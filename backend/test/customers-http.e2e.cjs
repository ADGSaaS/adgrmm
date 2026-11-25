#!/usr/bin/env node
// The customer routes behind the real sign-in and permission checks.
// Run against a throwaway backend and database only:
//
//   RIQ_E2E_ALLOW=1 BASE_URL=http://127.0.0.1:3901 DATABASE_URL=postgres://.../riq_e2e JWT_SECRET=... node test/customers-http.e2e.cjs
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { Client } = require("pg");
const jwt = require("jsonwebtoken");

const BASE = process.env.BASE_URL || "http://127.0.0.1:3901";
const DB_URL = process.env.DATABASE_URL || "";
const SECRET = process.env.JWT_SECRET || "";
const COOKIE = process.env.AUTH_COOKIE_NAME || "auth_token";

if (process.env.RIQ_E2E_ALLOW !== "1" || !/e2e/.test(new URL(DB_URL).pathname) || !SECRET) {
    console.error("Refusing to run: set RIQ_E2E_ALLOW=1, JWT_SECRET, and a DATABASE_URL naming an e2e database.");
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

    const made_users = [];
    const made_roles = [];
    async function user(label, permissions, organizationId = org) {
        const id = uuid();
        made_users.push(id);
        const email = `${label}-${id}@example.test`;
        await q(`INSERT INTO users (id, organization_id, email, first_name, last_name, status, password_hash) VALUES ($1,$2,$3,'E2E',$4,'active','x')`, [id, organizationId, email, label]);
        const roleId = uuid();
        made_roles.push(roleId);
        await q(`INSERT INTO roles (id, organization_id, scope, name) VALUES ($1,$2,'organization',$3)`, [roleId, organizationId, `e2e-${label}-${id}`]);
        await q(`INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)`, [id, roleId]);
        for (const p of permissions) await q(`INSERT INTO role_permissions (role_id, permission_key) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [roleId, p]);
        const jti = uuid();
        await q(`INSERT INTO sessions (id, user_id, refresh_token) VALUES ($1,$2,$3)`, [jti, id, sha256(jti)]);
        return jwt.sign({ sub: id, email, jti }, SECRET, { expiresIn: "1h" });
    }

    const viewer = await user("viewer", ["devices.read"]);
    const reader = await user("reader", ["customers.read"]);
    const writer = await user("writer", ["customers.read", "customers.write"]);
    const stranger = await user("stranger", ["customers.read", "customers.write"], otherOrg);

    // a customer and site to poke at, made directly
    const cid = uuid();
    const sid = uuid();
    await q(`INSERT INTO clients (id, organization_id, name) VALUES ($1,$2,$3)`, [cid, org, `HttpCust-${stamp}`]);
    await q(`INSERT INTO sites (id, client_id, name) VALUES ($1,$2,'HQ')`, [sid, cid]);

    console.log("who may call what");
    const routes = [
        ["GET", "/api/customers"],
        ["GET", `/api/customers/${cid}`],
        ["POST", "/api/customers", { name: "x" }],
        ["PATCH", `/api/customers/${cid}`, { phone: "1" }],
        ["POST", `/api/customers/${cid}/archive`, {}],
        ["POST", `/api/customers/${cid}/restore`, {}],
        ["GET", `/api/customers/${cid}/sites/${sid}`],
        ["PATCH", `/api/customers/${cid}/sites/${sid}`, { phone: "1" }],
        ["POST", `/api/customers/${cid}/sites`, { name: "New" }],
    ];
    for (const [method, path, body] of routes) {
        await test(`${method} ${path.replace(cid, ":id").replace(sid, ":site")} needs a sign-in`, async () => {
            assert.equal((await call(path, { method, body })).status, 401);
        });
    }
    for (const [method, path, body] of routes) {
        await test(`${method} ${path.replace(cid, ":id").replace(sid, ":site")} is closed to someone without customer permissions`, async () => {
            assert.equal((await call(path, { method, token: viewer, body })).status, 403);
        });
    }
    for (const [method, path, body] of routes.filter(([m]) => m !== "GET")) {
        await test(`${method} ${path.replace(cid, ":id").replace(sid, ":site")} is closed to someone who can only read`, async () => {
            assert.equal((await call(path, { method, token: reader, body })).status, 403);
        });
    }
    await test("a reader can list and open a customer and a site", async () => {
        assert.equal((await call("/api/customers", { token: reader })).status, 200);
        assert.equal((await call(`/api/customers/${cid}`, { token: reader })).status, 200);
        assert.equal((await call(`/api/customers/${cid}/sites/${sid}`, { token: reader })).status, 200);
    });
    await test("the customer was not changed by the refused calls", async () => {
        const row = (await q(`SELECT phone, archived_at FROM clients WHERE id = $1`, [cid])).rows[0];
        assert.equal(row.phone, null);
        assert.equal(row.archived_at, null);
    });

    console.log("customers over HTTP");
    let made;
    await test("a writer creates a customer with everything, and the organisation comes from the sign-in, not the request", async () => {
        const res = await call("/api/customers", {
            method: "POST", token: writer,
            body: { name: `Full-${stamp}`, organization_id: otherOrg, status: "prospect", email: "Hi@Full.Example.com", contacts: [{ name: "Pat", role: "billing", isPrimary: true }] },
        });
        assert.equal(res.status, 201, await res.clone().text());
        made = await res.json();
        assert.equal(made.email, "hi@full.example.com");
        assert.equal(made.contacts.length, 1);
        const row = (await q(`SELECT organization_id FROM clients WHERE id = $1`, [made.id])).rows[0];
        assert.equal(row.organization_id, org);
    });
    await test("a bad request says what is wrong", async () => {
        const res = await call("/api/customers", { method: "POST", token: writer, body: { name: `Bad-${stamp}`, email: "nope" } });
        assert.equal(res.status, 400);
        assert.match((await res.json()).message, /Email is not a valid/);
    });
    await test("a repeated name is a conflict", async () => {
        assert.equal((await call("/api/customers", { method: "POST", token: writer, body: { name: `FULL-${stamp}` } })).status, 409);
    });
    await test("the second of two saves from the same version is refused", async () => {
        const seen = await (await call(`/api/customers/${made.id}`, { token: writer })).json();
        const first = await call(`/api/customers/${made.id}`, { method: "PATCH", token: writer, body: { phone: "1", version: seen.updatedAt } });
        assert.equal(first.status, 200, await first.clone().text());
        const second = await call(`/api/customers/${made.id}`, { method: "PATCH", token: writer, body: { phone: "2", version: seen.updatedAt } });
        assert.equal(second.status, 409);
        assert.match((await second.json()).message, /Someone else changed/);
        assert.equal((await (await call(`/api/customers/${made.id}`, { token: writer })).json()).phone, "1");
    });
    await test("archiving hides a customer from the list and restoring brings it back", async () => {
        assert.equal((await call(`/api/customers/${made.id}/archive`, { method: "POST", token: writer })).status, 201);
        let list = await (await call(`/api/customers?q=Full-${stamp}`, { token: writer })).json();
        assert.equal(list.length, 0);
        list = await (await call(`/api/customers?q=Full-${stamp}&archived=true`, { token: writer })).json();
        assert.equal(list.length, 1);
        assert.equal(list[0].archived, true);
        assert.equal((await call(`/api/customers/${made.id}/restore`, { method: "POST", token: writer })).status, 201);
        list = await (await call(`/api/customers?q=Full-${stamp}`, { token: writer })).json();
        assert.equal(list.length, 1);
    });
    await test("a site is created and changed with its details", async () => {
        const made1 = await call(`/api/customers/${made.id}/sites`, { method: "POST", token: writer, body: { name: "Depot", phone: "555", address: { city: "Reno" } } });
        assert.equal(made1.status, 201, await made1.clone().text());
        const site = await made1.json();
        const upd = await call(`/api/customers/${made.id}/sites/${site.id}`, { method: "PATCH", token: writer, body: { contactName: "Lee", version: site.updatedAt } });
        assert.equal(upd.status, 200, await upd.clone().text());
        const out = await upd.json();
        assert.equal(out.contactName, "Lee");
        assert.equal(out.address.city, "Reno");
        const stale = await call(`/api/customers/${made.id}/sites/${site.id}`, { method: "PATCH", token: writer, body: { contactName: "Other", version: site.updatedAt } });
        assert.equal(stale.status, 409);
    });

    console.log("another organisation");
    await test("cannot read, change or archive the customer", async () => {
        assert.equal((await call(`/api/customers/${made.id}`, { token: stranger })).status, 404);
        assert.equal((await call(`/api/customers/${made.id}`, { method: "PATCH", token: stranger, body: { phone: "9" } })).status, 404);
        assert.equal((await call(`/api/customers/${made.id}/archive`, { method: "POST", token: stranger })).status, 404);
        assert.equal((await call(`/api/customers/${made.id}/sites`, { token: stranger })).status, 200);
        assert.deepEqual(await (await call(`/api/customers/${made.id}/sites`, { token: stranger })).json(), []);
    });
    await test("does not see it in the list", async () => {
        const list = await (await call(`/api/customers?q=Full-${stamp}`, { token: stranger })).json();
        assert.equal(list.length, 0);
    });

    console.log("branding saved with the customer");
    await test("branding can be read with report access and changed only with settings access", async () => {
        const reader2 = await user("brand-reader", ["customers.read", "devices.read"]);
        assert.equal((await call(`/api/reports/branding/${made.id}`, { token: reader2 })).status, 200);
        assert.equal((await call(`/api/reports/branding/${made.id}`, { method: "PUT", token: writer, body: { primaryColor: "#112233" } })).status, 403);
        const admin = await user("brand-admin", ["customers.write", "settings.write", "devices.read"]);
        assert.equal((await call(`/api/reports/branding/${made.id}`, { method: "PUT", token: admin, body: { primaryColor: "#112233" } })).status, 200);
    });

    await test("deleting the customer removes its sites and contacts", async () => {
        const res = await call(`/api/customers/${made.id}?force=true`, { method: "DELETE", token: writer });
        assert.equal(res.status, 200, await res.clone().text());
        assert.equal((await q(`SELECT count(*)::int AS n FROM customer_contacts WHERE client_id = $1`, [made.id])).rows[0].n, 0);
    });

    // Leave nothing behind: other tests pick an organisation by looking at the table.
    await q(`DELETE FROM clients WHERE id = $1`, [cid]);
    await q(`DELETE FROM sessions WHERE user_id = ANY($1::uuid[])`, [made_users]);
    await q(`DELETE FROM user_roles WHERE user_id = ANY($1::uuid[])`, [made_users]);
    await q(`DELETE FROM role_permissions WHERE role_id = ANY($1::uuid[])`, [made_roles]);
    await q(`DELETE FROM roles WHERE id = ANY($1::uuid[])`, [made_roles]);
    await q(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [made_users]);
    await q(`DELETE FROM organizations WHERE id = $1`, [otherOrg]);
    await db.end();
    console.log(`\n${passed} passed, ${failures.length} failed`);
    process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
