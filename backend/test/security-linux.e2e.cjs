// The security scan of Linux devices in the application against a real database (no HTTP): a scan is queued as a bash job with its own
// marker, read back by the poller and kept with a score and grade, shown through the device view with Linux highlights, listed in the
// fleet view and summary, scheduled by the same policy setting as Windows, refused for devices that are neither Windows nor Linux and for
// the Defender actions, and a failed attempt keeps the last good result. Throwaway database only (name has "e2e").
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
process.env.SECURITY_SCANS_AUTOMATION_ENABLED = "false";
process.env.SECURITY_SCANS_POLLER_ENABLED = "false";
process.env.NODE_ENV = "development";

let passed = 0;
let failed = 0;
function check(name, ok, extra) {
    if (ok) passed++;
    else failed++;
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && extra !== undefined ? `: ${JSON.stringify(extra)}` : ""}`);
}
const fails = async (fn, re) => { try { await fn(); return false; } catch (e) { return re.test(String(e.message ?? e)); } };

const HEALTHY = [
    "K os id ubuntu", "K os version 24.04", "K os name Ubuntu 24.04.1 LTS", "K os kernel 6.8.0-45-generic",
    "K firewall manager ufw", "K firewall active yes", "K encryption volumes /:on,",
    "K ssh installed yes", "K ssh running yes", "K ssh permitrootlogin prohibit-password", "K ssh passwordauthentication no", "K ssh permitemptypasswords no", "K ssh port 22",
    "K accounts emptypassword ", "K accounts extraroot ", "K accounts admins alice,bob,",
    "K updates agedays 3", "K autoupdates enabled yes", "K autoupdates by unattended-upgrades", "K reboot pending no", "K mac kind apparmor", "K mac mode enabled",
    "K time synchronized yes", "K exposure risky ", "K disk rootusedpercent 41", "K antivirus products ClamAV,", "K boot uefi yes", "K boot secureboot yes", "K boot tpm yes", "E 2",
];
const outputWith = (over = {}) => HEALTHY.map((l) => { const k = Object.keys(over).find((p) => l.startsWith(p + " ")); return k ? `${k} ${over[k]}` : l; }).join("\n") + "\n";

(async () => {
    require("reflect-metadata");
    const { NestFactory } = require("@nestjs/core");
    const dist = path.resolve(process.cwd(), "dist");
    const { AppModule } = require(path.join(dist, "app.module.js"));
    const { PrismaService } = require(path.join(dist, "storage/prisma.service.js"));
    const { SecurityService } = require(path.join(dist, "security/security.service.js"));
    const { SecurityFleetService } = require(path.join(dist, "security/security-fleet.service.js"));
    const { SecurityAutomationService } = require(path.join(dist, "security/security-automation.service.js"));

    const app = await NestFactory.createApplicationContext(AppModule, { logger: ["error"] });
    const prisma = app.get(PrismaService, { strict: false });
    const security = app.get(SecurityService, { strict: false });
    const fleet = app.get(SecurityFleetService, { strict: false });
    const auto = app.get(SecurityAutomationService, { strict: false });

    const org = await prisma.organizations.upsert({ where: { slug: "default" }, create: { name: "Default Organization", slug: "default" }, update: {} });
    const stamp = Date.now();
    const client = await prisma.clients.create({ data: { organization_id: org.id, name: `LxSec ${stamp}` } });
    const site = await prisma.sites.create({ data: { client_id: client.id, name: "HQ" } });
    async function device(label, os, osName) {
        const dev = await prisma.devices.create({ data: { site_id: site.id, hostname: `LXSEC-${label}-${stamp}`, operating_system: osName } });
        const agent = await prisma.agents.create({ data: { device_id: dev.id, agent_uuid: crypto.randomUUID(), version: "1.3.37", last_check_in_at: new Date(), facts: { os } } });
        return { dev, agent };
    }
    const scanJobs = async (d) => (await prisma.jobs.findMany({ where: { agent_id: d.agent.id }, orderBy: { created_at: "asc" } })).filter((j) => j.payload?.env?.RIQ_TOOL === "security.scan");
    const row = async (d) => (await prisma.$queryRaw`SELECT * FROM public.device_security_scans WHERE device_id = ${d.dev.id}::uuid`)[0] ?? null;
    async function answer(d, stdout, status = "succeeded", stderr = "") {
        const j = (await scanJobs(d)).pop();
        await prisma.jobs.update({ where: { id: j.id }, data: { status, finished_at: new Date() } });
        await prisma.job_results.upsert({ where: { job_id: j.id }, create: { job_id: j.id, exit_code: 0, stdout, stderr, duration_ms: 5n }, update: { stdout, stderr } });
        return j;
    }

    const lx = await device("lx", "linux", "Ubuntu 24.04.1 LTS");
    const win = await device("win", "windows", "Windows 11 Pro");
    const mac = await device("mac", "macos", "macOS 14");
    const nameOnly = await prisma.devices.create({ data: { site_id: site.id, hostname: `LXSEC-name-${stamp}`, operating_system: "Debian GNU/Linux 12" } });
    const nameOnlyAgent = await prisma.agents.create({ data: { device_id: nameOnly.id, agent_uuid: crypto.randomUUID(), version: "1.3.30", last_check_in_at: new Date(), facts: {} } });

    // ---------------------------------------------------------------- who can be scanned
    const dLx = await security.device(lx.dev.id);
    const dWin = await security.device(win.dev.id);
    const dMac = await security.device(mac.dev.id);
    const dName = await security.device(nameOnly.id);
    check("a Linux device is a Linux device and not a Windows one", dLx.linux === true && dLx.windows === false, dLx);
    check("a device whose agent sent no OS is recognised by its distribution name", dName.linux === true && dName.windows === false, dName);
    check("a macOS device is neither", dMac.linux === false && dMac.windows === false);
    check("the scan is refused for macOS, with a message that names both systems", await fails(() => security.startScan(dMac), /Windows and Linux/));
    check("Defender actions are refused for a Linux device", await fails(() => security.defender(dLx, "update"), /only available for Windows/));
    check("the view says unsupported for macOS", (await security.view(dMac)).state === "unsupported");

    // ---------------------------------------------------------------- asking for a scan
    const q = await security.startScan(dLx);
    const jobs = await scanJobs(lx);
    check("a Linux scan is queued as a bash job with the Linux marker", jobs.length === 1 && jobs[0].payload?.language === "bash" && jobs[0].payload?.env?.RIQ_PLATFORM === "linux" && /^#!\/bin\/bash/.test(jobs[0].payload?.scriptText ?? ""), jobs[0]?.payload && { l: jobs[0].payload.language, e: jobs[0].payload.env });
    check("a Windows scan is still a PowerShell job without it", (await security.startScan(dWin), (await scanJobs(win))[0]?.payload?.language === "powershell" && !(await scanJobs(win))[0]?.payload?.env?.RIQ_PLATFORM));
    check("asking again while it waits does not queue a second scan", (await security.startScan(dLx)).alreadyWaiting === true && (await scanJobs(lx)).length === 1);
    const waiting = await security.view(dLx);
    check("the view says it is waiting", waiting.state === "not_scanned" && waiting.pending === true && waiting.linux === true, waiting);

    // ---------------------------------------------------------------- reading it back
    await answer(lx, outputWith());
    await security.poll();
    const r1 = await row(lx);
    check("the poller keeps the result: score 100, grade A, no failed rules", r1 && r1.ok === true && r1.score === 100 && r1.grade === "A" && r1.failed_rules.length === 0 && r1.pending_job_id === null, r1 && { s: r1.score, g: r1.grade, f: r1.failed_rules, p: r1.pending_job_id });
    check("the stored scan is marked as a Linux scan", r1?.raw?.platform === "linux" && r1.raw.probes?.os?.name === "Ubuntu 24.04.1 LTS");
    const v1 = await security.view(dLx);
    check("the view shows the scan with Linux highlights and 18 rules", v1.state === "scanned" && v1.scan.highlights.platform === "linux" && v1.scan.rules.length === 18 && v1.scan.score === 100, { st: v1.state, hp: v1.scan?.highlights?.platform, n: v1.scan?.rules?.length });
    check("every rule carries its texts and the Linux highlights carry the OS support", v1.scan.rules.every((r) => r.title && r.why && r.fix && r.checks) && v1.scan.highlights.os.support.status === "supported");

    // ---------------------------------------------------------------- a poor result, and a failed attempt
    await security.startScan(dLx);
    await answer(lx, outputWith({ "K firewall active": "no", "K ssh permitrootlogin": "yes", "K exposure risky": "telnet," }));
    await security.poll();
    const r2 = await row(lx);
    check("a poor server fails its rules, and a failed critical rule caps the grade", r2.grade === "D" && r2.score <= 69 && r2.failed_rules.includes("lx.fw.active") && r2.failed_rules.includes("lx.ssh.rootlogin") && r2.critical_failed === 1 && r2.high_failed === 2, { g: r2.grade, s: r2.score, f: r2.failed_rules, c: r2.critical_failed, h: r2.high_failed });
    await security.startScan(dLx);
    await answer(lx, "", "failed", "bash: line 3: syntax error");
    await security.poll();
    const r3 = await row(lx);
    check("a failed attempt keeps the last good result and says why", r3.ok === false && r3.score === r2.score && /did not run|syntax error/.test(r3.message ?? ""), { ok: r3.ok, m: r3.message });
    await security.startScan(dLx);
    await answer(lx, "this is not a scan", "succeeded");
    await security.poll();
    check("output that is not a scan is refused and the last good result stays", (await row(lx)).score === r2.score && /not a security scan/.test((await row(lx)).message ?? ""));
    await security.startScan(dLx);
    await answer(lx, "", "timeout");
    await security.poll();
    check("a timed out scan is noted", /too long/.test((await row(lx)).message ?? ""));

    // ---------------------------------------------------------------- the fleet and the schedule
    const scoped = await fleet.fleet(null, { clientId: client.id, limit: 50 });
    const names = scoped.items.map((i) => i.hostname);
    check("the fleet lists the Linux and Windows devices of the customer but not the macOS one", names.includes(`LXSEC-lx-${stamp}`) && names.includes(`LXSEC-win-${stamp}`) && !names.includes(`LXSEC-mac-${stamp}`) && names.includes(`LXSEC-name-${stamp}`), names);
    const lxRow = scoped.items.find((i) => i.hostname === `LXSEC-lx-${stamp}`);
    check("the fleet row carries the firewall, encryption and antivirus labels", lxRow.firewall?.text === "Off" && lxRow.bitlocker?.text === "On" && lxRow.defender?.text === "ClamAV", lxRow);
    const sum = await fleet.summary(null, client.id);
    check("the summary counts the Linux device and its failed rules", sum.windowsDevices === 3 && sum.scanned === 1 && sum.topFailingRules.some((r) => r.id === "lx.fw.active" && r.group === "Firewall"), sum);

    const later = Date.now() + 3 * 24 * 3600_000;
    await prisma.agents.updateMany({ where: { id: { in: [lx.agent.id, nameOnlyAgent.id] } }, data: { last_check_in_at: new Date(later) } });
    const before = (await scanJobs({ agent: nameOnlyAgent })).length;
    const sweep = await auto.run(later);
    check("the schedule asks the Linux devices too (a name-only one as well)", sweep.scans >= 2 && (await scanJobs({ agent: nameOnlyAgent })).length === before + 1, sweep);
    check("a device recognised by name is sent the Linux script", (await scanJobs({ agent: nameOnlyAgent })).pop()?.payload?.language === "bash");

    await app.close();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
