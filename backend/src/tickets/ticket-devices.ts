// Devices on a ticket. A ticket links none, one or several devices, all of the ticket's own customer.
// tickets.device_id stays as the main device (alerts, the portal and older screens use it); every linked device,
// the main one included, is a row in ticket_devices (a database trigger adds the main one).
import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "crypto";
import { isCanonicalUuid } from "../common/agent-lookup.util";
import { PrismaService } from "../storage/prisma.service";
import { ClientAccessService } from "../reports/client-access.service";

export const MAX_DEVICES_PER_TICKET = 50;

type Db = Pick<PrismaService, "devices" | "tickets" | "ticket_devices" | "ticket_activity">;

export type CheckedDevice = { id: string; hostname: string; alias: string | null; clientId: string | null };
export const deviceLabel = (d: { hostname: string; alias: string | null }) => d.alias || d.hostname;

/**
 * The devices exist, are in this organization, and are all of one customer, which is the ticket's customer when it has one.
 * Returns the customer the ticket should carry (its own, or the devices').
 */
export async function checkTicketDevices(prisma: Db, orgId: string, ticketClientId: string | null, ids: string[]): Promise<{ clientId: string | null; devices: CheckedDevice[] }> {
    const unique = [...new Set(ids)];
    if (!unique.length) return { clientId: ticketClientId, devices: [] };
    if (unique.length > MAX_DEVICES_PER_TICKET) throw new BadRequestException(`A ticket can have ${MAX_DEVICES_PER_TICKET} devices at most.`);
    if (unique.some((id) => !isCanonicalUuid(id))) throw new BadRequestException("That device does not exist.");
    const rows = await prisma.devices.findMany({
        where: { id: { in: unique } },
        select: { id: true, hostname: true, alias: true, sites: { select: { client_id: true, clients: { select: { organization_id: true } } } } },
    });
    if (rows.length !== unique.length) throw new BadRequestException("That device does not exist.");
    const devices: CheckedDevice[] = rows.map((r) => ({ id: r.id, hostname: r.hostname, alias: r.alias, clientId: r.sites?.client_id ?? null }));
    for (const r of rows) {
        const deviceOrg = r.sites?.clients?.organization_id;
        if (deviceOrg && deviceOrg !== orgId) throw new BadRequestException("That device does not exist.");
    }
    let clientId = ticketClientId;
    for (const d of devices) {
        if (!d.clientId) continue;
        if (clientId && d.clientId !== clientId) {
            throw new BadRequestException(`${deviceLabel(d)} belongs to a different customer than this ticket. A ticket can only have devices of its own customer.`);
        }
        clientId = d.clientId;
    }
    return { clientId, devices };
}

/** Links devices that passed checkTicketDevices; the first becomes the main one when the ticket has none. */
export async function linkTicketDevices(prisma: Db, ticketId: string, devices: CheckedDevice[], actor: string, opts: { quiet?: boolean } = {}): Promise<CheckedDevice[]> {
    if (!devices.length) return [];
    const existing = new Set((await prisma.ticket_devices.findMany({ where: { ticket_id: ticketId }, select: { device_id: true } })).map((r) => r.device_id));
    const added = devices.filter((d) => !existing.has(d.id));
    if (!added.length) return [];
    await prisma.ticket_devices.createMany({ data: added.map((d) => ({ ticket_id: ticketId, device_id: d.id, added_by: actor })), skipDuplicates: true });
    await prisma.tickets.updateMany({ where: { id: ticketId, device_id: null }, data: { device_id: added[0].id } });
    if (!opts.quiet) await history(prisma, ticketId, actor, added.map((d) => `Device added: ${deviceLabel(d)}`));
    return added;
}

/** A line in the ticket's history. Best-effort: the change itself has already been saved. */
export async function history(prisma: Pick<PrismaService, "ticket_activity">, ticketId: string, actor: string, lines: string[]) {
    // Timestamps stay distinct so the newest-first order holds.
    const base = Date.now();
    try {
        await prisma.ticket_activity.createMany({
            data: lines.map((body, i) => ({ id: randomUUID(), ticket_id: ticketId, kind: "change", body, attachments: [], time_worked_seconds: 0, notify_customer: false, author: actor, is_internal: true, created_at: new Date(base + i) })),
        });
    } catch {
        /* ignore */
    }
}

export const actorOf = (req: any): string => {
    const u = req?.user ?? null;
    return String(u?.name ?? u?.fullName ?? "").trim() || String(u?.email ?? u?.username ?? "").trim() || "System";
};
export const orgOf = (req: any): string | null => {
    const u = req?.user ?? null;
    return u?.organizationId ?? u?.organization_id ?? u?.orgId ?? null;
};

@Injectable()
export class TicketDevicesService {
    constructor(private readonly prisma: PrismaService, private readonly access: ClientAccessService) { }

    private scope(req: any) {
        return this.access.scopeFor(req?.user?.id ? String(req.user.id) : null);
    }

    private async ticketOf(id: string, req: any) {
        const orgId = orgOf(req);
        if (!isCanonicalUuid(id) || (orgId && !isCanonicalUuid(orgId))) throw new NotFoundException("Ticket not found");
        const t = await this.prisma.tickets.findFirst({ where: { id, ...(orgId ? { organization_id: orgId } : {}) }, select: { id: true, organization_id: true, client_id: true, device_id: true } });
        if (!t) throw new NotFoundException("Ticket not found");
        return t;
    }

    /** A person limited to some customers may only use their own customers' devices: any other is "not found" for them. */
    async assertVisible(req: any, ids: string[]) {
        const scope = await this.scope(req);
        if (!scope) return;
        for (const id of new Set(ids)) if (!(await this.access.canSeeDevice(scope, id))) throw new NotFoundException("Device not found");
    }

