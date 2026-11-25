import { PoliciesService } from "../policies/policies.service";
import { Inject, Injectable, Logger, forwardRef } from "@nestjs/common";
import { AlertsService } from "../alerts/alerts.service";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../storage/prisma.service";
import { isCanonicalUuid } from "../common/agent-lookup.util";
import { UiSocketRegistry } from "../common/ui-socket-registry.service";
import { buildCheckPlan, type AgentCheckPlan } from "./check-plan.util";

/**
 * Device-scoped checks runtime:
 * - Uses the normalized model:
 *   checks (definitions) + check_assignments (target-based) + check_runs (results)
 * - Upserts per-device assignments using (target_type,target_id,dedupe_key)
 * - Ingests runs
 * - Lists checks for a device detail page
 *
 * IMPORTANT:
 * - check_assignments is target-based: (target_type, target_id)
 * - Do NOT assume check_assignments.device_id exists (it does not in your schema)
 */

/**
 * Measurements that are never pass/fail (network traffic, disk activity). They only feed the performance graphs:
 * whatever status an agent sends is stored as OK, they never reach the alert engine, and they are not listed as checks.
 */
export const INFORMATIONAL_CHECK_TYPES = ["NETWORK", "DISKIO"] as const;
export const isInformationalCheckType = (t: string | null | undefined) =>
    (INFORMATIONAL_CHECK_TYPES as readonly string[]).includes(String(t ?? "").trim().toUpperCase());

const INFORMATIONAL_NUMBER_KEYS = ["rxBytesPerSec", "txBytesPerSec", "readBytesPerSec", "writeBytesPerSec", "intervalSec", "adapters", "devices", "linkMbps"];

/** Only the known numbers and a short reason are kept, whatever an agent sends. */
function informationalMetrics(raw: Record<string, any> | undefined): Record<string, number | string> | null {
    if (!raw || typeof raw !== "object") return null;
    const out: Record<string, number | string> = {};
    for (const k of INFORMATIONAL_NUMBER_KEYS) {
        const v = raw[k];
        if (typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 1e15) out[k] = v;
    }
    if (typeof raw.reason === "string" && raw.reason.trim()) out.reason = raw.reason.trim().slice(0, 300);
    return Object.keys(out).length ? out : null;
}

export type NormalizedRunStatus = "OK" | "WARN" | "CRIT" | "TIMEOUT" | "UNKNOWN";

export type IngestRun = {
    assignmentId?: string;
    dedupeKey?: string | null;
    checkType?: string | null;
    checkName?: string | null;
    status: string;
    severity?: string | null; // can be enum/text depending on schema
    metrics?: Record<string, any>;
    output?: string;
    startedAt?: string;
    finishedAt?: string;
};

export type IngestPayload = {
    agentId: string;   // agents.id (uuid string)
    deviceId: string;  // may be agents.id or devices.id or any text identifier you already use
    runs: IngestRun[];
};

export type DeviceCheckDTO = {
    id: string; // assignment id
    name: string;
    status: "Passing" | "Warning" | "Failing";
    lastRun: string | null;
    output: string;

    type?: string | null;
    severity?: string | null;
    metrics?: Record<string, any> | null;
    thresholds?: Record<string, any> | null;
    maintenance?: boolean | null;
    dedupeKey?: string | null;
    category?: string | null;
    tags?: string[] | null;
};

function normalizeStatus(s?: string | null): NormalizedRunStatus {
    const t = String(s ?? "").trim().toUpperCase();
    if (t === "OK" || t === "PASS" || t === "PASSING") return "OK";
    if (t === "WARN" || t === "WARNING") return "WARN";
    if (t === "CRIT" || t === "CRITICAL" || t === "ERROR" || t === "FAIL" || t === "FAILED" || t === "FAILING") return "CRIT";
    if (t === "TIMEOUT") return "TIMEOUT";
    return "UNKNOWN";
}

function toUiStatus(s?: string | null): DeviceCheckDTO["status"] {
    switch (normalizeStatus(s)) {
        case "OK":
            return "Passing";
        case "WARN":
            return "Warning";
        default:
            return "Failing";
    }
}

