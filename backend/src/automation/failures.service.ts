// backend/src/automation/failures.service.ts
//
// One list of what went wrong on its own: scripts that failed or timed out, update scans and installs that failed, and
// device actions such as restarts that did not go through. A run that failed only because nobody was signed in to the
// device is counted as skipped, not failed, because there was nothing wrong to fix.
import { AccessScope, deviceSqlOf } from "../reports/client-access.service";
import { BadRequestException, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../storage/prisma.service";
import { OrganizationContextService } from "../storage/organization-context.service";

export type FailureKind = "script" | "patch" | "action";
export type FailureStatus = "failed" | "timed out" | "skipped";

/** Words that mean "there was nobody to run it for", which is not a failure of the script. */
const NO_USER = /(no (interactive |logged[- ]?on |active |console )?users?\b|nobody (is )?(signed|logged)|not logged on|no (active |console )?session|no user is (signed|logged))/i;

export function classify(status: string, reason: string): FailureStatus {
    if (NO_USER.test(reason)) return "skipped";
    return status === "timeout" ? "timed out" : "failed";
}

const clip = (s: string | null | undefined, n = 400) => {
    const t = String(s ?? "").replace(/\s+/g, " ").trim();
    return t.length > n ? `${t.slice(0, n)}...` : t;
};

type Row = {
    id: string; kind: FailureKind; title: string; deviceId: string; device: string; customer: string | null; clientId: string | null; site: string | null;
    at: Date; status: FailureStatus; reason: string;
};

@Injectable()
export class FailuresService {
    constructor(private readonly prisma: PrismaService, private readonly orgs: OrganizationContextService) { }

    async list(opts: { days?: number; kind?: string; showSkipped?: boolean; limit?: number }, scope: AccessScope | null, organizationId?: string | null) {
        const orgId = organizationId || (await this.orgs.getDefaultOrganizationId());
        const days = Math.min(Math.max(Math.floor(Number(opts.days) || 7), 1), 90);
        const limit = Math.min(Math.max(Math.floor(Number(opts.limit) || 300), 1), 1000);
        if (opts.kind && !["script", "patch", "action"].includes(opts.kind)) throw new BadRequestException("The kind must be script, patch or action.");
        const since = new Date(Date.now() - days * 86_400_000);
        const only = scope ? Prisma.sql`AND ${deviceSqlOf(scope, { client: Prisma.sql`c.id::text`, site: Prisma.sql`s.id::text`, id: Prisma.sql`d.id::text` })}` : Prisma.empty;

        const rows: Row[] = [];

        // Scripts and device actions: jobs that failed or ran out of time.
        if (!opts.kind || opts.kind === "script" || opts.kind === "action") {
            const jobs = await this.prisma.$queryRaw<Array<{ id: string; type: string; status: string; at: Date; stderr: string | null; payload: any; script_name: string | null; device_id: string; hostname: string; customer: string | null; client_id: string | null; site: string | null }>>`
                SELECT COALESCE(sr.id, j.id)::text AS id, j.type, j.status, COALESCE(j.finished_at, j.created_at) AS at, jr.stderr, j.payload,
                       sr.script_name, d.id::text AS device_id, COALESCE(d.alias, d.hostname) AS hostname, c.name AS customer, c.id::text AS client_id, s.name AS site
                  FROM public.jobs j
                  JOIN public.agents a ON a.id = j.agent_id
                  JOIN public.devices d ON d.id = a.device_id
                  JOIN public.sites s ON s.id = d.site_id
                  JOIN public.clients c ON c.id = s.client_id
                  LEFT JOIN public.job_results jr ON jr.job_id = j.id
                  LEFT JOIN public.script_runs sr ON sr.job_id = j.id
                 WHERE j.status IN ('failed', 'timeout') AND j.created_at >= ${since} AND c.organization_id::text = ${orgId} ${only}
                 ORDER BY COALESCE(j.finished_at, j.created_at) DESC
                 LIMIT ${limit}`;
            for (const j of jobs) {
                const isScript = !!j.script_name;
                const text = JSON.stringify(j.payload ?? {});
                const title = j.script_name ?? (/shutdown\.exe \/r/i.test(text) ? "Restart" : /uninstall/i.test(text) ? "Uninstall software" : j.type === "AGENT_UPDATE" ? "Agent update" : "Device action");
                const reason = clip(j.stderr) || (j.status === "timeout" ? "The device did not finish in time." : "It failed without saying why.");
                rows.push({ id: j.id, kind: isScript ? "script" : "action", title, deviceId: j.device_id, device: j.hostname, customer: j.customer, clientId: j.client_id, site: j.site, at: j.at, status: classify(j.status, reason), reason });
            }
        }

        // Agent updates that the agent accepted and then could not finish (it says why with its next update check).
        if (!opts.kind || opts.kind === "action") {
            const ups = await this.prisma.$queryRaw<Array<{ id: string; at: Date; version: string; outcome: string; detail: string; device_id: string; hostname: string; customer: string | null; client_id: string | null; site: string | null }>>`
                SELECT f.agent_id::text AS id, f.reported_at AS at, f.version, f.outcome, f.detail,
                       d.id::text AS device_id, COALESCE(d.alias, d.hostname) AS hostname, c.name AS customer, c.id::text AS client_id, s.name AS site
                  FROM public.agent_update_failures f
                  JOIN public.agents a ON a.id = f.agent_id
                  JOIN public.devices d ON d.id = a.device_id
                  JOIN public.sites s ON s.id = d.site_id
                  JOIN public.clients c ON c.id = s.client_id
                 WHERE f.reported_at >= ${since} AND c.organization_id::text = ${orgId} ${only}
                 ORDER BY f.reported_at DESC LIMIT ${limit}`;
            for (const u of ups) {
                const reason = `The update to ${u.version} did not finish (${u.outcome.replace(/_/g, " ")}). ${clip(u.detail)}`.trim();
                rows.push({ id: `agent-update-${u.id}`, kind: "action", title: "Agent update", deviceId: u.device_id, device: u.hostname, customer: u.customer, clientId: u.client_id, site: u.site, at: u.at, status: classify("failed", reason), reason });
            }
        }

        // Update scans and installs that the device reported as failed.
        if (!opts.kind || opts.kind === "patch") {
            const runs = await this.prisma.$queryRaw<Array<{ id: string; type: string; at: Date; stderr: string | null; device_id: string; hostname: string; customer: string | null; client_id: string | null; site: string | null }>>`
                SELECT r.id::text AS id, t.type::text AS type, COALESCE(r.finished_at, r.created_at) AS at, res.stderr,
                       d.id::text AS device_id, COALESCE(d.alias, d.hostname) AS hostname, c.name AS customer, c.id::text AS client_id, s.name AS site
                  FROM public.agent_task_runs r
                  JOIN public.agent_tasks t ON t.id = r.task_id
                  JOIN public.agents a ON a.id = t.agent_id
                  JOIN public.devices d ON d.id = a.device_id
                  JOIN public.sites s ON s.id = d.site_id
                  JOIN public.clients c ON c.id = s.client_id
                  LEFT JOIN public.agent_task_results res ON res.run_id = r.id
                 WHERE r.status = 'failed' AND t.type IN ('patch_scan', 'patch_install') AND r.created_at >= ${since} AND c.organization_id::text = ${orgId} ${only}
                 ORDER BY COALESCE(r.finished_at, r.created_at) DESC
                 LIMIT ${limit}`;
            for (const r of runs) {
                const reason = clip(r.stderr) || "The device reported a failure without saying why.";
                rows.push({ id: r.id, kind: "patch", title: r.type === "patch_scan" ? "Update scan" : "Update install", deviceId: r.device_id, device: r.hostname, customer: r.customer, clientId: r.client_id, site: r.site, at: r.at, status: classify("failed", reason), reason });
            }
        }

        rows.sort((a, b) => b.at.getTime() - a.at.getTime());
        const visible = opts.showSkipped === false ? rows.filter((r) => r.status !== "skipped") : rows;
        const count = (f: (r: Row) => boolean) => rows.filter(f).length;
        const byDevice = new Map<string, { deviceId: string; device: string; customer: string | null; count: number }>();
        for (const r of rows.filter((x) => x.status !== "skipped")) {
            const e = byDevice.get(r.deviceId) ?? { deviceId: r.deviceId, device: r.device, customer: r.customer, count: 0 };
            e.count++;
            byDevice.set(r.deviceId, e);
        }
        return {
            days,
            summary: {
                failed: count((r) => r.status === "failed"), timedOut: count((r) => r.status === "timed out"), skipped: count((r) => r.status === "skipped"),
                scripts: count((r) => r.kind === "script" && r.status !== "skipped"), patches: count((r) => r.kind === "patch" && r.status !== "skipped"), actions: count((r) => r.kind === "action" && r.status !== "skipped"),
            },
            worstDevices: [...byDevice.values()].sort((a, b) => b.count - a.count).slice(0, 5),
            items: visible.slice(0, limit).map((r) => ({ id: r.id, kind: r.kind, title: r.title, deviceId: r.deviceId, device: r.device, customer: r.customer, site: r.site, at: r.at.toISOString(), status: r.status, reason: r.reason })),
            truncated: visible.length > limit,
        };
    }

    private empty(days: number) {
        return { days, summary: { failed: 0, timedOut: 0, skipped: 0, scripts: 0, patches: 0, actions: 0 }, worstDevices: [], items: [], truncated: false };
    }
}
