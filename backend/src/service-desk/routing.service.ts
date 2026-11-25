import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { isCanonicalUuid } from "../common/agent-lookup.util";
import { PrismaService } from "../storage/prisma.service";
import { QueuesService } from "./queues.service";
import { SOURCES, cleanActions, cleanConditions, evaluate, type Actions, type Condition, type Decision, type Facts, type Rule } from "./routing-rules";

export type RuleView = Rule & { queueName: string | null; assigneeName: string | null };

const MAX_RULES = 100;
const priorityFromDb = (p: string) => (p === "normal" ? "medium" : p);
const priorityToDb = (p: string) => (p === "medium" ? "normal" : p);
const fullName = (u: { first_name: string | null; last_name: string | null; email: unknown }) => [u.first_name, u.last_name].filter(Boolean).join(" ") || String(u.email);

const cleanName = (v: unknown) => {
    const s = String(v ?? "").replace(/\s+/g, " ").trim();
    if (!s) throw new BadRequestException("Give the rule a name.");
    if (s.length > 80) throw new BadRequestException("The rule name is too long (80 characters at most).");
    return s;
};

export type RouteContext = {
    /** Where the ticket came from: ui, email, portal, alert, api. */
    source: string;
    /** The person filling in the form chose a priority / an assignee, so rules and queues leave them alone. */
    priorityGiven?: boolean;
    assigneeGiven?: boolean;
    /** The person who made it, who needs no notice that it was assigned to them. */
    actorUserId?: string | null;
};

@Injectable()
export class RoutingService {
    private readonly log = new Logger(RoutingService.name);

    constructor(private readonly prisma: PrismaService, private readonly queues: QueuesService) { }

    private toRule(r: any): Rule {
        return {
            id: r.id,
            name: r.name,
            enabled: r.enabled,
            position: r.position,
            match: r.match === "any" ? "any" : "all",
            conditions: Array.isArray(r.conditions) ? (r.conditions as Condition[]) : [],
            actions: { queueId: r.actions?.queueId ?? null, assignee: r.actions?.assignee ?? "queue", priority: r.actions?.priority ?? null } as Actions,
            stopOnMatch: r.stop_on_match,
        };
    }

    async list(orgId: string): Promise<RuleView[]> {
        const rows = await this.prisma.ticket_routing_rules.findMany({ where: { organization_id: orgId }, orderBy: [{ position: "asc" }, { created_at: "asc" }] });
        const rules = rows.map((r) => this.toRule(r));
        const queueIds = [...new Set(rules.map((r) => r.actions.queueId).filter((x): x is string => !!x))];
        const userIds = [...new Set(rules.map((r) => r.actions.assignee).filter((x) => isCanonicalUuid(x)))];
        const [queues, users] = await Promise.all([
            queueIds.length ? this.prisma.ticket_queues.findMany({ where: { id: { in: queueIds } }, select: { id: true, name: true } }) : [],
            userIds.length ? this.prisma.users.findMany({ where: { id: { in: userIds } }, select: { id: true, first_name: true, last_name: true, email: true } }) : [],
        ]);
        return rules.map((r) => ({
            ...r,
            queueName: queues.find((q) => q.id === r.actions.queueId)?.name ?? null,
            assigneeName: (() => { const u = users.find((x) => x.id === r.actions.assignee); return u ? fullName(u) : null; })(),
        }));
    }

    private async find(orgId: string, id: string) {
        const r = isCanonicalUuid(id) ? await this.prisma.ticket_routing_rules.findFirst({ where: { id, organization_id: orgId } }) : null;
        if (!r) throw new NotFoundException("Rule not found");
        return r;
    }

    private async checkActions(orgId: string, a: Actions) {
        if (a.queueId && !(await this.prisma.ticket_queues.findFirst({ where: { id: a.queueId, organization_id: orgId }, select: { id: true } }))) throw new BadRequestException("That queue does not exist.");
        if (isCanonicalUuid(a.assignee) && !(await this.prisma.users.findFirst({ where: { id: a.assignee, organization_id: orgId }, select: { id: true } }))) throw new BadRequestException("That person does not exist.");
    }

    private async checkConditions(orgId: string, conditions: Condition[]) {
        for (const c of conditions) {
            if (c.field === "customer") {
                const n = await this.prisma.clients.count({ where: { id: { in: c.values }, organization_id: orgId } });
                if (n !== c.values.length) throw new BadRequestException("One of the customers chosen does not exist.");
            }
            if (c.field === "site") {
                const n = await this.prisma.sites.count({ where: { id: { in: c.values }, clients: { organization_id: orgId } } });
                if (n !== c.values.length) throw new BadRequestException("One of the sites chosen does not exist.");
            }
        }
    }

