// Recurring tickets: a ticket opened from a ticket template on a schedule, for a customer (and site, and device).
//
// Safe to restart and to run twice:
//  - every period gets one row in recurring_ticket_runs with a unique run key (schedule + the instant it was due), and a
//    ticket is only opened by whoever inserted that row;
//  - the schedule moves on to its next time only after that row exists, and a row left "pending" by a crash is picked up
//    again after a couple of minutes instead of being lost or repeated (the ticket carries recurring_id, so a ticket
//    opened just before the crash is found and linked, not opened again).
import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { Prisma } from "@prisma/client";
import { randomUUID } from "crypto";
import { isCanonicalUuid } from "../common/agent-lookup.util";
import { PrismaService } from "../storage/prisma.service";
import { AuditService } from "../audit/audit.service";
import { ClientAccessService } from "../reports/client-access.service";
import { TicketsService } from "../tickets/tickets.service";
import { checkTicketDevices } from "../tickets/ticket-devices";
import { describeRecurringRule, checkRecurringRule, nextRecurringRun, previewRecurringRuns, type RecurringRule } from "./recurring-schedule";

const SWEEP_MS = 30_000;
/** A run still pending after this long was interrupted. */
const STALE_PENDING_MS = 2 * 60_000;
const MAX_SCHEDULES = 500;
const KEEP_RUNS = 200;
const PRIORITIES = ["low", "medium", "high", "urgent"];

type Row = Prisma.recurring_ticketsGetPayload<Record<string, never>>;

const oneLine = (v: unknown) => String(v ?? "").replace(/\s+/g, " ").trim();
const uuidOrNull = (label: string, v: unknown): string | null => {
    if (v === undefined || v === null || v === "") return null;
    const s = String(v);
    if (!isCanonicalUuid(s)) throw new BadRequestException(`${label} is not valid.`);
    return s;
};
const dateOnly = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

function ruleOf(r: Row): RecurringRule {
    return {
        frequency: r.frequency as RecurringRule["frequency"],
        time: r.run_time,
        timezone: r.timezone,
        daysOfWeek: r.days_of_week,
        dayOfMonth: r.day_of_month,
        monthOfYear: r.month_of_year,
        startDate: dateOnly(r.start_date),
        endDate: dateOnly(r.end_date),
    };
}

/** {{date}}, {{month}}, {{year}}, {{customer}} and {{site}} in a subject or description. */
export function fillTokens(text: string, v: { at: Date; timezone: string; customer: string; site: string }): string {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: v.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(v.at);
    const month = new Intl.DateTimeFormat("en-US", { timeZone: v.timezone, month: "long", year: "numeric" }).format(v.at);
    const year = parts.slice(0, 4);
    return text.replace(/\{\{\s*(date|month|year|customer|site)\s*\}\}/gi, (_m, k: string) => ({ date: parts, month, year, customer: v.customer, site: v.site }[k.toLowerCase() as "date"] ?? ""));
}

const orgOf = (req: any): string => {
    const u = req?.user ?? null;
    const org = u?.organizationId ?? u?.organization_id ?? u?.orgId ?? null;
    if (!org) throw new BadRequestException("No organization in the session.");
    return String(org);
};

@Injectable()
export class RecurringTicketsService {
    private readonly logger = new Logger(RecurringTicketsService.name);
    private sweeping = false;

    constructor(
        private readonly prisma: PrismaService,
        private readonly tickets: TicketsService,
        private readonly access: ClientAccessService,
        private readonly audit: AuditService,
    ) { }

    /* ------------------------------ reading ------------------------------ */

    private async visibleClients(req: any): Promise<string[] | null> {
        return this.access.visibleClientsFor(req?.user?.id ? String(req.user.id) : null);
    }

