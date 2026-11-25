#!/usr/bin/env node
// Compares two backend builds across auth, 2FA, sessions, users and roles, each on its own
// throwaway database. The same scenario runs against both builds, using each build's own
// secrets, then the transcripts and the resulting rows must match.
//
//   node test/parity-batch6.e2e.cjs seed     (before the backends start)
//   node test/parity-batch6.e2e.cjs run      (once both are up)
//
// Required env: RIQ_E2E_ALLOW=1, JWT_SECRET, BASE_A, BASE_B, DB_A, DB_B, TEST_PASSWORD,
// ENROLLMENT_SECRET. Optional: DIST_B enables direct calls, SECRETS_FILE collects every
// secret seen so the caller can search the new build's log for them.
// It writes test rows, so it refuses any database whose name lacks "e2e".
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const { Client } = require("pg");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { authenticator } = require("otplib");

const { JWT_SECRET: SECRET, BASE_A, BASE_B, DB_A, DB_B, TEST_PASSWORD: PW, ENROLLMENT_SECRET, SECRETS_FILE } = process.env;
const COOKIE = process.env.AUTH_COOKIE_NAME || "auth_token";

const safe = (url) => {
    try {
        return /e2e/.test(new URL(url).pathname);
    } catch {
        return false;
    }
};
if (process.env.RIQ_E2E_ALLOW !== "1" || !SECRET || !PW || !ENROLLMENT_SECRET || !safe(DB_A) || !safe(DB_B)) {
    console.error("Refusing to run: set RIQ_E2E_ALLOW=1, JWT_SECRET, TEST_PASSWORD, ENROLLMENT_SECRET and e2e-named DB_A and DB_B.");
    process.exit(2);
}

const uid = (n) => `a0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isFixtureId = (s) => s.startsWith("a0000000-");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const secretNote = (v) => {
    if (SECRETS_FILE && v) fs.appendFileSync(SECRETS_FILE, `${v}\n`);
};

const ORG = uid(1);
const ROLE = { admin: uid(10), viewer: uid(11), technician: uid(12), system: uid(13), free: uid(14) };
const U = {};
const NAMES = [
    "admin", "viewer", "norole", "disabled", "invited", "mixed", "under_score", "guard", "xffok", "xffbad",
    "tfa", "tfarec", "tfareset", "tfarace", "sess", "sessother", "pwd", "pwdadmin", "limit", "target", "doomed",
    "first", "nameless", "blank", "minted",
];
NAMES.forEach((n, i) => (U[n] = uid(100 + i)));
const email = (n) => (n === "mixed" ? "MiXeD@Example.Test" : `${n}@example.test`);

const SESSION = { admin: uid(200), adminRevoked: uid(201), viewerOld: uid(202), viewerMid: uid(203), viewerNew: uid(204), adminUnknown: uid(205) };
const CLIENT = uid(300), SITE = uid(301), OTHER_SITE = uid(302);
const DEV = { oneTime: uid(310), wrong: uid(311), expired: uid(312), withAgent: uid(313), other: uid(314), keyNew: uid(315), race: uid(316), legacy: uid(317) };
const AGENT_SEED = uid(320);
const KEY = { good: uid(330), revoked: uid(331), expired: uid(332) };
const TOKENS = {
    oneTime: `${PW}-one-time`, expired: `${PW}-expired`, withAgent: `${PW}-with-agent`, race: `${PW}-race`,
    key: `${PW}-key`, keyRevoked: `${PW}-key-revoked`, keyExpired: `${PW}-key-expired`,
};
const AGENT_TOKEN = `${PW}-agent-token`;

const tok = (sub, jti, extra = {}, opts = {}) =>
    jwt.sign({ ...(sub === undefined ? {} : { sub }), email: "x@example.test", ...(jti === undefined ? {} : { jti }), ...extra }, opts.secret ?? SECRET, { expiresIn: opts.expiresIn ?? "1h" });
const adminCookie = tok(U.admin, SESSION.admin);
const viewerCookie = tok(U.viewer, SESSION.adminUnknown);

async function seedDb(db) {
    const hash = await bcrypt.hash(PW, 4);
    await db.query(`INSERT INTO organizations (id, name, slug) VALUES ($1,'Default Organization','default')`, [ORG]);
    await db.query(`INSERT INTO roles (id, organization_id, scope, name) VALUES ($1,$2,'organization','Admin'), ($3,$2,'organization','parity viewer'), ($4,$2,'organization','Technician'), ($5,$2,'organization','Unused')`, [ROLE.admin, ORG, ROLE.viewer, ROLE.technician, ROLE.free]);
    await db.query(`INSERT INTO roles (id, organization_id, scope, name) VALUES ($1,NULL,'system','Sysrole')`, [ROLE.system]);
    for (const perm of ["me.security", "me.read", "devices.read"]) {
        await db.query(`INSERT INTO role_permissions (role_id, permission_key) VALUES ($1,$2)`, [ROLE.viewer, perm]);
    }
    const details = { disabled: ["disabled"], invited: ["invited"], first: ["active", "Only", null], nameless: ["active", null, null], blank: ["active", "", ""] };
    for (const n of NAMES) {
        const [status, first, last] = details[n] ?? ["active", "Parity", n];
        await db.query(
            `INSERT INTO users (id, organization_id, email, first_name, last_name, status, password_hash, last_seen_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [U[n], ORG, email(n), first ?? null, last ?? null, status, hash, n === "first" ? "2026-01-01T00:00:00Z" : null],
        );
        if (n === "norole") continue;
        await db.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)`, [U[n], n === "admin" || n === "pwdadmin" ? ROLE.admin : ROLE.viewer]);
    }
    await db.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)`, [U.first, ROLE.system]);
    await db.query(`INSERT INTO sessions (id, user_id, refresh_token) VALUES ($1,$2,'x')`, [SESSION.admin, U.admin]);
    await db.query(`INSERT INTO sessions (id, user_id, refresh_token, revoked_at) VALUES ($1,$2,'x',now())`, [SESSION.adminRevoked, U.admin]);
    for (const [id, age, ip] of [[SESSION.viewerOld, "3 days", "192.0.2.1"], [SESSION.viewerMid, "2 days", "2001:db8::1"], [SESSION.viewerNew, "1 day", null]]) {
        await db.query(
            `INSERT INTO sessions (id, user_id, refresh_token, ip_address, user_agent, last_seen_at) VALUES ($1,$2,'x',$3,'seeded', now() - $4::interval)`,
            [id, U.viewer, ip, age],
        );
    }
    await db.query(`INSERT INTO clients (id, organization_id, name) VALUES ($1,$2,'Parity Client')`, [CLIENT, ORG]);
    await db.query(`INSERT INTO sites (id, client_id, name) VALUES ($1,$2,'Site A'), ($3,$2,'Site B')`, [SITE, CLIENT, OTHER_SITE]);
    for (const [k, id] of Object.entries(DEV)) {
        const site = k === "other" ? OTHER_SITE : k === "keyNew" || k === "legacy" ? null : SITE;
        if (k === "keyNew" || k === "legacy") continue; // these must not exist yet
        await db.query(`INSERT INTO devices (id, site_id, hostname, alias) VALUES ($1,$2,$3,'old alias')`, [id, site, `seed-${k}`]);
    }
    await db.query(
        `INSERT INTO agents (id, device_id, agent_uuid, version, facts, agent_token, token) VALUES ($1::uuid,$2,'',$3,'{"kept":1,"os":"old"}',$4,$4)`,
        [AGENT_SEED, DEV.withAgent, "1.0", AGENT_TOKEN],
    );
    const enroll = [[DEV.oneTime, TOKENS.oneTime, "1 hour"], [DEV.expired, TOKENS.expired, "-1 hour"], [DEV.withAgent, TOKENS.withAgent, "1 hour"], [DEV.race, TOKENS.race, "1 hour"]];
    for (const [dev, token, exp] of enroll) {
        await db.query(
            `INSERT INTO endpoint_enrollments (client_id, site_id, device_id, os, alias, token_hash, expires_at) VALUES ($1,$2,$3,'windows','enrolled alias',$4, now() + $5::interval)`,
            [CLIENT, SITE, dev, sha256(token), exp],
        );
    }
    for (const [id, token, exp, revoked] of [[KEY.good, TOKENS.key, "1 hour", null], [KEY.revoked, TOKENS.keyRevoked, "1 hour", "now"], [KEY.expired, TOKENS.keyExpired, "-1 hour", null]]) {
        await db.query(
            `INSERT INTO site_enrollment_keys (id, client_id, site_id, name, token_hash, expires_at, revoked_at) VALUES ($1,$2,$3,'k',$4, now() + $5::interval, $6::timestamptz)`,
            [id, CLIENT, SITE, sha256(token), exp, revoked],
        );
    }
}

