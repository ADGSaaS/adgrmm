// What the tickets list adds for queues, assignment and SLAs: filters, sorting and what a person limited to some
// customers may see. All as SQL fragments over `tickets t` that look the SLA up on their own, so they can be added to any
// of the list's queries.
import { BadRequestException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { isCanonicalUuid } from "../common/agent-lookup.util";
import { ticketScopeSql } from "./queues.service";

export type ListExtras = {
    queueId?: string;
    assignee?: string;
    sla?: string;
    sort?: string;
    dir?: string;
};

export const SLA_FILTERS = ["breached", "warning", "at_risk", "paused", "ok", "none"] as const;
export const SORTS = ["created", "updated", "sla_due", "priority"] as const;

const OPEN = Prisma.sql`t.status::text NOT IN ('resolved', 'closed')`;

/** A clock that is still counting toward something, and has gone past its due time. */
const lateClock = (k: "response" | "resolution") =>
    Prisma.raw(`(s.${k}_target_min IS NOT NULL AND s.${k}_done_at IS NULL AND (s.${k}_breached_at IS NOT NULL OR (s.${k}_running_since IS NOT NULL AND s.${k}_due_at <= now())))`);
const warnClock = (k: "response" | "resolution") =>
    Prisma.raw(`(s.${k}_target_min IS NOT NULL AND s.${k}_done_at IS NULL AND s.${k}_running_since IS NOT NULL AND s.${k}_warn_at <= now())`);

export function slaFilter(kind: string): Prisma.Sql {
    const late = Prisma.sql`(${lateClock("response")} OR ${lateClock("resolution")})`;
    const warn = Prisma.sql`(${warnClock("response")} OR ${warnClock("resolution")})`;
    switch (kind) {
        case "breached":
            return Prisma.sql`(${OPEN} AND EXISTS (SELECT 1 FROM ticket_sla s WHERE s.ticket_id = t.id AND ${late}))`;
        case "warning":
            return Prisma.sql`(${OPEN} AND EXISTS (SELECT 1 FROM ticket_sla s WHERE s.ticket_id = t.id AND NOT ${late} AND ${warn}))`;
        case "at_risk":
            return Prisma.sql`(${OPEN} AND EXISTS (SELECT 1 FROM ticket_sla s WHERE s.ticket_id = t.id AND (${late} OR ${warn})))`;
        case "paused":
            return Prisma.sql`(${OPEN} AND EXISTS (SELECT 1 FROM ticket_sla s WHERE s.ticket_id = t.id AND s.paused))`;
        case "ok":
            return Prisma.sql`(${OPEN} AND EXISTS (SELECT 1 FROM ticket_sla s WHERE s.ticket_id = t.id AND NOT s.paused AND NOT ${late} AND NOT ${warn}))`;
        default:
            return Prisma.sql`NOT EXISTS (SELECT 1 FROM ticket_sla s WHERE s.ticket_id = t.id)`;
    }
}

/** The earliest due time of a clock still running; tickets with none go last. */
const DUE_ORDER = Prisma.sql`(SELECT LEAST(
        CASE WHEN s.response_done_at IS NULL THEN s.response_due_at END,
        CASE WHEN s.resolution_done_at IS NULL THEN s.resolution_due_at END)
      FROM ticket_sla s WHERE s.ticket_id = t.id)`;

export function buildExtras(q: ListExtras, who: { userId: string | null; allowed: string[] | null }): { active: boolean; sql: Prisma.Sql[]; order: Prisma.Sql } {
    const sql: Prisma.Sql[] = [];
    if (who.allowed) sql.push(ticketScopeSql(who.allowed, who.userId));

    if (q.queueId) {
        if (q.queueId === "none") sql.push(Prisma.sql`t.queue_id IS NULL`);
        else if (isCanonicalUuid(q.queueId)) sql.push(Prisma.sql`t.queue_id = ${q.queueId}::uuid`);
        else throw new BadRequestException("queueId must be a queue id or none.");
    }
    if (q.assignee) {
        if (q.assignee === "unassigned") sql.push(Prisma.sql`t.assignee_user_id IS NULL`);
        else if (q.assignee === "me") sql.push(who.userId && isCanonicalUuid(who.userId) ? Prisma.sql`t.assignee_user_id = ${who.userId}::uuid` : Prisma.sql`FALSE`);
        else if (isCanonicalUuid(q.assignee)) sql.push(Prisma.sql`t.assignee_user_id = ${q.assignee}::uuid`);
        else throw new BadRequestException("assignee must be me, unassigned or a person.");
    }
    if (q.sla) {
        if (!(SLA_FILTERS as readonly string[]).includes(q.sla)) throw new BadRequestException(`sla must be one of ${SLA_FILTERS.join(", ")}.`);
        sql.push(slaFilter(q.sla));
    }

    const dir = q.dir === "asc" ? Prisma.sql`ASC` : Prisma.sql`DESC`;
    let order = Prisma.sql`t.created_at DESC`;
    if (q.sort) {
        if (!(SORTS as readonly string[]).includes(q.sort)) throw new BadRequestException(`sort must be one of ${SORTS.join(", ")}.`);
        if (q.sort === "created") order = Prisma.sql`t.created_at ${dir}`;
        else if (q.sort === "updated") order = Prisma.sql`t.updated_at ${dir}, t.created_at DESC`;
        else if (q.sort === "priority") order = Prisma.sql`CASE t.priority::text WHEN 'urgent' THEN 4 WHEN 'high' THEN 3 WHEN 'normal' THEN 2 ELSE 1 END ${dir}, t.created_at DESC`;
        // Soonest due first by default; the direction flips it. Tickets with no running clock always go last.
        else order = Prisma.sql`${DUE_ORDER} ${q.dir === "desc" ? Prisma.sql`DESC` : Prisma.sql`ASC`} NULLS LAST, t.created_at DESC`;
    }
    return { active: sql.length > 0 || !!q.sort, sql, order };
}
