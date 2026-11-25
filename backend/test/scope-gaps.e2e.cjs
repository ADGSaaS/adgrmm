#!/usr/bin/env node
// Customer limits on the device paths that used to check only sign-in and a permission: the remote shell socket, desktop tunnels,
// device tags, live device subscriptions on the dashboard socket and reading a job by id. A person limited to customer A must not
// reach customer B's device through any of them; a person with no limits keeps reaching both.
// It starts its own backend (RIQ_DIST, default ./dist, main.js) on PORT (default 3931). Throwaway database only:
//   RIQ_E2E_ALLOW=1 DATABASE_URL=postgres://.../riq_scope_e2e JWT_SECRET=... DATA_ENCRYPTION_KEY=... ADMIN_API_KEY=... node test/scope-gaps.e2e.cjs
"use strict";

const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const WebSocket = require("ws");

process.env.BASE_URL = `http://127.0.0.1:${process.env.PORT || 3931}`;
const { assert, BASE, uuid, call, runner, setup, sha256 } = require("./groupc-helpers.cjs");
const COOKIE = process.env.AUTH_COOKIE_NAME || "auth_token";
const WS_BASE = BASE.replace(/^http/, "ws");

async function startBackend() {
    const dist = path.resolve(process.env.RIQ_DIST || path.join(process.cwd(), "dist"));
    // This test never uses the admin key, and the backend refuses to start with a placeholder one.
    const { ADMIN_API_KEY: _unused, ...env } = process.env;
    const child = spawn(process.execPath, [path.join(dist, "main.js")], {
        env: { ...env, PORT: String(new URL(BASE).port), BIND_HOST: "127.0.0.1", NODE_ENV: "development", IMAP_POLL_ENABLED: "false", FRONTEND_ORIGINS: "", ALLOWED_ORIGIN: "" },
        stdio: ["ignore", "ignore", "pipe"],
    });
    let err = "";
    child.stderr.on("data", (d) => { err = (err + d).slice(-4000); });
    for (let i = 0; i < 120; i++) {
        if (child.exitCode !== null) throw new Error(`backend exited: ${err}`);
        try { if ((await fetch(`${BASE}/healthz`)).status < 500) return child; } catch { }
        await new Promise((r) => setTimeout(r, 500));
    }
    child.kill();
    throw new Error(`backend did not start: ${err}`);
}

/** Opens a socket and collects what happens in the first moments: messages received and the close code, if any. */
function socket(url, token, onOpen) {
    return new Promise((resolve) => {
        const ws = new WebSocket(url, { headers: { cookie: `${COOKIE}=${token}` } });
        const out = { messages: [], code: null };
        const done = () => { try { ws.close(); } catch { } resolve(out); };
        ws.on("open", () => onOpen?.(ws));
        ws.on("message", (d) => { try { out.messages.push(JSON.parse(String(d))); } catch { } });
        ws.on("close", (code) => { out.code = code; resolve(out); });
        ws.on("error", () => { });
        setTimeout(done, 2500);
    });
}

