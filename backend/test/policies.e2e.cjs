// Policies against a real database: saving, assigning, history and undo, the preview, what a device is told, and
// that alerts, the software report, remote access and checks really follow them.
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
    const { EndpointReportsService } = require(path.join(dist, "reports/endpoint-reports.service.js"));
    const { ChecksRuntimeService } = require(path.join(dist, "checks/checks.runtime.service.js"));
    const { RemoteConsoleService } = require(path.join(dist, "remote-console/remote-console.service.js"));
    const { DeviceHistoryService } = require(path.join(dist, "reports/device-history.service.js"));
    const { PrismaService } = require(path.join(dist, "storage/prisma.service.js"));

    const app = await NestFactory.createApplicationContext(AppModule, { logger: ["error"] });
    const svc = app.get(PoliciesService, { strict: false });
    const alerts = app.get(AlertsService, { strict: false });
    const endpoint = app.get(EndpointReportsService, { strict: false });
    const runtime = app.get(ChecksRuntimeService, { strict: false });
    const remote = app.get(RemoteConsoleService, { strict: false });
    const history = app.get(DeviceHistoryService, { strict: false });
    const prisma = app.get(PrismaService, { strict: false });

    const org = await prisma.organizations.upsert({ where: { slug: "default" }, create: { name: "Default Organization", slug: "default" }, update: {} });
    const o = org.id;
    const stamp = Date.now();
    const me = { id: null, name: "Test Person" };
    const GHOST = "00000000-0000-4000-8000-000000000000";

    // two customers, each with a site and a Windows and a Linux device that reported in eight minutes ago
    const eight = new Date(Date.now() - 8 * 60_000);
    async function customer(label) {
        const client = await prisma.clients.create({ data: { organization_id: o, name: `Pol ${label} ${stamp}` } });
        const site = await prisma.sites.create({ data: { client_id: client.id, name: "HQ" } });
        const mk = async (host, os) => {
            const device = await prisma.devices.create({ data: { site_id: site.id, hostname: `${host}-${stamp}`, operating_system: os } });
            const agent = await prisma.agents.create({ data: { device_id: device.id, agent_uuid: crypto.randomUUID(), version: "1.0.0", last_check_in_at: eight, facts: {} } });
            return { ...device, agentId: agent.id };
        };
        return { client, site, win: await mk("WIN", "Windows 11 Pro"), lin: await mk("LIN", "Ubuntu 22.04") };
    }
    const A = await customer("A");
    const B = await customer("B");
    await prisma.alert_settings.upsert({ where: { id: 1 }, create: { id: 1, offline_after_minutes: 15, renotify_after_hours: 0, auto_ticket: false }, update: { offline_after_minutes: 15, renotify_after_hours: 0, auto_ticket: false } });
    await prisma.report_settings.deleteMany({ where: { organization_id: o } });

    const val = (e, k) => e.scalars[k]?.value;

    // ---- before any policy, devices get what the old screens say
    let e = await svc.effectiveForDevice(A.win.id);
    check("with no policies a device gets the alert settings", val(e, "alerting.offlineAfterMinutes") === 15 && e.scalars["alerting.offlineAfterMinutes"].source.label === "Alert settings", e.scalars);
    check("and the customer's remote access notice", val(e, "remote.consent") === "notice");
    check("and the business hours", val(e, "hours").start === "08:00");
    check("an unknown device is answered with defaults, not an error", (await svc.effectiveForDevice(GHOST)).applied.length === 0);

    // ---- creating
    const made = await svc.create({
        name: `  Policy A ${stamp} `, description: "Short wait for customer A", priority: 50, os: "any",
        sections: { alerting: { offlineAfterMinutes: 5, autoTicket: true }, remote: { consent: "consent" }, software: { required: ["Zzz Policy Tool"], banned: ["Zzz Banned Tool"] } },
        assignments: [{ level: "customer", targetId: A.client.id }],
    }, me, o);
    check("a policy is created with its settings and assignment", made.name === `Policy A ${stamp}` && made.priority === 50 && made.version === 1 && made.assignments.length === 1 && made.assignments[0].targetName === A.client.name && made.sectionNames.length === 3, made);
    check("it counts its settings", made.settingCount === 5, made.settingCount);

    check("a repeated name is refused", await fails(() => svc.create({ name: `policy a ${stamp}` }, me, o), /already has that name/));
    check("a missing name is refused", await fails(() => svc.create({ name: " " }, me, o), /needs a name/));
    check("a bad setting is refused", await fails(() => svc.create({ name: `Bad ${stamp}`, sections: { alerting: { offlineAfterMinutes: 0 } } }, me, o), /Minutes offline/));
    check("an unknown customer is refused", await fails(() => svc.create({ name: `Bad ${stamp}`, assignments: [{ level: "customer", targetId: GHOST }] }, me, o), /does not exist/));
    check("an assignment without a target is refused", await fails(() => svc.create({ name: `Bad ${stamp}`, assignments: [{ level: "site" }] }, me, o), /Choose which site/));
    check("everyone cannot be switched off", await fails(() => svc.create({ name: `Bad ${stamp}`, assignments: [{ level: "global", exclude: true }] }, me, o), /cannot be switched off/));
    check("an unknown check profile is refused", await fails(() => svc.create({ name: `Bad ${stamp}`, sections: { checks: { profileIds: [GHOST] } } }, me, o), /check profiles does not exist/));
    check("a priority out of range is refused", await fails(() => svc.create({ name: `Bad ${stamp}`, priority: 0 }, me, o), /Priority/));
    check("nothing was created by the refusals", (await svc.list(o)).items.filter((p) => p.name.includes(`${stamp}`)).length === 1);

    // ---- a policy changes what devices get, only where it applies
    e = await svc.effectiveForDevice(A.win.id);
    check("a device in the customer gets the policy's value", val(e, "alerting.offlineAfterMinutes") === 5 && e.scalars["alerting.offlineAfterMinutes"].source.name === made.name, e.scalars);
    check("and says what it replaced", e.scalars["alerting.offlineAfterMinutes"].overrode[0].value === 15);
    check("the remote notice follows the policy", val(e, "remote.consent") === "consent");
    check("a device in another customer is unchanged", val(await svc.effectiveForDevice(B.win.id), "alerting.offlineAfterMinutes") === 15);

    const exp = await svc.explainDevice(A.win.id, o);
    check("the explanation lists each setting with its source", exp.device.name === `WIN-${stamp}` && exp.device.customer === A.client.name && exp.rows.find((r) => r.key === "alerting.offlineAfterMinutes").source.name === made.name && exp.applied.length === 1, exp.rows.map((r) => r.key));
    check("and carries a hash", /^[0-9a-f]{16}$/.test(exp.hash));
    check("a device that does not exist is not found", await fails(() => svc.explainDevice(GHOST, o), /does not exist/));

    // ---- the preview shows the effect and saves nothing
    const pv = await svc.preview({ name: `Draft ${stamp}`, sections: { alerting: { offlineAfterMinutes: 3 } }, assignments: [{ level: "customer", targetId: B.client.id }] }, o);
    check("the preview counts the devices it would change", pv.devicesChanged === 2 && pv.devicesReached === 2 && pv.customersChanged === 1, pv);
    check("and shows what changes on each", pv.items.every((i) => i.changes.some((c) => c.key === "alerting.offlineAfterMinutes" && c.from === 15 && c.to === 3)), pv.items[0]);
    check("the preview saved nothing", (await svc.list(o)).items.filter((p) => p.name.includes(`${stamp}`)).length === 1);
    const pv2 = await svc.preview({ id: made.id, sections: made.sections }, o);
    check("a preview of no real change shows none", pv2.devicesChanged === 0, pv2.devicesChanged);
    const pv3 = await svc.preview({ id: made.id, enabled: false }, o);
    check("a preview of switching a policy off shows what reverts", pv3.devicesChanged === 2 && pv3.items[0].changes.some((c) => c.key === "alerting.offlineAfterMinutes" && c.from === 5 && c.to === 15), pv3);
    check("a preview refuses bad input like a save", await fails(() => svc.preview({ name: "x", sections: { alerting: { offlineAfterMinutes: -1 } } }, o), /Minutes offline/));

    // ---- what the rest of the system does with it
    alerts.startedAt = 0;
    await alerts.sweepOffline();
    const alertA = await prisma.alerts.findFirst({ where: { device_id: A.win.id, state: { not: "RESOLVED" } } });
    const alertB = await prisma.alerts.findFirst({ where: { device_id: B.win.id, state: { not: "RESOLVED" } } });
    check("a device past its policy's wait raises an offline alert", !!alertA, alertA);
    check("while one inside the default wait does not", !alertB, alertB);

    const ticketsBefore = await prisma.alerts.findUnique({ where: { id: alertA.id }, select: { ticket_id: true } });
    check("the policy's automatic ticket setting is used", !!ticketsBefore.ticket_id, ticketsBefore);

    check("remote access follows the policy for that device", (await remote.consentModeFor(A.win.agentId)) === "consent");
    check("and the customer's own setting elsewhere", (await remote.consentModeFor(B.win.agentId)) === "notice");

    const report = await endpoint.run("software-compliance", { clientId: A.client.id });
    const row = report.rows.find((r) => r.deviceId === A.win.id);
    check("the software report requires what the policy requires", !!row && /Zzz Policy Tool/.test(row.missingRequired), row);
    const reportB = await endpoint.run("software-compliance", { clientId: B.client.id });
    check("and nothing for a customer it does not reach", !reportB.rows.some((r) => /Zzz Policy Tool/.test(r.missingRequired)));
    const typed = await endpoint.run("software-compliance", { clientId: A.client.id, required: "Only This", banned: "" });
    check("a list typed into the report still overrides", typed.rows.find((r) => r.deviceId === A.win.id).missingRequired === "Only This");

    // ---- hours from a policy reach availability counting
    const hoursPolicy = await svc.create({
        name: `Night shift ${stamp}`, sections: { hours: { days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "00:00", timezone: "UTC" } }, assignments: [{ level: "customer", targetId: B.client.id }],
    }, me, o);
    await prisma.device_daily.deleteMany({ where: { device_id: { in: [A.win.id, B.win.id] } } });
    await prisma.report_settings.create({ data: { organization_id: o, business_days: [], business_start: "00:00", business_end: "00:00", timezone: "UTC" } }).catch(() => undefined);
    await history.sample();
    const dayA = await prisma.device_daily.findFirst({ where: { device_id: A.win.id } });
    const dayB = await prisma.device_daily.findFirst({ where: { device_id: B.win.id } });
    check("a device the policy gives always-on hours counts every sample as business", dayB?.business_samples === 1, dayB);
    check("and the sample for the other customer is unaffected by it", dayA && dayA.samples === 1, dayA);
    await svc.remove(hoursPolicy.id, me, o);

    // ---- check profiles
    const profile = await prisma.check_profiles.create({ data: { organization_id: o, name: `Profile ${stamp}` } });
    const chk = await prisma.checks.create({ data: { organization_id: o, name: `Policy ping ${stamp}`, type: "ping", schedule: "5m", config: { host: "example.com" } } });
    await prisma.check_profile_members.create({ data: { profile_id: profile.id, check_id: chk.id } });
    const planBefore = await runtime.getCheckPlan(B.win.id);
    const checkPolicy = await svc.create({ name: `Checks B ${stamp}`, sections: { checks: { profileIds: [profile.id] } }, assignments: [{ level: "customer", targetId: B.client.id }] }, me, o);
    const planAfter = await runtime.getCheckPlan(B.win.id);
    check("a policy's check profile adds its checks to a device's plan", !planBefore.checks.some((c) => c.name === `Policy ping ${stamp}`) && planAfter.checks.some((c) => c.name === `Policy ping ${stamp}`), planAfter.checks.map((c) => c.name));
    check("and not to a device it does not reach", !(await runtime.getCheckPlan(A.win.id)).checks.some((c) => c.name === `Policy ping ${stamp}`));
    await svc.remove(checkPolicy.id, me, o);
    await prisma.check_profiles.delete({ where: { id: profile.id } });
    await prisma.checks.delete({ where: { id: chk.id } });

    // ---- managing check profiles
    const chk2 = await prisma.checks.create({ data: { organization_id: o, name: `Profile member ${stamp}`, type: "ping", schedule: "5m", config: { host: "example.org" } } });
    const sp = await svc.createProfile({ name: `  Svc profile ${stamp} `, description: "two words", checkIds: [chk2.id] }, me, o);
    check("a check profile is created with its checks", sp.name === `Svc profile ${stamp}` && sp.checkIds.length === 1 && sp.checkNames[0] === `Profile member ${stamp}` && sp.usedBy.length === 0, sp);
    check("a repeated profile name is refused", await fails(() => svc.createProfile({ name: `svc PROFILE ${stamp}`, checkIds: [] }, me, o), /already has that name/));
    check("a profile with a check that does not exist is refused", await fails(() => svc.createProfile({ name: `Ghost ${stamp}`, checkIds: [GHOST] }, me, o), /does not exist/));
    check("a profile needs a name", await fails(() => svc.createProfile({ name: " ", checkIds: [] }, me, o), /needs a name/));
    const sp2 = await svc.updateProfile(sp.id, { checkIds: [] }, o);
    check("a profile's checks can be changed", sp2.checkIds.length === 0 && sp2.name === sp.name);
    const usingPolicy = await svc.create({ name: `Uses profile ${stamp}`, sections: { checks: { profileIds: [sp.id] } } }, me, o);
    check("a profile says which policies use it", (await svc.listProfiles(o)).items.find((i) => i.id === sp.id).usedBy[0] === usingPolicy.name);
    check("a profile in use cannot be deleted", await fails(() => svc.removeProfile(sp.id, o), /used by/));
    await svc.remove(usingPolicy.id, me, o);
    check("an unused profile can be deleted", (await svc.removeProfile(sp.id, o)).deleted === true && !(await svc.listProfiles(o)).items.some((i) => i.id === sp.id));
    check("another organisation cannot change it", await fails(() => svc.updateProfile(sp.id, { name: "x" }, GHOST), /does not exist/));
    await prisma.checks.delete({ where: { id: chk2.id } });

    // ---- who it reaches
    const reach = await svc.devicesOf(made.id, o);
    check("the policy lists the devices it reaches", reach.applied === 2 && reach.items.every((i) => i.status === "applied" && i.customer === A.client.name), reach);
    check("and how many of its settings win on each", reach.items.every((i) => i.winning === 5 && i.overridden === 0), reach.items[0]);

    // ---- an operating system filter and exclusions show up in the list
    const linuxOnly = await svc.update(made.id, { os: "linux", version: made.version }, me, o);
    const reach2 = await svc.devicesOf(made.id, o);
    check("an operating system filter limits where it applies", reach2.applied === 1 && reach2.skipped === 1 && /linux devices only/.test(reach2.items.find((i) => i.status === "skipped").reason), reach2);
    check("the version moves on with every save", linuxOnly.version === 2);
    await svc.update(made.id, { os: "any", assignments: [{ level: "customer", targetId: A.client.id }, { level: "device", targetId: A.lin.id, exclude: true }] }, me, o);
    const reach3 = await svc.devicesOf(made.id, o);
    check("a device can be excluded, and the list says so", reach3.items.find((i) => i.deviceId === A.lin.id).reason === "Switched off for this device" && reach3.items.find((i) => i.deviceId === A.win.id).status === "applied", reach3.items);
    check("the excluded device gets the old settings", val(await svc.effectiveForDevice(A.lin.id), "alerting.offlineAfterMinutes") === 15);

    // ---- two people editing
    const seen = await svc.get(made.id, o);
    await svc.update(made.id, { description: "first save", version: seen.version }, me, o);
    check("a save from an older version is refused", await fails(() => svc.update(made.id, { description: "second save", version: seen.version }, me, o), /Someone else changed/));
    check("and changed nothing", (await svc.get(made.id, o)).description === "first save");
    check("a save without a version still works", (await svc.update(made.id, { description: "no version" }, me, o)).description === "no version");
    check("another organisation cannot read it", await fails(() => svc.get(made.id, GHOST), /does not exist/));
    check("or change it", await fails(() => svc.update(made.id, { description: "x" }, me, GHOST), /does not exist/));
    check("or delete it", await fails(() => svc.remove(made.id, me, GHOST), /does not exist/));

    // ---- history and undo
    const h = await svc.history(made.id, o);
    check("every change is recorded with who made it", h.items.length >= 4 && h.items.every((i) => i.by === "Test Person") && h.items[h.items.length - 1].action === "created", h.items.map((i) => i.action));
    check("the changes are described in words", h.items.some((i) => i.changes.some((c) => /os: "any" to "linux"/.test(c))), h.items.map((i) => i.changes));
    const off = await svc.update(made.id, { enabled: false }, me, o);
    check("switching off is recorded as that", (await svc.history(made.id, o)).items[0].action === "disabled" && off.enabled === false);
    check("a switched-off policy stops applying", val(await svc.effectiveForDevice(A.win.id), "alerting.offlineAfterMinutes") === 15);
    const createdEntry = h.items[h.items.length - 1];
    const back = await svc.restore(createdEntry.id, me, o);
    check("a policy can be put back as it was after an earlier change", back.priority === 50 && back.os === "any" && back.enabled === true && back.assignments.length === 1 && back.description === "Short wait for customer A", back);
    check("and the device gets it again", val(await svc.effectiveForDevice(A.win.id), "alerting.offlineAfterMinutes") === 5);
    check("the restore is itself recorded", (await svc.history(made.id, o)).items[0].action === "restored");
    const dup = await svc.duplicate(made.id, me, o);
    check("a copy is made switched off with a new name", dup.enabled === false && dup.name === `${made.name} (copy)` && dup.assignments.length === 1 && dup.id !== made.id, dup);
    check("and changes nothing until it is switched on", val(await svc.effectiveForDevice(A.win.id), "alerting.offlineAfterMinutes") === 5);
    await svc.remove(dup.id, me, o);

    await svc.remove(made.id, me, o);
    check("deleting a policy puts devices back to the old settings", val(await svc.effectiveForDevice(A.win.id), "alerting.offlineAfterMinutes") === 15);
    const all = await svc.history(null, o, 500);
    const deletedEntry = all.items.find((i) => i.policyId === made.id && i.action === "deleted");
    check("the history outlives the policy", !!deletedEntry);
    const revived = await svc.restore(deletedEntry.id, me, o);
    check("a deleted policy can be brought back, as it was", revived.name === made.name && revived.sectionNames.length === 3 && revived.assignments.length === 1 && val(await svc.effectiveForDevice(A.win.id), "alerting.offlineAfterMinutes") === 5, revived);
    check("a change that does not exist cannot be restored", await fails(() => svc.restore(GHOST, me, o), /does not exist/));

    // ---- clean up
    await svc.remove(revived.id, me, o);
    await prisma.alerts.deleteMany({ where: { device_id: { in: [A.win.id, A.lin.id, B.win.id, B.lin.id] } } });
    await prisma.policy_audit.deleteMany({ where: { organization_id: o, policy_name: { contains: `${stamp}` } } });
    for (const c of [A, B]) await prisma.clients.delete({ where: { id: c.client.id } });
    await app.close();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
