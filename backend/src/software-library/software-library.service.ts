// The software library: the catalog policies pick software from, and the installer details used to put it on endpoints.
//
// Installs are ordinary signed agent tasks (type software_install). The agent picks them up within about ten seconds.
// Everything here is limited by the same customer / site / tag scope as the rest of the device routes.
import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../storage/prisma.service";
import { OrganizationContextService } from "../storage/organization-context.service";
import { AccessScope, ClientAccessService, deviceSqlOf, deviceWhereOf } from "../reports/client-access.service";
import { SOFTWARE_CATEGORIES, STARTER_CATALOG } from "./starter-catalog";

/** Agents older than this do not know the software_install task. */
export const INSTALL_MIN_VERSION = "1.3.31";
/** Removing a program for one user needs an agent that knows how. */
export const RUN_AS_UNINSTALL_MIN_VERSION = "1.3.33";

const WINGET_ID_RE = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,99}$/;
const ACCOUNT_RE = /^[^\u0000-\u001f\\/]{1,100}\\[^\u0000-\u001f\\/]{1,100}$/;
const ONLINE_WITHIN_MS = 5 * 60_000;
const MAX_PREVIEW_DEVICES = 500;
/** Fix now plans a program for this many devices (in batches of MAX_PREVIEW_DEVICES); more are reported as not planned. */
const MAX_FIX_DEVICES = 2000;
const MAX_INSTALL_DEVICES = 200;
const DUPLICATE_WINDOW_MS = 10 * 60_000;
const MAX_LIBRARY = 2000;

const CHOCO_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const WINGET_ID = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,99}$/;
const LINUX_PKG = /^[a-z0-9][a-z0-9+.-]{0,99}$/;
const SHA256 = /^[0-9a-fA-F]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function versionAtLeast(have: string, need: string): boolean {
    const a = String(have).split(/[.+-]/).map((p) => parseInt(p, 10) || 0);
    const b = need.split(".").map((p) => parseInt(p, 10) || 0);
    for (let i = 0; i < Math.max(a.length, b.length, 3); i++) {
        const x = a[i] ?? 0, y = b[i] ?? 0;
        if (x !== y) return x > y;
    }
    return true;
}

export type LibraryEntry = {
    id: string; name: string; category: string; matchText: string; publisher: string | null;
    chocolateyId: string | null; chocolateyParams: string | null; chocolateyInstallArgs: string | null; wingetId: string | null; installerUrl: string | null; installerSha256: string | null;
    installerKind: "exe" | "msi" | null; silentArgs: string | null; linuxPackage: string | null; notes: string | null;
    builtIn: boolean; installable: boolean; devices: number;
};

export type InstallAction = "install" | "uninstall";
export type DeviceTargets = { deviceIds?: unknown; clientIds?: unknown; siteIds?: unknown; tagIds?: unknown };
type Why = { deviceId: string; device: string; customer: string; site: string; reason: string };
type Eligible = { deviceId: string; device: string; customer: string; site: string; hasIt: boolean; agentId: string };

const text = (v: unknown, max: number, label: string, required = false): string | null => {
    const s = String(v ?? "").trim();
    if (!s) { if (required) throw new BadRequestException(`${label} is required.`); return null; }
    if (s.length > max) throw new BadRequestException(`${label} is too long (${max} characters at most).`);
    if (/[\u0000-\u001f]/.test(s)) throw new BadRequestException(`${label} has characters that are not allowed.`);
    return s;
};

const idList = (v: unknown, label: string): string[] => {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) throw new BadRequestException(`${label} must be a list.`);
    const out = [...new Set(v.map((x) => String(x ?? "").trim()).filter(Boolean))];
    if (out.some((x) => !UUID.test(x))) throw new BadRequestException(`${label} has an id that is not valid.`);
    return out;
};

@Injectable()
export class SoftwareLibraryService {
    constructor(private readonly prisma: PrismaService, private readonly orgs: OrganizationContextService, private readonly access: ClientAccessService) { }

    private async org(organizationId?: string | null) {
        return organizationId || (await this.orgs.getDefaultOrganizationId());
    }

    /* ------------------------------ the entries ------------------------------ */

    /** The first time an organisation opens its library it is filled with the starter set. */
    private async seedIfEmpty(orgId: string) {
        if (await this.prisma.software_library.count({ where: { organization_id: orgId } })) return;
        await this.prisma.software_library.createMany({
            data: STARTER_CATALOG.map((e) => ({
                organization_id: orgId, name: e.name, category: e.category, match_text: e.match, publisher: e.publisher ?? null,
                chocolatey_id: e.choco ?? null, chocolatey_install_args: e.chocoInstallArgs ?? null, winget_id: e.winget ?? null, linux_package: e.linux ?? null, notes: e.notes ?? null, built_in: true,
            })),
            skipDuplicates: true,
        });
    }

