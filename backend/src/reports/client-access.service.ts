// backend/src/reports/client-access.service.ts
//
// What a person may see. Someone with nothing set sees everything. Otherwise they see only what is named for
// them, directly or through a group: whole customers, single sites, or every device carrying a tag.
//
// Reports and a few other screens still work at the level of whole customers: for them a person who only has sites
// or tags sees nothing, which is the safe side. Devices, a device's own pages, alerts, failures and the customer
// list follow sites and tags too.
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../storage/prisma.service";
import { OrganizationContextService } from "../storage/organization-context.service";

export type AccessScope = { clients: string[]; sites: string[]; tags: string[] };

/** Prisma filter for devices a person may see. */
export function deviceWhereOf(scope: AccessScope): Prisma.devicesWhereInput {
    return {
        OR: [
            ...(scope.clients.length ? [{ sites: { client_id: { in: scope.clients } } }] : []),
            ...(scope.sites.length ? [{ site_id: { in: scope.sites } }] : []),
            ...(scope.tags.length ? [{ device_tags: { some: { tag_id: { in: scope.tags } } } }] : []),
        ],
    };
}

/** The same filter for raw queries over rows that carry client, site and device ids as text. */
export function deviceSqlOf(scope: AccessScope, cols: { client: Prisma.Sql; site: Prisma.Sql; id: Prisma.Sql }): Prisma.Sql {
    return Prisma.sql`(
        ${cols.client} = ANY(${scope.clients}::text[])
        OR ${cols.site} = ANY(${scope.sites}::text[])
        OR ${cols.id} IN (SELECT dt.device_id::text FROM public.device_tags dt WHERE dt.tag_id::text = ANY(${scope.tags}::text[]))
    )`;
}

@Injectable()
export class ClientAccessService {
    constructor(private readonly prisma: PrismaService, private readonly orgs: OrganizationContextService) { }

    /** Everything a person is limited to, from their own list and their groups, or null when they may see it all. */
    async scopeFor(userId: string | null | undefined): Promise<AccessScope | null> {
        if (!userId) return null;
        const [mine, grouped] = await Promise.all([
            this.prisma.user_client_access.findMany({ where: { user_id: userId }, select: { client_id: true } }),
            this.prisma.user_group_scope.findMany({
                where: { user_groups: { user_group_members: { some: { user_id: userId } } } },
                select: { kind: true, target_id: true },
            }),
        ]);
        if (!mine.length && !grouped.length) return null;
        const pick = (kind: string) => grouped.filter((g) => g.kind === kind).map((g) => g.target_id);
        return {
            clients: [...new Set([...mine.map((m) => m.client_id), ...pick("customer")])],
            sites: [...new Set(pick("site"))],
            tags: [...new Set(pick("tag"))],
        };
    }

    /** The whole customers a person is limited to, or null when they may see all of them. Sites and tags do not count here. */
    async allowedFor(userId: string | null | undefined): Promise<string[] | null> {
        const scope = await this.scopeFor(userId);
        return scope ? scope.clients : null;
    }

    /** Every customer a person can reach in any way: whole customers, plus those that hold one of their sites or tagged devices. */
    async visibleClientsFor(userId: string | null | undefined): Promise<string[] | null> {
        const scope = await this.scopeFor(userId);
        if (!scope) return null;
        const out = new Set(scope.clients);
        if (scope.sites.length) {
            for (const s of await this.prisma.sites.findMany({ where: { id: { in: scope.sites } }, select: { client_id: true } })) out.add(s.client_id);
        }
        if (scope.tags.length) {
            const rows = await this.prisma.devices.findMany({ where: { device_tags: { some: { tag_id: { in: scope.tags } } } }, select: { sites: { select: { client_id: true } } } });
            for (const r of rows) if (r.sites?.client_id) out.add(r.sites.client_id);
        }
        return [...out];
    }

    deviceWhere(scope: AccessScope): Prisma.devicesWhereInput {
        return deviceWhereOf(scope);
    }

    /** True when a device is one of those a limited person may see. */
    async canSeeDevice(scope: AccessScope | null, deviceId: string): Promise<boolean> {
        if (!scope) return true;
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(deviceId)) return false;
        const hit = await this.prisma.devices.findFirst({ where: { id: deviceId, ...this.deviceWhere(scope) }, select: { id: true } });
        return !!hit;
    }

    /** True when a site is one a limited person may use: in one of their customers, or one of their own sites. */
    async canSeeSite(scope: AccessScope | null, siteId: string): Promise<boolean> {
        if (!scope) return true;
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(siteId)) return false;
        const site = await this.prisma.sites.findUnique({ where: { id: siteId }, select: { client_id: true } });
        if (!site) return false;
        return scope.clients.includes(site.client_id) || scope.sites.includes(siteId);
    }

    /** For a limited person, throws not-found when a device is not one of their customers' devices. Others pass. */
    async assertDevice(userId: string | null | undefined, deviceId: string) {
        const scope = await this.scopeFor(userId);
        if (!(await this.canSeeDevice(scope, deviceId))) throw new NotFoundException("Device not found");
    }

    /** Throws if a person who is limited asks for a customer outside their list. */
    assertClient(allowed: string[] | null | undefined, clientId: string | null | undefined) {
        if (!allowed) return;
        if (!clientId || !allowed.includes(clientId)) throw new ForbiddenException("You do not have access to that customer.");
    }

    async list() {
        const organizationId = await this.orgs.getDefaultOrganizationId();
        const [users, rows, clients] = await Promise.all([
            this.prisma.users.findMany({ where: { organization_id: organizationId }, select: { id: true, email: true, first_name: true, last_name: true }, orderBy: { email: "asc" } }),
            this.prisma.user_client_access.findMany(),
            this.prisma.clients.findMany({ where: { organization_id: organizationId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
        ]);
        const byUser = new Map<string, string[]>();
        for (const r of rows) byUser.set(r.user_id, [...(byUser.get(r.user_id) ?? []), r.client_id]);
        return {
            customers: clients,
            users: users.map((u) => ({ id: u.id, email: String(u.email), name: [u.first_name, u.last_name].filter(Boolean).join(" "), clientIds: (byUser.get(u.id) ?? []).filter((c) => clients.some((x) => x.id === c)) })),
        };
    }

    /** Replaces a person's list. An empty list means they may see every customer. */
    async set(userId: string, clientIds: string[]) {
        const organizationId = await this.orgs.getDefaultOrganizationId();
        const user = await this.prisma.users.findFirst({ where: { id: userId, organization_id: organizationId }, select: { id: true } });
        if (!user) throw new NotFoundException("That person does not exist.");
        const unique = [...new Set(clientIds ?? [])];
        if (unique.length > 500) throw new BadRequestException("That is too many customers.");
        const valid = await this.prisma.clients.findMany({ where: { id: { in: unique }, organization_id: organizationId }, select: { id: true } });
        if (valid.length !== unique.length) throw new BadRequestException("One of those customers does not exist.");
        await this.prisma.$transaction([
            this.prisma.user_client_access.deleteMany({ where: { user_id: userId } }),
            this.prisma.user_client_access.createMany({ data: unique.map((client_id) => ({ user_id: userId, client_id })) }),
        ]);
        return { userId, clientIds: unique };
    }
}
