// Workflow rules ("when this happens, do that") in process against a throwaway database (name has "e2e").
"use strict";
const path = require("node:path");
if (process.env.ADG_E2E_ALLOW !== "1" || !/e2e/.test(process.env.DATABASE_URL || "")) { console.error("Refusing to run: set ADG_E2E_ALLOW=1 and an e2e-named DATABASE_URL."); process.exit(2); }
process.env.JWT_SECRET ||= "e2e-only-not-a-real-secret-e2e-only-not-a-real-secret";
process.env.DATA_ENCRYPTION_KEY ||= "e2e-only-data-key";
process.env.IMAP_POLL_ENABLED = "false"; process.env.NODE_ENV = "development";
let passed = 0, failed = 0;
const check = (name, ok, extra) => { ok ? passed++ : failed++; console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && extra !== undefined ? `: ${JSON.stringify(extra)}` : ""}`); };
const fails = async (fn, re) => { try { await fn(); return false; } catch (e) { return re.test(JSON.stringify(e.response ?? e.message ?? e)); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    require("reflect-metadata");
    const dist = path.resolve(process.cwd(), "dist");
    const W = require(path.join(dist, "workflows/workflows.core.js"));

    // --- the rules of the engine ---
    const ok = { name: "Critical on servers", trigger: "alert.opened", conditions: [{ field: "severity", op: "is", value: "CRIT" }], actions: [{ type: "create_ticket", subject: "{{title}}", description: "", priority: "high" }] };
    check("a good rule validates", !!W.validateRule(ok).rule);
    check("a rule needs a name, a known trigger and an action", W.validateRule({ ...ok, name: "" }).errors.length === 1 && W.validateRule({ ...ok, trigger: "x" }).errors.length >= 1 && W.validateRule({ ...ok, actions: [] }).errors.length === 1);
    check("a condition can only use what the trigger offers", W.validateRule({ ...ok, conditions: [{ field: "priority", op: "is", value: "x" }] }).errors[0].includes("priority"));
    check("running a script needs a computer, which a ticket rule does not have", W.validateRule({ name: "n", trigger: "ticket.created", conditions: [], actions: [{ type: "run_script", scriptId: "11111111-1111-1111-1111-111111111111" }] }).errors[0].includes("needs a computer"));
    check("limits: five conditions, four actions", W.validateRule({ ...ok, conditions: Array(6).fill(ok.conditions[0]) }).errors.some((e) => /At most 5/.test(e)) && W.validateRule({ ...ok, actions: Array(5).fill(ok.actions[0]) }).errors.some((e) => /At most 4/.test(e)));
    check("the cool-down is kept between one minute and a week", W.validateRule({ ...ok, cooldownMinutes: 0 }).rule.cooldownMinutes === 1 && W.validateRule({ ...ok, cooldownMinutes: 999999 }).rule.cooldownMinutes === 10080 && W.validateRule({ ...ok, cooldownMinutes: "abc" }).rule.cooldownMinutes === 60);
    const facts = { device: "PC-1", severity: "CRIT", title: "Disk full on PC-1", client: "Acme Dental" };
    check("conditions ignore case and judge is / is not / contains / starts with", W.holds({ field: "client", op: "contains", value: "dental" }, facts) && W.holds({ field: "severity", op: "is", value: "crit" }, facts) && W.holds({ field: "severity", op: "is_not", value: "WARN" }, facts) && W.holds({ field: "title", op: "starts_with", value: "disk" }, facts) && !W.holds({ field: "client", op: "contains", value: "" }, facts) && W.holds({ field: "client", op: "not_contains", value: "xyz" }, facts));
    check("text is filled from facts and nothing else is evaluated", W.fill("{{title}} / {{ client }} / {{missing}} / ${process.exit(1)}", facts) === "Disk full on PC-1 / Acme Dental /  / ${process.exit(1)}");

    // --- against the database ---
    const { NestFactory } = require("@nestjs/core");
    const { AppModule } = require(path.join(dist, "app.module.js"));
    const { PrismaService } = require(path.join(dist, "storage/prisma.service.js"));
    const { WorkflowsService } = require(path.join(dist, "workflows/workflows.service.js"));
    const { TicketsService } = require(path.join(dist, "tickets/tickets.service.js"));
    const { NotifierService } = require(path.join(dist, "backups/notifier.service.js"));
    const { fireWorkflow } = require(path.join(dist, "workflows/workflows.bus.js"));
    const app = await NestFactory.createApplicationContext(AppModule, { logger: ["error"] });
    const prisma = app.get(PrismaService, { strict: false });
    const svc = app.get(WorkflowsService, { strict: false });
    const tickets = app.get(TicketsService, { strict: false });
    const sent = [];
    app.get(NotifierService, { strict: false }).send = async (_c, subject, body) => { if (/boom/.test(subject)) throw new Error("mail server down"); sent.push({ subject, body }); };

    const org = await prisma.organizations.upsert({ where: { slug: "default" }, create: { name: "Default Organization", slug: "default" }, update: {} });
    const stamp = Date.now();
    const client = await prisma.clients.create({ data: { organization_id: org.id, name: `Acme Dental ${stamp}` } });
    const site = await prisma.sites.create({ data: { client_id: client.id, name: "HQ" } });
    const mkDevice = (host, os = "Windows 11") => prisma.devices.create({ data: { site_id: site.id, hostname: host, operating_system: os } });
    const d1 = await mkDevice(`PC-A-${stamp}`), d2 = await mkDevice(`PC-B-${stamp}`);
    const mkAlert = (device, severity, title) => prisma.alerts.create({ data: { device_id: device.id, kind: "check", dedupe_key: `wf-${Math.random()}`, severity, title } });
    const countTickets = async (like) => Number((await prisma.$queryRaw`SELECT count(*)::int AS n FROM public.tickets WHERE subject LIKE ${like}`)[0].n);
    const runsOf = (ruleId) => prisma.$queryRaw`SELECT outcome, subject, steps FROM public.workflow_runs WHERE rule_id = ${ruleId}::uuid ORDER BY at`;

    const rule = await svc.create(org.id, null, { name: "Critical alert on Acme", trigger: "alert.opened", enabled: false, conditions: [{ field: "severity", op: "is", value: "CRIT" }, { field: "client", op: "contains", value: "Acme Dental" }], actions: [{ type: "create_ticket", subject: `WF {{severity}}: {{title}} ({{device}}) ${stamp}`, description: "Client {{client}}", priority: "high" }, { type: "notify", subject: "Critical on {{device}}", message: "{{title}}" }], cooldownMinutes: 30 });
    check("a new rule is off until it is switched on", rule.enabled === false && (await svc.list(org.id)).items.length === 1);

    const a1 = await mkAlert(d1, "CRIT", "Disk full");
    await svc.onEvent({ trigger: "alert.opened", alertId: a1.id, deviceId: d1.id });
    check("a disabled rule does nothing", (await countTickets(`WF %${stamp}`)) === 0 && (await runsOf(rule.id)).length === 0);

    await svc.setEnabled(org.id, rule.id, true);
    await svc.onEvent({ trigger: "alert.opened", alertId: a1.id, deviceId: d1.id });
    check("when the alert matches, the ticket is made with the facts filled in", (await countTickets(`WF CRIT: Disk full (${d1.hostname}) ${stamp}`)) === 1);
    check("and the notice is sent", sent.some((s) => s.subject === `Critical on ${d1.hostname}` && s.body === "Disk full"));
    let runs = await runsOf(rule.id);
    check("the run is logged with each step", runs.length === 1 && runs[0].outcome === "done" && runs[0].steps.length === 2 && runs[0].steps.every((s) => s.ok));

    await svc.onEvent({ trigger: "alert.opened", alertId: a1.id, deviceId: d1.id });
    check("the same computer inside the cool-down does not run it again", (await countTickets(`WF %${stamp}`)) === 1 && (await runsOf(rule.id)).length === 1);

    const a2 = await mkAlert(d2, "CRIT", "Service stopped");
    await svc.onEvent({ trigger: "alert.opened", alertId: a2.id, deviceId: d2.id });
    check("another computer runs it", (await countTickets(`WF %${stamp}`)) === 2);

    const a3 = await mkAlert(d1, "WARN", "Slow");
    const d3 = await mkDevice(`PC-C-${stamp}`);
    await svc.onEvent({ trigger: "alert.opened", alertId: a3.id, deviceId: d1.id });
    check("an alert that does not match (WARN) does nothing", (await countTickets(`WF %${stamp}`)) === 2);

    // ticket rules: a ticket made by a workflow starts no workflow
    const tRule = await svc.create(org.id, null, { name: "Every ticket", trigger: "ticket.created", enabled: true, conditions: [{ field: "subject", op: "contains", value: `LOOP ${stamp}` }], actions: [{ type: "create_ticket", subject: `LOOPED ${stamp}`, description: "", priority: "low" }], cooldownMinutes: 1 });
    const tid = await tickets.create({ subject: `LOOP ${stamp} please`, description: "x", priority: "medium", deviceId: d1.id }, { user: { organizationId: org.id, name: "Test" } }, { source: "ui" });
    for (let i = 0; i < 40 && (await countTickets(`LOOPED ${stamp}`)) < 1; i++) await wait(250);
    check("a ticket rule fires from a real ticket (through the event bus)", (await countTickets(`LOOPED ${stamp}`)) === 1, await countTickets(`LOOPED ${stamp}`));
    await wait(800);
    check("and the ticket it made did not start the rule again", (await countTickets(`LOOPED ${stamp}`)) === 1 && (await runsOf(tRule.id)).length === 1);

    // one failed step does not stop the others
    const pRule = await svc.create(org.id, null, { name: "Partial", trigger: "device.registered", enabled: true, conditions: [{ field: "os", op: "contains", value: "windows" }], actions: [{ type: "notify", subject: "boom", message: "" }, { type: "create_ticket", subject: `NEW PC {{device}} ${stamp}`, description: "", priority: "medium" }], cooldownMinutes: 5 });
    await svc.onEvent({ trigger: "device.registered", deviceId: d3.id });
    runs = await runsOf(pRule.id);
    check("a failed step is recorded and the next step still runs", runs.length === 1 && runs[0].outcome === "partial" && runs[0].steps[0].ok === false && /mail server down/.test(runs[0].steps[0].text) && (await countTickets(`NEW PC ${d3.hostname} ${stamp}`)) === 1, runs);
    const dLinux = await mkDevice(`LNX-${stamp}`, "Ubuntu 24.04");
    await svc.onEvent({ trigger: "device.registered", deviceId: dLinux.id });
    check("the operating system condition is honoured", (await runsOf(pRule.id)).length === 1);

    // an enrollment through the bus
    const bRule = await svc.create(org.id, null, { name: "Bus", trigger: "device.registered", enabled: true, conditions: [{ field: "device", op: "starts_with", value: "BUS-" }], actions: [{ type: "notify", subject: `Bus saw {{device}} ${stamp}`, message: "" }], cooldownMinutes: 5 });
    const dBus = await mkDevice(`BUS-${stamp}`);
    fireWorkflow({ trigger: "device.registered", deviceId: dBus.id });
    await wait(1200);
    check("events from the application reach the rules", sent.some((s) => s.subject === `Bus saw BUS-${stamp} ${stamp}`));

    // hourly limit
    const hRule = await svc.create(org.id, null, { name: "Busy", trigger: "alert.opened", enabled: true, conditions: [], actions: [{ type: "notify", subject: `busy ${stamp}`, message: "" }], cooldownMinutes: 1 });
    for (let i = 0; i < 30; i++) await prisma.$executeRaw`INSERT INTO public.workflow_runs (rule_id, trigger, subject, outcome) VALUES (${hRule.id}::uuid, 'alert.opened', ${`other-${i}`}, 'done')`;
    const before = sent.filter((s) => s.subject === `busy ${stamp}`).length;
    await svc.onEvent({ trigger: "alert.opened", alertId: a2.id, deviceId: d2.id });
    await svc.onEvent({ trigger: "alert.opened", alertId: a2.id, deviceId: d2.id });
    const skipped = (await runsOf(hRule.id)).filter((r) => r.outcome === "skipped");
    check("a rule that ran 30 times in an hour stops, says so once, and does not run", sent.filter((s) => s.subject === `busy ${stamp}`).length === before && skipped.length === 1);

    // preview and editing
    const pv = await svc.preview(org.id, rule.id);
    check("preview says whether the newest event would match and runs nothing", pv.sample && typeof pv.wouldRun === "boolean" && (await countTickets(`WF %${stamp}`)) === 2);
    const edited = await svc.update(org.id, rule.id, { name: "Renamed", trigger: "alert.opened", enabled: true, conditions: [], actions: [{ type: "notify", subject: "x", message: "" }] });
    check("a rule can be edited", edited.name === "Renamed" && edited.conditions.length === 0);
    check("a bad edit is refused in plain words", await fails(() => svc.update(org.id, rule.id, { name: "", trigger: "alert.opened", actions: [] }), /Give the rule a name/));
    check("a rule that runs a script that does not exist is refused", await fails(() => svc.create(org.id, null, { name: "S", trigger: "alert.opened", conditions: [], actions: [{ type: "run_script", scriptId: "22222222-2222-2222-2222-222222222222" }] }), /does not exist/));
    check("the log lists the runs with the rule name", (await svc.runs(org.id)).items.some((r) => r.rule === "Critical alert on Acme" || r.rule === "Renamed"));
    check("a rule can be deleted with its runs", (await svc.remove(org.id, rule.id)).ok && (await runsOf(rule.id)).length === 0 && await fails(() => svc.remove(org.id, rule.id), /not found/));

    // --- more triggers and actions ---
    const tech = (await prisma.$queryRaw`SELECT id FROM public.users LIMIT 1`)[0];
    check("set priority and assign need a ticket: refused after a notice, fine after a ticket is made or from a ticket rule", W.validateRule({ name: "n", trigger: "device.offline", conditions: [], actions: [{ type: "set_priority", priority: "high" }] }).errors[0].includes("needs a ticket") && !!W.validateRule({ name: "n", trigger: "device.offline", conditions: [], actions: [ok.actions[0], { type: "set_priority", priority: "high" }] }).rule && !!W.validateRule({ name: "n", trigger: "ticket.created", conditions: [], actions: [{ type: "assign", userId: "11111111-1111-1111-1111-111111111111" }] }).rule);
    check("the ready-made rules are all valid and none is switched on", W.TEMPLATES.length >= 4 && W.TEMPLATES.every((t) => { const r = W.validateRule({ ...t.rule, enabled: false }); return !!r.rule && r.rule.enabled === false; }), W.TEMPLATES.map((t) => W.validateRule(t.rule).errors));
    await svc.create(org.id, null, { name: "Offline", trigger: "device.offline", enabled: true, conditions: [{ field: "client", op: "contains", value: "Acme Dental" }], actions: [{ type: "create_ticket", subject: `OFFLINE {{device}} ${stamp}`, description: "", priority: "low" }, { type: "set_priority", priority: "urgent" }, ...(tech ? [{ type: "assign", userId: tech.id }] : [])], cooldownMinutes: 5 });
    const aOff = await prisma.alerts.create({ data: { device_id: d2.id, kind: "offline", dedupe_key: `off-${stamp}`, severity: "CRIT", title: "Offline" } });
    await svc.onEvent({ trigger: "device.offline", alertId: aOff.id, deviceId: d2.id });
    const ot = (await prisma.$queryRaw`SELECT priority::text AS priority, assignee_user_id FROM public.tickets WHERE subject = ${`OFFLINE ${d2.hostname} ${stamp}`}`)[0];
    check("offline trigger: the ticket is made, its priority is raised and it is assigned", !!ot && ot.priority === "urgent" && (!tech || ot.assignee_user_id === tech.id), ot);
    const pRule2 = await svc.create(org.id, null, { name: "Patch", trigger: "patch.failed", enabled: true, conditions: [{ field: "kind", op: "is", value: "patch_install" }, { field: "reason", op: "contains", value: "0x8007" }], actions: [{ type: "create_ticket", subject: `PATCH {{device}} ${stamp}: {{reason}}`, description: "", priority: "medium" }], cooldownMinutes: 5 });
    await svc.onEvent({ trigger: "patch.failed", deviceId: d1.id, source: "patch_scan", reason: "0x80070005" });
    check("patch trigger: a scan failure does not match an install-only rule", (await countTickets(`PATCH %${stamp}%`)) === 0);
    await svc.onEvent({ trigger: "patch.failed", deviceId: d1.id, source: "patch_install", reason: "Error 0x80070005 access denied" });
    check("patch trigger: an install failure with the reason makes the ticket with the reason in it", (await countTickets(`PATCH ${d1.hostname} ${stamp}: Error 0x80070005%`)) === 1);
    const pv2 = await svc.preview(org.id, pRule2.id);
    check("preview works for the new triggers", pv2.sample && pv2.sample.kind === "patch_install");
    check("the workflow event for a failed update is fired when a patch task completes with a failure", await (async () => {
        const { AgentsTasksService: AgentTasksService } = require(path.join(dist, "agents/agents.tasks.service.js"));
        const ats = app.get(AgentTasksService, { strict: false });
        const ag = await prisma.agents.create({ data: { device_id: d3.id, agent_uuid: require("node:crypto").randomUUID(), version: "1.3.50", last_check_in_at: new Date(), facts: {}, hostname: d3.hostname } });
        const task = await prisma.agent_tasks.create({ data: { agent_id: ag.id, type: "patch_install", payload: {}, status: "running" } });
        const run = await prisma.agent_task_runs.create({ data: { task_id: task.id, status: "running" } });
        const seen = []; const bus = require(path.join(dist, "workflows/workflows.bus.js")).workflowBus; const l = (e) => seen.push(e); bus.on("event", l);
        await ats.completeRun({ agentId: ag.id, taskId: task.id, runId: run.id, status: "failed", stdout: null, stderr: "boom 0x800f0922", output: null, artifacts: null });
        await wait(400); bus.off("event", l);
        return seen.some((e) => e.trigger === "patch.failed" && e.deviceId === d3.id && /0x800f0922/.test(e.reason) && e.source === "patch_install");
    })());

    await app.close();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
