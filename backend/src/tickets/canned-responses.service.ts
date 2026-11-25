import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { isCanonicalUuid } from "../common/agent-lookup.util";
import { PrismaService } from "../storage/prisma.service";
import { randomUUID } from "crypto";

export type AdminCannedResponse = {
  id: string;
  title: string;
  body: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type AdminCannedVariable = {
  id: string;
  key: string;
  value: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type VariableDefinition = {
  key: string; // e.g. "ticket.number", "now.datetime", "company.name", "custom.companyName"
  label: string;
  description?: string;
  source: "preset" | "custom";
};

function getOrgIdFromReq(req: any): string | null {
  const u = req?.user ?? req?.auth ?? null;
  return u?.organizationId ?? u?.organization_id ?? u?.orgId ?? u?.org_id ?? null;
}

function normTitle(s: any): string {
  return String(s ?? "").trim();
}

function normBody(s: any): string {
  return String(s ?? "").trim();
}

function normKey(s: any): string {
  return String(s ?? "").trim();
}

function isUniqueViolation(err: any): boolean {
  return err?.code === "P2002";
}

function safeStr(v: any): string {
  return String(v ?? "").trim();
}

function renderTemplate(template: string, ctx: Record<string, string>): string {
  const src = String(template ?? "");
  return src.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_m, rawKey) => {
    const key = String(rawKey ?? "").trim();
    const v = ctx[key];
    return v === undefined || v === null ? "" : String(v);
  });
}

@Injectable()
export class CannedResponsesService {
  constructor(private readonly prisma: PrismaService) {}

  private presetDefs(): VariableDefinition[] {
    return [
      // Ticket
      { key: "ticket.id", label: "Ticket UUID", description: "Full ticket UUID.", source: "preset" },
      { key: "ticket.uuid", label: "Ticket UUID (alias)", description: "Alias of ticket.id.", source: "preset" },
      { key: "ticket.number", label: "Ticket number", description: "Numeric ticket number (if available).", source: "preset" },
      { key: "ticket.title", label: "Ticket title", description: "Ticket subject/title.", source: "preset" },
      { key: "ticket.status", label: "Ticket status", description: "open / in_progress / resolved / closed.", source: "preset" },
      { key: "ticket.priority", label: "Ticket priority", description: "low / medium / high / urgent.", source: "preset" },
      { key: "ticket.dueAt", label: "Due date/time", description: "Due date in America/New_York (if set).", source: "preset" },

      // People
      { key: "requester.name", label: "Requester name", description: "Best-effort: contact/user name when available.", source: "preset" },
      { key: "requester.email", label: "Requester email", description: "Best-effort when available.", source: "preset" },
      { key: "assignee.name", label: "Assignee name", description: "Best-effort from users table.", source: "preset" },
      { key: "assignee.email", label: "Assignee email", description: "Best-effort from users table.", source: "preset" },

      // Time
      { key: "now.iso", label: "Current time (ISO)", description: "Server time as ISO string.", source: "preset" },
      { key: "now.date", label: "Current date", description: "Date in America/New_York.", source: "preset" },
      { key: "now.time", label: "Current time", description: "Time in America/New_York.", source: "preset" },
      { key: "now.datetime", label: "Current date/time", description: "Date+time in America/New_York.", source: "preset" },

      // Company (your schema: company_profile id=1)
      { key: "company.name", label: "Company name", description: "Company profile name.", source: "preset" },
      { key: "company.legalName", label: "Legal name", description: "Company legal name.", source: "preset" },
      { key: "company.email", label: "Company email", description: "Company contact email.", source: "preset" },
      { key: "company.phone", label: "Company phone", description: "Company phone number.", source: "preset" },
      { key: "company.fax", label: "Company fax", description: "Company fax number.", source: "preset" },
      { key: "company.website", label: "Company website", description: "Company website.", source: "preset" },
      { key: "company.vatTin", label: "VAT/TIN", description: "Company VAT/TIN.", source: "preset" },
      { key: "company.address1", label: "Address line 1", description: "Company address line 1.", source: "preset" },
      { key: "company.address2", label: "Address line 2", description: "Company address line 2.", source: "preset" },
      { key: "company.city", label: "City", description: "Company city.", source: "preset" },
      { key: "company.state", label: "State", description: "Company state/province.", source: "preset" },
      { key: "company.postal", label: "Postal", description: "Company postal/zip.", source: "preset" },
      { key: "company.country", label: "Country", description: "Company country.", source: "preset" },

      // Branding (optional best-effort)
      { key: "branding.primaryColor", label: "Branding primary color", description: "Primary color.", source: "preset" },
      { key: "branding.secondaryColor", label: "Branding secondary color", description: "Secondary color.", source: "preset" },
      { key: "branding.logoUrl", label: "Brand logo URL", description: "Best-effort logo url.", source: "preset" },
      { key: "branding.emailHeader", label: "Email header", description: "Brand email header content.", source: "preset" },
      { key: "branding.emailFooter", label: "Email footer", description: "Brand email footer content.", source: "preset" },
    ];
  }

