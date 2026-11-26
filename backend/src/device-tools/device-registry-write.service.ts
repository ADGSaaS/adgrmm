// backend/src/device-tools/device-registry-write.service.ts
//
// Changing a Windows device's registry (phase 2 of the registry browser). Every change goes through the same steps:
//   1. the request is checked (path, value name, type, data, the write blocklist, the secret-name mask),
//   2. the rate limit is applied (30 changes a minute per person, 10 per device),
//   3. a change record is written ("pending"), then a fixed signed script job is made (it re-reads the old value, refuses when it is
//      not what the person saw, changes the registry and reads the new state back),
//   4. the record is finalised from the script's answer: ok, refused (the device would not, nothing changed) or failed.
// A slow device answers "pending" and the page asks again through the jobs route; the record is finalised when the result is read
// (first read wins), and the list of changes settles old pending records, so a record never stays in progress forever.
// Nothing here ever deletes recursively or works on more than one key, value or device per request.
import { BadRequestException, ConflictException, HttpException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../storage/prisma.service";
import { isCanonicalUuid } from "../common/agent-lookup.util";
import { DeviceToolsService, type Target, type ToolKind } from "./device-tools.service";
import {
    assertNameNotMasked, assertWritable, cleanExpected, cleanRegistryPath, cleanValueData, cleanValueName, cleanView, cleanWriteType,
    dataArg, expectArg, hiveOf, KEY_DELETE_MAX_VALUES, recordedForDisplay, REGISTRY_WRITE_SCRIPTS,
    valuesArg, WRITE_TYPES, isMaskedName,
    type Expected, type NewData, type RegistryView, type RestoreValue, type WriteAnswer, type WriteType,
} from "./device-registry.scripts";
import { RegistryWriteLimiter } from "./device-registry.limiter";

export type ChangeAction = "set" | "delete-value" | "create-key" | "delete-key";
export type Actor = { id: string; email: string | null; name: string | null; orgId: string | null };

/** A pending record older than this is settled as failed when the job has no result (the script itself is cut off at 90 seconds). */
const STALE_PENDING_MS = 10 * 60_000;
const NO_JOB_PENDING_MS = 2 * 60_000;
const SETTLE_MAX = 20;
export const CHANGES_DEFAULT_LIMIT = 30;
export const CHANGES_MAX_LIMIT = 200;

type Row = {
    id: string; organization_id: string; device_id: string; user_id: string | null; user_name: string | null; at: Date; action: string; hive: string; view: string;
    path: string; value_name: string | null; old_type: string | null; old_data: unknown; new_type: string | null; new_data: unknown; outcome: string; error: string | null;
    job_id: string | null; undone_at: Date | null; undone_by: string | null; undo_of: string | null;
};

type Spec = {
    action: ChangeAction;
    kind: ToolKind;
    script: string;
    env: Record<string, string>;
    path: string;
    view: RegistryView;
    name: string | null;
    /** What is being written (kept on the record until the device's read-back replaces it). */
    newType: string | null;
    newData: unknown;
    undoOf?: string;
};

export type ChangeView = ReturnType<DeviceRegistryWriteService["present"]>;
export type WriteResult = { pending: true; jobId: string; changeId: string } | { pending: false; changeId: string; jobId: string | null; change: ChangeView };

const safeText = (v: unknown, n = 500) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, n);
const errBody = (e: unknown): { status: number; message: string; code?: string } => {
    if (e instanceof HttpException) {
        const b: any = e.getResponse();
        const message = typeof b === "string" ? b : Array.isArray(b?.message) ? b.message.join(" ") : String(b?.message ?? e.message);
        return { status: e.getStatus(), message, code: typeof b?.code === "string" ? b.code : undefined };
    }
    return { status: 500, message: "The change could not be made." };
};
/** The same error with the change record's id added, so the page and the audit trail can name the record. */
const withChange = (e: unknown, changeId: string | null, code?: string): HttpException => {
    const b = errBody(e);
    return new HttpException({ statusCode: b.status, message: b.message, ...(code || b.code ? { code: code ?? b.code } : {}), ...(changeId ? { changeId } : {}) }, b.status);
};
export const changeIdOf = (e: unknown): string | null => {
    const r: any = e instanceof HttpException ? e.getResponse() : null;
    return r && typeof r === "object" && typeof r.changeId === "string" ? r.changeId : null;
};
export const codeOf = (e: unknown): string | null => errBody(e).code ?? null;

