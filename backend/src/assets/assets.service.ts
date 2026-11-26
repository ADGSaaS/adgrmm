// backend/src/assets/assets.service.ts
//
// Who owns assets, and the operations the rest of ADG RMM needs from whoever does. The built-in asset manager is the default. When the
// owner switches to an external one (Killian), the built-in one is switched OFF: assertBuiltin() makes its endpoints answer "managed
// elsewhere", the hourly sync and the expiry emails stop, reports use their fallbacks, and nothing is deleted, so switching back loses nothing.
// The external provider has no adapter yet (it waits for Killian's API): while it is on, ADG RMM simply does not offer asset features.
import { BadRequestException, ConflictException, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../storage/prisma.service";
import { OrganizationContextService } from "../storage/organization-context.service";
import { EXTERNAL_DEFAULT_NAME, type AssetLink, type AssetProviderId, type AssetSettings, type DeviceAssetInfo, type HostAsset } from "./asset-provider";

type SettingsRow = { provider: string; external_name: string | null; external_url: string | null; changed_by: string | null; changed_at: Date };

/** The asset type of the built-in asset manager that fits what a host probably is. */
export function assetKindOf(guess: string): string {
    if (guess === "printer") return "printer";
    if (guess === "network" || guess === "switch") return "network";
    if (guess === "windows" || guess === "linux" || guess === "virtual") return "computer";
    return "other";
}

const csvCell = (v: unknown) => {
    const s = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    // a cell that starts like a formula is made text, so opening the file in a spreadsheet runs nothing
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

@Injectable()
export class AssetsService {
    constructor(private readonly prisma: PrismaService, private readonly orgs: OrganizationContextService) { }

    /* ------------------------------ who owns assets ------------------------------ */

    async settings(): Promise<AssetSettings> {
        const orgId = await this.orgs.getDefaultOrganizationId();
        const r = (await this.prisma.$queryRaw<SettingsRow[]>`SELECT provider, external_name, external_url, changed_by::text AS changed_by, changed_at FROM public.asset_provider_settings WHERE organization_id = ${orgId}::uuid`)[0];
        return r
            ? { provider: r.provider === "external" ? "external" : "builtin", externalName: r.external_name, externalUrl: r.external_url, changedAt: r.changed_at.toISOString(), changedBy: r.changed_by }
            : { provider: "builtin", externalName: null, externalUrl: null, changedAt: null, changedBy: null };
    }

    async isBuiltin(): Promise<boolean> {
        return (await this.settings()).provider === "builtin";
    }

    /** What people are told when the built-in asset manager is off. */
    async externalMessage(): Promise<{ code: "assets_external"; message: string; url: string | null; name: string }> {
        const s = await this.settings();
        const name = s.externalName || EXTERNAL_DEFAULT_NAME;
        return { code: "assets_external", message: `Assets are managed in ${name}.`, url: s.externalUrl, name };
    }

    /** Throws a 409 that says where assets are managed, when the built-in asset manager is switched off. */
    async assertBuiltin(): Promise<void> {
        if (!(await this.isBuiltin())) throw new ConflictException(await this.externalMessage());
    }

    /** The switch. Needs the person to have confirmed; nothing is deleted either way. */
    async setProvider(userId: string | null, input: { provider?: string; externalName?: string | null; externalUrl?: string | null; confirm?: boolean }): Promise<AssetSettings> {
        if (input.provider !== "builtin" && input.provider !== "external") throw new BadRequestException("The asset manager must be builtin or external.");
        if (input.confirm !== true) throw new BadRequestException("Confirm the change first. Look at what it changes, then confirm.");
        let name: string | null = null, url: string | null = null;
        if (input.provider === "external") {
            name = String(input.externalName ?? "").trim();
            if (!name || name.length > 60) throw new BadRequestException("Say what the other asset manager is called (up to 60 characters).");
            url = String(input.externalUrl ?? "").trim() || null;
            if (url) {
                try { const u = new URL(url); if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error(); } catch { throw new BadRequestException("The address must be a web address starting with https:// or http://."); }
                if (url.length > 300) throw new BadRequestException("The address is too long.");
            }
        }
        const orgId = await this.orgs.getDefaultOrganizationId();
        await this.prisma.$executeRaw`
            INSERT INTO public.asset_provider_settings (organization_id, provider, external_name, external_url, changed_by, changed_at)
            VALUES (${orgId}::uuid, ${input.provider}, ${name}, ${url}, ${userId}::uuid, now())
            ON CONFLICT (organization_id) DO UPDATE SET provider = EXCLUDED.provider, external_name = EXCLUDED.external_name, external_url = EXCLUDED.external_url, changed_by = EXCLUDED.changed_by, changed_at = now()`;
        return this.settings();
    }

    /** What switching would change, for the confirmation screen. */
    async preflight() {
        const orgId = await this.orgs.getDefaultOrganizationId();
        const r = (await this.prisma.$queryRaw<Array<{ total: number; with_device: number; with_warranty: number; expiring_30: number; manual: number }>>`
            SELECT count(*)::int AS total, count(device_id)::int AS with_device, count(expires_at)::int AS with_warranty,
                   count(*) FILTER (WHERE expires_at IS NOT NULL AND expires_at <= now() + interval '30 days')::int AS expiring_30,
                   count(*) FILTER (WHERE source = 'manual')::int AS manual
              FROM public.assets WHERE organization_id = ${orgId}::uuid`)[0];
        const linked = (await this.prisma.$queryRaw<Array<{ hosts: number; snmp: number }>>`
            SELECT (SELECT count(*)::int FROM public.discovered_hosts WHERE asset_ref IS NOT NULL) AS hosts, (SELECT count(*)::int FROM public.snmp_devices WHERE asset_ref IS NOT NULL) AS snmp`)[0];
        return {
            assets: r.total, fromAgents: r.with_device, enteredByHand: r.manual, withWarrantyDate: r.with_warranty, expiringWithin30Days: r.expiring_30,
            linkedHosts: linked.hosts, linkedSnmpDevices: linked.snmp,
            willStop: ["The built-in asset list, create, change and delete (they answer that assets are managed elsewhere)", "The hourly fill-in of assets from agents", "The warranty and licence expiry emails"],
            staysTheSame: ["The built-in records (nothing is deleted; switching back brings everything back)", "Reports: hardware age and warranty fall back to the firmware date the agent reports", "Everything else in ADG RMM"],
        };
    }

    /** Every built-in asset, for importing into the other asset manager. The keys (customer id, device id, serial number) are what a match is made on. */
    async export(format: "json" | "csv"): Promise<{ contentType: string; filename: string; body: string }> {
        const orgId = await this.orgs.getDefaultOrganizationId();
        const rows = await this.prisma.assets.findMany({ where: { organization_id: orgId }, include: { clients: { select: { id: true, name: true } } }, orderBy: [{ client_id: "asc" }, { name: "asc" }], take: 100_000 });
        const items = rows.map((a) => ({
            id: a.id, customerId: a.client_id, customer: a.clients.name, deviceId: a.device_id, name: a.name, kind: a.kind, manufacturer: a.manufacturer, model: a.model,
            serialNumber: a.serial_number, location: a.location, purchaseDate: a.purchase_date?.toISOString().slice(0, 10) ?? null, expiresAt: a.expires_at?.toISOString().slice(0, 10) ?? null,
            notes: a.notes, source: a.source, details: a.details,
        }));
        const stamp = new Date().toISOString().slice(0, 10);
        if (format === "json") return { contentType: "application/json; charset=utf-8", filename: `adgrmm-assets-${stamp}.json`, body: JSON.stringify({ exportedAt: new Date().toISOString(), count: items.length, assets: items }, null, 2) };
        const cols = ["id", "customerId", "customer", "deviceId", "name", "kind", "manufacturer", "model", "serialNumber", "location", "purchaseDate", "expiresAt", "notes", "source", "details"] as const;
        return { contentType: "text/csv; charset=utf-8", filename: `adgrmm-assets-${stamp}.csv`, body: [cols.join(","), ...items.map((i) => cols.map((c) => csvCell((i as any)[c])).join(","))].join("\r\n") + "\r\n" };
    }

    /* ------------------------------ what the rest of ADG RMM asks ------------------------------ */

    /** Purchase and warranty dates of devices' assets, for the reports. Empty while assets are external: the reports then use their fallbacks. */
    async deviceAssetInfos(deviceIds: string[]): Promise<Map<string, DeviceAssetInfo>> {
        const out = new Map<string, DeviceAssetInfo>();
        if (!deviceIds.length || !(await this.isBuiltin())) return out;
        const rows = await this.prisma.assets.findMany({ where: { device_id: { in: deviceIds } }, select: { id: true, device_id: true, purchase_date: true, expires_at: true } });
        for (const a of rows) if (a.device_id) out.set(a.device_id, { ref: a.id, purchaseDate: a.purchase_date, warrantyEnd: a.expires_at });
        return out;
    }

    /** A device moved to another customer takes its asset along. Inside the move's own transaction. */
    async moveToCustomer(tx: Prisma.TransactionClient, deviceId: string, clientId: string, at: Date): Promise<void> {
        if (!(await this.isBuiltin())) return;
        await tx.assets.updateMany({ where: { device_id: deviceId }, data: { client_id: clientId, updated_at: at } });
    }

    /** Records a host with no agent as an asset (or finds the one that already is). A host already linked keeps its link. */
    async registerHost(h: HostAsset): Promise<AssetLink> {
        await this.assertBuiltin();
        const site = await this.prisma.sites.findUnique({ where: { id: h.siteId }, select: { client_id: true } });
        if (!site) throw new BadRequestException("That site does not exist.");
        const clientId = site.client_id;
        // the same MAC (or, without one, the same address) at the same customer is the same thing
        const existing = h.mac
            ? await this.prisma.$queryRaw<Array<{ id: string }>>`SELECT id::text AS id FROM public.assets WHERE client_id = ${clientId}::uuid AND details->>'mac' = ${h.mac} AND device_id IS NULL LIMIT 1`
            : await this.prisma.$queryRaw<Array<{ id: string }>>`SELECT id::text AS id FROM public.assets WHERE client_id = ${clientId}::uuid AND details->>'ip' = ${h.ip} AND details->>'mac' IS NULL AND device_id IS NULL AND source = ${h.source} LIMIT 1`;
        if (existing[0]) return { provider: "builtin", ref: existing[0].id, alreadyLinked: true };
        const row = await this.prisma.assets.create({
            data: {
                organization_id: h.organizationId, client_id: clientId, name: h.name.slice(0, 200), kind: assetKindOf(h.guess), manufacturer: h.vendor, source: h.source,
                notes: h.description ? h.description.slice(0, 500) : null,
                details: { ip: h.ip, mac: h.mac, vendor: h.vendor, ports: h.ports, guess: h.guess, recordedFrom: h.source === "snmp" ? "SNMP monitoring" : "network discovery" } as Prisma.InputJsonValue,
            },
            select: { id: true },
        });
        return { provider: "builtin", ref: row.id, alreadyLinked: false };
    }
}

export { csvCell };
