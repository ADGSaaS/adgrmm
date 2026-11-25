// backend/src/auto-repair/auto-repair.service.ts
//
// The automatic repair loop. A ticket made from the tray with a category (and a program, for Software Issue) starts a run:
//   diagnosing  a read-only script looks for the problems that category can have
//   repairing   a fixed repair script does what the catalog says for the problems that have one
//   verifying   the same checks run again: the repair only counts when the problem is gone
//   awaiting_user  the person is told in the ticket (and by email) to test again, and answers "fixed" or "still not working"
// Anything that does not go to plan (nothing found, nothing repairable, a repair that failed, the problem still there, a repair limit, too long)
// goes to a technician with a note of what was seen and done. A repair that worked also writes the KB article for that problem, once.
import { Injectable, Logger } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { randomUUID } from "node:crypto";
import { AlertsService } from "../alerts/alerts.service";
import { JobsService } from "../jobs/jobs.service";
import { KbService } from "../kb/kb.service";
import { SupportMailboxService } from "../support-mailbox/support-mailbox.service";
import { workflowBus, type WorkflowEvent } from "../workflows/workflows.bus";
import { PrismaService } from "../storage/prisma.service";
import {
    ALWAYS_REVIEWED, AUTO_AUTHOR, HANDOFF_REASONS, HEAL_ALERT_WITHIN_MINUTES, ISSUES, MINUTES_SAVED_PER_FIX, REPAIRS_PER_DEVICE_PER_DAY, RUN_LIMIT_MINUTES, SAME_ISSUE_PER_DAY, adviceReply, categoryFromText, checksFor, checksForLinux, platformOf, escalationReply, fixedReply, isIssueId, kbArticle,
    healingPlan, kbTagOf, parseDiagnosis, summarizeRuns, parseRepair, scriptResultNote, scriptStartNote, technicianNote, type AppInput, type Category, type Diagnosis, type IssueDef, type IssueId, type RepairLine,
} from "./auto-repair.core";
import { DIAGNOSE_KIND, DIAGNOSE_SCRIPT, REPAIR_KIND, REPAIR_SCRIPT } from "./auto-repair.scripts";
import { LINUX_DIAGNOSE_KIND, LINUX_DIAGNOSE_SCRIPT, LINUX_REPAIR_KIND, LINUX_REPAIR_SCRIPT } from "./auto-repair.linux";
import { PlaybooksService } from "./playbooks.service";
import { composeDiagnose, composeRepair } from "./playbooks.core";

type Platform = "windows" | "linux";

/** The scripts, and the language they are run in, for a kind of computer. */
const scriptsFor = (p: Platform) => p === "linux"
    ? { language: "bash" as const, diag: LINUX_DIAGNOSE_SCRIPT, repair: LINUX_REPAIR_SCRIPT, diagKind: LINUX_DIAGNOSE_KIND, repairKind: LINUX_REPAIR_KIND }
    : { language: "powershell" as const, diag: DIAGNOSE_SCRIPT, repair: REPAIR_SCRIPT, diagKind: DIAGNOSE_KIND, repairKind: REPAIR_KIND };

export type AutoRepairSettings = { enabled: boolean; autoRepair: boolean; createKb: boolean; selfHealing: boolean; fromText: boolean };
export const DEFAULT_AUTO_REPAIR: AutoRepairSettings = { enabled: false, autoRepair: true, createKb: true, selfHealing: false, fromText: false };

const FINISHED = ["succeeded", "failed", "timeout"];
const KB_CATEGORY = "Automatic repairs";

type Run = {
    id: string; organization_id: string; ticket_id: string | null; alert_id: string | null; source: string; device_id: string; category: string | null; app_name: string | null; checks: string[]; state: string;
    diag_job_id: string | null; repair_job_id: string | null; verify_job_id: string | null; repair_issues: string[]; custom_ids: string[]; diagnosis: any; repairs: any; created_at: Date;
};

@Injectable()
export class AutoRepairService {
    private readonly logger = new Logger(AutoRepairService.name);
    private ticking = false;
    private healing = false;

    constructor(
        private readonly prisma: PrismaService,
        private readonly jobs: JobsService,
        private readonly kb: KbService,
        private readonly mailbox: SupportMailboxService,
        private readonly alerts: AlertsService,
        private readonly playbooks: PlaybooksService,
    ) { }

    /* ------------------------------ settings ------------------------------ */

    async settings(orgId: string): Promise<AutoRepairSettings> {
        const rows = await this.prisma.$queryRaw<Array<{ enabled: boolean; auto_repair: boolean; create_kb: boolean; self_healing: boolean; from_text: boolean }>>`SELECT enabled, auto_repair, create_kb, self_healing, from_text FROM public.auto_repair_settings WHERE organization_id = ${orgId}::uuid`;
        const r = rows[0];
        return r ? { enabled: r.enabled, autoRepair: r.auto_repair, createKb: r.create_kb, selfHealing: r.self_healing, fromText: r.from_text } : { ...DEFAULT_AUTO_REPAIR };
    }

    async saveSettings(orgId: string, actorId: string | null, input: Record<string, unknown>) {
        const before = await this.settings(orgId);
        const after = { ...before };
        for (const k of ["enabled", "autoRepair", "createKb", "selfHealing", "fromText"] as const) {
            if (input[k] === undefined) continue;
            if (typeof input[k] !== "boolean") throw new Error(`${k} must be true or false.`);
            after[k] = input[k] as boolean;
        }
        await this.prisma.$executeRaw`INSERT INTO public.auto_repair_settings (organization_id, enabled, auto_repair, create_kb, self_healing, from_text, updated_by, updated_at) VALUES (${orgId}::uuid, ${after.enabled}, ${after.autoRepair}, ${after.createKb}, ${after.selfHealing}, ${after.fromText}, ${actorId}::uuid, now())
            ON CONFLICT (organization_id) DO UPDATE SET enabled = EXCLUDED.enabled, auto_repair = EXCLUDED.auto_repair, create_kb = EXCLUDED.create_kb, self_healing = EXCLUDED.self_healing, from_text = EXCLUDED.from_text, updated_by = EXCLUDED.updated_by, updated_at = now()`;
        return { before, after };
    }

