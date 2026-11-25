// Time worked on tickets: a stopwatch that lives on the server, and the entries it (or a reply, or a person) writes.
//
// The stopwatch is per person and per ticket, started and stopped on purpose, so it keeps running when the browser is
// closed and follows the person to another computer. A person has one running at a time: starting a second pauses the
// first. Stopping turns the time into an ordinary time entry (the same ones billing approves and invoices).
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../storage/prisma.service";

export const MAX_MINUTES_PER_ENTRY = 24 * 60;
/** A stopwatch run shorter than this is almost surely a slip: discard it, or type the time in. */
const MIN_TIMER_SECONDS = 30;
export const MANUAL_TIME_DENIED = "You do not have permission to add time by hand. Use the ticket timer, or ask an administrator.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export type TimerState = { ticketId: string; running: boolean; seconds: number; startedAt: string | null };

function orgOf(req: any): string | null {
    const u = req?.user;
    const org = u?.organizationId ?? u?.org ?? null;
    return org ? String(org) : null;
}
const userOf = (req: any): string => {
    const id = req?.user?.id;
    if (!id) throw new BadRequestException("Sign in first.");
    return String(id);
};

@Injectable()
export class TicketTimeService {
    constructor(private readonly prisma: PrismaService) { }

    /* ------------------------------ helpers ------------------------------ */

    private async ticketOf(ticketId: string, req: any) {
        if (!UUID.test(ticketId)) throw new NotFoundException("Ticket not found");
        const org = orgOf(req);
        const t = await this.prisma.tickets.findFirst({
            where: { id: ticketId, ...(org ? { organization_id: org } : {}) },
            select: { id: true, organization_id: true, ticket_number: true, subject: true, status: true, devices: { select: { sites: { select: { client_id: true } } } } },
        });
        if (!t) throw new NotFoundException("Ticket not found");
        return t;
    }

    private stateOf(ticketId: string, row: { started_at: Date | null; accumulated_seconds: number } | null): TimerState {
        if (!row) return { ticketId, running: false, seconds: 0, startedAt: null };
        const running = !!row.started_at;
        const extra = running ? Math.max(0, Math.floor((Date.now() - row.started_at!.getTime()) / 1000)) : 0;
        return { ticketId, running, seconds: row.accumulated_seconds + extra, startedAt: row.started_at ? row.started_at.toISOString() : null };
    }

    /** Writes a time entry on a ticket. The one place entries are made from a timer or a reply. */
    async logEntry(input: { organizationId: string; userId: string; ticketId: string; clientId: string | null; minutes: number; billable: boolean; note?: string | null; workDate?: string | null }) {
        if (!Number.isInteger(input.minutes) || input.minutes < 1 || input.minutes > MAX_MINUTES_PER_ENTRY) throw new BadRequestException("Enter between 1 minute and 24 hours.");
        let day: Date;
        if (input.workDate) {
            if (!DATE.test(input.workDate) || Number.isNaN(new Date(`${input.workDate}T00:00:00Z`).getTime())) throw new BadRequestException("The date is not valid.");
            day = new Date(`${input.workDate}T00:00:00Z`);
        } else {
            const n = new Date();
            day = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
        }
        const note = (input.note ?? "").toString().trim().slice(0, 500) || null;
        const row = await this.prisma.time_entries.create({
            data: { organization_id: input.organizationId, user_id: input.userId, client_id: input.clientId, ticket_id: input.ticketId, work_date: day, minutes: input.minutes, billable: input.billable, note },
            select: { id: true },
        });
        return row.id;
    }

    /** For a reply or note that carries time ("15 minutes, billable"). Returns the minutes logged, or 0 when none was asked for. */
    async logFromReply(req: any, ticketId: string, time: { minutes?: unknown; billable?: unknown } | undefined, note: string, canManual: boolean): Promise<number> {
        if (!time || time.minutes === undefined || time.minutes === null || time.minutes === "") return 0;
        if (!canManual) throw new ForbiddenException(MANUAL_TIME_DENIED);
        const minutes = Number(time.minutes);
        const ticket = await this.ticketOf(ticketId, req);
        await this.logEntry({
            organizationId: ticket.organization_id, userId: userOf(req), ticketId: ticket.id, clientId: ticket.devices?.sites?.client_id ?? null,
            minutes, billable: time.billable !== false, note: note.split("\n")[0].slice(0, 200),
        });
        return minutes;
    }

    /* ------------------------------ the stopwatch ------------------------------ */

    async get(req: any, ticketId: string): Promise<TimerState> {
        const t = await this.ticketOf(ticketId, req);
        const row = await this.prisma.ticket_timers.findUnique({ where: { user_id_ticket_id: { user_id: userOf(req), ticket_id: t.id } } });
        return this.stateOf(t.id, row);
    }

