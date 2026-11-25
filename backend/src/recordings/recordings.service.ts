// backend/src/recordings/recordings.service.ts
//
// Remote session recordings (roadmap 1.26). The technician's browser records the remote video (MediaRecorder, WebM)
// and uploads it in pieces while the session runs. This service decides whether a recording may exist at all, keeps
// the pieces encrypted, enforces size and quota limits, answers the list and playback, and removes what has expired.
import {
    BadRequestException,
    ConflictException,
    ForbiddenException,
    Injectable,
    Logger,
    NotFoundException,
    PayloadTooLargeException,
    ServiceUnavailableException,
} from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { Prisma } from "@prisma/client";
import * as fsp from "node:fs/promises";

import { AuditService } from "../audit/audit.service";
import { isCanonicalUuid } from "../common/agent-lookup.util";
import { hasDataKey } from "../common/secret-box";
import { RemoteConsoleService } from "../remote-console/remote-console.service";
import { ClientAccessService } from "../reports/client-access.service";
import { OrganizationContextService } from "../storage/organization-context.service";
import { PrismaService } from "../storage/prisma.service";
import { pieceSizes, readPiece, recordingsRoot, removeRecordingFiles, writePiece } from "./recording-store";

const DAY_MS = 24 * 60 * 60 * 1000;
const MB = 1024 * 1024;
const GB = 1024 * MB;

export const DEFAULT_RETENTION_DAYS = 90;
export const DEFAULT_MAX_RECORDING_MB = 2048;
export const DEFAULT_QUOTA_GB = 50;
/** One uploaded piece covers a few seconds of video; anything bigger is not from the recorder. */
export const MAX_PIECE_BYTES = 16 * MB;
/** A recording with no new piece for this long has lost its browser. */
const STALE_AFTER_MS = 3 * 60_000;
/** Pieces already uploaded are kept for this long after the session ended, for a retried upload. */
const ORPHAN_GRACE_MS = 60 * 60_000;

export type RecActor = { orgId: string; userId: string | null; name: string; email: string | null };

type Row = {
    id: string;
    organization_id: string;
    session_id: string;
    device_id: string | null;
    device_name: string | null;
    client_id: string | null;
    client_name: string | null;
    technician_id: string | null;
    technician_name: string | null;
    status: string;
    mime_type: string;
    started_at: Date;
    ended_at: Date | null;
    last_chunk_at: Date | null;
    duration_ms: bigint;
    size_bytes: bigint;
    chunk_count: number;
    notice_mode: string | null;
    expires_at: Date;
};

export type RecordingSettings = { retentionDays: number; maxRecordingMb: number; quotaGb: number };

function view(r: Row) {
    const live = r.status === "recording";
    return {
        id: r.id,
        sessionId: r.session_id,
        deviceId: r.device_id,
        deviceName: r.device_name,
        clientId: r.client_id,
        clientName: r.client_name,
        technicianId: r.technician_id,
        technicianName: r.technician_name,
        status: r.status,
        startedAt: r.started_at.toISOString(),
        endedAt: r.ended_at ? r.ended_at.toISOString() : null,
        durationMs: live ? Math.max(0, Date.now() - r.started_at.getTime()) : Number(r.duration_ms),
        sizeBytes: Number(r.size_bytes),
        expiresAt: r.expires_at.toISOString(),
    };
}

function intIn(value: unknown, name: string, min: number, max: number): number {
    const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
    if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) throw new BadRequestException(`${name} must be a whole number from ${min} to ${max}.`);
    return n;
}

function parseDate(value: unknown, name: string): Date | undefined {
    if (value === undefined || value === null || value === "") return undefined;
    const d = new Date(String(value));
    if (Number.isNaN(d.getTime())) throw new BadRequestException(`Invalid ${name} date.`);
    return d;
}

@Injectable()
export class RecordingsService {
    private readonly log = new Logger("Recordings");

    constructor(
        private readonly prisma: PrismaService,
        private readonly rc: RemoteConsoleService,
        private readonly access: ClientAccessService,
        private readonly audit: AuditService,
        private readonly orgs: OrganizationContextService,
    ) { }

