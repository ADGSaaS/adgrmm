// Scheduled network discovery and the alerts for new hosts, against a real database, in-process (the timers are switched off and the
// test calls the scheduler and the reader itself). A fake agent finishes the scan jobs with scripted output.
// Needs the migrations 20261121010000 and 20261121020000 applied to the throwaway database.
//   RIQ_E2E_ALLOW=1 DATABASE_URL=postgres://.../riq_x_e2e JWT_SECRET=... node test/network-discovery-schedules.e2e.cjs
"use strict";
const path = require("node:path");
const crypto = require("node:crypto");

if (process.env.RIQ_E2E_ALLOW !== "1" || !/e2e/.test(process.env.DATABASE_URL || "")) { console.error("Refusing to run: set RIQ_E2E_ALLOW=1 and an e2e-named DATABASE_URL."); process.exit(2); }
process.env.JWT_SECRET ||= "e2e-only-not-a-real-secret-e2e-only-not-a-real-secret";
process.env.DATA_ENCRYPTION_KEY ||= "e2e-only-data-key";
process.env.IMAP_POLL_ENABLED = "false";
process.env.NODE_ENV = "development";
process.env.NETWORK_DISCOVERY_SCHEDULER_ENABLED = "false";
process.env.NETWORK_DISCOVERY_POLLER_ENABLED = "false";

