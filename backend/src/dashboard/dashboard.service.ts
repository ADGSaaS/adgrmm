// backend/src/dashboard/dashboard.service.ts
//
// The numbers behind the Overview page, in one answer. Every section is computed with SQL aggregates (no loop over devices),
// only when the person may see it, inside the customers, sites and tags they are limited to, and kept for a short time
// (30 seconds) per section, organisation, scope and customer filter. Nothing is ever invalidated: the numbers are a little old
// at worst, which is what a dashboard is.
import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../storage/prisma.service";
import { OrganizationContextService } from "../storage/organization-context.service";
import { AccessScope, ClientAccessService, deviceSqlOf } from "../reports/client-access.service";
import { SecurityFleetService } from "../security/security-fleet.service";
import { AgentReleasesService } from "../agents/agent-releases.service";
import { compareAgentVersions, parseAgentVersion } from "../agents/agent-version.util";
import { isCanonicalUuid } from "../common/agent-lookup.util";
import { ALL_PERMISSIONS, permsForRoles } from "../auth/policy";
import { actorOf } from "../access/grant-rules";
import { slaFilter } from "../service-desk/ticket-filters";
import { ticketScopeSql } from "../service-desk/queues.service";
import { ACTIVE_STATUSES, isValidTimeZone } from "../schedule/schedule-core";
import { buildAttention, cacheKey, describeAudit, scopeKey, TtlCache } from "./dashboard.core";

export const DEFAULT_TTL_MS = 30_000;
export const ACTIVITY_ROWS = 8;
const MAX_VERSION_ROWS = 5;

/** Cache lifetime in milliseconds; DASHBOARD_CACHE_TTL_MS changes it (0 turns the cache off). */
export function ttlFromEnv(raw: string | undefined = process.env.DASHBOARD_CACHE_TTL_MS): number {
    if (raw === undefined || raw === "") return DEFAULT_TTL_MS;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), 300_000) : DEFAULT_TTL_MS;
}

type Ctx = { orgId: string; isDefaultOrg: boolean; userId: string | null; scope: AccessScope | null; scopeKey: string; clientId: string | null; perms: Set<string> };

/** Devices with their site, customer and agent (if any). The organisation comes from the customer. */
const DEVICES_FROM = Prisma.sql`
    FROM public.devices d
    LEFT JOIN public.sites st ON st.id = d.site_id
    LEFT JOIN public.clients c ON c.id = st.client_id
    LEFT JOIN public.agents a ON a.device_id = d.id`;
const AGENTS_FROM = Prisma.sql`
    FROM public.agents a
    JOIN public.devices d ON d.id = a.device_id
    LEFT JOIN public.sites st ON st.id = d.site_id
    LEFT JOIN public.clients c ON c.id = st.client_id`;

/** Same five-minute rule the device list uses for "online". */
const ONLINE = Prisma.sql`(CASE WHEN a.id IS NOT NULL THEN COALESCE(a.last_check_in_at > now() - interval '5 minutes', false)
                                ELSE COALESCE(d.last_seen_at > now() - interval '5 minutes', false) END)`;
const SEEN = Prisma.sql`COALESCE(a.last_check_in_at, d.last_seen_at)`;

/** An alert that is still open and not silenced: what the device list calls "with alerts". */
const LIVE_ALERT = Prisma.sql`al.state = 'OPEN' AND (al.silenced_until IS NULL OR al.silenced_until < now())`;

const EMPTY_SECURITY = {
    windowsDevices: 0, withAgent: 0, scanned: 0, neverScanned: 0, stale: 0, lastScanFailed: 0, averageScore: null as number | null,
    devicesWithCriticalFailures: 0, devicesNeedingAction: 0, grades: { A: 0, B: 0, C: 0, D: 0, F: 0, none: 0 } as Record<string, number>,
    topFailingRules: [] as Array<{ id: string; title: string; severity: string; group: string; devices: number }>,
};

const OPEN_TICKET = Prisma.sql`t.status::text NOT IN ('resolved', 'closed')`;