    private async present(r: Row, names: { clients: Map<string, string>; sites: Map<string, string>; devices: Map<string, string>; templates: Map<string, string>; users: Map<string, string>; open: Map<string, number> }) {
        const rule = ruleOf(r);
        const last = await this.prisma.recurring_ticket_runs.findFirst({ where: { recurring_id: r.id }, orderBy: { created_at: "desc" }, select: { status: true, error: true, ticket_id: true, created_at: true } });
        return {
            id: r.id,
            name: r.name,
            templateId: r.template_id,
            templateName: r.template_id ? names.templates.get(r.template_id) ?? null : null,
            subject: r.subject,
            description: r.description,
            priority: r.priority,
            clientId: r.client_id,
            clientName: names.clients.get(r.client_id) ?? null,
            siteId: r.site_id,
            siteName: r.site_id ? names.sites.get(r.site_id) ?? null : null,
            deviceId: r.device_id,
            deviceName: r.device_id ? names.devices.get(r.device_id) ?? null : null,
            assigneeUserId: r.assignee_user_id,
            assigneeName: r.assignee_user_id ? names.users.get(r.assignee_user_id) ?? null : null,
            frequency: r.frequency,
            time: r.run_time,
            timezone: r.timezone,
            daysOfWeek: r.days_of_week,
            dayOfMonth: r.day_of_month,
            monthOfYear: r.month_of_year,
            startDate: dateOnly(r.start_date),
            endDate: dateOnly(r.end_date),
            skipIfOpen: r.skip_if_open,
            enabled: r.enabled,
            schedule: describeRecurringRule(rule),
            nextRunAt: r.enabled ? r.next_run_at : null,
            nextRuns: r.enabled ? previewRecurringRuns(rule, 3, new Date()).map((d) => d.toISOString()) : [],
            lastRunAt: r.last_run_at,
            lastStatus: r.last_status,
            lastError: r.last_error,
            lastRun: last ? { status: last.status, error: last.error, ticketId: last.ticket_id, at: last.created_at } : null,
            openTickets: names.open.get(r.id) ?? 0,
            finished: !r.enabled && !r.next_run_at,
            createdAt: r.created_at,
            updatedAt: r.updated_at,
        };
    }

    private async namesFor(rows: Row[]) {
        const ids = (pick: (r: Row) => string | null) => [...new Set(rows.map(pick).filter((v): v is string => !!v))];
        const [clients, sites, devices, templates, users, open] = await Promise.all([
            this.prisma.clients.findMany({ where: { id: { in: ids((r) => r.client_id) } }, select: { id: true, name: true } }),
            this.prisma.sites.findMany({ where: { id: { in: ids((r) => r.site_id) } }, select: { id: true, name: true } }),
            this.prisma.devices.findMany({ where: { id: { in: ids((r) => r.device_id) } }, select: { id: true, hostname: true, alias: true } }),
            this.prisma.ticket_templates.findMany({ where: { id: { in: ids((r) => r.template_id) } }, select: { id: true, name: true } }),
            this.prisma.users.findMany({ where: { id: { in: ids((r) => r.assignee_user_id) } }, select: { id: true, first_name: true, last_name: true, email: true } }),
            this.prisma.tickets.groupBy({ by: ["recurring_id"], where: { recurring_id: { in: rows.map((r) => r.id) }, status: { in: ["open", "in_progress"] } }, _count: { _all: true } }),
        ]);
        return {
            clients: new Map(clients.map((c) => [c.id, c.name])),
            sites: new Map(sites.map((s) => [s.id, s.name])),
            devices: new Map(devices.map((d) => [d.id, d.alias || d.hostname])),
            templates: new Map(templates.map((t) => [t.id, t.name])),
            users: new Map(users.map((u) => [u.id, [u.first_name, u.last_name].filter(Boolean).join(" ") || String(u.email)])),
            open: new Map(open.flatMap((o) => (o.recurring_id ? [[o.recurring_id, o._count._all] as [string, number]] : []))),
        };
    }

