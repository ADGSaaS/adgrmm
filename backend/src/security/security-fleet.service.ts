// backend/src/security/security-fleet.service.ts
//
// The fleet view of security (page /security): one row per Windows device with its score, the summary tiles, and the top failing
// rules. Paged, filtered and sorted in the database (a fleet can be thousands of devices), and limited to the customers, sites and
// tags the person may see.
import { BadRequestException, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../storage/prisma.service";
import { OrganizationContextService } from "../storage/organization-context.service";
import { ClientAccessService, deviceSqlOf } from "../reports/client-access.service";
import { isCanonicalUuid } from "../common/agent-lookup.util";
import { RULE_BY_ID, SEVERITY_RANK } from "./security.baseline";
import { LINUX_RULE_BY_ID } from "./security-linux.baseline";
import { SecurityService, STALE_AFTER_MS } from "./security.service";

export const FLEET_SORTS = ["worst", "best", "name", "customer", "scanned", "critical"] as const;
export type FleetSort = (typeof FLEET_SORTS)[number];
export const FLEET_GRADES = ["A", "B", "C", "D", "F", "none"] as const;
export const MAX_FLEET_LIMIT = 200;

export type FleetQuery = { clientId?: string; q?: string; grade?: string; sort?: string; limit?: unknown; offset?: unknown };

type FleetRow = {
    device_id: string; hostname: string; alias: string | null; site_name: string | null; client_id: string; client_name: string; has_agent: boolean;
    last_check_in_at: Date | null; scanned_at: Date | null; attempted_at: Date | null; ok: boolean | null; score: number | null; grade: string | null;
    critical_failed: number | null; high_failed: number | null; unknown_count: number | null; message: string | null; pending: boolean; raw: unknown;
};

const ONLINE_WINDOW_MS = 5 * 60_000;
/** The devices a security scan runs on: Windows and Linux ones (the name WINDOWS is from before Linux was added). */
const WINDOWS = Prisma.sql`(lower(COALESCE(a.facts->>'os', '')) IN ('windows', 'linux') OR (COALESCE(a.facts->>'os', '') = '' AND (lower(COALESCE(d.operating_system, '')) LIKE 'windows%' OR lower(COALESCE(d.operating_system, '')) ~ '(linux|ubuntu|debian|fedora|rocky|alma|centos|red hat|rhel|suse|oracle)')))`;

/** A whole number from a query string, kept within bounds. */
function bounded(raw: unknown, def: number, min: number, max: number, what: string): number {
    if (raw === undefined || raw === null || raw === "") return def;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) throw new BadRequestException(`${what} must be a whole number from ${min} to ${max}.`);
    return n;
}

