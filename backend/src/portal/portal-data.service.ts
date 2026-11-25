import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../storage/prisma.service";
import { BillingService } from "../billing/billing.service";
import { FullReportService, QBR_SECTIONS } from "../reports/full-report.service";
import { ReportsService } from "../reports/reports.service";
import { PortalSettingsService } from "./portal-settings.service";
import { WebhooksService } from "../webhooks/webhooks.service";
import { ServiceDeskService } from "../service-desk/service-desk.service";
import type { PortalActor } from "./portal-auth.service";
import { STATUS_LABEL } from "./portal.util";
import { displayValue } from "../customers/custom-fields";
import { fireWorkflow } from "../workflows/workflows.bus";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const need = (id: string, what: string) => {
    if (!UUID.test(String(id ?? ""))) throw new NotFoundException(`${what} not found`);
    return id;
};

/** Everything a signed-in customer person can read or do. Every query is limited to their own company (and, for a plain user, their own tickets). */
@Injectable()
export class PortalDataService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly settings: PortalSettingsService,
        private readonly billing: BillingService,
        private readonly full: FullReportService,
        private readonly reports: ReportsService,
        private readonly webhooks: WebhooksService,
        private readonly desk: ServiceDeskService,
    ) { }

    /** The areas this person may open: what the administrator turned on, and what their role allows. */
    async modulesFor(actor: PortalActor): Promise<string[]> {
        const on = (await this.settings.get()).modules;
        return on.filter((m) => m === "dashboard" || m === "tickets" || m === "knowledge" || actor.role === "manager");
    }

    async requireModule(actor: PortalActor, module: "tickets" | "devices" | "invoices" | "dashboard" | "reports" | "knowledge") {
        if (!(await this.modulesFor(actor)).includes(module)) throw new ForbiddenException("This area is not available to you.");
    }

    /* --------------------------------- tickets --------------------------------- */

    private visible(actor: PortalActor) {
        return actor.role === "manager" ? { all: true } : { all: false };
    }

    async tickets(actor: PortalActor, filter: { status?: string; q?: string }) {
        const open = filter.status === "open";
        const closed = filter.status === "closed";
        const q = String(filter.q ?? "").trim().slice(0, 100);
        const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        const rows = await this.prisma.$queryRaw<any[]>`
            SELECT t.id::text AS id, t.ticket_number::int AS number, t.subject, t.status::text AS status, t.created_at, t.updated_at, d.hostname AS device,
                   ${this.unreadSql(actor)} AS unread
              FROM tickets t LEFT JOIN devices d ON d.id = t.device_id
             WHERE t.client_id = ${actor.clientId}::uuid
               AND (${this.visible(actor).all} OR t.portal_account_id = ${actor.accountId}::uuid)
               AND (${open}::boolean = false OR t.status::text NOT IN ('resolved', 'closed'))
               AND (${closed}::boolean = false OR t.status::text IN ('resolved', 'closed'))
               AND (${q} = '' OR t.subject ILIKE ${like} OR t.ticket_number::text = ${q.replace(/^#/, "")})
             ORDER BY t.updated_at DESC
             LIMIT 300`;
        return rows.map((r) => ({ id: r.id, number: r.number, subject: r.subject, status: r.status, statusLabel: STATUS_LABEL[r.status] ?? r.status, createdAt: r.created_at, updatedAt: r.updated_at, device: r.device ?? null, unread: r.unread === true }));
    }

    private async ticketRow(actor: PortalActor, id: string) {
        const rows = await this.prisma.$queryRaw<any[]>`
            SELECT t.id::text AS id, t.ticket_number::int AS number, t.subject, t.description, t.status::text AS status, t.created_at, t.updated_at, t.closed_at,
                   d.hostname AS device, pa.name AS opened_by, t.custom_fields, t.organization_id::text AS org_id
              FROM tickets t LEFT JOIN devices d ON d.id = t.device_id LEFT JOIN portal_accounts pa ON pa.id = t.portal_account_id
             WHERE t.id = ${need(id, "Ticket")}::uuid AND t.client_id = ${actor.clientId}::uuid
               AND (${this.visible(actor).all} OR t.portal_account_id = ${actor.accountId}::uuid)`;
        if (!rows[0]) throw new NotFoundException("Ticket not found");
        return rows[0];
    }

    /** The ticket and its public conversation. Private notes and who on the support team wrote what stay inside. */
    async ticket(actor: PortalActor, id: string) {
        const t = await this.ticketRow(actor, id);
        const acts = await this.prisma.ticket_activity.findMany({
            where: { ticket_id: t.id, kind: "message", is_internal: false },
            orderBy: { created_at: "asc" },
            select: { id: true, author: true, body: true, is_inbound: true, created_at: true },
        });
        // What this person had seen before now, so the new replies can be pointed out. Opening the ticket marks it seen.
        const prev = await this.prisma.portal_ticket_reads.findUnique({ where: { account_id_ticket_id: { account_id: actor.accountId, ticket_id: t.id } } });
        await this.prisma.$executeRaw`INSERT INTO portal_ticket_reads (account_id, ticket_id, read_at) VALUES (${actor.accountId}::uuid, ${t.id}::uuid, now())
            ON CONFLICT (account_id, ticket_id) DO UPDATE SET read_at = EXCLUDED.read_at`;
        const seenUntil = prev?.read_at ?? null;
        // Only the ticket fields marked "visible to customer", and only those with a value.
        const saved = t.custom_fields && typeof t.custom_fields === "object" && !Array.isArray(t.custom_fields) ? (t.custom_fields as Record<string, unknown>) : {};
        const defs = await this.prisma.custom_field_defs.findMany({
            where: { organization_id: t.org_id, entity: "ticket", active: true, visible_to_customer: true },
            orderBy: [{ sort_order: "asc" }, { created_at: "asc" }],
            select: { key: true, label: true, type: true },
        });
        const customFields = defs.flatMap((d) => {
            const value = displayValue(d.type, saved[d.key]);
            return value === null ? [] : [{ label: d.label, type: d.type, value }];
        });
        return {
            id: t.id, number: t.number, subject: t.subject, description: t.description ?? "", status: t.status, statusLabel: STATUS_LABEL[t.status] ?? t.status,
            createdAt: t.created_at, updatedAt: t.updated_at, closedAt: t.closed_at, device: t.device ?? null, openedBy: t.opened_by ?? null,
            canReply: t.status !== "closed",
            customFields,
            replies: acts.map((a) => ({ id: a.id, fromSupport: !a.is_inbound, author: a.is_inbound ? a.author : "Support team", body: a.body, createdAt: a.created_at, isNew: !a.is_inbound && (!seenUntil || a.created_at.getTime() > seenUntil.getTime()) })),
        };
    }

    async createTicket(actor: PortalActor, input: { subject?: unknown; description?: unknown; deviceId?: unknown }) {
        if (!(await this.settings.get()).allowTicketCreate) throw new ForbiddenException("Opening tickets from the portal is turned off.");
        const subject = String(input.subject ?? "").trim();
        const description = String(input.description ?? "").trim();
        if (!subject) throw new BadRequestException("Give the ticket a subject.");
        if (subject.length > 200) throw new BadRequestException("Keep the subject under 200 characters.");
        if (!description) throw new BadRequestException("Describe what you need.");
        if (description.length > 10_000) throw new BadRequestException("Keep the description under 10,000 characters.");

        let deviceId: string | null = null;
        if (input.deviceId) {
            if (actor.role !== "manager") throw new ForbiddenException("Only managers can pick a device.");
            const ok = await this.prisma.$queryRaw<{ id: string }[]>`
                SELECT d.id::text AS id FROM devices d JOIN sites s ON s.id = d.site_id
                 WHERE d.id = ${need(String(input.deviceId), "Device")}::uuid AND s.client_id = ${actor.clientId}::uuid`;
            if (!ok[0]) throw new BadRequestException("That device is not one of yours.");
            deviceId = ok[0].id;
        }

        for (let attempt = 0; attempt < 5; attempt++) {
            try {
                const rows = await this.prisma.$queryRaw<{ id: string; number: number }[]>`
                    WITH next_num AS (SELECT COALESCE(MAX(t.ticket_number), 0) + 1 AS n FROM tickets t WHERE t.organization_id = ${actor.orgId}::uuid)
                    INSERT INTO tickets (organization_id, ticket_number, subject, description, status, device_id, client_id, portal_account_id, created_at, updated_at)
                    SELECT ${actor.orgId}::uuid, next_num.n, ${subject}::text, ${description}::text, 'open'::ticket_status, ${deviceId}::uuid, ${actor.clientId}::uuid, ${actor.accountId}::uuid, now(), now()
                      FROM next_num
                    RETURNING id::text AS id, ticket_number::int AS number`;
                // Routing rules and the SLA clocks, before the created event so it describes the ticket as routed.
                await this.desk.onCreated(rows[0].id, { source: "portal" });
                void this.webhooks.emitTicket("ticket.created", rows[0].id, { source: "portal" }, actor.orgId);
                fireWorkflow({ trigger: "ticket.created", ticketId: rows[0].id, source: "portal" });
                return rows[0];
            } catch (e: any) {
                if (e?.code === "P2010" && /unique|23505/i.test(String(e?.message)) && attempt < 4) continue;
                throw e;
            }
        }
        throw new ConflictException("Could not open the ticket. Try again.");
    }

    async reply(actor: PortalActor, id: string, bodyInput: unknown) {
        const t = await this.ticketRow(actor, id);
        if (t.status === "closed") throw new ConflictException("This ticket is closed. Open a new one instead.");
        const body = String(bodyInput ?? "").trim();
        if (!body) throw new BadRequestException("Write a message first.");
        if (body.length > 10_000) throw new BadRequestException("Keep the message under 10,000 characters.");
        await this.prisma.$transaction([
            this.prisma.ticket_activity.create({ data: { id: randomUUID(), ticket_id: t.id, kind: "message", body, author: actor.name, is_inbound: true, via: "portal", is_internal: false, notify_customer: false } }),
            // An answer from the customer puts a waiting or resolved ticket back in front of the team.
            this.prisma.$executeRaw`UPDATE tickets SET updated_at = now(), status = CASE WHEN status::text IN ('pending', 'resolved') THEN 'open'::ticket_status ELSE status END WHERE id = ${t.id}::uuid`,
        ]);
        // A customer answer can take the ticket off hold or reopen it: the SLA clocks follow.
        await this.desk.onChanged(t.id);
        return { ok: true };
    }

    /** True when the support team has replied (publicly) after this person last opened the ticket. */
    private unreadSql(actor: PortalActor) {
        return Prisma.sql`EXISTS (SELECT 1 FROM ticket_activity a WHERE a.ticket_id = t.id AND a.kind = 'message' AND NOT a.is_internal AND NOT a.is_inbound
            AND a.created_at > COALESCE((SELECT r.read_at FROM portal_ticket_reads r WHERE r.account_id = ${actor.accountId}::uuid AND r.ticket_id = t.id), '-infinity'::timestamptz))`;
    }

    /** How many of this person's tickets have a reply from support they have not seen. */
    async unreadCount(actor: PortalActor): Promise<number> {
        const [r] = await this.prisma.$queryRaw<{ n: number }[]>`
            SELECT count(*)::int AS n FROM tickets t
             WHERE t.client_id = ${actor.clientId}::uuid AND (${this.visible(actor).all} OR t.portal_account_id = ${actor.accountId}::uuid)
               AND ${this.unreadSql(actor)}`;
        return r?.n ?? 0;
    }

    /* --------------------------------- reports --------------------------------- */

    reportList() {
        return [
            { key: "quarterly-review", title: "Quarterly review", description: "Security score, risky settings, patching, hardware age and how often your devices were available.", defaultDays: 90 },
            { key: "health", title: "Health summary", description: "A short summary of how your devices are doing: what is online, what needs attention.", defaultDays: 30 },
        ];
    }

    async reportPdf(actor: PortalActor, key: string, daysInput: unknown): Promise<{ filename: string; data: Buffer }> {
        await this.requireModule(actor, "reports");
        const spec = this.reportList().find((r) => r.key === key);
        if (!spec) throw new NotFoundException("Report not found");
        const asked = Number(daysInput);
        const days = Number.isInteger(asked) && asked >= 7 && asked <= 366 ? asked : spec.defaultDays;
        const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
        const from = day(Date.now() - (days - 1) * 86_400_000);
        const to = day(Date.now());
        if (key === "health") return this.reports.healthPdfFile(actor.clientId, from, to);
        // Only what a customer is meant to see: nothing about alerts or technicians' remote sessions.
        const report = await this.full.build({ clientId: actor.clientId, from, to }, new Set(["devices.read"]), { kind: "qbr", sections: QBR_SECTIONS, restrictClientIds: [actor.clientId] });
        return this.full.pdfFile(report);
    }

    /* --------------------------------- devices --------------------------------- */

    async devices(actor: PortalActor) {
        await this.requireModule(actor, "devices");
        const rows = await this.prisma.$queryRaw<any[]>`
            SELECT d.id::text AS id, COALESCE(NULLIF(d.alias, ''), d.hostname) AS name, d.hostname, d.operating_system AS os, d.primary_user AS "user", s.name AS site,
                   (CASE WHEN a.id IS NOT NULL THEN a.last_check_in_at ELSE d.last_seen_at END) AS last_seen,
                   COALESCE((CASE WHEN a.id IS NOT NULL THEN a.last_check_in_at ELSE d.last_seen_at END) > NOW() - INTERVAL '5 minutes', false) AS online
              FROM devices d JOIN sites s ON s.id = d.site_id LEFT JOIN agents a ON a.device_id = d.id
             WHERE s.client_id = ${actor.clientId}::uuid
             ORDER BY s.name, lower(d.hostname)
             LIMIT 2000`;
        return rows.map((r) => ({ id: r.id, name: r.name, os: r.os ?? null, user: r.user ?? null, site: r.site, online: r.online === true, lastSeen: r.last_seen }));
    }

    /* --------------------------------- invoices -------------------------------- */

    async invoices(actor: PortalActor) {
        await this.requireModule(actor, "invoices");
        const rows = await this.prisma.invoices.findMany({
            where: { client_id: actor.clientId, kind: "invoice", status: { notIn: ["draft", "void"] } },
            orderBy: [{ issue_date: "desc" }, { created_at: "desc" }],
            take: 500,
        });
        return rows.map((r) => ({
            id: r.id, number: r.number, status: r.status, currency: r.currency, issueDate: r.issue_date, dueDate: r.due_date,
            totalCents: r.total_cents, paidCents: r.paid_cents, dueCents: Math.max(0, r.total_cents - r.paid_cents),
        }));
    }

    async invoice(actor: PortalActor, id: string) {
        await this.requireModule(actor, "invoices");
        return this.billing.portalInvoiceView(actor.clientId, need(id, "Invoice"));
    }

    async invoicePdf(actor: PortalActor, id: string) {
        await this.requireModule(actor, "invoices");
        return this.billing.portalInvoicePdf(actor.clientId, need(id, "Invoice"));
    }

    async checkout(actor: PortalActor, id: string, returnUrl: string) {
        await this.requireModule(actor, "invoices");
        return this.billing.portalCheckout(actor.clientId, need(id, "Invoice"), returnUrl);
    }

    /* -------------------------------- dashboard -------------------------------- */

    async dashboard(actor: PortalActor) {
        const modules = await this.modulesFor(actor);
        const [t] = await this.prisma.$queryRaw<{ open: number; waiting: number }[]>`
            SELECT count(*) FILTER (WHERE t.status::text NOT IN ('resolved', 'closed'))::int AS open,
                   count(*) FILTER (WHERE t.status::text = 'pending')::int AS waiting
              FROM tickets t
             WHERE t.client_id = ${actor.clientId}::uuid AND (${this.visible(actor).all} OR t.portal_account_id = ${actor.accountId}::uuid)`;
        const out: any = { openTickets: t?.open ?? 0, waitingTickets: t?.waiting ?? 0, unreadReplies: await this.unreadCount(actor), recentTickets: modules.includes("tickets") ? (await this.tickets(actor, {})).slice(0, 5) : [] };
        if (modules.includes("devices")) {
            const [d] = await this.prisma.$queryRaw<{ total: number; online: number }[]>`
                SELECT count(*)::int AS total,
                       count(*) FILTER (WHERE COALESCE((CASE WHEN a.id IS NOT NULL THEN a.last_check_in_at ELSE d.last_seen_at END) > NOW() - INTERVAL '5 minutes', false))::int AS online
                  FROM devices d JOIN sites s ON s.id = d.site_id LEFT JOIN agents a ON a.device_id = d.id WHERE s.client_id = ${actor.clientId}::uuid`;
            out.devices = { total: d?.total ?? 0, online: d?.online ?? 0, offline: (d?.total ?? 0) - (d?.online ?? 0) };
        }
        if (modules.includes("invoices")) {
            const [i] = await this.prisma.$queryRaw<{ unpaid: number; balance: number | null; overdue: number }[]>`
                SELECT count(*) FILTER (WHERE total_cents > paid_cents)::int AS unpaid,
                       COALESCE(sum(total_cents - paid_cents) FILTER (WHERE total_cents > paid_cents), 0)::bigint::int AS balance,
                       count(*) FILTER (WHERE total_cents > paid_cents AND due_date < CURRENT_DATE)::int AS overdue
                  FROM invoices WHERE client_id = ${actor.clientId}::uuid AND kind = 'invoice' AND status NOT IN ('draft', 'void')`;
            out.invoices = { unpaid: i?.unpaid ?? 0, balanceCents: i?.balance ?? 0, overdue: i?.overdue ?? 0 };
        }
        return out;
    }
}
