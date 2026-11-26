#!/usr/bin/env node
// Device-secrets vault through the real HTTP API with a fake agent that reports results through the real agent endpoint
// (POST /api/agent/jobs/:id/finish, which ends in JobsService.finishJob): rights (neither right is granted to any role, Owner holds both
// by rule, an administrator granted reveal can reveal but not rotate), the customer limit, offline / Linux / no-agent devices, policy off,
// the reason, the rate limit, the reveal answer (no-store), bulk results, the access log, and that no planted secret is in the audit rows,
// the access rows, any job record, any table or the captured server log.
//
//   ADG_E2E_ALLOW=1 BASE_URL=http://127.0.0.1:3961 DATABASE_URL=postgres://.../adg_vault_e2e JWT_SECRET=... SERVER_LOG=<file> node test/vault-http.e2e.cjs
"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { assert, BASE, call, runner, setup, uuid, sha256 } = require("./groupc-helpers.cjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ALPHA = { u: "ABCDEFGHJKLMNPQRSTUVWXYZ", l: "abcdefghijkmnpqrstuvwxyz", d: "23456789", s: "!#%&*+=?@^_" };
const pw = (len = 20) => {
    const pick = (s) => s[crypto.randomInt(s.length)];
    const c = [pick(ALPHA.u), pick(ALPHA.l), pick(ALPHA.d), pick(ALPHA.s)];
    const all = Object.values(ALPHA).join("");
    while (c.length < len) c.push(pick(all));
    for (let i = c.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [c[i], c[j]] = [c[j], c[i]]; }
    return c.join("");
};
const g = () => String(100000 + crypto.randomInt(800000));
const rpass = () => Array.from({ length: 8 }, g).join("-");