    /* ------------------------------ settings ------------------------------ */

    async settings(orgId: string): Promise<RecordingSettings & { usedBytes: number; recordings: number }> {
        const [row, usage] = await Promise.all([
            this.prisma.remote_recording_settings.findUnique({ where: { organization_id: orgId } }),
            this.prisma.remote_session_recordings.aggregate({ where: { organization_id: orgId }, _sum: { size_bytes: true }, _count: { _all: true } }),
        ]);
        return {
            retentionDays: row?.retention_days ?? DEFAULT_RETENTION_DAYS,
            maxRecordingMb: row?.max_recording_mb ?? DEFAULT_MAX_RECORDING_MB,
            quotaGb: row?.quota_gb ?? DEFAULT_QUOTA_GB,
            usedBytes: Number(usage._sum.size_bytes ?? 0),
            recordings: usage._count._all,
        };
    }

    async updateSettings(actor: RecActor, body: any) {
        const b = body && typeof body === "object" ? body : {};
        const current = await this.settings(actor.orgId);
        const next = {
            retentionDays: b.retentionDays === undefined ? current.retentionDays : intIn(b.retentionDays, "Retention", 1, 3650),
            maxRecordingMb: b.maxRecordingMb === undefined ? current.maxRecordingMb : intIn(b.maxRecordingMb, "The size limit of one recording", 10, 20480),
            quotaGb: b.quotaGb === undefined ? current.quotaGb : intIn(b.quotaGb, "The storage limit", 1, 10240),
        };
        const updatedBy = actor.userId && isCanonicalUuid(actor.userId) ? actor.userId : null;
        await this.prisma.remote_recording_settings.upsert({
            where: { organization_id: actor.orgId },
            create: { organization_id: actor.orgId, retention_days: next.retentionDays, max_recording_mb: next.maxRecordingMb, quota_gb: next.quotaGb, updated_by: updatedBy },
            update: { retention_days: next.retentionDays, max_recording_mb: next.maxRecordingMb, quota_gb: next.quotaGb, updated_by: updatedBy, updated_at: new Date() },
        });
        // Kept for a number of days from when each was recorded, so a new period applies to what is already stored.
        // make_interval keeps the arithmetic in the database, where it cannot overflow.
        await this.prisma.$executeRaw`
            UPDATE public.remote_session_recordings
               SET expires_at = started_at + make_interval(days => ${next.retentionDays}::int)
             WHERE organization_id = ${actor.orgId}::uuid`;
        return this.settings(actor.orgId);
    }

    /* ------------------------------ who may see what ------------------------------ */

    private async visibleWhere(actor: RecActor): Promise<Prisma.remote_session_recordingsWhereInput> {
        const scope = await this.access.scopeFor(actor.userId);
        const where: Prisma.remote_session_recordingsWhereInput = { organization_id: actor.orgId };
        if (!scope) return where;
        const devices = await this.prisma.devices.findMany({ where: this.access.deviceWhere(scope), select: { id: true } });
        where.OR = [
            { device_id: { in: devices.map((d) => d.id) } },
            // A recording whose device was deleted can only be matched by whole customers.
            { device_id: null, client_id: { in: scope.clients } },
        ];
        return where;
    }

    /** The row, or "not found" for another organization's, a missing one and one a limited person may not see. */
    private async load(actor: RecActor, id: string): Promise<Row> {
        if (!isCanonicalUuid(id)) throw new NotFoundException("Recording not found.");
        const where = await this.visibleWhere(actor);
        const row = await this.prisma.remote_session_recordings.findFirst({ where: { AND: [where, { id }] } });
        if (!row) throw new NotFoundException("Recording not found.");
        return row as Row;
    }

    /* ------------------------------ recording ------------------------------ */

