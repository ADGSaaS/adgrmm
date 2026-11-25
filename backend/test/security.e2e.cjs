// Security basics, stage 1, in the application against a real database (no HTTP): the scheduled scan and the policy setting
// security.scanHours (default 24, 0 means never, a policy can change it; an injected clock; online Windows devices with an agent only;
// a device with a scan waiting is left alone; a bounded number of scans per sweep), the policy checks, reading a scan back (poller),
// and the Security posture report. Throwaway database only (name has "e2e").
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
process.env.SECURITY_SCANS_AUTOMATION_ENABLED = "false"; // the test calls run() itself
process.env.SECURITY_SCANS_POLLER_ENABLED = "false"; // and poll()
process.env.NODE_ENV = "development";

let passed = 0;
let failed = 0;
function check(name, ok, extra) {
    if (ok) passed++;
    else failed++;
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && extra !== undefined ? `: ${JSON.stringify(extra)}` : ""}`);
}
const fails = async (fn, re) => { try { await fn(); return false; } catch (e) { return re.test(String(e.message ?? e)); } };
const { healthy, text } = require("./security-fixtures.cjs");

(async () => {
    require("reflect-metadata");
    const { NestFactory } = require("@nestjs/core");
    const dist = path.resolve(process.cwd(), "dist");
    const { AppModule } = require(path.join(dist, "app.module.js"));
    const { PoliciesService } = require(path.join(dist, "policies/policies.service.js"));
    const { PrismaService } = require(path.join(dist, "storage/prisma.service.js"));
    const { SecurityService } = require(path.join(dist, "security/security.service.js"));
    const { SecurityAutomationService, SCANS_PER_SWEEP } = require(path.join(dist, "security/security-automation.service.js"));
    const { EndpointReportsService } = require(path.join(dist, "reports/endpoint-reports.service.js"));

    const app = await NestFactory.createApplicationContext(AppModule, { logger: ["error"] });
    const prisma = app.get(PrismaService, { strict: false });
    const policies = app.get(PoliciesService, { strict: false });
    const security = app.get(SecurityService, { strict: false });
    const auto = app.get(SecurityAutomationService, { strict: false });
    const endpoint = app.get(EndpointReportsService, { strict: false });

    const org = await prisma.organizations.upsert({ where: { slug: "default" }, create: { name: "Default Organization", slug: "default" }, update: {} });
    const o = org.id;
    const stamp = Date.now();
    const me = { id: null, name: "Test Person" };
    const HOUR = 3600_000;

    async function customer(label) {
        const client = await prisma.clients.create({ data: { organization_id: o, name: `Sec ${label} ${stamp}` } });
        const site = await prisma.sites.create({ data: { client_id: client.id, name: "HQ" } });
        return { client, site };
    }
    async function device(c, label, { os = "windows", online: isOnline = true, agent = true } = {}) {
        const dev = await prisma.devices.create({ data: { site_id: c.site.id, hostname: `SEC-${label}-${stamp}`, operating_system: os === "windows" ? "Windows 11 Pro" : "Ubuntu 22.04" } });
        const a = agent ? await prisma.agents.create({ data: { device_id: dev.id, agent_uuid: crypto.randomUUID(), version: "1.3.30", last_check_in_at: isOnline ? new Date() : new Date(Date.now() - 3 * HOUR), facts: { os } } }) : null;
        if (a && isOnline) online.add(a.id);
        return { dev, agent: a, c };
    }
    const jobsOf = (d) => prisma.jobs.findMany({ where: { agent_id: d.agent.id }, orderBy: { created_at: "asc" } });
    const scanJobs = async (d) => (await jobsOf(d)).filter((j) => j.payload?.env?.RIQ_TOOL === "security.scan");
    const row = async (d) => (await prisma.$queryRaw`SELECT * FROM public.device_security_scans WHERE device_id = ${d.dev.id}::uuid`)[0] ?? null;
    async function answer(d, out, status = "succeeded") {
        const j = (await scanJobs(d)).pop();
        await prisma.jobs.update({ where: { id: j.id }, data: { status, finished_at: new Date() } });
        await prisma.job_results.upsert({ where: { job_id: j.id }, create: { job_id: j.id, exit_code: 0, stdout: out, stderr: "", duration_ms: 5n }, update: { stdout: out } });
        return j;
    }

    // the clock is injected, so the devices must have checked in at that moment too (the schedule only asks devices that are online)
    const online = new Set();
    async function runAt(t) {
        await prisma.agents.updateMany({ where: { id: { in: [...online] } }, data: { last_check_in_at: new Date(t) } });
        return auto.run(t);
    }

    const A = await customer("A");
    const B = await customer("B");
    const C = await customer("C");

    // ---------------------------------------------------------------- the policy setting
    const eff0 = (await policies.effectiveForDevices([(await device(A, "probe")).dev.id])).values().next().value;
    check("policy: with no policy a device gets the default, a scan every 24 hours, and the default says so", eff0.scalars["security.scanHours"].value === 24 && eff0.scalars["security.scanHours"].source.kind === "default" && /every day/.test(eff0.scalars["security.scanHours"].source.label), eff0.scalars["security.scanHours"]);
    check("policy: the section is saved and cleaned (0, 6 and '12' as text)", (await policies.preview({ name: "x", sections: { security: { scanHours: 6 } } }, o)) !== null && (await policies.preview({ name: "x", sections: { security: { scanHours: 0 } } }, o)) !== null && (await policies.preview({ name: "x", sections: { security: { scanHours: "12" } } }, o)) !== null);
    check("policy: bad values are refused with the valid range", await fails(() => policies.create({ name: `bad1 ${stamp}`, sections: { security: { scanHours: 721 } } }, me, o), /whole number from 0 to 720/)
        && await fails(() => policies.create({ name: `bad2 ${stamp}`, sections: { security: { scanHours: -1 } } }, me, o), /whole number from 0 to 720/)
        && await fails(() => policies.create({ name: `bad3 ${stamp}`, sections: { security: { scanHours: 1.5 } } }, me, o), /whole number/)
        && await fails(() => policies.create({ name: `bad4 ${stamp}`, sections: { security: { scanHours: "soon" } } }, me, o), /whole number/)
        && await fails(() => policies.create({ name: `bad5 ${stamp}`, sections: { security: { disableDefender: true } } }, me, o), /do not know/)
        && await fails(() => policies.create({ name: `bad6 ${stamp}`, sections: { security: "yes" } }, me, o), /not valid/));
    check("policy: an unknown section is still refused", await fails(() => policies.create({ name: `bad7 ${stamp}`, sections: { antivirus: { on: true } } }, me, o), /do not know/));

    // ---------------------------------------------------------------- the schedule with no policy: every 24 hours
    const a1 = await device(A, "a1");
    const aOffline = await device(A, "offline", { online: false });
    const aLinux = await device(A, "linux", { os: "linux" });
    const aNoAgent = await device(A, "noagent", { agent: false });
    const T0 = Date.now();
    let r = await runAt(T0);
    check("schedule: a Windows device that is online and was never scanned gets a scan (the default is 24 hours)", (await scanJobs(a1)).length === 1 && r.scans >= 1, r);
    const j1 = (await scanJobs(a1))[0];
    check("schedule: it is a signed script job, fixed script, only RIQ_TOOL in its environment", j1.payload.language === "powershell" && j1.payload.env.RIQ_TOOL === "security.scan" && Object.keys(j1.payload.env).length === 1 && j1.payload.timeoutSec === 90 && j1.payload.scriptText.includes("Probe 'defender'"));
    check("schedule: a device that is offline and one with no agent are never scanned, but an online Linux device is (with the Linux script)", (await scanJobs(aOffline)).length === 0 && !(await row(aNoAgent)) && (await scanJobs(aLinux)).length === 1 && (await scanJobs(aLinux))[0].payload.language === "bash");
    r = await runAt(T0 + 60_000);
    check("schedule: a device with a scan already waiting is left alone", (await scanJobs(a1)).length === 1);
    await answer(a1, text(healthy()));
    check("schedule: the answer is read back by the poller, and the device has its score", (await security.poll()) >= 1 && (await row(a1)).score === 100 && (await row(a1)).pending_job_id === null);
    r = await runAt(T0 + 23 * HOUR);
    check("schedule: not again inside the interval (23 hours after the attempt)", (await scanJobs(a1)).length === 1);
    r = await runAt(T0 + 25 * HOUR + 120_000);
    check("schedule: again once 24 hours have passed", (await scanJobs(a1)).length === 2, (await scanJobs(a1)).length);
    await answer(a1, "garbage");
    await security.poll();
    check("schedule: a failed scan is a failed attempt, the last good result stays, and the next try waits for the interval", (await row(a1)).score === 100 && (await row(a1)).ok === false && /could not be read/.test((await row(a1)).message), await row(a1));

    // ---------------------------------------------------------------- policies change it
    const b1 = await device(B, "b1");
    const pNever = await policies.create({ name: `no scans ${stamp}`, sections: { security: { scanHours: 0 } }, assignments: [{ level: "customer", targetId: B.client.id }] }, me, o);
    await runAt(T0 + 2 * HOUR);
    check("policy: scanHours 0 means never: a device of that customer is not scanned, though everyone else is", (await scanJobs(b1)).length === 0);
    await policies.update(pNever.id, { sections: { security: { scanHours: 6 } } }, me, o);
    await runAt(T0 + 3 * HOUR);
    check("policy: scanHours 6 scans it", (await scanJobs(b1)).length === 1);
    await answer(b1, text(healthy()));
    await security.poll();
    const att = (await row(b1)).attempted_at.getTime();
    await runAt(att + 5 * HOUR);
    check("policy: not before 6 hours", (await scanJobs(b1)).length === 1);
    await runAt(att + 6 * HOUR + 60_000);
    check("policy: after 6 hours, again", (await scanJobs(b1)).length === 2);
    await policies.update(pNever.id, { sections: { security: { scanHours: 0 } } }, me, o);
    await answer(b1, text(healthy())); await security.poll();
    await runAt(att + 100 * HOUR);
    check("policy: back to 0, never again", (await scanJobs(b1)).length === 2);
    // a more specific policy wins: a device-level policy for one device
    const b2 = await device(B, "b2");
    const pDev = await policies.create({ name: `device scans ${stamp}`, sections: { security: { scanHours: 1 } }, assignments: [{ level: "device", targetId: b2.dev.id }] }, me, o);
    await runAt(T0 + 4 * HOUR);
    check("policy: a policy for one device beats the customer's", (await scanJobs(b2)).length === 1 && (await scanJobs(b1)).length === 2);
    const eff = (await policies.effectiveForDevices([b2.dev.id])).get(b2.dev.id);
    check("policy: the effective value says where it comes from", eff.scalars["security.scanHours"].value === 1 && eff.scalars["security.scanHours"].source.name === `device scans ${stamp}`);
    await policies.update(pDev.id, { enabled: false }, me, o).catch(() => null);

    // ---------------------------------------------------------------- a bounded number per sweep
    const many = [];
    for (let i = 0; i < SCANS_PER_SWEEP + 10; i++) many.push(await device(C, `m${i}`));
    r = await runAt(T0 + 5 * HOUR);
    const queued = async () => (await Promise.all(many.map(async (d) => (await scanJobs(d)).length))).reduce((a, b) => a + b, 0);
    check("sweep: at most SCANS_PER_SWEEP scans are started in one pass, and the rest is reported as due", r.scans === SCANS_PER_SWEEP && r.due >= SCANS_PER_SWEEP + 10 && (await queued()) === SCANS_PER_SWEEP, { r, q: await queued() });
    r = await runAt(T0 + 5 * HOUR + 60_000);
    check("sweep: the next pass takes the rest, and nobody is scanned twice", (await queued()) === SCANS_PER_SWEEP + 10 && r.scans === 10, { r, q: await queued() });
    check("sweep: no device has more than one waiting scan", (await Promise.all(many.map((d) => scanJobs(d)))).every((l) => l.length === 1));

    // ---------------------------------------------------------------- reading back
    const rb = await device(A, "readback");
    const q1 = await security.queueScan(rb.dev.id, rb.agent.id);
    const q2 = await security.queueScan(rb.dev.id, rb.agent.id);
    check("readback: queueing twice gives the same waiting job", !q1.alreadyWaiting && q2.alreadyWaiting && q1.jobId === q2.jobId);
    await prisma.jobs.update({ where: { id: q1.jobId }, data: { status: "timeout", finished_at: new Date() } });
    check("readback: a timed-out job is a failed attempt with a reason, nothing else is stored", (await security.poll()) === 0 && /too long/.test((await row(rb)).message) && (await row(rb)).scanned_at === null && (await row(rb)).raw === null);
    const view = await security.view(await security.device(rb.dev.id));
    check("readback: the page says it was never scanned, and that the last try failed", view.state === "not_scanned" && view.lastAttemptFailed === true && view.scan === null);
    check("readback: a new scan can be asked for after that", !(await security.queueScan(rb.dev.id, rb.agent.id)).alreadyWaiting);
    // a job that is not a security scan, planted in pending_job_id, is never ingested
    const other = await prisma.jobs.create({ data: { agent_id: rb.agent.id, type: "RUN_SCRIPT", payload: { env: { RIQ_TOOL: "services.list" }, language: "powershell", scriptText: "x" }, status: "succeeded", finished_at: new Date() } });
    await prisma.job_results.create({ data: { job_id: other.id, exit_code: 0, stdout: text(healthy()), stderr: "", duration_ms: 1n } });
    await prisma.$executeRaw`UPDATE public.device_security_scans SET pending_job_id = ${other.id}::uuid, pending_at = now() WHERE device_id = ${rb.dev.id}::uuid`;
    await security.poll();
    check("readback: only a security scan job is ever kept as a scan", (await row(rb)).scanned_at === null && (await row(rb)).pending_job_id === null && /gone/.test((await row(rb)).message));

    // ---------------------------------------------------------------- the report
    const rep = await endpoint.run("security-posture", { clientId: A.client.id });
    const names = rep.rows.map((x) => x.name);
    const ra1 = rep.rows.find((x) => x.name === `SEC-a1-${stamp}`);
    check("report: lists the Windows and Linux devices of the customer that have an agent, not agentless ones", names.includes(`SEC-a1-${stamp}`) && names.includes(`SEC-offline-${stamp}`) && names.includes(`SEC-linux-${stamp}`) && !names.includes(`SEC-noagent-${stamp}`), names);
    check("report: a scanned device has its score and grade, an unscanned one says so", ra1.score === 100 && ra1.grade === "A" && rep.rows.find((x) => x.name === `SEC-offline-${stamp}`).grade === "Not scanned" && rep.rows.find((x) => x.name === `SEC-readback-${stamp}`).state === "Scan failed", rep.rows.map((x) => [x.name, x.grade, x.state]));
    check("report: summary and columns", (rep.summary ?? []).some((s) => s.label === "Devices" && s.value === rep.rows.length) && rep.columns.some((c) => c.key === "failedChecks") && rep.charts.length === 2, { summary: rep.summary, rows: rep.rows.length, charts: rep.charts?.length });
    const { CATALOG } = require(path.join(dist, "reports/endpoint-reports.service.js"));
    const def = CATALOG.find((x) => x.key === "security-posture");
    check("report: it is in the catalogue under Security with the devices.read right, and the catalogue has 32 reports", !!def && def.group === "Security" && def.permission === "devices.read" && def.scoped === true && CATALOG.length === 32, CATALOG.length);

    console.log(`\n${passed} passed, ${failed} failed`);
    await prisma.$executeRaw`DELETE FROM public.device_security_scans WHERE device_id IN (SELECT d.id FROM public.devices d JOIN public.sites s ON s.id = d.site_id WHERE s.client_id = ANY(${[A.client.id, B.client.id, C.client.id]}::uuid[]))`;
    // leave nothing behind that other tests (for instance the patch scans of the same schedule) would count
    const clientIds = [A.client.id, B.client.id, C.client.id];
    await prisma.$executeRaw`DELETE FROM public.devices WHERE site_id IN (SELECT id FROM public.sites WHERE client_id = ANY(${clientIds}::uuid[]))`;
    await prisma.$executeRaw`DELETE FROM public.policies WHERE name LIKE ${"%" + stamp}`;
    await prisma.$executeRaw`DELETE FROM public.sites WHERE client_id = ANY(${clientIds}::uuid[])`;
    await prisma.$executeRaw`DELETE FROM public.clients WHERE id = ANY(${clientIds}::uuid[])`;
    await app.close();
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
