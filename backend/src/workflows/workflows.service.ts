// backend/src/workflows/workflows.service.ts
//
// Workflow rules, "when this happens, do that". Places in the system fire an event (alert opened, computer enrolled, ticket created); the matching
// enabled rules whose conditions hold run their actions in order. Every run is logged with what each step did. Safety: a rule does not run twice
// for the same computer or ticket within its cool-down, no rule runs more than 30 times an hour, a ticket made by a workflow starts no workflow,
// and one failed step is recorded and does not stop the others.
import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaService } from "../storage/prisma.service";
import { OrganizationContextService } from "../storage/organization-context.service";
import { TicketsService } from "../tickets/tickets.service";
import { ScriptsService } from "../automation/scripts.service";
import { NotifierService } from "../backups/notifier.service";
import { workflowBus, WorkflowEvent } from "./workflows.bus";
import {
    ACTIONS, Action, TEMPLATES, Condition, Facts, MAX_RUNS_PER_RULE_PER_HOUR, RuleInput, TRIGGERS, Trigger, allHold, fill, subjectKey, validateRule,
} from "./workflows.core";

type RuleRow = { id: string; name: string; enabled: boolean; trigger: Trigger; conditions: Condition[]; actions: Action[]; cooldown_minutes: number; run_count: number; last_run_at: Date | null; created_at: Date; updated_at: Date };
type Step = { action: string; ok: boolean; text: string };
type Ctx = { ticketId: string | null };
type Subject = { facts: Facts; deviceId: string | null; label: string };

const shape = (r: RuleRow) => ({
    id: r.id, name: r.name, enabled: r.enabled, trigger: r.trigger, conditions: r.conditions, actions: r.actions, cooldownMinutes: r.cooldown_minutes,
    runCount: r.run_count, lastRunAt: r.last_run_at ? new Date(r.last_run_at).toISOString() : null, createdAt: new Date(r.created_at).toISOString(), updatedAt: new Date(r.updated_at).toISOString(),
});

@Injectable()
export class WorkflowsService implements OnModuleInit, OnModuleDestroy {
    private readonly log = new Logger("Workflows");
    private readonly listener = (e: WorkflowEvent) => { void this.onEvent(e).catch((err) => this.log.warn(`Workflow event failed: ${err?.message ?? err}`)); };

    constructor(
        private readonly prisma: PrismaService,
        private readonly orgs: OrganizationContextService,
        private readonly tickets: TicketsService,
        private readonly scripts: ScriptsService,
        private readonly notifier: NotifierService,
    ) { }

    onModuleInit() { workflowBus.on("event", this.listener); }
    onModuleDestroy() { workflowBus.off("event", this.listener); }

    /* ------------------------------ rules ------------------------------ */

    meta() {
        return {
            triggers: Object.entries(TRIGGERS).map(([id, t]) => ({ id, title: t.title, plain: t.plain, hasDevice: t.hasDevice, fields: Object.entries(t.fields).map(([key, label]) => ({ key, label })) })),
            actions: Object.entries(ACTIONS).map(([id, a]) => ({ id, title: a.title, needsDevice: a.needsDevice, needsTicket: a.needsTicket })),
            templates: TEMPLATES,
            ops: [{ id: "is", label: "is" }, { id: "is_not", label: "is not" }, { id: "contains", label: "contains" }, { id: "not_contains", label: "does not contain" }, { id: "starts_with", label: "starts with" }],
        };
    }

    async list(orgId: string) {
        const rows = await this.prisma.$queryRaw<RuleRow[]>`SELECT * FROM public.workflow_rules WHERE organization_id = ${orgId}::uuid ORDER BY created_at`;
        return { items: rows.map(shape) };
    }

    private async checked(input: RuleInput) {
        const { rule, errors } = validateRule(input);
        if (!rule) throw new BadRequestException(errors.join(" "));
        for (const a of rule.actions) {
            if (a.type === "run_script") {
                const s = await this.prisma.automations.findUnique({ where: { id: a.scriptId }, select: { id: true } });
                if (!s) throw new BadRequestException("The script to run does not exist.");
            }
            if (a.type === "assign") {
                const u = (await this.prisma.$queryRaw<Array<{ id: string }>>`SELECT id FROM public.users WHERE id = ${a.userId}::uuid`)[0];
                if (!u) throw new BadRequestException("The technician to assign the ticket to does not exist.");
            }
        }
        return rule;
    }