    async start(actor: RecActor, sessionIdRaw: unknown) {
        const sessionId = String(sessionIdRaw ?? "").trim();
        if (!isCanonicalUuid(sessionId)) throw new BadRequestException("sessionId is required.");
        if (!actor.userId) throw new ForbiddenException("Sign in first.");

        const live = this.rc.liveSessionFor(sessionId, actor.userId);
        if (!live) throw new NotFoundException("That is not a live Remote Console session of yours.");
        // The person at the device was told about the recording when the session began. Without that, none is allowed,
        // whatever the setting says now.
        if (!live.record) throw new ForbiddenException("Recording is not turned on for this customer, so this session cannot be recorded.");
        if (!hasDataKey()) throw new ServiceUnavailableException("Recordings are encrypted, and this server has no data encryption key set (DATA_ENCRYPTION_KEY_FILE).");

        const agent = await this.prisma.agents.findUnique({ where: { id: live.agentId }, select: { device_id: true } });
        if (!agent) throw new NotFoundException("Device not found.");
        await this.access.assertDevice(actor.userId, agent.device_id);
        const dev = await this.prisma.devices.findUnique({
            where: { id: agent.device_id },
            select: { id: true, hostname: true, alias: true, sites: { select: { client_id: true, clients: { select: { name: true, organization_id: true } } } } },
        });
        if (!dev) throw new NotFoundException("Device not found.");
        if (dev.sites?.clients && dev.sites.clients.organization_id !== actor.orgId) throw new NotFoundException("Device not found.");

        const existing = await this.prisma.remote_session_recordings.findUnique({ where: { session_id: sessionId } });
        if (existing) {
            if (existing.technician_id === actor.userId && existing.status === "recording") return { ...view(existing as Row), nextSeq: existing.chunk_count, ...(await this.limits(actor.orgId)) };
            throw new ConflictException("This session already has a recording.");
        }

        const s = await this.settings(actor.orgId);
        if (s.usedBytes >= s.quotaGb * GB) throw new PayloadTooLargeException(`The recording storage limit of ${s.quotaGb} GB is used up. Delete old recordings or raise the limit.`);

        const now = new Date();
        const row = await this.prisma.remote_session_recordings.create({
            data: {
                organization_id: actor.orgId,
                session_id: sessionId,
                device_id: dev.id,
                device_name: (dev.alias || dev.hostname || null),
                client_id: dev.sites?.client_id ?? null,
                client_name: dev.sites?.clients?.name ?? null,
                technician_id: actor.userId,
                technician_name: actor.name.slice(0, 200),
                notice_mode: live.consentMode,
                started_at: now,
                expires_at: new Date(now.getTime() + s.retentionDays * DAY_MS),
            },
        });
        return { ...view(row as Row), nextSeq: 0, ...(await this.limits(actor.orgId)) };
    }

    private async limits(orgId: string) {
        const s = await this.settings(orgId);
        return { maxPieceBytes: MAX_PIECE_BYTES, maxRecordingBytes: s.maxRecordingMb * MB };
    }

