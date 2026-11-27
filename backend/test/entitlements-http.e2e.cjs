#!/usr/bin/env node
// Seat limits over HTTP, behind the real sign-in: GET /api/entitlements, and the 402 answers for enrolling and for adding people.
// Run against a throwaway backend and database only. The backend must be started with ENTITLEMENTS_FILE pointing at a path this
// test can write (it writes and removes that file):
//
//   ENTITLEMENTS_FILE=/tmp/adg-entitlements-e2e.json  (backend and test)
//   ADG_E2E_ALLOW=1 BASE_URL=http://127.0.0.1:3901 DATABASE_URL=postgres://.../adg_e2e JWT_SECRET=... node test/entitlements-http.e2e.cjs
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const { Client } = require("pg");
const jwt = require("jsonwebtoken");

const BASE = process.env.BASE_URL || "http://127.0.0.1:3901";
const DB_URL = process.env.DATABASE_URL || "";
const SECRET = process.env.JWT_SECRET || "";
const COOKIE = process.env.AUTH_COOKIE_NAME || "auth_token";
const FILE = process.env.ENTITLEMENTS_FILE || "";

if (process.env.ADG_E2E_ALLOW !== "1" || !/e2e/.test(new URL(DB_URL).pathname) || !SECRET || !FILE) {
    console.error("Refusing to run: set ADG_E2E_ALLOW=1, JWT_SECRET, ENTITLEMENTS_FILE (also given to the backend), and a DATABASE_URL naming an e2e database.");
    process.exit(2);
}

const uuid = () => crypto.randomUUID();
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
let passed = 0;
const failures = [];
async function test(name, fn) {
    try { await fn(); passed++; console.log(`  ok    ${name}`); } catch (e) { failures.push(name); console.log(`  FAIL  ${name}\n        ${e?.message ?? e}`); }
}
const call = (path, { method = "GET", token, body, headers } = {}) =>
    fetch(`${BASE}${path}`, {
        method,
        headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { cookie: `${COOKIE}=${token}` } : {}), ...(headers ?? {}) },
        body: body ? JSON.stringify(body) : undefined,
    });