const SECRET_KEYS = new Set(["challengeToken", "token", "secret", "otpauthUrl", "qrPngDataUrl", "agentToken"]);

// Volatile fields are compared for presence only; secrets are noted, then masked.
function normalize(value, key) {
    if (Array.isArray(value)) {
        if (key === "recoveryCodes") {
            value.forEach(secretNote);
            return `<${value.length} codes>`;
        }
        const items = value.map((v) => normalize(v));
        if (key === "permissions") return items.sort();
        // Live session rows race with the heartbeat; the seeded order is checked through "items".
        if (key === "sessions" || key === "events") return items.map((v) => JSON.stringify(v)).sort();
        return items;
    }
    if (value instanceof Date) return "<time>";
    if (value && typeof value === "object") {
        const out = {};
        for (const k of Object.keys(value).sort()) {
            const volatile = /(_at|At|^at)$/.test(k) && value[k] !== null && value[k] !== undefined;
            if (SECRET_KEYS.has(k) && typeof value[k] === "string") {
                secretNote(value[k]);
                out[k] = "<secret>";
            } else {
                out[k] = volatile ? "<time>" : normalize(value[k], k);
            }
        }
        return out;
    }
    if (typeof value === "string" && UUID.test(value) && !isFixtureId(value)) return "<uuid>";
    return value;
}

function cookieShape(header) {
    const [pair, ...attrs] = header.split(";").map((s) => s.trim());
    const i = pair.indexOf("=");
    return {
        name: pair.slice(0, i),
        value: pair.slice(i + 1) ? "<set>" : "<empty>",
        attrs: attrs.filter((a) => !/^expires=/i.test(a)).sort(),
    };
}

async function call(base, { method = "GET", path, body, cookie, bearer, xff, rawBody }) {
    const res = await fetch(`${base}${path}`, {
        method,
        headers: {
            ...(body !== undefined || rawBody ? { "content-type": "application/json" } : {}),
            ...(cookie ? { cookie: `${COOKIE}=${cookie}` } : {}),
            ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
            ...(xff !== undefined ? { "x-forwarded-for": xff } : {}),
        },
        body: rawBody ?? (body !== undefined ? JSON.stringify(body) : undefined),
    });
    const text = await res.text();
    let parsed = text;
    try {
        parsed = text ? JSON.parse(text) : null;
    } catch {
        /* keep text */
    }
    const setCookies = res.headers.getSetCookie();
    const authCookie = setCookies.find((c) => c.startsWith(`${COOKIE}=`));
    const newCookie = authCookie ? authCookie.split(";")[0].slice(COOKIE.length + 1) : null;
    if (newCookie) secretNote(newCookie);
    return { status: res.status, raw: parsed, newCookie, setCookie: setCookies.map(cookieShape) };
}

const RACE_IP = "198.51.100.50";
const LOGIN = "/api/auth/login";
const VERIFY = "/api/auth/2fa/verify";
const ME = "/api/users/me";
const USERS = "/api/admin/users";
const ROLES = "/api/roles";

/** Every step's outcome for one build; the two transcripts are compared by position. */
function makeContext(base) {
    const log = [];
    const step = async (label, req, opts = {}) => {
        const r = await call(base, req);
        log.push({ label, status: r.status, body: normalize(r.raw), setCookie: r.setCookie, known: opts.known });
        return r;
    };
    const login = async (name, extra = {}) => step(`login ${name}`, { method: "POST", path: LOGIN, body: { email: email(name), password: PW, ...extra } });
    return { log, step, login, base };
}

const post = (path, body, cookie, more = {}) => ({ method: "POST", path, body, cookie, ...more });
const patch = (path, body, cookie) => ({ method: "PATCH", path, body, cookie });
const del = (path, cookie) => ({ method: "DELETE", path, cookie });
const get = (path, cookie, more = {}) => ({ path, cookie, ...more });

/** Session lists hold live rows whose order races with the heartbeat, so compare them sorted. */
const sessionsSorted = async (ctx, label, cookie, more = {}) => {
    const r = await call(ctx.base, get(`${ME}/sessions`, cookie, more));
    const items = (r.raw?.items ?? []).map((i) => JSON.stringify(normalize(i))).sort();
    ctx.log.push({ label, status: r.status, body: items, setCookie: r.setCookie });
    return r.raw?.items ?? [];
};

async function guards(ctx) {
    const { step } = ctx;
    const known = (expect) => ({ known: expect });
    const guarded = `${ME}/security`;
    const cases = {
        "valid session": [tok(U.guard, SESSION.adminUnknown)],
        "wrong secret": [tok(U.guard, undefined, {}, { secret: "wrong" })],
        "expired": [tok(U.guard, SESSION.adminUnknown, {}, { expiresIn: -10 })],
        "garbage": ["not.a.jwt"],
        "sub malformed": [tok("not-a-uuid", SESSION.adminUnknown)],
        "sub number": [tok(12345, SESSION.adminUnknown)],
        "sub missing": [tok(undefined, SESSION.adminUnknown)],
        "sub unknown": [tok(uid(999), SESSION.adminUnknown)],
        "sub uppercase": [tok(U.guard.toUpperCase(), SESSION.adminUnknown)],
        "sub of disabled user": [tok(U.disabled, SESSION.adminUnknown)],
        "sub of invited user": [tok(U.invited, SESSION.adminUnknown)],
        "challenge token": [tok(U.guard, uid(998), { typ: "2fa_challenge" })],
        "jti unknown": [tok(U.guard, uid(997))],
        "jti revoked": [tok(U.admin, SESSION.adminRevoked)],
        "jti malformed": [tok(U.guard, "not-a-uuid"), { malformedJti: true }],
        "jti number": [tok(U.guard, 12345), { malformedJti: true }],
        "jti empty": [tok(U.guard, ""), { malformedJti: true, minted: true }],
    };
    for (const [name, [token, flags = {}]] of Object.entries(cases)) {
        const opt = flags.malformedJti ? known("malformed-jti") : {};
        await step(`guard cookie: ${name}`, get(guarded, token), opt);
        await step(`guard bearer: ${name}`, get(guarded, null, { bearer: token }), opt);
        await step(`auth/me: ${name}`, get("/api/auth/me", token), opt);
        await step(`legacy me: ${name}`, get("/api/auth-legacy/me", token), opt);
    }
    const missing = tok(U.minted);
    await step("guard: missing jti mints a session cookie", get(guarded, missing));
    await step("guard: missing jti as bearer", get(guarded, null, { bearer: missing }));
    await step("guard: no token", get(guarded));
    await step("permissions guard: no perms", get(USERS, viewerCookie));
    await step("bad cookie beats good bearer", get(guarded, "not.a.jwt", { bearer: adminCookie }));
    await step("admin route as cookie", get("/api/admin/environment", adminCookie));
    await step("human guard: bearer refused", get("/api/admin/environment", null, { bearer: adminCookie }));
    await step("human guard: unknown session refused", get("/api/admin/environment", tok(U.admin, uid(996))));
    await step("human guard: revoked session refused", get("/api/admin/environment", tok(U.admin, SESSION.adminRevoked)));
    await step("human guard: session of another user refused", get("/api/admin/environment", tok(U.pwdadmin, SESSION.admin)));
    await step("public branding with token", get("/api/branding", adminCookie));
}