@Injectable()
export class SecurityFleetService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly orgs: OrganizationContextService,
        private readonly access: ClientAccessService,
        private readonly security: SecurityService,
    ) { }

    /** The WHERE of both views: Windows devices of this organisation, the customer filter and what the person may see. */
    private async where(userId: string | null, clientId: string | undefined, extra: Prisma.Sql[] = []): Promise<Prisma.Sql> {
        if (clientId !== undefined && !isCanonicalUuid(clientId)) throw new BadRequestException("That is not a customer id.");
        const orgId = await this.orgs.getDefaultOrganizationId();
        const scope = await this.access.scopeFor(userId);
        const conds: Prisma.Sql[] = [WINDOWS, Prisma.sql`c.organization_id = ${orgId}::uuid`];
        if (clientId) conds.push(Prisma.sql`st.client_id = ${clientId}::uuid`);
        if (scope) conds.push(deviceSqlOf(scope, { client: Prisma.sql`st.client_id::text`, site: Prisma.sql`d.site_id::text`, id: Prisma.sql`d.id::text` }));
        return Prisma.join([...conds, ...extra], " AND ");
    }

    private static readonly FROM = Prisma.sql`
        FROM public.devices d
        JOIN public.sites st ON st.id = d.site_id
        JOIN public.clients c ON c.id = st.client_id
        LEFT JOIN public.agents a ON a.device_id = d.id
        LEFT JOIN public.device_security_scans s ON s.device_id = d.id`;

    async fleet(userId: string | null, q: FleetQuery) {
        const limit = bounded(q.limit, 50, 1, MAX_FLEET_LIMIT, "The limit");
        const offset = bounded(q.offset, 0, 0, 1_000_000, "The offset");
        const sort = (q.sort ?? "worst") as FleetSort;
        if (!FLEET_SORTS.includes(sort)) throw new BadRequestException(`Sort must be one of: ${FLEET_SORTS.join(", ")}.`);
        const extra: Prisma.Sql[] = [];
        if (q.grade !== undefined && q.grade !== "") {
            if (!(FLEET_GRADES as readonly string[]).includes(q.grade)) throw new BadRequestException("Grade must be A, B, C, D, F or none.");
            extra.push(q.grade === "none" ? Prisma.sql`s.score IS NULL` : Prisma.sql`s.grade = ${q.grade}`);
        }
        const text = String(q.q ?? "").trim();
        if (text.length > 100) throw new BadRequestException("The search text is too long (100 characters at most).");
        if (/[\u0000-\u001f\u007f]/.test(text)) throw new BadRequestException("The search text has characters that are not allowed.");
        if (text) {
            const like = `%${text.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
            extra.push(Prisma.sql`(d.hostname ILIKE ${like} OR COALESCE(d.alias, '') ILIKE ${like} OR c.name ILIKE ${like})`);
        }
        const where = await this.where(userId, q.clientId, extra);
        const name = Prisma.sql`lower(COALESCE(d.alias, d.hostname))`;
        const order: Prisma.Sql = {
            // worst first: lowest score, then the most critical failures; devices with no score yet come last
            worst: Prisma.sql`(s.score IS NULL), s.score ASC, s.critical_failed DESC NULLS LAST, s.high_failed DESC NULLS LAST, ${name} ASC`,
            best: Prisma.sql`(s.score IS NULL), s.score DESC, ${name} ASC`,
            name: Prisma.sql`${name} ASC`,
            customer: Prisma.sql`lower(c.name) ASC, ${name} ASC`,
            scanned: Prisma.sql`s.scanned_at ASC NULLS FIRST, ${name} ASC`,
            critical: Prisma.sql`s.critical_failed DESC NULLS LAST, s.high_failed DESC NULLS LAST, ${name} ASC`,
        }[sort];

        const [rows, total] = await Promise.all([
            this.prisma.$queryRaw<FleetRow[]>`
                SELECT d.id::text AS device_id, d.hostname, d.alias, st.name AS site_name, c.id::text AS client_id, c.name AS client_name,
                       (a.id IS NOT NULL) AS has_agent, a.last_check_in_at, s.scanned_at, s.attempted_at, s.ok, s.score, s.grade,
                       s.critical_failed, s.high_failed, s.unknown_count, s.message, (s.pending_job_id IS NOT NULL) AS pending, s.raw
                ${SecurityFleetService.FROM}
                WHERE ${where}
                ORDER BY ${order}, d.id ASC
                LIMIT ${limit} OFFSET ${offset}`,
            this.prisma.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n ${SecurityFleetService.FROM} WHERE ${where}`,
        ]);
        const now = Date.now();
        return {
            total: total[0]?.n ?? 0, limit, offset, sort,
            items: rows.map((r) => {
                const summary = r.raw ? this.security.summarize({ raw: r.raw }) : null;
                return {
                    deviceId: r.device_id, name: r.alias || r.hostname, hostname: r.hostname, customer: r.client_name, clientId: r.client_id, site: r.site_name,
                    hasAgent: r.has_agent, online: !!r.last_check_in_at && now - r.last_check_in_at.getTime() <= ONLINE_WINDOW_MS,
                    scannedAt: r.scanned_at?.toISOString() ?? null, attemptedAt: r.attempted_at?.toISOString() ?? null,
                    stale: !!r.scanned_at && now - r.scanned_at.getTime() > STALE_AFTER_MS,
                    lastAttemptFailed: r.ok === false && !!r.message, message: r.message, pending: r.pending,
                    score: r.score, grade: r.grade, criticalFailed: r.critical_failed ?? 0, highFailed: r.high_failed ?? 0, unknown: r.unknown_count ?? 0,
                    defender: summary?.defender ?? null, bitlocker: summary?.bitlocker ?? null, firewall: summary?.firewall ?? null,
                };
            }),
        };
    }

    async summary(userId: string | null, clientId?: string) {
        const where = await this.where(userId, clientId);
        const withAgent = Prisma.sql`${where} AND a.id IS NOT NULL`;
        const staleBefore = new Date(Date.now() - STALE_AFTER_MS);
        const [grades, totals, rules] = await Promise.all([
            this.prisma.$queryRaw<Array<{ grade: string; n: number }>>`SELECT COALESCE(s.grade, 'none') AS grade, count(*)::int AS n ${SecurityFleetService.FROM} WHERE ${withAgent} GROUP BY 1`,
            this.prisma.$queryRaw<Array<{ windows: number; with_agent: number; never: number; scanned: number; stale: number; avg_score: number | null; critical_devices: number; failing: number; need_action: number }>>`
                SELECT count(*)::int AS windows,
                       count(*) FILTER (WHERE a.id IS NOT NULL)::int AS with_agent,
                       count(*) FILTER (WHERE a.id IS NOT NULL AND s.scanned_at IS NULL)::int AS never,
                       count(*) FILTER (WHERE s.scanned_at IS NOT NULL)::int AS scanned,
                       count(*) FILTER (WHERE s.scanned_at IS NOT NULL AND s.scanned_at < ${staleBefore}::timestamptz)::int AS stale,
                       avg(s.score)::float AS avg_score,
                       count(*) FILTER (WHERE s.critical_failed > 0)::int AS critical_devices,
                       count(*) FILTER (WHERE s.grade = 'F' OR s.critical_failed > 0)::int AS need_action,
                       count(*) FILTER (WHERE s.attempted_at IS NOT NULL AND s.ok = false AND s.message IS NOT NULL)::int AS failing
                ${SecurityFleetService.FROM} WHERE ${where}`,
            this.prisma.$queryRaw<Array<{ rule: string; devices: number }>>`
                SELECT r AS rule, count(*)::int AS devices
                  ${SecurityFleetService.FROM}, unnest(s.failed_rules) AS r
                 WHERE ${where} AND s.scanned_at IS NOT NULL
                 GROUP BY r ORDER BY count(*) DESC, r ASC LIMIT 30`,
        ]);
        const byGrade: Record<string, number> = { A: 0, B: 0, C: 0, D: 0, F: 0, none: 0 };
        for (const g of grades) byGrade[g.grade] = g.n;
        const t = totals[0];
        const topRules = rules
            .flatMap((r) => { const def = RULE_BY_ID.get(r.rule) ?? LINUX_RULE_BY_ID.get(r.rule); return def ? [{ id: r.rule, title: def.title, severity: def.severity, group: def.group, devices: r.devices }] : []; })
            .sort((a, b) => b.devices - a.devices || SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
            .slice(0, 10);
        return {
            windowsDevices: t?.windows ?? 0, withAgent: t?.with_agent ?? 0, noAgent: (t?.windows ?? 0) - (t?.with_agent ?? 0),
            scanned: t?.scanned ?? 0, neverScanned: t?.never ?? 0, stale: t?.stale ?? 0, lastScanFailed: t?.failing ?? 0,
            averageScore: t?.avg_score == null ? null : Math.round(t.avg_score), devicesWithCriticalFailures: t?.critical_devices ?? 0,
            /** Devices graded F or with a failed critical check: the ones to look at first (the Overview page). */
            devicesNeedingAction: t?.need_action ?? 0,
            grades: byGrade, topFailingRules: topRules,
        };
    }
}
