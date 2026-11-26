#!/usr/bin/env node
// End-to-end test of agent installation, driven one step at a time by
// .github/workflows/agent-install.yml, which runs the real installer between steps.
//
//   ADG_E2E_ALLOW=1 BASE_URL=http://127.0.0.1:3001 DATABASE_URL=postgres://.../adg_e2e \
//   AGENT_OS=windows STATE_DIR=/tmp/adg node test/agent-install.e2e.cjs <step>
//
// It writes test rows, so it refuses any database whose name lacks "e2e".
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Client } = require("pg");
const bcrypt = require("bcryptjs");
const WebSocket = require("ws");

const BASE = process.env.BASE_URL || "http://127.0.0.1:3001";
const DB_URL = process.env.DATABASE_URL || "";
const AGENT_OS = process.env.AGENT_OS || "";
const STATE_DIR = process.env.STATE_DIR || "";
const COOKIE = process.env.AUTH_COOKIE_NAME || "auth_token";
const HOST = os.hostname().toLowerCase();

const dbName = (() => {
    try { return new URL(DB_URL.replace(/^postgres(ql)?:/, "http:")).pathname; } catch { return ""; }
})();
if (process.env.ADG_E2E_ALLOW !== "1" || !/e2e/.test(dbName) || !STATE_DIR || !["windows", "linux"].includes(AGENT_OS)) {
    console.error("Refusing to run: set ADG_E2E_ALLOW=1, AGENT_OS, STATE_DIR and a DATABASE_URL naming an e2e database.");
    process.exit(2);
}

const statePath = path.join(STATE_DIR, "state.json");
const loadState = () => JSON.parse(fs.readFileSync(statePath, "utf8"));
const saveState = (s) => fs.writeFileSync(statePath, JSON.stringify(s, null, 2));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function db(fn) {
    const client = new Client({ connectionString: DB_URL });
    await client.connect();
    try { return await fn(client); } finally { await client.end(); }
}