  // ---------------- Ticket-side canned list ----------------

  async listForTicketUse(req: any): Promise<Array<{ id: string; title: string; body: string }>> {
    const orgId = getOrgIdFromReq(req);
    if (!orgId) return [];

    // Prisma cannot order by lower(title).
    return await this.prisma.$queryRaw<Array<{ id: string; title: string; body: string }>>`
      SELECT id::text AS id, title, body
      FROM canned_responses
      WHERE organization_id::text = ${orgId} AND is_active = true
      ORDER BY lower(title) ASC`;
  }

  async listVariableDefinitionsForTicketUse(req: any): Promise<VariableDefinition[]> {
    const orgId = getOrgIdFromReq(req);
    if (!orgId) return this.presetDefs();

    const defs: VariableDefinition[] = [...this.presetDefs()];

    // Prisma cannot order by lower(key).
    const rows = await this.prisma.$queryRaw<Array<{ key: string }>>`
      SELECT key
      FROM canned_variables
      WHERE organization_id::text = ${orgId} AND is_active = true
      ORDER BY lower(key) ASC`;

    for (const r of rows) {
      const k = String(r?.key ?? "").trim();
      if (!k) continue;
      defs.push({
        key: `custom.${k}`,
        label: `Custom: ${k}`,
        description: "Admin-defined variable.",
        source: "custom",
      });
    }

    return defs;
  }

  async listVariableValuesForTicket(ticketId: string, req: any): Promise<Array<{ key: string; value: string }>> {
    const ctx = await this.buildContextForTicket(ticketId, req);
    const keys = Object.keys(ctx).sort((a, b) => a.localeCompare(b));
    return keys.map((k) => ({ key: k, value: ctx[k] }));
  }

  async renderForTicket(ticketId: string, template: string, req: any): Promise<string> {
    const ctx = await this.buildContextForTicket(ticketId, req);
    return renderTemplate(template, ctx);
  }

  private emptyCompanyContext(): Record<string, string> {
    return {
      "company.name": "",
      "company.legalName": "",
      "company.email": "",
      "company.phone": "",
      "company.fax": "",
      "company.website": "",
      "company.vatTin": "",
      "company.address1": "",
      "company.address2": "",
      "company.city": "",
      "company.state": "",
      "company.postal": "",
      "company.country": "",
    };
  }

  private async loadCompanyProfileRowId1(): Promise<Record<string, string>> {
    const out = this.emptyCompanyContext();

    try {
      // Match CompanyService.get(): company_profile WHERE id = 1
      const r = await this.prisma.company_profile.findUnique({ where: { id: 1 } });
      if (!r) return out;

      out["company.name"] = safeStr(r.name);
      out["company.legalName"] = safeStr(r.legal_name);
      out["company.email"] = safeStr(r.email);
      out["company.phone"] = safeStr(r.phone);
      out["company.fax"] = safeStr(r.fax);
      out["company.website"] = safeStr(r.website);
      out["company.vatTin"] = safeStr(r.vat_tin);
      out["company.address1"] = safeStr(r.address1);
      out["company.address2"] = safeStr(r.address2);
      out["company.city"] = safeStr(r.city);
      out["company.state"] = safeStr(r.state);
      out["company.postal"] = safeStr(r.postal);
      out["company.country"] = safeStr(r.country);

      return out;
    } catch {
      // never fail canned rendering
      return out;
    }
  }