@Injectable()
export class DashboardService {
    private readonly log = new Logger("Dashboard");
    private readonly cache = new TtlCache<unknown>(ttlFromEnv());

    constructor(
        private readonly prisma: PrismaService,
        private readonly orgs: OrganizationContextService,
        private readonly access: ClientAccessService,
        private readonly security: SecurityFleetService,
        private readonly releases: AgentReleasesService,
    ) { }

    /** For tests: forget everything cached. */
    clearCache() { this.cache.clear(); }

    /* ------------------------------ who is asking ------------------------------ */

    /**
     * What the person may do. The permission guard only works it out for routes that name a permission, and this route names
     * none (each section has its own), so it is worked out here the same way: the token, Owner, then roles and groups.
     */
    async permsOf(req: any): Promise<Set<string>> {
        const fromGuard: Set<string> | undefined = req?.effectivePermissions;
        if (fromGuard) return fromGuard;
        const actor = actorOf(req);
        const held = new Set<string>([...actor.perms].map((p) => p.toLowerCase()));
        if (actor.owner) return new Set(ALL_PERMISSIONS.map((p) => String(p)));
        const roleNames = [...(Array.isArray(req?.user?.roles) ? req.user.roles : []), req?.user?.role].filter(Boolean).map((r: unknown) => String(r).toLowerCase());
        for (const p of permsForRoles(roleNames)) held.add(String(p).toLowerCase());
        if (held.size === 0 && actor.id) {
            try {
                const [rows, groups] = await Promise.all([
                    this.prisma.role_permissions.findMany({ where: { roles: { user_roles: { some: { user_id: actor.id } } } }, select: { permission_key: true }, distinct: ["permission_key"] }),
                    this.prisma.user_group_permissions.findMany({ where: { user_groups: { user_group_members: { some: { user_id: actor.id } } } }, select: { permission_key: true }, distinct: ["permission_key"] }),
                ]);
                for (const r of [...rows, ...groups]) if (r.permission_key) held.add(String(r.permission_key).toLowerCase());
            } catch (e: any) {
                this.log.warn(`Could not read permissions: ${e?.code ?? e?.message ?? e}`);
            }
        }
        return held;
    }

    private async orgOf(req: any): Promise<string> {
        const u = req?.user;
        const org = u?.organizationId ?? u?.org ?? null;
        return org ? String(org) : this.orgs.getDefaultOrganizationId();
    }

    /* ------------------------------ the answer ------------------------------ */