    private shape(r: any, devices = 0): LibraryEntry {
        const kind = r.installer_kind === "msi" || r.installer_kind === "exe" ? r.installer_kind : null;
        return {
            id: r.id, name: r.name, category: r.category, matchText: r.match_text, publisher: r.publisher ?? null,
            chocolateyId: r.chocolatey_id ?? null, chocolateyParams: r.chocolatey_params ?? null, chocolateyInstallArgs: r.chocolatey_install_args ?? null, wingetId: r.winget_id ?? null, installerUrl: r.installer_url ?? null, installerSha256: r.installer_sha256 ?? null,
            installerKind: kind, silentArgs: r.silent_args ?? null, linuxPackage: r.linux_package ?? null, notes: r.notes ?? null,
            builtIn: r.built_in === true, installable: !!r.chocolatey_id || (!!r.installer_url && !!r.installer_sha256), devices,
        };
    }

    /** How many endpoints report a program matching each entry, inside what the person may see. */
    private async deviceCounts(orgId: string, scope: AccessScope | null): Promise<Map<string, number>> {
        const limit = scope ? Prisma.sql`AND ${deviceSqlOf(scope, { client: Prisma.sql`c.id::text`, site: Prisma.sql`d.site_id::text`, id: Prisma.sql`d.id::text` })}` : Prisma.empty;
        const rows = await this.prisma.$queryRaw<Array<{ id: string; n: number }>>`
            SELECT l.id::text AS id, count(DISTINCT s.agent_id)::int AS n
              FROM public.software_library l
              JOIN public.agent_software s ON position(lower(l.match_text) in lower(s.name)) > 0
              JOIN public.agents a ON a.id = s.agent_id
              JOIN public.devices d ON d.id = a.device_id
              JOIN public.sites st ON st.id = d.site_id
              JOIN public.clients c ON c.id = st.client_id
             WHERE l.organization_id::text = ${orgId} AND c.organization_id::text = ${orgId} ${limit}
             GROUP BY l.id`;
        return new Map(rows.map((r) => [r.id, Number(r.n)]));
    }

    async list(organizationId: string | null | undefined, userId: string | null, q?: string, category?: string) {
        const orgId = await this.org(organizationId);
        await this.seedIfEmpty(orgId);
        const scope = await this.access.scopeFor(userId);
        const term = (q ?? "").trim();
        const where: Prisma.software_libraryWhereInput = {
            organization_id: orgId,
            ...(category ? { category } : {}),
            ...(term ? { OR: [{ name: { contains: term, mode: "insensitive" } }, { match_text: { contains: term, mode: "insensitive" } }, { publisher: { contains: term, mode: "insensitive" } }] } : {}),
        };
        const [rows, counts, cats] = await Promise.all([
            this.prisma.software_library.findMany({ where, orderBy: [{ category: "asc" }, { name: "asc" }] }),
            this.deviceCounts(orgId, scope),
            this.prisma.software_library.findMany({ where: { organization_id: orgId }, distinct: ["category"], select: { category: true } }),
        ]);
        const categories = [...new Set([...SOFTWARE_CATEGORIES, ...cats.map((c) => c.category)])].filter((c) => cats.some((x) => x.category === c));
        return { items: rows.map((r) => this.shape(r, counts.get(r.id) ?? 0)), categories };
    }

    private clean(body: unknown, partial: boolean) {
        if (!body || typeof body !== "object") throw new BadRequestException("Nothing was sent.");
        const b = body as Record<string, unknown>;
        const has = (k: string) => !partial || k in b;
        const out: Record<string, unknown> = {};

        if (has("name")) out.name = text(b.name, 120, "The name", true);
        if (has("matchText")) out.match_text = text(b.matchText, 120, "The match text", true);
        if (has("category")) {
            const c = text(b.category, 40, "The category") ?? "Other";
            out.category = (SOFTWARE_CATEGORIES as readonly string[]).includes(c) ? c : c;
        }
        if (has("publisher")) out.publisher = text(b.publisher, 120, "The publisher");
        if (has("notes")) out.notes = text(b.notes, 500, "The notes");
        if (has("chocolateyId")) {
            const v = text(b.chocolateyId, 100, "The Chocolatey id");
            if (v && !CHOCO_ID.test(v)) throw new BadRequestException("The Chocolatey id may only hold letters, digits, dots, dashes and underscores.");
            out.chocolatey_id = v;
        }
        if (has("chocolateyParams")) out.chocolatey_params = text(b.chocolateyParams, 200, "The Chocolatey parameters");
        if (has("chocolateyInstallArgs")) out.chocolatey_install_args = text(b.chocolateyInstallArgs, 200, "The Chocolatey installer arguments");
        if (has("wingetId")) {
            const v = text(b.wingetId, 100, "The winget id");
            if (v && !WINGET_ID.test(v)) throw new BadRequestException("The winget id is not valid.");
            out.winget_id = v;
        }
        if (has("linuxPackage")) {
            const v = text(b.linuxPackage, 100, "The Linux package");
            if (v && !LINUX_PKG.test(v)) throw new BadRequestException("The Linux package name is not valid.");
            out.linux_package = v;
        }
        if (has("silentArgs")) out.silent_args = text(b.silentArgs, 200, "The silent arguments");
        if (has("installerKind")) {
            const v = text(b.installerKind, 10, "The installer kind");
            if (v && v !== "exe" && v !== "msi") throw new BadRequestException("The installer kind must be exe or msi.");
            out.installer_kind = v;
        }
        if (has("installerUrl")) {
            const v = text(b.installerUrl, 500, "The installer address");
            if (v) {
                let u: URL;
                try { u = new URL(v); } catch { throw new BadRequestException("The installer address is not a valid web address."); }
                if (u.protocol !== "https:") throw new BadRequestException("The installer address must start with https://.");
                if (u.username || u.password) throw new BadRequestException("The installer address must not hold a user name or password.");
            }
            out.installer_url = v;
        }
        if (has("installerSha256")) {
            const v = text(b.installerSha256, 64, "The installer hash");
            if (v && !SHA256.test(v)) throw new BadRequestException("The installer hash must be 64 hexadecimal characters (SHA-256).");
            out.installer_sha256 = v ? v.toLowerCase() : null;
        }
        return out;
    }

