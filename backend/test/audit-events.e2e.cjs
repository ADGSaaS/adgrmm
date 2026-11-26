#!/usr/bin/env node
// Audit log test. Run against a throwaway backend and database only:
//
//   ADG_E2E_ALLOW=1 BASE_URL=http://127.0.0.1:3901 DATABASE_URL=postgres://.../adg_e2e \
//   JWT_SECRET=... CONSOLE_ORIGIN=http://console.test node test/audit-events.e2e.cjs
//
// It writes test rows, so it refuses any database whose name lacks "e2e".
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const { Client } = require("pg");
const WebSocket = require("ws");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { authenticator } = require("otplib");

const BASE = process.env.BASE_URL || "http://127.0.0.1:3901";
const WS_BASE = BASE.replace(/^http/, "ws");
const DB_URL = process.env.DATABASE_URL || "";
const SECRET = process.env.JWT_SECRET || "";
const ORIGIN = process.env.CONSOLE_ORIGIN || "http://console.test";
const COOKIE = process.env.AUTH_COOKIE_NAME || "auth_token";
const DIST = path.resolve(__dirname, "..", "dist");

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

async function waitFor(check, label, ms = 4000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        const value = await check();
        if (value) return value;
        await sleep(50);
    }
    throw new Error(`timed out waiting for ${label}`);
}