  private async bestEffortBranding(): Promise<Record<string, string>> {
    const out: Record<string, string> = {
      "branding.primaryColor": "",
      "branding.secondaryColor": "",
      "branding.logoUrl": "",
      "branding.emailHeader": "",
      "branding.emailFooter": "",
    };

    try {
      const r = await this.prisma.branding_settings.findUnique({ where: { id: 1 } });
      if (!r) return out;

      out["branding.primaryColor"] = safeStr(r.primary_color);
      out["branding.secondaryColor"] = safeStr(r.secondary_color);
      out["branding.emailHeader"] = safeStr(r.email_header);
      out["branding.emailFooter"] = safeStr(r.email_footer);
      out["branding.logoUrl"] = safeStr(r.logo_light_url) || safeStr(r.logo_dark_url);
    } catch {
      // never fail canned rendering
    }

    return out;
  }

  private async buildContextForTicket(ticketId: string, req: any): Promise<Record<string, string>> {
    const orgIdFromReq = getOrgIdFromReq(req);

    // ---- load ticket (enforce org if present) ----
    // A non-canonical id never matched the old `id::text = $1`, and Prisma would reject it.
    const t =
      isCanonicalUuid(ticketId) && (!orgIdFromReq || isCanonicalUuid(orgIdFromReq))
        ? await this.prisma.tickets.findFirst({
            where: { id: ticketId, ...(orgIdFromReq ? { organization_id: orgIdFromReq } : {}) },
          })
        : null;

    if (!t) throw new NotFoundException("Ticket not found");

    const orgId = t.organization_id;
    const tz = "America/New_York";
    const now = new Date();

    const ctx: Record<string, string> = {
      "ticket.id": safeStr(t.id),
      "ticket.uuid": safeStr(t.id),
      "ticket.number": String(Number(t.ticket_number)),
      "ticket.title": safeStr(t.subject),
      "ticket.status": safeStr(t.status),
      "ticket.priority": safeStr(t.priority),
      "ticket.dueAt": t.due_at ? t.due_at.toLocaleString("en-US", { timeZone: tz }) : "",

      "now.iso": now.toISOString(),
      "now.date": now.toLocaleDateString("en-US", { timeZone: tz }),
      "now.time": now.toLocaleTimeString("en-US", { timeZone: tz }),
      "now.datetime": now.toLocaleString("en-US", { timeZone: tz }),

      // initialize these so templates never crash
      ...this.emptyCompanyContext(),
      "branding.primaryColor": "",
      "branding.secondaryColor": "",
      "branding.logoUrl": "",
      "branding.emailHeader": "",
      "branding.emailFooter": "",
      "requester.name": "",
      "requester.email": "",
      "assignee.name": "",
      "assignee.email": "",
    };

    // ---- company profile (FIX: matches your CompanyService: id=1) ----
    Object.assign(ctx, await this.loadCompanyProfileRowId1());

    // ---- branding (optional) ----
    Object.assign(ctx, await this.bestEffortBranding());

    // assignee.name and assignee.email stay empty: the old lookup selected users.name, a column
    // that does not exist, so it always failed and the error was ignored.

    // ---- requester best-effort (contacts table) ----
    if (t.requester_contact_id) {
      try {
        const c = await this.prisma.contacts.findUnique({
          where: { id: t.requester_contact_id },
          select: { name: true, email: true },
        });
        if (c) {
          ctx["requester.name"] = safeStr(c.name);
          ctx["requester.email"] = safeStr(c.email);
        }
      } catch {
        // ignore best-effort errors
      }
    }

    // ---- custom variables (active only) ----
    try {
      const vars = await this.prisma.canned_variables.findMany({
        where: { organization_id: orgId, is_active: true },
        select: { key: true, value: true },
      });

      for (const r of vars) {
        const k = String(r?.key ?? "").trim();
        const v = String(r?.value ?? "");
        if (!k) continue;

        ctx[`custom.${k}`] = v;
        ctx[`var.${k}`] = v;

        // convenience: allow {{companyName}} if it doesn't collide
        if (!k.includes(".") && ctx[k] === undefined) ctx[k] = v;
      }
    } catch {
      // ignore
    }

    return ctx;
  }

