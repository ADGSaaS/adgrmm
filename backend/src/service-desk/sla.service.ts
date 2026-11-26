import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { isCanonicalUuid } from "../common/agent-lookup.util";
import { isValidTimezone } from "../reports/schedule-time";
import { SmtpService } from "../smtp/smtp.service";
import { PrismaService } from "../storage/prisma.service";
import { WebhooksService } from "../webhooks/webhooks.service";
import { cleanCalendarInput, type Calendar } from "./sla-calendar";
import { priorityFromDb, rowToState, viewOf, type SlaRow, type SlaView } from "./sla-view";
export type { SlaClockView, SlaView } from "./sla-view";
import {
    PRIORITIES,
    PRIORITY_UP,
    clockState,
    levelOf,
    overallLevel,
    reconcile,
    type Clock,
    type ClockState,
    type Level,
    type PolicySpec,
    type SlaPriority,
    type SlaState,
    type Targets,
} from "./sla-engine";

export type Escalation = {
    warning: { users: string[]; groups: string[]; notifyAssignee: boolean; email: boolean };
    breach: { users: string[]; groups: string[]; notifyAssignee: boolean; email: boolean; raisePriority: boolean; reassignUserId: string | null; moveToQueueId: string | null };
};

export type PolicyView = {
    id: string;
    name: string;
    description: string;
    calendarId: string | null;
    calendarName: string | null;
    isDefault: boolean;
    enabled: boolean;
    targets: Record<SlaPriority, { response: number | null; resolution: number | null }>;
    pauseStatuses: string[];
    warnPercent: number;
    escalation: Escalation;
    customers: number;
    createdAt: string;
    updatedAt: string;
};

export type CalendarView = { id: string; name: string; timezone: string; days: number[]; start: string; end: string; holidays: { date: string; name: string }[]; policies: number };

const MIN = 60_000;
const PAUSE_ALLOWED = ["pending", "in_progress"];
const UUID_LIST_MAX = 30;

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const ms = (d: Date | null | undefined) => (d ? d.getTime() : null);
const date = (n: number | null) => (n === null ? null : new Date(n));

function emptyEscalation(): Escalation {
    return {
        warning: { users: [], groups: [], notifyAssignee: false, email: false },
        breach: { users: [], groups: [], notifyAssignee: true, email: false, raisePriority: false, reassignUserId: null, moveToQueueId: null },
    };
}

function readEscalation(raw: unknown): Escalation {
    const e = emptyEscalation();
    const r: any = raw && typeof raw === "object" ? raw : {};
    const ids = (v: unknown) => (Array.isArray(v) ? v.map(String).filter((x) => isCanonicalUuid(x)) : []);
    e.warning = { users: ids(r.warning?.users), groups: ids(r.warning?.groups), notifyAssignee: r.warning?.notifyAssignee === true, email: r.warning?.email === true };
    e.breach = {
        users: ids(r.breach?.users),
        groups: ids(r.breach?.groups),
        notifyAssignee: r.breach?.notifyAssignee !== false,
        email: r.breach?.email === true,
        raisePriority: r.breach?.raisePriority === true,
        reassignUserId: r.breach?.reassignUserId && isCanonicalUuid(String(r.breach.reassignUserId)) ? String(r.breach.reassignUserId) : null,
        moveToQueueId: r.breach?.moveToQueueId && isCanonicalUuid(String(r.breach.moveToQueueId)) ? String(r.breach.moveToQueueId) : null,
    };
    return e;
}

function readTargets(raw: unknown): Record<SlaPriority, { response: number | null; resolution: number | null }> {
    const r: any = raw && typeof raw === "object" ? raw : {};
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : null);
    const out = {} as Record<SlaPriority, { response: number | null; resolution: number | null }>;
    for (const p of PRIORITIES) out[p] = { response: num(r[p]?.response), resolution: num(r[p]?.resolution) };
    return out;
}

const cleanName = (v: unknown, what: string) => {
    const s = String(v ?? "").replace(/\s+/g, " ").trim();
    if (!s) throw new BadRequestException(`Give the ${what} a name.`);
    if (s.length > 80) throw new BadRequestException(`The ${what} name is too long (80 characters at most).`);
    return s;
};

@Injectable()
export class SlaService {
    private readonly log = new Logger(SlaService.name);
    private running = false;

    constructor(private readonly prisma: PrismaService, private readonly webhooks: WebhooksService, private readonly smtp: SmtpService) { }

    /* ------------------------------ calendars ------------------------------ */

    private calendarView(r: any, policies = 0): CalendarView {
        return {
            id: r.id,
            name: r.name,
            timezone: r.timezone,
            days: r.days,
            start: r.start_time,
            end: r.end_time,
            holidays: Array.isArray(r.holidays) ? r.holidays.map((h: any) => ({ date: String(h.date), name: String(h.name ?? "") })) : [],
            policies,
        };
    }

