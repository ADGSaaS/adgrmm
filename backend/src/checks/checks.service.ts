// backend/src/checks/checks.service.ts
import { Inject, Injectable, Logger, NotImplementedException, forwardRef } from '@nestjs/common';
import { AlertsService } from '../alerts/alerts.service';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../storage/prisma.service';
import { UiSocketRegistry } from '../common/ui-socket-registry.service';

/* ========================= Types / helpers ========================= */

export enum CheckScope {
    DEVICE = 'DEVICE',
    SITE = 'SITE',
    CLIENT = 'CLIENT',
    GLOBAL = 'GLOBAL',
}

export enum CheckType {
    PING = 'PING',
    CPU = 'CPU',
    MEMORY = 'MEMORY',
    DISK = 'DISK',
    SERVICE = 'SERVICE',
    PROCESS = 'PROCESS',
    PORT = 'PORT',
    WINEVENT = 'WINEVENT',
    SOFTWARE = 'SOFTWARE',
    SECURITY = 'SECURITY',
    SCRIPT = 'SCRIPT',
    PATCH = 'PATCH',
    CERT = 'CERT',
    SMART = 'SMART',
    RDP = 'RDP',
    SMB = 'SMB',
    FIREWALL = 'FIREWALL',
}

export type DeviceCheckDTO = {
    id: string; // assignment id (device-scoped)
    name: string;
    status: 'Passing' | 'Warning' | 'Failing';
    lastRun: string | null;
    output: string;
};

type NormalizedRunStatus = 'OK' | 'WARN' | 'CRIT' | 'TIMEOUT' | 'UNKNOWN';

function normalizeStatus(s?: string | null): NormalizedRunStatus {
    const t = String(s || '').trim().toUpperCase();
    if (t === 'OK' || t === 'PASS' || t === 'PASSING') return 'OK';
    if (t === 'WARN' || t === 'WARNING') return 'WARN';
    if (t === 'TIMEOUT') return 'TIMEOUT';
    if (t === 'CRIT' || t === 'ERROR' || t === 'FAIL' || t === 'FAILING') return 'CRIT';
    return 'UNKNOWN';
}

function toUiStatus(s?: string | null): DeviceCheckDTO['status'] {
    switch (normalizeStatus(s)) {
        case 'OK': return 'Passing';
        case 'WARN': return 'Warning';
        default: return 'Failing';
    }
}

/* =============================== Service =============================== */

@Injectable()
export class ChecksService {
    private readonly logger = new Logger(ChecksService.name);

    // per-device debounce to avoid floods; value is NodeJS.Timeout in Node
    private readonly deviceDebounce = new Map<string, ReturnType<typeof setTimeout>>();

    constructor(
        @Inject(forwardRef(() => AlertsService)) private readonly alerts: AlertsService,
        private readonly prisma: PrismaService,
        private readonly uiSockets: UiSocketRegistry,
    ) { }

    /* ====================== Public read for UI ====================== */

    async listByDevice(deviceId: string, limit = 100): Promise<{ items: DeviceCheckDTO[] }> {
        if (!Number.isFinite(limit) || limit < 1) limit = 1;
        if (limit > 200) limit = 200;

        // Latest run per assignment + assignment name; the sort on the computed name must follow the database collation.
        try {
            const rows = await this.prisma.$queryRaw<Array<{
                assignment_id: string;
                check_name: string | null;
                run_status: string | null;
                run_output: string | null;
                last_run: Date | string | null;
            }>>`
      WITH latest_run AS (
        SELECT
          cr.assignment_id,
          cr.status,
          cr.output,
          cr.finished_at AS last_run,
          ROW_NUMBER() OVER (PARTITION BY cr.assignment_id ORDER BY cr.finished_at DESC NULLS LAST) AS rn
        FROM public.check_runs cr
        WHERE cr.device_id = ${deviceId}
      )
      SELECT
        a.id::text                AS assignment_id,
        COALESCE(NULLIF(a.check_name,''), NULLIF(a.check_type,''), 'Check') AS check_name,
        lr.status                 AS run_status,
        lr.output                 AS run_output,
        lr.last_run               AS last_run
      FROM public.check_assignments a
      LEFT JOIN latest_run lr ON lr.assignment_id = a.id AND lr.rn = 1
      WHERE a.device_id = ${deviceId}
      ORDER BY lr.last_run DESC NULLS LAST, check_name ASC
      LIMIT ${limit}
    `;

            const items: DeviceCheckDTO[] = rows.map((r) => ({
                id: r.assignment_id,
                name: r.check_name ?? 'Check',
                status: toUiStatus(r.run_status),
                lastRun: r.last_run ? new Date(r.last_run as any).toISOString() : null,
                output:
                    (r.run_output ?? '').length > 8192
                        ? (r.run_output ?? '').slice(0, 8192) + '…'
                        : r.run_output ?? '',
            }));

            return { items };
        } catch (err: any) {
            this.logger.error('ChecksService.listByDevice failed', err?.stack || err);
            return { items: [] };
        }
    }

