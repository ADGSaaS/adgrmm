// backend/src/policies/policies.service.ts
//
// Policies kept in the database, and the answer for a device: what it gets, from which policy, and why.
// Nothing changes for a device until a policy reaches it. Before that, it gets what the old screens say.
import { AccessScope, deviceWhereOf } from "../reports/client-access.service";
import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../storage/prisma.service";
import { OrganizationContextService } from "../storage/organization-context.service";
import { isValidTimezone } from "../reports/schedule-time";
import { activeWindow, nextWindowStart } from "./time-window";
import {
    applicablePolicies, cleanSections, diffEffective, explain, flatten, LEVELS, LIST_KEYS, OS_CHOICES, resolve,
    type Assignment, type Baseline, type DeviceContext, type DeviceOs, type Effective, type Level, type OsChoice, type PolicyRecord, type Sections,
} from "./policy-engine";

export type Actor = { id: string | null; name: string | null };

type DeviceRow = DeviceContext & { hostname: string; customer: string | null; site: string | null; organizationId: string };

const MAX_POLICIES = 200;
const MAX_ASSIGNMENTS = 500;
const DEVICE_LIMIT = 5000;
const CACHE_MS = 5000;

export function osFamily(os: string | null | undefined, factsOs?: unknown): DeviceOs {
    const text = `${os ?? ""} ${typeof factsOs === "string" ? factsOs : ""}`.toLowerCase();
    if (/windows/.test(text)) return "windows";
    if (/mac|darwin|os x/.test(text)) return "macos";
    if (/linux|ubuntu|debian|centos|red ?hat|rhel|fedora|suse|alma|rocky/.test(text)) return "linux";
    return "unknown";
}

type Snapshot = {
    at: number;
    policies: PolicyRecord[];
    baseline: (clientId: string | null) => Baseline;
};

@Injectable()
export class PoliciesService {
    private static cache = new Map<string, Snapshot>();

    /**
     * Policies and the settings they sit on top of are read once and kept for a few seconds. Anything that
     * changes one of them calls this, so a change shows at once.
     */
    static invalidate() {
        PoliciesService.cache.clear();
    }

    constructor(private readonly prisma: PrismaService, private readonly orgs: OrganizationContextService) { }

    /** Anything changed, so the next question is answered from fresh data. */
    private forget() {
        PoliciesService.invalidate();
    }

    private async org(organizationId?: string | null) {
        return organizationId || (await this.orgs.getDefaultOrganizationId());
    }

    /* ------------------------------ loading ------------------------------ */

    private async loadPolicies(organizationId: string): Promise<PolicyRecord[]> {
        const rows = await this.prisma.policies.findMany({ where: { organization_id: organizationId }, include: { assignments: true }, orderBy: { created_at: "asc" } });
        return rows.map((r) => this.record(r));
    }

    private record(r: any): PolicyRecord {
        return {
            id: r.id, name: r.name, enabled: r.enabled, priority: r.priority, os: (OS_CHOICES as readonly string[]).includes(r.os) ? (r.os as OsChoice) : "any",
            enforced: r.enforced, sections: (r.sections ?? {}) as Sections,
            assignments: (r.assignments ?? []).map((a: any) => ({ level: a.level as Level, targetId: a.target_id, exclude: a.exclude })),
        };
    }

    /** What each setting is today, from the screens that existed before policies. A policy overrides these. */
    private async snapshot(organizationId: string): Promise<Snapshot> {
        const hit = PoliciesService.cache.get(organizationId);
        if (hit && Date.now() - hit.at < CACHE_MS) return hit;

        const [policies, alert, hoursRow, clients, software] = await Promise.all([
            this.loadPolicies(organizationId),
            this.prisma.alert_settings.findUnique({ where: { id: 1 } }),
            this.prisma.report_settings.findUnique({ where: { organization_id: organizationId } }),
            this.prisma.clients.findMany({ where: { organization_id: organizationId }, select: { id: true, remote_console_consent: true, record_remote_sessions: true } }),
            this.prisma.software_policies.findMany({ where: { organization_id: organizationId }, select: { client_id: true, kind: true, pattern: true } }),
        ]);
        const consent = new Map(clients.map((c) => [c.id, c.remote_console_consent]));
        const recording = new Map(clients.map((c) => [c.id, c.record_remote_sessions]));
        const hours = hoursRow
            ? { days: hoursRow.business_days?.length ? hoursRow.business_days : [1, 2, 3, 4, 5], start: hoursRow.business_start, end: hoursRow.business_end, timezone: hoursRow.timezone }
            : { days: [1, 2, 3, 4, 5], start: "08:00", end: "18:00", timezone: "UTC" };
        const alerting: Baseline["scalars"] = {
            "alerting.offlineAfterMinutes": { value: alert?.offline_after_minutes ?? 15, label: "Alert settings" },
            "alerting.renotifyAfterHours": { value: alert?.renotify_after_hours ?? 0, label: "Alert settings" },
            "alerting.autoTicket": { value: alert?.auto_ticket ?? false, label: "Alert settings" },
            "alerting.autoTicketMinSeverity": { value: alert?.auto_ticket_min_severity ?? "CRIT", label: "Alert settings" },
            "alerting.autoResolveTicket": { value: alert?.auto_resolve_ticket ?? true, label: "Alert settings" },
            "alerting.holdMinutes": { value: 0, label: "Alert settings" },
            "alerting.reopenWithinMinutes": { value: 0, label: "Alert settings" },
            hours: { value: hours, label: "Business hours" },
            "patching.approve": { value: "none", label: "Manual patching" },
            "patching.installIn": { value: "anytime", label: "Manual patching" },
            "patching.reboot": { value: "never", label: "Manual patching" },
            "patching.appScanHours": { value: 0, label: "No scheduled scan for outdated programs" },
            "patching.appUpdate": { value: "none", label: "Manual program updates" },
            "patching.appUpdateIn": { value: "anytime", label: "Manual program updates" },
            "security.scanHours": { value: 24, label: "Default: a security scan every day" },
            "security.bitlockerEscrow": { value: "off", label: "Default: recovery keys are not stored" },
            "laps.enabled": { value: false, label: "Default: the local administrator password is not managed" },
            "laps.account": { value: "adg-admin", label: "Default account name" },
            "laps.passwordLength": { value: 20, label: "Default password length" },
            "laps.rotateDays": { value: 30, label: "Default: every 30 days" },
            "laps.rotateAfterRevealMinutes": { value: 60, label: "Default: 60 minutes after a reveal" },
        };

        const baseline = (clientId: string | null): Baseline => {
            const lists: Baseline["lists"] = { "software.required": [], "software.banned": [], "checks.profiles": [] };
            for (const s of software) {
                if (s.client_id && s.client_id !== clientId) continue;
                const key = s.kind === "banned" ? "software.banned" : "software.required";
                lists[key]!.push({ item: s.pattern, label: s.client_id ? "Software policies (this customer)" : "Software policies (everyone)" });
            }
            const scalars = { ...alerting };
            const mode = clientId ? consent.get(clientId) : undefined;
            scalars["remote.consent"] = { value: mode === "off" || mode === "consent" ? mode : "notice", label: "Remote access notice" };
            scalars["remote.record"] = { value: (clientId ? recording.get(clientId) : false) === true, label: "Record remote sessions (customer setting)" };
            return { scalars, lists };
        };

        const snap = { at: Date.now(), policies, baseline };
        PoliciesService.cache.set(organizationId, snap);
        return snap;
    }