// The Checks tab filters on WARN and CRIT, and a passing check has no severity at all.
function toUiSeverity(s?: string | null): "WARN" | "CRIT" | null {
    if (s == null) return null;
    switch (normalizeStatus(s)) {
        case "OK":
            return null;
        case "WARN":
            return "WARN";
        default:
            return "CRIT";
    }
}

function isUuid(v: string): boolean {
    return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/.test(v);
}

function normalizeDedupeKey(raw: string | null | undefined, checkType: string | null, checkName: string | null): string {
    const dk = String(raw ?? "").trim();
    if (dk) return dk;
    const t = String(checkType ?? "").trim().toLowerCase();
    const n = String(checkName ?? "").trim().toLowerCase();
    const fallback = `${t}|${n}`.trim();
    return fallback ? fallback : "check|check";
}

@Injectable()
export class ChecksRuntimeService {
    private readonly log = new Logger(ChecksRuntimeService.name);
    private readonly deviceDebounce = new Map<string, ReturnType<typeof setTimeout>>();

    constructor(
        private readonly prisma: PrismaService,
        private readonly uiSockets: UiSocketRegistry,
        @Inject(forwardRef(() => AlertsService)) private readonly alerts: AlertsService,
        private readonly policies: PoliciesService,
    ) { }

    /* ------------------------------------------------------------------------ */
    /* Helpers: resolve device target uuid                                       */
    /* ------------------------------------------------------------------------ */

    /**
     * Device pages in your app often use agents.id.
     * Assignments target devices via public.devices.id (uuid).
     *
     * This resolves:
     * - if input is a devices.id -> returns it
     * - else if input is an agents.id -> returns agents.device_id
     * - else returns null
     */
    private async resolveDeviceTargetUuid(deviceOrAgentId: string): Promise<string | null> {
        const raw = String(deviceOrAgentId ?? "").trim();
        if (!raw || !isUuid(raw)) return null;

        // devices.id?
        if (!isCanonicalUuid(raw)) return null; // ids compare as text, so an uppercase one finds nothing
        const asDevice = await this.prisma.devices.findUnique({ where: { id: raw }, select: { id: true } });
        if (asDevice) return asDevice.id;

        // agents.id -> agents.device_id
        const asAgent = await this.prisma.agents.findUnique({ where: { id: raw }, select: { device_id: true } });
        return asAgent?.device_id ?? null;
    }

    /* ------------------------------------------------------------------------ */
    /* Public: UI listing                                                       */
    /* ------------------------------------------------------------------------ */

