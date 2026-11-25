// backend/src/workflows/workflows.core.ts
//
// Workflow rules, "when this happens, do that": the triggers, the facts each trigger offers, how conditions are judged, how the text of an action is
// filled in, and the validation of a rule. Pure: no database, nothing that runs, so every rule of the engine can be tested by itself.
export type Trigger = "alert.opened" | "device.registered" | "ticket.created" | "patch.failed" | "device.offline";
export type Op = "is" | "is_not" | "contains" | "not_contains" | "starts_with";
export type Condition = { field: string; op: Op; value: string };
export type Action =
    | { type: "create_ticket"; subject: string; description: string; priority: "low" | "medium" | "high" | "urgent" }
    | { type: "notify"; subject: string; message: string }
    | { type: "run_script"; scriptId: string }
    | { type: "set_priority"; priority: "low" | "medium" | "high" | "urgent" }
    | { type: "assign"; userId: string };
export type Facts = Record<string, string>;

export const MAX_CONDITIONS = 5;
export const MAX_ACTIONS = 4;
export const MAX_RUNS_PER_RULE_PER_HOUR = 30;
export const OPS: Op[] = ["is", "is_not", "contains", "not_contains", "starts_with"];
export const PRIORITIES = ["low", "medium", "high", "urgent"] as const;

export const TRIGGERS: Record<Trigger, { title: string; plain: string; fields: Record<string, string>; hasDevice: boolean }> = {
    "alert.opened": {
        title: "An alert is raised", plain: "A check fails and opens an alert (not again while the same alert stays open).", hasDevice: true,
        fields: { severity: "Severity (WARN or CRIT)", title: "Alert title", detail: "Alert detail", kind: "Kind of alert", device: "Computer name", client: "Customer", os: "Operating system" },
    },
    "device.registered": {
        title: "A new computer enrolls", plain: "An agent installs and enrolls for the first time.", hasDevice: true,
        fields: { device: "Computer name", client: "Customer", os: "Operating system" },
    },
    "patch.failed": {
        title: "A Windows update scan or install fails", plain: "A computer reports that an update scan or install did not work.", hasDevice: true,
        fields: { kind: "What failed (patch_scan or patch_install)", reason: "The reason the computer gave", device: "Computer name", client: "Customer", os: "Operating system" },
    },
    "device.offline": {
        title: "A computer goes offline", plain: "A computer stops reaching the server and an offline alert opens.", hasDevice: true,
        fields: { device: "Computer name", client: "Customer", os: "Operating system", severity: "Severity of the offline alert" },
    },
    "ticket.created": {
        title: "A ticket is created", plain: "Any ticket made by a person, the tray app, email or an alert. Tickets made by workflows do not start workflows.", hasDevice: false,
        fields: { subject: "Ticket subject", priority: "Priority", source: "Where it came from (ui, api, email, tray, alert)", client: "Customer", device: "Computer name" },
    },
};

export const ACTIONS: Record<Action["type"], { title: string; needsDevice: boolean; needsTicket: boolean }> = {
    create_ticket: { title: "Create a ticket", needsDevice: false, needsTicket: false },
    notify: { title: "Send a notice (email / Slack / webhook as set for backups)", needsDevice: false, needsTicket: false },
    run_script: { title: "Run a script from the script library on the computer", needsDevice: true, needsTicket: false },
    set_priority: { title: "Set the priority of the ticket", needsDevice: false, needsTicket: true },
    assign: { title: "Assign the ticket to a technician", needsDevice: false, needsTicket: true },
};

export const fieldsOf = (t: Trigger) => Object.keys(TRIGGERS[t].fields);