    /** Rules that need the whole entry: a direct installer has to come with its hash, and a kind. */
    private checkWhole(e: { installer_url?: unknown; installer_sha256?: unknown; installer_kind?: unknown }) {
        if (e.installer_url && !e.installer_sha256) throw new BadRequestException("An installer address needs its SHA-256 hash, so a changed file is never run.");
        if (e.installer_sha256 && !e.installer_url) throw new BadRequestException("A hash without an installer address does nothing. Add the address or clear the hash.");
        if (e.installer_url && !e.installer_kind) {
            const path = new URL(String(e.installer_url)).pathname.toLowerCase();
            if (!path.endsWith(".msi") && !path.endsWith(".exe")) throw new BadRequestException("Say whether the installer is an exe or an msi.");
        }
    }

    async create(body: unknown, userId: string | null, organizationId?: string | null) {
        const orgId = await this.org(organizationId);
        const data = this.clean(body, false);
        if (data.installer_url && !data.installer_kind) data.installer_kind = String(data.installer_url).toLowerCase().split("?")[0].endsWith(".msi") ? "msi" : "exe";
        this.checkWhole(data as any);
        if ((await this.prisma.software_library.count({ where: { organization_id: orgId } })) >= MAX_LIBRARY) throw new BadRequestException(`The library can hold ${MAX_LIBRARY} entries at most.`);
        const clash = await this.prisma.$queryRaw<Array<{ id: string }>>`SELECT id::text AS id FROM public.software_library WHERE organization_id::text = ${orgId} AND lower(name) = lower(${String(data.name)}) LIMIT 1`;
        if (clash.length) throw new ConflictException("Another entry already has that name.");
        try {
            const row = await this.prisma.software_library.create({ data: { organization_id: orgId, created_by: userId, ...(data as any) } });
            return this.shape(row);
        } catch (e: any) {
            if (e?.code === "P2002") throw new ConflictException("Another entry already has that name.");
            throw e;
        }
    }

    async update(id: string, body: unknown, organizationId?: string | null) {
        const orgId = await this.org(organizationId);
        const before = await this.prisma.software_library.findFirst({ where: { id, organization_id: orgId } });
        if (!before) throw new NotFoundException("That entry does not exist.");
        const data = this.clean(body, true);
        const merged: any = { ...before, ...data };
        if (merged.installer_url && !merged.installer_kind) {
            merged.installer_kind = String(merged.installer_url).toLowerCase().split("?")[0].endsWith(".msi") ? "msi" : "exe";
            data.installer_kind = merged.installer_kind;
        }
        this.checkWhole(merged);
        if (data.name !== undefined) {
            const clash = await this.prisma.$queryRaw<Array<{ id: string }>>`SELECT id::text AS id FROM public.software_library WHERE organization_id::text = ${orgId} AND lower(name) = lower(${String(data.name)}) AND id <> ${id}::uuid LIMIT 1`;
            if (clash.length) throw new ConflictException("Another entry already has that name.");
        }
        try {
            const row = await this.prisma.software_library.update({ where: { id }, data: { ...(data as any), updated_at: new Date() } });
            return this.shape(row);
        } catch (e: any) {
            if (e?.code === "P2002") throw new ConflictException("Another entry already has that name.");
            throw e;
        }
    }

    async remove(id: string, organizationId?: string | null) {
        const orgId = await this.org(organizationId);
        const found = await this.prisma.software_library.findFirst({ where: { id, organization_id: orgId }, select: { id: true } });
        if (!found) throw new NotFoundException("That entry does not exist.");
        await this.prisma.software_library.delete({ where: { id } });
        return { id, deleted: true };
    }

