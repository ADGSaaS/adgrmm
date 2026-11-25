import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { fireWorkflow } from "../workflows/workflows.bus";
import { Prisma, ticket_priority, ticket_status } from "@prisma/client";
import { isCanonicalUuid } from "../common/agent-lookup.util";
import { PrismaService } from "../storage/prisma.service";
import { SupportMailboxService } from "../support-mailbox/support-mailbox.service";
import { likePattern, snippetAround, type TicketMatch } from "./ticket-search";
import { ListTicketsQuery } from "./dto/list-tickets.dto";
import { CreateTicketDto } from "./dto/create-ticket.dto";
import { UpdateTicketDto } from "./dto/update-ticket.dto";
import { randomUUID } from "crypto";
import { TicketTimeService } from "./ticket-time.service";
import { CustomFieldsService } from "../customers/custom-fields.service";
import { WebhooksService } from "../webhooks/webhooks.service";
import { displayValue } from "../customers/custom-fields";
import { customFieldFilter, customValueMatch } from "./ticket-custom-values";
import { ServiceDeskService } from "../service-desk/service-desk.service";
import { ClientAccessService } from "../reports/client-access.service";
import { buildExtras } from "../service-desk/ticket-filters";
import type { SlaView } from "../service-desk/sla.service";
import { checkTicketDevices, deviceLabel, linkTicketDevices, unlinkTicketDevice } from "./ticket-devices";
import { requireCustomerContact } from "./ticket-contacts";

export type Ticket = {
  id: string;

  // Backward compatible API naming:
  customerId: string | null;

  title: string;
  description: string | null;

  status: "open" | "in_progress" | "pending" | "resolved" | "closed";
  priority: "low" | "medium" | "high" | "urgent";

  assigneeUserId: string | null;

  requesterEmail: string | null;

  createdAt: string;
  updatedAt: string;
  closedAt: string | null;

  dueAt: string | null;

  ticketNumber: number | null;
  requesterContactId: string | null;
  deviceId: string | null;
  /** The customer the ticket is for (what the client portal shows them). */
  clientId: string | null;
  /** Who asked: the portal person who opened it, else the contact on the ticket. */
  requesterName?: string | null;
  /** The customer's own contact who asked (from the customer record), if one was chosen. */
  requesterCustomerContactId?: string | null;
  requesterContact?: { id: string; name: string; email: string | null; phone: string | null; mobile: string | null; jobTitle: string | null } | null;
  /** The first few device names on the ticket, and how many devices it has. */
  deviceNames?: string[];
  deviceCount?: number;
  /** The recurring schedule that opened the ticket. */
  recurringId?: string | null;
  /** What people saved in the ticket custom fields, by field key. */
  customFields: Record<string, unknown>;
  /** The queue the ticket waits in, and where it came from (ui, email, portal, alert, api). */
  queueId?: string | null;
  queueName?: string | null;
  createdVia?: string | null;
  /** Response and resolution clocks. Staff only: the client portal never gets this. */
  sla?: SlaView | null;
  /** True when the customer has replied since the person asking last opened this ticket. */
  hasNewReply?: boolean;
  lastCustomerReplyAt?: string | null;

  /** In a search: where the words were found, when it was in a reply, note or the description rather than the subject. */
  match?: TicketMatch;
};

export type LinkedTicket = { id: string; number?: string | null; title: string; status: string };

export type AttachmentItem = { id: string; name: string; size?: number; url: string };

export type MessageActivityItem = {
  id: string;
  kind: "message";
  author: string;
  body: string;
  createdAt: string;
  isInternal: false;
  /** The customer wrote this and it arrived by email or the portal. */
  isInbound?: boolean;
  /** For a customer reply: where it came from. */
  via?: "portal" | "email";
  /** Time logged with this reply, in seconds. */
  timeWorkedSeconds?: number;
  attachments: AttachmentItem[];
};

export type NoteActivityItem = {
  id: string;
  kind: "note";
  author: string;
  body: string;
  createdAt: string;
  isInternal: true;
  /** A note left for the next technician: where the ticket was left. */
  isHandoff: boolean;
  /** Time logged with this note, in seconds. */
  timeWorkedSeconds?: number;
  attachments: AttachmentItem[];
};

export type ChangeActivityItem = {
  id: string;
  kind: "change";
  createdAt: string;
  actor: string;
  field: "status" | "priority" | "assignee" | "title" | "dueAt" | "collaborators" | "requester" | "queue" | `custom:${string}`;
  from?: string | null;
  to?: string | null;
};

export type ActivityItem = MessageActivityItem | NoteActivityItem | ChangeActivityItem;

export type ReplyItem = MessageActivityItem;
export type NoteItem = NoteActivityItem;

const STATUS_ALLOW = new Set<Ticket["status"]>(["open", "in_progress", "pending", "resolved", "closed"]);
const PRIORITY_ALLOW = new Set<string>(["low", "normal", "medium", "high", "urgent"]);

function priorityApiToDb(p: string): string {
  const v = String(p ?? "").toLowerCase();
  if (v === "medium") return "normal";
  if (v === "normal") return "normal";
  return v;
}
function priorityDbToApi(p: string): Ticket["priority"] {
  const v = String(p ?? "").toLowerCase();
  return (v === "normal" ? "medium" : v) as Ticket["priority"];
}

function getOrgIdFromReq(req: any): string | null {
  const u = req?.user ?? req?.auth ?? null;
  return u?.organizationId ?? u?.organization_id ?? u?.orgId ?? u?.org_id ?? null;
}

function getActorFromReq(req: any): string {
  const u = req?.user ?? req?.auth ?? null;
  const name = (u?.name ?? u?.fullName ?? "").toString().trim();
  const email = (u?.email ?? u?.username ?? "").toString().trim();
  return name || email || "System";
}

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
}

function isIntLike(s: string): boolean {
  return /^[0-9]+$/.test(String(s ?? "").trim());
}

function isUniqueViolation(err: any): boolean {
  return err?.code === "P2002" || (err?.code === "P2010" && err?.meta?.code === "23505");
}

