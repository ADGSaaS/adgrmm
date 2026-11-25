// The technician schedule: visits booked against tickets, working hours, time off, conflict warnings and the invites.
import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../storage/prisma.service";
import { ClientAccessService } from "../reports/client-access.service";
import { SmtpService } from "../smtp/smtp.service";
import { EmailTemplatesService } from "../templates/email-templates.service";
import { TicketTimeService } from "../tickets/ticket-time.service";
import {
    ACTIVE_STATUSES, MAX_TECHS_PER_VISIT, VISIT_STATUSES, buildIcs, defaultHours, describeSpan, isValidTimeZone, parseHours, parseRange, withinWorkingHours,
    type Conflict, type VisitStatus, type WorkDay,
} from "./schedule-core";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NIL = "00000000-0000-0000-0000-000000000000";
const cut = (v: unknown, n: number): string | null => {
    const s = typeof v === "string" ? v.trim().slice(0, n) : "";
    return s || null;
};
const orgOf = (req: any): string => {
    const u = req?.user;
    const org = u?.organizationId ?? u?.org ?? null;
    if (!org) throw new BadRequestException("Sign in first.");
    return String(org);
};
const actorOf = (req: any): string | null => (req?.user?.id ? String(req.user.id) : null);
const nameOf = (u: { first_name: string | null; last_name: string | null; email: string }) => [u.first_name, u.last_name].filter(Boolean).join(" ") || u.email;

export type VisitInput = {
    ticketId?: unknown; startsAt?: unknown; endsAt?: unknown; techIds?: unknown; title?: unknown; notes?: unknown; location?: unknown; timeZone?: unknown;
    status?: unknown; notifyTechs?: unknown; notifyCustomer?: unknown; force?: unknown; logTime?: unknown;
};

@Injectable()
export class ScheduleService {
    private readonly log = new Logger(ScheduleService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly access: ClientAccessService,
        private readonly smtp: SmtpService,
        private readonly templates: EmailTemplatesService,
        private readonly time: TicketTimeService,
    ) { }

    /* ------------------------------ helpers ------------------------------ */

    /** The customers this person is limited to, or null for all. */
    private allowed(req: any): Promise<string[] | null> {
        return this.access.visibleClientsFor(actorOf(req));
    }

    private assertSeen(allowed: string[] | null, clientId: string | null) {
        if (allowed && (!clientId || !allowed.includes(clientId))) throw new NotFoundException("Visit not found");
    }

    private async ticketFor(orgId: string, ticketId: unknown) {
        if (typeof ticketId !== "string" || !UUID.test(ticketId)) throw new BadRequestException("Choose a ticket.");
        const t = await this.prisma.tickets.findFirst({
            where: { id: ticketId, organization_id: orgId },
            select: {
                id: true, ticket_number: true, subject: true, status: true, client_id: true,
                devices: { select: { sites: { select: { client_id: true } } } },
            },
        });
        if (!t) throw new NotFoundException("Ticket not found");
        return { ...t, clientId: t.client_id ?? t.devices?.sites?.client_id ?? null };
    }

    private async techsFor(orgId: string, ids: unknown) {
        if (!Array.isArray(ids) || ids.length === 0) throw new BadRequestException("Choose at least one technician.");
        const list = [...new Set(ids.map(String))];
        if (list.length > MAX_TECHS_PER_VISIT) throw new BadRequestException(`A visit can have at most ${MAX_TECHS_PER_VISIT} technicians.`);
        if (list.some((i) => !UUID.test(i))) throw new BadRequestException("A technician is not valid.");
        const users = await this.prisma.users.findMany({ where: { id: { in: list }, organization_id: orgId, status: "active" }, select: { id: true, email: true, first_name: true, last_name: true, timezone: true } });
        if (users.length !== list.length) throw new BadRequestException("A technician is not valid.");
        return users;
    }