    async listCalendars(orgId: string): Promise<CalendarView[]> {
        const [rows, used] = await Promise.all([
            this.prisma.sla_calendars.findMany({ where: { organization_id: orgId }, orderBy: { name: "asc" } }),
            this.prisma.sla_policies.groupBy({ by: ["calendar_id"], where: { organization_id: orgId, calendar_id: { not: null } }, _count: { _all: true } }),
        ]);
        const n = new Map(used.map((u) => [u.calendar_id, u._count._all]));
        return rows.map((r) => this.calendarView(r, n.get(r.id) ?? 0));
    }

    private async findCalendar(orgId: string, id: string) {
        const r = isCanonicalUuid(id) ? await this.prisma.sla_calendars.findFirst({ where: { id, organization_id: orgId } }) : null;
        if (!r) throw new NotFoundException("Calendar not found");
        return r;
    }

    async createCalendar(orgId: string, body: any): Promise<CalendarView> {
        const name = cleanName(body?.name, "calendar");
        const c = cleanCalendarInput(body ?? {}, isValidTimezone);
        if (!c.ok) throw new BadRequestException(c.error);
        try {
            const r = await this.prisma.sla_calendars.create({
                data: { id: randomUUID(), organization_id: orgId, name, timezone: c.value.timezone, days: c.value.days, start_time: c.value.start, end_time: c.value.end, holidays: c.value.holidays as Prisma.InputJsonValue },
            });
            return this.calendarView(r);
        } catch (e: any) {
            if (e?.code === "P2002" || e?.code === "P2010") throw new ConflictException("There is already a calendar with that name.");
            throw e;
        }
    }

    async updateCalendar(orgId: string, id: string, body: any): Promise<CalendarView> {
        const cur = await this.findCalendar(orgId, id);
        const name = body?.name === undefined ? cur.name : cleanName(body.name, "calendar");
        const c = cleanCalendarInput(
            { timezone: body?.timezone ?? cur.timezone, days: body?.days ?? cur.days, start: body?.start ?? cur.start_time, end: body?.end ?? cur.end_time, holidays: body?.holidays ?? cur.holidays },
            isValidTimezone
        );
        if (!c.ok) throw new BadRequestException(c.error);
        try {
            const r = await this.prisma.sla_calendars.update({
                where: { id },
                data: { name, timezone: c.value.timezone, days: c.value.days, start_time: c.value.start, end_time: c.value.end, holidays: c.value.holidays as Prisma.InputJsonValue, updated_at: new Date() },
            });
            // Open tickets that count in this calendar are aimed again.
            void this.resyncPolicies(orgId, (await this.prisma.sla_policies.findMany({ where: { organization_id: orgId, calendar_id: id }, select: { id: true } })).map((p) => p.id));
            return this.calendarView(r);
        } catch (e: any) {
            if (e?.code === "P2002" || e?.code === "P2010") throw new ConflictException("There is already a calendar with that name.");
            throw e;
        }
    }

    async deleteCalendar(orgId: string, id: string): Promise<{ ok: true }> {
        await this.findCalendar(orgId, id);
        const used = await this.prisma.sla_policies.count({ where: { calendar_id: id } });
        if (used > 0) throw new ConflictException(`${used} policy${used === 1 ? " uses" : " policies use"} this calendar. Change them first.`);
        await this.prisma.sla_calendars.delete({ where: { id } });
        return { ok: true };
    }

    /* ------------------------------ policies ------------------------------ */

    private async policyView(r: any, calendarName: string | null, customers: number): Promise<PolicyView> {
        return {
            id: r.id,
            name: r.name,
            description: r.description ?? "",
            calendarId: r.calendar_id,
            calendarName,
            isDefault: r.is_default,
            enabled: r.enabled,
            targets: readTargets(r.targets),
            pauseStatuses: r.pause_statuses,
            warnPercent: r.warn_percent,
            escalation: readEscalation(r.escalation),
            customers,
            createdAt: r.created_at.toISOString(),
            updatedAt: r.updated_at.toISOString(),
        };
    }

    async listPolicies(orgId: string): Promise<PolicyView[]> {
        const [rows, calendars, assigned] = await Promise.all([
            this.prisma.sla_policies.findMany({ where: { organization_id: orgId }, orderBy: [{ is_default: "desc" }, { name: "asc" }] }),
            this.prisma.sla_calendars.findMany({ where: { organization_id: orgId }, select: { id: true, name: true } }),
            this.prisma.sla_client_policies.groupBy({ by: ["policy_id"], _count: { _all: true } }),
        ]);
        const cal = new Map(calendars.map((c) => [c.id, c.name]));
        const n = new Map(assigned.map((a) => [a.policy_id, a._count._all]));
        return Promise.all(rows.map((r) => this.policyView(r, r.calendar_id ? cal.get(r.calendar_id) ?? null : null, n.get(r.id) ?? 0)));
    }

    private async findPolicy(orgId: string, id: string) {
        const r = isCanonicalUuid(id) ? await this.prisma.sla_policies.findFirst({ where: { id, organization_id: orgId } }) : null;
        if (!r) throw new NotFoundException("Policy not found");
        return r;
    }