function normalizeAttachments(v: any): AttachmentItem[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((a: any) => ({
      id: String(a?.id ?? randomUUID()),
      name: String(a?.name ?? ""),
      size: typeof a?.size === "number" ? a.size : undefined,
      url: String(a?.url ?? ""),
    }))
    .filter((a: AttachmentItem) => !!a.url);
}

/** Null when the ids can't match a row: the old `id::text = $1` found nothing for these. */
function ticketWhere(id: string, orgId: string | null): Prisma.ticketsWhereInput | null {
  if (!isCanonicalUuid(id) || (orgId && !isCanonicalUuid(orgId))) return null;
  return { id, ...(orgId ? { organization_id: orgId } : {}) };
}

const TICKET_FIELDS = {
  id: true,
  organization_id: true,
  ticket_number: true,
  requester_contact_id: true,
  device_id: true,
  client_id: true,
  subject: true,
  description: true,
  status: true,
  priority: true,
  assignee_user_id: true,
  due_at: true,
  created_at: true,
  updated_at: true,
  closed_at: true,
  custom_fields: true,
  requester_customer_contact_id: true,
  recurring_id: true,
  queue_id: true,
  created_via: true,
} satisfies Prisma.ticketsSelect;

type TicketRow = Prisma.ticketsGetPayload<{ select: typeof TICKET_FIELDS }>;

