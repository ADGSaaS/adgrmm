// Tags, the new-customer baseline, alert noise controls, the automatic patching report and the failures inbox, against a
// real database.
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
    const { TagsService } = require(path.join(dist, "policies/tags.service.js"));
    const { CustomersService } = require(path.join(dist, "customers/customers.service.js"));
    const { AlertsService } = require(path.join(dist, "alerts/alerts.service.js"));
    const { FailuresService, classify } = require(path.join(dist, "automation/failures.service.js"));
    const { EndpointReportsService } = require(path.join(dist, "reports/endpoint-reports.service.js"));
    const { PrismaService } = require(path.join(dist, "storage/prisma.service.js"));

    const app = await NestFactory.createApplicationContext(AppModule, { logger: ["error"] });
    const svc = app.get(PoliciesService, { strict: false });
    const tags = app.get(TagsService, { strict: false });
    const customers = app.get(CustomersService, { strict: false });
    const alerts = app.get(AlertsService, { strict: false });
    const failures = app.get(FailuresService, { strict: false });
    const endpoint = app.get(EndpointReportsService, { strict: false });
    const prisma = app.get(PrismaService, { strict: false });

    const org = await prisma.organizations.upsert({ where: { slug: "default" }, create: { name: "Default Organization", slug: "default" }, update: {} });
    const o = org.id;
    const stamp = Date.now();
    const me = { id: null, name: "Test Person" };
    const GHOST = "00000000-0000-4000-8000-000000000000";

    async function customer(label) {
        const client = await prisma.clients.create({ data: { organization_id: o, name: `Extras ${label} ${stamp}` } });
        const site = await prisma.sites.create({ data: { client_id: client.id, name: "HQ" } });
        const mk = async (host) => {
            const dev = await prisma.devices.create({ data: { site_id: site.id, hostname: `${host}-${stamp}`, operating_system: "Windows 11 Pro" } });
            const agent = await prisma.agents.create({ data: { device_id: dev.id, agent_uuid: crypto.randomUUID(), version: "1.3.28", last_check_in_at: new Date(), facts: { os: "windows" } } });
            return { dev, agent };
        };
        return { client, site, a: await mk(`${label}-A`), b: await mk(`${label}-B`) };
    }
    const val = (e, k) => e.scalars[k]?.value;
    const A = await customer("A");
    const B = await customer("B");
    await prisma.alert_settings.upsert({ where: { id: 1 }, create: { id: 1, offline_after_minutes: 15, renotify_after_hours: 0, auto_ticket: false }, update: { offline_after_minutes: 15, renotify_after_hours: 0, auto_ticket: false } });

    // ================= tags =================
    check("a tag needs a name", await fails(() => tags.create({ name: " " }, o), /needs a name/));
    check("a tag colour must be a colour", await fails(() => tags.create({ name: `Bad ${stamp}`, color: "red" }, o), /colour must look like/));
    const servers = await tags.create({ name: `  Servers ${stamp} `, color: "#112233" }, o);
    check("a tag is created, tidied and has no devices", servers.name === `Servers ${stamp}` && servers.color === "#112233" && servers.devices === 0, servers);
    check("a repeated tag name is refused, whatever its case", await fails(() => tags.create({ name: `SERVERS ${stamp}` }, o), /already has that name/));
    check("a tag name that is too long is refused", await fails(() => tags.create({ name: "x".repeat(41) }, o), /too long/));

    const tagged = await tags.setForDevice(A.a.dev.id, { tagIds: [servers.id] }, o);
    check("a device is given a tag", tagged.items.length === 1 && tagged.items[0].id === servers.id);
    check("a tag that does not exist is refused", await fails(() => tags.setForDevice(A.a.dev.id, { tagIds: [GHOST] }, o), /does not exist/));
    check("a device that does not exist is not found", await fails(() => tags.setForDevice(GHOST, { tagIds: [] }, o), /does not exist/));
    check("another organisation cannot tag it", await fails(() => tags.setForDevice(A.a.dev.id, { tagIds: [servers.id] }, GHOST), /does not exist/));
    check("the tag counts its devices", (await tags.list(o)).items.find((t) => t.id === servers.id).devices === 1);

    const tagPolicy = await svc.create({ name: `For servers ${stamp}`, sections: { alerting: { offlineAfterMinutes: 3 } }, assignments: [{ level: "tag", targetId: servers.id }] }, me, o);
    check("a policy for a tag shows the tag's name", tagPolicy.assignments[0].targetName === servers.name, tagPolicy.assignments);
    check("a device with the tag gets the policy", val(await svc.effectiveForDevice(A.a.dev.id), "alerting.offlineAfterMinutes") === 3);
    check("a device without it does not, even in the same customer", val(await svc.effectiveForDevice(A.b.dev.id), "alerting.offlineAfterMinutes") === 15);
    const siteP = await svc.create({ name: `Site level ${stamp}`, sections: { alerting: { offlineAfterMinutes: 9 } }, assignments: [{ level: "site", targetId: A.site.id }] }, me, o);
    check("a tag is more specific than a site", val(await svc.effectiveForDevice(A.a.dev.id), "alerting.offlineAfterMinutes") === 3 && val(await svc.effectiveForDevice(A.b.dev.id), "alerting.offlineAfterMinutes") === 9);
    const devP = await svc.create({ name: `Device level ${stamp}`, sections: { alerting: { offlineAfterMinutes: 1 } }, assignments: [{ level: "device", targetId: A.a.dev.id }] }, me, o);
    check("and a device is more specific than a tag", val(await svc.effectiveForDevice(A.a.dev.id), "alerting.offlineAfterMinutes") === 1);
    await svc.remove(devP.id, me, o);
    await svc.update(siteP.id, { assignments: [{ level: "site", targetId: A.site.id }, { level: "tag", targetId: servers.id, exclude: true }] }, me, o);
    const ex = await svc.explainDevice(A.a.dev.id, o);
    check("a policy can be switched off for a tag, with the reason", ex.skipped.some((s) => s.name === siteP.name && /Switched off for this tag/.test(s.reason)), ex.skipped);
    await svc.remove(siteP.id, me, o);
    check("an assignment to a tag that does not exist is refused", await fails(() => svc.create({ name: `Ghost tag ${stamp}`, assignments: [{ level: "tag", targetId: GHOST }] }, me, o), /tags does not exist/));

    const bulkAdd = await tags.bulk(servers.id, { deviceIds: [A.b.dev.id, B.a.dev.id] }, o);
    check("a tag is put on many devices at once", bulkAdd.devices === 2 && (await tags.devicesOf(servers.id, o)).items.length === 3);
    check("the policy follows the tag across customers", val(await svc.effectiveForDevice(B.a.dev.id), "alerting.offlineAfterMinutes") === 3);
    await tags.bulk(servers.id, { deviceIds: [B.a.dev.id], remove: true }, o);
    check("and is taken off again", val(await svc.effectiveForDevice(B.a.dev.id), "alerting.offlineAfterMinutes") === 15);
    check("a bulk change needs devices", await fails(() => tags.bulk(servers.id, { deviceIds: [] }, o), /at least one device/));
    check("a bulk change with a device that does not exist is refused", await fails(() => tags.bulk(servers.id, { deviceIds: [GHOST] }, o), /does not exist/));
    const renamed = await tags.update(servers.id, { name: `Servers renamed ${stamp}`, color: "" }, o);
    check("a tag can be renamed and its colour cleared", renamed.name === `Servers renamed ${stamp}` && renamed.color === null && renamed.policies[0] === tagPolicy.name, renamed);
    const gone = await tags.remove(servers.id, o);
    check("deleting a tag says which policies lost it", gone.removedFromPolicies[0] === tagPolicy.name, gone);
    check("devices lose it, and the policy stops reaching them", (await tags.ofDevice(A.a.dev.id, o)).items.length === 0 && val(await svc.effectiveForDevice(A.a.dev.id), "alerting.offlineAfterMinutes") === 15);
    check("the policy itself is still there", (await svc.get(tagPolicy.id, o)).assignments.length === 0);
    await svc.remove(tagPolicy.id, me, o);

    // ================= baseline for new customers =================
    const base = await svc.create({ name: `Baseline ${stamp}`, applyToNewCustomers: true, sections: { alerting: { offlineAfterMinutes: 12 } } }, me, o);
    check("a policy can be marked for every new customer", base.applyToNewCustomers === true && base.assignments.length === 0);
    const fresh = await customers.createClient({ name: `Fresh customer ${stamp}` }, o);
    const afterNew = await svc.get(base.id, o);
    check("a new customer gets it assigned straight away", afterNew.assignments.some((a) => a.level === "customer" && a.targetId === fresh.id) && afterNew.version === base.version + 1, afterNew.assignments);
    check("and the history says so", (await svc.history(base.id, o)).items.some((i) => i.action === "assigned"));
    const manual = await prisma.clients.create({ data: { organization_id: o, name: `Created elsewhere ${stamp}` } });
    const drift = await svc.baselineStatus(o);
    const rowOf = (id) => drift.items.find((i) => i.customerId === id);
    check("a customer made without the hook is missing the baseline", rowOf(manual.id).missing.length === 1 && rowOf(manual.id).onBaseline === false, rowOf(manual.id));
    check("one that has it is on the baseline", rowOf(fresh.id).onBaseline === true);
    await svc.update(base.id, { assignments: [...(await svc.get(base.id, o)).assignments.map((a) => ({ level: a.level, targetId: a.targetId, exclude: a.exclude })), { level: "customer", targetId: A.client.id, exclude: true }] }, me, o);
    const drift2 = await svc.baselineStatus(o);
    check("a customer that switched it off is listed as having done so", drift2.items.find((i) => i.customerId === A.client.id).switchedOff.length === 1 && drift2.drifted >= 2);
    const applied = await svc.applyBaseline(me, o);
    check("applying gives it to every customer missing it", applied.added >= 2 && (await svc.baselineStatus(o)).items.find((i) => i.customerId === manual.id).onBaseline === true, applied);
    check("but not to one that switched it off", (await svc.baselineStatus(o)).items.find((i) => i.customerId === A.client.id).switchedOff.length === 1 && val(await svc.effectiveForDevice(A.a.dev.id), "alerting.offlineAfterMinutes") === 15);
    check("applying again adds nothing", (await svc.applyBaseline(me, o)).added === 0);
    const dupBase = await svc.duplicate(base.id, me, o);
    check("a copy of a baseline policy is not itself a baseline", dupBase.applyToNewCustomers === false);
    await svc.remove(dupBase.id, me, o);
    await svc.remove(base.id, me, o);
    await prisma.clients.deleteMany({ where: { id: { in: [fresh.id, manual.id] } } });

    // ================= alert noise =================
    const N = await customer("N");
    const check1 = { deviceId: N.a.dev.id, assignmentId: crypto.randomUUID(), checkName: "Disk C:", severity: "CRIT", output: "full" };
    const run = (status, c = check1) => alerts.onCheckRun({ ...c, status });
    const live = () => prisma.alerts.findMany({ where: { device_id: N.a.dev.id }, orderBy: { first_seen_at: "asc" } });
    await run("CRIT");
    check("with no policy a failing check alerts at once", (await live()).length === 1);
    await prisma.alerts.deleteMany({ where: { device_id: N.a.dev.id } });

    const hold = await svc.create({ name: `Hold ${stamp}`, sections: { alerting: { holdMinutes: 10 } }, assignments: [{ level: "customer", targetId: N.client.id }] }, me, o);
    check("the hold time is saved", (await svc.get(hold.id, o)).sections.alerting.holdMinutes === 10);
    check("a hold out of range is refused", await fails(() => svc.create({ name: `Hold bad ${stamp}`, sections: { alerting: { holdMinutes: 2000 } } }, me, o), /Minutes a check must keep failing/));
    await run("CRIT");
    check("a check that has only just started failing does not alert", (await live()).length === 0 && (await prisma.alert_pending.count({ where: { dedupe_key: `check:${check1.assignmentId}` } })) === 1);
    await run("CRIT");
    check("nor on the next run, while it is still new", (await live()).length === 0);
    await run("OK");
    check("a check that recovers forgets it was failing", (await prisma.alert_pending.count({ where: { dedupe_key: `check:${check1.assignmentId}` } })) === 0);
    await run("CRIT");
    await prisma.alert_pending.update({ where: { dedupe_key: `check:${check1.assignmentId}` }, data: { first_seen_at: new Date(Date.now() - 11 * 60_000) } });
    await run("CRIT");
    const raised = await live();
    check("one that keeps failing past the hold time alerts", raised.length === 1 && raised[0].state === "OPEN", raised);
    check("and is no longer pending", (await prisma.alert_pending.count({ where: { dedupe_key: `check:${check1.assignmentId}` } })) === 0);
    await prisma.alerts.deleteMany({ where: { device_id: N.a.dev.id } });
    await run("CRIT");
    await prisma.alert_pending.update({ where: { dedupe_key: `check:${check1.assignmentId}` }, data: { first_seen_at: new Date(Date.now() - 30 * 3_600_000), last_seen_at: new Date(Date.now() - 5 * 3_600_000) } });
    await run("CRIT");
    check("a check that stopped reporting for hours starts its hold again", (await live()).length === 0);
    await prisma.alert_pending.deleteMany({ where: { device_id: N.a.dev.id } });
    await svc.remove(hold.id, me, o);

    // reopening instead of starting again
    const c2 = { deviceId: N.a.dev.id, assignmentId: crypto.randomUUID(), checkName: "Service", severity: "CRIT", output: "stopped" };
    await run("CRIT", c2);
    await alerts.clear(`check:${c2.assignmentId}`, "back");
    await run("CRIT", c2);
    check("with no policy a problem that comes back is a new alert", (await live()).length === 2, (await live()).map((a) => a.state));
    await prisma.alerts.deleteMany({ where: { device_id: N.a.dev.id } });

    const reopen = await svc.create({ name: `Reopen ${stamp}`, sections: { alerting: { reopenWithinMinutes: 30 } }, assignments: [{ level: "customer", targetId: N.client.id }] }, me, o);
    await run("CRIT", c2);
    const first = (await live())[0];
    await alerts.clear(`check:${c2.assignmentId}`, "back");
    await run("CRIT", c2);
    const after = await live();
    check("with a policy it comes back as the same alert, reopened", after.length === 1 && after[0].id === first.id && after[0].state === "OPEN" && after[0].resolved_at === null && after[0].open_count === 2, after);
    check("and the timeline says it came back", (await prisma.alert_events.findMany({ where: { alert_id: first.id } })).some((e) => e.type === "reopened"));
    await alerts.clear(`check:${c2.assignmentId}`, "back");
    await prisma.alerts.update({ where: { id: first.id }, data: { resolved_at: new Date(Date.now() - 2 * 3_600_000) } });
    await run("CRIT", c2);
    check("one that cleared long ago is a new alert", (await live()).length === 2);
    await svc.remove(reopen.id, me, o);
    await prisma.alerts.deleteMany({ where: { device_id: N.a.dev.id } });

    // ================= automatic patching report =================
    const patchPolicy = await svc.create({
        name: `Patch ${stamp}`, sections: { patching: { approve: "critical", installIn: "maintenance", reboot: "maintenance" }, maintenance: { windows: [{ name: "Another day", days: [(new Date().getUTCDay() + 3) % 7], start: "01:00", end: "02:00", timezone: "UTC" }] } },
        assignments: [{ level: "customer", targetId: A.client.id }],
    }, me, o);
    await prisma.policy_actions.create({ data: { organization_id: o, device_id: A.a.dev.id, policy_id: patchPolicy.id, policy_name: patchPolicy.name, kind: "patch_install", detail: { count: 4 } } });
    await prisma.agents.update({ where: { id: A.a.agent.id }, data: { facts: { os: "windows", device: { boot: { pendingReboot: true } } } } });
    const rep = await endpoint.run("automatic-patching", { clientId: A.client.id });
    const rowA = rep.rows.find((r) => r.deviceId === A.a.dev.id);
    check("the report lists how each Windows device is patched", rep.rows.length === 2 && rowA.mode === "Waiting for window" && rowA.installs === "Critical and important" && rowA.when === "Only in a window" && rowA.restarts === "In a window" && rowA.policy === patchPolicy.name, rowA);
    check("with the last automatic install and a pending restart", rowA.lastInstallCount === 4 && !!rowA.lastInstallAt && rowA.restartPending === "Yes" && /^Next: Another day/.test(rowA.window), rowA);
    const rowB = rep.rows.find((r) => r.deviceId === A.b.dev.id);
    check("a device not told otherwise shows what its policy says", rowB.mode === "Waiting for window" && rowB.restartPending === "Not reported", rowB);
    const repB = await endpoint.run("automatic-patching", { clientId: B.client.id });
    check("a device no policy reaches is by hand", repB.rows.every((r) => r.mode === "By hand" && r.installs === "By hand" && r.restarts === "By hand"), repB.rows);
    check("the summary counts them", rep.summary.find((s) => s.label === "Waiting for a window").value === 2 && rep.summary.find((s) => s.label === "Restart pending").value === 1, rep.summary);
    await svc.remove(patchPolicy.id, me, o);

    // ================= failures inbox =================
    const F = await customer("F");
    const mkJob = async (d, status, stderr, payload = {}, scriptName = null) => {
        const job = await prisma.jobs.create({ data: { agent_id: d.agent.id, type: "RUN_SCRIPT", payload, status, finished_at: new Date() } });
        await prisma.job_results.create({ data: { job_id: job.id, exit_code: 1, stderr } });
        if (scriptName) await prisma.script_runs.create({ data: { script_name: scriptName, job_id: job.id, device_id: d.dev.id } });
        return job;
    };
    await mkJob(F.a, "failed", "Access denied writing the file", {}, "Clean temp");
    await mkJob(F.a, "timeout", "", {}, "Slow script");
    await mkJob(F.a, "failed", "Cannot run: no user is logged on to this device", {}, "Show message");
    await mkJob(F.b, "failed", "Could not restart", { scriptText: "shutdown.exe /r /t 5" });
    const pt = await prisma.agent_tasks.create({ data: { agent_id: F.b.agent.id, type: "patch_install", payload: {}, status: "failed" } });
    const pr = await prisma.agent_task_runs.create({ data: { task_id: pt.id, status: "failed", finished_at: new Date() } });
    await prisma.agent_task_results.create({ data: { run_id: pr.id, stderr: "Windows Update did not install every update (result 4)." } });
    const old = await mkJob(F.b, "failed", "ancient failure", {}, "Old script");
    await prisma.jobs.update({ where: { id: old.id }, data: { created_at: new Date(Date.now() - 20 * 86_400_000), finished_at: new Date(Date.now() - 20 * 86_400_000) } });

    const all = await failures.list({ days: 7 }, null, o);
    const mine = all.items.filter((i) => i.customer === F.client.name);
    check("failed scripts, restarts and update installs all appear", mine.length === 5 && ["Clean temp", "Slow script", "Show message", "Restart", "Update install"].every((t) => mine.some((i) => i.title === t)), mine.map((i) => i.title));
    check("a script that timed out says so", mine.find((i) => i.title === "Slow script").status === "timed out" && /did not finish in time/.test(mine.find((i) => i.title === "Slow script").reason));
    check("one that had nobody to run for is skipped, not failed", mine.find((i) => i.title === "Show message").status === "skipped");
    check("each item names its device, customer and the reason", mine.find((i) => i.title === "Clean temp").device === `F-A-${stamp}` && mine.find((i) => i.title === "Clean temp").reason === "Access denied writing the file" && mine.find((i) => i.title === "Update install").reason.startsWith("Windows Update did not install"));
    check("kinds are told apart", mine.find((i) => i.title === "Clean temp").kind === "script" && mine.find((i) => i.title === "Restart").kind === "action" && mine.find((i) => i.title === "Update install").kind === "patch");
    check("a failure older than the window is left out", !all.items.some((i) => i.title === "Old script") && (await failures.list({ days: 30 }, null, o)).items.some((i) => i.title === "Old script"));
    const noSkips = await failures.list({ days: 7, showSkipped: false }, null, o);
    check("skipped ones can be hidden", !noSkips.items.some((i) => i.title === "Show message") && noSkips.summary.skipped >= 1);
    check("the summary does not count skipped as failures", all.summary.failed >= 3 && all.summary.timedOut >= 1);
    check("a kind can be asked for", (await failures.list({ days: 7, kind: "patch" }, null, o)).items.every((i) => i.kind === "patch") && await fails(() => failures.list({ kind: "nonsense" }, null, o), /kind must be/));
    check("it names the devices with the most failures", all.worstDevices[0].count >= 2);
    const limited = await failures.list({ days: 7 }, [B.client.id], o);
    check("a limited person sees only their customers' failures", limited.items.every((i) => i.customer !== F.client.name) && (await failures.list({ days: 7 }, [F.client.id], o)).items.every((i) => i.customer === F.client.name) && (await failures.list({ days: 7 }, [], o)).items.length === 0);
    check("the words that mean nobody was signed in are recognised", ["No interactive user", "no user is logged on", "Not logged on", "There is no active session"].every((t) => classify("failed", t) === "skipped") && classify("failed", "disk full") === "failed" && classify("timeout", "") === "timed out");

    // ================= clean up =================
    for (const c of [A, B, N, F]) {
        for (const d of [c.a, c.b]) {
            await prisma.jobs.deleteMany({ where: { agent_id: d.agent.id } });
            await prisma.agent_tasks.deleteMany({ where: { agent_id: d.agent.id } });
            await prisma.alerts.deleteMany({ where: { device_id: d.dev.id } });
            await prisma.policy_actions.deleteMany({ where: { device_id: d.dev.id } });
        }
        await prisma.clients.delete({ where: { id: c.client.id } });
    }
    await prisma.tag_defs.deleteMany({ where: { organization_id: o, name: { contains: `${stamp}` } } });
    await prisma.alert_pending.deleteMany({ where: {} });
    await prisma.policy_audit.deleteMany({ where: { organization_id: o, policy_name: { contains: `${stamp}` } } });
    await app.close();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
