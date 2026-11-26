#!/usr/bin/env node
// The policy routes behind the real sign-in and permission checks.
// Run against a throwaway backend and database only:
//
//   ADG_E2E_ALLOW=1 BASE_URL=http://127.0.0.1:3901 DATABASE_URL=postgres://.../adg_e2e JWT_SECRET=... node test/policies-http.e2e.cjs
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
    try {
        await fn();
        passed++;
        console.log(`  ok    ${name}`);
    } catch (e) {
        failures.push(name);
        console.log(`  FAIL  ${name}\n        ${e?.message ?? e}`);
    }
}

function call(path, { method = "GET", token, body } = {}) {
    return fetch(`${BASE}${path}`, {
        method,
        headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { cookie: `${COOKIE}=${token}` } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
}

async function main() {
    const db = new Client({ connectionString: DB_URL });
    await db.connect();
    const q = (sql, params) => db.query(sql, params);
    const stamp = Date.now();

    const orgOf = async (slug, name) =>
        (await q(`INSERT INTO organizations (name, slug) VALUES ($1,$2) ON CONFLICT (slug) DO UPDATE SET slug = EXCLUDED.slug RETURNING id`, [name, slug])).rows[0].id;
    const org = await orgOf("default", "Default Organization");
    const otherOrg = await orgOf(`other-${stamp}`, `Other ${stamp}`);

    const madeUsers = [];
    const madeRoles = [];
    async function user(label, permissions, organizationId = org) {
        const id = uuid();
        madeUsers.push(id);
        const email = `${label}-${id}@example.test`;
        await q(`INSERT INTO users (id, organization_id, email, first_name, last_name, status, password_hash) VALUES ($1,$2,$3,'E2E',$4,'active','x')`, [id, organizationId, email, label]);
        const roleId = uuid();
        madeRoles.push(roleId);
        await q(`INSERT INTO roles (id, organization_id, scope, name) VALUES ($1,$2,'organization',$3)`, [roleId, organizationId, `e2e-${label}-${id}`]);
        await q(`INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)`, [id, roleId]);
        for (const p of permissions) await q(`INSERT INTO role_permissions (role_id, permission_key) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [roleId, p]);
        const jti = uuid();
        await q(`INSERT INTO sessions (id, user_id, refresh_token) VALUES ($1,$2,$3)`, [jti, id, sha256(jti)]);
        return jwt.sign({ sub: id, email, jti }, SECRET, { expiresIn: "1h" });
    }

    const viewer = await user("viewer", ["devices.read"]);
    const reader = await user("reader", ["policies.read"]);
    const writer = await user("writer", ["policies.read", "policies.write"]);
    const stranger = await user("stranger", ["policies.read", "policies.write"], otherOrg);

    const seed = await call("/api/policies", { method: "POST", token: writer, body: { name: `Seed-${stamp}`, sections: { alerting: { offlineAfterMinutes: 20 } } } });
    assert.equal(seed.status, 201, await seed.clone().text());
    const pid = (await seed.json()).id;
    const aid = uuid();
    const dev = uuid();

    console.log("who may call what");
    const routes = [
        ["GET", "/api/policies"],
        ["POST", "/api/policies", { name: "x" }],
        ["GET", "/api/policies/history"],
        ["POST", "/api/policies/preview", { name: "x" }],
        ["POST", `/api/policies/history/${aid}/restore`, {}],
        ["GET", `/api/policies/devices/${dev}/effective`],
        ["GET", `/api/policies/${pid}`],
        ["PATCH", `/api/policies/${pid}`, { description: "x" }],
        ["DELETE", `/api/policies/${pid}`],
        ["POST", `/api/policies/${pid}/duplicate`, {}],
        ["GET", `/api/policies/${pid}/devices`],
        ["GET", `/api/policies/${pid}/history`],
    ];
    const label = (m, p) => `${m} ${p.replace(pid, ":id").replace(aid, ":audit").replace(dev, ":device")}`;
    const writes = routes.filter(([m, p]) => m !== "GET" && p !== "/api/policies/preview");
    for (const [m, p, body] of routes) await test(`${label(m, p)} needs a sign-in`, async () => assert.equal((await call(p, { method: m, body })).status, 401));
    for (const [m, p, body] of routes) await test(`${label(m, p)} is closed to someone without policy permissions`, async () => assert.equal((await call(p, { method: m, token: viewer, body })).status, 403));
    for (const [m, p, body] of writes) await test(`${label(m, p)} is closed to someone who can only read`, async () => assert.equal((await call(p, { method: m, token: reader, body })).status, 403));
    await test("a reader can read, list, preview and see history", async () => {
        assert.equal((await call("/api/policies", { token: reader })).status, 200);
        assert.equal((await call(`/api/policies/${pid}`, { token: reader })).status, 200);
        assert.equal((await call(`/api/policies/${pid}/devices`, { token: reader })).status, 200);
        assert.equal((await call("/api/policies/history", { token: reader })).status, 200);
        assert.equal((await call("/api/policies/preview", { method: "POST", token: reader, body: { name: "Draft", sections: { alerting: { offlineAfterMinutes: 3 } } } })).status, 201);
    });
    await test("the refused calls changed nothing", async () => {
        const row = (await q("SELECT description, version FROM policies WHERE id = $1", [pid])).rows[0];
        assert.equal(row.description, null);
        assert.equal(row.version, 1);
    });

    console.log("policies over HTTP");
    await test("a writer creates, changes and deletes; the organisation comes from the sign-in", async () => {
        const res = await call("/api/policies", { method: "POST", token: writer, body: { name: `Made-${stamp}`, organization_id: otherOrg, sections: { remote: { consent: "consent" } }, assignments: [{ level: "global" }] } });
        assert.equal(res.status, 201, await res.clone().text());
        const made = await res.json();
        assert.equal((await q("SELECT organization_id FROM policies WHERE id = $1", [made.id])).rows[0].organization_id, org);
        const upd = await call(`/api/policies/${made.id}`, { method: "PATCH", token: writer, body: { priority: 10, version: made.version } });
        assert.equal(upd.status, 200, await upd.clone().text());
        const stale = await call(`/api/policies/${made.id}`, { method: "PATCH", token: writer, body: { priority: 20, version: made.version } });
        assert.equal(stale.status, 409);
        assert.equal((await call(`/api/policies/${made.id}`, { method: "DELETE", token: writer })).status, 200);
    });
    await test("a bad request says what is wrong", async () => {
        const res = await call("/api/policies", { method: "POST", token: writer, body: { name: `Bad-${stamp}`, sections: { alerting: { offlineAfterMinutes: 0 } } } });
        assert.equal(res.status, 400);
        assert.match((await res.json()).message, /Minutes offline/);
    });
    await test("a repeated name is a conflict", async () => {
        assert.equal((await call("/api/policies", { method: "POST", token: writer, body: { name: `SEED-${stamp}` } })).status, 409);
    });
    await test("a policy id that is not an id is refused", async () => {
        assert.equal((await call("/api/policies/not-an-id", { token: writer })).status, 400);
    });
    await test("history records the creation", async () => {
        const res = await call(`/api/policies/${pid}/history`, { token: writer });
        const body = await res.json();
        assert.equal(res.status, 200);
        assert.ok(body.items.some((i) => i.action === "created"));
    });

    console.log("another organisation");
    await test("cannot read, change, delete or copy the policy", async () => {
        assert.equal((await call(`/api/policies/${pid}`, { token: stranger })).status, 404);
        assert.equal((await call(`/api/policies/${pid}`, { method: "PATCH", token: stranger, body: { description: "x" } })).status, 404);
        assert.equal((await call(`/api/policies/${pid}`, { method: "DELETE", token: stranger })).status, 404);
        assert.equal((await call(`/api/policies/${pid}/duplicate`, { method: "POST", token: stranger })).status, 404);
        assert.equal((await call(`/api/policies/${pid}/devices`, { token: stranger })).status, 404);
    });
    await test("does not see it in the list or the history", async () => {
        const list = await (await call("/api/policies", { token: stranger })).json();
        assert.equal(list.items.some((p) => p.id === pid), false);
        const hist = await (await call("/api/policies/history", { token: stranger })).json();
        assert.equal(hist.items.some((i) => i.policyId === pid), false);
    });
    await test("cannot assign a policy to a customer of another organisation", async () => {
        const c = uuid();
        await q("INSERT INTO clients (id, organization_id, name) VALUES ($1,$2,$3)", [c, org, `PolHttp-${stamp}`]);
        const res = await call("/api/policies", { method: "POST", token: stranger, body: { name: `Sneaky-${stamp}`, assignments: [{ level: "customer", targetId: c }] } });
        assert.equal(res.status, 400);
        await q("DELETE FROM clients WHERE id = $1", [c]);
    });

    // Leave nothing behind: other tests pick an organisation by looking at the table.
    await q("DELETE FROM policy_audit WHERE organization_id = ANY($1::uuid[])", [[org, otherOrg]]);
    await q("DELETE FROM policies WHERE organization_id = ANY($1::uuid[])", [[org, otherOrg]]);
    await q(`DELETE FROM sessions WHERE user_id = ANY($1::uuid[])`, [madeUsers]);
    await q(`DELETE FROM user_roles WHERE user_id = ANY($1::uuid[])`, [madeUsers]);
    await q(`DELETE FROM role_permissions WHERE role_id = ANY($1::uuid[])`, [madeRoles]);
    await q(`DELETE FROM roles WHERE id = ANY($1::uuid[])`, [madeRoles]);
    await q(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [madeUsers]);
    await q(`DELETE FROM organizations WHERE id = $1`, [otherOrg]);
    await db.end();
    console.log(`\n${passed} passed, ${failures.length} failed`);
    process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
