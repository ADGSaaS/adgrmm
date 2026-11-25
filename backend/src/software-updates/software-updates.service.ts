// backend/src/software-updates/software-updates.service.ts
//
// Third-party software patching: which programs on which devices have a newer version (winget, Chocolatey), a scan that
// finds out, and the update itself. Both ride the signed agent tasks: software_updates_scan lists, and software_install
// with action "upgrade" updates one program. Everything is limited by the same customer / site / tag scope as the rest
// of the device routes, and updates show up in the existing install log.
import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../storage/prisma.service";
import { OrganizationContextService } from "../storage/organization-context.service";
import { AccessScope, ClientAccessService, deviceSqlOf, deviceWhereOf } from "../reports/client-access.service";
import { PoliciesService } from "../policies/policies.service";
import {
    UPDATES_MIN_VERSION, UpdateRule, appKey, displayName, isSource, manualDecision, matchTextFor, validAppId, whyNotSupported,
} from "./update-rules";

export const MAX_UPDATE_DEVICES = 200;
const MAX_APPS_PER_REQUEST = 50;
const MAX_UPDATE_TASKS = 1000;
const MAX_FLEET_ROWS = 2000;
const DUPLICATE_WINDOW_MS = 30 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const idList = (v: unknown, label: string): string[] => {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) throw new BadRequestException(`${label} must be a list.`);
    const out = [...new Set(v.map((x) => String(x ?? "").trim()).filter(Boolean))];
    if (out.some((x) => !UUID.test(x))) throw new BadRequestException(`${label} has an id that is not valid.`);
    return out;
};

type Outdated = { source: string; app_id: string; name: string; installed_version: string | null; available_version: string; approximate: boolean; first_seen_at: Date; scanned_at: Date };
export type PlannedUpdate = { deviceId: string; device: string; customer: string; site: string; source: string; appId: string; name: string; from: string | null; to: string };
export type SkippedUpdate = { deviceId: string; device: string; customer: string; site: string; source: string | null; appId: string | null; name: string | null; reason: string };