    /* ======================= Agent ingestion ====================== */

    /**
     * Ingest runs from an agent (TEXT deviceId).
     * - Upsert assignment per device using dedupeKey or (type|name) tuple
     * - Insert runs
     * Returns counts for observability.
     */
    async ingestAgentRuns(input: {
        agentId: string;
        deviceId: string; // TEXT (e.g., "win-...")
        runs: Array<{
            assignmentId?: string;
            dedupeKey?: string;
            checkType?: string;
            checkName?: string;
            status: string;
            severity?: 'WARN' | 'CRIT';
            metrics?: Record<string, any>;
            output?: string;
            startedAt?: string;
            finishedAt?: string;
        }>;
    }): Promise<{ inserted: number; assignmentsCreated: number }> {
        if (!input?.runs?.length) return { inserted: 0, assignmentsCreated: 0 };

        const MAX_OUTPUT = 64 * 1024; // 64 KiB

        // ---------- 1) Prepare src rows with a stable ordinal ----------
        const src = input.runs.map((r) => {
            const dk = r.dedupeKey ?? null;
            const ct = (r.checkType || '').trim().toUpperCase() || null;
            const cn = (r.checkName || ct || 'Agent Check').trim().substring(0, 200) || 'Agent Check';
            return { device_id: input.deviceId, dedupe_key: dk, check_type: ct, check_name: cn };
        });

        // ---------- 2) Insert missing assignments; the expression index skips existing ones ----------
        const { count: assignmentsCreated } = await this.prisma.check_assignments.createMany({
            data: src,
            skipDuplicates: true,
        });

        // ---------- 3) Resolve assignment ids for each src row in order ----------
        // Prisma cannot join on the lower() expression of the unique index, and it must match in the database's own case rules.
        const values = Prisma.join(
            src.map((r, i) => Prisma.sql`(${i + 1}::int, ${r.dedupe_key}::text, ${r.check_type}::text, ${r.check_name}::text)`),
        );
        const mapRows = await this.prisma.$queryRaw<Array<{ ord: number; assignment_id: string }>>`
      WITH src(ord, dedupe_key, check_type, check_name) AS (
        VALUES ${values}
      )
      SELECT
        s.ord,
        ca.id::text AS assignment_id
      FROM src s
      JOIN public.check_assignments ca
        ON ca.device_id = ${input.deviceId}
       AND COALESCE(NULLIF(ca.dedupe_key,''),
            LOWER(COALESCE(ca.check_type,'')) || '|' || LOWER(COALESCE(ca.check_name,'')))
        = COALESCE(NULLIF(s.dedupe_key,''),
            LOWER(COALESCE(s.check_type,'')) || '|' || LOWER(COALESCE(s.check_name,'')))
      ORDER BY s.ord ASC
    `;
        const assignmentByOrd = new Map<number, string>();
        for (const r of mapRows) assignmentByOrd.set(r.ord, r.assignment_id);

        // ---------- 4) Build runs aligned to the original order ----------
        const runRows: Prisma.check_runsCreateManyInput[] = [];

        for (let i = 0; i < input.runs.length; i++) {
            const r = input.runs[i];
            const assignmentIdFromMap = assignmentByOrd.get(i + 1);

            const assignmentId =
                (r.assignmentId && /^[0-9a-fA-F-]{8}-[0-9a-fA-F-]{4}-[1-5][0-9a-fA-F-]{3}-[89abAB][0-9a-fA-F-]{3}-[0-9a-fA-F-]{12}$/.test(r.assignmentId))
                    ? r.assignmentId
                    : assignmentIdFromMap;

            if (!assignmentId) continue; // should not happen, but be defensive

            const status = normalizeStatus(r.status);
            const severity = r.severity === 'CRIT' ? 'CRIT' : r.severity === 'WARN' ? 'WARN' : null;
            const output = (r.output ?? '').slice(0, MAX_OUTPUT);
            const startedAt = r.startedAt ? new Date(r.startedAt) : new Date();
            const finishedAt = r.finishedAt ? new Date(r.finishedAt) : new Date();

            runRows.push({
                assignment_id: assignmentId,
                device_id: input.deviceId,
                status,
                severity,
                metrics: r.metrics ? r.metrics : Prisma.DbNull,
                output,
                started_at: startedAt.toISOString(),
                finished_at: finishedAt.toISOString(),
            });
        }

        let inserted = 0;
        if (runRows.length) {
            ({ count: inserted } = await this.prisma.check_runs.createMany({ data: runRows }));
        }

        // Debounced UI broadcast per device
        if (inserted > 0) this.scheduleDeviceBroadcast(input.deviceId, inserted);

        // Runs arrive oldest first, so the newest result for a check is the one that stands.
        for (const run of runRows) {
            const index = input.runs.findIndex((r, i) => (assignmentByOrd.get(i + 1) ?? r.assignmentId) === run.assignment_id);
            await this.alerts.onCheckRun({
                deviceId: input.deviceId,
                assignmentId: run.assignment_id,
                checkName: src[index]?.check_name ?? "Check",
                status: run.status,
                severity: run.severity,
                output: run.output,
            });
        }

        this.logger.log(`ingested ${inserted} run(s) for device ${input.deviceId}; new assignments: ${assignmentsCreated}`);
        return { inserted, assignmentsCreated };
    }