    private async devices(organizationId: string, ids?: string[]): Promise<DeviceRow[]> {
        const rows = await this.prisma.devices.findMany({
            where: { ...(ids ? { id: { in: ids } } : {}), sites: { clients: { organization_id: organizationId } } },
            select: {
                id: true, hostname: true, alias: true, operating_system: true, site_id: true,
                sites: { select: { name: true, client_id: true, clients: { select: { name: true } } } },
                agents: { select: { facts: true } },
                device_tags: { select: { tag_id: true } },
            },
            take: ids ? undefined : DEVICE_LIMIT,
            orderBy: { hostname: "asc" },
        });
        return rows.map((d) => ({
            deviceId: d.id, hostname: d.alias || d.hostname, siteId: d.site_id, clientId: d.sites?.client_id ?? null, customer: d.sites?.clients?.name ?? null, site: d.sites?.name ?? null,
            os: osFamily(d.operating_system, (d.agents?.facts as any)?.os), organizationId, tagIds: d.device_tags.map((t) => t.tag_id),
        }));
    }

    /* ------------------------------ for the rest of the system ------------------------------ */

    /** What one device gets. Null when the device does not exist. */
    async effectiveForDevice(deviceId: string): Promise<Effective | null> {
        return (await this.effectiveForDevices([deviceId])).get(deviceId) ?? null;
    }

    /** What each of these devices gets. Policies are read once, however many devices there are. */
    async effectiveForDevices(deviceIds: string[], organizationId?: string | null): Promise<Map<string, Effective>> {
        const out = new Map<string, Effective>();
        if (!deviceIds.length) return out;
        const orgId = await this.org(organizationId);
        const [snap, devices] = await Promise.all([this.snapshot(orgId), this.devices(orgId, [...new Set(deviceIds)])]);
        for (const d of devices) out.set(d.deviceId, resolve(d, snap.policies, snap.baseline(d.clientId)));
        // A device that belongs to no customer is answered with the organisation's defaults.
        for (const id of deviceIds) {
            if (!out.has(id)) out.set(id, resolve({ deviceId: id, clientId: null, siteId: null, os: "unknown" }, snap.policies, snap.baseline(null)));
        }
        return out;
    }

    /** What every device in the organisation gets. */
    async effectiveForAll(organizationId?: string | null): Promise<Map<string, Effective>> {
        const orgId = await this.org(organizationId);
        const [snap, devices] = await Promise.all([this.snapshot(orgId), this.devices(orgId)]);
        return new Map(devices.map((d) => [d.deviceId, resolve(d, snap.policies, snap.baseline(d.clientId))] as const));
    }

    /* ------------------------------ reading policies ------------------------------ */

    private view(r: any, extra?: { devices?: number }) {
        const p = this.record(r);
        const flat = flatten(p.sections);
        return {
            id: r.id, name: r.name, description: r.description ?? null, enabled: r.enabled, priority: r.priority, os: p.os, enforced: r.enforced, applyToNewCustomers: r.apply_to_new_customers === true,
            sections: p.sections, version: r.version,
            sectionNames: Object.keys(p.sections),
            settingCount: Object.keys(flat.scalars).length + Object.values(flat.lists).reduce((n, l) => n + (l?.length ?? 0), 0) + flat.waive.length,
            assignments: p.assignments.map((a) => ({ level: a.level, targetId: a.targetId, exclude: a.exclude })),
            createdAt: r.created_at?.toISOString?.() ?? null, updatedAt: r.updated_at?.toISOString?.() ?? null,
            ...(extra?.devices !== undefined ? { devices: extra.devices } : {}),
        };
    }

    private async names(organizationId: string, assignments: Assignment[]) {
        const ids = (level: Level) => [...new Set(assignments.filter((a) => a.level === level && a.targetId).map((a) => a.targetId as string))];
        const [clients, sites, devices, tags] = await Promise.all([
            ids("customer").length ? this.prisma.clients.findMany({ where: { organization_id: organizationId, id: { in: ids("customer") } }, select: { id: true, name: true } }) : [],
            ids("site").length ? this.prisma.sites.findMany({ where: { id: { in: ids("site") }, clients: { organization_id: organizationId } }, select: { id: true, name: true, clients: { select: { name: true } } } }) : [],
            ids("device").length ? this.prisma.devices.findMany({ where: { id: { in: ids("device") } }, select: { id: true, hostname: true, alias: true } }) : [],
            ids("tag").length ? this.prisma.tag_defs.findMany({ where: { organization_id: organizationId, id: { in: ids("tag") } }, select: { id: true, name: true } }) : [],
        ]);
        const map = new Map<string, string>();
        for (const c of clients) map.set(c.id, c.name);
        for (const s of sites) map.set(s.id, `${s.clients?.name ?? "?"} / ${s.name}`);
        for (const d of devices) map.set(d.id, d.alias || d.hostname);
        for (const t of tags) map.set(t.id, t.name);
        return map;
    }