    async create(orgId: string, body: any): Promise<RuleView> {
        const name = cleanName(body?.name);
        const conditions = cleanConditions(body?.conditions ?? []);
        if (!conditions.length) throw new BadRequestException("Add at least one condition.");
        const actions = cleanActions(body?.actions);
        await this.checkConditions(orgId, conditions);
        await this.checkActions(orgId, actions);
        const count = await this.prisma.ticket_routing_rules.count({ where: { organization_id: orgId } });
        if (count >= MAX_RULES) throw new BadRequestException(`That is as many rules as there can be (${MAX_RULES}).`);
        const last = await this.prisma.ticket_routing_rules.aggregate({ where: { organization_id: orgId }, _max: { position: true } });
        const id = randomUUID();
        await this.prisma.ticket_routing_rules.create({
            data: {
                id, organization_id: orgId, name, enabled: body?.enabled !== false, position: (last._max.position ?? 0) + 1,
                match: body?.match === "any" ? "any" : "all", conditions: conditions as unknown as Prisma.InputJsonValue, actions: actions as unknown as Prisma.InputJsonValue, stop_on_match: body?.stopOnMatch !== false,
            },
        });
        return (await this.list(orgId)).find((r) => r.id === id)!;
    }

    async update(orgId: string, id: string, body: any): Promise<RuleView> {
        const cur = await this.find(orgId, id);
        const data: Prisma.ticket_routing_rulesUncheckedUpdateInput = { updated_at: new Date() };
        if (body?.name !== undefined) data.name = cleanName(body.name);
        if (body?.enabled !== undefined) data.enabled = body.enabled === true;
        if (body?.match !== undefined) {
            if (!["all", "any"].includes(String(body.match))) throw new BadRequestException("Match must be all or any.");
            data.match = String(body.match);
        }
        if (body?.stopOnMatch !== undefined) data.stop_on_match = body.stopOnMatch === true;
        if (body?.conditions !== undefined) {
            const conditions = cleanConditions(body.conditions);
            if (!conditions.length) throw new BadRequestException("Add at least one condition.");
            await this.checkConditions(orgId, conditions);
            data.conditions = conditions as unknown as Prisma.InputJsonValue;
        }
        if (body?.actions !== undefined) {
            const actions = cleanActions(body.actions);
            await this.checkActions(orgId, actions);
            data.actions = actions as unknown as Prisma.InputJsonValue;
        }
        void cur;
        await this.prisma.ticket_routing_rules.update({ where: { id }, data });
        return (await this.list(orgId)).find((r) => r.id === id)!;
    }

    async remove(orgId: string, id: string): Promise<{ ok: true }> {
        await this.find(orgId, id);
        await this.prisma.ticket_routing_rules.delete({ where: { id } });
        return { ok: true };
    }

    /** The order of the rules is the order of the ids given; rules not named keep their place after them. */
    async reorder(orgId: string, ids: unknown): Promise<RuleView[]> {
        if (!Array.isArray(ids) || ids.some((i) => !isCanonicalUuid(String(i)))) throw new BadRequestException("Send the rule ids in the order you want.");
        const rows = await this.prisma.ticket_routing_rules.findMany({ where: { organization_id: orgId }, orderBy: [{ position: "asc" }, { created_at: "asc" }], select: { id: true } });
        const known = new Set(rows.map((r) => r.id));
        const wanted = [...new Set(ids.map(String))];
        if (wanted.some((i) => !known.has(i))) throw new BadRequestException("One of those rules does not exist.");
        const order = [...wanted, ...rows.map((r) => r.id).filter((i) => !wanted.includes(i))];
        await this.prisma.$transaction(order.map((rid, i) => this.prisma.ticket_routing_rules.update({ where: { id: rid }, data: { position: i + 1 } })));
        return this.list(orgId);
    }

    /* ------------------------------ deciding ------------------------------ */

    private async loadRules(orgId: string): Promise<Rule[]> {
        return (await this.prisma.ticket_routing_rules.findMany({ where: { organization_id: orgId, enabled: true }, orderBy: [{ position: "asc" }, { created_at: "asc" }] })).map((r) => this.toRule(r));
    }