let passed = 0, failed = 0;
const check = (name, ok, extra) => { if (ok) passed++; else failed++; console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && extra !== undefined ? `: ${JSON.stringify(extra)}` : ""}`); };
const fails = async (fn, re) => { try { await fn(); return false; } catch (e) { return re.test(String(e.message ?? e)); } };

(async () => {
    require("reflect-metadata");
    const { NestFactory } = require("@nestjs/core");
    const dist = path.resolve(process.cwd(), "dist");
    const { AppModule } = require(path.join(dist, "app.module.js"));
    const { NetworkDiscoveryService } = require(path.join(dist, "network-discovery/network-discovery.service.js"));
    const { NetworkDiscoverySchedulesService } = require(path.join(dist, "network-discovery/network-discovery-schedules.service.js"));
    const { PrismaService } = require(path.join(dist, "storage/prisma.service.js"));
    const D = require(path.join(dist, "network-discovery/discovery.scripts.js"));

    const app = await NestFactory.createApplicationContext(AppModule, { logger: ["error"] });
    const disc = app.get(NetworkDiscoveryService, { strict: false });
    const sched = app.get(NetworkDiscoverySchedulesService, { strict: false });
    const prisma = app.get(PrismaService, { strict: false });
    const q = (sql, params) => prisma.$queryRawUnsafe(sql, ...(params ?? []));
    const org = await prisma.organizations.upsert({ where: { slug: "default" }, create: { name: "Default Organization", slug: "default" }, update: {} });
    const stamp = Date.now();

    const site = async (label) => {
        const client = await prisma.clients.create({ data: { organization_id: org.id, name: `NS ${label} ${stamp}` } });
        return { client, site: await prisma.sites.create({ data: { client_id: client.id, name: `${label} HQ` } }) };
    };
    const device = async (s, label, { os = "windows", minutes = 0, facts = {} } = {}) => {
        const dev = await prisma.devices.create({ data: { site_id: s.site.id, hostname: `NS-${label}-${stamp}`, operating_system: os === "windows" ? "Windows 11 Pro" : "Ubuntu 24.04" } });
        const agent = await prisma.agents.create({ data: { device_id: dev.id, agent_uuid: crypto.randomUUID(), version: "1.3.37", last_check_in_at: new Date(Date.now() - minutes * 60_000), facts: { os, ...facts } } });
        return { dev, agent };
    };
    const finish = async (jobId, out) => {
        await prisma.$executeRawUnsafe(`UPDATE jobs SET status = 'succeeded', finished_at = now() WHERE id = $1::uuid`, jobId);
        await prisma.$executeRawUnsafe(`INSERT INTO job_results (job_id, exit_code, stdout, stderr) VALUES ($1::uuid, 0, $2, '') ON CONFLICT (job_id) DO NOTHING`, jobId, out);
    };
    const lastJob = async (siteId) => (await q(`SELECT job_id::text AS job_id, scanner_device_id::text AS scanner, status FROM network_discovery_runs WHERE site_id = $1::uuid ORDER BY requested_at DESC LIMIT 1`, [siteId]))[0];
    const scanWith = async (siteId, lines) => { // one scheduled round: the scheduler starts it, the fake agent answers, the reader reads it back
        const started = await sched.runDue();
        const r = await lastJob(siteId);
        await finish(r.job_id, ["R 10.5.0.0/24", ...lines, "E 4"].join("\n"));
        await disc.poll();
        return { started, run: r };
    };
    const backdate = (siteId, hours = 25) => q(`UPDATE network_discovery_schedules SET last_requested_at = now() - make_interval(hours => $2::int) WHERE site_id = $1::uuid`, [siteId, hours]);
    const alertsFor = (like) => q(`SELECT dedupe_key, state, kind, device_id::text AS device_id, title FROM alerts WHERE dedupe_key LIKE $1 ORDER BY dedupe_key`, [like]);
    const hostId = async (siteId, ip) => (await q(`SELECT id::text AS id FROM discovered_hosts WHERE site_id = $1::uuid AND ip = $2`, [siteId, ip]))[0]?.id;

    const S = await site("A");
    const win = await device(S, "win");
    const lin = await device(S, "lin", { os: "linux" });
    const off = await device(S, "off", { minutes: 90 });
    const known = await device(S, "known-pc", { facts: { device: { network: [{ mac: "AA:BB:CC:00:00:01", ipv4: ["10.5.0.10"] }] } } });

    // ---- the schedule itself
    check("a schedule is saved with defaults, listed with its next due time, and updated in place", await (async () => {
        const r = await sched.save(null, S.site.id, {});
        const again = await sched.save(null, S.site.id, { intervalHours: 6, ranges: ["10.5.0.0/24"], alertNew: false });
        const list = (await sched.list(null)).items.filter((x) => x.siteId === S.site.id);
        return r.enabled === true && r.intervalHours === 24 && r.alertNew === true && again.intervalHours === 6 && again.alertNew === false && list.length === 1 && list[0].ranges[0] === "10.5.0.0/24" && list[0].customer === `NS A ${stamp}`;
    })());
    check("odd input is refused: a bad interval, a public range, a scanner from another site, a site that does not exist", await (async () => {
        const other = await site("B"); const od = await device(other, "other");
        return (await fails(() => sched.save(null, S.site.id, { intervalHours: 2 }), /hours/))
            && (await fails(() => sched.save(null, S.site.id, { ranges: ["8.8.8.0/24"] }), /private/))
            && (await fails(() => sched.save(null, S.site.id, { scannerDeviceId: od.dev.id }), /belong to this site/))
            && (await fails(() => sched.save(null, crypto.randomUUID(), {}), /not found/i));
    })());
    await sched.save(null, S.site.id, { intervalHours: 24, ranges: ["10.5.0.0/24"], alertNew: true });

    // ---- the first scan is the baseline: it raises nothing
    const first = await scanWith(S.site.id, ["H 10.5.0.10 AA:BB:CC:00:00:01 pc-known 445,3389", "H 10.5.0.11 AA:BB:CC:00:00:02 printer-1 9100", "H 10.5.0.12 AA:BB:CC:00:00:03 - 22"]);
    check("the scheduler starts a scan for a due schedule, from an online Windows or Linux device of the site, with the schedule's ranges", first.started === 1 && [win.dev.id, lin.dev.id, known.dev.id].includes(first.run.scanner) && first.run.scanner !== off.dev.id, first);
    check("the first scan of a site is the baseline: hosts are remembered, no alert is raised", (await alertsFor("discovery:%")).length === 0 && (await disc.list(null, { status: "all" })).counts.all >= 3);
    check("the schedule is not due again until its interval has passed", (await sched.runDue()) === 0);

    // ---- a later scan: new unknown hosts alert, once each
    await backdate(S.site.id);
    const second = await scanWith(S.site.id, ["H 10.5.0.10 AA:BB:CC:00:00:01 pc-known 445", "H 10.5.0.11 AA:BB:CC:00:00:02 printer-1 9100", "H 10.5.0.50 AA:BB:CC:00:00:50 camera-3 554,80", "H 10.5.0.51 - - -"]);
    const al = await alertsFor("discovery:host:%");
    const camId = await hostId(S.site.id, "10.5.0.50"), plainId = await hostId(S.site.id, "10.5.0.51");
    check("a new unknown host raises one WARN alert on the scanner device; hosts seen before and managed ones raise none", second.started === 1 && al.length === 2 && al.every((a) => a.kind === "discovery" && a.state !== "RESOLVED" && a.device_id === second.run.scanner) && al.some((a) => a.dedupe_key === `discovery:host:${camId}` && /camera-3/.test(a.title)) && al.some((a) => a.dedupe_key === `discovery:host:${plainId}` && /10\.5\.0\.51/.test(a.title)), { al, second });
    const detail = (await q(`SELECT detail FROM alerts WHERE dedupe_key = $1`, [`discovery:host:${camId}`]))[0].detail;
    check("the alert says what was found: address, MAC, what it looks like, the open ports, and what to do", /10\.5\.0\.50/.test(detail) && /AA:BB:CC:00:00:50/.test(detail) && /Camera or recorder/.test(detail) && /554, 80|80, 554/.test(detail) && /Network discovery/.test(detail), detail);

    // ---- alerts end when the host is ignored or becomes managed
    await disc.setIgnored(null, [camId], true);
    check("ignoring a host closes its alert", (await alertsFor(`discovery:host:${camId}`))[0].state === "RESOLVED");
    await prisma.agents.update({ where: { id: known.agent.id }, data: { facts: { os: "windows", device: { network: [{ mac: "AA:BB:CC:00:00:01", ipv4: ["10.5.0.10"] }, { mac: "AA:BB:CC:00:00:51", ipv4: ["10.5.0.51"] }] } } } });
    await backdate(S.site.id);
    await scanWith(S.site.id, ["H 10.5.0.51 AA:BB:CC:00:00:51 - -"]);
    check("a host that turns out to be a managed device closes its alert too (and a MAC seen later is the same host, not a new one)", (await alertsFor(`discovery:host:${plainId}`))[0].state === "RESOLVED" && (await q(`SELECT count(*)::int AS n FROM discovered_hosts WHERE site_id = $1::uuid AND ip = '10.5.0.51'`, [S.site.id]))[0].n === 1);
    check("the same host seen again raises nothing new", (await alertsFor("discovery:host:%")).length === 2);

    // ---- a burst is a summary
    await backdate(S.site.id);
    await scanWith(S.site.id, Array.from({ length: 12 }, (_, i) => `H 10.5.0.${100 + i} AA:BB:CC:01:00:${(10 + i).toString(16).padStart(2, "0").toUpperCase()} dev-${i} 80`));
    const burst = await alertsFor("discovery:%");
    check("12 new hosts in one scan raise 10 alerts and one summary, not 12", burst.filter((a) => a.dedupe_key.startsWith("discovery:host:")).length === 12 /* the 2 earlier + 10 now */ && burst.filter((a) => a.dedupe_key.startsWith("discovery:summary:")).length === 1 && /12 new devices/.test(burst.find((a) => a.dedupe_key.startsWith("discovery:summary:")).title), burst.map((a) => a.dedupe_key.slice(0, 22)));

    // ---- alert_new off, disabled, no scanner, preferred scanner
    await sched.save(null, S.site.id, { alertNew: false, intervalHours: 24, ranges: ["10.5.0.0/24"] });
    await backdate(S.site.id);
    const before = (await alertsFor("discovery:%")).length;
    await scanWith(S.site.id, ["H 10.5.0.200 AA:BB:CC:02:00:01 quiet 80"]);
    check("with alerts switched off a new host is remembered and nothing is raised", (await alertsFor("discovery:%")).length === before && !!(await hostId(S.site.id, "10.5.0.200")));
    await sched.save(null, S.site.id, { enabled: false });
    await backdate(S.site.id);
    check("a disabled schedule starts nothing", (await sched.runDue()) === 0);
    await sched.save(null, S.site.id, { enabled: true, scannerDeviceId: lin.dev.id });
    await backdate(S.site.id);
    await q(`UPDATE network_discovery_runs SET status = 'failed' WHERE site_id = $1::uuid AND status = 'pending'`, [S.site.id]);
    const pref = await scanWith(S.site.id, []);
    check("the preferred scanner is used when it is online", pref.run.scanner === lin.dev.id, pref.run);
    await q(`UPDATE agents SET last_check_in_at = now() - interval '90 minutes' WHERE device_id = ANY($1::uuid[])`, [[win.dev.id, lin.dev.id, known.dev.id]]);
    await backdate(S.site.id);
    const quiet = await sched.runDue();
    const row = (await sched.list(null)).items.find((x) => x.siteId === S.site.id);
    check("with no device online nothing starts, the schedule says why, and it stays due so it runs as soon as a device is back", quiet === 0 && /No Windows or Linux device/.test(row.message || "") && row.nextDueAt === "due now", row);
    await q(`UPDATE agents SET last_check_in_at = now() WHERE device_id = $1::uuid`, [win.dev.id]);
    await q(`UPDATE network_discovery_runs SET status = 'failed' WHERE site_id = $1::uuid AND status = 'pending'`, [S.site.id]);
    check("when a device is back, the next tick uses another online device (the preferred one is still offline)", (await sched.runDue()) === 1 && (await lastJob(S.site.id)).scanner === win.dev.id);

    // ---- one at a time, and the customer limit
    check("a schedule never starts a second scan while one is still running for the site", (await (async () => { await backdate(S.site.id); return sched.runDue(); })()) === 0);
    const lim = (await q(`INSERT INTO users (id, organization_id, email, first_name, last_name, status, password_hash) VALUES ($1::uuid, $2::uuid, $3, 'E2E', 'lim', 'active', 'x') RETURNING id::text AS id`, [crypto.randomUUID(), org.id, `ns-lim-${stamp}@example.test`]))[0].id;
    const T = await site("C");
    await q(`INSERT INTO user_client_access (user_id, client_id) VALUES ($1::uuid, $2::uuid)`, [lim, T.client.id]);
    check("a limited person cannot make, see or remove a schedule of another customer's site", (await fails(() => sched.save(lim, S.site.id, {}), /not found/i)) && (await sched.list(lim)).items.length === 0 && (await sched.remove(lim, S.site.id)) === false);
    check("a schedule is removed", (await sched.remove(null, S.site.id)) === true && !(await sched.list(null)).items.some((x) => x.siteId === S.site.id));

    await q(`DELETE FROM users WHERE id = $1::uuid`, [lim]).catch(() => { });
    await app.close();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