    async addPiece(actor: RecActor, id: string, seqRaw: unknown, data: Buffer) {
        if (!isCanonicalUuid(id)) throw new NotFoundException("Recording not found.");
        const seq = Number(seqRaw);
        if (!Number.isInteger(seq) || seq < 0 || seq > 1_000_000) throw new BadRequestException("seq must be the number of the piece, starting at 0.");
        if (!data.length) throw new BadRequestException("The piece is empty.");
        if (data.length > MAX_PIECE_BYTES) throw new PayloadTooLargeException(`A piece can be at most ${MAX_PIECE_BYTES / MB} MB.`);

        const row = await this.prisma.remote_session_recordings.findFirst({ where: { id, organization_id: actor.orgId } });
        // Only the technician who made the recording can add to it, and others learn nothing about its existence.
        if (!row || !actor.userId || row.technician_id !== actor.userId) throw new NotFoundException("Recording not found.");
        if (row.status !== "recording") throw new ConflictException("This recording is closed.");

        // The setting is read again now, so turning recording off stops what is stored, not only what starts.
        if (!(await this.stillAllowed(row as Row))) {
            await this.prisma.remote_session_recordings.updateMany({ where: { id, status: "recording" }, data: { status: "interrupted", ended_at: new Date(), duration_ms: BigInt(this.elapsed(row as Row)) } });
            throw new ForbiddenException("Recording was turned off for this customer, so nothing more is stored.");
        }

        // Pieces must arrive in order, so the file is whole and nothing is silently missing from the middle.
        if (seq > row.chunk_count) throw new ConflictException(`Piece ${row.chunk_count} comes next, not ${seq}.`);
        if (seq < row.chunk_count) return { nextSeq: row.chunk_count, sizeBytes: Number(row.size_bytes), duplicate: true };

        const s = await this.settings(actor.orgId);
        if (Number(row.size_bytes) + data.length > s.maxRecordingMb * MB) {
            throw new PayloadTooLargeException(`This recording reached its limit of ${s.maxRecordingMb} MB. It stops here.`);
        }
        if (s.usedBytes + data.length > s.quotaGb * GB) {
            throw new PayloadTooLargeException(`The recording storage limit of ${s.quotaGb} GB is used up.`);
        }

        await writePiece(id, seq, data);
        const claimed = await this.prisma.remote_session_recordings.updateMany({
            where: { id, status: "recording", chunk_count: seq },
            data: { chunk_count: { increment: 1 }, size_bytes: { increment: BigInt(data.length) }, last_chunk_at: new Date() },
        });
        const now = await this.prisma.remote_session_recordings.findUnique({ where: { id } });
        if (claimed.count === 0) return { nextSeq: now?.chunk_count ?? seq, sizeBytes: Number(now?.size_bytes ?? 0), duplicate: true };
        return { nextSeq: now!.chunk_count, sizeBytes: Number(now!.size_bytes), duplicate: false };
    }

    private elapsed(r: Row): number {
        const end = r.last_chunk_at ?? new Date();
        return Math.max(0, end.getTime() - r.started_at.getTime());
    }

    /** Whether the device's customer (or a policy) still has recording on. A device that is gone cannot be checked, so no. */
    private async stillAllowed(r: Row): Promise<boolean> {
        if (!r.device_id) return false;
        const agent = await this.prisma.agents.findUnique({ where: { device_id: r.device_id }, select: { id: true } });
        if (!agent) return false;
        return this.rc.recordingFor(agent.id);
    }

    async finish(actor: RecActor, id: string, durationRaw: unknown) {
        if (!isCanonicalUuid(id)) throw new NotFoundException("Recording not found.");
        const row = await this.prisma.remote_session_recordings.findFirst({ where: { id, organization_id: actor.orgId } });
        if (!row || !actor.userId || row.technician_id !== actor.userId) throw new NotFoundException("Recording not found.");
        if (row.status === "recording") {
            const wall = Date.now() - row.started_at.getTime();
            const said = Number(durationRaw);
            // The browser's own count is only believed up to the time that really passed.
            const duration = Number.isFinite(said) && said >= 0 ? Math.min(Math.round(said), wall + 5_000) : this.elapsed(row as Row);
            if (row.chunk_count === 0) {
                await this.remove(row as Row);
                return { id, status: "empty", sizeBytes: 0, durationMs: 0 };
            }
            await this.prisma.remote_session_recordings.updateMany({
                where: { id, status: "recording" },
                data: { status: "complete", ended_at: new Date(), duration_ms: BigInt(duration) },
            });
        }
        const fresh = await this.prisma.remote_session_recordings.findUnique({ where: { id } });
        return view(fresh as Row);
    }

    /* ------------------------------ list and read ------------------------------ */