const sizeOfData = (type: string, data: unknown): number => {
    if (type === "REG_DWORD") return 4;
    if (type === "REG_QWORD") return 8;
    if (type === "REG_BINARY") return typeof data === "string" ? data.split(" ").filter(Boolean).length : 0;
    if (Array.isArray(data)) return data.reduce((n: number, x: unknown) => n + String(x).length, 0);
    return typeof data === "string" ? data.length : 0;
};

@Injectable()
export class DeviceRegistryWriteService {
    constructor(private readonly prisma: PrismaService, private readonly tools: DeviceToolsService, private readonly limiter: RegistryWriteLimiter) { }

    /** Counts one attempt against the limits (429 when over). `onFirst` is called once per burst, to write one audit row. */
    take(actor: Actor, t: Target, onFirst?: () => void) {
        this.limiter.take(actor.id, t.deviceId, onFirst ? () => onFirst() : undefined);
    }

    private async orgOf(t: Target, actor: Actor): Promise<string> {
        const r = await this.prisma.$queryRaw<{ org: string }[]>`SELECT c.organization_id::text AS org FROM devices d JOIN sites s ON s.id = d.site_id JOIN clients c ON c.id = s.client_id WHERE d.id = ${t.deviceId}::uuid`;
        if (r[0]?.org) return r[0].org;
        if (actor.orgId && isCanonicalUuid(actor.orgId)) return actor.orgId;
        const o = await this.prisma.organizations.findFirst({ select: { id: true }, orderBy: { created_at: "asc" } });
        if (!o) throw new ConflictException("No organization is set up.");
        return o.id;
    }

    /* ------------------------------ records ------------------------------ */

    private async insert(actor: Actor, t: Target, s: Pick<Spec, "action" | "path" | "view" | "name" | "newType" | "newData" | "undoOf">, outcome: "pending" | "refused" | "failed", error?: string): Promise<Row> {
        const j = (v: unknown) => (v === undefined || v === null ? Prisma.DbNull : (v as Prisma.InputJsonValue));
        return (await this.prisma.device_registry_changes.create({
            data: {
                organization_id: await this.orgOf(t, actor), device_id: t.deviceId, user_id: isCanonicalUuid(actor.id) ? actor.id : null, user_name: safeText(actor.name || actor.email, 200) || null,
                action: s.action, hive: hiveOf(s.path), view: s.view, path: s.path, value_name: s.name,
                // What was asked for is kept only while the change is in progress; a refusal keeps no data at all.
                new_type: outcome === "pending" ? s.newType : null, new_data: outcome === "pending" ? j(s.newData) : Prisma.DbNull,
                outcome, error: error ? safeText(error, 500) : null, undo_of: s.undoOf ?? null,
            },
        })) as unknown as Row;
    }

    private async end(id: string, outcome: "refused" | "failed", error: string, extra: Record<string, unknown> = {}): Promise<void> {
        await this.prisma.device_registry_changes.updateMany({ where: { id, outcome: "pending" }, data: { outcome, error: safeText(error, 500), new_type: null, new_data: Prisma.DbNull, ...extra } as any });
    }

    private async load(id: string): Promise<Row> {
        return (await this.prisma.device_registry_changes.findUniqueOrThrow({ where: { id } })) as unknown as Row;
    }