async function main() {
    const backend = await startBackend();
    const { q, org, made, staffUser, cleanup } = await setup();
    const { test, finish } = runner();
    const stamp = `SG${Date.now()}`;
    const madeTunnels = [];
    try {
        const perms = ["devices.read", "devices.write", "devices.actions", "automation.read", "policies.write"];
        const limited = await staffUser("sg-limited", perms);
        const open = await staffUser("sg-open", perms);

        const mk = async (n) => {
            const client = (await q(`INSERT INTO clients (organization_id, name) VALUES ($1,$2) RETURNING id`, [org, `${stamp} ${n}`])).rows[0].id;
            made.clients.push(client);
            const site = (await q(`INSERT INTO sites (client_id, name) VALUES ($1,'HQ') RETURNING id`, [client])).rows[0].id;
            const dev = (await q(`INSERT INTO devices (site_id, hostname, operating_system) VALUES ($1,$2,'Windows 11') RETURNING id`, [site, `${stamp}-${n}`])).rows[0].id;
            const token = crypto.randomBytes(24).toString("hex");
            const agent = (await q(`INSERT INTO agents (device_id, agent_uuid, version, last_check_in_at, facts, agent_token) VALUES ($1,$2,'1.3.28', now(), '{"os":"windows"}', $3) RETURNING id, agent_uuid`, [dev, uuid(), sha256(token)])).rows[0];
            const job = (await q(`INSERT INTO jobs (agent_id, type, payload, status, finished_at) VALUES ($1,'RUN_SCRIPT','{}','succeeded', now()) RETURNING id`, [agent.id])).rows[0].id;
            return { client, site, dev, agent: agent.id, agentUuid: agent.agent_uuid, token, job };
        };
        const A = await mk("A"), B = await mk("B");
        await q(`INSERT INTO user_client_access (user_id, client_id) VALUES ($1,$2)`, [limited.id, A.client]);
        const tag = (await q(`INSERT INTO tag_defs (organization_id, name) VALUES ($1,$2) RETURNING id`, [org, `${stamp} tag`])).rows[0].id;
        const tagged = async (dev) => (await q(`SELECT count(*)::int AS n FROM device_tags WHERE device_id = $1 AND tag_id = $2`, [dev, tag])).rows[0].n;

        // ---------------------------------------------------------------- 5: a job read by id
        console.log("jobs by id");
        await test("a limited person reads a job on their own customer's device", async () => {
            assert.equal((await call(`/api/jobs/${A.job}`, { token: limited.token })).status, 200);
        });
        await test("a limited person gets not found for another customer's job", async () => {
            assert.equal((await call(`/api/jobs/${B.job}`, { token: limited.token })).status, 404);
        });
        await test("a person with no limits still reads any job", async () => {
            const res = await call(`/api/jobs/${B.job}`, { token: open.token });
            assert.equal(res.status, 200);
            assert.equal((await res.json()).id, B.job);
        });

        // ---------------------------------------------------------------- 3: tags
        console.log("device tags");
        await test("a limited person cannot set the tags of another customer's device", async () => {
            assert.equal((await call(`/api/tags/devices/${B.dev}`, { method: "PUT", token: limited.token, body: { tagIds: [tag] } })).status, 404);
            assert.equal(await tagged(B.dev), 0);
        });
        await test("nor read them", async () => {
            assert.equal((await call(`/api/tags/devices/${B.dev}`, { token: limited.token })).status, 404);
        });
        await test("a limited person sets the tags of their own customer's device", async () => {
            assert.equal((await call(`/api/tags/devices/${A.dev}`, { method: "PUT", token: limited.token, body: { tagIds: [tag] } })).status, 200);
            assert.equal(await tagged(A.dev), 1);
        });
        await test("a bulk change with one out-of-scope device is refused as a whole", async () => {
            await q(`DELETE FROM device_tags WHERE tag_id = $1`, [tag]);
            assert.equal((await call(`/api/tags/${tag}/devices`, { method: "POST", token: limited.token, body: { deviceIds: [A.dev, B.dev] } })).status, 404);
            assert.equal(await tagged(A.dev) + await tagged(B.dev), 0);
        });
        await test("a bulk change on own devices works for a limited person", async () => {
            assert.equal((await call(`/api/tags/${tag}/devices`, { method: "POST", token: limited.token, body: { deviceIds: [A.dev] } })).status, 201);
            assert.equal(await tagged(A.dev), 1);
        });
        await test("a person with no limits tags both, singly and in bulk, and sees both in the tag's list", async () => {
            assert.equal((await call(`/api/tags/devices/${B.dev}`, { method: "PUT", token: open.token, body: { tagIds: [tag] } })).status, 200);
            assert.equal((await call(`/api/tags/${tag}/devices`, { method: "POST", token: open.token, body: { deviceIds: [A.dev, B.dev] } })).status, 201);
            const items = (await (await call(`/api/tags/${tag}/devices`, { token: open.token })).json()).items.map((x) => x.deviceId).sort();
            assert.deepEqual(items, [A.dev, B.dev].sort());
        });
        await test("the tag's device list shows a limited person only their own devices", async () => {
            const items = (await (await call(`/api/tags/${tag}/devices`, { token: limited.token })).json()).items.map((x) => x.deviceId);
            assert.deepEqual(items, [A.dev]);
        });

        // ---------------------------------------------------------------- 2: desktop tunnels
        console.log("desktop tunnels");
        for (const X of [A, B]) {
            const ws = new WebSocket(`${WS_BASE}/ws/desktop-tunnel`);
            madeTunnels.push(ws);
            await new Promise((resolve, reject) => {
                const t = setTimeout(() => reject(new Error("tunnel agent hello timed out")), 5000);
                ws.on("open", () => ws.send(JSON.stringify({ type: "hello", agentUuid: X.agent, agentToken: X.token })));
                ws.on("message", (d) => { const m = JSON.parse(String(d)); if (m.type === "hello.ok") { clearTimeout(t); resolve(); } });
                ws.on("error", reject);
            });
        }
        const agentsSeen = async (t) => (await (await call("/api/remote-desktop/sessions", { token: t.token })).json()).agents.map((s) => String(s).toLowerCase());
        await test("the connected-agents list shows a limited person only their own customer's agent", async () => {
            const seen = await agentsSeen(limited);
            assert.ok(seen.includes(A.agent) && !seen.includes(B.agent), JSON.stringify(seen));
        });
        await test("a person with no limits sees both agents", async () => {
            const seen = await agentsSeen(open);
            assert.ok(seen.includes(A.agent) && seen.includes(B.agent), JSON.stringify(seen));
        });
        await test("a limited person cannot open a tunnel through another customer's device, by device or by agent", async () => {
            assert.equal((await call("/api/remote-desktop/sessions", { method: "POST", token: limited.token, body: { deviceId: B.dev } })).status, 404);
            assert.equal((await call("/api/remote-desktop/sessions", { method: "POST", token: limited.token, body: { agentUuid: B.agent } })).status, 404);
            assert.equal((await call("/api/remote-desktop/sessions", { method: "POST", token: limited.token, body: { agentUuid: B.agentUuid } })).status, 404);
        });
        await test("a person with no limits gets past the scope check for the same device", async () => {
            // The fake agent never acknowledges, so the tunnel itself fails; what matters is that it is not "not found".
            const res = await call("/api/remote-desktop/sessions", { method: "POST", token: open.token, body: { deviceId: B.dev } });
            assert.notEqual(res.status, 404);
            assert.notEqual(res.status, 403);
        });

        // ---------------------------------------------------------------- 1: remote shell socket
        console.log("remote shell socket");
        const shell = (t, agent) => socket(`${WS_BASE}/ws/shell?role=ui&agentUuid=${agent}`, t.token);
        await test("a limited person's shell socket to another customer's device is refused", async () => {
            const r = await shell(limited, B.agentUuid);
            assert.equal(r.code, 4403, JSON.stringify(r));
            assert.ok(!r.messages.some((m) => m.type === "status"));
        });
        await test("a limited person's shell socket to their own customer's device opens", async () => {
            const r = await shell(limited, A.agent);
            assert.ok(r.messages.some((m) => m.type === "status"), JSON.stringify(r));
        });
        await test("a person with no limits opens a shell socket to either", async () => {
            const r = await shell(open, B.agentUuid);
            assert.ok(r.messages.some((m) => m.type === "status"), JSON.stringify(r));
        });

        // ---------------------------------------------------------------- 4: dashboard device subscriptions
        console.log("dashboard subscriptions");
        const subscribe = (t, deviceId) => socket(`${WS_BASE}/ws`, t.token, (ws) => setTimeout(() => ws.send(JSON.stringify({ t: "subscribe_device", deviceId })), 200));
        await test("a limited person cannot follow another customer's device", async () => {
            const r = await subscribe(limited, B.dev);
            assert.ok(!r.messages.some((m) => m.t === "subscribed"), JSON.stringify(r));
            assert.ok(r.messages.some((m) => m.t === "error" && m.error === "subscribe_failed"), JSON.stringify(r));
        });
        await test("a limited person follows their own customer's device", async () => {
            const r = await subscribe(limited, A.dev);
            assert.ok(r.messages.some((m) => m.t === "subscribed" && m.deviceId === A.dev), JSON.stringify(r));
        });
        await test("a person with no limits follows any device", async () => {
            const r = await subscribe(open, B.dev);
            assert.ok(r.messages.some((m) => m.t === "subscribed" && m.deviceId === B.dev), JSON.stringify(r));
        });

        await q(`DELETE FROM device_tags WHERE tag_id = $1`, [tag]);
        await q(`DELETE FROM tag_defs WHERE id = $1`, [tag]);
        await q(`DELETE FROM user_client_access WHERE user_id = $1`, [limited.id]);
    } finally {
        for (const ws of madeTunnels) try { ws.close(); } catch { }
        await cleanup().catch(() => { });
        backend.kill();
    }
    finish();
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
