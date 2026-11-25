// backend/src/policies/tags.service.ts
//
// Tags: labels put on devices, so a policy can reach "every server" or "every point-of-sale PC" by tag, across customers.
import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../storage/prisma.service";
import { OrganizationContextService } from "../storage/organization-context.service";
import { PoliciesService } from "./policies.service";
import { ClientAccessService } from "../reports/client-access.service";

const MAX_TAGS = 200;
const MAX_TAGS_PER_DEVICE = 30;
const MAX_BULK = 1000;
const COLOR = /^#[0-9a-f]{6}$/i;

@Injectable()
export class TagsService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly orgs: OrganizationContextService,
        private readonly access: ClientAccessService,
    ) { }

    private async org(organizationId?: string | null) {
        return organizationId || (await this.orgs.getDefaultOrganizationId());
    }

    private cleanName(v: unknown): string {
        const name = String(v ?? "").trim().replace(/\s+/g, " ");
        if (!name) throw new BadRequestException("The tag needs a name.");
        if (name.length > 40) throw new BadRequestException("The tag name is too long (40 characters at most).");
        return name;
    }

    private cleanColor(v: unknown): string | null {
        const c = String(v ?? "").trim();
        if (!c) return null;
        if (!COLOR.test(c)) throw new BadRequestException("The colour must look like #1a73e8.");
        return c.toLowerCase();
    }

    private async assertNameFree(orgId: string, name: string, exceptId?: string) {
        const clash = await this.prisma.$queryRaw<Array<{ id: string }>>`
            SELECT id::text AS id FROM public.tag_defs WHERE organization_id::text = ${orgId} AND lower(name) = lower(${name}) ${exceptId ? Prisma.sql`AND id <> ${exceptId}::uuid` : Prisma.empty} LIMIT 1`;
        if (clash.length) throw new ConflictException("Another tag already has that name.");
    }

    async list(organizationId?: string | null) {
        const orgId = await this.org(organizationId);
        const tags = await this.prisma.tag_defs.findMany({ where: { organization_id: orgId }, orderBy: { name: "asc" }, include: { _count: { select: { device_tags: true } } } });
        const used = await this.prisma.policy_assignments.findMany({ where: { level: "tag", policies: { organization_id: orgId } }, select: { target_id: true, policies: { select: { name: true } } } });
        return {
            items: tags.map((t) => ({
                id: t.id, name: t.name, color: t.color, devices: t._count.device_tags,
                policies: [...new Set(used.filter((u) => u.target_id === t.id).map((u) => u.policies.name))].sort(),
            })),
        };
    }

    async create(body: unknown, organizationId?: string | null) {
        const orgId = await this.org(organizationId);
        if (!body || typeof body !== "object") throw new BadRequestException("Nothing was sent.");
        const b = body as Record<string, unknown>;
        const name = this.cleanName(b.name);
        const color = this.cleanColor(b.color);
        if ((await this.prisma.tag_defs.count({ where: { organization_id: orgId } })) >= MAX_TAGS) throw new BadRequestException(`There can be ${MAX_TAGS} tags at most.`);
        await this.assertNameFree(orgId, name);
        try {
            const row = await this.prisma.tag_defs.create({ data: { organization_id: orgId, name, color } });
            return { id: row.id, name: row.name, color: row.color, devices: 0, policies: [] as string[] };
        } catch (e: any) {
            if (e?.code === "P2002") throw new ConflictException("Another tag already has that name.");
            throw e;
        }
    }

    async update(id: string, body: unknown, organizationId?: string | null) {
        const orgId = await this.org(organizationId);
        const found = await this.prisma.tag_defs.findFirst({ where: { id, organization_id: orgId }, select: { id: true } });
        if (!found) throw new NotFoundException("That tag does not exist.");
        if (!body || typeof body !== "object") throw new BadRequestException("Nothing was sent.");
        const b = body as Record<string, unknown>;
        const data: { name?: string; color?: string | null } = {};
        if ("name" in b) { data.name = this.cleanName(b.name); await this.assertNameFree(orgId, data.name, id); }
        if ("color" in b) data.color = this.cleanColor(b.color);
        try {
            await this.prisma.tag_defs.update({ where: { id }, data });
        } catch (e: any) {
            if (e?.code === "P2002") throw new ConflictException("Another tag already has that name.");
            throw e;
        }
        PoliciesService.invalidate();
        return (await this.list(orgId)).items.find((t) => t.id === id);
    }

    /** Deleting a tag takes it off every device and out of every policy that used it. */
    async remove(id: string, organizationId?: string | null) {
        const orgId = await this.org(organizationId);
        const found = await this.prisma.tag_defs.findFirst({ where: { id, organization_id: orgId }, select: { id: true, name: true } });
        if (!found) throw new NotFoundException("That tag does not exist.");
        const policies = await this.prisma.policy_assignments.findMany({ where: { level: "tag", target_id: id }, select: { policies: { select: { name: true } } } });
        await this.prisma.$transaction([
            this.prisma.policy_assignments.deleteMany({ where: { level: "tag", target_id: id } }),
            this.prisma.tag_defs.delete({ where: { id } }),
        ]);
        PoliciesService.invalidate();
        return { id, deleted: true, removedFromPolicies: [...new Set(policies.map((p) => p.policies.name))] };
    }

    /** In the organisation and, for a person limited to some customers, one of their devices. Otherwise not found. */
    private async assertDevice(orgId: string, deviceId: string, userId?: string | null) {
        const d = await this.prisma.devices.findFirst({ where: { id: deviceId, sites: { clients: { organization_id: orgId } } }, select: { id: true } });
        if (!d) throw new NotFoundException("That device does not exist.");
        await this.access.assertDevice(userId ?? null, deviceId);
    }

    async ofDevice(deviceId: string, organizationId?: string | null, userId?: string | null) {
        const orgId = await this.org(organizationId);
        await this.assertDevice(orgId, deviceId, userId);
        const rows = await this.prisma.device_tags.findMany({ where: { device_id: deviceId }, include: { tag_defs: true } });
        return { items: rows.map((r) => ({ id: r.tag_defs.id, name: r.tag_defs.name, color: r.tag_defs.color })).sort((a, b) => a.name.localeCompare(b.name)) };
    }

    /** The tags a device has, replaced by this list. */
    async setForDevice(deviceId: string, body: unknown, organizationId?: string | null, userId?: string | null) {
        const orgId = await this.org(organizationId);
        await this.assertDevice(orgId, deviceId, userId);
        const raw = (body as any)?.tagIds;
        if (!Array.isArray(raw)) throw new BadRequestException("Choose the tags the device should have.");
        const ids = [...new Set(raw.map((x: unknown) => String(x ?? "").toLowerCase()))];
        if (ids.length > MAX_TAGS_PER_DEVICE) throw new BadRequestException(`A device can have ${MAX_TAGS_PER_DEVICE} tags at most.`);
        if (ids.length && (await this.prisma.tag_defs.count({ where: { organization_id: orgId, id: { in: ids } } })) !== ids.length) throw new BadRequestException("One of the tags does not exist.");
        await this.prisma.$transaction([
            this.prisma.device_tags.deleteMany({ where: { device_id: deviceId } }),
            ...(ids.length ? [this.prisma.device_tags.createMany({ data: ids.map((tag_id) => ({ device_id: deviceId, tag_id })) })] : []),
        ]);
        PoliciesService.invalidate();
        return this.ofDevice(deviceId, orgId, userId);
    }

    /** Put a tag on, or take it off, many devices at once. */
    async bulk(tagId: string, body: unknown, organizationId?: string | null, userId?: string | null) {
        const orgId = await this.org(organizationId);
        const tag = await this.prisma.tag_defs.findFirst({ where: { id: tagId, organization_id: orgId }, select: { id: true } });
        if (!tag) throw new NotFoundException("That tag does not exist.");
        const b = (body ?? {}) as Record<string, unknown>;
        if (!Array.isArray(b.deviceIds) || !b.deviceIds.length) throw new BadRequestException("Choose at least one device.");
        if (b.deviceIds.length > MAX_BULK) throw new BadRequestException(`Choose ${MAX_BULK} devices at most at a time.`);
        const ids = [...new Set(b.deviceIds.map((x: unknown) => String(x ?? "").toLowerCase()))];
        const valid = await this.prisma.devices.findMany({ where: { id: { in: ids }, sites: { clients: { organization_id: orgId } } }, select: { id: true } });
        if (valid.length !== ids.length) throw new BadRequestException("One of the devices does not exist.");
        // A person limited to some customers may only change their own customers' devices: one outside refuses the lot.
        const scope = await this.access.scopeFor(userId ?? null);
        if (scope) {
            const reachable = await this.prisma.devices.count({ where: { AND: [{ id: { in: ids } }, this.access.deviceWhere(scope)] } });
            if (reachable !== ids.length) throw new NotFoundException("Device not found");
        }
        const remove = b.remove === true;
        if (remove) await this.prisma.device_tags.deleteMany({ where: { tag_id: tagId, device_id: { in: ids } } });
        else await this.prisma.device_tags.createMany({ data: ids.map((device_id) => ({ device_id, tag_id: tagId })), skipDuplicates: true });
        PoliciesService.invalidate();
        return { tagId, devices: ids.length, removed: remove };
    }

    /** For a person limited to some customers, only their devices; nothing extra for everyone else. */
    private async limitedDevices(userId?: string | null): Promise<Prisma.device_tagsWhereInput> {
        const scope = await this.access.scopeFor(userId ?? null);
        return scope ? { devices: this.access.deviceWhere(scope) } : {};
    }

    /** The devices that have a tag. */
    async devicesOf(tagId: string, organizationId?: string | null, userId?: string | null) {
        const orgId = await this.org(organizationId);
        const tag = await this.prisma.tag_defs.findFirst({ where: { id: tagId, organization_id: orgId }, select: { id: true, name: true } });
        if (!tag) throw new NotFoundException("That tag does not exist.");
        const rows = await this.prisma.device_tags.findMany({
            where: { tag_id: tagId, ...(await this.limitedDevices(userId)) }, take: 1000,
            include: { devices: { select: { id: true, hostname: true, alias: true, sites: { select: { name: true, clients: { select: { name: true } } } } } } },
        });
        return { tag: tag.name, items: rows.map((r) => ({ deviceId: r.devices.id, device: r.devices.alias || r.devices.hostname, customer: r.devices.sites?.clients?.name ?? null, site: r.devices.sites?.name ?? null })).sort((a, b) => a.device.localeCompare(b.device)) };
    }
}
