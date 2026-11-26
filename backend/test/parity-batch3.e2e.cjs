#!/usr/bin/env node
// Compares two backend builds for agents, tasks, jobs, remote console and remote desktop,
// each on its own throwaway database. Every step runs against both, then responses and
// the resulting rows must match.
//
//   node test/parity-batch3.e2e.cjs seed     (before the backends start)
//   node test/parity-batch3.e2e.cjs run      (once both are up)
//
// Required env: ADG_E2E_ALLOW=1, JWT_SECRET, ADMIN_API_KEY, BASE_A, BASE_B, DB_A, DB_B.
// DIST_B enables direct calls into the new build.
// It writes test rows, so it refuses any database whose name lacks "e2e".
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { Client } = require("pg");
const WebSocket = require("ws");
const jwt = require("jsonwebtoken");

const { JWT_SECRET: SECRET, ADMIN_API_KEY: ADMIN_KEY, BASE_A, BASE_B, DB_A, DB_B } = process.env;
const COOKIE = process.env.AUTH_COOKIE_NAME || "auth_token";

const safe = (url) => {
    try {
        return /e2e/.test(new URL(url).pathname);
    } catch {
        return false;
    }
};
if (process.env.ADG_E2E_ALLOW !== "1" || !SECRET || !ADMIN_KEY || !safe(DB_A) || !safe(DB_B)) {
    console.error("Refusing to run: set ADG_E2E_ALLOW=1, JWT_SECRET, ADMIN_API_KEY, and e2e-named DB_A and DB_B.");
    process.exit(2);
}

const ORG = "11111111-1111-4111-8111-111111111111";
const ADMIN = "22222222-2222-4222-8222-222222222222";
const VIEWER = "33333333-3333-4333-8333-333333333333";
const ADMIN_ROLE = "44444444-4444-4444-8444-444444444444";
const VIEWER_ROLE = "55555555-5555-4555-8555-555555555555";
const SESSION = "66666666-6666-4666-8666-666666666666";

const CLIENT = "a0000000-0000-4000-8000-000000000003";
const SITE = "a0000000-0000-4000-8000-000000000004";
const DEVICE = "a0000000-0000-4000-8000-000000000001";
const DEVICE2 = "a0000000-0000-4000-8000-000000000005";
const DEVICE3 = "a0000000-0000-4000-8000-000000000006";
const DEVICE_NO_AGENT = "a0000000-0000-4000-8000-000000000007";
const UNKNOWN = "a0000000-0000-4000-8000-0000000000ff";
const AGENT = "a0000000-0000-4000-8000-000000000002";
const AGENT2 = "a0000000-0000-4000-8000-000000000008";
const AGENT3 = "a0000000-0000-4000-8000-000000000009";
const AGENT2_UUID = "agent-two-uuid";
const TOKEN_A = "parity-agent-token-aaaaaaaaaaaaaaaa";
const TOKEN_B = "parity-agent-token-bbbbbbbbbbbbbbbb";
const TOKEN_C = "parity-agent-token-cccccccccccccccc";
const T1 = "a0000000-0000-4000-8000-000000000101";
const T2 = "a0000000-0000-4000-8000-000000000102";
const T3 = "a0000000-0000-4000-8000-000000000103";
const T_DONE = "a0000000-0000-4000-8000-000000000104";
const T_B = "a0000000-0000-4000-8000-000000000105";
const J_BAD_SCRIPT = "a0000000-0000-4000-8000-000000000201";
const J_BAD_FILE = "a0000000-0000-4000-8000-000000000202";
const J_UNKNOWN = "a0000000-0000-4000-8000-000000000203";
const J_SCRIPT = "a0000000-0000-4000-8000-000000000204";
const J_FILE = "a0000000-0000-4000-8000-000000000205";
const J_DONE = "a0000000-0000-4000-8000-000000000206";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Generated ids differ between the databases; fixture ids are fixed and compared.
const isFixtureId = (s) => s.startsWith("a0000000-") || /^(.)\1{7}-/.test(s);