    async list(organizationId?: string | null) {
        const orgId = await this.org(organizationId);
        const rows = await this.prisma.policies.findMany({ where: { organization_id: orgId }, include: { assignments: true }, orderBy: [{ priority: "asc" }, { name: "asc" }] });
        const all = await this.effectiveForAll(orgId);
        const reach = new Map<string, number>();
        for (const e of all.values()) for (const a of e.applied) reach.set(a.policyId, (reach.get(a.policyId) ?? 0) + 1);
        return { items: rows.map((r) => this.view(r, { devices: reach.get(r.id) ?? 0 })) };
    }

    async get(id: string, organizationId?: string | null) {
        const orgId = await this.org(organizationId);
        const row = await this.prisma.policies.findFirst({ where: { id, organization_id: orgId }, include: { assignments: true } });
        if (!row) throw new NotFoundException("That policy does not exist.");
        const names = await this.names(orgId, this.record(row).assignments);
        const v = this.view(row);
        return { ...v, assignments: v.assignments.map((a) => ({ ...a, targetName: a.targetId ? names.get(a.targetId) ?? null : null })) };
    }

    /* ------------------------------ writing policies ------------------------------ */

    private async cleanAssignments(organizationId: string, input: unknown): Promise<Assignment[]> {
        if (!Array.isArray(input)) throw new BadRequestException("Assignments must be a list.");
        if (input.length > MAX_ASSIGNMENTS) throw new BadRequestException(`A policy can have ${MAX_ASSIGNMENTS} assignments at most.`);
        const seen = new Set<string>();
        const out: Assignment[] = [];
        for (const raw of input) {
            const a = (raw ?? {}) as Record<string, unknown>;
            const level = String(a.level ?? "") as Level;
            if (!(LEVELS as readonly string[]).includes(level)) throw new BadRequestException("An assignment needs a level: everyone, customer, site, tag or device.");
            const exclude = a.exclude === true;
            if (level === "global") {
                if (exclude) throw new BadRequestException('"Everyone" cannot be switched off. Remove the assignment instead.');
                if (!seen.has("global")) { seen.add("global"); out.push({ level, targetId: null, exclude: false }); }
                continue;
            }
            const targetId = String(a.targetId ?? "").toLowerCase();
            if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(targetId)) throw new BadRequestException(`Choose which ${level} this applies to.`);
            const key = `${level}:${targetId}:${exclude}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({ level, targetId, exclude });
        }
        // Every target must exist in this organisation.
        const need = (level: Level) => out.filter((a) => a.level === level).map((a) => a.targetId as string);
        const check = async (level: Level, label: string, count: () => Promise<number>) => {
            const ids = [...new Set(need(level))];
            if (ids.length && (await count()) !== ids.length) throw new BadRequestException(`One of the ${label} does not exist.`);
        };
        await check("customer", "customers", () => this.prisma.clients.count({ where: { organization_id: organizationId, id: { in: need("customer") } } }));
        await check("site", "sites", () => this.prisma.sites.count({ where: { clients: { organization_id: organizationId }, id: { in: need("site") } } }));
        await check("tag", "tags", () => this.prisma.tag_defs.count({ where: { organization_id: organizationId, id: { in: need("tag") } } }));
        await check("device", "devices", () => this.prisma.devices.count({ where: { sites: { clients: { organization_id: organizationId } }, id: { in: need("device") } } }));
        return out;
    }

    private async cleanChecks(organizationId: string, sections: Sections) {
        const ids = sections.checks?.profileIds ?? [];
        if (!ids.length) return;
        const found = await this.prisma.check_profiles.count({ where: { organization_id: organizationId, id: { in: ids } } });
        if (found !== ids.length) throw new BadRequestException("One of the check profiles does not exist.");
    }

    private cleanHeader(body: Record<string, unknown>, partial: boolean) {
        const out: { name?: string; description?: string | null; enabled?: boolean; priority?: number; os?: OsChoice; enforced?: boolean; applyToNewCustomers?: boolean } = {};
        if (!partial || "name" in body) {
            const name = String(body.name ?? "").trim().replace(/\s+/g, " ");
            if (!name) throw new BadRequestException("The policy needs a name.");
            if (name.length > 120) throw new BadRequestException("The name is too long (120 characters at most).");
            out.name = name;
        }
        if ("description" in body) {
            const d = String(body.description ?? "").trim();
            if (d.length > 500) throw new BadRequestException("The description is too long (500 characters at most).");
            out.description = d || null;
        }
        if ("enabled" in body) { if (typeof body.enabled !== "boolean") throw new BadRequestException("Enabled must be on or off."); out.enabled = body.enabled; }
        if ("applyToNewCustomers" in body) { if (typeof body.applyToNewCustomers !== "boolean") throw new BadRequestException("Apply to new customers must be on or off."); out.applyToNewCustomers = body.applyToNewCustomers; }
        if ("enforced" in body) { if (typeof body.enforced !== "boolean") throw new BadRequestException("Enforced must be on or off."); out.enforced = body.enforced; }
        if ("priority" in body) {
            const n = Number(body.priority);
            if (!Number.isInteger(n) || n < 1 || n > 1000) throw new BadRequestException("Priority must be a whole number from 1 to 1000.");
            out.priority = n;
        }
        if ("os" in body) {
            if (!(OS_CHOICES as readonly string[]).includes(String(body.os))) throw new BadRequestException("The system must be any, windows, linux or macos.");
            out.os = body.os as OsChoice;
        }
        return out;
    }

    private snap(row: any) {
        return { name: row.name, description: row.description ?? null, enabled: row.enabled, priority: row.priority, os: row.os, enforced: row.enforced, applyToNewCustomers: row.apply_to_new_customers === true, sections: row.sections ?? {}, assignments: (row.assignments ?? []).map((a: any) => ({ level: a.level, targetId: a.target_id, exclude: a.exclude })) };
    }

    private async audit(organizationId: string, policyId: string | null, policyName: string, action: string, actor: Actor, version: number | null, before: unknown, after: unknown) {
        await this.prisma.policy_audit.create({
            data: { organization_id: organizationId, policy_id: policyId, policy_name: policyName, action, actor_id: actor.id, actor_name: actor.name, version, before: (before ?? Prisma.JsonNull) as any, after: (after ?? Prisma.JsonNull) as any },
        });
    }

    async create(body: unknown, actor: Actor, organizationId?: string | null) {
        const orgId = await this.org(organizationId);
        if (!body || typeof body !== "object") throw new BadRequestException("Nothing was sent.");
        const b = body as Record<string, unknown>;
        const header = this.cleanHeader(b, false);
        const sections = cleanSections(b.sections, isValidTimezone);
        await this.cleanChecks(orgId, sections);
        const assignments = b.assignments === undefined ? [] : await this.cleanAssignments(orgId, b.assignments);
        if ((await this.prisma.policies.count({ where: { organization_id: orgId } })) >= MAX_POLICIES) throw new BadRequestException(`There can be ${MAX_POLICIES} policies at most.`);
        await this.assertNameFree(orgId, header.name!);

        try {
            const row = await this.prisma.policies.create({
                data: {
                    organization_id: orgId, name: header.name!, description: header.description ?? null, enabled: header.enabled ?? true, priority: header.priority ?? 100,
                    os: header.os ?? "any", enforced: header.enforced ?? false, apply_to_new_customers: header.applyToNewCustomers ?? false, sections: sections as any, created_by: actor.id,
                    assignments: { create: assignments.map((a) => ({ level: a.level, target_id: a.targetId, exclude: a.exclude })) },
                },
                include: { assignments: true },
            });
            await this.audit(orgId, row.id, row.name, "created", actor, row.version, null, this.snap(row));
            this.forget();
            return this.get(row.id, orgId);
        } catch (e: any) {
            if (e?.code === "P2002") throw new ConflictException("Another policy already has that name.");
            throw e;
        }
    }

    private async assertNameFree(orgId: string, name: string, exceptId?: string) {
        const clash = await this.prisma.$queryRaw<Array<{ id: string }>>`
            SELECT id::text AS id FROM public.policies WHERE organization_id::text = ${orgId} AND lower(name) = lower(${name}) ${exceptId ? Prisma.sql`AND id <> ${exceptId}::uuid` : Prisma.empty} LIMIT 1`;
        if (clash.length) throw new ConflictException("Another policy already has that name.");
    }

    /** Change a policy. Only what is sent changes. `version` is the one the person was looking at. */
    async update(id: string, body: unknown, actor: Actor, organizationId?: string | null) {
        const orgId = await this.org(organizationId);
        if (!body || typeof body !== "object") throw new BadRequestException("Nothing was sent.");
        const b = body as Record<string, unknown>;
        const before = await this.prisma.policies.findFirst({ where: { id, organization_id: orgId }, include: { assignments: true } });
        if (!before) throw new NotFoundException("That policy does not exist.");
        const header = this.cleanHeader(b, true);
        const sections = "sections" in b ? cleanSections(b.sections, isValidTimezone) : undefined;
        if (sections) await this.cleanChecks(orgId, sections);
        const assignments = "assignments" in b ? await this.cleanAssignments(orgId, b.assignments) : undefined;
        if (header.name !== undefined) await this.assertNameFree(orgId, header.name, id);

        const version = b.version === undefined || b.version === null ? undefined : Number(b.version);
        if (version !== undefined && (!Number.isInteger(version) || version < 1)) throw new BadRequestException("The version is not valid. Reload and try again.");

        try {
            const after = await this.prisma.$transaction(async (tx) => {
                const done = await tx.policies.updateMany({
                    where: { id, organization_id: orgId, ...(version !== undefined ? { version } : {}) },
                    data: {
                        ...(header.name !== undefined ? { name: header.name } : {}), ...(header.description !== undefined ? { description: header.description } : {}),
                        ...(header.enabled !== undefined ? { enabled: header.enabled } : {}), ...(header.priority !== undefined ? { priority: header.priority } : {}),
                        ...(header.os !== undefined ? { os: header.os } : {}), ...(header.enforced !== undefined ? { enforced: header.enforced } : {}),
                        ...(header.applyToNewCustomers !== undefined ? { apply_to_new_customers: header.applyToNewCustomers } : {}),
                        ...(sections !== undefined ? { sections: sections as any } : {}), version: { increment: 1 }, updated_at: new Date(),
                    },
                });
                if (done.count === 0) throw new ConflictException("Someone else changed this policy while you were editing. Close it and open it again to see their changes.");
                if (assignments) {
                    await tx.policy_assignments.deleteMany({ where: { policy_id: id } });
                    if (assignments.length) await tx.policy_assignments.createMany({ data: assignments.map((a) => ({ policy_id: id, level: a.level, target_id: a.targetId, exclude: a.exclude })) });
                }
                return tx.policies.findUniqueOrThrow({ where: { id }, include: { assignments: true } });
            });
            const was = this.snap(before);
            const now = this.snap(after);
            const action = was.enabled !== now.enabled && JSON.stringify({ ...was, enabled: 0 }) === JSON.stringify({ ...now, enabled: 0 }) ? (now.enabled ? "enabled" : "disabled") : "updated";
            await this.audit(orgId, id, after.name, action, actor, after.version, was, now);
            this.forget();
            return this.get(id, orgId);
        } catch (e: any) {
            if (e?.code === "P2002") throw new ConflictException("Another policy already has that name.");
            throw e;
        }
    }

    async remove(id: string, actor: Actor, organizationId?: string | null) {
        const orgId = await this.org(organizationId);
        const before = await this.prisma.policies.findFirst({ where: { id, organization_id: orgId }, include: { assignments: true } });
        if (!before) throw new NotFoundException("That policy does not exist.");
        await this.prisma.policies.delete({ where: { id } });
        await this.audit(orgId, id, before.name, "deleted", actor, before.version, this.snap(before), null);
        this.forget();
        return { id, deleted: true };
    }

    /** A copy with a new name, off by default so it changes nothing until looked at. */
    async duplicate(id: string, actor: Actor, organizationId?: string | null) {
        const orgId = await this.org(organizationId);
        const src = await this.prisma.policies.findFirst({ where: { id, organization_id: orgId }, include: { assignments: true } });
        if (!src) throw new NotFoundException("That policy does not exist.");
        let name = `${src.name} (copy)`;
        for (let i = 2; await this.prisma.policies.count({ where: { organization_id: orgId, name } }); i++) name = `${src.name} (copy ${i})`;
        return this.create({ name, description: src.description, enabled: false, priority: src.priority, os: src.os, enforced: src.enforced, applyToNewCustomers: false, sections: src.sections, assignments: src.assignments.map((a) => ({ level: a.level, targetId: a.target_id, exclude: a.exclude })) }, actor, orgId);
    }

    /* ------------------------------ templates ------------------------------ */

    private shapeTemplate(r: any) {
        return {
            id: r.id as string, name: r.name as string, description: (r.description ?? null) as string | null, priority: r.priority as number,
            os: (OS_CHOICES as readonly string[]).includes(r.os) ? (r.os as OsChoice) : "any", enforced: r.enforced === true,
            sections: (r.sections ?? {}) as Sections, sectionNames: Object.keys((r.sections ?? {}) as object), updatedAt: (r.updated_at as Date).toISOString(),
        };
    }

    async listTemplates(organizationId?: string | null) {
        const orgId = await this.org(organizationId);
        const rows = await this.prisma.policy_templates.findMany({ where: { organization_id: orgId }, orderBy: { name: "asc" } });
        return { items: rows.map((r) => this.shapeTemplate(r)) };
    }

    private async assertTemplateNameFree(orgId: string, name: string, exceptId?: string) {
        const clash = await this.prisma.$queryRaw<Array<{ id: string }>>`
            SELECT id::text AS id FROM public.policy_templates WHERE organization_id::text = ${orgId} AND lower(name) = lower(${name}) ${exceptId ? Prisma.sql`AND id <> ${exceptId}::uuid` : Prisma.empty} LIMIT 1`;
        if (clash.length) throw new ConflictException("Another template already has that name.");
    }

    async createTemplate(body: unknown, actor: Actor, organizationId?: string | null) {
        const orgId = await this.org(organizationId);
        if (!body || typeof body !== "object") throw new BadRequestException("Nothing was sent.");
        const b = body as Record<string, unknown>;
        const header = this.cleanHeader(b, false);
        const sections = cleanSections(b.sections, isValidTimezone);
        await this.cleanChecks(orgId, sections);
        if ((await this.prisma.policy_templates.count({ where: { organization_id: orgId } })) >= MAX_POLICIES) throw new BadRequestException(`There can be ${MAX_POLICIES} templates at most.`);
        await this.assertTemplateNameFree(orgId, header.name!);
        try {
            const row = await this.prisma.policy_templates.create({
                data: { organization_id: orgId, name: header.name!, description: header.description ?? null, priority: header.priority ?? 100, os: header.os ?? "any", enforced: header.enforced ?? false, sections: sections as any, created_by: actor.id },
            });
            return this.shapeTemplate(row);
        } catch (e: any) {
            if (e?.code === "P2002") throw new ConflictException("Another template already has that name.");
            throw e;
        }
    }

    async updateTemplate(id: string, body: unknown, organizationId?: string | null) {
        const orgId = await this.org(organizationId);
        if (!body || typeof body !== "object") throw new BadRequestException("Nothing was sent.");
        const b = body as Record<string, unknown>;
        const before = await this.prisma.policy_templates.findFirst({ where: { id, organization_id: orgId } });
        if (!before) throw new NotFoundException("That template does not exist.");
        const header = this.cleanHeader(b, true);
        const sections = "sections" in b ? cleanSections(b.sections, isValidTimezone) : undefined;
        if (sections) await this.cleanChecks(orgId, sections);
        if (header.name !== undefined) await this.assertTemplateNameFree(orgId, header.name, id);
        try {
            const row = await this.prisma.policy_templates.update({
                where: { id },
                data: {
                    ...(header.name !== undefined ? { name: header.name } : {}), ...(header.description !== undefined ? { description: header.description } : {}),
                    ...(header.priority !== undefined ? { priority: header.priority } : {}), ...(header.os !== undefined ? { os: header.os } : {}),
                    ...(header.enforced !== undefined ? { enforced: header.enforced } : {}), ...(sections ? { sections: sections as any } : {}), updated_at: new Date(),
                },
            });
            return this.shapeTemplate(row);
        } catch (e: any) {
            if (e?.code === "P2002") throw new ConflictException("Another template already has that name.");
            throw e;
        }
    }

    async removeTemplate(id: string, organizationId?: string | null) {
        const orgId = await this.org(organizationId);
        const found = await this.prisma.policy_templates.findFirst({ where: { id, organization_id: orgId }, select: { id: true } });
        if (!found) throw new NotFoundException("That template does not exist.");
        await this.prisma.policy_templates.delete({ where: { id } });
        return { id, deleted: true };
    }

    /* ------------------------------ the baseline for new customers ------------------------------ */

    /** Policies marked for every new customer are assigned to a customer the moment it is created. */
    async onCustomerCreated(clientId: string, organizationId: string): Promise<number> {
        const flagged = await this.prisma.policies.findMany({ where: { organization_id: organizationId, apply_to_new_customers: true }, include: { assignments: true } });
        let added = 0;
        for (const p of flagged) {
            if (p.assignments.some((a) => !a.exclude && (a.level === "global" || (a.level === "customer" && a.target_id === clientId)))) continue;
            await this.prisma.policy_assignments.create({ data: { policy_id: p.id, level: "customer", target_id: clientId, exclude: false } });
            await this.prisma.policies.update({ where: { id: p.id }, data: { version: { increment: 1 }, updated_at: new Date() } });
            await this.audit(organizationId, p.id, p.name, "assigned", { id: null, name: "New customer" }, p.version + 1, null, { customer: clientId });
            added++;
        }
        if (added) this.forget();
        return added;
    }

    /** Which customers are missing which baseline policy, and which have switched one off. */
    async baselineStatus(organizationId?: string | null) {
        const orgId = await this.org(organizationId);
        const flagged = await this.prisma.policies.findMany({ where: { organization_id: orgId, apply_to_new_customers: true }, include: { assignments: true }, orderBy: { name: "asc" } });
        const customers = await this.prisma.clients.findMany({ where: { organization_id: orgId, archived_at: null }, select: { id: true, name: true }, orderBy: { name: "asc" } });
        const items = customers.map((c) => {
            const missing: { id: string; name: string }[] = [];
            const off: { id: string; name: string }[] = [];
            for (const p of flagged) {
                if (p.assignments.some((a) => a.exclude && a.level === "customer" && a.target_id === c.id)) { off.push({ id: p.id, name: p.name }); continue; }
                if (!p.assignments.some((a) => !a.exclude && (a.level === "global" || (a.level === "customer" && a.target_id === c.id)))) missing.push({ id: p.id, name: p.name });
            }
            return { customerId: c.id, customer: c.name, missing, switchedOff: off, onBaseline: missing.length === 0 && off.length === 0 };
        });
        return {
            policies: flagged.map((p) => ({ id: p.id, name: p.name, enabled: p.enabled })),
            items,
            customers: customers.length,
            drifted: items.filter((i) => !i.onBaseline).length,
        };
    }

    /** Give every customer that is missing a baseline policy that policy. A customer that switched one off keeps it off. */
    async applyBaseline(actor: Actor, organizationId?: string | null) {
        const orgId = await this.org(organizationId);
        const status = await this.baselineStatus(orgId);
        let added = 0;
        for (const item of status.items) {
            for (const m of item.missing) {
                await this.prisma.policy_assignments.create({ data: { policy_id: m.id, level: "customer", target_id: item.customerId, exclude: false } });
                added++;
            }
        }
        const touched = new Set(status.items.flatMap((i) => i.missing.map((m) => m.id)));
        for (const id of touched) {
            const p = await this.prisma.policies.update({ where: { id }, data: { version: { increment: 1 }, updated_at: new Date() } });
            await this.audit(orgId, id, p.name, "assigned", actor, p.version, null, { baseline: "applied to customers that were missing it" });
        }
        if (added) this.forget();
        return { added, policies: touched.size };
    }

    /* ------------------------------ check profiles ------------------------------ */

    /** Named bundles of checks, so a policy can give a device a whole set at once. */
    async listProfiles(organizationId?: string | null) {
        const orgId = await this.org(organizationId);
        const rows = await this.prisma.check_profiles.findMany({
            where: { organization_id: orgId }, orderBy: { name: "asc" },
            include: { check_profile_members: { select: { check_id: true, checks: { select: { name: true } } } } },
        });
        const policies = await this.loadPolicies(orgId);
        return {
            items: rows.map((r) => ({
                id: r.id, name: r.name, description: r.description ?? null,
                checkIds: r.check_profile_members.map((m) => m.check_id), checkNames: r.check_profile_members.map((m) => m.checks.name).sort(),
                usedBy: policies.filter((p) => p.sections.checks?.profileIds.includes(r.id)).map((p) => p.name),
            })),
        };
    }

    private async cleanProfile(orgId: string, body: unknown, partial: boolean) {
        if (!body || typeof body !== "object") throw new BadRequestException("Nothing was sent.");
        const b = body as Record<string, unknown>;
        const out: { name?: string; description?: string | null; checkIds?: string[] } = {};
        if (!partial || "name" in b) {
            const name = String(b.name ?? "").trim().replace(/\s+/g, " ");
            if (!name) throw new BadRequestException("The profile needs a name.");
            if (name.length > 120) throw new BadRequestException("The name is too long (120 characters at most).");
            out.name = name;
        }
        if ("description" in b) {
            const d = String(b.description ?? "").trim();
            if (d.length > 500) throw new BadRequestException("The description is too long (500 characters at most).");
            out.description = d || null;
        }
        if (!partial || "checkIds" in b) {
            if (!Array.isArray(b.checkIds)) throw new BadRequestException("Choose the checks the profile holds.");
            const ids = [...new Set(b.checkIds.map((x) => String(x ?? "").toLowerCase()))];
            if (ids.length > 200) throw new BadRequestException("A profile can hold 200 checks at most.");
            if (ids.length && (await this.prisma.checks.count({ where: { organization_id: orgId, id: { in: ids } } })) !== ids.length) throw new BadRequestException("One of the checks does not exist.");
            out.checkIds = ids;
        }
        return out;
    }

    private async assertProfileNameFree(orgId: string, name: string, exceptId?: string) {
        const clash = await this.prisma.$queryRaw<Array<{ id: string }>>`
            SELECT id::text AS id FROM public.check_profiles WHERE organization_id::text = ${orgId} AND lower(name) = lower(${name}) ${exceptId ? Prisma.sql`AND id <> ${exceptId}::uuid` : Prisma.empty} LIMIT 1`;
        if (clash.length) throw new ConflictException("Another profile already has that name.");
    }

    async createProfile(body: unknown, actor: Actor, organizationId?: string | null) {
        const orgId = await this.org(organizationId);
        const p = await this.cleanProfile(orgId, body, false);
        await this.assertProfileNameFree(orgId, p.name!);
        try {
            const row = await this.prisma.check_profiles.create({
                data: { organization_id: orgId, name: p.name!, description: p.description ?? null, created_by: actor.id, check_profile_members: { create: (p.checkIds ?? []).map((check_id) => ({ check_id })) } },
            });
            return (await this.listProfiles(orgId)).items.find((i) => i.id === row.id);
        } catch (e: any) {
            if (e?.code === "P2002") throw new ConflictException("Another profile already has that name.");
            throw e;
        }
    }

    async updateProfile(id: string, body: unknown, organizationId?: string | null) {
        const orgId = await this.org(organizationId);
        const existing = await this.prisma.check_profiles.findFirst({ where: { id, organization_id: orgId }, select: { id: true } });
        if (!existing) throw new NotFoundException("That profile does not exist.");
        const p = await this.cleanProfile(orgId, body, true);
        if (p.name !== undefined) await this.assertProfileNameFree(orgId, p.name, id);
        try {
            await this.prisma.$transaction(async (tx) => {
                await tx.check_profiles.update({ where: { id }, data: { ...(p.name !== undefined ? { name: p.name } : {}), ...(p.description !== undefined ? { description: p.description } : {}), updated_at: new Date() } });
                if (p.checkIds) {
                    await tx.check_profile_members.deleteMany({ where: { profile_id: id } });
                    if (p.checkIds.length) await tx.check_profile_members.createMany({ data: p.checkIds.map((check_id) => ({ profile_id: id, check_id })) });
                }
            });
        } catch (e: any) {
            if (e?.code === "P2002") throw new ConflictException("Another profile already has that name.");
            throw e;
        }
        return (await this.listProfiles(orgId)).items.find((i) => i.id === id);
    }

    async removeProfile(id: string, organizationId?: string | null) {
        const orgId = await this.org(organizationId);
        const found = (await this.listProfiles(orgId)).items.find((i) => i.id === id);
        if (!found) throw new NotFoundException("That profile does not exist.");
        if (found.usedBy.length) throw new ConflictException(`This profile is used by ${found.usedBy.join(", ")}. Take it out of the policy first.`);
        await this.prisma.check_profiles.delete({ where: { id } });
        return { id, deleted: true };
    }

    /* ------------------------------ history ------------------------------ */

    async history(policyId: string | null, organizationId?: string | null, limit = 100) {
        const orgId = await this.org(organizationId);
        const rows = await this.prisma.policy_audit.findMany({
            where: { organization_id: orgId, ...(policyId ? { policy_id: policyId } : {}) }, orderBy: { at: "desc" }, take: Math.min(Math.max(limit, 1), 500),
        });
        return {
            items: rows.map((r) => ({
                id: r.id, policyId: r.policy_id, policy: r.policy_name, action: r.action, by: r.actor_name, version: r.version, at: r.at.toISOString(),
                changes: this.describeChange(r.before as any, r.after as any),
            })),
        };
    }

    /** What changed, in words, from the two snapshots. */
    private describeChange(before: any, after: any): string[] {
        if (!before && after) return ["Created"];
        if (before && !after) return ["Deleted"];
        if (!before || !after) return [];
        const out: string[] = [];
        for (const k of ["name", "description", "enabled", "priority", "os", "enforced", "applyToNewCustomers"]) if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) out.push(`${k}: ${JSON.stringify(before[k])} to ${JSON.stringify(after[k])}`);
        const sb = before.sections ?? {};
        const sa = after.sections ?? {};
        for (const k of new Set([...Object.keys(sb), ...Object.keys(sa)])) if (JSON.stringify(sb[k]) !== JSON.stringify(sa[k])) out.push(`${k} settings changed`);
        const ab = (before.assignments ?? []).length;
        const aa = (after.assignments ?? []).length;
        if (JSON.stringify(before.assignments) !== JSON.stringify(after.assignments)) out.push(`assignments ${ab} to ${aa}`);
        return out;
    }

    /** Put a policy back as it was after one of its recorded changes, or bring back a deleted one. */
    async restore(auditId: string, actor: Actor, organizationId?: string | null) {
        const orgId = await this.org(organizationId);
        const entry = await this.prisma.policy_audit.findFirst({ where: { id: auditId, organization_id: orgId } });
        if (!entry) throw new NotFoundException("That change does not exist.");
        const target = (entry.action === "deleted" ? entry.before : entry.after) as any;
        if (!target) throw new BadRequestException("There is nothing to restore from that entry.");
        const existing = entry.policy_id ? await this.prisma.policies.findFirst({ where: { id: entry.policy_id, organization_id: orgId } }) : null;
        const body = { name: target.name, description: target.description, enabled: target.enabled, priority: target.priority, os: target.os, enforced: target.enforced, applyToNewCustomers: target.applyToNewCustomers === true, sections: target.sections, assignments: (target.assignments ?? []).filter((a: any) => a.level === "global" || a.targetId) };
        const result = existing ? await this.update(existing.id, body, actor, orgId) : await this.create(body, actor, orgId);
        await this.audit(orgId, result.id, result.name, "restored", actor, result.version, null, { fromChange: auditId });
        return result;
    }

    /* ------------------------------ seeing the effect ------------------------------ */

    private async canSee(scope: AccessScope, deviceId: string): Promise<boolean> {
        return !!(await this.prisma.devices.findFirst({ where: { id: deviceId, ...deviceWhereOf(scope) }, select: { id: true } }));
    }

    /** What a device gets, in rows a screen can show, with the reason for every one. */
    async explainDevice(deviceId: string, organizationId?: string | null, scope: AccessScope | null = null) {
        const orgId = await this.org(organizationId);
        const [d] = await this.devices(orgId, [deviceId]);
        if (!d || (scope && !(await this.canSee(scope, deviceId)))) throw new NotFoundException("That device does not exist.");
        const snap = await this.snapshot(orgId);
        const e = resolve(d, snap.policies, snap.baseline(d.clientId));
        const actions = await this.prisma.policy_actions.findMany({ where: { organization_id: orgId, device_id: deviceId }, orderBy: { created_at: "desc" }, take: 20 });
        return {
            device: { id: d.deviceId, name: d.hostname, customer: d.customer, site: d.site, os: d.os },
            rows: explain(e), applied: e.applied, skipped: e.skipped, removed: e.removed, hash: e.hash,
            maintenance: this.maintenanceOf(e),
            actions: actions.map((a) => ({ id: a.id, kind: a.kind, policy: a.policy_name, detail: a.detail, at: a.created_at.toISOString() })),
        };
    }

    /** The maintenance windows a device has, whether one is open now, and when the next opens. */
    maintenanceOf(e: Effective, now = Date.now()) {
        const m = e.scalars.maintenance?.value as { windows: { name: string; days: number[]; start: string; end: string; timezone: string }[]; muteAlerts: boolean } | undefined;
        if (!m) return null;
        const open = activeWindow(m.windows, now);
        const next = open ? null : nextWindowStart(m.windows, now);
        return {
            windows: m.windows, muteAlerts: m.muteAlerts, source: e.scalars.maintenance!.source,
            activeNow: open?.name ?? null, next: next ? { name: next.window.name, at: new Date(next.at).toISOString() } : null,
        };
    }

    /** The devices a policy reaches, and what it does on each. */
    async devicesOf(id: string, organizationId?: string | null) {
        const orgId = await this.org(organizationId);
        const policy = await this.prisma.policies.findFirst({ where: { id, organization_id: orgId }, include: { assignments: true } });
        if (!policy) throw new NotFoundException("That policy does not exist.");
        const snap = await this.snapshot(orgId);
        const record = this.record(policy);
        const own = flatten(record.sections);
        const ownScalars = Object.keys(own.scalars);
        const items: { deviceId: string; device: string; customer: string | null; site: string | null; status: "applied" | "skipped"; reason: string | null; winning: number; overridden: number }[] = [];
        for (const d of await this.devices(orgId)) {
            const { applied, skipped } = applicablePolicies(d, snap.policies);
            const skip = skipped.find((s) => s.policyId === id);
            if (skip) { items.push({ deviceId: d.deviceId, device: d.hostname, customer: d.customer, site: d.site, status: "skipped", reason: skip.reason, winning: 0, overridden: 0 }); continue; }
            if (!applied.some((a) => a.policy.id === id)) continue;
            const e = resolve(d, snap.policies, snap.baseline(d.clientId));
            let winning = 0;
            for (const k of ownScalars) if (e.scalars[k as keyof typeof e.scalars]?.source.kind === "policy" && (e.scalars[k as keyof typeof e.scalars]!.source as any).policyId === id) winning++;
            for (const k of LIST_KEYS) for (const h of e.lists[k]) if (h.source.kind === "policy" && h.source.policyId === id) winning++;
            const total = ownScalars.length + Object.entries(own.lists).reduce((n, [, l]) => n + (l?.length ?? 0), 0);
            items.push({ deviceId: d.deviceId, device: d.hostname, customer: d.customer, site: d.site, status: "applied", reason: null, winning, overridden: Math.max(total - winning, 0) });
        }
        return { items: items.slice(0, 1000), total: items.length, applied: items.filter((i) => i.status === "applied").length, skipped: items.filter((i) => i.status === "skipped").length, truncated: items.length > 1000 };
    }

    /** The effect of a change before it is saved: which devices would get something different. */
    async preview(body: unknown, organizationId?: string | null) {
        const orgId = await this.org(organizationId);
        if (!body || typeof body !== "object") throw new BadRequestException("Nothing was sent.");
        const b = body as Record<string, unknown>;
        const existingId = typeof b.id === "string" ? b.id : null;
        const current = existingId ? await this.prisma.policies.findFirst({ where: { id: existingId, organization_id: orgId }, include: { assignments: true } }) : null;
        if (existingId && !current) throw new NotFoundException("That policy does not exist.");

        const header = this.cleanHeader({ name: current?.name ?? "Draft", ...b }, false);
        const sections = "sections" in b ? cleanSections(b.sections, isValidTimezone) : ((current?.sections ?? {}) as Sections);
        await this.cleanChecks(orgId, sections);
        const assignments = "assignments" in b ? await this.cleanAssignments(orgId, b.assignments) : current ? this.record(current).assignments : [];
        const draft: PolicyRecord = {
            id: current?.id ?? "00000000-0000-4000-8000-00000000d0af", name: header.name ?? current?.name ?? "Draft", enabled: header.enabled ?? current?.enabled ?? true,
            priority: header.priority ?? current?.priority ?? 100, os: header.os ?? ((current?.os as OsChoice) ?? "any"), enforced: header.enforced ?? current?.enforced ?? false, sections, assignments,
        };

        const snap = await this.snapshot(orgId);
        const after = snap.policies.filter((p) => p.id !== draft.id).concat(draft);
        const changed: { deviceId: string; device: string; customer: string | null; site: string | null; changes: ReturnType<typeof diffEffective> }[] = [];
        let reached = 0;
        const devices = await this.devices(orgId);
        for (const d of devices) {
            const baseline = snap.baseline(d.clientId);
            const was = resolve(d, snap.policies, baseline);
            const now = resolve(d, after, baseline);
            if (now.applied.some((a) => a.policyId === draft.id)) reached++;
            const changes = diffEffective(was, now);
            if (changes.length) changed.push({ deviceId: d.deviceId, device: d.hostname, customer: d.customer, site: d.site, changes });
        }
        const customers = new Set(changed.map((c) => c.customer).filter(Boolean));
        return { devicesChecked: devices.length, devicesReached: reached, devicesChanged: changed.length, customersChanged: customers.size, items: changed.slice(0, 100), truncated: changed.length > 100 };
    }
}