    /** What a script's answer means for the record. The first answer that finds the record pending finalises it. */
    private async finalise(rec: Row, answer: WriteAnswer): Promise<Row> {
        if (answer.status === "refused") {
            const old = answer.old && answer.old.exists ? answer.old : null;
            await this.end(rec.id, "refused", this.refusalText(rec, answer).message, old ? { old_type: old.type, old_data: old.data === null ? Prisma.DbNull : old.data } : {});
            return this.load(rec.id);
        }
        const data: Record<string, unknown> = { outcome: "ok", error: null };
        const j = (v: unknown) => (v === undefined || v === null ? Prisma.DbNull : v);
        if (rec.action === "set" || rec.action === "delete-value") {
            const o = answer.old && answer.old.exists ? answer.old : null;
            const n = answer.new && answer.new.exists ? answer.new : null;
            Object.assign(data, { old_type: o?.type ?? null, old_data: j(o?.data), new_type: n?.type ?? null, new_data: j(n?.data) });
        } else if (rec.action === "delete-key") {
            Object.assign(data, { old_type: "KEY", old_data: (answer.values ?? []).map((v) => ({ name: v.name, type: v.type, size: v.size, data: v.data })), new_type: null, new_data: Prisma.DbNull });
        } else {
            Object.assign(data, { new_type: "KEY", new_data: { values: answer.valueCount ?? 0 } });
        }
        const r = await this.prisma.device_registry_changes.updateMany({ where: { id: rec.id, outcome: "pending" }, data: data as any });
        if (r.count > 0 && rec.undo_of) {
            await this.prisma.device_registry_changes.updateMany({ where: { id: rec.undo_of, undone_at: null }, data: { undone_at: new Date(), undone_by: rec.user_id } });
        }
        return this.load(rec.id);
    }

    /** The message a refusal or failure is shown with. An undo that finds things different says so in its own words. */
    private refusalText(rec: Row, answer: WriteAnswer): { message: string; code: string; status: number } {
        const again = !!rec.undo_of && ["changed", "missing", "exists", "hassubkeys"].includes(answer.reason ?? "");
        const message = again
            ? `This was changed again since (${(answer.message ?? "").replace(/\s+/g, " ").slice(0, 200)}), so it was not undone and nothing was clobbered. Look at the key now and make the change you want by hand.`
            : answer.message || "The device refused the change.";
        const blocked = answer.reason === "blocked" || answer.reason === "masked";
        const code = again ? "changed_again" : answer.reason === "changed" ? "changed" : blocked ? "blocked" : answer.reason || "refused";
        return { message, code, status: blocked ? 403 : 409 };
    }

    private refusal(rec: Row, answer: WriteAnswer): HttpException {
        const t = this.refusalText(rec, answer);
        return new HttpException({ statusCode: t.status, code: t.code, message: t.message, changeId: rec.id }, t.status);
    }

    /* ------------------------------ running a change ------------------------------ */

    private async execute(actor: Actor, t: Target, s: Spec): Promise<WriteResult> {
        if (!t.online) {
            const rec = await this.insert(actor, t, s, "refused", "The device is offline. Registry changes are made on a device that is online now.");
            throw new HttpException({ statusCode: 409, code: "offline", message: "This device is offline. Registry changes are made on a device that is online now.", changeId: rec.id }, 409);
        }
        const rec = await this.insert(actor, t, s, "pending");
        try {
            const { jobId, answer } = await this.tools.run(t, s.kind, s.script, s.env, this.tools.reader(s.kind, t.family, s.env), async (id) => {
                await this.prisma.device_registry_changes.update({ where: { id: rec.id }, data: { job_id: id } });
            });
            if (answer.pending) return { pending: true, jobId, changeId: rec.id };
            const done = await this.finalise(rec, answer as WriteAnswer);
            if (done.outcome !== "ok") throw this.refusal(rec, answer as WriteAnswer);
            return { pending: false, changeId: rec.id, jobId, change: this.present(done) };
        } catch (e) {
            if (e instanceof HttpException && changeIdOf(e)) throw e;
            // The device could not be asked, or did not answer in time, or the script itself failed.
            const b = errBody(e);
            await this.end(rec.id, "failed", b.message);
            throw withChange(e, rec.id, /took too long/i.test(b.message) ? "slow" : /offline/i.test(b.message) ? "offline" : undefined);
        }
    }

    /** A refusal before any job is made (blocklist, mask, bad data): recorded, then rethrown with the record's id. */
    private async refused(actor: Actor, t: Target, s: Pick<Spec, "action" | "path" | "view" | "name" | "newType" | "newData" | "undoOf">, e: unknown): Promise<never> {
        const b = errBody(e);
        let id: string | null = null;
        try {
            id = (await this.insert(actor, t, s, "refused", b.message)).id;
        } catch { /* recording must not hide the real answer */ }
        throw withChange(e, id, b.status === 403 ? "blocked" : "invalid");
    }