function api(url, { method = "GET", cookie, body, headers = {} } = {}) {
    return fetch(`${BASE}${url}`, {
        method,
        headers: {
            ...(body ? { "content-type": "application/json" } : {}),
            ...(cookie ? { cookie: `${COOKIE}=${cookie}` } : {}),
            ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
    });
}

const cookieFrom = (res) => (res.headers.get("set-cookie") || "").match(new RegExp(`${COOKIE}=([^;]+)`))?.[1];

async function main() {
    const db = new Client({ connectionString: DB_URL });
    await db.connect();
    const q = (sql, params) => db.query(sql, params);

    const org = (
        await q(
            `INSERT INTO organizations (name, slug) VALUES ('Default Organization', 'default')
             ON CONFLICT (slug) DO UPDATE SET slug = EXCLUDED.slug
             RETURNING id`,
        )
    ).rows[0].id;

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

    /** The newest row matching a filter, waiting because audit writes do not hold up the response. */
    const row = (where, params) =>
        waitFor(
            async () => (await q(`SELECT * FROM audit_events WHERE ${where} ORDER BY created_at DESC LIMIT 1`, params)).rows[0],
            `audit row: ${where} ${JSON.stringify(params)}`,
        );

    const admin = await user("admin", [
        "admin.access", "audit.read", "customers.read", "customers.write", "devices.read", "devices.actions",
        "devices.delete", "automation.run", "users.read", "users.write", "users.delete", "users.2fa.reset",
        "roles.read", "roles.write", "me.security", "me.read", "settings.write", "tickets.read", "tickets.write",
    ]);
    const viewer = await user("viewer", ["admin.access", "customers.read"]);

    const clientId = uuid();
    const siteId = uuid();
    await q(`INSERT INTO clients (id, organization_id, name) VALUES ($1,$2,$3)`, [clientId, org, `audit-client-${clientId}`]);
    await q(`INSERT INTO sites (id, client_id, name) VALUES ($1,$2,'audit-site')`, [siteId, clientId]);
    const enrollmentKey = `key-${uuid()}`;
    await q(
        `INSERT INTO site_enrollment_keys (id, client_id, site_id, name, token_hash, expires_at)
         VALUES ($1,$2,$3,'e2e',$4, now() + interval '1 day')`,
        [uuid(), clientId, siteId, sha256(enrollmentKey)],
    );
    const hostname = `audit-host-${uuid()}`;
    const deviceId = uuid();
    const enrolled = await api("/api/agent/enroll", {
        method: "POST",
        body: { enrollmentKey, deviceId, hostname, os: "windows", arch: "x64", version: "1.0.0" },
    });
    assert.equal(enrolled.status, 201, "enroll failed");
    const agent = await enrolled.json();

    console.log("Sign-in and sign-out");
    await test("wrong password records a failure without the password", async () => {
        const bad = `wrong-${uuid()}`;
        const res = await api("/api/auth/login", { method: "POST", body: { email: admin.email, password: bad } });
        assert.equal(res.status, 401);
        const r = await row(`action = 'auth.signin' AND actor_email = $1 AND outcome = 'failure'`, [admin.email]);
        assert.equal(r.details.reason, "invalid_credentials");
        assert.ok(!JSON.stringify(r).includes(bad));
    });

    let session;
    await test("correct password records a success and who it was", async () => {
        const res = await api("/api/auth/login", {
            method: "POST",
            body: { email: admin.email, password: admin.password },
            headers: { "user-agent": "audit-e2e", "cf-connecting-ip": "203.0.113.9" },
        });
        assert.equal(res.status, 201);
        session = cookieFrom(res);
        const r = await row(`action = 'auth.signin' AND actor_user_id = $1 AND outcome = 'success'`, [admin.id]);
        assert.equal(r.user_agent, "audit-e2e");
        assert.equal(r.ip, "203.0.113.9");
        assert.equal(r.details.via, "password");
    });

    await test("the legacy sign-in route is recorded too", async () => {
        const res = await api("/api/auth-legacy/login", { method: "POST", body: { email: viewer.email, password: "nope-nope-nope" } });
        assert.equal(res.status, 401);
        await row(`action = 'auth.signin' AND actor_email = $1 AND outcome = 'failure'`, [viewer.email]);
    });

    await test("garbage 2FA challenges cannot fill the table", async () => {
        const address = `203.0.113.${Math.floor(Math.random() * 250) + 1}`;
        const headers = { "cf-connecting-ip": address };
        for (let i = 0; i < 5; i++) {
            const res = await api("/api/auth/2fa/verify", { method: "POST", headers, body: { challengeToken: "aaaa.bbbb.cccc", code: "000000" } });
            assert.equal(res.status, 401);
        }
        await sleep(300);
        const { rows } = await q(`SELECT count(*)::int AS n FROM audit_events WHERE ip = $1 AND details->>'reason' = 'invalid_2fa_challenge'`, [address]);
        assert.equal(rows[0].n, 1);
    });

    await test("repeated blocked attempts write at most one row a minute", async () => {
        const email = `flood-${uuid()}@example.test`;
        const headers = { "cf-connecting-ip": "203.0.113.77" };
        for (let i = 0; i < 14; i++) {
            await api("/api/auth/login", { method: "POST", body: { email, password: "nope-nope-nope" }, headers });
        }
        await sleep(300);
        const { rows } = await q(`SELECT details->>'reason' AS reason FROM audit_events WHERE actor_email = $1`, [email]);
        assert.equal(rows.filter((r) => r.reason === "invalid_credentials").length, 10);
        assert.equal(rows.filter((r) => r.reason === "rate_limited").length, 1);
    });

    console.log("2FA");
    const tfa = await user("tfa", ["me.security", "me.read"]);
    let totpSecret;
    await test("enabling 2FA is recorded and neither secret nor code is kept", async () => {
        const start = await api("/api/users/me/2fa/start", { method: "POST", cookie: tfa.token });
        assert.ok(start.status < 300, `start ${start.status}`);
        totpSecret = (await start.json()).secret;
        const code = authenticator.generate(totpSecret);
        const res = await api("/api/users/me/2fa/confirm", { method: "POST", cookie: tfa.token, body: { code } });
        assert.ok(res.status < 300, `confirm ${res.status}`);
        const r = await row(`action = 'auth.2fa.enable' AND actor_user_id = $1`, [tfa.id]);
        assert.equal(r.outcome, "success");
        assert.ok(!JSON.stringify(r).includes(totpSecret));
        assert.ok(!JSON.stringify(r).includes(code));
    });

    await test("a 2FA sign-in records the password step, a bad code and the success", async () => {
        const login = await api("/api/auth/login", { method: "POST", body: { email: tfa.email, password: tfa.password } });
        const { challengeToken } = await login.json();
        assert.ok(challengeToken);
        await row(`action = 'auth.signin.password_accepted' AND actor_user_id = $1`, [tfa.id]);

        const bad = await api("/api/auth/2fa/verify", { method: "POST", body: { challengeToken, code: "000000" } });
        assert.equal(bad.status, 400);
        const failed = await row(`action = 'auth.signin' AND actor_user_id = $1 AND outcome = 'failure'`, [tfa.id]);
        assert.equal(failed.details.reason, "invalid_2fa_code");
        assert.equal(failed.actor_email, tfa.email);

        // A challenge is single-use, even when the code was wrong.
        const again = await api("/api/auth/login", { method: "POST", body: { email: tfa.email, password: tfa.password } });
        const good = await api("/api/auth/2fa/verify", {
            method: "POST",
            body: { challengeToken: (await again.json()).challengeToken, code: authenticator.generate(totpSecret) },
        });
        assert.ok(good.status < 300, `verify ${good.status}`);
        const ok = await row(`action = 'auth.signin' AND actor_user_id = $1 AND outcome = 'success'`, [tfa.id]);
        assert.equal(ok.details.via, "2fa_code");
    });

    console.log("Recorded actions");
    const c = { cookie: session };
    await test("customer and site create and delete, with names", async () => {
        const name = `Audit Co ${uuid()}`;
        const res = await api("/api/customers", { method: "POST", ...c, body: { name } });
        assert.ok(res.status < 300, `create ${res.status}`);
        const created = await res.json();
        const r = await row(`action = 'customer.create' AND target_label = $1`, [name]);
        assert.equal(r.category, "customer");
        assert.equal(r.target_id, created.id);
        assert.equal(r.actor_email, admin.email);

        const site = await api(`/api/customers/${created.id}/sites`, { method: "POST", ...c, body: { name: "Branch" } });
        assert.ok(site.status < 300, `site ${site.status}`);
        await row(`action = 'site.create' AND target_label = 'Branch'`);
        const delSite = await api(`/api/customers/${created.id}/sites/${(await site.json()).id}`, { method: "DELETE", ...c });
        assert.ok(delSite.status < 300, `delete site ${delSite.status}`);
        await row(`action = 'site.delete' AND target_label = 'Branch'`);

        const del = await api(`/api/customers/${created.id}`, { method: "DELETE", ...c });
        assert.ok(del.status < 300, `delete ${del.status}`);
        const d = await row(`action = 'customer.delete' AND target_id = $1`, [created.id]);
        assert.equal(d.target_label, name, "the name should be looked up before the delete");
    });

    await test("device action names the device by hostname", async () => {
        const res = await api(`/api/devices/${deviceId}/actions/reboot`, { method: "POST", ...c, body: { reason: "patch night" } });
        assert.ok(res.status < 300, `reboot ${res.status}`);
        const r = await row(`action = 'device.reboot' AND target_id = $1`, [deviceId]);
        assert.equal(r.target_label, hostname);
        assert.equal(r.details.reason, "patch night");
        assert.equal(r.outcome, "success");
    });

    await test("a failed action is recorded as a failure with its status", async () => {
        const missing = uuid();
        const res = await api(`/api/devices/${missing}/actions/reboot`, { method: "POST", ...c, body: {} });
        assert.equal(res.status, 404);
        const r = await row(`action = 'device.reboot' AND target_id = $1`, [missing]);
        assert.equal(r.outcome, "failure");
        assert.equal(r.details.status, 404);
    });

    await test("script text and file contents are never stored", async () => {
        const secret = `s3cret-${uuid()}`;
        await api("/api/automation/runs", {
            method: "POST",
            ...c,
            body: { deviceId, script: `Set-Password ${secret}`, shell: "powershell", timeoutSec: 30 },
        });
        const run = await row(`action = 'script.run' AND target_id = $1`, [deviceId]);
        assert.equal(run.details.shell, "powershell");

        const b64 = Buffer.from(secret).toString("base64");
        await api(`/api/devices/${deviceId}/files/write`, {
            method: "POST",
            ...c,
            body: { path: "C:\\temp\\a.txt", contentBase64: b64 },
        });
        const w = await row(`action = 'file.write' AND target_id = $1`, [deviceId]);
        assert.equal(w.details.path, "C:\\temp\\a.txt");

        const { rows } = await q(`SELECT count(*)::int AS n FROM audit_events WHERE audit_events::text LIKE $1 OR audit_events::text LIKE $2`, [`%${secret}%`, `%${b64}%`]);
        assert.equal(rows[0].n, 0);
    });

    await test("user creation keeps the email but never the password", async () => {
        const password = `Created-${uuid()}!a1`;
        const email = `made-${uuid()}@example.test`;
        await api("/api/admin/users/create", { method: "POST", ...c, body: { email, name: "Made", role: "Admin", password } });
        const r = await row(`action = 'user.create' AND target_label = $1`, [email]);
        assert.ok(!JSON.stringify(r).includes(password));
    });

    await test("a remote console start is recorded without its session token", async () => {
        const res = await api("/api/remote-console/sessions", { method: "POST", ...c, body: { agentId: agent.agentId } });
        const r = await row(`action = 'remote.console.start' AND target_id = $1`, [agent.agentId]);
        if (res.status < 300) {
            const { sessionToken } = await res.json();
            assert.ok(!JSON.stringify(r).includes(sessionToken));
        }
    });

    await test("opening a shell over the socket is recorded", async () => {
        const sock = (url, headers) =>
            new Promise((resolve, reject) => {
                const ws = new WebSocket(`${WS_BASE}${url}`, { headers });
                ws.on("open", () => setTimeout(() => resolve(ws), 400));
                ws.on("error", reject);
            });
        const agentSock = await sock(`/ws/shell?role=agent&agentUuid=${agent.agentUuid}`, { authorization: `Bearer ${agent.agentToken}` });
        const ui = await sock(`/ws/shell?role=ui&agentUuid=${agent.agentUuid}`, { origin: ORIGIN, cookie: `${COOKIE}=${session}` });
        ui.send(JSON.stringify({ type: "open", cols: 80, rows: 24, runAs: "user" }));
        const r = await row(`action = 'remote.shell.start' AND actor_user_id = $1`, [admin.id]);
        assert.equal(r.actor_email, admin.email);
        assert.equal(r.target_label, hostname);
        assert.equal(r.details.runAs, "user");
        ui.close();
        agentSock.close();
    });

    await test("a route with no table entry would still get a usable generic action", async () => {
        const { auditRuleFor } = require(path.join(DIST, "audit/audit-routes.js"));
        const rule = auditRuleFor("DELETE", "/api/admin/widgets//:id/parts/:partId");
        assert.equal(rule.action, "widgets.parts.delete");
        assert.equal(rule.category, "widgets");
        assert.equal(rule.targetParam, "id");
        assert.equal(rule.fields, undefined, "a generic route must keep no body fields");
    });

    console.log("Skipped and refused");
    await test("agent routes are not recorded", async () => {
        const before = (await q(`SELECT count(*)::int AS n FROM audit_events`)).rows[0].n;
        const res = await api("/api/agent/ping", {
            method: "POST",
            headers: { authorization: `Bearer ${agent.agentToken}` },
            body: { hostname },
        });
        assert.ok(res.status < 500, `ping ${res.status}`);
        await sleep(300);
        const { rows } = await q(`SELECT count(*)::int AS n FROM audit_events`);
        assert.equal(rows[0].n, before);
    });

    await test("a change refused for lack of permission is recorded", async () => {
        const res = await api("/api/customers", { method: "POST", cookie: viewer.token, body: { name: "Nope" } });
        assert.equal(res.status, 403);
        const r = await row(`action = 'customer.create' AND actor_user_id = $1`, [viewer.id]);
        assert.equal(r.outcome, "failure");
        assert.equal(r.details.reason, "permission_denied");
        assert.equal(r.details.permission, "customers.write");
    });

    await test("the admin API key is attributed, and a wrong key records nothing", async () => {
        const key = process.env.ADMIN_API_KEY;
        if (!key) return console.log("        (skipped: ADMIN_API_KEY is not set)");
        const secret = `s3cret-${uuid()}`;
        const body = { agentId: agent.agentId, language: "powershell", scriptText: secret, timeoutSec: 5 };
        const res = await api("/api/admin/jobs/run-script", { method: "POST", headers: { "x-admin-api-key": key }, body });
        assert.ok(res.status < 500, `run-script ${res.status}`);
        const r = await row(`action = 'script.run' AND actor_email = 'admin-api-key' AND target_id = $1`, [agent.agentId]);
        assert.equal(r.actor_user_id, null);
        assert.equal(r.details.language, "powershell");
        assert.ok(!JSON.stringify(r).includes(secret));

        const count = async () => (await q(`SELECT count(*)::int AS n FROM audit_events WHERE actor_email = 'admin-api-key'`)).rows[0].n;
        const before = await count();
        const wrong = await api("/api/admin/jobs/run-script", { method: "POST", headers: { "x-admin-api-key": "wrong" }, body });
        assert.ok([401, 403].includes(wrong.status), `wrong key ${wrong.status}`);
        await sleep(300);
        assert.equal(await count(), before);
    });

    console.log("Reading the log");
    await test("reading needs audit.read", async () => {
        assert.equal((await api("/api/admin/audit-events", { cookie: viewer.token })).status, 403);
        assert.equal((await api("/api/admin/audit-events/export", { cookie: viewer.token })).status, 403);
        assert.ok([401, 403].includes((await api("/api/admin/audit-events")).status));
    });

    await test("no route changes or removes a row", async () => {
        const { rows } = await q(`SELECT id FROM audit_events LIMIT 1`);
        for (const method of ["PUT", "PATCH", "DELETE", "POST"]) {
            const res = await api(`/api/admin/audit-events/${rows[0].id}`, { method, ...c, body: {} });
            assert.equal(res.status, 404, method);
        }
    });

    const tied = new Date("2026-01-15T12:00:00.123Z");
    const marker = `page-${uuid()}`;
    await q(
        `INSERT INTO audit_events (created_at, action, category, outcome, target_label)
         SELECT $1, 'test.page', 'e2e', 'success', $2 FROM generate_series(1, 130)`,
        [tied, marker],
    );

    await test("paging through identical timestamps skips and repeats nothing", async () => {
        const seen = new Set();
        let cursor = null;
        let pages = 0;
        do {
            const qs = new URLSearchParams({ target: marker, limit: "50", ...(cursor ? { cursor } : {}) });
            const res = await api(`/api/admin/audit-events?${qs}`, c);
            assert.equal(res.status, 200);
            const body = await res.json();
            for (const item of body.items) {
                assert.ok(!seen.has(item.id), "repeated row");
                seen.add(item.id);
            }
            cursor = body.nextCursor;
            pages++;
        } while (cursor && pages < 10);
        assert.equal(seen.size, 130);
        assert.equal(pages, 3);
    });

    await test("filters narrow the results", async () => {
        const get = async (params) => {
            const res = await api(`/api/admin/audit-events?${new URLSearchParams(params)}`, c);
            assert.equal(res.status, 200, JSON.stringify(params));
            return (await res.json()).items;
        };
        assert.ok((await get({ category: "auth" })).every((i) => i.category === "auth"));
        assert.ok((await get({ action: "device." })).every((i) => i.action.startsWith("device.")));
        assert.ok((await get({ actor: admin.id })).every((i) => i.actor_user_id === admin.id));
        assert.ok((await get({ actor: admin.email })).every((i) => i.actor_email === admin.email));
        assert.ok((await get({ outcome: "failure" })).every((i) => i.outcome === "failure"));
        assert.ok((await get({ target: deviceId })).length > 0);
        assert.equal((await get({ q: hostname.toUpperCase() }))[0].target_label, hostname);
        assert.equal((await get({ from: "2026-01-15T12:00:00.000Z", to: "2026-01-15T12:00:00.500Z", limit: "5" })).length, 5);
        assert.equal((await get({ from: "2026-01-15T12:00:01.000Z", to: "2026-01-15T12:00:02.000Z" })).length, 0);
    });

    await test("a search treats % and _ as plain characters", async () => {
        const res = await api(`/api/admin/audit-events?${new URLSearchParams({ q: `zz%no_match${uuid()}` })}`, c);
        assert.equal((await res.json()).items.length, 0);
        const wild = await api(`/api/admin/audit-events?${new URLSearchParams({ q: "%" })}`, c);
        const items = (await wild.json()).items;
        assert.ok(items.every((i) => JSON.stringify(i).includes("%")), "% should not match every row");
    });

    await test("bad dates and cursors are refused, not a server error", async () => {
        assert.equal((await api("/api/admin/audit-events?from=not-a-date", c)).status, 400);
        assert.equal((await api("/api/admin/audit-events?cursor=rubbish", c)).status, 400);
        assert.equal((await api("/api/admin/audit-events/export?to=not-a-date", c)).status, 400);
        assert.equal((await api("/api/admin/audit-events?outcome=maybe", c)).status, 400);
    });

    await test("export escapes formulas and quotes, and is itself recorded", async () => {
        const label = `csv-${uuid()}`;
        const nasty = ["=cmd|' /C calc'!A0", "+1+1", "-2+3", "@SUM(A1)", "\t=1+1", " =1+1", 'has "quotes", commas\nand lines'];
        for (const email of nasty) {
            await q(`INSERT INTO audit_events (action, category, outcome, target_label, actor_email) VALUES ('test.csv','e2e','success',$1,$2)`, [label, email]);
        }
        const res = await api(`/api/admin/audit-events/export?${new URLSearchParams({ target: label })}`, c);
        assert.equal(res.status, 200);
        assert.match(res.headers.get("content-type"), /text\/csv/);
        assert.match(res.headers.get("content-disposition"), /attachment; filename="audit-log-/);
        const text = await res.text();
        for (const email of nasty.slice(0, 6)) {
            assert.ok(text.includes(`"'${email}"`), `not escaped: ${email}`);
            assert.ok(!text.includes(`"${email}"`), `left as a formula: ${email}`);
        }
        assert.ok(text.includes('"has ""quotes"", commas\nand lines"'));
        assert.equal(text.split("\r\n").filter(Boolean).length, nasty.length + 1);
        const r = await row(`action = 'audit.export' AND actor_user_id = $1`, [admin.id]);
        assert.equal(r.details.target, label);
    });

    console.log("Direct service behaviour");
    await test("record() never rejects, and strips secrets and NUL characters", async () => {
        const { AuditService } = require(path.join(DIST, "audit/audit.service.js"));
        const broken = new AuditService({ audit_events: { create: () => { throw new Error("boom"); } } });
        await broken.record({ action: "x", category: "y", outcome: "success" });
        await broken.record(undefined);

        const { PrismaClient } = require("@prisma/client");
        const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
        const svc = new AuditService(prisma);
        const action = `test.scrub.${uuid()}`;
        await svc.record({
            action,
            category: "e2e",
            outcome: "success",
            actorEmail: "a\u0000b@example.test",
            details: { password: "x", nested: { apiKey: "x", token: "x", keep: "yes\u0000" }, scriptText: "x", list: [1, "two"] },
        });
        const r = await row(`action = $1`, [action]);
        assert.equal(r.actor_email, "ab@example.test");
        assert.deepEqual(r.details, { nested: { keep: "yes" }, list: [1, "two"] });

        const old = `old-${uuid()}`;
        const recent = `recent-${uuid()}`;
        await q(`INSERT INTO audit_events (created_at, action, category, outcome, target_label) VALUES (now() - interval '40 days', 'test.old', 'e2e', 'success', $1), (now() - interval '20 days', 'test.old', 'e2e', 'success', $2)`, [old, recent]);
        const before = process.env.AUDIT_RETENTION_DAYS;
        process.env.AUDIT_RETENTION_DAYS = "30";
        await svc.sweep();
        if (before === undefined) delete process.env.AUDIT_RETENTION_DAYS;
        else process.env.AUDIT_RETENTION_DAYS = before;
        const left = await q(`SELECT target_label FROM audit_events WHERE target_label = ANY($1)`, [[old, recent]]);
        assert.deepEqual(left.rows.map((x) => x.target_label), [recent]);

        const { retentionDays } = require(path.join(DIST, "audit/audit.service.js"));
        assert.equal(retentionDays(undefined), 365);
        assert.equal(retentionDays("0"), 365);
        assert.equal(retentionDays("junk"), 365);
        assert.equal(retentionDays("90"), 90);
        await prisma.$disconnect();
    });

    console.log("Sign-out");
    await test("sign-out is recorded even though the auth middleware skips that route", async () => {
        const res = await api("/api/auth/logout", { method: "POST", ...c });
        assert.ok(res.status < 300);
        const r = await row(`action = 'auth.signout' AND actor_user_id = $1`, [admin.id]);
        assert.equal(r.actor_email, admin.email);
    });

    await db.end();
    console.log(`\n${passed} passed, ${failures.length} failed`);
    if (failures.length) process.exit(1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