async function logins(ctx) {
    const { step, login } = ctx;
    const r = await login("admin");
    await step("auth/me after login", get("/api/auth/me", r.newCookie));
    await step("protected after login", get(`${ME}/security`, r.newCookie));
    await step("legacy me after login", get("/api/auth-legacy/me", r.newCookie));
    await step("auth/me no cookie", get("/api/auth/me"));
    await step("legacy me no cookie", get("/api/auth-legacy/me"));
    await step("logout", post("/api/auth/logout", undefined, r.newCookie));
    await step("legacy logout", post("/api/auth-legacy/logout", undefined, r.newCookie));
    for (const prefix of ["/api/auth", "/api/auth-legacy"]) {
        const at = (label, body) => step(`${prefix} ${label}`, post(`${prefix}/login`, body, null, { xff: "198.51.100.30" }));
        await at("correct", { email: email("viewer"), password: PW });
        await at("wrong password", { email: email("viewer"), password: "wrong-password" });
        await at("unknown user", { email: "nobody@example.test", password: PW });
        await at("disabled", { email: email("disabled"), password: PW });
        await at("invited", { email: email("invited"), password: PW });
        await at("stored mixed, sent lower", { email: "mixed@example.test", password: PW });
        await at("stored mixed, sent upper", { email: "MIXED@EXAMPLE.TEST", password: PW });
        await at("stored lower, sent mixed", { email: "ViEwEr@Example.Test", password: PW });
        await at("spaces", { email: ` ${email("viewer")} `, password: PW });
        await at("like wildcards", { email: "%@example.test", password: PW });
        await at("underscore wildcard", { email: "under-score@example.test", password: PW });
        await at("real underscore", { email: "under_score@example.test", password: PW });
        await at("no role", { email: email("norole"), password: PW });
        await at("no email", { password: PW });
        await at("no password", { email: email("viewer") });
        await at("email object", { email: { contains: "@" }, password: PW });
        await at("email number", { email: 5, password: PW });
        await at("email array", { email: [email("viewer")], password: PW });
        await at("password object", { email: email("viewer"), password: { not: "x" } });
        await at("empty body", {});
    }
    await step("login invalid json", { method: "POST", path: LOGIN, rawBody: "{nope" });
    for (let i = 0; i < 11; i++) await step(`limit: wrong ${i}`, post(LOGIN, { email: email("limit"), password: "wrong-password" }, null, { xff: "198.51.100.10" }));
    await step("limit: right password while blocked", post(LOGIN, { email: email("limit"), password: PW }, null, { xff: "198.51.100.11" }));
    await step("limit: case variant blocked too", post(LOGIN, { email: email("limit").toUpperCase(), password: PW }, null, { xff: "198.51.100.12" }));
    for (let i = 0; i < 31; i++) await step(`limit by ip ${i}`, post(LOGIN, { email: `nobody${i}@example.test`, password: "x" }, null, { xff: "198.51.100.20" }));
}

async function xff(ctx) {
    const { step } = ctx;
    const good = ["192.0.2.10", "192.0.2.11, 192.0.2.12", "2001:db8::2", "::ffff:192.0.2.13", " 192.0.2.14 ", ""];
    let last;
    for (const value of good) {
        last = await step(`xff ok login [${value}]`, post(LOGIN, { email: email("xffok"), password: PW }, null, { xff: value }));
    }
    // The address is written after the response, so only the status is comparable here.
    const forwarded = await call(ctx.base, get(`${ME}/security`, last.newCookie, { xff: "192.0.2.99" }));
    ctx.log.push({ label: "xff ok: guard with valid forwarded", status: forwarded.status, setCookie: forwarded.setCookie });
    await sleep(300);
    // Sent with the same address, because this request also rewrites its own session's address.
    await sessionsSorted(ctx, "xff ok sessions", last.newCookie, { xff: "192.0.2.99" });
    const bad = ["garbage", "999.1.1.1", "fe80::1%eth0", "1.2.3", "'; DROP TABLE sessions;--", "unknown"];
    for (const value of bad) {
        const r = await step(`xff bad login [${value}]`, post(LOGIN, { email: email("xffbad"), password: PW }, null, { xff: value }), { known: "bad-xff" });
        if (r.newCookie) last = r.newCookie;
    }
    await step("xff bad cidr login", post(LOGIN, { email: email("xffbad"), password: PW }, null, { xff: "10.0.0.1/24" }), {});
    // A request with a bad header on an existing session must still pass.
    const session = tok(U.xffok, SESSION.adminUnknown);
    await step("xff bad on guarded request", get(`${ME}/security`, session, { xff: "garbage" }));
    await step("xff bad on public me", get("/api/auth/me", session, { xff: "garbage" }));
}

async function twoFactor(ctx) {
    const { step, login } = ctx;
    const sessionCookie = (await login("tfa")).newCookie;
    await step("confirm before start", post(`${ME}/2fa/confirm`, { code: "123456" }, sessionCookie));
    await step("regen before enable", post(`${ME}/2fa/recovery/regen`, undefined, sessionCookie));
    const start = await step("2fa start", post(`${ME}/2fa/start`, undefined, sessionCookie));
    const { secret } = start.raw;
    await step("login still no challenge before confirm", post(LOGIN, { email: email("tfa"), password: PW }));
    await step("confirm malformed", post(`${ME}/2fa/confirm`, { code: "12" }, sessionCookie));
    const code = () => authenticator.generate(secret);
    const wrong = () => (code() === "000000" ? "000001" : "000000");
    await step("confirm wrong", post(`${ME}/2fa/confirm`, { code: wrong() }, sessionCookie));
    const confirmed = await step("confirm right", post(`${ME}/2fa/confirm`, { code: code() }, sessionCookie));
    const recovery = confirmed.raw.recoveryCodes;
    await step("overview shows enabled", get(`${ME}/security`, sessionCookie));

    const challenge = async (label = "challenge", extra = {}) => (await login(`tfa ${label}`.replace("tfa ", "tfa ") && "tfa", extra)).raw.challengeToken;

    let c = await challenge();
    await step("challenge is no cookie", get(`${ME}/security`, c));
    await step("challenge is no bearer", get(`${ME}/security`, null, { bearer: c }));
    await step("challenge on auth/me", get("/api/auth/me", c));
    await step("verify neither code", post(VERIFY, { challengeToken: c }));
    await step("verify bad format code", post(VERIFY, { challengeToken: c, code: "abc" }));
    await step("verify garbage challenge", post(VERIFY, { challengeToken: "garbage", code: "123456" }));
    await step("verify session token as challenge", post(VERIFY, { challengeToken: adminCookie, code: "123456" }));
    await step("verify forged jti", post(VERIFY, { challengeToken: tok(U.tfa, "not-a-uuid", { typ: "2fa_challenge" }), code: code() }));
    await step("verify forged sub", post(VERIFY, { challengeToken: tok("not-a-uuid", uid(995), { typ: "2fa_challenge" }), code: code() }));
    await step("verify unknown challenge row", post(VERIFY, { challengeToken: tok(U.tfa, uid(995), { typ: "2fa_challenge" }), code: code() }));
    await step("verify wrong code", post(VERIFY, { challengeToken: c, code: wrong() }));
    await step("verify after wrong code: consumed", post(VERIFY, { challengeToken: c, code: code() }));

    c = await challenge();
    const ok = await step("verify right code", post(VERIFY, { challengeToken: c, code: code() }));
    await step("session from verify works", get(`${ME}/security`, ok.newCookie));
    await step("verify replay: consumed", post(VERIFY, { challengeToken: c, code: code() }));

    c = await challenge();
    await step("legacy verify", post("/api/auth-legacy/2fa/verify", { challengeToken: c, code: code() }));

    c = await challenge();
    await step("recovery code", post(VERIFY, { challengeToken: c, recoveryCode: recovery[0] }));
    c = await challenge();
    await step("recovery code second use", post(VERIFY, { challengeToken: c, recoveryCode: recovery[0] }));
    c = await challenge();
    await step("recovery code lower case", post(VERIFY, { challengeToken: c, recoveryCode: recovery[1].toLowerCase() }));
    c = await challenge();
    await step("recovery code wrong", post(VERIFY, { challengeToken: c, recoveryCode: "AAAA-BBBB-CCCC" }));

    c = await challenge();
    await step("trust device", post(VERIFY, { challengeToken: c, code: code(), rememberDevice: true, deviceFingerprint: "device-1" }));
    await login("tfa", { deviceFingerprint: "device-1" });
    await login("tfa", { deviceFingerprint: "device-2" });
    await login("tfa", { deviceFingerprint: { not: "x" } });
    await login("tfa", { deviceFingerprint: { contains: "device" } });
    await login("tfa", { deviceFingerprint: ["device-1"] });
    await login("tfa", { deviceFingerprint: 5 });
    await login("tfa", { deviceFingerprint: "" });
    c = await challenge();
    await step("trust device twice", post(VERIFY, { challengeToken: c, code: code(), rememberDevice: true, deviceFingerprint: "device-1" }));
    c = await challenge();
    await step("trust without fingerprint", post(VERIFY, { challengeToken: c, code: code(), rememberDevice: true }));
    c = await challenge();
    await step("verify non-string fingerprint", post(VERIFY, { challengeToken: c, code: code(), rememberDevice: true, deviceFingerprint: { not: "x" } }));

    await sleep(10_500); // per-user security rate limits
    const regen = await step("regen", post(`${ME}/2fa/recovery/regen`, undefined, sessionCookie));
    c = await challenge();
    await step("old code dead after regen", post(VERIFY, { challengeToken: c, recoveryCode: recovery[2] }));
    c = await challenge();
    await step("new code after regen", post(VERIFY, { challengeToken: c, recoveryCode: regen.raw.recoveryCodes[0] }));
    await step("disable wrong code", post(`${ME}/2fa/disable`, { code: wrong() }, sessionCookie));
    await step("disable wrong recovery", post(`${ME}/2fa/disable`, { recoveryCode: "AAAA-BBBB-CCCC" }, sessionCookie));
    await step("disable nothing", post(`${ME}/2fa/disable`, {}, sessionCookie));
    await step("disable with used recovery", post(`${ME}/2fa/disable`, { recoveryCode: regen.raw.recoveryCodes[0] }, sessionCookie));
    await step("disable right recovery", post(`${ME}/2fa/disable`, { recoveryCode: regen.raw.recoveryCodes[1] }, sessionCookie));
    await login("tfa");
    await sleep(10_500);
    await step("disable when already off", post(`${ME}/2fa/disable`, { code: "123456" }, sessionCookie));
    const again = await step("restart", post(`${ME}/2fa/start`, undefined, sessionCookie));
    await step("confirm again", post(`${ME}/2fa/confirm`, { code: authenticator.generate(again.raw.secret) }, sessionCookie));
    await step("disable right code", post(`${ME}/2fa/disable`, { code: authenticator.generate(again.raw.secret) }, sessionCookie));

    // Admin reset, with a user who has never had a security row.
    const other = (await login("tfareset")).newCookie;
    const s2 = await step("reset user: start", post(`${ME}/2fa/start`, undefined, other));
    await step("reset user: confirm", post(`${ME}/2fa/confirm`, { code: authenticator.generate(s2.raw.secret) }, other));
    await login("tfareset");
    await step("admin reset by viewer refused", post(`${USERS}/${U.tfareset}/reset-2fa`, undefined, viewerCookie));
    await step("admin reset", post(`${USERS}/${U.tfareset}/reset-2fa`, undefined, adminCookie));
    await login("tfareset");
    await step("admin reset of user without row", post(`${USERS}/${U.target}/reset-2fa`, undefined, adminCookie));
    await step("admin reset unknown", post(`${USERS}/${uid(994)}/reset-2fa`, undefined, adminCookie));
    await step("disable with no row", post(`${ME}/2fa/disable`, {}, tok(U.sessother, SESSION.adminUnknown)));
    await step("start hits rate limit eventually", post(`${ME}/2fa/start`, undefined, tok(U.sessother, SESSION.adminUnknown)));
}

