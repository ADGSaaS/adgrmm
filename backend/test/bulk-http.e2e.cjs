#!/usr/bin/env node
// Bulk device actions (roadmap 1.13) through the real HTTP API: validation, rights, the customer limit per device,
// partial results with a reason per device, the batch kept with one row per device, one audit event per batch, the
// matching-ids endpoint behind "select all N matching", and a full 500-device batch.
//
//   RIQ_E2E_ALLOW=1 BASE_URL=http://127.0.0.1:3951 DATABASE_URL=postgres://.../riq_g1_e2e JWT_SECRET=... node test/bulk-http.e2e.cjs
"use strict";
const { assert, call, json, runner, setup, uuid } = require("./groupc-helpers.cjs");

async function main() {
    const { q, org, made, staffUser, cleanup } = await setup();
    const { test, finish } = runner();
    const tag = `BK${Date.now()}`;
    const devs = [];

    const ops = await staffUser("bk-ops", ["devices.read", "devices.write", "devices.actions", "devices.delete", "automation.run", "software.install", "policies.read"]);
    const reader = await staffUser("bk-reader", ["devices.read"]);
    const writer = await staffUser("bk-writer", ["devices.read", "devices.write"]);
    const limited = await staffUser("bk-limited", ["devices.read", "devices.write", "devices.actions", "automation.run"]);

    const mkClient = async (n) => {
        const id = (await q(`INSERT INTO clients (organization_id, name) VALUES ($1,$2) RETURNING id`, [org, `${tag} ${n}`])).rows[0].id;
        made.clients.push(id);
        const site = (await q(`INSERT INTO sites (client_id, name) VALUES ($1,$2) RETURNING id`, [id, `${n} HQ`])).rows[0].id;
        const site2 = (await q(`INSERT INTO sites (client_id, name) VALUES ($1,$2) RETURNING id`, [id, `${n} Branch`])).rows[0].id;
        return { id, site, site2 };
    };
    const A = await mkClient("Alpha");
    const B = await mkClient("Bravo");
    await q(`INSERT INTO user_client_access (user_id, client_id) VALUES ($1,$2)`, [limited.id, A.id]);

    // os: windows | linux; agentMin: minutes since the agent last checked in (null = no agent)
    const mk = async (site, host, { os = "windows", agentMin = 0, version = "1.3.28" } = {}) => {
        const id = (await q(`INSERT INTO devices (site_id, hostname, operating_system) VALUES ($1,$2,$3) RETURNING id`, [site, `${tag}-${host}`, os === "windows" ? "Windows 11" : "Ubuntu 24.04"])).rows[0].id;
        devs.push(id);
        let agent = null;
        if (agentMin !== null) {
            agent = (await q(`INSERT INTO agents (id, device_id, agent_uuid, version, last_check_in_at, facts) VALUES ($1,$2,$3,$4, now() - ($5 || ' minutes')::interval, $6)`, [uuid(), id, uuid(), version, String(agentMin), JSON.stringify({ os })])).rowCount ? (await q(`SELECT id FROM agents WHERE device_id=$1`, [id])).rows[0].id : null;
        }
        return { id, agent };
    };
    const w1 = await mk(A.site, "w1");
    const w2 = await mk(A.site, "w2");
    const l1 = await mk(A.site, "l1", { os: "linux" });
    const noAgent = await mk(A.site, "noagent", { agentMin: null });
    const offline = await mk(A.site, "offline", { agentMin: 120 });
    const oldAgent = await mk(A.site, "old", { version: "1.2.0" });
    const b1 = await mk(B.site, "b1");
    const b2 = await mk(B.site, "b2");

    const post = (path, t, body) => call(`/api/bulk/devices/${path}`, { method: "POST", token: t.token, body });
    const ok = async (path, t, body) => {
        const r = await post(path, t, body);
        assert.equal(r.status, 200, `${path}: ${r.status} ${JSON.stringify(await r.clone().json().catch(() => null))}`);
        return r.json();
    };
    const itemOf = (res, id) => res.items.find((i) => i.deviceId === id);
    const finishJob = async (jobId, stdout, { stderr = "", exit = 0, status = "succeeded" } = {}) => {
        await q(`UPDATE jobs SET status=$2, finished_at=now() WHERE id=$1`, [jobId, status]);
        await q(`INSERT INTO job_results (job_id, exit_code, stdout, stderr) VALUES ($1,$2,$3,$4) ON CONFLICT (job_id) DO UPDATE SET stdout=EXCLUDED.stdout, stderr=EXCLUDED.stderr, exit_code=EXCLUDED.exit_code`, [jobId, exit, stdout, stderr]);
    };
    const jobOf = async (agentId) => (await q(`SELECT id, payload, type, status FROM jobs WHERE agent_id=$1 ORDER BY created_at DESC LIMIT 1`, [agentId])).rows[0];

    console.log("checking the request");
    await test("the request must name 1 to 500 real device ids", async () => {
        assert.equal((await post("reboot", ops, {})).status, 400);
        assert.equal((await post("reboot", ops, { deviceIds: [] })).status, 400);
        assert.equal((await post("reboot", ops, { deviceIds: ["nope"] })).status, 400);
        const many = Array.from({ length: 501 }, () => uuid());
        const r = await post("reboot", ops, { deviceIds: many });
        assert.equal(r.status, 400);
        assert.match(JSON.stringify(await r.json()), /500/);
        assert.equal((await post("move-site", ops, { deviceIds: [w1.id] })).status, 400, "a site is needed");
        assert.equal((await post("patch-install", ops, { deviceIds: [w1.id], level: "some" })).status, 400);
        assert.equal((await post("delete-request", ops, { deviceIds: [w1.id], reason: "x" })).status, 400, "a reason is needed");
    });

    await test("who may do what: each action keeps the right the single-device route needs; no token is refused", async () => {
        assert.equal((await post("reboot", reader, { deviceIds: [w1.id] })).status, 403);
        assert.equal((await post("update-agent", reader, { deviceIds: [w1.id] })).status, 403);
        assert.equal((await post("patch-scan", writer, { deviceIds: [w1.id] })).status, 403, "devices.write is not devices.actions");
        assert.equal((await post("run-script", writer, { deviceIds: [w1.id], script: "echo hi" })).status, 403);
        assert.equal((await post("move-site", reader, { deviceIds: [w1.id], siteId: A.site2 })).status, 403);
        assert.equal((await post("tags", reader, { deviceIds: [w1.id], tagId: uuid() })).status, 403);
        assert.equal((await post("delete-request", reader, { deviceIds: [w1.id], reason: "gone for good" })).status, 403);
        assert.ok([401, 403].includes((await call("/api/bulk/devices/reboot", { method: "POST", body: { deviceIds: [w1.id] } })).status));
        assert.equal((await call("/api/bulk/batches", { token: ops.token })).status, 200);
        assert.equal((await call("/api/bulk/batches", { token: (await staffUser("bk-none", ["customers.read"])).token })).status, 403);
    });

    console.log("restart");
    let rebootBatch;
    await test("a mixed batch: each device answers for itself, one bad device does not stop the others", async () => {
        const missing = uuid();
        const res = await ok("reboot", ops, { deviceIds: [w1.id, l1.id, noAgent.id, missing, w1.id] });
        rebootBatch = res;
        assert.equal(res.requested, 4, "duplicates count once");
        assert.equal(res.succeeded, 2);
        assert.equal(res.skipped, 1);
        assert.equal(res.failed, 1);
        assert.equal(itemOf(res, w1.id).status, "queued");
        assert.equal(itemOf(res, l1.id).status, "queued");
        assert.equal(itemOf(res, noAgent.id).status, "skipped");
        assert.match(itemOf(res, noAgent.id).reason, /no agent/i);
        assert.equal(itemOf(res, missing).status, "failed");
        assert.match(itemOf(res, missing).reason, /not found/i);
        const wj = await jobOf(w1.agent);
        assert.equal(wj.type, "RUN_SCRIPT");
        assert.equal(wj.payload.language, "powershell");
        assert.equal(wj.payload.scriptText, "shutdown.exe /r /t 5");
        const lj = await jobOf(l1.agent);
        assert.equal(lj.payload.language, "bash");
        assert.match(lj.payload.scriptText, /shutdown -r/);
    });

    await test("the batch is kept with one row per device, and one audit event describes it", async () => {
        const batch = (await q(`SELECT * FROM bulk_batches WHERE id=$1`, [rebootBatch.batchId])).rows[0];
        assert.equal(batch.action, "reboot");
        assert.equal(batch.requested, 4);
        assert.equal(batch.succeeded, 2);
        assert.equal(batch.created_by, ops.id);
        assert.match(batch.summary, /Restart 4 devices/);
        assert.equal((await q(`SELECT count(*)::int AS n FROM bulk_batch_items WHERE batch_id=$1`, [rebootBatch.batchId])).rows[0].n, 4);
        await new Promise((r) => setTimeout(r, 400));
        const ev = (await q(`SELECT * FROM audit_events WHERE target_id=$1`, [rebootBatch.batchId])).rows;
        assert.equal(ev.length, 1, "one event per batch");
        assert.equal(ev[0].action, "device.bulk.reboot");
        assert.equal(ev[0].actor_user_id, ops.id);
        assert.equal(ev[0].details.devices, 4);
        assert.equal(ev[0].details.failed, 1);
        assert.equal(ev[0].details.results.length, 4, "the per-device detail is in the event");
        assert.ok(ev[0].details.results.some((r) => r.device === w1.id && r.status === "queued"));
        // the generic per-request event is not written as well: this person has exactly one event for one batch
        const mine = (await q(`SELECT count(*)::int AS n FROM audit_events WHERE actor_user_id=$1 AND category='device'`, [ops.id])).rows[0].n;
        assert.equal(mine, 1);
    });

    await test("the batch view lists it, shows how each device is going as the job moves, and keeps it from other people", async () => {
        const list = await json("/api/bulk/batches", { token: ops.token });
        assert.ok(list.items.some((b) => b.id === rebootBatch.batchId && b.requested === 4 && b.by));
        let one = await json(`/api/bulk/batches/${rebootBatch.batchId}`, { token: ops.token });
        const w = one.items.find((i) => i.deviceId === w1.id);
        assert.equal(w.live.state, "waiting");
        assert.equal(one.progress.waiting, 2);
        const wj = await jobOf(w1.agent);
        await finishJob(wj.id, "");
        one = await json(`/api/bulk/batches/${rebootBatch.batchId}`, { token: ops.token });
        assert.equal(one.items.find((i) => i.deviceId === w1.id).live.state, "done");
        assert.equal(one.progress.done, 1);
        await q(`UPDATE jobs SET status='failed' WHERE id=$1`, [(await jobOf(l1.agent)).id]);
        one = await json(`/api/bulk/batches/${rebootBatch.batchId}`, { token: ops.token });
        assert.equal(one.items.find((i) => i.deviceId === l1.id).live.state, "failed");
        assert.equal((await call(`/api/bulk/batches/${rebootBatch.batchId}`, { token: limited.token })).status, 404, "someone limited to customers sees only their own batches");
        assert.equal((await call(`/api/bulk/batches/not-a-uuid`, { token: ops.token })).status, 404);
        assert.equal((await call(`/api/bulk/batches/${uuid()}`, { token: ops.token })).status, 404);
    });

    console.log("the customer limit, device by device");
    await test("a person limited to some customers acts on their devices only; others answer exactly like missing ones", async () => {
        const before = (await q(`SELECT count(*)::int AS n FROM jobs WHERE agent_id=$1`, [b1.agent])).rows[0].n;
        const missing = uuid();
        const res = await ok("reboot", limited, { deviceIds: [w2.id, b1.id, missing] });
        assert.equal(itemOf(res, w2.id).status, "queued");
        assert.equal(itemOf(res, b1.id).status, "failed");
        assert.equal(itemOf(res, b1.id).reason, itemOf(res, missing).reason, "no hint that the device exists");
        assert.equal((await q(`SELECT count(*)::int AS n FROM jobs WHERE agent_id=$1`, [b1.agent])).rows[0].n, before, "nothing was queued for another customer's device");
        const mine = await json("/api/bulk/batches", { token: limited.token });
        assert.ok(mine.items.some((b) => b.id === res.batchId));
        const detail = await json(`/api/bulk/batches/${res.batchId}`, { token: limited.token });
        assert.equal(detail.items.length, 3);
    });

    await test("the same holds for every action", async () => {
        const cases = [
            ["patch-scan", {}],
            ["update-agent", {}],
            ["run-script", { script: "echo hi", shell: "powershell" }],
            ["delete-request", { reason: "retired hardware" }],
        ];
        for (const [path, extra] of cases) {
            const res = await ok(path, limited, { deviceIds: [b1.id, b2.id], ...extra });
            assert.equal(res.failed, 2, path);
            assert.ok(res.items.every((i) => /not found/i.test(i.reason)), path);
        }
        assert.equal((await q(`SELECT count(*)::int AS n FROM device_deletion_requests WHERE device_id = ANY($1::uuid[])`, [[b1.id, b2.id]])).rows[0].n, 0);
        assert.equal((await q(`SELECT count(*)::int AS n FROM agent_tasks WHERE agent_id = ANY($1::uuid[])`, [[b1.agent, b2.agent]])).rows[0].n, 0);
    });

    console.log("run a script on many");
    let scriptBatch;
    await test("a script goes to every device it fits, and the ones it does not fit say why", async () => {
        const res = await ok("run-script", ops, { deviceIds: [w1.id, w2.id, l1.id, noAgent.id], script: "Write-Output 'hello from bulk'", shell: "powershell", timeoutSec: 30 });
        scriptBatch = res;
        assert.equal(itemOf(res, w1.id).status, "queued");
        assert.equal(itemOf(res, w2.id).status, "queued");
        assert.equal(itemOf(res, l1.id).status, "skipped");
        assert.match(itemOf(res, l1.id).reason, /bash/i);
        assert.equal(itemOf(res, noAgent.id).status, "skipped");
        const j = await jobOf(w1.agent);
        assert.equal(j.payload.scriptText, "Write-Output 'hello from bulk'");
        assert.equal(j.payload.timeoutSec, 30);
        // a script run without a shell picks each system's own
        const auto = await ok("run-script", ops, { deviceIds: [l1.id], script: "echo auto" });
        assert.equal(itemOf(auto, l1.id).status, "queued");
        assert.equal((await jobOf(l1.agent)).payload.language, "bash");
        assert.equal((await post("run-script", ops, { deviceIds: [w1.id], script: "   " })).status, 400);
    });

    await test("the script text never reaches the audit trail, and the output is read per device", async () => {
        await new Promise((r) => setTimeout(r, 400));
        const ev = (await q(`SELECT details FROM audit_events WHERE target_id=$1`, [scriptBatch.batchId])).rows[0];
        const text = JSON.stringify(ev.details);
        assert.ok(!/hello from bulk/.test(text), "no script text");
        assert.ok(ev.details.length > 10);
        const w = itemOf(scriptBatch, w1.id);
        const wj = await jobOf(w1.agent);
        await finishJob(wj.id, "hello from bulk\n", { stderr: "warn" });
        const out = await json(`/api/bulk/batches/${scriptBatch.batchId}/items/${w.id}/output`, { token: ops.token });
        assert.equal(out.stdout, "hello from bulk\n");
        assert.equal(out.stderr, "warn");
        assert.equal(out.exitCode, 0);
        assert.equal((await call(`/api/bulk/batches/${scriptBatch.batchId}/items/${itemOf(scriptBatch, l1.id).id}/output`, { token: ops.token })).status, 404, "a skipped device has no output");
        assert.equal((await call(`/api/bulk/batches/${scriptBatch.batchId}/items/${w.id}/output`, { token: limited.token })).status, 404, "another person's batch");
        assert.equal((await call(`/api/bulk/batches/${scriptBatch.batchId}/items/${uuid()}/output`, { token: ops.token })).status, 404);
    });

    console.log("updates");
    await test("scan queues an agent task per device that can take one", async () => {
        const res = await ok("patch-scan", ops, { deviceIds: [w1.id, noAgent.id] });
        assert.equal(itemOf(res, w1.id).status, "queued");
        assert.equal(itemOf(res, noAgent.id).status, "skipped");
        const t = (await q(`SELECT type::text AS type, created_by, payload FROM agent_tasks WHERE agent_id=$1 ORDER BY created_at DESC LIMIT 1`, [w1.agent])).rows[0];
        assert.equal(t.type, "patch_scan");
        assert.equal(t.created_by, ops.id);
        const linux = await ok("patch-scan", ops, { deviceIds: [l1.id] });
        assert.ok(["queued", "skipped"].includes(itemOf(linux, l1.id).status), "a system that cannot scan is skipped, not failed");
    });

    await test("install takes what the last scan found, at the chosen level, and says so when there is nothing to install", async () => {
        const first = await ok("patch-install", ops, { deviceIds: [w2.id], level: "critical" });
        assert.equal(itemOf(first, w2.id).status, "skipped");
        assert.match(itemOf(first, w2.id).reason, /scan/i);
        const task = (await q(`INSERT INTO agent_tasks (agent_id, type, payload, status, queued_at) VALUES ($1,'patch_scan','{}','succeeded', now()) RETURNING id`, [w2.agent])).rows[0].id;
        await q(`INSERT INTO agent_task_runs (task_id, status, finished_at, output) VALUES ($1,'succeeded', now(), $2)`, [task, JSON.stringify({ artifacts: { patches: [
            { id: "kb1", title: "Critical one", severity: "Critical", requiresReboot: false, kbIds: ["KB1"] },
            { id: "kb2", title: "Moderate one", severity: "Moderate", requiresReboot: false, kbIds: ["KB2"] },
            { id: "kb3", title: "Important one", severity: "Important", requiresReboot: true, kbIds: ["KB3"] },
        ] } })]);
        const crit = await ok("patch-install", ops, { deviceIds: [w2.id], level: "critical" });
        assert.equal(itemOf(crit, w2.id).status, "queued");
        assert.equal(itemOf(crit, w2.id).reason, "2 updates");
        const t1 = (await q(`SELECT payload FROM agent_tasks WHERE agent_id=$1 AND type='patch_install' ORDER BY created_at DESC LIMIT 1`, [w2.agent])).rows[0];
        assert.deepEqual([...t1.payload.ids].sort(), ["kb1", "kb3"]);
        // that install is still waiting, so another is not stacked on it
        const again = await ok("patch-install", ops, { deviceIds: [w2.id], level: "all" });
        assert.equal(itemOf(again, w2.id).status, "skipped");
        assert.match(itemOf(again, w2.id).reason, /already/i);
    });

    await test("agent update is held back for devices that are offline or too old, with the reason", async () => {
        const res = await ok("update-agent", ops, { deviceIds: [offline.id, oldAgent.id, noAgent.id, w1.id] });
        assert.equal(itemOf(res, offline.id).status, "skipped");
        assert.match(itemOf(res, offline.id).reason, /offline/i);
        assert.equal(itemOf(res, oldAgent.id).status, "skipped");
        assert.match(itemOf(res, oldAgent.id).reason, /cannot update itself/i);
        assert.equal(itemOf(res, noAgent.id).status, "skipped");
        assert.ok(["queued", "done", "skipped"].includes(itemOf(res, w1.id).status), "an online current agent is updated, found current, or the server has updates off");
        assert.equal(res.failed, 0);
    });

    console.log("move, tag, remove");
    await test("move to a site: same site is skipped, a name clash is skipped with the reason, the rest move", async () => {
        const m1 = await mk(A.site, "m1");
        const m2 = await mk(A.site, "m2");
        const clash = await mk(A.site2, "m1"); // same host name as m1 at the target
        // clash: host names are tag-prefixed, so a device with m1's name at site2 blocks moving m1 there
        const res = await ok("move-site", ops, { deviceIds: [m1.id, m2.id, clash.id], siteId: A.site2 });
        assert.equal(itemOf(res, m2.id).status, "done");
        assert.equal(itemOf(res, clash.id).status, "skipped");
        assert.match(itemOf(res, clash.id).reason, /already at that site/i);
        assert.equal(itemOf(res, m1.id).status, "skipped");
        assert.match(itemOf(res, m1.id).reason, /already has a device named/i);
        assert.equal((await q(`SELECT site_id FROM devices WHERE id=$1`, [m2.id])).rows[0].site_id, A.site2);
        assert.equal((await q(`SELECT count(*)::int AS n FROM device_changes WHERE device_id=$1 AND kind='moved'`, [m2.id])).rows[0].n, 1);
        assert.match(res.summary, /Move 3 devices to .*Alpha \/ Alpha Branch/);
        assert.equal((await post("move-site", ops, { deviceIds: [m1.id], siteId: uuid() })).status, 404);
    });

    await test("a person limited to some customers cannot move devices into someone else's site", async () => {
        const r = await post("move-site", limited, { deviceIds: [w1.id], siteId: B.site });
        assert.equal(r.status, 404);
        assert.equal((await q(`SELECT site_id FROM devices WHERE id=$1`, [w1.id])).rows[0].site_id, A.site);
        const ok2 = await ok("move-site", limited, { deviceIds: [w1.id], siteId: A.site2 });
        assert.equal(itemOf(ok2, w1.id).status, "done");
        await ok("move-site", ops, { deviceIds: [w1.id], siteId: A.site });
    });

    let tagId;
    await test("tags: add, add again (skipped), remove, remove what is not there (skipped); only a real tag in the organisation", async () => {
        tagId = (await q(`INSERT INTO tag_defs (organization_id, name) VALUES ($1,$2) RETURNING id`, [org, `${tag}-tag`])).rows[0].id;
        const add = await ok("tags", ops, { deviceIds: [w1.id, w2.id], tagId });
        assert.equal(add.succeeded, 2);
        const again = await ok("tags", ops, { deviceIds: [w1.id, l1.id], tagId });
        assert.equal(itemOf(again, w1.id).status, "skipped");
        assert.equal(itemOf(again, l1.id).status, "done");
        const list = await json(`/api/devices?tag=${tagId}&pageSize=50`, { token: ops.token });
        assert.deepEqual(list.items.map((d) => d.id).sort(), [w1.id, w2.id, l1.id].sort());
        const rem = await ok("tags", ops, { deviceIds: [w1.id, noAgent.id], tagId, remove: true });
        assert.equal(itemOf(rem, w1.id).status, "done");
        assert.equal(itemOf(rem, noAgent.id).status, "skipped");
        assert.equal((await post("tags", ops, { deviceIds: [w1.id], tagId: uuid() })).status, 404);
        assert.equal((await post("tags", ops, { deviceIds: [w1.id], tagId: "nope" })).status, 400);
        const lim = await ok("tags", limited, { deviceIds: [b1.id], tagId });
        assert.equal(itemOf(lim, b1.id).status, "failed");
        assert.equal((await q(`SELECT count(*)::int AS n FROM device_tags WHERE device_id=$1`, [b1.id])).rows[0].n, 0);
    });

    await test("removal requests: a reason is kept for every device, a second request is skipped, nothing is deleted", async () => {
        const d1 = await mk(A.site, "del1");
        const d2 = await mk(A.site, "del2");
        const res = await ok("delete-request", ops, { deviceIds: [d1.id, d2.id], reason: "  Retired in the March refresh  " });
        assert.equal(res.succeeded, 2);
        const rows = (await q(`SELECT device_id, status, reason, requested_by_user_id FROM device_deletion_requests WHERE device_id = ANY($1::uuid[])`, [[d1.id, d2.id]])).rows;
        assert.equal(rows.length, 2);
        assert.ok(rows.every((r) => r.status === "pending" && r.reason === "Retired in the March refresh" && r.requested_by_user_id === ops.id));
        assert.equal((await q(`SELECT count(*)::int AS n FROM devices WHERE id = ANY($1::uuid[])`, [[d1.id, d2.id]])).rows[0].n, 2);
        const again = await ok("delete-request", ops, { deviceIds: [d1.id], reason: "Second try" });
        assert.equal(itemOf(again, d1.id).status, "skipped");
        assert.equal((await q(`SELECT reason FROM device_deletion_requests WHERE device_id=$1`, [d1.id])).rows[0].reason, "Retired in the March refresh");
        const list = await json(`/api/devices?q=${tag}-del&pageSize=50`, { token: ops.token });
        assert.ok(list.items.every((d) => d.deletionStatus === "pending"));
        assert.equal((await post("delete-request", writer, { deviceIds: [w1.id], reason: "ok" })).status, 400, "the reason is too short");
    });

    console.log("select all matching");
    await test("the matching-ids endpoint gives ids and names, at most 500, with the total, and follows filters and the customer limit", async () => {
        const all = await json(`/api/devices/ids?q=${tag}`, { token: ops.token });
        assert.equal(all.total, devs.length, "every device made here matches the tag in its name");
        assert.ok(all.items.length <= 500);
        assert.ok(all.items.every((d) => d.id && d.hostname.startsWith(tag)));
        const one = await json(`/api/devices/ids?q=${tag}-w1`, { token: ops.token });
        assert.deepEqual(one.items.map((d) => d.id), [w1.id]);
        assert.equal(one.total, 1);
        const lim = await json(`/api/devices/ids?q=${tag}`, { token: limited.token });
        assert.ok(lim.items.every((d) => ![b1.id, b2.id].includes(d.id)), "none of another customer's devices");
        assert.ok(lim.items.some((d) => d.id === w1.id));
        const online = await json(`/api/devices/ids?q=${tag}&status=offline`, { token: ops.token });
        assert.ok(online.items.some((d) => d.id === offline.id) && !online.items.some((d) => d.id === w1.id));
        assert.equal((await call(`/api/devices/ids?q=${tag}`, { token: (await staffUser("bk-none2", ["customers.read"])).token })).status, 403);
    });

    console.log("a full batch");
    await test("500 devices in one request: all answered, kept, and audited once", async () => {
        const C = await mkClient("Charlie");
        const rows = (await q(`INSERT INTO devices (site_id, hostname, operating_system) SELECT $1, $2 || '-bulk-' || g, 'Windows 11' FROM generate_series(1, 500) g RETURNING id`, [C.site, tag])).rows;
        const ids = rows.map((r) => r.id);
        devs.push(...ids);
        await q(`INSERT INTO agents (device_id, agent_uuid, version, last_check_in_at, facts) SELECT id, gen_random_uuid()::text, '1.3.28', now(), '{"os":"windows"}' FROM devices WHERE id = ANY($1::uuid[])`, [ids]);
        const started = Date.now();
        const res = await ok("reboot", ops, { deviceIds: ids });
        const ms = Date.now() - started;
        assert.equal(res.requested, 500);
        assert.equal(res.succeeded, 500);
        assert.equal(res.items.length, 500);
        assert.equal((await q(`SELECT count(*)::int AS n FROM bulk_batch_items WHERE batch_id=$1`, [res.batchId])).rows[0].n, 500);
        console.log(`        (500 devices in ${ms} ms)`);
        assert.ok(ms < 60_000);
        await new Promise((r) => setTimeout(r, 500));
        const ev = (await q(`SELECT details FROM audit_events WHERE target_id=$1`, [res.batchId])).rows;
        assert.equal(ev.length, 1);
        assert.equal(ev[0].details.devices, 500);
        const detail = await json(`/api/bulk/batches/${res.batchId}`, { token: ops.token });
        assert.equal(detail.items.length, 500);
        assert.equal(detail.progress.waiting, 500);
    });

    await q(`DELETE FROM bulk_batches WHERE created_by = ANY($1::uuid[])`, [made.users]);
    await q(`DELETE FROM device_deletion_requests WHERE device_id = ANY($1::uuid[])`, [devs]);
    await q(`DELETE FROM agent_tasks WHERE agent_id IN (SELECT id FROM agents WHERE device_id = ANY($1::uuid[]))`, [devs]);
    await q(`DELETE FROM agents WHERE device_id = ANY($1::uuid[])`, [devs]);
    await q(`DELETE FROM devices WHERE id = ANY($1::uuid[])`, [devs]);
    if (tagId) await q(`DELETE FROM tag_defs WHERE id=$1`, [tagId]);
    await q(`DELETE FROM user_client_access WHERE user_id = ANY($1::uuid[])`, [made.users]);
    await cleanup();
    finish();
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