    async listByDevice(deviceOrAgentId: string, limit = 100): Promise<{ items: DeviceCheckDTO[] }> {
        if (!Number.isFinite(limit) || limit < 1) limit = 1;
        if (limit > 200) limit = 200;

        const deviceTargetId = await this.resolveDeviceTargetUuid(deviceOrAgentId);
        if (!deviceTargetId) return { items: [] };

        // target_type enum includes 'device' (confirmed)
        const TARGET_TYPE = "device";

        // The sort on the computed name must follow the database collation, which Prisma cannot order by.
        try {
            const rows = await this.prisma.$queryRaw<any[]>`
      WITH a AS (
        SELECT
          ca.id,
          ca.dedupe_key,
          ca.check_type,
          ca.check_name
        FROM public.check_assignments ca
        WHERE ca.target_type = ${TARGET_TYPE}
          AND ca.target_id = ${deviceTargetId}::uuid
          -- network traffic and disk activity are graph data, not checks that pass or fail
          AND (ca.check_type IS NULL OR ca.check_type NOT IN ('NETWORK', 'DISKIO'))
      ),
      lr AS (
        SELECT
          cr.assignment_id,
          cr.status::text   AS status,
          cr.severity::text AS severity,
          cr.metrics        AS metrics,
          cr.output         AS output,
          cr.finished_at    AS last_run,
          ROW_NUMBER() OVER (
            PARTITION BY cr.assignment_id
            ORDER BY cr.finished_at DESC NULLS LAST, cr.created_at DESC NULLS LAST
          ) AS rn
        FROM public.check_runs cr
        JOIN a ON a.id = cr.assignment_id
      )
      SELECT
        a.id::text                            AS assignment_id,
        a.dedupe_key                          AS dedupe_key,
        a.check_type                          AS check_type,
        COALESCE(NULLIF(a.check_name,''), NULLIF(a.check_type,''), 'Check') AS check_name,
        lr.status                             AS run_status,
        lr.severity                           AS run_severity,
        lr.metrics                            AS run_metrics,
        lr.output                             AS run_output,
        lr.last_run                           AS last_run
      FROM a
      LEFT JOIN lr ON lr.assignment_id = a.id AND lr.rn = 1
      -- A check this device stopped reporting, such as one for a removed disk, would otherwise
      -- show its last result forever. An offline device still shows everything it last sent.
      WHERE lr.last_run IS NULL
         OR lr.last_run >= (SELECT MAX(x.last_run) FROM lr x WHERE x.rn = 1) - INTERVAL '7 days'
      ORDER BY lr.last_run DESC NULLS LAST, check_name ASC
      LIMIT ${limit}
    `;

            const items: DeviceCheckDTO[] = rows.map((r: any) => {
                // Agents send the limits they applied inside the metrics; the UI shows them apart.
                const { thresholds = null, ...metrics } = (r.run_metrics ?? {}) as Record<string, any>;
                return {
                    id: String(r.assignment_id),
                    name: r.check_name ?? "Check",
                    status: toUiStatus(r.run_status),
                    lastRun: r.last_run ? new Date(r.last_run as any).toISOString() : null,
                    output: (r.run_output ?? "").length > 8192
                        ? String(r.run_output ?? "").slice(0, 8192) + "…"
                        : (r.run_output ?? ""),

                    type: r.check_type ?? null,
                    severity: toUiSeverity(r.run_status),
                    metrics: r.run_metrics ? metrics : null,
                    dedupeKey: r.dedupe_key ?? null,

                    thresholds,
                    maintenance: null,
                    category: null,
                    tags: null,
                };
            });

            return { items };
        } catch (err: any) {
            // Do not 500 the UI.
            this.log.error("listByDevice failed", err?.stack || err);
            return { items: [] };
        }
    }

    /* ------------------------------------------------------------------------ */
    /* Public: Agent ingestion                                                  */
    /* ------------------------------------------------------------------------ */

