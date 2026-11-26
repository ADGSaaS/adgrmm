#!/usr/bin/env node
// Services, processes and event log tools (roadmap 1.16) through the real HTTP API, with a fake agent that answers the
// signed script jobs: rights, input checks, nothing typed ever reaches the script text, parsing for Windows and Linux,
// the customer limit, offline and no-agent devices, the security log right, CSV, audit, and a slow device.
//
//   ADG_E2E_ALLOW=1 BASE_URL=http://127.0.0.1:3951 DATABASE_URL=postgres://.../adg_g1_e2e JWT_SECRET=... node test/device-tools-http.e2e.cjs
"use strict";
const { assert, call, json, runner, setup, uuid } = require("./groupc-helpers.cjs");

const WIN_SERVICES = JSON.stringify({ ok: true, items: [
    { name: "Spooler", display: "Print Spooler", state: "Running", startMode: "Auto", delayed: false, account: "LocalSystem", pid: 1234 },
    { name: "wuauserv", display: "Windows Update", state: "Stopped", startMode: "Auto", delayed: true, account: "LocalSystem", pid: 0 },
    { name: "Fax", display: "Fax", state: "Stopped", startMode: "Disabled", delayed: false, account: "NT AUTHORITY\\NetworkService", pid: 0 },
] });
const WIN_PROCS = JSON.stringify({ ok: true, items: [
    { name: "chrome", pid: 4000, cpuSeconds: 12.5, memoryMb: 800.2, user: "PC\\ann" },
    { name: "notepad", pid: 4100, cpuSeconds: null, memoryMb: 20, user: "PC\\ann" },
] });
const WIN_EVENTS = JSON.stringify({ ok: true, truncated: false, scanned: 2, items: [
    { time: "2026-11-16T10:00:00.0000000Z", id: 7036, level: "Information", levelNumber: 4, provider: "Service Control Manager", message: "The Print Spooler service entered the running state." },
    { time: "2026-11-16T09:00:00.0000000Z", id: 1000, level: "Error", levelNumber: 2, provider: "Application Error", message: "=cmd|' /C calc'!A0 crashed, caf\u00e9" },
] });
const LINUX_SERVICES = "  ssh.service loaded active running OpenBSD Secure Shell server\n  cron.service loaded inactive dead Regular background program processing daemon\n  ghost.service not-found inactive dead ghost.service\n---UNITFILES---\nssh.service enabled enabled\ncron.service disabled enabled\nsnapd.service masked enabled\n";
const LINUX_PROCS = "    1 root      10240 00:00:05 systemd\n  900 www-data  51200 1-02:03:04 nginx: worker\n";
const LINUX_EVENTS = [
    JSON.stringify({ __REALTIME_TIMESTAMP: "1763287200000000", PRIORITY: "3", MESSAGE: "disk failing", SYSLOG_IDENTIFIER: "kernel" }),
    JSON.stringify({ __REALTIME_TIMESTAMP: "1763287100000000", PRIORITY: "6", MESSAGE: "all fine", _SYSTEMD_UNIT: "ssh.service" }),
].join("\n");