    async setValue(actor: Actor, t: Target, input: { path?: unknown; view?: unknown; name?: unknown; type?: unknown; data?: unknown; expected?: unknown }): Promise<WriteResult> {
        const path = cleanRegistryPath(input.path, { allowEmpty: false });
        const view = cleanView(input.view);
        const known: Pick<Spec, "action" | "path" | "view" | "name" | "newType" | "newData"> = { action: "set", path, view, name: null, newType: null, newData: null };
        let type: WriteType, name: string, data: NewData, expected: Expected | null;
        try {
            name = cleanValueName(input.name);
            known.name = name;
            assertWritable(path, "value", name);
            assertNameNotMasked(name);
            type = cleanWriteType(input.type);
            known.newType = type;
            data = cleanValueData(type, input.data);
            expected = cleanExpected(input.expected);
        } catch (e) {
            return this.refused(actor, t, { ...known, newType: known.newType, newData: null }, e);
        }
        const env = { ADG_REG_PATH: path, ADG_REG_VIEW: view, ADG_REG_NAME: name, ADG_REG_TYPE: type, ADG_REG_DATA: dataArg(type, data), ADG_REG_EXPECT: expectArg(expected) };
        return this.execute(actor, t, { action: "set", kind: "registry.set", script: REGISTRY_WRITE_SCRIPTS.set, env, path, view, name, newType: type, newData: data });
    }

    async deleteValue(actor: Actor, t: Target, input: { path?: unknown; view?: unknown; name?: unknown; expected?: unknown }): Promise<WriteResult> {
        const path = cleanRegistryPath(input.path, { allowEmpty: false });
        const view = cleanView(input.view);
        const known = { action: "delete-value" as const, path, view, name: null as string | null, newType: null, newData: null };
        let name: string, expected: Expected | null;
        try {
            name = cleanValueName(input.name);
            known.name = name;
            assertWritable(path, "value", name);
            assertNameNotMasked(name);
            expected = cleanExpected(input.expected);
        } catch (e) {
            return this.refused(actor, t, known, e);
        }
        const env = { ADG_REG_PATH: path, ADG_REG_VIEW: view, ADG_REG_NAME: name, ADG_REG_EXPECT: expectArg(expected) };
        return this.execute(actor, t, { action: "delete-value", kind: "registry.delete-value", script: REGISTRY_WRITE_SCRIPTS.deleteValue, env, path, view, name, newType: null, newData: null });
    }

    async createKey(actor: Actor, t: Target, input: { path?: unknown; view?: unknown }): Promise<WriteResult> {
        const path = cleanRegistryPath(input.path, { allowEmpty: false });
        const view = cleanView(input.view);
        const known = { action: "create-key" as const, path, view, name: null, newType: null, newData: null };
        try {
            assertWritable(path, "createkey");
        } catch (e) {
            return this.refused(actor, t, known, e);
        }
        const env = { ADG_REG_PATH: path, ADG_REG_VIEW: view };
        return this.execute(actor, t, { action: "create-key", kind: "registry.create-key", script: REGISTRY_WRITE_SCRIPTS.createKey, env, path, view, name: null, newType: null, newData: null });
    }

    async deleteKey(actor: Actor, t: Target, input: { path?: unknown; view?: unknown; expectedValueCount?: unknown }): Promise<WriteResult> {
        const path = cleanRegistryPath(input.path, { allowEmpty: false });
        const view = cleanView(input.view);
        const known = { action: "delete-key" as const, path, view, name: null, newType: null, newData: null };
        let expectValues: number | null = null;
        try {
            assertWritable(path, "deletekey");
            if (input.expectedValueCount !== undefined && input.expectedValueCount !== null) {
                const n = Number(input.expectedValueCount);
                if (!Number.isSafeInteger(n) || n < 0 || n > 1_000_000) throw new BadRequestException("The expected number of values is not valid.");
                expectValues = n;
            }
        } catch (e) {
            return this.refused(actor, t, known, e);
        }
        const env: Record<string, string> = { ADG_REG_PATH: path, ADG_REG_VIEW: view, ADG_REG_EXPECT: expectValues === null ? "" : JSON.stringify({ values: expectValues }) };
        return this.execute(actor, t, { action: "delete-key", kind: "registry.delete-key", script: REGISTRY_WRITE_SCRIPTS.deleteKey, env, path, view, name: null, newType: null, newData: null });
    }