    async list(req: any) {
        const orgId = orgOf(req);
        const visible = await this.visibleClients(req);
        const rows = await this.prisma.recurring_tickets.findMany({
            where: { organization_id: orgId, ...(visible ? { client_id: { in: visible } } : {}) },
            orderBy: [{ enabled: "desc" }, { name: "asc" }],
        });
        const names = await this.namesFor(rows);
        return { items: await Promise.all(rows.map((r) => this.present(r, names))) };
    }

    private async find(id: string, req: any): Promise<Row> {
        if (!isCanonicalUuid(id)) throw new NotFoundException("Recurring ticket not found");
        const r = await this.prisma.recurring_tickets.findFirst({ where: { id, organization_id: orgOf(req) } });
        if (!r) throw new NotFoundException("Recurring ticket not found");
        const visible = await this.visibleClients(req);
        if (visible && !visible.includes(r.client_id)) throw new NotFoundException("Recurring ticket not found");
        return r;
    }

    async get(id: string, req: any) {
        const r = await this.find(id, req);
        const names = await this.namesFor([r]);
        return this.present(r, names);
    }

    /** What a rule would do, without saving anything. */
    preview(body: Record<string, unknown>) {
        const rule = checkRecurringRule(body ?? {});
        return { schedule: describeRecurringRule(rule), runs: previewRecurringRuns(rule, 5, new Date()).map((d) => d.toISOString()) };
    }

    async runs(id: string, req: any, limit = 50) {
        const r = await this.find(id, req);
        const rows = await this.prisma.recurring_ticket_runs.findMany({ where: { recurring_id: r.id }, orderBy: { created_at: "desc" }, take: Math.min(Math.max(1, limit), 200) });
        const ids = rows.map((x) => x.ticket_id).filter((v): v is string => !!v);
        const tickets = await this.prisma.tickets.findMany({ where: { id: { in: ids } }, select: { id: true, ticket_number: true, subject: true, status: true } });
        const byId = new Map(tickets.map((t) => [t.id, t]));
        return {
            items: rows.map((x) => {
                const t = x.ticket_id ? byId.get(x.ticket_id) : undefined;
                return {
                    id: x.id,
                    scheduledFor: x.scheduled_for,
                    trigger: x.trigger,
                    status: x.status,
                    error: x.error,
                    at: x.created_at,
                    ticket: t ? { id: t.id, number: Number(t.ticket_number), title: t.subject, status: t.status } : null,
                };
            }),
        };
    }

    /* ------------------------------ saving ------------------------------ */

