// After an install: the device is scanned again by itself (once, not once per install), and until that scan lands the list of needed
// patches counts every install since the last scan, so a package installed earlier does not come back as "Required".
// Real database, throwaway only. Run: ADG_E2E_ALLOW=1 DATABASE_URL=postgres://.../adg_x_e2e node test/patch-install-rescan.e2e.cjs
"use strict";
const crypto = require("node:crypto");
const path = require("node:path");

if (process.env.ADG_E2E_ALLOW !== "1" || !/e2e/.test(process.env.DATABASE_URL || "")) { console.error("Refusing to run: set ADG_E2E_ALLOW=1 and an e2e-named DATABASE_URL."); process.exit(2); }
process.env.JWT_SECRET ||= "e2e-only-not-a-real-secret-e2e-only-not-a-real-secret";
process.env.DATA_ENCRYPTION_KEY ||= "e2e-only-data-key";
process.env.IMAP_POLL_ENABLED = "false";
process.env.NODE_ENV = "development";

let passed = 0, failed = 0;
const check = (name, ok, extra) => { if (ok) passed++; else failed++; console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && extra !== undefined ? `: ${JSON.stringify(extra)}` : ""}`); };

(async () => {
    require("reflect-metadata");
    const { NestFactory } = require("@nestjs/core");
    const dist = path.resolve(process.cwd(), "dist");
    const { AppModule } = require(path.join(dist, "app.module.js"));
    const { PatchesService } = require(path.join(dist, "patches/patches.service.js"));
    const { AgentsTasksService } = require(path.join(dist, "agents/agents.tasks.service.js"));
    const { PrismaService } = require(path.join(dist, "storage/prisma.service.js"));
    const lp = require(path.join(dist, "patches/linux-patching.js"));

    const app = await NestFactory.createApplicationContext(AppModule, { logger: ["error"] });
    const patches = app.get(PatchesService, { strict: false });
    const tasks = app.get(AgentsTasksService, { strict: false });
    const prisma = app.get(PrismaService, { strict: false });
    const org = await prisma.organizations.upsert({ where: { slug: "default" }, create: { name: "Default Organization", slug: "default" }, update: {} });
    const stamp = Date.now();

    async function device(os) {
        const client = await prisma.clients.create({ data: { organization_id: org.id, name: `RS ${os} ${stamp}` } });
        const site = await prisma.sites.create({ data: { client_id: client.id, name: "HQ" } });
        const dev = await prisma.devices.create({ data: { site_id: site.id, hostname: `RS-${os}-${stamp}`, operating_system: os === "windows" ? "Windows 11 Pro" : "Ubuntu 24.04 LTS" } });
        const agent = await prisma.agents.create({ data: { device_id: dev.id, agent_uuid: crypto.randomUUID(), version: lp.LINUX_PATCH_MIN_VERSION, last_check_in_at: new Date(), facts: { os } } });
        return { dev, agent };
    }
    const scanDone = async (d, ids, finished) => {
        const t = await prisma.agent_tasks.create({ data: { agent_id: d.agent.id, type: "patch_scan", payload: {}, status: "succeeded" } });
        const r = await prisma.agent_task_runs.create({ data: { task_id: t.id, status: "succeeded", finished_at: finished, output: { ok: true } } });
        await prisma.agent_task_results.create({ data: { run_id: r.id, artifacts: { packageManager: "apt", patches: ids.map((id) => ({ id, title: id, severity: null, requiresReboot: false, kbIds: [], security: false, name: id, current: "1", available: "2" })) } } });
    };
    // an install that is running, then completed through the same call the agent's report uses
    async function installRuns(d, installed, status = "succeeded") {
        const t = await prisma.agent_tasks.create({ data: { agent_id: d.agent.id, type: "patch_install", payload: { ids: installed, includeOptional: false }, status: "running" } });
        const r = await prisma.agent_task_runs.create({ data: { task_id: t.id, status: "running", started_at: new Date() } });
        await tasks.completeRun({ agentId: d.agent.id, taskId: t.id, runId: r.id, status, stdout: "", stderr: null, output: { ok: status === "succeeded" }, artifacts: { installed, requiresReboot: false } });
    }
    const scans = (d) => prisma.agent_tasks.findMany({ where: { agent_id: d.agent.id, type: "patch_scan" }, orderBy: { created_at: "asc" } });
    const statusOf = async (d) => Object.fromEntries((await patches.getLatest(d.dev.id)).patches.map((p) => [p.id, p.status]));

    const L = await device("linux");
    const past = new Date(Date.now() - 3600_000);
    await scanDone(L, ["a", "b", "c", "d"], past);
    check("before any install all four are required", JSON.stringify(await statusOf(L)) === JSON.stringify({ a: "Required", b: "Required", c: "Required", d: "Required" }));

    await installRuns(L, ["a"]);
    let s = await scans(L);
    check("a finished install queues one new scan of the device", s.length === 2 && s[1].status === "queued" && s[1].payload.afterInstall === true, s.map((x) => x.status));

    await installRuns(L, ["b"]);
    s = await scans(L);
    check("a second install while that scan still waits does not queue another", s.length === 2, s.length);
    check("every install since the last scan counts as installed, not only the newest", JSON.stringify(await statusOf(L)) === JSON.stringify({ a: "Installed", b: "Installed", c: "Required", d: "Required" }), await statusOf(L));

    await prisma.agent_tasks.update({ where: { id: s[1].id }, data: { status: "succeeded" } });
    await installRuns(L, ["c"], "failed");
    s = await scans(L);
    check("an install that failed (it may have changed some packages) is followed by a scan too", s.length === 3, s.length);

    await scanDone(L, ["d"], new Date(Date.now() + 5000));
    check("a newer scan replaces the guess: only what the device still needs is listed, as required", JSON.stringify(await statusOf(L)) === JSON.stringify({ d: "Required" }), await statusOf(L));

    const W = await device("windows");
    await installRuns(W, ["KB1"]);
    check("a Windows device is scanned again after an install as well", (await scans(W)).length === 1);

    await app.close();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
