// backend/src/vault/vault.service.ts
//
// The encrypted device-secrets vault: BitLocker recovery-key escrow and the managed local administrator password (LAPS style).
//   - Secrets are sealed with vault.crypto.ts (AES-256-GCM, device id + kind + ref as associated data) and never leave this service as
//     anything but the explicit reveal. Listings carry metadata only. The access table and the state table hold no secret material.
//   - The two script jobs are "secret jobs" (ADG_SECRET_JOB=1): when the result arrives, JobsService.finishJob stores a fixed text
//     instead of the output and calls the handlers registered here with the output in memory. Nothing is read back from the job later.
//   - Everything defaults off: a device is only touched when the effective policy says so (security.bitlockerEscrow, laps.*).
import { BadRequestException, ConflictException, HttpException, Injectable, Logger, NotFoundException, OnModuleInit } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { PrismaService } from "../storage/prisma.service";
import { OrganizationContextService } from "../storage/organization-context.service";
import { ClientAccessService, deviceSqlOf } from "../reports/client-access.service";
import { JobsService } from "../jobs/jobs.service";
import { SECRET_JOB_MARKER, registerSecretJobHandler, type SecretJobContext, type SecretJobResult } from "../jobs/secret-jobs";
import { PoliciesService } from "../policies/policies.service";
import { isLinuxOs, SecurityService, type SecurityDevice } from "../security/security.service";
import { isCanonicalUuid } from "../common/agent-lookup.util";
import { openSecret, sealSecret, VaultCryptoError } from "./vault.crypto";
import { DEVICE_REASONS, parseBitlockerKeys, parseLapsResult, parseLuksResult, VaultParseError, type LuksVolumeState } from "./vault.parsers";
import { BITLOCKER_KEYS_SCRIPT, LAPS_ROTATE_SCRIPT, LINUX_LAPS_ROTATE_SCRIPT, LINUX_LUKS_ESCROW_SCRIPT } from "./vault.scripts";
import { VaultLimiters } from "./vault.limiter";

export const TOOL_BITLOCKER = "vault.bitlocker";
export const TOOL_LAPS = "vault.laps";
/** Linux: adds a LUKS recovery key slot on a volume that unlocks without a passphrase (TPM2 or a key file) and stores the new key. */
export const TOOL_LUKS = "vault.luks";
export type SecretKind = "bitlocker_recovery" | "luks_recovery" | "local_admin";
export type SecretStatus = "current" | "previous" | "unconfirmed" | "purged";

/** How long a queued secret job may wait before it is given up on. */
export const PENDING_STALE_MS = 10 * 60_000;
export const KEEP_GENERATIONS = 3;
export const PREVIOUS_KEEP_DAYS = 30;
export const UNCONFIRMED_KEEP_DAYS = 7;
const JOB_TIMEOUT_SEC = 90;
/** Adding a recovery key slot runs a deliberately slow key derivation, up to four volumes. */
const LUKS_TIMEOUT_SEC = 420;
const ONLINE_WINDOW_MS = 5 * 60_000;
export const REASON_MIN = 5;
export const REASON_MAX = 300;
export const HIDE_AFTER_SEC = 60;

export type Actor = { id: string | null; name: string | null; email: string | null };
export type LapsSettings = { enabled: boolean; source: string | null; account: string; passwordLength: number; rotateDays: number; rotateAfterRevealMinutes: number };
export type EscrowSettings = { enabled: boolean; source: string | null };
type Db = Pick<Prisma.TransactionClient, "$queryRaw" | "$executeRaw">;

type SecretRow = {
    id: string; org_id: string; device_id: string; kind: SecretKind; label: string; ref: string; ciphertext: string | null; status: SecretStatus;
    created_at: Date; rotated_at: Date | null; last_revealed_at: Date | null; last_revealed_by: string | null;
};
type StateRow = {
    device_id: string; escrow_pending_job_id: string | null; escrow_pending_at: Date | null; escrow_attempted_at: Date | null; escrow_ok_at: Date | null; escrow_message: string | null;
    escrow_by_user: string | null; escrow_by_name: string | null; escrow_trigger: string | null;
    laps_pending_job_id: string | null; laps_pending_at: Date | null; laps_attempted_at: Date | null; laps_ok_at: Date | null; laps_attempt: string | null; laps_message: string | null;
    laps_by_user: string | null; laps_by_name: string | null; laps_trigger: string | null; laps_rotate_due_at: Date | null;
};

const errCode = (status: number, code: string, message: string, extra: Record<string, unknown> = {}) => new HttpException({ statusCode: status, code, message, ...extra }, status);
const tail = (s: string) => s.slice(-4);
const actorName = (a: Actor) => (a.name || a.email || "").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 200) || null;

/** The reason a person gives for a reveal: 5 to 300 characters once trimmed, no control characters. */
export function cleanReason(raw: unknown): string {
    const s = typeof raw === "string" ? raw.trim() : "";
    if (s.length < REASON_MIN || s.length > REASON_MAX) throw new BadRequestException(`Give a reason of ${REASON_MIN} to ${REASON_MAX} characters.`);
    if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(s)) throw new BadRequestException("The reason has characters that are not allowed.");
    return s;
}

export const lapsWarning = (status: SecretStatus, kind: SecretKind, newestIsUnconfirmed: boolean): string | null => {
    if (status === "unconfirmed") return "ADG RMM set this password on the device but could not confirm it with a test logon. If it does not work, try the previous password, which is also listed. This warning applies for 7 days.";
    if (status === "previous" && kind === "local_admin") return newestIsUnconfirmed ? "This is the password before the last change. The newer one could not be confirmed, so this one may still be the one that works." : "This password has been replaced. Use it only if the newer one does not work.";
    if (status === "previous") return "This recovery key belongs to a protector that is no longer on the device. It is kept in case the disk is restored from an old state.";
    return null;
};

@Injectable()
export class VaultService implements OnModuleInit {
    private readonly logger = new Logger(VaultService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly orgs: OrganizationContextService,
        private readonly access: ClientAccessService,
        private readonly jobs: JobsService,
        private readonly policies: PoliciesService,
        private readonly security: SecurityService,
        readonly limiters: VaultLimiters,
    ) { }

