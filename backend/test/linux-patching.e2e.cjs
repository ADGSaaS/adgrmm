// Linux patching against a real database: scans and installs are queued for Linux agents that can run them (and refused for
// ones that cannot), a Linux scan reads back with its security flags, policies and maintenance windows patch Linux
// devices, the restart is a Linux restart, and the patching reports list Linux devices beside Windows ones.
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
    const { PatchAutomationService, approved } = require(path.join(dist, "patches/patch-automation.service.js"));
    const { PatchesService } = require(path.join(dist, "patches/patches.service.js"));
    const lp = require(path.join(dist, "patches/linux-patching.js"));
    const { PrismaService } = require(path.join(dist, "storage/prisma.service.js"));
    const { EndpointReportsService } = require(path.join(dist, "reports/endpoint-reports.service.js"));
    const { DeviceActionsController } = require(path.join(dist, "devices/device-actions.controller.js"));

    const app = await NestFactory.createApplicationContext(AppModule, { logger: ["error"] });
    const svc = app.get(PoliciesService, { strict: false });
    const auto = app.get(PatchAutomationService, { strict: false });
    const patches = app.get(PatchesService, { strict: false });
    const prisma = app.get(PrismaService, { strict: false });
    const endpoint = app.get(EndpointReportsService, { strict: false });
    const actions = app.get(DeviceActionsController, { strict: false });

    const org = await prisma.organizations.upsert({ where: { slug: "default" }, create: { name: "Default Organization", slug: "default" }, update: {} });
    const o = org.id;
    const stamp = Date.now();
    const me = { id: null, name: "Test Person" };
    const ALL_DAY = { name: "Always", days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "00:00", timezone: "UTC" };
    const MIN = lp.LINUX_PATCH_MIN_VERSION;

    // ---- the helpers
    check("version comparison is numeric", lp.agentVersionAtLeast("1.10.0", "1.3.34") && !lp.agentVersionAtLeast("1.3.33", "1.3.34") && lp.agentVersionAtLeast("1.3.34", "1.3.34") && !lp.agentVersionAtLeast("garbage", "1.3.34") && !lp.agentVersionAtLeast(null, "1.3.34"));
    check("the minimum can be raised but never lowered", lp.linuxPatchMinVersion("1.9.0") === "1.9.0" && lp.linuxPatchMinVersion("1.0.0") === MIN && lp.linuxPatchMinVersion("nonsense") === MIN && lp.linuxPatchMinVersion(undefined) === MIN);
    check("the OS comes from the agent's report first, then the device record", lp.patchOs({ os: "linux" }, "Windows 11") === "linux" && lp.patchOs({}, "Ubuntu 22.04.5 LTS") === "linux" && lp.patchOs({}, "Rocky Linux 9.3") === "linux" && lp.patchOs(null, "Windows 10 Pro") === "windows" && lp.patchOs({}, "macOS 14") === null);
    check("Windows always can patch, Linux only with a new enough agent", lp.canPatch("windows", "1.0.0") && lp.canPatch("linux", MIN) && !lp.canPatch("linux", "1.3.33") && !lp.canPatch(null, MIN));

    async function device(label, { os = "linux", version = MIN, facts = {}, osName } = {}) {
        const client = await prisma.clients.create({ data: { organization_id: o, name: `LP ${label} ${stamp}` } });
        const site = await prisma.sites.create({ data: { client_id: client.id, name: "HQ" } });
        const dev = await prisma.devices.create({ data: { site_id: site.id, hostname: `LX-${label}-${stamp}`, operating_system: osName ?? (os === "windows" ? "Windows 11 Pro" : "Ubuntu 22.04.5 LTS") } });
        const agent = await prisma.agents.create({ data: { device_id: dev.id, agent_uuid: crypto.randomUUID(), version, last_check_in_at: new Date(), facts: { os, device: { boot: { pendingReboot: false } }, ...facts } } });
        return { client, site, dev, agent };
    }
    const scan = async (d, artifacts, { finished = new Date() } = {}) => {
        const task = await prisma.agent_tasks.create({ data: { agent_id: d.agent.id, type: "patch_scan", payload: {}, status: "succeeded" } });
        const run = await prisma.agent_task_runs.create({ data: { task_id: task.id, status: "succeeded", finished_at: finished, output: { ok: true } } });
        await prisma.agent_task_results.create({ data: { run_id: run.id, artifacts } });
    };
    const install = async (d, artifacts, { finished = new Date() } = {}) => {
        const task = await prisma.agent_tasks.create({ data: { agent_id: d.agent.id, type: "patch_install", payload: {}, status: "succeeded" } });
        const run = await prisma.agent_task_runs.create({ data: { task_id: task.id, status: "succeeded", finished_at: finished, output: { ok: true } } });
        await prisma.agent_task_results.create({ data: { run_id: run.id, artifacts } });
    };
    const linuxScan = {
        packageManager: "apt",
        patches: [
            { id: "libssl3", title: "libssl3 3.0.2-0ubuntu1.12 to 3.0.2-0ubuntu1.13", severity: "Important", requiresReboot: false, kbIds: [], security: true, name: "libssl3", current: "3.0.2-0ubuntu1.12", available: "3.0.2-0ubuntu1.13", source: "jammy-security" },
            { id: "linux-image-5.15.0-91-generic", title: "Kernel linux-image-5.15.0-91-generic 5.15.0-91.101", severity: "Important", requiresReboot: true, kbIds: [], security: true, name: "linux-image-5.15.0-91-generic", current: null, available: "5.15.0-91.101" },
            { id: "tzdata", title: "tzdata 2023c to 2023d", severity: null, requiresReboot: false, kbIds: [], security: false, name: "tzdata", current: "2023c", available: "2023d" },
        ],
        skipped: [{ id: "libc6", reason: "held" }],
        rebootRequired: true,
        rebootReason: "Restart needed for linux-base",
    };
    const tasksOf = (d, type) => prisma.agent_tasks.findMany({ where: { agent_id: d.agent.id, type }, orderBy: { created_at: "desc" } });
    const policyFor = (d, name, sections) => svc.create({ name: `${name} ${stamp}`, sections, assignments: [{ level: "customer", targetId: d.client.id }] }, me, o);

    // ---- queueing
    const A = await device("new");
    const OLD = await device("old", { version: "1.3.33" });
    const WEIRD = await device("mac", { os: "macos", osName: "macOS 14" });
    const r1 = await patches.enqueueScan(A.dev.id, false, null);
    check("a Linux device with a new agent is given a scan task", r1.accepted === true && (await tasksOf(A, "patch_scan")).length === 1);
    check("an older Linux agent is refused with the version it needs", await fails(() => patches.enqueueScan(OLD.dev.id, false, null), new RegExp(`needs agent ${MIN.replace(/\./g, "\\.")}`)) && (await tasksOf(OLD, "patch_scan")).length === 0);
    check("so is an install for it", await fails(() => patches.enqueueInstall(OLD.dev.id, false, ["x"], null), /needs agent/));
    check("another operating system is refused", await fails(() => patches.enqueueScan(WEIRD.dev.id, false, null), /Windows and Linux/));
    await patches.enqueueInstall(A.dev.id, false, ["libssl3", "tzdata"], null);
    const inst = (await tasksOf(A, "patch_install"))[0];
    check("an install names the packages, as on Windows", inst.status === "queued" && JSON.stringify(inst.payload.ids) === JSON.stringify(["libssl3", "tzdata"]) && inst.payload.mode === undefined, inst.payload);
    await prisma.agent_tasks.update({ where: { id: inst.id }, data: { status: "succeeded" } });
    await patches.enqueueInstallMode(A.dev.id, "security", false, null);
    check("installing all security updates is left for the agent to work out", (await tasksOf(A, "patch_install"))[0].payload.mode === "security" && (await tasksOf(A, "patch_install"))[0].payload.ids.length === 0);
    const act = await actions.patch(A.dev.id, {});
    const actTask = await prisma.agent_tasks.findUnique({ where: { id: act.jobId } });
    check("the Install-all device action queues a patch_install in mode all for Linux", act.accepted === true && actTask?.type === "patch_install" && actTask.payload.mode === "all", actTask);
    check("and refuses an old Linux agent", await fails(() => actions.patch(OLD.dev.id, {}), /needs agent/));

    // ---- scheduled scans
    await prisma.agent_tasks.deleteMany({ where: { agent_id: { in: [A.agent.id, OLD.agent.id] } } });
    const queued = await patches.queueDueScans(24);
    check("the daily sweep scans a Linux device with a new agent and leaves an old one alone", (await tasksOf(A, "patch_scan")).length === 1 && (await tasksOf(OLD, "patch_scan")).length === 0 && queued >= 1, queued);
    await prisma.agent_tasks.deleteMany({ where: { agent_id: A.agent.id } });

    // ---- reading a scan back
    await scan(A, linuxScan, { finished: new Date(Date.now() - 3600_000) });
    let latest = await patches.getLatest(A.dev.id);
    const lib = latest.patches.find((p) => p.id === "libssl3");
    check("a Linux scan reads back with the security flag and versions", latest.os === "linux" && latest.supported === true && lib.security === true && lib.current === "3.0.2-0ubuntu1.12" && lib.available === "3.0.2-0ubuntu1.13" && latest.patches.find((p) => p.id === "tzdata").security === false, latest.patches);
    check("with the package manager, what is held and the restart", latest.packageManager === "apt" && latest.skipped[0].id === "libc6" && latest.rebootRequired === true && /linux-base/.test(latest.rebootReason), latest);
    const OLDL = await patches.getLatest(OLD.dev.id);
    check("an old Linux agent's device says why it cannot be patched", OLDL.supported === false && /needs agent/.test(OLDL.unsupportedReason) && OLDL.os === "linux");
    check("a Windows scan still has no Linux fields in its rows", await (async () => { const W = await device("w", { os: "windows" }); await scan(W, { patches: [{ id: "kb1", title: "t", severity: "Critical", requiresReboot: false, kbIds: ["KB1"] }] }); const l = await patches.getLatest(W.dev.id); await prisma.clients.delete({ where: { id: W.client.id } }); return l.os === "windows" && l.patches[0].security === undefined && l.patches[0].current === undefined && l.supported; })());

    await install(A, { installed: ["libssl3"], requiresReboot: false }, { finished: new Date() });
    latest = await patches.getLatest(A.dev.id);
    check("an install after the scan marks its packages installed", latest.patches.find((p) => p.id === "libssl3").status === "Installed" && latest.patches.find((p) => p.id === "tzdata").status === "Required");
    await scan(A, linuxScan, { finished: new Date(Date.now() + 60_000) });
    latest = await patches.getLatest(A.dev.id);
    check("but a newer scan of the same package name starts again as required", latest.patches.find((p) => p.id === "libssl3").status === "Required", latest.patches.map((p) => p.status));

    // ---- approval
    check("critical approval means security updates on Linux", approved({ severity: "Moderate", security: true, status: "Required" }, "critical") && !approved({ severity: null, security: false, status: "Required" }, "critical") && approved({ severity: null, security: false, status: "Required" }, "all") && !approved({ severity: null, security: true, status: "Installed" }, "critical"));

    // ---- automatic patching
    const B = await device("auto");
    await scan(B, linuxScan);
    const pol = await policyFor(B, "Linux security", { patching: { approve: "critical", reboot: "always" } });
    let r = await auto.run();
    let tasks = await tasksOf(B, "patch_install");
    check("a policy that approves critical installs the Linux security updates only", tasks.length === 1 && JSON.stringify(tasks[0].payload.ids.sort()) === JSON.stringify(["libssl3", "linux-image-5.15.0-91-generic"]), tasks.map((t) => t.payload));
    const done = await prisma.policy_actions.findMany({ where: { device_id: B.dev.id, kind: "patch_install" } });
    check("it is recorded with the policy, as for Windows", done.length === 1 && done[0].policy_name === pol.name && done[0].detail.count === 2);
    await prisma.agent_tasks.update({ where: { id: tasks[0].id }, data: { status: "succeeded" } });
    await prisma.agents.update({ where: { id: B.agent.id }, data: { facts: { os: "linux", device: { boot: { pendingReboot: true } } } } });
    r = await auto.run();
    const jobs = await prisma.jobs.findMany({ where: { agent_id: B.agent.id } });
    check("the restart is a Linux restart, run with bash", r.reboots === 1 && jobs.length === 1 && /shutdown -r \+2/.test(JSON.stringify(jobs[0].payload)) && /bash/.test(JSON.stringify(jobs[0].payload)) && !/shutdown\.exe/.test(JSON.stringify(jobs[0].payload)), jobs.map((j) => j.payload));
    await auto.run();
    check("and not repeated within hours", (await prisma.policy_actions.count({ where: { device_id: B.dev.id, kind: "reboot" } })) === 1);

    const C = await device("window");
    await scan(C, linuxScan);
    const closed = { name: "Another day", days: [(new Date().getUTCDay() + 3) % 7], start: "01:00", end: "02:00", timezone: "UTC" };
    const winPol = await policyFor(C, "Linux in window", { maintenance: { windows: [closed] }, patching: { approve: "all", installIn: "maintenance" } });
    await auto.run();
    check("Linux installs wait for the maintenance window", (await tasksOf(C, "patch_install")).length === 0);
    await svc.update(winPol.id, { sections: { maintenance: { windows: [ALL_DAY] }, patching: { approve: "all", installIn: "maintenance" } } }, me, o);
    await auto.run();
    const winTasks = await tasksOf(C, "patch_install");
    check("and start inside it, with every update", winTasks.length === 1 && winTasks[0].payload.ids.length === 3);

    const D = await device("oldauto", { version: "1.3.33" });
    await scan(D, linuxScan);
    await policyFor(D, "Old agent policy", { patching: { approve: "all", reboot: "always" } });
    await prisma.agents.update({ where: { id: D.agent.id }, data: { facts: { os: "linux", device: { boot: { pendingReboot: true } } } } });
    await auto.run();
    check("a Linux agent that cannot run patch tasks is left alone", (await tasksOf(D, "patch_install")).length === 0 && (await prisma.jobs.count({ where: { agent_id: D.agent.id } })) === 0);

    // ---- reports
    await scan(A, linuxScan, { finished: new Date() });
    const pc = await endpoint.run("patch-compliance", { clientId: A.client.id });
    const row = pc.rows.find((x) => x.name === `LX-new-${stamp}`);
    check("patch compliance lists the Linux device with its security count", row && row.missing === 3 && row.security === 2 && /3 missing/.test(row.issues) && /2 security/.test(row.issues) && row.needsRestart === "Yes", row);
    const miss = await endpoint.run("patch-missing", { clientId: A.client.id });
    check("missing updates lists packages by name, security ones as Important", miss.rows.length === 3 && miss.rows.some((x) => x.kb === "libssl3" && x.severity === "Important") && miss.rows.some((x) => x.kb === "tzdata" && x.severity === "Unrated"), miss.rows.map((x) => [x.kb, x.severity]));
    const pcOld = await endpoint.run("patch-compliance", { clientId: OLD.client.id });
    check("a Linux device with an old agent is left out, and the note says so", pcOld.rows.length === 0 && pcOld.notes.some((n) => /1 device that is not Windows or Linux/.test(n)), pcOld.notes);
    const ap = await endpoint.run("automatic-patching", { clientId: B.client.id });
    check("the automatic patching report lists the Linux device", ap.rows.length === 1 && ap.rows[0].installs === "Critical and important" && ap.rows[0].restarts === "Straight away" && ap.rows[0].mode === "Automatic", ap.rows);

    // ---- clean up
    for (const d of [A, OLD, WEIRD, B, C, D]) {
        await prisma.jobs.deleteMany({ where: { agent_id: d.agent.id } });
        await prisma.policy_actions.deleteMany({ where: { device_id: d.dev.id } });
        await prisma.agent_tasks.deleteMany({ where: { agent_id: d.agent.id } });
        await prisma.clients.delete({ where: { id: d.client.id } }).catch(() => { });
    }
    await prisma.policy_audit.deleteMany({ where: { organization_id: o, policy_name: { contains: `${stamp}` } } });
    await app.close();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