    /* ------------------------------ undo ------------------------------ */

    /** Puts a change back: only an ok change that has not been undone yet, and only while the registry still holds what that change left. */
    async undo(actor: Actor, t: Target, changeId: string): Promise<WriteResult> {
        if (!isCanonicalUuid(changeId)) throw new NotFoundException("Change not found");
        const rec = (await this.prisma.device_registry_changes.findFirst({ where: { id: changeId, device_id: t.deviceId } })) as unknown as Row | null;
        if (!rec) throw new NotFoundException("Change not found");
        if (rec.undo_of) throw new ConflictException("An undo cannot be undone. Make the change again instead.");
        if (rec.outcome !== "ok") throw new ConflictException("Only a change that was made can be undone.");
        if (rec.undone_at) throw new ConflictException("This change was already undone.");

        const view = cleanView(rec.view);
        const path = rec.path;
        const name = rec.value_name ?? "";
        const base = { path, view, name: null as string | null, newType: null as string | null, newData: null as unknown, undoOf: rec.id };
        const typeOk = (x: string | null): x is WriteType => !!x && (WRITE_TYPES as string[]).includes(x);
        const restoring = (): { type: WriteType; data: NewData } => {
            if (!typeOk(rec.old_type)) throw new ConflictException("The value this change replaced has a type that cannot be put back.");
            return { type: rec.old_type, data: cleanValueData(rec.old_type, rec.old_data) };
        };
        const left = (): Expected => {
            if (!typeOk(rec.new_type)) throw new ConflictException("The value this change left has a type that cannot be checked.");
            return { exists: true, type: rec.new_type, data: cleanValueData(rec.new_type, rec.new_data) };
        };
        let spec: Spec;
        try {
            if (rec.action === "set" && rec.old_type) {
                const r = restoring();
                assertWritable(path, "value", name); assertNameNotMasked(name);
                const env = { ADG_REG_PATH: path, ADG_REG_VIEW: view, ADG_REG_NAME: name, ADG_REG_TYPE: r.type, ADG_REG_DATA: dataArg(r.type, r.data), ADG_REG_EXPECT: expectArg(left()) };
                spec = { ...base, action: "set", kind: "registry.set", script: REGISTRY_WRITE_SCRIPTS.set, env, name, newType: r.type, newData: r.data };
            } else if (rec.action === "set") {
                assertWritable(path, "value", name); assertNameNotMasked(name);
                const env = { ADG_REG_PATH: path, ADG_REG_VIEW: view, ADG_REG_NAME: name, ADG_REG_EXPECT: expectArg(left()) };
                spec = { ...base, action: "delete-value", kind: "registry.delete-value", script: REGISTRY_WRITE_SCRIPTS.deleteValue, env, name };
            } else if (rec.action === "delete-value") {
                const r = restoring();
                assertWritable(path, "value", name); assertNameNotMasked(name);
                const env = { ADG_REG_PATH: path, ADG_REG_VIEW: view, ADG_REG_NAME: name, ADG_REG_TYPE: r.type, ADG_REG_DATA: dataArg(r.type, r.data), ADG_REG_EXPECT: expectArg({ exists: false }) };
                spec = { ...base, action: "set", kind: "registry.set", script: REGISTRY_WRITE_SCRIPTS.set, env, name, newType: r.type, newData: r.data };
            } else if (rec.action === "create-key") {
                assertWritable(path, "deletekey");
                const env = { ADG_REG_PATH: path, ADG_REG_VIEW: view, ADG_REG_EXPECT: JSON.stringify({ values: Number((rec.new_data as any)?.values ?? 0) }) };
                spec = { ...base, action: "delete-key", kind: "registry.delete-key", script: REGISTRY_WRITE_SCRIPTS.deleteKey, env };
            } else {
                assertWritable(path, "createkey");
                const old: any[] = Array.isArray(rec.old_data) ? (rec.old_data as any[]) : [];
                if (old.length > KEY_DELETE_MAX_VALUES) throw new ConflictException("The key held too many values to put back.");
                const values: RestoreValue[] = old.map((v) => {
                    if (isMaskedName(String(v?.name ?? "")) || !typeOk(v?.type)) throw new ConflictException("The key held a value that cannot be put back.");
                    return { name: String(v.name ?? ""), type: v.type as WriteType, data: cleanValueData(v.type as WriteType, v.data) };
                });
                const env: Record<string, string> = { ADG_REG_PATH: path, ADG_REG_VIEW: view, ADG_REG_VALUES: valuesArg(values) };
                spec = { ...base, action: "create-key", kind: "registry.create-key", script: REGISTRY_WRITE_SCRIPTS.createKey, env };
            }
        } catch (e) {
            return this.refused(actor, t, { ...base, action: rec.action as ChangeAction, name: rec.value_name }, e);
        }
        return this.execute(actor, t, spec);
    }