async function sessions(ctx) {
    const { step, login } = ctx;
    await step("seeded order is by last seen", get(`${ME}/sessions`, viewerCookie));
    await step("sessions trailing slash", get(`${ME}/sessions/`, viewerCookie));
    await step("overview with seeded sessions", get(`${ME}/security`, viewerCookie));

    const one = (await login("sess")).newCookie;
    const two = (await login("sess")).newCookie;
    const three = (await login("sess")).newCookie;
    const four = (await login("sess")).newCookie;
    const idOf = (t) => jwt.decode(t).jti;
    await sessionsSorted(ctx, "sessions list", one);
    await step("trust", post(`${ME}/sessions/${idOf(two)}/trust`, { trusted: true }, one));
    await step("untrust", post(`${ME}/sessions/${idOf(three)}/trust`, { trusted: false }, one));
    await step("trust non-bool", post(`${ME}/sessions/${idOf(two)}/trust`, { trusted: "maybe" }, one));
    await step("trust malformed id", post(`${ME}/sessions/not-a-uuid/trust`, { trusted: true }, one));
    await step("trust unknown", post(`${ME}/sessions/${uid(993)}/trust`, { trusted: true }, one));
    await step("trust someone else's", post(`${ME}/sessions/${SESSION.viewerOld}/trust`, { trusted: true }, one));
    await sessionsSorted(ctx, "sessions after trust", one);
    await step("revoke current refused", del(`${ME}/sessions/${idOf(one)}`, one));
    await step("revoke malformed", del(`${ME}/sessions/not-a-uuid`, one));
    await step("revoke unknown", del(`${ME}/sessions/${uid(993)}`, one));
    await step("revoke someone else's", del(`${ME}/sessions/${SESSION.viewerOld}`, one));
    await step("before revoke: works", get(`${ME}/security`, two));
    await step("revoke", del(`${ME}/sessions/${idOf(two)}`, one));
    await step("revoked: next request 401", get(`${ME}/security`, two));
    await step("revoked: auth/me", get("/api/auth/me", two));
    await step("revoked: legacy me", get("/api/auth-legacy/me", two));
    await step("revoked: bearer", get(`${ME}/security`, null, { bearer: two }));
    await step("revoke twice", del(`${ME}/sessions/${idOf(two)}`, one));
    await step("trust revoked", post(`${ME}/sessions/${idOf(two)}/trust`, { trusted: true }, one));
    await sleep(10_500);
    await step("revoke by body malformed", post(`${ME}/sessions/revoke`, { sessionId: "not-a-uuid" }, one));
    await step("revoke by body", post(`${ME}/sessions/revoke`, { sessionId: idOf(three) }, one));
    await step("revoked by body: 401", get(`${ME}/security`, three));
    await step("revoke-all", post(`${ME}/sessions/revoke-all`, undefined, one));
    await step("revoke-all: other 401", get(`${ME}/security`, four));
    await step("revoke-all: current ok", get(`${ME}/security`, one));
    await sessionsSorted(ctx, "sessions after revoke-all", one);
    await step("other user's sessions untouched", get(`${ME}/sessions`, viewerCookie));
    const bearerAll = (await login("sessother")).newCookie;
    const keep = (await login("sessother")).newCookie;
    await step("revoke-all as bearer", post(`${ME}/sessions/revoke-all`, undefined, null, { bearer: bearerAll }));
    await step("bearer's target revoked", get(`${ME}/security`, keep));
    await step("revoke-all with no jti cookie", post(`${ME}/sessions/revoke-all`, undefined, tok(U.sessother)));

    // Personal access tokens
    await step("tokens empty", get(`${ME}/tokens`, one));
    const pat = await step("token create", post(`${ME}/tokens`, { name: "  ci  " }, one));
    await step("token create blank", post(`${ME}/tokens`, { name: "   " }, one));
    await step("token create non-string", post(`${ME}/tokens`, { name: 5 }, one));
    await step("tokens list", get(`${ME}/tokens`, one));
    await step("token revoke malformed", post(`${ME}/tokens/revoke`, { id: "not-a-uuid" }, one));
    await step("token revoke unknown", post(`${ME}/tokens/revoke`, { id: uid(992) }, one));
    await step("token revoke someone else's", post(`${ME}/tokens/revoke`, { id: pat.raw.id }, viewerCookie));
    await step("token revoke", post(`${ME}/tokens/revoke`, { id: pat.raw.id }, one));
    await step("token revoke twice", post(`${ME}/tokens/revoke`, { id: pat.raw.id }, one));
    await step("tokens after revoke", get(`${ME}/tokens`, one));

    // Passwords
    const pwd = (await login("pwd")).newCookie;
    const NEW = `${PW}-new`;
    secretNote(NEW);
    await step("password wrong current", post(`${ME}/password`, { current: "wrong-password", next: NEW }, pwd));
    await step("password too short", post(`${ME}/password`, { current: PW, next: "short" }, pwd));
    await step("password same", post(`${ME}/password`, { current: PW, next: PW }, pwd));
    await step("password change", post(`${ME}/password`, { current: PW, next: NEW }, pwd));
    await step("old password dead", post(LOGIN, { email: email("pwd"), password: PW }));
    await step("new password works", post(LOGIN, { email: email("pwd"), password: NEW }));
    await step("session survives change", get(`${ME}/security`, pwd));
    await step("admin reset password", patch(`${USERS}/${U.pwdadmin}/password`, { password: NEW }, adminCookie));
    await step("admin reset password post", post(`${USERS}/${U.pwdadmin}/password`, { password: NEW }, adminCookie));
    await step("admin reset too short", patch(`${USERS}/${U.pwdadmin}/password`, { password: "x" }, adminCookie));
    await step("admin reset unknown", patch(`${USERS}/${uid(991)}/password`, { password: NEW }, adminCookie));
    await step("admin reset by viewer", patch(`${USERS}/${U.pwdadmin}/password`, { password: NEW }, viewerCookie));
    await step("reset: old dead", post(LOGIN, { email: email("pwdadmin"), password: PW }));
    await step("reset: new works", post(LOGIN, { email: email("pwdadmin"), password: NEW }));
    for (let i = 0; i < 7; i++) await step(`password rate limit ${i}`, post(`${ME}/password`, { current: "x", next: "y" }, tok(U.target, SESSION.adminUnknown)));
}