    private async shape(rows: any[]) {
        const userIds = [...new Set(rows.flatMap((r) => r.techs.map((t: any) => t.user_id)))] as string[];
        const users = userIds.length ? await this.prisma.users.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true, first_name: true, last_name: true } }) : [];
        const byId = new Map(users.map((u) => [u.id, u]));
        const ticketIds = [...new Set(rows.map((r) => r.ticket_id))] as string[];
        const tickets = ticketIds.length ? await this.prisma.tickets.findMany({ where: { id: { in: ticketIds } }, select: { id: true, ticket_number: true, subject: true, status: true, priority: true } }) : [];
        const tById = new Map(tickets.map((t) => [t.id, t]));
        const clientIds = [...new Set(rows.map((r) => r.client_id).filter(Boolean))] as string[];
        const clients = clientIds.length ? await this.prisma.clients.findMany({ where: { id: { in: clientIds } }, select: { id: true, name: true } }) : [];
        const cById = new Map(clients.map((c) => [c.id, c.name]));
        return rows.map((r) => {
            const t = tById.get(r.ticket_id);
            return {
                id: r.id, ticketId: r.ticket_id, ticketNumber: t ? String(t.ticket_number) : null, ticketSubject: t?.subject ?? null, ticketStatus: t?.status ?? null, ticketPriority: t?.priority ?? null,
                clientId: r.client_id, clientName: r.client_id ? cById.get(r.client_id) ?? null : null,
                title: r.title, notes: r.notes, location: r.location, status: r.status,
                startsAt: r.starts_at.toISOString(), endsAt: r.ends_at.toISOString(), timeZone: r.time_zone,
                customerNotifiedAt: r.customer_notified_at ? r.customer_notified_at.toISOString() : null, timeEntryId: r.time_entry_id,
                techs: r.techs.map((x: any) => ({ id: x.user_id, name: byId.get(x.user_id) ? nameOf(byId.get(x.user_id)!) : "Former user" })),
            };
        });
    }

    private async loadVisit(orgId: string, id: string, req: any) {
        if (!UUID.test(id)) throw new NotFoundException("Visit not found");
        const v = await this.prisma.ticket_visits.findFirst({ where: { id, organization_id: orgId }, include: { techs: true } });
        if (!v) throw new NotFoundException("Visit not found");
        this.assertSeen(await this.allowed(req), v.client_id);
        return v;
    }

    /* ------------------------------ reading ------------------------------ */

    async list(req: any, q: { from?: string; to?: string; techId?: string; ticketId?: string; status?: string }) {
        const orgId = orgOf(req);
        const allowed = await this.allowed(req);
        const where: Prisma.ticket_visitsWhereInput = { organization_id: orgId };
        const from = q.from ? new Date(q.from) : null;
        const to = q.to ? new Date(q.to) : null;
        if ((from && Number.isNaN(from.getTime())) || (to && Number.isNaN(to.getTime()))) throw new BadRequestException("The dates are not valid.");
        if (from) where.ends_at = { gt: from };
        if (to) where.starts_at = { lt: to };
        if (q.techId) where.techs = { some: { user_id: UUID.test(q.techId) ? q.techId : NIL } };
        if (q.ticketId) where.ticket_id = UUID.test(q.ticketId) ? q.ticketId : NIL;
        if (q.status && (VISIT_STATUSES as readonly string[]).includes(q.status)) where.status = q.status;
        if (allowed) where.client_id = { in: allowed };
        const rows = await this.prisma.ticket_visits.findMany({ where, include: { techs: true }, orderBy: { starts_at: "asc" }, take: 1000 });
        return { items: await this.shape(rows) };
    }

    async get(req: any, id: string) {
        const v = await this.loadVisit(orgOf(req), id, req);
        return (await this.shape([v]))[0];
    }

    /** Tickets still being worked that have no visit coming up: the board's side list. */
    async unscheduled(req: any, q: { q?: string }) {
        const orgId = orgOf(req);
        const allowed = await this.allowed(req);
        const booked = await this.prisma.ticket_visits.findMany({ where: { organization_id: orgId, status: { in: ACTIVE_STATUSES }, ends_at: { gt: new Date() } }, select: { ticket_id: true } });
        const AND: Prisma.ticketsWhereInput[] = [
            { organization_id: orgId },
            { status: { in: ["open", "pending", "in_progress"] } },
            { NOT: { id: { in: booked.map((x) => x.ticket_id) } } },
        ];
        if (allowed) AND.push({ OR: [{ client_id: { in: allowed } }, { client_id: null, devices: { sites: { client_id: { in: allowed } } } }] });
        const term = cut(q.q, 80);
        if (term) AND.push({ OR: [{ subject: { contains: term, mode: "insensitive" } }, ...(/^\d{1,12}$/.test(term) ? [{ ticket_number: BigInt(term) }] : [])] });
        const rows = await this.prisma.tickets.findMany({
            where: { AND }, take: 100, orderBy: [{ due_at: { sort: "asc", nulls: "last" } }, { created_at: "desc" }],
            select: { id: true, ticket_number: true, subject: true, priority: true, status: true, due_at: true, client_id: true, assignee_user_id: true, devices: { select: { sites: { select: { client_id: true } } } } },
        });
        const cids = [...new Set(rows.map((r) => r.client_id ?? r.devices?.sites?.client_id).filter(Boolean))] as string[];
        const clients = cids.length ? await this.prisma.clients.findMany({ where: { id: { in: cids } }, select: { id: true, name: true } }) : [];
        const names = new Map(clients.map((c) => [c.id, c.name]));
        return {
            items: rows.map((r) => {
                const cid = r.client_id ?? r.devices?.sites?.client_id ?? null;
                return { id: r.id, number: String(r.ticket_number), subject: r.subject, priority: r.priority, status: r.status, dueAt: r.due_at?.toISOString() ?? null, clientName: cid ? names.get(cid) ?? null : null, assigneeId: r.assignee_user_id };
            }),
        };
    }

    /* ------------------------------ conflicts ------------------------------ */

    async conflicts(orgId: string, techs: { id: string; email: string; first_name: string | null; last_name: string | null }[], start: Date, end: Date, ignoreVisitId?: string): Promise<Conflict[]> {
        const out: Conflict[] = [];
        const ids = techs.map((t) => t.id);
        const who = new Map(techs.map((t) => [t.id, nameOf(t)]));
        const clash = await this.prisma.ticket_visit_techs.findMany({
            where: { user_id: { in: ids }, visit: { organization_id: orgId, status: { in: ACTIVE_STATUSES }, starts_at: { lt: end }, ends_at: { gt: start }, ...(ignoreVisitId ? { id: { not: ignoreVisitId } } : {}) } },
            include: { visit: true },
        });
        const tix = clash.length ? await this.prisma.tickets.findMany({ where: { id: { in: clash.map((c) => c.visit.ticket_id) } }, select: { id: true, ticket_number: true } }) : [];
        const num = new Map(tix.map((t) => [t.id, String(t.ticket_number)]));
        for (const c of clash) out.push({ kind: "visit", userId: c.user_id, visitId: c.visit_id, ticketNumber: num.get(c.visit.ticket_id), message: `${who.get(c.user_id)} already has a visit on ticket #${num.get(c.visit.ticket_id)} at that time.` });
        const off = await this.prisma.tech_time_off.findMany({ where: { organization_id: orgId, user_id: { in: ids }, starts_at: { lt: end }, ends_at: { gt: start } } });
        for (const o of off) out.push({ kind: "time_off", userId: o.user_id, message: `${who.get(o.user_id)} has time off then${o.reason ? ` (${o.reason})` : ""}.` });
        const avail = await this.prisma.tech_availability.findMany({ where: { user_id: { in: ids } } });
        for (const a of avail) {
            const hours = Array.isArray(a.hours) && a.hours.length === 7 ? (a.hours as unknown as WorkDay[]) : null;
            if (hours && !withinWorkingHours(start, end, a.time_zone, hours)) out.push({ kind: "outside_hours", userId: a.user_id, message: `That is outside ${who.get(a.user_id)}'s working hours.` });
        }
        return out;
    }

    async checkConflicts(req: any, body: VisitInput & { ignoreVisitId?: unknown }) {
        const orgId = orgOf(req);
        const { start, end } = parseRange(body.startsAt, body.endsAt);
        const techs = await this.techsFor(orgId, body.techIds);
        const ignore = typeof body.ignoreVisitId === "string" && UUID.test(body.ignoreVisitId) ? body.ignoreVisitId : undefined;
        return { conflicts: await this.conflicts(orgId, techs, start, end, ignore) };
    }

    /* ------------------------------ writing ------------------------------ */

    private async zoneFor(requested: unknown, techs: { timezone: string | null; id: string }[], clientId: string | null): Promise<string> {
        if (requested !== undefined && requested !== null && requested !== "") {
            if (!isValidTimeZone(requested)) throw new BadRequestException("The time zone is not valid.");
            return requested;
        }
        const avail = await this.prisma.tech_availability.findFirst({ where: { user_id: { in: techs.map((t) => t.id) } } });
        if (avail && isValidTimeZone(avail.time_zone)) return avail.time_zone;
        if (clientId) {
            const c = await this.prisma.clients.findUnique({ where: { id: clientId }, select: { time_zone: true } });
            if (c?.time_zone && isValidTimeZone(c.time_zone)) return c.time_zone;
        }
        return techs.find((t) => isValidTimeZone(t.timezone))?.timezone ?? "UTC";
    }

    async create(req: any, body: VisitInput) {
        const orgId = orgOf(req);
        const ticket = await this.ticketFor(orgId, body.ticketId);
        this.assertSeen(await this.allowed(req), ticket.clientId);
        const { start, end } = parseRange(body.startsAt, body.endsAt);
        const techs = await this.techsFor(orgId, body.techIds);
        const conflicts = await this.conflicts(orgId, techs, start, end);
        if (conflicts.length && body.force !== true) throw new ConflictException({ message: "There are scheduling conflicts.", conflicts });
        const tz = await this.zoneFor(body.timeZone, techs, ticket.clientId);
        const row = await this.prisma.ticket_visits.create({
            data: {
                organization_id: orgId, ticket_id: ticket.id, client_id: ticket.clientId, title: cut(body.title, 200) ?? `Visit for #${ticket.ticket_number}: ${ticket.subject}`.slice(0, 200),
                notes: cut(body.notes, 2000), location: cut(body.location, 300), starts_at: start, ends_at: end, time_zone: tz, created_by: actorOf(req),
                techs: { create: techs.map((t) => ({ user_id: t.id })) },
            },
            include: { techs: true },
        });
        const notified = await this.notify(row, "booked", body.notifyTechs !== false, body.notifyCustomer === true);
        if (notified.customer) row.customer_notified_at = new Date();
        return { ...(await this.shape([row]))[0], conflicts, notified };
    }

    async update(req: any, id: string, body: VisitInput) {
        const orgId = orgOf(req);
        const before = await this.loadVisit(orgId, id, req);
        const data: Prisma.ticket_visitsUpdateInput = { updated_at: new Date() };
        const moved = body.startsAt !== undefined || body.endsAt !== undefined;
        let start = before.starts_at;
        let end = before.ends_at;
        if (moved) ({ start, end } = parseRange(body.startsAt ?? before.starts_at.toISOString(), body.endsAt ?? before.ends_at.toISOString()));
        const techsChanged = body.techIds !== undefined;
        const techs = techsChanged ? await this.techsFor(orgId, body.techIds) : await this.prisma.users.findMany({ where: { id: { in: before.techs.map((t) => t.user_id) } }, select: { id: true, email: true, first_name: true, last_name: true, timezone: true } });
        let status = before.status as VisitStatus;
        if (body.status !== undefined) {
            if (typeof body.status !== "string" || !(VISIT_STATUSES as readonly string[]).includes(body.status)) throw new BadRequestException("The status is not valid.");
            status = body.status as VisitStatus;
        }
        const reactivated = status !== before.status && ACTIVE_STATUSES.includes(status) && !ACTIVE_STATUSES.includes(before.status as VisitStatus);
        let conflicts: Conflict[] = [];
        if ((moved || techsChanged || reactivated) && ACTIVE_STATUSES.includes(status)) {
            conflicts = await this.conflicts(orgId, techs, start, end, before.id);
            if (conflicts.length && body.force !== true) throw new ConflictException({ message: "There are scheduling conflicts.", conflicts });
        }
        if (moved) { data.starts_at = start; data.ends_at = end; }
        if (body.title !== undefined) data.title = cut(body.title, 200) ?? before.title;
        if (body.notes !== undefined) data.notes = cut(body.notes, 2000);
        if (body.location !== undefined) data.location = cut(body.location, 300);
        if (body.timeZone !== undefined) {
            if (!isValidTimeZone(body.timeZone)) throw new BadRequestException("The time zone is not valid.");
            data.time_zone = body.timeZone;
        }
        if (status !== before.status) data.status = status;
        const changedForInvite = moved || techsChanged || status !== before.status && (status === "cancelled" || reactivated) || body.location !== undefined || body.title !== undefined || body.timeZone !== undefined;
        if (changedForInvite) data.sequence = { increment: 1 };

        // Finishing a visit can log its time on the ticket, once.
        let timeLogged = 0;
        if (status === "done" && before.status !== "done" && body.logTime && typeof body.logTime === "object" && !before.time_entry_id) {
            if (req?.effectivePermissions?.has?.("tickets.time.manual") !== true) throw new ForbiddenException("You do not have permission to add time by hand.");
            const lt = body.logTime as { minutes?: unknown; billable?: unknown };
            const minutes = lt.minutes === undefined || lt.minutes === null || lt.minutes === "" ? Math.max(1, Math.round((end.getTime() - start.getTime()) / 60000)) : Number(lt.minutes);
            const me = actorOf(req);
            const userId = me && techs.some((t) => t.id === me) ? me : techs[0]?.id ?? me;
            if (!userId) throw new BadRequestException("Nobody to log the time for.");
            data.time_entry_id = await this.time.logEntry({ organizationId: orgId, userId, ticketId: before.ticket_id, clientId: before.client_id, minutes, billable: lt.billable !== false, note: `Visit: ${before.title}`.slice(0, 200) });
            timeLogged = minutes;
        }

        const row = await this.prisma.$transaction(async (tx) => {
            if (techsChanged) {
                await tx.ticket_visit_techs.deleteMany({ where: { visit_id: id } });
                await tx.ticket_visit_techs.createMany({ data: techs.map((t) => ({ visit_id: id, user_id: t.id })) });
            }
            return tx.ticket_visits.update({ where: { id }, data, include: { techs: true } });
        });
        let notified = { techs: 0, customer: false, note: "" };
        if (changedForInvite) {
            const what = status === "cancelled" ? "cancelled" : "changed";
            const toCustomer = body.notifyCustomer === true || (before.customer_notified_at !== null && body.notifyCustomer !== false);
            notified = await this.notify(row, what, body.notifyTechs !== false, toCustomer);
        }
        if (notified.customer) row.customer_notified_at = new Date();
        return { ...(await this.shape([row]))[0], conflicts, notified, timeLogged };
    }

    async remove(req: any, id: string) {
        const orgId = orgOf(req);
        const v = await this.loadVisit(orgId, id, req);
        const notified = ACTIVE_STATUSES.includes(v.status as VisitStatus) ? await this.notify({ ...v, sequence: v.sequence + 1 }, "cancelled", true, v.customer_notified_at !== null) : null;
        await this.prisma.ticket_visits.deleteMany({ where: { id, organization_id: orgId } });
        return { ok: true, notified };
    }

    /* ------------------------------ invites ------------------------------ */

    async icsFor(req: any, id: string): Promise<{ filename: string; content: string }> {
        const v = await this.loadVisit(orgOf(req), id, req);
        return { filename: `visit-${v.id.slice(0, 8)}.ics`, content: buildIcs(await this.icsInput(v, v.status === "cancelled")) };
    }

    private async icsInput(v: any, cancelled: boolean) {
        const t = await this.prisma.tickets.findUnique({ where: { id: v.ticket_id }, select: { ticket_number: true, subject: true } });
        const base = (process.env.PUBLIC_CONSOLE_URL || "").replace(/\/+$/, "");
        const desc = [`Ticket #${t?.ticket_number}: ${t?.subject ?? ""}`, v.notes ?? "", base ? `${base}/tickets/${v.ticket_id}` : ""].filter(Boolean).join("\n");
        return { id: v.id as string, title: v.title as string, description: desc, location: v.location as string | null, startsAt: v.starts_at as Date, endsAt: v.ends_at as Date, sequence: v.sequence as number, cancelled, updatedAt: v.updated_at as Date };
    }

    /** Sends the technicians their invite (with the calendar file) and, if asked, the customer's contact a notice. Never throws. */
    private async notify(v: any, what: "booked" | "changed" | "cancelled", techs: boolean, customer: boolean) {
        const result = { techs: 0, customer: false, note: "" };
        try {
            const orgId = v.organization_id as string;
            const t = await this.prisma.tickets.findUnique({
                where: { id: v.ticket_id },
                select: { ticket_number: true, subject: true, contacts: { select: { name: true, email: true } }, portal_account_id: true },
            });
            const clientName = v.client_id ? (await this.prisma.clients.findUnique({ where: { id: v.client_id }, select: { name: true } }))?.name ?? "" : "";
            const ticketLabel = `#${t?.ticket_number} ${t?.subject ?? ""}`.trim();
            const users = await this.prisma.users.findMany({ where: { id: { in: v.techs.map((x: any) => x.user_id) } }, select: { id: true, email: true, first_name: true, last_name: true } });
            const when = describeSpan(v.starts_at, v.ends_at, v.time_zone);
            const base = (process.env.PUBLIC_CONSOLE_URL || "").replace(/\/+$/, "");
            const ics = Buffer.from(buildIcs(await this.icsInput(v, what === "cancelled")), "utf8");
            const attach = { filename: "visit.ics", content: ics, contentType: `text/calendar; charset=utf-8; method=${what === "cancelled" ? "CANCEL" : "PUBLISH"}` };
            if (techs) {
                for (const u of users) {
                    const msg = await this.templates.render("visit_tech", {
                        name: nameOf(u), what, ticket: ticketLabel, customer: clientName, when,
                        location_line: v.location ? `Where: ${v.location}` : "", notes_line: v.notes ? `Notes: ${v.notes}` : "", link: base ? `${base}/tickets/${v.ticket_id}` : "",
                    }, orgId);
                    const r = await this.smtp.sendWithAttachment("tickets", u.email, msg.subject, msg.body, attach);
                    if (r.ok) result.techs++;
                    else result.note = r.result;
                }
            }
            if (customer) {
                let to: string | null = t?.contacts?.email ?? null;
                let name = t?.contacts?.name ?? "";
                if (!to && t?.portal_account_id) {
                    const pa = await this.prisma.portal_accounts.findUnique({ where: { id: t.portal_account_id }, select: { email: true, name: true } });
                    to = pa?.email ?? null;
                    name = pa?.name ?? "";
                }
                if (!to) result.note = "The ticket has no customer contact with an email address.";
                else {
                    const company = (await this.prisma.organizations.findUnique({ where: { id: orgId }, select: { name: true } }))?.name || "Your IT provider";
                    const msg = await this.templates.render("visit_customer", {
                        name: name || "there", company, what: what === "changed" ? "rescheduled" : what, ticket: ticketLabel, when, technicians: users.map(nameOf).join(", "), location_line: v.location ? `Where: ${v.location}` : "",
                    }, orgId);
                    const r = await this.smtp.sendWithAttachment("tickets", String(to), msg.subject, msg.body, attach);
                    if (r.ok) {
                        result.customer = true;
                        await this.prisma.ticket_visits.updateMany({ where: { id: v.id }, data: { customer_notified_at: new Date() } });
                    } else result.note = r.result;
                }
            }
        } catch (e) {
            this.log.warn(`Visit notification failed: ${(e as Error)?.name}`);
            result.note = "The notification could not be sent.";
        }
        return result;
    }

    /* ------------------------------ people, hours, time off ------------------------------ */

    async techs(req: any) {
        const orgId = orgOf(req);
        const users = await this.prisma.users.findMany({ where: { organization_id: orgId, status: "active" }, select: { id: true, email: true, first_name: true, last_name: true, timezone: true }, orderBy: [{ first_name: "asc" }, { email: "asc" }], take: 500 });
        const av = await this.prisma.tech_availability.findMany({ where: { organization_id: orgId } });
        const byId = new Map(av.map((a) => [a.user_id, a]));
        return {
            items: users.map((u) => {
                const a = byId.get(u.id);
                return { id: u.id, name: nameOf(u), email: u.email, timeZone: a?.time_zone ?? (isValidTimeZone(u.timezone) ? u.timezone : "UTC"), hours: a && Array.isArray(a.hours) && a.hours.length === 7 ? a.hours : defaultHours(), configured: !!a };
            }),
        };
    }

    async setAvailability(req: any, userId: string, body: { timeZone?: unknown; hours?: unknown }) {
        const orgId = orgOf(req);
        if (!UUID.test(userId) || !(await this.prisma.users.findFirst({ where: { id: userId, organization_id: orgId }, select: { id: true } }))) throw new NotFoundException("User not found");
        if (!isValidTimeZone(body.timeZone)) throw new BadRequestException("The time zone is not valid.");
        const hours = parseHours(body.hours) as unknown as Prisma.InputJsonValue;
        await this.prisma.tech_availability.upsert({
            where: { user_id: userId },
            create: { user_id: userId, organization_id: orgId, time_zone: body.timeZone, hours },
            update: { time_zone: body.timeZone, hours, updated_at: new Date() },
        });
        return { ok: true };
    }

    async timeOff(req: any, q: { from?: string; to?: string }) {
        const orgId = orgOf(req);
        const from = q.from ? new Date(q.from) : null;
        const to = q.to ? new Date(q.to) : null;
        if ((from && Number.isNaN(from.getTime())) || (to && Number.isNaN(to.getTime()))) throw new BadRequestException("The dates are not valid.");
        const rows = await this.prisma.tech_time_off.findMany({ where: { organization_id: orgId, ...(from ? { ends_at: { gt: from } } : {}), ...(to ? { starts_at: { lt: to } } : {}) }, orderBy: { starts_at: "asc" }, take: 1000 });
        return { items: rows.map((r) => ({ id: r.id, userId: r.user_id, startsAt: r.starts_at.toISOString(), endsAt: r.ends_at.toISOString(), reason: r.reason })) };
    }

    async addTimeOff(req: any, body: { userId?: unknown; startsAt?: unknown; endsAt?: unknown; reason?: unknown }) {
        const orgId = orgOf(req);
        const userId = typeof body.userId === "string" ? body.userId : actorOf(req);
        if (!userId || !UUID.test(userId) || !(await this.prisma.users.findFirst({ where: { id: userId, organization_id: orgId }, select: { id: true } }))) throw new BadRequestException("Choose a person.");
        const start = new Date(String(body.startsAt ?? ""));
        const end = new Date(String(body.endsAt ?? ""));
        if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) throw new BadRequestException("Give a start and an end, with the end after the start.");
        if (end.getTime() - start.getTime() > 366 * 86400_000) throw new BadRequestException("Time off can be at most a year.");
        const row = await this.prisma.tech_time_off.create({ data: { organization_id: orgId, user_id: userId, starts_at: start, ends_at: end, reason: cut(body.reason, 200) } });
        return { id: row.id };
    }

    async removeTimeOff(req: any, id: string) {
        if (!UUID.test(id)) throw new NotFoundException("Not found");
        const r = await this.prisma.tech_time_off.deleteMany({ where: { id, organization_id: orgOf(req) } });
        if (!r.count) throw new NotFoundException("Not found");
        return { ok: true };
    }
}