    /** What the rules know about a ticket that exists. */
    private async factsOf(ticketId: string, source: string): Promise<Facts | null> {
        const t = await this.prisma.tickets.findUnique({
            where: { id: ticketId },
            select: { subject: true, description: true, priority: true, client_id: true, device_id: true, portal_account_id: true, contacts: { select: { email: true } } },
        });
        if (!t) return null;
        let siteId: string | null = null;
        let tags: string[] = [];
        if (t.device_id) {
            const d = await this.prisma.devices.findUnique({ where: { id: t.device_id }, select: { site_id: true, device_tags: { select: { tag_defs: { select: { name: true } } } } } });
            siteId = d?.site_id ?? null;
            tags = (d?.device_tags ?? []).map((x) => x.tag_defs.name);
        }
        let sender: string | null = t.contacts?.email ? String(t.contacts.email) : null;
        if (t.portal_account_id) {
            const a = await this.prisma.portal_accounts.findUnique({ where: { id: t.portal_account_id }, select: { email: true } });
            if (a?.email) sender = String(a.email);
        }
        return { clientId: t.client_id, siteId, source, priority: priorityFromDb(t.priority), subject: t.subject, body: t.description ?? "", senderEmail: sender, deviceTags: tags };
    }

    /** Applies the rules to a new ticket: its queue, its assignee and its priority. Never throws: the ticket exists either way. */
    async route(ticketId: string, ctx: RouteContext): Promise<{ queueId: string | null; assigneeUserId: string | null; matched: string[] } | null> {
        try {
            const t = await this.prisma.tickets.findUnique({ where: { id: ticketId }, select: { organization_id: true, queue_id: true, assignee_user_id: true, priority: true, created_via: true } });
            if (!t) return null;
            const orgId = t.organization_id;
            if (!t.created_via) await this.prisma.tickets.updateMany({ where: { id: ticketId, created_via: null }, data: { created_via: ctx.source } });

            const rules = await this.loadRules(orgId);
            const facts = rules.length ? await this.factsOf(ticketId, ctx.source) : null;
            const decision: Decision = rules.length && facts ? evaluate(rules, facts) : { queueId: null, assignee: "queue", priority: null, matched: [] };

            const data: Prisma.ticketsUncheckedUpdateManyInput = {};
            const history: { field: string; from: string; to: string }[] = [];

            // The queue a rule chose, else the one the ticket was given by hand.
            let queue = null as Awaited<ReturnType<typeof this.prisma.ticket_queues.findFirst>>;
            if (decision.queueId && !t.queue_id) {
                queue = await this.prisma.ticket_queues.findFirst({ where: { id: decision.queueId, organization_id: orgId, enabled: true } });
                if (queue) { data.queue_id = queue.id; history.push({ field: "queue", from: "", to: queue.name }); }
            }
            if (!queue && t.queue_id) queue = await this.prisma.ticket_queues.findFirst({ where: { id: t.queue_id, organization_id: orgId } });
            if (!decision.matched.length && !queue) return { queueId: t.queue_id, assigneeUserId: t.assignee_user_id, matched: [] };

            let assignee: string | null = null;
            if (!ctx.assigneeGiven && !t.assignee_user_id) assignee = await this.pickAssignee(orgId, decision, queue);
            if (assignee) {
                data.assignee_user_id = assignee;
                const u = await this.prisma.users.findUnique({ where: { id: assignee }, select: { first_name: true, last_name: true, email: true } });
                history.push({ field: "assignee", from: "", to: u ? fullName(u) : assignee });
            }

            if (decision.priority && !ctx.priorityGiven && priorityFromDb(t.priority) !== decision.priority) {
                data.priority = priorityToDb(decision.priority) as any;
                history.push({ field: "priority", from: priorityFromDb(t.priority), to: decision.priority });
            }

            if (Object.keys(data).length) {
                data.updated_at = new Date();
                await this.prisma.tickets.updateMany({ where: { id: ticketId }, data });
                const base = Date.now();
                const names = decision.matched.length ? decision.matched.map((m) => m.name).join(", ") : "queue";
                await this.prisma.ticket_activity.createMany({
                    data: history.map((h, i) => ({
                        id: randomUUID(), ticket_id: ticketId, kind: "change", body: `${h.field}: ${h.from || "-"} -> ${h.to || "-"}`, attachments: [], time_worked_seconds: 0, notify_customer: false,
                        author: `Routing (${names})`.slice(0, 200), is_internal: true, field: h.field, from_value: h.from || null, to_value: h.to || null, created_at: new Date(base + i),
                    })),
                });
                if (assignee && assignee !== ctx.actorUserId) {
                    await this.prisma.ticket_notices.create({ data: { id: randomUUID(), organization_id: orgId, user_id: assignee, ticket_id: ticketId, kind: "assigned", title: "A ticket was assigned to you", body: facts?.subject ?? "" } }).catch(() => undefined);
                }
            }
            return { queueId: (data.queue_id as string) ?? t.queue_id, assigneeUserId: assignee ?? t.assignee_user_id, matched: decision.matched.map((m) => m.id) };
        } catch (e) {
            this.log.warn(`Routing ticket ${ticketId} failed: ${(e as Error).message}`);
            return null;
        }
    }