async function users(ctx) {
    const { step } = ctx;
    const list = (q, cookie = adminCookie) => step(`users list ${q}`, get(`${USERS}${q}`, cookie));
    await list("", null);
    await list("", viewerCookie);
    for (const sortKey of ["name", "email", "role", "lastSeen"]) {
        for (const sortDir of ["asc", "desc"]) await list(`?pageSize=100&sortKey=${sortKey}&sortDir=${sortDir}`);
    }
    for (const q of ["?page=2&pageSize=5", "?page=99", "?page=0", "?pageSize=0", "?page=x", "?sortKey=password_hash", "?sortDir=sideways",
        "?q=PARITY&pageSize=100", "?q=%25&pageSize=100", "?q=_&pageSize=100", "?q=under_score", "?q=only", "?q=%20parity%20admin", "?q=MIXED", "?q=@EXAMPLE.TEST&pageSize=100", "?q=nomatch", "?q='%20OR%201=1--",
        "?status=active&pageSize=100", "?status=invited", "?status=suspended", "?status=all&pageSize=100", "?status=bogus",
        `?role=${ROLE.admin}`, "?role=admin", "?role=ADMIN", "?role=parity%20viewer&pageSize=100", "?role=all&pageSize=100", "?role=%25", `?role=${uid(990)}`, "?role=not-a-uuid"]) await list(q);
    await step("user roles", get(`${USERS}/roles`, adminCookie));
    await step("user roles as viewer", get(`${USERS}/roles`, viewerCookie));

    const w = (label, req) => step(label, req);
    const created = await w("create", post(`${USERS}/create`, { name: "New  Middle Person", email: "NEW@Example.Test", password: PW, role: "technician" }, adminCookie));
    await w("create login", post(LOGIN, { email: "new@example.test", password: PW }));
    await w("create existing upserts", post(`${USERS}/create`, { name: "Solo", email: "new@EXAMPLE.test", password: `${PW}-2`, status: "suspended" }, adminCookie));
    await w("upserted user disabled", post(LOGIN, { email: "new@example.test", password: `${PW}-2` }));
    await w("create over stored mixed case", post(`${USERS}/create`, { name: "Mixed Over", email: "mixed@example.test", password: PW, status: "active" }, adminCookie));
    await w("create short password", post(`${USERS}/create`, { name: "x", email: "s@example.test", password: "x" }, adminCookie));
    await w("create bad email", post(`${USERS}/create`, { name: "x", email: "nope", password: PW }, adminCookie));
    await w("create bad status", post(`${USERS}/create`, { name: "x", email: "s@example.test", password: PW, status: "bogus" }, adminCookie));
    await w("create by viewer", post(`${USERS}/create`, { name: "x", email: "s@example.test", password: PW }, viewerCookie));
    await w("create invited status", post(`${USERS}/create`, { name: "Inv", email: "inv@example.test", password: PW, status: "invited" }, adminCookie));
    await w("create with system role", post(`${USERS}/create`, { name: "Sys", email: "sys@example.test", password: PW, role: "sysrole" }, adminCookie));
    await w("create with wildcard role", post(`${USERS}/create`, { name: "Wild", email: "wild@example.test", password: PW, role: "%" }, adminCookie));
    await w("create with uuid role", post(`${USERS}/create`, { name: "Uuid", email: "uuid@example.test", password: PW, role: ROLE.viewer }, adminCookie));
    await w("create with unknown uuid role", post(`${USERS}/create`, { name: "Ghost", email: "ghost@example.test", password: PW, role: uid(989) }, adminCookie));
    await w("invite", post(`${USERS}/invite`, { name: "Invited  One", email: "Invite1@Example.test", role: "parity viewer" }, adminCookie));
    await w("invite no name", post(`${USERS}/invite`, { email: "invite2@example.test" }, adminCookie));
    await w("invite existing active flips to invited", post(`${USERS}/invite`, { email: email("target") }, adminCookie));
    await w("invited target cannot log in", post(LOGIN, { email: email("target"), password: PW }));
    await w("invite stored mixed case", post(`${USERS}/invite`, { email: "mixed@EXAMPLE.test", name: "Mix" }, adminCookie));
    await w("invite bad email", post(`${USERS}/invite`, { email: "nope" }, adminCookie));
    await w("invite by viewer", post(`${USERS}/invite`, { email: "v@example.test" }, viewerCookie));
    await w("bulk", post(`${USERS}/invite/bulk`, { invites: [{ email: "b1@example.test" }, { email: "b2@example.test", name: "B Two", role: "admin" }] }, adminCookie));
    await w("bulk empty", post(`${USERS}/invite/bulk`, { invites: [] }, adminCookie));
    await w("bulk missing", post(`${USERS}/invite/bulk`, {}, adminCookie));
    const id = created.raw.id;
    await w("role by name", patch(`${USERS}/${id}/role`, { role: "parity viewer" }, adminCookie));
    await w("role by case variant", patch(`${USERS}/${id}/role`, { role: "ADMIN" }, adminCookie));
    await w("role by uuid", patch(`${USERS}/${id}/role`, { role: ROLE.technician }, adminCookie));
    await w("role wildcard falls back to default", patch(`${USERS}/${id}/role`, { role: "A%" }, adminCookie));
    await w("role underscore falls back to default", patch(`${USERS}/${id}/role`, { role: "Adm_n" }, adminCookie));
    await w("role unknown", patch(`${USERS}/${id}/role`, { role: "nope" }, adminCookie));
    await w("role of unknown user", patch(`${USERS}/${uid(988)}/role`, { role: "admin" }, adminCookie));
    await w("role bad id", patch(`${USERS}/not-a-uuid/role`, { role: "admin" }, adminCookie));
    await w("role no body", patch(`${USERS}/${id}/role`, {}, adminCookie));
    await w("role by viewer", patch(`${USERS}/${id}/role`, { role: "admin" }, viewerCookie));
    await w("update all", patch(`${USERS}/${id}`, { name: "Ann Lee", email: "ANN@example.test", role: "technician", phone: "1", address1: "a", address2: "b", city: "c", state: "d", postal: "e", country: "f", avatarUrl: "http://x/a", avatarThumbUrl: "http://x/t" }, adminCookie));
    await w("update nothing", patch(`${USERS}/${id}`, {}, adminCookie));
    await w("update null name", patch(`${USERS}/${id}`, { name: null }, adminCookie));
    await w("update null phone", patch(`${USERS}/${id}`, { phone: null }, adminCookie));
    await w("update non-string phone", patch(`${USERS}/${id}`, { phone: 5 }, adminCookie));
    await w("update duplicate email", patch(`${USERS}/${id}`, { email: email("viewer") }, adminCookie));
    await w("update unknown", patch(`${USERS}/${uid(987)}`, { name: "x" }, adminCookie));
    await w("update unknown nothing", patch(`${USERS}/${uid(987)}`, {}, adminCookie));
    await w("update bad id", patch(`${USERS}/not-a-uuid`, { name: "x" }, adminCookie));

    const sus = tok(U.doomed, SESSION.adminUnknown);
    await w("before suspend", get(`${ME}/security`, sus));
    await w("suspend", post(`${USERS}/${U.doomed}/suspend`, { suspended: true }, adminCookie));
    await w("suspended token refused", get(`${ME}/security`, sus));
    await w("suspended auth/me", get("/api/auth/me", sus));
    await w("suspended login refused", post(LOGIN, { email: email("doomed"), password: PW }));
    await w("suspended shows in list", get(`${USERS}?status=suspended`, adminCookie));
    await w("unsuspend", post(`${USERS}/${U.doomed}/suspend`, { suspended: false }, adminCookie));
    await w("unsuspended works", get(`${ME}/security`, sus));
    await w("suspend non-bool", post(`${USERS}/${U.doomed}/suspend`, { suspended: "yes" }, adminCookie));
    await w("suspend unknown", post(`${USERS}/${uid(986)}/suspend`, { suspended: true }, adminCookie));
    await w("delete by viewer", del(`${USERS}/${U.doomed}`, viewerCookie));
    await w("delete", del(`${USERS}/${U.doomed}`, adminCookie));
    await w("deleted token refused", get(`${ME}/security`, sus));
    await w("deleted again", del(`${USERS}/${U.doomed}`, adminCookie));
    await w("delete bad id", del(`${USERS}/not-a-uuid`, adminCookie));
    await list("?pageSize=200&sortKey=email");
}