    /** Checks a body (all of it for a new schedule, the changed parts for an edit) and returns the columns to save. */
    private async clean(req: any, input: Record<string, any>, existing: Row | null) {
        const orgId = orgOf(req);
        const out: Prisma.recurring_ticketsUncheckedUpdateInput = {};
        const has = (k: string) => input[k] !== undefined;

        if (!existing || has("name")) {
            const name = oneLine(input.name);
            if (!name) throw new BadRequestException("Give the schedule a name.");
            if (name.length > 120) throw new BadRequestException("The name is too long (120 characters at most).");
            out.name = name;
        }
        if (!existing || has("templateId") || has("subject")) {
            const templateId = has("templateId") ? uuidOrNull("The template", input.templateId) : existing?.template_id ?? null;
            if (templateId && !(await this.prisma.ticket_templates.findFirst({ where: { id: templateId, organization_id: orgId }, select: { id: true } }))) throw new BadRequestException("That ticket template does not exist.");
            const subject = has("subject") ? oneLine(input.subject) || null : existing?.subject ?? null;
            if (subject && subject.length > 300) throw new BadRequestException("The subject is too long (300 characters at most).");
            if (!templateId && !subject) throw new BadRequestException("Choose a ticket template, or give the ticket a subject.");
            out.template_id = templateId;
            out.subject = subject;
        }
        if (has("description")) {
            const d = String(input.description ?? "").replace(/\r\n?/g, "\n").trim();
            if (d.length > 10_000) throw new BadRequestException("The text is too long (10,000 characters at most).");
            out.description = d || null;
        }
        if (has("priority")) {
            const p = input.priority === null || input.priority === "" ? null : String(input.priority).toLowerCase();
            if (p && !PRIORITIES.includes(p)) throw new BadRequestException(`The priority must be one of: ${PRIORITIES.join(", ")}.`);
            out.priority = p;
        }

        // Customer, site and device have to agree with each other.
        const clientId = has("clientId") ? uuidOrNull("The customer", input.clientId) : existing?.client_id ?? null;
        if (!clientId) throw new BadRequestException("Choose the customer the tickets are for.");
        const client = await this.prisma.clients.findFirst({ where: { id: clientId, organization_id: orgId }, select: { id: true } });
        if (!client) throw new BadRequestException("That customer does not exist.");
        const visible = await this.visibleClients(req);
        if (visible && !visible.includes(clientId)) throw new NotFoundException("Customer not found");
        out.client_id = clientId;

        const siteId = has("siteId") ? uuidOrNull("The site", input.siteId) : existing?.site_id ?? null;
        if (siteId && !(await this.prisma.sites.findFirst({ where: { id: siteId, client_id: clientId }, select: { id: true } }))) throw new BadRequestException("That site does not belong to the customer.");
        out.site_id = siteId;

        const deviceId = has("deviceId") ? uuidOrNull("The device", input.deviceId) : existing?.device_id ?? null;
        if (deviceId) {
            const scope = await this.access.scopeFor(req?.user?.id ? String(req.user.id) : null);
            if (!(await this.access.canSeeDevice(scope, deviceId))) throw new NotFoundException("Device not found");
            const checked = await checkTicketDevices(this.prisma, orgId, clientId, [deviceId]);
            const dev = await this.prisma.devices.findUnique({ where: { id: deviceId }, select: { site_id: true } });
            if (siteId && dev?.site_id && dev.site_id !== siteId) throw new BadRequestException("That device is not at the chosen site.");
            void checked;
        }
        out.device_id = deviceId;

        if (has("assigneeUserId")) {
            const a = uuidOrNull("The assignee", input.assigneeUserId);
            if (a && !(await this.prisma.users.findFirst({ where: { id: a, organization_id: orgId }, select: { id: true } }))) throw new BadRequestException("That person does not exist.");
            out.assignee_user_id = a;
        }
        if (has("skipIfOpen")) out.skip_if_open = input.skipIfOpen === true || input.skipIfOpen === "true";

        // The schedule: anything not sent keeps what the schedule already has.
        const rule = checkRecurringRule({
            frequency: existing?.frequency,
            time: existing?.run_time,
            timezone: existing?.timezone,
            daysOfWeek: existing?.days_of_week,
            dayOfMonth: existing?.day_of_month ?? undefined,
            monthOfYear: existing?.month_of_year ?? undefined,
            startDate: existing ? dateOnly(existing.start_date) : undefined,
            endDate: existing ? dateOnly(existing.end_date) : undefined,
            ...Object.fromEntries(["frequency", "time", "timezone", "daysOfWeek", "dayOfMonth", "monthOfYear", "startDate", "endDate"].filter((k) => has(k)).map((k) => [k, input[k]])),
        });
        out.frequency = rule.frequency;
        out.run_time = rule.time;
        out.timezone = rule.timezone;
        out.days_of_week = rule.daysOfWeek;
        out.day_of_month = rule.dayOfMonth;
        out.month_of_year = rule.monthOfYear;
        out.start_date = rule.startDate ? new Date(`${rule.startDate}T00:00:00Z`) : null;
        out.end_date = rule.endDate ? new Date(`${rule.endDate}T00:00:00Z`) : null;
        return { data: out, rule };
    }