  // ---------------- Admin canned responses CRUD ----------------

  async adminList(req: any): Promise<AdminCannedResponse[]> {
    const orgId = getOrgIdFromReq(req);
    if (!orgId) return [];

    // Prisma cannot order by lower(title).
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT id::text AS id, title, body, is_active, created_at, updated_at
      FROM canned_responses
      WHERE organization_id::text = ${orgId}
      ORDER BY lower(title) ASC`;

    return rows.map((r) => ({
      id: r.id,
      title: String(r.title ?? ""),
      body: String(r.body ?? ""),
      isActive: !!r.is_active,
      createdAt: new Date(r.created_at).toISOString(),
      updatedAt: new Date(r.updated_at).toISOString(),
    }));
  }

  async adminCreate(req: any, input: { title: string; body: string; isActive?: boolean }) {
    const orgId = getOrgIdFromReq(req);
    if (!orgId) throw new BadRequestException("No organization context available");

    const title = normTitle(input?.title);
    const body = normBody(input?.body);
    const isActive = input?.isActive !== false;

    if (!title) throw new BadRequestException("title is required");
    if (title.length > 200) throw new BadRequestException("title is too long (max 200)");
    if (!body) throw new BadRequestException("body is required");
    if (body.length > 20000) throw new BadRequestException("body is too long (max 20000)");

    const id = randomUUID();

    try {
      await this.prisma.canned_responses.create({
        data: { id, organization_id: orgId, title, body, is_active: isActive },
      });
    } catch (err: any) {
      if (isUniqueViolation(err)) {
        throw new BadRequestException("A canned response with that title already exists.");
      }
      throw err;
    }

    return { id };
  }

  async adminUpdate(req: any, id: string, input: { title?: string; body?: string; isActive?: boolean }) {
    const orgId = getOrgIdFromReq(req);
    if (!orgId) throw new BadRequestException("No organization context available");

    const data: Prisma.canned_responsesUpdateManyMutationInput = {};

    if (input.title !== undefined) {
      const title = normTitle(input.title);
      if (!title) throw new BadRequestException("title cannot be empty");
      if (title.length > 200) throw new BadRequestException("title is too long (max 200)");
      data.title = title;
    }

    if (input.body !== undefined) {
      const body = normBody(input.body);
      if (!body) throw new BadRequestException("body cannot be empty");
      if (body.length > 20000) throw new BadRequestException("body is too long (max 20000)");
      data.body = body;
    }

    if (input.isActive !== undefined) {
      data.is_active = !!input.isActive;
    }

    if (Object.keys(data).length === 0) return { ok: true };

    data.updated_at = new Date();

    if (!isCanonicalUuid(id)) throw new NotFoundException("Canned response not found");

    try {
      const { count } = await this.prisma.canned_responses.updateMany({
        where: { id, organization_id: orgId },
        data,
      });

      if (!count) throw new NotFoundException("Canned response not found");
    } catch (err: any) {
      if (isUniqueViolation(err)) {
        throw new BadRequestException("A canned response with that title already exists.");
      }
      throw err;
    }

    return { ok: true };
  }

  async adminDelete(req: any, id: string) {
    const orgId = getOrgIdFromReq(req);
    if (!orgId) throw new BadRequestException("No organization context available");

    if (!isCanonicalUuid(id)) throw new NotFoundException("Canned response not found");

    const { count } = await this.prisma.canned_responses.deleteMany({
      where: { id, organization_id: orgId },
    });

    if (!count) throw new NotFoundException("Canned response not found");
    return { ok: true };
  }

  // ---------------- Admin variables CRUD ----------------

  async adminListVariables(req: any): Promise<AdminCannedVariable[]> {
    const orgId = getOrgIdFromReq(req);
    if (!orgId) return [];

    // Prisma cannot order by lower(key).
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT id::text AS id, key, value, is_active, created_at, updated_at
      FROM canned_variables
      WHERE organization_id::text = ${orgId}
      ORDER BY lower(key) ASC`;

    return rows.map((r) => ({
      id: r.id,
      key: String(r.key ?? ""),
      value: String(r.value ?? ""),
      isActive: !!r.is_active,
      createdAt: new Date(r.created_at).toISOString(),
      updatedAt: new Date(r.updated_at).toISOString(),
    }));
  }