async function roles(ctx) {
    const { step } = ctx;
    const base = ROLES;
    const w = (label, req) => step(`roles ${label}`, req);
    await w("list anon", get(base));
    await w("list viewer", get(base, viewerCookie));
    await w("list", get(base, adminCookie));
    await w("keys", get(`${base}/permission-keys`, adminCookie));
    const a = await w("create", post(base, { name: " Alpha ", description: " desc ", permissions: ["users.read", "USERS.READ", " roles.read "] }, adminCookie));
    await w("create no perms", post(base, { name: "bravo" }, adminCookie));
    await w("dup same", post(base, { name: "Alpha" }, adminCookie));
    await w("dup case", post(base, { name: "ALPHA" }, adminCookie));
    await w("dup of system", post(base, { name: "SYSROLE" }, adminCookie));
    await w("dup of owner", post(base, { name: "owner" }, adminCookie));
    await w("underscore is literal", post(base, { name: "wild_card" }, adminCookie));
    await w("underscore lookalike allowed", post(base, { name: "wildXcard" }, adminCookie));
    await w("percent is literal", post(base, { name: "A%" }, adminCookie));
    await w("non-ascii", post(base, { name: "Ärzte" }, adminCookie));
    await w("non-ascii case dup", post(base, { name: "ÄRZTE" }, adminCookie));
    await w("short", post(base, { name: "x" }, adminCookie));
    await w("long", post(base, { name: "x".repeat(65) }, adminCookie));
    await w("non-string name", post(base, { name: 5 }, adminCookie));
    await w("unknown perm", post(base, { name: "bad perm", permissions: ["nope.nope"] }, adminCookie));
    await w("perm not string", post(base, { name: "bad perm", permissions: [5] }, adminCookie));
    await w("create by viewer", post(base, { name: "viewer made" }, viewerCookie));
    const id = a.raw.id;
    await w("rename", patch(`${base}/${id}`, { name: "Alpha Two" }, adminCookie));
    await w("rename case only", patch(`${base}/${id}`, { name: "ALPHA TWO" }, adminCookie));
    await w("rename to dup", patch(`${base}/${id}`, { name: "bravo" }, adminCookie));
    await w("rename to wildcard of dup", patch(`${base}/${id}`, { name: "brav_" }, adminCookie));
    await w("rename short", patch(`${base}/${id}`, { name: "x" }, adminCookie));
    await w("description", patch(`${base}/${id}`, { description: "new" }, adminCookie));
    await w("description null", patch(`${base}/${id}`, { description: null }, adminCookie));
    await w("perms replace", patch(`${base}/${id}`, { permissions: ["users.write"] }, adminCookie));
    await w("perms clear", patch(`${base}/${id}`, { permissions: [] }, adminCookie));
    await w("perms unknown", patch(`${base}/${id}`, { permissions: ["nope.nope"] }, adminCookie));
    await w("list after edits", get(base, adminCookie));
    await w("rename system refused", patch(`${base}/${ROLE.system}`, { name: "Nope" }, adminCookie));
    await w("system perms", patch(`${base}/${ROLE.system}`, { permissions: ["users.read"] }, adminCookie));
    await w("patch unknown", patch(`${base}/${uid(985)}`, { name: "Ghost" }, adminCookie));
    await w("patch bad id", patch(`${base}/not-a-uuid`, { name: "Ghost" }, adminCookie));
    await w("delete in use", del(`${base}/${ROLE.viewer}`, adminCookie));
    await w("delete protected admin", del(`${base}/${ROLE.admin}`, adminCookie));
    await w("delete system", del(`${base}/${ROLE.system}`, adminCookie));
    await w("delete by viewer", del(`${base}/${ROLE.free}`, viewerCookie));
    await w("delete free", del(`${base}/${ROLE.free}`, adminCookie));
    await w("delete again", del(`${base}/${ROLE.free}`, adminCookie));
    await w("delete with perms", del(`${base}/${id}`, adminCookie));
    await w("delete bad id", del(`${base}/not-a-uuid`, adminCookie));
    await w("list final", get(base, adminCookie));
    // A permission change must reach the next request.
    const sub = tok(U.tfarec, SESSION.adminUnknown);
    await w("perm before removal", get(`${ME}/security`, sub));
    await w("remove perm", patch(`${base}/${ROLE.viewer}`, { permissions: ["me.read"] }, adminCookie));
    await w("perm removed", get(`${ME}/security`, sub));
    await w("restore perm", patch(`${base}/${ROLE.viewer}`, { permissions: ["me.security", "me.read", "devices.read"] }, adminCookie));
    await w("perm restored", get(`${ME}/security`, sub));
}

async function enroll(ctx) {
    const { step } = ctx;
    const path = "/api/agent/enroll";
    const body = (deviceId, token, field = "enrollmentSecret", more = {}) => ({ [field]: token, deviceId, hostname: "host-1", os: "linux", arch: "x64", version: "2.0", ...more });
    const w = (label, b) => step(`enroll ${label}`, post(path, b, null, { xff: "198.51.100.40" }));
    await w("wrong device keeps token", body(DEV.wrong, TOKENS.oneTime));
    await w("one-time", body(DEV.oneTime, TOKENS.oneTime));
    await w("one-time replay", body(DEV.oneTime, TOKENS.oneTime));
    await w("one-time replay other device", body(DEV.wrong, TOKENS.oneTime));
    await w("expired", body(DEV.expired, TOKENS.expired));
    await w("hostname already used in the site", body(DEV.wrong, TOKENS.key, "enrollmentKey"));
    await w("one-time over existing agent", body(DEV.withAgent, TOKENS.withAgent, "enrollmentSecret", { hostname: "host-with-agent" }));
    await w("key new device", body(DEV.keyNew, TOKENS.key, "enrollmentKey", { hostname: "host-new" }));
    await w("key same device again", body(DEV.keyNew, TOKENS.key, "enrollmentKey", { hostname: "host-new-2", arch: "arm64" }));
    await w("key sent as secret", body(DEV.oneTime, TOKENS.key));
    await w("key on device in other site", body(DEV.other, TOKENS.key, "enrollmentKey"));
    await w("revoked key", body(DEV.oneTime, TOKENS.keyRevoked, "enrollmentKey"));
    await w("expired key", body(DEV.oneTime, TOKENS.keyExpired, "enrollmentKey"));
    await w("legacy secret refused in production", body(DEV.legacy, ENROLLMENT_SECRET));
    await w("legacy secret on existing device", body(DEV.oneTime, ENROLLMENT_SECRET));
    await w("unknown token", body(DEV.oneTime, "not-a-token"));
    await w("no token", { deviceId: DEV.oneTime, hostname: "h", os: "linux", arch: "x64", version: "1" });
    await w("bad device id", body("not-a-uuid", TOKENS.key, "enrollmentKey"));
    await w("object token", body(DEV.oneTime, { not: "x" }));
    await w("blank hostname", body(DEV.keyNew, TOKENS.key, "enrollmentKey", { hostname: "" }));
}

