#!/usr/bin/env node
// The "Remote video codec" customer setting behind the real sign-in and permission checks.
// Run against a throwaway backend and database only:
//
//   ADG_E2E_ALLOW=1 BASE_URL=http://127.0.0.1:3901 DATABASE_URL=postgres://.../adg_e2e JWT_SECRET=... node test/remote-console-codec-http.e2e.cjs
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { Client } = require("pg");
const jwt = require("jsonwebtoken");

const BASE = process.env.BASE_URL || "http://127.0.0.1:3901";
const DB_URL = process.env.DATABASE_URL || "";
const SECRET = process.env.JWT_SECRET || "";
const COOKIE = process.env.AUTH_COOKIE_NAME || "auth_token";

if (process.env.ADG_E2E_ALLOW !== "1" || !/e2e/.test(new URL(DB_URL).pathname) || !SECRET) {
    console.error("Refusing to run: set ADG_E2E_ALLOW=1, JWT_SECRET, and a DATABASE_URL naming an e2e database.");
    process.exit(2);
}

const uuid = () => crypto.randomUUID();
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
let passed = 0;
const failures = [];
async function test(name, fn) {
    try { await fn(); passed++; console.log(`  ok    ${name}`); }
    catch (e) { failures.push(name); console.log(`  FAIL  ${name}\n        ${e?.message ?? e}`); }
}
const call = (path, { method = "GET", token, body } = {}) =>
    fetch(`${BASE}${path}`, {
        method,
        headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { cookie: `${COOKIE}=${token}` } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });

async function main() {
    const db = new Client({ connectionString: DB_URL });
    await db.connect();
    const q = (sql, params) => db.query(sql, params);
    const org = (await q(`INSERT INTO organizations (name, slug) VALUES ('Default Organization','default') ON CONFLICT (slug) DO UPDATE SET slug = EXCLUDED.slug RETURNING id`)).rows[0].id;
    const users = [], roles = [];
    async function user(label, permissions) {
        const id = uuid(); users.push(id);
        const email = `${label}-${id}@example.test`;
        await q(`INSERT INTO users (id, organization_id, email, first_name, last_name, status, password_hash) VALUES ($1,$2,$3,'E2E',$4,'active','x')`, [id, org, email, label]);
        const roleId = uuid(); roles.push(roleId);
        await q(`INSERT INTO roles (id, organization_id, scope, name) VALUES ($1,$2,'organization',$3)`, [roleId, org, `e2e-${label}-${id}`]);
        await q(`INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)`, [id, roleId]);
        for (const p of permissions) await q(`INSERT INTO role_permissions (role_id, permission_key) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [roleId, p]);
        const jti = uuid();
        await q(`INSERT INTO sessions (id, user_id, refresh_token) VALUES ($1,$2,$3)`, [jti, id, sha256(jti)]);
        return jwt.sign({ sub: id, email, jti }, SECRET, { expiresIn: "1h" });
    }
    const reader = await user("reader", ["customers.read"]);
    const writer = await user("writer", ["customers.read", "customers.write"]);
    const cid = uuid();
    await q(`INSERT INTO clients (id, organization_id, name) VALUES ($1,$2,$3)`, [cid, org, `CodecCust-${Date.now()}`]);
    const path = `/api/customers/${cid}/remote-console`;

    try {
        await test("a new customer is on Auto, with the other settings as before", async () => {
            const r = await call(path, { token: reader });
            assert.equal(r.status, 200);
            const j = await r.json();
            assert.equal(j.codec, "auto");
            assert.equal(j.consent, "notice");
            assert.equal(j.record, false);
        });
        await test("someone who can only read cannot change it", async () => {
            assert.equal((await call(path, { method: "PATCH", token: reader, body: { codec: "vp8" } })).status, 403);
        });
        await test("the codec can be set on its own, without touching consent or recording", async () => {
            await q(`UPDATE clients SET remote_console_consent='consent', record_remote_sessions=true WHERE id=$1`, [cid]);
            const r = await call(path, { method: "PATCH", token: writer, body: { codec: "h264" } });
            assert.equal(r.status, 200);
            const j = await r.json();
            assert.deepEqual([j.codec, j.consent, j.record], ["h264", "consent", true]);
        });
        await test("the older call that sends only consent keeps the codec", async () => {
            const r = await call(path, { method: "PATCH", token: writer, body: { consent: "notice" } });
            assert.equal(r.status, 200);
            const j = await r.json();
            assert.deepEqual([j.codec, j.consent], ["h264", "notice"]);
        });
        await test("consent and codec can be saved together", async () => {
            const j = await (await call(path, { method: "PATCH", token: writer, body: { consent: "off", codec: "vp8" } })).json();
            assert.deepEqual([j.codec, j.consent], ["vp8", "off"]);
        });
        for (const bad of ["H265", "", 5, null, "vp9"]) {
            await test(`codec ${JSON.stringify(bad)} is refused and nothing changes`, async () => {
                const r = await call(path, { method: "PATCH", token: writer, body: { codec: bad } });
                assert.equal(r.status, 400);
                const row = (await q(`SELECT remote_console_codec FROM clients WHERE id=$1`, [cid])).rows[0];
                assert.equal(row.remote_console_codec, "vp8");
            });
        }
        await test("the database refuses a value the routes would not", async () => {
            await assert.rejects(q(`UPDATE clients SET remote_console_codec='av1' WHERE id=$1`, [cid]));
        });
    } finally {
        await q(`DELETE FROM clients WHERE id=$1`, [cid]);
        await q(`DELETE FROM sessions WHERE user_id = ANY($1)`, [users]);
        await q(`DELETE FROM user_roles WHERE user_id = ANY($1)`, [users]);
        await q(`DELETE FROM role_permissions WHERE role_id = ANY($1)`, [roles]);
        await q(`DELETE FROM roles WHERE id = ANY($1)`, [roles]);
        await q(`DELETE FROM users WHERE id = ANY($1)`, [users]);
        await db.end();
    }
    console.log(`\n${passed} passed, ${failures.length} failed`);
    process.exit(failures.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
