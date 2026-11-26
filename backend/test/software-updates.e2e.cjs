// Third-party software patching against a real database: what a scan stores, what a confirmed update clears, the allow /
// never-update lists, who may update what, the scheduled scan and the automatic updates (inside and outside maintenance
// windows), the fleet screen's numbers and the "Outdated software" report. Throwaway database only (name has "e2e").
"use strict";

const crypto = require("node:crypto");
const path = require("node:path");

if (process.env.ADG_E2E_ALLOW !== "1" || !/e2e/.test(process.env.DATABASE_URL || "")) {
    console.error("Refusing to run: set ADG_E2E_ALLOW=1 and an e2e-named DATABASE_URL.");
    process.exit(2);
}
process.env.JWT_SECRET ||= "e2e-only-not-a-real-secret-e2e-only-not-a-real-secret";
process.env.DATA_ENCRYPTION_KEY ||= "e2e-only-data-key";
process.env.IMAP_POLL_ENABLED = "false";
process.env.NODE_ENV = "development";

let passed = 0;
let failed = 0;
function check(name, ok, extra) {
    if (ok) passed++;
    else failed++;
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && extra !== undefined ? `: ${JSON.stringify(extra)}` : ""}`);
}
const fails = async (fn, re) => { try { await fn(); return false; } catch (e) { return re.test(String(e.message ?? e)); } };

(async () => {
    require("reflect-metadata");
    const { NestFactory } = require("@nestjs/core");
    const dist = path.resolve(process.cwd(), "dist");
    const { AppModule } = require(path.join(dist, "app.module.js"));
    const { PoliciesService } = require(path.join(dist, "policies/policies.service.js"));
    const { PrismaService } = require(path.join(dist, "storage/prisma.service.js"));
    const { AgentsTasksService } = require(path.join(dist, "agents/agents.tasks.service.js"));
    const { SoftwareUpdatesService } = require(path.join(dist, "software-updates/software-updates.service.js"));
    const { SoftwareUpdatesAutomationService } = require(path.join(dist, "software-updates/software-updates-automation.service.js"));
    const rules = require(path.join(dist, "software-updates/update-rules.js"));
    const { cleanApps } = require(path.join(dist, "software-updates/ingest.js"));
    const { EndpointReportsService } = require(path.join(dist, "reports/endpoint-reports.service.js"));

    const app = await NestFactory.createApplicationContext(AppModule, { logger: ["error"] });
    const prisma = app.get(PrismaService, { strict: false });
    const tasks = app.get(AgentsTasksService, { strict: false });
    const svc = app.get(SoftwareUpdatesService, { strict: false });
    const auto = app.get(SoftwareUpdatesAutomationService, { strict: false });
    const policies = app.get(PoliciesService, { strict: false });
    const endpoint = app.get(EndpointReportsService, { strict: false });

    const org = await prisma.organizations.upsert({ where: { slug: "default" }, create: { name: "Default Organization", slug: "default" }, update: {} });
    const o = org.id;
    const stamp = Date.now();
    const me = { id: null, name: "Test Person" };
    const MIN = rules.UPDATES_MIN_VERSION;
    const ALL_DAY = { name: "Always", days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "00:00", timezone: "UTC" };
    const closedDay = (new Date().getUTCDay() + 3) % 7;
    const CLOSED = { name: "Another day", days: [closedDay], start: "01:00", end: "02:00", timezone: "UTC" };

    async function customer(label) {
        const client = await prisma.clients.create({ data: { organization_id: o, name: `Upd ${label} ${stamp}` } });
        const site = await prisma.sites.create({ data: { client_id: client.id, name: "HQ" } });
        return { client, site };
    }
    async function device(c, label, { os = "windows", version = MIN, online = true } = {}) {
        const dev = await prisma.devices.create({ data: { site_id: c.site.id, hostname: `PC-${label}-${stamp}`, operating_system: os === "windows" ? "Windows 11 Pro" : "Ubuntu 22.04" } });
        const agent = await prisma.agents.create({ data: { device_id: dev.id, agent_uuid: crypto.randomUUID(), version, last_check_in_at: online ? new Date() : new Date(Date.now() - 3 * 3600_000), facts: { os } } });
        return { dev, agent, c };
    }
    // a scan result goes through the real completion route of the agent task service
    async function scanResult(d, { apps, winget = "ok", chocolatey = "missing", status = "succeeded", message = "done" }) {
        const task = await prisma.agent_tasks.create({ data: { agent_id: d.agent.id, type: "software_updates_scan", payload: {}, status: "running" } });
        const run = await prisma.agent_task_runs.create({ data: { task_id: task.id, status: "running", started_at: new Date() } });
        await tasks.completeRun({
            agentId: d.agent.id, taskId: task.id, runId: run.id, status, stdout: message, stderr: status === "failed" ? message : null,
            // the completion route of the agent controller keeps the artifacts inside the output and passes none of its own
            output: { ok: status === "succeeded", message, count: apps.length, artifacts: { apps, winget: { state: winget }, chocolatey: { state: chocolatey } } },
            artifacts: null,
        });
        return task;
    }
    const w = (id, name, from, to, extra = {}) => ({ source: "winget", id, name, installedVersion: from, availableVersion: to, approximate: false, ...extra });
    const rows = (d) => prisma.agent_outdated_software.findMany({ where: { agent_id: d.agent.id }, orderBy: { app_id: "asc" } });
    const upgrades = (d) => prisma.agent_tasks.findMany({ where: { agent_id: d.agent.id, type: "software_install" }, orderBy: { created_at: "desc" } });
    const scanTasks = (d) => prisma.agent_tasks.findMany({ where: { agent_id: d.agent.id, type: "software_updates_scan" }, orderBy: { created_at: "desc" } });
    const actions = (d) => prisma.policy_actions.findMany({ where: { device_id: d.dev.id, kind: "software_update" } });
    const finishAll = (d) => prisma.agent_tasks.updateMany({ where: { agent_id: d.agent.id, status: { in: ["queued", "running", "pending"] } }, data: { status: "succeeded" } });

    // ---------------------------------------------------------------- the rules, as plain functions
    const R = (rule, appId, clientId = null, source = "winget") => ({ rule, appId, clientId, source });
    check("rules: mode none never updates", rules.autoDecision("none", [R("allow", "A.B")], null, "winget", "A.B").update === false);
    check("rules: all updates what is not blocked", rules.autoDecision("all", [], null, "winget", "A.B").update === true && rules.autoDecision("all", [R("block", "a.b")], null, "winget", "A.B").update === false);
    check("rules: listed needs an allow entry, matched without regard to case", rules.autoDecision("listed", [], null, "winget", "A.B").update === false && rules.autoDecision("listed", [R("allow", "a.b")], null, "winget", "A.B").update === true);
    check("rules: a never-update entry beats an allow entry, in either place", rules.autoDecision("listed", [R("allow", "A.B"), R("block", "A.B", "c1")], "c1", "winget", "A.B").update === false && rules.autoDecision("listed", [R("allow", "A.B", "c1"), R("block", "A.B")], "c1", "winget", "A.B").update === false);
    check("rules: another customer's entry does not apply", rules.autoDecision("all", [R("block", "A.B", "c2")], "c1", "winget", "A.B").update === true && rules.autoDecision("listed", [R("allow", "A.B", "c2")], "c1", "winget", "A.B").update === false);
    check("rules: the same id in another source is another program", rules.autoDecision("all", [R("block", "git", null, "chocolatey")], null, "winget", "git").update === true);
    check("rules: a manual update is stopped only by a block", rules.manualDecision([R("allow", "A.B")], null, "winget", "A.B").update === true && rules.manualDecision([R("block", "A.B")], null, "winget", "A.B").update === false);
    check("rules: the installed version is taken out of a name to look it up by", rules.matchTextFor("7-Zip 25.01 (x64)", "25.01") === "7-Zip (x64)" && rules.matchTextFor("Certify The Web version 6.0.18", "6.0.18") === "Certify The Web" && rules.matchTextFor("Git", "2.56.0") === "Git");
    check("rules: package ids are checked by source", rules.validAppId("winget", "Microsoft.VCRedist.2015+.x64") && !rules.validAppId("winget", "a b") && rules.validAppId("chocolatey", "python3") && !rules.validAppId("chocolatey", "a+b") && !rules.validAppId("other", "x"));
    check("rules: an old agent, a non-Windows device and an offline one are not supported", rules.whyNotSupported({ version: "1.3.10", os: "windows", lastCheckInAt: new Date() }) !== null && /Windows/.test(rules.whyNotSupported({ version: MIN, os: "linux", lastCheckInAt: new Date() })) && /offline/.test(rules.whyNotSupported({ version: MIN, os: "windows", lastCheckInAt: new Date(0) })) && rules.whyNotSupported({ version: MIN, os: "windows", lastCheckInAt: new Date() }) === null);

    // ---------------------------------------------------------------- what an agent's scan may store
    const cleaned = cleanApps([w("7zip.7zip", "7-Zip", "25.01", "26.06"), w("7zip.7zip", "dup", "1", "2"), w("bad id", "x", "1", "2"), { source: "evil", id: "x.y", availableVersion: "1" }, { source: "winget", id: "no.available" }, null, 5, w("ok.id", "n\u0001ame", null, "3.0")]);
    check("ingest: bad entries, duplicates and control characters are dropped", cleaned.length === 2 && cleaned[1].name === "n ame" && cleaned[1].installed === null);
    check("ingest: more than 2000 entries are cut", cleanApps(Array.from({ length: 2500 }, (_, i) => w(`a.app${i}`, "n", "1", "2"))).length === 2000);

    // ---------------------------------------------------------------- a scan is stored, replaced, and kept when a tool fails
    const A = await customer("A");
    const B = await customer("B");
    const d1 = await device(A, "a1");
    await scanResult(d1, { apps: [w("7zip.7zip", "7-Zip 25.01 (x64)", "25.01", "26.06"), w("Git.Git", "Git", "2.40.0", "2.56.0"), { source: "winget", id: "Old.App", name: "Old App", installedVersion: "< 1.0", availableVersion: "1.1", approximate: true }], chocolatey: "ok" });
    let r = await rows(d1);
    let scan = await prisma.agent_software_scans.findUnique({ where: { agent_id: d1.agent.id } });
    check("scan: the programs are stored per device with versions", r.length === 3 && r.find((x) => x.app_id === "7zip.7zip")?.available_version === "26.06" && r.find((x) => x.app_id === "Old.App")?.approximate === true);
    check("scan: the scan time and what each tool said are kept", scan?.ok === true && !!scan.scanned_at && scan.winget_state === "ok" && scan.choco_state === "ok" && scan.app_count === 3, scan);
    const firstSeen = r.find((x) => x.app_id === "7zip.7zip").first_seen_at.getTime();
    await new Promise((res) => setTimeout(res, 20));
    await scanResult(d1, { apps: [w("7zip.7zip", "7-Zip 25.01 (x64)", "25.01", "26.07"), w("New.App", "New", "1", "2")] });
    r = await rows(d1);
    check("scan: a new scan replaces the list (gone ones removed, new added, available version updated)", r.length === 2 && r.some((x) => x.app_id === "New.App") && r.find((x) => x.app_id === "7zip.7zip").available_version === "26.07");
    check("scan: a program keeps the time it was first seen", r.find((x) => x.app_id === "7zip.7zip").first_seen_at.getTime() === firstSeen);
    await scanResult(d1, { apps: [], winget: "timeout", chocolatey: "missing", status: "failed", message: "winget did not answer" });
    r = await rows(d1);
    scan = await prisma.agent_software_scans.findUnique({ where: { agent_id: d1.agent.id } });
    check("scan: a winget timeout keeps the last list and says so", r.length === 2 && scan.ok === false && scan.winget_state === "timeout" && /did not answer/.test(scan.message ?? "") && !!scan.scanned_at);
    await scanResult(d1, { apps: [w("7zip.7zip", "7-Zip 25.01 (x64)", "25.01", "26.07"), w("New.App", "New", "1", "2")] });
    // a stranger cannot complete another agent's task
    const other = await device(A, "other");
    const stray = await prisma.agent_tasks.create({ data: { agent_id: d1.agent.id, type: "software_updates_scan", payload: {}, status: "running" } });
    const strayRun = await prisma.agent_task_runs.create({ data: { task_id: stray.id, status: "running", started_at: new Date() } });
    await tasks.completeRun({ agentId: other.agent.id, taskId: stray.id, runId: strayRun.id, status: "succeeded", stdout: null, stderr: null, output: { ok: true }, artifacts: { apps: [], winget: { state: "ok" }, chocolatey: { state: "ok" } } });
    check("scan: another agent cannot complete the task or wipe the list", (await rows(d1)).length === 2 && (await rows(other)).length === 0);
    await finishAll(d1);

    // ---------------------------------------------------------------- a confirmed update clears the row
    async function upgradeResult(d, payload, status, output) {
        const task = await prisma.agent_tasks.create({ data: { agent_id: d.agent.id, type: "software_install", payload, status: "running" } });
        const run = await prisma.agent_task_runs.create({ data: { task_id: task.id, status: "running", started_at: new Date() } });
        await tasks.completeRun({ agentId: d.agent.id, taskId: task.id, runId: run.id, status, stdout: "x", stderr: null, output, artifacts: null });
    }
    await upgradeResult(d1, { action: "upgrade", method: "winget", wingetId: "New.App", name: "New", matchText: "New" }, "failed", { ok: false, verified: false, message: "failed" });
    check("update: a failed update leaves the row", (await rows(d1)).some((x) => x.app_id === "New.App"));
    await upgradeResult(d1, { action: "upgrade", method: "winget", wingetId: "New.App", name: "New", matchText: "New" }, "succeeded", { ok: true, verified: false, message: "unconfirmed" });
    check("update: an unconfirmed update leaves the row", (await rows(d1)).some((x) => x.app_id === "New.App"));
    await upgradeResult(d1, { action: "upgrade", method: "winget", wingetId: "new.app", name: "New", matchText: "New" }, "succeeded", { ok: true, verified: true, message: "ok" });
    check("update: a confirmed update removes the row (ids match without regard to case)", !(await rows(d1)).some((x) => x.app_id === "New.App") && (await rows(d1)).length === 1);
    await upgradeResult(d1, { action: "install", method: "chocolatey", chocolateyId: "7zip.7zip", name: "x", matchText: "x" }, "succeeded", { ok: true, verified: true });
    check("update: an ordinary install does not touch the list", (await rows(d1)).length === 1);

    // ---------------------------------------------------------------- the lists
    const L = async (rule, appId, clientId, source = "winget") => svc.setRule({ rule, source, appId, clientId, name: appId }, null, o);
    const orgBlock = await L("block", "Git.Git", null);
    check("lists: a never-update entry for the whole organisation is saved", !!orgBlock.id && orgBlock.rule === "block");
    const again = await L("allow", "git.git", null);
    check("lists: the same program in the same place is changed, not duplicated", again.id === orgBlock.id && again.rule === "allow" && (await svc.listRules(o, null)).items.filter((x) => x.appId.toLowerCase() === "git.git").length === 1);
    await L("block", "Git.Git", null);
    const custRule = await L("allow", "7zip.7zip", A.client.id);
    check("lists: a customer's own entry is saved and listed with the customer", (await svc.listRules(o, null, A.client.id)).items.some((x) => x.id === custRule.id && x.customer === A.client.name));
    check("lists: filtering by customer shows that customer's and the organisation's entries only", !(await svc.listRules(o, null, B.client.id)).items.some((x) => x.id === custRule.id) && (await svc.listRules(o, null, B.client.id)).items.some((x) => x.id === orgBlock.id));
    check("lists: a bad id, source, rule or customer is refused", await fails(() => L("block", "a b", null), /not valid/) && await fails(() => L("maybe", "A.B", null), /allow or block/) && await fails(() => svc.setRule({ rule: "block", source: "apt", appId: "x" }, null, o), /winget or chocolatey/) && await fails(() => L("block", "A.B", "not-a-uuid"), /not valid/) && await fails(() => L("block", "A.B", crypto.randomUUID()), /does not exist/));
    await svc.removeRule(custRule.id, null, o);
    check("lists: an entry can be removed, and a second removal says it is gone", !(await svc.listRules(o, null)).items.some((x) => x.id === custRule.id) && await fails(() => svc.removeRule(custRule.id, null, o), /does not exist/));

    // someone limited to customer A
    const mkUser = async (label, clientIds) => {
        const id = crypto.randomUUID();
        await prisma.$executeRaw`INSERT INTO users (id, organization_id, email, first_name, last_name, status, password_hash) VALUES (${id}::uuid, ${o}::uuid, ${`upd-${label}-${id}@example.test`}, 'E2E', ${label}, 'active', 'x')`;
        for (const c of clientIds) await prisma.$executeRaw`INSERT INTO user_client_access (user_id, client_id) VALUES (${id}::uuid, ${c}::uuid)`;
        return id;
    };
    const limitedA = await mkUser("limitedA", [A.client.id]);
    check("lists: someone limited to a customer cannot set an organisation-wide entry", await fails(() => svc.setRule({ rule: "block", appId: "Zoom.Zoom.EXE" }, limitedA, o), /do not have access/));
    check("lists: nor an entry for a customer outside their list", await fails(() => svc.setRule({ rule: "block", appId: "Zoom.Zoom.EXE", clientId: B.client.id }, limitedA, o), /do not have access/));
    const limRule = await svc.setRule({ rule: "block", appId: "Zoom.Zoom.EXE", clientId: A.client.id }, limitedA, o);
    check("lists: but can for their own customer, and sees only theirs plus the organisation's", !!limRule.id && (await svc.listRules(o, limitedA)).items.every((x) => x.clientId === null || x.clientId === A.client.id));
    const bRule = await svc.setRule({ rule: "block", appId: "Foo.Bar", clientId: B.client.id }, null, o);
    check("lists: they cannot see or remove another customer's entry", !(await svc.listRules(o, limitedA)).items.some((x) => x.id === bRule.id) && await fails(() => svc.removeRule(bRule.id, limitedA, o), /do not have access/));
    await svc.removeRule(limRule.id, null, o);
    await svc.removeRule(bRule.id, null, o);

    // ---------------------------------------------------------------- manual scans and updates
    const dA = await device(A, "manA");
    const dB = await device(B, "manB");
    const dLinux = await device(A, "lin", { os: "linux" });
    const dOld = await device(A, "old", { version: "1.3.10" });
    const dOff = await device(A, "off", { online: false });
    for (const d of [dA, dB]) await scanResult(d, { apps: [w("7zip.7zip", "7-Zip 25.01 (x64)", "25.01", "26.06"), w("Git.Git", "Git", "2.40.0", "2.56.0"), w("VideoLAN.VLC", "VLC media player", "3.0.20", "3.0.21")] });
    await finishAll(dA); await finishAll(dB);
    let res = await svc.scanNow({ deviceIds: [dA.dev.id, dLinux.dev.id, dOld.dev.id, dOff.dev.id, crypto.randomUUID()] }, null, o);
    const why = (id) => res.skipped.find((s) => s.deviceId === id)?.reason ?? "";
    check("scan now: queues for a capable device and skips the rest with the reason", res.queued === 1 && /Windows/.test(why(dLinux.dev.id)) && /agent is 1\.3\.10/.test(why(dOld.dev.id)) && /offline/.test(why(dOff.dev.id)) && /not found/.test(res.skipped.find((s) => s.reason === "Device not found.")?.reason ?? ""), res);
    res = await svc.scanNow({ deviceIds: [dA.dev.id] }, null, o);
    check("scan now: a second request while one waits is skipped", res.queued === 0 && /already waiting/.test(res.skipped[0]?.reason));
    const scanTask = (await scanTasks(dA))[0];
    check("scan now: the task is a software_updates_scan, queued by nobody in particular for the agent", scanTask.type === "software_updates_scan" && scanTask.status === "queued");
    await finishAll(dA);
    check("scan now: more than 200 devices is refused, and no devices too", await fails(() => svc.scanNow({ deviceIds: Array.from({ length: 201 }, () => crypto.randomUUID()) }, null, o), /200 devices at most/) && await fails(() => svc.scanNow({ deviceIds: [] }, null, o), /at least one device/));

    let pv = await svc.preview({ deviceIds: [dA.dev.id, dB.dev.id, dLinux.dev.id], apps: [{ source: "winget", appId: "7zip.7zip" }] }, null, o);
    check("update preview: lists who gets what, and changes nothing", pv.eligible.length === 2 && pv.eligible.every((e) => e.appId === "7zip.7zip" && e.to === "26.06") && (await upgrades(dA)).length === 0);
    check("update preview: a non-Windows device is skipped with the reason", pv.skipped.some((s) => s.deviceId === dLinux.dev.id && /Windows/.test(s.reason)));
    res = await svc.update({ deviceIds: [dA.dev.id, dB.dev.id], apps: [{ source: "winget", appId: "7zip.7zip" }, { source: "winget", appId: "Nope.App" }] }, null, o);
    check("update: one task per device and program, with the program asked for by id", res.queued === 2 && res.skipped.length === 2 && res.skipped.every((s) => /not listed as outdated/.test(s.reason)));
    const t1 = (await upgrades(dA))[0];
    check("update: the task asks for an upgrade by exact winget id with the versions seen", t1.type === "software_install" && t1.payload.action === "upgrade" && t1.payload.method === "winget" && t1.payload.wingetId === "7zip.7zip" && t1.payload.fromVersion === "25.01" && t1.payload.toVersion === "26.06" && t1.payload.matchText === "7-Zip (x64)" && t1.status === "queued", t1.payload);
    res = await svc.update({ deviceIds: [dA.dev.id], apps: [{ source: "winget", appId: "7zip.7zip" }] }, null, o);
    check("update: the same update is not queued twice", res.queued === 0 && /already waiting/.test(res.skipped[0].reason));
    await L("block", "VideoLAN.VLC", null);
    res = await svc.update({ deviceIds: [dA.dev.id], apps: [{ source: "winget", appId: "VideoLAN.VLC" }] }, null, o);
    check("update: a never-update program is refused by hand too, with the reason", res.queued === 0 && /never-update/.test(res.skipped[0].reason));
    await svc.removeRule((await svc.listRules(o, null)).items.find((x) => x.appId === "VideoLAN.VLC").id, null, o);
    await finishAll(dA); await finishAll(dB);
    res = await svc.update({ deviceIds: [dA.dev.id], all: true }, null, o);
    check("update: 'all' updates everything listed except what is blocked (Git is blocked organisation-wide)", res.queued === 2 && res.skipped.some((s) => s.appId === "Git.Git" && /never-update/.test(s.reason)), res);
    await finishAll(dA);
    check("update: no program and no 'all' is refused; so are 201 devices and 51 programs", await fails(() => svc.update({ deviceIds: [dA.dev.id], apps: [] }, null, o), /Choose at least one program/) && await fails(() => svc.update({ deviceIds: Array.from({ length: 201 }, () => crypto.randomUUID()), all: true }, null, o), /200 devices at most/) && await fails(() => svc.update({ deviceIds: [dA.dev.id], apps: Array.from({ length: 51 }, (_, i) => ({ source: "winget", appId: `A.B${i}` })) }, null, o), /50 programs at most/));
    check("update: a bad program id is refused", await fails(() => svc.update({ deviceIds: [dA.dev.id], apps: [{ source: "winget", appId: "x;y" }] }, null, o), /not valid/));
    res = await svc.update({ deviceIds: [dLinux.dev.id, dOld.dev.id, dOff.dev.id], all: true }, null, o);
    check("update: Linux, old agents and offline devices are skipped, nothing queued", res.queued === 0 && res.skipped.length === 3);

    // customer limits
    res = await svc.update({ deviceIds: [dA.dev.id, dB.dev.id], apps: [{ source: "winget", appId: "VideoLAN.VLC" }] }, limitedA, o);
    check("limits: someone limited to customer A cannot update customer B's device (it is simply not found)", res.queued === 1 && res.skipped.some((s) => s.deviceId === dB.dev.id && /not found/.test(s.reason)));
    check("limits: nor scan it", (await svc.scanNow({ deviceIds: [dB.dev.id] }, limitedA, o)).queued === 0);
    check("limits: nor open its outdated programs", await fails(() => svc.forDevice(o, limitedA, dB.dev.id), /not found/i));
    await finishAll(dA); await finishAll(dB);

    // ---------------------------------------------------------------- one device's view
    const view = await svc.forDevice(o, null, dA.dev.id);
    check("device view: lists programs with versions, the scan, the rule state and the automation", view.supported && view.items.length === 3 && !!view.scan && view.scan.ok && view.scan.winget === "ok" && view.items.find((i) => i.appId === "Git.Git").blocked === true && view.automation.mode === "none" && view.automation.scanEveryHours === 0, view);
    check("device view: the name has the version taken out, and the last attempt is shown", view.items.find((i) => i.appId === "7zip.7zip").name === "7-Zip (x64)" && !!view.items.find((i) => i.appId === "7zip.7zip").lastAttempt);
    const lin = await svc.forDevice(o, null, dLinux.dev.id);
    check("device view: a Linux device says plainly it is not supported", lin.supported === false && /Windows/.test(lin.reason) && lin.items.length === 0);
    const oldView = await svc.forDevice(o, null, dOld.dev.id);
    check("device view: an old agent can see the screen but is told to update", oldView.supported === true && oldView.canScan === false && /1\.3\.10/.test(oldView.reason));

    // ---------------------------------------------------------------- the fleet screen
    let fleet = await svc.fleet(o, null, { clientId: A.client.id });
    const z = fleet.items.find((i) => i.appId === "7zip.7zip");
    check("fleet: one row per program with device count, versions and available versions", !!z && z.devices === 2 && z.name === "7-Zip (x64)" && z.versions[0].installed === "25.01" && z.availableVersions.includes("26.06"), z);
    check("fleet: the organisation-wide rule shows on the program", fleet.items.find((i) => i.appId === "Git.Git").rule === "block");
    check("fleet: coverage counts the Windows devices of the customer and how many were scanned", fleet.coverage.windowsDevices === 5 && fleet.coverage.scanned === 2 && fleet.coverage.neverScanned === 3, fleet.coverage);
    fleet = await svc.fleet(o, null, { clientId: B.client.id });
    check("fleet: filtering by customer counts only that customer", fleet.items.find((i) => i.appId === "7zip.7zip").devices === 1);
    check("fleet: search and source filters work", (await svc.fleet(o, null, { clientId: A.client.id, q: "vlc" })).items.length === 1 && (await svc.fleet(o, null, { clientId: A.client.id, source: "chocolatey" })).items.length === 0 && await fails(() => svc.fleet(o, null, { source: "apt" }), /winget or chocolatey/));
    fleet = await svc.fleet(o, limitedA, {});
    check("fleet: someone limited to customer A sees only customer A's devices", fleet.items.find((i) => i.appId === "7zip.7zip").devices === 2 && fleet.coverage.windowsDevices === 5);
    const fd = await svc.fleetDevices(o, null, { source: "winget", appId: "7zip.7zip", clientId: A.client.id });
    check("fleet devices: the devices that have the program outdated, with versions", fd.items.length === 2 && fd.items.some((i) => i.deviceId === dA.dev.id && i.installedVersion === "25.01"));
    check("fleet devices: limited staff do not see other customers' devices", (await svc.fleetDevices(o, limitedA, { source: "winget", appId: "7zip.7zip" })).items.every((i) => i.customer === A.client.name));
    check("fleet devices: a bad program is refused", await fails(() => svc.fleetDevices(o, null, { source: "winget", appId: "a b" }), /not valid/));

    // ---------------------------------------------------------------- the report
    const rep = await endpoint.run("outdated-software", { clientId: A.client.id });
    const repRow = rep.rows.find((x) => x.appId === "7zip.7zip");
    check("report: one row per program with device count, versions and source", !!repRow && repRow.devices === 2 && repRow.source === "winget" && /25\.01 \(2\)/.test(repRow.installedVersions) && repRow.customers === 1, repRow);
    check("report: the summary and the scan coverage note", rep.summary.some((s) => s.label === "Devices scanned") && rep.notes.some((n) => /have been scanned|has been scanned/.test(n)));
    const repB = await endpoint.run("outdated-software", { clientId: B.client.id });
    check("report: limited to a customer, other customers are not counted", repB.rows.find((x) => x.appId === "7zip.7zip").devices === 1);

    // ---------------------------------------------------------------- policy settings
    const mk = (C, name, patching, extra = {}) => policies.create({ name: `${name} ${stamp}`, sections: { patching, maintenance: { windows: [ALL_DAY] } }, assignments: [{ level: "customer", targetId: C.client.id }], ...extra }, me, o);
    check("policy: the scan hours and update settings are saved", (await policies.preview({ name: "x", sections: { patching: { appScanHours: 12, appUpdate: "listed", appUpdateIn: "maintenance" } } }, o)) !== null);
    check("policy: bad values are refused", await fails(() => policies.create({ name: `bad1 ${stamp}`, sections: { patching: { appUpdate: "everything" } } }, me, o), /none.*listed.*all/) && await fails(() => policies.create({ name: `bad2 ${stamp}`, sections: { patching: { appScanHours: 1000 } } }, me, o), /whole number from 0 to 720/) && await fails(() => policies.create({ name: `bad3 ${stamp}`, sections: { patching: { appUpdateIn: "sometime" } } }, me, o), /anytime/) && await fails(() => policies.create({ name: `bad4 ${stamp}`, sections: { patching: { appScan: 1 } } }, me, o), /do not know/));

    // ---------------------------------------------------------------- automation
    const C = await customer("auto");
    const a1 = await device(C, "auto1");
    const aStale = await device(C, "stale");
    const aOldAgent = await device(C, "oldagent", { version: "1.3.10" });
    const aLinux = await device(C, "linuxauto", { os: "linux" });
    await L("allow", "7zip.7zip", null);
    await L("allow", "Allowed.One", C.client.id);
    await L("block", "Blocked.One", C.client.id);
    const apps = [w("7zip.7zip", "7-Zip 25.01 (x64)", "25.01", "26.06"), w("Allowed.One", "Allowed One", "1.0", "2.0"), w("Blocked.One", "Blocked One", "1.0", "2.0"), w("Unlisted.One", "Unlisted One", "1.0", "2.0"), w("Approx.One", "Approx", "< 1.0", "2.0", { approximate: true }), { source: "chocolatey", id: "choco-app", name: "choco-app", installedVersion: "1.0", availableVersion: "1.1", approximate: false }];
    await scanResult(a1, { apps, chocolatey: "ok" });
    await scanResult(aOldAgent, { apps });
    await scanResult(aLinux, { apps });
    await scanResult(aStale, { apps });
    await prisma.agent_software_scans.update({ where: { agent_id: aStale.agent.id }, data: { scanned_at: new Date(Date.now() - 8 * 86400_000) } });
    await Promise.all([a1, aOldAgent, aLinux, aStale].map(finishAll));

    // no policy: nothing happens
    let run = await auto.run();
    check("automation: with no policy nothing is scanned or updated", (await scanTasks(a1)).length === 1 /* the one from scanResult */ && (await upgrades(a1)).length === 0);

    // a window that is closed: scans happen, updates do not
    const pClosed = await policies.create({ name: `closed ${stamp}`, sections: { patching: { appScanHours: 6, appUpdate: "listed", appUpdateIn: "maintenance" }, maintenance: { windows: [CLOSED] } }, assignments: [{ level: "customer", targetId: C.client.id }] }, me, o);
    await prisma.agent_tasks.deleteMany({ where: { agent_id: a1.agent.id, type: "software_updates_scan" } });
    run = await auto.run();
    check("automation: a scan is queued for a device that has none inside its interval", (await scanTasks(a1)).length === 1 && (await scanTasks(a1))[0].created_by === null && (await scanTasks(a1))[0].payload.scheduled === true);
    run = await auto.run();
    check("automation: not queued again while one waits", (await scanTasks(a1)).length === 1);
    await finishAll(a1);
    run = await auto.run();
    check("automation: not queued again inside the interval", (await scanTasks(a1)).length === 1);
    await prisma.agent_tasks.updateMany({ where: { agent_id: a1.agent.id, type: "software_updates_scan" }, data: { created_at: new Date(Date.now() - 7 * 3600_000) } });
    run = await auto.run();
    check("automation: queued again once the interval has passed", (await scanTasks(a1)).length === 2);
    check("automation: old agents, Linux devices are never scanned", (await scanTasks(aOldAgent)).length === 1 && (await scanTasks(aLinux)).length === 1);
    check("automation: outside the maintenance window no program is updated", (await upgrades(a1)).length === 0 && (await actions(a1)).length === 0);
    await finishAll(a1);

    // open window, only listed apps
    await policies.update(pClosed.id, { sections: { patching: { appScanHours: 6, appUpdate: "listed", appUpdateIn: "maintenance" }, maintenance: { windows: [ALL_DAY] } } }, me, o);
    run = await auto.run();
    let up = await upgrades(a1);
    const ids = up.map((t) => t.payload.wingetId ?? t.payload.chocolateyId).sort();
    check("automation: in the window only allowed programs are updated (organisation and customer lists)", ids.join(",") === "7zip.7zip,Allowed.One", ids);
    check("automation: a blocked, unlisted or only-approximately-known program is left alone", !ids.includes("Blocked.One") && !ids.includes("Unlisted.One") && !ids.includes("Approx.One"));
    check("automation: what policies did is recorded for the device, with the policy and the programs", (await actions(a1)).length === 1 && (await actions(a1))[0].policy_name === `closed ${stamp}` && (await actions(a1))[0].detail.count === 2 && (await actions(a1))[0].detail.apps[0].to);
    check("automation: updates started by a policy have no person behind them and ask for an upgrade by id", up.every((t) => t.created_by === null && t.payload.action === "upgrade"));
    run = await auto.run();
    check("automation: waiting updates are not queued twice", (await upgrades(a1)).length === 2);
    await finishAll(a1);
    run = await auto.run();
    check("automation: a program that was just tried is not tried again for a day", (await upgrades(a1)).length === 2 && (await actions(a1)).length === 1);
    check("automation: an old scan is not trusted", (await upgrades(aStale)).length === 0);
    check("automation: no updates for old agents or Linux", (await upgrades(aOldAgent)).length === 0 && (await upgrades(aLinux)).length === 0);

    // mode all, any time: everything not blocked, including chocolatey
    await policies.update(pClosed.id, { sections: { patching: { appUpdate: "all", appUpdateIn: "anytime" }, maintenance: { windows: [CLOSED] } } }, me, o);
    await prisma.agent_tasks.updateMany({ where: { agent_id: a1.agent.id, type: "software_install" }, data: { created_at: new Date(Date.now() - 2 * 86400_000) } });
    run = await auto.run();
    up = (await upgrades(a1)).filter((t) => t.created_at.getTime() > Date.now() - 3600_000);
    const ids2 = up.map((t) => t.payload.wingetId ?? t.payload.chocolateyId).sort();
    check("automation: 'all' updates everything not blocked, outside any window when set to any time, chocolatey too", ids2.join(",") === "7zip.7zip,Allowed.One,Unlisted.One,choco-app", ids2);
    check("automation: a chocolatey program is asked for with its chocolatey id", up.some((t) => t.payload.method === "chocolatey" && t.payload.chocolateyId === "choco-app"));
    await finishAll(a1);

    // mode none
    await policies.update(pClosed.id, { sections: { patching: { appScanHours: 0, appUpdate: "none" }, maintenance: { windows: [ALL_DAY] } } }, me, o);
    await prisma.agent_tasks.updateMany({ where: { agent_id: a1.agent.id }, data: { created_at: new Date(Date.now() - 3 * 86400_000) } });
    const nBefore = (await upgrades(a1)).length + (await scanTasks(a1)).length;
    run = await auto.run();
    check("automation: turned off, nothing is scanned or updated", (await upgrades(a1)).length + (await scanTasks(a1)).length === nBefore);

    // ---------------------------------------------------------------- a policy that was never touched changes nothing for others
    check("automation: a device of another customer without a policy was not touched", (await actions(dA)).length === 0 && (await scanTasks(dB)).every((t) => t.payload.scheduled !== true));

    console.log(`\n${passed} passed, ${failed} failed`);
    await app.close();
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