    onModuleInit() {
        registerSecretJobHandler(TOOL_BITLOCKER, { ingest: (tx, ctx, r) => this.ingestBitlocker(tx, ctx, r), failed: (tx, ctx, why) => this.failedJob(tx, ctx, why) });
        registerSecretJobHandler(TOOL_LAPS, { ingest: (tx, ctx, r) => this.ingestLaps(tx, ctx, r), failed: (tx, ctx, why) => this.failedJob(tx, ctx, why) });
        registerSecretJobHandler(TOOL_LUKS, { ingest: (tx, ctx, r) => this.ingestLuks(tx, ctx, r), failed: (tx, ctx, why) => this.failedJob(tx, ctx, why) });
    }

    /* ------------------------------ small helpers ------------------------------ */

    async device(id: string): Promise<SecurityDevice> {
        return this.security.device(id);
    }

    private async orgOf(db: Db, deviceId: string): Promise<string> {
        const r = await db.$queryRaw<{ org: string }[]>`SELECT c.organization_id::text AS org FROM public.devices d JOIN public.sites s ON s.id = d.site_id JOIN public.clients c ON c.id = s.client_id WHERE d.id = ${deviceId}::uuid`;
        if (r[0]?.org) return r[0].org;
        return this.orgs.getDefaultOrganizationId();
    }

