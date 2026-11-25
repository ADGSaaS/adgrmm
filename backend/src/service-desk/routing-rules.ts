// Routing rules, as pure functions: what a rule may test, how a ticket is matched against a list of rules in order, and
// what the rules decide. No database here, so it can be tested alone.
import { BadRequestException } from "@nestjs/common";

export const SOURCES = ["ui", "email", "portal", "alert", "api"] as const;
export type Source = (typeof SOURCES)[number];
export const RULE_PRIORITIES = ["low", "medium", "high", "urgent"] as const;

export const CONDITION_FIELDS = [
    { key: "customer", label: "Customer is", kind: "ids" },
    { key: "site", label: "Site is", kind: "ids" },
    { key: "source", label: "Comes from", kind: "list" },
    { key: "priority", label: "Priority is", kind: "list" },
    { key: "subject_contains", label: "Subject contains", kind: "text" },
    { key: "body_contains", label: "Description contains", kind: "text" },
    { key: "sender_domain", label: "Sender's email domain is", kind: "text" },
    { key: "device_tag", label: "Device has the tag", kind: "text" },
] as const;
export type ConditionField = (typeof CONDITION_FIELDS)[number]["key"];

export type Condition = { field: ConditionField; values: string[] };
export type Actions = {
    queueId: string | null;
    /** queue: whatever the queue does; none: leave unassigned; round_robin: take turns in the queue's pool; or a user id. */
    assignee: "queue" | "none" | "round_robin" | string;
    priority: (typeof RULE_PRIORITIES)[number] | null;
};
export type Rule = { id: string; name: string; enabled: boolean; position: number; match: "all" | "any"; conditions: Condition[]; actions: Actions; stopOnMatch: boolean };

/** What the rules know about a ticket when it is made. */
export type Facts = {
    clientId: string | null;
    siteId: string | null;
    source: string;
    priority: string;
    subject: string;
    body: string;
    senderEmail: string | null;
    deviceTags: string[];
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const lower = (s: unknown) => String(s ?? "").toLowerCase();

export function domainOf(email: string | null | undefined): string {
    const at = String(email ?? "").trim().toLowerCase().lastIndexOf("@");
    return at < 0 ? "" : String(email).trim().toLowerCase().slice(at + 1);
}

function conditionMatches(c: Condition, f: Facts): boolean {
    const any = (test: (v: string) => boolean) => c.values.some(test);
    switch (c.field) {
        case "customer": return !!f.clientId && any((v) => v === f.clientId);
        case "site": return !!f.siteId && any((v) => v === f.siteId);
        case "source": return any((v) => v === f.source);
        case "priority": return any((v) => v === f.priority);
        case "subject_contains": return any((v) => lower(f.subject).includes(v.toLowerCase()));
        case "body_contains": return any((v) => lower(f.body).includes(v.toLowerCase()));
        case "sender_domain": {
            const d = domainOf(f.senderEmail);
            return !!d && any((v) => v.toLowerCase().replace(/^@/, "") === d);
        }
        case "device_tag": return any((v) => f.deviceTags.some((t) => t.toLowerCase() === v.toLowerCase()));
    }
}

export function ruleMatches(rule: Pick<Rule, "match" | "conditions">, f: Facts): boolean {
    if (!rule.conditions.length) return false;
    return rule.match === "any" ? rule.conditions.some((c) => conditionMatches(c, f)) : rule.conditions.every((c) => conditionMatches(c, f));
}

export type Decision = { queueId: string | null; assignee: Actions["assignee"]; priority: Actions["priority"]; matched: { id: string; name: string }[] };

/**
 * Goes through the enabled rules in order. The first rule that matches decides what it sets; a rule that does not stop
 * lets later rules set what is still undecided.
 */
export function evaluate(rules: Rule[], f: Facts): Decision {
    const out: Decision = { queueId: null, assignee: "queue", priority: null, matched: [] };
    let assigneeSet = false;
    for (const r of [...rules].filter((x) => x.enabled).sort((a, b) => a.position - b.position)) {
        if (!ruleMatches(r, f)) continue;
        out.matched.push({ id: r.id, name: r.name });
        if (out.queueId === null && r.actions.queueId) out.queueId = r.actions.queueId;
        if (!assigneeSet && r.actions.assignee !== "queue") { out.assignee = r.actions.assignee; assigneeSet = true; }
        if (out.priority === null && r.actions.priority) out.priority = r.actions.priority;
        if (r.stopOnMatch) break;
    }
    return out;
}

/* ------------------------------ what an administrator may save ------------------------------ */

function words(v: unknown, max = 50): string[] {
    const list = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,\n]/) : [];
    const out = [...new Set(list.map((x) => String(x ?? "").trim()).filter(Boolean))];
    if (out.length > max) throw new BadRequestException(`A condition can hold ${max} values at most.`);
    if (out.some((x) => x.length > 200)) throw new BadRequestException("A value in a condition is too long (200 characters at most).");
    return out;
}