    async ingestAgentRuns(input: IngestPayload): Promise<{ inserted: number; assignmentsCreated: number }> {
        if (!input?.runs?.length) return { inserted: 0, assignmentsCreated: 0 };

        const MAX_OUTPUT = 64 * 1024;

        // Resolve target device UUID from agent id (preferred)
        const deviceTargetId = await this.resolveDeviceTargetUuid(input.agentId);
        if (!deviceTargetId) {
            this.log.warn(`ingestAgentRuns: unable to resolve device target from agentId=${input.agentId}`);
            return { inserted: 0, assignmentsCreated: 0 };
        }

        const TARGET_TYPE = "device";

        // ---- 1) Build source rows, one per dedupe key
        const srcByKey = new Map<string, { target_type: string; target_id: string; dedupe_key: string; check_type: string | null; check_name: string }>();

        const keyType: Array<string | null> = [];
        const keys = input.runs.map((r) => {
            const type = (r.checkType ?? "").toString().trim().toUpperCase() || null;
            keyType.push(type);
            const name = ((r.checkName ?? type) ?? "Agent Check").toString().trim().slice(0, 200);

            const dkNorm = normalizeDedupeKey(r.dedupeKey ?? null, type, name);
            srcByKey.set(dkNorm, { target_type: TARGET_TYPE, target_id: deviceTargetId, dedupe_key: dkNorm, check_type: type, check_name: name });
            return dkNorm;
        });
        const src = [...srcByKey.values()];

        // ---- 2) Upsert assignments by (target_type,target_id,dedupe_key)
        // Insert-then-update stays safe under concurrent ingests, where upsert can hit a unique violation.
        await this.prisma.$transaction([
            this.prisma.check_assignments.createMany({ data: src, skipDuplicates: true }),
            ...src.map((row) =>
                this.prisma.check_assignments.updateMany({
                    where: { target_type: row.target_type, target_id: row.target_id, dedupe_key: row.dedupe_key },
                    data: { check_type: row.check_type, check_name: row.check_name, updated_at: new Date() },
                }),
            ),
        ]);
        const assignmentsTouched = input.runs.length;

        // ---- 3) Map assignment ids back by dedupe key
        const assignments = await this.prisma.check_assignments.findMany({
            where: { target_type: TARGET_TYPE, target_id: deviceTargetId, dedupe_key: { in: [...srcByKey.keys()] } },
            select: { id: true, dedupe_key: true },
        });
        const assignmentByKey = new Map(assignments.map((a) => [a.dedupe_key, a.id]));

        // ---- 4) Build run rows
        const runRows: Prisma.check_runsCreateManyInput[] = [];

        for (let i = 0; i < input.runs.length; i++) {
            const r = input.runs[i];

            // Only an assignment found for this device: an id from the request could belong to
            // another customer's device, and the agent's token would let it write there.
            const assignmentId = assignmentByKey.get(keys[i]);
            if (!assignmentId) continue;

            const informational = isInformationalCheckType(keyType[i]);
            const status = informational ? "OK" : normalizeStatus(r.status);
            const sevRaw = String(r.severity ?? "").trim().toLowerCase();
            const severity = informational ? null :
                sevRaw === "critical" || sevRaw === "crit" || sevRaw === "high" ? "critical"
                    : (sevRaw === "medium" ? "medium"
                        : (sevRaw === "low" ? "low"
                            : (sevRaw === "info" ? "info" : null)));

            const output = (r.output ?? "").toString().slice(0, MAX_OUTPUT);
            const startedAt = r.startedAt ? new Date(r.startedAt) : new Date();
            const finishedAt = r.finishedAt ? new Date(r.finishedAt) : new Date();

            runRows.push({
                assignment_id: assignmentId,
                device_id: String(input.deviceId ?? ""), // keep agent/device text identifier as-is
                status,
                severity,
                metrics: informational ? (informationalMetrics(r.metrics) ?? Prisma.DbNull) : (r.metrics ? r.metrics : Prisma.DbNull),
                output,
                started_at: startedAt.toISOString(),
                finished_at: finishedAt.toISOString(),
            });
        }

        let inserted = 0;
        if (runRows.length) {
            ({ count: inserted } = await this.prisma.check_runs.createMany({ data: runRows }));
        }

        if (inserted > 0) this.scheduleDeviceBroadcast(String(input.deviceId ?? ""), inserted);

        // In the order they ran, so the newest result for a check is the one that stands.
        for (let i = 0; i < input.runs.length; i++) {
            const assignmentId = assignmentByKey.get(keys[i]);
            if (!assignmentId) continue;
            if (isInformationalCheckType(keyType[i])) continue; // measurements for the graphs: never an alert
            await this.alerts.onCheckRun({
                deviceId: deviceTargetId,
                assignmentId,
                checkName: srcByKey.get(keys[i])?.check_name ?? "Check",
                status: normalizeStatus(input.runs[i].status),
                severity: normalizeStatus(input.runs[i].status) === "WARN" ? "WARN" : "CRIT",
                output: input.runs[i].output ?? null,
            });
        }

        this.log.log(`ingested ${inserted} run(s) for deviceText=${String(input.deviceId ?? "")}; assignments touched: ${assignmentsTouched}`);
        return { inserted, assignmentsCreated: assignmentsTouched };
    }

    /* ------------------------------------------------------------------------ */
    /* Agent: what to run                                                        */
    /* ------------------------------------------------------------------------ */

