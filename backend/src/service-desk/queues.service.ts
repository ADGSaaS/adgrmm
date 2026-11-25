import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { isCanonicalUuid } from "../common/agent-lookup.util";
import { PrismaService } from "../storage/prisma.service";
import { nextInPool } from "./routing-rules";

export type QueueView = {
    id: string;
    name: string;
    description: string;
    enabled: boolean;
    assignment: "none" | "user" | "round_robin";
    defaultAssigneeUserId: string | null;
    poolUserIds: string[];
    poolGroupId: string | null;
    defaultSlaPolicyId: string | null;
    /** Tickets that are not resolved or closed. */
    open: number;
    unassigned: number;
};

const cleanName = (v: unknown) => {
    const s = String(v ?? "").replace(/\s+/g, " ").trim();
    if (!s) throw new BadRequestException("Give the queue a name.");
    if (s.length > 60) throw new BadRequestException("The queue name is too long (60 characters at most).");
    return s;
};

const OPEN = Prisma.sql`t.status::text NOT IN ('resolved', 'closed')`;

/** Customers a limited person may see, as SQL on tickets t: their customers' tickets, and tickets assigned to them. */
export function ticketScopeSql(allowed: string[] | null, userId: string | null): Prisma.Sql {
    if (!allowed) return Prisma.sql`TRUE`;
    return Prisma.sql`(t.client_id = ANY(${allowed}::uuid[]) ${userId && isCanonicalUuid(userId) ? Prisma.sql`OR t.assignee_user_id = ${userId}::uuid` : Prisma.empty})`;
}

@Injectable()
export class QueuesService {
    constructor(private readonly prisma: PrismaService) { }

    private async view(r: any, open = 0, unassigned = 0): Promise<QueueView> {
        return {
            id: r.id,
            name: r.name,
            description: r.description ?? "",
            enabled: r.enabled,
            assignment: r.assignment,
            defaultAssigneeUserId: r.default_assignee_user_id,
            poolUserIds: r.pool_user_ids,
            poolGroupId: r.pool_group_id,
            defaultSlaPolicyId: r.default_sla_policy_id,
            open,
            unassigned,
        };
    }

    async list(orgId: string, allowed: string[] | null = null, userId: string | null = null): Promise<QueueView[]> {
        const rows = await this.prisma.ticket_queues.findMany({ where: { organization_id: orgId }, orderBy: { name: "asc" } });
        const counts = await this.prisma.$queryRaw<{ queue_id: string; open: number; unassigned: number }[]>`
            SELECT t.queue_id::text AS queue_id, count(*)::int AS open, count(*) FILTER (WHERE t.assignee_user_id IS NULL)::int AS unassigned
              FROM tickets t
             WHERE t.organization_id = ${orgId}::uuid AND t.queue_id IS NOT NULL AND ${OPEN} AND ${ticketScopeSql(allowed, userId)}
             GROUP BY t.queue_id`;
        const n = new Map(counts.map((c) => [c.queue_id, c]));
        return Promise.all(rows.map((r) => this.view(r, n.get(r.id)?.open ?? 0, n.get(r.id)?.unassigned ?? 0)));
    }

    /** Numbers for the tickets screen: each queue, tickets in no queue, the person's own tickets and everything unassigned. */
    async counts(orgId: string, allowed: string[] | null, userId: string | null) {
        const queues = await this.list(orgId, allowed, userId);
        const [row] = await this.prisma.$queryRaw<{ open: number; mine: number; unassigned: number; no_queue: number; breached: number }[]>`
            SELECT count(*)::int AS open,
                   count(*) FILTER (WHERE ${userId && isCanonicalUuid(userId) ? Prisma.sql`t.assignee_user_id = ${userId}::uuid` : Prisma.sql`FALSE`})::int AS mine,
                   count(*) FILTER (WHERE t.assignee_user_id IS NULL)::int AS unassigned,
                   count(*) FILTER (WHERE t.queue_id IS NULL)::int AS no_queue,
                   count(*) FILTER (WHERE s.response_breached_at IS NOT NULL AND s.response_done_at IS NULL OR s.resolution_breached_at IS NOT NULL AND s.resolution_done_at IS NULL)::int AS breached
              FROM tickets t LEFT JOIN ticket_sla s ON s.ticket_id = t.id
             WHERE t.organization_id = ${orgId}::uuid AND ${OPEN} AND ${ticketScopeSql(allowed, userId)}`;
        return {
            open: row?.open ?? 0,
            mine: row?.mine ?? 0,
            unassigned: row?.unassigned ?? 0,
            noQueue: row?.no_queue ?? 0,
            breached: row?.breached ?? 0,
            queues: queues.map((q) => ({ id: q.id, name: q.name, enabled: q.enabled, open: q.open, unassigned: q.unassigned })),
        };
    }

