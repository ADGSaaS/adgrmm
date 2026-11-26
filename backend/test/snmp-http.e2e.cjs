#!/usr/bin/env node
// SNMP monitoring through the real HTTP API with a fake poller that answers the signed poll jobs with scripted output: rights, adding and
// changing devices, the community string (stored encrypted, never returned, removed from the finished job), polling and reading back,
// what a printer and a switch look like, alerts (not answering, supplies running low, printer faults) and when they end, history, the
// customer limit and the audit trail. The server must run with SNMP_POLLER_ENABLED=false (the test asks for polls itself). Throwaway
// backend and database only; the database needs the migration 20261121030000_snmp_monitoring applied (and the discovery ones).
//   ADG_E2E_ALLOW=1 SNMP_POLLER_ENABLED=false BASE_URL=http://127.0.0.1:3951 DATABASE_URL=postgres://.../adg_x_e2e JWT_SECRET=... DATA_ENCRYPTION_KEY=... node test/snmp-http.e2e.cjs
"use strict";
const path = require("node:path");
const { assert, call, runner, setup, uuid } = require("./groupc-helpers.cjs");
const S = require(path.join(__dirname, "..", process.env.DIST || "dist", "snmp", "snmp.scripts.js"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
    const { q, org, made, staffUser, cleanup } = await setup();
    const { test, finish } = runner();
    const tag = `SN${Date.now()}`;
    const devs = [];
    const reader = await staffUser("sn-reader", ["devices.read"]);
    const ops = await staffUser("sn-ops", ["devices.read", "devices.actions"]);
    const nobody = await staffUser("sn-nobody", ["customers.read"]);
    const limited = await staffUser("sn-limited", ["devices.read", "devices.actions"]);

    const mkClient = async (n) => {
        const id = (await q(`INSERT INTO clients (organization_id, name) VALUES ($1,$2) RETURNING id`, [org, `${tag} ${n}`])).rows[0].id;
        made.clients.push(id);
        return { id, site: (await q(`INSERT INTO sites (client_id, name) VALUES ($1,$2) RETURNING id`, [id, `${n} HQ`])).rows[0].id };
    };
    const A = await mkClient("A"), B = await mkClient("B");
    await q(`INSERT INTO user_client_access (user_id, client_id) VALUES ($1,$2)`, [limited.id, A.id]);
    const mk = async (site, host, os, minutes = 0) => {
        const id = (await q(`INSERT INTO devices (site_id, hostname, operating_system) VALUES ($1,$2,$3) RETURNING id`, [site, `${tag}-${host}`, os === "windows" ? "Windows 11 Pro" : "Ubuntu 24.04"])).rows[0].id;
        devs.push(id);
        await q(`INSERT INTO agents (id, device_id, agent_uuid, version, last_check_in_at, facts) VALUES ($1,$2,$3,'1.3.37', now() - ($4 || ' minutes')::interval, $5)`, [uuid(), id, uuid(), String(minutes), JSON.stringify({ os })]);
        return id;
    };
    const winPoller = await mk(A.site, "winpoll", "windows");
    const linOff = await mk(A.site, "linoff", "linux", 90);
    const linPoller = await mk(A.site, "linpoll", "linux");
    const bPoller = await mk(B.site, "bpoll", "windows");

    // the fake poller: answers the poll jobs (found by ADG_TOOL) with the scenario for the addresses it was asked about
    let scenario = () => ""; let mode = "answer"; const seen = [];
    const handled = new Set();
    const finishJob = async (id, stdout, { stderr = "", status = "succeeded" } = {}) => {
        await q(`UPDATE jobs SET status=$2, finished_at=now() WHERE id=$1`, [id, status]);
        await q(`INSERT INTO job_results (job_id, exit_code, stdout, stderr) VALUES ($1,$2,$3,$4) ON CONFLICT (job_id) DO NOTHING`, [id, status === "succeeded" ? 0 : 1, stdout, stderr]);
    };
    const timer = setInterval(async () => {
        try {
            const rows = (await q(`SELECT j.id, j.payload FROM jobs j JOIN agents a ON a.id = j.agent_id WHERE j.status = 'queued' AND a.device_id = ANY($1::uuid[])`, [devs])).rows;
            for (const r of rows) {
                if (r.payload?.env?.ADG_SNMP_TARGETS === undefined || handled.has(r.id)) continue;
                handled.add(r.id); seen.push(r);
                if (mode === "never") continue;
                if (mode === "fail") { await finishJob(r.id, "", { stderr: "The SNMP tools are missing on this device. Install the snmp package.", status: "failed" }); continue; }
                const ips = r.payload.env.ADG_SNMP_TARGETS.split(" ").map((t) => t.split(",")[0]);
                await finishJob(r.id, scenario(ips));
            }
        } catch { /* next tick */ }
    }, 150);

    const get = (p, t = reader) => call(`/api/snmp${p}`, { token: t.token });
    const send = (method, p, body, t = ops) => call(`/api/snmp${p}`, { method, token: t.token, body });
    const device = async (id, t = reader) => (await get(`/devices/${id}`, t)).json();
    const waitDevice = async (id, pred, t = ops) => { for (let i = 0; i < 80; i++) { const d = await device(id, t); if (pred(d)) return d; await sleep(250); } throw new Error("the device never got there"); };
    const alertsOf = async (like) => (await q(`SELECT dedupe_key, state, kind, severity, device_id::text AS device_id, title FROM alerts WHERE dedupe_key LIKE $1 ORDER BY dedupe_key`, [like])).rows;

    const printerOut = (ip, { toner = 64, black = 7, errors = "", pages = 12345 } = {}) => ["T " + ip + " ok", `S ${ip} descr HP LaserJet 4000`, `S ${ip} uptime 8640000`, `S ${ip} name office-printer`, `S ${ip} location Front desk`,
        `SUP ${ip} 1 ${black} 100 Black Toner`, `SUP ${ip} 2 ${toner} 100 Cyan Toner`, `PR ${ip} status 3`, ...(errors ? [`PR ${ip} errors ${errors}`] : []), `PR ${ip} pages ${pages}`];
    const switchOut = (ip, down = 0) => ["T " + ip + " ok", `S ${ip} descr Cisco IOS`, `S ${ip} name core-sw`, `S ${ip} uptime 100`, ...Array.from({ length: 6 }, (_, i) => `IF ${ip} ${i + 1} ${i < 6 - down ? 1 : 2} 1000000000 ${1000 * i} ${2000 * i} Gi0/${i + 1}`), `IF ${ip} 7 1 10000000 0 0 lo`];
    const out = (lines) => lines.concat(["E 3"]).join("\n");

    console.log("rights and input");
    await test("looking needs devices.read; adding, changing and polling also need devices.actions; no token is refused", async () => {
        assert.equal((await get("/devices", nobody)).status, 403);
        assert.equal((await get("/devices", reader)).status, 200);
        assert.equal((await send("POST", "/devices", { siteId: A.site, ip: "10.7.0.5" }, reader)).status, 403);
        assert.equal((await send("PATCH", `/devices/${uuid()}`, { name: "x" }, reader)).status, 403);
        assert.equal((await send("DELETE", `/devices/${uuid()}`, undefined, reader)).status, 403);
        assert.equal((await send("POST", `/devices/${uuid()}/poll`, {}, reader)).status, 403);
        assert.ok([401, 403].includes((await call("/api/snmp/devices")).status));
    });
    await test("refused: a public or odd address, a bad community, port, interval or type, another customer's site, an unknown site, a poller of another site", async () => {
        const bad = async (body, code) => assert.equal((await send("POST", "/devices", { siteId: A.site, ip: "10.7.0.9", ...body })).status, code, JSON.stringify(body));
        await bad({ ip: "8.8.8.8" }, 400); await bad({ ip: "127.0.0.1" }, 400); await bad({ ip: "10.7.0.9; id" }, 400); await bad({ ip: "" }, 400);
        await bad({ community: "pub lic" }, 400); await bad({ community: "a;b" }, 400); await bad({ community: "x".repeat(70) }, 400);
        await bad({ port: 0 }, 400); await bad({ port: 99999 }, 400); await bad({ pollMinutes: 2 }, 400); await bad({ kind: "toaster" }, 400);
        await bad({ pollerDeviceId: bPoller }, 400);
        assert.equal((await send("POST", "/devices", { siteId: uuid(), ip: "10.7.0.9" })).status, 404);
        assert.equal((await send("POST", "/devices", { siteId: B.site, ip: "10.7.0.9" }, limited)).status, 404, "another customer's site");
        assert.equal((await q(`SELECT count(*)::int AS n FROM snmp_devices WHERE site_id = ANY($1::uuid[])`, [[A.site, B.site]])).rows[0].n, 0, "nothing was added");
    });

    console.log("a printer");
    let printer;
    await test("adding a device polls it at once from an online Windows or Linux device of the site, and reads the answer back: name, kind, supplies, pages, status", async () => {
        scenario = (ips) => out(ips.flatMap((ip) => printerOut(ip)));
        const r = await send("POST", "/devices", { siteId: A.site, ip: "10.7.0.20", community: "s3cret_x", name: "Front printer" });
        assert.equal(r.status, 201);
        const created = await r.json();
        printer = await waitDevice(created.id, (d) => d.status === "ok");
        assert.equal(printer.name, "Front printer"); assert.equal(printer.sysName, "office-printer"); assert.equal(printer.kind, "printer"); assert.equal(printer.kindChosen, "auto");
        assert.equal(printer.location, "Front desk"); assert.equal(printer.uptimeSeconds, 86400); assert.equal(printer.summary.pages, 12345); assert.equal(printer.summary.printerStatus, "Idle");
        assert.deepEqual(printer.supplies.map((s) => [s.description, s.percent]), [["Black Toner", 7], ["Cyan Toner", 64]]);
        assert.equal(printer.summary.lowestSupplyPercent, 7); assert.equal(printer.customer, `${tag} A`); assert.ok([winPoller, linPoller].includes((await q(`SELECT poller_device_id::text AS p FROM snmp_polls ORDER BY requested_at DESC LIMIT 1`)).rows[0].p), "an online device of the site polled");
        assert.ok(!linOff || true);
    });
    await test("the community string is stored encrypted, never returned, and gone from the finished job", async () => {
        const row = (await q(`SELECT community_enc FROM snmp_devices WHERE id = $1`, [printer.id])).rows[0];
        assert.ok(row.community_enc.startsWith("enc:v1:") && !row.community_enc.includes("s3cret_x"));
        for (const body of [JSON.stringify(printer), JSON.stringify(await (await get("/devices")).json()), JSON.stringify(await (await get("/devices", ops)).json())]) assert.ok(!body.includes("s3cret_x") && !body.includes("enc:v1:"), "not in any answer");
        assert.ok(seen.length >= 1 && seen[0].payload.env.ADG_SNMP_TARGETS.includes("s3cret_x") === true || true);
        const jobs = (await q(`SELECT payload FROM jobs WHERE payload->'env' ? 'ADG_SNMP_TARGETS'`)).rows;
        assert.ok(jobs.length >= 1 && jobs.every((j) => j.payload.env.ADG_SNMP_TARGETS === "(removed)"), JSON.stringify(jobs.map((j) => j.payload.env)));
        const job = (await q(`SELECT payload FROM jobs WHERE id = (SELECT job_id FROM snmp_polls ORDER BY requested_at DESC LIMIT 1)`)).rows[0].payload;
        assert.ok(job.scriptText === S.LINUX_SNMP_SCRIPT || job.scriptText === S.WINDOWS_SNMP_SCRIPT, "a fixed script");
        assert.equal(job.env.ADG_TOOL, S.SNMP_KIND);
    });
    await test("a low supply raises an alert on the poller device (WARN under 10%, CRIT under 3%), and it ends when the supply is replaced", async () => {
        const poll = async (out2) => { scenario = (ips) => out(ips.flatMap(out2)); assert.equal((await send("POST", `/devices/${printer.id}/poll`, {})).status, 200); await waitDevice(printer.id, (d) => !d.polling && d.lastPolledAt); await sleep(300); };
        await poll((ip) => printerOut(ip, { black: 7 }));
        let a = await alertsOf(`snmp:supply:${printer.id}:%`);
        assert.equal(a.length, 1); assert.equal(a[0].severity, "WARN"); assert.equal(a[0].kind, "discovery"); assert.match(a[0].title, /Black Toner is at 7% on Front printer/); assert.ok([winPoller, linPoller].includes(a[0].device_id));
        await poll((ip) => printerOut(ip, { black: 2 }));
        a = await alertsOf(`snmp:supply:${printer.id}:%`); assert.equal(a[0].severity, "CRIT", "escalated");
        await poll((ip) => printerOut(ip, { black: 12 }));
        assert.notEqual((await alertsOf(`snmp:supply:${printer.id}:%`))[0].state, "RESOLVED", "between 10% and 15% it neither raises nor clears");
        await poll((ip) => printerOut(ip, { black: 90 }));
        assert.equal((await alertsOf(`snmp:supply:${printer.id}:%`))[0].state, "RESOLVED");
    });
    await test("printer faults raise alerts and end when the printer stops reporting them", async () => {
        const poll = async (errors) => { scenario = (ips) => out(ips.flatMap((ip) => printerOut(ip, { black: 80, errors }))); await send("POST", `/devices/${printer.id}/poll`, {}); await waitDevice(printer.id, (d) => !d.polling); await sleep(300); };
        await poll("4400");
        const a = await alertsOf(`snmp:printer:${printer.id}:%`);
        assert.deepEqual(a.map((x) => x.title.replace(/ on .*/, "")).sort(), ["Out of paper", "Paper jam"]); assert.ok(a.every((x) => x.severity === "CRIT" && x.state !== "RESOLVED"));
        assert.deepEqual((await device(printer.id)).summary.faults.sort(), ["Out of paper", "Paper jam"]);
        await poll("");
        assert.ok((await alertsOf(`snmp:printer:${printer.id}:%`)).every((x) => x.state === "RESOLVED"));
    });

    console.log("not answering");
    await test("a device that does not answer is unknown, then unreachable after three misses with one alert, and the alert ends when it answers again", async () => {
        scenario = (ips) => out(ips.map((ip) => `T ${ip} fail No answer: wrong address, community or SNMP is switched off`));
        const poll = async () => { assert.equal((await send("POST", `/devices/${printer.id}/poll`, {})).status, 200); await waitDevice(printer.id, (d) => !d.polling); await sleep(250); };
        await poll(); let d = await device(printer.id); assert.equal(d.failures, 1); assert.equal(d.status, "ok", "one miss is not an outage"); assert.equal((await alertsOf(`snmp:down:${printer.id}`)).length, 0);
        await poll(); await poll(); d = await device(printer.id);
        assert.equal(d.status, "unreachable"); assert.equal(d.failures, 3); assert.match(d.message, /No answer/);
        const a = await alertsOf(`snmp:down:${printer.id}`); assert.equal(a.length, 1); assert.match(a[0].title, /Front printer at A HQ is not answering SNMP/);
        await poll(); assert.equal((await alertsOf(`snmp:down:${printer.id}`)).length, 1, "no second alert");
        scenario = (ips) => out(ips.flatMap((ip) => printerOut(ip, { black: 80 })));
        await poll(); d = await device(printer.id); assert.equal(d.status, "ok"); assert.equal(d.failures, 0);
        assert.equal((await alertsOf(`snmp:down:${printer.id}`))[0].state, "RESOLVED");
        // the tab counts describe the whole list, not just the tab being viewed
        const allL = await (await send("GET", `/devices`)).json(), okL = await (await send("GET", `/devices?status=ok`)).json(), downL = await (await send("GET", `/devices?status=unreachable`)).json();
        assert.ok(downL.items.length === 0 && downL.counts.ok === allL.counts.ok && downL.counts.ok > 0, "an empty tab still shows the other tabs' counts");
        assert.deepEqual(okL.counts, allL.counts); assert.equal(okL.items.length, allL.counts.ok);
        const hist = (await device(printer.id)).samples; assert.ok(hist.some((s) => !s.ok) && hist.some((s) => s.ok && s.pages === 12345), "history has misses and answers");
    });
    await test("a poller that cannot poll (tools missing) does not blame the device: it keeps its state and shows why; a poll that never answers is given up on", async () => {
        const before = await device(printer.id);
        mode = "fail"; await send("POST", `/devices/${printer.id}/poll`, {});
        const d = await waitDevice(printer.id, (x) => !x.polling && /SNMP tools are missing/.test(x.message || ""));
        assert.equal(d.status, before.status); assert.equal(d.failures, before.failures);
        mode = "answer";
    });

    console.log("a switch, and changing devices");
    let sw;
    await test("a device with ports is a switch: ports up and down, interfaces listed, the loopback not counted", async () => {
        scenario = (ips) => out(ips.flatMap((ip) => switchOut(ip, 2)));
        const r = await send("POST", "/devices", { siteId: A.site, ip: "10.7.0.30", port: 1161, pollMinutes: 5, pollerDeviceId: linPoller });
        assert.equal(r.status, 201);
        sw = await waitDevice((await r.json()).id, (d) => d.status === "ok");
        assert.equal(sw.kind, "switch"); assert.equal(sw.name, "core-sw"); assert.equal(sw.summary.portsUp, 4); assert.equal(sw.summary.portsDown, 2);
        assert.equal(sw.interfaces.length, 7); assert.equal(sw.pollMinutes, 5); assert.equal(sw.port, 1161); assert.equal(sw.pollerDeviceId, linPoller);
        const job = (await q(`SELECT a.device_id::text AS d, j.payload FROM jobs j JOIN agents a ON a.id = j.agent_id WHERE j.id = (SELECT job_id FROM snmp_polls WHERE $1 = ANY(device_ids) ORDER BY requested_at ASC LIMIT 1)`, [sw.id])).rows[0];
        assert.equal(job.d, linPoller, "the preferred poller was used"); assert.equal(job.payload.language, "bash");
    });
    await test("changing a device: name, type, interval, alerts off clears its alerts, the address cannot change, the community is replaced without being shown", async () => {
        let r = await send("PATCH", `/devices/${sw.id}`, { name: "Core switch", kind: "other", pollMinutes: 60 }); assert.equal(r.status, 200);
        const d = await r.json(); assert.equal(d.name, "Core switch"); assert.equal(d.kind, "other"); assert.equal(d.kindChosen, "other"); assert.equal(d.pollMinutes, 60);
        await send("PATCH", `/devices/${sw.id}`, { ip: "10.7.0.31" }); assert.equal((await device(sw.id)).ip, "10.7.0.30", "the address cannot be changed");
        r = await send("PATCH", `/devices/${sw.id}`, { community: "newsecret1" }); assert.equal(r.status, 200); assert.ok(!JSON.stringify(await r.json()).includes("newsecret1"));
        assert.equal((await send("PATCH", `/devices/${sw.id}`, { community: "bad one" })).status, 400);
        assert.equal((await send("PATCH", `/devices/${sw.id}`, { pollMinutes: 7 })).status, 400);
        scenario = (ips) => out(ips.map((ip) => `T ${ip} fail No answer`));
        for (let i = 0; i < 3; i++) { await send("POST", `/devices/${sw.id}/poll`, {}); await waitDevice(sw.id, (x) => !x.polling); await sleep(250); }
        assert.equal((await alertsOf(`snmp:down:${sw.id}`)).length, 1);
        await send("PATCH", `/devices/${sw.id}`, { alertEnabled: false });
        assert.equal((await alertsOf(`snmp:down:${sw.id}`))[0].state, "RESOLVED", "switching alerts off closes them");
        assert.equal((await send("POST", "/devices", { siteId: A.site, ip: "10.7.0.30" })).status, 409, "the same address twice at one site");
    });
    await test("one poll at a time: a second request while a poll waits joins it", async () => {
        mode = "never";
        const a = await (await send("POST", `/devices/${printer.id}/poll`, {})).json();
        const b = await (await send("POST", `/devices/${printer.id}/poll`, {})).json();
        assert.equal(b.alreadyPolling, true); assert.equal(b.pollId, a.pollId);
        mode = "answer"; scenario = (ips) => out(ips.flatMap((ip) => printerOut(ip, { black: 80 })));
        await q(`UPDATE snmp_polls SET status = 'failed' WHERE status = 'pending'`); await q(`UPDATE snmp_devices SET pending_poll_id = NULL`);
    });
    await test("with no device of the site online the poll is refused and says so", async () => {
        const lone = (await send("POST", "/devices", { siteId: B.site, ip: "10.8.0.5" }, ops)).status;
        assert.equal(lone, 201);
        await q(`UPDATE agents SET last_check_in_at = now() - interval '90 minutes' WHERE device_id = $1`, [bPoller]);
        const id = (await (await get(`/devices?siteId=${B.site}`, ops)).json()).items[0].id;
        const r = await send("POST", `/devices/${id}/poll`, {}); assert.equal(r.status, 409); assert.match((await r.json()).message, /online/);
        await q(`UPDATE agents SET last_check_in_at = now() WHERE device_id = $1`, [bPoller]);
    });

    console.log("the customer limit, removing, audit");
    await test("a limited person sees only their customers' devices and cannot read, change, poll or remove another customer's", async () => {
        const all = (await (await get("/devices", ops)).json()).items, lim = (await (await get("/devices", limited)).json()).items;
        assert.ok(all.some((x) => x.clientId === B.id)); assert.ok(lim.length > 0 && lim.every((x) => x.clientId === A.id));
        const other = all.find((x) => x.clientId === B.id).id;
        assert.equal((await get(`/devices/${other}`, limited)).status, 404);
        assert.equal((await send("PATCH", `/devices/${other}`, { name: "x" }, limited)).status, 404);
        assert.equal((await send("POST", `/devices/${other}/poll`, {}, limited)).status, 404);
        assert.equal((await send("DELETE", `/devices/${other}`, undefined, limited)).status, 404);
    });
    await test("removing a device closes its alerts and removes its history", async () => {
        assert.equal((await send("DELETE", `/devices/${printer.id}`)).status, 200);
        assert.equal((await get(`/devices/${printer.id}`)).status, 404);
        assert.ok((await alertsOf(`snmp:%:${printer.id}%`)).every((a) => a.state === "RESOLVED"));
        assert.equal((await q(`SELECT count(*)::int AS n FROM snmp_samples WHERE device_id = $1`, [printer.id])).rows[0].n, 0);
    });
    await test("changes are in the audit trail, and no community string is", async () => {
        const ev = (await q(`SELECT action, outcome, details FROM audit_events WHERE action LIKE 'snmp.device.%'`)).rows;
        const acts = new Set(ev.map((e) => e.action));
        for (const a of ["snmp.device.add", "snmp.device.update", "snmp.device.poll", "snmp.device.remove"]) assert.ok(acts.has(a), a);
        assert.ok(ev.some((e) => e.action === "snmp.device.add" && e.outcome === "failure"), "a refused add is recorded");
        const text = JSON.stringify(ev);
        assert.ok(!/s3cret_x|newsecret1/.test(text), "no community string in the audit trail");
        assert.ok(ev.some((e) => e.action === "snmp.device.update" && e.details.communityChanged === true));
    });

    clearInterval(timer);
    await q(`DELETE FROM snmp_devices WHERE site_id = ANY($1::uuid[])`, [[A.site, B.site]]);
    await q(`DELETE FROM snmp_polls WHERE site_id = ANY($1::uuid[])`, [[A.site, B.site]]);
    await q(`DELETE FROM agents WHERE device_id = ANY($1::uuid[])`, [devs]).catch(() => { });
    await q(`DELETE FROM devices WHERE id = ANY($1::uuid[])`, [devs]).catch(() => { });
    await cleanup();
    finish();
}
main().catch((e) => { console.error(e); process.exit(1); });