    async getPolicy(orgId: string, id: string): Promise<PolicyView> {
        const r = await this.findPolicy(orgId, id);
        const [cal, n] = await Promise.all([
            r.calendar_id ? this.prisma.sla_calendars.findUnique({ where: { id: r.calendar_id }, select: { name: true } }) : null,
            this.prisma.sla_client_policies.count({ where: { policy_id: id } }),
        ]);
        return this.policyView(r, cal?.name ?? null, n);
    }

    private cleanTargets(raw: unknown): Record<SlaPriority, { response: number | null; resolution: number | null }> {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new BadRequestException("Give a response and a resolution time for the priorities.");
        const src: any = raw;
        const out = {} as Record<SlaPriority, { response: number | null; resolution: number | null }>;
        let any = false;
        for (const p of PRIORITIES) {
            const one = (v: unknown, what: string) => {
                if (v === null || v === undefined || v === "") return null;
                const n = Number(v);
                if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 525_600) throw new BadRequestException(`The ${p} ${what} time must be a whole number of minutes between 1 and 525600 (a year).`);
                any = true;
                return n;
            };
            const t = one(src[p]?.response, "response");
            const s = one(src[p]?.resolution, "resolution");
            if (t !== null && s !== null && t > s) throw new BadRequestException(`For ${p} priority the first response cannot take longer than the resolution.`);
            out[p] = { response: t, resolution: s };
        }
        if (!any) throw new BadRequestException("Set at least one target.");
        return out;
    }

    private async cleanEscalation(orgId: string, raw: unknown, current?: Escalation): Promise<Escalation> {
        const base = current ?? emptyEscalation();
        if (raw === undefined) return base;
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new BadRequestException("The escalation settings are not valid.");
        const r: any = raw;
        const list = (v: unknown, what: string) => {
            if (v === undefined) return undefined;
            if (!Array.isArray(v)) throw new BadRequestException(`${what} must be a list.`);
            const ids = [...new Set(v.map(String))];
            if (ids.length > UUID_LIST_MAX) throw new BadRequestException(`${what}: ${UUID_LIST_MAX} at most.`);
            if (ids.some((x) => !isCanonicalUuid(x))) throw new BadRequestException(`${what} has something that is not a person or group.`);
            return ids;
        };
        const merged = emptyEscalation();
        for (const k of ["warning", "breach"] as const) {
            const o: any = r[k] ?? {};
            const b: any = base[k];
            const users = list(o.users, "People to tell") ?? b.users;
            const groups = list(o.groups, "Groups to tell") ?? b.groups;
            (merged as any)[k] = {
                ...b,
                users,
                groups,
                notifyAssignee: o.notifyAssignee === undefined ? b.notifyAssignee : o.notifyAssignee === true,
                email: o.email === undefined ? b.email : o.email === true,
                ...(k === "breach"
                    ? {
                        raisePriority: o.raisePriority === undefined ? b.raisePriority : o.raisePriority === true,
                        reassignUserId: o.reassignUserId === undefined ? b.reassignUserId : o.reassignUserId ? String(o.reassignUserId) : null,
                        moveToQueueId: o.moveToQueueId === undefined ? b.moveToQueueId : o.moveToQueueId ? String(o.moveToQueueId) : null,
                    }
                    : {}),
            };
        }
        const people = [...merged.warning.users, ...merged.breach.users, ...(merged.breach.reassignUserId ? [merged.breach.reassignUserId] : [])];
        if (people.some((x) => !isCanonicalUuid(x))) throw new BadRequestException("Choose people from the list.");
        if (people.length) {
            const found = await this.prisma.users.count({ where: { id: { in: [...new Set(people)] }, organization_id: orgId } });
            if (found !== new Set(people).size) throw new BadRequestException("One of the people chosen does not exist.");
        }
        const groups = [...merged.warning.groups, ...merged.breach.groups];
        if (groups.length) {
            const found = await this.prisma.user_groups.count({ where: { id: { in: [...new Set(groups)] }, organization_id: orgId } });
            if (found !== new Set(groups).size) throw new BadRequestException("One of the groups chosen does not exist.");
        }
        if (merged.breach.moveToQueueId) {
            if (!isCanonicalUuid(merged.breach.moveToQueueId) || !(await this.prisma.ticket_queues.findFirst({ where: { id: merged.breach.moveToQueueId, organization_id: orgId }, select: { id: true } }))) throw new BadRequestException("That queue does not exist.");
        }
        return merged;
    }

    async createPolicy(orgId: string, body: any): Promise<PolicyView> {
        const name = cleanName(body?.name, "policy");
        const targets = this.cleanTargets(body?.targets);
        const calendarId = body?.calendarId ? String(body.calendarId) : null;
        if (calendarId) await this.findCalendar(orgId, calendarId).catch(() => { throw new BadRequestException("That calendar does not exist."); });
        const pause = this.cleanPause(body?.pauseStatuses);
        const warn = this.cleanWarn(body?.warnPercent);
        const escalation = await this.cleanEscalation(orgId, body?.escalation);
        const description = String(body?.description ?? "").trim().slice(0, 300);
        const id = randomUUID();
        try {
            await this.prisma.$transaction(async (tx) => {
                const makeDefault = body?.isDefault === true || (body?.isDefault === undefined && (await tx.sla_policies.count({ where: { organization_id: orgId } })) === 0);
                if (makeDefault) await tx.sla_policies.updateMany({ where: { organization_id: orgId, is_default: true }, data: { is_default: false } });
                await tx.sla_policies.create({
                    data: { id, organization_id: orgId, name, description: description || null, calendar_id: calendarId, is_default: makeDefault, enabled: body?.enabled !== false, targets: targets as Prisma.InputJsonValue, pause_statuses: pause, warn_percent: warn, escalation: escalation as unknown as Prisma.InputJsonValue },
                });
            });
        } catch (e: any) {
            if (e?.code === "P2002" || e?.code === "P2010") throw new ConflictException("There is already a policy with that name.");
            throw e;
        }
        void this.resyncAll(orgId);
        return this.getPolicy(orgId, id);
    }

    private cleanPause(v: unknown): string[] {
        if (v === undefined) return ["pending"];
        if (!Array.isArray(v)) throw new BadRequestException("Pause statuses must be a list.");
        const s = [...new Set(v.map(String))];
        if (s.some((x) => !PAUSE_ALLOWED.includes(x))) throw new BadRequestException(`The clocks can pause only while a ticket is: ${PAUSE_ALLOWED.join(", ")}.`);
        return s;
    }

    private cleanWarn(v: unknown): number {
        if (v === undefined || v === null || v === "") return 80;
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1 || n > 99) throw new BadRequestException("The warning point must be a whole percent between 1 and 99.");
        return n;
    }

    async updatePolicy(orgId: string, id: string, body: any): Promise<PolicyView> {
        const cur = await this.findPolicy(orgId, id);
        const data: Prisma.sla_policiesUncheckedUpdateInput = { updated_at: new Date() };
        if (body?.name !== undefined) data.name = cleanName(body.name, "policy");
        if (body?.description !== undefined) data.description = String(body.description ?? "").trim().slice(0, 300) || null;
        if (body?.targets !== undefined) data.targets = this.cleanTargets(body.targets) as Prisma.InputJsonValue;
        if (body?.calendarId !== undefined) {
            if (body.calendarId) await this.findCalendar(orgId, String(body.calendarId)).catch(() => { throw new BadRequestException("That calendar does not exist."); });
            data.calendar_id = body.calendarId ? String(body.calendarId) : null;
        }
        if (body?.pauseStatuses !== undefined) data.pause_statuses = this.cleanPause(body.pauseStatuses);
        if (body?.warnPercent !== undefined) data.warn_percent = this.cleanWarn(body.warnPercent);
        if (body?.enabled !== undefined) data.enabled = body.enabled === true;
        if (body?.escalation !== undefined) data.escalation = (await this.cleanEscalation(orgId, body.escalation, readEscalation(cur.escalation))) as unknown as Prisma.InputJsonValue;
        try {
            await this.prisma.$transaction(async (tx) => {
                if (body?.isDefault === true) {
                    await tx.sla_policies.updateMany({ where: { organization_id: orgId, is_default: true, NOT: { id } }, data: { is_default: false } });
                    data.is_default = true;
                } else if (body?.isDefault === false) data.is_default = false;
                await tx.sla_policies.update({ where: { id }, data });
            });
        } catch (e: any) {
            if (e?.code === "P2002" || e?.code === "P2010") throw new ConflictException("There is already a policy with that name.");
            throw e;
        }
        void this.resyncAll(orgId, true);
        return this.getPolicy(orgId, id);
    }

    async deletePolicy(orgId: string, id: string): Promise<{ ok: true }> {
        await this.findPolicy(orgId, id);
        await this.prisma.sla_policies.delete({ where: { id } });
        void this.resyncAll(orgId);
        return { ok: true };
    }

    /* ------------------------------ customers ------------------------------ */

    /** The customers that have a policy of their own. */
    async listClientPolicies(orgId: string): Promise<{ clientId: string; clientName: string; policyId: string; policyName: string }[]> {
        const rows = await this.prisma.$queryRaw<{ client_id: string; client_name: string; policy_id: string; policy_name: string }[]>`
            SELECT cp.client_id::text AS client_id, c.name AS client_name, cp.policy_id::text AS policy_id, p.name AS policy_name
              FROM sla_client_policies cp
              JOIN clients c ON c.id = cp.client_id
              JOIN sla_policies p ON p.id = cp.policy_id
             WHERE c.organization_id = ${orgId}::uuid
             ORDER BY lower(c.name)`;
        return rows.map((r) => ({ clientId: r.client_id, clientName: r.client_name, policyId: r.policy_id, policyName: r.policy_name }));
    }

    async setClientPolicy(orgId: string, clientId: string, policyId: string | null): Promise<{ ok: true }> {
        const client = isCanonicalUuid(clientId) ? await this.prisma.clients.findFirst({ where: { id: clientId, organization_id: orgId }, select: { id: true } }) : null;
        if (!client) throw new NotFoundException("Customer not found");
        if (policyId === null) {
            await this.prisma.sla_client_policies.deleteMany({ where: { client_id: clientId } });
        } else {
            await this.findPolicy(orgId, policyId);
            await this.prisma.sla_client_policies.upsert({ where: { client_id: clientId }, create: { client_id: clientId, policy_id: policyId }, update: { policy_id: policyId } });
        }
        void this.resyncClient(orgId, clientId);
        return { ok: true };
    }

    /* ------------------------------ which policy a ticket gets ------------------------------ */

    private toSpec(p: any): PolicySpec {
        return { id: p.id, name: p.name, targets: readTargets(p.targets) as Targets, pauseStatuses: p.pause_statuses, warnPercent: p.warn_percent, createdAt: p.created_at.getTime() };
    }

    /** The customer's own policy, else the queue's, else the default one. Disabled policies are skipped. */
    async policyFor(orgId: string, clientId: string | null, queueId: string | null) {
        if (clientId) {
            const own = await this.prisma.sla_client_policies.findUnique({ where: { client_id: clientId } });
            if (own) {
                const p = await this.prisma.sla_policies.findFirst({ where: { id: own.policy_id, organization_id: orgId, enabled: true } });
                if (p) return p;
            }
        }
        if (queueId) {
            const q = await this.prisma.ticket_queues.findFirst({ where: { id: queueId, organization_id: orgId }, select: { default_sla_policy_id: true } });
            if (q?.default_sla_policy_id) {
                const p = await this.prisma.sla_policies.findFirst({ where: { id: q.default_sla_policy_id, organization_id: orgId, enabled: true } });
                if (p) return p;
            }
        }
        return this.prisma.sla_policies.findFirst({ where: { organization_id: orgId, is_default: true, enabled: true } });
    }

    private async calendarOf(policy: { calendar_id: string | null }): Promise<Calendar> {
        if (!policy.calendar_id) return null;
        const c = await this.prisma.sla_calendars.findUnique({ where: { id: policy.calendar_id } });
        if (!c) return null;
        return { timezone: c.timezone, days: c.days, start: c.start_time, end: c.end_time, holidays: (Array.isArray(c.holidays) ? c.holidays : []).map((h: any) => String(h.date)) };
    }

    /* ------------------------------ keeping a ticket's clocks right ------------------------------ */

    /**
     * Brings the ticket's clocks up to date with its policy, priority and status. Safe to call after any change, and
     * more than once. `respondedAt` says a technician has answered (or acknowledged) the ticket at that moment.
     */
    async sync(ticketId: string, opts: { respondedAt?: Date | null; reaim?: boolean; now?: Date } = {}): Promise<void> {
        try {
            const t = await this.prisma.tickets.findUnique({ where: { id: ticketId }, select: { id: true, organization_id: true, status: true, priority: true, client_id: true, queue_id: true, created_at: true } });
            if (!t) return;
            const policy = await this.policyFor(t.organization_id, t.client_id, t.queue_id);
            const existing = (await this.prisma.$queryRaw<SlaRow[]>`SELECT * FROM ticket_sla WHERE ticket_id = ${ticketId}::uuid`)[0] ?? null;
            if (!policy) {
                if (existing) await this.prisma.ticket_sla.deleteMany({ where: { ticket_id: ticketId } });
                return;
            }
            const cal = await this.calendarOf(policy);
            const now = (opts.now ?? new Date()).getTime();
            const prev = existing ? rowToState(existing) : null;
            const next = reconcile(prev, {
                now,
                createdAt: t.created_at.getTime(),
                status: t.status,
                priority: priorityFromDb(t.priority),
                policy: this.toSpec(policy),
                calendar: cal,
                respondedAt: opts.respondedAt ? opts.respondedAt.getTime() : prev?.response.doneAt ?? null,
                reaim: opts.reaim,
            });
            if (prev && JSON.stringify(prev) === JSON.stringify(next)) return;
            await this.save(ticketId, next);
        } catch (e) {
            // The policy or the ticket was deleted while this ran: there is nothing left to keep right.
            if (/23503|foreign key/i.test(String((e as Error).message))) return;
            this.log.warn(`Could not update the SLA clocks of ticket ${ticketId}: ${(e as Error).message}`);
        }
    }

    private async save(ticketId: string, s: SlaState): Promise<void> {
        const d = (n: number | null) => date(n);
        const r = s.response;
        const x = s.resolution;
        // Warned and breached stay as first recorded, even if this write was prepared a moment before the job recorded them.
        await this.prisma.$executeRaw`
            INSERT INTO ticket_sla (ticket_id, policy_id, policy_name, priority, status, paused, warn_percent,
                response_target_min, response_used_ms, response_running_since, response_due_at, response_warn_at, response_done_at, response_met, response_warned_at, response_breached_at,
                resolution_target_min, resolution_used_ms, resolution_running_since, resolution_due_at, resolution_warn_at, resolution_done_at, resolution_met, resolution_warned_at, resolution_breached_at, updated_at)
            VALUES (${ticketId}::uuid, ${s.policyId}::uuid, ${s.policyName}, ${s.priority}, ${s.status}, ${s.paused}, ${s.warnPercent},
                ${r.targetMin}, ${BigInt(Math.round(r.usedMs))}, ${d(r.runningSince)}, ${d(r.dueAt)}, ${d(r.warnAt)}, ${d(r.doneAt)}, ${r.met}, ${d(r.warnedAt)}, ${d(r.breachedAt)},
                ${x.targetMin}, ${BigInt(Math.round(x.usedMs))}, ${d(x.runningSince)}, ${d(x.dueAt)}, ${d(x.warnAt)}, ${d(x.doneAt)}, ${x.met}, ${d(x.warnedAt)}, ${d(x.breachedAt)}, now())
            ON CONFLICT (ticket_id) DO UPDATE SET
                policy_id = EXCLUDED.policy_id, policy_name = EXCLUDED.policy_name, priority = EXCLUDED.priority, status = EXCLUDED.status, paused = EXCLUDED.paused, warn_percent = EXCLUDED.warn_percent,
                response_target_min = EXCLUDED.response_target_min, response_used_ms = EXCLUDED.response_used_ms, response_running_since = EXCLUDED.response_running_since,
                response_due_at = EXCLUDED.response_due_at, response_warn_at = EXCLUDED.response_warn_at, response_done_at = EXCLUDED.response_done_at, response_met = EXCLUDED.response_met,
                response_warned_at = COALESCE(ticket_sla.response_warned_at, EXCLUDED.response_warned_at), response_breached_at = COALESCE(ticket_sla.response_breached_at, EXCLUDED.response_breached_at),
                resolution_target_min = EXCLUDED.resolution_target_min, resolution_used_ms = EXCLUDED.resolution_used_ms, resolution_running_since = EXCLUDED.resolution_running_since,
                resolution_due_at = EXCLUDED.resolution_due_at, resolution_warn_at = EXCLUDED.resolution_warn_at, resolution_done_at = EXCLUDED.resolution_done_at, resolution_met = EXCLUDED.resolution_met,
                resolution_warned_at = COALESCE(ticket_sla.resolution_warned_at, EXCLUDED.resolution_warned_at), resolution_breached_at = COALESCE(ticket_sla.resolution_breached_at, EXCLUDED.resolution_breached_at),
                updated_at = now()`;
    }

    /** Tickets that are still being worked, to be aimed again after a policy, calendar or customer setting changed. */
    private async resyncWhere(where: Prisma.Sql, reaim: boolean) {
        const rows = await this.prisma.$queryRaw<{ id: string }[]>`
            SELECT t.id::text AS id FROM tickets t
             WHERE t.status::text NOT IN ('resolved', 'closed') AND ${where}
             ORDER BY t.created_at DESC LIMIT 5000`;
        for (const r of rows) await this.sync(r.id, { reaim });
    }

    async resyncAll(orgId: string, reaim = false): Promise<void> {
        try {
            await this.resyncWhere(Prisma.sql`t.organization_id = ${orgId}::uuid`, reaim);
        } catch (e) {
            this.log.warn(`Could not update the SLA clocks after a policy change: ${(e as Error).message}`);
        }
    }

    private async resyncPolicies(orgId: string, policyIds: string[]) {
        if (!policyIds.length) return;
        try {
            await this.resyncWhere(Prisma.sql`t.organization_id = ${orgId}::uuid AND t.id IN (SELECT ticket_id FROM ticket_sla WHERE policy_id = ANY(${policyIds}::uuid[]))`, true);
        } catch (e) {
            this.log.warn(`Could not update the SLA clocks after a calendar change: ${(e as Error).message}`);
        }
    }

    private async resyncClient(orgId: string, clientId: string) {
        try {
            await this.resyncWhere(Prisma.sql`t.organization_id = ${orgId}::uuid AND t.client_id = ${clientId}::uuid`, false);
        } catch (e) {
            this.log.warn(`Could not update the SLA clocks after a customer's policy changed: ${(e as Error).message}`);
        }
    }

    /* ------------------------------ reading ------------------------------ */

    /** The SLA of several tickets, by ticket id. Tickets without a policy are left out. */
    async viewsFor(ticketIds: string[]): Promise<Map<string, SlaView>> {
        const out = new Map<string, SlaView>();
        if (!ticketIds.length) return out;
        const rows = await this.prisma.$queryRaw<SlaRow[]>`SELECT * FROM ticket_sla WHERE ticket_id = ANY(${ticketIds}::uuid[])`;
        const now = Date.now();
        for (const r of rows) out.set(r.ticket_id, viewOf(r, now));
        return out;
    }

    /* ------------------------------ the periodic check ------------------------------ */

    @Cron(CronExpression.EVERY_MINUTE)
    async tick(): Promise<void> {
        if (process.env.SLA_JOB === "0" || this.running) return;
        this.running = true;
        try {
            await this.run();
        } catch (e) {
            this.log.warn(`SLA check failed: ${(e as Error).message}`);
        } finally {
            this.running = false;
        }
    }

    /**
     * One pass: catches tickets whose status or priority changed some way that did not tell us, then records the
     * warnings and breaches that are due (once each) and carries out the escalation of the policy.
     */
    async run(now = new Date()): Promise<{ synced: number; warnings: number; breaches: number }> {
        const out = { synced: 0, warnings: 0, breaches: 0 };

        // Tickets changed behind our back, and open tickets that have no clocks yet while a policy exists.
        if ((await this.prisma.sla_policies.count({ where: { enabled: true } })) > 0) {
            const stale = await this.prisma.$queryRaw<{ id: string }[]>`
                SELECT t.id::text AS id
                  FROM tickets t
                  LEFT JOIN ticket_sla s ON s.ticket_id = t.id
                 WHERE (s.ticket_id IS NULL AND t.status::text NOT IN ('resolved', 'closed') AND t.created_at > now() - interval '60 days')
                    OR (s.ticket_id IS NOT NULL AND (s.status <> t.status::text OR s.priority <> CASE WHEN t.priority::text = 'normal' THEN 'medium' ELSE t.priority::text END))
                 ORDER BY t.updated_at DESC LIMIT 500`;
            for (const r of stale) { await this.sync(r.id, { now }); out.synced++; }
        }

        for (const k of ["response", "resolution"] as const) {
            // Claiming a row and recording it are one statement, so a warning or breach fires once, even with two servers.
            const warned = await this.prisma.$queryRawUnsafe<{ ticket_id: string; policy_id: string | null; due: Date | null }[]>(
                `UPDATE ticket_sla SET ${k}_warned_at = $1 WHERE ${k}_warn_at <= $1 AND ${k}_warned_at IS NULL AND ${k}_done_at IS NULL AND ${k}_running_since IS NOT NULL
                 RETURNING ticket_id::text AS ticket_id, policy_id::text AS policy_id, ${k}_due_at AS due`,
                now
            );
            for (const w of warned) {
                // Past its due time as well (the job was not running): the breach below says it.
                if (w.due && w.due.getTime() <= now.getTime()) continue;
                out.warnings++;
                await this.escalate("warning", k, w.ticket_id, w.policy_id).catch((e) => this.log.warn(`SLA warning actions failed: ${e.message}`));
            }
            const breached = await this.prisma.$queryRawUnsafe<{ ticket_id: string; policy_id: string | null }[]>(
                `UPDATE ticket_sla SET ${k}_breached_at = $1, ${k}_warned_at = COALESCE(${k}_warned_at, $1) WHERE ${k}_due_at <= $1 AND ${k}_breached_at IS NULL AND ${k}_done_at IS NULL AND ${k}_running_since IS NOT NULL
                 RETURNING ticket_id::text AS ticket_id, policy_id::text AS policy_id`,
                now
            );
            for (const b of breached) {
                out.breaches++;
                await this.escalate("breach", k, b.ticket_id, b.policy_id).catch((e) => this.log.warn(`SLA breach actions failed: ${e.message}`));
            }
        }
        return out;
    }

    /* ------------------------------ escalation ------------------------------ */

    private async recipients(orgId: string, cfg: { users: string[]; groups: string[]; notifyAssignee: boolean }, assignee: string | null): Promise<{ id: string; email: string; name: string }[]> {
        const ids = new Set(cfg.users);
        if (cfg.notifyAssignee && assignee) ids.add(assignee);
        if (cfg.groups.length) {
            const members = await this.prisma.user_group_members.findMany({ where: { group_id: { in: cfg.groups } }, select: { user_id: true } });
            for (const m of members) ids.add(m.user_id);
        }
        if (!ids.size) return [];
        const users = await this.prisma.users.findMany({ where: { id: { in: [...ids] }, organization_id: orgId, status: "active" }, select: { id: true, email: true, first_name: true, last_name: true } });
        return users.map((u) => ({ id: u.id, email: String(u.email), name: [u.first_name, u.last_name].filter(Boolean).join(" ") || String(u.email) }));
    }

    private async escalate(kind: "warning" | "breach", timer: "response" | "resolution", ticketId: string, policyId: string | null): Promise<void> {
        const t = await this.prisma.tickets.findUnique({ where: { id: ticketId }, select: { id: true, organization_id: true, ticket_number: true, subject: true, priority: true, assignee_user_id: true, queue_id: true, status: true } });
        if (!t) return;
        const policy = policyId ? await this.prisma.sla_policies.findUnique({ where: { id: policyId } }) : null;
        const esc = readEscalation(policy?.escalation);
        const cfg = esc[kind];
        const what = timer === "response" ? "first response" : "resolution";
        const number = Number(t.ticket_number);
        const title = kind === "warning" ? `SLA warning: ticket #${number}, ${what} is close to its limit` : `SLA breached: ticket #${number}, ${what} time is up`;
        const detail = `${t.subject} (policy ${policy?.name ?? "removed"}, priority ${priorityFromDb(t.priority)})`;

        const people = await this.recipients(t.organization_id, cfg, t.assignee_user_id);
        if (people.length) {
            await this.prisma.ticket_notices.createMany({ data: people.map((p) => ({ id: randomUUID(), organization_id: t.organization_id, user_id: p.id, ticket_id: t.id, kind: kind === "warning" ? "sla_warning" : "sla_breached", title, body: detail })) });
            if (cfg.email) {
                const base = (process.env.PUBLIC_CONSOLE_URL || "").replace(/\/+$/, "");
                const text = `${title}\n\n${detail}\n${base ? `\n${base}/tickets/${t.id}\n` : ""}\nSent by the SLA rules in ADG RMM.`;
                for (const p of people) {
                    const sent = await this.smtp.sendPlain("alerts", p.email, title, text).catch((e: Error) => ({ ok: false, result: e.message }));
                    if (!sent.ok) this.log.warn(`SLA email to ${p.email} not sent: ${sent.result}`);
                }
            }
        }

        let changed = false;
        if (kind === "breach") {
            const data: Prisma.ticketsUncheckedUpdateManyInput = {};
            const history: { field: string; from: string; to: string }[] = [];
            if (esc.breach.raisePriority) {
                const now = priorityFromDb(t.priority);
                const up = PRIORITY_UP[now] ?? now;
                if (up !== now) {
                    data.priority = (up === "medium" ? "normal" : up) as any;
                    history.push({ field: "priority", from: now, to: up });
                }
            }
            if (esc.breach.reassignUserId && esc.breach.reassignUserId !== t.assignee_user_id) {
                data.assignee_user_id = esc.breach.reassignUserId;
                history.push({ field: "assignee", from: t.assignee_user_id ?? "", to: esc.breach.reassignUserId });
            }
            if (esc.breach.moveToQueueId && esc.breach.moveToQueueId !== t.queue_id) {
                data.queue_id = esc.breach.moveToQueueId;
                const names = await this.prisma.ticket_queues.findMany({ where: { id: { in: [esc.breach.moveToQueueId, ...(t.queue_id ? [t.queue_id] : [])] } }, select: { id: true, name: true } });
                const nm = (id: string | null) => names.find((n) => n.id === id)?.name ?? "";
                history.push({ field: "queue", from: nm(t.queue_id), to: nm(esc.breach.moveToQueueId) });
            }
            if (Object.keys(data).length) {
                data.updated_at = new Date();
                await this.prisma.tickets.updateMany({ where: { id: t.id }, data });
                changed = true;
            }
            const base = Date.now();
            await this.prisma.ticket_activity.createMany({
                data: [{ field: "SLA", from: "", to: `${what} time breached` }, ...history].map((h, i) => ({
                    id: randomUUID(), ticket_id: t.id, kind: "change", body: `${h.field}: ${h.from || "-"} -> ${h.to || "-"}`, attachments: [], time_worked_seconds: 0, notify_customer: false,
                    author: "SLA", is_internal: true, field: h.field, from_value: h.from || null, to_value: h.to || null, created_at: new Date(base + i),
                })),
            });
        } else {
            await this.prisma.ticket_activity.create({
                data: { id: randomUUID(), ticket_id: t.id, kind: "change", body: `SLA: - -> ${what} warning`, attachments: [], time_worked_seconds: 0, notify_customer: false, author: "SLA", is_internal: true, field: "SLA", from_value: null, to_value: `${what} warning` },
            });
        }

        const view = (await this.viewsFor([t.id])).get(t.id);
        const clock = view?.[timer];
        void this.webhooks.emitTicket(kind === "warning" ? "ticket.sla_warning" : "ticket.sla_breached", t.id, {
            sla: { timer, policy: policy?.name ?? null, dueAt: clock?.dueAt ?? null, targetMinutes: clock?.targetMinutes ?? null, ...(kind === "warning" ? { warnPercent: policy?.warn_percent ?? 80 } : {}) },
        }, t.organization_id);
        if (changed) {
            void this.webhooks.emitTicket("ticket.updated", t.id, { changes: [{ field: "sla", from: null, to: "breach actions" }], changedBy: "SLA" }, t.organization_id);
            await this.sync(t.id);
        }
    }

    /* ------------------------------ notices ------------------------------ */

    async notices(userId: string, orgId: string) {
        const rows = await this.prisma.ticket_notices.findMany({ where: { user_id: userId, organization_id: orgId, read_at: null }, orderBy: { created_at: "desc" }, take: 50 });
        return rows.map((n) => ({ id: n.id, kind: n.kind, title: n.title, body: n.body, ticketId: n.ticket_id, createdAt: n.created_at.toISOString() }));
    }

    async markNoticesRead(userId: string, ids: string[] | "all"): Promise<{ read: number }> {
        const where: Prisma.ticket_noticesWhereInput = { user_id: userId, read_at: null, ...(ids === "all" ? {} : { id: { in: ids.filter((i) => isCanonicalUuid(i)) } }) };
        const r = await this.prisma.ticket_notices.updateMany({ where, data: { read_at: new Date() } });
        return { read: r.count };
    }
}