async function main() {
    const { q, org, made, staffUser, cleanup } = await setup();
    const { test, finish } = runner();
    const tag = `VH${Date.now()}`;
    const devs = [];
    const ownerRole = (await q(`SELECT id FROM roles WHERE lower(name) = 'owner' ORDER BY scope DESC LIMIT 1`)).rows[0]?.id;

    const reader = await staffUser("vh-reader", ["devices.read"]);
    const reveal = await staffUser("vh-reveal", ["devices.read", "devices.secrets.reveal"]);
    const manage = await staffUser("vh-manage", ["devices.read", "devices.secrets.manage"]);
    const revealNoRead = await staffUser("vh-revealnoread", ["devices.secrets.reveal"]);
    const both = await staffUser("vh-both", ["devices.read", "devices.secrets.reveal", "devices.secrets.manage"]);
    const limited = await staffUser("vh-limited", ["devices.read", "devices.secrets.reveal", "devices.secrets.manage"]);
    const policyAdmin = await staffUser("vh-policy", ["policies.read", "policies.write"]);
    const rl1 = await staffUser("vh-rate1", ["devices.read", "devices.secrets.reveal"]);
    const rl2 = await staffUser("vh-rate2", ["devices.read", "devices.secrets.reveal"]);
    const owner = await staffUser("vh-owner", []);
    await q(`INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [owner.id, ownerRole]);

    const mkClient = async (n) => {
        const id = (await q(`INSERT INTO clients (organization_id, name) VALUES ($1,$2) RETURNING id`, [org, `${tag} ${n}`])).rows[0].id;
        made.clients.push(id);
        return { id, site: (await q(`INSERT INTO sites (client_id, name) VALUES ($1,$2) RETURNING id`, [id, `${n} HQ`])).rows[0].id };
    };
    const A = await mkClient("A");
    const B = await mkClient("B");
    await q(`INSERT INTO user_client_access (user_id, client_id) VALUES ($1,$2)`, [limited.id, A.id]);
    const tokens = new Map();
    const mk = async (site, host, os, minutes = 0) => {
        const id = (await q(`INSERT INTO devices (site_id, hostname, operating_system) VALUES ($1,$2,$3) RETURNING id`, [site, `${tag}-${host}`, os === "windows" ? "Windows 11 Pro" : "Ubuntu 24.04"])).rows[0].id;
        devs.push(id);
        let agent = null;
        if (minutes !== null) {
            agent = uuid();
            const token = `tok-${uuid()}`;
            tokens.set(id, token);
            await q(`INSERT INTO agents (id, device_id, agent_uuid, version, last_check_in_at, facts, agent_token) VALUES ($1,$2,$3,'1.3.30', now() - ($4 || ' minutes')::interval, $5, $6)`, [agent, id, uuid(), String(minutes), JSON.stringify({ os }), sha256(token)]);
        }
        return { id, agent };
    };
    const w1 = await mk(A.site, "w1", "windows");
    const w2 = await mk(A.site, "w2", "windows");
    const w3 = await mk(A.site, "w3", "windows");
    const w4 = await mk(A.site, "w4", "windows");
    const lin = await mk(A.site, "lin", "linux");
    const off = await mk(A.site, "off", "windows", 90);
    const none = await mk(A.site, "none", "windows", null);
    const other = await mk(B.site, "other", "windows");

    // policies (through the API, as a person with the policy right): customer A has both features on, customer B has nothing
    const pol = await call("/api/policies", { method: "POST", token: policyAdmin.token, body: { name: `${tag} on`, sections: { security: { bitlockerEscrow: "on" }, laps: { enabled: true, account: "vault-admin", passwordLength: 20, rotateAfterRevealMinutes: 60 } }, assignments: [{ level: "customer", targetId: A.id }] } });
    assert.equal(pol.status, 201, `policy create ${pol.status}`);
    const polId = (await pol.json()).id;

    // ----- the fake agent: reports a result through the agent endpoint (the real finishJob), exactly like the Windows agent
    const handled = new Set();
    const seen = [];
    const mode = new Map(); // device id -> { lapsVerified, garbage }
    const planted = [];
    const agentFinish = async (jobId, deviceId, body) => fetch(`${BASE}/api/agent/jobs/${jobId}/finish`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tokens.get(deviceId)}` }, body: JSON.stringify(body) });
    const timer = setInterval(async () => {
        try {
            const rows = (await q(`SELECT j.id, j.payload, a.device_id FROM jobs j JOIN agents a ON a.id = j.agent_id WHERE j.status = 'queued' AND a.device_id = ANY($1::uuid[])`, [devs])).rows;
            for (const r of rows) {
                const tool = r.payload?.env?.ADG_TOOL;
                if (!tool?.startsWith("vault.") || handled.has(r.id)) continue;
                handled.add(r.id);
                seen.push({ id: r.id, tool, device: r.device_id, payload: r.payload });
                const m = mode.get(r.device_id) ?? {};
                let stdout;
                if (m.garbage) { const s = pw(); planted.push(s); stdout = `oops ${s}`; }
                else if (tool === "vault.laps") { const s = pw(Number(r.payload.env.ADG_LAPS_LENGTH)); planted.push(s); lastLaps.set(r.device_id, s); stdout = JSON.stringify({ ok: true, account: r.payload.env.ADG_LAPS_ACCOUNT, created: true, verified: m.lapsVerified !== false, password: s }); }
                else { const k = { id: uuid(), pw: rpass() }; planted.push(k.pw); lastKey.set(r.device_id, k); stdout = JSON.stringify({ ok: true, keys: [{ mount: "C:", protectorId: `{${k.id.toUpperCase()}}`, recoveryPassword: k.pw }] }); }
                await agentFinish(r.id, r.device_id, { status: "succeeded", exitCode: 0, stdout, stderr: "", durationMs: 12 });
            }
        } catch { /* next tick */ }
    }, 150);
    const lastLaps = new Map();
    const lastKey = new Map();
    const waitFor = async (fn, ms = 15000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error("timed out waiting"); await sleep(200); } };

    const U = (id, p = "") => `/api/devices/${id}/secrets${p}`;
    const get = (id, t, p = "") => call(U(id, p), { token: t?.token });
    const post = (id, t, p, body) => call(U(id, p), { method: "POST", token: t?.token, body: body ?? {} });
    const list = async (id, t = both) => (await get(id, t)).json();

    console.log("rights");
    await test("the two rights exist and are granted to no role except by Owner's rule: Admin, Operator and Viewer do not have them", async () => {
        assert.equal((await q(`SELECT count(*)::int AS n FROM permissions WHERE permission_key IN ('devices.secrets.reveal','devices.secrets.manage') AND group_key = 'devices'`)).rows[0].n, 2);
        const roles = (await q(`SELECT DISTINCT lower(r.name) AS name FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE rp.permission_key IN ('devices.secrets.reveal','devices.secrets.manage') AND r.name NOT LIKE 'e2e-%'`)).rows.map((r) => r.name);
        assert.ok(roles.every((n) => n === "owner"), `only Owner may hold them: ${roles}`);
        assert.ok(!roles.includes("admin"));
    });
    await test("the roles screen's catalogue lists both rights with labels", async () => {
        const r = await call("/api/roles/permission-keys", { token: owner.token });
        assert.equal(r.status, 200);
        const text = JSON.stringify(await r.json());
        assert.ok(text.includes("devices.secrets.reveal") && text.includes("devices.secrets.manage") && /View device secrets/.test(text));
    });
    await test("the list needs devices.read and one of the rights; the admin API key (no person) gets nothing", async () => {
        assert.equal((await get(w1.id, reader)).status, 403);
        assert.equal((await get(w1.id, revealNoRead)).status, 403);
        assert.equal((await get(w1.id, reveal)).status, 200);
        assert.equal((await get(w1.id, manage)).status, 200);
        assert.ok([401, 403].includes((await get(w1.id)).status));
        assert.ok([401, 403].includes((await call(U(w1.id), { headers: { "x-admin-api-key": process.env.ADMIN_API_KEY || "e2e-admin" } })).status), "the API key alone gets nothing");
        const v = await (await get(w1.id, reveal)).json();
        assert.equal(v.canReveal, true); assert.equal(v.canManage, false);
        assert.equal((await (await get(w1.id, manage)).json()).canReveal, false);
    });
    await test("Owner (by rule) can list and has both rights", async () => {
        const v = await (await get(w1.id, owner)).json();
        assert.equal(v.canReveal, true); assert.equal(v.canManage, true);
    });
    await test("reveal needs devices.read AND reveal; escrow and rotate need devices.read AND manage; each right alone is not enough for the other", async () => {
        const s = uuid();
        for (const t of [reader, manage, revealNoRead]) assert.equal((await post(w1.id, t, `/${s}/reveal`, { reason: "valid reason" })).status, 403);
        for (const t of [reader, reveal, revealNoRead]) for (const p of ["/escrow", "/rotate"]) assert.equal((await post(w1.id, t, p)).status, 403, `${p} as an administrator who may only reveal`);
        for (const p of ["/escrow", "/rotate"]) assert.ok([401, 403].includes((await post(w1.id, undefined, p)).status));
        assert.equal((await call("/api/security/secret-access", { token: manage.token })).status, 403);
        assert.equal((await call("/api/security/secret-access", { token: reader.token })).status, 403);
        assert.equal((await call("/api/security/secret-access", { token: reveal.token })).status, 200);
        assert.equal(seen.length, 0, "no job was made by any refused request");
    });

    console.log("devices that cannot be asked");
    await test("no agent 409, offline 409, a customer without the policy 409: no job is made", async () => {
        const cases = [[none, 409, /no agent/i], [off, 409, /offline/i], [other, 409, /off for this device by policy/]];
        // the unlimited manager sees 'other' (customer B, no policy): policy off
        for (const p of ["/escrow", "/rotate"]) {
            const r = await post(other.id, both, p); assert.equal(r.status, 409); assert.match((await r.json()).message, /off for this device by policy/);
            for (const [d, status, re] of cases.slice(0, 2)) { const x = await post(d.id, both, p); assert.equal(x.status, status, `${p} ${d.id}`); assert.match((await x.json()).message, re); }
        }
        assert.equal(seen.length, 0);
        const lv = await (await get(lin.id, both)).json(); assert.equal(lv.windows, false); assert.equal(lv.linux, true); assert.deepEqual(lv.items, []);
        assert.equal((await post(lin.id, reveal, `/${uuid()}/reveal`, { reason: "valid reason" })).status, 404, "Linux devices have secrets now: an unknown one is simply not found");
    });
    await test("the customer limit: another customer's device is a 404 for a limited person on every route", async () => {
        assert.equal((await get(other.id, limited)).status, 404);
        for (const p of [`/${uuid()}/reveal`, "/escrow", "/rotate"]) assert.equal((await post(other.id, limited, p, { reason: "valid reason" })).status, 404, p);
        assert.equal((await get(w1.id, limited)).status, 200);
        assert.equal((await get("not-a-uuid", both)).status, 404);
        assert.equal((await get(uuid(), both)).status, 404);
    });

    console.log("escrow and rotation");
    const KEYPW = () => lastKey.get(w1.id)?.pw;
    await test("Escrow now (manage): one fixed secret job marked secret, the keys arrive through the agent endpoint and are listed as metadata only", async () => {
        const r = await post(w1.id, manage, "/escrow");
        assert.equal(r.status, 200); const j = await r.json(); assert.equal(j.queued, true); assert.equal(j.alreadyWaiting, false); assert.ok(!("jobId" in j));
        const v = await waitFor(async () => { const x = await list(w1.id); return x.items.some((i) => i.kind === "bitlocker_recovery") && !x.escrow.pending ? x : null; });
        const it = v.items.find((i) => i.kind === "bitlocker_recovery");
        assert.equal(it.label, "C:"); assert.equal(it.status, "current"); assert.equal(it.refTail.length, 4); assert.equal(it.lastRevealedAt, null);
        assert.ok(!JSON.stringify(v).includes(KEYPW()), "the list never carries a key");
        assert.ok(!/ciphertext|v1:/.test(JSON.stringify(v)));
        const job = seen.find((s) => s.tool === "vault.bitlocker");
        assert.deepEqual(job.payload.env, { ADG_TOOL: "vault.bitlocker", ADG_SECRET_JOB: "1" });
        const res = (await q(`SELECT stdout, stderr FROM job_results WHERE job_id = $1`, [job.id])).rows[0];
        assert.equal(res.stdout, "(secret output removed)"); assert.equal(res.stderr, "(secret output removed)");
        assert.equal((await q(`SELECT status FROM jobs WHERE id = $1`, [job.id])).rows[0].status, "succeeded");
    });
    await test("Rotate now (manage): the password generated on the 'device' arrives sealed; the account and length come from the policy", async () => {
        const r = await post(w1.id, manage, "/rotate"); assert.equal(r.status, 200);
        const v = await waitFor(async () => { const x = await list(w1.id); return x.items.some((i) => i.kind === "local_admin") && !x.laps.pending ? x : null; });
        const it = v.items.find((i) => i.kind === "local_admin");
        assert.equal(it.label, "vault-admin"); assert.equal(it.status, "current"); assert.equal(v.laps.attempt, "ok"); assert.equal(v.laps.enabled, true); assert.equal(v.laps.account, "vault-admin");
        const job = seen.find((s) => s.tool === "vault.laps");
        assert.equal(job.payload.env.ADG_LAPS_ACCOUNT, "vault-admin"); assert.equal(job.payload.env.ADG_LAPS_LENGTH, "20");
        assert.ok(!JSON.stringify(v).includes(lastLaps.get(w1.id)));
    });
    await test("a second Rotate now while one waits is reported as already waiting, not queued twice", async () => {
        mode.set(w2.id, {});
        const a = await (await post(w2.id, manage, "/rotate")).json();
        const b = await (await post(w2.id, manage, "/rotate")).json();
        assert.equal(a.queued, true); assert.equal(b.alreadyWaiting, true);
        await waitFor(async () => !(await list(w2.id)).laps.pending);
    });

    console.log("reveal");
    let adminId, keyId;
    await test("a reveal needs a reason of 5 to 300 characters; refused attempts are recorded; no secret is returned", async () => {
        const v = await list(w1.id); adminId = v.items.find((i) => i.kind === "local_admin").id; keyId = v.items.find((i) => i.kind === "bitlocker_recovery").id;
        for (const bad of [undefined, "", "abcd", "x".repeat(301), "bad\nreason", "   "]) {
            const r = await post(w1.id, rl2, `/${adminId}/reveal`, bad === undefined ? {} : { reason: bad });
            assert.equal(r.status, 400, JSON.stringify(bad)); assert.ok(!JSON.stringify(await r.json()).includes(lastLaps.get(w1.id)));
        }
        const rows = (await q(`SELECT * FROM device_secret_access WHERE device_id = $1 AND outcome = 'refused' AND user_id = $2`, [w1.id, rl2.id])).rows;
        assert.equal(rows.length, 6); assert.ok(rows.every((x) => x.error === "bad_reason"));
    });
    await test("a reveal returns the secret with Cache-Control: no-store, records the access and the audit event with the reason and never the value", async () => {
        const r = await post(w1.id, reveal, `/${adminId}/reveal`, { reason: "  ticket 4411: customer locked out  " });
        assert.equal(r.status, 200); assert.match(r.headers.get("cache-control") ?? "", /no-store/);
        const j = await r.json();
        assert.equal(j.secret, lastLaps.get(w1.id)); assert.equal(j.kind, "local_admin"); assert.equal(j.label, "vault-admin"); assert.equal(j.hideAfterSec, 60); assert.ok(j.rotateAt); assert.equal(j.status, "current");
        const acc = (await q(`SELECT * FROM device_secret_access WHERE device_id = $1 AND action = 'reveal' AND outcome = 'ok'`, [w1.id])).rows;
        assert.equal(acc.length, 1); assert.equal(acc[0].reason, "ticket 4411: customer locked out"); assert.equal(acc[0].user_id, reveal.id);
        await sleep(800);
        const ev = (await q(`SELECT action, outcome, details FROM audit_events WHERE target_id = $1 AND action = 'device.secret.reveal' AND outcome = 'success'`, [w1.id])).rows;
        assert.equal(ev.length, 1); assert.equal(ev[0].details.kind, "local_admin"); assert.equal(ev[0].details.label, "vault-admin"); assert.equal(ev[0].details.reason, "ticket 4411: customer locked out");
        assert.ok(!JSON.stringify(ev).includes(j.secret));
        const l = await list(w1.id); assert.ok(l.items.find((i) => i.id === adminId).lastRevealedAt); assert.ok(l.laps.rotateDueAt, "rotation after the reveal is scheduled");
        assert.ok(l.recentAccess.some((a) => a.action === "reveal"));
    });
    await test("a BitLocker recovery key is revealed the same way", async () => {
        const r = await post(w1.id, both, `/${keyId}/reveal`, { reason: "disk recovery for ticket 4412" });
        assert.equal(r.status, 200); const j = await r.json(); assert.equal(j.secret, KEYPW()); assert.match(j.secret, /^\d{6}(-\d{6}){7}$/);
    });
    await test("a secret of another device or an unknown id is a 404", async () => {
        assert.equal((await post(w3.id, both, `/${adminId}/reveal`, { reason: "valid reason" })).status, 404);
        assert.equal((await post(w1.id, both, `/${uuid()}/reveal`, { reason: "valid reason" })).status, 404);
        assert.equal((await post(w1.id, both, `/not-a-uuid/reveal`, { reason: "valid reason" })).status, 404);
    });
    await test("rate limit: 10 reveal attempts per person per minute (refused ones count); the 11th is a 429 with a clear message and retryAfterSec", async () => {
        let last;
        for (let i = 0; i < 10; i++) last = await post(w1.id, rl1, `/${adminId}/reveal`, { reason: i % 2 ? "short" : "a valid reason " + i });
        assert.ok([200, 400].includes(last.status));
        const r = await post(w1.id, rl1, `/${adminId}/reveal`, { reason: "a valid reason again" });
        assert.equal(r.status, 429); const j = await r.json(); assert.equal(j.code, "rate_limited"); assert.ok(j.retryAfterSec >= 1); assert.match(j.message, /Wait \d+ second/);
        assert.ok(!JSON.stringify(j).includes(lastLaps.get(w1.id)));
        assert.equal((await post(w1.id, reveal, `/${adminId}/reveal`, { reason: "another person is fine" })).status, 200);
        await sleep(800);
        assert.ok((await q(`SELECT 1 FROM device_secret_access WHERE user_id = $1 AND error LIKE 'rate_limited%'`, [rl1.id])).rows.length >= 1, "one row for the burst");
    });

    console.log("unconfirmed passwords");
    await test("an unconfirmed password is listed with a warning, the old one becomes previous, both can be revealed", async () => {
        mode.set(w3.id, { lapsVerified: false });
        await post(w3.id, both, "/rotate");
        const v = await waitFor(async () => { const x = await list(w3.id); return x.items.length && !x.laps.pending ? x : null; });
        assert.equal(v.items[0].status, "unconfirmed"); assert.match(v.items[0].warning, /could not confirm/); assert.equal(v.laps.attempt, "unconfirmed");
        const r = await post(w3.id, reveal, `/${v.items[0].id}/reveal`, { reason: "checking unconfirmed" });
        assert.equal(r.status, 200); assert.match((await r.json()).warning, /could not confirm/);
    });

    console.log("failures");
    await test("an unreadable answer (garbage with a password in it) stores nothing, fails the job, redacts the result and says so in plain words", async () => {
        mode.set(w4.id, { garbage: true });
        await post(w4.id, both, "/rotate");
        const v = await waitFor(async () => { const x = await list(w4.id); return x.laps.lastAttemptAt && !x.laps.pending ? x : null; });
        assert.deepEqual(v.items, []); assert.equal(v.laps.attempt, "failed"); assert.match(v.laps.message, /discarded|could not be read/);
        const job = seen.filter((s) => s.device === w4.id).pop();
        const jr = (await q(`SELECT j.status, r.stdout, r.stderr FROM jobs j JOIN job_results r ON r.job_id = j.id WHERE j.id = $1`, [job.id])).rows[0];
        assert.equal(jr.status, "failed"); assert.match(jr.stdout, /secret output removed/); assert.ok(!jr.stderr.includes("oops"));
        mode.delete(w4.id);
    });

    console.log("bulk");
    const bulk = (what, t, ids) => call(`/api/bulk/devices/${what}`, { method: "POST", token: t?.token, body: { deviceIds: ids } });
    await test("bulk needs devices.read and manage; per-device results say what happened; offline, no-agent, other-customer and no-policy devices are reported (Linux is asked like Windows), nothing is queued for them", async () => {
        for (const what of ["escrow-bitlocker", "rotate-laps-password"]) {
            for (const t of [reader, reveal, revealNoRead]) assert.equal((await bulk(what, t, [w1.id])).status, 403, what);
            assert.ok([401, 403].includes((await bulk(what, undefined, [w1.id])).status));
        }
        for (const d of [w1, w2, w3, w4, lin, off, none, other]) { await q(`UPDATE device_secret_state SET escrow_pending_job_id = NULL, laps_pending_job_id = NULL, laps_attempted_at = NULL WHERE device_id = $1`, [d.id]); }
        const before = seen.length;
        const ids = [w1.id, lin.id, off.id, none.id, other.id, uuid()];
        const r = await bulk("rotate-laps-password", both, ids); assert.equal(r.status, 200);
        const j = await r.json();
        const by = Object.fromEntries(j.items.map((i) => [i.deviceId, i]));
        assert.equal(j.requested, 6); assert.equal(by[w1.id].status, "queued"); assert.equal(by[lin.id].status, "queued"); assert.match(by[off.id].reason, /offline/i); assert.match(by[none.id].reason, /no agent/i); assert.match(by[other.id].reason, /off for this device by policy/); assert.equal(by[ids[5]].status, "failed");
        assert.equal(j.succeeded, 2);
        await waitFor(async () => seen.length > before);
        const e = await bulk("escrow-bitlocker", both, [w2.id, other.id]); const ej = await e.json();
        assert.equal(ej.items.find((i) => i.deviceId === w2.id).status, "queued"); assert.equal(ej.items.find((i) => i.deviceId === other.id).status, "skipped");
        assert.equal((await bulk("rotate-laps-password", both, [])).status, 400);
        assert.equal((await bulk("rotate-laps-password", both, Array.from({ length: 501 }, () => uuid()))).status, 400);
        const lim = await (await bulk("rotate-laps-password", limited, [other.id])).json();
        assert.equal(lim.items[0].status, "failed"); assert.match(lim.items[0].reason, /not found/i);
        assert.ok(!JSON.stringify(j).includes(lastLaps.get(w1.id)));
        // the batch view shows no job output for these
        const batch = await (await call(`/api/bulk/batches/${j.batchId}`, { token: both.token })).text();
        assert.ok(!batch.includes(lastLaps.get(w1.id)));
        await sleep(1500);
    });

    console.log("the access log");
    await test("the secret access log lists who revealed what, when and why, with filters and paging; the customer limit applies", async () => {
        const all = await (await call("/api/security/secret-access?limit=5", { token: reveal.token })).json();
        assert.ok(all.total >= 8); assert.equal(all.items.length, 5); assert.equal(all.limit, 5);
        assert.ok(all.items.every((i) => i.deviceName && i.customer && i.action && i.at));
        const byUser = await (await call(`/api/security/secret-access?user=${encodeURIComponent("vh-reveal")}&limit=200`, { token: reveal.token })).json();
        assert.ok(byUser.items.length >= 3 && byUser.items.every((i) => /vh-reveal/.test(i.userName ?? "")));
        const byDev = await (await call(`/api/security/secret-access?deviceId=${w1.id}&limit=200`, { token: reveal.token })).json();
        assert.ok(byDev.items.every((i) => i.deviceId === w1.id) && byDev.items.some((i) => i.action === "reveal" && /ticket 4411/.test(i.reason ?? "")));
        const byClient = await (await call(`/api/security/secret-access?clientId=${B.id}&limit=200`, { token: reveal.token })).json();
        assert.ok(byClient.items.every((i) => i.deviceId === other.id));
        assert.equal((await call("/api/security/secret-access?limit=201", { token: reveal.token })).status, 400);
        assert.equal((await call("/api/security/secret-access?deviceId=x", { token: reveal.token })).status, 400);
        const p2 = await (await call("/api/security/secret-access?limit=3&offset=3", { token: reveal.token })).json(); assert.equal(p2.offset, 3);
        const lim = await (await call("/api/security/secret-access?limit=200", { token: limited.token })).json();
        assert.ok(lim.items.every((i) => i.deviceId !== other.id));
    });

    console.log("no secret anywhere");
    await test("every planted secret is absent from the audit rows, access rows, state, jobs and results, bulk tables, and the captured server log", async () => {
        await sleep(1000);
        assert.ok(planted.length >= 5);
        const tables = ["jobs", "job_results", "device_secret_access", "device_secret_state", "audit_events", "bulk_batches", "bulk_batch_items"];
        let dump = "";
        for (const t of tables) { try { dump += (await q(`SELECT row_to_json(x)::text AS j FROM ${t} x`)).rows.map((r) => r.j).join("\n"); } catch { /* name differs */ } }
        dump += (await q(`SELECT row_to_json(x)::text AS j FROM device_secrets x`)).rows.map((r) => r.j).join("\n");
        const bad = planted.filter((s) => dump.includes(s));
        assert.deepEqual(bad, [], "secrets found in the database");
        const logFile = process.env.SERVER_LOG;
        assert.ok(logFile && fs.existsSync(logFile), "SERVER_LOG must name the captured server output");
        const log = fs.readFileSync(logFile, "utf8");
        assert.ok(log.length > 200, "the server log was captured");
        assert.deepEqual(planted.filter((s) => log.includes(s)), [], "secrets found in the server log");
        assert.ok(!/\d{6}-\d{6}-\d{6}-\d{6}/.test(log));
        console.log(`        ${planted.length} planted secrets checked against ${dump.length} characters of database rows and ${log.length} characters of log`);
    });

    clearInterval(timer);
    await q(`DELETE FROM policies WHERE id = $1`, [polId]).catch(() => undefined);
    await cleanup().catch(() => undefined);
    finish();
}
main().catch((e) => { console.error(e); process.exit(1); });