    async summary(req: any, clientIdRaw?: string) {
        const clientId = clientIdRaw === undefined || clientIdRaw === "" ? null : clientIdRaw;
        if (clientId !== null && !isCanonicalUuid(clientId)) throw new BadRequestException("That is not a customer id.");
        const userId: string | null = req?.user?.id ? String(req.user.id) : null;
        const [perms, orgId, scope] = await Promise.all([this.permsOf(req), this.orgOf(req), this.access.scopeFor(userId)]);
        // The security fleet service and the audit log work for the default organisation only, so another organisation gets nothing from them.
        const isDefaultOrg = orgId === (await this.orgs.getDefaultOrganizationId());
        const ctx: Ctx = { orgId, isDefaultOrg, userId, scope, scopeKey: scopeKey(scope, userId), clientId, perms };
        const can = (p: string) => perms.has(p);

        const allowed = {
            devices: can("devices.read"),
            alerts: can("alerts.read"),
            tickets: can("tickets.read"),
            schedule: can("schedule.read"),
            // The audit log is not split by customer, so only people who are not limited to some customers get it.
            activity: can("audit.read") && !scope && isDefaultOrg,
            release: can("agents.release.manage"),
            customers: can("customers.read"),
        };
        const none = Promise.resolve(null);
        const [devices, alerts, security, patching, agents, tickets, schedule, activity, release, setup] = await Promise.all([
            allowed.devices ? this.section("devices", ctx, () => this.devicesSection(ctx)) : none,
            allowed.alerts ? this.section("alerts", ctx, () => this.alertsSection(ctx)) : none,
            allowed.devices ? this.section("security", ctx, () => (isDefaultOrg ? this.securitySection(ctx) : Promise.resolve(EMPTY_SECURITY))) : none,
            allowed.devices ? this.section("patching", ctx, () => this.patchingSection(ctx)) : none,
            allowed.devices ? this.section("agents", ctx, () => this.agentsSection(ctx)) : none,
            allowed.tickets ? this.section("tickets", ctx, () => this.ticketsSection(ctx)) : none,
            allowed.schedule ? this.section("schedule", ctx, () => this.scheduleSection(ctx), userId ?? "") : none,
            allowed.activity ? this.section("activity", ctx, () => this.activitySection()) : none,
            allowed.release ? this.section("release", ctx, () => this.releases.waitingCandidates()) : none,
            allowed.devices ? this.section("setup", ctx, () => this.setupSection(ctx, allowed.customers)) : none,
        ]) as [any, any, any, any, any, any, any, any, Array<{ os: string; version: string }> | null, any];

        const attention = buildAttention({
            alerts, tickets, devices,
            security: security ? { attentionDevices: security.devicesNeedingAction, neverScanned: security.neverScanned } : null,
            patching,
            release,
        });

        return {
            generatedAt: new Date().toISOString(),
            cacheSeconds: Math.round(ttlFromEnv() / 1000),
            clientId,
            /** Which parts the person may see. A part that is null in the answer but allowed here simply has nothing to show. */
            access: { ...allowed, security: allowed.devices, patching: allowed.devices, agents: allowed.devices },
            setup,
            attention,
            devices,
            alerts,
            security,
            patching,
            agents: agents ? { ...agents, release } : null,
            tickets,
            schedule,
            activity: activity ? { ...activity, allCustomers: clientId !== null } : null,
        };
    }

    private section<T>(name: string, ctx: Ctx, load: () => Promise<T>, extra = ""): Promise<T> {
        return this.cache.get(cacheKey(name, ctx.orgId, ctx.scopeKey, ctx.clientId, extra), load) as Promise<T>;
    }

    /* ------------------------------ building blocks ------------------------------ */

    /** Where a device row belongs: this organisation, the customer filter, and what the person may see. */
    private devWhere(ctx: Ctx, withClient = true): Prisma.Sql {
        // A device with no site belongs to no customer, and the device list shows it to everyone (as a dash); here it counts for the default organisation only.
        const conds: Prisma.Sql[] = [ctx.isDefaultOrg ? Prisma.sql`(c.organization_id = ${ctx.orgId}::uuid OR c.id IS NULL)` : Prisma.sql`c.organization_id = ${ctx.orgId}::uuid`];
        if (withClient && ctx.clientId) conds.push(Prisma.sql`c.id = ${ctx.clientId}::uuid`);
        if (ctx.scope) conds.push(deviceSqlOf(ctx.scope, { client: Prisma.sql`c.id::text`, site: Prisma.sql`d.site_id::text`, id: Prisma.sql`d.id::text` }));
        return Prisma.join(conds, " AND ");
    }

    /* ------------------------------ devices ------------------------------ */

    private async devicesSection(ctx: Ctx) {
        const [r] = await this.prisma.$queryRaw<Array<{ total: number; online: number; offline: number; over24: number; never: number }>>`
            SELECT count(*)::int AS total,
                   count(*) FILTER (WHERE ${ONLINE})::int AS online,
                   count(*) FILTER (WHERE NOT ${ONLINE})::int AS offline,
                   count(*) FILTER (WHERE NOT ${ONLINE} AND ${SEEN} < now() - interval '24 hours')::int AS over24,
                   count(*) FILTER (WHERE ${SEEN} IS NULL)::int AS never
            ${DEVICES_FROM}
            WHERE ${this.devWhere(ctx)}`;
        // Removal requests waiting for someone with the right to delete devices (the same visibility as the device counts).
        const [rr] = await this.prisma.$queryRaw<Array<{ n: number }>>`
            SELECT count(*)::int AS n
            ${DEVICES_FROM}
            JOIN public.device_deletion_requests r ON r.device_id = d.id AND r.status = 'pending'
            WHERE ${this.devWhere(ctx)}`;
        return { total: r?.total ?? 0, online: r?.online ?? 0, offline: r?.offline ?? 0, offlineOver24h: r?.over24 ?? 0, neverCheckedIn: r?.never ?? 0, removalRequests: rr?.n ?? 0 };
    }