async function main() {
    const db = new Client({ connectionString: DB_URL });
    await db.connect();
    const q = (sql, params) => db.query(sql, params);
    const stamp = Date.now();
    fs.rmSync(FILE, { force: true });
    const limits = (o) => {
        fs.writeFileSync(FILE, JSON.stringify({ version: 1, maxEndpoints: null, maxTechnicians: null, status: "active", upgradeUrl: "https://account.example.test", updatedAt: new Date().toISOString(), secretField: "never shown", ...o }) + " ".repeat(Math.floor(Math.random() * 60)));
        fs.utimesSync(FILE, new Date(), new Date(Date.now() + Math.random() * 1e6));
    };
    const count = async (sql) => Number((await q(sql)).rows[0].n);
    const agents = () => count(`SELECT count(*) AS n FROM agents`);
    const techs = () => count(`SELECT count(*) AS n FROM users WHERE status IN ('active','invited')`);

    const org = (await q(`INSERT INTO organizations (name, slug) VALUES ('Default Organization','default') ON CONFLICT (slug) DO UPDATE SET slug = EXCLUDED.slug RETURNING id`)).rows[0].id;
    const madeUsers = [], madeRoles = [];
    async function user(label, permissions) {
        const id = uuid();
        madeUsers.push(id);
        const email = `${label}-${id}@example.test`;
        await q(`INSERT INTO users (id, organization_id, email, first_name, last_name, status, password_hash) VALUES ($1,$2,$3,'E2E',$4,'active','x')`, [id, org, email, label]);
        const roleId = uuid();
        madeRoles.push(roleId);
        await q(`INSERT INTO roles (id, organization_id, scope, name) VALUES ($1,$2,'organization',$3)`, [roleId, org, `e2e-${label}-${id}`]);
        await q(`INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)`, [id, roleId]);
        for (const p of permissions) await q(`INSERT INTO role_permissions (role_id, permission_key) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [roleId, p]);
        const jti = uuid();
        await q(`INSERT INTO sessions (id, user_id, refresh_token) VALUES ($1,$2,$3)`, [jti, id, sha256(jti)]);
        return { id, token: jwt.sign({ sub: id, email, jti }, SECRET, { expiresIn: "1h" }) };
    }
    const nobody = await user("ent-nobody", []); // signed in, no permissions at all
    const admin = await user("ent-admin", ["users.read", "users.write", "admin.access"]);
    // New people get the Viewer role by default, and only someone who holds everything in it may hand it out: make the admin an Owner.
    const ownerRole = (await q(`SELECT id FROM roles WHERE lower(name) = 'owner' ORDER BY scope LIMIT 1`)).rows[0];
    if (ownerRole) await q(`INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)`, [admin.id, ownerRole.id]);

    const client = uuid(), site = uuid();
    await q(`INSERT INTO clients (id, organization_id, name) VALUES ($1,$2,$3)`, [client, org, `Ent HTTP ${stamp}`]);
    await q(`INSERT INTO sites (id, client_id, name) VALUES ($1,$2,'HQ')`, [site, client]);
    const makeKey = async () => {
        const key = `ent-key-${uuid()}`;
        await q(`INSERT INTO site_enrollment_keys (id, client_id, site_id, token_hash, expires_at) VALUES ($4,$1,$2,$3, now() + interval '1 hour')`, [client, site, sha256(key), uuid()]);
        return key;
    };
    const key = await makeKey();
    let ip = 0;
    const enroll = (deviceId) => call("/api/agent/enroll", {
        method: "POST",
        headers: { "x-forwarded-for": `203.0.113.${(++ip % 200) + 1}` },
        body: { enrollmentKey: key, deviceId, hostname: `ENT-${deviceId.slice(0, 8)}`, os: "windows", arch: "x64", version: "1.3.40" },
    });
    const email = (() => { let n = 0; return () => `ent-http-${stamp}-${++n}@example.test`; })();

    try {
        await test("no file: GET /api/entitlements answers 200 with no limits for anyone signed in", async () => {
            const r = await call("/api/entitlements", { token: nobody.token });
            assert.equal(r.status, 200);
            const b = await r.json();
            assert.equal(b.limits, null);
            assert.equal(b.banner, null);
        });

        await test("it needs a sign-in", async () => {
            const r = await call("/api/entitlements");
            assert.ok([401, 403].includes(r.status), String(r.status));
        });

        await test("with limits: shape, usage, banner, and nothing else from the file", async () => {
            const a = await agents(), t = await techs();
            limits({ maxEndpoints: a + 20, maxTechnicians: t + 20 });
            const b = await (await call("/api/entitlements", { token: nobody.token })).json();
            assert.deepEqual(Object.keys(b).sort(), ["banner", "limits", "status", "upgradeUrl", "usage"]);
            assert.deepEqual(b.limits, { maxEndpoints: a + 20, maxTechnicians: t + 20 });
            assert.equal(b.status, "active");
            assert.equal(b.upgradeUrl, "https://account.example.test/");
            assert.equal(b.banner, null);
            assert.ok(Number.isInteger(b.usage.endpoints) && Number.isInteger(b.usage.technicians));
            assert.ok(!JSON.stringify(b).includes("never shown"));
        });

        await test("banner: past_due is an error, near the limit is a warning", async () => {
            const t = await techs();
            limits({ status: "past_due" });
            const pd = await (await call("/api/entitlements", { token: nobody.token })).json();
            assert.equal(pd.banner.level, "error");
            assert.match(pd.banner.text, /Payment failed/);
            limits({ maxTechnicians: t + 1 });
            // one more than now would be exactly at the limit; close to it is warn only from 90 percent, so use a tight limit
            const tight = t === 0 ? 1 : Math.ceil(t / 0.95);
            limits({ maxTechnicians: tight });
            const w = await (await call("/api/entitlements", { token: nobody.token })).json();
            assert.ok(["warn", "error"].includes(w.banner?.level), JSON.stringify(w.banner));
        });

        await test("over the endpoint limit: a new device gets 402 with seat_limit_endpoints, an existing one can still enroll", async () => {
            const existing = uuid();
            limits({});
            assert.equal((await enroll(existing)).status, 201);
            const a = await agents();
            limits({ maxEndpoints: a });
            const id = uuid();
            const r = await enroll(id);
            assert.equal(r.status, 402);
            const b = await r.json();
            assert.equal(b.code, "seat_limit_endpoints");
            assert.match(b.message, /endpoint limit/);
            assert.match(b.message, /account\.example\.test/);
            assert.equal(await agents(), a);
            await q(`UPDATE agents SET last_check_in_at = now() - interval '10 minutes' WHERE device_id = $1`, [existing]);
            assert.equal((await enroll(existing)).status, 201, "re-enrollment is not a new seat");
            for (let i = 0; i < 8; i++) assert.equal((await enroll(uuid())).status, 402, "refusals do not lock the address out"); // a 402 is not counted as a failed guess
        });

        await test("over the technician limit: create, invite and bulk invite answer 402 seat_limit_technicians", async () => {
            const t = await techs();
            limits({ maxTechnicians: t });
            const create = await call("/api/admin/users/create", { method: "POST", token: admin.token, body: { email: email(), name: "Over Limit", password: "Str0ng!Passw0rd#2026" } });
            assert.equal(create.status, 402);
            assert.equal((await create.json()).code, "seat_limit_technicians");
            const invite = await call("/api/admin/users/invite", { method: "POST", token: admin.token, body: { email: email() } });
            assert.equal(invite.status, 402);
            assert.equal((await invite.json()).code, "seat_limit_technicians");
            const bulk = await call("/api/admin/users/invite/bulk", { method: "POST", token: admin.token, body: { invites: [{ email: email() }, { email: email() }] } });
            assert.equal(bulk.status, 201);
            const bb = await bulk.json();
            assert.equal(bb.created, 0);
            assert.equal(bb.skipped.length, 2);
            assert.match(bb.skipped[0].reason, /technician limit/);
            assert.equal(await techs(), t);
        });

        await test("with room, adding works; removing the file lifts every limit", async () => {
            const t = await techs();
            limits({ maxTechnicians: t + 1 });
            const ok = await call("/api/admin/users/invite", { method: "POST", token: admin.token, body: { email: email() } });
            assert.equal(ok.status, 201, await ok.clone().text());
            assert.equal((await call("/api/admin/users/invite", { method: "POST", token: admin.token, body: { email: email() } })).status, 402);
            fs.rmSync(FILE);
            assert.equal((await call("/api/admin/users/invite", { method: "POST", token: admin.token, body: { email: email() } })).status, 201);
            assert.equal((await (await call("/api/entitlements", { token: nobody.token })).json()).limits, null);
        });
    } finally {
        fs.rmSync(FILE, { force: true });
        await q(`DELETE FROM agents WHERE device_id IN (SELECT id FROM devices WHERE site_id = $1)`, [site]);
        await q(`DELETE FROM devices WHERE site_id = $1`, [site]);
        await q(`DELETE FROM clients WHERE id = $1`, [client]);
        await q(`DELETE FROM users WHERE email LIKE $1`, [`ent-http-${stamp}-%`]);
        await q(`DELETE FROM sessions WHERE user_id = ANY($1::uuid[])`, [madeUsers]);
        await q(`DELETE FROM user_roles WHERE user_id = ANY($1::uuid[])`, [madeUsers]);
        await q(`DELETE FROM role_permissions WHERE role_id = ANY($1::uuid[])`, [madeRoles]);
        await q(`DELETE FROM roles WHERE id = ANY($1::uuid[])`, [madeRoles]);
        await q(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [madeUsers]);
        await db.end();
    }
    console.log(`\n${passed} passed, ${failures.length} failed`);
    process.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
