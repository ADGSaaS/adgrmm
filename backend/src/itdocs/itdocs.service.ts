// backend/src/itdocs/itdocs.service.ts
import { AssetsService } from "../assets/assets.service";
import { ClientAccessService, deviceWhereOf, type AccessScope } from "../reports/client-access.service";
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../storage/prisma.service";
import { OrganizationContextService } from "../storage/organization-context.service";
import { SmtpService } from "../smtp/smtp.service";

export const ASSET_KINDS = ["computer", "server", "network", "printer", "mobile", "licence", "domain", "certificate", "other"] as const;
export const LINK_TYPES = ["ticket", "device", "asset"] as const;
export type LinkType = (typeof LINK_TYPES)[number];

export type AssetInput = {
    clientId: string;
    name: string;
    kind: string;
    manufacturer?: string | null;
    model?: string | null;
    serialNumber?: string | null;
    location?: string | null;
    purchaseDate?: string | null;
    expiresAt?: string | null;
    notes?: string | null;
};

const SYNC_EVERY_MS = 60 * 60_000;
const NOTICE_DAYS = [30, 7, 1];

const dateOnly = (value: Date | null | undefined) => (value ? value.toISOString().slice(0, 10) : null);

function toDate(value: string | null | undefined): Date | null | undefined {
    if (value === undefined) return undefined;
    if (value === null || value === "") return null;
    const date = new Date(`${value}T00:00:00.000Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(date.getTime())) throw new BadRequestException("Dates must look like 2026-12-31.");
    return date;
}

@Injectable()
export class ItDocsService {
    private readonly logger = new Logger(ItDocsService.name);
    private syncing = false;

    constructor(
        private readonly prisma: PrismaService,
        private readonly orgs: OrganizationContextService,
        private readonly smtp: SmtpService,
        private readonly assets: AssetsService,
        private readonly access: ClientAccessService,
    ) { }

    private orgId() {
        return this.orgs.getDefaultOrganizationId();
    }

    private async requireClient(clientId: string, organizationId: string) {
        const client = await this.prisma.clients.findFirst({ where: { id: clientId, organization_id: organizationId }, select: { id: true } });
        if (!client) throw new BadRequestException("That customer does not exist.");
    }

    /* ------------------------------ assets ------------------------------ */

    private presentAsset(row: any) {
        return {
            id: row.id,
            client: row.clients ? { id: row.clients.id, name: row.clients.name } : { id: row.client_id, name: "" },
            deviceId: row.device_id,
            name: row.name,
            kind: row.kind,
            manufacturer: row.manufacturer,
            model: row.model,
            serialNumber: row.serial_number,
            location: row.location,
            purchaseDate: dateOnly(row.purchase_date),
            expiresAt: dateOnly(row.expires_at),
            notes: row.notes,
            details: row.details ?? {},
            source: row.source,
            lastSyncedAt: row.last_synced_at,
        };
    }

    /**
     * What a person limited to some customers may reach: the assets of their customers, and the assets of devices they can see. Anyone else
     * (no limit) reaches everything. An asset of another customer does not exist for a limited person.
     */
    private async assetScope(userId: string | null | undefined): Promise<{ scope: AccessScope | null; where: Prisma.assetsWhereInput }> {
        const scope = await this.access.scopeFor(userId);
        if (!scope) return { scope, where: {} };
        return { scope, where: { OR: [{ client_id: { in: scope.clients } }, { devices: { is: deviceWhereOf(scope) } }] } };
    }

    /** A limited person can only put an asset on one of their own customers. */
    private assertClientAllowed(scope: AccessScope | null, clientId: string) {
        if (scope && !scope.clients.includes(clientId)) throw new BadRequestException("That customer does not exist.");
    }

    async listAssets(params: { clientId?: string; kind?: string; q?: string }, userId?: string | null) {
        await this.assets.assertBuiltin();
        const q = params.q?.trim();
        const limit = await this.assetScope(userId);
        const rows = await this.prisma.assets.findMany({
            where: {
                AND: [limit.where],
                organization_id: await this.orgId(),
                ...(params.clientId ? { client_id: params.clientId } : {}),
                ...(params.kind ? { kind: params.kind } : {}),
                ...(q ? { OR: [{ name: { contains: q, mode: "insensitive" as const } }, { serial_number: { contains: q, mode: "insensitive" as const } }, { model: { contains: q, mode: "insensitive" as const } }] } : {}),
            },
            orderBy: [{ kind: "asc" }, { name: "asc" }],
            take: 2000,
            include: { clients: { select: { id: true, name: true } } },
        });
        return { items: rows.map((r) => this.presentAsset(r)) };
    }

    private assetData(input: AssetInput) {
        if (!input.name?.trim()) throw new BadRequestException("Give it a name.");
        if (!(ASSET_KINDS as readonly string[]).includes(input.kind)) throw new BadRequestException("Choose a type.");
        return {
            name: input.name.trim(),
            kind: input.kind,
            manufacturer: input.manufacturer || null,
            model: input.model || null,
            serial_number: input.serialNumber || null,
            location: input.location || null,
            purchase_date: toDate(input.purchaseDate) ?? null,
            expires_at: toDate(input.expiresAt) ?? null,
            notes: input.notes || null,
            updated_at: new Date(),
        };
    }

    async createAsset(input: AssetInput, userId?: string | null) {
        await this.assets.assertBuiltin();
        const organizationId = await this.orgId();
        this.assertClientAllowed((await this.assetScope(userId)).scope, input.clientId);
        await this.requireClient(input.clientId, organizationId);
        const row = await this.prisma.assets.create({ data: { ...this.assetData(input), organization_id: organizationId, client_id: input.clientId }, select: { id: true } });
        return { id: row.id };
    }

    async updateAsset(id: string, input: AssetInput, userId?: string | null) {
        await this.assets.assertBuiltin();
        const limit = await this.assetScope(userId);
        const existing = await this.prisma.assets.findFirst({ where: { id, organization_id: await this.orgId(), AND: [limit.where] } });
        if (!existing) throw new NotFoundException("Not found");
        this.assertClientAllowed(limit.scope, input.clientId);
        await this.requireClient(input.clientId, existing.organization_id);
        const data = this.assetData(input);
        const moved = dateOnly(existing.expires_at) !== dateOnly(data.expires_at);
        await this.prisma.assets.update({
            where: { id },
            data: {
                ...data,
                client_id: input.clientId,
                // A new expiry date earns its notices again.
                ...(moved ? { expiry_notice_days: null } : {}),
            },
        });
        return { id };
    }

    async deleteAsset(id: string, userId?: string | null) {
        await this.assets.assertBuiltin();
        const existing = await this.prisma.assets.findFirst({ where: { id, organization_id: await this.orgId(), AND: [(await this.assetScope(userId)).where] } });
        if (!existing) throw new NotFoundException("Not found");
        if (existing.device_id) throw new ConflictException("This record comes from a device with an agent. Remove the device instead.");
        await this.prisma.$transaction([
            this.prisma.entity_links.deleteMany({ where: { OR: [{ a_type: "asset", a_id: id }, { b_type: "asset", b_id: id }] } }),
            this.prisma.assets.delete({ where: { id } }),
        ]);
        return { id, deleted: true };
    }

    /**
     * Keeps one asset record per device with an agent. Only what the agent reports is overwritten, so
     * a technician's location, warranty date and notes survive every sync.
     */
    async syncFromAgents(): Promise<{ created: number; updated: number }> {
        await this.assets.assertBuiltin();
        const devices = await this.prisma.devices.findMany({
            where: { agents: { isNot: null }, sites: { isNot: null } },
            select: {
                id: true,
                hostname: true,
                alias: true,
                serial_number: true,
                operating_system: true,
                sites: { select: { client_id: true, clients: { select: { organization_id: true } } } },
                agents: { select: { facts: true } },
            },
        });
        const existing = await this.prisma.assets.findMany({ where: { device_id: { in: devices.map((d) => d.id) } }, select: { id: true, device_id: true } });
        const byDevice = new Map(existing.map((a) => [a.device_id, a.id]));

        let created = 0;
        let updated = 0;
        for (const device of devices) {
            const facts = (device.agents?.facts ?? {}) as Record<string, any>;
            const hw = (facts.device ?? {}) as Record<string, any>;
            const os = String(device.operating_system ?? facts.os ?? "");
            const data = {
                name: device.alias || device.hostname,
                client_id: device.sites!.client_id,
                model: hw.model ?? hw.Model ?? null,
                serial_number: device.serial_number ?? hw.serial ?? hw.Serial ?? null,
                details: {
                    os: os || null,
                    cpu: hw.cpu ?? hw.Cpu ?? null,
                    ram: hw.ram ?? hw.Ram ?? null,
                } as Prisma.InputJsonValue,
                last_synced_at: new Date(),
                updated_at: new Date(),
            };
            const id = byDevice.get(device.id);
            if (id) {
                await this.prisma.assets.update({ where: { id }, data });
                updated++;
            } else {
                await this.prisma.assets.create({
                    data: {
                        ...data,
                        organization_id: device.sites!.clients.organization_id,
                        device_id: device.id,
                        kind: /server/i.test(os) ? "server" : "computer",
                        source: "agent",
                    },
                });
                created++;
            }
        }
        return { created, updated };
    }

    /* ------------------------------ expiry ------------------------------ */

    /** Everything with a date that runs out: warranties, licences, domains and certificates. */
    async expiring(days = 90, userId?: string | null) {
        const organizationId = await this.orgId();
        const limit = await this.assetScope(userId);
        const until = new Date(Date.now() + days * 86_400_000);
        const builtin = await this.assets.isBuiltin();
        const assets = !builtin ? [] : await this.prisma.assets.findMany({
            where: { organization_id: organizationId, expires_at: { not: null, lte: until }, AND: [limit.where] },
            orderBy: { expires_at: "asc" },
            take: 500,
            include: { clients: { select: { id: true, name: true } } },
        });
        const items = assets
            .map((a) => ({ type: "asset" as const, id: a.id, name: a.name, kind: a.kind, client: a.clients.name, expiresAt: dateOnly(a.expires_at)! }))
            .sort((x, y) => x.expiresAt.localeCompare(y.expiresAt));
        return { items };
    }

    /** Emails the alert recipients when something crosses 30, 7 or 1 days, once per threshold. */
    async sendExpiryNotices(now = new Date()): Promise<{ notified: number; sent: boolean }> {
        // when another system owns assets, it owns the expiry notices too
        if (!(await this.assets.isBuiltin())) return { notified: 0, sent: false };
        const horizon = new Date(now.getTime() + 30 * 86_400_000);
        const due = await this.prisma.assets.findMany({
            where: { expires_at: { not: null, lte: horizon } },
            include: { clients: { select: { name: true } } },
        });

        const toNotify = due
            .map((asset) => {
                const daysLeft = Math.ceil((asset.expires_at!.getTime() - now.getTime()) / 86_400_000);
                const threshold = NOTICE_DAYS.filter((d) => daysLeft <= d).pop() ?? 30;
                return { asset, daysLeft, threshold };
            })
            .filter(({ asset, threshold }) => asset.expiry_notice_days === null || threshold < asset.expiry_notice_days);
        if (toNotify.length === 0) return { notified: 0, sent: false };

        const channels = await this.prisma.notification_channels.findMany({ where: { kind: "email", enabled: true } });
        const recipients = Array.from(new Set(channels.flatMap((c) => ((c.config as any)?.recipients ?? []) as string[])));
        if (recipients.length === 0) return { notified: 0, sent: false };

        const lines = toNotify
            .sort((a, b) => a.daysLeft - b.daysLeft)
            .map(({ asset, daysLeft }) => `${asset.clients.name}: ${asset.name} (${asset.kind}) ${daysLeft < 0 ? `expired ${-daysLeft} days ago` : daysLeft === 0 ? "expires today" : `expires in ${daysLeft} days`}, on ${dateOnly(asset.expires_at)}`);

        const result = await this.smtp.sendWithAttachment("alerts", recipients.join(", "), `${toNotify.length} item${toNotify.length === 1 ? "" : "s"} expiring soon`, lines.join("\n"));
        // Marked only once sent, so a mail problem means it tries again rather than staying silent.
        if (!result.ok) {
            this.logger.warn(`Could not send expiry notices: ${result.result}`);
            return { notified: 0, sent: false };
        }
        for (const { asset, threshold } of toNotify) {
            await this.prisma.assets.update({ where: { id: asset.id }, data: { expiry_notice_days: threshold } });
        }
        return { notified: toNotify.length, sent: true };
    }

    @Interval(SYNC_EVERY_MS)
    async hourly(): Promise<void> {
        if (this.syncing) return;
        this.syncing = true;
        try {
            if (!(await this.assets.isBuiltin())) return;
            await this.syncFromAgents();
            await this.sendExpiryNotices();
        } catch (err) {
            this.logger.error(`Asset sync failed: ${(err as Error).message}`);
        } finally {
            this.syncing = false;
        }
    }

    /* ------------------------------ links ------------------------------ */

    private ordered(aType: string, aId: string, bType: string, bId: string) {
        return `${aType}:${aId}` < `${bType}:${bId}`
            ? { a_type: aType, a_id: aId, b_type: bType, b_id: bId }
            : { a_type: bType, a_id: bId, b_type: aType, b_id: aId };
    }

    /** The other side has to exist, in this organization, so a link can never expose or point at nothing. */
    private async describe(type: string, id: string, organizationId: string): Promise<{ type: string; id: string; label: string } | null> {
        if (type === "ticket") {
            const t = await this.prisma.tickets.findUnique({ where: { id }, select: { ticket_number: true, subject: true } });
            return t && { type, id, label: `#${t.ticket_number} ${t.subject}` };
        }
        if (type === "device") {
            const d = await this.prisma.devices.findUnique({ where: { id }, select: { hostname: true, alias: true } });
            return d && { type, id, label: d.alias || d.hostname };
        }
        if (type === "asset") {
            const a = await this.prisma.assets.findFirst({ where: { id, organization_id: organizationId }, select: { name: true } });
            return a && { type, id, label: a.name };
        }
        return null;
    }

    async listLinks(type: string, id: string) {
        const organizationId = await this.orgId();
        const rows = await this.prisma.entity_links.findMany({
            where: { organization_id: organizationId, OR: [{ a_type: type, a_id: id }, { b_type: type, b_id: id }] },
            orderBy: { created_at: "asc" },
        });
        const items: Array<{ linkId: string; type: string; id: string; label: string }> = [];
        for (const row of rows) {
            const other = row.a_type === type && row.a_id === id ? { type: row.b_type, id: row.b_id } : { type: row.a_type, id: row.a_id };
            const described = await this.describe(other.type, other.id, organizationId);
            if (described) items.push({ linkId: row.id, ...described });
        }
        return { items };
    }

    async addLink(input: { fromType: string; fromId: string; toType: string; toId: string }, userId: string | null) {
        const organizationId = await this.orgId();
        if (input.fromType === input.toType && input.fromId === input.toId) throw new BadRequestException("Something cannot link to itself.");
        const [from, to] = await Promise.all([this.describe(input.fromType, input.fromId, organizationId), this.describe(input.toType, input.toId, organizationId)]);
        if (!from || !to) throw new BadRequestException("One of those no longer exists.");

        try {
            const row = await this.prisma.entity_links.create({
                data: { ...this.ordered(input.fromType, input.fromId, input.toType, input.toId), organization_id: organizationId, created_by: userId },
                select: { id: true },
            });
            return { id: row.id };
        } catch (err) {
            if ((err as Prisma.PrismaClientKnownRequestError)?.code === "P2002") throw new ConflictException("These are already linked.");
            throw err;
        }
    }

    async removeLink(linkId: string) {
        const { count } = await this.prisma.entity_links.deleteMany({ where: { id: linkId, organization_id: await this.orgId() } });
        if (!count) throw new NotFoundException("Not found");
        return { id: linkId, deleted: true };
    }

    /** What can be picked when adding a link. Never includes secrets. */
    async linkTargets(type: string, q: string) {
        const organizationId = await this.orgId();
        const term = q.trim();
        const contains = { contains: term, mode: "insensitive" as const };
        if (type === "ticket") {
            const rows = await this.prisma.tickets.findMany({ where: term ? { subject: contains } : {}, orderBy: { created_at: "desc" }, take: 20, select: { id: true, ticket_number: true, subject: true } });
            return { items: rows.map((r) => ({ id: r.id, label: `#${r.ticket_number} ${r.subject}` })) };
        }
        if (type === "device") {
            const rows = await this.prisma.devices.findMany({ where: term ? { hostname: contains } : {}, orderBy: { hostname: "asc" }, take: 20, select: { id: true, hostname: true, alias: true } });
            return { items: rows.map((r) => ({ id: r.id, label: r.alias || r.hostname })) };
        }
        if (type === "asset") {
            const rows = await this.prisma.assets.findMany({ where: { organization_id: organizationId, ...(term ? { name: contains } : {}) }, orderBy: { name: "asc" }, take: 20, select: { id: true, name: true } });
            return { items: rows.map((r) => ({ id: r.id, label: r.name })) };
        }
        throw new BadRequestException("Unknown type.");
    }
}