    async runs(orgId: string, limit = 25) {
        const rows = await this.prisma.$queryRaw<Array<{ id: string; source: string; ticket_number: string | null; subject: string | null; alert_title: string | null; device: string; customer: string | null; category: string | null; app_name: string | null; state: string; repair_issues: string[]; outcome: string | null; created_at: Date; finished_at: Date | null }>>`
            SELECT r.id::text AS id, r.source, t.ticket_number::text AS ticket_number, t.subject, al.title AS alert_title, COALESCE(d.alias, d.hostname) AS device, c.name AS customer, r.category, r.app_name, r.state, r.repair_issues, r.outcome, r.created_at, r.finished_at
              FROM public.auto_repair_runs r LEFT JOIN public.tickets t ON t.id = r.ticket_id LEFT JOIN public.alerts al ON al.id = r.alert_id JOIN public.devices d ON d.id = r.device_id LEFT JOIN public.sites s ON s.id = d.site_id LEFT JOIN public.clients c ON c.id = s.client_id
             WHERE r.organization_id = ${orgId}::uuid ORDER BY r.created_at DESC LIMIT ${Math.min(100, Math.max(1, limit))}`;
        return { items: rows.map((r) => ({ id: r.id, source: r.source, ticketNumber: r.ticket_number ? Number(r.ticket_number) : null, subject: r.subject ?? r.alert_title, device: r.device, customer: r.customer, category: r.category, app: r.app_name, state: r.state, repaired: r.repair_issues, outcome: r.outcome, startedAt: r.created_at.toISOString(), finishedAt: r.finished_at?.toISOString() ?? null })) };
    }