@Injectable()
export class SoftwareUpdatesService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly orgs: OrganizationContextService,
        private readonly access: ClientAccessService,
        private readonly policies: PoliciesService,
    ) { }

    private async org(organizationId?: string | null) {
        return organizationId || (await this.orgs.getDefaultOrganizationId());
    }

    private limitSql(scope: AccessScope | null) {
        return scope ? Prisma.sql`AND ${deviceSqlOf(scope, { client: Prisma.sql`c.id::text`, site: Prisma.sql`d.site_id::text`, id: Prisma.sql`d.id::text` })}` : Prisma.empty;
    }

    private static readonly WINDOWS = Prisma.sql`(lower(COALESCE(a.facts->>'os', '')) = 'windows' OR lower(COALESCE(d.operating_system, '')) LIKE 'windows%')`;

    /* ------------------------------ the rules ------------------------------ */

    async loadRules(orgId: string): Promise<UpdateRule[]> {
        const rows = await this.prisma.software_update_rules.findMany({ where: { organization_id: orgId } });
        return rows.map((r) => ({ source: r.source, appId: r.app_id, rule: r.rule === "block" ? "block" : "allow", clientId: r.client_id }));
    }

    async listRules(organizationId: string | null | undefined, userId: string | null, clientId?: string) {
        const orgId = await this.org(organizationId);
        const allowed = await this.access.allowedFor(userId);
        if (clientId && !UUID.test(clientId)) throw new BadRequestException("That customer is not valid.");
        const rows = await this.prisma.software_update_rules.findMany({
            where: { organization_id: orgId, ...(clientId ? { OR: [{ client_id: clientId }, { client_id: null }] } : {}) },
            orderBy: [{ rule: "asc" }, { app_id: "asc" }],
        });
        const clients = await this.prisma.clients.findMany({ where: { organization_id: orgId, id: { in: [...new Set(rows.map((r) => r.client_id).filter((c): c is string => !!c))] } }, select: { id: true, name: true } });
        const names = new Map(clients.map((c) => [c.id, c.name]));
        // a customer-limited person sees the organisation's rules (they apply to their devices) and their own customers' rules
        return {
            items: rows
                .filter((r) => !allowed || !r.client_id || allowed.includes(r.client_id))
                .map((r) => ({
                    id: r.id, source: r.source, appId: r.app_id, name: r.app_name, rule: r.rule as "allow" | "block",
                    clientId: r.client_id, customer: r.client_id ? names.get(r.client_id) ?? null : null,
                    createdAt: r.created_at.toISOString(),
                })),
        };
    }

    async setRule(body: unknown, userId: string | null, organizationId?: string | null) {
        const orgId = await this.org(organizationId);
        if (!body || typeof body !== "object") throw new BadRequestException("Nothing was sent.");
        const b = body as Record<string, unknown>;
        const rule = b.rule;
        if (rule !== "allow" && rule !== "block") throw new BadRequestException("The rule must be allow or block.");
        const source = String(b.source ?? "winget");
        if (!isSource(source)) throw new BadRequestException("The source must be winget or chocolatey.");
        const appId = String(b.appId ?? "").trim();
        if (!validAppId(source, appId)) throw new BadRequestException("That package id is not valid.");
        const clientId = b.clientId === undefined || b.clientId === null || b.clientId === "" ? null : String(b.clientId);
        const nameRaw = String(b.name ?? "").trim().replace(/[\u0000-\u001f]/g, " ").slice(0, 200);
        const allowed = await this.access.allowedFor(userId);
        // someone limited to some customers may only keep rules for those customers, never for the whole organisation
        this.access.assertClient(allowed, clientId ?? undefined);
        if (clientId) {
            if (!UUID.test(clientId)) throw new BadRequestException("That customer is not valid.");
            const c = await this.prisma.clients.findFirst({ where: { id: clientId, organization_id: orgId }, select: { id: true } });
            if (!c) throw new NotFoundException("That customer does not exist.");
        }
        const existing = await this.prisma.$queryRaw<Array<{ id: string }>>`
            SELECT id::text AS id FROM public.software_update_rules
             WHERE organization_id::text = ${orgId} AND source = ${source}::text AND lower(app_id) = lower(${appId})
               AND client_id IS NOT DISTINCT FROM ${clientId}::uuid LIMIT 1`;
        const data = { rule, app_name: nameRaw || null };
        let id: string;
        if (existing.length) {
            id = existing[0].id;
            await this.prisma.software_update_rules.update({ where: { id }, data: { ...data, created_by: userId } });
        } else {
            const row = await this.prisma.software_update_rules.create({ data: { organization_id: orgId, client_id: clientId, source, app_id: appId, created_by: userId, ...data } });
            id = row.id;
        }
        return { id, source, appId, rule, clientId };
    }

    async removeRule(id: string, userId: string | null, organizationId?: string | null) {
        const orgId = await this.org(organizationId);
        const row = await this.prisma.software_update_rules.findFirst({ where: { id, organization_id: orgId } });
        if (!row) throw new NotFoundException("That entry does not exist.");
        const allowed = await this.access.allowedFor(userId);
        this.access.assertClient(allowed, row.client_id);
        await this.prisma.software_update_rules.delete({ where: { id } });
        return { id, deleted: true };
    }

    /* ------------------------------ devices ------------------------------ */

    /** The devices asked for, inside what the person may see, with what we need to know about their agents. */
    private async devicesFor(orgId: string, userId: string | null, deviceIds: string[]) {
        const scope = await this.access.scopeFor(userId);
        const devices = await this.prisma.devices.findMany({
            where: { AND: [{ id: { in: deviceIds } }, { sites: { clients: { organization_id: orgId } } }, ...(scope ? [deviceWhereOf(scope)] : [])] },
            select: { id: true, alias: true, hostname: true, sites: { select: { name: true, client_id: true, clients: { select: { name: true } } } }, agents: { select: { id: true, version: true, facts: true, last_check_in_at: true } } },
            orderBy: { hostname: "asc" },
        });
        return devices.map((d) => ({
            deviceId: d.id,
            device: String(d.alias || d.hostname || d.id),
            customer: d.sites?.clients?.name ?? "",
            site: d.sites?.name ?? "",
            clientId: d.sites?.client_id ?? null,
            agent: d.agents ? { id: d.agents.id, version: d.agents.version, os: String((d.agents.facts as any)?.os ?? "").toLowerCase(), lastCheckInAt: d.agents.last_check_in_at } : null,
        }));
    }

    /* ------------------------------ scanning ------------------------------ */

    /** Looks for outdated programs on these devices now. A device with a scan already waiting is left alone. */
    async scanNow(body: unknown, userId: string | null, organizationId?: string | null) {
        const orgId = await this.org(organizationId);
        if (!body || typeof body !== "object") throw new BadRequestException("Nothing was sent.");
        const deviceIds = idList((body as any).deviceIds, "deviceIds");
        if (!deviceIds.length) throw new BadRequestException("Choose at least one device.");
        if (deviceIds.length > MAX_UPDATE_DEVICES) throw new BadRequestException(`Scan ${MAX_UPDATE_DEVICES} devices at most at a time.`);
        const devices = await this.devicesFor(orgId, userId, deviceIds);
        const found = new Set(devices.map((d) => d.deviceId));
        const skipped: SkippedUpdate[] = deviceIds.filter((id) => !found.has(id)).map((id) => ({ deviceId: id, device: id, customer: "", site: "", source: null, appId: null, name: null, reason: "Device not found." }));
        const agentIds = devices.flatMap((d) => (d.agent ? [d.agent.id] : []));
        const busy = new Set(
            agentIds.length
                ? (await this.prisma.agent_tasks.findMany({ where: { agent_id: { in: agentIds }, type: "software_updates_scan", status: { in: ["pending", "queued", "running"] } }, select: { agent_id: true } })).map((t) => t.agent_id)
                : [],
        );
        const queue: string[] = [];
        for (const d of devices) {
            const base = { deviceId: d.deviceId, device: d.device, customer: d.customer, site: d.site, source: null, appId: null, name: null };
            if (!d.agent) { skipped.push({ ...base, reason: "It has no agent." }); continue; }
            const why = whyNotSupported({ version: d.agent.version, os: d.agent.os, lastCheckInAt: d.agent.lastCheckInAt });
            if (why) { skipped.push({ ...base, reason: why }); continue; }
            if (busy.has(d.agent.id)) { skipped.push({ ...base, reason: "A scan is already waiting for this device." }); continue; }
            queue.push(d.agent.id);
        }
        const now = new Date();
        if (queue.length) {
            await this.prisma.agent_tasks.createMany({ data: queue.map((agentId) => ({ agent_id: agentId, type: "software_updates_scan" as const, payload: { scheduled: false } as any, status: "queued" as const, queued_at: now, created_by: userId, created_at: now, updated_at: now })) });
        }
        return { queued: queue.length, skipped: skipped.map(({ customer, site, source, appId, name, ...rest }) => rest) };
    }

    /* ------------------------------ updating ------------------------------ */

    /** What an update request would do: which program on which device, and who is skipped and why. Nothing is queued. */
    async plan(orgId: string, userId: string | null, body: unknown) {
        if (!body || typeof body !== "object") throw new BadRequestException("Nothing was sent.");
        const b = body as Record<string, unknown>;
        const deviceIds = idList(b.deviceIds, "deviceIds");
        if (!deviceIds.length) throw new BadRequestException("Choose at least one device.");
        if (deviceIds.length > MAX_UPDATE_DEVICES) throw new BadRequestException(`Update ${MAX_UPDATE_DEVICES} devices at most at a time.`);
        const all = b.all === true;
        let wanted: Array<{ source: string; appId: string }> = [];
        if (!all) {
            if (!Array.isArray(b.apps) || !b.apps.length) throw new BadRequestException("Choose at least one program, or update everything.");
            if (b.apps.length > MAX_APPS_PER_REQUEST) throw new BadRequestException(`Update ${MAX_APPS_PER_REQUEST} programs at most at a time.`);
            wanted = b.apps.map((x: any) => {
                const source = String(x?.source ?? "winget");
                const appId = String(x?.appId ?? "").trim();
                if (!isSource(source) || !validAppId(source, appId)) throw new BadRequestException("One of the programs is not valid.");
                return { source, appId };
            });
        }
        const wantedKeys = new Set(wanted.map((w) => appKey(w.source, w.appId)));
        const devices = await this.devicesFor(orgId, userId, deviceIds);
        const found = new Set(devices.map((d) => d.deviceId));
        const planned: PlannedUpdate[] = [];
        const skipped: SkippedUpdate[] = deviceIds.filter((id) => !found.has(id)).map((id) => ({ deviceId: id, device: id, customer: "", site: "", source: null, appId: null, name: null, reason: "Device not found." }));
        const rules = await this.loadRules(orgId);
        const agentIds = devices.flatMap((d) => (d.agent ? [d.agent.id] : []));
        const outdated = agentIds.length
            ? await this.prisma.agent_outdated_software.findMany({ where: { agent_id: { in: agentIds } }, orderBy: [{ name: "asc" }] })
            : [];
        const byAgent = new Map<string, Outdated[]>();
        for (const o of outdated) byAgent.set(o.agent_id, [...(byAgent.get(o.agent_id) ?? []), o as unknown as Outdated]);
        const busyRows = agentIds.length
            ? await this.prisma.agent_tasks.findMany({ where: { agent_id: { in: agentIds }, type: "software_install", status: { in: ["pending", "queued", "running"] }, created_at: { gte: new Date(Date.now() - DUPLICATE_WINDOW_MS) } }, select: { agent_id: true, payload: true } })
            : [];
        const busy = new Set<string>();
        for (const t of busyRows) {
            const p: any = t.payload;
            if (p?.action === "upgrade") busy.add(`${t.agent_id}\u0001${appKey(String(p.method), String(p.wingetId ?? p.chocolateyId ?? ""))}`);
        }

        for (const d of devices) {
            const base = { deviceId: d.deviceId, device: d.device, customer: d.customer, site: d.site };
            if (!d.agent) { skipped.push({ ...base, source: null, appId: null, name: null, reason: "It has no agent." }); continue; }
            const why = whyNotSupported({ version: d.agent.version, os: d.agent.os, lastCheckInAt: d.agent.lastCheckInAt });
            if (why) { skipped.push({ ...base, source: null, appId: null, name: null, reason: why }); continue; }
            const mine = byAgent.get(d.agent.id) ?? [];
            const picked = all ? mine : mine.filter((o) => wantedKeys.has(appKey(o.source, o.app_id)));
            if (!all) {
                for (const w of wanted) {
                    if (!mine.some((o) => appKey(o.source, o.app_id) === appKey(w.source, w.appId))) {
                        skipped.push({ ...base, source: w.source, appId: w.appId, name: null, reason: "It is not listed as outdated on this device (as of its last scan)." });
                    }
                }
            } else if (!picked.length) {
                skipped.push({ ...base, source: null, appId: null, name: null, reason: "Nothing outdated is listed for this device." });
            }
            for (const o of picked) {
                const item = { ...base, source: o.source, appId: o.app_id, name: displayName(o.name, o.installed_version) };
                const decision = manualDecision(rules, d.clientId, o.source, o.app_id);
                if (!decision.update) { skipped.push({ ...item, reason: decision.reason }); continue; }
                if (busy.has(`${d.agent.id}\u0001${appKey(o.source, o.app_id)}`)) { skipped.push({ ...item, reason: "The same update is already waiting for this device." }); continue; }
                if (planned.length >= MAX_UPDATE_TASKS) { skipped.push({ ...item, reason: `At most ${MAX_UPDATE_TASKS} updates are started at a time.` }); continue; }
                planned.push({ ...base, source: o.source, appId: o.app_id, name: o.name, from: o.installed_version, to: o.available_version });
            }
        }
        const agentOf = new Map(devices.map((d) => [d.deviceId, d.agent?.id ?? null]));
        return { planned, skipped, agentOf };
    }

    async preview(body: unknown, userId: string | null, organizationId?: string | null) {
        const orgId = await this.org(organizationId);
        const r = await this.plan(orgId, userId, body);
        return {
            eligible: r.planned.map(({ deviceId, device, customer, site, source, appId, name, from, to }) => ({ deviceId, device, customer, site, source, appId, name, from, to })),
            skipped: r.skipped,
            total: r.planned.length + r.skipped.length,
        };
    }

    /** The payload the agent is told: an upgrade by package id, never a name it has to guess. */
    static payloadFor(u: { source: string; appId: string; name: string; from: string | null; to: string }) {
        return {
            action: "upgrade" as const,
            name: displayName(u.name, u.from),
            matchText: matchTextFor(u.name, u.from),
            method: u.source === "chocolatey" ? ("chocolatey" as const) : ("winget" as const),
            ...(u.source === "chocolatey" ? { chocolateyId: u.appId } : { wingetId: u.appId }),
            ...(u.from ? { fromVersion: u.from.slice(0, 100) } : {}),
            toVersion: u.to.slice(0, 100),
        };
    }

    async update(body: unknown, userId: string | null, organizationId?: string | null) {
        const orgId = await this.org(organizationId);
        const r = await this.plan(orgId, userId, body);
        const now = new Date();
        if (r.planned.length) {
            await this.prisma.agent_tasks.createMany({
                data: r.planned.map((u) => ({ agent_id: r.agentOf.get(u.deviceId)!, type: "software_install" as const, payload: SoftwareUpdatesService.payloadFor(u) as any, status: "queued" as const, queued_at: now, created_by: userId, created_at: now, updated_at: now })),
            });
        }
        return { queued: r.planned.length, skipped: r.skipped.map(({ customer, site, ...rest }) => rest) };
    }

    /* ------------------------------ one device ------------------------------ */

    async forDevice(organizationId: string | null | undefined, userId: string | null, deviceId: string) {
        const orgId = await this.org(organizationId);
        const [d] = await this.devicesFor(orgId, userId, [deviceId]);
        if (!d) throw new NotFoundException("Device not found");
        const rules = await this.loadRules(orgId);
        const eff = (await this.policies.effectiveForDevices([deviceId], orgId)).get(deviceId);
        const scanHours = Number(eff?.scalars["patching.appScanHours"]?.value ?? 0) || 0;
        const mode = String(eff?.scalars["patching.appUpdate"]?.value ?? "none");
        const when = String(eff?.scalars["patching.appUpdateIn"]?.value ?? "anytime");
        const src = (k: "patching.appScanHours" | "patching.appUpdate") => { const s = eff?.scalars[k]?.source; return s?.kind === "policy" ? s.name : null; };
        const automation = { scanEveryHours: scanHours, mode, when, policy: src("patching.appUpdate") ?? src("patching.appScanHours"), minVersion: UPDATES_MIN_VERSION };
        if (!d.agent) return { supported: false as const, reason: "This device has no agent.", automation, scan: null, items: [], recent: [] };
        if (d.agent.os !== "windows") return { supported: false as const, reason: "Updating other programs only works on Windows devices for now. Nothing is scanned on this device.", automation, scan: null, items: [], recent: [] };
        const old = !whyNotSupported({ version: d.agent.version, os: d.agent.os, lastCheckInAt: new Date() });
        const [rows, scan, tasks] = await Promise.all([
            this.prisma.agent_outdated_software.findMany({ where: { agent_id: d.agent.id }, orderBy: { name: "asc" } }),
            this.prisma.agent_software_scans.findUnique({ where: { agent_id: d.agent.id } }),
            this.prisma.agent_tasks.findMany({
                where: { agent_id: d.agent.id, type: { in: ["software_install", "software_updates_scan"] }, created_at: { gte: new Date(Date.now() - 14 * 86_400_000) } },
                orderBy: { created_at: "desc" }, take: 100,
                select: { id: true, type: true, status: true, payload: true, created_at: true, completed_at: true, agent_task_runs: { orderBy: { started_at: "desc" }, take: 1, select: { output: true } } },
            }),
        ]);
        const upgrades = tasks.filter((t) => t.type === "software_install" && (t.payload as any)?.action === "upgrade");
        const pendingScan = tasks.some((t) => t.type === "software_updates_scan" && ["pending", "queued", "running"].includes(t.status));
        const lastFor = (source: string, id: string) => upgrades.find((t) => { const p: any = t.payload; return appKey(String(p.method), String(p.wingetId ?? p.chocolateyId ?? "")) === appKey(source, id); });
        const items = rows.map((o) => {
            const t = lastFor(o.source, o.app_id);
            const out: any = t?.agent_task_runs?.[0]?.output ?? {};
            const waiting = !!t && ["pending", "queued", "running"].includes(t.status);
            const decision = manualDecision(rules, d.clientId, o.source, o.app_id);
            const allowed = rules.some((r) => r.rule === "allow" && appKey(r.source, r.appId) === appKey(o.source, o.app_id) && (r.clientId === null || r.clientId === d.clientId));
            return {
                source: o.source, appId: o.app_id, name: displayName(o.name, o.installed_version), installedVersion: o.installed_version, availableVersion: o.available_version,
                approximate: o.approximate, firstSeenAt: o.first_seen_at.toISOString(),
                blocked: !decision.update, allowed,
                updating: waiting ? (t!.status === "running" ? "running" : "waiting") : null,
                lastAttempt: t && !waiting ? { status: t.status, at: (t.completed_at ?? t.created_at).toISOString(), message: typeof out.message === "string" ? out.message.slice(0, 300) : null } : null,
            };
        });
        return {
            supported: true as const,
            canScan: old,
            reason: old ? null : `Its agent is ${d.agent.version}; scanning for outdated programs needs ${UPDATES_MIN_VERSION} or newer.`,
            automation,
            scan: scan ? {
                scannedAt: scan.scanned_at?.toISOString() ?? null, attemptedAt: scan.attempted_at.toISOString(), ok: scan.ok, winget: scan.winget_state, chocolatey: scan.choco_state, message: scan.message,
            } : null,
            scanning: pendingScan,
            items,
        };
    }

    /* ------------------------------ the whole fleet ------------------------------ */

    private fleetFilters(f: { clientId?: string; q?: string; source?: string }) {
        if (f.clientId && !UUID.test(f.clientId)) throw new BadRequestException("That customer is not valid.");
        if (f.source && !isSource(f.source)) throw new BadRequestException("The source must be winget or chocolatey.");
        const term = (f.q ?? "").trim().slice(0, 100);
        const like = `%${term.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
        return {
            client: f.clientId ? Prisma.sql`AND c.id = ${f.clientId}::uuid` : Prisma.empty,
            source: f.source ? Prisma.sql`AND o.source = ${f.source}::text` : Prisma.empty,
            q: term ? Prisma.sql`AND (o.name ILIKE ${like} ESCAPE '\\' OR o.app_id ILIKE ${like} ESCAPE '\\')` : Prisma.empty,
        };
    }

    /** One row per program: how many devices have an older version, which versions, and whether a rule covers it. */
    async fleet(organizationId: string | null | undefined, userId: string | null, f: { clientId?: string; q?: string; source?: string }) {
        const orgId = await this.org(organizationId);
        const scope = await this.access.scopeFor(userId);
        const limit = this.limitSql(scope);
        const fl = this.fleetFilters(f);
        const [rows, coverage, rules] = await Promise.all([
            this.prisma.$queryRaw<Array<{ source: string; key: string; app_id: string; name: string; installed: string | null; available: string; n: number; approx: boolean; first_seen: Date }>>`
                SELECT o.source, lower(o.app_id) AS key, max(o.app_id) AS app_id, max(o.name) AS name, o.installed_version AS installed, o.available_version AS available,
                       count(DISTINCT o.agent_id)::int AS n, bool_or(o.approximate) AS approx, min(o.first_seen_at) AS first_seen
                  FROM public.agent_outdated_software o
                  JOIN public.agents a ON a.id = o.agent_id
                  JOIN public.devices d ON d.id = a.device_id
                  JOIN public.sites st ON st.id = d.site_id
                  JOIN public.clients c ON c.id = st.client_id
                 WHERE c.organization_id::text = ${orgId} ${limit} ${fl.client} ${fl.source} ${fl.q}
                 GROUP BY o.source, lower(o.app_id), o.installed_version, o.available_version`,
            this.prisma.$queryRaw<Array<{ windows: number; scanned: number; oldest: Date | null; failing: number }>>`
                SELECT count(*)::int AS windows, count(s.scanned_at)::int AS scanned, min(s.scanned_at) AS oldest,
                       count(*) FILTER (WHERE s.attempted_at IS NOT NULL AND s.ok = false)::int AS failing
                  FROM public.agents a
                  JOIN public.devices d ON d.id = a.device_id
                  JOIN public.sites st ON st.id = d.site_id
                  JOIN public.clients c ON c.id = st.client_id
                  LEFT JOIN public.agent_software_scans s ON s.agent_id = a.id
                 WHERE c.organization_id::text = ${orgId} AND ${SoftwareUpdatesService.WINDOWS} ${limit} ${fl.client}`,
            this.loadRules(orgId),
        ]);
        type FleetAcc = { source: string; appId: string; names: Map<string, number>; devices: number; versions: Array<{ installed: string | null; available: string; devices: number }>; approx: boolean; firstSeen: Date };
        const apps = new Map<string, FleetAcc>();
        for (const r of rows) {
            const k = `${r.source}\u0001${r.key}`;
            const a: FleetAcc = apps.get(k) ?? { source: r.source, appId: r.app_id, names: new Map(), devices: 0, versions: [], approx: false, firstSeen: r.first_seen };
            a.devices += Number(r.n);
            a.approx = a.approx || r.approx;
            const nm = displayName(r.name, r.installed);
            a.names.set(nm, (a.names.get(nm) ?? 0) + Number(r.n));
            a.versions.push({ installed: r.installed, available: r.available, devices: Number(r.n) });
            if (r.first_seen < a.firstSeen) a.firstSeen = r.first_seen;
            apps.set(k, a);
        }
        const clientId = f.clientId ?? null;
        const items = [...apps.values()].map((a) => {
            const orgRule = rules.find((r) => r.clientId === null && appKey(r.source, r.appId) === appKey(a.source, a.appId));
            const customerRules = rules.filter((r) => r.clientId !== null && (clientId === null || r.clientId === clientId) && appKey(r.source, r.appId) === appKey(a.source, a.appId));
            const name = [...a.names.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? a.appId;
            const versions = a.versions.sort((x, y) => y.devices - x.devices).slice(0, 20);
            const newest = [...new Set(a.versions.map((v) => v.available))];
            return {
                source: a.source, appId: a.appId, name, devices: a.devices, versions, availableVersions: newest.slice(0, 5), approximate: a.approx,
                since: a.firstSeen.toISOString(),
                rule: (orgRule?.rule ?? null) as "allow" | "block" | null,
                customerRules: customerRules.length,
                customerBlocks: customerRules.filter((r) => r.rule === "block").length,
            };
        }).sort((x, y) => y.devices - x.devices || x.name.localeCompare(y.name)).slice(0, MAX_FLEET_ROWS);
        const c = coverage[0] ?? { windows: 0, scanned: 0, oldest: null, failing: 0 };
        return {
            items,
            coverage: { windowsDevices: Number(c.windows), scanned: Number(c.scanned), neverScanned: Number(c.windows) - Number(c.scanned), oldestScan: c.oldest ? new Date(c.oldest).toISOString() : null, failing: Number(c.failing) },
            minVersion: UPDATES_MIN_VERSION,
        };
    }

    /** The devices that have one program outdated, so some of them can be picked for an update. */
    async fleetDevices(organizationId: string | null | undefined, userId: string | null, f: { source?: string; appId?: string; clientId?: string }) {
        const orgId = await this.org(organizationId);
        const scope = await this.access.scopeFor(userId);
        const limit = this.limitSql(scope);
        const source = f.source ?? "winget";
        const appId = String(f.appId ?? "").trim();
        if (!isSource(source) || !validAppId(source, appId)) throw new BadRequestException("That program is not valid.");
        const fl = this.fleetFilters({ clientId: f.clientId });
        const rules = await this.loadRules(orgId);
        const rows = await this.prisma.$queryRaw<Array<{ device_id: string; device: string; customer: string; client_id: string; site: string; name: string; installed: string | null; available: string; approx: boolean; scanned_at: Date; busy: boolean }>>`
            SELECT d.id::text AS device_id, COALESCE(NULLIF(d.alias, ''), d.hostname) AS device, c.name AS customer, c.id::text AS client_id, st.name AS site,
                   o.name, o.installed_version AS installed, o.available_version AS available, o.approximate AS approx, o.scanned_at,
                   EXISTS (SELECT 1 FROM public.agent_tasks t WHERE t.agent_id = a.id AND t.type = 'software_install' AND t.status IN ('pending','queued','running')
                              AND t.payload->>'action' = 'upgrade' AND lower(COALESCE(t.payload->>'wingetId', t.payload->>'chocolateyId')) = lower(o.app_id)) AS busy
              FROM public.agent_outdated_software o
              JOIN public.agents a ON a.id = o.agent_id
              JOIN public.devices d ON d.id = a.device_id
              JOIN public.sites st ON st.id = d.site_id
              JOIN public.clients c ON c.id = st.client_id
             WHERE c.organization_id::text = ${orgId} ${limit} ${fl.client} AND o.source = ${source}::text AND lower(o.app_id) = lower(${appId})
             ORDER BY c.name, device
             LIMIT 2000`;
        return {
            items: rows.map((r) => ({
                deviceId: r.device_id, device: r.device, customer: r.customer, site: r.site, name: displayName(r.name, r.installed), installedVersion: r.installed, availableVersion: r.available,
                approximate: r.approx, scannedAt: new Date(r.scanned_at).toISOString(), updating: r.busy,
                blocked: !manualDecision(rules, r.client_id, source, appId).update,
            })),
        };
    }

}