    private async find(orgId: string, id: string) {
        const r = isCanonicalUuid(id) ? await this.prisma.ticket_queues.findFirst({ where: { id, organization_id: orgId } }) : null;
        if (!r) throw new NotFoundException("Queue not found");
        return r;
    }

    /** Checks and cleans what is typed; `cur` is the saved queue when editing. */
    private async clean(orgId: string, body: any, cur?: any) {
        const data: Prisma.ticket_queuesUncheckedUpdateInput = {};
        if (body?.name !== undefined || !cur) data.name = cleanName(body?.name);
        if (body?.description !== undefined) data.description = String(body.description ?? "").trim().slice(0, 300) || null;
        if (body?.enabled !== undefined) data.enabled = body.enabled === true;
        const assignment = body?.assignment !== undefined ? String(body.assignment) : cur?.assignment ?? "none";
        if (!["none", "user", "round_robin"].includes(assignment)) throw new BadRequestException("Assignment must be none, user or round_robin.");
        data.assignment = assignment;

        const userIds = async (ids: string[], what: string) => {
            if (ids.some((x) => !isCanonicalUuid(x))) throw new BadRequestException(`${what} has something that is not a person.`);
            if (ids.length) {
                const n = await this.prisma.users.count({ where: { id: { in: ids }, organization_id: orgId } });
                if (n !== ids.length) throw new BadRequestException(`${what}: one of the people does not exist.`);
            }
        };
        const assignee = body?.defaultAssigneeUserId !== undefined ? (body.defaultAssigneeUserId ? String(body.defaultAssigneeUserId) : null) : cur?.default_assignee_user_id ?? null;
        if (assignee) await userIds([assignee], "The default assignee");
        data.default_assignee_user_id = assignee;
        let pool: string[] = cur?.pool_user_ids ?? [];
        if (body?.poolUserIds !== undefined) {
            if (!Array.isArray(body.poolUserIds)) throw new BadRequestException("The pool must be a list of people.");
            pool = [...new Set<string>(body.poolUserIds.map(String))];
            if (pool.length > 100) throw new BadRequestException("A pool can hold 100 people at most.");
            await userIds(pool, "The pool");
        }
        data.pool_user_ids = pool;
        const group = body?.poolGroupId !== undefined ? (body.poolGroupId ? String(body.poolGroupId) : null) : cur?.pool_group_id ?? null;
        if (group && (!isCanonicalUuid(group) || !(await this.prisma.user_groups.findFirst({ where: { id: group, organization_id: orgId }, select: { id: true } })))) throw new BadRequestException("That group does not exist.");
        data.pool_group_id = group;
        const policy = body?.defaultSlaPolicyId !== undefined ? (body.defaultSlaPolicyId ? String(body.defaultSlaPolicyId) : null) : cur?.default_sla_policy_id ?? null;
        if (policy && (!isCanonicalUuid(policy) || !(await this.prisma.sla_policies.findFirst({ where: { id: policy, organization_id: orgId }, select: { id: true } })))) throw new BadRequestException("That SLA policy does not exist.");
        data.default_sla_policy_id = policy;

        if (assignment === "user" && !assignee) throw new BadRequestException("Choose the person who gets this queue's tickets.");
        if (assignment === "round_robin" && !pool.length && !group) throw new BadRequestException("Taking turns needs people or a group to take turns between.");
        return data;
    }