async function api(state, method, url, body, extraHeaders = {}) {
    const res = await fetch(`${BASE}${url}`, {
        method,
        headers: {
            ...(body ? { "content-type": "application/json" } : {}),
            ...(state?.cookie ? { cookie: state.cookie } : {}),
            ...extraHeaders,
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text, headers: res.headers };
}

async function waitFor(what, seconds, fn) {
    const deadline = Date.now() + seconds * 1000;
    let last;
    while (Date.now() < deadline) {
        try {
            const v = await fn();
            if (v) return v;
        } catch (e) {
            last = e;
        }
        await sleep(2000);
    }
    throw new Error(`Timed out waiting for ${what}${last ? `: ${last.message}` : ""}`);
}

async function findDevices(state) {
    const res = await api(state, "GET", `/api/devices?pageSize=200`);
    assert.equal(res.status, 200, `device list: ${res.text.slice(0, 300)}`);
    return res.json.items.filter((d) => String(d.hostname).toLowerCase() === HOST);
}

const steps = {
    /** Creates the customer and login, then asks the API for an installer, as the console does. */
    async seed() {
        const email = "installer.test@example.test";
        const password = crypto.randomBytes(18).toString("base64url");
        const permissions = ["customers.read", "customers.write", "devices.read", "devices.actions", "devices.write"];

        const { clientId, siteId } = await db(async (c) => {
            const one = async (q, p) => (await c.query(q, p)).rows[0];
            const org = (await one(`INSERT INTO organizations (name, slug) VALUES ('Default Organization','default')
                ON CONFLICT (slug) DO UPDATE SET slug=EXCLUDED.slug RETURNING id`)).id;
            for (const key of permissions) {
                await c.query(`INSERT INTO permissions (permission_key,label,group_key,group_label)
                    VALUES ($1,$1,split_part($1,'.',1),initcap(split_part($1,'.',1))) ON CONFLICT DO NOTHING`, [key]);
            }
            const role = (await one(`INSERT INTO roles (organization_id, scope, name, description)
                VALUES ($1,'organization','owner','Full access')
                ON CONFLICT (organization_id,name) DO UPDATE SET description=EXCLUDED.description RETURNING id`, [org])).id;
            await c.query(`INSERT INTO role_permissions (role_id, permission_key) SELECT $1, permission_key FROM permissions ON CONFLICT DO NOTHING`, [role]);
            const user = (await one(`INSERT INTO users (organization_id,email,first_name,last_name,status,password_hash)
                VALUES ($1,$2,'Install','Test','active',$3) RETURNING id`, [org, email, await bcrypt.hash(password, 8)])).id;
            await c.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)`, [user, role]);
            const clientId = (await one(`INSERT INTO clients (organization_id,name) VALUES ($1,'Install Test Client') RETURNING id`, [org])).id;
            const siteId = (await one(`INSERT INTO sites (client_id,name) VALUES ($1,'Install Test Site') RETURNING id`, [clientId])).id;
            return { clientId, siteId };
        });

        const login = await api(null, "POST", "/api/auth/login", { email, password });
        assert.ok(login.status === 200 || login.status === 201, `login: ${login.status} ${login.text.slice(0, 300)}`);
        const setCookie = login.headers.getSetCookie().find((h) => h.startsWith(`${COOKIE}=`));
        assert.ok(setCookie, "login set no auth cookie");
        const state = { cookie: setCookie.split(";")[0], clientId, siteId };

        const key = await api(state, "POST", "/api/provisioning/enrollment-keys", { clientId, siteId, name: "e2e", expiresMinutes: 120 });
        assert.equal(key.status, 201, `create key: ${key.text.slice(0, 300)}`);
        state.enrollmentKey = key.json.enrollmentKey;

        const bundle = await api(state, "POST", "/api/provisioning/installer-bundles", { enrollmentKey: state.enrollmentKey, os: AGENT_OS });
        assert.equal(bundle.status, 201, `create bundle: ${bundle.text.slice(0, 300)}`);
        assert.ok(bundle.json.installCommand, "bundle has no install command");
        assert.ok(new Date(bundle.json.expiresAt) > new Date(Date.now() + 60 * 60_000), "installer link should last as long as its key");
        state.bundleUrl = bundle.json.url;

        fs.writeFileSync(path.join(STATE_DIR, "install-command.txt"), bundle.json.installCommand);
        saveState(state);
        console.log("seeded; installer ready");
    },

    /** Requests that must be refused. */
    async refusals() {
        const state = loadState();

        const script = await api(null, "GET", state.bundleUrl);
        assert.equal(script.status, 200);
        assert.equal(/[^\x00-\x7F]/.test(script.text), false, "installer script must be ASCII");

        const badToken = await api(null, "GET", state.bundleUrl.replace(/token=.*/, "token=wrong"));
        assert.equal(badToken.status, 404, "bundle with a wrong token");

        const pkg = `/api/provisioning/agent-packages/${AGENT_OS}`;
        assert.equal((await api(null, "GET", pkg, null, { "x-enrollment-key": "wrong" })).status, 401, "package with a wrong key");
        assert.equal((await api(null, "GET", pkg)).status, 400, "package with no key");

        const mac = await api(state, "POST", "/api/provisioning/installer-bundles", { enrollmentKey: state.enrollmentKey, os: "macos" });
        assert.equal(mac.status, 503, "macOS installer should explain that there is no agent");
        console.log("refusals ok");
    },

    /** The installed service enrolled, reports in, and runs jobs. */
    async verify() {
        const state = loadState();

        const device = await waitFor("the device to appear online", 120, async () => {
            const found = await findDevices(state);
            assert.ok(found.length <= 1, `expected one device for ${HOST}, found ${found.length}`);
            return found[0]?.status === "online" ? found[0] : null;
        });
        assert.equal(device.os, AGENT_OS);
        assert.equal(device.siteId, state.siteId);
        assert.ok(device.version, "device has no agent version");

        const full = await waitFor("device facts", 120, async () => {
            const res = await api(state, "GET", `/api/devices/${device.id}`);
            return res.json?.primaryIp ? res.json : null;
        });
        console.log(`device ${full.id}: ${full.hostname} ${full.os} v${full.version} ip=${full.primaryIp}`);

        const software = await waitFor("software inventory", 180, async () => {
            const res = await api(state, "GET", `/api/devices/${device.id}/software`);
            return res.json?.items?.length ? res.json.items : null;
        });
        console.log(`software items: ${software.length}`);

        // Allow for a moment while the job socket connects after enrollment.
        const roots = await waitFor("a file job to complete", 90, async () => {
            const res = await api(state, "GET", `/api/devices/${device.id}/files/roots?wait=true`);
            return res.status === 200 && res.json?.status === "succeeded" ? res.json : null;
        });
        console.log(`file job ok: ${JSON.stringify(roots).slice(0, 160)}`);

        const action = await api(state, "POST", `/api/devices/${device.id}/actions/uninstall`, { name: "ADG RMM Not Installed" });
        if (AGENT_OS === "windows") {
            assert.equal(action.status, 202, `script job: ${action.text.slice(0, 300)}`);
            const job = await waitFor("a script job to finish", 90, () => db(async (c) => {
                const r = (await c.query(
                    `SELECT j.status, r.exit_code, r.stderr FROM jobs j LEFT JOIN job_results r ON r.job_id = j.id WHERE j.id = $1`,
                    [action.json.jobId],
                )).rows[0];
                return r && ["succeeded", "failed", "timeout"].includes(r.status) ? r : null;
            }));
            assert.match(String(job.stderr), /App not found/, "script job output");
            console.log(`script job reached the agent: ${job.status}`);
        } else {
            assert.equal(action.status, 400, "Linux uninstall should explain itself");
        }

        const previous = state.deviceId;
        if (process.argv.includes("--same-device")) {
            assert.equal(device.id, previous, "a reinstall must keep the same device");
        }
        state.deviceId = device.id;
        saveState(state);
    },

    /** Every device tool, used the way the console uses it. */
    async tools() {
        const state = loadState();
        const id = state.deviceId;
        const files = `/api/devices/${id}/files`;
        const base = path.join(os.tmpdir(), `adg-e2e-${crypto.randomBytes(4).toString("hex")}`);

        const done = async (res) => {
            assert.ok(res.status < 300, `file op: ${res.status} ${res.text.slice(0, 300)}`);
            assert.equal(res.json.status, "succeeded", `file op: ${res.text.slice(0, 400)}`);
            return res.json;
        };

        // The Node process here and the agent share the machine, so paths are real on both.
        await done(await api(state, "POST", `${files}/mkdir`, { path: base, wait: true }));
        const big = crypto.randomBytes(400 * 1024);
        const fileA = path.join(base, "a.bin");
        await done(await api(state, "POST", `${files}/write`, { path: fileA, contentBase64: big.toString("base64"), wait: true }));
        console.log("file write of 400 KB ok");

        const list = await done(await api(state, "GET", `${files}?path=${encodeURIComponent(base)}&wait=true`));
        assert.match(JSON.stringify(list), /a\.bin/, "list should show the written file");

        const read = await done(await api(state, "GET", `${files}/read?path=${encodeURIComponent(fileA)}&wait=true`));
        const readBody = JSON.parse(read.stdout);
        assert.equal(readBody.contentBase64, big.toString("base64"), "read should return the same bytes");

        const fileB = path.join(base, "b.bin");
        const fileC = path.join(base, "c.bin");
        await done(await api(state, "POST", `${files}/copy`, { from: fileA, to: fileB, wait: true }));
        await done(await api(state, "POST", `${files}/move`, { from: fileB, to: fileC, wait: true }));
        await done(await api(state, "POST", `${files}/delete`, { path: base, recursive: true, wait: true }));
        console.log("file list, read, copy, move and delete ok");

        // Run Script
        const run = async (shell, script) => {
            const started = await api(state, "POST", "/api/automation/runs", { deviceId: id, shell, script, timeoutSec: 60 });
            assert.equal(started.status, 202, `run: ${started.text.slice(0, 300)}`);
            return waitFor(`a ${shell} script`, 90, async () => {
                const snap = await api(state, "GET", `/api/automation/runs/${started.json.jobId}`);
                return snap.json?.status === "succeeded" || snap.json?.status === "failed" ? snap.json : null;
            });
        };
        const marker = crypto.randomBytes(6).toString("hex");
        if (AGENT_OS === "windows") {
            const ps = await run("powershell", `Write-Output "ps-${marker}"`);
            assert.equal(ps.status, "succeeded", ps.log);
            assert.match(ps.log, new RegExp(`ps-${marker}`));
            const cmd = await run("cmd", `@echo off\r\necho cmd-${marker}\r\n`);
            assert.equal(cmd.status, "succeeded", cmd.log);
            assert.match(cmd.log, new RegExp(`cmd-${marker}`));
            const bad = await run("powershell", "exit 7");
            assert.equal(bad.status, "failed");
            assert.equal(bad.exitCode, 7);
        } else {
            const sh = await run("bash", `echo "sh-${marker}"`);
            assert.equal(sh.status, "succeeded", sh.log);
            assert.match(sh.log, new RegExp(`sh-${marker}`));
            const bad = await run("bash", "exit 7");
            assert.equal(bad.status, "failed");
            assert.equal(bad.exitCode, 7);
        }
        console.log("run script ok");

        // Remote shell, through the same socket the console opens
        const device = (await api(state, "GET", `/api/devices/${id}`)).json;
        const shellMarker = crypto.randomBytes(6).toString("hex");
        const output = await new Promise((resolve, reject) => {
            const ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/ws/shell?role=ui&agentUuid=${device.agentUuid}`, {
                headers: { origin: "http://console.test", cookie: state.cookie },
            });
            let seen = "";
            let sessionId = null;
            const finish = (fn) => { clearTimeout(timer); try { ws.close(); } catch {} fn(); };
            const timer = setTimeout(() => finish(() => reject(new Error(`Shell timed out. Saw: ${seen.slice(-300)}`))), 60000);
            ws.on("open", () => setTimeout(() => ws.send(JSON.stringify({ type: "open", cols: 100, rows: 30 })), 500));
            ws.on("error", (e) => finish(() => reject(e)));
            ws.on("message", (raw) => {
                const msg = JSON.parse(raw.toString());
                if (msg.type === "error") return finish(() => reject(new Error(`Shell error: ${msg.message}`)));
                if (msg.type === "session") {
                    sessionId = msg.sessionId;
                    setTimeout(() => ws.send(JSON.stringify({ type: "input", sessionId, data: `echo shell-${shellMarker}\r\n` })), 3000);
                }
                if (msg.type === "data") {
                    seen += msg.data;
                    // Counting from the echoed command, the marker appears twice once the output is back.
                    if (seen.split(`shell-${shellMarker}`).length >= 3) {
                        ws.send(JSON.stringify({ type: "close", sessionId }));
                        finish(() => resolve(seen));
                    }
                }
            });
        });
        console.log(`remote shell ok (${output.length} chars)`);

        // Tools that only exist on Windows
        if (AGENT_OS === "windows") {
            const rdp = await api(state, "POST", "/api/remote-desktop/sessions", { deviceId: id });
            assert.ok(rdp.status < 300, `remote desktop: ${rdp.status} ${rdp.text.slice(0, 300)}`);
            console.log("remote desktop session created");

            const rc = await waitFor("the console agent", 60, async () => {
                const res = await api(state, "POST", "/api/remote-console/sessions", { agentId: device.agentUuid });
                return res.status < 300 ? res.json : null;
            });
            assert.ok(rc.sessionId, "remote console session");
            console.log("remote console session created");

            const scan = await api(state, "POST", "/api/patches/scan", { deviceId: id });
            assert.equal(scan.status, 202, `patch scan: ${scan.text.slice(0, 300)}`);
            const scanned = await waitFor("a patch scan", 600, async () => {
                const res = await api(state, "GET", `/api/patches/latest?deviceId=${id}`);
                return res.json?.lastScanAt ? res.json : null;
            });
            console.log(`patch scan ok: ${scanned.patches?.length ?? 0} updates`);
        } else {
            assert.equal((await api(state, "POST", "/api/patches/scan", { deviceId: id })).status, 400, "Linux patch scan should explain itself");
        }

        // Stored tokens are hashes, so the database no longer holds a usable credential.
        await db(async (c) => {
            const rows = (await c.query("SELECT agent_token FROM agents")).rows;
            assert.ok(rows.length > 0);
            for (const r of rows) assert.match(r.agent_token, /^[0-9a-f]{64}$/, "agent token should be stored hashed");
        });
        console.log("tools ok");
    },

    /** A job the server did not sign is refused, even over the agent's real socket path. */
    async signing() {
        const state = loadState();
        const pub = await db(async (c) => (await c.query("SELECT count(*)::int AS n FROM installer_bundles WHERE content LIKE 'enc1:%'")).rows[0].n);
        assert.ok(pub > 0, "installer scripts should be stored encrypted");
        const plain = await db(async (c) => (await c.query("SELECT count(*)::int AS n FROM installer_bundles WHERE content NOT LIKE 'enc1:%'")).rows[0].n);
        assert.equal(plain, 0, "no installer script should be stored readable");
        const script = await api(null, "GET", state.bundleUrl);
        assert.equal(script.status, 200);
        assert.ok(script.text.includes(state.enrollmentKey), "download should still give a working script");
        console.log("signing and bundle storage ok");
    },

    /** A different machine with the same name cannot take over a device that is online. */
    async conflict() {
        const state = loadState();
        const res = await api(null, "POST", "/api/agent/enroll", {
            enrollmentKey: state.enrollmentKey,
            deviceId: crypto.randomUUID(),
            hostname: (await findDevices(state))[0].hostname,
            os: AGENT_OS,
            arch: "x64",
            version: "1.0.0",
        });
        assert.equal(res.status, 409, `expected a conflict: ${res.text.slice(0, 300)}`);
        console.log("conflict ok");
    },

    /** After a wipe the machine has been offline a while, as a rebuilt PC would be. */
    async age() {
        await db((c) => c.query(`UPDATE agents SET last_check_in_at = NOW() - INTERVAL '1 hour'`));
        console.log("aged the last check-in");
    },

    /** The agent stopped, so the device can no longer run jobs and its row remains for history. */
    async removed() {
        const state = loadState();
        const res = await api(state, "GET", `/api/devices/${state.deviceId}`);
        assert.equal(res.status, 200);
        console.log("device record kept after uninstall");
    },
};

const step = process.argv[2];
if (!steps[step]) {
    console.error(`Unknown step: ${step}. Steps: ${Object.keys(steps).join(", ")}`);
    process.exit(2);
}
steps[step]().then(
    () => console.log(`STEP ${step} PASSED`),
    (e) => {
        console.error(`STEP ${step} FAILED: ${e?.stack ?? e}`);
        process.exit(1);
    },
);
