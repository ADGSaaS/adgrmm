#!/usr/bin/env node
// The Tools menu through the real HTTP API: scopes (all, customer, site, system, online only) and what they reach, the customer limit, the
// bulk command, bulk script, bulk patch and recover-agents tools (each handed to the bulk engine in groups of 500 and kept as batches), the
// server maintenance clean-up with real old rows, and clearing the cache.
//
//   RIQ_E2E_ALLOW=1 BASE_URL=http://127.0.0.1:3977 DATABASE_URL=postgres://.../riq_tools_e2e JWT_SECRET=... node test/tools-http.e2e.cjs
"use strict";
const path = require("node:path");
const { assert, call, runner, setup, uuid } = require("./groupc-helpers.cjs");

const DIST = path.join(__dirname, "..", process.env.DIST || "dist");
const R = require(path.join(DIST, "bulk", "recover-agent.scripts.js"));

async function main() {
    const { q, org, made, staffUser, cleanup } = await setup();
    const { test, finish } = runner();
    const tag = `TL${Date.now()}`;

    const ops = await staffUser("tl-ops", ["devices.read", "devices.actions", "automation.run", "automation.read", "settings.write"]);
    const reader = await staffUser("tl-reader", ["devices.read"]);
    const limited = await staffUser("tl-limited", ["devices.read", "devices.actions", "automation.run"]);

    const mkClient = async (n) => {
        const id = (await q(`INSERT INTO clients (organization_id, name) VALUES ($1,$2) RETURNING id`, [org, `${tag} ${n}`])).rows[0].id;
        made.clients.push(id);
        const site = (await q(`INSERT INTO sites (client_id, name) VALUES ($1,$2) RETURNING id`, [id, `${n} HQ`])).rows[0].id;
        const site2 = (await q(`INSERT INTO sites (client_id, name) VALUES ($1,$2) RETURNING id`, [id, `${n} Branch`])).rows[0].id;
        return { id, site, site2 };
    };
    const A = await mkClient("Alpha");
    const B = await mkClient("Bravo");
    const C = await mkClient("Charlie");
    await q(`INSERT INTO user_client_access (user_id, client_id) VALUES ($1,$2)`, [limited.id, A.id]);

    const mk = async (site, host, { os = "windows", agentMin = 0 } = {}) => {
        const id = (await q(`INSERT INTO devices (site_id, hostname, operating_system) VALUES ($1,$2,$3) RETURNING id`, [site, `${tag}-${host}`, os === "windows" ? "Windows 11" : os === "macos" ? "macOS 14.5" : "Ubuntu 24.04"])).rows[0].id;
        let agent = null;
        if (agentMin !== null) {
            agent = uuid();
            await q(`INSERT INTO agents (id, device_id, agent_uuid, version, last_check_in_at, facts) VALUES ($1,$2,$3,'1.3.38', now() - ($4 || ' minutes')::interval, $5)`, [agent, id, uuid(), String(agentMin), JSON.stringify({ os })]);
        }
        return { id, agent };
    };
    const w1 = await mk(A.site, "w1");
    const w2 = await mk(A.site2, "w2");
    const l1 = await mk(A.site, "l1", { os: "linux" });
    const noAgent = await mk(A.site, "noagent", { agentMin: null });
    const offline = await mk(A.site, "offline", { agentMin: 120 });
    const b1 = await mk(B.site, "b1");

    const T = (p, t, body, method = "POST") => call(`/api/tools/${p}`, { method, token: t?.token, body });
    const ok = async (p, t, body) => {
        const r = await T(p, t, body);
        assert.equal(r.status, 200, `${p}: ${r.status} ${JSON.stringify(await r.clone().json().catch(() => null))}`);
        return r.json();
    };
    const jobsOf = async (agentId) => (await q(`SELECT id, payload, type FROM jobs WHERE agent_id=$1 ORDER BY created_at DESC`, [agentId])).rows;
    const clientA = { kind: "client", clientId: A.id };

    console.log("rights");
    await test("who may do what: preview needs only device read; commands, patches and recovery their usual rights; maintenance and cache the settings right", async () => {
        assert.equal((await T("preview", reader, { scope: clientA })).status, 200);
        assert.equal((await T("command", reader, { scope: clientA, script: "hostname" })).status, 403);
        assert.equal((await T("script", reader, { scope: clientA, scriptId: uuid() })).status, 403);
        assert.equal((await T("patches", reader, { scope: clientA, action: "scan" })).status, 403);
        assert.equal((await T("recover-agents", reader, { scope: clientA })).status, 403);
        assert.equal((await T("maintenance", reader, undefined, "GET")).status, 403);
        assert.equal((await T("maintenance/preview", reader, { tasks: [{ key: "jobs" }] })).status, 403);
        assert.equal((await T("maintenance/run", limited, { tasks: [{ key: "jobs" }] })).status, 403);
        assert.equal((await T("clear-cache", limited, {})).status, 403);
        assert.ok([401, 403].includes((await call("/api/tools/preview", { method: "POST", body: {} })).status));
    });

    console.log("scopes");
    await test("a customer: devices with an agent only, counted by system and by online or offline", async () => {
        const p = await ok("preview", ops, { scope: clientA });
        assert.equal(p.total, 4, "w1, w2, l1 and the offline one (the device without an agent is not a target)");
        assert.equal(p.windows, 3); assert.equal(p.linux, 1); assert.equal(p.online, 3); assert.equal(p.offline, 1);
        assert.ok(p.sample.length >= 1 && p.sample.length <= 5);
    });
    await test("a site, a system and online-only narrow it", async () => {
        assert.equal((await ok("preview", ops, { scope: { kind: "site", siteId: A.site2 } })).total, 1);
        assert.equal((await ok("preview", ops, { scope: { ...clientA, os: "linux" } })).total, 1);
        assert.equal((await ok("preview", ops, { scope: { ...clientA, os: "windows" } })).total, 3);
        assert.equal((await ok("preview", ops, { scope: { ...clientA, onlineOnly: true } })).total, 3);
    });
    await test("bad choices are refused, and a choice that matches nothing does nothing", async () => {
        assert.equal((await T("preview", ops, { scope: { kind: "client" } })).status, 400);
        assert.equal((await T("preview", ops, { scope: { kind: "site", siteId: "nope" } })).status, 400);
        assert.equal((await T("preview", ops, { scope: { kind: "everything" } })).status, 400);
        assert.equal((await T("preview", ops, { scope: { os: "beos" } })).status, 400);
        const empty = await mkClient("Empty");
        const r = await T("command", ops, { scope: { kind: "client", clientId: empty.id }, script: "hostname" });
        assert.equal(r.status, 400); assert.match(JSON.stringify(await r.json()), /No device matches/);
    });
    await test("the customer limit applies: a limited person's 'all devices' is only their customers, and another customer is simply empty", async () => {
        const all = await ok("preview", limited, { scope: { kind: "all" } });
        assert.equal(all.total, 4);
        assert.equal((await ok("preview", limited, { scope: { kind: "client", clientId: B.id } })).total, 0);
        const r = await T("command", limited, { scope: { kind: "client", clientId: B.id }, script: "hostname" });
        assert.equal(r.status, 400);
        assert.equal((await jobsOf(b1.agent)).length, 0, "nothing was queued for the other customer");
    });

    console.log("bulk command");
    await test("a command runs on every device in the scope: one batch, a job per device, its text never in the audit trail", async () => {
        const secret = `echo ${tag}-secret-text`;
        const res = await ok("command", ops, { scope: clientA, script: secret, timeoutSec: 60 });
        assert.equal(res.requested, 4); assert.equal(res.batches.length, 1); assert.ok(res.succeeded >= 3, JSON.stringify(res));
        for (const d of [w1, l1]) {
            const j = (await jobsOf(d.agent))[0];
            assert.equal(j.type, "RUN_SCRIPT"); assert.equal(j.payload.scriptText, secret);
        }
        const audit = await q(`SELECT details::text AS d FROM audit_events WHERE action = 'device.bulk.run-script' ORDER BY created_at DESC LIMIT 1`);
        assert.ok(audit.rows[0] && !audit.rows[0].d.includes(`${tag}-secret-text`), "the command text is not in the audit event");
        assert.equal((await T("command", ops, { scope: clientA, script: "   " })).status, 400);
    });

    console.log("bulk script");
    let bashScript, psScript, both;
    await test("a saved script runs with its parameters as environment variables; a script that does not fit a system is skipped there", async () => {
        bashScript = (await q(`INSERT INTO automations (organization_id, name, type, script, configuration) VALUES ($1,$2,'script',$3,$4) RETURNING id`,
            [org, `${tag} bash`, "echo $RIQ_TARGET", JSON.stringify({ language: "bash", timeoutSec: 60, parameters: [{ name: "target", label: "Target", required: true }, { name: "mode", defaultValue: "fast" }] })])).rows[0].id;
        psScript = (await q(`INSERT INTO automations (organization_id, name, type, script, configuration) VALUES ($1,$2,'script',$3,$4) RETURNING id`,
            [org, `${tag} ps`, "Write-Output ok", JSON.stringify({ language: "powershell", timeoutSec: 60, parameters: [] })])).rows[0].id;
        assert.equal((await T("script", ops, { scope: clientA, scriptId: bashScript, parameters: {} })).status, 400, "a required parameter is missing");
        const res = await ok("script", ops, { scope: { ...clientA, os: "any" }, scriptId: bashScript, parameters: { target: "host-9", mode: "slow" } });
        assert.equal(res.requested, 4);
        const items = (await call(`/api/bulk/batches/${res.batches[0].batchId}`, { token: ops.token }).then((r) => r.json())).items;
        const byId = Object.fromEntries(items.map((i) => [i.deviceId, i]));
        assert.equal(byId[l1.id].status, "queued"); assert.equal(byId[w1.id].status, "skipped");
        const j = (await jobsOf(l1.agent))[0];
        assert.equal(j.payload.env.RIQ_TARGET, "host-9"); assert.equal(j.payload.env.RIQ_MODE, "slow");
        const runs = await q(`SELECT count(*)::int AS n FROM script_runs WHERE automation_id = $1`, [bashScript]);
        assert.equal(runs.rows[0].n, 1, "the run is in the script history");
        const audit = await q(`SELECT details::text AS d FROM audit_events WHERE action = 'device.bulk.run-saved-script' ORDER BY created_at DESC LIMIT 1`);
        assert.ok(audit.rows[0] && !audit.rows[0].d.includes("host-9"), "parameter values are not kept in the audit event");
        assert.equal((await T("script", ops, { scope: clientA, scriptId: uuid() })).status, 400, "an unknown script");
        const win = await ok("script", ops, { scope: { ...clientA, os: "windows" }, scriptId: psScript, parameters: {} });
        assert.ok(win.succeeded >= 2);
    });

    console.log("bulk patch management");
    await test("scan and install go to the bulk engine for every device in the scope; a bad action is refused", async () => {
        assert.equal((await T("patches", ops, { scope: clientA, action: "reboot" })).status, 400);
        const res = await ok("patches", ops, { scope: clientA, action: "scan" });
        assert.equal(res.requested, 4); assert.ok(res.succeeded >= 3, JSON.stringify(res));
        const inst = await ok("patches", ops, { scope: clientA, action: "install-critical" });
        assert.equal(inst.requested, 4);
        assert.equal(inst.succeeded, 0, "nothing was scanned yet, so nothing is installed blind");
    });

    console.log("recover agents");
    await test("every online device is told to restart its agent with the right script; an offline one is told why not", async () => {
        const res = await ok("recover-agents", ops, { scope: clientA });
        assert.equal(res.requested, 4); assert.equal(res.succeeded, 3); assert.equal(res.skipped, 1);
        const jw = (await jobsOf(w1.agent))[0], jl = (await jobsOf(l1.agent))[0];
        assert.equal(jw.payload.language, "powershell"); assert.equal(jw.payload.scriptText, R.WINDOWS_RECOVER_SCRIPT); assert.equal(jw.payload.env.RIQ_TOOL, "agent.recover");
        assert.equal(jl.payload.language, "bash"); assert.equal(jl.payload.scriptText, R.LINUX_RECOVER_SCRIPT);
        const items = (await call(`/api/bulk/batches/${res.batches[0].batchId}`, { token: ops.token }).then((r) => r.json())).items;
        const off = items.find((i) => i.deviceId === offline.id);
        assert.equal(off.status, "skipped"); assert.match(off.reason, /offline/i);
    });

    console.log("a tag as the choice, and leaving devices out");
    let tagId;
    await test("a tag is a choice: it reaches the tagged devices that have an agent, narrowed like any other choice", async () => {
        tagId = (await q(`INSERT INTO tag_defs (organization_id, name) VALUES ($1,$2) RETURNING id`, [org, `${tag} vip`])).rows[0].id;
        for (const d of [w1, l1, offline, noAgent, b1]) await q(`INSERT INTO device_tags (device_id, tag_id) VALUES ($1,$2)`, [d.id, tagId]);
        const p = await ok("preview", ops, { scope: { kind: "tag", tagId } });
        assert.equal(p.total, 4, "w1, l1, offline and b1; the device without an agent is not a target");
        assert.equal((await ok("preview", ops, { scope: { kind: "tag", tagId, os: "linux" } })).total, 1);
        assert.equal((await ok("preview", ops, { scope: { kind: "tag", tagId, onlineOnly: true } })).total, 3);
        assert.equal((await T("preview", ops, { scope: { kind: "tag" } })).status, 400, "a tag has to be chosen");
        assert.equal((await ok("preview", ops, { scope: { kind: "tag", tagId: uuid() } })).total, 0, "a tag that does not exist reaches nothing");
    });
    await test("the customer limit applies to a tag too: a limited person only gets their own customers' tagged devices", async () => {
        assert.equal((await ok("preview", limited, { scope: { kind: "tag", tagId } })).total, 3, "w1, l1 and offline, not the other customer's b1");
    });
    await test("the preview lists every device the choice reaches (name, system, online) for ticking and unticking", async () => {
        const p = await ok("preview", ops, { scope: { kind: "tag", tagId } });
        assert.equal(p.devices.length, 4); assert.equal(p.devicesCapped, false);
        const w = p.devices.find((d) => d.id === w1.id);
        assert.ok(w && w.os === "windows" && w.online === true && typeof w.name === "string");
        assert.equal(p.devices.find((d) => d.id === offline.id).online, false);
        const withExclude = await ok("preview", ops, { scope: { kind: "tag", tagId, exclude: [w1.id] } });
        assert.equal(withExclude.devices.length, 4, "the list is the whole choice: what was left out stays on it to be ticked again");
    });
    await test("devices left out are not touched: the command runs on the rest of the tag, and what was left out gets no job", async () => {
        const before = (await jobsOf(w1.agent)).length;
        const res = await ok("command", ops, { scope: { kind: "tag", tagId, exclude: [w1.id, b1.id] }, script: `echo ${tag}-excl` });
        assert.equal(res.requested, 2, "four in the tag, two left out");
        assert.equal((await jobsOf(w1.agent)).length, before, "the device that was left out got no job");
        assert.equal((await jobsOf(b1.agent)).length, 0);
        assert.equal((await jobsOf(l1.agent))[0].payload.scriptText, `echo ${tag}-excl`);
    });
    await test("leaving devices out works for a customer too, bad lists are refused, and leaving everyone out does nothing", async () => {
        const res = await ok("recover-agents", ops, { scope: { ...clientA, exclude: [w2.id] } });
        assert.equal(res.requested, 3, "four in the customer, one left out");
        assert.equal((await T("command", ops, { scope: { ...clientA, exclude: ["nope"] }, script: "hostname" })).status, 400);
        const all = (await ok("preview", ops, { scope: clientA })).devices.map((d) => d.id);
        const r = await T("command", ops, { scope: { ...clientA, exclude: all }, script: "hostname" });
        assert.equal(r.status, 400); assert.match(JSON.stringify(await r.json()), /No device matches/);
    });

    console.log("scripts for Windows, Linux or both");
    await test("a script for both systems needs both parts, and shows which systems it is for", async () => {
        const body = { name: `${tag} both`, language: "powershell", script: "Write-Output win-part", platform: "both", linuxScript: "echo linux-part" };
        assert.equal((await call("/api/scripts", { method: "POST", token: ops.token, body: { ...body, linuxScript: "  " } })).status, 400, "the Linux part is missing");
        const c = await call("/api/scripts", { method: "POST", token: ops.token, body });
        assert.equal(c.status, 201, JSON.stringify(await c.clone().json().catch(() => null)));
        const made = await c.json();
        assert.equal(made.platform, "both"); assert.equal(made.linuxScript, "echo linux-part"); assert.equal(made.language, "powershell");
        const plain = await (await call("/api/scripts", { method: "POST", token: ops.token, body: { name: `${tag} plain`, language: "bash", script: "echo x" } })).json();
        assert.equal(plain.platform, "linux"); assert.equal(plain.linuxScript, null);
        const list = (await (await call("/api/scripts", { method: "GET", token: ops.token })).json()).items;
        assert.equal(list.find((x) => x.id === made.id).platform, "both");
        both = made.id;
    });
    await test("run on both systems: Windows devices get the PowerShell part and Linux devices the bash part", async () => {
        const res = await ok("script", ops, { scope: { ...clientA, os: "any" }, scriptId: both, parameters: {} });
        assert.ok(res.succeeded >= 3, JSON.stringify(res));
        const jw = (await jobsOf(w1.agent))[0], jl = (await jobsOf(l1.agent))[0];
        assert.equal(jw.payload.language, "powershell"); assert.equal(jw.payload.scriptText, "Write-Output win-part");
        assert.equal(jl.payload.language, "bash"); assert.equal(jl.payload.scriptText, "echo linux-part");
    });

    console.log("scripts for Windows, Linux and macOS");
    let allId, bothId2;
    await test("a script for all three systems needs all three parts, shows them, and a bad platform is refused", async () => {
        const body = { name: `${tag} all`, language: "powershell", script: "Write-Output win-part", platform: "all", linuxScript: "echo linux-part", macosScript: "echo mac-part" };
        assert.equal((await call("/api/scripts", { method: "POST", token: ops.token, body: { ...body, macosScript: " " } })).status, 400, "the macOS part is missing");
        assert.equal((await call("/api/scripts", { method: "POST", token: ops.token, body: { ...body, linuxScript: "" } })).status, 400, "the Linux part is missing");
        assert.equal((await call("/api/scripts", { method: "POST", token: ops.token, body: { ...body, platform: "plan9" } })).status, 400);
        const c = await call("/api/scripts", { method: "POST", token: ops.token, body });
        assert.equal(c.status, 201, JSON.stringify(await c.clone().json().catch(() => null)));
        const made = await c.json();
        assert.equal(made.platform, "all"); assert.equal(made.macosScript, "echo mac-part"); assert.equal(made.linuxScript, "echo linux-part");
        const win = await (await call("/api/scripts", { method: "POST", token: ops.token, body: { name: `${tag} win-only`, language: "powershell", script: "x" } })).json();
        assert.equal(win.macosScript, null);
        allId = made.id;
        bothId2 = both;
    });
    await test("run on all systems: Windows gets PowerShell, Linux its bash part, a Mac its macOS part; a Windows-and-Linux script is skipped on a Mac", async () => {
        const mac = await mk(A.site, "mac1", { os: "macos" });
        const res = await ok("script", ops, { scope: { ...clientA, os: "any" }, scriptId: allId, parameters: {} });
        const jw = (await jobsOf(w1.agent))[0], jl = (await jobsOf(l1.agent))[0], jm = (await jobsOf(mac.agent))[0];
        assert.equal(jw.payload.scriptText, "Write-Output win-part"); assert.equal(jw.payload.language, "powershell");
        assert.equal(jl.payload.scriptText, "echo linux-part"); assert.equal(jl.payload.language, "bash");
        assert.ok(jm, "the Mac got no job: " + JSON.stringify(res)); assert.equal(jm.payload.scriptText, "echo mac-part"); assert.equal(jm.payload.language, "bash");
        const before = (await jobsOf(mac.agent)).length;
        const r2 = await ok("script", ops, { scope: { ...clientA, os: "any" }, scriptId: bothId2, parameters: {} });
        assert.equal((await jobsOf(mac.agent)).length, before, "a Windows-and-Linux script reached a Mac: " + JSON.stringify(r2));
        assert.ok(r2.skipped >= 1, "the Mac was not reported as skipped");
    });
    await test("the shipped cross-platform built-ins are in the list with all three parts and can be edited and reset", async () => {
        const items = (await (await call("/api/scripts", { method: "GET", token: ops.token })).json()).items;
        const sum = items.find((x) => x.name === "System summary (all systems)");
        if (!sum) return console.log("     (built-in scripts are not seeded in this run, skipped)");
        assert.equal(sum.platform, "all"); assert.ok(sum.linuxScript && sum.macosScript && sum.script); assert.equal(sum.builtin, true);
        const put = await call(`/api/scripts/${sum.id}`, { method: "PUT", token: ops.token, body: { name: sum.name, language: "powershell", platform: "all", script: sum.script + " # mine", linuxScript: sum.linuxScript, macosScript: sum.macosScript + " # mine" } });
        assert.equal(put.status, 200, JSON.stringify(await put.clone().json().catch(() => null)));
        const edited = await put.json(); assert.equal(edited.customized, true); assert.ok(edited.macosScript.endsWith("# mine"));
        const reset = await call(`/api/scripts/${sum.id}/reset`, { method: "POST", token: ops.token, body: {} });
        assert.ok([200, 201].includes(reset.status), String(reset.status));
        const back = await reset.json(); assert.equal(back.customized, false); assert.equal(back.macosScript, sum.macosScript); assert.equal(back.script, sum.script);
    });

    console.log("more than 500 devices");
    await test("a scope of 520 devices is done in two groups (500 and 20), each its own batch", async () => {
        const site = (await q(`INSERT INTO sites (client_id, name) VALUES ($1,'Big') RETURNING id`, [C.id])).rows[0].id;
        await q(`INSERT INTO devices (id, site_id, hostname, operating_system) SELECT gen_random_uuid(), $1, $2 || '-big-' || g, 'Windows 11' FROM generate_series(1, 520) g`, [site, tag]);
        await q(`INSERT INTO agents (id, device_id, agent_uuid, version, last_check_in_at, facts) SELECT gen_random_uuid(), d.id, gen_random_uuid(), '1.3.38', now(), '{"os":"windows"}'::jsonb FROM devices d WHERE d.site_id = $1`, [site]);
        const res = await ok("command", ops, { scope: { kind: "site", siteId: site }, script: "hostname" });
        assert.equal(res.requested, 520); assert.equal(res.batches.length, 2);
        assert.deepEqual(res.batches.map((b) => b.requested).sort((a, b) => b - a), [500, 20]);
    });

    console.log("server maintenance");
    await test("the list names every task with its default age", async () => {
        const l = await (await T("maintenance", ops, undefined, "GET")).json();
        assert.ok(l.tasks.length >= 8 && l.tasks.every((t) => t.key && t.title && t.defaultDays >= 7), JSON.stringify(l).slice(0, 200));
        assert.equal(l.min, 7);
    });
    await test("old history is counted, then removed; recent history, open alerts and the audit log stay", async () => {
        const dev = w1.id, agent = w1.agent;
        // an old finished job (with output), a recent one, an old resolved alert, an old open alert, an old bulk batch
        const oldJob = uuid(), newJob = uuid();
        await q(`INSERT INTO jobs (id, agent_id, type, status, created_at, finished_at) VALUES ($1,$2,'RUN_SCRIPT','succeeded', now() - interval '60 days', now() - interval '60 days')`, [oldJob, agent]);
        await q(`INSERT INTO job_results (job_id, exit_code, stdout) VALUES ($1, 0, 'old output')`, [oldJob]);
        await q(`INSERT INTO jobs (id, agent_id, type, status, created_at, finished_at) VALUES ($1,$2,'RUN_SCRIPT','succeeded', now() - interval '1 day', now() - interval '1 day')`, [newJob, agent]);
        const oldAlert = uuid(), openAlert = uuid();
        await q(`INSERT INTO alerts (id, device_id, kind, dedupe_key, state, severity, title, resolved_at) VALUES ($1,$2,'x',$3,'RESOLVED','WARN','old resolved', now() - interval '200 days')`, [oldAlert, dev, `${tag}-a1`]);
        await q(`INSERT INTO alerts (id, device_id, kind, dedupe_key, state, severity, title, first_seen_at) VALUES ($1,$2,'x',$3,'OPEN','WARN','old open', now() - interval '200 days')`, [openAlert, dev, `${tag}-a2`]);
        await q(`INSERT INTO bulk_batches (organization_id, action, summary, requested, created_at) VALUES ($1,'reboot','old batch',1, now() - interval '200 days')`, [org]);
        const auditBefore = (await q(`SELECT count(*)::int AS n FROM audit_events`)).rows[0].n;

        const body = { tasks: [{ key: "jobs", days: 30 }, { key: "alerts", days: 90 }, { key: "bulk", days: 90 }] };
        const pv = await ok("maintenance/preview", ops, body);
        const n = Object.fromEntries(pv.items.map((i) => [i.key, i.count]));
        assert.ok(n.jobs >= 1 && n.alerts === 1 && n.bulk >= 1, JSON.stringify(n));
        assert.equal((await q(`SELECT count(*)::int AS n FROM jobs WHERE id=$1`, [oldJob])).rows[0].n, 1, "a preview removes nothing");

        const run = await ok("maintenance/run", ops, { ...body, optimize: true });
        const r = Object.fromEntries(run.items.map((i) => [i.key, i.removed]));
        assert.ok(r.jobs >= 1 && r.alerts === 1 && r.bulk >= 1, JSON.stringify(r));
        assert.equal(run.optimized, true);
        const has = async (sql, id) => (await q(sql, [id])).rows[0].n;
        assert.equal(await has(`SELECT count(*)::int AS n FROM jobs WHERE id=$1`, oldJob), 0, "the old job is gone");
        assert.equal(await has(`SELECT count(*)::int AS n FROM job_results WHERE job_id=$1`, oldJob), 0, "and its output");
        assert.equal(await has(`SELECT count(*)::int AS n FROM jobs WHERE id=$1`, newJob), 1, "a recent job stays");
        assert.equal(await has(`SELECT count(*)::int AS n FROM alerts WHERE id=$1`, oldAlert), 0);
        assert.equal(await has(`SELECT count(*)::int AS n FROM alerts WHERE id=$1`, openAlert), 1, "an open alert is never removed, however old");
        assert.ok((await q(`SELECT count(*)::int AS n FROM audit_events`)).rows[0].n > auditBefore, "the audit log only grew");
        const ev = await q(`SELECT details::text AS d FROM audit_events WHERE action = 'tools.maintenance' ORDER BY created_at DESC LIMIT 1`);
        assert.ok(ev.rows[0] && /jobs/.test(ev.rows[0].d), "the clean-up is in the audit log");
    });
    await test("bad requests are refused: nothing chosen, an unknown task, an age that is too short or too long, a task twice", async () => {
        assert.equal((await T("maintenance/run", ops, { tasks: [] })).status, 400);
        assert.equal((await T("maintenance/run", ops, { tasks: [{ key: "everything" }] })).status, 400);
        assert.equal((await T("maintenance/run", ops, { tasks: [{ key: "jobs", days: 3 }] })).status, 400);
        assert.equal((await T("maintenance/run", ops, { tasks: [{ key: "jobs", days: 99999 }] })).status, 400);
        assert.equal((await T("maintenance/run", ops, { tasks: [{ key: "jobs" }, { key: "jobs" }] })).status, 400);
        assert.equal((await T("maintenance/preview", ops, { tasks: [{ key: "jobs", days: 7.5 }] })).status, 400);
    });
    await test("every task's SQL runs against the real schema (preview of all of them)", async () => {
        const l = await (await T("maintenance", ops, undefined, "GET")).json();
        const pv = await ok("maintenance/preview", ops, { tasks: l.tasks.map((t) => ({ key: t.key })) });
        assert.equal(pv.items.length, l.tasks.length);
        const run = await ok("maintenance/run", ops, { tasks: l.tasks.map((t) => ({ key: t.key, days: 3650 })) });
        assert.equal(run.items.length, l.tasks.length);
    });

    console.log("clear cache");
    await test("clearing the cache says what it cleared and is audited", async () => {
        const r = await ok("clear-cache", ops, {});
        assert.ok(r.cleared.includes("Policy results") && r.cleared.includes("Sign-in policy"), JSON.stringify(r));
        const ev = await q(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'tools.clear-cache'`);
        assert.ok(ev.rows[0].n >= 1);
    });

    await q(`DELETE FROM automations WHERE id = ANY($1::uuid[])`, [[bashScript, psScript].filter(Boolean)]).catch(() => { });
    await cleanup();
    finish();
}
main().catch((e) => { console.error(e); process.exit(1); });