    async create(req: any, input: Record<string, any>) {
        const orgId = orgOf(req);
        if ((await this.prisma.recurring_tickets.count({ where: { organization_id: orgId } })) >= MAX_SCHEDULES) throw new BadRequestException(`There can be ${MAX_SCHEDULES} recurring tickets at most.`);
        const { data, rule } = await this.clean(req, input, null);
        const next = nextRecurringRun(rule, new Date());
        try {
            const r = await this.prisma.recurring_tickets.create({
                data: {
                    organization_id: orgId,
                    name: data.name as string,
                    template_id: (data.template_id as string | null) ?? null,
                    subject: (data.subject as string | null) ?? null,
                    description: (data.description as string | null) ?? null,
                    priority: (data.priority as string | null) ?? null,
                    client_id: data.client_id as string,
                    site_id: (data.site_id as string | null) ?? null,
                    device_id: (data.device_id as string | null) ?? null,
                    assignee_user_id: (data.assignee_user_id as string | null) ?? null,
                    frequency: rule.frequency,
                    run_time: rule.time,
                    timezone: rule.timezone,
                    days_of_week: rule.daysOfWeek,
                    day_of_month: rule.dayOfMonth,
                    month_of_year: rule.monthOfYear,
                    start_date: data.start_date as Date | null,
                    end_date: data.end_date as Date | null,
                    skip_if_open: (data.skip_if_open as boolean | undefined) ?? true,
                    enabled: next !== null,
                    next_run_at: next,
                    created_by: req?.user?.id && isCanonicalUuid(String(req.user.id)) ? String(req.user.id) : null,
                },
            });
            return this.get(r.id, req);
        } catch (e: any) {
            if (e?.code === "P2002") throw new BadRequestException("There is already a recurring ticket with that name.");
            throw e;
        }
    }

    async update(id: string, req: any, input: Record<string, any>) {
        const existing = await this.find(id, req);
        const { data, rule } = await this.clean(req, input, existing);
        // Changing the schedule moves the next time; pausing and resuming have their own routes.
        const next = existing.enabled ? nextRecurringRun(rule, new Date()) : existing.next_run_at;
        try {
            await this.prisma.recurring_tickets.update({ where: { id }, data: { ...data, next_run_at: next, ...(existing.enabled && !next ? { enabled: false } : {}), updated_at: new Date() } });
        } catch (e: any) {
            if (e?.code === "P2002") throw new BadRequestException("There is already a recurring ticket with that name.");
            throw e;
        }
        return this.get(id, req);
    }

    async remove(id: string, req: any) {
        await this.find(id, req);
        // The tickets it opened stay; the database clears their link (recurring_id) to the schedule.
        await this.prisma.recurring_tickets.delete({ where: { id } });
        return { ok: true };
    }

    async setEnabled(id: string, req: any, enabled: boolean) {
        const r = await this.find(id, req);
        if (!enabled) {
            await this.prisma.recurring_tickets.update({ where: { id }, data: { enabled: false, updated_at: new Date() } });
        } else {
            // Resuming does not catch up on what was missed while paused: the next time is the next one from now.
            const next = nextRecurringRun(ruleOf(r), new Date());
            if (!next) throw new BadRequestException("This schedule has reached its end date, so there is nothing to resume. Change the end date first.");
            await this.prisma.recurring_tickets.update({ where: { id }, data: { enabled: true, next_run_at: next, updated_at: new Date() } });
        }
        return this.get(id, req);
    }

    /** Opens the ticket now, as an extra: it does not change when the schedule runs next, and is not held back by an open ticket. */
    async runNow(id: string, req: any) {
        const r = await this.find(id, req);
        const result = await this.execute(r, new Date(), "manual", req?.user?.name ?? req?.user?.email ?? "Someone", req?.user?.id ?? null);
        return result;
    }

    /* ------------------------------ running ------------------------------ */