    /* ------------------------------ reading records ------------------------------ */

    /** What the page gets for a record: data shown the way the reader shows it, secrets hidden, who and when. */
    present(r: Row, canUndo = false, undoneByName: string | null = null) {
        const side = (nm: string, type: string | null, data: unknown) =>
            type && type !== "KEY" ? recordedForDisplay(nm, { exists: true, type: type as any, size: sizeOfData(type, data), data: data === null || data === undefined ? null : (data as NewData) }) : null;
        const name = r.value_name ?? "";
        const deleted = r.action === "delete-key" && Array.isArray(r.old_data)
            ? (r.old_data as any[]).slice(0, KEY_DELETE_MAX_VALUES).map((v) => {
                const nm = String(v?.name ?? "");
                return { name: nm, display: nm === "" ? "(Default)" : nm, ...(side(nm, String(v?.type ?? ""), v?.data) ?? {}) };
            })
            : null;
        return {
            id: r.id, at: r.at.toISOString(), user: r.user_name, userId: r.user_id,
            action: r.action as ChangeAction, undo: !!r.undo_of, undoOf: r.undo_of,
            hive: r.hive, view: r.view, path: r.path, valueName: r.value_name, display: r.value_name === null ? null : r.value_name === "" ? "(Default)" : r.value_name,
            old: r.action === "set" || r.action === "delete-value" ? (r.old_type ? side(name, r.old_type, r.old_data) : r.outcome === "ok" ? { exists: false as const } : null) : null,
            new: r.action === "set" ? (r.new_type ? side(name, r.new_type, r.new_data) : null) : r.action === "delete-value" && r.outcome === "ok" ? { exists: false as const } : null,
            deletedValues: deleted,
            valueCount: r.action === "delete-key" && Array.isArray(r.old_data) ? (r.old_data as unknown[]).length : r.action === "create-key" && r.new_data && typeof r.new_data === "object" ? Number((r.new_data as any).values ?? 0) : null,
            outcome: r.outcome as "pending" | "ok" | "refused" | "failed", error: r.error,
            undoneAt: r.undone_at ? r.undone_at.toISOString() : null, undoneBy: undoneByName,
            canUndo: canUndo && r.outcome === "ok" && !r.undone_at && !r.undo_of,
        };
    }