    async list(actor: RecActor, q: Record<string, unknown>) {
        const base = await this.visibleWhere(actor);
        const and: Prisma.remote_session_recordingsWhereInput[] = [base];

        const uuidFilter = (key: string, col: "client_id" | "device_id" | "technician_id") => {
            const v = q[key];
            if (v === undefined || v === null || v === "") return;
            const s = String(v);
            // A value that is not an id matches nothing, rather than failing.
            and.push(isCanonicalUuid(s) ? { [col]: s } : { id: "00000000-0000-0000-0000-000000000000" });
        };
        uuidFilter("clientId", "client_id");
        uuidFilter("deviceId", "device_id");
        uuidFilter("technicianId", "technician_id");

        const from = parseDate(q.from, "from");
        const to = parseDate(q.to, "to");
        if (from) and.push({ started_at: { gte: from } });
        if (to) and.push({ started_at: { lt: to } });
        const status = String(q.status ?? "");
        if (status) and.push({ status: ["recording", "complete", "interrupted", "failed"].includes(status) ? status : "none" });

        const limit = Math.min(200, Math.max(1, Number(q.limit) || 50));
        const offset = Math.max(0, Number(q.offset) || 0);
        const where = { AND: and };
        const [rows, total, agg] = await Promise.all([
            this.prisma.remote_session_recordings.findMany({ where, orderBy: [{ started_at: "desc" }, { id: "desc" }], take: limit, skip: offset }),
            this.prisma.remote_session_recordings.count({ where }),
            this.prisma.remote_session_recordings.aggregate({ where, _sum: { size_bytes: true } }),
        ]);
        return { items: (rows as Row[]).map(view), total, sizeBytes: Number(agg._sum.size_bytes ?? 0), limit, offset };
    }

    /** People and customers that appear in the recordings this person may see, for the list's filters. */
    async facets(actor: RecActor) {
        const where = await this.visibleWhere(actor);
        const rows = await this.prisma.remote_session_recordings.findMany({
            where,
            select: { client_id: true, client_name: true, technician_id: true, technician_name: true },
            distinct: ["client_id", "technician_id"],
            take: 1000,
        });
        const clients = new Map<string, string>();
        const techs = new Map<string, string>();
        for (const r of rows) {
            if (r.client_id) clients.set(r.client_id, r.client_name ?? r.client_id);
            if (r.technician_id) techs.set(r.technician_id, r.technician_name ?? r.technician_id);
        }
        const pack = (m: Map<string, string>) => [...m].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
        return { clients: pack(clients), technicians: pack(techs) };
    }

    async get(actor: RecActor, id: string) {
        return view(await this.load(actor, id));
    }