const token = (sub, jti) => jwt.sign({ sub, email: `${sub}@example.test`, jti }, SECRET, { expiresIn: "1h" });
const adminCookie = token(ADMIN, SESSION);
const viewerCookie = token(VIEWER, crypto.randomUUID());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function seedDb(db) {
    await db.query(`INSERT INTO organizations (id, name, slug) VALUES ($1,'Default Organization','default')`, [ORG]);
    for (const [id, name] of [[ADMIN, "admin"], [VIEWER, "viewer"]]) {
        await db.query(
            `INSERT INTO users (id, organization_id, email, first_name, last_name, status, password_hash)
             VALUES ($1,$2,$3,'Parity',$4,'active','x')`,
            [id, ORG, `${name}@example.test`, name],
        );
    }
    for (const [id, user, perms] of [
        [ADMIN_ROLE, ADMIN, ["automation.read"]],
        [VIEWER_ROLE, VIEWER, ["devices.read"]],
    ]) {
        await db.query(`INSERT INTO roles (id, organization_id, scope, name) VALUES ($1,$2,'organization',$3)`, [id, ORG, `parity-${id}`]);
        await db.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)`, [user, id]);
        for (const perm of perms) {
            await db.query(`INSERT INTO role_permissions (role_id, permission_key) VALUES ($1,$2)`, [id, perm]);
        }
    }
    await db.query(`INSERT INTO clients (id, organization_id, name) VALUES ($1,$2,'Parity Client')`, [CLIENT, ORG]);
    await db.query(`INSERT INTO sites (id, client_id, name) VALUES ($1,$2,'Parity Site')`, [SITE, CLIENT]);
    for (const [id, name] of [[DEVICE, "one"], [DEVICE2, "two"], [DEVICE3, "three"], [DEVICE_NO_AGENT, "none"]]) {
        await db.query(`INSERT INTO devices (id, site_id, hostname) VALUES ($1,$2,$3)`, [id, SITE, name]);
    }
    for (const [id, device, uuid, tok] of [
        [AGENT, DEVICE, AGENT, TOKEN_A],
        [AGENT2, DEVICE2, AGENT2_UUID, TOKEN_B],
        [AGENT3, DEVICE3, "", TOKEN_C],
    ]) {
        await db.query(
            `INSERT INTO agents (id, device_id, agent_uuid, version, agent_token, created_at, updated_at, facts)
             VALUES ($1,$2,$3,'1.0',$4,'2026-01-01 00:00:00+00','2026-01-01 00:00:00+00','{"keep":"me"}')`,
            [id, device, uuid, tok],
        );
    }
    await db.query(`INSERT INTO sessions (id, user_id, refresh_token) VALUES ($1,$2,'x')`, [SESSION, ADMIN]);
}

// Volatile fields are compared for presence only.
function normalize(value) {
    if (Array.isArray(value)) return value.map(normalize);
    if (value instanceof Date) return "<time>";
    if (value && typeof value === "object") {
        const out = {};
        for (const key of Object.keys(value).sort()) {
            const volatile = /(_at|At|^lastUpdated)$/.test(key) && value[key] !== null;
            const port = /^(port|localPort)$/.test(key) && value[key] !== 3389 && typeof value[key] === "number";
            out[key] = volatile ? "<time>" : port ? "<port>" : normalize(value[key]);
        }
        return out;
    }
    if (typeof value === "string" && UUID.test(value) && !isFixtureId(value)) return "<uuid>";
    if (typeof value === "string") return value.replace(/127\.0\.0\.1:\d+/g, "127.0.0.1:<port>");
    if (typeof value === "bigint") return String(value);
    return value;
}

// {name} in a path, body or SQL becomes the id captured from that build's earlier response.
const fill = (text, vars) => text.replace(/\{(\w+)\}/g, (m, name) => vars[name] ?? m);
const dig = (obj, path) => path.split(".").reduce((o, k) => o?.[k], obj);

async function request(base, { method = "GET", path, body, cookie = adminCookie, bearer, adminKey, capture }, vars = {}) {
    const res = await fetch(`${base}${fill(path, vars)}`, {
        method,
        headers: {
            ...(body !== undefined ? { "content-type": "application/json" } : {}),
            ...(cookie ? { cookie: `${COOKIE}=${cookie}` } : {}),
            ...(bearer ? { authorization: bearer } : {}),
            ...(adminKey ? { "x-admin-api-key": adminKey } : {}),
        },
        body: body !== undefined ? fill(JSON.stringify(body), vars) : undefined,
    });
    const text = await res.text();
    let parsed = text;
    try {
        parsed = text ? JSON.parse(text) : null;
    } catch {
        /* keep text */
    }
    for (const [name, from] of Object.entries(capture ?? {})) {
        const got = dig(parsed, from);
        if (got !== undefined && got !== null) vars[name] = got;
    }
    return { status: res.status, body: normalize(parsed), raw: parsed };
}

/** Opens a socket, sends frames, and records messages and how it ended. */
function openSocket(base, path, { headers = {}, send = [], ackRdp = false } = {}, vars = {}) {
    return new Promise((resolve) => {
        const ws = new WebSocket(`${base.replace(/^http/, "ws")}${fill(path, vars)}`, { headers });
        const state = { ws, messages: [], closed: false, closeCode: null };
        ws.on("message", (raw) => {
            let msg;
            try {
                msg = JSON.parse(raw.toString());
            } catch {
                return;
            }
            if (msg?.type === "ping") return;
            if (ackRdp && msg?.type === "rdp.open") {
                ws.send(JSON.stringify({ type: "rdp.ready", sessionId: msg.sessionId }));
            }
            state.messages.push(msg);
        });
        ws.on("close", (code) => {
            state.closed = true;
            state.closeCode = code;
        });
        ws.on("error", () => {
            state.closed = true;
        });
        ws.on("open", () => {
            for (const frame of send) ws.send(fill(JSON.stringify(frame), vars));
            resolve(state);
        });
        ws.on("unexpected-response", (_req, res) => {
            state.closed = true;
            state.closeCode = res.statusCode;
            resolve(state);
        });
    });
}

const wsView = (state) => ({ messages: normalize(state.messages), closed: state.closed, closeCode: state.closeCode });

const get = (path, cookie) => ({ path, cookie });
const post = (path, body) => ({ method: "POST", path, body });
const del = (path, cookie) => ({ method: "DELETE", path, cookie });
const agent = (tok, method, path, body) => ({ method, path, body, cookie: null, bearer: tok ? `Bearer ${tok}` : undefined });
const key = (k, method, path, body) => ({ method, path, body, cookie: null, adminKey: k });

const ping = (tok, body) => agent(tok, "POST", "/api/agent/ping", body);
const software = (tok, body) => agent(tok, "POST", "/api/agent/software", body);
const next = (tok, capture) => ({ ...agent(tok, "POST", "/api/agent/tasks/next", {}), capture });
const complete = (tok, body) => agent(tok, "POST", "/api/agent/tasks/complete", body);
const runScript = (body, capture) => ({ ...key(ADMIN_KEY, "POST", "/api/admin/jobs/run-script", body), capture });
const fileOp = (body, capture) => ({ ...key(ADMIN_KEY, "POST", "/api/admin/jobs/file-op", body), capture });
const readJob = (id) => key(ADMIN_KEY, "GET", `/api/admin/jobs/${id}`);
const running = (tok, id) => agent(tok, "POST", `/api/agent/jobs/${id}/running`, {});
const finish = (tok, id, body) => agent(tok, "POST", `/api/agent/jobs/${id}/finish`, body);
const once = (path, frame, opts = {}) => ({ wsOnce: path, send: [frame], ...opts });
const rcAgent = (agentUuid, agentToken) => ({ type: "hello", kind: "agent", agentUuid, agentToken });
const rcTech = (sessionId, sessionToken) => ({ type: "hello", kind: "tech", sessionId, sessionToken });
const rdHello = (agentUuid, agentToken) => ({ type: "hello", agentUuid, agentToken });
const RC = "/ws/remote-console";
const RD = "/ws/desktop-tunnel";

const agentState = `SELECT id, hostname, version, agent_uuid, facts, last_check_in_at IS NOT NULL AS checked_in FROM agents ORDER BY id`;
const softwareState = `SELECT agent_id, name, version, publisher, install_date::text AS install_date FROM agent_software ORDER BY agent_id, name`;
// Exact values only for the task seeded with them, which a claim must not rewrite; the rest are generated now.
const exactIfSeeded = (col) => `CASE WHEN id='${T2}' THEN ${col}::text ELSE (${col} IS NOT NULL)::text END`;
const taskState = `SELECT id, status, ${exactIfSeeded("queued_at")} AS q, ${exactIfSeeded("started_at")} AS s, completed_at IS NOT NULL AS done FROM agent_tasks WHERE id::text LIKE 'a0000000-%' ORDER BY id`;
const runState = `SELECT r.task_id, r.attempt, r.status, r.output, r.finished_at IS NOT NULL AS done, x.stdout, x.stderr, x.artifacts, x.artifacts IS NULL AS sql_null
                    FROM agent_task_runs r LEFT JOIN agent_task_results x ON x.run_id = r.id ORDER BY r.task_id, r.attempt`;
const jobState = `SELECT j.type, j.agent_id, j.status, j.payload, j.dispatched_at IS NOT NULL AS d, j.started_at IS NOT NULL AS s, j.finished_at IS NOT NULL AS f,
                         r.exit_code, r.stdout, r.stderr, r.duration_ms
                    FROM jobs j LEFT JOIN job_results r ON r.job_id = j.id ORDER BY j.created_at, j.type, j.status`;

const taskSeed = `
  INSERT INTO agent_tasks (id, agent_id, type, payload, status, queued_at, started_at, created_at) VALUES
    ('${T1}', '${AGENT}', 'script', '{"n":1}', 'pending', NULL, NULL, '2026-01-03 00:00:00+00'),
    ('${T2}', '${AGENT}', 'policy', '{"n":2}', 'queued', '2026-01-01 00:00:00.123456+00', '2026-01-02 00:00:00.654321+00', '2026-01-05 00:00:00+00'),
    ('${T3}', '${AGENT}', 'command', '{"n":3}', 'pending', NULL, NULL, '2026-01-02 00:00:00+00'),
    ('${T_DONE}', '${AGENT}', 'update', '{"n":4}', 'succeeded', NULL, NULL, '2025-01-01 00:00:00+00'),
    ('${T_B}', '${AGENT2}', 'patch_scan', '{"n":5}', 'pending', NULL, NULL, '2026-01-01 00:00:00+00')`;
const jobSeed = `
  INSERT INTO jobs (id, agent_id, type, payload, status, created_at) VALUES
    ('${J_BAD_SCRIPT}', '${AGENT2}', 'RUN_SCRIPT', '{"language":"cobol"}', 'queued', '2026-02-01 00:00:01+00'),
    ('${J_BAD_FILE}', '${AGENT2}', 'FILE_OP', '{"op":"read"}', 'queued', '2026-02-01 00:00:02+00'),
    ('${J_UNKNOWN}', '${AGENT2}', 'mystery', '{}', 'queued', '2026-02-01 00:00:03+00'),
    ('${J_SCRIPT}', '${AGENT2}', 'run_script', '{"language":"bash","scriptText":"echo hi"}', 'queued', '2026-02-01 00:00:04+00'),
    ('${J_FILE}', '${AGENT2}', 'FILE_OP', '{"op":"roots"}', 'queued', '2026-02-01 00:00:05+00'),
    ('${J_DONE}', '${AGENT2}', 'FILE_OP', '{"op":"roots"}', 'succeeded', '2026-02-01 00:00:06+00')`;

// A step is an HTTP request, `sql` to change both databases, `query` to compare rows now,
// or a WebSocket action: wsOnce, wsKeep, wsDrain, wsClose.
const MODULES = {
    "agent ping facts": {
        tables: ["agents"],
        queries: [agentState],
        steps: [
            ping(null, {}),
            ping("nope", {}),
            { ...ping(TOKEN_A, {}), bearer: `Basic ${TOKEN_A}` },
            ping(TOKEN_A, {}),
            { query: agentState },
            ping(TOKEN_A, { hostname: "h1", version: "2.0", os: "linux", arch: "x64", primaryIp: "10.0.0.1", user: "ann" }),
            { query: agentState },
            ping(TOKEN_A, { loggedInUser: "bob" }),
            { query: agentState },
            ping(TOKEN_A, { facts: { cpu: 1, disks: [{ a: 1 }] } }),
            { query: agentState },
            ping(TOKEN_A, { facts: { ram: 2 } }),
            { query: agentState },
            ping(TOKEN_A, { primaryIp: "", user: "", hostname: "" }),
            { query: agentState },
            ping(TOKEN_A, { facts: null, hostname: null }),
            { query: agentState },
            ping(TOKEN_A, { version: null }),
            ping(TOKEN_A, { os: "plan9" }),
            ping(TOKEN_A, { nonsense: 1 }),
            ping(TOKEN_A, { facts: "x" }),
            ping(TOKEN_A, { facts: { bad: "a\u0000b" } }),
            { query: agentState },
            // An empty agent_uuid is restored to the id, with and without a facts patch.
            ping(TOKEN_C, {}),
            { query: agentState },
            { sql: `UPDATE agents SET agent_uuid='' WHERE id='${AGENT3}'` },
            ping(TOKEN_C, { os: "windows" }),
            { query: agentState },
            ping(TOKEN_B, { arch: "arm64" }),
            { query: agentState },
        ],
    },
    "agent software": {
        tables: ["agent_software"],
        queries: [softwareState],
        steps: [
            software(null, { items: [] }),
            software(TOKEN_A, { items: [{ name: "a", version: "1", publisher: "p", installDate: "2024-02-03" }, { name: "  b  " }] }),
            { query: softwareState },
            software(TOKEN_B, { items: [{ name: "other" }] }),
            software(TOKEN_A, { items: [{ name: "c", installDate: "2024-02-30" }, { name: "c" }] }),
            { query: softwareState },
            software(TOKEN_A, { items: [{ name: "   " }, { name: "d" }] }),
            { query: softwareState },
            software(TOKEN_A, { items: [{ name: "x", installDate: "02/03/2024" }] }),
            software(TOKEN_A, { items: "x" }),
            software(TOKEN_A, {}),
            software(TOKEN_A, { items: [{ name: "" }] }),
            software(TOKEN_A, { items: [{ name: "x", extra: 1 }] }),
            { query: softwareState },
            software(TOKEN_A, { items: [{ name: "   " }] }),
            { query: softwareState },
            software(TOKEN_A, { items: [{ name: "e" }] }),
            software(TOKEN_A, { items: [] }),
            { query: softwareState },
        ],
    },
    "agent tasks": {
        tables: ["agent_tasks", "agent_task_runs", "agent_task_results"],
        queries: [taskState, runState],
        steps: [
            next(null),
            next(TOKEN_A),
            { sql: taskSeed },
            next("nope"),
            next(TOKEN_A, { r2: "run.id" }),
            { query: taskState },
            next(TOKEN_A, { r3: "run.id" }),
            next(TOKEN_B, { rb: "run.id" }),
            { query: runState },
            // Another agent's token, then mismatched ids: all safe no-ops.
            complete(TOKEN_A, { taskId: T_B, runId: "{rb}", status: "succeeded", stdout: "stolen" }),
            complete(TOKEN_B, { taskId: T2, runId: "{r2}", status: "failed", stdout: "stolen" }),
            complete(TOKEN_A, { taskId: T2, runId: "{r3}", status: "failed", stdout: "mismatch" }),
            complete(TOKEN_A, { taskId: UNKNOWN, runId: UNKNOWN, status: "failed" }),
            { query: taskState },
            { query: runState },
            complete(null, { taskId: T2, runId: "{r2}", status: "failed" }),
            complete(TOKEN_A, { runId: "{r2}", status: "failed" }),
            complete(TOKEN_A, { taskId: T2, status: "failed" }),
            complete(TOKEN_A, { taskId: T2, runId: "{r2}" }),
            complete(TOKEN_A, { taskId: T2, runId: "{r2}", status: "running" }),
            complete(TOKEN_A, { taskId: "nope", runId: "{r2}", status: "failed" }),
            complete(TOKEN_A, { taskId: T2, runId: "nope", status: "failed" }),
            complete(TOKEN_A, { taskId: UNKNOWN, runId: "nope", status: "failed" }),
            complete(TOKEN_A, { taskId: T2, runId: "{r2}", status: "failed", stdout: "a\u0000b" }),
            complete(TOKEN_A, { taskId: T2, runId: "{r2}", status: "failed", output: { x: "a\u0000b" } }),
            { query: taskState },
            { query: runState },
            complete(TOKEN_A, { taskId: T2, runId: "{r2}", status: "succeeded", stdout: "out", stderr: "err", output: { a: 1 }, artifacts: { b: 2 } }),
            { query: taskState },
            { query: runState },
            // Completing again overwrites results but keeps the saved output.
            complete(TOKEN_A, { taskId: T2, runId: "{r2}", status: "failed", stdout: 5 }),
            { query: taskState },
            { query: runState },
            complete(TOKEN_A, { taskId: T3, runId: "{r3}", status: "cancelled", artifacts: { only: true } }),
            complete(TOKEN_B, { taskId: T_B, runId: "{rb}", status: "failed" }),
            { query: runState },
            next(TOKEN_A, { r1: "run.id" }),
            next(TOKEN_A),
            complete(TOKEN_A, { taskId: T1, runId: "{r1}", status: "succeeded" }),
            // A requeued task keeps started_at and gets the next attempt number.
            { sql: `UPDATE agent_tasks SET status='pending' WHERE id='${T1}'` },
            next(TOKEN_A),
            { query: taskState },
            { query: runState },
            next(TOKEN_A),
        ],
    },
    "admin jobs": {
        tables: ["jobs", "job_results"],
        queries: [jobState],
        steps: [
            key(null, "POST", "/api/admin/agents"),
            key("nope", "POST", "/api/admin/agents"),
            { ...runScript({ agentId: AGENT, language: "bash", scriptText: "x" }), adminKey: undefined },
            { ...runScript({ agentId: AGENT, language: "bash", scriptText: "x" }), adminKey: "nope" },
            runScript({ agentId: AGENT, language: "bash", scriptText: "echo 1", args: ["a"], env: { K: "V" }, timeoutSec: 300 }, { j1: "id" }),
            runScript({ agentUuid: AGENT2_UUID, language: "powershell", scriptText: "echo 2" }, { j2: "id" }),
            runScript({ agentUuid: AGENT, language: "bash", scriptText: "echo 3" }, { j3: "id" }),
            runScript({ agentId: AGENT, language: "bash", scriptText: "echo 4" }, { j4: "id" }),
            runScript({ agentId: AGENT, language: "bash", scriptText: "echo 5" }, { j5: "id" }),
            runScript({ agentId: AGENT, language: "bash", scriptText: "echo 6" }, { j6: "id" }),
            { query: jobState },
            runScript({ agentUuid: "nope", language: "bash", scriptText: "x" }),
            runScript({ agentId: "nope", language: "bash", scriptText: "x" }),
            runScript({ agentId: UNKNOWN, language: "bash", scriptText: "x" }),
            runScript({ agentId: AGENT.toUpperCase(), language: "bash", scriptText: "x" }),
            runScript({ language: "bash", scriptText: "x" }),
            runScript({ agentId: AGENT, scriptText: "x" }),
            runScript({ agentId: AGENT, language: "bash", scriptText: "  " }),
            runScript({ agentId: AGENT, language: "bash", scriptText: 5 }),
            runScript({ agentId: AGENT, language: "bash", scriptText: "a\u0000b" }),
            fileOp({ agentId: AGENT, op: "roots" }),
            fileOp({ agentId: AGENT, op: "list", path: "/tmp", recursive: true }),
            fileOp({ agentId: AGENT, op: "read", path: "/tmp/a", maxBytes: 10 }),
            fileOp({ agentUuid: AGENT2_UUID, op: "write", path: "/tmp/a", contentBase64: "QQ==" }),
            fileOp({ agentId: AGENT, op: "move", path: "/a", path2: "/b" }),
            fileOp({ agentId: AGENT, op: "move", path: "/a" }),
            fileOp({ agentId: AGENT, op: "write", path: "/a" }),
            fileOp({ agentId: AGENT, op: "list" }),
            fileOp({ agentId: AGENT }),
            fileOp({ agentId: "nope", op: "roots" }),
            { query: jobState },
            // Reads, before any result exists.
            readJob("{j1}"),
            { ...readJob("{j1}"), adminKey: "nope" },
            { ...readJob("{j1}"), adminKey: undefined },
            readJob("nope"),
            readJob(UNKNOWN),
            get("/api/jobs/{j1}"),
            get("/api/jobs/{j1}", viewerCookie),
            get("/api/jobs/{j1}", null),
            get("/api/jobs/nope"),
            get(`/api/jobs/${UNKNOWN}`),
        ],
    },
    "agent job reports": {
        tables: ["jobs", "job_results"],
        queries: [jobState],
        steps: [
            running(null, "{j1}"),
            running(TOKEN_B, "{j1}"),
            running(TOKEN_A, "nope"),
            running(TOKEN_A, UNKNOWN),
            { query: jobState },
            running(TOKEN_A, "{j1}"),
            readJob("{j1}"),
            running(TOKEN_A, "{j1}"),
            finish(null, "{j1}", { status: "succeeded" }),
            finish(TOKEN_B, "{j1}", { status: "succeeded", exitCode: 0, stdout: "stolen", stderr: "", durationMs: 1 }),
            finish(TOKEN_A, "nope", { status: "succeeded", exitCode: 0, stdout: "", stderr: "", durationMs: 1 }),
            finish(TOKEN_A, UNKNOWN, { status: "succeeded", exitCode: 0, stdout: "", stderr: "", durationMs: 1 }),
            finish(TOKEN_A, "{j1}", { status: "nope" }),
            finish(TOKEN_A, "{j1}", {}),
            { query: jobState },
            finish(TOKEN_A, "{j1}", { status: "succeeded", exitCode: 0, stdout: "{\"ok\":\u0000true}", stderr: "e\u0000", durationMs: 1500 }),
            readJob("{j1}"),
            get("/api/jobs/{j1}"),
            finish(TOKEN_A, "{j1}", { status: "failed", exitCode: 1, stdout: "again", stderr: "", durationMs: 2 }),
            running(TOKEN_A, "{j1}"),
            { query: jobState },
            // From queued straight to finished, with junk fields coerced.
            finish(TOKEN_B, "{j2}", { status: "failed", exitCode: 1.5, stdout: 5, stderr: null, durationMs: "9" }),
            readJob("{j2}"),
            finish(TOKEN_A, "{j3}", { status: "timeout", exitCode: 124, stdout: "not json", stderr: "", durationMs: -5 }),
            readJob("{j3}"),
            // Values the column rejects leave the job active.
            finish(TOKEN_A, "{j4}", { status: "succeeded", exitCode: 3000000000, stdout: "", stderr: "", durationMs: 1 }),
            finish(TOKEN_A, "{j5}", { status: "succeeded", exitCode: 0, stdout: "", stderr: "", durationMs: 1e30 }),
            { query: jobState },
            readJob("{j4}"),
            // A result row already there is replaced.
            { sql: `INSERT INTO job_results (job_id, exit_code, stdout) SELECT id, 9, 'old' FROM jobs WHERE id='{j6}'` },
            finish(TOKEN_A, "{j6}", { status: "succeeded", exitCode: 0, stdout: "new", stderr: "", durationMs: 5 }),
            readJob("{j6}"),
            { query: jobState },
        ],
    },
    "job dispatch": {
        tables: ["jobs", "job_results"],
        queries: [jobState],
        steps: [
            { sql: jobSeed },
            // Connecting dispatches queued jobs in order and fails the invalid ones.
            { wsKeep: "agent2", path: "/ws/agent", headers: { authorization: `Bearer ${TOKEN_B}` }, send: [{ t: "agent_hello", agentId: AGENT2 }] },
            { wsDrain: "agent2", wait: 1500 },
            { query: jobState },
            runScript({ agentUuid: AGENT2_UUID, language: "bash", scriptText: "live", timeoutSec: 30 }, { live: "id" }),
            { wsDrain: "agent2", wait: 800 },
            { query: jobState },
            readJob(J_SCRIPT),
            readJob(J_BAD_SCRIPT),
            { wsClose: "agent2" },
        ],
    },
    "remote console": {
        tables: ["agents"],
        steps: [
            post("/api/remote-console/sessions", { agentId: AGENT }),
            { ...post("/api/remote-console/sessions", { agentId: AGENT }), cookie: null },
            { path: "/api/remote-console/debug", cookie: null },
            post("/api/remote-console/sessions", {}),
            post("/api/remote-console/sessions", { agentId: "nope" }),
            post("/api/remote-console/sessions", { agentId: UNKNOWN }),
            post("/api/remote-console/sessions", { agentId: AGENT.toUpperCase() }),
            { ...post("/api/remote-console/sessions", { agentId: AGENT }), capture: { s1: "sessionId", t1: "sessionToken" } },
            { ...post("/api/remote-console/sessions", { agentId: AGENT2_UUID }), capture: { s2: "sessionId", t2: "sessionToken" } },
            once(RC, rcAgent(AGENT, TOKEN_A)),
            once(RC, rcAgent(AGENT2_UUID, TOKEN_B)),
            once(RC, rcAgent(AGENT, TOKEN_B)),
            once(RC, rcAgent(AGENT2_UUID, "wrong")),
            once(RC, rcAgent(AGENT2, TOKEN_A)),
            once(RC, rcAgent(UNKNOWN, TOKEN_A)),
            once(RC, rcAgent("nope", TOKEN_A)),
            once(RC, rcAgent(AGENT, "")),
            once(RC, rcAgent("", TOKEN_A)),
            once(RC, { type: "hello", kind: "wat" }),
            once(RC, rcTech("nope", "nope")),
            once(RC, rcTech("{s1}", "wrong")),
            { wsKeep: "rcAgent", path: RC, send: [rcAgent(AGENT, TOKEN_A)] },
            { wsDrain: "rcAgent", wait: 400 },
            { wsKeep: "rcTech", path: RC, send: [rcTech("{s1}", "{t1}")] },
            { wsDrain: "rcTech", wait: 400 },
            { wsDrain: "rcAgent", wait: 100 },
            get("/api/remote-console/debug"),
            { wsClose: "rcTech" },
            { wsClose: "rcAgent" },
            { pause: 300 },
            get("/api/remote-console/debug"),
        ],
    },
    "remote desktop": {
        tables: ["agents"],
        steps: [
            get("/api/remote-desktop/sessions", null),
            get("/api/remote-desktop/sessions"),
            get("/api/remote-desktop/sessions", viewerCookie),
            ...[
                {},
                { deviceId: DEVICE, agentUuid: AGENT },
                { deviceId: "nope" },
                { deviceId: DEVICE.toUpperCase() },
                { deviceId: UNKNOWN },
                { deviceId: DEVICE_NO_AGENT },
                { deviceId: DEVICE },
                { agentUuid: "nope" },
                { agentUuid: AGENT },
            ].map((body) => ({ ...post("/api/remote-desktop/sessions", body), cookie: viewerCookie })),
            once(RD, rdHello(AGENT, TOKEN_A)),
            once(RD, rdHello(AGENT2_UUID, TOKEN_B)),
            once(RD, rdHello(AGENT, TOKEN_B)),
            once(RD, rdHello(AGENT2_UUID, "wrong")),
            once(RD, rdHello(UNKNOWN, TOKEN_A)),
            once(RD, rdHello("nope", TOKEN_A)),
            once(RD, rdHello(AGENT, "")),
            once(RD, rdHello("", TOKEN_A)),
            { wsKeep: "rd", path: RD, send: [rdHello(AGENT, TOKEN_A)], ackRdp: true },
            { wsDrain: "rd", wait: 400 },
            { ...get("/api/remote-desktop/sessions", viewerCookie), sortAgents: true },
            { ...post("/api/remote-desktop/sessions", { deviceId: DEVICE, host: "10.0.0.9", port: 3390 }), cookie: viewerCookie, capture: { rd1: "sessionId" } },
            { ...post("/api/remote-desktop/sessions", { deviceId: DEVICE }), cookie: viewerCookie },
            { wsDrain: "rd", wait: 200 },
            get("/api/remote-desktop/sessions/{rd1}/rdp", viewerCookie),
            get("/api/remote-desktop/sessions/{rd1}/rdp"),
            get("/api/remote-desktop/sessions/nope/rdp", viewerCookie),
            del("/api/remote-desktop/sessions/{rd1}", viewerCookie),
            { pause: 200 },
            { ...post("/api/remote-desktop/sessions", { agentUuid: AGENT }), cookie: viewerCookie, capture: { rd2: "sessionId" } },
            del("/api/remote-desktop/sessions/{rd2}", viewerCookie),
            { wsClose: "rd" },
            // Agent with a non-UUID agent_uuid, and one with an empty agent_uuid.
            { wsKeep: "rd2", path: RD, send: [rdHello(AGENT2_UUID, TOKEN_B)], ackRdp: true },
            { wsDrain: "rd2", wait: 400 },
            { ...post("/api/remote-desktop/sessions", { deviceId: DEVICE2 }), cookie: viewerCookie, capture: { rd3: "sessionId" } },
            { wsClose: "rd2" },
            { pause: 200 },
            { sql: `UPDATE agents SET agent_uuid='' WHERE id='${AGENT3}'` },
            { wsKeep: "rd3", path: RD, send: [rdHello(AGENT3, TOKEN_C)], ackRdp: true },
            { wsDrain: "rd3", wait: 400 },
            { ...post("/api/remote-desktop/sessions", { deviceId: DEVICE3 }), cookie: viewerCookie, capture: { rd4: "sessionId" } },
            { wsDrain: "rd3", wait: 200 },
            del("/api/remote-desktop/sessions/{rd4}", viewerCookie),
            { wsClose: "rd3" },
            { pause: 200 },
            get("/api/remote-desktop/sessions", viewerCookie),
        ],
    },
};

async function rows(db, table) {
    const { rows: found } = await db.query(`SELECT * FROM ${table}`);
    // Generated ids change per database, so order by normalized content.
    return found.map(normalize).map((r) => JSON.stringify(r)).sort();
}
async function queryRows(db, sql) {
    const { rows: found } = await db.query(sql);
    return found.map(normalize);
}

// The old sweep statement, kept here so the new one can be compared on the same rows.
const OLD_SWEEP = `
  WITH expired AS (
    UPDATE jobs
       SET status = 'timeout', finished_at = now()
     WHERE status IN ('dispatched', 'running')
       AND COALESCE(started_at, dispatched_at) + make_interval(secs =>
             LEAST(
               CASE WHEN payload->>'timeoutSec' ~ '^[0-9]{1,9}$'
                    THEN (payload->>'timeoutSec')::double precision
                    ELSE 120::double precision
               END,
               86400::double precision
             ) + 60::double precision
           ) < now()
    RETURNING id
  ), results AS (
    INSERT INTO job_results (job_id, exit_code, stdout, stderr, duration_ms)
    SELECT id, -1, '', 'Timed out: the agent did not report a result.', 0
      FROM expired
    ON CONFLICT (job_id) DO NOTHING
  )
  SELECT count(*)::text AS expired FROM expired`;

const SWEEP_CASES = [
    // [name, status, payload, started seconds ago, dispatched seconds ago, should time out]
    ["old running, default timeout", "running", {}, 600, null, true],
    ["running inside default timeout plus grace", "running", {}, 100, 300, false],
    ["dispatched, no started_at, past default", "dispatched", {}, null, 200, true],
    ["dispatched inside default", "dispatched", {}, null, 100, false],
    ["started_at wins over dispatched_at", "running", {}, 10, 5000, false],
    ["long timeoutSec not reached", "running", { timeoutSec: 600 }, 300, null, false],
    ["long timeoutSec passed", "running", { timeoutSec: 600 }, 700, null, true],
    ["string timeoutSec", "running", { timeoutSec: "30" }, 100, null, true],
    ["zero timeoutSec keeps grace only", "running", { timeoutSec: 0 }, 30, null, false],
    ["zero timeoutSec past grace", "running", { timeoutSec: 0 }, 90, null, true],
    ["junk timeoutSec uses default, inside", "running", { timeoutSec: "abc" }, 100, null, false],
    ["junk timeoutSec uses default, past", "running", { timeoutSec: "abc" }, 200, null, true],
    ["fractional uses default, inside", "running", { timeoutSec: 1.5 }, 100, null, false],
    ["negative uses default, inside", "running", { timeoutSec: -5 }, 100, null, false],
    ["array value uses default, inside", "running", { timeoutSec: [5] }, 100, null, false],
    ["bool value uses default, inside", "running", { timeoutSec: true }, 100, null, false],
    ["ten digits uses default, inside", "running", { timeoutSec: 1234567890 }, 100, null, false],
    ["payload array uses default, past", "running", [1], 200, null, true],
    ["huge timeoutSec capped, past cap", "running", { timeoutSec: 999999999 }, 86400 + 90, null, true],
    ["huge timeoutSec capped, inside cap", "running", { timeoutSec: 999999999 }, 86400 + 10, null, false],
    ["no timestamps at all", "running", {}, null, null, false],
    ["queued is left alone", "queued", {}, 5000, 5000, false],
    ["succeeded is left alone", "succeeded", {}, 5000, 5000, false],
    ["existing result is kept", "running", {}, 900, null, true],
];

async function seedSweepCases(db) {
    const ids = [];
    for (const [i, [, status, payload, started, dispatched]] of SWEEP_CASES.entries()) {
        const id = `a0000000-0000-4000-8000-0000000003${String(i).padStart(2, "0")}`;
        ids.push(id);
        await db.query(
            `INSERT INTO jobs (id, agent_id, type, payload, status, started_at, dispatched_at)
             VALUES ($1,$2,'RUN_SCRIPT',$3::jsonb,$4,
                     CASE WHEN $5::int IS NULL THEN NULL ELSE now() - make_interval(secs => $5::int) END,
                     CASE WHEN $6::int IS NULL THEN NULL ELSE now() - make_interval(secs => $6::int) END)`,
            [id, AGENT3, JSON.stringify(payload), status, started, dispatched],
        );
    }
    await db.query(
        `INSERT INTO job_results (job_id, exit_code, stdout, stderr, duration_ms) VALUES ($1, 7, 'kept', 'kept', 42)`,
        [ids[SWEEP_CASES.length - 1]],
    );
    return ids;
}
const sweepRows = async (db) =>
    (await db.query(
        `SELECT j.id, j.status, j.finished_at IS NOT NULL AS finished, r.exit_code, r.stdout, r.stderr, r.duration_ms
           FROM jobs j LEFT JOIN job_results r ON r.job_id = j.id
          WHERE j.id::text LIKE 'a0000000-0000-4000-8000-0000000003%' ORDER BY j.id`,
    )).rows;

async function main() {
    const mode = process.argv[2];
    const dbA = new Client({ connectionString: DB_A });
    const dbB = new Client({ connectionString: DB_B });
    await Promise.all([dbA.connect(), dbB.connect()]);

    if (mode === "seed") {
        await seedDb(dbA);
        await seedDb(dbB);
        await Promise.all([dbA.end(), dbB.end()]);
        console.log("seeded");
        return;
    }
    assert.equal(mode, "run", "usage: parity-batch3.e2e.cjs seed|run");

    let compared = 0;
    let succeeded = 0;
    const failures = [];
    const fail = (label, a, b) => {
        failures.push(label);
        console.log(`  DIFF  ${label}\n        A: ${JSON.stringify(a).slice(0, 500)}\n        B: ${JSON.stringify(b).slice(0, 500)}`);
    };
    const same = (a, b) => {
        try {
            assert.deepEqual(a, b);
            return true;
        } catch {
            return false;
        }
    };

    const varsA = {};
    const varsB = {};
    const socketsA = {};
    const socketsB = {};
    const compare = (label, a, b) => {
        compared++;
        if (!same(a, b)) fail(label, a, b);
    };

    for (const [name, mod] of Object.entries(MODULES)) {
        console.log(name);
        const before = failures.length;
        let ok2xx = 0;
        for (const [i, step] of mod.steps.entries()) {
            const label = `${name} step ${i}`;
            if (step.sql) {
                await dbA.query(fill(step.sql, varsA));
                await dbB.query(fill(step.sql, varsB));
            } else if (step.query) {
                const [a, b] = await Promise.all([queryRows(dbA, fill(step.query, varsA)), queryRows(dbB, fill(step.query, varsB))]);
                compare(`${label}: rows ${step.query.slice(0, 60)}`, a, b);
            } else if (step.pause) {
                await sleep(step.pause);
            } else if (step.wsOnce) {
                const go = async (base, vars) => {
                    const s = await openSocket(base, step.wsOnce, { send: step.send, headers: step.headers }, vars);
                    await sleep(step.wait ?? 500);
                    const view = wsView(s);
                    s.ws.close();
                    return view;
                };
                const [a, b] = await Promise.all([go(BASE_A, varsA), go(BASE_B, varsB)]);
                compare(`${label}: ws ${step.wsOnce} ${JSON.stringify(step.send).slice(0, 80)}`, a, b);
                if (a.messages.some((m) => m.type === "hello.ok")) ok2xx++;
            } else if (step.wsKeep) {
                const opts = { send: step.send, headers: step.headers, ackRdp: step.ackRdp };
                [socketsA[step.wsKeep], socketsB[step.wsKeep]] = await Promise.all([
                    openSocket(BASE_A, step.path, opts, varsA),
                    openSocket(BASE_B, step.path, opts, varsB),
                ]);
            } else if (step.wsDrain) {
                await sleep(step.wait ?? 300);
                const drain = (s) => {
                    const view = wsView(s);
                    s.messages = [];
                    return view;
                };
                const a = drain(socketsA[step.wsDrain]);
                const b = drain(socketsB[step.wsDrain]);
                compare(`${label}: ws messages on ${step.wsDrain}`, a, b);
                if (a.messages.length) ok2xx++;
            } else if (step.wsClose) {
                socketsA[step.wsClose].ws.close();
                socketsB[step.wsClose].ws.close();
            } else {
                const [a, b] = await Promise.all([request(BASE_A, step, varsA), request(BASE_B, step, varsB)]);
                compared++;
                if (a.status < 300) ok2xx++;
                if (a.status !== b.status || !same(a.body, b.body)) {
                    fail(`${label}: ${step.method ?? "GET"} ${step.path}`, { status: a.status, body: a.body }, { status: b.status, body: b.body });
                }
            }
        }
        for (const sql of mod.queries ?? []) {
            const [a, b] = await Promise.all([queryRows(dbA, sql), queryRows(dbB, sql)]);
            compare(`${name} final rows: ${sql.slice(0, 60)}`, a, b);
        }
        for (const table of mod.tables) {
            const [a, b] = await Promise.all([rows(dbA, table), rows(dbB, table)]);
            compare(`${name} rows: ${table}`, a, b);
        }
        if (ok2xx === 0) fail(`${name}: no step succeeded, so nothing real was compared`, 0, 0);
        succeeded += ok2xx;
        if (failures.length === before) console.log(`  ok    ${mod.steps.length} steps, ${ok2xx} successful`);
    }

    console.log("expected differences");
    {
        const adminAgents = key(ADMIN_KEY, "POST", "/api/admin/agents");
        const [a, b] = await Promise.all([request(BASE_A, adminAgents), request(BASE_B, adminAgents)]);
        console.log(`  info  POST /api/admin/agents: old ${a.status}, new ${b.status}`);
        if (a.status !== 500 || b.status >= 300) fail("/api/admin/agents: expected old 500 and new 2xx", a.status, b.status);
        const first = b.raw?.items?.find((x) => x.id === AGENT2);
        if (first?.arch !== "arm64" || first?.os !== null || first?.agent_uuid !== AGENT2_UUID || "facts" in (first ?? {})) {
            fail("/api/admin/agents returns os and arch from facts", null, first);
        }
        const count = b.raw?.items?.length;
        if (count !== 3) fail("/api/admin/agents lists every agent", 3, count);
        const order = b.raw?.items?.map((x) => x.created_at);
        if (!same(order, [...order].sort().reverse())) fail("/api/admin/agents orders newest first", null, order);

        // A fractional duration used to fail the bigint insert and leave the job stuck.
        const enqueue = runScript({ agentId: AGENT, language: "bash", scriptText: "frac" }, { frac: "id" });
        await Promise.all([request(BASE_A, enqueue, varsA), request(BASE_B, enqueue, varsB)]);
        const report = finish(TOKEN_A, "{frac}", { status: "succeeded", exitCode: 0, stdout: "", stderr: "", durationMs: 12.9 });
        const [fa, fb] = await Promise.all([request(BASE_A, report, varsA), request(BASE_B, report, varsB)]);
        console.log(`  info  fractional durationMs: old ${fa.status}, new ${fb.status}`);
        if (fa.status !== 500 || fb.status !== 204) fail("fractional durationMs: expected old 500 and new 204", fa.status, fb.status);
        const read = readJob("{frac}");
        const [ra, rb] = await Promise.all([request(BASE_A, read, varsA), request(BASE_B, read, varsB)]);
        if (ra.raw.status !== "queued" || rb.raw.status !== "succeeded" || rb.raw.duration_ms !== "12") {
            fail("fractional durationMs: old stays queued, new stores 12", ra.raw.status, [rb.raw.status, rb.raw.duration_ms]);
        }

        // A bad item used to leave the inventory empty; now the previous one survives.
        const good = software(TOKEN_C, { items: [{ name: "kept" }] });
        await Promise.all([request(BASE_A, good), request(BASE_B, good)]);
        const bad = software(TOKEN_C, { items: [{ name: "broken", installDate: "2024-13-45" }] });
        const [sa, sb] = await Promise.all([request(BASE_A, bad), request(BASE_B, bad)]);
        console.log(`  info  software with an impossible date: old ${sa.status}, new ${sb.status}`);
        const inv = async (db) => (await db.query(`SELECT name FROM agent_software WHERE agent_id=$1`, [AGENT3])).rows.map((r) => r.name);
        const [ia, ib] = await Promise.all([inv(dbA), inv(dbB)]);
        if (sa.status !== 500 || sb.status !== 500 || !same(ia, []) || !same(ib, ["kept"])) {
            fail("bad software item: old empties the inventory, new keeps it", [sa.status, ia], [sb.status, ib]);
        }
        compared += 4;
    }

    console.log("concurrency over HTTP");
    {
        const ids = ["a0000000-0000-4000-8000-000000000401", "a0000000-0000-4000-8000-000000000402"];
        for (const id of ids) {
            await dbB.query(`INSERT INTO agent_tasks (id, agent_id, type, payload) VALUES ($1,$2,'script','{}')`, [id, AGENT2]);
        }
        const burst = await Promise.all(Array.from({ length: 8 }, () => request(BASE_B, next(TOKEN_B))));
        const got = burst.map((r) => r.raw?.task?.id).filter(Boolean).sort();
        if (burst.some((r) => r.status >= 300) || !same(got, ids)) fail("8 HTTP claims over 2 tasks give 2 distinct tasks", ids, burst.map((r) => [r.status, r.raw?.task?.id]));
        else console.log("  ok    8 HTTP claims gave 2 distinct tasks");
    }

    console.log("sweeper: new code against the old statement");
    let directPrisma = null;
    if (process.env.DIST_B) {
        process.env.DATABASE_URL = DB_B;
        const load = (p) => require(`${process.env.DIST_B}/${p}`);
        const { PrismaService } = load("storage/prisma.service.js");
        const prisma = (directPrisma = new PrismaService());
        const check = async (label, fn) => {
            compared++;
            try {
                await fn();
                console.log(`  ok    ${label}`);
            } catch (e) {
                fail(label, "", String(e?.message ?? e));
            }
        };

        const { JobSweeperService } = load("jobs/job-sweeper.service.js");
        const sweeper = new JobSweeperService(prisma);
        await seedSweepCases(dbA);
        const ids = await seedSweepCases(dbB);
        const expectedCount = SWEEP_CASES.filter((c) => c[5]).length;
        await dbA.query(OLD_SWEEP);
        const [first, second] = await Promise.all([sweeper.sweep(), sweeper.sweep()]);
        const [oldRows, newRows] = await Promise.all([sweepRows(dbA), sweepRows(dbB)]);
        await check("sweeper rows match the old statement", async () => assert.deepEqual(newRows, oldRows));
        for (const [i, c] of SWEEP_CASES.entries()) {
            await check(`sweeper: ${c[0]}`, async () => {
                const row = newRows.find((r) => r.id === ids[i]);
                assert.equal(row.status, c[5] ? "timeout" : c[1]);
                assert.equal(row.finished, c[5]);
                if (i === SWEEP_CASES.length - 1) {
                    assert.deepEqual([row.exit_code, row.stdout, row.stderr, row.duration_ms], [7, "kept", "kept", "42"]);
                } else if (c[5]) {
                    assert.deepEqual([row.exit_code, row.stdout, row.stderr, row.duration_ms], [-1, "", "Timed out: the agent did not report a result.", "0"]);
                } else {
                    assert.equal(row.exit_code, null);
                }
            });
        }
        await check("parallel sweeps count each job once", async () => {
            // The build's own timer may sweep first, so only an upper bound is exact.
            assert.ok(first + second <= expectedCount, `${first}+${second} > ${expectedCount}`);
            assert.equal(await sweeper.sweep(), 0);
        });
        await check("sweep returns the number of jobs it timed out", async () => {
            await dbB.query(
                `INSERT INTO jobs (agent_id, type, status, started_at) VALUES ($1,'RUN_SCRIPT','running', now() - interval '1 hour'), ($1,'RUN_SCRIPT','running', now() - interval '1 hour')`,
                [AGENT3],
            );
            assert.equal(await sweeper.sweep(), 2);
        });
        await check("sweep skips a job that finished after the read", async () => {
            const [row] = (await dbB.query(
                `INSERT INTO jobs (agent_id, type, status, started_at) VALUES ($1,'RUN_SCRIPT','running', now() - interval '1 hour') RETURNING id`,
                [AGENT3],
            )).rows;
            const racing = {
                jobs: {
                    findMany: async (args) => {
                        const found = await prisma.jobs.findMany(args);
                        await dbB.query(`UPDATE jobs SET status='succeeded' WHERE id=$1`, [row.id]);
                        return found;
                    },
                },
                $transaction: (fn) => prisma.$transaction(fn),
            };
            assert.equal(await new JobSweeperService(racing).sweep(), 0);
            const { rows: after } = await dbB.query(`SELECT status FROM jobs WHERE id=$1`, [row.id]);
            assert.equal(after[0].status, "succeeded");
        });

        console.log("direct calls (new build)");
        const { AgentsTasksService } = load("agents/agents.tasks.service.js");
        const { AgentsService } = load("agents/agents.service.js");
        const { JobsService } = load("jobs/jobs.service.js");
        const tasks = new AgentsTasksService(prisma);
        const agents = new AgentsService(prisma);
        const jobs = new JobsService(prisma, { tryDispatch: async () => {} });

        await check("8 parallel claims over 2 tasks give 2 distinct claims", async () => {
            const ids = ["a0000000-0000-4000-8000-000000000411", "a0000000-0000-4000-8000-000000000412"];
            for (const id of ids) {
                await dbB.query(`INSERT INTO agent_tasks (id, agent_id, type, payload) VALUES ($1,$2,'script','{}')`, [id, AGENT3]);
            }
            const claims = await Promise.all(Array.from({ length: 8 }, () => tasks.claimNext(AGENT3)));
            const won = claims.filter(Boolean);
            assert.deepEqual(won.map((c) => c.task.id).sort(), ids);
            assert.equal(new Set(won.map((c) => c.run.id)).size, 2);
            assert.ok(won.every((c) => c.run.attempt === 1 && c.task.status === "running" && c.run.status === "running"));
            const { rows: runs } = await dbB.query(`SELECT count(*)::int AS n FROM agent_task_runs WHERE task_id = ANY($1::uuid[])`, [ids]);
            assert.equal(runs[0].n, 2);
        });
        await check("20 rounds of parallel claims never share a task", async () => {
            for (let round = 0; round < 20; round++) {
                const { rows: seeded } = await dbB.query(
                    `INSERT INTO agent_tasks (agent_id, type, payload) SELECT $1,'script','{}' FROM generate_series(1,3) RETURNING id`,
                    [AGENT3],
                );
                const claims = (await Promise.all(Array.from({ length: 6 }, () => tasks.claimNext(AGENT3)))).filter(Boolean);
                assert.deepEqual(claims.map((c) => c.task.id).sort(), seeded.map((s) => s.id).sort());
            }
        });
        await check("claims follow COALESCE(queued_at, created_at), then attempt grows", async () => {
            const { rows: seeded } = await dbB.query(
                `INSERT INTO agent_tasks (agent_id, type, payload, status, queued_at, created_at) VALUES
                   ($1,'script','{"o":2}','pending',NULL,'2020-01-02'),
                   ($1,'script','{"o":1}','queued','2020-01-01','2030-01-01'),
                   ($1,'script','{"o":3}','pending','2020-01-03','2019-01-01')
                 RETURNING id`,
                [AGENT3],
            );
            const order = [];
            for (let i = 0; i < 3; i++) order.push((await tasks.claimNext(AGENT3)).task.payload.o);
            assert.deepEqual(order, [1, 2, 3]);
            await dbB.query(`UPDATE agent_tasks SET status='queued' WHERE id=$1`, [seeded[0].id]);
            assert.equal((await tasks.claimNext(AGENT3)).run.attempt, 2);
            assert.equal(await tasks.claimNext(AGENT3), null);
        });
        await check("completeRun: another agent is a no-op, null artifacts are SQL NULL", async () => {
            await dbB.query(`INSERT INTO agent_tasks (agent_id, type, payload) VALUES ($1,'script','{}')`, [AGENT3]);
            const claim = await tasks.claimNext(AGENT3);
            const args = { taskId: claim.task.id, runId: claim.run.id, status: "succeeded", stdout: "o", stderr: null, output: null, artifacts: null };
            await tasks.completeRun({ ...args, agentId: AGENT });
            const state = async () => (await dbB.query(
                `SELECT t.status AS task, t.completed_at IS NOT NULL AS done, r.status AS run, x.run_id IS NOT NULL AS has_result, x.artifacts IS NULL AS sql_null
                   FROM agent_tasks t JOIN agent_task_runs r ON r.task_id=t.id LEFT JOIN agent_task_results x ON x.run_id=r.id WHERE t.id=$1`,
                [claim.task.id],
            )).rows[0];
            assert.deepEqual(await state(), { task: "running", done: false, run: "running", has_result: false, sql_null: true });
            await tasks.completeRun({ ...args, agentId: AGENT3 });
            assert.deepEqual(await state(), { task: "succeeded", done: true, run: "succeeded", has_result: true, sql_null: true });
        });
        await check("completeRun: only terminal statuses set completed_at", async () => {
            await dbB.query(`INSERT INTO agent_tasks (agent_id, type, payload) VALUES ($1,'script','{}')`, [AGENT3]);
            const claim = await tasks.claimNext(AGENT3);
            await tasks.completeRun({ agentId: AGENT3, taskId: claim.task.id, runId: claim.run.id, status: "running", stdout: null, stderr: null, output: { a: 1 }, artifacts: { b: 1 } });
            const { rows: r } = await dbB.query(
                `SELECT t.status, t.completed_at, x.artifacts FROM agent_tasks t JOIN agent_task_runs u ON u.task_id=t.id JOIN agent_task_results x ON x.run_id=u.id WHERE t.id=$1`,
                [claim.task.id],
            );
            assert.deepEqual(r, [{ status: "running", completed_at: null, artifacts: { b: 1 } }]);
        });
        await check("concurrent pings keep each other's facts", async () => {
            await dbB.query(`UPDATE agents SET facts='{}' WHERE id=$1`, [AGENT3]);
            await Promise.all([
                agents.updateFacts(AGENT3, { os: "linux" }),
                agents.updateFacts(AGENT3, { arch: "x64" }),
                agents.updateFacts(AGENT3, { primaryIp: "1.2.3.4" }),
                agents.updateFacts(AGENT3, { user: "u" }),
                agents.updateFacts(AGENT3, { facts: { d: 1 } }),
                agents.updateFacts(AGENT3, { hostname: "h" }),
            ]);
            const { rows: r } = await dbB.query(`SELECT facts FROM agents WHERE id=$1`, [AGENT3]);
            assert.deepEqual(r[0].facts, { os: "linux", arch: "x64", primary_ip: "1.2.3.4", user: "u", logged_in_user: "u", device: { d: 1 } });
        });
        await check("getAgentUuidById", async () => {
            assert.equal(await agents.getAgentUuidById(AGENT2), AGENT2_UUID);
            assert.equal(await agents.getAgentUuidById(UNKNOWN), UNKNOWN);
            assert.equal(await agents.getAgentUuidById("nope"), null);
        });
        await check("markRunning and finishJob return false for non-UUID ids and other agents", async () => {
            const result = { exitCode: 0, stdout: "", stderr: "", durationMs: 1 };
            assert.equal(await jobs.markRunning("nope"), false);
            assert.equal(await jobs.finishJob("nope", result, "failed"), false);
            const job = await jobs.enqueueJob({ agentId: AGENT3, type: "RUN_SCRIPT", payload: { a: undefined, b: 1 } });
            assert.equal(await jobs.markRunning(job.id, { agentId: "nope" }), false);
            assert.equal(await jobs.markRunning(job.id, { agentId: AGENT }), false);
            assert.equal(await jobs.finishJob(job.id, result, "failed", { agentId: "nope" }), false);
            assert.equal(await jobs.finishJob(job.id, result, "failed", { agentId: AGENT }), false);
            assert.equal(await jobs.markRunning(job.id), true);
            assert.equal(await jobs.finishJob(job.id, { ...result, durationMs: 12.9, stdout: "a\u0000b" }, "succeeded"), true);
            const read = await jobs.getJobWithResult(job.id);
            assert.equal(read.duration_ms, "12");
            assert.equal(read.stdout, "ab");
            assert.deepEqual(read.payload, { b: 1 });
            assert.equal(await jobs.finishJob(job.id, result, "failed"), false);
            JSON.stringify(read);
        });
        await check("Prisma errors do not echo stored values", async () => {
            const secret = "super-secret-value";
            let message = "";
            try {
                await prisma.agents.create({ data: { agent_token: secret } });
            } catch (e) {
                message = String(e?.message ?? e);
            }
            assert.ok(message, "expected a validation error");
            assert.ok(!message.includes(secret), "error message contains the stored value");
        });
    }
    if (directPrisma) await directPrisma.$disconnect();

    await Promise.all([dbA.end(), dbB.end()]);
    console.log(`\n${compared} comparisons (${succeeded} on successful requests), ${failures.length} failed`);
    process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