    async create(orgId: string, body: any): Promise<QueueView> {
        const data = await this.clean(orgId, body);
        if ((await this.prisma.ticket_queues.count({ where: { organization_id: orgId } })) >= 100) throw new BadRequestException("That is as many queues as there can be (100).");
        try {
            const r = await this.prisma.ticket_queues.create({ data: { id: randomUUID(), organization_id: orgId, name: data.name as string, ...(data as any) } });
            return this.view(r);
        } catch (e: any) {
            if (e?.code === "P2002") throw new ConflictException("There is already a queue with that name.");
            throw e;
        }
    }

    async update(orgId: string, id: string, body: any): Promise<QueueView> {
        const cur = await this.find(orgId, id);
        const data = await this.clean(orgId, body, cur);
        try {
            const r = await this.prisma.ticket_queues.update({ where: { id }, data: { ...data, updated_at: new Date() } });
            return this.view(r);
        } catch (e: any) {
            if (e?.code === "P2002") throw new ConflictException("There is already a queue with that name.");
            throw e;
        }
    }

    async remove(orgId: string, id: string): Promise<{ ok: true }> {
        await this.find(orgId, id);
        const rules = await this.prisma.ticket_routing_rules.findMany({ where: { organization_id: orgId }, select: { name: true, actions: true } });
        const using = rules.filter((r) => (r.actions as any)?.queueId === id);
        if (using.length) throw new ConflictException(`${using.length === 1 ? "A routing rule sends" : `${using.length} routing rules send`} tickets to this queue (${using.slice(0, 3).map((r) => r.name).join(", ")}). Change or delete them first.`);
        const policies = await this.prisma.sla_policies.findMany({ where: { organization_id: orgId }, select: { name: true, escalation: true } });
        const esc = policies.filter((p) => (p.escalation as any)?.breach?.moveToQueueId === id);
        if (esc.length) throw new ConflictException(`The SLA policy "${esc[0].name}" moves late tickets to this queue. Change it first.`);
        // Its tickets stay, in no queue.
        await this.prisma.ticket_queues.delete({ where: { id } });
        return { ok: true };
    }

    /* ------------------------------ who gets a ticket ------------------------------ */

    /** The active people a queue hands tickets to: its list of people and the members of its group. */
    async poolOf(queue: { pool_user_ids: string[]; pool_group_id: string | null }, orgId: string): Promise<string[]> {
        const ids = new Set(queue.pool_user_ids);
        if (queue.pool_group_id) {
            for (const m of await this.prisma.user_group_members.findMany({ where: { group_id: queue.pool_group_id }, select: { user_id: true } })) ids.add(m.user_id);
        }
        if (!ids.size) return [];
        const active = await this.prisma.users.findMany({ where: { id: { in: [...ids] }, organization_id: orgId, status: "active" }, select: { id: true } });
        return active.map((u) => u.id);
    }

    /** Takes the next person in the queue's pool and remembers the turn, so two tickets at once do not go to the same person. */
    async takeTurn(orgId: string, queueId: string): Promise<string | null> {
        return this.prisma.$transaction(async (tx) => {
            const [q] = await tx.$queryRaw<{ pool_user_ids: string[]; pool_group_id: string | null; last: string | null }[]>`
                SELECT pool_user_ids::text[] AS pool_user_ids, pool_group_id::text AS pool_group_id, last_assigned_user_id::text AS last
                  FROM ticket_queues WHERE id = ${queueId}::uuid AND organization_id = ${orgId}::uuid FOR UPDATE`;
            if (!q) return null;
            const pool = await this.poolOf(q, orgId);
            const next = nextInPool(pool, q.last);
            if (next) await tx.$executeRaw`UPDATE ticket_queues SET last_assigned_user_id = ${next}::uuid WHERE id = ${queueId}::uuid`;
            return next;
        });
    }

    /** Who would be next, without taking the turn (for the rule preview). */
    async peekTurn(orgId: string, queueId: string): Promise<string | null> {
        const q = await this.prisma.ticket_queues.findFirst({ where: { id: queueId, organization_id: orgId } });
        if (!q) return null;
        return nextInPool(await this.poolOf(q, orgId), q.last_assigned_user_id);
    }
}