    private async setupSection(ctx: Ctx, mayReadCustomers: boolean) {
        const [has] = await this.prisma.$queryRaw<Array<{ has: boolean }>>`
            SELECT EXISTS (SELECT 1 ${DEVICES_FROM} WHERE ${this.devWhere(ctx, false)}) AS has`;
        let customers: number | null = null;
        if (mayReadCustomers) {
            const visible = await this.access.visibleClientsFor(ctx.userId);
            const [n] = await this.prisma.$queryRaw<Array<{ n: number }>>`
                SELECT count(*)::int AS n FROM public.clients cl
                 WHERE cl.organization_id = ${ctx.orgId}::uuid ${visible ? Prisma.sql`AND cl.id::text = ANY(${visible}::text[])` : Prisma.empty}`;
            customers = n?.n ?? 0;
        }
        return { hasDevices: !!has?.has, customers };
    }

    /* ------------------------------ alerts ------------------------------ */

    private async alertsSection(ctx: Ctx) {
        const where = this.devWhere(ctx);
        const [counts, flags] = await Promise.all([
            this.prisma.$queryRaw<Array<{ open: number; crit: number; acked: number; silenced: number }>>`
                SELECT count(*) FILTER (WHERE al.state = 'OPEN')::int AS open,
                       count(*) FILTER (WHERE al.state = 'OPEN' AND al.severity = 'CRIT')::int AS crit,
                       count(*) FILTER (WHERE al.state = 'ACKED')::int AS acked,
                       count(*) FILTER (WHERE al.state = 'SILENCED')::int AS silenced
                  FROM public.alerts al
                  JOIN public.devices d ON d.id = al.device_id
                  LEFT JOIN public.sites st ON st.id = d.site_id
                  LEFT JOIN public.clients c ON c.id = st.client_id
                 WHERE al.state <> 'RESOLVED' AND ${where}`,
            this.prisma.$queryRaw<Array<{ critical: number; warning: number }>>`
                SELECT count(*) FILTER (WHERE x.crit)::int AS critical, count(*) FILTER (WHERE x.warn AND NOT x.crit)::int AS warning
                  FROM (SELECT d.id, bool_or(al.severity = 'CRIT') AS crit, bool_or(al.severity = 'WARN') AS warn
                          FROM public.alerts al
                          JOIN public.devices d ON d.id = al.device_id
                          LEFT JOIN public.sites st ON st.id = d.site_id
                          LEFT JOIN public.clients c ON c.id = st.client_id
                         WHERE ${LIVE_ALERT} AND ${where}
                         GROUP BY d.id) x`,
        ]);
        const r = counts[0];
        return {
            open: r?.open ?? 0, openCritical: r?.crit ?? 0, acknowledged: r?.acked ?? 0, silenced: r?.silenced ?? 0,
            /** Devices with an open critical alert, and devices whose open alerts are all warnings: the Critical and Warning tiles. */
            devicesCritical: flags[0]?.critical ?? 0, devicesWarning: flags[0]?.warning ?? 0,
        };
    }

    /* ------------------------------ security ------------------------------ */

    private async securitySection(ctx: Ctx) {
        const s = await this.security.summary(ctx.userId, ctx.clientId ?? undefined);
        return {
            windowsDevices: s.windowsDevices, withAgent: s.withAgent, scanned: s.scanned, neverScanned: s.neverScanned, stale: s.stale,
            lastScanFailed: s.lastScanFailed, averageScore: s.averageScore, devicesWithCriticalFailures: s.devicesWithCriticalFailures,
            devicesNeedingAction: s.devicesNeedingAction, grades: s.grades, topFailingRules: s.topFailingRules.slice(0, 3),
        };
    }