    /**
     * Streams the decrypted recording, with byte ranges so the browser can seek. Opening playback and downloading are
     * audited once; the follow-up range requests of the same playback are not repeated.
     */
    async stream(actor: RecActor, id: string, req: any, res: any, download: boolean) {
        const row = await this.load(actor, id);
        const sizes = await pieceSizes(row.id, row.chunk_count);
        const total = sizes.reduce((a, b) => a + b, 0);
        if (total === 0) throw new NotFoundException("This recording has no video.");

        let start = 0;
        let end = total - 1;
        let partial = false;
        const range = String(req.headers?.range ?? "");
        if (range) {
            const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
            if (!m || (m[1] === "" && m[2] === "")) {
                res.status(416).set("Content-Range", `bytes */${total}`).end();
                return;
            }
            if (m[1] === "") {
                start = Math.max(0, total - Number(m[2]));
            } else {
                start = Number(m[1]);
                if (m[2] !== "") end = Math.min(total - 1, Number(m[2]));
            }
            if (start >= total || start > end) {
                res.status(416).set("Content-Range", `bytes */${total}`).end();
                return;
            }
            partial = true;
        }

        if (download || !range || start === 0) {
            await this.audit.record({
                action: download ? "recording.download" : "recording.view",
                category: "remote",
                outcome: "success",
                actorUserId: actor.userId,
                actorEmail: actor.email,
                targetType: "recording",
                targetId: row.id,
                targetLabel: `${row.client_name ?? "No customer"} / ${row.device_name ?? "Device"}`,
                req,
                details: { technician: row.technician_name, startedAt: row.started_at.toISOString() },
            });
        }

        const filename = `session-${(row.device_name ?? "device").replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 60)}-${row.started_at.toISOString().replace(/[:.]/g, "-")}.webm`;
        res.status(partial ? 206 : 200);
        res.set({
            "Content-Type": row.mime_type || "video/webm",
            "Content-Length": String(end - start + 1),
            "Accept-Ranges": "bytes",
            // Shows what was on a customer's screen: never kept by a browser or a proxy.
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
            "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${filename}"`,
            ...(partial ? { "Content-Range": `bytes ${start}-${end}/${total}` } : {}),
        });

        let offset = 0;
        try {
            for (let seq = 0; seq < sizes.length && offset <= end; seq++) {
                const size = sizes[seq];
                const pieceStart = offset;
                const pieceEnd = offset + size - 1;
                offset += size;
                if (pieceEnd < start) continue;
                const plain = await readPiece(row.id, seq);
                const slice = plain.subarray(Math.max(0, start - pieceStart), Math.min(size, end - pieceStart + 1));
                if (!res.write(slice)) await new Promise((r) => res.once("drain", r));
                if (res.destroyed || res.writableEnded) return;
            }
            res.end();
        } catch (e: any) {
            this.log.warn(`playback of ${row.id} failed: ${e?.message ?? e}`);
            // Headers are out already; closing the connection short is the only honest signal left.
            res.destroy();
        }
    }

    async deleteOne(actor: RecActor, id: string) {
        const row = await this.load(actor, id);
        await this.remove(row);
        return { ok: true };
    }

    private async remove(row: Row) {
        // Files go first: a row with no files is a clear "gone", but files with no row would be stored for nobody.
        await removeRecordingFiles(row.id);
        await this.prisma.remote_session_recordings.deleteMany({ where: { id: row.id } });
    }

    /* ------------------------------ cleanup ------------------------------ */

    @Cron("0 */10 * * * *")
    async scheduledSweep() {
        try {
            const r = await this.sweep();
            if (r.expired || r.interrupted || r.orphans) this.log.log(`cleanup: ${r.expired} expired, ${r.interrupted} cut short, ${r.orphans} stray folders`);
        } catch (e: any) {
            this.log.warn(`cleanup failed: ${e?.code ?? e?.message ?? e}`);
        }
    }

    /** Ends recordings that lost their browser, removes expired ones, and folders that belong to no recording. */
    async sweep(): Promise<{ expired: number; interrupted: number; orphans: number }> {
        const now = new Date();

        const stale = await this.prisma.remote_session_recordings.findMany({
            where: { status: "recording", OR: [{ last_chunk_at: { lt: new Date(now.getTime() - STALE_AFTER_MS) } }, { last_chunk_at: null, started_at: { lt: new Date(now.getTime() - STALE_AFTER_MS) } }] },
        });
        let interrupted = 0;
        for (const r of stale as Row[]) {
            if (r.chunk_count === 0) {
                await this.remove(r);
            } else {
                const res = await this.prisma.remote_session_recordings.updateMany({
                    where: { id: r.id, status: "recording" },
                    data: { status: "interrupted", ended_at: r.last_chunk_at ?? now, duration_ms: BigInt(this.elapsed(r)) },
                });
                interrupted += res.count;
            }
        }

        const expired = await this.prisma.remote_session_recordings.findMany({ where: { expires_at: { lt: now } } });
        for (const r of expired as Row[]) await this.remove(r);

        let orphans = 0;
        try {
            const root = recordingsRoot();
            const names = await fsp.readdir(root).catch(() => [] as string[]);
            const ids = names.filter((n) => isCanonicalUuid(n));
            if (ids.length) {
                const known = new Set((await this.prisma.remote_session_recordings.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((r) => r.id));
                for (const n of ids) {
                    if (known.has(n)) continue;
                    const st: any = await fsp.stat(`${root}/${n}`).catch(() => null);
                    if (st && now.getTime() - st.mtimeMs > ORPHAN_GRACE_MS) {
                        await removeRecordingFiles(n);
                        orphans++;
                    }
                }
            }
        } catch {
            // The next pass tries again.
        }
        return { expired: expired.length, interrupted, orphans };
    }
}