const MASKED = new Set(["refresh_token", "challenge", "token_hash", "agent_token", "token"]);
const TABLES = {
    users: "SELECT * FROM users",
    user_security: "SELECT * FROM user_security",
    user_roles: "SELECT * FROM user_roles",
    roles: "SELECT * FROM roles",
    role_permissions: "SELECT * FROM role_permissions",
    permissions: "SELECT * FROM permissions",
    // These two users exist to hold sessions whose differences are checked separately.
    sessions: `SELECT * FROM sessions WHERE user_id NOT IN ('${U.guard}','${U.xffbad}')`,
    trusted_devices: "SELECT * FROM trusted_devices",
    login_challenges: "SELECT * FROM login_challenges",
    personal_access_tokens: "SELECT * FROM personal_access_tokens",
    devices: "SELECT * FROM devices",
    agents: "SELECT * FROM agents",
    endpoint_enrollments: "SELECT * FROM endpoint_enrollments",
    site_enrollment_keys: "SELECT * FROM site_enrollment_keys",
};

async function rows(db, sql) {
    const { rows: found } = await db.query(sql);
    return found
        .map((row) => {
            const out = {};
            for (const [k, v] of Object.entries(row)) {
                if (k === "password_hash") out[k] = String(v).slice(0, 7);
                else if (k === "recovery_codes") out[k] = v === null ? null : `len:${v.length}`;
                else if (k === "totp_secret" || MASKED.has(k)) out[k] = v === null ? null : "<set>";
                else out[k] = v;
            }
            return JSON.stringify(normalize(out));
        })
        .sort();
}