export function cleanConditions(raw: unknown): Condition[] {
    if (!Array.isArray(raw)) throw new BadRequestException("Conditions must be a list.");
    if (raw.length > 12) throw new BadRequestException("A rule can have 12 conditions at most.");
    return raw.map((c: any) => {
        const def = CONDITION_FIELDS.find((f) => f.key === c?.field);
        if (!def) throw new BadRequestException(`"${String(c?.field ?? "")}" is not something a rule can test.`);
        const values = words(c?.values ?? c?.value);
        if (!values.length) throw new BadRequestException(`"${def.label}" needs a value.`);
        if (def.key === "customer" || def.key === "site") {
            if (values.some((v) => !UUID.test(v))) throw new BadRequestException(`"${def.label}" needs a customer or site from the list.`);
        }
        if (def.key === "source" && values.some((v) => !(SOURCES as readonly string[]).includes(v))) throw new BadRequestException(`Source must be one of ${SOURCES.join(", ")}.`);
        if (def.key === "priority" && values.some((v) => !(RULE_PRIORITIES as readonly string[]).includes(v))) throw new BadRequestException(`Priority must be one of ${RULE_PRIORITIES.join(", ")}.`);
        return { field: def.key, values: def.key === "sender_domain" ? values.map((v) => v.toLowerCase().replace(/^@/, "")) : values };
    });
}

export function cleanActions(raw: any): Actions {
    const queueId = raw?.queueId ? String(raw.queueId) : null;
    if (queueId && !UUID.test(queueId)) throw new BadRequestException("Choose a queue from the list.");
    const assignee = raw?.assignee === undefined || raw?.assignee === null || raw?.assignee === "" ? "queue" : String(raw.assignee);
    if (!["queue", "none", "round_robin"].includes(assignee) && !UUID.test(assignee)) throw new BadRequestException("Choose who the ticket goes to.");
    if (assignee === "round_robin" && !queueId) throw new BadRequestException("Taking turns needs a queue, whose pool of people takes the tickets.");
    const priority = raw?.priority ? String(raw.priority) : null;
    if (priority && !(RULE_PRIORITIES as readonly string[]).includes(priority)) throw new BadRequestException(`Priority must be one of ${RULE_PRIORITIES.join(", ")}.`);
    if (!queueId && assignee === "queue" && !priority) throw new BadRequestException("A rule has to do something: pick a queue, a person or a priority.");
    return { queueId, assignee, priority: priority as Actions["priority"] };
}

/** The next person in line: after `last` in a stable order, wrapping round. Null for an empty pool. */
export function nextInPool(pool: string[], last: string | null): string | null {
    const ids = [...new Set(pool)].sort();
    if (!ids.length) return null;
    if (!last) return ids[0];
    const after = ids.find((id) => id > last);
    return after ?? ids[0];
}