/** Does one condition hold for these facts? Text is compared without regard to case. */
export function holds(c: Condition, facts: Facts): boolean {
    const have = String(facts[c.field] ?? "").trim().toLowerCase();
    const want = String(c.value ?? "").trim().toLowerCase();
    switch (c.op) {
        case "is": return have === want;
        case "is_not": return have !== want;
        case "contains": return want !== "" && have.includes(want);
        case "not_contains": return !have.includes(want);
        case "starts_with": return want !== "" && have.startsWith(want);
        default: return false;
    }
}
export const allHold = (cs: Condition[], facts: Facts) => cs.every((c) => holds(c, facts));

/** "Disk full on {{device}}" with the facts filled in; a fact that is not there becomes empty, and nothing else is ever evaluated. */
export function fill(template: string, facts: Facts, max = 4000): string {
    return String(template ?? "").replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_m, k: string) => String(facts[k.toLowerCase()] ?? "")).slice(0, max);
}

export type RuleInput = { name: string; trigger: string; conditions: unknown; actions: unknown; cooldownMinutes?: unknown; enabled?: unknown };
export type CleanRule = { name: string; trigger: Trigger; conditions: Condition[]; actions: Action[]; cooldownMinutes: number; enabled: boolean };

const str = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);

/** The cleaned rule, or the list of what is wrong with it (in plain words). */
export function validateRule(input: RuleInput): { rule?: CleanRule; errors: string[] } {
    const errors: string[] = [];
    const name = str(input?.name, 120);
    if (!name) errors.push("Give the rule a name.");
    const trigger = str(input?.trigger, 40) as Trigger;
    if (!TRIGGERS[trigger]) errors.push("Choose what starts the rule.");

    const conditions: Condition[] = [];
    const rawConds = Array.isArray(input?.conditions) ? (input.conditions as any[]) : [];
    if (rawConds.length > MAX_CONDITIONS) errors.push(`At most ${MAX_CONDITIONS} conditions.`);
    for (const c of rawConds.slice(0, MAX_CONDITIONS)) {
        const field = str(c?.field, 40), op = str(c?.op, 20) as Op, value = str(c?.value, 300);
        if (TRIGGERS[trigger] && !fieldsOf(trigger).includes(field)) { errors.push(`"${field || "?"}" is not something a "${TRIGGERS[trigger].title}" rule can check.`); continue; }
        if (!OPS.includes(op)) { errors.push("A condition has an unknown comparison."); continue; }
        if (!value && (op === "contains" || op === "starts_with")) { errors.push("A condition needs a value to look for."); continue; }
        conditions.push({ field, op, value });
    }

    const actions: Action[] = [];
    const rawActions = Array.isArray(input?.actions) ? (input.actions as any[]) : [];
    if (!rawActions.length) errors.push("Add at least one action.");
    if (rawActions.length > MAX_ACTIONS) errors.push(`At most ${MAX_ACTIONS} actions.`);
    let haveTicket = trigger === "ticket.created";
    for (const a of rawActions.slice(0, MAX_ACTIONS)) {
        const type = str(a?.type, 30) as Action["type"];
        if (!ACTIONS[type]) { errors.push("An action has an unknown type."); continue; }
        if (ACTIONS[type].needsTicket && !haveTicket) { errors.push(`"${ACTIONS[type].title}" needs a ticket: put "Create a ticket" before it, or start the rule from a ticket.`); continue; }
        if (TRIGGERS[trigger] && ACTIONS[type].needsDevice && !TRIGGERS[trigger].hasDevice) { errors.push(`"${ACTIONS[type].title}" needs a computer, and a "${TRIGGERS[trigger].title}" rule has none.`); continue; }
        if (type === "create_ticket") {
            const subject = str(a?.subject, 300), priority = str(a?.priority || "medium", 10) as (typeof PRIORITIES)[number];
            if (!subject) { errors.push("The ticket needs a subject."); continue; }
            if (!PRIORITIES.includes(priority)) { errors.push("The ticket priority must be low, medium, high or urgent."); continue; }
            actions.push({ type, subject, description: str(a?.description, 4000), priority });
            haveTicket = true;
        } else if (type === "set_priority") {
            const priority = str(a?.priority, 10) as (typeof PRIORITIES)[number];
            if (!PRIORITIES.includes(priority)) { errors.push("The priority must be low, medium, high or urgent."); continue; }
            actions.push({ type, priority });
        } else if (type === "assign") {
            const userId = str(a?.userId, 60);
            if (!/^[0-9a-f-]{36}$/i.test(userId)) { errors.push("Choose the technician to assign the ticket to."); continue; }
            actions.push({ type, userId });
        } else if (type === "notify") {
            const subject = str(a?.subject, 200), message = str(a?.message, 2000);
            if (!subject) { errors.push("The notice needs a subject."); continue; }
            actions.push({ type, subject, message });
        } else {
            const scriptId = str(a?.scriptId, 60);
            if (!/^[0-9a-f-]{36}$/i.test(scriptId)) { errors.push("Choose a script to run."); continue; }
            actions.push({ type, scriptId });
        }
    }

    let cooldown = Number(input?.cooldownMinutes ?? 60);
    if (!Number.isFinite(cooldown)) cooldown = 60;
    cooldown = Math.min(10080, Math.max(1, Math.round(cooldown)));
    if (errors.length) return { errors };
    return { errors, rule: { name, trigger, conditions, actions, cooldownMinutes: cooldown, enabled: input?.enabled === true } };
}