    /** Opens (or skips) the ticket for one period. `key` makes it happen once. */
    private async execute(row: Row, scheduledFor: Date, trigger: "scheduled" | "manual", who: string, userId: string | null, resume?: { id: string; since: Date }) {
        let runId = resume?.id ?? null;
        if (!runId) {
            const key = trigger === "scheduled" ? `p:${scheduledFor.toISOString()}` : `m:${randomUUID()}`;
            const inserted = await this.prisma.$queryRaw<{ id: string }[]>`
                INSERT INTO recurring_ticket_runs (recurring_id, run_key, scheduled_for, trigger, status)
                VALUES (${row.id}::uuid, ${key}, ${scheduledFor}, ${trigger}, 'pending')
                ON CONFLICT (recurring_id, run_key) DO NOTHING
                RETURNING id::text AS id`;
            if (!inserted[0]) return { status: "duplicate" as const };
            runId = inserted[0].id;
        }
        const finish = async (status: "created" | "skipped" | "failed", extra: { ticketId?: string | null; error?: string | null }) => {
            await this.prisma.recurring_ticket_runs.update({ where: { id: runId! }, data: { status, ticket_id: extra.ticketId ?? null, error: extra.error ?? null, finished_at: new Date() } });
            await this.prisma.recurring_tickets.update({ where: { id: row.id }, data: { last_run_at: new Date(), last_status: status, last_error: status === "failed" ? extra.error ?? "Failed" : null } }).catch(() => undefined);
            void this.audit.record({ action: "recurring_ticket.run", category: "ticket", outcome: status === "failed" ? "failure" : "success", actorUserId: userId, actorEmail: who, targetType: "recurring_ticket", targetId: row.id, targetLabel: row.name, details: { status, trigger, ticketId: extra.ticketId ?? null, error: extra.error ?? null } }).catch(() => undefined);
        };
        try {
            // A crash may have left the ticket behind just before the run could be marked.
            if (resume) {
                const already = await this.prisma.tickets.findFirst({ where: { recurring_id: row.id, created_at: { gte: new Date(resume.since.getTime() - 1000) } }, orderBy: { created_at: "asc" }, select: { id: true } });
                if (already) {
                    await finish("created", { ticketId: already.id });
                    return { status: "created" as const, ticketId: already.id };
                }
            }
            if (trigger === "scheduled" && row.skip_if_open) {
                const open = await this.prisma.tickets.findFirst({ where: { recurring_id: row.id, status: { in: ["open", "in_progress"] } }, orderBy: { created_at: "desc" }, select: { ticket_number: true } });
                if (open) {
                    const why = `Skipped: ticket #${Number(open.ticket_number)} from the previous run is still open.`;
                    await finish("skipped", { error: why });
                    return { status: "skipped" as const, reason: why };
                }
            }
            const ticketId = await this.openTicket(row, scheduledFor);
            await finish("created", { ticketId });
            return { status: "created" as const, ticketId };
        } catch (e: any) {
            const message = String(e?.response?.message ?? e?.message ?? e).slice(0, 500);
            this.logger.warn(`Recurring ticket "${row.name}" could not open its ticket: ${message}`);
            await finish("failed", { error: message });
            return { status: "failed" as const, error: message };
        }
    }

