// backend/src/system-health/system-health.service.ts
//
// Watches the RemoteIQ servers themselves: database, disk, memory, the job queue, backups and restore tests. Every minute it measures, stores the
// state, keeps a history of changes and tells the Owner (email / Slack / webhook as configured for backups) when something changes state.
// It also starts the monthly restore test: the newest good backup is restored into a scratch database and checked, and production is never touched.
import { Injectable, Logger } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import { PrismaService } from "../storage/prisma.service";
import { BackupsService } from "../backups/backups.service";
import { RestoreWorkerService } from "../backups/restore-worker.service";
import { NotifierService } from "../backups/notifier.service";
import {
    Result, RestoreFacts, Status, agentsCheck, backupCheck, webCheck, changeMessage, databaseCheck, diskCheck, memoryCheck, overall, queueCheck, restoreCheck, shouldStartRestore,
} from "./system-health.core";

@Injectable()
export class SystemHealthService {
    private readonly log = new Logger("SystemHealth");
    private busy = false;
    private lastRestoreStartAttempt = 0;

    constructor(
        private readonly prisma: PrismaService,
        private readonly backups: BackupsService,
        private readonly restoreWorker: RestoreWorkerService,
        private readonly notifier: NotifierService,
    ) { }

    /* ------------------------------- measuring ------------------------------- */

    async restoreFacts(): Promise<RestoreFacts> {
        const rows = await this.prisma.$queryRaw<Array<any>>`
            SELECT
              (SELECT max(finished_at) FROM public.backup_restores WHERE status = 'completed') AS good,
              (SELECT max(finished_at) FROM public.backup_restores WHERE status = 'failed') AS failed,
              (SELECT error FROM public.backup_restores WHERE status = 'failed' ORDER BY finished_at DESC NULLS LAST LIMIT 1) AS err,
              EXISTS (SELECT 1 FROM public.backup_restores WHERE status IN ('queued', 'running', 'pending')) AS running,
              EXISTS (SELECT 1 FROM public.backup_jobs WHERE status = 'completed' AND verified = true AND backup_kind = 'postgresql' AND checksum ~ '^[a-fA-F0-9]{64}$') AS testable`;
        const r = rows[0] ?? {};
        return { testableBackup: !!r.testable, lastGoodAt: r.good ?? null, lastFailedAt: r.failed ?? null, lastError: r.err ?? null, running: !!r.running };
    }