/** What a ticket has saved in its custom fields, whatever the column holds. */
function savedValues(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function toTicket(r: TicketRow): Ticket {
  return {
    id: r.id,
    customerId: r.organization_id,
    ticketNumber: Number(r.ticket_number),
    requesterContactId: r.requester_contact_id,
    deviceId: r.device_id,
    clientId: r.client_id,

    title: r.subject,
    description: r.description || null,

    status: r.status as Ticket["status"],
    priority: priorityDbToApi(r.priority),

    assigneeUserId: r.assignee_user_id,

    requesterEmail: null,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    closedAt: r.closed_at ? r.closed_at.toISOString() : null,
    dueAt: r.due_at ? r.due_at.toISOString() : null,
    customFields: savedValues(r.custom_fields),
    queueId: r.queue_id,
    createdVia: r.created_via,
    requesterCustomerContactId: r.requester_customer_contact_id,
    recurringId: r.recurring_id,
  };
}

/** Filters on what a ticket is linked to: one of its devices, the contact who asked, the recurring schedule that opened it. */
function relationFilters(q: ListTicketsQuery): Prisma.Sql[] {
  const out: Prisma.Sql[] = [];
  if (q.deviceId) out.push(Prisma.sql`EXISTS (SELECT 1 FROM ticket_devices td WHERE td.ticket_id = t.id AND td.device_id = ${q.deviceId}::uuid)`);
  if (q.contactId) out.push(Prisma.sql`t.requester_customer_contact_id = ${q.contactId}::uuid`);
  if (q.recurringId) out.push(Prisma.sql`t.recurring_id = ${q.recurringId}::uuid`);
  return out;
}

@Injectable()
export class TicketsService {
  constructor(private readonly prisma: PrismaService, private readonly time: TicketTimeService, private readonly mailbox: SupportMailboxService, private readonly customFields: CustomFieldsService, private readonly webhooks: WebhooksService, private readonly desk: ServiceDeskService, private readonly access: ClientAccessService) { }

  async list(
    q: ListTicketsQuery,
    req: any
  ): Promise<{ items: Ticket[]; page: number; pageSize: number; total: number }> {
    const page = Math.max(1, q.page ?? 1);
    const pageSize = Math.min(Math.max(1, q.pageSize ?? 25), 200);
    const offset = (page - 1) * pageSize;

    // Always the session's organization. A query parameter must not reach another one.
    const orgId = getOrgIdFromReq(req);
    if (orgId && !isCanonicalUuid(orgId)) return { items: [], page, pageSize, total: 0 };

    const status = (q as any).status && STATUS_ALLOW.has((q as any).status) ? ((q as any).status as ticket_status) : null;
    const priority =
      (q as any).priority && PRIORITY_ALLOW.has(String((q as any).priority).toLowerCase())
        ? (priorityApiToDb(String((q as any).priority)) as ticket_priority)
        : null;

    const viewer = req?.user?.id && isCanonicalUuid(String(req.user.id)) ? String(req.user.id) : null;
    const extra = buildExtras(q as any, { userId: viewer, allowed: await this.access.allowedFor(viewer) });

    if ((q as any).search && String((q as any).search).trim()) {
      const term = String((q as any).search).trim().slice(0, 100);
      // A % or _ typed in the box is just a character.
      const pattern = likePattern(term);
      const filters: Prisma.Sql[] = [
        Prisma.sql`(
          t.subject ILIKE ${pattern} ESCAPE '\\'
          OR t.description ILIKE ${pattern} ESCAPE '\\'
          OR t.id::text ILIKE ${pattern} ESCAPE '\\'
          OR t.ticket_number::text ILIKE ${pattern} ESCAPE '\\'
          OR EXISTS (SELECT 1 FROM ticket_activity a WHERE a.ticket_id = t.id AND a.kind IN ('message', 'note') AND a.body ILIKE ${pattern} ESCAPE '\\')
          OR ${customValueMatch(pattern)}
          OR EXISTS (SELECT 1 FROM ticket_devices td JOIN devices d ON d.id = td.device_id WHERE td.ticket_id = t.id AND (d.hostname ILIKE ${pattern} ESCAPE '\' OR d.alias ILIKE ${pattern} ESCAPE '\'))
          OR EXISTS (SELECT 1 FROM customer_contacts cc WHERE cc.id = t.requester_customer_contact_id AND (cc.name ILIKE ${pattern} ESCAPE '\' OR cc.email ILIKE ${pattern} ESCAPE '\'))
        )`,
        ...relationFilters(q),
      ];
      const byField = customFieldFilter(q.customField, q.customValue);
      if (byField) filters.push(byField);
      if (orgId) filters.push(Prisma.sql`t.organization_id::text = ${orgId}`);
      if (status) filters.push(Prisma.sql`t.status = ${status}::ticket_status`);
      if (priority) filters.push(Prisma.sql`t.priority = ${priority}::ticket_priority`);
      filters.push(...extra.sql);
      const where = Prisma.join(filters, " AND ");

      // Prisma cannot ILIKE uuid and bigint columns cast to text, so the matching page comes from SQL.
      const [{ n: total }] = await this.prisma.$queryRaw<{ n: number }[]>`
        SELECT COUNT(*)::int AS n FROM tickets t WHERE ${where}`;
      // For each ticket on the page, the newest reply or note with the words in it, to show where they were found.
      const pageRows = await this.prisma.$queryRaw<{ id: string; in_subject: boolean; in_description: boolean; in_custom: boolean; hit_kind: string | null; hit_internal: boolean | null; hit_inbound: boolean | null; hit_author: string | null; hit_body: string | null; hit_device: string | null; hit_requester: string | null }[]>`
        SELECT t.id::text AS id,
               (t.subject ILIKE ${pattern} ESCAPE '\\' OR t.id::text ILIKE ${pattern} ESCAPE '\\' OR t.ticket_number::text ILIKE ${pattern} ESCAPE '\\') AS in_subject,
               (t.description ILIKE ${pattern} ESCAPE '\\') AS in_description,
               ${customValueMatch(pattern)} AS in_custom,
               h.kind AS hit_kind, h.is_internal AS hit_internal, h.is_inbound AS hit_inbound, h.author AS hit_author, h.body AS hit_body,
               (SELECT COALESCE(d.alias, d.hostname) FROM ticket_devices td JOIN devices d ON d.id = td.device_id WHERE td.ticket_id = t.id AND (d.hostname ILIKE ${pattern} ESCAPE '\' OR d.alias ILIKE ${pattern} ESCAPE '\') LIMIT 1) AS hit_device,
               (SELECT cc.name FROM customer_contacts cc WHERE cc.id = t.requester_customer_contact_id AND (cc.name ILIKE ${pattern} ESCAPE '\' OR cc.email ILIKE ${pattern} ESCAPE '\')) AS hit_requester
        FROM tickets t
        LEFT JOIN LATERAL (
          SELECT a.kind, a.is_internal, a.is_inbound, a.author, a.body FROM ticket_activity a
          WHERE a.ticket_id = t.id AND a.kind IN ('message', 'note') AND a.body ILIKE ${pattern} ESCAPE '\\'
          ORDER BY a.created_at DESC LIMIT 1
        ) h ON true
        WHERE ${where}
        ORDER BY ${extra.order}
        LIMIT ${pageSize} OFFSET ${offset}`;

      const ids = pageRows.map((r) => r.id);
      const found = await this.prisma.tickets.findMany({ where: { id: { in: ids } }, select: TICKET_FIELDS });
      const byId = new Map(found.map((r) => [r.id, r]));
      const items = pageRows.flatMap((p) => {
        const r = byId.get(p.id);
        if (!r) return [];
        const ticket = toTicket(r);
        if (!p.in_subject) {
          if (p.hit_body) {
            ticket.match = {
              in: p.hit_internal ? "private note" : p.hit_inbound ? "customer reply" : "reply",
              author: String(p.hit_author ?? ""),
              snippet: snippetAround(p.hit_body, term),
            };
          } else if (p.in_description && r.description) {
            ticket.match = { in: "description", author: "", snippet: snippetAround(r.description, term) };
          } else if (p.in_custom) {
            ticket.match = { in: "custom field", author: "", snippet: "" };
          } else if (p.hit_device) {
            ticket.match = { in: "device", author: "", snippet: p.hit_device };
          } else if (p.hit_requester) {
            ticket.match = { in: "requester", author: "", snippet: p.hit_requester };
          }
        }
        return [ticket];
      });
      return { items: await this.decorate(items, req), page, pageSize, total };
    }

    const where: Prisma.ticketsWhereInput = {
      ...(orgId ? { organization_id: orgId } : {}),
      ...(status ? { status } : {}),
      ...(priority ? { priority } : {}),
      ...(q.deviceId ? { ticket_devices: { some: { device_id: q.deviceId } } } : {}),
      ...(q.contactId ? { requester_customer_contact_id: q.contactId } : {}),
      ...(q.recurringId ? { recurring_id: q.recurringId } : {}),
    };

    // One custom field with one value: the matching ids come from SQL (Prisma has no case-blind JSON match), the rows from Prisma.
    const byField = customFieldFilter(q.customField, q.customValue);
    if (byField || extra.active) {
      const filters: Prisma.Sql[] = [...(byField ? [byField] : []), ...relationFilters(q), ...extra.sql];
      if (orgId) filters.push(Prisma.sql`t.organization_id::text = ${orgId}`);
      if (status) filters.push(Prisma.sql`t.status = ${status}::ticket_status`);
      if (priority) filters.push(Prisma.sql`t.priority = ${priority}::ticket_priority`);
      const cond = Prisma.join(filters, " AND ");
      const [{ n: total }] = await this.prisma.$queryRaw<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM tickets t WHERE ${cond}`;
      const ids = (await this.prisma.$queryRaw<{ id: string }[]>`
        SELECT t.id::text AS id FROM tickets t WHERE ${cond} ORDER BY ${extra.order} LIMIT ${pageSize} OFFSET ${offset}`).map((r) => r.id);
      const found = await this.prisma.tickets.findMany({ where: { id: { in: ids } }, select: TICKET_FIELDS });
      const byId = new Map(found.map((r) => [r.id, r]));
      const items = ids.flatMap((id) => (byId.has(id) ? [toTicket(byId.get(id)!)] : []));
      return { items: await this.decorate(items, req), page, pageSize, total };
    }

    const total = await this.prisma.tickets.count({ where });
    const rows = await this.prisma.tickets.findMany({
      where,
      select: TICKET_FIELDS,
      orderBy: { created_at: "desc" },
      take: pageSize,
      skip: offset,
    });

    return { items: await this.decorate(rows.map(toTicket), req), page, pageSize, total };
  }

  /** True unless the person is limited to some customers and this ticket is neither theirs nor one of those customers'. */
  private async canSee(req: any, row: { client_id: string | null; assignee_user_id: string | null }): Promise<boolean> {
    const userId = req?.user?.id ? String(req.user.id) : null;
    const allowed = await this.access.allowedFor(userId);
    if (!allowed) return true;
    return (!!row.client_id && allowed.includes(row.client_id)) || (!!userId && row.assignee_user_id === userId);
  }

  /**
   * For the routes that work on a ticket by id outside this service (stopwatch, reply templates): a person limited to some
   * customers gets "not found" for a ticket that is neither theirs nor one of their customers'. A ticket that does not
   * exist is left to the caller, as before.
   */
  async assertVisible(id: string, req: any): Promise<void> {
    const where = ticketWhere(id, getOrgIdFromReq(req));
    if (!where) return;
    const row = await this.prisma.tickets.findFirst({ where, select: TICKET_FIELDS });
    if (row && !(await this.canSee(req, row))) throw new NotFoundException("Ticket not found");
  }

  /** A queue given for a ticket has to exist in this organization and be switched on. Null (or empty) is no queue. */
  private async checkQueue(orgId: string | null, queueId: unknown): Promise<string | null> {
    if (queueId === null || queueId === undefined || queueId === "") return null;
    const id = String(queueId);
    const q = isCanonicalUuid(id) ? await this.prisma.ticket_queues.findFirst({ where: { id, ...(orgId ? { organization_id: orgId } : {}) }, select: { id: true, enabled: true } }) : null;
    if (!q) throw new BadRequestException("That queue does not exist.");
    if (!q.enabled) throw new BadRequestException("That queue is switched off.");
    return q.id;
  }

  private async queueNames(ids: (string | null)[]): Promise<Map<string, string>> {
    const wanted = [...new Set(ids.filter((x): x is string => !!x))];
    if (!wanted.length) return new Map();
    return new Map((await this.prisma.ticket_queues.findMany({ where: { id: { in: wanted } }, select: { id: true, name: true } })).map((q) => [q.id, q.name]));
  }

  /** Adds the queue's name and the response and resolution clocks. */
  private async addServiceDesk(items: Ticket[]): Promise<void> {
    const [views, names] = await Promise.all([this.desk.sla.viewsFor(items.map((i) => i.id)), this.queueNames(items.map((i) => i.queueId ?? null))]);
    for (const t of items) {
      t.queueName = t.queueId ? names.get(t.queueId) ?? null : null;
      t.sla = views.get(t.id) ?? null;
    }
  }

  /** Adds who asked and whether the customer has replied since this person last looked. */
  private async decorate(items: Ticket[], req: any): Promise<Ticket[]> {
    if (!items.length) return items;
    const userId = req?.user?.id && isCanonicalUuid(String(req.user.id)) ? String(req.user.id) : null;
    const rows = await this.prisma.$queryRaw<{ id: string; name: string | null; email: string | null; cc_id: string | null; cc_name: string | null; cc_email: string | null; cc_phone: string | null; cc_mobile: string | null; cc_title: string | null; device_count: number; device_names: string[] | null; last_inbound: Date | null; read_at: Date | null }[]>`
      SELECT t.id::text AS id,
             COALESCE(pa.name, cc.name, c.name) AS name,
             COALESCE(pa.email::text, cc.email::text, c.email::text) AS email,
             cc.id::text AS cc_id, cc.name AS cc_name, cc.email AS cc_email, cc.phone AS cc_phone, cc.mobile AS cc_mobile, cc.job_title AS cc_title,
             (SELECT count(*)::int FROM ticket_devices td WHERE td.ticket_id = t.id) AS device_count,
             (SELECT array_agg(x.n) FROM (SELECT COALESCE(d.alias, d.hostname) AS n FROM ticket_devices td JOIN devices d ON d.id = td.device_id WHERE td.ticket_id = t.id ORDER BY td.added_at LIMIT 3) x) AS device_names,
             (SELECT max(a.created_at) FROM ticket_activity a WHERE a.ticket_id = t.id AND a.kind = 'message' AND a.is_inbound = true) AS last_inbound,
             (SELECT r.read_at FROM ticket_staff_reads r WHERE r.ticket_id = t.id AND r.user_id = ${userId}::uuid) AS read_at
        FROM tickets t
        LEFT JOIN portal_accounts pa ON pa.id = t.portal_account_id
        LEFT JOIN contacts c ON c.id = t.requester_contact_id
        LEFT JOIN customer_contacts cc ON cc.id = t.requester_customer_contact_id
       WHERE t.id = ANY(${items.map((i) => i.id)}::uuid[])`;
    const by = new Map(rows.map((r) => [r.id, r]));
    for (const t of items) {
      const r = by.get(t.id);
      if (!r) continue;
      t.requesterName = r.name;
      t.requesterEmail = r.email;
      t.requesterContact = r.cc_id ? { id: r.cc_id, name: r.cc_name ?? "", email: r.cc_email, phone: r.cc_phone, mobile: r.cc_mobile, jobTitle: r.cc_title } : null;
      t.deviceCount = r.device_count;
      t.deviceNames = r.device_names ?? [];
      t.lastCustomerReplyAt = r.last_inbound ? r.last_inbound.toISOString() : null;
      t.hasNewReply = !!r.last_inbound && (!r.read_at || r.last_inbound.getTime() > r.read_at.getTime());
    }
    await this.addServiceDesk(items);
    return items;
  }

  /** This technician has now seen the ticket as it stands. */
  async markRead(id: string, req: any): Promise<void> {
    const t = await this.requireTicket(id, req);
    const userId = req?.user?.id && isCanonicalUuid(String(req.user.id)) ? String(req.user.id) : null;
    if (!userId) return;
    await this.prisma.$executeRaw`
      INSERT INTO ticket_staff_reads (user_id, ticket_id, read_at) VALUES (${userId}::uuid, ${t.id}::uuid, ${new Date()})
      ON CONFLICT (user_id, ticket_id) DO UPDATE SET read_at = EXCLUDED.read_at`;
  }

  async getOne(id: string, req: any): Promise<Ticket | null> {
    const where = ticketWhere(id, getOrgIdFromReq(req));
    if (!where) return null;

    const r = await this.prisma.tickets.findFirst({ where, select: TICKET_FIELDS });
    if (r && !(await this.canSee(req, r))) return null;
    return r ? (await this.decorate([toTicket(r)], req))[0] : null;
  }

  /** A customer given for a ticket has to exist in this organization. */
  private async assertClient(clientId: unknown, orgId: string | null) {
    if (!clientId) return;
    const ok = await this.prisma.clients.findFirst({ where: { id: String(clientId), ...(orgId ? { organization_id: orgId } : {}) }, select: { id: true } });
    if (!ok) throw new BadRequestException("That customer does not exist.");
  }

  async create(dto: CreateTicketDto, req: any, opts?: { enforceRequired?: boolean; source?: string }): Promise<string> {
    const orgId = getOrgIdFromReq(req);
    if (!orgId) {
      throw new BadRequestException("organizationId is required (not found in request session)");
    }

    // A template supplies what the form did not: subject, description, priority and custom field values.
    let template: { subject: string; body: string; priority: string; custom_fields: unknown } | null = null;
    if ((dto as any).templateId) {
      template = await this.prisma.ticket_templates.findFirst({ where: { id: String((dto as any).templateId), organization_id: orgId }, select: { subject: true, body: true, priority: true, custom_fields: true } });
      if (!template) throw new BadRequestException("That ticket template does not exist.");
    }

    const title = String((dto as any).subject ?? (dto as any).title ?? template?.subject ?? "").trim();
    if (!title) throw new BadRequestException("subject/title is required");
    if ((dto as any).description === undefined && template?.body) (dto as any).description = template.body;
    if ((dto as any).priority === undefined && template) (dto as any).priority = template.priority;
    await this.assertClient((dto as any).clientId, orgId);
    const queueId = await this.checkQueue(orgId, (dto as any).queueId);

    // The customer, the contact who asked and the devices have to agree: the devices and the contact are the ticket's own customer's.
    const wantedDevices = [...new Set([...((dto as any).deviceId ? [String((dto as any).deviceId)] : []), ...(((dto as any).deviceIds as string[] | undefined) ?? [])])];
    const checkedDevices = await checkTicketDevices(this.prisma, orgId, (dto as any).clientId ?? null, wantedDevices);
    let ticketClientId: string | null = checkedDevices.clientId;
    const requesterContactId: string | null = (dto as any).requesterCustomerContactId ?? null;
    if (requesterContactId) {
      const contact = await requireCustomerContact(this.prisma, requesterContactId, ticketClientId);
      ticketClientId = ticketClientId ?? contact.client_id;
      await this.assertClient(ticketClientId, orgId);
    }

    // Required custom fields are enforced for people filling in the form; tickets opened by the system (alerts) skip it.
    const fromTemplate = template ? await this.customFields.onlyActive(orgId, savedValues(template.custom_fields), "ticket") : {};
    const sent = (dto as any).customFields === undefined && !template ? undefined : { ...fromTemplate, ...((dto as any).customFields ?? {}) };
    const custom = (await this.customFields.valuesToSave(orgId, sent, {}, opts?.enforceRequired === true, "ticket")) ?? {};

    const status = String((dto as any).status ?? "open").toLowerCase() as Ticket["status"];
    const priorityApi = String((dto as any).priority ?? "medium").toLowerCase();

    if (!STATUS_ALLOW.has(status)) throw new BadRequestException("Invalid status");
    if (!PRIORITY_ALLOW.has(priorityApi)) throw new BadRequestException("Invalid priority");

    const priorityDb = priorityApiToDb(priorityApi);

    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        // Prisma cannot insert from a select, and this must stay one statement so numbering is atomic.
        const rows = await this.prisma.$queryRaw<{ id: string }[]>`
          WITH next_num AS (
            SELECT COALESCE(MAX(t.ticket_number), 0) + 1 AS n
            FROM tickets t
            WHERE t.organization_id = ${orgId}::uuid
          )
          INSERT INTO tickets
            (organization_id, ticket_number, subject, description, status, priority, assignee_user_id, requester_contact_id, device_id, client_id, custom_fields, created_at, updated_at)
          SELECT
            ${orgId}::uuid, next_num.n, ${title}::text, ${(dto as any).description ?? null}::text,
            ${status}::ticket_status, ${priorityDb}::ticket_priority,
            ${(dto as any).assigneeUserId ?? null}::uuid, ${(dto as any).requesterContactId ?? null}::uuid,
            ${(dto as any).deviceId ?? null}::uuid,
            COALESCE(${(dto as any).clientId ?? null}::uuid, (SELECT s.client_id FROM devices d JOIN sites s ON s.id = d.site_id WHERE d.id = ${(dto as any).deviceId ?? null}::uuid)),
            ${JSON.stringify(custom)}::jsonb,
            now(), now()
          FROM next_num
          RETURNING id::text AS id`;
        await this.afterCreate(rows[0].id, { devices: checkedDevices.devices, clientId: ticketClientId, contactId: requesterContactId, recurringId: (dto as any).recurringId ?? null, actor: getActorFromReq(req) });
        // Queue, routing rules and the SLA clocks, before the created event so it describes the ticket as routed.
        const source = opts?.source ?? (opts?.enforceRequired ? "ui" : "api");
        if (queueId) await this.prisma.tickets.updateMany({ where: { id: rows[0].id }, data: { queue_id: queueId } });
        await this.desk.onCreated(rows[0].id, { source, priorityGiven: (source === "ui" || source === "api") && (dto as any).priority !== undefined, assigneeGiven: !!(dto as any).assigneeUserId, actorUserId: req?.user?.id ? String(req.user.id) : null, acknowledged: source === "ui" });
        void this.webhooks.emitTicket("ticket.created", rows[0].id, {}, orgId);
        fireWorkflow({ trigger: "ticket.created", ticketId: rows[0].id, source });
        return rows[0].id;
      } catch (err: any) {
        if (isUniqueViolation(err) && attempt < 4) continue;
        throw err;
      }
    }

    throw new Error("Failed to create ticket");
  }

  /** What the insert does not set: the customer's contact, the recurring schedule, the customer taken from the contact, and the linked devices. */
  private async afterCreate(id: string, o: { devices: Parameters<typeof linkTicketDevices>[2]; clientId: string | null; contactId: string | null; recurringId: string | null; actor: string }) {
    try {
      const data: Prisma.ticketsUncheckedUpdateManyInput = {};
      if (o.contactId) data.requester_customer_contact_id = o.contactId;
      if (o.recurringId) data.recurring_id = o.recurringId;
      if (Object.keys(data).length) await this.prisma.tickets.updateMany({ where: { id }, data });
      if (o.clientId) await this.prisma.tickets.updateMany({ where: { id, client_id: null }, data: { client_id: o.clientId } });
      await linkTicketDevices(this.prisma, id, o.devices, o.actor, { quiet: true });
    } catch {
      // The ticket exists; a failed link must not make the caller (an alert, a schedule) try to open it a second time.
    }
  }

  private async requireTicket(id: string, req: any): Promise<{ id: string; orgId: string | null; row: TicketRow }> {
    const where = ticketWhere(id, getOrgIdFromReq(req));
    const row = where ? await this.prisma.tickets.findFirst({ where, select: TICKET_FIELDS }) : null;
    if (!row || !(await this.canSee(req, row))) throw new NotFoundException("Ticket not found");
    return { id: row.id, orgId: row.organization_id, row };
  }

  /** Postgres accepts more date formats than Prisma, such as "Jan 5 2026 10:00", so it does the parsing. */
  private async parseTimestamp(value: string): Promise<Date> {
    const [{ v }] = await this.prisma.$queryRaw<{ v: Date }[]>`SELECT ${value}::timestamptz AS v`;
    return new Date(v);
  }

  private async addChanges(
    ticketId: string,
    actor: string,
    changes: {
      field: "status" | "priority" | "assignee" | "title" | "dueAt" | "collaborators" | "requester" | "queue" | `custom:${string}`;
      from: string | null;
      to: string | null;
    }[]
  ) {
    if (changes.length === 0) return;

    // History lists newest first, and Prisma's timestamps stop at milliseconds: keep them distinct.
    const base = Date.now();
    try {
      await this.prisma.ticket_activity.createMany({
        data: changes.map((c, i) => ({
          id: randomUUID(),
          ticket_id: ticketId,
          kind: "change",
          body: `${c.field}: ${c.from ?? "-"} -> ${c.to ?? "-"}`,
          attachments: [],
          time_worked_seconds: 0,
          notify_customer: false,
          author: actor,
          is_internal: true,
          field: c.field,
          from_value: c.from,
          to_value: c.to,
          created_at: new Date(base + i),
        })),
      });
    } catch {
      // History is best-effort: the ticket itself has already been saved.
    }
  }

  async update(id: string, dto: UpdateTicketDto, req: any): Promise<boolean> {
    const actor = getActorFromReq(req);
    const before = await this.requireTicket(id, req);

    const data: Prisma.ticketsUncheckedUpdateManyInput = {};

    if ((dto as any).subject !== undefined || (dto as any).title !== undefined) {
      const nextTitle = String((dto as any).subject ?? (dto as any).title ?? "").trim();
      if (!nextTitle) throw new BadRequestException("subject/title cannot be empty");
      data.subject = nextTitle;
    }

    if ((dto as any).description !== undefined) {
      data.description = (dto as any).description;
    }

    if ((dto as any).status !== undefined) {
      const s = String((dto as any).status).toLowerCase() as Ticket["status"];
      if (!STATUS_ALLOW.has(s)) throw new BadRequestException("Invalid status");
      data.status = s;
    }

    if ((dto as any).priority !== undefined) {
      const pr = String((dto as any).priority).toLowerCase();
      if (!PRIORITY_ALLOW.has(pr)) throw new BadRequestException("Invalid priority");
      data.priority = priorityApiToDb(pr) as ticket_priority;
    }

    if ((dto as any).assigneeUserId !== undefined) {
      data.assignee_user_id = (dto as any).assigneeUserId;
    }

    // A queue picked by hand. A ticket nobody has yet goes to the queue's own pick (its person, or the next in turn).
    if ((dto as any).queueId !== undefined) {
      const queueId = await this.checkQueue(before.orgId, (dto as any).queueId);
      data.queue_id = queueId;
      if ((dto as any).assigneeUserId === undefined && !before.row.assignee_user_id && queueId && queueId !== before.row.queue_id && before.orgId) {
        const pick = await this.desk.routing.assigneeForQueue(before.orgId, queueId);
        if (pick) data.assignee_user_id = pick;
      }
    }

    if ((dto as any).requesterContactId !== undefined) {
      data.requester_contact_id = (dto as any).requesterContactId;
    }

    // The main device and the contact who asked are set below, once the ticket's customer is known, so they can be checked against it.

    // The customer: as given, or from the new device when the ticket has none yet.
    if ((dto as any).clientId !== undefined) {
      await this.assertClient((dto as any).clientId, before.orgId);
      data.client_id = (dto as any).clientId;
    } else if ((dto as any).deviceId && !before.row.client_id) {
      const d = await this.prisma.devices.findUnique({ where: { id: (dto as any).deviceId }, select: { sites: { select: { client_id: true } } } });
      if (d?.sites?.client_id) data.client_id = d.sites.client_id;
    }

    // Devices and the contact who asked have to be of the ticket's own customer.
    let effectiveClient: string | null = typeof data.client_id === "string" ? data.client_id : before.row.client_id;
    if (typeof data.client_id === "string" && before.row.client_id && data.client_id !== before.row.client_id) {
      const strangers = await this.prisma.ticket_devices.count({ where: { ticket_id: id, devices: { sites: { client_id: { not: data.client_id } } } } });
      if (strangers > 0) throw new BadRequestException("This ticket has devices of the old customer. Remove them before changing the customer.");
      if (before.row.requester_customer_contact_id && (dto as any).requesterCustomerContactId === undefined) throw new BadRequestException("The contact who asked belongs to the old customer. Choose a contact of the new customer or clear it.");
    }
    let deviceToLink: Parameters<typeof linkTicketDevices>[2] = [];
    if ((dto as any).deviceId) {
      const checked = await checkTicketDevices(this.prisma, before.row.organization_id, effectiveClient, [String((dto as any).deviceId)]);
      deviceToLink = checked.devices;
      data.device_id = String((dto as any).deviceId);
      if (!effectiveClient && checked.clientId) {
        data.client_id = checked.clientId;
        effectiveClient = checked.clientId;
      }
    } else if ((dto as any).deviceId === null && before.row.device_id) {
      await unlinkTicketDevice(this.prisma, { id: before.id, device_id: before.row.device_id }, before.row.device_id, actor);
    }
    if ((dto as any).requesterCustomerContactId !== undefined) {
      const contactId = (dto as any).requesterCustomerContactId as string | null;
      if (contactId) {
        const contact = await requireCustomerContact(this.prisma, contactId, effectiveClient);
        if (!effectiveClient) {
          await this.assertClient(contact.client_id, before.orgId);
          data.client_id = contact.client_id;
          effectiveClient = contact.client_id;
        }
        data.requester_customer_contact_id = contactId;
      } else {
        data.requester_customer_contact_id = null;
      }
    }

    // Custom fields: only what was sent changes; required ones are checked when any were sent.
    let customDefs: { key: string; label: string; type: string }[] = [];
    if ((dto as any).customFields !== undefined) {
      const merged = await this.customFields.valuesToSave(before.row.organization_id, (dto as any).customFields, savedValues(before.row.custom_fields), false, "ticket");
      if (merged) {
        data.custom_fields = merged as Prisma.InputJsonValue;
        customDefs = await this.customFields.list(before.row.organization_id, true, "ticket");
      }
    }

    if ((dto as any).dueAt !== undefined) {
      const dueAt = (dto as any).dueAt as string | null;
      data.due_at = dueAt === null ? null : await this.parseTimestamp(dueAt);
    }

    if ((dto as any).closedAt !== undefined) {
      const closedAt = (dto as any).closedAt as string | null;
      data.closed_at = closedAt === null ? null : await this.parseTimestamp(closedAt);
    }

    if (deviceToLink.length) await linkTicketDevices(this.prisma, id, deviceToLink, actor);

    if (Object.keys(data).length === 0) return true;

    data.updated_at = new Date();

    await this.prisma.tickets.updateMany({ where: { id }, data });

    try {
      const after = await this.requireTicket(id, req);
      const changes: Parameters<TicketsService["addChanges"]>[2] = [];

      const beforeTitle = before.row.subject;
      const afterTitle = after.row.subject;
      if (beforeTitle !== afterTitle) changes.push({ field: "title", from: beforeTitle || null, to: afterTitle || null });

      const beforeStatus = String(before.row.status);
      const afterStatus = String(after.row.status);
      if (beforeStatus !== afterStatus) changes.push({ field: "status", from: beforeStatus || null, to: afterStatus || null });

      const beforePr = priorityDbToApi(before.row.priority);
      const afterPr = priorityDbToApi(after.row.priority);
      if (beforePr !== afterPr) changes.push({ field: "priority", from: beforePr || null, to: afterPr || null });

      const beforeAssignee = before.row.assignee_user_id ?? "";
      const afterAssignee = after.row.assignee_user_id ?? "";
      if (beforeAssignee !== afterAssignee) changes.push({ field: "assignee", from: beforeAssignee || null, to: afterAssignee || null });

      if (before.row.queue_id !== after.row.queue_id) {
        const names = await this.queueNames([before.row.queue_id, after.row.queue_id]);
        changes.push({ field: "queue", from: before.row.queue_id ? names.get(before.row.queue_id) ?? null : null, to: after.row.queue_id ? names.get(after.row.queue_id) ?? null : null });
      }

      const beforeDue = before.row.due_at ? before.row.due_at.toISOString() : null;
      const afterDue = after.row.due_at ? after.row.due_at.toISOString() : null;
      if (beforeDue !== afterDue) changes.push({ field: "dueAt", from: beforeDue, to: afterDue });

      if ((before.row.requester_customer_contact_id ?? null) !== (after.row.requester_customer_contact_id ?? null)) {
        const ids = [before.row.requester_customer_contact_id, after.row.requester_customer_contact_id].filter((v): v is string => !!v);
        const names = new Map((await this.prisma.customer_contacts.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((c) => [c.id, c.name]));
        changes.push({ field: "requester", from: (before.row.requester_customer_contact_id && names.get(before.row.requester_customer_contact_id)) || null, to: (after.row.requester_customer_contact_id && names.get(after.row.requester_customer_contact_id)) || null });
      }

      const beforeCustom = savedValues(before.row.custom_fields);
      const afterCustom = savedValues(after.row.custom_fields);
      for (const d of customDefs) {
        const was = beforeCustom[d.key];
        const now = afterCustom[d.key];
        if (JSON.stringify(was ?? null) !== JSON.stringify(now ?? null)) {
          changes.push({ field: `custom:${d.label}`, from: displayValue(d.type, was), to: displayValue(d.type, now) });
        }
      }

      await this.addChanges(id, actor, changes);
      if (changes.length > 0) void this.webhooks.emitTicket("ticket.updated", id, { changes: changes.map((c) => ({ field: c.field.replace(/^custom:/, ""), from: c.from, to: c.to })), changedBy: actor }, after.orgId ?? undefined);
    } catch {
      // ignore
    }

    // The SLA clocks follow status, priority, queue and customer. A technician taking the ticket out of "open" counts as the first response.
    await this.desk.onChanged(id, data.status !== undefined && before.row.status === "open" && data.status !== "open" ? { respondedAt: new Date() } : {});

    return true;
  }

  async addMessageOrNote(
    ticketId: string,
    req: any,
    kind: "message" | "note",
    payload: {
      body?: string;
      attachments?: { id?: string; name: string; size?: number; url: string }[];
      notifyCustomer?: boolean;
      handoff?: boolean;
      /** Time spent, logged as a time entry on the ticket. */
      time?: { minutes?: unknown; billable?: unknown };
      /** Whether the person may type time in (tickets.time.manual). */
      canManualTime?: boolean;
    }
  ) {
    const ticket = await this.requireTicket(ticketId, req);

    const actor = getActorFromReq(req);
    const body = String(payload?.body ?? "").trim();
    const attachments = Array.isArray(payload?.attachments) ? payload.attachments : [];
    const notify = kind === "message" ? !!payload?.notifyCustomer : false;

    // Time first: a time that is not valid stops the reply instead of quietly dropping the time.
    const loggedMinutes = await this.time.logFromReply(req, ticket.id, payload?.time, body, payload?.canManualTime === true);

    await this.prisma.ticket_activity.create({
      data: {
        id: randomUUID(),
        ticket_id: ticket.id,
        kind,
        body,
        attachments: attachments as unknown as Prisma.InputJsonValue,
        time_worked_seconds: loggedMinutes * 60,
        notify_customer: notify,
        author: actor,
        is_internal: kind === "note",
        is_handoff: kind === "note" && payload?.handoff === true,
      },
    });

    // A reply to the customer is the first response: it stops that clock.
    if (kind === "message") await this.desk.onStaffReply(ticket.id);

    // A reply marked "notify the customer" is also emailed. The ticket keeps the reply either way, and says if the email failed.
    let emailed: { sent: boolean; reason?: string } | undefined;
    if (notify && body && ticket.orgId) emailed = await this.mailbox.sendReply(ticket.orgId, ticket.id, body, actor);

    return { ok: true, ...(emailed ? { emailed } : {}) };
  }

  /**
   * Replies (messages only). Newest first.
   */
  async getReplies(ticketId: string, req: any): Promise<ReplyItem[]> {
    const ticket = await this.requireTicket(ticketId, req);

    const rows = await this.prisma.ticket_activity.findMany({
      where: { ticket_id: ticket.id, kind: "message" },
      orderBy: { created_at: "desc" },
    });

    return rows.map((r): ReplyItem => ({
      id: r.id,
      kind: "message",
      author: r.author,
      body: r.body,
      createdAt: r.created_at.toISOString(),
      isInternal: false,
      isInbound: r.is_inbound === true,
      ...(r.is_inbound === true ? { via: r.via === "portal" ? ("portal" as const) : ("email" as const) } : {}),
      timeWorkedSeconds: r.time_worked_seconds,
      attachments: normalizeAttachments(r.attachments),
    }));
  }

  /**
   * Internal Notes (notes only). Newest first.
   */
  async getInternalNotes(ticketId: string, req: any): Promise<NoteItem[]> {
    const ticket = await this.requireTicket(ticketId, req);

    const rows = await this.prisma.ticket_activity.findMany({
      where: { ticket_id: ticket.id, kind: "note" },
      orderBy: { created_at: "desc" },
    });

    return rows.map((r): NoteItem => ({
      id: r.id,
      kind: "note",
      author: r.author,
      body: r.body,
      createdAt: r.created_at.toISOString(),
      isInternal: true,
      isHandoff: r.is_handoff === true,
      timeWorkedSeconds: r.time_worked_seconds,
      attachments: normalizeAttachments(r.attachments),
    }));
  }

  async getHistory(ticketId: string, req: any): Promise<{ at: string; who: string; what: string }[]> {
    const ticket = await this.requireTicket(ticketId, req);

    const rows = await this.prisma.ticket_activity.findMany({
      where: { ticket_id: ticket.id, kind: "change" },
      orderBy: { created_at: "desc" },
      take: 100,
    });

    return rows.map((r) => {
      const f = String(r.field ?? "").trim();
      return {
        at: r.created_at.toISOString(),
        who: r.author,
        what: f ? `${f.replace(/^custom:/, "")}: ${r.from_value ?? "-"} -> ${r.to_value ?? "-"}` : r.body,
      };
    });
  }

  async getLinked(ticketId: string, req: any): Promise<LinkedTicket[]> {
    const ticket = await this.requireTicket(ticketId, req);

    const orgId = getOrgIdFromReq(req);
    const inOrg = orgId ? { organization_id: orgId } : {};

    const rows = await this.prisma.ticket_links.findMany({
      where: {
        ticket_id: ticket.id,
        tickets_ticket_links_ticket_idTotickets: inOrg,
        tickets_ticket_links_linked_ticket_idTotickets: inOrg,
      },
      orderBy: { tickets_ticket_links_linked_ticket_idTotickets: { created_at: "desc" } },
      select: {
        tickets_ticket_links_linked_ticket_idTotickets: {
          select: { id: true, ticket_number: true, subject: true, status: true },
        },
      },
    });

    return rows.map(({ tickets_ticket_links_linked_ticket_idTotickets: lt }) => ({
      id: lt.id,
      number: String(Number(lt.ticket_number)),
      title: lt.subject,
      status: lt.status,
    }));
  }

  private async resolveLinkedTicketId(linkedRefRaw: string, req: any): Promise<string> {
    const linkedRef = String(linkedRefRaw ?? "").trim();

    if (isUuid(linkedRef)) return linkedRef;

    const orgId = getOrgIdFromReq(req);
    if (!orgId) {
      throw new BadRequestException("Linking by ticket number requires organization context; provide a UUID instead.");
    }

    if (!isIntLike(linkedRef)) {
      throw new BadRequestException("linkedId must be a UUID or a numeric ticket number");
    }

    const num = Number(linkedRef);
    if (!Number.isFinite(num) || num <= 0) {
      throw new BadRequestException("Invalid ticket number");
    }

    const r = isCanonicalUuid(orgId)
      ? await this.prisma.tickets.findFirst({
          where: { organization_id: orgId, ticket_number: BigInt(num) },
          select: { id: true },
        })
      : null;
    if (!r?.id) throw new NotFoundException("Linked ticket not found");
    return r.id;
  }

  async addLink(ticketId: string, linkedIdOrNumber: string, req: any) {
    const resolvedLinkedId = await this.resolveLinkedTicketId(linkedIdOrNumber, req);

    if (ticketId === resolvedLinkedId) throw new BadRequestException("Cannot link a ticket to itself");

    const a = await this.requireTicket(ticketId, req);
    const b = await this.requireTicket(resolvedLinkedId, req);

    if (a.orgId && b.orgId && a.orgId !== b.orgId) {
      throw new BadRequestException("Cannot link tickets across organizations");
    }

    await this.prisma.ticket_links.createMany({
      data: [
        { id: randomUUID(), ticket_id: ticketId, linked_ticket_id: resolvedLinkedId },
        { id: randomUUID(), ticket_id: resolvedLinkedId, linked_ticket_id: ticketId },
      ],
      skipDuplicates: true,
    });

    return { ok: true };
  }
}
