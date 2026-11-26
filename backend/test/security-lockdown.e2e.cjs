#!/usr/bin/env node
// Security regression test. Run against a throwaway backend and database only:
//
//   ADG_E2E_ALLOW=1 BASE_URL=http://127.0.0.1:3901 DATABASE_URL=postgres://.../adg_e2e \
//   JWT_SECRET=... CONSOLE_ORIGIN=http://console.test node test/security-lockdown.e2e.cjs
//
// It writes test rows, so it refuses any database whose name lacks "e2e".
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { Client } = require("pg");
const WebSocket = require("ws");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");

const BASE = process.env.BASE_URL || "http://127.0.0.1:3901";
const WS_BASE = BASE.replace(/^http/, "ws");
const DB_URL = process.env.DATABASE_URL || "";
const SECRET = process.env.JWT_SECRET || "";
const ORIGIN = process.env.CONSOLE_ORIGIN || "http://console.test";
const COOKIE = process.env.AUTH_COOKIE_NAME || "auth_token";

if (process.env.ADG_E2E_ALLOW !== "1" || !/e2e/.test(new URL(DB_URL).pathname) || !SECRET) {
    console.error("Refusing to run: set ADG_E2E_ALLOW=1, JWT_SECRET, and a DATABASE_URL naming an e2e database.");
    process.exit(2);
}