    /** Program names found on endpoints that no library entry covers, most common first. */
    async seen(organizationId: string | null | undefined, userId: string | null, q?: string, clientId?: string) {
        const orgId = await this.org(organizationId);
        const scope = await this.access.scopeFor(userId);
        const term = (q ?? "").trim().slice(0, 100);
        if (clientId && !UUID.test(clientId)) throw new BadRequestException("That customer is not valid.");
        const limit = scope ? Prisma.sql`AND ${deviceSqlOf(scope, { client: Prisma.sql`c.id::text`, site: Prisma.sql`d.site_id::text`, id: Prisma.sql`d.id::text` })}` : Prisma.empty;
        const like = `%${term.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
        const rows = await this.prisma.$queryRaw<Array<{ name: string; publisher: string | null; n: number }>>`
            SELECT s.name, max(s.publisher) AS publisher, count(DISTINCT s.agent_id)::int AS n
              FROM public.agent_software s
              JOIN public.agents a ON a.id = s.agent_id
              JOIN public.devices d ON d.id = a.device_id
              JOIN public.sites st ON st.id = d.site_id
              JOIN public.clients c ON c.id = st.client_id
             WHERE c.organization_id::text = ${orgId} ${limit}
               ${clientId ? Prisma.sql`AND c.id = ${clientId}::uuid` : Prisma.empty}
               ${term ? Prisma.sql`AND s.name ILIKE ${like} ESCAPE '\\'` : Prisma.empty}
               AND NOT EXISTS (SELECT 1 FROM public.software_library l WHERE l.organization_id::text = ${orgId} AND position(lower(l.match_text) in lower(s.name)) > 0)
             GROUP BY s.name
             ORDER BY n DESC, lower(s.name) ASC
             LIMIT 200`;
        return { items: rows.map((r) => ({ name: r.name, publisher: r.publisher ?? null, devices: Number(r.n) })) };
    }

    /* ------------------------------ installs ------------------------------ */

    private async entry(id: string, orgId: string) {
        const row = await this.prisma.software_library.findFirst({ where: { id, organization_id: orgId } });
        if (!row) throw new NotFoundException("That entry does not exist.");
        return row;
    }

    private action(v: unknown): InstallAction {
        if (v !== "install" && v !== "uninstall") throw new BadRequestException("The action must be install or uninstall.");
        return v;
    }

    /** What the agent is told. Chocolatey when the entry has an id; otherwise a direct installer, which has no uninstall. */
    private payloadFor(entry: any, action: InstallAction, runAs?: string | null) {
        if (runAs) {
            const user = { user: runAs };
            if (action === "uninstall") {
                if (entry.winget_id && WINGET_ID_RE.test(entry.winget_id)) {
                    return { action, name: entry.name, matchText: entry.match_text, method: "winget" as const, wingetId: entry.winget_id, runAs: user };
                }
                throw new ConflictException(`Removing ${entry.name} for one user needs a winget id on its library entry.`);
            }
            if (entry.winget_id && WINGET_ID_RE.test(entry.winget_id)) {
                return { action, name: entry.name, matchText: entry.match_text, method: "winget" as const, wingetId: entry.winget_id, runAs: user };
            }
            if (entry.installer_url && entry.installer_sha256) {
                return {
                    action, name: entry.name, matchText: entry.match_text, method: "direct" as const,
                    installerUrl: entry.installer_url, installerSha256: entry.installer_sha256, installerKind: entry.installer_kind === "msi" ? "msi" : "exe",
                    ...(entry.silent_args ? { silentArgs: entry.silent_args } : {}), runAs: user,
                };
            }
            throw new ConflictException(`${entry.name} cannot be installed for one user: its library entry needs a winget id or a direct installer with a hash. Chocolatey installs for everyone.`);
        }
        if (entry.chocolatey_id) {
            return {
                action, name: entry.name, matchText: entry.match_text, method: "chocolatey" as const, chocolateyId: entry.chocolatey_id,
                ...(action === "install" && entry.chocolatey_params ? { chocolateyParams: entry.chocolatey_params } : {}),
                ...(action === "install" && entry.chocolatey_install_args ? { chocolateyInstallArgs: entry.chocolatey_install_args } : {}),
            };
        }
        if (action === "uninstall") throw new ConflictException(`Removing ${entry.name} needs a Chocolatey id on its library entry. Add one, or remove it on the device.`);
        if (!entry.installer_url || !entry.installer_sha256) throw new ConflictException(`${entry.name} cannot be installed from here: its library entry has no Chocolatey id and no installer with a hash.`);
        return {
            action, name: entry.name, matchText: entry.match_text, method: "direct" as const,
            installerUrl: entry.installer_url, installerSha256: entry.installer_sha256, installerKind: entry.installer_kind === "msi" ? "msi" : "exe",
            ...(entry.silent_args ? { silentArgs: entry.silent_args } : {}),
        };
    }

    private deviceName(d: any) {
        return String(d.alias || d.hostname || d.id);
    }

    /** Works out, for a set of devices, who can have the action run now and who is skipped and why. */
    private async evaluate(orgId: string, userId: string | null, entry: any, action: InstallAction, ids: { deviceIds: string[]; clientIds: string[]; siteIds: string[]; tagIds: string[] }, cap: number, force = false, minVersion: string = INSTALL_MIN_VERSION) {
        const scope = await this.access.scopeFor(userId);
        const picks: Prisma.devicesWhereInput[] = [
            ...(ids.deviceIds.length ? [{ id: { in: ids.deviceIds } }] : []),
            ...(ids.clientIds.length ? [{ sites: { client_id: { in: ids.clientIds } } }] : []),
            ...(ids.siteIds.length ? [{ site_id: { in: ids.siteIds } }] : []),
            ...(ids.tagIds.length ? [{ device_tags: { some: { tag_id: { in: ids.tagIds } } } }] : []),
        ];
        if (!picks.length) throw new BadRequestException("Choose at least one device, site, customer or tag.");
        const devices = await this.prisma.devices.findMany({
            where: { AND: [{ sites: { clients: { organization_id: orgId } } }, ...(scope ? [deviceWhereOf(scope)] : []), { OR: picks }] },
            select: { id: true, alias: true, hostname: true, sites: { select: { name: true, clients: { select: { name: true } } } } },
            take: cap + 1,
            orderBy: { hostname: "asc" },
        });
        const truncated = devices.length > cap;
        const list = devices.slice(0, cap);
        const agents = list.length ? await this.prisma.agents.findMany({ where: { device_id: { in: list.map((d) => d.id) } }, select: { id: true, device_id: true, version: true, facts: true, last_check_in_at: true } }) : [];
        const byDevice = new Map(agents.map((a) => [a.device_id, a]));
        const have = new Set<string>();
        if (agents.length) {
            const rows = await this.prisma.$queryRaw<Array<{ agent_id: string }>>`
                SELECT DISTINCT s.agent_id::text AS agent_id FROM public.agent_software s
                 WHERE s.agent_id = ANY(${agents.map((a) => a.id)}::uuid[]) AND position(lower(${entry.match_text}) in lower(s.name)) > 0`;
            rows.forEach((r) => have.add(r.agent_id));
        }
        const busy = new Set<string>();
        if (agents.length) {
            const recent = await this.prisma.agent_tasks.findMany({
                where: { agent_id: { in: agents.map((a) => a.id) }, type: "software_install", status: { in: ["pending", "queued", "running"] }, created_at: { gte: new Date(Date.now() - DUPLICATE_WINDOW_MS) } },
                select: { agent_id: true, payload: true },
            });
            for (const t of recent) { const p: any = t.payload; if (p?.matchText === entry.match_text && p?.action === action) busy.add(t.agent_id); }
        }

        const eligible: Eligible[] = [];
        const skipped: Why[] = [];
        for (const d of list) {
            const base = { deviceId: d.id, device: this.deviceName(d), customer: d.sites?.clients?.name ?? "", site: d.sites?.name ?? "" };
            const a = byDevice.get(d.id);
            const skip = (reason: string) => skipped.push({ ...base, reason });
            if (!a) { skip("It has no agent."); continue; }
            if (String((a.facts as any)?.os ?? "").toLowerCase() !== "windows") { skip("Installing software from here only works on Windows devices for now."); continue; }
            if (!versionAtLeast(a.version, minVersion)) { skip(`Its agent is ${a.version}; this needs ${minVersion} or newer.`); continue; }
            if (!a.last_check_in_at || Date.now() - a.last_check_in_at.getTime() > ONLINE_WITHIN_MS) { skip("It is offline right now."); continue; }
            const hasIt = have.has(a.id);
            if (action === "install" && hasIt) { skip("It already has it."); continue; }
            // "Remove anyway" is for programs the inventory cannot see, such as one that went into the system account's own profile.
            if (action === "uninstall" && !hasIt && !force) { skip("It does not have it."); continue; }
            if (busy.has(a.id)) { skip("The same request is already waiting for this device."); continue; }
            eligible.push({ ...base, hasIt, agentId: a.id });
        }
        return { eligible, skipped, truncated };
    }

    private parseTargets(t: DeviceTargets) {
        return { deviceIds: idList(t.deviceIds, "deviceIds"), clientIds: idList(t.clientIds, "clientIds"), siteIds: idList(t.siteIds, "siteIds"), tagIds: idList(t.tagIds, "tagIds") };
    }

    async preview(libraryId: string, body: unknown, userId: string | null, organizationId?: string | null) {
        const orgId = await this.org(organizationId);
        if (!body || typeof body !== "object") throw new BadRequestException("Nothing was sent.");
        const b = body as Record<string, unknown>;
        const action = this.action(b.action);
        const entry = await this.entry(libraryId, orgId);
        this.payloadFor(entry, action); // says why this entry cannot do the action at all
        const r = await this.evaluate(orgId, userId, entry, action, this.parseTargets(b as DeviceTargets), MAX_PREVIEW_DEVICES, b.force === true);
        return {
            eligible: r.eligible.map(({ agentId, ...rest }) => rest),
            skipped: r.skipped,
            total: r.eligible.length + r.skipped.length,
            truncated: r.truncated,
        };
    }

    async queue(libraryId: string, body: unknown, userId: string | null, organizationId?: string | null) {
        const orgId = await this.org(organizationId);
        if (!body || typeof body !== "object") throw new BadRequestException("Nothing was sent.");
        const b = body as Record<string, unknown>;
        const action = this.action(b.action);
        const deviceIds = idList(b.deviceIds, "deviceIds");
        if (!deviceIds.length) throw new BadRequestException("Choose at least one device.");
        if (deviceIds.length > MAX_INSTALL_DEVICES) throw new BadRequestException(`Install on ${MAX_INSTALL_DEVICES} devices at most at a time.`);
        const entry = await this.entry(libraryId, orgId);
        const payload = this.payloadFor(entry, action);
        const r = await this.evaluate(orgId, userId, entry, action, { deviceIds, clientIds: [], siteIds: [], tagIds: [] }, MAX_INSTALL_DEVICES, b.force === true);
        const now = new Date();
        if (r.eligible.length) {
            await this.prisma.agent_tasks.createMany({
                data: r.eligible.map((e) => ({ agent_id: e.agentId, type: "software_install" as const, payload: payload as any, status: "queued" as const, queued_at: now, created_by: userId, created_at: now, updated_at: now })),
            });
        }
        return { queued: r.eligible.length, skipped: r.skipped.map(({ customer, site, ...rest }) => rest) };
    }

    /* ------------------------------ fix now (from the compliance report) ------------------------------ */

    /** The library entry a policy item (a library match text, a name seen on devices, or something typed) stands for. */
    private resolveItem(item: string, entries: any[]): any | null {
        const it = item.trim().toLowerCase();
        if (!it) return null;
        const exact = entries.find((e) => e.match_text.toLowerCase() === it || e.name.toLowerCase() === it);
        if (exact) return exact;
        // The item holds an entry's match text ("Google Chrome 120" holds "Google Chrome"): the longest one wins.
        const holds = entries.filter((e) => it.includes(e.match_text.toLowerCase())).sort((a, b) => b.match_text.length - a.match_text.length);
        if (holds.length) return holds[0];
        // The item is part of one entry's match text ("Chrome" in "Google Chrome"), when that is unambiguous.
        const part = entries.filter((e) => e.match_text.toLowerCase().includes(it));
        return part.length === 1 ? part[0] : null;
    }

    /**
     * Turns "these devices miss these required programs / have these banned ones" into what Fix now would do: for each
     * program, the library entry it maps to and which devices can be given the action now and which are skipped and why.
     * Nothing is queued here; the person confirms, and each group is queued through the ordinary install route.
     */
    async fixPlan(organizationId: string | null | undefined, userId: string | null, body: unknown) {
        const orgId = await this.org(organizationId);
        if (!body || typeof body !== "object") throw new BadRequestException("Nothing was sent.");
        const fixes = (body as { fixes?: unknown }).fixes;
        if (!Array.isArray(fixes) || !fixes.length) throw new BadRequestException("There is nothing to fix.");
        if (fixes.length > 5000) throw new BadRequestException("Fix at most 5000 items at a time. Narrow the report first.");

        const groups = new Map<string, { action: InstallAction; item: string; deviceIds: Set<string> }>();
        for (const f of fixes) {
            const action = this.action((f as any)?.action);
            const item = String((f as any)?.item ?? "").trim();
            const deviceId = String((f as any)?.deviceId ?? "");
            if (!item || item.length > 200 || /[\u0000-\u001f]/.test(item)) throw new BadRequestException("One of the items is not valid.");
            if (!UUID.test(deviceId)) throw new BadRequestException("One of the devices is not valid.");
            const key = `${action}\u0001${item.toLowerCase()}`;
            if (!groups.has(key)) groups.set(key, { action, item, deviceIds: new Set() });
            groups.get(key)!.deviceIds.add(deviceId);
        }
        if (groups.size > 100) throw new BadRequestException("That is more than 100 different programs. Narrow the report first.");

        const entries = await this.prisma.software_library.findMany({ where: { organization_id: orgId } });
        const out: Array<{
            item: string; action: InstallAction; devices: number; notPlanned: number;
            entry: { id: string; name: string; method: "chocolatey" | "direct" } | null; problem: string | null;
            eligible: Array<{ deviceId: string; device: string; customer: string; site: string }>;
            skipped: Array<{ deviceId: string; device: string; customer: string; site: string; reason: string }>;
        }> = [];
        for (const g of groups.values()) {
            const base = { item: g.item, action: g.action, devices: g.deviceIds.size, notPlanned: Math.max(0, g.deviceIds.size - MAX_FIX_DEVICES) };
            const entry = this.resolveItem(g.item, entries);
            if (!entry) { out.push({ ...base, entry: null, problem: `"${g.item}" is not in the software library. Add it there, with a Chocolatey id or an installer, to fix it from here.`, eligible: [], skipped: [] }); continue; }
            let payload: ReturnType<SoftwareLibraryService["payloadFor"]>;
            try { payload = this.payloadFor(entry, g.action); } catch (e) {
                out.push({ ...base, entry: { id: entry.id, name: entry.name, method: entry.chocolatey_id ? "chocolatey" : "direct" }, problem: (e as Error).message, eligible: [], skipped: [] });
                continue;
            }
            const ids = [...g.deviceIds].slice(0, MAX_FIX_DEVICES);
            const eligible: Array<{ deviceId: string; device: string; customer: string; site: string }> = [];
            const skipped: Why[] = [];
            for (let i = 0; i < ids.length; i += MAX_PREVIEW_DEVICES) {
                const r = await this.evaluate(orgId, userId, entry, g.action, { deviceIds: ids.slice(i, i + MAX_PREVIEW_DEVICES), clientIds: [], siteIds: [], tagIds: [] }, MAX_PREVIEW_DEVICES);
                eligible.push(...r.eligible.map(({ agentId, hasIt, ...rest }) => rest));
                skipped.push(...r.skipped);
            }
            out.push({ ...base, entry: { id: entry.id, name: entry.name, method: payload.method === "chocolatey" ? "chocolatey" : "direct" }, problem: null, eligible, skipped });
        }
        out.sort((a, b) => a.action.localeCompare(b.action) || a.item.localeCompare(b.item));
        return { groups: out };
    }

    /* ------------------------------ the install log ------------------------------ */

    /**
     * Recent installs and uninstalls, newest first, with what the agent said. For one device when `deviceId` is given,
     * otherwise across everything the person may see. Output is cut to a size a page can show.
     */
    async installs(organizationId: string | null | undefined, userId: string | null, opts: { deviceId?: string; status?: string; limit?: number }) {
        const orgId = await this.org(organizationId);
        const scope = await this.access.scopeFor(userId);
        if (opts.deviceId) {
            if (!UUID.test(opts.deviceId)) throw new BadRequestException("That device is not valid.");
            if (!(await this.access.canSeeDevice(scope, opts.deviceId))) throw new NotFoundException("Device not found");
        }
        const status = opts.status && ["waiting", "running", "succeeded", "failed"].includes(opts.status) ? opts.status : null;
        const limit = Math.min(Math.max(Math.floor(Number(opts.limit) || 50), 1), 200);
        const limited = scope ? Prisma.sql`AND ${deviceSqlOf(scope, { client: Prisma.sql`c.id::text`, site: Prisma.sql`d.site_id::text`, id: Prisma.sql`d.id::text` })}` : Prisma.empty;
        const statusSql = status === "waiting" ? Prisma.sql`AND t.status IN ('pending','queued')`
            : status ? Prisma.sql`AND t.status = ${status}::agent_task_status` : Prisma.empty;
        const rows = await this.prisma.$queryRaw<any[]>`
            SELECT t.id::text AS id, t.status::text AS status, t.payload, t.created_at, t.started_at, t.completed_at,
                   d.id::text AS device_id, COALESCE(NULLIF(d.alias, ''), d.hostname) AS device, c.name AS customer, st.name AS site,
                   COALESCE(NULLIF(trim(concat_ws(' ', u.first_name, u.last_name)), ''), u.email::text) AS requested_by,
                   r.output, res.stdout, res.stderr
              FROM public.agent_tasks t
              JOIN public.agents a ON a.id = t.agent_id
              JOIN public.devices d ON d.id = a.device_id
              JOIN public.sites st ON st.id = d.site_id
              JOIN public.clients c ON c.id = st.client_id
              LEFT JOIN public.users u ON u.id = t.created_by
              LEFT JOIN LATERAL (SELECT rr.id, rr.output FROM public.agent_task_runs rr WHERE rr.task_id = t.id ORDER BY rr.started_at DESC LIMIT 1) r ON true
              LEFT JOIN public.agent_task_results res ON res.run_id = r.id
             WHERE t.type = 'software_install' AND c.organization_id::text = ${orgId} ${limited} ${statusSql}
               ${opts.deviceId ? Prisma.sql`AND d.id = ${opts.deviceId}::uuid` : Prisma.empty}
             ORDER BY t.created_at DESC
             LIMIT ${limit}`;
        const cut = (v: unknown) => (typeof v === "string" && v ? (v.length > 8000 ? `${v.slice(0, 8000)}\n... (cut)` : v) : null);
        const now = Date.now();
        return {
            items: rows.map((r) => {
                const p = (r.payload ?? {}) as Record<string, any>;
                const out = (r.output ?? {}) as Record<string, any>;
                const status: "waiting" | "running" | "succeeded" | "failed" | "cancelled" = r.status === "pending" || r.status === "queued" ? "waiting" : r.status;
                const age = now - new Date(r.created_at).getTime();
                return {
                    id: r.id as string,
                    deviceId: r.device_id as string,
                    device: String(r.device ?? ""),
                    customer: String(r.customer ?? ""),
                    site: String(r.site ?? ""),
                    action: p.action === "uninstall" ? ("uninstall" as const) : p.action === "upgrade" ? ("upgrade" as const) : ("install" as const),
                    name: String(p.name ?? "Software"),
                    method: p.method === "direct" ? ("direct" as const) : p.method === "winget" ? ("winget" as const) : ("chocolatey" as const),
                    runAs: typeof p.runAs?.user === "string" ? (p.runAs.user as string) : null,
                    status,
                    // Waiting a long time means the device has not answered; running a very long time means it is stuck.
                    stale: (status === "waiting" && age > 15 * 60_000) || (status === "running" && age > 60 * 60_000),
                    requestedBy: (r.requested_by as string | null) ?? null,
                    requestedAt: new Date(r.created_at).toISOString(),
                    startedAt: r.started_at ? new Date(r.started_at).toISOString() : null,
                    finishedAt: r.completed_at ? new Date(r.completed_at).toISOString() : null,
                    ok: typeof out.ok === "boolean" ? (out.ok as boolean) : null,
                    exitCode: typeof out.exitCode === "number" ? (out.exitCode as number) : null,
                    message: typeof out.message === "string" ? (out.message as string).slice(0, 500) : null,
                    stdout: cut(r.stdout),
                    stderr: cut(r.stderr),
                };
            }),
        };
    }

    /** The account to install for, or null for everyone. It must be one the device reported, and signed in right now as of its last report. */
    private async cleanRunAs(raw: unknown, deviceId: string, orgId: string, userId: string | null): Promise<string | null> {
        const account = String(raw ?? "").trim();
        if (!account) return null;
        if (!ACCOUNT_RE.test(account)) throw new BadRequestException("That user is not valid.");
        const scope = await this.access.scopeFor(userId);
        if (!(await this.access.canSeeDevice(scope, deviceId))) throw new NotFoundException("Device not found");
        const agent = await this.prisma.agents.findFirst({ where: { device_id: deviceId, devices: { sites: { clients: { organization_id: orgId } } } }, select: { id: true } });
        if (!agent) throw new NotFoundException("That device has no agent.");
        // A plain lower-case comparison: Prisma's case-insensitive match is a LIKE, where the backslash in DOMAIN\name is an escape.
        const rows = await this.prisma.$queryRaw<Array<{ account: string; logged_in: boolean }>>`
            SELECT account, logged_in FROM public.agent_user_accounts WHERE agent_id = ${agent.id}::uuid AND lower(account) = lower(${account}) LIMIT 1`;
        const row = rows[0];
        if (!row) throw new ConflictException(`${account} is not one of this device's users as of its last report. Wait for its next inventory report, then try again.`);
        if (!row.logged_in) throw new ConflictException(`${row.account} is not signed in on this device right now. A program is installed for a user while they are signed in.`);
        return row.account;
    }

