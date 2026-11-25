// backend/src/edr/edr.service.ts
//
// EDR and antivirus consoles: the connections an administrator keeps (credentials encrypted, never shown again), the reading every half hour,
// matching what each console reports to RemoteIQ's devices, a coverage view (which devices are protected and well, which are not known to any
// console, which console endpoints are not managed here) and an alert for a matched device whose protection is unhealthy.
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { Prisma } from "@prisma/client";
import { AlertsService } from "../alerts/alerts.service";
import { isCanonicalUuid } from "../common/agent-lookup.util";
import { decryptSecret, encryptSecret } from "../common/secret-box";
import { ClientAccessService, deviceSqlOf } from "../reports/client-access.service";
import { OrganizationContextService } from "../storage/organization-context.service";
import { PrismaService } from "../storage/prisma.service";
import { EdrError, fetchEndpoints } from "./edr.adapters";
import { MAX_CONNECTIONS, VENDORS, cleanConnection, coverageOf, matchEndpoints, type DeviceRef, type Health, type Vendor } from "./edr.core";

export type Actor = { id: string | null; organizationId?: string | null };
const EVERY_MS = 30 * 60_000;
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

type ConnRow = { id: string; vendor: Vendor; name: string; client_id: string | null; client_name: string | null; config: Record<string, string>; status: string; last_error: string | null; last_synced_at: Date | null; requested_at: Date | null; endpoint_count: number };

@Injectable()
export class EdrService {
    private readonly logger = new Logger(EdrService.name);
    private busy = false;

    constructor(
        private readonly prisma: PrismaService,
        private readonly orgs: OrganizationContextService,
        private readonly access: ClientAccessService,
        private readonly alerts: AlertsService,
    ) { }

    private async orgOf(actor: Actor) { return actor.organizationId || (await this.orgs.getDefaultOrganizationId()); }

    vendors() { return { vendors: VENDORS }; }

    /* ------------------------------ connections ------------------------------ */

    private present(r: ConnRow) {
        return {
            id: r.id, vendor: r.vendor, vendorName: VENDORS.find((v) => v.key === r.vendor)?.label ?? r.vendor, name: r.name, clientId: r.client_id, customer: r.client_name,
            // the non-secret part of the settings, so it can be edited; the secret is never sent back
            config: r.config, status: r.status, error: r.last_error, endpoints: r.endpoint_count, lastSyncedAt: iso(r.last_synced_at),
            syncing: !!r.requested_at && (!r.last_synced_at || r.requested_at > r.last_synced_at) && Date.now() - r.requested_at.getTime() < 5 * 60_000,
        };
    }

    private async connRows(actor: Actor, id?: string): Promise<ConnRow[]> {
        const org = await this.orgOf(actor);
        const rows = await this.prisma.$queryRaw<ConnRow[]>(Prisma.sql`
            SELECT e.id::text AS id, e.vendor, e.name, e.client_id::text AS client_id, c.name AS client_name, e.config, e.status, e.last_error, e.last_synced_at, e.requested_at, e.endpoint_count
              FROM public.edr_connections e LEFT JOIN public.clients c ON c.id = e.client_id
             WHERE e.organization_id = ${org}::uuid ${id ? Prisma.sql`AND e.id = ${id}::uuid` : Prisma.empty} ORDER BY lower(e.name)`);
        const allowed = await this.access.allowedFor(actor.id);
        // a console that covers every customer is not for a person who may only see some of them
        return allowed ? rows.filter((r) => r.client_id && allowed.includes(r.client_id)) : rows;
    }

    async list(actor: Actor) { return { items: (await this.connRows(actor)).map((r) => this.present(r)) }; }

    private async one(actor: Actor, id: string) {
        if (!isCanonicalUuid(id)) throw new NotFoundException("Connection not found");
        const r = (await this.connRows(actor, id))[0];
        if (!r) throw new NotFoundException("Connection not found");
        return r;
    }

    private async checkClient(actor: Actor, clientId: unknown): Promise<string | null> {
        const allowed = await this.access.allowedFor(actor.id);
        if (clientId === undefined || clientId === null || clientId === "") {
            if (allowed) throw new BadRequestException("Choose the customer this console is for.");
            return null;
        }
        const id = String(clientId);
        if (!isCanonicalUuid(id)) throw new BadRequestException("Choose a customer.");
        const org = await this.orgOf(actor);
        if (!(await this.prisma.clients.findFirst({ where: { id, organization_id: org }, select: { id: true } }))) throw new BadRequestException("That customer does not exist.");
        this.access.assertClient(allowed, id);
        return id;
    }