async function main() {
    const { q, org, made, staffUser, cleanup } = await setup();
    const { test, finish } = runner();
    const tag = `DT${Date.now()}`;
    const devs = [];

    const viewer = await staffUser("dt-viewer", ["devices.read", "devices.actions"]);
    const admin = await staffUser("dt-admin", ["devices.read", "devices.actions", "devices.tools.write"]);
    const readOnly = await staffUser("dt-readonly", ["devices.read"]);
    const onlyWrite = await staffUser("dt-onlywrite", ["devices.tools.write"]);
    const limited = await staffUser("dt-limited", ["devices.read", "devices.actions", "devices.tools.write"]);

    const mkClient = async (n) => {
        const id = (await q(`INSERT INTO clients (organization_id, name) VALUES ($1,$2) RETURNING id`, [org, `${tag} ${n}`])).rows[0].id;
        made.clients.push(id);
        return { id, site: (await q(`INSERT INTO sites (client_id, name) VALUES ($1,$2) RETURNING id`, [id, `${n} HQ`])).rows[0].id };
    };
    const A = await mkClient("A");
    const B = await mkClient("B");
    await q(`INSERT INTO user_client_access (user_id, client_id) VALUES ($1,$2)`, [limited.id, A.id]);
    const mk = async (site, host, os, minutes = 0) => {
        const id = (await q(`INSERT INTO devices (site_id, hostname, operating_system) VALUES ($1,$2,$3) RETURNING id`, [site, `${tag}-${host}`, os === "windows" ? "Windows 11" : "Ubuntu 24.04"])).rows[0].id;
        devs.push(id);
        const agent = uuid();
        if (minutes !== null) await q(`INSERT INTO agents (id, device_id, agent_uuid, version, last_check_in_at, facts) VALUES ($1,$2,$3,'1.3.28', now() - ($4 || ' minutes')::interval, $5)`, [agent, id, uuid(), String(minutes), JSON.stringify({ os })]);
        return { id, agent };
    };
    const win = await mk(A.site, "win", "windows");
    const lin = await mk(A.site, "lin", "linux");
    const off = await mk(A.site, "off", "windows", 90);
    const none = await mk(A.site, "none", "windows", null);
    const other = await mk(B.site, "other", "windows");

    // The fake agent: answers every queued script job of the tools, as the real agents would print it.
    let delayKind = null;
    const handled = new Set();
    const seen = [];
    const answers = {
        windows: { "services.list": WIN_SERVICES, "processes.list": WIN_PROCS, eventlog: WIN_EVENTS, "service.action": JSON.stringify({ ok: true, name: "Spooler", state: "Running", startMode: "Auto", delayed: false }), "process.end": JSON.stringify({ ok: true, pid: 4000, name: "chrome" }) },
        linux: { "services.list": LINUX_SERVICES, "processes.list": LINUX_PROCS, eventlog: LINUX_EVENTS, "service.action": "OK\nactive\nenabled\n", "process.end": "OK\nnginx\n" },
    };
    const timer = setInterval(async () => {
        try {
            const rows = (await q(`SELECT j.id, j.payload, a.facts->>'os' AS os FROM jobs j JOIN agents a ON a.id = j.agent_id WHERE j.status = 'queued' AND a.device_id = ANY($1::uuid[])`, [devs])).rows;
            for (const r of rows) {
                const kind = r.payload?.env?.ADG_TOOL;
                if (!kind || handled.has(r.id)) continue;
                handled.add(r.id);
                if (kind === delayKind) { delayKind = null; await new Promise((x) => setTimeout(x, 27_000)); }
                seen.push({ id: r.id, kind, os: r.os, payload: r.payload });
                const failing = r.payload?.env?.ADG_SERVICE === "BrokenSvc";
                const out = failing ? JSON.stringify({ ok: false, error: "Cannot open BrokenSvc service on computer '.'." }) : answers[r.os][kind];
                await q(`UPDATE jobs SET status='succeeded', finished_at=now() WHERE id=$1`, [r.id]);
                await q(`INSERT INTO job_results (job_id, exit_code, stdout, stderr) VALUES ($1,0,$2,'') ON CONFLICT (job_id) DO NOTHING`, [r.id, out]);
            }
        } catch { /* next tick */ }
    }, 150);

    const get = (path, t) => call(`/api/devices/${path}`, { token: t.token });
    const act = (id, path, t, body) => call(`/api/devices/${id}/tools/${path}`, { method: "POST", token: t.token, body });

    console.log("rights");
    await test("looking needs devices.read and devices.actions; changing also needs devices.tools.write", async () => {
        assert.equal((await get(`${win.id}/tools/services`, readOnly)).status, 403);
        assert.equal((await get(`${win.id}/tools/processes`, readOnly)).status, 403);
        assert.equal((await get(`${win.id}/tools/eventlog`, readOnly)).status, 403);
        assert.equal((await get(`${win.id}/tools/services`, onlyWrite)).status, 403, "tools.write alone cannot look");
        assert.equal((await get(`${win.id}/tools/services`, viewer)).status, 200);
        assert.equal((await act(win.id, "services/action", viewer, { name: "Spooler", action: "restart" })).status, 403);
        assert.equal((await act(win.id, "processes/end", viewer, { pid: 4000 })).status, 403);
        assert.equal((await act(win.id, "services/action", onlyWrite, { name: "Spooler", action: "restart" })).status, 403);
        assert.ok([401, 403].includes((await call(`/api/devices/${win.id}/tools/services`)).status));
    });

    console.log("Windows");
    await test("the services list is parsed: names, display names, states, start types", async () => {
        const r = await (await get(`${win.id}/tools/services`, viewer)).json();
        assert.equal(r.os, "windows");
        assert.equal(r.pending, false);
        assert.deepEqual(r.items.map((s) => s.name), ["Fax", "Spooler", "wuauserv"]);
        const sp = r.items.find((s) => s.name === "Spooler");
        assert.equal(sp.state, "running");
        assert.equal(sp.startType, "automatic");
        assert.equal(sp.pid, 1234);
        assert.equal(r.items.find((s) => s.name === "wuauserv").startType, "automatic (delayed)");
        assert.equal(r.items.find((s) => s.name === "Fax").startType, "disabled");
        const job = seen[seen.length - 1];
        assert.equal(job.payload.language, "powershell");
        assert.match(job.payload.scriptText, /Get-CimInstance -ClassName Win32_Service -Property /);
    });

    await test("processes and event log are parsed; the event query travels in environment variables, never in the script", async () => {
        const p = await (await get(`${win.id}/tools/processes`, viewer)).json();
        assert.deepEqual(p.items.map((x) => x.name), ["chrome", "notepad"], "largest memory first");
        assert.equal(p.items[1].cpuSeconds, null);
        const e = await (await get(`${win.id}/tools/eventlog?log=System&hours=6&levels=error,warning&max=50&q=${encodeURIComponent("it's \"quoted\"; $(x)")}`, viewer)).json();
        assert.equal(e.items.length, 2);
        assert.equal(e.items[1].level, "Error");
        const job = seen[seen.length - 1];
        assert.equal(job.payload.env.ADG_LOG, "System");
        assert.equal(job.payload.env.ADG_HOURS, "6");
        assert.equal(job.payload.env.ADG_MAX, "50");
        assert.equal(job.payload.env.ADG_LEVELS, "2,3");
        assert.equal(job.payload.env.ADG_TEXT, "it's \"quoted\"; $(x)");
        assert.ok(!job.payload.scriptText.includes("quoted") && !job.payload.scriptText.includes("$(x)"));
    });

    await test("changing a service: the name goes in an environment variable, the script text is fixed, the answer says the new state", async () => {
        const r = await (await act(win.id, "services/action", admin, { name: "Spooler", action: "restart", force: true })).json();
        assert.equal(r.ok, true);
        assert.equal(r.state, "running");
        const j = seen[seen.length - 1];
        assert.equal(j.payload.env.ADG_SERVICE, "Spooler");
        assert.equal(j.payload.env.ADG_ACTION, "restart");
        assert.equal(j.payload.env.ADG_FORCE, "1");
        assert.ok(!j.payload.scriptText.includes("Spooler"));
        const st = await act(win.id, "services/action", admin, { name: "Spooler", action: "startup", startType: "delayed" });
        assert.equal(st.status, 200);
        assert.equal(seen[seen.length - 1].payload.env.ADG_STARTTYPE, "delayed");
        assert.equal((await act(win.id, "services/action", admin, { name: "Spooler", action: "startup" })).status, 400, "a start type is needed");
    });

    await test("an error the device reports comes back as a 409 with its own words", async () => {
        const r = await act(win.id, "services/action", admin, { name: "BrokenSvc", action: "start" });
        assert.equal(r.status, 409);
        assert.match((await r.json()).message, /Cannot open BrokenSvc/);
    });

    await test("ending a process", async () => {
        const r = await (await act(win.id, "processes/end", admin, { pid: 4000 })).json();
        assert.equal(r.ok, true);
        assert.equal(r.name, "chrome");
        assert.equal(seen[seen.length - 1].payload.env.ADG_PID, "4000");
    });

    console.log("input is checked before anything is sent");
    await test("bad service names, process ids, log names, levels, hours, counts and search text are refused", async () => {
        const before = seen.length;
        for (const name of ["", "a*", "a?b", "x'; Remove-Item C:\\ -Recurse; '", "a\"b", "a`b", "-flag", "a;b", "a|b", "x".repeat(300), "a$(b)"]) {
            assert.equal((await act(win.id, "services/action", admin, { name, action: "stop" })).status, 400, `name ${JSON.stringify(name)}`);
        }
        assert.equal((await act(win.id, "services/action", admin, { name: "Spooler", action: "format" })).status, 400);
        for (const pid of [0, 1, 4, -5, "abc", "12; calc", 1.5, 99999999999, null]) {
            assert.equal((await act(win.id, "processes/end", admin, { pid })).status, 400, `pid ${pid}`);
        }
        for (const bad of ["log=" + encodeURIComponent("a;b"), "log=x%00y", "hours=0", "hours=99999", "hours=abc", "max=0", "max=501", "levels=loud", "q=" + "x".repeat(201), "q=a%0Ab"]) {
            assert.equal((await get(`${win.id}/tools/eventlog?${bad}`, admin)).status, 400, bad);
        }
        assert.equal(seen.length, before, "no job was made for any of them");
    });

    await test("the security log needs devices.tools.write as well; the others do not", async () => {
        assert.equal((await get(`${win.id}/tools/eventlog?log=Security`, viewer)).status, 403);
        assert.equal((await get(`${win.id}/tools/eventlog?log=Security`, admin)).status, 200);
        assert.equal((await get(`${win.id}/tools/eventlog?log=Application`, viewer)).status, 200);
        assert.equal((await get(`${win.id}/tools/eventlog?log=Microsoft-Windows-PowerShell/Operational`, viewer)).status, 200);
    });

    await test("CSV export: one row per event, a formula cell is forced to text, non-ASCII survives", async () => {
        const r = await get(`${win.id}/tools/eventlog?log=Application&format=csv`, viewer);
        assert.equal(r.status, 200);
        assert.match(r.headers.get("content-type"), /text\/csv/);
        assert.match(r.headers.get("content-disposition"), /event-log-Application\.csv/);
        const text = await r.text();
        const lines = text.trim().split("\r\n");
        assert.equal(lines.length, 3);
        assert.match(lines[0], /^"Time","Level","Id","Source","Message"$/);
        assert.ok(lines[2].includes("\"'=cmd|"), "the formula starts with a quote");
        assert.ok(text.includes("caf\u00e9"));
    });

    console.log("Linux");
    await test("Linux: systemctl, ps and journalctl output is parsed; the unit name is validated and passed in the environment", async () => {
        const s = await (await get(`${lin.id}/tools/services`, viewer)).json();
        assert.equal(s.os, "linux");
        assert.deepEqual(s.items.map((x) => x.name), ["cron.service", "ssh.service"], "a unit that does not exist is not listed");
        assert.equal(s.items[1].state, "running");
        assert.equal(s.items[1].startType, "automatic");
        assert.equal(s.items[0].startType, "manual");
        assert.equal(seen[seen.length - 1].payload.language, "bash");
        const p = await (await get(`${lin.id}/tools/processes`, viewer)).json();
        assert.equal(p.items.find((x) => x.pid === 900).name, "nginx: worker");
        assert.equal(p.items.find((x) => x.pid === 900).cpuSeconds, 93784);
        const e = await (await get(`${lin.id}/tools/eventlog?log=system&levels=error`, viewer)).json();
        assert.equal(e.items.length, 1, "the level filter is exact");
        assert.equal(e.items[0].message, "disk failing");
        assert.equal(e.items[0].provider, "kernel");
        const a = await (await act(lin.id, "services/action", admin, { name: "ssh", action: "restart" })).json();
        assert.equal(a.state, "active");
        assert.equal(seen[seen.length - 1].payload.env.ADG_SERVICE, "ssh.service");
        await act(lin.id, "services/action", admin, { name: "ssh", action: "startup", startType: "disabled" });
        assert.equal(seen[seen.length - 1].payload.env.ADG_ACTION, "mask");
        assert.equal((await act(lin.id, "services/action", admin, { name: "ssh", action: "startup", startType: "delayed" })).status, 400);
        assert.equal((await act(lin.id, "services/action", admin, { name: "a b.service", action: "stop" })).status, 400);
        assert.equal((await get(`${lin.id}/tools/eventlog?log=Application`, viewer)).status, 400, "a Windows log name on Linux");
        assert.equal((await act(lin.id, "processes/end", admin, { pid: 1 })).status, 400);
    });

    console.log("which devices");
    await test("an offline device, one with no agent, an unknown id and another customer's device are refused; limited people get not found", async () => {
        const o = await get(`${off.id}/tools/services`, viewer);
        assert.equal(o.status, 409);
        assert.match((await o.json()).message, /offline/i);
        assert.equal((await get(`${none.id}/tools/services`, viewer)).status, 409);
        assert.equal((await get(`${uuid()}/tools/services`, viewer)).status, 404);
        assert.equal((await get(`not-a-uuid/tools/services`, viewer)).status, 404);
        const before = seen.length;
        assert.equal((await get(`${other.id}/tools/services`, limited)).status, 404);
        assert.equal((await act(other.id, "services/action", limited, { name: "Spooler", action: "stop" })).status, 404);
        assert.equal((await act(other.id, "processes/end", limited, { pid: 4000 })).status, 404);
        assert.equal((await get(`${other.id}/tools/eventlog`, limited)).status, 404);
        assert.equal(seen.length, before);
        assert.equal((await get(`${win.id}/tools/services`, limited)).status, 200);
    });

    console.log("audit");
    await test("every look and every change is in the audit trail, with what was asked for and no free text beyond the search", async () => {
        await new Promise((r) => setTimeout(r, 500));
        const ev = (await q(`SELECT action, outcome, target_id, details FROM audit_events WHERE target_id = $1 ORDER BY created_at`, [win.id])).rows;
        const actions = ev.map((e) => e.action);
        for (const a of ["device.tools.services.view", "device.tools.processes.view", "device.tools.eventlog.view", "device.service.change", "device.process.end"]) assert.ok(actions.includes(a), a);
        const change = ev.find((e) => e.action === "device.service.change" && e.outcome === "success");
        assert.equal(change.details.name, "Spooler");
        assert.equal(change.details.action, "restart");
        const failed = ev.filter((e) => e.action === "device.service.change" && e.outcome === "failure");
        assert.ok(failed.length >= 1, "the 409 and the 400s are recorded as failures");
        const look = ev.find((e) => e.action === "device.tools.eventlog.view" && e.details.searchText);
        assert.equal(look.details.log, "System");
        assert.deepEqual(look.details.levels, [2, 3]);
        assert.equal(ev.find((e) => e.action === "device.process.end" && e.outcome === "success").details.pid, 4000);
    });

    console.log("a slow device");
    await test("when the device is slow the answer is pending, and the page asks again for that job (only for this device's tool jobs)", async () => {
        delayKind = "services.list";
        const r = await (await get(`${win.id}/tools/services`, viewer)).json();
        assert.equal(r.pending, true);
        assert.ok(r.jobId);
        let again = await (await get(`${win.id}/tools/jobs/${r.jobId}`, viewer)).json();
        for (let i = 0; i < 20 && again.pending; i++) {
            await new Promise((x) => setTimeout(x, 500));
            again = await (await get(`${win.id}/tools/jobs/${r.jobId}`, viewer)).json();
        }
        assert.equal(again.pending, false);
        assert.equal(again.items.length, 3);
        assert.equal((await get(`${lin.id}/tools/jobs/${r.jobId}`, viewer)).status, 404, "a job of another device");
        const plain = (await q(`INSERT INTO jobs (agent_id, type, payload, status) VALUES ($1,'RUN_SCRIPT','{"env":{}}','succeeded') RETURNING id`, [win.agent])).rows[0].id;
        assert.equal((await get(`${win.id}/tools/jobs/${plain}`, viewer)).status, 404, "a job that is not one of these tools");
        assert.equal((await get(`${win.id}/tools/jobs/${uuid()}`, viewer)).status, 404);
        assert.equal((await get(`${win.id}/tools/jobs/nope`, viewer)).status, 404);
    });

    clearInterval(timer);
    await q(`DELETE FROM agents WHERE device_id = ANY($1::uuid[])`, [devs]);
    await q(`DELETE FROM devices WHERE id = ANY($1::uuid[])`, [devs]);
    await q(`DELETE FROM user_client_access WHERE user_id = ANY($1::uuid[])`, [made.users]);
    await cleanup();
    finish();
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