    /** Fills in an assignee from what the rules and queue say. Null leaves the ticket unassigned. */
    async pickAssignee(orgId: string, d: Pick<Decision, "assignee">, queue: { id: string; assignment: string; default_assignee_user_id: string | null } | null): Promise<string | null> {
        if (d.assignee === "none") return null;
        if (isCanonicalUuid(d.assignee)) {
            const u = await this.prisma.users.findFirst({ where: { id: d.assignee, organization_id: orgId, status: "active" }, select: { id: true } });
            return u?.id ?? null;
        }
        if (!queue) return null;
        if (d.assignee === "round_robin" || (d.assignee === "queue" && queue.assignment === "round_robin")) return this.queues.takeTurn(orgId, queue.id);
        if (d.assignee === "queue" && queue.assignment === "user") return queue.default_assignee_user_id;
        return null;
    }

    /** A queue picked by hand: who it hands tickets to, when the person did not say. */
    async assigneeForQueue(orgId: string, queueId: string): Promise<string | null> {
        const q = await this.prisma.ticket_queues.findFirst({ where: { id: queueId, organization_id: orgId } });
        return q ? this.pickAssignee(orgId, { assignee: "queue" }, q) : null;
    }

    /* ------------------------------ try a rule set on a made-up ticket ------------------------------ */

    async preview(orgId: string, body: any) {
        const source = String(body?.source ?? "email");
        if (!(SOURCES as readonly string[]).includes(source)) throw new BadRequestException(`Source must be one of ${SOURCES.join(", ")}.`);
        const priority = String(body?.priority ?? "medium");
        if (!["low", "medium", "high", "urgent"].includes(priority)) throw new BadRequestException("Priority must be low, medium, high or urgent.");
        const id = (v: unknown, what: string) => {
            if (!v) return null;
            if (!isCanonicalUuid(String(v))) throw new BadRequestException(`Choose ${what} from the list.`);
            return String(v);
        };
        const facts: Facts = {
            clientId: id(body?.customerId, "a customer"),
            siteId: id(body?.siteId, "a site"),
            source,
            priority,
            subject: String(body?.subject ?? "").slice(0, 300),
            body: String(body?.body ?? "").slice(0, 10_000),
            senderEmail: body?.senderEmail ? String(body.senderEmail).slice(0, 200) : null,
            deviceTags: (Array.isArray(body?.deviceTags) ? body.deviceTags : String(body?.deviceTags ?? "").split(",")).map((x: unknown) => String(x).trim()).filter(Boolean).slice(0, 30),
        };
        const rules = await this.loadRules(orgId);
        const d = evaluate(rules, facts);
        const queue = d.queueId ? await this.prisma.ticket_queues.findFirst({ where: { id: d.queueId, organization_id: orgId } }) : null;
        let assigneeId: string | null = null;
        let how = "nobody: it stays unassigned";
        if (d.matched.length) {
            if (isCanonicalUuid(d.assignee)) { assigneeId = d.assignee; how = "the person named in the rule"; }
            else if (queue && (d.assignee === "round_robin" || (d.assignee === "queue" && queue.assignment === "round_robin"))) { assigneeId = await this.queues.peekTurn(orgId, queue.id); how = "the next person in the queue's turn order"; }
            else if (queue && d.assignee === "queue" && queue.assignment === "user") { assigneeId = queue.default_assignee_user_id; how = "the queue's default person"; }
        }
        const assignee = assigneeId ? await this.prisma.users.findUnique({ where: { id: assigneeId }, select: { id: true, first_name: true, last_name: true, email: true } }) : null;
        return {
            matched: d.matched,
            queue: queue ? { id: queue.id, name: queue.name, enabled: queue.enabled } : null,
            assignee: assignee ? { id: assignee.id, name: fullName(assignee), how } : null,
            assigneeNote: assignee ? null : d.matched.length ? how : "no rule matched, so the ticket would be left as it is",
            priority: d.priority,
            noRuleMatched: d.matched.length === 0,
        };
    }
}