    /** Every stopwatch the person has going or paused, for the "you are timing" badge and the list of unfinished timers. */
    async mine(req: any) {
        const org = orgOf(req);
        const rows = await this.prisma.ticket_timers.findMany({
            where: { user_id: userOf(req), ...(org ? { organization_id: org } : {}) },
            orderBy: { updated_at: "desc" },
            take: 20,
            include: { tickets: { select: { id: true, ticket_number: true, subject: true } } },
        });
        return {
            items: rows.map((r) => ({ ...this.stateOf(r.ticket_id, r), number: String(r.tickets.ticket_number), subject: r.tickets.subject })),
        };
    }

    async start(req: any, ticketId: string): Promise<TimerState> {
        const t = await this.ticketOf(ticketId, req);
        if (t.status === "closed") throw new ConflictException("This ticket is closed.");
        const userId = userOf(req);
        const now = new Date();
        const row = await this.prisma.$transaction(async (tx) => {
            // One at a time: anything else this person had running is paused, keeping what it had counted.
            const others = await tx.ticket_timers.findMany({ where: { user_id: userId, started_at: { not: null }, NOT: { ticket_id: t.id } } });
            for (const o of others) {
                const extra = Math.max(0, Math.floor((now.getTime() - o.started_at!.getTime()) / 1000));
                await tx.ticket_timers.update({ where: { id: o.id }, data: { started_at: null, accumulated_seconds: o.accumulated_seconds + extra, updated_at: now } });
            }
            const mine = await tx.ticket_timers.findUnique({ where: { user_id_ticket_id: { user_id: userId, ticket_id: t.id } } });
            if (!mine) return tx.ticket_timers.create({ data: { organization_id: t.organization_id, user_id: userId, ticket_id: t.id, started_at: now, accumulated_seconds: 0 } });
            if (mine.started_at) return mine; // already running
            return tx.ticket_timers.update({ where: { id: mine.id }, data: { started_at: now, updated_at: now } });
        });
        return this.stateOf(t.id, row);
    }

    async pause(req: any, ticketId: string): Promise<TimerState> {
        const t = await this.ticketOf(ticketId, req);
        const userId = userOf(req);
        const mine = await this.prisma.ticket_timers.findUnique({ where: { user_id_ticket_id: { user_id: userId, ticket_id: t.id } } });
        if (!mine) return this.stateOf(t.id, null);
        if (!mine.started_at) return this.stateOf(t.id, mine);
        const now = new Date();
        const extra = Math.max(0, Math.floor((now.getTime() - mine.started_at.getTime()) / 1000));
        const row = await this.prisma.ticket_timers.update({ where: { id: mine.id }, data: { started_at: null, accumulated_seconds: mine.accumulated_seconds + extra, updated_at: now } });
        return this.stateOf(t.id, row);
    }

    async discard(req: any, ticketId: string): Promise<TimerState> {
        const t = await this.ticketOf(ticketId, req);
        await this.prisma.ticket_timers.deleteMany({ where: { user_id: userOf(req), ticket_id: t.id } });
        return this.stateOf(t.id, null);
    }

    /** Turns the stopwatch into a time entry. `minutes` overrides what it counted (a forgotten timer is corrected here). */
    async stop(req: any, ticketId: string, body: { minutes?: unknown; billable?: unknown; note?: unknown; workDate?: unknown }, canManual: boolean) {
        const t = await this.ticketOf(ticketId, req);
        const userId = userOf(req);
        const mine = await this.prisma.ticket_timers.findUnique({ where: { user_id_ticket_id: { user_id: userId, ticket_id: t.id } } });
        if (!mine) throw new NotFoundException("There is no timer for this ticket. Start one, or enter the time by hand.");
        const state = this.stateOf(t.id, mine);

        let minutes: number;
        if (body?.minutes !== undefined && body.minutes !== null && body.minutes !== "") {
            // Overriding what the timer counted is typing time in.
            if (!canManual) throw new ForbiddenException(MANUAL_TIME_DENIED);
            minutes = Number(body.minutes);
        } else {
            if (state.seconds < MIN_TIMER_SECONDS) throw new BadRequestException("The timer ran for less than half a minute. Discard it, or enter the time by hand.");
            minutes = Math.ceil(state.seconds / 60);
            if (minutes > MAX_MINUTES_PER_ENTRY) throw new BadRequestException(`The timer counted ${Math.round(minutes / 60)} hours, which is more than a day. Say how many minutes to log instead.`);
        }
        const id = await this.logEntry({
            organizationId: t.organization_id, userId, ticketId: t.id, clientId: t.devices?.sites?.client_id ?? null, minutes,
            billable: body?.billable !== false, note: typeof body?.note === "string" ? body.note : null, workDate: canManual && typeof body?.workDate === "string" && body.workDate ? body.workDate : null,
        });
        await this.prisma.ticket_timers.delete({ where: { id: mine.id } });
        return { id, minutes };
    }
}