const uuid = () => crypto.randomUUID();
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const failures = [];
async function test(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  ok    ${name}`);
    } catch (e) {
        failures.push(name);
        console.log(`  FAIL  ${name}\n        ${e?.message ?? e}`);
    }
}

/** Opens a socket and records its messages and how it ended. */
function open(path, headers = {}) {
    return new Promise((resolve) => {
        const ws = new WebSocket(`${WS_BASE}${path}`, { headers });
        const state = { ws, messages: [], closeCode: null, opened: false };
        ws.on("message", (raw) => {
            try {
                state.messages.push(JSON.parse(raw.toString()));
            } catch {
                /* ignore */
            }
        });
        ws.on("close", (code) => {
            state.closeCode = code;
            resolve(state);
        });
        ws.on("error", () => resolve(state));
        ws.on("open", () => {
            state.opened = true;
            setTimeout(() => resolve(state), 500);
        });
    });
}

async function waitFor(check, label, ms = 4000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        const value = await check();
        if (value) return value;
        await sleep(50);
    }
    throw new Error(`timed out waiting for ${label}`);
}

function api(path, { method = "GET", token, cookie, body, headers = {} } = {}) {
    return fetch(`${BASE}${path}`, {
        method,
        headers: {
            ...(body ? { "content-type": "application/json" } : {}),
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            ...(cookie ? { cookie: `${COOKIE}=${cookie}` } : {}),
            ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
    });
}

async function main() {
    const db = new Client({ connectionString: DB_URL });
    await db.connect();
    const q = (sql, params) => db.query(sql, params);

    // ---------- fixtures ----------
    // Login resolves users within the default organization, so fixtures live there.
    const org = (
        await q(
            `INSERT INTO organizations (name, slug) VALUES ('Default Organization', 'default')
             ON CONFLICT (slug) DO UPDATE SET slug = EXCLUDED.slug
             RETURNING id`,
        )
    ).rows[0].id;

    async function client(label) {
        const id = uuid();
        const siteId = uuid();
        await q(`INSERT INTO clients (id, organization_id, name) VALUES ($1,$2,$3)`, [id, org, `${label}-${id}`]);
        await q(`INSERT INTO sites (id, client_id, name) VALUES ($1,$2,$3)`, [siteId, id, `${label}-site`]);
        const key = `key-${uuid()}`;
        await q(
            `INSERT INTO site_enrollment_keys (id, client_id, site_id, name, token_hash, expires_at)
             VALUES ($1,$2,$3,'e2e',$4, now() + interval '1 day')`,
            [uuid(), id, siteId, sha256(key)],
        );
        return { id, siteId, key };
    }

    async function enroll(key, deviceId = uuid(), hostname = `host-${uuid()}`) {
        const res = await api("/api/agent/enroll", {
            method: "POST",
            body: { enrollmentKey: key, deviceId, hostname, os: "windows", arch: "x64", version: "1.0.0" },
            headers: { "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 200) + 1}` },
        });
        return { res, body: await res.json().catch(() => ({})), deviceId };
    }

    async function user(label, permissions) {
        const id = uuid();
        const email = `${label}-${id}@example.test`;
        const password = `pw-${uuid()}`;
        await q(
            `INSERT INTO users (id, organization_id, email, first_name, last_name, status, password_hash)
             VALUES ($1,$2,$3,'E2E',$4,'active',$5)`,
            [id, org, email, label, await bcrypt.hash(password, 4)],
        );
        const roleId = uuid();
        await q(`INSERT INTO roles (id, organization_id, scope, name) VALUES ($1,$2,'organization',$3)`, [roleId, org, `e2e-${label}-${id}`]);
        await q(`INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)`, [id, roleId]);
        for (const p of permissions) {
            await q(`INSERT INTO role_permissions (role_id, permission_key) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [roleId, p]);
        }
        const jti = uuid();
        await q(`INSERT INTO sessions (id, user_id, refresh_token) VALUES ($1,$2,$3)`, [jti, id, sha256(jti)]);
        const token = jwt.sign({ sub: id, email, jti }, SECRET, { expiresIn: "1h" });
        return { id, email, password, jti, token };
    }

    const custA = await client("cust-a");
    const custB = await client("cust-b");
    const a = await enroll(custA.key);
    const b = await enroll(custB.key);
    assert.equal(a.res.status, 201, `enroll failed: ${JSON.stringify(a.body)}`);
    assert.equal(b.res.status, 201, `enroll failed: ${JSON.stringify(b.body)}`);
    const agentA = a.body;
    const agentB = b.body;
    const tech = await user("tech", ["devices.actions", "devices.read"]);
    const viewer = await user("viewer", ["devices.read"]);
    const uiHeaders = (u) => ({ origin: ORIGIN, cookie: `${COOKIE}=${u.token}` });
    const shellUi = `/ws/shell?role=ui&agentUuid=${agentA.agentUuid}`;
    const shellAgent = `/ws/shell?role=agent&agentUuid=${agentA.agentUuid}`;

    // ---------- S1: /ws/shell ----------
    console.log("S1 remote shell");
    await test("UI without a login is rejected", async () => {
        const s = await open(shellUi, { origin: ORIGIN });
        assert.equal(s.closeCode, 4401);
    });
    await test("UI from a foreign origin is rejected", async () => {
        const s = await open(shellUi, { ...uiHeaders(tech), origin: "https://evil.example" });
        assert.equal(s.closeCode, 4403);
    });
    await test("user without devices.actions is rejected", async () => {
        const s = await open(shellUi, uiHeaders(viewer));
        assert.equal(s.closeCode, 4403);
    });
    await test("revoked session is rejected", async () => {
        const u = await user("revoked", ["devices.actions"]);
        await q(`UPDATE sessions SET revoked_at = now() WHERE id = $1`, [u.jti]);
        const s = await open(shellUi, uiHeaders(u));
        assert.equal(s.closeCode, 4401);
    });
    await test("2FA challenge token is rejected", async () => {
        const token = jwt.sign({ sub: tech.id, typ: "2fa_challenge", jti: uuid() }, SECRET, { expiresIn: "5m" });
        const s = await open(shellUi, { origin: ORIGIN, cookie: `${COOKIE}=${token}` });
        assert.equal(s.closeCode, 4401);
    });
    await test("agent role without a token is rejected", async () => {
        const s = await open(shellAgent);
        assert.equal(s.closeCode, 4401);
    });
    await test("agent cannot register under another agent's id", async () => {
        const s = await open(shellAgent, { authorization: `Bearer ${agentB.agentToken}` });
        assert.equal(s.closeCode, 4401);
    });
    await test("authorized user reaches a real agent, and data flows both ways", async () => {
        const agentSock = await open(shellAgent, { authorization: `Bearer ${agentA.agentToken}` });
        assert.ok(agentSock.opened && agentSock.closeCode === null, "agent socket should stay open");
        const ui = await open(shellUi, uiHeaders(tech));
        assert.ok(ui.opened && ui.closeCode === null, "UI socket should stay open");
        assert.equal(ui.messages[0]?.status, "agent_connected");

        ui.ws.send(JSON.stringify({ type: "open", cols: 80, rows: 24 }));
        const opened = await waitFor(() => agentSock.messages.find((m) => m.type === "shell.open"), "shell.open");
        agentSock.ws.send(JSON.stringify({ type: "shell.data", sessionId: opened.sessionId, data: "hello" }));
        await waitFor(() => ui.messages.find((m) => m.type === "data" && m.data === "hello"), "shell data");

        const other = await open(`/ws/shell?role=agent&agentUuid=${agentB.agentUuid}`, {
            authorization: `Bearer ${agentB.agentToken}`,
        });
        other.ws.send(JSON.stringify({ type: "shell.data", sessionId: opened.sessionId, data: "forged" }));
        await sleep(300);
        assert.ok(!ui.messages.some((m) => m.data === "forged"), "another agent injected shell output");

        for (const s of [ui, agentSock, other]) s.ws.close();
        await sleep(100);
    });

    // ---------- S2 and S3: /ws/agent and jobs ----------
    console.log("S2/S3 agent socket and jobs");
    async function newJob(agentId, payload = { language: "powershell", scriptText: "x", timeoutSec: 5 }) {
        const { rows } = await q(
            `INSERT INTO jobs (agent_id, type, payload, status) VALUES ($1,'RUN_SCRIPT',$2,'queued') RETURNING id`,
            [agentId, JSON.stringify(payload)],
        );
        return rows[0].id;
    }
    const jobStatus = async (id) => (await q(`SELECT status FROM jobs WHERE id = $1`, [id])).rows[0]?.status;

    await test("connection without a token is rejected", async () => {
        const s = await open("/ws/agent");
        assert.equal(s.closeCode, 4401);
    });
    await test("posing as another agent receives no jobs", async () => {
        const job = await newJob(agentA.agentId);
        const s = await open("/ws/agent", { authorization: `Bearer ${agentB.agentToken}` });
        s.ws.send(JSON.stringify({ t: "agent_hello", agentId: agentA.agentId }));
        await sleep(400);
        assert.equal(s.closeCode, 4401);
        assert.ok(!s.messages.some((m) => m.jobId === job), "job leaked to the wrong agent");
        assert.equal(await jobStatus(job), "queued");
    });
    await test("the real agent receives its queued job", async () => {
        const job = await newJob(agentA.agentId);
        const s = await open("/ws/agent", { authorization: `Bearer ${agentA.agentToken}` });
        s.ws.send(JSON.stringify({ t: "agent_hello", agentId: agentA.agentId }));
        await waitFor(() => s.messages.find((m) => m.jobId === job), "job delivery");
        await waitFor(async () => (await jobStatus(job)) === "dispatched", "dispatched status");
        s.ws.send(JSON.stringify({ t: "job_result", jobId: job, exitCode: 0, stdout: "ok\u0000done" }));
        await waitFor(async () => (await jobStatus(job)) === "succeeded", "job result");
        const row = (await q(`SELECT stdout FROM job_results WHERE job_id = $1`, [job])).rows[0];
        assert.equal(row.stdout, "okdone", "NUL should be stripped");
        s.ws.close();
        await sleep(100);
    });
    await test("another agent cannot forge a result over the socket", async () => {
        const job = await newJob(agentA.agentId);
        const s = await open("/ws/agent", { authorization: `Bearer ${agentB.agentToken}` });
        s.ws.send(JSON.stringify({ t: "job_result", jobId: job, exitCode: 0, stdout: "forged" }));
        await sleep(400);
        assert.equal(await jobStatus(job), "queued");
        s.ws.close();
    });
    await test("another agent cannot forge a result over REST", async () => {
        const job = await newJob(agentA.agentId);
        const finish = await api(`/api/agent/jobs/${job}/finish`, {
            method: "POST",
            token: agentB.agentToken,
            body: { status: "succeeded", exitCode: 0, stdout: "forged", stderr: "", durationMs: 1 },
        });
        assert.equal(finish.status, 404);
        const running = await api(`/api/agent/jobs/${job}/running`, { method: "POST", token: agentB.agentToken });
        assert.equal(running.status, 404);
        assert.equal(await jobStatus(job), "queued");
    });
    await test("the owning agent can finish over REST, and only once", async () => {
        const job = await newJob(agentA.agentId);
        const body = { status: "failed", exitCode: 1, stdout: "", stderr: "first", durationMs: 1 };
        const first = await api(`/api/agent/jobs/${job}/finish`, { method: "POST", token: agentA.agentToken, body });
        assert.equal(first.status, 204);
        const second = await api(`/api/agent/jobs/${job}/finish`, {
            method: "POST",
            token: agentA.agentToken,
            body: { ...body, status: "succeeded", stderr: "second" },
        });
        assert.equal(second.status, 404);
        assert.equal(await jobStatus(job), "failed");
    });

    // ---------- S4 and S5: enrollment ----------
    console.log("S4/S5 enrollment");
    await test("another customer's key cannot take over a device", async () => {
        const stolen = await enroll(custB.key, agentA.deviceId, "stolen");
        assert.equal(stolen.res.status, 403);
        const site = (await q(`SELECT site_id FROM devices WHERE id = $1`, [agentA.deviceId])).rows[0].site_id;
        assert.equal(site, custA.siteId);
        const still = await api("/api/agent/ping", { method: "POST", token: agentA.agentToken, body: {} });
        assert.equal(still.status, 201, "the real agent must keep its token");
    });
    await test("same-site key cannot re-enroll a device whose agent is still online", async () => {
        const blocked = await enroll(custA.key, agentA.deviceId, "takeover");
        assert.equal(blocked.res.status, 409);
        const still = await api("/api/agent/ping", { method: "POST", token: agentA.agentToken, body: {} });
        assert.equal(still.status, 201, "the real agent must keep its token");
    });
    await test("same-site key can re-enroll the device once its agent has been quiet", async () => {
        await q(`UPDATE agents SET last_check_in_at = now() - interval '10 minutes' WHERE device_id = $1`, [agentA.deviceId]);
        const again = await enroll(custA.key, agentA.deviceId, "reinstall");
        assert.equal(again.res.status, 201);
        agentA.agentToken = again.body.agentToken;
    });
    await test("static ENROLLMENT_SECRET is refused in production", async () => {
        const res = await api("/api/agent/enroll", {
            method: "POST",
            headers: { "x-forwarded-for": "198.51.100.250" },
            body: {
                enrollmentSecret: process.env.ENROLLMENT_SECRET || "e2e-enrollment-secret",
                deviceId: uuid(),
                hostname: "legacy",
                os: "windows",
                arch: "x64",
                version: "1.0.0",
            },
        });
        assert.equal(res.status, 401);
    });
    await test("one-time token works only once, even when raced", async () => {
        const deviceId = uuid();
        const token = `one-${uuid()}`;
        await q(`INSERT INTO devices (id, site_id, hostname) VALUES ($1,$2,$3)`, [deviceId, custA.siteId, `one-${deviceId}`]);
        await q(
            `INSERT INTO endpoint_enrollments (client_id, site_id, device_id, os, alias, token_hash, expires_at)
             VALUES ($1,$2,$3,'windows','one',$4, now() + interval '1 hour')`,
            [custA.id, custA.siteId, deviceId, sha256(token)],
        );
        const attempts = await Promise.all(
            [1, 2, 3, 4].map((i) =>
                api("/api/agent/enroll", {
                    method: "POST",
                    headers: { "x-forwarded-for": `198.51.100.${210 + i}` },
                    body: { enrollmentSecret: token, deviceId, hostname: `one-${deviceId}`, os: "windows", arch: "x64", version: "1.0.0" },
                }),
            ),
        );
        assert.equal(attempts.filter((r) => r.status === 201).length, 1);
    });

    // ---------- S6 and S7: checks ----------
    console.log("S6/S7 checks");
    const run = { status: "OK", checkType: "ping", checkName: "e2e" };
    await test("ingest rejects an agent id used as a credential", async () => {
        const res = await api("/api/agent/ingest/check-runs", {
            method: "POST",
            token: agentA.agentId,
            body: { deviceId: agentA.deviceId, runs: [run] },
        });
        assert.equal(res.status, 401);
    });
    await test("ingest rejects another device's id", async () => {
        const res = await api("/api/agent/ingest/check-runs", {
            method: "POST",
            token: agentB.agentToken,
            body: { deviceId: agentA.deviceId, runs: [run] },
        });
        assert.equal(res.status, 403);
    });
    await test("ingest accepts the agent's own device", async () => {
        const res = await api("/api/agent/ingest/check-runs", {
            method: "POST",
            token: agentB.agentToken,
            body: { deviceId: agentB.deviceId, runs: [run] },
        });
        assert.equal(res.status, 201);
    });
    await test("an agent cannot read another device's assignments", async () => {
        const res = await api(`/api/agent/assignments?deviceId=${agentA.deviceId}`, { token: agentB.agentToken });
        assert.equal(res.status, 403);
    });
    await test("an agent can read its own assignments", async () => {
        const res = await api("/api/agent/assignments", { token: agentB.agentToken });
        assert.equal(res.status, 200);
    });

    // ---------- R1 to R4 ----------
    console.log("R1-R4 reliability");
    await test("R1: a reconnecting agent keeps receiving jobs after the old socket closes", async () => {
        const headers = { authorization: `Bearer ${agentB.agentToken}` };
        const hello = JSON.stringify({ t: "agent_hello", agentId: agentB.agentId });
        const first = await open("/ws/agent", headers);
        first.ws.send(hello);
        await sleep(200);
        const second = await open("/ws/agent", headers);
        second.ws.send(hello);
        await waitFor(() => first.closeCode === 4409, "old socket to be replaced");
        await sleep(200);
        const job = await newJob(agentB.agentId);
        const again = await open("/ws/agent", headers);
        again.ws.send(hello);
        await waitFor(() => again.messages.find((m) => m.jobId === job), "job after reconnect");
        again.ws.close();
        second.ws.close();
        await sleep(100);
    });
    await test("R2: an abandoned job times out with a result", async () => {
        const job = await newJob(agentB.agentId, { language: "powershell", scriptText: "x", timeoutSec: 5 });
        await q(`UPDATE jobs SET status='dispatched', dispatched_at = now() - interval '10 minutes' WHERE id = $1`, [job]);
        const fresh = await newJob(agentB.agentId, { language: "powershell", scriptText: "x", timeoutSec: 3600 });
        await q(`UPDATE jobs SET status='running', started_at = now() - interval '10 minutes' WHERE id = $1`, [fresh]);
        await waitFor(async () => (await jobStatus(job)) === "timeout", "sweeper", 70_000);
        assert.equal(await jobStatus(fresh), "running", "a long job inside its timeout must survive");
        const row = (await q(`SELECT exit_code FROM job_results WHERE job_id = $1`, [job])).rows[0];
        assert.equal(row?.exit_code, -1);
    });
    await test("R3: the server pings connected agents", async () => {
        const s = await open("/ws/agent", { authorization: `Bearer ${agentB.agentToken}` });
        let pinged = false;
        s.ws.on("ping", () => {
            pinged = true;
        });
        await waitFor(() => pinged, "server ping", 35_000);
        s.ws.close();
    });
    await test("R4: a silent device reports offline, and a recent one online", async () => {
        await q(
            `UPDATE devices SET status='online', last_seen_at = now() - interval '2 days' WHERE id = $1`,
            [agentA.deviceId],
        );
        await q(`UPDATE agents SET last_check_in_at = now() - interval '2 days' WHERE id = $1`, [agentA.agentId]);
        const stale = await (await api(`/api/devices/${agentA.deviceId}`, { cookie: tech.token })).json();
        assert.equal(stale.status, "offline");

        await q(`UPDATE agents SET last_check_in_at = now() WHERE id = $1`, [agentA.agentId]);
        const live = await (await api(`/api/devices/${agentA.deviceId}`, { cookie: tech.token })).json();
        assert.equal(live.status, "online");
    });

    // ---------- login ----------
    console.log("Login");
    await test("2FA challenge token cannot call the API", async () => {
        const token = jwt.sign({ sub: tech.id, typ: "2fa_challenge", jti: uuid() }, SECRET, { expiresIn: "5m" });
        assert.equal((await api("/api/devices", { token })).status, 401);
        assert.equal((await api("/api/devices", { cookie: token })).status, 401);
        const me = await (await api("/api/auth/me", { cookie: token })).json();
        assert.equal(me.user, null);
    });
    await test("a normal session still works", async () => {
        assert.equal((await api("/api/devices", { cookie: tech.token })).status, 200);
    });
    await test("correct password logs in", async () => {
        const u = await user("login-ok", []);
        const res = await api("/api/auth/login", {
            method: "POST",
            headers: { "x-forwarded-for": "203.0.113.1" },
            body: { email: u.email, password: u.password },
        });
        assert.ok(res.status < 300, `status ${res.status}`);
    });
    for (const route of ["/api/auth/login", "/api/auth-legacy/login"]) {
        await test(`${route} locks an account after 10 failures`, async () => {
            const u = await user("locked", []);
            const send = (password, i) =>
                api(route, {
                    method: "POST",
                    headers: { "x-forwarded-for": `203.0.113.${i}` },
                    body: { email: u.email, password },
                });
            for (let i = 0; i < 10; i++) assert.equal((await send("wrong-password", 10 + i)).status, 401);
            assert.equal((await send("wrong-password", 40)).status, 429);
            assert.equal((await send(u.password, 41)).status, 429, "lock must also stop the right password");
        });
    }
    await test("one IP is blocked after 30 failures across accounts", async () => {
        for (let i = 0; i < 30; i++) {
            await api("/api/auth/login", {
                method: "POST",
                headers: { "x-forwarded-for": "203.0.113.200" },
                body: { email: `nobody-${i}@example.test`, password: "wrong-password" },
            });
        }
        const res = await api("/api/auth/login", {
            method: "POST",
            headers: { "x-forwarded-for": "203.0.113.200" },
            body: { email: "someone@example.test", password: "wrong-password" },
        });
        assert.equal(res.status, 429);
    });

    await db.end();
    console.log(`\n${passed} passed, ${failures.length} failed`);
    if (failures.length) {
        console.log(failures.map((f) => `  - ${f}`).join("\n"));
        process.exit(1);
    }
    process.exit(0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
