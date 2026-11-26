// ClamAV on a Linux device: what ADG RMM remembers after an action (installed or not, signatures refreshed, the last malware scan and what it
// found), shown through the device view, kept when a later scan does not finish, and also learned when the answer comes late (job lookup).
// Throwaway database only (name has "e2e"). Needs the migration 20261128010000_linux_av_state applied.
"use strict";
const crypto = require("node:crypto");
const path = require("node:path");

if (process.env.ADG_E2E_ALLOW !== "1" || !/e2e/.test(process.env.DATABASE_URL || "")) { console.error("Refusing to run: set ADG_E2E_ALLOW=1 and an e2e-named DATABASE_URL."); process.exit(2); }
process.env.JWT_SECRET ||= "e2e-only-not-a-real-secret-e2e-only-not-a-real-secret";
process.env.DATA_ENCRYPTION_KEY ||= "e2e-only-data-key";
process.env.IMAP_POLL_ENABLED = "false"; process.env.SECURITY_SCANS_AUTOMATION_ENABLED = "false"; process.env.SECURITY_SCANS_POLLER_ENABLED = "false"; process.env.NODE_ENV = "development";

let passed = 0, failed = 0;
const check = (name, ok, extra) => { ok ? passed++ : failed++; console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && extra !== undefined ? `: ${JSON.stringify(extra)}` : ""}`); };

(async () => {
    require("reflect-metadata");
    const { NestFactory } = require("@nestjs/core");
    const dist = path.resolve(process.cwd(), "dist");
    const { AppModule } = require(path.join(dist, "app.module.js"));
    const { PrismaService } = require(path.join(dist, "storage/prisma.service.js"));
    const { SecurityService } = require(path.join(dist, "security/security.service.js"));
    const app = await NestFactory.createApplicationContext(AppModule, { logger: ["error"] });
    const prisma = app.get(PrismaService, { strict: false });
    const security = app.get(SecurityService, { strict: false });

    const org = await prisma.organizations.upsert({ where: { slug: "default" }, create: { name: "Default Organization", slug: "default" }, update: {} });
    const stamp = Date.now();
    const client = await prisma.clients.create({ data: { organization_id: org.id, name: `LxAv ${stamp}` } });
    const site = await prisma.sites.create({ data: { client_id: client.id, name: "HQ" } });
    const dev = await prisma.devices.create({ data: { site_id: site.id, hostname: `LXAV-${stamp}`, operating_system: "Ubuntu 24.04.1 LTS" } });
    const agent = await prisma.agents.create({ data: { device_id: dev.id, agent_uuid: crypto.randomUUID(), version: "1.3.39", last_check_in_at: new Date(), facts: { os: "linux" } } });
    const d = await security.device(dev.id);

    // run one action: start it, then answer the job like the agent would
    async function act(action, stdout, stderr = "") {
        const p = security.linuxAction(d, action);
        let job = null;
        for (let i = 0; i < 100 && !job; i++) {
            await new Promise((r) => setTimeout(r, 100));
            job = (await prisma.jobs.findMany({ where: { agent_id: agent.id }, orderBy: { created_at: "desc" }, take: 1 }))[0];
            if (job && !String(job.payload?.env?.ADG_TOOL ?? "").startsWith("security.linux.")) job = null;
        }
        await prisma.jobs.update({ where: { id: job.id }, data: { status: "succeeded", finished_at: new Date() } });
        await prisma.job_results.upsert({ where: { job_id: job.id }, create: { job_id: job.id, exit_code: 0, stdout, stderr, duration_ms: 5n }, update: { stdout, stderr } });
        return p;
    }

    const v0 = await security.view(d);
    check("before anything: nothing is known about ClamAV", v0.clamav && v0.clamav.installed === null && v0.clamav.lastScan === null, v0.clamav);

    await act("antivirus-install", "OK ClamAV is installed (ClamAV 1.0.5) and its signatures are up to date.\n");
    const v1 = await security.view(d);
    check("after the install it is installed and the signatures are fresh", v1.clamav.installed === true && !!v1.clamav.signaturesAt && v1.clamav.lastScan === null, v1.clamav);

    await act("malware-scan", "R clean 12345 42\n");
    const v2 = await security.view(d);
    const s2 = v2.clamav.lastScan;
    check("a clean scan is kept with its time, file count and duration", s2 && s2.state === "clean" && s2.scannedFiles === 12345 && s2.seconds === 42 && s2.infectedCount === 0 && !!s2.at, s2);

    await act("malware-scan", "R infected 500 7 2\nF Eicar-Signature|/home/bob/eicar.com\nF Win.Test.EICAR_HDB-1|/tmp/x/eicar2.txt\n");
    const s3 = (await security.view(d)).clamav.lastScan;
    check("an infected scan lists the signatures and paths", s3.state === "infected" && s3.infectedCount === 2 && s3.found.length === 2 && s3.found[0].signature === "Eicar-Signature" && s3.found[0].path === "/home/bob/eicar.com", s3);

    await act("malware-scan", "E The scan ran out of time.\n");
    const v4 = await security.view(d);
    check("a scan that did not finish is shown as such and does not make ClamAV 'not installed'", v4.clamav.lastScan.state === "error" && /ran out of time/.test(v4.clamav.lastScan.message) && v4.clamav.installed === true, v4.clamav);

    await act("malware-scan", "E ClamAV is not installed. Install the clamav package from the Software tab.\n");
    check("a scan that says ClamAV is missing marks it not installed", (await security.view(d)).clamav.installed === false);

    await act("antivirus-install", "OK ClamAV is installed (ClamAV 1.0.5) and its signatures are up to date.\n");
    check("installing again marks it installed", (await security.view(d)).clamav.installed === true);

    // a malware scan that was still running when asked: the late answer is learned through the job lookup
    const p = security.linuxAction(d, "malware-scan");
    let job = null;
    for (let i = 0; i < 100 && !job; i++) { await new Promise((r) => setTimeout(r, 100)); job = (await prisma.jobs.findMany({ where: { agent_id: agent.id }, orderBy: { created_at: "desc" }, take: 1 }))[0]; if (job && job.payload?.env?.ADG_TOOL !== "security.linux.malware-scan") job = null; }
    p.catch(() => {});
    await prisma.jobs.update({ where: { id: job.id }, data: { status: "succeeded", finished_at: new Date() } });
    await prisma.job_results.upsert({ where: { job_id: job.id }, create: { job_id: job.id, exit_code: 0, stdout: "R clean 999 3\n", stderr: "", duration_ms: 5n }, update: { stdout: "R clean 999 3\n", stderr: "" } });
    await p.catch(() => {});
    const late = await security.defenderResult(d, job.id);
    const s5 = (await security.view(d)).clamav.lastScan;
    check("the job lookup returns the result and the latest scan is the one shown", late.pending === false && s5.scannedFiles === 999, { late, s5 });

    const w = await prisma.devices.create({ data: { site_id: site.id, hostname: `LXAV-WIN-${stamp}`, operating_system: "Windows 11 Pro" } });
    await prisma.agents.create({ data: { device_id: w.id, agent_uuid: crypto.randomUUID(), version: "1.3.39", last_check_in_at: new Date(), facts: { os: "windows" } } });
    check("a Windows device has no ClamAV state", (await security.view(await security.device(w.id))).clamav === null);

    await app.close();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