    /** The results report: what the automatic repair and self-healing did over a period, what went to technicians and why, which problems are common, and which KB articles it wrote. */
    async report(orgId: string, daysInput: number) {
        const days = Math.min(365, Math.max(1, Math.round(daysInput) || 30));
        const since = new Date(Date.now() - days * 86_400_000);
        const runs = await this.prisma.$queryRaw<Array<{ source: string; state: string; handoff_reason: string | null; category: string | null; app_name: string | null; repair_issues: string[]; diagnosis: any; created_at: Date; finished_at: Date | null }>>`
            SELECT source, state, handoff_reason, category, app_name, repair_issues, diagnosis, created_at, finished_at FROM public.auto_repair_runs
             WHERE organization_id = ${orgId}::uuid AND created_at >= ${since}::timestamptz ORDER BY created_at DESC LIMIT 20000`;
        const sum = summarizeRuns(runs, days);
        const kb = await this.prisma.$queryRaw<Array<{ issue_id: string; article_id: string | null; title: string | null; seen_count: number; created_at: Date; last_seen_at: Date }>>`
            SELECT k.issue_id, k.article_id::text AS article_id, a.title, k.seen_count, k.created_at, k.last_seen_at FROM public.auto_repair_kb k
              LEFT JOIN public.kb_articles a ON a.id = k.article_id WHERE k.organization_id = ${orgId}::uuid ORDER BY k.created_at DESC LIMIT 100`;
        const label = (id: string) => (ISSUES as Record<string, { title: string; kind: string }>)[id];
        const list = (m: Record<string, number>) => Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 10);
        return {
            days, since: since.toISOString(), assumptionMinutesPerFix: MINUTES_SAVED_PER_FIX,
            ...sum,
            reasons: Object.entries(sum.reasons).sort((a, b) => b[1] - a[1]).map(([code, count]) => ({ code, text: HANDOFF_REASONS[code] ?? code, count })),
            byCategory: Object.entries(sum.byCategory).sort((a, b) => b[1].total - a[1].total).map(([category, v]) => ({ category, ...v })),
            problemsFound: list(sum.problemsFound).map(([id, count]) => ({ id, title: label(id)?.title ?? id, kind: label(id)?.kind ?? "", count, fixed: sum.problemsFixed[id] ?? 0, notFixed: sum.problemsNotFixed[id] ?? 0 })),
            addNext: list(sum.handedNoRepair).map(([what, count]) => ({ what: what.startsWith("Problem: ") ? `${label(what.slice(9))?.title ?? what.slice(9)} (found ${count} times, no automatic repair)` : `${what} (${count} times, nothing found)`, count })),
            articles: kb.map((k) => ({ issue: k.issue_id, articleId: k.article_id, title: k.title ?? label(k.issue_id)?.title ?? k.issue_id, seen: k.seen_count, writtenAt: k.created_at.toISOString(), lastSeenAt: k.last_seen_at.toISOString() })),
        };
    }

    /** One run in full, for a technician: its settings and every line it logged (the scripts and their results included). */
    async runDetail(orgId: string, id: string) {
        const rows = await this.prisma.$queryRaw<Array<{ id: string; source: string; state: string; category: string | null; app_name: string | null; checks: string[]; outcome: string | null; handoff_reason: string | null; created_at: Date; finished_at: Date | null; ticket_number: string | null; alert_title: string | null; device: string }>>`
            SELECT r.id::text AS id, r.source, r.state, r.category, r.app_name, r.checks, r.outcome, r.handoff_reason, r.created_at, r.finished_at, t.ticket_number::text AS ticket_number, al.title AS alert_title, COALESCE(d.alias, d.hostname) AS device
              FROM public.auto_repair_runs r LEFT JOIN public.tickets t ON t.id = r.ticket_id LEFT JOIN public.alerts al ON al.id = r.alert_id JOIN public.devices d ON d.id = r.device_id
             WHERE r.id = ${id}::uuid AND r.organization_id = ${orgId}::uuid`;
        const r = rows[0];
        if (!r) return null;
        const ev = await this.prisma.$queryRaw<Array<{ id: string; at: Date; internal: boolean; body: string }>>`SELECT id::text AS id, at, internal, body FROM public.auto_repair_events WHERE run_id = ${id}::uuid ORDER BY id`;
        return {
            id: r.id, source: r.source, state: r.state, category: r.category, app: r.app_name, checks: r.checks, outcome: r.outcome, handoff: r.handoff_reason ? HANDOFF_REASONS[r.handoff_reason] ?? r.handoff_reason : null, device: r.device,
            ticketNumber: r.ticket_number ? Number(r.ticket_number) : null, alertTitle: r.alert_title, startedAt: r.created_at.toISOString(), finishedAt: r.finished_at?.toISOString() ?? null,
            events: ev.map((e) => ({ id: e.id, at: e.at.toISOString(), internal: e.internal, text: e.body })),
        };
    }

    /** For the tray: where the repair of each of these tickets stands. */
    async stateOf(ticketIds: string[]): Promise<Map<string, string>> {
        if (!ticketIds.length) return new Map();
        const rows = await this.prisma.$queryRaw<Array<{ ticket_id: string; state: string }>>`
            SELECT DISTINCT ON (ticket_id) ticket_id::text AS ticket_id, state FROM public.auto_repair_runs WHERE ticket_id = ANY(${ticketIds}::uuid[]) ORDER BY ticket_id, created_at DESC`;
        return new Map(rows.map((r) => [r.ticket_id, r.state]));
    }

    /* ------------------------------ tickets that do not come from the tray ------------------------------ */

    onModuleInit() { workflowBus.on("event", this.onTicketEvent); }
    onModuleDestroy() { workflowBus.off("event", this.onTicketEvent); }

    private readonly onTicketEvent = (e: WorkflowEvent) => {
        if (e.trigger !== "ticket.created" || !e.ticketId || !["email", "portal", "ui", "api"].includes(String(e.source))) return;
        void this.startFromText(e.ticketId).catch((err) => this.logger.warn(`Automatic repair from ticket text failed: ${err?.message ?? err}`));
    };

    /**
     * A ticket from email, the customer portal or a technician, with a computer linked to it: when "tickets that are not from the tray" is on, the words of
     * the ticket choose the category (see categoryFromText). A ticket with no computer, or whose words point at nothing in particular, is left to a person.
     */
    async startFromText(ticketId: string): Promise<string | null> {
        const t = (await this.prisma.$queryRaw<Array<{ organization_id: string; subject: string; description: string | null; device_id: string | null }>>`
            SELECT organization_id::text AS organization_id, subject, description, device_id::text AS device_id FROM public.tickets WHERE id = ${ticketId}::uuid`)[0];
        if (!t) return null;
        const s = await this.settings(t.organization_id);
        if (!s.enabled || !s.fromText) return null;
        if ((await this.prisma.$queryRaw<Array<{ n: number }>>`SELECT 1 AS n FROM public.auto_repair_runs WHERE ticket_id = ${ticketId}::uuid LIMIT 1`).length) return null;
        const category = categoryFromText(t.subject, t.description);
        if (!category) return null;
        if (!t.device_id) {
            await this.say(ticketId, `Automatic repair would look at this ticket (the wording points at "${category}"), but no computer is linked to it, so nothing was checked. Link the computer and a technician can run the checks.`, true);
            return null;
        }
        await this.say(ticketId, `Automatic repair chose the category "${category}" from the wording of the ticket (it was not made from the tray app, so nobody picked one).`, true);
        return this.start({ ticketId, deviceId: t.device_id, orgId: t.organization_id, category, app: null });
    }

    /* ------------------------------ starting a run ------------------------------ */

    /** A ticket from the tray: starts the checks for its category when automatic repair is on and the computer is a Windows computer with an agent. Never throws. */
    async start(input: { ticketId: string; deviceId: string; orgId: string; category: Category | null; app: AppInput | null }): Promise<string | null> {
        try {
            const s = await this.settings(input.orgId);
            if (!input.category) return null;
            if (!s.enabled) {
                await this.say(input.ticketId, "Automatic repair is switched off, so no automatic checks were run for this ticket. (Administration > Agents & Endpoints > Automatic repair.)", true);
                return null;
            }
            const dev = await this.prisma.$queryRaw<Array<{ agent_id: string; os: string | null; name: string | null }>>`SELECT a.id::text AS agent_id, a.facts->>'os' AS os, d.operating_system AS name FROM public.devices d JOIN public.agents a ON a.device_id = d.id WHERE d.id = ${input.deviceId}::uuid LIMIT 1`;
            const d = dev[0];
            const platform = d ? platformOf(d.os, d.name) : null;
            if (!d || !platform) {
                await this.say(input.ticketId, d ? "No automatic checks were run: automatic repair works on Windows and Linux computers, and this one is neither." : "No automatic checks were run: this computer has no agent.", true);
                return null;
            }
            const sc = scriptsFor(platform);
            const checks = platform === "linux" ? checksForLinux(input.category, input.app) : checksFor(input.category, input.app);
            await this.playbooks.register(input.orgId);
            // Your own repairs are PowerShell scripts, so they only run on Windows computers.
            const custom = platform === "windows" ? await this.playbooks.matching(input.orgId, { category: input.category, app: input.app?.name ?? null }) : [];
            if (!checks.length && !custom.length) return null;
            const diagScript = platform === "windows" ? composeDiagnose(sc.diag, custom) : sc.diag;
            const job = await this.jobs.createRunScriptJob({ agentId: d.agent_id, language: sc.language, scriptText: diagScript, env: { RIQ_TOOL: sc.diagKind, RIQ_CHECKS: checks.join(","), RIQ_APP: input.app?.name ?? "" }, timeoutSec: 180 });
            const id = randomUUID();
            await this.prisma.$executeRaw`INSERT INTO public.auto_repair_runs (id, organization_id, ticket_id, device_id, category, app_name, checks, custom_ids, state, diag_job_id)
                VALUES (${id}::uuid, ${input.orgId}::uuid, ${input.ticketId}::uuid, ${input.deviceId}::uuid, ${input.category}, ${input.app?.name ?? null}, ${checks}::text[], ${custom.map((c) => c.key)}::text[], 'diagnosing', ${job.id}::uuid)`;
            await this.say({ id, ticket_id: input.ticketId, alert_id: null, source: "ticket" }, [
                "Automatic repair started for this ticket.",
                `They picked: ${[input.category, input.app?.name].filter(Boolean).join(", ")}${input.app?.publisher ? ` (${input.app.publisher}${input.app.version ? `, ${input.app.version}` : ""})` : ""}.`,
                `Checks chosen for that category: ${checks.join(", ") || "none of the built-in ones"}.`,
                ...(custom.length ? [`Your own repairs included (approved scripts): ${custom.map((c) => `${c.title} [${c.key}, ${c.risk} risk, approved${c.approvedBy ? ` by ${c.approvedBy}` : ""}${c.approvedAt ? ` on ${c.approvedAt.toISOString().slice(0, 10)}` : ""}]`).join("; ")}.`] : []),
                `Settings: repair ${s.autoRepair ? "on" : "off (checks only)"}, knowledge base articles ${s.createKb ? "on" : "off"}.`,
                "What happens next: the computer is checked (read only); a problem with a safe repair is repaired; the checks run again to confirm; the person is asked to test; anything else comes to a technician. Every step is written here.",
            ].join("\n"), true);
            await this.say({ id, ticket_id: input.ticketId, alert_id: null, source: "ticket" }, scriptStartNote({ step: "1. Checks (read only)", purpose: "Look for the problems this category can have. Nothing on the computer is changed.", jobId: job.id, language: sc.language, env: { RIQ_CHECKS: checks.join(","), RIQ_APP: input.app?.name ?? "" }, script: diagScript, scriptName: sc.diagKind }), true);
            return id;
        } catch (e) {
            this.logger.warn(`Could not start the automatic repair: ${(e as Error).message}`);
            return null;
        }
    }

    /* ------------------------------ moving runs along ------------------------------ */

    @Interval(10_000)
    async tick() {
        if (this.ticking) return;
        this.ticking = true;
        try {
            const runs = await this.prisma.$queryRaw<Run[]>`
                SELECT id::text AS id, organization_id::text AS organization_id, ticket_id::text AS ticket_id, alert_id::text AS alert_id, source, device_id::text AS device_id, category, app_name, checks, state,
                       diag_job_id::text AS diag_job_id, repair_job_id::text AS repair_job_id, verify_job_id::text AS verify_job_id, repair_issues, custom_ids, diagnosis, repairs, created_at
                  FROM public.auto_repair_runs WHERE state IN ('diagnosing', 'repairing', 'verifying') ORDER BY created_at LIMIT 25`;
            for (const r of runs) {
                try { await this.advance(r); } catch (e) { this.logger.warn(`Automatic repair run ${r.id} could not advance: ${(e as Error).message}`); await this.finish(r, "needs_technician", `The automatic repair stopped with an error: ${(e as Error).message}`.slice(0, 300), "error"); }
            }
        } finally {
            this.ticking = false;
        }
    }

    private async setState(r: Run, state: string, fields: { repairJob?: string; verifyJob?: string; diagnosis?: unknown; repairs?: unknown; repairIssues?: string[] } = {}) {
        await this.prisma.$executeRaw`UPDATE public.auto_repair_runs SET state = ${state}, updated_at = now(),
            repair_job_id = COALESCE(${fields.repairJob ?? null}::uuid, repair_job_id), verify_job_id = COALESCE(${fields.verifyJob ?? null}::uuid, verify_job_id),
            diagnosis = COALESCE(${fields.diagnosis === undefined ? null : JSON.stringify(fields.diagnosis)}::jsonb, diagnosis), repairs = COALESCE(${fields.repairs === undefined ? null : JSON.stringify(fields.repairs)}::jsonb, repairs),
            repair_issues = COALESCE(${fields.repairIssues ?? null}::text[], repair_issues) WHERE id = ${r.id}::uuid`;
    }

    private async finish(r: Run, state: "needs_technician" | "no_issue_found" | "awaiting_user" | "healed", outcome: string, reason: string | null = null) {
        await this.prisma.$executeRaw`UPDATE public.auto_repair_runs SET state = ${state}, outcome = ${outcome}, handoff_reason = ${reason}, updated_at = now(), finished_at = CASE WHEN ${state} = 'awaiting_user' THEN NULL ELSE now() END WHERE id = ${r.id}::uuid`;
    }

    private async advance(r: Run) {
        await this.playbooks.register(r.organization_id);
        if (Date.now() - r.created_at.getTime() > RUN_LIMIT_MINUTES * 60_000) {
            await this.toTechnician(r, "The automatic repair took too long (the computer may be offline), so a technician needs to take over.", r.diagnosis as Diagnosis | null, [], true, "too_long");
            return;
        }
        const jobId = r.state === "diagnosing" ? r.diag_job_id : r.state === "repairing" ? r.repair_job_id : r.verify_job_id;
        if (!jobId) { await this.toTechnician(r, "The automatic repair has no job to wait for.", null, [], true); return; }
        const j = await this.jobs.getJobWithResult(jobId);
        if (!FINISHED.includes(j.status)) return;
        const out = String(j.stdout ?? ""), err = String(j.stderr ?? "");
        const step = r.state === "diagnosing" ? "1. Checks (read only)" : r.state === "repairing" ? "2. Repair" : "3. Checks again, to confirm the repair";
        await this.say(r, scriptResultNote({ step, jobId, status: j.status, exitCode: j.exit_code ?? null, durationMs: j.duration_ms ?? null, startedAt: j.started_at ?? null, finishedAt: j.finished_at ?? null, stdout: out, stderr: err }), true);
        if (r.state === "diagnosing") return this.afterDiagnosis(r, j.status, out, err);
        if (r.state === "repairing") return this.afterRepair(r, j.status, out, err);
        return this.afterVerify(r, j.status, out, err);
    }

    private async afterDiagnosis(r: Run, status: string, out: string, err: string) {
        const diag = parseDiagnosis(out);
        if (status !== "succeeded" || !diag.complete) {
            await this.toTechnician(r, `The automatic checks could not run on the computer${err.trim() ? ` (${err.trim().slice(0, 200)})` : ""}.`, null, [], true, "could_not_run");
            return;
        }
        const defs = diag.issues.map((i) => ISSUES[i.id]);
        const set = await this.settings(r.organization_id);
        let repairable = defs.filter((d) => d.kind === "repair");
        const skipped: string[] = [];
        if (repairable.length) {
            if (!set.autoRepair) { skipped.push("automatic repair is switched off (checks only)"); repairable = []; }
            else {
                const recent = await this.prisma.$queryRaw<Array<{ repair_issues: string[] }>>`SELECT repair_issues FROM public.auto_repair_runs WHERE device_id = ${r.device_id}::uuid AND repair_job_id IS NOT NULL AND id <> ${r.id}::uuid AND created_at > now() - interval '24 hours'`;
                const total = recent.reduce((n, x) => n + x.repair_issues.length, 0);
                const again = new Set(recent.flatMap((x) => x.repair_issues));
                repairable = repairable.filter((d) => { if (again.has(d.id)) { skipped.push(`${d.id} was already repaired automatically today and came back`); return false; } return true; });
                if (total + repairable.length > REPAIRS_PER_DEVICE_PER_DAY) { skipped.push("this computer has had its limit of automatic repairs for today"); repairable = []; }
            }
        }
        const stored = { issues: diag.issues, info: diag.info, skipped };
        if (repairable.length) {
            const agent = await this.agentOf(r.device_id);
            const customFix = (await this.playbooks.byKeys(r.organization_id, r.custom_ids)).filter((c) => repairable.some((d) => d.id === c.key));
            const sc = scriptsFor(await this.platformOfDevice(r.device_id));
            const repairScript = sc.language === "powershell" ? composeRepair(sc.repair, customFix) : sc.repair;
            const job = await this.jobs.createRunScriptJob({ agentId: agent, language: sc.language, scriptText: repairScript, env: { RIQ_TOOL: sc.repairKind, RIQ_FIX: repairable.map((d) => d.id).join(",") }, timeoutSec: 420 });
            await this.setState(r, "repairing", { repairJob: job.id, diagnosis: stored, repairIssues: repairable.map((d) => d.id) });
            await this.say(r, [
                "Decision after the checks:",
                `Found: ${diag.issues.map((i) => `${i.id} (${ISSUES[i.id].kind}): ${ISSUES[i.id].title}. ${i.detail}`).join("\n       ")}`,
                `Repairing automatically: ${repairable.map((d) => `${d.id}: ${d.fix}`).join(" | ")}`,
                skipped.length ? `Not repaired automatically: ${skipped.join("; ")}.` : "",
            ].filter(Boolean).join("\n"), true);
            await this.say(r, scriptStartNote({ step: "2. Repair", purpose: `Repair ${repairable.map((d) => d.id).join(", ")}. It only does what is written in the script for those problems and says for each whether it worked.`, jobId: job.id, language: sc.language, env: { RIQ_FIX: repairable.map((d) => d.id).join(",") }, script: repairScript, scriptName: sc.repairKind }), true);
            return;
        }
        await this.say(r, [
            "Decision after the checks:",
            defs.length ? `Found: ${diag.issues.map((i) => `${i.id} (${ISSUES[i.id].kind}): ${ISSUES[i.id].title}. ${i.detail}`).join("\n       ")}` : "Found: no problem the automatic checks know about.",
            skipped.length ? `Not repaired automatically: ${skipped.join("; ")}.` : "",
            `No repair script is run for this ${r.source === "alert" ? "alert" : "ticket"}.`,
        ].filter(Boolean).join("\n"), true);
        const advice = defs.filter((d) => d.kind === "advice");
        const escalate = defs.filter((d) => d.kind === "escalate" || (d.kind === "repair" && !repairable.includes(d)) || (r.source === "alert" && d.kind === "advice"));
        const note = (outcome: string) => technicianNote({ app: r.app_name, category: r.category, checks: r.checks, diagnosis: { ...diag, complete: true }, outcome: [outcome, skipped.length ? `Not repaired automatically: ${skipped.join("; ")}.` : ""].filter(Boolean).join(" ") });
        if (!defs.length) {
            await this.setState(r, "no_issue_found", { diagnosis: stored });
            await this.say(r, note("Nothing the automatic checks know about was found, so a technician needs to look into it."), true);
            await this.say(r, "We checked your computer automatically and did not find anything we can fix by ourselves. A technician will follow up with you.", false);
            await this.finish(r, "no_issue_found", "No known problem was found.");
            return;
        }
        if (advice.length && r.source !== "alert") {
            await this.setState(r, "awaiting_user", { diagnosis: stored });
            await this.say(r, note(`The person was asked to: ${advice.map((d) => d.advice).join(" ")}`), true);
            await this.say(r, adviceReply(advice, escalate), false, true);
            await this.afterReply(r, escalate.length > 0 || escalate.some((d) => d.urgent));
            await this.finish(r, "awaiting_user", `Advice given: ${advice.map((d) => d.id).join(", ")}.`);
            return;
        }
        await this.setState(r, "needs_technician", { diagnosis: stored });
        await this.say(r, note("These need a technician."), true);
        await this.say(r, escalationReply(escalate), false, true);
        if (escalate.some((d) => d.urgent)) await this.raise(r);
        await this.finish(r, "needs_technician", `Needs a technician: ${escalate.map((d) => d.id).join(", ")}.`, skipped.length ? "not_repaired" : "needs_technician");
    }

    private async afterRepair(r: Run, status: string, out: string, err: string) {
        const lines = parseRepair(out);
        const ok = lines.filter((l) => l.ok);
        if (status !== "succeeded" || !ok.length) {
            await this.toTechnician(r, `The automatic repair did not work${err.trim() ? ` (${err.trim().slice(0, 200)})` : ""}.`, r.diagnosis as Diagnosis | null, lines, true, "repair_failed");
            return;
        }
        const agent = await this.agentOf(r.device_id);
        // the confirming checks only count crashes after the repair: the ones before it are still in the event log and always will be
        const repairJob = r.repair_job_id ? await this.jobs.getJobWithResult(r.repair_job_id).catch(() => null) : null;
        const since = (repairJob?.finished_at ?? new Date()).toISOString();
        const sc = scriptsFor(await this.platformOfDevice(r.device_id));
        const verifyScript = sc.language === "powershell" ? composeDiagnose(sc.diag, await this.playbooks.byKeys(r.organization_id, r.custom_ids)) : sc.diag;
        const job = await this.jobs.createRunScriptJob({ agentId: agent, language: sc.language, scriptText: verifyScript, env: { RIQ_TOOL: sc.diagKind, RIQ_CHECKS: r.checks.join(","), RIQ_APP: r.app_name ?? "", RIQ_SINCE: since }, timeoutSec: 180 });
        await this.setState(r, "verifying", { verifyJob: job.id, repairs: lines });
        await this.say(r, [
            "Decision after the repair:",
            ...lines.map((l) => `${l.id}: ${l.ok ? "the repair says it worked" : "the repair did not work"}. ${l.message}`),
            "The checks now run again to confirm the problem is really gone. A repair only counts if they come back clean.",
        ].join("\n"), true);
        await this.say(r, scriptStartNote({ step: "3. Checks again, to confirm the repair", purpose: "Run the same checks again and compare with the first run.", jobId: job.id, language: sc.language, env: { RIQ_CHECKS: r.checks.join(","), RIQ_APP: r.app_name ?? "", RIQ_SINCE: since }, script: null, scriptName: sc.diagKind }), true);
    }

    private async afterVerify(r: Run, status: string, out: string, err: string) {
        const repairs: RepairLine[] = Array.isArray(r.repairs) ? r.repairs : [];
        const diag = parseDiagnosis(out);
        const fixedIds = repairs.filter((l) => l.ok).map((l) => l.id);
        const stillThere = status === "succeeded" && diag.complete ? fixedIds.filter((id) => diag.issues.some((i) => i.id === id)) : fixedIds;
        const before = (r.diagnosis ?? {}) as { issues?: Array<{ id: string; detail: string }>; info?: Record<string, string>; skipped?: string[] };
        const beforeDiag: Diagnosis = { issues: (before.issues ?? []).filter((i): i is { id: IssueId; detail: string } => isIssueId(i.id)), info: before.info ?? {}, complete: true };
        if (status !== "succeeded" || !diag.complete || stillThere.length) {
            await this.toTechnician(r, stillThere.length ? `The repair said it worked but the check still finds: ${stillThere.join(", ")}.` : `The check after the repair could not run${err.trim() ? ` (${err.trim().slice(0, 200)})` : ""}.`, beforeDiag, repairs, true, stillThere.length ? "still_there" : "could_not_run");
            return;
        }
        await this.say(r, `Decision after the confirming checks: the problem${fixedIds.length === 1 ? "" : "s"} (${fixedIds.join(", ")}) ${fixedIds.length === 1 ? "is" : "are"} gone. The repair is confirmed. ${r.source === "alert" ? "The alert is resolved and the knowledge base is updated." : "The person is asked to test, the ticket waits for them, and the knowledge base is updated."}`, true);
        if (r.source === "alert") { await this.healAlertRun(r, fixedIds, repairs, beforeDiag); return; }
        // it worked: tell the person, write the KB article (once per kind of problem), and wait for them to test
        const fixed = fixedIds.map((id) => ISSUES[id as IssueId]);
        const failed = repairs.filter((l) => !l.ok).map((l) => ISSUES[l.id]);
        const others = beforeDiag.issues.map((i) => ISSUES[i.id]).filter((d) => !fixedIds.includes(d.id));
        const advice = others.filter((d) => d.kind === "advice");
        const noticed = [...others.filter((d) => d.kind !== "advice"), ...failed.filter((d) => !others.includes(d))];
        const needsTech = noticed.length > 0 || ALWAYS_REVIEWED.has((r.category ?? "") as Category) || [...fixed, ...noticed].some((d) => d.urgent);
        let reply = fixedReply(fixed, repairs.filter((l) => l.ok).map((l) => l.message), noticed);
        if (advice.length) reply = `${reply}\n\nOne more thing: ${advice.map((d) => d.advice).join(" ")}`;
        await this.say(r, technicianNote({ app: r.app_name, category: r.category, checks: r.checks, diagnosis: beforeDiag, repairs, outcome: "The repair worked and the check afterwards is clean. The person was asked to test." }), true);
        await this.say(r, reply, false, true);
        await this.afterReply(r, needsTech);
        if ([...fixed, ...noticed].some((d) => d.urgent)) await this.raise(r);
        await this.writeKb(r, fixed);
        await this.setState(r, "awaiting_user", { repairs });
        await this.finish(r, "awaiting_user", `Fixed: ${fixedIds.join(", ")}. Waiting for the person to test.`);
    }

    /** The knowledge base after a repair that worked: one article per problem, written once. The log says what happened. */
    private async writeKb(r: Run, fixed: IssueDef[]) {
        const set = await this.settings(r.organization_id);
        if (!set.createKb) { await this.say(r, "Knowledge base: writing articles is switched off, so none was written.", true); return; }
        const where = r.source === "alert" ? "the ticket of this alert, if it has one" : "this ticket";
        for (const d of fixed) {
            const kb = await this.ensureArticle(r.organization_id, d, r.app_name, await this.ticketOf(r)).catch((e) => { this.logger.warn(`Could not write the KB article for ${d.id}: ${(e as Error).message}`); return undefined; });
            await this.say(r, kb === undefined ? `Knowledge base: the article for ${d.id} could not be written (see the server log).` : kb === null ? `Knowledge base: the article for ${d.id} is being written by another repair at this moment.` : kb.created ? `Knowledge base: a new article was written for ${d.id}: "${d.title}" (article ${kb.id}). It is published and linked to ${where}.` : `Knowledge base: ${d.id} already has an article (article ${kb.id}), so no second one was written. It is linked to ${where}.`, true);
        }
    }

    /** The ticket a run writes to: its own, or (for an alert) the one the alert opened, if it has one. */
    private async ticketOf(r: { ticket_id: string | null; alert_id: string | null }): Promise<string | null> {
        if (r.ticket_id) return r.ticket_id;
        if (!r.alert_id) return null;
        const a = await this.prisma.$queryRaw<Array<{ ticket_id: string | null }>>`SELECT ticket_id::text AS ticket_id FROM public.alerts WHERE id = ${r.alert_id}::uuid`;
        return a[0]?.ticket_id ?? null;
    }

    /** A repair of a failed check worked and the check is clean again: the alert is resolved (which also closes the ticket it opened, when that is switched on). */
    private async healAlertRun(r: Run, fixedIds: string[], repairs: RepairLine[], beforeDiag: Diagnosis) {
        const fixed = fixedIds.map((id) => ISSUES[id as IssueId]);
        await this.say(r, technicianNote({ app: null, category: "Failed monitoring check", checks: r.checks, diagnosis: beforeDiag, repairs, outcome: "The repair worked and the check afterwards is clean. The alert is resolved automatically." }), true);
        try {
            await this.alerts.resolve(r.alert_id!, null, `Fixed by automatic repair: ${repairs.filter((l) => l.ok).map((l) => l.message).join(" ")}`.slice(0, 500));
            await this.say(r, "Alert: resolved by the automatic repair. A ticket the alert opened is closed too when that is switched on (Administration > Alerts).", true);
        } catch (e) {
            await this.say(r, `Alert: it could not be resolved here (${(e as Error).message}); it had probably already cleared on its own.`, true);
        }
        await this.writeKb(r, fixed);
        await this.setState(r, "healed", { repairs });
        await this.finish(r, "healed", `Fixed: ${fixedIds.join(", ")}. The alert was resolved.`);
    }

    /* ------------------------------ self-healing: a failed check starts the loop ------------------------------ */

    /** Looks for new alerts from failed checks that have a known repair, and starts the loop for each. Safe to call often. */
    @Interval(30_000)
    async healAlerts() {
        if (this.healing) return;
        this.healing = true;
        try {
            const rows = await this.prisma.$queryRaw<Array<{ id: string; device_id: string; title: string; ticket_id: string | null; check_type: string | null; check_config: any; org: string | null }>>`
                SELECT al.id::text AS id, al.device_id::text AS device_id, al.title, al.ticket_id::text AS ticket_id, ck.type::text AS check_type, ck.config AS check_config,
                       COALESCE(c.organization_id, (SELECT id FROM public.organizations WHERE slug = 'default' LIMIT 1))::text AS org
                  FROM public.alerts al
                  JOIN public.check_assignments ca ON ca.id = al.assignment_id
                  JOIN public.checks ck ON ck.id = ca.check_id
                  JOIN public.devices d ON d.id = al.device_id
                  LEFT JOIN public.sites s ON s.id = d.site_id LEFT JOIN public.clients c ON c.id = s.client_id
                 WHERE al.kind = 'check' AND al.state = 'OPEN' AND al.resolved_at IS NULL AND al.first_seen_at > now() - make_interval(mins => ${HEAL_ALERT_WITHIN_MINUTES}::int)
                   AND NOT EXISTS (SELECT 1 FROM public.auto_repair_runs r WHERE r.alert_id = al.id)
                 ORDER BY al.first_seen_at LIMIT 20`;
            for (const a of rows) {
                try {
                    if (!a.org) continue;
                    const s = await this.settings(a.org);
                    if (!s.enabled || !s.selfHealing) continue;
                    const builtIn = healingPlan({ type: a.check_type ?? "", config: a.check_config });
                    await this.playbooks.register(a.org);
                    const cfg = (a.check_config ?? {}) as Record<string, unknown>;
                    const custom = await this.playbooks.matching(a.org, { checkService: a.check_type === "service" ? String(cfg.service ?? "") : null, checkMetric: a.check_type === "metric" ? String(cfg.metric ?? "") : null });
                    if (!builtIn && !custom.length) continue;
                    const plan = builtIn ?? { checks: [], why: "Your own repair is set to run when this check fails." };
                    await this.startForAlert({ alertId: a.id, ticketId: a.ticket_id, deviceId: a.device_id, orgId: a.org, title: a.title, plan, settings: s, custom });
                } catch (e) {
                    this.logger.warn(`Self-healing could not start for alert ${a.id}: ${(e as Error).message}`);
                }
            }
        } finally {
            this.healing = false;
        }
    }

    private async startForAlert(input: { alertId: string; ticketId: string | null; deviceId: string; orgId: string; title: string; plan: { checks: string[]; why: string }; settings: AutoRepairSettings; custom: Array<{ key: string; title: string; risk: string; detectScript: string; fixScript: string }> }) {
        const dev = await this.prisma.$queryRaw<Array<{ agent_id: string; os: string | null; name: string | null }>>`SELECT a.id::text AS agent_id, a.facts->>'os' AS os, d.operating_system AS name FROM public.devices d JOIN public.agents a ON a.device_id = d.id WHERE d.id = ${input.deviceId}::uuid LIMIT 1`;
        const d = dev[0];
        const platform = d ? platformOf(d.os, d.name) : null;
        if (!d || !platform) return;   // self-healing works on Windows and Linux computers, and says nothing about the others
        const sc = scriptsFor(platform);
        // On Linux only the checks that mean something there are run; a failed check that none of them can help with goes its normal way.
        const heal = platform === "linux" ? { ...input.plan, checks: input.plan.checks.filter((c) => ["disk", "time", "network", "services"].includes(c)) } : input.plan;
        if (platform === "linux" && !heal.checks.length) return;
        const id = randomUUID();
        // the run is claimed first (one per alert, enforced by the database), then the job is made
        const claim = await this.prisma.$queryRaw<Array<{ id: string }>>`INSERT INTO public.auto_repair_runs (id, organization_id, ticket_id, device_id, category, checks, custom_ids, state, source, alert_id)
            VALUES (${id}::uuid, ${input.orgId}::uuid, ${input.ticketId}::uuid, ${input.deviceId}::uuid, 'Failed monitoring check', ${input.plan.checks}::text[], ${input.custom.map((c) => c.key)}::text[], 'diagnosing', 'alert', ${input.alertId}::uuid)
            ON CONFLICT (alert_id) WHERE alert_id IS NOT NULL DO NOTHING RETURNING id::text AS id`;
        if (!claim.length) return;
        const diagScript = platform === "windows" ? composeDiagnose(sc.diag, input.custom) : sc.diag;
        const job = await this.jobs.createRunScriptJob({ agentId: d.agent_id, language: sc.language, scriptText: diagScript, env: { RIQ_TOOL: sc.diagKind, RIQ_CHECKS: heal.checks.join(","), RIQ_APP: "" }, timeoutSec: 180 });
        await this.prisma.$executeRaw`UPDATE public.auto_repair_runs SET diag_job_id = ${job.id}::uuid WHERE id = ${id}::uuid`;
        const ref = { id, ticket_id: input.ticketId, alert_id: input.alertId, source: "alert" };
        await this.say(ref, [
            "Self-healing started: a monitoring check failed.",
            `Alert: ${input.title}.`,
            input.plan.why,
            `Checks chosen: ${input.plan.checks.join(", ") || "none of the built-in ones"}.`,
            ...(input.custom.length ? [`Your own repairs included (approved scripts): ${input.custom.map((c) => `${c.title} [${c.key}, ${c.risk} risk]`).join("; ")}.`] : []),
            `Settings: repair ${input.settings.autoRepair ? "on" : "off (checks only)"}, knowledge base articles ${input.settings.createKb ? "on" : "off"}.`,
            "What happens next: the computer is checked (read only); a problem with a safe repair is repaired; the checks run again to confirm; if they come back clean the alert is resolved. Anything else is left for a technician, with this log. Every step is written here.",
        ].join("\n"), true);
        await this.say(ref, scriptStartNote({ step: "1. Checks (read only)", purpose: "Look for the cause of the failed check. Nothing on the computer is changed.", jobId: job.id, language: sc.language, env: { RIQ_CHECKS: heal.checks.join(","), RIQ_APP: "" }, script: diagScript, scriptName: sc.diagKind }), true);
    }

    /** Hands a run to a technician with a note of what was seen and done, and tells the person someone will follow up. */
    private async toTechnician(r: Run, why: string, diag: Diagnosis | null, repairs: RepairLine[], tellPerson: boolean, code = "error") {
        await this.say(r, technicianNote({ app: r.app_name, category: r.category, checks: r.checks, diagnosis: diag, repairs, outcome: `${why} A technician needs to take over.` }), true);
        if (tellPerson && r.source !== "alert") await this.say(r, "We tried to fix this automatically but could not. A technician has been given everything we found and will follow up.", false, true);
        await this.finish(r, "needs_technician", why.slice(0, 300), code);
    }

    private async platformOfDevice(deviceId: string): Promise<Platform> {
        const rows = await this.prisma.$queryRaw<Array<{ os: string | null; name: string | null }>>`SELECT a.facts->>'os' AS os, d.operating_system AS name FROM public.devices d JOIN public.agents a ON a.device_id = d.id WHERE d.id = ${deviceId}::uuid LIMIT 1`;
        return rows[0] && platformOf(rows[0].os, rows[0].name) === "linux" ? "linux" : "windows";
    }

    private async agentOf(deviceId: string): Promise<string> {
        const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`SELECT id::text AS id FROM public.agents WHERE device_id = ${deviceId}::uuid LIMIT 1`;
        if (!rows[0]) throw new Error("The computer has no agent.");
        return rows[0].id;
    }

    /* ------------------------------ the ticket ------------------------------ */

    /** A line on the ticket: for technicians only (internal), or a reply the person sees (and gets by email when they gave an address). */
    private async say(target: string | { id: string; ticket_id: string | null; alert_id?: string | null; source?: string }, text: string, internal: boolean, email = false) {
        const ref = typeof target === "string" ? { id: null as string | null, ticket_id: target as string | null, alert_id: null as string | null, source: "ticket" } : { id: target.id as string | null, ticket_id: target.ticket_id, alert_id: target.alert_id ?? null, source: target.source ?? "ticket" };
        if (ref.source === "alert" && !internal) return;   // there is nobody to write to: an alert has no person
        // the run keeps its own log (what a technician reads on a ticket is a copy of it)
        if (ref.id) await this.prisma.$executeRaw`INSERT INTO public.auto_repair_events (run_id, internal, body) VALUES (${ref.id}::uuid, ${internal}, ${text})`;
        const ticketId = await this.ticketOf(ref);
        if (!ticketId) return;
        await this.prisma.ticket_activity.create({ data: { id: randomUUID(), ticket_id: ticketId, kind: internal ? "note" : "message", body: text, author: AUTO_AUTHOR, is_internal: internal, notify_customer: false } });
        await this.prisma.$executeRaw`UPDATE public.tickets SET updated_at = now() WHERE id = ${ticketId}::uuid`;
        if (!internal && email) {
            const org = await this.prisma.$queryRaw<Array<{ organization_id: string }>>`SELECT organization_id::text AS organization_id FROM public.tickets WHERE id = ${ticketId}::uuid`;
            if (org[0]) {
                const sent = await this.mailbox.sendReply(org[0].organization_id, ticketId, text, AUTO_AUTHOR).catch((e) => ({ sent: false, reason: String((e as Error).message ?? e).slice(0, 200), to: undefined as string | undefined }));
                await this.prisma.ticket_activity.create({ data: { id: randomUUID(), ticket_id: ticketId, kind: "note", body: `Reply sent to the person in the tray window${sent.sent ? ` and emailed to ${sent.to}` : `. Email: not sent (${sent.reason ?? "no reason given"})`}.`, author: AUTO_AUTHOR, is_internal: true, notify_customer: false } });
            }
        }
    }

    /** After a reply asking the person to test or act: the ticket waits for them, unless a technician is needed too. */
    private async afterReply(r: Run, technicianNeeded: boolean) {
        if (!r.ticket_id) return;
        await this.prisma.$executeRaw`UPDATE public.tickets SET status = ${technicianNeeded ? "open" : "pending"}::ticket_status, updated_at = now() WHERE id = ${r.ticket_id}::uuid AND status::text IN ('open', 'pending', 'in_progress')`;
        await this.say(r, technicianNeeded ? "Ticket status: left open, because a technician is needed as well (something was found that a script cannot fix, the category is always reviewed, or it is urgent)." : "Ticket status: set to pending, waiting for the person to test.", true);
    }

    private async raise(r: Run) {
        const ticketId = await this.ticketOf(r);
        if (!ticketId) return;
        const up = await this.prisma.$executeRaw`UPDATE public.tickets SET priority = 'high'::ticket_priority WHERE id = ${ticketId}::uuid AND priority::text IN ('low', 'normal')`;
        if (up) await this.say(r, "Ticket priority: raised to high, because something urgent was found (a security, hardware or sign-in problem that should not wait).", true);
    }

    /** The person answered after an automatic repair: any reply means it is not (yet) fixed, so a technician takes over. */
    async onUserReply(ticketId: string): Promise<void> {
        const hit = await this.prisma.$queryRaw<Array<{ id: string }>>`UPDATE public.auto_repair_runs SET state = 'not_fixed', handoff_reason = 'person_says_not_fixed', updated_at = now(), finished_at = now(), outcome = 'The person says the problem is still there.' WHERE ticket_id = ${ticketId}::uuid AND state = 'awaiting_user' RETURNING id::text AS id`;
        if (!hit.length) return;
        await this.say({ id: hit[0].id, ticket_id: ticketId }, "The person tested it and says the problem is still there after the automatic repair. No further automatic steps will run. A technician needs to investigate, starting from the checks and repair written above, and the ticket is back to open.", true);
        await this.prisma.$executeRaw`UPDATE public.tickets SET status = 'open'::ticket_status, updated_at = now() WHERE id = ${ticketId}::uuid AND status::text IN ('pending', 'resolved')`;
    }

    /** The person said it is fixed. */
    async onUserResolved(ticketId: string): Promise<void> {
        const hit = await this.prisma.$queryRaw<Array<{ id: string }>>`UPDATE public.auto_repair_runs SET state = 'confirmed_fixed', updated_at = now(), finished_at = now(), outcome = 'The person confirmed it is fixed.' WHERE ticket_id = ${ticketId}::uuid AND state = 'awaiting_user' RETURNING id::text AS id`;
        if (hit.length) await this.say({ id: hit[0].id, ticket_id: ticketId }, "The person tested it and says it is fixed. The automatic repair is complete: confirmed by the person.", true);
    }

    /* ------------------------------ the KB, once per kind of problem ------------------------------ */

    private async kbCategory(orgId: string): Promise<string> {
        const found = await this.prisma.kb_categories.findFirst({ where: { organization_id: orgId, name: KB_CATEGORY }, select: { id: true } });
        if (found) return found.id;
        return (await this.prisma.kb_categories.create({ data: { organization_id: orgId, name: KB_CATEGORY }, select: { id: true } })).id;
    }

    private async link(ticketId: string | null, articleId: string) {
        if (!ticketId) return;
        await this.prisma.$executeRaw`INSERT INTO public.kb_ticket_links (ticket_id, article_id) VALUES (${ticketId}::uuid, ${articleId}::uuid) ON CONFLICT DO NOTHING`;
    }

    /**
     * The KB article for a problem a repair fixed. There is never a second one for the same problem: the claim row (one per organization and problem)
     * is taken first, so two repairs at the same moment cannot both write one, and an article that already carries the problem's tag is used as it is.
     * A later repair of the same problem only counts it and links the ticket to the existing article.
     */
    async ensureArticle(orgId: string, issue: IssueDef, appName: string | null, ticketId: string | null): Promise<{ id: string; created: boolean } | null> {
        const claim = await this.prisma.$queryRaw<Array<{ issue_id: string }>>`INSERT INTO public.auto_repair_kb (organization_id, issue_id) VALUES (${orgId}::uuid, ${issue.id}) ON CONFLICT (organization_id, issue_id) DO NOTHING RETURNING issue_id`;
        if (!claim.length) {
            const row = await this.prisma.$queryRaw<Array<{ article_id: string | null; alive: boolean }>>`
                UPDATE public.auto_repair_kb k SET seen_count = seen_count + 1, last_seen_at = now() WHERE organization_id = ${orgId}::uuid AND issue_id = ${issue.id}
                RETURNING k.article_id::text AS article_id, EXISTS (SELECT 1 FROM public.kb_articles a WHERE a.id = k.article_id) AS alive`;
            const hit = row[0];
            if (!hit || !hit.article_id) return null;   // another repair is writing it at this moment: it gets linked by that one
            if (hit.alive) { await this.link(ticketId, hit.article_id); return { id: hit.article_id, created: false }; }
            // the article was deleted by hand: take the claim back (only one repair can) and write it again
            const back = await this.prisma.$queryRaw<Array<{ issue_id: string }>>`UPDATE public.auto_repair_kb SET article_id = NULL WHERE organization_id = ${orgId}::uuid AND issue_id = ${issue.id} AND article_id = ${hit.article_id}::uuid RETURNING issue_id`;
            if (!back.length) return null;
        }
        const tag = kbTagOf(issue.id);
        const existing = await this.prisma.$queryRaw<Array<{ id: string }>>`SELECT id::text AS id FROM public.kb_articles WHERE organization_id = ${orgId}::uuid AND ${tag} = ANY(tags) ORDER BY created_at LIMIT 1`;
        let articleId = existing[0]?.id ?? null;
        let created = false;
        if (!articleId) {
            try {
                const a = kbArticle(issue, appName);
                const made = await this.kb.create({ orgId, userId: null, canWrite: true }, { title: a.title, body: a.body, tags: a.tags, status: "published", customerVisible: true, categoryId: await this.kbCategory(orgId) });
                articleId = made.id;
                created = true;
            } catch (e) {
                await this.prisma.$executeRaw`DELETE FROM public.auto_repair_kb WHERE organization_id = ${orgId}::uuid AND issue_id = ${issue.id} AND article_id IS NULL`;
                throw e;
            }
        }
        await this.prisma.$executeRaw`UPDATE public.auto_repair_kb SET article_id = ${articleId}::uuid WHERE organization_id = ${orgId}::uuid AND issue_id = ${issue.id}`;
        await this.link(ticketId, articleId);
        return { id: articleId, created };
    }
}