    /** The recent changes of a device, newest first; with a path: those of that key (its values, and keys created or deleted directly in it). */
    async list(t: Target, path: string, limit: number, canUndo: boolean) {
        await this.settlePending(t);
        const lim = Math.min(CHANGES_MAX_LIMIT, Math.max(1, Math.floor(limit) || CHANGES_DEFAULT_LIMIT));
        let rows: Row[];
        if (path) {
            // Done in SQL with plain comparisons: a registry path holds backslashes, which LIKE would take for its escape character.
            const ids = await this.prisma.$queryRaw<{ id: string }[]>`
                SELECT id::text AS id FROM device_registry_changes
                WHERE device_id = ${t.deviceId}::uuid
                  AND (lower(path) = lower(${path}::text)
                       OR (action IN ('create-key', 'delete-key') AND lower(left(path, length(${path}::text) + 1)) = lower(${path}::text) || chr(92)
                           AND position(chr(92) in substr(path, length(${path}::text) + 2)) = 0))
                ORDER BY at DESC, id DESC LIMIT ${lim}`;
            const found = (await this.prisma.device_registry_changes.findMany({ where: { id: { in: ids.map((r) => r.id) } } })) as unknown as Row[];
            const order = new Map(ids.map((r, i) => [r.id, i]));
            rows = found.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
        } else {
            rows = (await this.prisma.device_registry_changes.findMany({ where: { device_id: t.deviceId }, orderBy: [{ at: "desc" }, { id: "desc" }], take: lim })) as unknown as Row[];
        }
        const keep = rows;
        const ids = [...new Set(keep.map((r) => r.undone_by).filter((x): x is string => !!x))];
        const names = new Map<string, string>();
        if (ids.length) {
            for (const u of await this.prisma.users.findMany({ where: { id: { in: ids } }, select: { id: true, email: true, first_name: true, last_name: true } })) {
                names.set(u.id, [u.first_name, u.last_name].filter(Boolean).join(" ").trim() || u.email);
            }
        }
        return keep.map((r) => this.present(r, canUndo, r.undone_by ? names.get(r.undone_by) ?? null : null));
    }

    /* ------------------------------ pending changes ------------------------------ */

    /** The result of a change job that was still running when its request was made (null when the job is not a change). */
    async result(t: Target, jobId: string): Promise<(WriteResult & { pending: boolean }) | null> {
        if (!isCanonicalUuid(jobId)) return null;
        const rec = (await this.prisma.device_registry_changes.findFirst({ where: { job_id: jobId, device_id: t.deviceId } })) as unknown as Row | null;
        if (!rec) return null;
        if (rec.outcome !== "pending") return this.outcomeOf(rec);
        let answer: any;
        try {
            answer = await this.tools.result(t, jobId, "registry");
        } catch (e) {
            const b = errBody(e);
            await this.end(rec.id, "failed", b.message);
            throw withChange(e, rec.id, /took too long/i.test(b.message) ? "slow" : undefined);
        }
        if (answer.pending) return { pending: true, jobId, changeId: rec.id };
        const done = await this.finalise(rec, answer as WriteAnswer);
        return this.outcomeOf(done, answer as WriteAnswer);
    }

    private outcomeOf(rec: Row, answer?: WriteAnswer): WriteResult & { pending: false } {
        if (rec.outcome === "ok") return { pending: false, changeId: rec.id, jobId: rec.job_id, change: this.present(rec) };
        if (answer?.status === "refused") throw this.refusal(rec, answer);
        throw new HttpException({ statusCode: 409, code: rec.outcome === "refused" ? "refused" : "failed", message: rec.error || "The change was not made.", changeId: rec.id }, 409);
    }

    /** Settles this device's records that are still pending: from the job's result when it has one, as failed when it never will. */
    async settlePending(t: Target): Promise<void> {
        const rows = (await this.prisma.device_registry_changes.findMany({ where: { device_id: t.deviceId, outcome: "pending" }, orderBy: { at: "asc" }, take: SETTLE_MAX })) as unknown as Row[];
        for (const rec of rows) {
            const age = Date.now() - rec.at.getTime();
            try {
                if (!rec.job_id) {
                    if (age > NO_JOB_PENDING_MS) await this.end(rec.id, "failed", "The request never reached the device.");
                    continue;
                }
                const answer = await this.tools.result(t, rec.job_id, "registry");
                if (answer.pending) {
                    if (age > STALE_PENDING_MS) await this.end(rec.id, "failed", "The device did not answer, so it is not known whether the change was made. Look at the key.");
                    continue;
                }
                await this.finalise(rec, answer as WriteAnswer);
            } catch (e) {
                if (e instanceof HttpException) await this.end(rec.id, "failed", errBody(e).message);
                else if (age > STALE_PENDING_MS) await this.end(rec.id, "failed", "The result of the change could not be read.");
            }
        }
    }
}
