// FILE: remoteiq-minimal-e2e/backend/src/customers/customers.service.ts

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../storage/prisma.service";
import { isCanonicalUuid } from "../common/agent-lookup.util";
import { PoliciesService } from "../policies/policies.service";
import { CustomFieldsService } from "./custom-fields.service";
import { cleanProfile, cleanSite, profileColumns, profileView, siteColumns, siteView, versionWindow, type ContactInput } from "./customer-profile";

type Listed = { id: string; name: string | null; counts: Record<string, number> | null; archived?: boolean };

const isRecordNotFound = (e: any) => e?.code === "P2025";

@Injectable()
export class CustomersService {
  constructor(private readonly prisma: PrismaService, private readonly policies: PoliciesService, private readonly customFields: CustomFieldsService) { }

  private isUuid(input: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      input.trim()
    );
  }

  private async resolveClientId(
    clientParam: string,
    organizationId?: string | null
  ): Promise<string | null> {
    const raw = (clientParam ?? "").trim();
    if (!raw) return null;

    // A UUID must exist (and match the org). Ids compare as text, so an uppercase one finds nothing.
    if (this.isUuid(raw)) {
      if (!isCanonicalUuid(raw)) return null;
      const client = await this.prisma.clients.findFirst({
        where: { id: raw, ...(organizationId ? { organization_id: organizationId } : {}) },
        select: { id: true },
      });
      return client?.id ?? null;
    }

    // Prisma's case-insensitive equals is ILIKE, which treats % and _ in the name as wildcards.
    const orgFilter = organizationId
      ? Prisma.sql`AND c.organization_id::text = ${organizationId}`
      : Prisma.empty;
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT c.id::text AS id
      FROM public.clients c
      WHERE lower(c.name) = lower(${raw}) ${orgFilter}
      ORDER BY c.id ASC
      LIMIT 1
    `;
    return rows[0]?.id ?? null;
  }

  private async resolveSiteIdForClient(clientId: string, siteParam: string): Promise<string | null> {
    const raw = (siteParam ?? "").trim();
    if (!raw) return null;

    // A UUID must belong to the client. Ids compare as text, so an uppercase one finds nothing.
    if (this.isUuid(raw)) {
      if (!isCanonicalUuid(raw)) return null;
      const site = await this.prisma.sites.findFirst({
        where: { id: raw, client_id: clientId },
        select: { id: true },
      });
      return site?.id ?? null;
    }

    // Prisma's case-insensitive equals is ILIKE, which treats % and _ in the name as wildcards.
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT s.id::text AS id
      FROM public.sites s
      WHERE s.client_id = ${clientId}::uuid AND lower(s.name) = lower(${raw})
      ORDER BY s.id ASC
      LIMIT 1
    `;
    return rows[0]?.id ?? null;
  }

  private toListItem(r: Listed) {
    return { key: String(r.id), name: String(r.name ?? ""), counts: r.counts ?? {}, archived: r.archived === true };
  }

  /**
   * GET /api/customers?q=term
   */
  /** Throws when a customer is outside the list a limited person may see. Not found, so it does not confirm the customer exists. */
  async assertAllowed(clientParam: string, allowed: string[], organizationId?: string | null) {
    const id = await this.resolveClientId(clientParam, organizationId);
    if (!id || !allowed.includes(id)) throw new NotFoundException("Client not found.");
  }

  async listClients(q: string, organizationId?: string | null, includeArchived = false, allowed: string[] | null = null) {
    const term = (q ?? "").trim();
    const only = allowed ? Prisma.sql`AND c.id::text = ANY(${allowed}::text[])` : Prisma.empty;
    const live = includeArchived ? Prisma.empty : Prisma.sql`AND c.archived_at IS NULL`;

    // A % or _ typed in the box is just a character. The name is searched, and what people saved in the custom fields in use.
    const like = `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    const search = term
      ? Prisma.sql`AND (lower(c.name) LIKE lower(${like}) ESCAPE '\\'
          OR EXISTS (
            SELECT 1 FROM jsonb_each_text(CASE WHEN jsonb_typeof(c.custom_fields) = 'object' THEN c.custom_fields ELSE '{}'::jsonb END) cv
            JOIN public.custom_field_defs cd ON cd.organization_id = c.organization_id AND cd.entity = 'customer' AND cd.key = cv.key AND cd.active
            WHERE cv.value ILIKE ${like} ESCAPE '\\'))`
      : Prisma.empty;
    const org = organizationId
      ? Prisma.sql`AND c.organization_id::text = ${organizationId}`
      : Prisma.empty;

    // Prisma cannot order by lower(name), and the order must follow the database collation.
    const rows = await this.prisma.$queryRaw<Listed[]>`
      SELECT
        c.id::text AS id,
        c.name AS name,
        (c.archived_at IS NOT NULL) AS archived,
        jsonb_build_object(
          'sites', (SELECT count(*)::int FROM public.sites s WHERE s.client_id = c.id),
          'devices', COALESCE(dc.devices, 0),
          -- Online by the same rule the device list uses: the agent (or the device) was heard from in the last 5 minutes.
          'online', COALESCE(dc.online, 0),
          'offline', COALESCE(dc.devices - dc.online, 0),
          -- Devices with an alert that is open and not silenced.
          'alerts', COALESCE(dc.with_alerts, 0),
          'tickets', (SELECT count(*)::int
            FROM public.tickets t
            JOIN public.devices d ON d.id = t.device_id
            JOIN public.sites s ON s.id = d.site_id
           WHERE s.client_id = c.id)
        ) AS counts
      FROM public.clients c
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS devices,
               count(*) FILTER (WHERE x.up)::int AS online,
               count(*) FILTER (WHERE x.has_alert)::int AS with_alerts
          FROM (
            SELECT (CASE WHEN a.id IS NOT NULL THEN a.last_check_in_at > NOW() - INTERVAL '5 minutes' ELSE d.last_seen_at > NOW() - INTERVAL '5 minutes' END) AS up,
                   EXISTS (SELECT 1 FROM public.alerts al WHERE al.device_id = d.id AND al.state = 'OPEN' AND (al.silenced_until IS NULL OR al.silenced_until < NOW())) AS has_alert
              FROM public.devices d
              JOIN public.sites s ON s.id = d.site_id
              LEFT JOIN public.agents a ON a.device_id = d.id
             WHERE s.client_id = c.id
          ) x
      ) dc ON TRUE
      WHERE TRUE ${search} ${org} ${live} ${only}
      ORDER BY lower(c.name) ASC
    `;

    return rows.map((r) => this.toListItem(r));
  }

  /**
   * GET /api/customers/:client/sites
   */
  async listSitesForClient(client: string, organizationId?: string | null) {
    const clientId = await this.resolveClientId(client, organizationId);
    if (!clientId) return [];

    // Prisma cannot order by lower(name), and the order must follow the database collation.
    const rows = await this.prisma.$queryRaw<Listed[]>`
      SELECT
        s.id::text AS id,
        s.name AS name,
        jsonb_build_object(
          'devices', (SELECT count(*)::int FROM public.devices d WHERE d.site_id = s.id),
          'tickets', (SELECT count(*)::int
            FROM public.tickets t
            JOIN public.devices d ON d.id = t.device_id
           WHERE d.site_id = s.id)
        ) AS counts
      FROM public.sites s
      WHERE s.client_id = ${clientId}::uuid
      ORDER BY lower(s.name) ASC
    `;

    return rows.map((r) => this.toListItem(r));
  }

  // =========================
  // ✅ CREATE: CLIENT
  // =========================
  async createClient(body: unknown, organizationId?: string | null) {
    if (!organizationId) {
      throw new BadRequestException("organization_id is required to create a client.");
    }
    const profile = cleanProfile(body, { requireName: true });
    await this.assertNameFree(profile.name!, organizationId);
    // A new customer must have a value for every required custom field.
    const customValues = await this.customFields.valuesToSave(organizationId, profile.customFields, {}, true);

    try {
      const id = await this.prisma.$transaction(async (tx) => {
        const created = await tx.clients.create({
          data: { organization_id: organizationId, ...(profileColumns(profile) as any), custom_fields: (customValues ?? {}) as Prisma.InputJsonValue },
          select: { id: true },
        });
        if (profile.contacts?.length) await this.writeContacts(tx, created.id, profile.contacts);
        return created.id;
      });
      // Policies marked for every new customer are assigned now.
      await this.policies.onCustomerCreated(id, organizationId).catch(() => 0);
      return await this.getProfile(id, organizationId);
    } catch (e: any) {
      if (e?.code === "P2002") throw new ConflictException("Another customer already has that name.");
      throw e;
    }
  }

  /** Names are looked up without regard to case, so two that differ only by case would be ambiguous. */
  private async assertNameFree(name: string, organizationId: string, exceptId?: string) {
    const except = exceptId ? Prisma.sql`AND c.id <> ${exceptId}::uuid` : Prisma.empty;
    const clash = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT c.id::text AS id FROM public.clients c
      WHERE lower(c.name) = lower(${name}) AND c.organization_id::text = ${organizationId} ${except}
      LIMIT 1
    `;
    if (clash.length) throw new ConflictException("Another customer already has that name.");
  }

  private async writeContacts(tx: Prisma.TransactionClient, clientId: string, list: ContactInput[]) {
    const existing = await tx.customer_contacts.findMany({ where: { client_id: clientId }, select: { id: true } });
    const known = new Set(existing.map((e) => e.id));
    for (const c of list) {
      if (c.id && !known.has(c.id)) throw new BadRequestException("One of the contacts does not belong to this customer.");
    }
    const keep = list.filter((c) => c.id).map((c) => c.id as string);
    await tx.customer_contacts.deleteMany({ where: { client_id: clientId, id: { notIn: keep } } });
    for (const c of list) {
      const data = {
        name: c.name, job_title: c.jobTitle, email: c.email, phone: c.phone, mobile: c.mobile,
        role: c.role, is_primary: c.isPrimary, notes: c.notes,
      };
      if (c.id) await tx.customer_contacts.update({ where: { id: c.id }, data: { ...data, updated_at: new Date() } });
      else await tx.customer_contacts.create({ data: { client_id: clientId, ...data } });
    }
  }

  // =========================
  // The whole customer record
  // =========================
  async getProfile(clientParam: string, organizationId?: string | null) {
    const clientId = await this.resolveClientId(clientParam, organizationId);
    if (!clientId) throw new NotFoundException("Client not found.");
    const row = await this.prisma.clients.findUnique({ where: { id: clientId } });
    if (!row) throw new NotFoundException("Client not found.");
    const contacts = await this.prisma.customer_contacts.findMany({
      where: { client_id: clientId },
      orderBy: [{ is_primary: "desc" }, { created_at: "asc" }],
    });
    return profileView(row, contacts);
  }

  /** Change any of the customer's details. Only what is sent changes; a contact list replaces the old one. */
  async updateClient(clientParam: string, body: unknown, organizationId?: string | null) {
    const profile = cleanProfile(body, { requireName: false });
    const clientId = await this.resolveClientId(clientParam, organizationId);
    if (!clientId) throw new NotFoundException("Client not found.");
    if (profile.name !== undefined && organizationId) await this.assertNameFree(profile.name, organizationId, clientId);

    // Custom field values: only what was sent changes, and required fields are checked when values were sent.
    let customValues: Record<string, unknown> | undefined;
    if (profile.customFields !== undefined) {
      const current = await this.prisma.clients.findUnique({ where: { id: clientId }, select: { organization_id: true, custom_fields: true } });
      if (!current) throw new NotFoundException("Client not found.");
      const saved = current.custom_fields && typeof current.custom_fields === "object" && !Array.isArray(current.custom_fields) ? (current.custom_fields as Record<string, unknown>) : {};
      customValues = await this.customFields.valuesToSave(current.organization_id, profile.customFields, saved, false);
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        // A person who opened the record earlier sends the version they saw. If it has moved on, theirs would overwrite someone else's save.
        const where = profile.version ? { id: clientId, updated_at: versionWindow(profile.version) } : { id: clientId };
        const done = await tx.clients.updateMany({ where, data: { ...(profileColumns(profile) as any), ...(customValues ? { custom_fields: customValues as Prisma.InputJsonValue } : {}), updated_at: new Date() } });
        if (done.count === 0) throw new ConflictException("Someone else changed this customer while you were editing. Close this and open it again to see their changes.");
        if (profile.contacts) await this.writeContacts(tx, clientId, profile.contacts);
      });
    } catch (e: any) {
      if (e?.code === "P2002") throw new ConflictException("Another customer already has that name.");
      if (isRecordNotFound(e)) throw new NotFoundException("Client not found.");
      throw e;
    }
    return this.getProfile(clientId, organizationId);
  }

  /** Take a customer out of the lists without losing anything. Its devices, tickets and history stay. */
  async setArchived(clientParam: string, archived: boolean, organizationId?: string | null) {
    const clientId = await this.resolveClientId(clientParam, organizationId);
    if (!clientId) throw new NotFoundException("Client not found.");
    await this.prisma.clients.update({ where: { id: clientId }, data: { archived_at: archived ? new Date() : null, updated_at: new Date() } });
    return this.getProfile(clientId, organizationId);
  }

  // =========================
  // ✅ CREATE: SITE
  // =========================
  async createSiteForClient(
    clientParam: string,
    body: unknown,
    organizationId?: string | null
  ) {
    const clientId = await this.resolveClientId(clientParam, organizationId);
    if (!clientId) throw new BadRequestException("Client not found.");

    const details = cleanSite(body, { requireName: true });
    await this.assertSiteNameFree(clientId, details.name!);

    try {
      const site = await this.prisma.sites.create({ data: { client_id: clientId, ...(siteColumns(details) as any) } });
      return siteView(site);
    } catch (e: any) {
      if (e?.code === "P2002") throw new ConflictException("Another site of this customer already has that name.");
      throw e;
    }
  }

  private async assertSiteNameFree(clientId: string, name: string, exceptId?: string) {
    const except = exceptId ? Prisma.sql`AND s.id <> ${exceptId}::uuid` : Prisma.empty;
    const clash = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT s.id::text AS id FROM public.sites s
      WHERE s.client_id = ${clientId}::uuid AND lower(s.name) = lower(${name}) ${except}
      LIMIT 1
    `;
    if (clash.length) throw new ConflictException("Another site of this customer already has that name.");
  }

  async getSite(clientParam: string, siteParam: string, organizationId?: string | null) {
    const clientId = await this.resolveClientId(clientParam, organizationId);
    if (!clientId) throw new NotFoundException("Client not found.");
    const siteId = await this.resolveSiteIdForClient(clientId, siteParam);
    if (!siteId) throw new NotFoundException("Site not found.");
    const row = await this.prisma.sites.findUnique({ where: { id: siteId } });
    if (!row) throw new NotFoundException("Site not found.");
    return siteView(row);
  }

  /** Change any of a site's details. Only what is sent changes. */
  async updateSite(clientParam: string, siteParam: string, body: unknown, organizationId?: string | null) {
    const details = cleanSite(body, { requireName: false });
    const clientId = await this.resolveClientId(clientParam, organizationId);
    if (!clientId) throw new NotFoundException("Client not found.");
    const siteId = await this.resolveSiteIdForClient(clientId, siteParam);
    if (!siteId) throw new NotFoundException("Site not found.");
    if (details.name !== undefined) await this.assertSiteNameFree(clientId, details.name, siteId);

    try {
      const where = details.version ? { id: siteId, updated_at: versionWindow(details.version) } : { id: siteId };
      const done = await this.prisma.sites.updateMany({ where, data: { ...(siteColumns(details) as any), updated_at: new Date() } });
      if (done.count === 0) throw new ConflictException("Someone else changed this site while you were editing. Close this and open it again to see their changes.");
    } catch (e: any) {
      if (e?.code === "P2002") throw new ConflictException("Another site of this customer already has that name.");
      throw e;
    }
    return this.getSite(clientId, siteId, organizationId);
  }

  // =========================
  // RENAME: CLIENT and SITE
  // =========================
  private cleanName(input: unknown, what: string): string {
    const name = String(input ?? "").trim().replace(/\s+/g, " ");
    if (!name) throw new BadRequestException(`${what} name is required.`);
    if (name.length > 120) throw new BadRequestException(`${what} name is too long (120 characters at most).`);
    return name;
  }

  async renameClient(clientParam: string, body: { name?: unknown }, organizationId?: string | null) {
    const name = this.cleanName(body?.name, "Customer");
    const clientId = await this.resolveClientId(clientParam, organizationId);
    if (!clientId) throw new NotFoundException("Client not found.");

    // Names are looked up without regard to case, so two that differ only by case would be ambiguous.
    const clash = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT c.id::text AS id
      FROM public.clients c
      WHERE lower(c.name) = lower(${name}) AND c.id <> ${clientId}::uuid
        AND c.organization_id = (SELECT organization_id FROM public.clients WHERE id = ${clientId}::uuid)
      LIMIT 1
    `;
    if (clash.length) throw new ConflictException("Another customer already has that name.");

    try {
      return await this.prisma.clients.update({
        where: { id: clientId },
        data: { name, updated_at: new Date() },
        select: { id: true, name: true },
      });
    } catch (e: any) {
      if (e?.code === "P2002") throw new ConflictException("Another customer already has that name.");
      if (isRecordNotFound(e)) throw new NotFoundException("Client not found.");
      throw e;
    }
  }

  async renameSite(clientParam: string, siteParam: string, body: { name?: unknown }, organizationId?: string | null) {
    const name = this.cleanName(body?.name, "Site");
    const clientId = await this.resolveClientId(clientParam, organizationId);
    if (!clientId) throw new NotFoundException("Client not found.");
    const siteId = await this.resolveSiteIdForClient(clientId, siteParam);
    if (!siteId) throw new NotFoundException("Site not found.");

    const clash = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT s.id::text AS id
      FROM public.sites s
      WHERE s.client_id = ${clientId}::uuid AND lower(s.name) = lower(${name}) AND s.id <> ${siteId}::uuid
      LIMIT 1
    `;
    if (clash.length) throw new ConflictException("Another site of this customer already has that name.");

    try {
      const site = await this.prisma.sites.update({
        where: { id: siteId },
        data: { name, updated_at: new Date() },
        select: { id: true, client_id: true, name: true },
      });
      return { id: site.id, clientId: site.client_id, name: site.name };
    } catch (e: any) {
      if (e?.code === "P2002") throw new ConflictException("Another site of this customer already has that name.");
      if (isRecordNotFound(e)) throw new NotFoundException("Site not found.");
      throw e;
    }
  }

  // =========================
  // Remote Console: what the person at the device is told or asked
  // =========================
  async getRemoteConsoleConsent(clientParam: string, organizationId?: string | null) {
    const clientId = await this.resolveClientId(clientParam, organizationId);
    if (!clientId) throw new NotFoundException("Client not found.");

    const rows = await this.prisma.$queryRaw<Array<{ mode: string; record: boolean; codec: string }>>`
      SELECT remote_console_consent AS mode, record_remote_sessions AS record, remote_console_codec AS codec FROM public.clients WHERE id = ${clientId}::uuid
    `;
    return { consent: rows[0]?.mode ?? "notice", record: rows[0]?.record === true, codec: rows[0]?.codec ?? "auto" };
  }

  /** `record` is optional so the older calls that only send the notice setting keep working. */
  async setRemoteConsoleConsent(clientParam: string, consent: unknown, organizationId?: string | null, record?: unknown, codec?: unknown) {
    // The video codec is optional too, so every older caller keeps working.
    if (codec !== undefined && codec !== "auto" && codec !== "vp8" && codec !== "h264") {
      throw new BadRequestException('codec must be "auto", "vp8" or "h264".');
    }
    if (consent === undefined && (record !== undefined || codec !== undefined)) {
      if (record !== undefined && typeof record !== "boolean") throw new BadRequestException("record must be true or false.");
    } else {
      if (consent !== "off" && consent !== "notice" && consent !== "consent") {
        throw new BadRequestException('consent must be "off", "notice" or "consent".');
      }
      if (record !== undefined && typeof record !== "boolean") throw new BadRequestException("record must be true or false.");
    }

    const clientId = await this.resolveClientId(clientParam, organizationId);
    if (!clientId) throw new NotFoundException("Client not found.");

    // Only what was sent changes: saving the notice setting must not switch recording off, or the reverse.
    await this.prisma.$executeRaw`
      UPDATE public.clients
         SET remote_console_consent = COALESCE(${consent === undefined ? null : String(consent)}, remote_console_consent),
             record_remote_sessions = COALESCE(${record === undefined ? null : record}::boolean, record_remote_sessions),
             remote_console_codec = COALESCE(${codec === undefined ? null : String(codec)}, remote_console_codec),
             updated_at = now()
       WHERE id = ${clientId}::uuid
    `;
    PoliciesService.invalidate();
    return this.getRemoteConsoleConsent(clientParam, organizationId);
  }

  // =========================
  // ✅ DELETE: SITE
  // =========================
  async deleteSiteForClient(
    clientParam: string,
    siteParam: string,
    organizationId?: string | null
  ) {
    const clientId = await this.resolveClientId(clientParam, organizationId);
    if (!clientId) throw new NotFoundException("Client not found.");

    const siteId = await this.resolveSiteIdForClient(clientId, siteParam);
    if (!siteId) throw new NotFoundException("Site not found.");

    const devices = await this.prisma.devices.count({ where: { site_id: siteId } });
    if (devices > 0) {
      throw new ConflictException("Site has devices. Move/delete devices first.");
    }

    try {
      const site = await this.prisma.sites.delete({
        where: { id: siteId, client_id: clientId },
        select: { id: true, name: true },
      });
      return { deleted: true, id: site.id, name: site.name };
    } catch (e) {
      if (isRecordNotFound(e)) throw new NotFoundException("Site not found (or not in your org).");
      throw e;
    }
  }

  // =========================
  // ✅ DELETE: CLIENT
  // =========================
  async deleteClient(
    clientParam: string,
    opts: { force?: boolean } = {},
    organizationId?: string | null
  ) {
    const clientId = await this.resolveClientId(clientParam, organizationId);
    if (!clientId) throw new NotFoundException("Client not found.");

    // If there are sites, only allow delete if force=true AND those sites are empty
    const sites = await this.prisma.sites.findMany({
      where: { client_id: clientId },
      select: { id: true },
    });

    if (sites.length > 0) {
      if (!opts.force) {
        throw new ConflictException(
          "Client has sites. Delete sites first, or call DELETE with ?force=true (only works if sites have no devices/tickets)."
        );
      }

      const devices = await this.prisma.devices.count({
        where: { site_id: { in: sites.map((s) => s.id) } },
      });
      if (devices > 0) {
        throw new ConflictException("One or more sites have devices. Cannot force-delete client.");
      }

      await this.prisma.sites.deleteMany({ where: { client_id: clientId } });
    }

    try {
      const client = await this.prisma.clients.delete({
        where: { id: clientId, ...(organizationId ? { organization_id: organizationId } : {}) },
        select: { id: true, name: true },
      });
      return { deleted: true, id: client.id, name: client.name };
    } catch (e) {
      if (isRecordNotFound(e)) throw new NotFoundException("Client not found (or not in your org).");
      throw e;
    }
  }
}
