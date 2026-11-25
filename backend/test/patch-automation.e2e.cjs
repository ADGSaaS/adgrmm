// Maintenance windows and automatic patching against a real database: alerts are held back inside a window, updates are
// installed and devices restarted only when and how the policy says, and nothing repeats too soon.
"use strict";

const crypto = require("node:crypto");
const path = require("node:path");

if (process.env.RIQ_E2E_ALLOW !== "1" || !/e2e/.test(process.env.DATABASE_URL || "")) {
    console.error("Refusing to run: set RIQ_E2E_ALLOW=1 and an e2e-named DATABASE_URL.");
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
    const { AlertsService } = require(path.join(dist, "alerts/alerts.service.js"));
    const { PatchAutomationService, approved } = require(path.join(dist, "patches/patch-automation.service.js"));
    const { PrismaService } = require(path.join(dist, "storage/prisma.service.js"));

    const app = await NestFactory.createApplicationContext(AppModule, { logger: ["error"] });
    const svc = app.get(PoliciesService, { strict: false });
    const alerts = app.get(AlertsService, { strict: false });
    const auto = app.get(PatchAutomationService, { strict: false });
    const prisma = app.get(PrismaService, { strict: false });

    const org = await prisma.organizations.upsert({ where: { slug: "default" }, create: { name: "Default Organization", slug: "default" }, update: {} });
    const o = org.id;
    const stamp = Date.now();
    const me = { id: null, name: "Test Person" };
    const ALL_DAY = { name: "Always", days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "00:00", timezone: "UTC" };
    const NEVER = { name: "Never", days: [0, 1, 2, 3, 4, 5, 6], start: "03:00", end: "03:01", timezone: "UTC" };
    // a window that is closed now, whenever the test runs: the one minute before this minute, tomorrow's weekday excluded
    const now = new Date();
    const closedDay = (now.getUTCDay() + 3) % 7;
    const CLOSED = { name: "Another day", days: [closedDay], start: "01:00", end: "02:00", timezone: "UTC" };

    async function device(label, os = "Windows 11 Pro") {
        const client = await prisma.clients.create({ data: { organization_id: o, name: `Patch ${label} ${stamp}` } });
        const site = await prisma.sites.create({ data: { client_id: client.id, name: "HQ" } });
        const dev = await prisma.devices.create({ data: { site_id: site.id, hostname: `PC-${label}-${stamp}`, operating_system: os } });
        const agent = await prisma.agents.create({ data: { device_id: dev.id, agent_uuid: crypto.randomUUID(), version: "1.3.28", last_check_in_at: new Date(), facts: { os: os.startsWith("Windows") ? "windows" : "linux", device: { boot: { pendingReboot: false } } } } });
        return { client, site, dev, agent };
    }
    const scan = async (d, patches) => {
        const task = await prisma.agent_tasks.create({ data: { agent_id: d.agent.id, type: "patch_scan", payload: {}, status: "succeeded" } });
        await prisma.agent_task_runs.create({ data: { task_id: task.id, status: "succeeded", finished_at: new Date(), output: { artifacts: { patches } } } });
    };
    const patchSet = [
        { id: "kb-crit", title: "Critical fix", severity: "Critical", requiresReboot: true, kbIds: ["KB1"] },
        { id: "kb-imp", title: "Important fix", severity: "Important", requiresReboot: false, kbIds: ["KB2"] },
        { id: "kb-mod", title: "Moderate fix", severity: "Moderate", requiresReboot: false, kbIds: ["KB3"] },
        { id: "kb-none", title: "Unrated", severity: null, requiresReboot: false, kbIds: ["KB4"] },
    ];
    const installs = (d) => prisma.agent_tasks.findMany({ where: { agent_id: d.agent.id, type: "patch_install" }, orderBy: { created_at: "desc" } });
    const actions = (d, kind) => prisma.policy_actions.findMany({ where: { device_id: d.dev.id, ...(kind ? { kind } : {}) } });
    const setFacts = (d, facts) => prisma.agents.update({ where: { id: d.agent.id }, data: { facts, last_check_in_at: new Date() } });
    const policyFor = (d, name, sections, extra = {}) => svc.create({ name: `${name} ${stamp}`, sections, assignments: [{ level: "customer", targetId: d.client.id }], ...extra }, me, o);

    // ---- what may be saved
    check("a maintenance window is saved with its days, times and zone", (await svc.preview({ name: "x", sections: { maintenance: { windows: [ALL_DAY] } } }, o)) !== null);
    check("a window needs a name", await fails(() => svc.create({ name: `w1 ${stamp}`, sections: { maintenance: { windows: [{ ...ALL_DAY, name: " " }] } } }, me, o), /needs a name/));
    check("two windows cannot share a name", await fails(() => svc.create({ name: `w2 ${stamp}`, sections: { maintenance: { windows: [ALL_DAY, { ...ALL_DAY, name: "always" }] } } }, me, o), /Two maintenance windows/));
    check("a window needs a day", await fails(() => svc.create({ name: `w3 ${stamp}`, sections: { maintenance: { windows: [{ ...ALL_DAY, days: [] }] } } }, me, o), /at least one day/));
    check("a window needs real times", await fails(() => svc.create({ name: `w4 ${stamp}`, sections: { maintenance: { windows: [{ ...ALL_DAY, start: "late" }] } } }, me, o), /must look like/));
    check("a window needs a real time zone", await fails(() => svc.create({ name: `w5 ${stamp}`, sections: { maintenance: { windows: [{ ...ALL_DAY, timezone: "Mars/Base" }] } } }, me, o), /time zone/));
    check("a bad patching choice is refused", await fails(() => svc.create({ name: `p1 ${stamp}`, sections: { patching: { approve: "everything" } } }, me, o), /none.*critical.*all/));
    check("a bad restart choice is refused", await fails(() => svc.create({ name: `p2 ${stamp}`, sections: { patching: { reboot: "now" } } }, me, o), /Restarts/));
    check("a bad install timing is refused", await fails(() => svc.create({ name: `p3 ${stamp}`, sections: { patching: { installIn: "whenever" } } }, me, o), /anytime/));

    // ---- which updates count as approved
    check("critical approves Critical and Important only", approved({ severity: "Critical", status: "Required" }, "critical") && approved({ severity: "important", status: "Required" }, "critical") && !approved({ severity: "Moderate", status: "Required" }, "critical") && !approved({ severity: null, status: "Required" }, "critical"));
    check("all approves everything still needed", approved({ severity: null, status: "Required" }, "all") && approved({ severity: "Low", status: "Required" }, "all"));
    check("none approves nothing", !approved({ severity: "Critical", status: "Required" }, "none"));
    check("an update already installed or pending is never approved", !approved({ severity: "Critical", status: "Installed" }, "all") && !approved({ severity: "Critical", status: "Pending" }, "all"));

    // ---- maintenance windows hold alerts back
    const A = await device("mute");
    const quiet = await policyFor(A, "Quiet hours", { maintenance: { windows: [ALL_DAY], muteAlerts: true } });
    let e = await svc.effectiveForDevice(A.dev.id);
    check("a device gets its policy's windows", e.scalars.maintenance.value.windows[0].name === "Always" && e.scalars.maintenance.source.name === quiet.name);
    const ex = await svc.explainDevice(A.dev.id, o);
    check("the explanation says a window is open now", ex.maintenance.activeNow === "Always" && ex.maintenance.next === null && ex.maintenance.muteAlerts === true, ex.maintenance);
    await alerts.raise({ deviceId: A.dev.id, kind: "check", dedupeKey: `t:${stamp}:a`, severity: "CRIT", title: "Disk full" });
    check("an alert for a device in a window is not raised", (await prisma.alerts.count({ where: { device_id: A.dev.id } })) === 0);

    await prisma.agents.update({ where: { id: A.agent.id }, data: { last_check_in_at: new Date(Date.now() - 60 * 60_000) } });
    alerts.startedAt = 0;
    await alerts.sweepOffline();
    check("nor is an offline alert", (await prisma.alerts.count({ where: { device_id: A.dev.id } })) === 0);

    await svc.update(quiet.id, { sections: { maintenance: { windows: [ALL_DAY], muteAlerts: false } } }, me, o);
    await alerts.raise({ deviceId: A.dev.id, kind: "check", dedupeKey: `t:${stamp}:b`, severity: "CRIT", title: "Disk full" });
    check("a window that does not mute alerts lets them through", (await prisma.alerts.count({ where: { device_id: A.dev.id } })) === 1);
    await prisma.alerts.deleteMany({ where: { device_id: A.dev.id } });

    await svc.update(quiet.id, { sections: { maintenance: { windows: [CLOSED], muteAlerts: true } } }, me, o);
    await alerts.raise({ deviceId: A.dev.id, kind: "check", dedupeKey: `t:${stamp}:c`, severity: "CRIT", title: "Disk full" });
    check("outside the window alerts are raised as usual", (await prisma.alerts.count({ where: { device_id: A.dev.id } })) === 1);
    const ex2 = await svc.explainDevice(A.dev.id, o);
    check("and the explanation says when the next window opens", ex2.maintenance.activeNow === null && ex2.maintenance.next?.name === "Another day" && new Date(ex2.maintenance.next.at).getTime() > Date.now() && new Date(ex2.maintenance.next.at).getUTCHours() === 1 && new Date(ex2.maintenance.next.at).getUTCDay() === closedDay, ex2.maintenance);
    await prisma.alerts.deleteMany({ where: { device_id: A.dev.id } });
    await svc.remove(quiet.id, me, o);

    // ---- automatic installs
    const B = await device("auto");
    await scan(B, patchSet);
    let r = await auto.run();
    check("with no policy nothing is installed", (await installs(B)).length === 0 && r.installs === 0);

    const critical = await policyFor(B, "Critical only", { patching: { approve: "critical" } });
    r = await auto.run();
    let tasks = await installs(B);
    check("a policy that approves critical updates starts an install of those", tasks.length === 1 && JSON.stringify(tasks[0].payload.ids.sort()) === JSON.stringify(["kb-crit", "kb-imp"]) && tasks[0].status === "queued", tasks.map((t) => t.payload));
    check("the install is recorded with the policy that caused it", (await actions(B, "patch_install")).length === 1 && (await actions(B, "patch_install"))[0].policy_name === critical.name && (await actions(B, "patch_install"))[0].detail.count === 2);
    r = await auto.run();
    check("it does not start a second while one is waiting", (await installs(B)).length === 1);
    await prisma.agent_tasks.update({ where: { id: tasks[0].id }, data: { status: "failed" } });
    await auto.run();
    check("nor start another soon after, even if the first failed", (await installs(B)).length === 1);
    await prisma.policy_actions.updateMany({ where: { device_id: B.dev.id }, data: { created_at: new Date(Date.now() - 5 * 3_600_000) } });
    await auto.run();
    check("after the cooldown it tries again", (await installs(B)).length === 2);
    await svc.update(critical.id, { sections: { patching: { approve: "all" } } }, me, o);
    await prisma.agent_tasks.updateMany({ where: { agent_id: B.agent.id, type: "patch_install" }, data: { status: "succeeded" } });
    await prisma.policy_actions.deleteMany({ where: { device_id: B.dev.id } });
    await auto.run();
    tasks = await installs(B);
    check("approving all includes the moderate and unrated updates", tasks.length === 3 && JSON.stringify(tasks[0].payload.ids.sort()) === JSON.stringify(["kb-crit", "kb-imp", "kb-mod", "kb-none"]), tasks[0].payload);
    await svc.remove(critical.id, me, o);

    // ---- installs wait for the window
    const C = await device("window");
    await scan(C, patchSet);
    const inWindowPolicy = await policyFor(C, "In window", { maintenance: { windows: [CLOSED] }, patching: { approve: "all", installIn: "maintenance" } });
    await auto.run();
    check("with installs limited to a window, nothing starts outside it", (await installs(C)).length === 0);
    await svc.update(inWindowPolicy.id, { sections: { maintenance: { windows: [ALL_DAY] }, patching: { approve: "all", installIn: "maintenance" } } }, me, o);
    await auto.run();
    check("and it starts inside it", (await installs(C)).length === 1 && (await actions(C, "patch_install"))[0].detail.inWindow === true);
    await svc.remove(inWindowPolicy.id, me, o);

    // ---- a device that is offline or not Windows is left alone
    const D = await device("offline");
    await scan(D, patchSet);
    await prisma.agents.update({ where: { id: D.agent.id }, data: { last_check_in_at: new Date(Date.now() - 3 * 3_600_000) } });
    const L = await device("linux", "Ubuntu 22.04");
    const everyone = await svc.create({ name: `Everyone all ${stamp}`, sections: { patching: { approve: "all" } }, assignments: [{ level: "customer", targetId: D.client.id }, { level: "customer", targetId: L.client.id }] }, me, o);
    await auto.run();
    check("an offline device is not given an install", (await installs(D)).length === 0);
    check("a Linux device is not given one", (await installs(L)).length === 0);
    await svc.remove(everyone.id, me, o);

    // ---- restarts
    const E = await device("reboot");
    await scan(E, []);
    const rebootPolicy = await policyFor(E, "Restart in window", { maintenance: { windows: [CLOSED] }, patching: { reboot: "maintenance" } });
    await setFacts(E, { os: "windows", device: { boot: { pendingReboot: true } } });
    await auto.run();
    check("a restart that waits for a window does not happen outside one", (await actions(E, "reboot")).length === 0);
    await svc.update(rebootPolicy.id, { sections: { maintenance: { windows: [ALL_DAY] }, patching: { reboot: "maintenance" } } }, me, o);
    await setFacts(E, { os: "windows", device: { boot: { pendingReboot: false } } });
    await auto.run();
    check("and not when no restart is needed", (await actions(E, "reboot")).length === 0);
    await setFacts(E, { os: "windows", device: { boot: { pendingReboot: true } } });
    r = await auto.run();
    check("it restarts inside the window when one is needed", r.reboots === 1 && (await actions(E, "reboot")).length === 1 && (await actions(E, "reboot"))[0].policy_name === rebootPolicy.name);
    const jobRows = await prisma.jobs.findMany({ where: { agent_id: E.agent.id } });
    check("by asking the device to restart, with a delay and a message", jobRows.length === 1 && /shutdown\.exe \/r \/t 120/.test(JSON.stringify(jobRows[0].payload)), jobRows);
    await auto.run();
    check("not again within hours", (await actions(E, "reboot")).length === 1);
    await svc.remove(rebootPolicy.id, me, o);

    const F = await device("always");
    await scan(F, []);
    const alwaysPolicy = await policyFor(F, "Restart now", { patching: { reboot: "always" } });
    await setFacts(F, { os: "windows", device: { boot: { pendingReboot: true } } });
    await auto.run();
    check("a policy that restarts straight away does, with no window", (await actions(F, "reboot")).length === 1);
    await svc.remove(alwaysPolicy.id, me, o);

    const G = await device("wait");
    await scan(G, patchSet);
    const waitPolicy = await policyFor(G, "Install then restart", { patching: { approve: "critical", reboot: "always" } });
    await setFacts(G, { os: "windows", device: { boot: { pendingReboot: true } } });
    await prisma.agent_tasks.create({ data: { agent_id: G.agent.id, type: "patch_install", payload: { ids: ["x"] }, status: "running" } });
    await auto.run();
    check("a restart waits while an install is still running", (await actions(G, "reboot")).length === 0);
    await svc.remove(waitPolicy.id, me, o);

    // ---- what the device page shows
    const exAll = await svc.explainDevice(E.dev.id, o);
    check("recent automatic actions appear on the device", exAll.actions.length === 1 && exAll.actions[0].kind === "reboot");
    const defaults = await svc.effectiveForDevice(G.dev.id);
    check("with no policy the patching settings are the manual defaults", defaults.scalars["patching.approve"].value === "none" && defaults.scalars["patching.reboot"].value === "never" && defaults.scalars["patching.approve"].source.kind === "default");

    // ---- clean up
    for (const d of [A, B, C, D, E, F, G, L]) {
        await prisma.jobs.deleteMany({ where: { agent_id: d.agent.id } });
        await prisma.alerts.deleteMany({ where: { device_id: d.dev.id } });
        await prisma.policy_actions.deleteMany({ where: { device_id: d.dev.id } });
        await prisma.clients.delete({ where: { id: d.client.id } });
    }
    await prisma.alerts.deleteMany({ where: { kind: "offline", first_seen_at: { gte: new Date(stamp) } } });
    await prisma.policy_audit.deleteMany({ where: { organization_id: o, policy_name: { contains: `${stamp}` } } });
    void NEVER;
    await app.close();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