    async create(orgId: string, userId: string | null, input: RuleInput) {
        const r = await this.checked(input);
        const rows = await this.prisma.$queryRaw<RuleRow[]>`
            INSERT INTO public.workflow_rules (organization_id, name, enabled, trigger, conditions, actions, cooldown_minutes, created_by)
            VALUES (${orgId}::uuid, ${r.name}, ${r.enabled}, ${r.trigger}, ${JSON.stringify(r.conditions)}::jsonb, ${JSON.stringify(r.actions)}::jsonb, ${r.cooldownMinutes}, ${userId}::uuid)
            RETURNING *`;
        return shape(rows[0]);
    }

    async update(orgId: string, id: string, input: RuleInput) {
        const r = await this.checked(input);
        const rows = await this.prisma.$queryRaw<RuleRow[]>`
            UPDATE public.workflow_rules SET name = ${r.name}, enabled = ${r.enabled}, trigger = ${r.trigger}, conditions = ${JSON.stringify(r.conditions)}::jsonb,
              actions = ${JSON.stringify(r.actions)}::jsonb, cooldown_minutes = ${r.cooldownMinutes}, updated_at = now()
            WHERE id = ${id}::uuid AND organization_id = ${orgId}::uuid RETURNING *`;
        if (!rows[0]) throw new NotFoundException("Rule not found.");
        return shape(rows[0]);
    }

    async setEnabled(orgId: string, id: string, enabled: boolean) {
        const rows = await this.prisma.$queryRaw<RuleRow[]>`UPDATE public.workflow_rules SET enabled = ${enabled}, updated_at = now() WHERE id = ${id}::uuid AND organization_id = ${orgId}::uuid RETURNING *`;
        if (!rows[0]) throw new NotFoundException("Rule not found.");
        return shape(rows[0]);
    }

    async remove(orgId: string, id: string) {
        const n = await this.prisma.$executeRaw`DELETE FROM public.workflow_rules WHERE id = ${id}::uuid AND organization_id = ${orgId}::uuid`;
        if (!n) throw new NotFoundException("Rule not found.");
        return { ok: true };
    }

    async runs(orgId: string, ruleId?: string) {
        const rid = ruleId ?? null;
        const rows = await this.prisma.$queryRaw<Array<any>>`
            SELECT r.id, r.rule_id, w.name, r.trigger, r.subject, r.outcome, r.detail, r.steps, r.at
            FROM public.workflow_runs r JOIN public.workflow_rules w ON w.id = r.rule_id
            WHERE w.organization_id = ${orgId}::uuid AND (${rid}::uuid IS NULL OR r.rule_id = ${rid}::uuid)
            ORDER BY r.at DESC LIMIT 100`;
        return { items: rows.map((r) => ({ id: r.id, ruleId: r.rule_id, rule: r.name, trigger: r.trigger, subject: r.subject, outcome: r.outcome, detail: r.detail, steps: r.steps, at: new Date(r.at).toISOString() })) };
    }

    /* ------------------------------ events ------------------------------ */

    /** What the rules can look at for this event. */
    async facts(e: WorkflowEvent): Promise<Subject | null> {
        if (e.trigger === "ticket.created") {
            if (!e.ticketId) return null;
            const t = (await this.prisma.$queryRaw<Array<any>>`
                SELECT t.subject, t.priority::text AS priority, t.device_id, c.name AS client, d.hostname, d.alias
                FROM public.tickets t LEFT JOIN public.clients c ON c.id = t.client_id LEFT JOIN public.devices d ON d.id = t.device_id WHERE t.id = ${e.ticketId}::uuid`)[0];
            if (!t) return null;
            return { facts: { subject: t.subject ?? "", priority: t.priority ?? "", source: e.source ?? "", client: t.client ?? "", device: t.alias || t.hostname || "" }, deviceId: t.device_id ?? null, label: `ticket ${e.ticketId}` };
        }
        const deviceId = e.deviceId ?? (e.alertId ? (await this.prisma.alerts.findUnique({ where: { id: e.alertId }, select: { device_id: true } }))?.device_id ?? null : null);
        if (!deviceId) return null;
        const d = (await this.prisma.$queryRaw<Array<any>>`
            SELECT d.hostname, d.alias, d.operating_system AS os, c.name AS client FROM public.devices d
            LEFT JOIN public.sites s ON s.id = d.site_id LEFT JOIN public.clients c ON c.id = s.client_id WHERE d.id = ${deviceId}::uuid`)[0];
        if (!d) return null;
        const facts: Facts = { device: d.alias || d.hostname || "", client: d.client ?? "", os: d.os ?? "" };
        if (e.trigger === "patch.failed") Object.assign(facts, { kind: e.source ?? "", reason: String(e.reason ?? "").slice(0, 500) });
        if (e.trigger === "device.offline") {
            const a = e.alertId ? await this.prisma.alerts.findUnique({ where: { id: e.alertId }, select: { severity: true } }) : null;
            Object.assign(facts, { severity: a?.severity ?? "" });
        }
        if (e.trigger === "alert.opened") {
            const a = e.alertId ? await this.prisma.alerts.findUnique({ where: { id: e.alertId }, select: { severity: true, title: true, detail: true, kind: true } }) : null;
            if (!a) return null;
            Object.assign(facts, { severity: a.severity, title: a.title, detail: a.detail ?? "", kind: a.kind });
        }
        return { facts, deviceId, label: facts.device || deviceId };
    }