    async list(ticketId: string, req: any) {
        const t = await this.ticketOf(ticketId, req);
        const scope = await this.scope(req);
        const rows = await this.prisma.ticket_devices.findMany({
            where: { ticket_id: t.id },
            orderBy: { added_at: "asc" },
            select: {
                added_at: true,
                added_by: true,
                devices: { select: { id: true, hostname: true, alias: true, operating_system: true, status: true, last_seen_at: true, site_id: true, sites: { select: { name: true, client_id: true, clients: { select: { name: true } } } } } },
            },
        });
        const out: Record<string, unknown>[] = [];
        for (const r of rows) {
            const d = r.devices;
            // A device outside a limited person's customers is not listed for them.
            if (scope && !(await this.access.canSeeDevice(scope, d.id))) continue;
            out.push({
                id: d.id,
                hostname: d.hostname,
                alias: d.alias,
                name: deviceLabel(d),
                os: d.operating_system,
                status: d.status,
                lastSeenAt: d.last_seen_at ? d.last_seen_at.toISOString() : null,
                siteId: d.site_id,
                siteName: d.sites?.name ?? null,
                clientId: d.sites?.client_id ?? null,
                clientName: d.sites?.clients?.name ?? null,
                isMain: t.device_id === d.id,
                addedAt: r.added_at.toISOString(),
                addedBy: r.added_by,
            });
        }
        return { items: out };
    }

    async add(ticketId: string, deviceId: unknown, req: any) {
        const t = await this.ticketOf(ticketId, req);
        const id = String(deviceId ?? "").trim();
        if (!isCanonicalUuid(id)) throw new BadRequestException("deviceId is required.");
        await this.assertVisible(req, [id]);
        const checked = await checkTicketDevices(this.prisma, t.organization_id, t.client_id, [id]);
        const already = await this.prisma.ticket_devices.count({ where: { ticket_id: t.id } });
        if (already >= MAX_DEVICES_PER_TICKET) throw new BadRequestException(`A ticket can have ${MAX_DEVICES_PER_TICKET} devices at most.`);
        const added = await linkTicketDevices(this.prisma, t.id, checked.devices, actorOf(req));
        // A ticket with no customer takes its first device's customer.
        if (!t.client_id && checked.clientId) await this.prisma.tickets.updateMany({ where: { id: t.id, client_id: null }, data: { client_id: checked.clientId } });
        if (added.length) await this.prisma.tickets.updateMany({ where: { id: t.id }, data: { updated_at: new Date() } });
        return { ok: true, added: added.length };
    }

    async remove(ticketId: string, deviceId: string, req: any) {
        const t = await this.ticketOf(ticketId, req);
        if (!isCanonicalUuid(deviceId)) throw new NotFoundException("That device is not on this ticket.");
        await this.assertVisible(req, [deviceId]);
        if (!(await unlinkTicketDevice(this.prisma, t, deviceId, actorOf(req)))) throw new NotFoundException("That device is not on this ticket.");
        return { ok: true };
    }

    /** The open tickets of a device first, then the most recent ones. */
    async forDevice(deviceId: string, req: any, limit = 25) {
        const orgId = orgOf(req);
        if (!isCanonicalUuid(deviceId)) throw new NotFoundException("Device not found");
        await this.assertVisible(req, [deviceId]);
        const rows = await this.prisma.tickets.findMany({
            where: { ticket_devices: { some: { device_id: deviceId } }, ...(orgId ? { organization_id: orgId } : {}) },
            select: { id: true, ticket_number: true, subject: true, status: true, priority: true, created_at: true, updated_at: true, closed_at: true },
            orderBy: { created_at: "desc" },
            take: 200,
        });
        const isOpen = (s: string) => s === "open" || s === "in_progress";
        const sorted = [...rows.filter((r) => isOpen(r.status)), ...rows.filter((r) => !isOpen(r.status))].slice(0, Math.min(Math.max(1, limit), 100));
        return {
            openCount: rows.filter((r) => isOpen(r.status)).length,
            items: sorted.map((r) => ({
                id: r.id,
                number: Number(r.ticket_number),
                title: r.subject,
                status: r.status,
                priority: r.priority === "normal" ? "medium" : r.priority,
                createdAt: r.created_at.toISOString(),
                updatedAt: r.updated_at.toISOString(),
                closedAt: r.closed_at ? r.closed_at.toISOString() : null,
            })),
        };
    }
}

/** Takes a device off a ticket; when it was the main one, the next linked device (or none) becomes the main one. */
export async function unlinkTicketDevice(prisma: Db, ticket: { id: string; device_id: string | null }, deviceId: string, actor: string): Promise<boolean> {
    const key = { ticket_id_device_id: { ticket_id: ticket.id, device_id: deviceId } };
    const link = await prisma.ticket_devices.findUnique({ where: key, select: { devices: { select: { hostname: true, alias: true } } } });
    if (!link) return false;
    await prisma.ticket_devices.delete({ where: key });
    if (ticket.device_id === deviceId) {
        const next = await prisma.ticket_devices.findFirst({ where: { ticket_id: ticket.id }, orderBy: { added_at: "asc" }, select: { device_id: true } });
        await prisma.tickets.updateMany({ where: { id: ticket.id }, data: { device_id: next?.device_id ?? null } });
    }
    await prisma.tickets.updateMany({ where: { id: ticket.id }, data: { updated_at: new Date() } });
    await history(prisma, ticket.id, actor, [`Device removed: ${deviceLabel(link.devices)}`]);
    return true;
}