async function main() {
    const mode = process.argv[2];
    const dbA = new Client({ connectionString: DB_A });
    const dbB = new Client({ connectionString: DB_B });
    await Promise.all([dbA.connect(), dbB.connect()]);

    if (mode === "seed") {
        await seedDb(dbA);
        await seedDb(dbB);
        await Promise.all([dbA.end(), dbB.end()]);
        [PW, SECRET, ENROLLMENT_SECRET, AGENT_TOKEN, ...Object.values(TOKENS)].forEach(secretNote);
        console.log("seeded");
        return;
    }
    assert.equal(mode, "run", "usage: parity-batch6.e2e.cjs seed|run");

    let compared = 0;
    let succeeded = 0;
    let knownDiffs = 0;
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

    const ctxA = makeContext(BASE_A);
    const ctxB = makeContext(BASE_B);
    const sections = { guards, logins, xff, twoFactor, sessions, users, roles, enroll };
    for (const [name, fn] of Object.entries(sections)) {
        const startA = ctxA.log.length;
        const startB = ctxB.log.length;
        const [ra, rb] = await Promise.allSettled([fn(ctxA), fn(ctxB)]);
        if (ra.status === "rejected") fail(`${name}: scenario crashed on A`, String(ra.reason?.stack ?? ra.reason), "");
        if (rb.status === "rejected") fail(`${name}: scenario crashed on B`, "", String(rb.reason?.stack ?? rb.reason));
        const logA = ctxA.log.slice(startA);
        const logB = ctxB.log.slice(startB);
        const before = failures.length;
        let ok = 0;
        for (let i = 0; i < Math.max(logA.length, logB.length); i++) {
            const a = logA[i];
            const b = logB[i];
            compared++;
            if (a?.status < 300) ok++;
            if (a?.known) {
                // Each known difference is pinned: the new build must fail closed or succeed as stated.
                knownDiffs++;
                let good = true;
                if (a.known === "malformed-jti") {
                    good = a.label.includes("me:")
                        ? b.status === 200 && b.body?.user === null
                        : b.status === 401 && b.setCookie.length === 0;
                }
                if (a.known === "bad-xff") good = b.status === 201 && b.setCookie.length === 1 && a.status === 500;
                console.log(`  known ${a.label}: old ${a.status}, new ${b?.status}`);
                if (!good) fail(`${name}: known difference not as pinned: ${a.label}`, a, b);
                continue;
            }
            const { known: _a, ...ca } = a ?? {};
            const { known: _b, ...cb } = b ?? {};
            if (!same(ca, cb)) fail(`${name} #${i}: ${a?.label ?? b?.label}`, ca, cb);
        }
        if (ok === 0) fail(`${name}: no step succeeded, so nothing real was compared`, 0, 0);
        succeeded += ok;
        const limited = logA.filter((e) => e.status === 429 && !/limit/.test(e.label)).map((e) => e.label);
        if (limited.length) fail(`${name}: rate limited unexpectedly`, limited, 0);
        if (failures.length === before) console.log(`${name}: ok, ${logA.length} steps, ${ok} successful`);
        else console.log(`${name}: ${failures.length - before} differences over ${logA.length} steps`);
    }

    await sleep(500); // let fire-and-forget session updates land
    for (const [table, sql] of Object.entries(TABLES)) {
        const [a, b] = await Promise.all([rows(dbA, sql), rows(dbB, sql)]);
        compared++;
        if (!same(a, b)) {
            const onlyA = a.filter((x) => !b.includes(x)).slice(0, 4);
            const onlyB = b.filter((x) => !a.includes(x)).slice(0, 4);
            fail(`rows ${table} (${a.length} vs ${b.length})`, onlyA, onlyB);
        } else {
            console.log(`rows ${table}: ok (${a.length})`);
        }
    }

    // Checks on the new build's own state and on races the old build may lose.
    console.log("new build");
    const check = async (label, fn) => {
        try {
            await fn();
            console.log(`  ok    ${label}`);
        } catch (e) {
            fail(label, "", String(e?.message ?? e));
        }
    };
    const callB = (req) => call(BASE_B, req);
    await check("invalid forwarded addresses store NULL, valid ones store the address", async () => {
        const { rows: bad } = await dbB.query(`SELECT count(*)::int AS n, count(ip_address)::int AS withip FROM sessions WHERE user_id=$1`, [U.xffbad]);
        assert.ok(bad[0].n >= 6, `only ${bad[0].n} sessions`);
        const { rows: good } = await dbB.query(`SELECT host(ip_address) AS ip FROM sessions WHERE user_id=$1 AND ip_address IS NOT NULL`, [U.xffok]);
        const ips = good.map((r) => r.ip);
        for (const ip of ["192.0.2.10", "192.0.2.11", "2001:db8::2", "::ffff:192.0.2.13", "192.0.2.14"]) assert.ok(ips.includes(ip), `${ip} missing from ${ips}`);
    });
    await check("50 concurrent authenticated requests all succeed", async () => {
        const out = await Promise.all(Array.from({ length: 50 }, () => callB(get(`${ME}/security`, adminCookie))));
        assert.deepEqual([...new Set(out.map((r) => r.status))], [200]);
    });
    await check("a one-time enrollment token is consumed exactly once under concurrency", async () => {
        const body = { enrollmentSecret: TOKENS.race, deviceId: DEV.race, hostname: "race", os: "linux", arch: "x64", version: "1" };
        const out = await Promise.all(Array.from({ length: 12 }, () => callB(post("/api/agent/enroll", body, null, { xff: RACE_IP }))));
        const statuses = out.map((r) => r.status).sort();
        assert.equal(statuses.filter((s) => s === 201 || s === 200).length, 1, statuses.join());
        assert.equal(statuses.filter((s) => s === 401).length, 11, statuses.join());
    });
    const raceUser = U.tfarace;
    const start = await callB(post(LOGIN, { email: email("tfarace"), password: PW }, null, { xff: RACE_IP }));
    const raceCookie = start.newCookie;
    const started = await callB(post(`${ME}/2fa/start`, undefined, raceCookie));
    const raceSecret = started.raw.secret;
    secretNote(raceSecret);
    const confirmed = await callB(post(`${ME}/2fa/confirm`, { code: authenticator.generate(raceSecret) }, raceCookie));
    const raceCodes = confirmed.raw.recoveryCodes ?? [];
    const challenges = async (n) => {
        const out = [];
        for (let i = 0; i < n; i++) {
            const r = await callB(post(LOGIN, { email: email("tfarace"), password: PW }, null, { xff: RACE_IP }));
            secretNote(r.raw.challengeToken);
            out.push(r.raw.challengeToken);
        }
        return out;
    };
    await check("a recovery code works once under concurrency", async () => {
        const list = await challenges(6);
        const out = await Promise.all(list.map((c) => callB(post(VERIFY, { challengeToken: c, recoveryCode: raceCodes[0] }, null, { xff: RACE_IP }))));
        assert.equal(out.filter((r) => r.status < 300).length, 1, out.map((r) => r.status).join());
    });
    await check("different recovery codes used together are all removed", async () => {
        const list = await challenges(4);
        const out = await Promise.all(list.map((c, i) => callB(post(VERIFY, { challengeToken: c, recoveryCode: raceCodes[i + 1] }, null, { xff: RACE_IP }))));
        assert.equal(out.filter((r) => r.status < 300).length, 4, out.map((r) => r.status).join());
        const { rows: r } = await dbB.query(`SELECT cardinality(recovery_codes) AS n FROM user_security WHERE user_id=$1`, [raceUser]);
        assert.equal(r[0].n, 8 - 5);
    });
    await check("a challenge is consumed once under concurrency", async () => {
        const [c] = await challenges(1);
        const code = authenticator.generate(raceSecret);
        const out = await Promise.all(Array.from({ length: 8 }, () => callB(post(VERIFY, { challengeToken: c, code }, null, { xff: RACE_IP }))));
        assert.equal(out.filter((r) => r.status < 300).length, 1, out.map((r) => r.status).join());
    });

    // Code with no HTTP route, called directly on the new build.
    if (process.env.DIST_B) {
        console.log("direct calls (new build)");
        process.env.DATABASE_URL = DB_B;
        const load = (p) => require(`${process.env.DIST_B}/${p}`);
        const { PrismaService } = load("storage/prisma.service.js");
        const prisma = new PrismaService();
        const { JwtService } = require("@nestjs/jwt");
        const jwtSvc = new JwtService({ secret: SECRET, signOptions: { expiresIn: 3600 } });
        const { AuthService } = load("auth/auth.service.js");
        const { WsAuthService } = load("auth/ws-auth.service.js");
        const { UserAuthService } = load("auth/user-auth.service.js");
        const { UsersService } = load("users/users.service.js");
        const { HumanSessionGuard } = load("auth/human-session.guard.js");
        const { queryUserIdentityById, toInet } = load("auth/user-identity.util.js");
        const auth = new AuthService(prisma);
        const ws = new WsAuthService(jwtSvc, prisma);
        const userAuth = new UserAuthService(jwtSvc, prisma, null);

        await check("agent token lookup: right token, wrong token, and non-values never match", async () => {
            const { rows: r } = await dbB.query(`SELECT agent_token FROM agents WHERE id=$1`, [AGENT_SEED]);
            secretNote(r[0].agent_token);
            assert.equal(await auth.validateAgentToken(r[0].agent_token), AGENT_SEED);
            for (const v of ["nope", "", undefined, null, 5, {}, { not: "x" }]) assert.equal(await auth.validateAgentToken(v), null);
        });
        await check("agent websocket auth: only agent_token matches", async () => {
            const { rows: r } = await dbB.query(`SELECT agent_token FROM agents WHERE id=$1`, [AGENT_SEED]);
            const req = (h) => ({ headers: { authorization: h } });
            assert.equal((await ws.authenticateAgent(req(`Bearer ${r[0].agent_token}`))).id, AGENT_SEED);
            assert.equal(await ws.authenticateAgent(req("Bearer nope")), null);
            assert.equal(await ws.authenticateAgent(req(undefined)), null);
        });
        await check("resolveAgentUuid: malformed and missing values find nothing", async () => {
            for (const v of ["nope", "", undefined, null, AGENT_SEED.toUpperCase()]) assert.equal(await ws.resolveAgentUuid(v), null);
            const { rows: r } = await dbB.query(`SELECT agent_uuid FROM agents WHERE id=$1`, [AGENT_SEED]);
            assert.equal(await ws.resolveAgentUuid(AGENT_SEED), r[0].agent_uuid);
            assert.equal(r[0].agent_uuid, AGENT_SEED, "re-enrolling fills an empty agent_uuid");
            assert.equal(await ws.resolveAgentUuid(r[0].agent_uuid), r[0].agent_uuid);
        });
        await check("websocket token checks fail closed", async () => {
            const usable = (p) => ws.isUsableUserToken(p);
            assert.equal(await usable({ sub: U.admin, jti: SESSION.admin }), true);
            assert.equal(await usable({ sub: U.admin }), true);
            assert.equal(await usable({ sub: U.admin, jti: SESSION.adminRevoked }), false);
            assert.equal(await usable({ sub: "not-a-uuid" }), false);
            assert.equal(await usable({ sub: U.admin.toUpperCase() }), false);
            assert.equal(await usable({ sub: undefined }), false);
            assert.equal(await usable({ sub: U.admin, jti: "not-a-uuid" }), false);
            assert.equal(await usable({ sub: U.admin, jti: 5 }), false);
            assert.equal(await usable({ sub: U.admin, jti: "" }), false);
            assert.equal(await usable({ sub: U.disabled }), false);
            assert.equal(await usable({ sub: U.admin, typ: "2fa_challenge" }), false);
        });
        await check("websocket user: permissions come from roles and role defaults", async () => {
            const req = { headers: { cookie: `${COOKIE}=${adminCookie}` } };
            const user = await ws.authenticateUser(req);
            assert.equal(user.id, U.admin);
            assert.ok(user.permissions.has("users.read"));
            const viewer = await ws.authenticateUser({ headers: { cookie: `${COOKIE}=${viewerCookie}` } });
            assert.ok(viewer.permissions.has("devices.read"));
            assert.ok(!viewer.permissions.has("users.read"));
            assert.equal(await ws.authenticateUser({ headers: { cookie: `${COOKIE}=${tok("not-a-uuid", uid(1))}` } }), null);
        });
        await check("missing ids never widen a user lookup", async () => {
            for (const v of [undefined, null, "", 5, {}]) assert.equal(await queryUserIdentityById(prisma, v), null);
            await assert.rejects(queryUserIdentityById(prisma, "not-a-uuid"));
            assert.equal(await userAuth.verify(tok(undefined, uid(1))), null);
            assert.equal(await userAuth.isDeviceTrusted(U.tfa, { not: "x" }), false);
        });
        await check("toInet accepts only plain addresses", async () => {
            for (const v of ["1.2.3.4", "::1", "::ffff:1.2.3.4", " 1.2.3.4 ", "2001:db8::1"]) assert.equal(toInet(v), v.trim());
            for (const v of ["", " ", "x", "1.2.3", "999.1.1.1", "fe80::1%eth0", "1.2.3.4/24", undefined, null, 5, {}]) assert.equal(toInet(v), null);
        });
        await check("session upsert keeps a previous address when the new one is invalid", async () => {
            const id = crypto.randomUUID();
            await userAuth.recordSessionOnLogin(U.viewer, id, "ua1", "192.0.2.50");
            await userAuth.recordSessionOnLogin(U.viewer, id, "", "garbage");
            const { rows: r } = await dbB.query(`SELECT host(ip_address) AS ip, user_agent FROM sessions WHERE id=$1`, [id]);
            assert.deepEqual(r[0], { ip: "192.0.2.50", user_agent: "ua1" });
        });
        await check("human session guard fails closed on malformed ids", async () => {
            const guard = new HumanSessionGuard(prisma);
            const ctxFor = (jti, id = U.admin) => ({
                switchToHttp: () => ({ getRequest: () => ({ headers: {}, cookies: { [COOKIE]: "x" }, user: { id }, jti, authSource: "cookie" }) }),
            });
            assert.equal(await guard.canActivate(ctxFor(SESSION.admin)), true);
            for (const ctx of [ctxFor("not-a-uuid"), ctxFor(SESSION.adminRevoked), ctxFor(SESSION.admin, "not-a-uuid"), ctxFor(undefined)]) {
                await assert.rejects(guard.canActivate(ctx), /session is required/);
            }
        });
        await check("getOne returns the same shape as the list", async () => {
            const orgs = { getDefaultOrganizationId: async () => ORG };
            const svc = new UsersService(prisma, orgs);
            const one = await svc.getOne(U.first);
            assert.equal(one.name, "Only");
            assert.equal(one.role, "parity viewer");
            assert.equal(one.roles.length, 2);
            await assert.rejects(svc.getOne(uid(984)), /User not found/);
        });
        await prisma.$disconnect();
    }

    await Promise.all([dbA.end(), dbB.end()]);
    console.log(`\n${compared} comparisons (${succeeded} on successful requests, ${knownDiffs} known differences), ${failures.length} failed`);
    process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