    private async openTicket(row: Row, at: Date): Promise<string> {
        const [client, site] = await Promise.all([
            this.prisma.clients.findUnique({ where: { id: row.client_id }, select: { name: true } }),
            row.site_id ? this.prisma.sites.findUnique({ where: { id: row.site_id }, select: { name: true } }) : Promise.resolve(null),
        ]);
        if (!client) throw new Error("The customer no longer exists.");
        let template: { subject: string; body: string; priority: string } | null = null;
        if (row.template_id) {
            template = await this.prisma.ticket_templates.findUnique({ where: { id: row.template_id }, select: { subject: true, body: true, priority: true } });
            if (!template) throw new Error("The ticket template no longer exists.");
        } else if (!row.subject) {
            throw new Error("The schedule has no ticket template and no subject.");
        }
        const tokens = { at, timezone: row.timezone, customer: client.name, site: site?.name ?? "" };
        const subject = fillTokens(row.subject || template!.subject, tokens).trim();
        if (!subject) throw new Error("The ticket would have no subject: the template's subject is empty.");
        let description = fillTokens(row.description ?? template?.body ?? "", tokens).trim();
        if (site) description = [description, `Site: ${site.name}`].filter(Boolean).join("\n\n");
        const dto: Record<string, unknown> = { subject, clientId: row.client_id, recurringId: row.id };
        if (template) dto.templateId = row.template_id;
        dto.description = description || undefined;
        if (row.priority) dto.priority = row.priority;
        if (row.assignee_user_id) dto.assigneeUserId = row.assignee_user_id;
        if (row.device_id) dto.deviceId = row.device_id;
        const id = await this.tickets.create(dto as any, { user: { organizationId: row.organization_id, name: `Recurring: ${row.name}` } });
        // The ticket's history says where it came from.
        await this.prisma.ticket_activity.create({ data: { id: randomUUID(), ticket_id: id, kind: "change", body: `Opened by the recurring ticket "${row.name}"`, attachments: [], time_worked_seconds: 0, notify_customer: false, author: "Recurring tickets", is_internal: true } }).catch(() => undefined);
        return id;
    }

    /** Every due schedule gets its period's ticket. Safe to call from several processes and after a restart. */
    @Interval(SWEEP_MS)
    async sweep(now = new Date()): Promise<void> {
        if (this.sweeping) return;
        this.sweeping = true;
        try {
            const due = await this.prisma.recurring_tickets.findMany({ where: { enabled: true, next_run_at: { lte: now } }, orderBy: { next_run_at: "asc" }, take: 50 });
            for (const row of due) await this.runDue(row, now);
            // Old history goes; the newest runs of each schedule stay.
            await this.prisma.$executeRaw`
                DELETE FROM recurring_ticket_runs r
                 WHERE r.status <> 'pending' AND r.created_at < now() - interval '90 days'
                   AND r.id NOT IN (SELECT x.id FROM recurring_ticket_runs x WHERE x.recurring_id = r.recurring_id ORDER BY x.created_at DESC LIMIT ${KEEP_RUNS})`;
        } catch (e) {
            this.logger.error(`Recurring tickets sweep failed: ${(e as Error).message}`);
        } finally {
            this.sweeping = false;
        }
    }

    private async runDue(row: Row, now: Date) {
        const dueAt = row.next_run_at!;
        const next = nextRecurringRun(ruleOf(row), now);
        // The period is the instant the schedule was due, so a second process or a restart computes the same run key.
        const outcome = await this.execute(row, dueAt, "scheduled", "Recurring tickets", null);
        if (outcome.status === "duplicate") {
            // Someone already has this period. A run interrupted by a crash is taken over; a finished one just moves the schedule on.
            const existing = await this.prisma.recurring_ticket_runs.findUnique({ where: { recurring_id_run_key: { recurring_id: row.id, run_key: `p:${dueAt.toISOString()}` } } });
            if (existing?.status === "pending" && now.getTime() - existing.created_at.getTime() > STALE_PENDING_MS) {
                // Whoever changes created_at first owns the run (another process sees it as fresh again).
                const took = await this.prisma.recurring_ticket_runs.updateMany({ where: { id: existing.id, status: "pending", created_at: { lt: new Date(now.getTime() - STALE_PENDING_MS) } }, data: { created_at: new Date() } });
                if (took.count === 1) await this.execute(row, dueAt, "scheduled", "Recurring tickets", null, { id: existing.id, since: existing.created_at });
            } else if (existing?.status === "pending") {
                return; // another process is on it right now; look again at the next sweep
            }
        }
        await this.prisma.recurring_tickets.updateMany({ where: { id: row.id, next_run_at: dueAt }, data: { next_run_at: next, ...(next ? {} : { enabled: false }), updated_at: new Date() } });
    }
}