  private validateVariableKey(keyRaw: string) {
    const k = normKey(keyRaw);
    if (!k) throw new BadRequestException("key is required");
    if (k.length > 80) throw new BadRequestException("key is too long (max 80)");
    if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(k)) {
      throw new BadRequestException("key must match: ^[a-zA-Z][a-zA-Z0-9_-]*$");
    }
    return k;
  }

  async adminCreateVariable(req: any, input: { key: string; value: string; isActive?: boolean }) {
    const orgId = getOrgIdFromReq(req);
    if (!orgId) throw new BadRequestException("No organization context available");

    const key = this.validateVariableKey(input?.key);
    const value = normBody(input?.value);
    const isActive = input?.isActive !== false;

    if (!value) throw new BadRequestException("value is required");
    if (value.length > 20000) throw new BadRequestException("value is too long (max 20000)");

    const id = randomUUID();

    try {
      await this.prisma.canned_variables.create({
        data: { id, organization_id: orgId, key, value, is_active: isActive },
      });
    } catch (err: any) {
      if (isUniqueViolation(err)) {
        throw new BadRequestException("A variable with that key already exists.");
      }
      throw err;
    }

    return { id };
  }

  async adminUpdateVariable(req: any, id: string, input: { key?: string; value?: string; isActive?: boolean }) {
    const orgId = getOrgIdFromReq(req);
    if (!orgId) throw new BadRequestException("No organization context available");

    const data: Prisma.canned_variablesUpdateManyMutationInput = {};

    if (input.key !== undefined) {
      data.key = this.validateVariableKey(input.key);
    }

    if (input.value !== undefined) {
      const value = normBody(input.value);
      if (!value) throw new BadRequestException("value cannot be empty");
      if (value.length > 20000) throw new BadRequestException("value is too long (max 20000)");
      data.value = value;
    }

    if (input.isActive !== undefined) {
      data.is_active = !!input.isActive;
    }

    if (Object.keys(data).length === 0) return { ok: true };

    data.updated_at = new Date();

    if (!isCanonicalUuid(id)) throw new NotFoundException("Variable not found");

    try {
      const { count } = await this.prisma.canned_variables.updateMany({
        where: { id, organization_id: orgId },
        data,
      });

      if (!count) throw new NotFoundException("Variable not found");
    } catch (err: any) {
      if (isUniqueViolation(err)) {
        throw new BadRequestException("A variable with that key already exists.");
      }
      throw err;
    }

    return { ok: true };
  }

  async adminDeleteVariable(req: any, id: string) {
    const orgId = getOrgIdFromReq(req);
    if (!orgId) throw new BadRequestException("No organization context available");

    if (!isCanonicalUuid(id)) throw new NotFoundException("Variable not found");

    const { count } = await this.prisma.canned_variables.deleteMany({
      where: { id, organization_id: orgId },
    });

    if (!count) throw new NotFoundException("Variable not found");
    return { ok: true };
  }
}