    async onEvent(e: WorkflowEvent): Promise<void> {
        // A ticket a workflow made starts no workflow, so rules cannot feed each other.
        if (e.trigger === "ticket.created" && e.source === "workflow") return;
        const orgId = await this.orgs.getDefaultOrganizationId();
        const rules = await this.prisma.$queryRaw<RuleRow[]>`SELECT * FROM public.workflow_rules WHERE organization_id = ${orgId}::uuid AND enabled AND trigger = ${e.trigger} ORDER BY created_at`;
        if (!rules.length) return;
        const f = await this.facts(e);
        if (!f) return;
        for (const rule of rules) {
            try { await this.runRule(rule, e, f, orgId); } catch (err: any) { this.log.warn(`Rule "${rule.name}" failed: ${err?.message ?? err}`); }
        }
    }

    async runRule(rule: RuleRow, e: WorkflowEvent, f: Subject, orgId: string): Promise<{ outcome: string; steps: Step[] }> {
        if (!allHold(rule.conditions ?? [], f.facts)) return { outcome: "no match", steps: [] };
        const key = subjectKey(e.trigger, { deviceId: f.deviceId, ticketId: e.ticketId, alertId: e.alertId });

        const recent = await this.prisma.$queryRaw<Array<{ same: bigint; hour: bigint }>>`
            SELECT count(*) FILTER (WHERE subject = ${key} AND outcome <> 'skipped' AND at > now() - make_interval(mins => ${rule.cooldown_minutes}::int))::bigint AS same,
                   count(*) FILTER (WHERE outcome <> 'skipped' AND at > now() - interval '1 hour')::bigint AS hour
            FROM public.workflow_runs WHERE rule_id = ${rule.id}::uuid`;
        if (Number(recent[0]?.same ?? 0) > 0) return { outcome: "cooldown", steps: [] };
        if (Number(recent[0]?.hour ?? 0) >= MAX_RUNS_PER_RULE_PER_HOUR) {
            // Said once, when the limit is first reached; after that the rule stays quiet until the hour has passed.
            const said = await this.prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*)::bigint AS n FROM public.workflow_runs WHERE rule_id = ${rule.id}::uuid AND outcome = 'skipped' AND at > now() - interval '1 hour'`;
            if (Number(said[0]?.n ?? 0) === 0) {
                await this.prisma.$executeRaw`INSERT INTO public.workflow_runs (rule_id, trigger, subject, outcome, detail) VALUES (${rule.id}::uuid, ${e.trigger}, ${key}, 'skipped', ${`Stopped: this rule already ran ${MAX_RUNS_PER_RULE_PER_HOUR} times in the last hour.`})`;
            }
            return { outcome: "hourly limit", steps: [] };
        }

        const steps: Step[] = [];
        const ctx: Ctx = { ticketId: e.trigger === "ticket.created" ? e.ticketId ?? null : null };
        for (const a of rule.actions) {
            try { steps.push({ action: a.type, ok: true, text: await this.act(a, f, orgId, ctx) }); }
            catch (err: any) { steps.push({ action: a.type, ok: false, text: String(err?.response?.message ?? err?.message ?? err).slice(0, 300) }); }
        }
        const okCount = steps.filter((s) => s.ok).length;
        const outcome = okCount === steps.length ? "done" : okCount === 0 ? "failed" : "partial";
        await this.prisma.$executeRaw`INSERT INTO public.workflow_runs (rule_id, trigger, subject, outcome, detail, steps) VALUES (${rule.id}::uuid, ${e.trigger}, ${key}, ${outcome}, ${`About ${f.label}`}, ${JSON.stringify(steps)}::jsonb)`;
        await this.prisma.$executeRaw`UPDATE public.workflow_rules SET run_count = run_count + 1, last_run_at = now() WHERE id = ${rule.id}::uuid`;
        await this.prisma.$executeRaw`DELETE FROM public.workflow_runs WHERE at < now() - interval '60 days'`;
        return { outcome, steps };
    }

    private async act(a: Action, f: Subject, orgId: string, ctx: Ctx): Promise<string> {
        const req = { user: { organizationId: orgId, name: "ADG RMM Workflows" } };
        if (a.type === "set_priority" || a.type === "assign") {
            if (!ctx.ticketId) throw new Error("There is no ticket to change (the step that makes it did not work).");
            await this.tickets.update(ctx.ticketId, (a.type === "set_priority" ? { priority: a.priority } : { assigneeUserId: a.userId }) as any, req);
            return a.type === "set_priority" ? `Set the priority to ${a.priority}.` : "Assigned the ticket.";
        }
        if (a.type === "create_ticket") {
            const id = await this.tickets.create(
                { subject: fill(a.subject, f.facts, 300), description: [fill(a.description, f.facts), "Made by a workflow rule."].filter(Boolean).join("\n\n"), priority: a.priority, deviceId: f.deviceId ?? undefined } as any,
                { user: { organizationId: orgId, name: "ADG RMM Workflows" } },
                { source: "workflow" },
            );
            ctx.ticketId = id;
            return `Created ticket ${id}.`;
        }
        if (a.type === "notify") {
            await this.notifier.send({ email: true, slack: true, webhook: true }, fill(a.subject, f.facts, 200), fill(a.message, f.facts, 2000));
            return "Sent the notice.";
        }
        if (!f.deviceId) throw new Error("There is no computer to run the script on.");
        await this.scripts.run(a.scriptId, [f.deviceId], {}, null);
        return "Started the script on the computer.";
    }

    /** Try a rule on the facts of a real recent event without running anything: says whether it would run and what each action would do. */
    async preview(orgId: string, id: string) {
        const rule = (await this.prisma.$queryRaw<RuleRow[]>`SELECT * FROM public.workflow_rules WHERE id = ${id}::uuid AND organization_id = ${orgId}::uuid`)[0];
        if (!rule) throw new NotFoundException("Rule not found.");
        let e: WorkflowEvent | null = null;
        if (rule.trigger === "alert.opened") { const a = await this.prisma.alerts.findFirst({ orderBy: { first_seen_at: "desc" }, select: { id: true, device_id: true } }); if (a) e = { trigger: rule.trigger, alertId: a.id, deviceId: a.device_id }; }
        else if (rule.trigger === "device.offline") { const a = await this.prisma.alerts.findFirst({ where: { kind: "offline" }, orderBy: { first_seen_at: "desc" }, select: { id: true, device_id: true } }); if (a) e = { trigger: rule.trigger, alertId: a.id, deviceId: a.device_id }; }
        else if (rule.trigger === "patch.failed") { const d = await this.prisma.devices.findFirst({ orderBy: { created_at: "desc" }, select: { id: true } }); if (d) e = { trigger: rule.trigger, deviceId: d.id, source: "patch_install", reason: "Example: the update could not be installed (0x80070005)." }; }
        else if (rule.trigger === "device.registered") { const d = await this.prisma.devices.findFirst({ orderBy: { created_at: "desc" }, select: { id: true } }); if (d) e = { trigger: rule.trigger, deviceId: d.id }; }
        else { const t = await this.prisma.tickets.findFirst({ orderBy: { created_at: "desc" }, select: { id: true } }); if (t) e = { trigger: rule.trigger, ticketId: t.id, source: "ui" }; }
        const f = e ? await this.facts(e) : null;
        if (!f) return { sample: null, wouldRun: false, actions: [] as string[], note: "There is no recent event of this kind to try the rule on." };
        const would = allHold(rule.conditions ?? [], f.facts);
        return {
            sample: f.facts, wouldRun: would,
            actions: would ? rule.actions.map((a) => a.type === "create_ticket" ? `Create ticket "${fill(a.subject, f.facts, 300)}"` : a.type === "notify" ? `Send notice "${fill(a.subject, f.facts, 200)}"` : a.type === "set_priority" ? `Set the ticket priority to ${a.priority}` : a.type === "assign" ? "Assign the ticket to the chosen technician" : "Run the script on the computer") : [],
            note: would ? "These conditions hold for the newest event of this kind. Nothing was run." : "These conditions do not hold for the newest event of this kind. Nothing was run.",
        };
    }
}