    /* ------------------------------ patching ------------------------------ */

    private async patchingSection(ctx: Ctx) {
        const where = this.devWhere(ctx);
        // The latest answer of each kind per agent: a scan keeps its list of missing updates in its run, an install says whether
        // a restart is needed. Looked up one agent at a time through the task indexes, so a large fleet stays quick.
        const patchesOf = Prisma.sql`COALESCE(jsonb_array_length(CASE
            WHEN jsonb_typeof(res.artifacts->'patches') = 'array' THEN res.artifacts->'patches'
            WHEN jsonb_typeof(r.output->'artifacts'->'patches') = 'array' THEN r.output->'artifacts'->'patches'
            WHEN jsonb_typeof(r.output->'patches') = 'array' THEN r.output->'patches' END), 0)`;
        const [r, o] = await Promise.all([
            this.prisma.$queryRaw<Array<{ agents: number; scanned: number; pending: number; restart: number; failed: number }>>`
                WITH ag AS (SELECT a.id AS agent_id ${AGENTS_FROM} WHERE ${where})
                SELECT count(*)::int AS agents,
                       count(*) FILTER (WHERE ps.finished_at IS NOT NULL)::int AS scanned,
                       count(*) FILTER (WHERE COALESCE(ps.patches, 0) > 0)::int AS pending,
                       count(*) FILTER (WHERE (CASE WHEN pi.finished_at IS NOT NULL AND ps.finished_at IS NOT NULL AND pi.finished_at > ps.finished_at AND pi.reboot IS NOT NULL
                                                    THEN pi.reboot ELSE ps.reboot END) = 'true')::int AS restart,
                       count(*) FILTER (WHERE fi.status = 'failed' AND fi.at > now() - interval '14 days')::int AS failed
                  FROM ag
                  LEFT JOIN LATERAL (
                      SELECT r.finished_at, ${patchesOf} AS patches, COALESCE(res.artifacts->>'rebootRequired', r.output->'artifacts'->>'rebootRequired') AS reboot
                        FROM public.agent_task_runs r
                        JOIN public.agent_tasks t ON t.id = r.task_id
                        LEFT JOIN public.agent_task_results res ON res.run_id = r.id
                       WHERE t.agent_id = ag.agent_id AND t.type = 'patch_scan' AND r.status = 'succeeded'
                       ORDER BY r.finished_at DESC NULLS LAST, r.created_at DESC LIMIT 1) ps ON true
                  LEFT JOIN LATERAL (
                      SELECT r.finished_at, COALESCE(res.artifacts->>'requiresReboot', r.output->'artifacts'->>'requiresReboot') AS reboot
                        FROM public.agent_task_runs r
                        JOIN public.agent_tasks t ON t.id = r.task_id
                        LEFT JOIN public.agent_task_results res ON res.run_id = r.id
                       WHERE t.agent_id = ag.agent_id AND t.type = 'patch_install' AND r.status = 'succeeded'
                       ORDER BY r.finished_at DESC NULLS LAST, r.created_at DESC LIMIT 1) pi ON true
                  LEFT JOIN LATERAL (
                      SELECT r.status::text AS status, COALESCE(r.finished_at, r.started_at) AS at
                        FROM public.agent_task_runs r
                        JOIN public.agent_tasks t ON t.id = r.task_id
                       WHERE t.agent_id = ag.agent_id AND t.type = 'patch_install'
                       ORDER BY r.created_at DESC LIMIT 1) fi ON true`,
            this.prisma.$queryRaw<Array<{ devices: number; apps: number }>>`
                SELECT count(DISTINCT o.agent_id)::int AS devices, count(DISTINCT lower(o.source) || ':' || lower(o.app_id))::int AS apps
                  FROM public.agent_outdated_software o
                  JOIN public.agents a ON a.id = o.agent_id
                  JOIN public.devices d ON d.id = a.device_id
                  LEFT JOIN public.sites st ON st.id = d.site_id
                  LEFT JOIN public.clients c ON c.id = st.client_id
                 WHERE ${where}`,
        ]);
        const x = r[0];
        return {
            devicesWithAgent: x?.agents ?? 0, scanned: x?.scanned ?? 0, neverScanned: (x?.agents ?? 0) - (x?.scanned ?? 0),
            withPendingUpdates: x?.pending ?? 0, needRestart: x?.restart ?? 0, installFailed: x?.failed ?? 0,
            outdatedSoftwareDevices: o[0]?.devices ?? 0, outdatedSoftwareApps: o[0]?.apps ?? 0,
        };
    }

