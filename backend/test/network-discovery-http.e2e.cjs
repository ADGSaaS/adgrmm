#!/usr/bin/env node
// Network discovery through the real HTTP API with a fake agent that answers the signed scan jobs with scripted output: rights, who can
// scan from where (Windows and Linux online devices only), refused ranges and devices, the scan flow (one at a time per site, read back
// on request), hosts remembered once and updated by the next scan, managed devices recognised by MAC, address and name, ignoring,
// failed and garbage answers, the customer limit, and the audit trail. Throwaway backend and database only; the database needs the
// migration 20261121010000_network_discovery applied.
//   RIQ_E2E_ALLOW=1 BASE_URL=http://127.0.0.1:3951 DATABASE_URL=postgres://.../riq_x_e2e JWT_SECRET=... node test/network-discovery-http.e2e.cjs
"use strict";
const path = require("node:path");
const { assert, call, runner, setup, uuid } = require("./groupc-helpers.cjs");
const D = require(path.join(__dirname, "..", process.env.DIST || "dist", "network-discovery", "discovery.scripts.js"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
    const { q, org, made, staffUser, cleanup } = await setup();
    const { test, finish } = runner();
    const tag = `ND${Date.now()}`;
    const devs = [];
    const reader = await staffUser("nd-reader", ["devices.read"]);
    const ops = await staffUser("nd-ops", ["devices.read", "devices.actions"]);
    const nobody = await staffUser("nd-nobody", ["customers.read"]);
    const limited = await staffUser("nd-limited", ["devices.read", "devices.actions"]);

    const mkClient = async (n) => {
        const id = (await q(`INSERT INTO clients (organization_id, name) VALUES ($1,$2) RETURNING id`, [org, `${tag} ${n}`])).rows[0].id;
        made.clients.push(id);
        return { id, site: (await q(`INSERT INTO sites (client_id, name) VALUES ($1,$2) RETURNING id`, [id, `${n} HQ`])).rows[0].id };
    };
    const A = await mkClient("A"), B = await mkClient("B");
    await q(`INSERT INTO user_client_access (user_id, client_id) VALUES ($1,$2)`, [limited.id, A.id]);

    const mk = async (site, host, os, minutes = 0, facts = {}) => {
        const id = (await q(`INSERT INTO devices (site_id, hostname, operating_system) VALUES ($1,$2,$3) RETURNING id`, [site, `${tag}-${host}`, os === "windows" ? "Windows 11 Pro" : os === "mac" ? "macOS 15" : "Ubuntu 24.04"])).rows[0].id;
        devs.push(id);
        await q(`INSERT INTO agents (id, device_id, agent_uuid, version, last_check_in_at, facts) VALUES ($1,$2,$3,'1.3.37', now() - ($4 || ' minutes')::interval, $5)`, [uuid(), id, uuid(), String(minutes), JSON.stringify({ os: os === "mac" ? "macos" : os, ...facts })]);
        return id;
    };
    const win = await mk(A.site, "win", "windows");
    const lin = await mk(A.site, "lin", "linux");
    const mac = await mk(A.site, "mac", "mac");
    const off = await mk(A.site, "off", "windows", 90);
    const known = await mk(A.site, "known-pc", "windows", 0, { device: { network: [{ mac: "AA:BB:CC:00:00:01", ipv4: ["10.9.0.10"] }] } });
    const bScanner = await mk(B.site, "bscan", "windows");

    // the fake agent: answers every queued discovery job with what the scenario says
    let answer = null; // { out, mode }
    const seen = [];
    const handled = new Set();
    const finishJob = async (id, stdout, { stderr = "", status = "succeeded" } = {}) => {
        await q(`UPDATE jobs SET status=$2, finished_at=now() WHERE id=$1`, [id, status]);
        await q(`INSERT INTO job_results (job_id, exit_code, stdout, stderr) VALUES ($1,$2,$3,$4) ON CONFLICT (job_id) DO NOTHING`, [id, status === "succeeded" ? 0 : 1, stdout, stderr]);
    };
    const timer = setInterval(async () => {
        try {
            const rows = (await q(`SELECT j.id, j.payload FROM jobs j JOIN agents a ON a.id = j.agent_id WHERE j.status = 'queued' AND a.device_id = ANY($1::uuid[])`, [devs])).rows;
            for (const r of rows) {
                if (r.payload?.env?.RIQ_TOOL !== D.DISCOVERY_KIND || handled.has(r.id)) continue;
                handled.add(r.id); seen.push({ id: r.id, payload: r.payload });
                if (!answer || answer.mode === "never") continue;
                if (answer.mode === "fail") { await finishJob(r.id, "", { stderr: answer.stderr, status: "failed" }); continue; }
                await finishJob(r.id, answer.out);
            }
        } catch { /* next tick */ }
    }, 150);

    const get = (p, t = reader) => call(`/api/network-discovery${p}`, { token: t.token });
    const post = (p, body, t = ops) => call(`/api/network-discovery${p}`, { method: "POST", token: t.token, body });
    const scan = async (deviceId, ranges, t = ops) => { const r = await post("/scan", { deviceId, ranges }, t); return { status: r.status, body: await r.json().catch(() => null) }; };
    const waitRun = async (runId, t = ops) => { for (let i = 0; i < 60; i++) { const r = await (await get(`/runs/${runId}`, t)).json(); if (r && r.status !== "pending") return r; await sleep(250); } throw new Error("the scan never finished"); };
    const hosts = async (status = "all", t = ops, extra = "") => (await (await get(`/hosts?status=${status}&limit=200${extra}`, t)).json());
    const scanOut = (lines) => ["R 10.9.0.0/24", ...lines, "E 7"].join("\n");

    console.log("rights, scanners and refusals");
    await test("looking needs devices.read; scanning and ignoring also need devices.actions; no token is refused", async () => {
        assert.equal((await get("/hosts", nobody)).status, 403);
        assert.equal((await get("/hosts", reader)).status, 200);
        assert.equal((await get("/runs", reader)).status, 200);
        assert.equal((await post("/scan", { deviceId: win, ranges: [] }, reader)).status, 403);
        assert.equal((await post("/ignore", { ids: [uuid()], ignored: true }, reader)).status, 403);
        assert.equal((await get("/scanners", reader)).status, 403);
        assert.ok([401, 403].includes((await call("/api/network-discovery/hosts")).status));
    });
    await test("scanners are the online Windows and Linux devices; a limited person sees only their customers'", async () => {
        const all = (await (await get("/scanners", ops)).json()).items.map((x) => x.deviceId);
        for (const d of [win, lin, known, bScanner]) assert.ok(all.includes(d), d);
        for (const d of [mac, off]) assert.ok(!all.includes(d), "macOS and offline devices are not offered");
        const lim = (await (await get("/scanners", limited)).json()).items.map((x) => x.deviceId);
        assert.ok(lim.includes(win) && !lim.includes(bScanner));
    });
    await test("refused: a public range, a range too wide, odd text, macOS, an offline device, an unknown device, another customer's device", async () => {
        for (const bad of ["8.8.8.0/24", "10.0.0.0/8", "192.168.1.0/24; id", "0.0.0.0/0", "127.0.0.1/32"]) assert.equal((await scan(win, [bad])).status, 400, bad);
        assert.equal((await scan(win, ["10.9.0.0/24", "10.9.1.0/24", "10.9.2.0/24", "10.9.3.0/24", "10.9.4.0/24"])).status, 400);
        assert.equal((await scan(mac, [])).status, 400);
        assert.equal((await scan(off, [])).status, 409);
        assert.equal((await scan(uuid(), [])).status, 404);
        assert.equal((await scan(bScanner, [], limited)).status, 404);
        assert.equal((await post("/scan", { deviceId: "not-a-uuid" })).status, 400);
        assert.equal((await q(`SELECT count(*)::int AS n FROM jobs WHERE payload->'env'->>'RIQ_TOOL' = $1 AND agent_id IN (SELECT id FROM agents WHERE device_id = ANY($2::uuid[]))`, [D.DISCOVERY_KIND, [mac, off]])).rows[0].n, 0, "no job for a refused request");
    });

    console.log("a scan");
    let run1;
    await test("a scan is one fixed signed job per OS with only the ranges in the environment, and a second request to the same device while it waits joins it, a different device of the site scans alongside", async () => {
        answer = { mode: "never" };
        const r = await scan(win, ["10.9.0.77/24"]);
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.equal(r.body.alreadyRunning, false); assert.deepEqual(r.body.ranges, ["10.9.0.0/24"]);
        run1 = r.body;
        const job = (await q(`SELECT payload FROM jobs WHERE id = $1`, [run1.jobId])).rows[0].payload;
        assert.equal(job.language, "powershell"); assert.equal(job.scriptText, D.WINDOWS_DISCOVERY_SCRIPT);
        assert.deepEqual(job.env, { RIQ_TOOL: D.DISCOVERY_KIND, RIQ_RANGES: "10.9.0.0/24" });
        const again = await scan(win, []);
        assert.equal(again.body.alreadyRunning, true); assert.equal(again.body.runId, run1.runId, "a device does one scan at a time");
        // a different device of the same site scans at the same time, its own network
        const other = await scan(lin, []);
        assert.equal(other.body.alreadyRunning, false); assert.notEqual(other.body.runId, run1.runId);
        await finishJob(other.body.jobId, scanOut([])); await waitRun(other.body.runId);
        const pending = await (await get(`/runs/${run1.runId}`)).json();
        assert.equal(pending.status, "pending"); assert.equal(pending.scanner, `${tag}-win`);
    });
    await test("the answer is read back: hosts are remembered, managed devices recognised by MAC, address and name, kinds guessed", async () => {
        // the waiting job is finished by hand (the fake agent skipped it)
        await finishJob(run1.jobId, scanOut([
            "H 10.9.0.10 AA:BB:CC:00:00:01 pc-known.lan 135,445,3389",         // a managed device, by MAC
            "H 10.9.0.11 AA:BB:CC:00:00:02 printer-1 9100,515,80",             // a printer
            "H 10.9.0.12 - " + `${tag}-known-pc`.toLowerCase() + " 445",      // a managed device, by name
            "H 10.9.0.13 00:50:56:11:22:33 vm-7 -",                             // a virtual machine
            "H 10.9.0.14 AA:BB:CC:00:00:05 - 22,80",                            // unknown name, a Linux box
            "H 8.8.8.8 - - 80",                                                  // outside: dropped
        ]));
        const r = await waitRun(run1.runId);
        assert.equal(r.status, "succeeded", JSON.stringify(r)); assert.equal(r.hostsFound, 5); assert.equal(r.newHosts, 5); assert.equal(r.seconds, 7);
        const h = await hosts("all");
        assert.equal(h.total, 5);
        const by = Object.fromEntries(h.items.map((x) => [x.ip, x]));
        assert.equal(by["10.9.0.10"].deviceId, known, "recognised by MAC"); assert.equal(by["10.9.0.12"].deviceId, known, "recognised by name");
        assert.equal(by["10.9.0.11"].deviceId, null); assert.equal(by["10.9.0.11"].kind, "printer"); assert.deepEqual(by["10.9.0.11"].ports, [80, 515, 9100]);
        assert.equal(by["10.9.0.13"].vendor, "VMware"); assert.equal(by["10.9.0.13"].kind, "virtual"); assert.equal(by["10.9.0.14"].kind, "linux");
        assert.deepEqual(h.counts, { unmanaged: 3, managed: 2, ignored: 0, all: 5 });
        assert.ok(!by["8.8.8.8"]);
        assert.equal(by["10.9.0.11"].customer, `${tag} A`); assert.equal(by["10.9.0.11"].site, "A HQ");
    });
    await test("the default list is the unmanaged hosts; managed and all are filters; search finds by address, name, vendor and kind", async () => {
        const un = await hosts("unmanaged"); assert.deepEqual(un.items.map((x) => x.ip).sort(), ["10.9.0.11", "10.9.0.13", "10.9.0.14"]);
        const dflt = await (await get("/hosts")).json(); assert.equal(dflt.total, 3);
        assert.equal((await hosts("managed")).total, 2);
        for (const [term, ip] of [["printer", "10.9.0.11"], ["VMware", "10.9.0.13"], ["10.9.0.14", "10.9.0.14"], ["vm-7", "10.9.0.13"]]) assert.deepEqual((await hosts("all", ops, `&q=${encodeURIComponent(term)}`)).items.map((x) => x.ip), [ip], term);
        assert.equal((await hosts("all", ops, "&q=%25")).total, 0, "a percent sign is text, not a wildcard");
    });
    await test("a second scan updates the hosts instead of duplicating them, adds a MAC to a host first seen without one, and reports what is new", async () => {
        answer = { out: scanOut(["H 10.9.0.11 AA:BB:CC:00:00:02 printer-1 9100", "H 10.9.0.12 AA:BB:CC:00:00:09 - 445", "H 10.9.0.20 - - 80,443"]) };
        const r = await scan(lin, ["10.9.0.0/24"]);
        assert.equal(r.status, 200); assert.equal(r.body.alreadyRunning, false);
        const done = await waitRun(r.body.runId);
        assert.equal(done.status, "succeeded"); assert.equal(done.hostsFound, 3); assert.equal(done.newHosts, 1, "only 10.9.0.20 is new");
        const by = Object.fromEntries((await hosts("all")).items.map((x) => [x.ip, x]));
        assert.equal(by["10.9.0.11"].seenRuns, 2); assert.deepEqual(by["10.9.0.11"].ports, [9100]);
        assert.equal(by["10.9.0.20"].kind, "web");
        assert.equal((await hosts("all")).total, 6, "no duplicates");
        const lrun = (await q(`SELECT payload->>'language' AS language FROM jobs WHERE id = $1`, [r.body.jobId])).rows[0].language;
        assert.equal(lrun, "bash", "a Linux scanner gets the bash script");
        // a host first seen by address only, then with its MAC, is one row
        answer = { out: scanOut(["H 10.9.0.20 AA:BB:CC:00:00:20 web-20 80,443"]) };
        const r2 = await scan(win, ["10.9.0.0/24"]); await waitRun(r2.body.runId);
        const rows = (await q(`SELECT host_key, mac, hostname FROM discovered_hosts WHERE site_id = $1 AND ip = '10.9.0.20'`, [A.site])).rows;
        assert.equal(rows.length, 1); assert.equal(rows[0].host_key, "AA:BB:CC:00:00:20"); assert.equal(rows[0].hostname, "web-20");
    });
    await test("ignoring hides a host from the default list and unignoring brings it back; a managed host and a stranger's host cannot be changed", async () => {
        const un = (await hosts("unmanaged")).items;
        const target = un.find((x) => x.ip === "10.9.0.13");
        const r = await post("/ignore", { ids: [target.id], ignored: true });
        assert.equal(r.status, 200); assert.equal((await r.json()).changed, 1);
        assert.ok(!(await hosts("unmanaged")).items.some((x) => x.id === target.id));
        assert.equal((await hosts("ignored")).total, 1); assert.equal((await hosts("all")).counts.ignored, 1);
        await post("/ignore", { ids: [target.id], ignored: false });
        assert.ok((await hosts("unmanaged")).items.some((x) => x.id === target.id));
        assert.equal((await (await post("/ignore", { ids: [uuid()], ignored: true })).json()).changed, 0, "unknown ids change nothing");
        assert.equal((await post("/ignore", { ids: [], ignored: true })).status, 400);
        assert.equal((await post("/ignore", { ids: [target.id], ignored: "yes" })).status, 400);
    });

    await test("addresses that all answer with one MAC (a router, firewall or VPN answering for them) are not listed as hosts, and the scan says so; a few addresses on one MAC are kept, each by address", async () => {
        const vpn = Array.from({ length: 8 }, (_, i) => `H 10.9.0.${150 + i} 00:FF:86:AF:00:1D - -`);
        const multi = ["H 10.9.0.60 AA:BB:CC:00:00:60 nas 445", "H 10.9.0.61 AA:BB:CC:00:00:60 nas-alias -", "H 10.9.0.62 AA:BB:CC:00:00:60 - -"];
        // an earlier scan had merged the VPN addresses into one row under the MAC: it is cleaned away
        await q(`INSERT INTO discovered_hosts (site_id, host_key, ip, mac, kind) VALUES ($1,'00:FF:86:AF:00:1D','10.9.0.157','00:FF:86:AF:00:1D','unknown')`, [A.site]);
        const before = (await hosts("all")).total;
        answer = { out: scanOut([...vpn, ...multi, "H 10.9.0.70 AA:BB:CC:00:00:70 normal 22"]) };
        const r = await scan(lin, ["10.9.0.0/24"]); const done = await waitRun(r.body.runId);
        assert.equal(done.status, "succeeded"); assert.equal(done.hostsFound, 4, "8 shared-MAC addresses left out of the 12 reported");
        assert.match(done.message, /8 addresses all answered with the same MAC address \(00:FF:86:AF:00:1D\)/); assert.match(done.message, /router, firewall or VPN/);
        const all = (await hosts("all")).items;
        assert.ok(!all.some((x) => x.mac === "00:FF:86:AF:00:1D" || /^10\.9\.0\.15\d$/.test(x.ip)), "the shared-MAC addresses are not hosts");
        assert.deepEqual(all.filter((x) => x.mac === "AA:BB:CC:00:00:60").map((x) => x.ip).sort(), ["10.9.0.60", "10.9.0.61", "10.9.0.62"], "three on one MAC are kept, one row per address");
        assert.ok(all.some((x) => x.ip === "10.9.0.70"));
        assert.equal((await q(`SELECT count(*)::int AS n FROM discovered_hosts WHERE site_id = $1 AND host_key = '00:FF:86:AF:00:1D'`, [A.site])).rows[0].n, 0, "the merged row from before is gone");
        assert.equal(all.length, before - 1 + 4, "rows: the cleaned one removed, the four kept added");
        // a clean scan has no note
        answer = { out: scanOut(["H 10.9.0.70 AA:BB:CC:00:00:70 normal 22"]) };
        const r2 = await scan(lin, ["10.9.0.0/24"]); assert.equal((await waitRun(r2.body.runId)).message, null);
    });

    await test("a whole site at once: every online device of it scans its own network, the ones that cannot are skipped with a reason, and a host that several of them found is one host", async () => {
        const out = (mac) => scanOut([`H 10.9.0.200 ${mac ? "AA:BB:CC:09:02:00" : "-"} printer-200 9100`, "H 10.9.0.201 AA:BB:CC:09:02:01 - 22"]);
        answer = { out: out(true) };
        const r = await post("/scan-many", { deviceIds: [win, lin, known, mac, off, uuid()], ranges: ["10.9.0.0/24"] });
        assert.equal(r.status, 200); const b = await r.json();
        assert.equal(b.started, 3, JSON.stringify(b)); assert.equal(b.skipped, 3);
        const why = Object.fromEntries(b.results.filter((x) => x.status === "skipped").map((x) => [x.deviceId, x.reason]));
        assert.match(why[mac], /macOS/); assert.match(why[off], /offline/);
        const runs = b.results.filter((x) => x.status === "started").map((x) => x.runId);
        assert.equal(new Set(runs).size, 3, "one run per device");
        for (const id of runs) assert.equal((await waitRun(id)).status, "succeeded");
        const rows = async (ip) => (await q(`SELECT count(*)::int AS n FROM discovered_hosts WHERE site_id = $1 AND ip = $2`, [A.site, ip])).rows[0].n;
        assert.equal(await rows("10.9.0.200"), 1, "three devices found it, it is one host"); assert.equal(await rows("10.9.0.201"), 1);
        // the same address seen by another device without its MAC (routed) is still the same host
        answer = { out: out(false) };
        const b2 = await (await post("/scan-many", { deviceIds: [win, lin] })).json();
        for (const x of b2.results.filter((y) => y.status === "started")) await waitRun(x.runId);
        assert.equal(await rows("10.9.0.200"), 1, "seen without a MAC, still one host");
        assert.equal((await q(`SELECT mac FROM discovered_hosts WHERE site_id = $1 AND ip = '10.9.0.200'`, [A.site])).rows[0].mac, "AA:BB:CC:09:02:00", "and its MAC is kept");
        const all = (await hosts("all")).items.filter((x) => x.ip === "10.9.0.200"); assert.equal(all.length, 1);
    });
    await test("scanning from several devices: a request for none, too many or a bad range is refused before anything starts; another customer's devices are skipped for a limited person", async () => {
        const jobs = async () => (await q(`SELECT count(*)::int AS n FROM jobs WHERE payload->'env'->>'RIQ_TOOL' = $1`, [D.DISCOVERY_KIND])).rows[0].n;
        const before = await jobs();
        assert.equal((await post("/scan-many", { deviceIds: [] })).status, 400);
        assert.equal((await post("/scan-many", { deviceIds: Array.from({ length: 26 }, () => uuid()) })).status, 400);
        assert.equal((await post("/scan-many", { deviceIds: [win], ranges: ["8.8.8.0/24"] })).status, 400);
        assert.equal((await post("/scan-many", { deviceIds: ["nope"] })).status, 400);
        assert.equal((await post("/scan-many", { deviceIds: [win] }, reader)).status, 403);
        assert.equal(await jobs(), before, "nothing was started");
        const lim = await (await post("/scan-many", { deviceIds: [bScanner] }, limited)).json();
        assert.equal(lim.started, 0); assert.equal(lim.skipped, 1); assert.match(lim.results[0].reason, /not found/i);
    });

    await test("a host's name comes with where it came from (DNS, NetBIOS, mDNS); a later scan that finds no name keeps the name and its source; a script that says nothing about the source is fine", async () => {
        answer = { out: scanOut(["H 10.9.0.150 AA:BB:CC:09:03:50 filesrv 445 nbns", "H 10.9.0.151 AA:BB:CC:09:03:51 camera-3.local 554 mdns", "H 10.9.0.152 AA:BB:CC:09:03:52 dns-host.lan 22 dns", "H 10.9.0.153 AA:BB:CC:09:03:53 old-script 22"]) };
        const r = await scan(win, ["10.9.0.0/24"]); await waitRun(r.body.runId);
        const by = Object.fromEntries((await hosts("all")).items.map((x) => [x.ip, x]));
        assert.deepEqual([by["10.9.0.150"].hostname, by["10.9.0.150"].nameSource, by["10.9.0.150"].nameSourceText], ["filesrv", "nbns", "NetBIOS"]);
        assert.deepEqual([by["10.9.0.151"].nameSource, by["10.9.0.151"].nameSourceText], ["mdns", "mDNS (Bonjour)"]);
        assert.deepEqual([by["10.9.0.152"].nameSource, by["10.9.0.152"].nameSourceText], ["dns", "DNS"]);
        assert.deepEqual([by["10.9.0.153"].hostname, by["10.9.0.153"].nameSource, by["10.9.0.153"].nameSourceText], ["old-script", null, null]);
        // the host does not answer the name question this time: the name and where it came from stay
        answer = { out: scanOut(["H 10.9.0.150 AA:BB:CC:09:03:50 - 445 -"]) };
        const r2 = await scan(win, ["10.9.0.0/24"]); await waitRun(r2.body.runId);
        const again = (await hosts("all")).items.find((x) => x.ip === "10.9.0.150");
        assert.deepEqual([again.hostname, again.nameSource], ["filesrv", "nbns"]);
    });

    console.log("failures");
    await test("a failed job and an answer that is not a scan are failed runs with the reason, and the hosts are left as they were", async () => {
        const before = (await hosts("all")).total;
        answer = { mode: "fail", stderr: "This device has no private network address to scan from." };
        let r = await scan(win, []); let done = await waitRun(r.body.runId);
        assert.equal(done.status, "failed"); assert.match(done.message, /no private network address/);
        answer = { out: "<html>proxy login</html>" };
        r = await scan(win, []); done = await waitRun(r.body.runId);
        assert.equal(done.status, "failed"); assert.match(done.message, /not a network scan/);
        assert.equal((await hosts("all")).total, before);
        answer = { out: scanOut([]) };
        r = await scan(win, []); done = await waitRun(r.body.runId);
        assert.equal(done.status, "succeeded"); assert.equal(done.hostsFound, 0, "an empty network is a finished scan");
    });

    console.log("the customer limit and the audit trail");
    await test("a limited person sees only their customers' hosts, runs and scans, and cannot ignore another customer's hosts", async () => {
        answer = { out: ["R 10.8.0.0/24", "H 10.8.0.5 AA:BB:CC:08:00:05 b-printer 9100", "E 2"].join("\n") };
        const r = await scan(bScanner, ["10.8.0.0/24"], ops); await waitRun(r.body.runId);
        const all = await hosts("all", ops);
        assert.ok(all.items.some((x) => x.ip === "10.8.0.5") && all.items.some((x) => x.ip === "10.9.0.11"));
        const lim = await hosts("all", limited);
        assert.ok(lim.items.length > 0 && lim.items.every((x) => x.clientId === A.id), "only customer A");
        const bHost = all.items.find((x) => x.ip === "10.8.0.5");
        assert.equal((await (await post("/ignore", { ids: [bHost.id], ignored: true }, limited)).json()).changed, 0);
        assert.equal((await get(`/runs/${r.body.runId}`, limited)).status, 404);
        const runsLim = (await (await get("/runs", limited)).json()).items;
        assert.ok(runsLim.length > 0 && runsLim.every((x) => x.customer === `${tag} A`));
    });
    await test("scans and ignores are in the audit trail, without any host data", async () => {
        const ev = (await q(`SELECT action, outcome, details FROM audit_events WHERE action LIKE 'network.discovery.%' ORDER BY created_at`)).rows;
        const acts = ev.map((e) => e.action);
        for (const a of ["network.discovery.scan", "network.discovery.ignore", "network.discovery.unignore"]) assert.ok(acts.includes(a), `${a} in ${acts.join(",")}`);
        assert.ok(ev.some((e) => e.action === "network.discovery.scan" && e.outcome === "failure"), "a refused scan is recorded too");
        assert.ok(!JSON.stringify(ev).includes("10.9.0.11"), "no host addresses in the audit trail");
    });

    clearInterval(timer);
    await q(`DELETE FROM discovered_hosts WHERE site_id = ANY($1::uuid[])`, [[A.site, B.site]]);
    await q(`DELETE FROM network_discovery_runs WHERE site_id = ANY($1::uuid[])`, [[A.site, B.site]]);
    await q(`DELETE FROM agents WHERE device_id = ANY($1::uuid[])`, [devs]).catch(() => { });
    await q(`DELETE FROM devices WHERE id = ANY($1::uuid[])`, [devs]).catch(() => { });
    await cleanup();
    finish();
}
main().catch((e) => { console.error(e); process.exit(1); });