    /** Debounce + emit device_checks_updated to subscribed UI sockets */
    private scheduleDeviceBroadcast(deviceId: string, changed: number) {
        const key = String(deviceId);
        const existing = this.deviceDebounce.get(key);
        if (existing) clearTimeout(existing as any);

        const handle = setTimeout(() => {
            try {
                const payload = {
                    t: 'device_checks_updated',
                    deviceId: key,
                    changed,
                    at: new Date().toISOString(),
                };
                const sent = this.uiSockets.broadcastToDevice(key, payload);
                this.logger.debug(`Broadcast device_checks_updated to ${sent} UI socket(s) for device ${key}`);
            } catch (e: any) {
                this.logger.warn(`Broadcast failed for device ${key}: ${e?.message ?? e}`);
            } finally {
                this.deviceDebounce.delete(key);
            }
        }, 750);

        this.deviceDebounce.set(key, handle);
    }

    /* ============== Server-driven assignments for agent (optional) ============ */

    async getAssignmentsForDevice(deviceId: string): Promise<{
        items: Array<{
            assignmentId: string;
            type: string | null;
            name: string | null;
            intervalSec: number; // static defaults for now
            timeoutSec: number;  // static defaults for now
            enabled: boolean;
            dedupeKey?: string | null;
            config?: any;
            thresholds?: any;
        }>;
    }> {
        // We don’t maintain a separate checks catalog here; return lightweight rows
        const rows = await this.prisma.check_assignments.findMany({
            where: { device_id: deviceId },
            orderBy: { created_at: 'desc' },
            select: { id: true, check_type: true, check_name: true, dedupe_key: true },
        });

        return {
            items: rows.map((r) => ({
                assignmentId: r.id,
                type: r.check_type ?? null,
                name: r.check_name ?? null,
                // simple defaults (agents can override via config if/when you add it)
                intervalSec: 60,
                timeoutSec: 10,
                enabled: true,
                dedupeKey: r.dedupe_key,
                config: null,
                thresholds: null,
            })),
        };
    }

    /* ======================== Placeholders (unchanged) ======================== */

    async list(_params: {
        scope?: CheckScope;
        type?: CheckType;
        enabled?: boolean;
        clientId?: string;
        siteId?: string;
        deviceId?: string;
        limit?: number;
        cursor?: string;
    }): Promise<{ items: any[]; nextCursor?: string | null }> {
        throw new NotImplementedException('ChecksService.list not implemented yet');
    }

    async create(_payload: any): Promise<any> {
        throw new NotImplementedException('ChecksService.create not implemented yet');
    }

    async update(_id: string, _payload: any): Promise<any> {
        throw new NotImplementedException('ChecksService.update not implemented yet');
    }

    async remove(_id: string): Promise<{ id: string; deleted: boolean }> {
        throw new NotImplementedException('ChecksService.remove not implemented yet');
    }

    async rebuildAssignments(_id: string): Promise<{ checkId: string; assignmentsRebuilt: number }> {
        throw new NotImplementedException('ChecksService.rebuildAssignments not implemented yet');
    }

    async runOnDemand(_id: string, _params?: { deviceIds?: string[] | null }): Promise<{ enqueued: number }> {
        throw new NotImplementedException('ChecksService.runOnDemand not implemented yet');
    }
}