    /**
     * Checks assigned to the device, its site, its client or its organization. A device with none
     * runs the agent's built-in set, which lives in the agent because it depends on the OS.
     * Rows with no check_id are the ones ingestion creates per result, so they are not assignments.
     */
    async getCheckPlan(deviceId: string): Promise<AgentCheckPlan> {
        const device = await this.prisma.devices.findUnique({
            where: { id: deviceId },
            select: {
                site_id: true,
                sites: { select: { client_id: true, clients: { select: { organization_id: true } } } },
            },
        });

        const targets: Array<{ target_type: string; target_id: string }> = [{ target_type: "device", target_id: deviceId }];
        if (device?.site_id) targets.push({ target_type: "site", target_id: device.site_id });
        if (device?.sites?.client_id) targets.push({ target_type: "client", target_id: device.sites.client_id });
        const organizationId = device?.sites?.clients?.organization_id;
        if (organizationId) targets.push({ target_type: "organization", target_id: organizationId });

        const rows = await this.prisma.check_assignments.findMany({
            where: { check_id: { not: null }, checks: { enabled: true }, OR: targets },
            select: { checks: { select: { id: true, name: true, type: true, schedule: true, config: true } } },
        });
        const stored = rows.flatMap((r) => (r.checks ? [{ ...r.checks, type: String(r.checks.type) }] : []));

        // Check profiles that a policy gives this device bring their checks too.
        try {
            const effective = await this.policies.effectiveForDevice(deviceId);
            const profileIds = effective?.lists["checks.profiles"].map((h) => h.value) ?? [];
            if (profileIds.length) {
                const members = await this.prisma.check_profile_members.findMany({
                    where: { profile_id: { in: profileIds }, checks: { enabled: true } },
                    select: { checks: { select: { id: true, name: true, type: true, schedule: true, config: true } } },
                });
                const have = new Set(stored.map((c) => c.id));
                for (const m of members) if (!have.has(m.checks.id)) { have.add(m.checks.id); stored.push({ ...m.checks, type: String(m.checks.type) }); }
            }
        } catch (err) {
            this.log.warn(`Could not read check profiles from policies for device ${deviceId}: ${(err as Error).message}`);
        }

        return buildCheckPlan(stored);
    }

    /* ------------------------------------------------------------------------ */
    /* Optional: assignments listing (server-driven)                              */
    /* ------------------------------------------------------------------------ */

    async getAssignmentsForDevice(deviceOrAgentId: string): Promise<{
        items: Array<{
            assignmentId: string;
            type: string | null;
            name: string | null;
            intervalSec: number;
            timeoutSec: number;
            enabled: boolean;
            dedupeKey?: string | null;
            config?: any;
            thresholds?: any;
        }>;
    }> {
        const deviceTargetId = await this.resolveDeviceTargetUuid(deviceOrAgentId);
        if (!deviceTargetId) return { items: [] };

        const rows = await this.prisma.check_assignments.findMany({
            where: { target_type: "device", target_id: deviceTargetId },
            orderBy: { created_at: "desc" },
            select: { id: true, check_type: true, check_name: true, dedupe_key: true },
        });

        return {
            items: rows.map((r) => ({
                assignmentId: r.id,
                type: r.check_type ?? null,
                name: r.check_name ?? null,
                intervalSec: 60,
                timeoutSec: 10,
                enabled: true,
                dedupeKey: r.dedupe_key ?? null,
                config: null,
                thresholds: null,
            })),
        };
    }

    /* ------------------------------------------------------------------------ */
    /* WS broadcast (debounced per device text id)                               */
    /* ------------------------------------------------------------------------ */

    private scheduleDeviceBroadcast(deviceTextId: string, changed: number) {
        const key = String(deviceTextId);
        const existing = this.deviceDebounce.get(key);
        if (existing) clearTimeout(existing as any);

        const handle = setTimeout(() => {
            try {
                const payload = {
                    t: "device_checks_updated",
                    deviceId: key,
                    changed,
                    at: new Date().toISOString(),
                };
                const sent = this.uiSockets.broadcastToDevice(key, payload);
                this.log.debug(`Broadcast device_checks_updated → ${sent} UI socket(s) for device ${key}`);
            } catch (e: any) {
                this.log.warn(`Broadcast failed for device ${key}: ${e?.message ?? e}`);
            } finally {
                this.deviceDebounce.delete(key);
            }
        }, 750);

        this.deviceDebounce.set(key, handle);
    }
}