    /** The accounts a device reported, for the "install for" choice. */
    async users(organizationId: string | null | undefined, userId: string | null, deviceId: string) {
        const orgId = await this.org(organizationId);
        const scope = await this.access.scopeFor(userId);
        if (!(await this.access.canSeeDevice(scope, deviceId))) throw new NotFoundException("Device not found");
        const agent = await this.prisma.agents.findFirst({ where: { device_id: deviceId, devices: { sites: { clients: { organization_id: orgId } } } }, select: { id: true } });
        if (!agent) return { items: [] as Array<{ account: string; loggedIn: boolean; updatedAt: string }> };
        const rows = await this.prisma.agent_user_accounts.findMany({ where: { agent_id: agent.id }, orderBy: [{ logged_in: "desc" }, { account: "asc" }] });
        return { items: rows.map((r) => ({ account: r.account, loggedIn: r.logged_in, updatedAt: r.updated_at.toISOString() })) };
    }

    /** One device. A plain-language conflict says why it cannot run. */
    async queueOne(deviceId: string, body: unknown, userId: string | null, organizationId?: string | null) {
        const orgId = await this.org(organizationId);
        if (!body || typeof body !== "object") throw new BadRequestException("Nothing was sent.");
        const b = body as Record<string, unknown>;
        const action = this.action(b.action);
        const libraryId = String(b.libraryId ?? "");
        if (!UUID.test(libraryId)) throw new BadRequestException("Choose something from the library.");
        const entry = await this.entry(libraryId, orgId);
        const runAs = await this.cleanRunAs(b.runAs, deviceId, orgId, userId);
        const payload = this.payloadFor(entry, action, runAs);
        let force = b.force === true;
        if (runAs && action === "uninstall") {
            // Whether THAT user has it: their own entries in the last inventory, not the whole PC's.
            const has = await this.prisma.$queryRaw<Array<{ one: number }>>`
                SELECT 1 AS one FROM public.agent_software s JOIN public.agents a ON a.id = s.agent_id
                 WHERE a.device_id = ${deviceId}::uuid AND s.scope = 'user' AND lower(s.installed_user) = lower(${runAs})
                   AND position(lower(${entry.match_text}) in lower(s.name)) > 0 LIMIT 1`;
            if (!has.length && b.force !== true) throw new ConflictException(`${runAs} does not have ${entry.name} installed, as far as the last inventory shows.`);
            force = true; // checked above, for this user
        }
        const r = await this.evaluate(orgId, userId, entry, action, { deviceIds: [deviceId], clientIds: [], siteIds: [], tagIds: [] }, 1, force, runAs && action === "uninstall" ? RUN_AS_UNINSTALL_MIN_VERSION : INSTALL_MIN_VERSION);
        if (!r.eligible.length) {
            const why = r.skipped[0]?.reason ?? "That device was not found.";
            if (!r.skipped.length) throw new NotFoundException("Device not found");
            throw new ConflictException(why);
        }
        const now = new Date();
        const { id } = await this.prisma.agent_tasks.create({
            data: { agent_id: r.eligible[0].agentId, type: "software_install", payload: payload as any, status: "queued", queued_at: now, created_by: userId, created_at: now, updated_at: now },
            select: { id: true },
        });
        return { accepted: true as const, taskId: id };
    }
}
