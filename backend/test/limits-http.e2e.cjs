#!/usr/bin/env node
// A person limited to some customers, behind the real sign-in: what they can and cannot see outside of reports.
// Run against a throwaway backend and database only:
//
//   ADG_E2E_ALLOW=1 BASE_URL=http://127.0.0.1:3901 DATABASE_URL=postgres://.../adg_e2e JWT_SECRET=... node test/limits-http.e2e.cjs
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

const call = (path, { method = "GET", token, body } = {}) =>
    fetch(`${BASE}${path}`, {
        method,
        headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { cookie: `${COOKIE}=${token}` } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
const json = async (path, opts) => (await call(path, opts)).json();

async function main() {
    const db = new Client({ connectionString: DB_URL });
    await db.connect();
    const q = (sql, params) => db.query(sql, params);
    const stamp = Date.now();

    const org = (await q(`INSERT INTO organizations (name, slug) VALUES ('Default Organization','default') ON CONFLICT (slug) DO UPDATE SET slug = EXCLUDED.slug RETURNING id`)).rows[0].id;

    const madeUsers = [];
    const madeRoles = [];
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

    const perms = ["customers.read", "customers.write", "devices.read", "checks.read", "alerts.read", "automation.read", "automation.run", "policies.read"];
    const everyone = await user("everyone", perms);
    const limited = await user("limited", perms);

    // two customers, each with a device, an agent, an open alert and a failed script
    async function customer(label) {
        const client = uuid(), site = uuid(), device = uuid(), agent = uuid(), job = uuid();
        await q(`INSERT INTO clients (id, organization_id, name) VALUES ($1,$2,$3)`, [client, org, `Lim ${label} ${stamp}`]);
        await q(`INSERT INTO sites (id, client_id, name) VALUES ($1,$2,'HQ')`, [site, client]);
        await q(`INSERT INTO devices (id, site_id, hostname, operating_system) VALUES ($1,$2,$3,'Windows 11')`, [device, site, `LIM-${label}-${stamp}`]);
        await q(`INSERT INTO agents (id, device_id, agent_uuid, version, last_check_in_at, facts) VALUES ($1,$2,$3,'1.3.28', now(), '{"os":"windows"}')`, [agent, device, uuid()]);
        await q(`INSERT INTO alerts (device_id, kind, dedupe_key, state, severity, title) VALUES ($1,'check',$2,'OPEN','CRIT',$3)`, [device, `lim:${label}:${stamp}`, `Alert ${label} ${stamp}`]);
        await q(`INSERT INTO jobs (id, agent_id, type, payload, status, finished_at) VALUES ($1,$2,'RUN_SCRIPT','{}','failed', now())`, [job, agent]);
        await q(`INSERT INTO job_results (job_id, exit_code, stderr) VALUES ($1,1,$2)`, [job, `Failed ${label}`]);
        await q(`INSERT INTO script_runs (script_name, job_id, device_id) VALUES ($1,$2,$3)`, [`Script ${label} ${stamp}`, job, device]);
        return { client, site, device, agent, job, name: `Lim ${label} ${stamp}`, host: `LIM-${label}-${stamp}` };
    }
    const A = await customer("A");
    const B = await customer("B");
    await q(`INSERT INTO user_client_access (user_id, client_id) VALUES ($1,$2)`, [limited.id, A.client]);

    console.log("customers");
    await test("everyone sees both customers", async () => {
        const list = await json("/api/customers?q=Lim%20", { token: everyone.token });
        assert.ok(list.some((c) => c.key === A.client) && list.some((c) => c.key === B.client));
    });
    await test("a limited person sees only their customer in the list", async () => {
        const list = await json("/api/customers?q=Lim%20", { token: limited.token });
        assert.ok(list.some((c) => c.key === A.client));
        assert.ok(!list.some((c) => c.key === B.client));
    });
    await test("they can open their own customer and its sites", async () => {
        assert.equal((await call(`/api/customers/${A.client}`, { token: limited.token })).status, 200);
        assert.equal((await call(`/api/customers/${A.client}/sites`, { token: limited.token })).status, 200);
    });
    await test("another customer is not found, whether asked for by id or by name", async () => {
        for (const path of [`/api/customers/${B.client}`, `/api/customers/${B.client}/sites`, `/api/customers/${B.client}/sites/${B.site}`, `/api/customers/${B.client}/remote-console`, `/api/customers/${encodeURIComponent(B.name)}`]) {
            assert.equal((await call(path, { token: limited.token })).status, 404, path);
        }
    });
    await test("and cannot be changed, archived or deleted", async () => {
        assert.equal((await call(`/api/customers/${B.client}`, { method: "PATCH", token: limited.token, body: { phone: "1" } })).status, 404);
        assert.equal((await call(`/api/customers/${B.client}/archive`, { method: "POST", token: limited.token })).status, 404);
        assert.equal((await call(`/api/customers/${B.client}/sites`, { method: "POST", token: limited.token, body: { name: "x" } })).status, 404);
        assert.equal((await call(`/api/customers/${B.client}`, { method: "DELETE", token: limited.token })).status, 404);
        const row = (await q(`SELECT phone, archived_at FROM clients WHERE id = $1`, [B.client])).rows[0];
        assert.equal(row.phone, null);
        assert.equal(row.archived_at, null);
    });
    await test("a limited person cannot create a customer", async () => {
        const res = await call("/api/customers", { method: "POST", token: limited.token, body: { name: `Nope ${stamp}` } });
        assert.equal(res.status, 403);
        assert.equal((await q(`SELECT count(*)::int AS n FROM clients WHERE name = $1`, [`Nope ${stamp}`])).rows[0].n, 0);
    });
    await test("an unlimited person still can", async () => {
        const res = await call("/api/customers", { method: "POST", token: everyone.token, body: { name: `Made ${stamp}` } });
        assert.equal(res.status, 201, await res.clone().text());
        await q(`DELETE FROM clients WHERE name = $1`, [`Made ${stamp}`]);
    });

    console.log("devices");
    await test("everyone sees both customers' devices", async () => {
        const list = await json("/api/devices?pageSize=200&q=LIM-", { token: everyone.token });
        assert.ok(list.items.some((d) => d.id === A.device) && list.items.some((d) => d.id === B.device));
    });
    await test("a limited person sees only theirs", async () => {
        const list = await json("/api/devices?pageSize=200&q=LIM-", { token: limited.token });
        assert.ok(list.items.some((d) => d.id === A.device));
        assert.ok(!list.items.some((d) => d.id === B.device));
    });
    await test("another customer's device is not found, nor its software or checks", async () => {
        for (const path of [`/api/devices/${B.device}`, `/api/devices/${B.device}/software`, `/api/devices/${B.device}/checks`]) {
            assert.equal((await call(path, { token: limited.token })).status, 404, path);
            assert.equal((await call(path, { token: everyone.token })).status, 200, path);
        }
        assert.equal((await call(`/api/devices/${A.device}`, { token: limited.token })).status, 200);
    });
    await test("actions and files on another customer's device are not reachable", async () => {
        for (const path of [`/api/devices/${B.device}/files/roots`, `/api/devices/${B.device}/actions/update-agent/${uuid()}`]) {
            const res = await call(path, { token: limited.token });
            assert.equal(res.status, 404, path);
            assert.match(JSON.stringify(await res.json()), /Device not found/, path);
        }
        const own = await call(`/api/devices/${A.device}/files/roots`, { token: limited.token });
        assert.doesNotMatch(JSON.stringify(await own.json().catch(() => ({}))), /Device not found/);
    });
    await test("searching cannot get around it", async () => {
        const list = await json(`/api/devices?pageSize=200&q=${encodeURIComponent(B.host)}`, { token: limited.token });
        assert.equal(list.items.length, 0);
    });
    await test("what policies give a device is hidden too", async () => {
        assert.equal((await call(`/api/policies/devices/${B.device}/effective`, { token: limited.token })).status, 404);
        assert.equal((await call(`/api/policies/devices/${A.device}/effective`, { token: limited.token })).status, 200);
        assert.equal((await call(`/api/policies/devices/${B.device}/effective`, { token: everyone.token })).status, 200);
    });

    console.log("alerts");
    await test("alerts are limited to their customers", async () => {
        const all = await json("/api/alerts?limit=200", { token: everyone.token });
        assert.ok(all.items.some((a) => a.title === `Alert A ${stamp}`) && all.items.some((a) => a.title === `Alert B ${stamp}`));
        const mine = await json("/api/alerts?limit=200", { token: limited.token });
        assert.ok(mine.items.some((a) => a.title === `Alert A ${stamp}`));
        assert.ok(!mine.items.some((a) => a.title === `Alert B ${stamp}`));
    });
    await test("asking for the other customer's alerts finds none", async () => {
        const res = await json(`/api/alerts?limit=200&clientId=${B.client}`, { token: limited.token });
        assert.equal(res.items.length, 0);
    });
    await test("the counts are theirs too", async () => {
        const all = await json("/api/alerts/summary", { token: everyone.token });
        const mine = await json("/api/alerts/summary", { token: limited.token });
        assert.ok(mine.open >= 1);
        assert.ok(mine.open < all.open);
    });

    console.log("the failures inbox");
    await test("everyone sees both customers' failures", async () => {
        const res = await json("/api/automation/failures?days=7&limit=1000", { token: everyone.token });
        assert.ok(res.items.some((i) => i.title === `Script A ${stamp}`) && res.items.some((i) => i.title === `Script B ${stamp}`));
    });
    await test("a limited person sees only theirs", async () => {
        const res = await json("/api/automation/failures?days=7&limit=1000", { token: limited.token });
        assert.ok(res.items.some((i) => i.title === `Script A ${stamp}`));
        assert.ok(!res.items.some((i) => i.title === `Script B ${stamp}`));
    });
    await test("a person with no automation permission sees nothing", async () => {
        const nobody = await user("nobody", ["devices.read"]);
        assert.equal((await call("/api/automation/failures", { token: nobody.token })).status, 403);
        assert.equal((await call("/api/automation/failures")).status, 401);
    });
    await test("a bad kind is refused", async () => {
        assert.equal((await call("/api/automation/failures?kind=nonsense", { token: everyone.token })).status, 400);
    });

    console.log("running a script");
    await test("a limited person cannot run a script on another customer's device, nor read its run", async () => {
        const body = { deviceId: B.device, script: "echo hi", shell: "powershell", timeoutSec: 5 };
        assert.equal((await call("/api/automation/runs", { method: "POST", token: limited.token, body })).status, 404);
        assert.equal((await call(`/api/automation/runs/${B.job}`, { token: limited.token })).status, 404);
        assert.equal((await call(`/api/automation/runs/${B.job}/log`, { token: limited.token })).status, 404);
        const jobsOnB = (await q(`SELECT count(*)::int AS n FROM jobs WHERE agent_id = $1`, [B.agent])).rows[0].n;
        assert.equal(jobsOnB, 1, "no job may have been queued for the other customer's device");
    });
    await test("a limited person can run a script on their own device and read its run, and others still can anywhere", async () => {
        const own = await call("/api/automation/runs", { method: "POST", token: limited.token, body: { deviceId: A.device, script: "echo hi", shell: "powershell", timeoutSec: 5 } });
        assert.equal(own.status, 202);
        assert.equal((await call(`/api/automation/runs/${A.job}`, { token: limited.token })).status, 200);
        assert.equal((await call(`/api/automation/runs/${A.job}/log`, { token: limited.token })).status, 200);
        const any = await call("/api/automation/runs", { method: "POST", token: everyone.token, body: { deviceId: B.device, script: "echo hi", shell: "powershell", timeoutSec: 5 } });
        assert.equal(any.status, 202);
        assert.equal((await call(`/api/automation/runs/${B.job}`, { token: everyone.token })).status, 200);
    });

    // Leave nothing behind: other tests pick an organisation by looking at the table.
    for (const c of [A, B]) {
        await q(`DELETE FROM alerts WHERE device_id = $1`, [c.device]);
        await q(`DELETE FROM clients WHERE id = $1`, [c.client]);
    }
    await q(`DELETE FROM user_client_access WHERE user_id = ANY($1::uuid[])`, [madeUsers]);
    await q(`DELETE FROM sessions WHERE user_id = ANY($1::uuid[])`, [madeUsers]);
    await q(`DELETE FROM user_roles WHERE user_id = ANY($1::uuid[])`, [madeUsers]);
    await q(`DELETE FROM role_permissions WHERE role_id = ANY($1::uuid[])`, [madeRoles]);
    await q(`DELETE FROM roles WHERE id = ANY($1::uuid[])`, [madeRoles]);
    await q(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [madeUsers]);
    await db.end();
    console.log(`\n${passed} passed, ${failures.length} failed`);
    process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