export const subjectKey = (trigger: Trigger, ids: { deviceId?: string | null; ticketId?: string | null; alertId?: string | null }) =>
    (trigger === "ticket.created" ? ids.ticketId : trigger === "alert.opened" ? (ids.deviceId ?? ids.alertId) : ids.deviceId) ?? "none";

/** Ready-made rules to start from. They are never switched on for you: the editor opens with one filled in, and you save it if you want it. */
export const TEMPLATES: Array<{ id: string; title: string; plain: string; rule: Omit<RuleInput, "enabled"> }> = [
    {
        id: "onboarding", title: "New computer: open an onboarding ticket", plain: "Every computer that enrolls gets a ticket to check it is set up properly.",
        rule: { name: "New computer onboarding", trigger: "device.registered", conditions: [], cooldownMinutes: 1440,
            actions: [{ type: "create_ticket", subject: "Onboard new computer {{device}} ({{client}})", description: "{{device}} ({{os}}) enrolled for {{client}}. Check that it is in the right customer and site, that monitoring and patching policies apply, and that the user can reach support.", priority: "low" }] },
    },
    {
        id: "offline-high", title: "Computer offline: ticket at high priority", plain: "When a computer goes offline, open a ticket and raise it to high.",
        rule: { name: "Offline computers get a high priority ticket", trigger: "device.offline", conditions: [], cooldownMinutes: 240,
            actions: [{ type: "create_ticket", subject: "{{device}} is offline ({{client}})", description: "The computer stopped reaching the server.", priority: "medium" }, { type: "set_priority", priority: "high" }] },
    },
    {
        id: "patch-failed", title: "Update failed: open a ticket", plain: "When a Windows update scan or install fails, open a ticket with the reason.",
        rule: { name: "Failed updates open a ticket", trigger: "patch.failed", conditions: [], cooldownMinutes: 1440,
            actions: [{ type: "create_ticket", subject: "Updates failed on {{device}}", description: "{{kind}} failed on {{device}} ({{client}}). Reason: {{reason}}", priority: "medium" }] },
    },
    {
        id: "critical-alert", title: "Critical alert: notice and urgent ticket", plain: "Critical alerts send a notice and open an urgent ticket.",
        rule: { name: "Critical alerts open an urgent ticket", trigger: "alert.opened", conditions: [{ field: "severity", op: "is", value: "CRIT" }], cooldownMinutes: 60,
            actions: [{ type: "notify", subject: "Critical alert on {{device}}", message: "{{title}} ({{client}})" }, { type: "create_ticket", subject: "{{title}}", description: "{{detail}}", priority: "urgent" }] },
    },
];