    async create(actor: Actor, input: Record<string, unknown>) {
        const c = cleanConnection(input, { editing: false });
        const org = await this.orgOf(actor);
        const clientId = await this.checkClient(actor, input.clientId);
        const [{ n }] = await this.prisma.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM public.edr_connections WHERE organization_id = ${org}::uuid`;
        if (n >= MAX_CONNECTIONS) throw new BadRequestException(`There can be ${MAX_CONNECTIONS} connections at most.`);
        let id: string;
        try {
            id = (await this.prisma.$queryRaw<Array<{ id: string }>>`INSERT INTO public.edr_connections (organization_id, client_id, vendor, name, config, secret_enc, created_by)
                VALUES (${org}::uuid, ${clientId}::uuid, ${c.vendor}, ${c.name}, ${JSON.stringify(c.config)}::jsonb, ${encryptSecret(c.secret!)}, ${actor.id}::uuid) RETURNING id::text AS id`)[0].id;
        } catch (e: any) {
            if (/23505/.test(`${e?.meta?.code ?? ""} ${e?.message ?? ""}`)) throw new ConflictException("There is already a connection with that name.");
            throw e;
        }
        void this.sync(id).catch((e) => this.logger.warn(`First reading of ${c.name} failed: ${(e as Error).message}`));
        return this.present(await this.one(actor, id));
    }

    async update(actor: Actor, id: string, input: Record<string, unknown>) {
        const cur = await this.one(actor, id);
        const c = cleanConnection({ ...cur.config, name: cur.name, ...input }, { editing: true, vendor: cur.vendor });
        const clientId = input.clientId !== undefined ? await this.checkClient(actor, input.clientId) : cur.client_id;
        try {
            await this.prisma.$executeRaw`UPDATE public.edr_connections SET name = ${c.name}, config = ${JSON.stringify(c.config)}::jsonb, client_id = ${clientId}::uuid, updated_at = now() WHERE id = ${id}::uuid`;
        } catch (e: any) {
            if (/23505/.test(`${e?.meta?.code ?? ""} ${e?.message ?? ""}`)) throw new ConflictException("There is already a connection with that name.");
            throw e;
        }
        if (c.secret) await this.prisma.$executeRaw`UPDATE public.edr_connections SET secret_enc = ${encryptSecret(c.secret)} WHERE id = ${id}::uuid`;
        void this.sync(id).catch(() => undefined);
        return this.present(await this.one(actor, id));
    }

    async remove(actor: Actor, id: string) {
        await this.one(actor, id);
        const devices = await this.prisma.$queryRaw<Array<{ device_id: string }>>`SELECT DISTINCT device_id::text AS device_id FROM public.edr_endpoints WHERE connection_id = ${id}::uuid AND device_id IS NOT NULL`;
        await this.prisma.$executeRaw`DELETE FROM public.edr_connections WHERE id = ${id}::uuid`;
        for (const d of devices) await this.alerts.clear(`edr:${d.device_id}:${id}`, "The console was disconnected.").catch(() => undefined);
        return { ok: true };
    }

    async syncNow(actor: Actor, id: string) {
        await this.one(actor, id);
        await this.sync(id);
        return this.present(await this.one(actor, id));
    }

    /* ------------------------------ reading ------------------------------ */

    @Interval(300_000)
    async tick(): Promise<void> {
        if ((process.env.EDR_SYNC ?? "").toLowerCase() === "false" || this.busy) return;
        this.busy = true;
        try {
            const due = await this.prisma.$queryRaw<Array<{ id: string }>>`SELECT id::text AS id FROM public.edr_connections
                WHERE (last_synced_at IS NULL OR last_synced_at < now() - ${EVERY_MS / 1000} * interval '1 second') AND (requested_at IS NULL OR requested_at < now() - interval '10 minutes') ORDER BY last_synced_at NULLS FIRST LIMIT 5`;
            for (const d of due) await this.sync(d.id).catch((e) => this.logger.warn(`Reading a console failed: ${(e as Error).message}`));
        } finally { this.busy = false; }
    }

    async sync(id: string): Promise<void> {
        const c = (await this.prisma.$queryRaw<Array<{ vendor: Vendor; config: Record<string, string>; secret_enc: string; organization_id: string; client_id: string | null; name: string }>>`
            SELECT vendor, config, secret_enc, organization_id::text AS organization_id, client_id::text AS client_id, name FROM public.edr_connections WHERE id = ${id}::uuid`)[0];
        if (!c) return;
        await this.prisma.$executeRaw`UPDATE public.edr_connections SET requested_at = now() WHERE id = ${id}::uuid`;
        try {
            const endpoints = await fetchEndpoints(c.vendor, c.config, decryptSecret(c.secret_enc));
            const devices = await this.prisma.$queryRaw<Array<{ id: string; hostname: string; alias: string | null; serial_number: string | null; client_id: string | null }>>`
                SELECT d.id::text AS id, d.hostname, d.alias, d.serial_number, s.client_id::text AS client_id FROM public.devices d JOIN public.sites s ON s.id = d.site_id JOIN public.clients cl ON cl.id = s.client_id WHERE cl.organization_id = ${c.organization_id}::uuid`;
            const refs: DeviceRef[] = devices.map((d) => ({ id: d.id, hostname: d.hostname, alias: d.alias, serial: d.serial_number, clientId: d.client_id }));
            const matched = matchEndpoints(endpoints, refs, c.client_id);
            const before = await this.prisma.$queryRaw<Array<{ device_id: string }>>`SELECT DISTINCT device_id::text AS device_id FROM public.edr_endpoints WHERE connection_id = ${id}::uuid AND device_id IS NOT NULL`;
            await this.prisma.$transaction(async (tx) => {
                await tx.$executeRaw`DELETE FROM public.edr_endpoints WHERE connection_id = ${id}::uuid`;
                for (const e of endpoints) {
                    await tx.$executeRaw`INSERT INTO public.edr_endpoints (connection_id, vendor_id, hostname, serial, os, agent_version, last_seen_at, health, health_detail, threats, device_id)
                        VALUES (${id}::uuid, ${e.vendorId}, ${e.hostname.slice(0, 253)}, ${e.serial}, ${e.os}, ${e.agentVersion}, ${e.lastSeenAt}, ${e.health}, ${e.detail.slice(0, 400)}, ${e.threats}, ${matched.get(e.vendorId) ?? null}::uuid)
                        ON CONFLICT (connection_id, vendor_id) DO NOTHING`;
                }
                await tx.$executeRaw`UPDATE public.edr_connections SET status = 'ok', last_error = NULL, last_synced_at = now(), endpoint_count = ${endpoints.length}, updated_at = now() WHERE id = ${id}::uuid`;
            });
            await this.syncAlerts(id, c.name, endpoints.map((e) => ({ ...e, deviceId: matched.get(e.vendorId) ?? null })), before.map((b) => b.device_id));
        } catch (e) {
            const message = e instanceof EdrError ? e.message : `The console could not be read (${(e as Error).message}).`;
            await this.prisma.$executeRaw`UPDATE public.edr_connections SET status = 'error', last_error = ${message.slice(0, 400)}, last_synced_at = now(), updated_at = now() WHERE id = ${id}::uuid`;
        }
    }

    /** A device whose protection is unhealthy is an alert; it clears when the console says it is fine again (or no longer lists it). */
    private async syncAlerts(connId: string, connName: string, endpoints: Array<{ hostname: string; health: Health; detail: string; deviceId: string | null }>, was: string[]) {
        const unhealthy = new Map<string, { hostname: string; detail: string }>();
        for (const e of endpoints) if (e.deviceId && e.health === "unhealthy") unhealthy.set(e.deviceId, { hostname: e.hostname, detail: e.detail });
        for (const [deviceId, e] of unhealthy) {
            await this.alerts.raise({ deviceId, kind: "edr", dedupeKey: `edr:${deviceId}:${connId}`, severity: "WARN", title: `Endpoint protection is unhealthy on ${e.hostname}`, detail: `${connName}: ${e.detail}` }).catch((err) => this.logger.warn(`EDR alert failed: ${(err as Error).message}`));
        }
        const now = new Set(endpoints.filter((e) => e.deviceId).map((e) => e.deviceId as string));
        for (const deviceId of new Set([...was, ...now])) if (!unhealthy.has(deviceId)) await this.alerts.clear(`edr:${deviceId}:${connId}`, "The console reports the protection as fine.").catch(() => undefined);
    }

    /* ------------------------------ coverage ------------------------------ */

    /** Every device with an agent, what the consoles say about it, and the endpoints that no device here matches. */
    async coverage(actor: Actor, filter: { clientId?: string; q?: string } = {}) {
        const org = await this.orgOf(actor);
        const scope = await this.access.scopeFor(actor.id);
        const where: Prisma.Sql[] = [Prisma.sql`c.organization_id = ${org}::uuid`];
        if (scope) where.push(deviceSqlOf(scope, { client: Prisma.sql`c.id::text`, site: Prisma.sql`s.id::text`, id: Prisma.sql`d.id::text` }));
        if (filter.clientId && isCanonicalUuid(filter.clientId)) where.push(Prisma.sql`c.id = ${filter.clientId}::uuid`);
        if (filter.q?.trim()) { const like = `%${filter.q.trim().replace(/[%_\\]/g, "\\$&")}%`; where.push(Prisma.sql`(d.hostname ILIKE ${like} OR d.alias ILIKE ${like})`); }
        const devices = await this.prisma.$queryRaw<Array<{ id: string; name: string; customer: string | null; client_id: string | null; site: string | null; windows: boolean; online: boolean }>>(Prisma.sql`
            SELECT d.id::text AS id, COALESCE(d.alias, d.hostname) AS name, c.name AS customer, c.id::text AS client_id, s.name AS site,
                   (lower(COALESCE(a.facts->>'os', d.operating_system, '')) LIKE 'windows%') AS windows, COALESCE(a.last_check_in_at > now() - interval '10 minutes', false) AS online
              FROM public.devices d JOIN public.sites s ON s.id = d.site_id JOIN public.clients c ON c.id = s.client_id JOIN public.agents a ON a.device_id = d.id
             WHERE ${Prisma.join(where, " AND ")} ORDER BY c.name, lower(COALESCE(d.alias, d.hostname)) LIMIT 3000`);
        const ids = devices.map((d) => d.id);
        const eps = ids.length ? await this.prisma.$queryRaw<Array<{ device_id: string; vendor: Vendor; connection: string; health: Health; detail: string | null; last_seen_at: Date | null; agent_version: string | null }>>`
            SELECT e.device_id::text AS device_id, k.vendor, k.name AS connection, e.health, e.health_detail AS detail, e.last_seen_at, e.agent_version
              FROM public.edr_endpoints e JOIN public.edr_connections k ON k.id = e.connection_id WHERE e.device_id = ANY(${ids}::uuid[])` : [];
        const by = new Map<string, typeof eps>();
        for (const e of eps) by.set(e.device_id, [...(by.get(e.device_id) ?? []), e]);
        const connections = await this.connRows(actor);
        const items = devices.map((d) => {
            const products = (by.get(d.id) ?? []).map((p) => ({ vendor: p.vendor, vendorName: VENDORS.find((v) => v.key === p.vendor)?.label ?? p.vendor, connection: p.connection, health: p.health, detail: p.detail ?? "", lastSeenAt: iso(p.last_seen_at), agentVersion: p.agent_version }));
            return { deviceId: d.id, name: d.name, customer: d.customer, clientId: d.client_id, site: d.site, os: d.windows ? "windows" : "linux", online: d.online, verdict: coverageOf(products.map((p) => ({ ...p, lastSeenAt: null }))), products };
        });
        const count = (v: string) => items.filter((i) => i.verdict === v).length;
        const covered = items.length - count("none");
        // endpoints the consoles know that no device here matches (not for a limited person: they would see other customers' computers)
        const unmatched = scope ? [] : await this.prisma.$queryRaw<Array<{ hostname: string; connection: string; vendor: Vendor; health: Health; last_seen_at: Date | null }>>`
            SELECT e.hostname, k.name AS connection, k.vendor, e.health, e.last_seen_at FROM public.edr_endpoints e JOIN public.edr_connections k ON k.id = e.connection_id
             WHERE k.organization_id = ${org}::uuid AND e.device_id IS NULL ${filter.clientId && isCanonicalUuid(filter.clientId) ? Prisma.sql`AND k.client_id = ${filter.clientId}::uuid` : Prisma.empty} ORDER BY lower(e.hostname) LIMIT 200`;
        return {
            connections: connections.map((r) => this.present(r)),
            summary: { total: items.length, healthy: count("healthy"), warning: count("warning"), unhealthy: count("unhealthy"), unknown: count("unknown"), none: count("none"), coveredPercent: items.length ? Math.round((100 * covered) / items.length) : null },
            items,
            unmatched: unmatched.map((u) => ({ hostname: u.hostname, connection: u.connection, vendor: u.vendor, health: u.health, lastSeenAt: iso(u.last_seen_at) })),
        };
    }
}