    private async lock(db: Db, deviceId: string) {
        await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"adg-vault:" + deviceId}))`;
    }

    /** One access row. It never holds secret material: kind, label, who, why, outcome and a short fixed error code. */
    async recordAccess(db: Db, a: { deviceId: string; secretId?: string | null; kind?: SecretKind | null; label?: string | null; userId?: string | null; userName?: string | null; action: "reveal" | "escrow" | "rotate" | "rotate-requested" | "purge"; reason?: string | null; outcome: string; error?: string | null; at?: Date }) {
        const userId = a.userId && isCanonicalUuid(a.userId) ? a.userId : null;
        await db.$executeRaw`
            INSERT INTO public.device_secret_access (device_id, secret_id, secret_kind, label, user_id, user_name, at, action, reason, outcome, error)
            VALUES (${a.deviceId}::uuid, ${a.secretId ?? null}::uuid, ${a.kind ?? null}::text, ${a.label ? a.label.slice(0, 100) : null}::text, ${userId}::uuid, ${a.userName ? a.userName.slice(0, 200) : null}::text,
                    ${a.at ?? new Date()}::timestamptz, ${a.action}::text, ${a.reason ? a.reason.slice(0, 300) : null}::text, ${a.outcome.slice(0, 40)}::text, ${a.error ? a.error.slice(0, 120) : null}::text)`;
    }

    private async state(db: Db, deviceId: string): Promise<StateRow | null> {
        return (await db.$queryRaw<StateRow[]>`SELECT * FROM public.device_secret_state WHERE device_id = ${deviceId}::uuid`)[0] ?? null;
    }

    /** What the effective policy of a device says about escrow and the local administrator password. */
    async settingsOf(deviceIds: string[]): Promise<Map<string, { escrow: EscrowSettings; laps: LapsSettings }>> {
        const eff = deviceIds.length ? await this.policies.effectiveForDevices(deviceIds) : new Map();
        const out = new Map<string, { escrow: EscrowSettings; laps: LapsSettings }>();
        for (const id of deviceIds) {
            const sc = (eff.get(id)?.scalars ?? {}) as Record<string, { value: unknown; source: any } | undefined>;
            const src = (k: string): string | null => { const s = sc[k]?.source; return s ? (s.kind === "policy" ? String(s.name) : String(s.label ?? "")) : null; };
            const num = (k: string, d: number) => { const n = Number(sc[k]?.value); return Number.isFinite(n) ? n : d; };
            out.set(id, {
                escrow: { enabled: sc["security.bitlockerEscrow"]?.value === "on", source: src("security.bitlockerEscrow") },
                laps: {
                    enabled: sc["laps.enabled"]?.value === true, source: src("laps.enabled"),
                    account: typeof sc["laps.account"]?.value === "string" ? String(sc["laps.account"]!.value) : "adg-admin",
                    passwordLength: num("laps.passwordLength", 20), rotateDays: num("laps.rotateDays", 30), rotateAfterRevealMinutes: num("laps.rotateAfterRevealMinutes", 60),
                },
            });
        }
        return out;
    }

    /* ------------------------------ asking the device ------------------------------ */

    private requireActionable(d: SecurityDevice) {
        if (!d.windows && !d.linux) throw new BadRequestException("Device secrets are only available for Windows and Linux devices.");
        if (!d.agentId) throw new ConflictException("This device has no agent.");
        if (!d.online) throw new ConflictException("This device is offline. Storing keys or changing the password needs a device that is online now.");
    }

    /** One manual or bulk request: Windows, agent, online and switched on by policy. Returns whether a job was queued. */
    async requestEscrow(d: SecurityDevice, actor: Actor, trigger: "manual" | "bulk"): Promise<{ queued: boolean; alreadyWaiting: boolean }> {
        this.requireActionable(d);
        const s = (await this.settingsOf([d.id])).get(d.id)!;
        if (!s.escrow.enabled) throw new ConflictException("Storing disk recovery keys is off for this device by policy (Policies > Device secrets).");
        return this.startEscrow(d.id, d.agentId!, actor, trigger, new Date());
    }

    async requestRotate(d: SecurityDevice, actor: Actor, trigger: "manual" | "bulk"): Promise<{ queued: boolean; alreadyWaiting: boolean }> {
        this.requireActionable(d);
        const s = (await this.settingsOf([d.id])).get(d.id)!;
        if (!s.laps.enabled) throw new ConflictException("Managing the local administrator password is off for this device by policy (Policies > Device secrets).");
        const r = await this.startRotate(d.id, d.agentId!, s.laps, actor, trigger, new Date());
        if (r.queued) await this.recordAccess(this.prisma, { deviceId: d.id, kind: "local_admin", label: s.laps.account, userId: actor.id, userName: actorName(actor), action: "rotate-requested", reason: trigger, outcome: "queued" });
        return r;
    }

    /** Claims the device's pending slot (race safe), creates the job, notes its id. Used by requests and by the schedule. */
    private async claim(deviceId: string, which: "escrow" | "laps", actor: Actor | null, trigger: string, at: Date): Promise<string | null> {
        const placeholder = randomUUID();
        const stale = new Date(at.getTime() - PENDING_STALE_MS);
        const n = which === "escrow"
            ? await this.prisma.$executeRaw`
                INSERT INTO public.device_secret_state (device_id, escrow_pending_job_id, escrow_pending_at, escrow_attempted_at, escrow_by_user, escrow_by_name, escrow_trigger)
                VALUES (${deviceId}::uuid, ${placeholder}::uuid, ${at}::timestamptz, ${at}::timestamptz, ${actor?.id && isCanonicalUuid(actor.id) ? actor.id : null}::uuid, ${actor ? actorName(actor) : null}::text, ${trigger}::text)
                ON CONFLICT (device_id) DO UPDATE SET escrow_pending_job_id = EXCLUDED.escrow_pending_job_id, escrow_pending_at = EXCLUDED.escrow_pending_at, escrow_attempted_at = EXCLUDED.escrow_attempted_at,
                    escrow_by_user = EXCLUDED.escrow_by_user, escrow_by_name = EXCLUDED.escrow_by_name, escrow_trigger = EXCLUDED.escrow_trigger
                WHERE device_secret_state.escrow_pending_job_id IS NULL OR device_secret_state.escrow_pending_at < ${stale}::timestamptz`
            : await this.prisma.$executeRaw`
                INSERT INTO public.device_secret_state (device_id, laps_pending_job_id, laps_pending_at, laps_attempted_at, laps_by_user, laps_by_name, laps_trigger)
                VALUES (${deviceId}::uuid, ${placeholder}::uuid, ${at}::timestamptz, ${at}::timestamptz, ${actor?.id && isCanonicalUuid(actor.id) ? actor.id : null}::uuid, ${actor ? actorName(actor) : null}::text, ${trigger}::text)
                ON CONFLICT (device_id) DO UPDATE SET laps_pending_job_id = EXCLUDED.laps_pending_job_id, laps_pending_at = EXCLUDED.laps_pending_at, laps_attempted_at = EXCLUDED.laps_attempted_at,
                    laps_by_user = EXCLUDED.laps_by_user, laps_by_name = EXCLUDED.laps_by_name, laps_trigger = EXCLUDED.laps_trigger
                WHERE device_secret_state.laps_pending_job_id IS NULL OR device_secret_state.laps_pending_at < ${stale}::timestamptz`;
        return n > 0 ? placeholder : null;
    }

    private async release(deviceId: string, which: "escrow" | "laps", placeholder: string) {
        if (which === "escrow") await this.prisma.$executeRaw`UPDATE public.device_secret_state SET escrow_pending_job_id = NULL, escrow_pending_at = NULL WHERE device_id = ${deviceId}::uuid AND escrow_pending_job_id = ${placeholder}::uuid`;
        else await this.prisma.$executeRaw`UPDATE public.device_secret_state SET laps_pending_job_id = NULL, laps_pending_at = NULL WHERE device_id = ${deviceId}::uuid AND laps_pending_job_id = ${placeholder}::uuid`;
    }

    /** Whether the device behind an agent is a Linux machine (the scripts differ; the answers have the same shape). */
    private async isLinuxDevice(deviceId: string): Promise<boolean> {
        const r = await this.prisma.$queryRaw<{ os: string | null; name: string | null }[]>`
            SELECT a.facts->>'os' AS os, d.operating_system AS name FROM public.devices d LEFT JOIN public.agents a ON a.device_id = d.id WHERE d.id = ${deviceId}::uuid LIMIT 1`;
        return isLinuxOs(r[0]?.os, r[0]?.name);
    }

    async startEscrow(deviceId: string, agentId: string, actor: Actor | null, trigger: string, at: Date): Promise<{ queued: boolean; alreadyWaiting: boolean }> {
        const claim = await this.claim(deviceId, "escrow", actor, trigger, at);
        if (!claim) return { queued: false, alreadyWaiting: true };
        try {
            let job;
            if (await this.isLinuxDevice(deviceId)) {
                // The volumes that already have a stored key are listed, so the device adds a key slot only where there is none yet.
                const have = await this.prisma.$queryRaw<{ ref: string }[]>`SELECT ref FROM public.device_secrets WHERE device_id = ${deviceId}::uuid AND kind = 'luks_recovery' AND status = 'current'`;
                job = await this.jobs.createRunScriptJob({ agentId, language: "bash", scriptText: LINUX_LUKS_ESCROW_SCRIPT, env: { ADG_TOOL: TOOL_LUKS, [SECRET_JOB_MARKER]: "1", ADG_LUKS_HAVE: have.map((h) => h.ref).filter((r) => isCanonicalUuid(r)).join(",") }, timeoutSec: LUKS_TIMEOUT_SEC });
            } else {
                job = await this.jobs.createRunScriptJob({ agentId, language: "powershell", scriptText: BITLOCKER_KEYS_SCRIPT, env: { ADG_TOOL: TOOL_BITLOCKER, [SECRET_JOB_MARKER]: "1" }, timeoutSec: JOB_TIMEOUT_SEC });
            }
            await this.prisma.$executeRaw`UPDATE public.device_secret_state SET escrow_pending_job_id = ${job.id}::uuid WHERE device_id = ${deviceId}::uuid AND escrow_pending_job_id = ${claim}::uuid`;
        } catch (e) {
            await this.release(deviceId, "escrow", claim);
            throw e;
        }
        return { queued: true, alreadyWaiting: false };
    }

    async startRotate(deviceId: string, agentId: string, s: LapsSettings, actor: Actor | null, trigger: string, at: Date): Promise<{ queued: boolean; alreadyWaiting: boolean }> {
        const claim = await this.claim(deviceId, "laps", actor, trigger, at);
        if (!claim) return { queued: false, alreadyWaiting: true };
        try {
            const linux = await this.isLinuxDevice(deviceId);
            const job = await this.jobs.createRunScriptJob({
                agentId, language: linux ? "bash" : "powershell", scriptText: linux ? LINUX_LAPS_ROTATE_SCRIPT : LAPS_ROTATE_SCRIPT, timeoutSec: JOB_TIMEOUT_SEC,
                env: { ADG_TOOL: TOOL_LAPS, [SECRET_JOB_MARKER]: "1", ADG_LAPS_ACCOUNT: s.account, ADG_LAPS_LENGTH: String(s.passwordLength) },
            });
            await this.prisma.$executeRaw`UPDATE public.device_secret_state SET laps_pending_job_id = ${job.id}::uuid WHERE device_id = ${deviceId}::uuid AND laps_pending_job_id = ${claim}::uuid`;
        } catch (e) {
            await this.release(deviceId, "laps", claim);
            throw e;
        }
        return { queued: true, alreadyWaiting: false };
    }

    /** Gives up on secret jobs nobody answered for six minutes: the reason is kept, the stored secrets stay as they are. */
    async releaseStale(now: Date): Promise<number> {
        const stale = new Date(now.getTime() - PENDING_STALE_MS);
        const a = await this.prisma.$executeRaw`
            UPDATE public.device_secret_state SET escrow_pending_job_id = NULL, escrow_pending_at = NULL, escrow_message = 'The device did not answer in time.'
            WHERE escrow_pending_job_id IS NOT NULL AND escrow_pending_at < ${stale}::timestamptz`;
        const b = await this.prisma.$executeRaw`
            UPDATE public.device_secret_state SET laps_pending_job_id = NULL, laps_pending_at = NULL, laps_attempt = 'no_answer',
                laps_message = 'The device did not answer in time. If it changed the password anyway, the stored one may no longer be valid.'
            WHERE laps_pending_job_id IS NOT NULL AND laps_pending_at < ${stale}::timestamptz`;
        return a + b;
    }

    /* ------------------------------ results arriving (called by JobsService.finishJob) ------------------------------ */

    private async deviceOfAgent(tx: Db, agentId: string): Promise<string | null> {
        const r = await tx.$queryRaw<{ device_id: string | null }[]>`SELECT device_id::text AS device_id FROM public.agents WHERE id = ${agentId}::uuid`;
        return r[0]?.device_id ?? null;
    }

    private async ingestBitlocker(tx: Prisma.TransactionClient, ctx: SecretJobContext, r: SecretJobResult): Promise<boolean> {
        const deviceId = await this.deviceOfAgent(tx, ctx.agentId);
        if (!deviceId) return false;
        let keys;
        try {
            keys = parseBitlockerKeys(r.stdout);
        } catch (e) {
            if (e instanceof VaultParseError && e.code === "device_error") {
                const msg = DEVICE_REASONS[e.reason ?? "other"] ?? DEVICE_REASONS.other;
                await this.lock(tx, deviceId);
                const st = await this.state(tx, deviceId);
                await tx.$executeRaw`UPDATE public.device_secret_state SET escrow_pending_job_id = NULL, escrow_pending_at = NULL, escrow_attempted_at = now(), escrow_message = ${msg}::text WHERE device_id = ${deviceId}::uuid`;
                await this.recordAccess(tx, { deviceId, userId: st?.escrow_by_user, userName: st?.escrow_by_name ?? "ADG RMM (scheduled)", action: "escrow", reason: st?.escrow_trigger ?? null, outcome: "failed", error: e.reason ?? "other" });
                return true;
            }
            throw e;
        }
        await this.lock(tx, deviceId);
        const org = await this.orgOf(tx, deviceId);
        const st = await this.state(tx, deviceId);
        let added = 0;
        const seen = new Set<string>();
        for (const k of keys) {
            seen.add(k.protectorId);
            const cur = (await tx.$queryRaw<{ id: string; ciphertext: string }[]>`SELECT id::text AS id, ciphertext FROM public.device_secrets WHERE device_id = ${deviceId}::uuid AND kind = 'bitlocker_recovery' AND ref = ${k.protectorId}::text AND status = 'current'`)[0];
            if (cur) {
                let same = false;
                try {
                    const a = Buffer.from(openSecret(cur.ciphertext, { deviceId, kind: "bitlocker_recovery", ref: k.protectorId }));
                    const b = Buffer.from(k.recoveryPassword);
                    same = a.length === b.length && timingSafeEqual(a, b);
                } catch { same = false; }
                if (same) {
                    await tx.$executeRaw`UPDATE public.device_secrets SET last_seen_at = now(), missed_reads = 0, label = ${k.mount}::text WHERE id = ${cur.id}::uuid`;
                    continue;
                }
                await tx.$executeRaw`UPDATE public.device_secrets SET status = 'previous', superseded_at = now() WHERE id = ${cur.id}::uuid`;
            }
            const sealed = sealSecret(k.recoveryPassword, { deviceId, kind: "bitlocker_recovery", ref: k.protectorId });
            await tx.$executeRaw`
                INSERT INTO public.device_secrets (org_id, device_id, kind, label, ref, ciphertext, key_version, key_id, last_seen_at, status)
                VALUES (${org}::uuid, ${deviceId}::uuid, 'bitlocker_recovery', ${k.mount}::text, ${k.protectorId}::text, ${sealed.ciphertext}::text, ${sealed.keyVersion}::int, ${sealed.keyId}::text, now(), 'current')`;
            added++;
        }
        // A key that was not listed is only retired after two successful reads in a row without it.
        const missing = (await tx.$queryRaw<{ id: string; ref: string }[]>`SELECT id::text AS id, ref FROM public.device_secrets WHERE device_id = ${deviceId}::uuid AND kind = 'bitlocker_recovery' AND status = 'current'`).filter((m) => !seen.has(m.ref));
        for (const m of missing) {
            await tx.$executeRaw`UPDATE public.device_secrets SET missed_reads = missed_reads + 1 WHERE id = ${m.id}::uuid`;
            await tx.$executeRaw`UPDATE public.device_secrets SET status = 'previous', superseded_at = now() WHERE id = ${m.id}::uuid AND missed_reads >= 2`;
        }
        await tx.$executeRaw`
            INSERT INTO public.device_secret_state (device_id, escrow_attempted_at, escrow_ok_at, escrow_message) VALUES (${deviceId}::uuid, now(), now(), NULL)
            ON CONFLICT (device_id) DO UPDATE SET escrow_pending_job_id = NULL, escrow_pending_at = NULL, escrow_attempted_at = now(), escrow_ok_at = now(), escrow_message = NULL`;
        const trigger = st?.escrow_trigger ?? "scheduled";
        if (added > 0 || trigger !== "scheduled") {
            await this.recordAccess(tx, { deviceId, userId: st?.escrow_by_user, userName: st?.escrow_by_name ?? "ADG RMM (scheduled)", action: "escrow", reason: trigger, outcome: "ok", error: null, label: `${keys.length} read, ${added} new` });
        }
        return true;
    }

    /** LUKS: only the keys just added are stored (a key that is not listed again is not retired: there is nothing to re-read on Linux). */
    private async ingestLuks(tx: Prisma.TransactionClient, ctx: SecretJobContext, r: SecretJobResult): Promise<boolean> {
        const deviceId = await this.deviceOfAgent(tx, ctx.agentId);
        if (!deviceId) return false;
        let res;
        try {
            res = parseLuksResult(r.stdout);
        } catch (e) {
            if (e instanceof VaultParseError && e.code === "device_error") {
                const msg = DEVICE_REASONS[e.reason ?? "other"] ?? DEVICE_REASONS.other;
                await this.lock(tx, deviceId);
                const st = await this.state(tx, deviceId);
                await tx.$executeRaw`UPDATE public.device_secret_state SET escrow_pending_job_id = NULL, escrow_pending_at = NULL, escrow_attempted_at = now(), escrow_message = ${msg}::text WHERE device_id = ${deviceId}::uuid`;
                await this.recordAccess(tx, { deviceId, userId: st?.escrow_by_user, userName: st?.escrow_by_name ?? "ADG RMM (scheduled)", action: "escrow", reason: st?.escrow_trigger ?? null, outcome: "failed", error: e.reason ?? "other" });
                return true;
            }
            throw e;
        }
        await this.lock(tx, deviceId);
        const org = await this.orgOf(tx, deviceId);
        const st = await this.state(tx, deviceId);
        let added = 0;
        for (const k of res.keys) {
            const cur = (await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM public.device_secrets WHERE device_id = ${deviceId}::uuid AND kind = 'luks_recovery' AND ref = ${k.protectorId}::text AND status = 'current'`)[0];
            // A second key for a volume that already has one is kept as the newest; the older one stays valid on the volume, so it is kept too.
            if (cur) await tx.$executeRaw`UPDATE public.device_secrets SET status = 'previous', superseded_at = now() WHERE id = ${cur.id}::uuid`;
            const sealed = sealSecret(k.recoveryPassword, { deviceId, kind: "luks_recovery", ref: k.protectorId });
            await tx.$executeRaw`
                INSERT INTO public.device_secrets (org_id, device_id, kind, label, ref, ciphertext, key_version, key_id, last_seen_at, status)
                VALUES (${org}::uuid, ${deviceId}::uuid, 'luks_recovery', ${k.mount}::text, ${k.protectorId}::text, ${sealed.ciphertext}::text, ${sealed.keyVersion}::int, ${sealed.keyId}::text, now(), 'current')`;
            added++;
        }
        const count = (s: LuksVolumeState) => res.volumes.filter((v) => v.state === s).length;
        const problems: string[] = [];
        if (count("no_unlock")) problems.push(`${count("no_unlock")} encrypted volume(s) could not get a recovery key: ADG RMM can only add one without the passphrase when the volume unlocks with the machine's TPM or with a key file listed in /etc/crypttab`);
        if (count("no_cryptenroll")) problems.push(`${count("no_cryptenroll")} volume(s) need systemd-cryptenroll from systemd 248 or newer`);
        if (count("not_luks2")) problems.push(`${count("not_luks2")} volume(s) use LUKS1, which cannot be given a recovery key this way`);
        if (count("unreadable")) problems.push(`${count("unreadable")} volume(s) got a new recovery key slot but the key could not be read back, so it is lost; remove the extra slot with cryptsetup luksKillSlot`);
        if (count("later")) problems.push(`${count("later")} more volume(s) will be done on the next run`);
        const message = problems.length ? problems.join(". ") + "." : null;
        await tx.$executeRaw`
            INSERT INTO public.device_secret_state (device_id, escrow_attempted_at, escrow_ok_at, escrow_message) VALUES (${deviceId}::uuid, now(), now(), ${message}::text)
            ON CONFLICT (device_id) DO UPDATE SET escrow_pending_job_id = NULL, escrow_pending_at = NULL, escrow_attempted_at = now(), escrow_ok_at = now(), escrow_message = ${message}::text`;
        const trigger = st?.escrow_trigger ?? "scheduled";
        if (added > 0 || trigger !== "scheduled") {
            await this.recordAccess(tx, { deviceId, userId: st?.escrow_by_user, userName: st?.escrow_by_name ?? "ADG RMM (scheduled)", action: "escrow", reason: trigger, outcome: added > 0 || !problems.length ? "ok" : "failed", error: null, label: `${res.volumes.length} volume(s), ${added} new key(s)` });
        }
        return true;
    }

    private async ingestLaps(tx: Prisma.TransactionClient, ctx: SecretJobContext, r: SecretJobResult): Promise<boolean> {
        const deviceId = await this.deviceOfAgent(tx, ctx.agentId);
        if (!deviceId) return false;
        const expected = { account: String(ctx.env.ADG_LAPS_ACCOUNT ?? ""), length: Number(ctx.env.ADG_LAPS_LENGTH) };
        let res;
        try {
            res = parseLapsResult(r.stdout, expected);
        } catch (e) {
            if (e instanceof VaultParseError && e.code === "device_error") {
                const msg = DEVICE_REASONS[e.reason ?? "other"] ?? DEVICE_REASONS.other;
                await this.lock(tx, deviceId);
                const st = await this.state(tx, deviceId);
                await tx.$executeRaw`UPDATE public.device_secret_state SET laps_pending_job_id = NULL, laps_pending_at = NULL, laps_attempted_at = now(), laps_attempt = 'failed', laps_message = ${msg}::text WHERE device_id = ${deviceId}::uuid`;
                await this.recordAccess(tx, { deviceId, kind: "local_admin", label: expected.account, userId: st?.laps_by_user, userName: st?.laps_by_name ?? "ADG RMM (scheduled)", action: "rotate", reason: st?.laps_trigger ?? null, outcome: "failed", error: e.reason ?? "other" });
                return true;
            }
            throw e;
        }
        await this.lock(tx, deviceId);
        const org = await this.orgOf(tx, deviceId);
        const st = await this.state(tx, deviceId);
        const ref = randomUUID();
        const sealed = sealSecret(res.password, { deviceId, kind: "local_admin", ref });
        // The newest generation becomes current (or unconfirmed); what was current or unconfirmed is kept as previous.
        await tx.$executeRaw`UPDATE public.device_secrets SET status = 'previous', superseded_at = now() WHERE device_id = ${deviceId}::uuid AND kind = 'local_admin' AND status IN ('current', 'unconfirmed')`;
        const status: SecretStatus = res.verified ? "current" : "unconfirmed";
        const row = await tx.$queryRaw<{ id: string }[]>`
            INSERT INTO public.device_secrets (org_id, device_id, kind, label, ref, ciphertext, key_version, key_id, rotated_at, last_seen_at, status)
            VALUES (${org}::uuid, ${deviceId}::uuid, 'local_admin', ${res.account}::text, ${ref}::text, ${sealed.ciphertext}::text, ${sealed.keyVersion}::int, ${sealed.keyId}::text, now(), now(), ${status}::text)
            RETURNING id::text AS id`;
        await this.pruneGenerations(tx, deviceId);
        const message = res.verified ? null : "The new password was set but a test logon did not confirm it. Both this and the previous password can be revealed for 7 days.";
        await tx.$executeRaw`
            UPDATE public.device_secret_state SET laps_pending_job_id = NULL, laps_pending_at = NULL, laps_attempted_at = now(), laps_ok_at = ${res.verified ? new Date() : st?.laps_ok_at ?? null}::timestamptz,
                laps_attempt = ${res.verified ? "ok" : "unconfirmed"}::text, laps_message = ${message}::text, laps_rotate_due_at = NULL
            WHERE device_id = ${deviceId}::uuid`;
        await this.recordAccess(tx, {
            deviceId, secretId: row[0]?.id, kind: "local_admin", label: res.account, userId: st?.laps_by_user, userName: st?.laps_by_name ?? "ADG RMM (scheduled)",
            action: "rotate", reason: st?.laps_trigger ?? null, outcome: res.verified ? "ok" : "unconfirmed",
        });
        return true;
    }

    /** The job gave nothing usable (timeout, a failed script with no readable answer, garbled output). No output reaches here. */
    private async failedJob(tx: Prisma.TransactionClient, ctx: SecretJobContext, why: "timeout" | "failed" | "unreadable"): Promise<void> {
        const deviceId = await this.deviceOfAgent(tx, ctx.agentId);
        if (!deviceId) return;
        const text = why === "timeout" ? "The device took too long to answer." : why === "failed" ? "The script failed on the device." : "The device's answer could not be read, so nothing was stored (the output was discarded).";
        if (ctx.tool === TOOL_BITLOCKER || ctx.tool === TOOL_LUKS) {
            const st = await this.state(tx, deviceId);
            await tx.$executeRaw`UPDATE public.device_secret_state SET escrow_pending_job_id = NULL, escrow_pending_at = NULL, escrow_attempted_at = now(), escrow_message = ${text}::text WHERE device_id = ${deviceId}::uuid`;
            await this.recordAccess(tx, { deviceId, userId: st?.escrow_by_user, userName: st?.escrow_by_name ?? "ADG RMM (scheduled)", action: "escrow", reason: st?.escrow_trigger ?? null, outcome: "failed", error: why });
        } else {
            const st = await this.state(tx, deviceId);
            const message = `${text} If the device changed the password anyway, the stored one may no longer be valid.`;
            await tx.$executeRaw`UPDATE public.device_secret_state SET laps_pending_job_id = NULL, laps_pending_at = NULL, laps_attempted_at = now(), laps_attempt = ${why === "timeout" ? "no_answer" : "failed"}::text, laps_message = ${message}::text WHERE device_id = ${deviceId}::uuid`;
            await this.recordAccess(tx, { deviceId, kind: "local_admin", label: String(ctx.env.ADG_LAPS_ACCOUNT ?? "") || null, userId: st?.laps_by_user, userName: st?.laps_by_name ?? "ADG RMM (scheduled)", action: "rotate", reason: st?.laps_trigger ?? null, outcome: "failed", error: why });
        }
    }

    /** Keeps the newest three generations of a local admin password; older ones lose their ciphertext. */
    private async pruneGenerations(db: Db, deviceId: string) {
        await db.$executeRaw`
            WITH p AS (
                UPDATE public.device_secrets SET status = 'purged', ciphertext = NULL
                WHERE id IN (SELECT id FROM (SELECT id, row_number() OVER (ORDER BY created_at DESC, id) AS rn FROM public.device_secrets WHERE device_id = ${deviceId}::uuid AND kind = 'local_admin' AND status <> 'purged') x WHERE rn > ${KEEP_GENERATIONS})
                RETURNING id, device_id, kind, label)
            INSERT INTO public.device_secret_access (device_id, secret_id, secret_kind, label, action, reason, outcome)
            SELECT device_id, id, kind, label, 'purge', 'only the last 3 passwords are kept', 'ok' FROM p`;
    }

    /** The sweeper: removes what is past its time. Returns how many secrets lost their ciphertext. */
    async purge(now: Date): Promise<number> {
        const prev = new Date(now.getTime() - PREVIOUS_KEEP_DAYS * 86_400_000);
        const unc = new Date(now.getTime() - UNCONFIRMED_KEEP_DAYS * 86_400_000);
        const rows = await this.prisma.$queryRaw<{ id: string }[]>`
            WITH p AS (
                UPDATE public.device_secrets SET status = 'purged', ciphertext = NULL
                WHERE kind = 'local_admin' AND status <> 'purged' AND (
                    (status = 'previous' AND COALESCE(superseded_at, created_at) < ${prev}::timestamptz)
                    OR (status = 'unconfirmed' AND created_at < ${unc}::timestamptz)
                    OR id IN (SELECT id FROM (SELECT id, row_number() OVER (PARTITION BY device_id ORDER BY created_at DESC, id) AS rn FROM public.device_secrets WHERE kind = 'local_admin' AND status <> 'purged') x WHERE rn > ${KEEP_GENERATIONS}))
                RETURNING id, device_id, kind, label),
            a AS (
                INSERT INTO public.device_secret_access (device_id, secret_id, secret_kind, label, action, reason, outcome, at)
                SELECT device_id, id, kind, label, 'purge', 'retention', 'ok', ${now}::timestamptz FROM p RETURNING 1)
            SELECT id::text AS id FROM p`;
        return rows.length;
    }

    /* ------------------------------ reading ------------------------------ */

    /** Metadata only: never the ciphertext, never the secret. */
    async view(d: SecurityDevice, can: { reveal: boolean; manage: boolean }, now = new Date()) {
        const base = { device: { id: d.id, name: d.name }, windows: d.windows, linux: d.linux, online: d.online, hasAgent: !!d.agentId, canReveal: can.reveal, canManage: can.manage };
        const s = (await this.settingsOf([d.id])).get(d.id)!;
        const st = d.windows || d.linux ? await this.state(this.prisma, d.id) : null;
        const rows = d.windows || d.linux
            ? await this.prisma.$queryRaw<SecretRow[]>`
                SELECT id::text AS id, org_id::text AS org_id, device_id::text AS device_id, kind, label, ref, NULL::text AS ciphertext, status, created_at, rotated_at, last_revealed_at, last_revealed_by
                FROM public.device_secrets WHERE device_id = ${d.id}::uuid AND status <> 'purged' ORDER BY kind, label, created_at DESC`
            : [];
        const newestAdmin = rows.filter((r) => r.kind === "local_admin")[0];
        const items = rows.map((r) => ({
            id: r.id, kind: r.kind, label: r.label, refTail: tail(r.ref), status: r.status as Exclude<SecretStatus, "purged">,
            createdAt: r.created_at.toISOString(), rotatedAt: r.rotated_at?.toISOString() ?? null,
            lastRevealedAt: r.last_revealed_at?.toISOString() ?? null, lastRevealedBy: r.last_revealed_by,
            warning: lapsWarning(r.status, r.kind, newestAdmin?.status === "unconfirmed"),
        }));
        const current = rows.find((r) => r.kind === "local_admin" && r.status === "current");
        const anyAdmin = rows.some((r) => r.kind === "local_admin");
        const pendingFresh = (id: string | null | undefined, at: Date | null | undefined) => !!id && !!at && now.getTime() - at.getTime() <= PENDING_STALE_MS;
        const recent = await this.prisma.$queryRaw<{ id: string; at: Date; user_name: string | null; action: string; label: string | null; reason: string | null; outcome: string }[]>`
            SELECT id::text AS id, at, user_name, action, label, reason, outcome FROM public.device_secret_access WHERE device_id = ${d.id}::uuid ORDER BY at DESC LIMIT 10`;
        return {
            ...base,
            escrow: { enabled: s.escrow.enabled, source: s.escrow.source, pending: pendingFresh(st?.escrow_pending_job_id, st?.escrow_pending_at), lastOkAt: st?.escrow_ok_at?.toISOString() ?? null, lastAttemptAt: st?.escrow_attempted_at?.toISOString() ?? null, message: st?.escrow_message ?? null },
            laps: {
                enabled: s.laps.enabled, source: s.laps.source, account: s.laps.account, passwordLength: s.laps.passwordLength, rotateDays: s.laps.rotateDays, rotateAfterRevealMinutes: s.laps.rotateAfterRevealMinutes,
                pending: pendingFresh(st?.laps_pending_job_id, st?.laps_pending_at), lastOkAt: st?.laps_ok_at?.toISOString() ?? null, lastAttemptAt: st?.laps_attempted_at?.toISOString() ?? null,
                attempt: (st?.laps_attempt as "ok" | "failed" | "unconfirmed" | "no_answer" | null) ?? null, message: st?.laps_message ?? null,
                nextRotationAt: s.laps.enabled ? new Date(current ? (current.rotated_at ?? current.created_at).getTime() + s.laps.rotateDays * 86_400_000 : now.getTime()).toISOString() : null,
                rotateDueAt: s.laps.enabled ? st?.laps_rotate_due_at?.toISOString() ?? null : null,
                mayStillBeValid: !s.laps.enabled && anyAdmin,
            },
            items,
            recentAccess: recent.map((r) => ({ id: r.id, at: r.at.toISOString(), userName: r.user_name, action: r.action, label: r.label, reason: r.reason, outcome: r.outcome })),
        };
    }

    /* ------------------------------ reveal ------------------------------ */

    /**
     * Gives one secret back once. Every attempt counts against the limits (also refused ones). The caller writes the audit event; the
     * access row is written here, with the reason and never the value.
     */
    async reveal(d: SecurityDevice, secretId: string, actor: Actor, rawReason: unknown, now = new Date()) {
        const who = actorName(actor);
        const note = (kind: SecretKind | null, label: string | null, outcome: string, error: string | null, reason: string | null, secret: string | null = null) =>
            this.recordAccess(this.prisma, { deviceId: d.id, secretId: secret, kind, label, userId: actor.id, userName: who, action: "reveal", reason, outcome, error });

        this.limiters.reveal.take(actor.id ?? "none", d.id, (v) => { void note(null, null, "refused", `rate_limited_${v.scope}`, null).catch(() => undefined); });

        let reason: string;
        try { reason = cleanReason(rawReason); } catch (e) { await note(null, null, "refused", "bad_reason", null); throw errCode(400, "bad_reason", (e as HttpException).message); }

        if (!isCanonicalUuid(secretId)) { await note(null, null, "refused", "not_found", reason); throw new NotFoundException("Secret not found"); }
        const row = (await this.prisma.$queryRaw<(SecretRow & { ciphertext: string })[]>`
            SELECT id::text AS id, org_id::text AS org_id, device_id::text AS device_id, kind, label, ref, ciphertext, status, created_at, rotated_at, last_revealed_at, last_revealed_by
            FROM public.device_secrets WHERE id = ${secretId}::uuid AND device_id = ${d.id}::uuid AND status <> 'purged'`)[0];
        if (!row) { await note(null, null, "refused", "not_found", reason); throw new NotFoundException("Secret not found"); }

        let plain: string;
        try {
            plain = openSecret(row.ciphertext, { deviceId: d.id, kind: row.kind, ref: row.ref });
        } catch (e) {
            const code = e instanceof VaultCryptoError ? e.code : "decrypt_failed";
            await note(row.kind, row.label, "failed", code, reason, row.id);
            throw errCode(500, "cannot_open", code === "wrong_key" ? "This secret was stored with a different server encryption key (DATA_ENCRYPTION_KEY) and cannot be opened." : "This secret could not be opened because it failed its integrity check.");
        }
        await this.prisma.$executeRaw`UPDATE public.device_secrets SET last_revealed_at = ${now}::timestamptz, last_revealed_by = ${who}::text WHERE id = ${row.id}::uuid`;

        // A revealed local administrator password stops working a little later (the policy says how much later; 0 = never).
        let rotateAt: Date | null = null;
        if (row.kind === "local_admin") {
            const s = (await this.settingsOf([d.id])).get(d.id)!;
            if (s.laps.enabled && s.laps.rotateAfterRevealMinutes > 0) {
                rotateAt = new Date(now.getTime() + s.laps.rotateAfterRevealMinutes * 60_000);
                await this.prisma.$executeRaw`
                    INSERT INTO public.device_secret_state (device_id, laps_rotate_due_at) VALUES (${d.id}::uuid, ${rotateAt}::timestamptz)
                    ON CONFLICT (device_id) DO UPDATE SET laps_rotate_due_at = LEAST(COALESCE(device_secret_state.laps_rotate_due_at, EXCLUDED.laps_rotate_due_at), EXCLUDED.laps_rotate_due_at)`;
            }
        }
        await note(row.kind, row.label, "ok", null, reason, row.id);
        const newest = row.kind === "local_admin"
            ? (await this.prisma.$queryRaw<{ status: string }[]>`SELECT status FROM public.device_secrets WHERE device_id = ${d.id}::uuid AND kind = 'local_admin' AND status <> 'purged' ORDER BY created_at DESC LIMIT 1`)[0]
            : undefined;
        return {
            payload: { secret: plain, kind: row.kind, label: row.label, refTail: tail(row.ref), status: row.status, warning: lapsWarning(row.status, row.kind, newest?.status === "unconfirmed"), revealedAt: now.toISOString(), hideAfterSec: HIDE_AFTER_SEC, rotateAt: rotateAt?.toISOString() ?? null },
            audit: { kind: row.kind, label: row.label, ref: tail(row.ref), status: row.status, reason },
        };
    }

    /** A refused reveal that the limiter or validation stopped, for the audit trail (no secret involved). */
    describeRefusal(e: unknown): { code: string; message: string } {
        if (e instanceof HttpException) { const b: any = e.getResponse(); return { code: String(b?.code ?? e.getStatus()), message: String(b?.message ?? e.message).slice(0, 200) }; }
        return { code: "error", message: "error" };
    }

    /* ------------------------------ the access log ------------------------------ */

    async accessLog(userId: string | null, q: { clientId?: string; deviceId?: string; user?: string; limit?: unknown; offset?: unknown }) {
        const num = (raw: unknown, def: number, min: number, max: number, what: string) => {
            if (raw === undefined || raw === null || raw === "") return def;
            const n = Number(raw);
            if (!Number.isInteger(n) || n < min || n > max) throw new BadRequestException(`${what} must be a whole number from ${min} to ${max}.`);
            return n;
        };
        const limit = num(q.limit, 50, 1, 200, "The limit");
        const offset = num(q.offset, 0, 0, 1_000_000, "The offset");
        if (q.clientId !== undefined && q.clientId !== "" && !isCanonicalUuid(q.clientId)) throw new BadRequestException("That is not a customer id.");
        if (q.deviceId !== undefined && q.deviceId !== "" && !isCanonicalUuid(q.deviceId)) throw new BadRequestException("That is not a device id.");
        const user = String(q.user ?? "").trim();
        if (user.length > 100 || /[\u0000-\u001f\u007f]/.test(user)) throw new BadRequestException("The person filter is not valid.");
        const orgId = await this.orgs.getDefaultOrganizationId();
        const scope = await this.access.scopeFor(userId);
        const conds: Prisma.Sql[] = [Prisma.sql`c.organization_id = ${orgId}::uuid`];
        if (q.clientId) conds.push(Prisma.sql`st.client_id = ${q.clientId}::uuid`);
        if (q.deviceId) conds.push(Prisma.sql`a.device_id = ${q.deviceId}::uuid`);
        if (user) {
            const like = `%${user.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
            conds.push(isCanonicalUuid(user) ? Prisma.sql`(a.user_id = ${user}::uuid OR a.user_name ILIKE ${like})` : Prisma.sql`a.user_name ILIKE ${like}`);
        }
        if (scope) conds.push(deviceSqlOf(scope, { client: Prisma.sql`st.client_id::text`, site: Prisma.sql`d.site_id::text`, id: Prisma.sql`d.id::text` }));
        const where = Prisma.join(conds, " AND ");
        const from = Prisma.sql`FROM public.device_secret_access a JOIN public.devices d ON d.id = a.device_id JOIN public.sites st ON st.id = d.site_id JOIN public.clients c ON c.id = st.client_id`;
        const [total, rows] = await Promise.all([
            this.prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n ${from} WHERE ${where}`,
            this.prisma.$queryRaw<any[]>`
                SELECT a.id::text AS id, a.at, a.device_id::text AS device_id, COALESCE(d.alias, d.hostname) AS device_name, c.name AS customer, a.secret_kind, a.label,
                       a.user_id::text AS user_id, a.user_name, a.action, a.reason, a.outcome, a.error
                ${from} WHERE ${where} ORDER BY a.at DESC, a.id LIMIT ${limit} OFFSET ${offset}`,
        ]);
        return {
            total: total[0]?.n ?? 0, limit, offset,
            items: rows.map((r) => ({ id: r.id, at: new Date(r.at).toISOString(), deviceId: r.device_id, deviceName: r.device_name, customer: r.customer ?? null, secretKind: r.secret_kind ?? null, label: r.label ?? null, userId: r.user_id ?? null, userName: r.user_name ?? null, action: r.action, reason: r.reason ?? null, outcome: r.outcome, error: r.error ?? null })),
        };
    }

    static readonly ONLINE_WINDOW_MS = ONLINE_WINDOW_MS;
}