    /* ------------------------------ agent versions ------------------------------ */

    private async agentsSection(ctx: Ctx) {
        const rows = await this.prisma.$queryRaw<Array<{ version: string; n: number; pilot: number }>>`
            SELECT COALESCE(NULLIF(a.version, ''), 'unknown') AS version, count(*)::int AS n,
                   count(*) FILTER (WHERE COALESCE(d.update_ring, c.default_update_ring, 'stable') = 'pilot')::int AS pilot
              ${AGENTS_FROM}
             WHERE ${this.devWhere(ctx)}
             GROUP BY 1`;
        const parsed = rows.map((r) => ({ ...r, key: parseAgentVersion(r.version) }));
        // Newest first; versions that cannot be read go last.
        parsed.sort((x, y) => (x.key && y.key ? compareAgentVersions(y.key, x.key) : x.key ? -1 : y.key ? 1 : y.n - x.n));
        const total = parsed.reduce((s, r) => s + r.n, 0);
        const pilotDevices = parsed.reduce((s, r) => s + r.pilot, 0);
        const latest = parsed.find((r) => r.key)?.version ?? null;
        const shown = parsed.slice(0, MAX_VERSION_ROWS).map((r) => ({ version: r.version, devices: r.n, pilot: r.pilot }));
        const rest = parsed.slice(MAX_VERSION_ROWS);
        return {
            devicesWithAgent: total,
            latestVersion: latest,
            onLatest: parsed.find((r) => r.version === latest)?.n ?? 0,
            distinctVersions: parsed.length,
            pilotDevices,
            versions: shown,
            otherVersions: rest.length ? { versions: rest.length, devices: rest.reduce((s, r) => s + r.n, 0) } : null,
        };
    }

    /* ------------------------------ service desk ------------------------------ */

    private async ticketsSection(ctx: Ctx) {
        const allowed = ctx.scope ? ctx.scope.clients : null;
        const where = Prisma.sql`t.organization_id = ${ctx.orgId}::uuid AND ${ticketScopeSql(allowed, ctx.userId)} ${ctx.clientId ? Prisma.sql`AND t.client_id = ${ctx.clientId}::uuid` : Prisma.empty}`;
        const [r, any] = await Promise.all([
            this.prisma.$queryRaw<Array<{ open: number; unassigned: number; breached: number; warning: number }>>`
                SELECT count(*)::int AS open,
                       count(*) FILTER (WHERE t.assignee_user_id IS NULL)::int AS unassigned,
                       count(*) FILTER (WHERE ${slaFilter("breached")})::int AS breached,
                       count(*) FILTER (WHERE ${slaFilter("warning")})::int AS warning
                  FROM public.tickets t
                 WHERE ${where} AND ${OPEN_TICKET}`,
            this.prisma.$queryRaw<Array<{ has: boolean }>>`SELECT EXISTS (SELECT 1 FROM public.tickets t WHERE ${where}) AS has`,
        ]);
        const x = r[0];
        return { open: x?.open ?? 0, unassigned: x?.unassigned ?? 0, breached: x?.breached ?? 0, warning: x?.warning ?? 0, hasTickets: !!any[0]?.has };
    }

    /* ------------------------------ today's schedule ------------------------------ */