    async measure(now = new Date()): Promise<Result[]> {
        const out: Result[] = [];

        const t0 = Date.now();
        try { await this.prisma.$queryRaw`SELECT 1`; out.push(databaseCheck(Date.now() - t0)); }
        catch (e: any) { out.push(databaseCheck(null, String(e?.message ?? e).slice(0, 160))); return out; }

        const dir = process.env.BACKUP_DIR || "/var/remoteiq/backups";
        let free: number | null = null, total: number | null = null, where = dir;
        for (const p of [dir, process.cwd()]) {
            try { const s: any = await (fsp as any).statfs(p); free = Number(s.bavail) * Number(s.bsize); total = Number(s.blocks) * Number(s.bsize); where = p; break; } catch { /* try next */ }
        }
        out.push(diskCheck(free, total, where));
        out.push(memoryCheck(os.freemem(), os.totalmem()));

        const q = await this.prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*)::bigint AS n FROM public.jobs WHERE status = 'queued' AND created_at < now() - interval '30 minutes'`;
        out.push(queueCheck(Number(q[0]?.n ?? 0)));

        const b = await this.prisma.$queryRaw<Array<any>>`
            SELECT (SELECT max(finished_at) FROM public.backup_jobs WHERE status = 'completed') AS good,
                   (SELECT max(finished_at) FROM public.backup_jobs WHERE status = 'failed') AS failed`;
        const sizes = await this.prisma.$queryRaw<Array<{ size_bytes: bigint | null }>>`
            SELECT size_bytes FROM public.backup_jobs WHERE status = 'completed' AND size_bytes IS NOT NULL ORDER BY finished_at DESC NULLS LAST LIMIT 6`;
        out.push(backupCheck(b[0]?.good ?? null, now, b[0]?.failed ?? null, sizes.map((r) => Number(r.size_bytes))));

        const a = await this.prisma.$queryRaw<Array<{ total: bigint; r15: bigint; rday: bigint }>>`
            SELECT count(*)::bigint AS total,
                   count(*) FILTER (WHERE last_check_in_at > now() - interval '15 minutes')::bigint AS r15,
                   count(*) FILTER (WHERE last_check_in_at > now() - interval '1 day')::bigint AS rday FROM public.agents`;
        out.push(agentsCheck(Number(a[0]?.total ?? 0), Number(a[0]?.r15 ?? 0), Number(a[0]?.rday ?? 0)));

        // The console (what people open) and the address agents connect to, as the outside world reaches them.
        for (const [key, title, env, path] of [["frontend", "Web console", process.env.PUBLIC_CONSOLE_URL, "/"], ["agentport", "Agent connection address", process.env.PUBLIC_API_BASE_URL, "/healthz"]] as const) {
            const base = String(env ?? "").replace(/\/+$/, "");
            if (!/^https?:\/\//i.test(base)) continue;
            const t = Date.now();
            try {
                const res = await fetch(base + path, { redirect: "manual", signal: AbortSignal.timeout(8000) });
                out.push(webCheck(key, title, base, res.status >= 300 && res.status < 400 ? 200 : res.status, Date.now() - t));
            } catch (e: any) { out.push(webCheck(key, title, base, null, null, String(e?.cause?.code ?? e?.message ?? e).slice(0, 100))); }
        }

        out.push(restoreCheck(await this.restoreFacts(), now));
        return out;
    }

    /* -------------------------------- recording ------------------------------- */

    /** Store the readings, keep the history of changes, and tell the Owner about each change of state once. */
    async record(results: Result[]): Promise<void> {
        for (const r of results) {
            const cur = (await this.prisma.$queryRaw<Array<{ status: Status; notified: Status | null }>>`SELECT status, notified FROM public.system_health_state WHERE check_key = ${r.key}`)[0];
            if (!cur || cur.status !== r.status) {
                await this.prisma.$executeRaw`INSERT INTO public.system_health_events (check_key, from_status, to_status, detail) VALUES (${r.key}, ${cur?.status ?? null}, ${r.status}, ${r.detail})`;
            }
            const message = changeMessage(r, cur?.notified ?? null);
            if (message) {
                try { await this.notifier.send({ email: true, slack: true, webhook: true }, message.subject, message.body); }
                catch (e: any) { this.log.warn(`Could not send the health notice: ${e?.message ?? e}`); }
            }
            await this.prisma.$executeRaw`
                INSERT INTO public.system_health_state (check_key, status, detail, since, updated_at, notified)
                VALUES (${r.key}, ${r.status}, ${r.detail}, now(), now(), ${r.status})
                ON CONFLICT (check_key) DO UPDATE SET
                  since = CASE WHEN public.system_health_state.status = EXCLUDED.status THEN public.system_health_state.since ELSE now() END,
                  status = EXCLUDED.status, detail = EXCLUDED.detail, updated_at = now(), notified = EXCLUDED.notified`;
        }
        await this.prisma.$executeRaw`DELETE FROM public.system_health_events WHERE at < now() - interval '90 days'`;
    }

    /* --------------------------------- restore -------------------------------- */

    /** Start a restore test of the newest good backup when one is due (or when asked for). Returns what happened. */
    async maybeStartRestore(now = new Date(), force = false): Promise<{ started: boolean; reason: string; restoreId?: string }> {
        const facts = await this.restoreFacts();
        if (!force && !shouldStartRestore(facts, now)) return { started: false, reason: "not due" };
        if (force && facts.running) return { started: false, reason: "A restore test is already running." };
        const job = (await this.prisma.$queryRaw<Array<{ id: string }>>`
            SELECT id FROM public.backup_jobs WHERE status = 'completed' AND verified = true AND backup_kind = 'postgresql' AND checksum ~ '^[a-fA-F0-9]{64}$'
            ORDER BY finished_at DESC NULLS LAST LIMIT 1`)[0];
        if (!job) return { started: false, reason: "There is no completed, verified PostgreSQL backup to test." };
        const res = await this.backups.startRestore(job.id);
        this.restoreWorker.runOneIfAny().catch(() => { });
        return { started: true, reason: "started", restoreId: res.id };
    }

    /* ---------------------------------- loop ---------------------------------- */

    @Interval(60_000)
    async tick(): Promise<void> {
        if (this.busy) return;
        this.busy = true;
        try {
            await this.record(await this.measure());
            // The restore decision is made at most every ten minutes, so a failed start is not retried every minute.
            if (Date.now() - this.lastRestoreStartAttempt > 10 * 60_000) {
                this.lastRestoreStartAttempt = Date.now();
                const r = await this.maybeStartRestore();
                if (r.started) this.log.log(`Monthly restore test started (${r.restoreId}).`);
            }
        } catch (e: any) {
            this.log.warn(`Health check failed: ${e?.message ?? e}`);
        } finally { this.busy = false; }
    }

    /* ---------------------------------- view ---------------------------------- */

    async status() {
        const checks = await this.measure();
        await this.record(checks);
        const remote = (await this.prisma.$queryRaw<Array<{ total: bigint; relayed: bigint; relay_bytes: bigint }>>`
            SELECT count(*)::bigint AS total, count(*) FILTER (WHERE relay)::bigint AS relayed, COALESCE(sum(bytes_received) FILTER (WHERE relay), 0)::bigint AS relay_bytes
              FROM public.remote_session_transport WHERE started_at > now() - interval '30 days'`)[0];
        const rows = await this.prisma.$queryRaw<Array<{ check_key: string; since: Date }>>`SELECT check_key, since FROM public.system_health_state`;
        const since = new Map(rows.map((r) => [r.check_key, r.since]));
        const events = await this.prisma.$queryRaw<Array<any>>`SELECT check_key, from_status, to_status, detail, at FROM public.system_health_events ORDER BY at DESC LIMIT 40`;
        const restores = await this.prisma.$queryRaw<Array<any>>`
            SELECT id, status, requested_at, finished_at, error, verification FROM public.backup_restores ORDER BY requested_at DESC LIMIT 10`;
        return {
            overall: overall(checks),
            checkedAt: new Date().toISOString(),
            checks: checks.map((c) => ({ ...c, since: since.get(c.key)?.toISOString() ?? null })),
            events: events.map((e) => ({ check: e.check_key, from: e.from_status, to: e.to_status, detail: e.detail, at: new Date(e.at).toISOString() })),
            restores: restores.map((r) => ({
                id: r.id, status: r.status, requestedAt: new Date(r.requested_at).toISOString(), finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
                error: r.error ?? null, verification: r.verification ?? {},
            })),
            remoteSessions: { days: 30, sessions: Number(remote?.total ?? 0), relayed: Number(remote?.relayed ?? 0), relayGigabytes: Math.round((Number(remote?.relay_bytes ?? 0) / 1024 ** 3) * 100) / 100, freeAllowanceGigabytes: 1000 },
            server: { uptimeHours: Math.round(process.uptime() / 360) / 10, node: process.version, load: os.loadavg()[0] },
        };
    }
}
