// The automatic repair loop against a real database, in process, with a fake agent that answers the signed script jobs with scripted output:
// each category's checks, repair and verify, the reply and status the person sees, what goes to a technician, the guardrails, and that a KB article is
// written once per kind of problem and never twice (also when two repairs finish at the same moment). Throwaway database only (name has "e2e").
"use strict";
const crypto = require("node:crypto");
const path = require("node:path");

if (process.env.ADG_E2E_ALLOW !== "1" || !/e2e/.test(process.env.DATABASE_URL || "")) { console.error("Refusing to run: set ADG_E2E_ALLOW=1 and an e2e-named DATABASE_URL."); process.exit(2); }
process.env.JWT_SECRET ||= "e2e-only-not-a-real-secret-e2e-only-not-a-real-secret";
process.env.DATA_ENCRYPTION_KEY ||= "e2e-only-data-key";
process.env.IMAP_POLL_ENABLED = "false"; process.env.NODE_ENV = "development";

let passed = 0, failed = 0;
const check = (name, ok, extra) => { ok ? passed++ : failed++; console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && extra !== undefined ? `: ${JSON.stringify(extra)}` : ""}`); };
const fails = async (fn, re) => { try { await fn(); return false; } catch (e) { return re.test(JSON.stringify(e.response ?? e.message ?? e)); } };

(async () => {
    require("reflect-metadata");
    const { NestFactory } = require("@nestjs/core");
    const dist = path.resolve(process.cwd(), "dist");
    const { AppModule } = require(path.join(dist, "app.module.js"));
    const { PrismaService } = require(path.join(dist, "storage/prisma.service.js"));
    const { DeviceTrayService } = require(path.join(dist, "device-tray/device-tray.service.js"));
    const { AutoRepairService } = require(path.join(dist, "auto-repair/auto-repair.service.js"));
    const C = require(path.join(dist, "auto-repair/auto-repair.core.js"));
    const S = require(path.join(dist, "auto-repair/auto-repair.scripts.js"));
    const app = await NestFactory.createApplicationContext(AppModule, { logger: process.env.ADG_TEST_WARN ? ["error", "warn"] : ["error"] });
    const prisma = app.get(PrismaService, { strict: false });
    const tray = app.get(DeviceTrayService, { strict: false });
    const repair = app.get(AutoRepairService, { strict: false });
    const { PlaybooksService } = require(path.join(dist, "auto-repair/playbooks.service.js"));
    const P = require(path.join(dist, "auto-repair/playbooks.core.js"));
    const playbooks = app.get(PlaybooksService, { strict: false });

    const org = await prisma.organizations.upsert({ where: { slug: "default" }, create: { name: "Default Organization", slug: "default" }, update: {} });
    const stamp = Date.now();
    const client = await prisma.clients.create({ data: { organization_id: org.id, name: `AutoRepair ${stamp}` } });
    const site = await prisma.sites.create({ data: { client_id: client.id, name: "HQ" } });
    await prisma.$executeRaw`INSERT INTO public.tray_settings (organization_id, enabled, help_enabled, chat_enabled) VALUES (${org.id}::uuid, true, true, true) ON CONFLICT (organization_id) DO UPDATE SET enabled = true, help_enabled = true`;
    let healOn = false;
    const setRepair = (enabled, autoRepair = true, createKb = true) => prisma.$executeRaw`INSERT INTO public.auto_repair_settings (organization_id, enabled, auto_repair, create_kb, self_healing) VALUES (${org.id}::uuid, ${enabled}, ${autoRepair}, ${createKb}, ${healOn}) ON CONFLICT (organization_id) DO UPDATE SET enabled = ${enabled}, auto_repair = ${autoRepair}, create_kb = ${createKb}, self_healing = ${healOn}`;
    await setRepair(true);

    let seq = 0;
    async function device(label, os = "windows") {
        const d = await prisma.devices.create({ data: { site_id: site.id, hostname: `AR-${label}-${stamp}-${++seq}`, operating_system: os === "windows" ? "Windows 11 Pro" : os === "mac" ? "macOS 14" : "Ubuntu 24.04" } });
        const a = await prisma.agents.create({ data: { device_id: d.id, agent_uuid: crypto.randomUUID(), version: "1.3.46", last_check_in_at: new Date(), facts: { os } } });
        return { d, a };
    }
    const jobOf = async (dev, tool) => (await prisma.jobs.findMany({ where: { agent_id: dev.a.id }, orderBy: { created_at: "desc" } })).find((j) => j.payload?.env?.ADG_TOOL === tool);
    async function answer(dev, tool, stdout, status = "succeeded", stderr = "") {
        const j = await jobOf(dev, tool);
        await prisma.jobs.update({ where: { id: j.id }, data: { status, finished_at: new Date() } });
        await prisma.job_results.upsert({ where: { job_id: j.id }, create: { job_id: j.id, exit_code: 0, stdout, stderr, duration_ms: 5n }, update: { stdout, stderr } });
        return j;
    }
    const ask = (dev, extra = {}) => tray.help(dev.a.id, { message: "It does not work", user: "ACME\\sam", name: "Sam", email: "sam@acme.example", phone: "555-0123", ...extra });
    const ticketOf = async (n) => (await prisma.tickets.findFirst({ where: { organization_id: org.id, ticket_number: BigInt(n) } }));
    const run = async (ticketId) => (await prisma.$queryRaw`SELECT * FROM public.auto_repair_runs WHERE ticket_id = ${ticketId}::uuid ORDER BY created_at DESC LIMIT 1`)[0];
    const acts = (ticketId) => prisma.ticket_activity.findMany({ where: { ticket_id: ticketId }, orderBy: { created_at: "asc" } });
    const articlesFor = async (issue) => prisma.$queryRaw`SELECT id::text AS id, status, customer_visible, title, body, tags FROM public.kb_articles WHERE organization_id = ${org.id}::uuid AND ${`auto-repair-${issue}`} = ANY(tags)`;
    const linked = async (ticketId) => (await prisma.$queryRaw`SELECT article_id::text AS a FROM public.kb_ticket_links WHERE ticket_id = ${ticketId}::uuid`).map((r) => r.a);

    // ------------------------------------------------------------ the catalog and the scripts' text
    console.log("catalog");
    check("every category has checks", C.CATEGORIES.every((c) => C.checksFor(c, c === C.SOFTWARE_CATEGORY ? { name: "Notepad", publisher: null, version: null } : null).length > 0), C.CATEGORIES.map((c) => [c, C.checksFor(c, null)]));
    check("only Software Issue looks at a program: the program adds the crash check, and Teams the Teams check", C.checksFor("Software Issue", { name: "Microsoft Teams", publisher: null, version: null }).join() === "disk,reboot,crash,teams" && !C.checksFor("Printing", { name: "Microsoft Teams", publisher: null, version: null }).includes("crash"));
    check("a diagnosis keeps only known problems and known line shapes", (() => { const d = C.parseDiagnosis("INFO a_b|1\nISSUE nonsense|x\nISSUE low-disk|Only 3 GB\nnoise\nISSUE low-disk|again\nDONE"); return d.complete && d.issues.length === 1 && d.issues[0].id === "low-disk" && d.info.a_b === "1"; })());
    check("every problem names its kind and the ones with a repair have text for the KB", Object.values(C.ISSUES).every((i) => ["repair", "advice", "escalate"].includes(i.kind) && i.title && i.signs && i.ifItReturns && (i.kind !== "repair" || i.fix) && (i.kind !== "advice" || i.advice)));
    check("the scripts take their input from environment variables only (no program name pasted in)", !/\$\{/.test(S.DIAGNOSE_SCRIPT + S.REPAIR_SCRIPT) && /ADG_APP/.test(S.DIAGNOSE_SCRIPT) && /ADG_FIX/.test(S.REPAIR_SCRIPT));

    // ------------------------------------------------------------ what is asked for
    console.log("what a ticket asks for");
    const d0 = await device("ask");
    check("a bad category is refused", await fails(() => ask(d0, { category: "Gardening" }), /categories/));
    check("Software Issue without a program is refused", await fails(() => ask(d0, { category: "Software Issue" }), /which program/));
    const sw = await ask(d0, { category: "Software Issue", appName: "Microsoft Teams", appPublisher: "Microsoft Corporation", appVersion: "24.1" });
    let t = await ticketOf(sw.ticket.number);
    const row = (await prisma.$queryRaw`SELECT category, app_name, app_publisher FROM public.tray_help_requests WHERE ticket_id = ${t.id}::uuid`)[0];
    check("the category and the program are kept and shown on the ticket", row.category === "Software Issue" && row.app_name === "Microsoft Teams" && /Category: Software Issue/.test(t.description) && /Program: Microsoft Teams \(Microsoft Corporation, 24\.1\)/.test(t.description));
    const j0 = await jobOf(d0, S.DIAGNOSE_KIND);
    check("the checks are queued as a signed script job with the checks and the program in its environment", j0 && j0.payload.env.ADG_CHECKS === "disk,reboot,crash,teams" && j0.payload.env.ADG_APP === "Microsoft Teams" && j0.payload.language === "powershell", j0?.payload);
    const pr = await ask(await device("printing-ignored"), { category: "Printing", appName: "Microsoft Teams" });
    check("another category ignores a program (it is not stored)", (await prisma.$queryRaw`SELECT app_name FROM public.tray_help_requests h JOIN public.tickets t ON t.id = h.ticket_id WHERE t.ticket_number = ${BigInt(pr.ticket.number)}`)[0].app_name === null);

    // ------------------------------------------------------------ the whole loop: print spooler
    console.log("who asked");
    const dq = await device("requester");
    await prisma.customer_contacts.create({ data: { client_id: client.id, name: "James Bond", email: "shared@acme.example", role: "other" } });
    const q1 = await ask(dq, { email: "shared@acme.example", name: "Jane Doe" });
    const cq = (await prisma.$queryRaw`SELECT c.name, c.email FROM public.tickets t JOIN public.customer_contacts c ON c.id = t.requester_customer_contact_id WHERE t.ticket_number = ${BigInt(q1.ticket.number)} AND t.organization_id = ${org.id}::uuid`)[0];
    check("the requester is the person who typed their name, even when an older contact has the same email address", cq.name === "Jane Doe" && cq.email === "shared@acme.example", cq);
    const q2 = await ask(dq, { email: "shared@acme.example", name: "Jane Doe" });
    const cq2 = (await prisma.$queryRaw`SELECT count(*)::int AS n FROM public.customer_contacts WHERE client_id = ${client.id}::uuid AND lower(name) = 'jane doe'`)[0];
    check("the same person asking again reuses their contact (no duplicates)", cq2.n === 1, cq2);

    console.log("diagnose, repair, verify");
    const dp = await device("print");
    const p1 = await ask(dp, { category: "Printing" });
    t = await ticketOf(p1.ticket.number);
    check("a run starts for the category", (await run(t.id)).state === "diagnosing" && (await jobOf(dp, S.DIAGNOSE_KIND)).payload.env.ADG_CHECKS === "printing,disk");
    await answer(dp, S.DIAGNOSE_KIND, "INFO host|X\nISSUE spooler-stopped|The Print Spooler service is Stopped\nDONE");
    await repair.tick();
    let r = await run(t.id);
    const rj = await jobOf(dp, S.REPAIR_KIND);
    check("a known problem with a repair gets the repair job, naming only that problem", r.state === "repairing" && rj && rj.payload.env.ADG_FIX === "spooler-stopped" && r.repair_issues.join() === "spooler-stopped", { s: r.state, env: rj?.payload?.env });
    await answer(dp, S.REPAIR_KIND, "FIXED spooler-stopped|The Print Spooler is running again.\nDONE");
    await repair.tick();
    check("then the checks run again to verify", (await run(t.id)).state === "verifying");
    check("the confirming checks only count crashes after the repair (the event log keeps the old ones for ever)", (await jobOf(dp, S.DIAGNOSE_KIND)).payload.env.ADG_SINCE && !Number.isNaN(Date.parse((await jobOf(dp, S.DIAGNOSE_KIND)).payload.env.ADG_SINCE)) && /ADG_SINCE/.test(S.DIAGNOSE_SCRIPT));
    await answer(dp, S.DIAGNOSE_KIND, "INFO host|X\nINFO spooler|Running\nDONE");
    await repair.tick();
    r = await run(t.id); t = await ticketOf(p1.ticket.number);
    const a1 = await acts(t.id);
    const publicMsg = a1.find((a) => a.kind === "message" && !a.is_internal && a.author === C.AUTO_AUTHOR);
    check("fixed and verified: the person is told what was found and done, and to test again", r.state === "awaiting_user" && publicMsg && /Print Spooler/.test(publicMsg.body) && /try it again/i.test(publicMsg.body) && /Still not working/.test(publicMsg.body), publicMsg?.body);
    check("the ticket waits for the person (pending), and technicians have a note of what ran", t.status === "pending" && a1.some((a) => a.is_internal && /Automatic checks and repair/.test(a.body) && /worked/.test(a.body)));
    const arts = await articlesFor("spooler-stopped");
    check("the KB article was written once: published, visible to customers, with the signs, the fix and what to do if it returns", arts.length === 1 && arts[0].status === "published" && arts[0].customer_visible && /Known fix/.test(arts[0].body) && /Started the Print Spooler/.test(arts[0].body) && /If it comes back/.test(arts[0].body), arts[0]);
    check("the ticket is linked to the article", (await linked(t.id)).includes(arts[0].id));
    const st = await tray.status(dp.a.id);
    check("the tray learns the repair is waiting for the person to test", st.tickets.find((x) => x.number === p1.ticket.number)?.autoRepair === "awaiting_user");

    console.log("everything the system does is written on the ticket for technicians");
    const log = (await acts(t.id)).filter((a) => a.author === C.AUTO_AUTHOR);
    const internalLog = log.filter((a) => a.is_internal).map((a) => a.body);
    const has = (re) => internalLog.some((x) => re.test(x));
    check("the log starts with what the person picked, the checks chosen and what happens next", has(/Automatic repair started for this ticket/) && has(/They picked: Printing/) && has(/Checks chosen for that category: printing, disk/) && has(/Every step is written here/));
    check("it shows the first script in full: its purpose, job, how it runs, what it was given and its text", has(/Script sent to the computer: 1\. Checks \(read only\)[\s\S]*Purpose:[\s\S]*job [0-9a-f-]{36}[\s\S]*Given: ADG_CHECKS=printing,disk; ADG_APP=\(empty\)[\s\S]*\$ErrorActionPreference[\s\S]*ISSUE/));
    check("it shows what the first script returned: status, exit code, time and the full output", has(/Script result: 1\. Checks \(read only\)\nJob [0-9a-f-]{36}: succeeded, exit code 0, took [\d.]+ s[\s\S]*Output:\nINFO host\|X\nISSUE spooler-stopped\|The Print Spooler service is Stopped\nDONE/));
    check("it explains the decision: what was found, its kind, and what will be repaired", has(/Decision after the checks:[\s\S]*spooler-stopped \(repair\)[\s\S]*Repairing automatically: spooler-stopped: Started the Print Spooler/));
    check("it shows the repair script in full with what it was told to repair, and what it returned", has(/Script sent to the computer: 2\. Repair[\s\S]*Given: ADG_FIX=spooler-stopped[\s\S]*Set-Service/) && has(/Script result: 2\. Repair[\s\S]*FIXED spooler-stopped\|The Print Spooler is running again\./));
    check("it records the decision after the repair and the confirming run (the script is referred to, not repeated)", has(/Decision after the repair:[\s\S]*spooler-stopped: the repair says it worked/) && has(/Script sent to the computer: 3\. Checks again[\s\S]*the same as the first check above/) && has(/Script result: 3\. Checks again/));
    check("it records the confirmation, the reply sent to the person, the ticket status and the knowledge base", has(/Decision after the confirming checks:[\s\S]*is gone\. The repair is confirmed/) && has(/Reply sent to the person in the tray window/) && has(/Ticket status: set to pending, waiting for the person to test/) && has(/Knowledge base: a new article was written for spooler-stopped/));
    check("every line of that log is internal (technicians only) except the reply the person is meant to read", log.filter((a) => !a.is_internal).length === 1);
    const order = (await acts(t.id)).filter((a) => a.is_internal && a.author === C.AUTO_AUTHOR).map((a) => a.body.split("\n")[0]);
    check("the log is in the order things happened", order.indexOf("Automatic repair started for this ticket.") < order.findIndex((x) => /^Script result: 1\./.test(x)) && order.findIndex((x) => /^Script result: 1\./.test(x)) < order.findIndex((x) => /^Script result: 2\./.test(x)) && order.findIndex((x) => /^Script result: 2\./.test(x)) < order.findIndex((x) => /^Script result: 3\./.test(x)), order);

    console.log("the person answers");
    await tray.ticketReplyFromDevice(dp.a.id, p1.ticket.number, { message: "Still nothing prints", user: "ACME\\sam", name: "Sam" });
    r = await run(t.id); t = await ticketOf(p1.ticket.number);
    check("still not working: it waits for a technician (open, with a note) and no more automatic steps", r.state === "not_fixed" && t.status === "open" && (await acts(t.id)).some((a) => a.is_internal && /still there/.test(a.body)));
    const p2 = await ask(await device("print2"), { category: "Printing" });
    const dp2 = { a: { id: (await prisma.agents.findFirst({ where: { devices: { hostname: { startsWith: `AR-print2-${stamp}` } } } })).id } };
    await answer(dp2, S.DIAGNOSE_KIND, "ISSUE spooler-stopped|Stopped\nDONE"); await repair.tick();
    await answer(dp2, S.REPAIR_KIND, "FIXED spooler-stopped|ok\nDONE"); await repair.tick();
    await answer(dp2, S.DIAGNOSE_KIND, "DONE"); await repair.tick();
    const t2 = await ticketOf(p2.ticket.number);
    await tray.ticketResolveFromDevice(dp2.a.id, p2.ticket.number, { reason: "It prints again, thank you", user: "ACME\\kim", name: "Kim" });
    check("it's fixed: the run is confirmed fixed", (await run(t2.id)).state === "confirmed_fixed");
    check("the person's answers are written on the ticket: the test result, and for the other ticket that it is still not working", (await acts(t2.id)).some((a) => a.is_internal && /tested it and says it is fixed/.test(a.body)) && (await acts(t.id)).some((a) => a.is_internal && /says the problem is still there[\s\S]*No further automatic steps/.test(a.body)));
    check("the second ticket's log says the article already existed and was linked, not written again", (await acts(t2.id)).some((a) => a.is_internal && /already has an article[\s\S]*no second one was written/.test(a.body)));

    console.log("a KB article is never written twice");
    check("the same problem on another computer reuses the article: still one, counted twice, and linked to the second ticket", (await articlesFor("spooler-stopped")).length === 1 && (await linked(t2.id)).includes(arts[0].id) && (await prisma.$queryRaw`SELECT seen_count FROM public.auto_repair_kb WHERE organization_id = ${org.id}::uuid AND issue_id = 'spooler-stopped'`)[0].seen_count === 2, { arts: (await articlesFor("spooler-stopped")).length, linked2: await linked(t2.id), kb: await prisma.$queryRaw`SELECT * FROM public.auto_repair_kb`, run2: await run(t2.id) });
    const issue = C.ISSUES["dns-failing"];
    const [x, y, z] = await Promise.all([repair.ensureArticle(org.id, issue, null, t.id), repair.ensureArticle(org.id, issue, null, t2.id), repair.ensureArticle(org.id, issue, null, t.id)]);
    const dnsArts = await articlesFor("dns-failing");
    check("three repairs of a new problem at the same moment write exactly one article", dnsArts.length === 1, { n: dnsArts.length, x, y, z });
    check("an article someone already wrote and tagged for the problem is used, not duplicated", await (async () => {
        const id = crypto.randomUUID();
        await prisma.kb_articles.create({ data: { id, organization_id: org.id, title: "Written by hand", body: "x", tags: ["auto-repair", "auto-repair-time-not-synced"], status: "published" } });
        await repair.ensureArticle(org.id, C.ISSUES["time-not-synced"], null, t.id);
        const n = (await articlesFor("time-not-synced")).length;
        const ok = n === 1 && (await linked(t.id)).includes(id);
        if (!ok) console.log("   detail", n, await linked(t.id), id, await prisma.$queryRaw`SELECT * FROM public.auto_repair_kb WHERE issue_id = 'time-not-synced'`);
        return ok;
    })());
    check("an article that was deleted is written again once (not many times)", await (async () => {
        const [gone] = await articlesFor("dns-failing");
        await prisma.kb_articles.delete({ where: { id: gone.id } });
        await Promise.all([repair.ensureArticle(org.id, issue, null, t.id), repair.ensureArticle(org.id, issue, null, t2.id)]);
        return (await articlesFor("dns-failing")).length === 1;
    })());

    console.log("when it does not go to plan");
    const dn = await device("none");
    const n1 = await ask(dn, { category: "Slow computer" }); const tn = await ticketOf(n1.ticket.number);
    await answer(dn, S.DIAGNOSE_KIND, "INFO uptime_days|3\nDONE"); await repair.tick();
    check("nothing found: a technician is told, the person is told they will be contacted, no repair ran", (await run(tn.id)).state === "no_issue_found" && !(await jobOf(dn, S.REPAIR_KIND)) && (await acts(tn.id)).some((a) => !a.is_internal && /did not find anything/.test(a.body)) && (await articlesFor("low-disk")).length === 0);
    const dv = await device("verify");
    const v1 = await ask(dv, { category: "Slow computer" }); const tv = await ticketOf(v1.ticket.number);
    await answer(dv, S.DIAGNOSE_KIND, "ISSUE low-disk|Only 2 GB\nDONE"); await repair.tick();
    await answer(dv, S.REPAIR_KIND, "FIXED low-disk|freed 1 GB\nDONE"); await repair.tick();
    await answer(dv, S.DIAGNOSE_KIND, "ISSUE low-disk|Only 2 GB\nDONE"); await repair.tick();
    check("a repair that said it worked but the check still finds the problem goes to a technician, and writes no article", (await run(tv.id)).state === "needs_technician" && (await articlesFor("low-disk")).length === 0 && /still finds/.test((await run(tv.id)).outcome));
    const df = await device("failed");
    const f1 = await ask(df, { category: "Printing" }); const tf = await ticketOf(f1.ticket.number);
    await answer(df, S.DIAGNOSE_KIND, "ISSUE spooler-stuck-jobs|3 files\nDONE"); await repair.tick();
    await answer(df, S.REPAIR_KIND, "FAILED spooler-stuck-jobs|could not clear\nDONE"); await repair.tick();
    check("a repair that failed goes to a technician with its reason", (await run(tf.id)).state === "needs_technician" && (await acts(tf.id)).some((a) => a.is_internal && /did not work: could not clear/.test(a.body)));
    const dc = await device("crashed");
    const c1 = await ask(dc, { category: "Printing" }); const tc = await ticketOf(c1.ticket.number);
    await answer(dc, S.DIAGNOSE_KIND, "", "failed", "access denied"); await repair.tick();
    check("checks that could not run go to a technician with the reason", (await run(tc.id)).state === "needs_technician" && /could not run/.test((await run(tc.id)).outcome));
    const dd = await device("same");
    const s1 = await ask(dd, { category: "Printing" }); const ts1 = await ticketOf(s1.ticket.number);
    await answer(dd, S.DIAGNOSE_KIND, "ISSUE spooler-stopped|Stopped\nDONE"); await repair.tick(); await answer(dd, S.REPAIR_KIND, "FIXED spooler-stopped|ok\nDONE"); await repair.tick(); await answer(dd, S.DIAGNOSE_KIND, "DONE"); await repair.tick();
    const s2 = await ask(dd, { category: "Printing" }); const ts2 = await ticketOf(s2.ticket.number);
    await answer(dd, S.DIAGNOSE_KIND, "ISSUE spooler-stopped|Stopped again\nDONE"); await repair.tick();
    check("the same problem repaired again the same day on the same computer is not repaired again: a technician is asked why it came back", (await run(ts2.id)).state === "needs_technician" && (await prisma.$queryRaw`SELECT repair_job_id FROM public.auto_repair_runs WHERE ticket_id = ${ts2.id}::uuid`)[0].repair_job_id === null && (await acts(ts2.id)).some((a) => a.is_internal && /already repaired automatically today/.test(a.body)));

    console.log("every category");
    const ds = await device("cat");
    async function category(cat, diagOut, extra = {}) {
        const dev = await device(`c-${cat.replace(/\W/g, "")}`);
        const q = await ask(dev, { category: cat, ...extra }); const tk = await ticketOf(q.ticket.number);
        await answer(dev, S.DIAGNOSE_KIND, diagOut); await repair.tick();
        const rr = await run(tk.id); const tt = await ticketOf(q.ticket.number);
        return { rr, tt, dev, tk, notes: await acts(tk.id) };
    }
    let k = await category("Internet or network", "ISSUE dns-failing|lookups fail\nDONE");
    check("network: name lookups failing gets the DNS repair", k.rr.state === "repairing" && (await jobOf(k.dev, S.REPAIR_KIND)).payload.env.ADG_FIX === "dns-failing");
    k = await category("Internet or network", "ISSUE gateway-unreachable|The router does not answer\nDONE");
    check("network: an unreachable router asks the person to check the cable (advice) and waits for them", k.rr.state === "awaiting_user" && !(await jobOf(k.dev, S.REPAIR_KIND)) && k.tt.status === "pending" && k.notes.some((a) => !a.is_internal && /network cable/.test(a.body)));
    k = await category("Internet or network", "ISSUE no-internet|down\nDONE");
    check("network: no internet at all goes to a technician", k.rr.state === "needs_technician" && !(await jobOf(k.dev, S.REPAIR_KIND)));
    k = await category("Sign-in or password", "ISSUE time-not-synced|stopped\nDONE");
    check("sign-in: a clock that is not synchronised gets the time repair", k.rr.state === "repairing" && (await jobOf(k.dev, S.REPAIR_KIND)).payload.env.ADG_FIX === "time-not-synced");
    k = await category("Sign-in or password", "ISSUE secure-channel-broken|broken\nDONE");
    check("sign-in: a broken domain trust goes to a technician at high priority", k.rr.state === "needs_technician" && k.tt.priority === "high");
    k = await category("Security concern", "ISSUE defender-realtime-off|off\nDONE");
    check("security: switched-off virus protection gets repaired", k.rr.state === "repairing" && (await jobOf(k.dev, S.REPAIR_KIND)).payload.env.ADG_FIX === "defender-realtime-off");
    await answer(k.dev, S.REPAIR_KIND, "FIXED defender-realtime-off|on\nDONE"); await repair.tick(); await answer(k.dev, S.DIAGNOSE_KIND, "DONE"); await repair.tick();
    const tsec = await ticketOf(k.tk.ticket_number);
    check("security: even when fixed, the ticket stays open for a technician and its priority is raised", (await run(k.tk.id)).state === "awaiting_user" && tsec.status === "open" && tsec.priority === "high");
    k = await category("Security concern", "ISSUE firewall-off|The firewall is off for: Domain\nDONE");
    check("security: a firewall that is off is not switched on by itself: a technician is told, at high priority", k.rr.state === "needs_technician" && k.tt.priority === "high" && !(await jobOf(k.dev, S.REPAIR_KIND)));
    k = await category("Hardware", "ISSUE disk-unhealthy|Disk reports Warning\nDONE");
    check("hardware: an unhealthy disk goes straight to a technician at high priority", k.rr.state === "needs_technician" && k.tt.priority === "high");
    k = await category("Email", "ISSUE mail-unreachable|no answer\nISSUE outlook-crashing|3 times\nDONE");
    check("email: problems that only a technician can look at go to one, with everything found in the note", k.rr.state === "needs_technician" && k.notes.some((a) => a.is_internal && /Outlook closed|Outlook keeps closing/.test(a.body)));
    k = await category("Slow computer", "ISSUE pending-reboot|10 days\nDONE");
    check("slow computer: a computer that needs a restart is asked to restart (advice)", k.rr.state === "awaiting_user" && k.notes.some((a) => !a.is_internal && /restart the computer/.test(a.body)));
    k = await category("Other", "INFO uptime_days|2\nDONE");
    check("other: checks run and a technician takes over when nothing is found", k.rr.state === "no_issue_found");
    k = await category("Software Issue", "ISSUE app-crashing|Notepad closed 3 times\nDONE", { appName: "Notepad" });
    check("software: a program that keeps crashing with no repair goes to a technician", k.rr.state === "needs_technician" && /Software Issue, Notepad/.test(k.notes.find((a) => a.is_internal && /Automatic checks and repair/.test(a.body)).body));
    k = await category("Software Issue", "ISSUE teams-crashing|3 times\nDONE", { appName: "Microsoft Teams" });
    check("software: Teams crashing gets the Teams repair", k.rr.state === "repairing" && (await jobOf(k.dev, S.REPAIR_KIND)).payload.env.ADG_FIX === "teams-crashing");

    console.log("switches and limits");
    await setRepair(true, false);
    k = await category("Printing", "ISSUE spooler-stopped|Stopped\nDONE");
    check("with repair switched off (checks only) nothing is repaired and a technician gets what was found", k.rr.state === "needs_technician" && !(await jobOf(k.dev, S.REPAIR_KIND)) && k.notes.some((a) => a.is_internal && /switched off/.test(a.body)));
    await setRepair(false);
    const doff = await device("off"); const o1 = await ask(doff, { category: "Printing" });
    check("with automatic repair switched off no run is made and no job is queued", !(await run((await ticketOf(o1.ticket.number)).id)) && !(await jobOf(doff, S.DIAGNOSE_KIND)));
    check("and the ticket says it was off, so technicians are not left wondering", (await acts((await ticketOf(o1.ticket.number)).id)).some((x) => x.is_internal && /Automatic repair is switched off/.test(x.body)));
    await setRepair(true);
    const dl = await device("mac", "mac"); const l1 = await ask(dl, { category: "Printing" });
    check("a computer that is neither Windows nor Linux is not checked", !(await run((await ticketOf(l1.ticket.number)).id)));
    check("and the ticket says why", (await acts((await ticketOf(l1.ticket.number)).id)).some((x) => x.is_internal && /neither/.test(x.body) && /Windows/.test(x.body)));
    await setRepair(true, true, false);
    k = await category("Printing", "ISSUE spooler-stuck-jobs|3 files\nDONE");
    await answer(k.dev, S.REPAIR_KIND, "FIXED spooler-stuck-jobs|ok\nDONE"); await repair.tick(); await answer(k.dev, S.DIAGNOSE_KIND, "DONE"); await repair.tick();
    check("with KB writing switched off a repair still works but no article is written", (await run(k.tk.id)).state === "awaiting_user" && (await articlesFor("spooler-stuck-jobs")).length === 0);

    // helpers shared by the self-healing and playbook sections
    let checkSeq = 0;
    async function failingCheck(dev, type, config, opts = {}) {
        const n = ++checkSeq;
        const ck = await prisma.checks.create({ data: { organization_id: org.id, name: `Heal check ${stamp}-${n}`, type, schedule: "*/5 * * * *", config } });
        const asg = await prisma.check_assignments.create({ data: { check_id: ck.id, target_type: "device", target_id: dev.d.id, device_id: dev.d.id, dedupe_key: `heal-${stamp}-${n}`, check_type: type, check_name: ck.name } });
        let ticketId = null;
        if (opts.ticket) ticketId = (await prisma.tickets.create({ data: { organization_id: org.id, ticket_number: BigInt(900000 + n + (stamp % 1000) * 10), subject: `Alert ticket ${n}`, device_id: dev.d.id } })).id;
        const al = await prisma.alerts.create({ data: { device_id: dev.d.id, assignment_id: asg.id, kind: "check", dedupe_key: `check:${asg.id}`, severity: "CRIT", title: `${ck.name} on ${dev.d.hostname}`, state: "OPEN", ticket_id: ticketId, first_seen_at: opts.old ? new Date(Date.now() - 3 * 3600_000) : new Date() } });
        return { al, ticketId };
    }
    const alertRun = async (alertId) => (await prisma.$queryRaw`SELECT * FROM public.auto_repair_runs WHERE alert_id = ${alertId}::uuid`)[0];
    const alertState = async (alertId) => (await prisma.alerts.findUnique({ where: { id: alertId } }));
    const events = async (runId) => (await prisma.$queryRaw`SELECT body, internal FROM public.auto_repair_events WHERE run_id = ${runId}::uuid ORDER BY id`).map((x) => x.body);
    {
    console.log("self-healing: a failed check starts the same loop, with no ticket");
    check("which failed checks have a plan: the Spooler, DNS Client and Time services, disk space, processor, ping and port; others none", [
        [{ type: "service", config: { service: "Spooler" } }, "printing"], [{ type: "service", config: { service: "Dnscache" } }, "network"], [{ type: "service", config: { service: "W32Time" } }, "time"],
        [{ type: "metric", config: { metric: "disk" } }, "disk"], [{ type: "metric", config: { metric: "cpu" } }, "cpu"], [{ type: "ping", config: { host: "x" } }, "network"],
    ].every(([c, want]) => C.healingPlan(c)?.checks.join() === want) && [{ type: "service", config: { service: "Fax" } }, { type: "metric", config: { metric: "memory" } }, { type: "process", config: { process: "x" } }, { type: "script", config: {} }].every((c) => C.healingPlan(c) === null));
    healOn = true; await setRepair(true);

    const dh = await device("heal-spooler");
    const f1 = await failingCheck(dh, "service", { service: "Spooler" }, { ticket: true });
    await repair.healAlerts(); await repair.healAlerts();
    let ar = await alertRun(f1.al.id);
    check("a failed Spooler check starts a run for the alert (once, even if looked at twice), with the printing checks", ar && ar.source === "alert" && ar.state === "diagnosing" && ar.checks.join() === "printing" && ar.ticket_id === f1.ticketId && (await jobOf(dh, S.DIAGNOSE_KIND)).payload.env.ADG_CHECKS === "printing", ar);
    await answer(dh, S.DIAGNOSE_KIND, "INFO spooler|Stopped\nISSUE spooler-stopped|The Print Spooler service is Stopped\nDONE"); await repair.tick();
    check("the problem found gets its repair, as for a ticket", (await alertRun(f1.al.id)).state === "repairing" && (await jobOf(dh, S.REPAIR_KIND)).payload.env.ADG_FIX === "spooler-stopped");
    await answer(dh, S.REPAIR_KIND, "FIXED spooler-stopped|The Print Spooler is running again.\nDONE"); await repair.tick();
    await answer(dh, S.DIAGNOSE_KIND, "INFO spooler|Running\nDONE"); await repair.tick();
    ar = await alertRun(f1.al.id);
    const afterAlert = await alertState(f1.al.id);
    check("confirmed clean: the alert is healed and resolved, with the reason", ar.state === "healed" && afterAlert.state === "RESOLVED" && /Fixed by automatic repair/.test((await prisma.alert_events.findMany({ where: { alert_id: f1.al.id, type: "resolved" } }))[0]?.reason ?? ""), { s: ar.state, a: afterAlert.state });
    const log = await events(ar.id);
    const lh = (re) => log.some((x) => re.test(x));
    check("the run keeps its own log with the scripts and results, as notes do for a ticket", lh(/Self-healing started: a monitoring check failed/) && lh(/Script sent to the computer: 1\. Checks[\s\S]*\$ErrorActionPreference/) && lh(/Script result: 2\. Repair[\s\S]*FIXED spooler-stopped/) && lh(/Decision after the confirming checks[\s\S]*The alert is resolved/) && lh(/Alert: resolved by the automatic repair/), log.map((x) => x.split("\n")[0]));
    const tnotes = (await acts(f1.ticketId)).filter((a) => a.author === C.AUTO_AUTHOR);
    check("a ticket the alert had opened gets the same notes, all for technicians only, and nothing is said to a person", tnotes.length >= 8 && tnotes.every((a) => a.is_internal) && tnotes.some((a) => /Self-healing started/.test(a.body)));
    check("the knowledge base article for the problem is the existing one (never a second), linked to the alert's ticket", (await articlesFor("spooler-stopped")).length === 1 && (await linked(f1.ticketId)).includes((await articlesFor("spooler-stopped"))[0].id) && lh(/already has an article[\s\S]*no second one was written/));

    const dd2 = await device("heal-disk");
    const f2 = await failingCheck(dd2, "metric", { metric: "disk" });
    await repair.healAlerts();
    check("a failed disk check runs the disk check and, with no ticket, writes only to the run log", (await alertRun(f2.al.id)).checks.join() === "disk" && (await alertRun(f2.al.id)).ticket_id === null);
    await answer(dd2, S.DIAGNOSE_KIND, "INFO disk_free_gb|2\nISSUE low-disk|Only 2 GB free\nDONE"); await repair.tick();
    await answer(dd2, S.REPAIR_KIND, "FIXED low-disk|Temporary files were deleted: 6 GB freed.\nDONE"); await repair.tick();
    await answer(dd2, S.DIAGNOSE_KIND, "INFO disk_free_gb|8\nDONE"); await repair.tick();
    const r2 = await alertRun(f2.al.id);
    check("a disk alert is healed: resolved, a new KB article for the problem, nothing on any ticket", r2.state === "healed" && (await alertState(f2.al.id)).state === "RESOLVED" && (await articlesFor("low-disk")).length === 1 && (await events(r2.id)).some((x) => /a new article was written for low-disk/.test(x)));

    const dn2 = await device("heal-notfixed");
    const f3 = await failingCheck(dn2, "service", { service: "Spooler" });
    await repair.healAlerts();
    await answer(dn2, S.DIAGNOSE_KIND, "ISSUE spooler-stuck-jobs|2 files\nDONE"); await repair.tick();
    await answer(dn2, S.REPAIR_KIND, "FIXED spooler-stuck-jobs|ok\nDONE"); await repair.tick();
    await answer(dn2, S.DIAGNOSE_KIND, "ISSUE spooler-stuck-jobs|2 files\nDONE"); await repair.tick();
    check("a repair that does not hold leaves the alert open for a technician, with the reason in the log", (await alertRun(f3.al.id)).state === "needs_technician" && (await alertState(f3.al.id)).state === "OPEN" && (await events((await alertRun(f3.al.id)).id)).some((x) => /still finds/.test(x)));

    const dg = await device("heal-gw");
    const f4 = await failingCheck(dg, "ping", { host: "10.0.0.1" });
    await repair.healAlerts();
    await answer(dg, S.DIAGNOSE_KIND, "ISSUE gateway-unreachable|The router 10.0.0.1 does not answer\nDONE"); await repair.tick();
    const r4 = await alertRun(f4.al.id);
    check("advice cannot be given to a person when there is none: a failed ping check with a cable problem goes to a technician", r4.state === "needs_technician" && (await alertState(f4.al.id)).state === "OPEN" && !(await jobOf(dg, S.REPAIR_KIND)));

    const dx2 = await device("heal-skip");
    const unknown = await failingCheck(dx2, "service", { service: "Fax" });
    const memory = await failingCheck(dx2, "metric", { metric: "memory" });
    const oldOne = await failingCheck(dx2, "service", { service: "Spooler" }, { old: true });
    await repair.healAlerts();
    check("a check with no plan, and an alert that has been open for hours, are left alone", !(await alertRun(unknown.al.id)) && !(await alertRun(memory.al.id)) && !(await alertRun(oldOne.al.id)));

    const dlin = await device("heal-linux", "linux");
    const lin = await failingCheck(dlin, "service", { service: "Spooler" });
    await repair.healAlerts();
    check("a computer that is not Windows is left alone", !(await alertRun(lin.al.id)));

    const dr = await device("heal-again");
    const a1 = await failingCheck(dr, "service", { service: "Spooler" });
    await repair.healAlerts();
    await answer(dr, S.DIAGNOSE_KIND, "ISSUE spooler-stopped|Stopped\nDONE"); await repair.tick(); await answer(dr, S.REPAIR_KIND, "FIXED spooler-stopped|ok\nDONE"); await repair.tick(); await answer(dr, S.DIAGNOSE_KIND, "DONE"); await repair.tick();
    const a2 = await failingCheck(dr, "service", { service: "Spooler" });
    await repair.healAlerts();
    await answer(dr, S.DIAGNOSE_KIND, "ISSUE spooler-stopped|Stopped again\nDONE"); await repair.tick();
    check("the same problem healed again the same day on the same computer is not healed again: it comes back as something for a technician", (await alertRun(a2.al.id)).state === "needs_technician" && (await alertState(a2.al.id)).state === "OPEN" && (await events((await alertRun(a2.al.id)).id)).some((x) => /already repaired automatically today/.test(x)));

    healOn = false; await setRepair(true);
    const doff2 = await device("heal-off");
    const off = await failingCheck(doff2, "service", { service: "Spooler" });
    await repair.healAlerts();
    check("with self-healing switched off nothing starts, though the rest of automatic repair is on", !(await alertRun(off.al.id)));
    healOn = true; await setRepair(false);
    const doff3 = await device("heal-master-off");
    const off2 = await failingCheck(doff3, "service", { service: "Spooler" });
    await repair.healAlerts();
    check("and with automatic repair itself off, self-healing does not run either", !(await alertRun(off2.al.id)));
    await setRepair(true);
    check("the settings carry the new switch, and the runs list shows alert runs with the alert's title", (await repair.settings(org.id)).selfHealing === true && (await repair.runs(org.id, 100)).items.some((i) => i.source === "alert" && i.ticketNumber === null && /Heal check/.test(i.subject) && i.state === "healed"));

    }

    console.log("the administrator's view");
    const runs = await repair.runs(org.id, 100);
    check("the runs list shows ticket, computer, category and where each stands", runs.items.length > 15 && runs.items.every((i) => (i.ticketNumber > 0 || i.source === "alert") && i.device && i.state) && runs.items.some((i) => i.state === "confirmed_fixed" && i.repaired.includes("spooler-stopped")));

    console.log("the results report");
    {
        const d = (n = 0) => new Date(Date.UTC(2026, 10, 15, 12, 0, 0) + n * 60_000);
        const mk = (o) => ({ source: "ticket", state: "confirmed_fixed", handoff_reason: null, category: "Printing", app_name: null, repair_issues: [], diagnosis: null, created_at: d(0), finished_at: d(20), ...o });
        const rows = [
            mk({ repair_issues: ["spooler-stopped"], diagnosis: { issues: [{ id: "spooler-stopped" }] } }),
            mk({ state: "healed", source: "alert", category: "Failed monitoring check", repair_issues: ["low-disk"], diagnosis: { issues: [{ id: "low-disk" }] }, finished_at: d(10) }),
            mk({ state: "awaiting_user", finished_at: null, repair_issues: ["spooler-stopped"], diagnosis: { issues: [{ id: "spooler-stopped" }] } }),
            mk({ state: "needs_technician", handoff_reason: "repair_failed", finished_at: d(5), repair_issues: ["teams-crashing"], category: "Software Issue", app_name: "Teams", diagnosis: { issues: [{ id: "teams-crashing" }] } }),
            mk({ state: "needs_technician", handoff_reason: "needs_technician", category: "Hardware", diagnosis: { issues: [{ id: "disk-unhealthy" }] } }),
            mk({ state: "no_issue_found", category: "Software Issue", app_name: "QuickBooks" }),
            mk({ state: "no_issue_found", category: "Software Issue", app_name: "QuickBooks" }),
            mk({ state: "not_fixed", repair_issues: ["spooler-stopped"], diagnosis: { issues: [{ id: "spooler-stopped" }] } }),
            mk({ state: "diagnosing", finished_at: null }),
        ];
        const sm = C.summarizeRuns(rows, 7, d(0));
        check("the report counts what was fixed without a technician (confirmed by the person, or an alert healed), what waits for a test, and what was handed over", sm.total === 9 && sm.fixed === 2 && sm.waiting === 1 && sm.handed === 5 && sm.inProgress === 1 && sm.tickets === 8 && sm.alerts === 1, sm);
        check("the fixed percentage is of the runs that reached a verdict, and the time saved is an estimate from it", sm.fixedPercent === Math.round((2 / 7) * 100) && sm.minutesSaved === 2 * C.MINUTES_SAVED_PER_FIX && sm.averageMinutesToFix === 15, sm);
        check("hand-overs are counted by reason, including the person saying it was not fixed and nothing being found", sm.reasons.repair_failed === 1 && sm.reasons.needs_technician === 1 && sm.reasons.nothing_found === 2 && sm.reasons.person_says_not_fixed === 1, sm.reasons);
        check("the report names what to add next: programs that keep coming up with nothing found, and problems found with no repair", sm.handedNoRepair["Software Issue: QuickBooks"] === 2 && sm.handedNoRepair["Problem: disk-unhealthy"] === 1, sm.handedNoRepair);
        check("the problems found, repaired and not repaired are counted per problem, and the trend has a row for each day", sm.problemsFound["spooler-stopped"] === 3 && sm.problemsFixed["spooler-stopped"] === 2 && sm.problemsNotFixed["teams-crashing"] === 1 && sm.trend.length === 7 && sm.trend.reduce((n, x) => n + x.fixed + x.handed + x.other, 0) === 9, { f: sm.problemsFound, x: sm.problemsFixed, n: sm.problemsNotFixed, t: sm.trend });
        const rep = await repair.report(org.id, 30);
        const dbCounts = (await prisma.$queryRaw`SELECT count(*)::int AS n, count(*) FILTER (WHERE state IN ('confirmed_fixed', 'healed'))::int AS fixed, count(*) FILTER (WHERE state IN ('needs_technician', 'no_issue_found', 'not_fixed'))::int AS handed FROM public.auto_repair_runs WHERE organization_id = ${org.id}::uuid`)[0];
        check("the report from the database agrees with the runs: totals, fixed and handed over, and every reason has words", rep.total === dbCounts.n && rep.fixed === dbCounts.fixed && rep.handed === dbCounts.handed && rep.reasons.reduce((n, x) => n + x.count, 0) === rep.handed && rep.reasons.every((x) => x.text && x.text !== x.code), { rep: [rep.total, rep.fixed, rep.handed], dbCounts });
        check("it lists the KB articles written, with how many times the problem came back, and none twice", rep.articles.length > 0 && new Set(rep.articles.map((a) => a.issue)).size === rep.articles.length && rep.articles.some((a) => a.issue === "spooler-stopped" && a.seen >= 2 && a.title), rep.articles);
        const healed = (await prisma.$queryRaw`SELECT id::text AS id FROM public.auto_repair_runs WHERE state = 'healed' AND organization_id = ${org.id}::uuid LIMIT 1`)[0];
        const detail = await repair.runDetail(org.id, healed.id);
        check("one run can be read in full, with its settings and every line it logged, the scripts included", detail && detail.source === "alert" && detail.events.length >= 6 && detail.events.some((e) => /\$ErrorActionPreference/.test(e.text)) && detail.alertTitle, detail && detail.events.length);
        check("a run that does not exist is not found", (await repair.runDetail(org.id, crypto.randomUUID())) === null);
    }

    console.log("your own repairs");
    {
        const good = { title: "Fax service stuck", plain: "the fax service was stuck", signs: "Faxes never leave.", fixText: "Restarted the fax service.", ifItReturns: "Look at the modem.", categories: ["Printing"], appWords: [], checkService: null, checkMetric: null,
            detectScript: "if ((Get-Service Fax).Status -ne 'Running') { Write-Output 'DETECTED|The Fax service is stopped' }", fixScript: "if ($env:ADG_DRYRUN -eq '1') { Write-Output 'FIXED|DRY RUN would start Fax'; return }\nStart-Service Fax\nWrite-Output 'FIXED|Started the Fax service'", risk: "low" };
        const refused = async (o, re) => fails(() => Promise.resolve().then(() => P.cleanPlaybook({ ...good, ...o })), re);
        check("what a person types is checked: a detection that never prints DETECTED|, a repair that never says FIXED| or FAILED|, a restart or a disk wipe, an unknown category, no scope, program words without Software Issue", await refused({ detectScript: "Write-Output 'hello'" }, /DETECTED\|/) && await refused({ fixScript: "Start-Service Fax" }, /FIXED\|/) && await refused({ fixScript: "Restart-Computer -Force\nWrite-Output 'FIXED|x'" }, /restarting or shutting down/) && await refused({ fixScript: "Format-Volume -DriveLetter D\nWrite-Output 'FIXED|x'" }, /formatting, wiping/) && await refused({ categories: ["Gardening"] }, /not one of the categories/) && await refused({ categories: [], checkService: "", checkMetric: null }, /when it applies/) && await refused({ appWords: ["teams"] }, /Software Issue/) && await refused({ risk: "yolo" }, /how risky/) && await refused({ title: "" }, /title is needed/));
        check("things that are allowed but worth a look are listed for the Owner", P.scriptWarnings("Invoke-WebRequest http://x; Remove-Item C:\\x -Recurse -Force; Stop-Process -Name y").length === 3 && P.scriptWarnings("Start-Service Fax").length === 0);
        const k = P.newPlaybookKey();
        const h0 = P.contentHash(k, good);
        check("the approval hash changes with the scripts, the scope and the risk, and not with the order of categories", P.contentHash(k, { ...good, detectScript: good.detectScript + " " }) !== h0 && P.contentHash(k, { ...good, categories: ["Printing", "Hardware"] }) !== h0 && P.contentHash(k, { ...good, risk: "high" }) !== h0 && P.contentHash(k, { ...good, categories: ["Hardware", "Printing"] }) === P.contentHash(k, { ...good, categories: ["Printing", "Hardware"] }));
        const dz = P.composeDiagnose("A\nWrite-Output 'DONE'\n", [{ key: "c-aaaaaaaa", detectScript: "X" }]);
        const rz = P.composeRepair("$custom = @{}\nB\n", [{ key: "c-aaaaaaaa", fixScript: "Y" }]);
        check("approved scripts are put into the fixed scripts: detection before DONE, repair after the $custom table", /RunCustom 'c-aaaaaaaa' \{\nX\n\}\nWrite-Output 'DONE'/.test(dz) && /\$custom = @\{\}\n\$custom\['c-aaaaaaaa'\] = \{\nY\n\}\nB/.test(rz) && P.composeDiagnose("A", []) === "A");
        check("a playbook applies by category (and program words), or by the failed check's service or measure", P.applies(good, { category: "Printing" }) && !P.applies(good, { category: "Hardware" }) && P.applies({ ...good, categories: ["Software Issue"], appWords: ["quickbooks"] }, { category: "Software Issue", app: "QuickBooks Desktop" }) && !P.applies({ ...good, categories: ["Software Issue"], appWords: ["quickbooks"] }, { category: "Software Issue", app: "Notepad" }) && P.applies({ ...good, categories: [], checkService: "Fax" }, { checkService: "fax" }) && P.applies({ ...good, categories: [], checkMetric: "disk" }, { checkMetric: "disk" }));

        // ---------------------------------------------------- the lifecycle
        const created = await playbooks.create(org.id, null, good);
        check("a new playbook is a draft: it does not run, and its warnings, tests and key are shown", created.status === "draft" && !created.approved && /^c-[0-9a-f]{8}$/.test(created.key) && created.tests.detect.state === "not_run" && created.tests.dryrun.state === "not_run" && (await playbooks.matching(org.id, { category: "Printing" })).length === 0);
        const dpb = await device("pb-test");
        check("a repair cannot be approved before it has been tried on a computer", await fails(() => playbooks.approve(org.id, created.id, null), /Try the detection script/));
        const t1 = await playbooks.startTest(org.id, created.id, dpb.d.id, "detect");
        const tj = await jobOf(dpb, "auto-repair.playbook-test");
        check("a test runs exactly what the loop would run: the fixed script with this playbook inside, and no built-in checks", tj && /RunCustom '/.test(tj.payload.scriptText) && tj.payload.env.ADG_CHECKS === "" && /Get-Service Fax/.test(tj.payload.scriptText));
        await answer(dpb, "auto-repair.playbook-test", `INFO c-zzzzzzzz_output|x\nINFO ${created.key}_output|DETECTED|The Fax service is stopped\nISSUE ${created.key}|The Fax service is stopped\nDONE`);
        const tr = await playbooks.testResult(org.id, created.id, t1.jobId, "detect");
        check("a finished detection test is remembered with what it printed", tr.state === "passed" && /found the problem/.test(tr.summary) && (await playbooks.get(org.id, created.id)).tests.detect.state === "passed");
        check("with a repair script, the dry run has to pass too", await fails(() => playbooks.approve(org.id, created.id, null), /dry run/));
        const t2 = await playbooks.startTest(org.id, created.id, dpb.d.id, "dryrun");
        const dj = await jobOf(dpb, "auto-repair.playbook-test");
        check("the dry run asks the script to change nothing (ADG_DRYRUN=1) and names the problem to repair", dj.payload.env.ADG_DRYRUN === "1" && dj.payload.env.ADG_FIX === created.key && new RegExp(`\\$custom\\['${created.key}'\\]`).test(dj.payload.scriptText));
        await answer(dpb, "auto-repair.playbook-test", `FIXED ${created.key}|DRY RUN would start Fax\nDONE`);
        check("a dry run that says it would work passes", (await playbooks.testResult(org.id, created.id, t2.jobId, "dryrun")).state === "passed");
        const ap = await playbooks.approve(org.id, created.id, null);
        check("approved after both tests: it is live, bound to these scripts", ap.status === "approved" && ap.approved === true && (await playbooks.matching(org.id, { category: "Printing" })).length === 1 && (await playbooks.matching(org.id, { category: "Hardware" })).length === 0);

        // ---------------------------------------------------- through a ticket
        await playbooks.register(org.id);
        const dpt = await device("pb-ticket");
        const q1 = await ask(dpt, { category: "Printing" }); const tq = await ticketOf(q1.ticket.number);
        let rr = await run(tq.id);
        const dscript = (await jobOf(dpt, S.DIAGNOSE_KIND)).payload.scriptText;
        check("a ticket in its category includes the approved playbook: recorded on the run, in the script, and said in the log", rr.custom_ids.join() === created.key && new RegExp(`RunCustom '${created.key}'`).test(dscript) && (await acts(tq.id)).some((a) => a.is_internal && /Your own repairs included[\s\S]*Fax service stuck[\s\S]*approved/.test(a.body)));
        await answer(dpt, S.DIAGNOSE_KIND, `INFO host|X\nISSUE ${created.key}|The Fax service is stopped\nDONE`); await repair.tick();
        const rscript = (await jobOf(dpt, S.REPAIR_KIND)).payload;
        check("its problem gets its repair: the repair script holds the playbook's repair, and only that problem is named", (await run(tq.id)).state === "repairing" && rscript.env.ADG_FIX === created.key && new RegExp(`\\$custom\\['${created.key}'\\] = \\{`).test(rscript.scriptText) && /Start-Service Fax/.test(rscript.scriptText));
        await answer(dpt, S.REPAIR_KIND, `FIXED ${created.key}|Started the Fax service\nDONE`); await repair.tick();
        check("the confirming checks use the same playbook", new RegExp(`RunCustom '${created.key}'`).test((await jobOf(dpt, S.DIAGNOSE_KIND)).payload.scriptText) && (await jobOf(dpt, S.DIAGNOSE_KIND)).payload.env.ADG_SINCE);
        await answer(dpt, S.DIAGNOSE_KIND, "INFO host|X\nDONE"); await repair.tick();
        const done = (await acts(tq.id));
        const reply = done.find((a) => !a.is_internal && a.author === C.AUTO_AUTHOR);
        check("fixed: the person is told in the playbook's own words, and a KB article is written for it with its tag", (await run(tq.id)).state === "awaiting_user" && reply && /the fax service was stuck/.test(reply.body) && /Restarted the fax service/.test(reply.body) && (await articlesFor(created.key)).length === 1 && /Known fix/.test((await articlesFor(created.key))[0].body));
        const dpt2 = await device("pb-ticket2");
        const q2 = await ask(dpt2, { category: "Printing" });
        await answer(dpt2, S.DIAGNOSE_KIND, `ISSUE ${created.key}|Stopped again\nDONE`); await repair.tick(); await answer(dpt2, S.REPAIR_KIND, `FIXED ${created.key}|ok\nDONE`); await repair.tick(); await answer(dpt2, S.DIAGNOSE_KIND, "DONE"); await repair.tick();
        check("the same problem on another computer reuses the article (never a second)", (await articlesFor(created.key)).length === 1);
        const dpf = await device("pb-fail");
        const q3 = await ask(dpf, { category: "Printing" });
        await answer(dpf, S.DIAGNOSE_KIND, `ISSUE ${created.key}|Stopped\nDONE`); await repair.tick(); await answer(dpf, S.REPAIR_KIND, `FAILED ${created.key}|The service would not start\nDONE`); await repair.tick();
        check("a custom repair that fails goes to a technician like any other, with its reason", (await run((await ticketOf(q3.ticket.number)).id)).state === "needs_technician" && (await acts((await ticketOf(q3.ticket.number)).id)).some((a) => a.is_internal && /did not work: The service would not start/.test(a.body)));

        // ---------------------------------------------------- through a failed check, and detect-only
        const detectOnly = await playbooks.create(org.id, null, { ...good, title: "Modem light is red", plain: "the modem was reporting a fault", categories: [], checkService: "Modem", fixScript: "", fixText: "", detectScript: "Write-Output 'DETECTED|Modem fault light'" });
        const dm = await device("pb-modem");
        await playbooks.startTest(org.id, detectOnly.id, dm.d.id, "detect");
        await answer(dm, "auto-repair.playbook-test", `ISSUE ${detectOnly.key}|x\nDONE`);
        await playbooks.testResult(org.id, detectOnly.id, (await jobOf(dm, "auto-repair.playbook-test")).id, "detect");
        await playbooks.approve(org.id, detectOnly.id, null);
        await playbooks.register(org.id);
        const fm = await failingCheck(dm, "service", { service: "Modem" });
        await repair.healAlerts();
        const arm = await alertRun(fm.al.id);
        check("a failed check can start the loop for a playbook that watches that service, even with no built-in plan", arm && arm.source === "alert" && arm.custom_ids.join() === detectOnly.key && (await jobOf(dm, S.DIAGNOSE_KIND)).payload.env.ADG_CHECKS === "");
        await answer(dm, S.DIAGNOSE_KIND, `ISSUE ${detectOnly.key}|Modem fault light\nDONE`); await repair.tick();
        check("a playbook with no repair script only detects: the alert stays open for a technician and no repair job is made", (await alertRun(fm.al.id)).state === "needs_technician" && !(await jobOf(dm, S.REPAIR_KIND)) && (await alertState(fm.al.id)).state === "OPEN");

        // ---------------------------------------------------- it stops the moment its scripts are not the approved ones
        const edited = await playbooks.update(org.id, created.id, null, { detectScript: good.detectScript + "\n# changed" });
        check("editing sends it back to draft with a new version, and it stops matching", edited.status === "draft" && edited.version === 2 && !edited.approved && (await playbooks.matching(org.id, { category: "Printing" })).length === 0 && edited.tests.detect.state === "old");
        check("it cannot be switched back on without a new approval", await fails(() => playbooks.setEnabled(org.id, created.id, true), /not the ones that were approved/));
        await playbooks.startTest(org.id, created.id, dpb.d.id, "detect"); await answer(dpb, "auto-repair.playbook-test", `ISSUE ${created.key}|x\nDONE`);
        await playbooks.testResult(org.id, created.id, (await jobOf(dpb, "auto-repair.playbook-test")).id, "detect");
        await playbooks.startTest(org.id, created.id, dpb.d.id, "dryrun"); await answer(dpb, "auto-repair.playbook-test", `FIXED ${created.key}|DRY RUN\nDONE`);
        await playbooks.testResult(org.id, created.id, (await jobOf(dpb, "auto-repair.playbook-test")).id, "dryrun");
        await playbooks.approve(org.id, created.id, null);
        check("tested and approved again, it is live again", (await playbooks.matching(org.id, { category: "Printing" })).length === 1);
        await prisma.$executeRaw`UPDATE public.repair_playbooks SET detect_script = detect_script || E'\nWrite-Output "tampered"' WHERE id = ${created.id}::uuid`;
        check("if the stored scripts are changed behind the application's back, the approval no longer holds and it does not run", (await playbooks.matching(org.id, { category: "Printing" })).length === 0 && (await playbooks.get(org.id, created.id)).status === "draft");
        await playbooks.update(org.id, created.id, null, { detectScript: good.detectScript });
        check("versions are kept with who and why", (await playbooks.versions(org.id, created.id)).items.length >= 3);
        const off = await playbooks.setEnabled(org.id, detectOnly.id, false);
        check("a disabled playbook does not run, and a playbook can be deleted", off.status === "disabled" && (await playbooks.matching(org.id, { checkService: "Modem" })).length === 0 && (await playbooks.remove(org.id, detectOnly.id)).ok && await fails(() => playbooks.get(org.id, detectOnly.id), /does not exist/));
        check("the loop's accepted problems follow the approved playbooks (no stale ids left over)", await (async () => { await playbooks.register(org.id); return !(C.ISSUES[detectOnly.key]) && (await prisma.$queryRaw`SELECT 1 FROM public.repair_playbooks WHERE status = 'approved'`).length >= 0; })());
    }


    // ------------------------------------------------------------ Linux computers and tickets that are not from the tray
    console.log("linux and ticket text");
    const L = require(path.join(dist, "auto-repair/auto-repair.linux.js"));
    check("the Linux scripts take input from environment variables only", /ADG_CHECKS/.test(L.LINUX_DIAGNOSE_SCRIPT) && /ADG_FIX/.test(L.LINUX_REPAIR_SCRIPT) && !/\$\{ADG_APP\}/.test(L.LINUX_REPAIR_SCRIPT) && /ADG_DRYRUN/.test(L.LINUX_REPAIR_SCRIPT));
    check("only checks that mean something on Linux are chosen (and failed services for most categories)", C.checksForLinux("Printing", null).join() === "disk,services" && C.checksForLinux("Hardware", null).join() === "disk" && C.checksForLinux("Sign-in or password", null).join() === "time,network" && C.checksForLinux("Internet or network", null).join() === "network");
    check("the kind of computer is told from what the agent and the device say", C.platformOf("windows", null) === "windows" && C.platformOf(null, "Windows 11 Pro") === "windows" && C.platformOf("linux", null) === "linux" && C.platformOf(null, "Ubuntu 24.04") === "linux" && C.platformOf(null, "Debian GNU/Linux 12") === "linux" && C.platformOf("macos", "macOS 14") === null);
    check("every Linux problem is in the catalog with its text", ["linux-low-disk", "linux-pending-reboot", "linux-time-not-synced", "linux-dns-broken", "linux-service-failed"].every((id) => C.ISSUES[id] && C.ISSUES[id].title && C.ISSUES[id].signs && C.ISSUES[id].ifItReturns && (C.ISSUES[id].kind !== "repair" || C.ISSUES[id].fix)));
    check("Linux scripts print lines the parser understands", (() => { const d = C.parseDiagnosis("INFO host|x\nISSUE linux-low-disk|/ has 2.0 GB free (4%)\nISSUE linux-service-failed|Failed services: cups.service\nDONE"); const r = C.parseRepair("FIXED linux-low-disk|ok\nFAILED linux-service-failed|left"); return d.complete && d.issues.length === 2 && r.length === 2 && r[1].ok === false; })());

    const dlx = await device("lin-loop", "linux");
    const lx = await ask(dlx, { category: "Slow computer" });
    const lt = await ticketOf(lx.ticket.number);
    const lj = await jobOf(dlx, L.LINUX_DIAGNOSE_KIND);
    check("a Linux computer is checked with the bash script and the Linux checks", (await run(lt.id)).state === "diagnosing" && lj && lj.payload.language === "bash" && lj.payload.env.ADG_CHECKS === "disk,reboot,services" && lj.payload.script_text?.startsWith?.("#!/bin/bash") !== false, lj && lj.payload);
    await answer(dlx, L.LINUX_DIAGNOSE_KIND, "INFO host|x\nISSUE linux-low-disk|/ has 2.0 GB free (4%)\nDONE");
    await repair.tick();
    const lrj = await jobOf(dlx, L.LINUX_REPAIR_KIND);
    check("the repair is the Linux repair for just that problem", lrj && lrj.payload.language === "bash" && lrj.payload.env.ADG_FIX === "linux-low-disk");
    await answer(dlx, L.LINUX_REPAIR_KIND, "FIXED linux-low-disk|Old temporary files were cleared: 900 MB freed.\nDONE");
    await repair.tick();
    check("then the Linux checks run again to confirm", (await run(lt.id)).state === "verifying" && !!(await jobOf(dlx, L.LINUX_DIAGNOSE_KIND)));
    await answer(dlx, L.LINUX_DIAGNOSE_KIND, "INFO host|x\nDONE");
    await repair.tick();
    const lmsg = (await acts(lt.id)).find((a) => a.kind === "message" && !a.is_internal && a.author === C.AUTO_AUTHOR);
    check("a confirmed Linux repair tells the person what was done, and waits for them", (await run(lt.id)).state === "awaiting_user" && lmsg && /disk/i.test(lmsg.body) && /temporary files/i.test(lmsg.body), lmsg && lmsg.body);

    check("ticket wording: each category from its words, a tie or nothing is null, security always wins", C.categoryFromText("Printer is jammed", "it will not print") === "Printing" && C.categoryFromText("Outlook will not open my mailbox", "") === "Email" && C.categoryFromText("No internet", "wifi keeps dropping, cannot connect to the vpn") === "Internet or network" && C.categoryFromText("Locked out", "my password does not work") === "Sign-in or password" && C.categoryFromText("PC is so slow", "it freezes") === "Slow computer" && C.categoryFromText("Hello", "thanks for the call") === null && C.categoryFromText("printer and email", "") === null && C.categoryFromText("Slow printer", "I clicked a phishing link") === "Security concern");

    // a ticket made from email or the portal, with the wording choosing the category
    const tickets = app.get(require(path.join(dist, "tickets/tickets.service.js")).TicketsService, { strict: false });
    const setText = (on) => prisma.$executeRaw`UPDATE public.auto_repair_settings SET from_text = ${on} WHERE organization_id = ${org.id}::uuid`;
    const mkTicket = async (dev, subject, body = "") => { const id = await tickets.create({ subject, description: body, priority: "medium", deviceId: dev ? dev.d.id : undefined }, { user: { organizationId: org.id, name: "Test" } }, { source: "api" }); return id; };
    const dtx = await device("text");
    await setText(false);
    const x0 = await mkTicket(dtx, "The printer will not print");
    check("tickets that are not from the tray are left alone while that setting is off", (await repair.startFromText(x0)) === null && !(await run(x0)));
    await setText(true);
    const x1 = await mkTicket(dtx, "The printer will not print", "Nothing comes out of the printer");
    const rid = await repair.startFromText(x1);
    check("with it on, the wording picks the category and the checks start (Windows computer)", !!rid && (await run(x1)).category === "Printing" && (await jobOf(dtx, S.DIAGNOSE_KIND)).payload.env.ADG_CHECKS === "printing,disk");
    check("and the ticket says how the category was chosen", (await acts(x1)).some((a) => a.is_internal && /chose the category "Printing" from the wording/.test(a.body)));
    check("the same ticket is not started twice", (await repair.startFromText(x1)) === null);
    const x2 = await mkTicket(null, "My outlook is not opening mail");
    check("a ticket with no computer linked is not checked, and says so", (await repair.startFromText(x2)) === null && !(await run(x2)) && (await acts(x2)).some((a) => a.is_internal && /no computer is linked/.test(a.body)));
    const x3 = await mkTicket(dtx, "Thanks for the call yesterday");
    check("a ticket that is about nothing in particular is left to a person", (await repair.startFromText(x3)) === null && !(await run(x3)));
    const dty = await device("text-bus");
    const x4 = await mkTicket(dty, "Everything is very slow and freezes");
    let busRun = null; for (let i = 0; i < 40 && !busRun; i++) { await new Promise((r) => setTimeout(r, 250)); busRun = await run(x4); }
    check("a ticket made through the application (the same event workflows use) starts the checks by itself", !!busRun && busRun.category === "Slow computer");
    await setText(false);
    await app.close();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