    private async scheduleSection(ctx: Ctx) {
        const visible = await this.access.visibleClientsFor(ctx.userId);
        let tz = "UTC";
        if (ctx.userId && isCanonicalUuid(ctx.userId)) {
            const u = await this.prisma.users.findUnique({ where: { id: ctx.userId }, select: { timezone: true } });
            if (isValidTimeZone(u?.timezone)) tz = u!.timezone as string;
        }
        const where = Prisma.sql`v.organization_id = ${ctx.orgId}::uuid
            ${visible ? Prisma.sql`AND v.client_id::text = ANY(${visible}::text[])` : Prisma.empty}
            ${ctx.clientId ? Prisma.sql`AND v.client_id = ${ctx.clientId}::uuid` : Prisma.empty}`;
        const active = ACTIVE_STATUSES as string[];
        const dayStart = Prisma.sql`((date_trunc('day', now() AT TIME ZONE ${tz}::text)) AT TIME ZONE ${tz}::text)`;
        const dayEnd = Prisma.sql`((date_trunc('day', now() AT TIME ZONE ${tz}::text) + interval '1 day') AT TIME ZONE ${tz}::text)`;
        const [r, next] = await Promise.all([
            this.prisma.$queryRaw<Array<{ today: number; remaining: number; done: number; week: number }>>`
                SELECT count(*) FILTER (WHERE v.status <> 'cancelled' AND v.starts_at >= ${dayStart} AND v.starts_at < ${dayEnd})::int AS today,
                       count(*) FILTER (WHERE v.status = ANY(${active}::text[]) AND v.starts_at < ${dayEnd} AND v.ends_at > now() AND v.ends_at > ${dayStart})::int AS remaining,
                       count(*) FILTER (WHERE v.status = 'done' AND v.starts_at >= ${dayStart} AND v.starts_at < ${dayEnd})::int AS done,
                       count(*) FILTER (WHERE v.status = ANY(${active}::text[]) AND v.ends_at > now() AND v.starts_at < now() + interval '7 days')::int AS week
                  FROM public.ticket_visits v WHERE ${where}`,
            this.prisma.$queryRaw<Array<{ title: string; starts_at: Date; client: string | null }>>`
                SELECT v.title, v.starts_at, cl.name AS client
                  FROM public.ticket_visits v LEFT JOIN public.clients cl ON cl.id = v.client_id
                 WHERE ${where} AND v.status = ANY(${active}::text[]) AND v.ends_at > now()
                 ORDER BY v.starts_at ASC LIMIT 1`,
        ]);
        const x = r[0];
        return {
            today: x?.today ?? 0, remainingToday: x?.remaining ?? 0, doneToday: x?.done ?? 0, nextSevenDays: x?.week ?? 0,
            timeZone: tz,
            next: next[0] ? { title: String(next[0].title).slice(0, 120), startsAt: next[0].starts_at.toISOString(), customer: next[0].client } : null,
        };
    }

    /* ------------------------------ recent activity ------------------------------ */

    private async activitySection() {
        const rows = await this.prisma.$queryRaw<Array<{ id: string; at: Date; action: string; outcome: string; target_label: string | null; actor_email: string | null; first_name: string | null; last_name: string | null }>>`
            SELECT e.id::text AS id, e.created_at AS at, e.action, e.outcome, e.target_label, e.actor_email, u.first_name, u.last_name
              FROM public.audit_events e
              LEFT JOIN public.users u ON u.id = e.actor_user_id
             WHERE e.category <> 'auth' AND e.action NOT LIKE '%.list' AND e.action NOT LIKE '%.view' AND e.action NOT LIKE '%.read'
             ORDER BY e.created_at DESC, e.id DESC
             LIMIT ${ACTIVITY_ROWS}`;
        // Only who, what and when. The details of an event (which can hold values people typed) are never sent.
        return {
            items: rows.map((r) => ({
                id: r.id,
                at: r.at.toISOString(),
                actor: [r.first_name, r.last_name].filter(Boolean).join(" ") || r.actor_email || "RemoteIQ",
                text: describeAudit(r.action, r.target_label, r.outcome),
                failed: r.outcome !== "success",
            })),
        };
    }
}
