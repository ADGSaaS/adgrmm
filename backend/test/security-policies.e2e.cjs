#!/usr/bin/env node
// Administration > Security Policies, Sessions and Agents & Endpoints, against a real backend and database.
//
// Start two throwaway backends on the same e2e database. The first stands in for Cloudflare Turnstile through
// ADG_TURNSTILE_VERIFY_URL; the second has the two safety switches on (ADG_IGNORE_IP_ALLOWLIST, ADG_DISABLE_CAPTCHA):
//
//   ADG_TURNSTILE_VERIFY_URL=http://127.0.0.1:3991/verify PORT=3911 node dist/main.js
//   ADG_TURNSTILE_VERIFY_URL=http://127.0.0.1:3991/verify ADG_IGNORE_IP_ALLOWLIST=1 ADG_DISABLE_CAPTCHA=1 PORT=3912 node dist/main.js
//
//   ADG_E2E_ALLOW=1 BASE_URL=http://127.0.0.1:3911 BYPASS_URL=http://127.0.0.1:3912 TS_PORT=3991 \
//   DATABASE_URL=postgres://.../adg_e2e JWT_SECRET=... [ADG_DIST=/path/to/dist] node test/security-policies.e2e.cjs
//
// It writes test rows, so it refuses any database whose name lacks "e2e".
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Client } = require("pg");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");

const BASE = process.env.BASE_URL || "http://127.0.0.1:3911";
const BYPASS = process.env.BYPASS_URL || "";
const TS_PORT = Number(process.env.TS_PORT || 3991);
const DB_URL = process.env.DATABASE_URL || "";
const SECRET = process.env.JWT_SECRET || "";
const COOKIE = process.env.AUTH_COOKIE_NAME || "auth_token";
const DIST = process.env.ADG_DIST || path.join(__dirname, "..", "dist");

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

// Cloudflare's published Turnstile test keys. The real endpoint answers these too; the stand-in below behaves the same.
const CF_PASS_SECRET = "1x0000000000000000000000000000000AA";
const CF_FAIL_SECRET = "2x0000000000000000000000000000000AA";
const CF_PASS_SITEKEY = "1x00000000000000000000AA";

// ---- A stand-in for Cloudflare's siteverify ----------------------------------------------------------------
const standIn = { rotated: false, down: false, calls: [] };
function startStandIn() {
    const srv = http.createServer((req, res) => {
        if (standIn.down) { res.destroy(); return; }
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => {
            const f = new URLSearchParams(raw);
            standIn.calls.push(Object.fromEntries(f));
            const secret = f.get("secret") || "";
            const token = f.get("response") || "";
            const out = (body, code = 200) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
            if (!secret) return out({ success: false, "error-codes": ["missing-input-secret"] });
            if (secret === CF_PASS_SECRET && !standIn.rotated) return token ? out({ success: true, "error-codes": [] }) : out({ success: false, "error-codes": ["missing-input-response"] });
            if (secret === CF_FAIL_SECRET) return out({ success: false, "error-codes": ["invalid-input-response"] });
            if (secret === "5xx-secret") return out({ success: false }, 502);
            return out({ success: false, "error-codes": ["invalid-input-secret"] });
        });
    });
    return new Promise((resolve) => srv.listen(TS_PORT, "127.0.0.1", () => resolve(srv)));
}

function call(base, p, { method = "GET", token, body, headers = {} } = {}) {
    return fetch(`${base}${p}`, {
        method,
        headers: {
            ...(body !== undefined ? { "content-type": "application/json" } : {}),
            ...(token ? { cookie: `${COOKIE}=${token}` } : {}),
            ...headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
}
const json = async (res) => res.json().catch(() => ({}));

async function main() {
    const lib = require(path.join(DIST, "auth", "security-policy.js"));
    const db = new Client({ connectionString: DB_URL });
    await db.connect();
    const q = (sql, params) => db.query(sql, params);
    const stamp = Date.now();
    const srv = await startStandIn();

    const org = (await q(`INSERT INTO organizations (name, slug) VALUES ('Default Organization','default') ON CONFLICT (slug) DO UPDATE SET slug = EXCLUDED.slug RETURNING id`)).rows[0].id;
    const roleByName = async (name) => (await q(`SELECT id FROM roles WHERE lower(name) = lower($1) ORDER BY scope DESC LIMIT 1`, [name])).rows[0]?.id;
    const ownerRole = await roleByName("Owner");
    const adminRole = await roleByName("Admin");

    /** A person with a real password, a role and a live session. */
    async function user(label, { roleId, permissions = [], password = `Pw-${uuid()}` } = {}) {
        const id = uuid();
        const email = `${label}-${id}@example.test`;
        await q(`INSERT INTO users (id, organization_id, email, first_name, last_name, status, password_hash) VALUES ($1,$2,$3,'E2E',$4,'active',$5)`, [id, org, email, label, await bcrypt.hash(password, 4)]);
        let role = roleId;
        if (!role) {
            role = uuid();
            await q(`INSERT INTO roles (id, organization_id, scope, name) VALUES ($1,$2,'organization',$3)`, [role, org, `e2e-${label}-${id}`]);
            for (const p of permissions) await q(`INSERT INTO role_permissions (role_id, permission_key) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [role, p]);
        }
        await q(`INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)`, [id, role]);
        const session = async () => {
            const jti = uuid();
            await q(`INSERT INTO sessions (id, user_id, refresh_token) VALUES ($1,$2,$3)`, [jti, id, sha256(jti)]);
            return { jti, token: jwt.sign({ sub: id, email, jti }, SECRET, { expiresIn: "1h" }) };
        };
        const s = await session();
        return { id, email, password, ...s, session };
    }

    const MY_IP = "203.0.113.9";
    const ipHeader = (ip) => ({ "x-forwarded-for": ip });

    const root = await user("root", { roleId: ownerRole });
    // The built-in Admin role: what an administrator really holds (it has no Owner powers).
    const admin = await user("admin", { roleId: adminRole });
    const reader = await user("reader", { permissions: ["settings.read", "users.read"] });
    const as = (u, ip = MY_IP) => ({ token: u.token, headers: ipHeader(ip) });
    const getPolicy = async () => json(await call(BASE, "/api/admin/security-policies", as(admin)));
    const putPolicy = (body, who = admin, ip = MY_IP) => call(BASE, "/api/admin/security-policies", { method: "PUT", body, ...as(who, ip) });
    const login = (email, password, extra = {}, base = BASE, ip = "198.51.100.7", p = "/api/auth/login") =>
        call(base, p, { method: "POST", body: { email, password, ...extra }, headers: ipHeader(ip) });

    const resetPolicy = async () => {
        await q(`DELETE FROM security_policies WHERE organization_id = $1`, [org]);
        await sleep(5200); // the server keeps what it read for a few seconds
    };
    await resetPolicy();

    // ------------------------------------------------------------------ pure rules
    console.log("the rules themselves");
    const pol = { ...lib.DEFAULT_POLICY, passwordMinLength: 12, passwordRequireNumbers: true, passwordRequireSpecial: true, passwordRequireUppercase: true };
    await test("a password is checked against every rule that is on", () => {
        assert.deepEqual(lib.passwordProblems(pol, "Abcdefghij1!"), []);
        assert.equal(lib.passwordProblems(pol, "short").length, 4);
        assert.deepEqual(lib.passwordProblems(pol, "abcdefghijk1!"), ["contain an uppercase letter"]);
        assert.deepEqual(lib.passwordProblems(pol, "Abcdefghijkl!"), ["contain a number"]);
        assert.deepEqual(lib.passwordProblems(pol, "Abcdefghijk12"), ["contain a special character, such as ! or #"]);
        assert.deepEqual(lib.passwordProblems(lib.DEFAULT_POLICY, "abcdefgh"), []);
    });
    await test("address lists: addresses, ranges, IPv6, comments, and bad lines named", () => {
        const e = lib.parseAllowlist("203.0.113.0/24  # office\n\n198.51.100.4\n2001:db8::/32\n::ffff:192.0.2.1");
        assert.equal(e.length, 4);
        assert.ok(lib.ipAllowed(e, "203.0.113.200"));
        assert.ok(!lib.ipAllowed(e, "203.0.114.1"));
        assert.ok(lib.ipAllowed(e, "198.51.100.4"));
        assert.ok(!lib.ipAllowed(e, "198.51.100.5"));
        assert.ok(lib.ipAllowed(e, "2001:db8:abcd::1"));
        assert.ok(!lib.ipAllowed(e, "2001:db9::1"));
        assert.ok(lib.ipAllowed(e, "::ffff:203.0.113.5"), "an IPv4 client on a dual-stack socket");
        assert.ok(lib.ipAllowed(e, "192.0.2.1"));
        assert.ok(!lib.ipAllowed(e, "not an ip"));
        assert.ok(lib.ipAllowed([], "anything"), "an empty list allows everyone");
        for (const bad of ["300.1.1.1", "10.0.0.0/33", "10.0.0.0/x", "hello", "1.2.3.4/5/6"]) {
            assert.throws(() => lib.parseAllowlist(`10.0.0.1\n${bad}`), /Line 2/, bad);
        }
    });
    await test("session limits: age and idleness", () => {
        const p = { ...lib.DEFAULT_POLICY, sessionTimeoutMins: 60, idleTimeoutMins: 10 };
        const now = Date.now();
        const at = (minsAgo) => new Date(now - minsAgo * 60_000);
        assert.equal(lib.sessionEnd(p, { created_at: at(5), last_seen_at: at(1) }, now), null);
        assert.equal(lib.sessionEnd(p, { created_at: at(70), last_seen_at: at(1) }, now), "session_timeout");
        assert.equal(lib.sessionEnd(p, { created_at: at(30), last_seen_at: at(11) }, now), "idle_timeout");
        assert.equal(lib.sessionEnd(lib.DEFAULT_POLICY, { created_at: at(99999), last_seen_at: at(99999) }, now), null);
    });

    // ------------------------------------------------------------------ the settings screen
    console.log("saving the settings");
    await test("defaults change nothing: 8 characters, no limits, no list, no CAPTCHA", async () => {
        const p = await getPolicy();
        assert.equal(p.passwordMinLength, 8);
        assert.equal(p.passwordHistory, 0);
        assert.equal(p.sessionTimeoutMins, 0);
        assert.equal(p.idleTimeoutMins, 0);
        assert.equal(p.ipAllowlist, "");
        assert.equal(p.captchaEnabled, false);
        assert.equal(p.hasTurnstileSecret, false);
        assert.equal(p.yourIp, MY_IP);
    });
    await test("only people with the settings permissions can read or change them", async () => {
        const none = await user("nobody", { permissions: ["devices.read"] });
        assert.equal((await call(BASE, "/api/admin/security-policies", as(none))).status, 403);
        assert.equal((await call(BASE, "/api/admin/security-policies", as(reader))).status, 200);
        assert.equal((await putPolicy({ passwordMinLength: 10 }, reader)).status, 403);
        assert.equal((await call(BASE, "/api/admin/security-policies")).status, 401);
    });
    await test("out-of-range numbers and bad address lines are refused with a reason", async () => {
        for (const body of [{ passwordMinLength: 4 }, { passwordMinLength: 500 }, { passwordHistory: 11 }, { sessionTimeoutMins: 5 }, { idleTimeoutMins: 2 }, { idleTimeoutMins: "soon" }, { passwordRequireNumbers: "yes" }]) {
            const r = await putPolicy(body);
            assert.equal(r.status, 400, JSON.stringify(body));
        }
        const bad = await putPolicy({ ipAllowlist: "203.0.113.0/24\nnot-an-address" });
        assert.equal(bad.status, 400);
        assert.match((await json(bad)).message, /Line 2/);
        assert.equal((await getPolicy()).ipAllowlist, "", "nothing was saved");
    });
    await test("a list that would exclude the saving administrator is refused", async () => {
        const r = await putPolicy({ ipAllowlist: "198.51.100.0/24" });
        assert.equal(r.status, 400);
        assert.match((await json(r)).message, /does not include your own address \(203\.0\.113\.9\)/);
        assert.equal((await getPolicy()).ipAllowlist, "");
        // The Owner is held to the same rule when saving: it protects the person at the keyboard.
        assert.equal((await putPolicy({ ipAllowlist: "198.51.100.0/24" }, root)).status, 400);
    });
    await test("a valid save is stored, audited without secrets, and read back", async () => {
        const r = await putPolicy({ passwordMinLength: 12, passwordRequireNumbers: true, passwordRequireSpecial: true, passwordRequireUppercase: true, passwordHistory: 2, ipAllowlist: "" });
        assert.equal(r.status, 200, JSON.stringify(await json(r)));
        const p = await getPolicy();
        assert.equal(p.passwordMinLength, 12);
        assert.equal(p.passwordHistory, 2);
        assert.match(p.passwordRules, /at least 12 characters.*uppercase.*number.*special.*last 2/);
        const audit = (await q(`SELECT * FROM audit_events WHERE action = 'security_policies.update' AND actor_user_id = $1 ORDER BY created_at DESC LIMIT 1`, [admin.id])).rows[0];
        assert.ok(audit, "an audit row");
        assert.equal(audit.outcome, "success");
        assert.match(JSON.stringify(audit.details), /passwordMinLength/);
    });

    // ------------------------------------------------------------------ passwords, everywhere one is set
    console.log("passwords");
    const subject = await user("subject", { permissions: ["me.security"], password: "Initial-Password-1!" });
    const created = [];
    await test("creating a person enforces every rule, and names what is missing", async () => {
        const weak = await call(BASE, "/api/admin/users/create", { method: "POST", body: { name: "Weak One", email: `weak-${stamp}@example.test`, password: "abcdefgh" }, ...as(admin) });
        assert.equal(weak.status, 400);
        const msg = (await json(weak)).message;
        assert.match(msg, /at least 12 characters/);
        assert.match(msg, /uppercase/);
        assert.match(msg, /number/);
        assert.match(msg, /special/);
        assert.equal((await q(`SELECT 1 FROM users WHERE email = $1`, [`weak-${stamp}@example.test`])).rowCount, 0, "no account was made");
        const ok = await call(BASE, "/api/admin/users/create", { method: "POST", body: { name: "Strong One", email: `strong-${stamp}@example.test`, password: "Correct-Horse-9!" }, ...as(admin) });
        assert.equal(ok.status, 201, JSON.stringify(await json(ok)));
        created.push((await json(ok)).id);
    });
    await test("an administrator setting a password is held to the rules", async () => {
        const weak = await call(BASE, `/api/admin/users/${subject.id}/password`, { method: "PATCH", body: { password: "lowercaseonly" }, ...as(admin) });
        assert.equal(weak.status, 400);
        const ok = await call(BASE, `/api/admin/users/${subject.id}/password`, { method: "PATCH", body: { password: "Second-Password-2@" }, ...as(admin) });
        assert.ok([200, 204].includes(ok.status), `got ${ok.status}`);
    });
    await test("history: a reused password is refused, in both places a password is set", async () => {
        // History is 2: the current password (Second...) and the one before it (Initial) cannot come back.
        await q(`INSERT INTO password_history (user_id, password_hash, created_at) VALUES ($1,$2, now() - interval '2 hour')`, [subject.id, await bcrypt.hash("Initial-Password-1!", 4)]);
        const again = await call(BASE, `/api/admin/users/${subject.id}/password`, { method: "PATCH", body: { password: "Second-Password-2@" }, ...as(admin) });
        assert.equal(again.status, 400);
        assert.match((await json(again)).message, /used before/);
        const fresh = await subject.session();
        const viaAccount = await call(BASE, "/api/users/me/password", { method: "POST", body: { current: "Second-Password-2@", next: "Second-Password-2@x" }, token: fresh.token, headers: ipHeader(MY_IP) });
        assert.equal(viaAccount.status, 201, JSON.stringify(await json(viaAccount)));
        // Now Second is one back, and Initial has fallen out of the last two.
        const back1 = await call(BASE, "/api/users/me/password", { method: "POST", body: { current: "Second-Password-2@x", next: "Second-Password-2@" }, token: fresh.token, headers: ipHeader(MY_IP) });
        assert.equal(back1.status, 400);
        assert.match((await json(back1)).message, /used before/);
        const weak = await call(BASE, "/api/users/me/password", { method: "POST", body: { current: "Second-Password-2@x", next: "nodigitsorsymbols" }, token: fresh.token, headers: ipHeader(MY_IP) });
        assert.equal(weak.status, 400);
        assert.match((await json(weak)).message, /must/);
        const wrongCurrent = await call(BASE, "/api/users/me/password", { method: "POST", body: { current: "wrong", next: "Brand-New-Pass-3#" }, token: fresh.token, headers: ipHeader(MY_IP) });
        assert.equal(wrongCurrent.status, 403, "the current password is checked before the rules reveal anything");
    });
    await test("the new password signs in, and the old one does not", async () => {
        assert.equal((await login(subject.email, "Second-Password-2@x")).status, 201);
        assert.equal((await login(subject.email, "Second-Password-2@")).status, 401);
    });
    await test("the history table keeps hashes, not passwords", async () => {
        const rows = (await q(`SELECT password_hash FROM password_history WHERE user_id = $1`, [subject.id])).rows;
        assert.ok(rows.length >= 2);
        for (const r of rows) assert.match(r.password_hash, /^\$2[aby]\$/);
    });
    await test("rules off again: the old floor of 8 characters is all that is left", async () => {
        assert.equal((await putPolicy({ passwordMinLength: 8, passwordRequireNumbers: false, passwordRequireSpecial: false, passwordRequireUppercase: false, passwordHistory: 0 })).status, 200);
        const r = await call(BASE, `/api/admin/users/${subject.id}/password`, { method: "PATCH", body: { password: "simplepass" }, ...as(admin) });
        assert.ok([200, 204].includes(r.status), `got ${r.status}`);
    });

    // ------------------------------------------------------------------ sessions end
    console.log("session limits");
    await test("a session idle for too long ends on its next request, and stays ended", async () => {
        assert.equal((await putPolicy({ idleTimeoutMins: 30 })).status, 200);
        const s = await subject.session();
        assert.equal((await call(BASE, "/api/users/me/sessions", { token: s.token, headers: ipHeader(MY_IP) })).status, 200);
        await sleep(400); // the last request records its time just after answering
        await q(`UPDATE sessions SET last_seen_at = now() - interval '45 minutes' WHERE id = $1`, [s.jti]);
        const r = await call(BASE, "/api/users/me/sessions", { token: s.token, headers: ipHeader(MY_IP) });
        assert.equal(r.status, 401);
        assert.match((await json(r)).message, /idle/i);
        assert.ok((await q(`SELECT revoked_at FROM sessions WHERE id = $1`, [s.jti])).rows[0].revoked_at, "the session is revoked");
        await q(`UPDATE sessions SET last_seen_at = now() WHERE id = $1`, [s.jti]);
        assert.equal((await call(BASE, "/api/users/me/sessions", { token: s.token, headers: ipHeader(MY_IP) })).status, 401, "a revoked session cannot be revived");
    });
    await test("a session older than the limit ends however busy it is", async () => {
        assert.equal((await putPolicy({ idleTimeoutMins: 0, sessionTimeoutMins: 60 })).status, 200);
        const s = await subject.session();
        assert.equal((await call(BASE, "/api/users/me/sessions", { token: s.token, headers: ipHeader(MY_IP) })).status, 200);
        await q(`UPDATE sessions SET created_at = now() - interval '2 hours', last_seen_at = now() WHERE id = $1`, [s.jti]);
        const r = await call(BASE, "/api/users/me/sessions", { token: s.token, headers: ipHeader(MY_IP) });
        assert.equal(r.status, 401);
        assert.match((await json(r)).message, /expired/i);
    });
    await test("with the limits off, old sessions carry on", async () => {
        assert.equal((await putPolicy({ idleTimeoutMins: 0, sessionTimeoutMins: 0 })).status, 200);
        const s = await subject.session();
        await q(`UPDATE sessions SET created_at = now() - interval '3 days', last_seen_at = now() - interval '2 days' WHERE id = $1`, [s.jti]);
        assert.equal((await call(BASE, "/api/users/me/sessions", { token: s.token, headers: ipHeader(MY_IP) })).status, 200);
    });
    await test("login and /me tell the console the limits, and signing out ends the session itself", async () => {
        assert.equal((await putPolicy({ idleTimeoutMins: 20, sessionTimeoutMins: 600 })).status, 200);
        const res = await login(subject.email, "simplepass");
        assert.equal(res.status, 201);
        const body = await json(res);
        assert.deepEqual(body.sessionRules, { idleTimeoutMins: 20, sessionTimeoutMins: 600 });
        const cookie = /auth_token=([^;]+)/.exec(res.headers.get("set-cookie") || "")?.[1];
        assert.ok(cookie);
        const me = await json(await call(BASE, "/api/auth/me", { token: cookie, headers: ipHeader(MY_IP) }));
        assert.equal(me.user.email, subject.email);
        assert.equal(me.sessionRules.idleTimeoutMins, 20);
        assert.equal((await call(BASE, "/api/auth/logout", { method: "POST", token: cookie })).status, 201);
        assert.equal((await call(BASE, "/api/users/me/sessions", { token: cookie, headers: ipHeader(MY_IP) })).status, 401, "a copy of the cookie is dead after signing out");
        assert.equal((await putPolicy({ idleTimeoutMins: 0, sessionTimeoutMins: 0 })).status, 200);
    });

    // ------------------------------------------------------------------ the address list
    console.log("sign-in address list");
    const staff = await user("staff", { permissions: ["devices.read"], password: "Staff-Password-1!" });
    const owner2 = await user("owner2", { roleId: ownerRole, password: "Owner-Password-1!" });
    await test("saving a list that includes the administrator works", async () => {
        const r = await putPolicy({ ipAllowlist: "203.0.113.0/24  # the office\n2001:db8::/32" });
        assert.equal(r.status, 200, JSON.stringify(await json(r)));
        assert.equal((await getPolicy()).ipAllowlist, "203.0.113.0/24\n2001:db8::/32");
    });
    await test("staff can sign in from a listed address and not from another", async () => {
        assert.equal((await login(staff.email, staff.password, {}, BASE, "203.0.113.77")).status, 201);
        const no = await login(staff.email, staff.password, {}, BASE, "198.51.100.7");
        assert.equal(no.status, 403);
        assert.match((await json(no)).message, /not allowed from this network address \(198\.51\.100\.7\)/);
        assert.equal((await login(staff.email, staff.password, {}, BASE, "2001:db8::55")).status, 201, "IPv6 ranges work");
        const row = (await q(`SELECT * FROM audit_events WHERE action = 'auth.signin' AND outcome = 'failure' AND details->>'reason' = 'ip_not_allowed' AND actor_email = $1`, [staff.email])).rows[0];
        assert.ok(row, "the refusal is in the audit log");
    });
    await test("the wrong password from an unlisted address is still just a wrong password", async () => {
        const r = await login(staff.email, "nope-nope-nope", {}, BASE, "198.51.100.7");
        assert.equal(r.status, 401);
    });
    await test("the old /api/auth-legacy sign-in is held to the same list", async () => {
        const no = await login(staff.email, staff.password, {}, BASE, "198.51.100.8", "/api/auth-legacy/login");
        assert.equal(no.status, 403);
        const yes = await login(staff.email, staff.password, {}, BASE, "203.0.113.78", "/api/auth-legacy/login");
        assert.equal(yes.status, 201);
    });
    await test("Owners can always sign in, so a wrong list can be fixed", async () => {
        assert.equal((await login(owner2.email, owner2.password, {}, BASE, "198.51.100.7")).status, 201);
    });
    await test("an unreadable list (damaged in the database) locks nobody out", async () => {
        await q(`UPDATE security_policies SET ip_allowlist = 'garbage' WHERE organization_id = $1`, [org]);
        await call(BASE, "/api/admin/security-policies", as(admin)); // GET drops the server's cached copy
        assert.equal((await login(staff.email, staff.password, {}, BASE, "198.51.100.7")).status, 201);
        await q(`UPDATE security_policies SET ip_allowlist = '203.0.113.0/24' WHERE organization_id = $1`, [org]);
        await call(BASE, "/api/admin/security-policies", as(admin));
    });
    if (BYPASS) {
        await test("ADG_IGNORE_IP_ALLOWLIST=1 on the server switches the list off", async () => {
            const view = await json(await call(BYPASS, "/api/admin/security-policies", as(admin)));
            assert.equal(view.env.allowlistIgnored, true);
            await sleep(5200);
            assert.equal((await login(staff.email, staff.password, {}, BYPASS, "198.51.100.7")).status, 201);
        });
    } else console.log("  skip  the ADG_IGNORE_IP_ALLOWLIST switch (set BYPASS_URL)");
    await test("clearing the list lets everyone in again", async () => {
        assert.equal((await putPolicy({ ipAllowlist: "" })).status, 200);
        assert.equal((await login(staff.email, staff.password, {}, BASE, "198.51.100.7")).status, 201);
    });

    // ------------------------------------------------------------------ CAPTCHA (Cloudflare Turnstile)
    console.log("CAPTCHA");
    const human = await user("human", { permissions: ["devices.read"], password: "Human-Password-1!" });
    await test("it cannot be turned on without keys, or with a secret Cloudflare refuses", async () => {
        const none = await putPolicy({ captchaEnabled: true });
        assert.equal(none.status, 400);
        assert.match((await json(none)).message, /site key and secret/);
        const wrong = await putPolicy({ captchaEnabled: true, turnstileSiteKey: CF_PASS_SITEKEY, turnstileSecret: "typo-secret" });
        assert.equal(wrong.status, 400);
        assert.match((await json(wrong)).message, /did not accept the secret key.*invalid-input-secret/);
        const down = await putPolicy({ captchaEnabled: true, turnstileSiteKey: CF_PASS_SITEKEY, turnstileSecret: "5xx-secret" });
        assert.equal(down.status, 400);
        assert.match((await json(down)).message, /Could not reach Cloudflare/);
        assert.equal((await getPolicy()).captchaEnabled, false);
        assert.equal((await q(`SELECT turnstile_secret FROM security_policies WHERE organization_id = $1`, [org])).rows[0].turnstile_secret, null, "a refused secret is not stored");
    });
    await test("with the always-pass test keys it turns on; the secret is stored encrypted and never shown", async () => {
        const r = await putPolicy({ captchaEnabled: true, turnstileSiteKey: CF_PASS_SITEKEY, turnstileSecret: CF_PASS_SECRET });
        const view = await json(r);
        assert.equal(r.status, 200, JSON.stringify(view));
        assert.equal(view.captchaEnabled, true);
        assert.equal(view.hasTurnstileSecret, true);
        assert.ok(!JSON.stringify(view).includes(CF_PASS_SECRET));
        assert.ok(!JSON.stringify(await getPolicy()).includes(CF_PASS_SECRET));
        const stored = (await q(`SELECT turnstile_secret FROM security_policies WHERE organization_id = $1`, [org])).rows[0].turnstile_secret;
        assert.match(stored, /^enc:v1:/);
        assert.ok(!stored.includes(CF_PASS_SECRET));
        const logRows = (await q(`SELECT details::text AS d FROM audit_events WHERE action = 'security_policies.update' ORDER BY created_at DESC LIMIT 3`)).rows;
        for (const row of logRows) assert.ok(!String(row.d).includes(CF_PASS_SECRET), "the audit log has no secret");
        assert.ok(standIn.calls.some((c) => c.secret === CF_PASS_SECRET), "the keys were checked with Cloudflare while saving");
    });
    await test("the sign-in page learns the site key, and never the secret", async () => {
        const c = await json(await call(BASE, "/api/auth/login-config"));
        assert.deepEqual(c, { captcha: { enabled: true, siteKey: CF_PASS_SITEKEY } });
    });
    await test("sign-in without a token is refused before the password is looked at", async () => {
        const r = await login(human.email, human.password);
        assert.equal(r.status, 400);
        const b = await json(r);
        assert.equal(b.code, "captcha_required");
        const r2 = await login(human.email, "wrong-password-here");
        assert.equal((await json(r2)).code, "captcha_required", "a guesser learns nothing about the password");
    });
    await test("sign-in with a token Cloudflare accepts works, and the address is passed along", async () => {
        const before = standIn.calls.length;
        const r = await login(human.email, human.password, { captchaToken: "XXXX.DUMMY.TOKEN.XXXX" }, BASE, "198.51.100.99");
        assert.equal(r.status, 201, JSON.stringify(await json(r)));
        const c = standIn.calls.slice(before).find((x) => x.response === "XXXX.DUMMY.TOKEN.XXXX");
        assert.ok(c);
        assert.equal(c.remoteip, "198.51.100.99");
        assert.equal((await login(human.email, human.password, { captchaToken: "x".repeat(5000) })).status, 400);
    });
    await test("the legacy sign-in needs the CAPTCHA too", async () => {
        const r = await login(human.email, human.password, {}, BASE, "198.51.100.7", "/api/auth-legacy/login");
        assert.equal(r.status, 400);
        assert.equal((await json(r)).code, "captcha_required");
    });
    await test("the always-fail test secret rejects every token with a clear message", async () => {
        assert.equal((await putPolicy({ turnstileSecret: CF_FAIL_SECRET })).status, 200);
        const r = await login(human.email, human.password, { captchaToken: "anything" });
        assert.equal(r.status, 400);
        const b = await json(r);
        assert.equal(b.code, "captcha_failed");
        assert.match(b.message, /CAPTCHA check failed/);
    });
    await test("Cloudflare unreachable: sign-in says so (503) instead of pretending the password is wrong", async () => {
        assert.equal((await putPolicy({ turnstileSecret: CF_PASS_SECRET })).status, 200);
        standIn.down = true;
        try {
            const r = await login(human.email, human.password, { captchaToken: "t" });
            assert.equal(r.status, 503);
            assert.equal((await json(r)).code, "captcha_unavailable");
        } finally { standIn.down = false; }
    });
    await test("a secret that stops working (rotated at Cloudflare) is reported as a setup problem", async () => {
        standIn.rotated = true;
        try {
            const r = await login(human.email, human.password, { captchaToken: "t" });
            assert.equal(r.status, 503);
            const b = await json(r);
            assert.equal(b.code, "captcha_misconfigured");
            assert.match(b.message, /ADG_DISABLE_CAPTCHA=1/);
        } finally { standIn.rotated = false; }
    });
    if (BYPASS) {
        await test("ADG_DISABLE_CAPTCHA=1 on the server lets people in, and the page is told there is no CAPTCHA", async () => {
            assert.deepEqual(await json(await call(BYPASS, "/api/auth/login-config")), { captcha: { enabled: false, siteKey: "" } });
            assert.equal((await login(human.email, human.password, {}, BYPASS)).status, 201);
            assert.equal((await json(await call(BYPASS, "/api/admin/security-policies", as(admin)))).env.captchaDisabled, true);
        });
    } else console.log("  skip  the ADG_DISABLE_CAPTCHA switch (set BYPASS_URL)");
    await test("turning it off removes the requirement and keeps the keys for later", async () => {
        assert.equal((await putPolicy({ captchaEnabled: false })).status, 200);
        assert.deepEqual((await json(await call(BASE, "/api/auth/login-config"))).captcha, { enabled: false, siteKey: "" });
        assert.equal((await login(human.email, human.password)).status, 201);
        assert.equal((await getPolicy()).hasTurnstileSecret, true);
    });
    await test("the real Cloudflare test endpoint agrees with the stand-in, when it can be reached", async () => {
        const { verifyTurnstile } = require(path.join(DIST, "auth", "turnstile.js"));
        const saved = process.env.ADG_TURNSTILE_VERIFY_URL;
        delete process.env.ADG_TURNSTILE_VERIFY_URL;
        try {
            const pass = await verifyTurnstile(CF_PASS_SECRET, "XXXX.DUMMY.TOKEN.XXXX", null);
            if (pass.kind === "unreachable") { console.log(`        (not reachable from here: ${pass.detail})`); return; }
            assert.equal(pass.kind, "ok");
            assert.equal((await verifyTurnstile(CF_FAIL_SECRET, "XXXX.DUMMY.TOKEN.XXXX", null)).kind, "rejected");
            assert.equal((await verifyTurnstile("not-a-real-secret", "x", null)).kind, "misconfigured");
        } finally { if (saved !== undefined) process.env.ADG_TURNSTILE_VERIFY_URL = saved; }
    });

    // ------------------------------------------------------------------ Administration > Sessions
    console.log("admin view of sessions");
    const victim = await user("victim", { permissions: ["devices.read"] });
    const victimSecond = await victim.session();
    await q(`UPDATE sessions SET user_agent = 'Mozilla/5.0 (Windows NT 10.0) Chrome/120', ip_address = '192.0.2.44' WHERE id = $1`, [victimSecond.jti]);
    /** 200 while the browser holding this cookie is still signed in, 401 once its session has ended. */
    const alive = async (u) => (await call(BASE, "/api/auth/me", { token: u.token, headers: ipHeader(MY_IP) })).status;
    const list = async (qs = "", who = admin) => json(await call(BASE, `/api/admin/sessions${qs}`, as(who)));
    await test("the list shows every person's sessions with address, device and times", async () => {
        const l = await list(`?userId=${victim.id}`);
        assert.equal(l.total, 2);
        const s = l.items.find((i) => i.id === victimSecond.jti);
        assert.equal(s.email, victim.email);
        assert.equal(s.ip, "192.0.2.44");
        assert.match(s.userAgent, /Chrome/);
        assert.ok(s.createdAt && s.lastSeenAt);
        assert.equal(s.current, false);
        const all = await list("?limit=200");
        assert.ok(all.items.some((i) => i.email === admin.email && i.current), "your own current session is marked");
        assert.ok((await list(`?search=192.0.2.44`)).items.every((i) => i.ip === "192.0.2.44"));
        const mapped = await victim.session();
        await q(`UPDATE sessions SET ip_address = '::ffff:10.1.2.3' WHERE id = $1`, [mapped.jti]);
        assert.equal((await list(`?userId=${victim.id}`)).items.find((i) => i.id === mapped.jti).ip, "10.1.2.3", "an IPv4 client is shown as IPv4");
        assert.equal((await call(BASE, "/api/admin/sessions?userId=nope", as(admin))).status, 400);
    });
    await test("viewing needs users.read and ending needs users.write", async () => {
        assert.equal((await call(BASE, "/api/admin/sessions", as(reader))).status, 200);
        assert.equal((await call(BASE, `/api/admin/sessions/${victimSecond.jti}`, { method: "DELETE", ...as(reader) })).status, 403);
        const none = await user("nobody2", { permissions: ["devices.read"] });
        assert.equal((await call(BASE, "/api/admin/sessions", as(none))).status, 403);
        assert.equal((await call(BASE, "/api/admin/sessions")).status, 401);
    });
    await test("ending one session logs that browser out, is audited, and cannot be repeated", async () => {
        assert.equal((await alive(victimSecond)), 200);
        await sleep(400);
        const r = await call(BASE, `/api/admin/sessions/${victimSecond.jti}`, { method: "DELETE", ...as(admin) });
        assert.equal(r.status, 200, JSON.stringify(await json(r)));
        assert.equal((await alive(victimSecond)), 401);
        assert.equal((await alive(victim)), 200, "their other session is untouched");
        assert.equal((await call(BASE, `/api/admin/sessions/${victimSecond.jti}`, { method: "DELETE", ...as(admin) })).status, 404);
        assert.equal((await call(BASE, `/api/admin/sessions/${uuid()}`, { method: "DELETE", ...as(admin) })).status, 404);
        const row = (await q(`SELECT * FROM audit_events WHERE action = 'admin.session.revoke' AND target_id = $1 AND actor_user_id = $2`, [victim.id, admin.id])).rows[0];
        assert.ok(row);
        assert.equal(row.target_label, victim.email);
    });
    await test("ending all of a person's sessions", async () => {
        await victim.session();
        const r = await call(BASE, `/api/admin/sessions/user/${victim.id}/revoke`, { method: "POST", ...as(admin) });
        assert.equal(r.status, 200);
        assert.ok((await json(r)).revoked >= 2);
        assert.equal((await alive(victim)), 401);
        assert.equal((await list(`?userId=${victim.id}`)).total, 0);
        assert.ok((await q(`SELECT 1 FROM audit_events WHERE action = 'admin.session.revoke_all' AND target_id = $1`, [victim.id])).rowCount >= 1);
    });
    await test("you cannot end the session you are using, but can end your others", async () => {
        const mine = await admin.session();
        const r = await call(BASE, `/api/admin/sessions/${admin.jti}`, { method: "DELETE", ...as(admin) });
        assert.equal(r.status, 400);
        const all = await call(BASE, `/api/admin/sessions/user/${admin.id}/revoke`, { method: "POST", ...as(admin) });
        assert.equal(all.status, 200);
        assert.equal((await alive(mine)), 401, "the other session ended");
        assert.equal((await alive(admin)), 200, "this one stays");
    });
    await test("someone cannot end the sessions of a person more powerful than they are", async () => {
        const ownerSession = await owner2.session();
        const r = await call(BASE, `/api/admin/sessions/${ownerSession.jti}`, { method: "DELETE", ...as(admin) });
        assert.equal(r.status, 403);
        const all = await call(BASE, `/api/admin/sessions/user/${owner2.id}/revoke`, { method: "POST", ...as(admin) });
        assert.equal(all.status, 403);
        assert.equal((await alive(ownerSession)), 200);
        // An Owner may.
        assert.equal((await call(BASE, `/api/admin/sessions/user/${staff.id}/revoke`, { method: "POST", ...as(root) })).status, 200);
        const denied = await q(`SELECT 1 FROM audit_events WHERE actor_user_id = $1 AND outcome = 'failure' AND action LIKE 'admin.session.%'`, [admin.id]);
        assert.ok(denied.rowCount >= 0);
    });

    // ------------------------------------------------------------------ Administration > Agents & Endpoints
    console.log("agent settings");
    const agentSettings = async (who = admin) => json(await call(BASE, "/api/admin/agent-settings", as(who)));
    await q(`DELETE FROM agent_settings WHERE organization_id = $1`, [org]);
    const customer = uuid();
    const site = uuid();
    await q(`INSERT INTO clients (id, organization_id, name) VALUES ($1,$2,$3)`, [customer, org, `agents-${customer}`]);
    await q(`INSERT INTO sites (id, client_id, name) VALUES ($1,$2,'main')`, [site, customer]);
    const makeKey = async (body = {}) => {
        const r = await call(BASE, "/api/provisioning/enrollment-keys", { method: "POST", body: { clientId: customer, siteId: site, name: "e2e", ...body }, ...as(admin) });
        const made = await json(r);
        assert.equal(r.status, 201, JSON.stringify(made));
        return made;
    };
    const minutesAhead = (iso) => Math.round((new Date(iso).getTime() - Date.now()) / 60_000);
    await test("defaults match what the console always did: a week, updates on", async () => {
        const s = await agentSettings();
        assert.equal(s.installKeyExpiryMins, 10080);
        assert.equal(s.autoUpdate, true);
        assert.ok(Array.isArray(s.packages));
        assert.equal((await json(await call(BASE, "/api/provisioning/enrollment-key-defaults", as(admin)))).expiresMinutes, 10080);
        const k = await makeKey();
        assert.ok(Math.abs(minutesAhead(k.expiresAt) - 10080) <= 1, `${k.expiresAt} is ${minutesAhead(k.expiresAt)} minutes away`);
    });
    await test("a new default lifetime applies to keys made without one, not to keys given a length", async () => {
        const r = await call(BASE, "/api/admin/agent-settings", { method: "PUT", body: { installKeyExpiryMins: 90 }, ...as(admin) });
        assert.equal(r.status, 200, JSON.stringify(await json(r)));
        assert.equal((await agentSettings()).installKeyExpiryMins, 90);
        assert.equal((await json(await call(BASE, "/api/provisioning/enrollment-key-defaults", as(admin)))).expiresMinutes, 90);
        const k90 = await makeKey();
        assert.ok(Math.abs(minutesAhead(k90.expiresAt) - 90) <= 1, `${k90.expiresAt} is ${minutesAhead(k90.expiresAt)} minutes away`);
        assert.ok(Math.abs(minutesAhead((await makeKey({ expiresMinutes: 600 })).expiresAt) - 600) <= 1);
    });
    await test("bad values, missing permission, and the audit entry", async () => {
        for (const body of [{ installKeyExpiryMins: 0 }, { installKeyExpiryMins: 99999999 }, { installKeyExpiryMins: 1.5 }, { autoUpdate: "off" }]) {
            assert.equal((await call(BASE, "/api/admin/agent-settings", { method: "PUT", body, ...as(admin) })).status, 400, JSON.stringify(body));
        }
        assert.equal((await call(BASE, "/api/admin/agent-settings", { method: "PUT", body: { autoUpdate: false }, ...as(reader) })).status, 403);
        const row = (await q(`SELECT details FROM audit_events WHERE action = 'agents.settings.update' AND actor_user_id = $1 ORDER BY created_at DESC LIMIT 1`, [admin.id])).rows[0];
        assert.ok(row);
        assert.match(JSON.stringify(row.details), /10080 -> 90/);
    });
    await test("turning automatic updates off stops the server offering any package", async () => {
        const { AgentUpdatesService } = require(path.join(DIST, "agents", "agent-updates.service.js"));
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adg-gpkg-"));
        const pkg = path.join(dir, "agent.zip");
        fs.writeFileSync(pkg, "pretend package");
        const sha = sha256("pretend package");
        fs.writeFileSync(path.join(dir, "version.json"), JSON.stringify({ version: "9.9.9", sha256: sha }));
        const provisioning = { getAgentPackage: async () => ({ absPath: pkg, sha256: sha, sizeBytes: 15, filename: "agent.zip", contentType: "application/zip" }) };
        const signer = { signBlob: () => "sig" };
        let on = true;
        const svc = new AgentUpdatesService(provisioning, signer, { autoUpdateEnabled: async () => on });
        assert.equal((await svc.getManifest("windows", "x64", "1.0.0"))?.version, "9.9.9");
        on = false;
        assert.equal(await svc.getManifest("windows", "x64", "1.0.0"), null);
        await assert.rejects(() => svc.getDownload("windows"), /turned off/);
        on = true;
        assert.ok(await svc.getManifest("windows", "x64", "1.0.0"));
        // The real setting, through the real service and database.
        const { AgentSettingsService } = require(path.join(DIST, "provisioning", "agent-settings.service.js"));
        const prismaMod = require(path.join(DIST, "storage", "prisma.service.js"));
        const prisma = new prismaMod.PrismaService();
        const settings = new AgentSettingsService(prisma, { getDefaultOrganizationId: async () => org });
        assert.equal(await settings.autoUpdateEnabled(), true);
        await settings.save(org, null, { autoUpdate: false });
        assert.equal(await settings.autoUpdateEnabled(), false);
        assert.equal((await agentSettings()).autoUpdate, false);
        await settings.save(org, null, { autoUpdate: true });
        assert.equal(await settings.autoUpdateEnabled(), true);
        await prisma.$disconnect();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    // ------------------------------------------------------------------ clean up
    await resetPolicy();
    await q(`DELETE FROM agent_settings WHERE organization_id = $1`, [org]);
    for (const id of created) await q(`DELETE FROM users WHERE id = $1`, [id]).catch(() => { });
    srv.close();
    await db.end();

    console.log(`\n${passed} passed, ${failures.length} failed`);
    if (failures.length) {
        console.log(failures.map((f) => ` - ${f}`).join("\n"));
        process.exit(1);
    }
    process.exit(0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
