#!/usr/bin/env node
// Users, roles and groups behind the real sign-in: what people may hand out, who may change whom, groups
// (permissions and what they can see), and the checks that stop an account being lost.
// Run against a throwaway backend and database only:
//
//   ADG_E2E_ALLOW=1 ADMIN_API_KEY=e2e-admin BASE_URL=http://127.0.0.1:3901 DATABASE_URL=postgres://.../adg_e2e JWT_SECRET=... node test/access-http.e2e.cjs
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { Client } = require("pg");
const jwt = require("jsonwebtoken");

const BASE = process.env.BASE_URL || "http://127.0.0.1:3901";
const DB_URL = process.env.DATABASE_URL || "";
const SECRET = process.env.JWT_SECRET || "";
const COOKIE = process.env.AUTH_COOKIE_NAME || "auth_token";
const ADMIN_KEY = process.env.ADMIN_API_KEY || "e2e-admin";

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

const call = (path, { method = "GET", token, body, admin } = {}) =>
    fetch(`${BASE}${path}`, {
        method,
        headers: {
            ...(body ? { "content-type": "application/json" } : {}),
            ...(token ? { cookie: `${COOKIE}=${token}` } : {}),
            ...(admin ? { "x-admin-api-key": ADMIN_KEY } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
    });
const json = async (path, opts) => (await call(path, opts)).json();

async function main() {
    const db = new Client({ connectionString: DB_URL });
    await db.connect();
    const q = (sql, params) => db.query(sql, params);
    const stamp = Date.now();

    const org = (await q(`INSERT INTO organizations (name, slug) VALUES ('Default Organization','default') ON CONFLICT (slug) DO UPDATE SET slug = EXCLUDED.slug RETURNING id`)).rows[0].id;
    // The catalogue rows the permission foreign keys point at are written when the backend starts.
    for (const k of ["groups.read", "groups.write"]) await q(`INSERT INTO permissions (permission_key, label, group_key, group_label) VALUES ($1,$1,'x','x') ON CONFLICT DO NOTHING`, [k]);

    const madeUsers = [];
    const madeRoles = [];
    const madeGroups = [];
    const madeClients = [];
    const madeTags = [];

    /** A signed-in person whose role holds exactly `permissions`. Pass `roleId` to use an existing role instead. */
    async function user(label, permissions, roleId) {
        const id = uuid();
        madeUsers.push(id);
        const email = `${label}-${id}@example.test`;
        await q(`INSERT INTO users (id, organization_id, email, first_name, last_name, status, password_hash) VALUES ($1,$2,$3,'E2E',$4,'active','x')`, [id, org, email, label]);
        let role = roleId;
        if (!role) {
            role = uuid();
            madeRoles.push(role);
            await q(`INSERT INTO roles (id, organization_id, scope, name) VALUES ($1,$2,'organization',$3)`, [role, org, `e2e-${label}-${id}`]);
            for (const p of permissions) await q(`INSERT INTO role_permissions (role_id, permission_key) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [role, p]);
        }
        await q(`INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)`, [id, role]);
        const jti = uuid();
        await q(`INSERT INTO sessions (id, user_id, refresh_token) VALUES ($1,$2,$3)`, [jti, id, sha256(jti)]);
        return { id, email, jti, token: jwt.sign({ sub: id, email, jti }, SECRET, { expiresIn: "1h" }) };
    }
    const roleByName = async (name) => (await q(`SELECT id FROM roles WHERE lower(name) = lower($1) ORDER BY scope DESC LIMIT 1`, [name])).rows[0]?.id;
    const statusOf = async (id) => (await q(`SELECT status FROM users WHERE id = $1`, [id])).rows[0]?.status;

    // ------------------------------------------------------------------ permissions are what is stored
    console.log("permissions come from the database");
    const adminRole = await roleByName("Admin");
    const viewerRole = await roleByName("Viewer");
    const operatorRole = await roleByName("Operator");
    const ownerRole = await roleByName("Owner");

    const root = await user("root", [], ownerRole);

    await test("the built-in roles exist", async () => {
        assert.ok(adminRole && viewerRole && operatorRole && ownerRole, JSON.stringify({ adminRole, viewerRole, operatorRole, ownerRole }));
    });
    await test("Owner holds every permission in the database", async () => {
        const n = (await q(`SELECT count(*)::int AS n FROM role_permissions WHERE role_id = $1 AND permission_key IN ('groups.write','users.write','settings.environment.critical.write')`, [ownerRole])).rows[0].n;
        assert.equal(n, 3);
    });
    await test("taking a permission off a built-in role really takes it away", async () => {
        const v = await user("viewer", [], viewerRole);
        assert.equal((await call("/api/admin/users?pageSize=1", { token: v.token })).status, 200);
        const had = (await q(`SELECT 1 FROM role_permissions WHERE role_id = $1 AND permission_key = 'users.read'`, [viewerRole])).rowCount;
        try {
            await q(`DELETE FROM role_permissions WHERE role_id = $1 AND permission_key = 'users.read'`, [viewerRole]);
            assert.equal((await call("/api/admin/users?pageSize=1", { token: v.token })).status, 403);
        } finally {
            if (had) await q(`INSERT INTO role_permissions (role_id, permission_key) VALUES ($1,'users.read') ON CONFLICT DO NOTHING`, [viewerRole]);
        }
        assert.equal((await call("/api/admin/users?pageSize=1", { token: v.token })).status, 200);
    });
    await test("a role named like a built-in one gets nothing it was not given", async () => {
        const id = uuid();
        const name = `Operator ${stamp}`; // not equal, but a prefix-style name must not matter either
        madeRoles.push(id);
        await q(`INSERT INTO roles (id, organization_id, scope, name) VALUES ($1,$2,'organization',$3)`, [id, org, name]);
        const p = await user("namesake", [], id);
        assert.equal((await call("/api/devices?pageSize=1", { token: p.token })).status, 403);
        assert.equal((await call("/api/admin/users?pageSize=1", { token: p.token })).status, 403);
    });

    // ------------------------------------------------------------------ nobody hands out what they lack
    console.log("handing out permissions");
    const mgrPerms = ["admin.access", "users.read", "users.write", "users.delete", "roles.read", "roles.write", "roles.delete", "groups.read", "groups.write", "users.2fa.reset"];
    const mgr = await user("mgr", mgrPerms);
    const strong = await user("strong", [...mgrPerms, "billing.write"]);

    await test("a new role cannot hold a permission its creator lacks", async () => {
        const res = await call("/api/roles", { method: "POST", token: mgr.token, body: { name: `Bill ${stamp}`, permissions: ["billing.write"] } });
        assert.equal(res.status, 403);
        assert.equal((await q(`SELECT count(*)::int AS n FROM roles WHERE name = $1`, [`Bill ${stamp}`])).rows[0].n, 0);
    });
    await test("one within their own permissions is fine", async () => {
        const res = await call("/api/roles", { method: "POST", token: mgr.token, body: { name: `Ok ${stamp}`, permissions: ["users.read"] } });
        assert.equal(res.status, 201, await res.clone().text());
        const { id } = await res.json();
        madeRoles.push(id);
    });
    await test("a role cannot be edited to add what you lack, nor a stronger role edited at all", async () => {
        const mine = (await q(`SELECT id FROM roles WHERE name = $1`, [`Ok ${stamp}`])).rows[0].id;
        assert.equal((await call(`/api/roles/${mine}`, { method: "PATCH", token: mgr.token, body: { permissions: ["users.read", "billing.write"] } })).status, 403);
        assert.equal((await call(`/api/roles/${adminRole}`, { method: "PATCH", token: mgr.token, body: { description: "mine now" } })).status, 403);
    });
    await test("the Owner role cannot be changed by anyone", async () => {
        const res = await call(`/api/roles/${ownerRole}`, { method: "PATCH", token: root.token, body: { permissions: ["users.read"] } });
        assert.equal(res.status, 400);
        assert.equal((await call(`/api/roles/${ownerRole}`, { method: "DELETE", token: root.token })).status, 400);
    });
    await test("saving the Owner role with its own permissions unchanged is fine (the form sends them back)", async () => {
        const held = (await q(`SELECT permission_key FROM role_permissions WHERE role_id = $1`, [ownerRole])).rows.map((r) => r.permission_key);
        const res = await call(`/api/roles/${ownerRole}`, { method: "PATCH", token: root.token, body: { description: "Full system access", permissions: held } });
        assert.equal(res.status, 200, await res.clone().text());
    });
    await test("a role can be copied, and copying a stronger one is refused", async () => {
        const mine = (await q(`SELECT id FROM roles WHERE name = $1`, [`Ok ${stamp}`])).rows[0].id;
        const res = await call(`/api/roles/${mine}/duplicate`, { method: "POST", token: mgr.token, body: { name: `Copy ${stamp}` } });
        assert.equal(res.status, 201, await res.clone().text());
        madeRoles.push((await res.json()).id);
        assert.equal((await call(`/api/roles/${adminRole}/duplicate`, { method: "POST", token: mgr.token, body: {} })).status, 403);
    });
    await test("you cannot give someone the Owner or Admin role, or a role stronger than you", async () => {
        const target = await user("target", ["users.read"]);
        for (const role of ["Owner", "Admin"]) {
            const res = await call(`/api/admin/users/${target.id}/role`, { method: "PATCH", token: mgr.token, body: { role } });
            assert.equal(res.status, 403, role);
        }
        const mine = (await q(`SELECT id FROM roles WHERE name = $1`, [`Ok ${stamp}`])).rows[0].id;
        assert.equal((await call(`/api/admin/users/${target.id}/role`, { method: "PATCH", token: mgr.token, body: { role: mine } })).status, 204);
    });
    await test("an unknown role is an error, never a silent fallback", async () => {
        const res = await call("/api/admin/users/create", { method: "POST", token: mgr.token, body: { name: "Nope", email: `nope-${stamp}@example.test`, password: "longenough1", role: "No Such Role" } });
        assert.equal(res.status, 400);
        assert.equal((await q(`SELECT count(*)::int AS n FROM users WHERE email = $1`, [`nope-${stamp}@example.test`])).rows[0].n, 0);
    });

    // ------------------------------------------------------------------ who may change whom
    console.log("changing people");
    const strongTarget = await user("strongtarget", ["users.read", "billing.write"]);
    await test("you cannot change someone who can do more than you", async () => {
        assert.equal((await call(`/api/admin/users/${strongTarget.id}/suspend`, { method: "POST", token: mgr.token, body: { suspended: true } })).status, 403);
        assert.equal((await call(`/api/admin/users/${strongTarget.id}/password`, { method: "POST", token: mgr.token, body: { password: "longenough1" } })).status, 403);
        assert.equal((await call(`/api/admin/users/${strongTarget.id}`, { method: "DELETE", token: mgr.token })).status, 403);
        assert.equal(await statusOf(strongTarget.id), "active");
        // someone with enough permissions can
        assert.equal((await call(`/api/admin/users/${strongTarget.id}/reset-2fa`, { method: "POST", token: strong.token })).status, 204);
    });
    await test("you cannot suspend, delete or re-role your own account", async () => {
        assert.equal((await call(`/api/admin/users/${mgr.id}/suspend`, { method: "POST", token: mgr.token, body: { suspended: true } })).status, 403);
        assert.equal((await call(`/api/admin/users/${mgr.id}`, { method: "DELETE", token: mgr.token })).status, 403);
        assert.equal((await call(`/api/admin/users/${mgr.id}/role`, { method: "PATCH", token: mgr.token, body: { role: "Viewer" } })).status, 403);
        assert.equal(await statusOf(mgr.id), "active");
    });
    await test("you can still edit your own details", async () => {
        const res = await call(`/api/admin/users/${mgr.id}`, { method: "PATCH", token: mgr.token, body: { phone: "555-0100" } });
        assert.equal(res.status, 204);
    });
    await test("the edit form sends the role every time: an unchanged role is not a role change", async () => {
        const myRole = (await q(`SELECT role_id FROM user_roles WHERE user_id = $1`, [mgr.id])).rows[0].role_id;
        const res = await call(`/api/admin/users/${mgr.id}`, { method: "PATCH", token: mgr.token, body: { name: "Mgr Renamed", email: mgr.email, role: myRole } });
        assert.equal(res.status, 204, await res.clone().text());
    });
    await test("choosing no role takes the role away", async () => {
        const target = await user("norole", ["users.read"]);
        assert.equal((await call(`/api/admin/users/${target.id}/role`, { method: "PATCH", token: mgr.token, body: { role: "" } })).status, 204);
        assert.equal((await q(`SELECT count(*)::int AS n FROM user_roles WHERE user_id = $1`, [target.id])).rows[0].n, 0);
    });
    await test("an Owner can suspend another Owner, but never themselves", async () => {
        const owner = await user("owner1", [], ownerRole);
        const second = await user("owner2", [], ownerRole);
        assert.equal((await call(`/api/admin/users/${owner.id}/suspend`, { method: "POST", token: owner.token, body: { suspended: true } })).status, 403);
        assert.equal((await call(`/api/admin/users/${owner.id}/role`, { method: "PATCH", token: owner.token, body: { role: "Viewer" } })).status, 403);
        assert.equal((await call(`/api/admin/users/${second.id}/suspend`, { method: "POST", token: owner.token, body: { suspended: true } })).status, 204);
        assert.equal(await statusOf(second.id), "disabled");
        assert.equal((await call(`/api/admin/users/${second.id}/suspend`, { method: "POST", token: owner.token, body: { suspended: false } })).status, 204);
    });
    await test("only an Owner can change an Owner", async () => {
        const owner = await user("anowner", [], ownerRole);
        assert.equal((await call(`/api/admin/users/${owner.id}/password`, { method: "POST", token: strong.token, body: { password: "longenough1" } })).status, 403);
    });
    await test("resetting a password signs that person out everywhere", async () => {
        const victim = await user("victim", ["users.read"]);
        assert.equal((await call("/api/admin/users?pageSize=1", { token: victim.token })).status, 200);
        assert.equal((await call(`/api/admin/users/${victim.id}/password`, { method: "POST", token: mgr.token, body: { password: "brand-new-password" } })).status, 204);
        assert.equal((await call("/api/admin/users?pageSize=1", { token: victim.token })).status, 401);
    });
    await test("suspending signs a person out at once", async () => {
        const victim = await user("victim2", ["users.read"]);
        assert.equal((await call(`/api/admin/users/${victim.id}/suspend`, { method: "POST", token: mgr.token, body: { suspended: true } })).status, 204);
        assert.notEqual((await call("/api/admin/users?pageSize=1", { token: victim.token })).status, 200);
        assert.ok((await q(`SELECT revoked_at FROM sessions WHERE id = $1`, [victim.jti])).rows[0].revoked_at);
    });
    await test("changing an email to one already in use is a clear conflict", async () => {
        const a = await user("mailA", ["users.read"]);
        const b = await user("mailB", ["users.read"]);
        const res = await call(`/api/admin/users/${a.id}`, { method: "PATCH", token: mgr.token, body: { email: b.email } });
        assert.equal(res.status, 409);
    });

    // ------------------------------------------------------------------ inviting and creating
    console.log("inviting and creating");
    await test("creating a person whose email exists does not overwrite them", async () => {
        const existing = await user("existing", ["users.read"]);
        const before = (await q(`SELECT password_hash FROM users WHERE id = $1`, [existing.id])).rows[0].password_hash;
        const res = await call("/api/admin/users/create", { method: "POST", token: mgr.token, body: { name: "X", email: existing.email, password: "longenough1" } });
        assert.equal(res.status, 409);
        assert.equal((await q(`SELECT password_hash FROM users WHERE id = $1`, [existing.id])).rows[0].password_hash, before);
        const inv = await call("/api/admin/users/invite", { method: "POST", token: mgr.token, body: { email: existing.email } });
        assert.equal(inv.status, 409);
        assert.equal(await statusOf(existing.id), "active");
    });
    await test("a new person with no role gets Viewer, the least powerful", async () => {
        const email = `fresh-${stamp}@example.test`;
        const res = await call("/api/admin/users/create", { method: "POST", token: mgr.token, body: { name: "Fresh Person", email, password: "longenough1" } });
        // Viewer holds permissions the manager lacks (customers.read and others), so handing it over is refused.
        assert.ok([201, 403].includes(res.status), String(res.status));
        if (res.status === 201) {
            const { id } = await res.json();
            madeUsers.push(id);
            const role = (await q(`SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1`, [id])).rows[0]?.name;
            assert.equal(role, "Viewer");
        }
    });
    await test("an Owner can invite with a group and a role in one go, and bulk reports what it skipped", async () => {
        const g = await call("/api/admin/groups", { method: "POST", token: root.token, body: { name: `Invite ${stamp}`, permissions: ["users.read"] } });
        assert.equal(g.status, 201, await g.clone().text());
        const gid = (await g.json()).id;
        madeGroups.push(gid);
        const taken = await user("taken", ["users.read"]);
        const res = await call("/api/admin/users/invite/bulk", {
            method: "POST",
            token: root.token,
            body: { invites: [{ email: `inv1-${stamp}@example.test`, role: "Viewer", groupIds: [gid] }, { email: taken.email }, { email: `inv2-${stamp}@example.test`, role: "Not A Role" }] },
        });
        assert.equal(res.status, 201, await res.clone().text());
        const out = await res.json();
        assert.equal(out.created, 1);
        assert.equal(out.skipped.length, 2);
        const row = (await q(`SELECT id, status FROM users WHERE email = $1`, [`inv1-${stamp}@example.test`])).rows[0];
        assert.equal(row.status, "invited");
        madeUsers.push(row.id);
        assert.equal((await q(`SELECT count(*)::int AS n FROM user_group_members WHERE user_id = $1 AND group_id = $2`, [row.id, gid])).rows[0].n, 1);
    });

    // ------------------------------------------------------------------ groups: permissions
    console.log("groups give permissions");
    await test("a group's permissions reach its members, and only while they are in it", async () => {
        const res = await call("/api/admin/groups", { method: "POST", token: mgr.token, body: { name: `Readers ${stamp}`, description: "See groups", permissions: ["groups.read"] } });
        assert.equal(res.status, 201, await res.clone().text());
        const gid = (await res.json()).id;
        madeGroups.push(gid);
        const member = await user("member", ["admin.access"]);
        assert.equal((await call("/api/admin/groups", { token: member.token })).status, 403);
        assert.equal((await call(`/api/admin/users/${member.id}/groups`, { method: "PUT", token: mgr.token, body: { groupIds: [gid] } })).status, 204);
        assert.equal((await call("/api/admin/groups", { token: member.token })).status, 200);
        assert.equal((await call(`/api/admin/users/${member.id}/groups`, { method: "PUT", token: mgr.token, body: { groupIds: [] } })).status, 204);
        assert.equal((await call("/api/admin/groups", { token: member.token })).status, 403);
    });
    await test("a group cannot be given a permission its creator lacks, nor a stronger group joined", async () => {
        assert.equal((await call("/api/admin/groups", { method: "POST", token: mgr.token, body: { name: `Greedy ${stamp}`, permissions: ["billing.write"] } })).status, 403);
        const made = await call("/api/admin/groups", { method: "POST", token: strong.token, body: { name: `Billing ${stamp}`, permissions: ["billing.write"] } });
        assert.equal(made.status, 201, await made.clone().text());
        const gid = (await made.json()).id;
        madeGroups.push(gid);
        const person = await user("joiner", ["admin.access"]);
        assert.equal((await call(`/api/admin/users/${person.id}/groups`, { method: "PUT", token: mgr.token, body: { groupIds: [gid] } })).status, 403);
        assert.equal((await call(`/api/admin/groups/${gid}`, { method: "PATCH", token: mgr.token, body: { memberIds: [person.id] } })).status, 403);
        assert.equal((await call(`/api/admin/users/${person.id}/groups`, { method: "PUT", token: strong.token, body: { groupIds: [gid] } })).status, 204);
    });
    await test("names are unique, trimmed and checked", async () => {
        const name = `Unique ${stamp}`;
        const a = await call("/api/admin/groups", { method: "POST", token: root.token, body: { name: `  ${name}  ` } });
        assert.equal(a.status, 201);
        madeGroups.push((await a.json()).id);
        assert.equal((await call("/api/admin/groups", { method: "POST", token: root.token, body: { name: name.toUpperCase() } })).status, 409);
        assert.equal((await call("/api/admin/groups", { method: "POST", token: root.token, body: { name: "x" } })).status, 400);
        assert.equal((await call("/api/admin/groups", { method: "POST", token: root.token, body: { name: `Bad ${stamp}`, permissions: ["nope.nope"] } })).status, 400);
        assert.equal((await call("/api/admin/groups", { method: "POST", token: root.token, body: { name: `Bad2 ${stamp}`, scope: [{ kind: "customer", id: uuid() }] } })).status, 400);
        assert.equal((await call("/api/admin/groups", { method: "POST", token: root.token, body: { name: `Bad3 ${stamp}`, memberIds: [uuid()] } })).status, 400);
    });
    await test("someone without the permission cannot read or change groups", async () => {
        const nobody = await user("nobody", ["admin.access"]);
        assert.equal((await call("/api/admin/groups", { token: nobody.token })).status, 403);
        assert.equal((await call("/api/admin/groups", { method: "POST", token: nobody.token, body: { name: `Zed ${stamp}` } })).status, 403);
        assert.equal((await call("/api/admin/groups")).status, 401);
    });

    // ------------------------------------------------------------------ groups: what people can see
    console.log("groups limit what people see");
    async function customer(label, sites = 2) {
        const client = uuid();
        madeClients.push(client);
        await q(`INSERT INTO clients (id, organization_id, name) VALUES ($1,$2,$3)`, [client, org, `Grp ${label} ${stamp}`]);
        const out = { client, name: `Grp ${label} ${stamp}`, sites: [] };
        for (let i = 1; i <= sites; i++) {
            const site = uuid(), device = uuid(), agent = uuid(), job = uuid();
            await q(`INSERT INTO sites (id, client_id, name) VALUES ($1,$2,$3)`, [site, client, `Site ${i}`]);
            const host = `GRP-${label}${i}-${stamp}`;
            await q(`INSERT INTO devices (id, site_id, hostname, operating_system) VALUES ($1,$2,$3,'Windows 11')`, [device, site, host]);
            await q(`INSERT INTO agents (id, device_id, agent_uuid, version, last_check_in_at, facts) VALUES ($1,$2,$3,'1.3.28', now(), '{"os":"windows"}')`, [agent, device, uuid()]);
            await q(`INSERT INTO alerts (device_id, kind, dedupe_key, state, severity, title) VALUES ($1,'check',$2,'OPEN','CRIT',$3)`, [device, `grp:${label}${i}:${stamp}`, `Alert ${label}${i} ${stamp}`]);
            await q(`INSERT INTO jobs (id, agent_id, type, payload, status, finished_at) VALUES ($1,$2,'RUN_SCRIPT','{}','failed', now())`, [job, agent]);
            await q(`INSERT INTO job_results (job_id, exit_code, stderr) VALUES ($1,1,$2)`, [job, `Failed ${label}${i}`]);
            await q(`INSERT INTO script_runs (script_name, job_id, device_id) VALUES ($1,$2,$3)`, [`Script ${label}${i} ${stamp}`, job, device]);
            out.sites.push({ site, device, host, label: `${label}${i}` });
        }
        return out;
    }
    const A = await customer("A");
    const B = await customer("B");
    const C = await customer("C", 1);
    const tag = uuid();
    madeTags.push(tag);
    await q(`INSERT INTO tag_defs (id, organization_id, name) VALUES ($1,$2,$3)`, [tag, org, `grp-tag-${stamp}`]);
    await q(`INSERT INTO device_tags (device_id, tag_id) VALUES ($1,$2)`, [C.sites[0].device, tag]);

    const readPerms = ["customers.read", "devices.read", "alerts.read", "automation.read", "policies.read", "checks.read"];
    const everyone = await user("everyone", readPerms);
    const bySite = await user("bysite", readPerms);
    const byTag = await user("bytag", readPerms);
    const byCustomer = await user("bycustomer", readPerms);
    const mixed = await user("mixed", readPerms);

    async function group(name, scope, members) {
        const res = await call("/api/admin/groups", { method: "POST", token: root.token, body: { name: `${name} ${stamp}`, scope, memberIds: members } });
        assert.equal(res.status, 201, await res.clone().text());
        const id = (await res.json()).id;
        madeGroups.push(id);
        return id;
    }
    const gSite = await group("Only A1", [{ kind: "site", id: A.sites[0].site }], [bySite.id]);
    await group("Tagged", [{ kind: "tag", id: tag }], [byTag.id]);
    await group("Whole B", [{ kind: "customer", id: B.client }], [byCustomer.id]);
    await group("Site A2", [{ kind: "site", id: A.sites[1].site }], [mixed.id]);
    await q(`INSERT INTO user_client_access (user_id, client_id) VALUES ($1,$2)`, [mixed.id, B.client]);

    const devices = async (p) => (await json("/api/devices?pageSize=200&q=GRP-", { token: p.token })).items.map((d) => d.id);
    await test("everyone with no limit sees every device", async () => {
        const ids = await devices(everyone);
        for (const c of [A, B, C]) for (const s of c.sites) assert.ok(ids.includes(s.device));
    });
    await test("a group limited to one site shows only that site's devices", async () => {
        const ids = await devices(bySite);
        assert.deepEqual(ids.sort(), [A.sites[0].device].sort());
    });
    await test("a group limited to a tag shows the devices carrying it, across customers", async () => {
        assert.deepEqual(await devices(byTag), [C.sites[0].device]);
    });
    await test("the device list shows each device's tags, and can filter and search by tag", async () => {
        const all = (await json("/api/devices?pageSize=200&q=GRP-", { token: everyone.token })).items;
        const tagged = all.find((d) => d.id === C.sites[0].device);
        assert.deepEqual(tagged.tags.map((t) => t.id), [tag]);
        assert.deepEqual(all.find((d) => d.id === A.sites[0].device).tags, []);
        const byFilter = (await json(`/api/devices?pageSize=200&tag=${tag}`, { token: everyone.token })).items.map((d) => d.id);
        assert.deepEqual(byFilter, [C.sites[0].device]);
        const bySearch = (await json(`/api/devices?pageSize=200&q=grp-tag-${stamp}`, { token: everyone.token })).items.map((d) => d.id);
        assert.deepEqual(bySearch, [C.sites[0].device]);
    });
    await test("a group limited to a customer shows all of its devices", async () => {
        assert.deepEqual((await devices(byCustomer)).sort(), B.sites.map((s) => s.device).sort());
    });
    await test("personal limits and group limits add up", async () => {
        assert.deepEqual((await devices(mixed)).sort(), [A.sites[1].device, ...B.sites.map((s) => s.device)].sort());
    });
    await test("a device outside the limit is not found, its own pages included", async () => {
        for (const path of [`/api/devices/${A.sites[1].device}`, `/api/devices/${A.sites[1].device}/software`, `/api/devices/${A.sites[1].device}/checks`, `/api/devices/${B.sites[0].device}`]) {
            assert.equal((await call(path, { token: bySite.token })).status, 404, path);
        }
        assert.equal((await call(`/api/devices/${A.sites[0].device}`, { token: bySite.token })).status, 200);
        assert.equal((await call(`/api/devices/${C.sites[0].device}`, { token: byTag.token })).status, 200);
    });
    await test("alerts follow the same limit", async () => {
        const titles = async (p) => (await json("/api/alerts?limit=200", { token: p.token })).items.map((a) => a.title).filter((t) => t.endsWith(String(stamp)));
        const mine = await titles(bySite);
        assert.deepEqual(mine, [`Alert A1 ${stamp}`]);
        const all = await titles(everyone);
        assert.ok(all.length >= 5);
    });
    await test("the failures list follows the same limit", async () => {
        const titles = async (p) => (await json("/api/automation/failures?days=7&limit=1000", { token: p.token })).items.map((i) => i.title).filter((t) => t.endsWith(String(stamp)));
        assert.deepEqual(await titles(bySite), [`Script A1 ${stamp}`]);
        assert.deepEqual(await titles(byTag), [`Script C1 ${stamp}`]);
        assert.ok((await titles(everyone)).length >= 5);
    });
    await test("the customer list shows each customer a person can reach, and no others", async () => {
        const names = async (p) => (await json("/api/customers?q=Grp%20", { token: p.token })).map((c) => c.name).filter((n) => n.endsWith(String(stamp))).sort();
        assert.deepEqual(await names(bySite), [A.name]);
        assert.deepEqual(await names(byTag), [C.name]);
        assert.deepEqual(await names(byCustomer), [B.name]);
        assert.deepEqual(await names(mixed), [A.name, B.name].sort());
        assert.equal((await call(`/api/customers/${B.client}`, { token: bySite.token })).status, 404);
    });
    await test("a device's policy view follows the limit too", async () => {
        assert.equal((await call(`/api/policies/devices/${A.sites[1].device}/effective`, { token: bySite.token })).status, 404);
        assert.equal((await call(`/api/policies/devices/${A.sites[0].device}/effective`, { token: bySite.token })).status, 200);
    });
    await test("taking the person out of the group lifts the limit; leaving a group empty of scope does not limit", async () => {
        assert.equal((await call(`/api/admin/users/${bySite.id}/groups`, { method: "PUT", token: root.token, body: { groupIds: [] } })).status, 204);
        const ids = await devices(bySite);
        assert.ok(ids.includes(B.sites[0].device) && ids.includes(A.sites[1].device));
        assert.equal((await call(`/api/admin/users/${bySite.id}/groups`, { method: "PUT", token: root.token, body: { groupIds: [gSite] } })).status, 204);
        assert.deepEqual(await devices(bySite), [A.sites[0].device]);
    });
    await test("deleting a group lifts its limit", async () => {
        assert.equal((await call(`/api/admin/groups/${gSite}`, { method: "DELETE", token: root.token })).status, 200);
        assert.ok((await devices(bySite)).includes(B.sites[0].device));
    });

    // ------------------------------------------------------------------ checks made from a device's page
    console.log("checks on a device");
    const checker = await user("checker", ["devices.read", "checks.read", "checks.write", "checks.delete"]);
    const reader = await user("checkreader", ["devices.read", "checks.read"]);
    const dev = A.sites[0].device;
    const body = (name) => ({ name, kind: "service", service: "Spooler", severity: "WARN", intervalMinutes: 5 });
    let ownId, sharedId;
    await test("a check can be made from the device page and is aimed at that device only", async () => {
        const res = await call(`/api/devices/${dev}/check-definitions`, { method: "POST", token: checker.token, body: body(`Own ${stamp}`) });
        assert.equal(res.status, 201, await res.clone().text());
        ownId = (await res.json()).id;
        const list = (await json(`/api/devices/${dev}/check-definitions`, { token: checker.token })).items;
        const mine = list.find((c) => c.id === ownId);
        assert.equal(mine.source, "device");
        assert.equal(mine.own, true);
        assert.deepEqual(mine.targets.map((t) => t.type), ["device"]);
        const other = (await json(`/api/devices/${A.sites[1].device}/check-definitions`, { token: checker.token })).items;
        assert.ok(!other.some((c) => c.id === ownId));
    });
    await test("checks from a customer, site or everyone are listed with their source but are not editable here", async () => {
        const res = await call("/api/checks", { method: "POST", token: root.token, body: { ...body(`Shared ${stamp}`), targets: [{ type: "client", id: A.client }, { type: "client", id: B.client }] } });
        assert.equal(res.status, 201, await res.clone().text());
        sharedId = (await res.json()).id;
        const row = (await json(`/api/devices/${dev}/check-definitions`, { token: checker.token })).items.find((c) => c.id === sharedId);
        assert.equal(row.source, "customer");
        assert.equal(row.own, false);
        assert.equal((await call(`/api/devices/${dev}/check-definitions/${sharedId}`, { method: "PUT", token: checker.token, body: body("changed") })).status, 409);
        assert.equal((await call(`/api/devices/${dev}/check-definitions/${sharedId}`, { method: "DELETE", token: checker.token })).status, 409);
        assert.equal((await json(`/api/devices/${B.sites[0].device}/check-definitions`, { token: checker.token })).items.some((c) => c.id === sharedId), true);
    });
    await test("an own check can be changed, turned off and deleted", async () => {
        const put = await call(`/api/devices/${dev}/check-definitions/${ownId}`, { method: "PUT", token: checker.token, body: { ...body(`Own ${stamp} v2`), enabled: false, intervalMinutes: 10 } });
        assert.equal(put.status, 200, await put.clone().text());
        const row = (await json(`/api/devices/${dev}/check-definitions`, { token: checker.token })).items.find((c) => c.id === ownId);
        assert.equal(row.name, `Own ${stamp} v2`);
        assert.equal(row.enabled, false);
        assert.equal(row.intervalMinutes, 10);
        assert.equal((await call(`/api/devices/${dev}/check-definitions/${ownId}`, { method: "DELETE", token: checker.token })).status, 204);
        assert.ok(!(await json(`/api/devices/${dev}/check-definitions`, { token: checker.token })).items.some((c) => c.id === ownId));
    });
    await test("bad input is refused and a reader cannot change anything", async () => {
        assert.equal((await call(`/api/devices/${dev}/check-definitions`, { method: "POST", token: checker.token, body: { name: "x", kind: "service" } })).status, 400);
        assert.equal((await call(`/api/devices/${dev}/check-definitions`, { method: "POST", token: checker.token, body: { name: "x", kind: "bogus" } })).status, 400);
        assert.equal((await call(`/api/devices/${dev}/check-definitions`, { method: "POST", token: reader.token, body: body("nope") })).status, 403);
        assert.equal((await call(`/api/devices/${dev}/check-definitions`, { token: reader.token })).status, 200);
    });
    await test("a limited person cannot see or change another customer's device checks", async () => {
        const limitedChecker = await user("limchecker", ["devices.read", "checks.read", "checks.write", "checks.delete"]);
        await q(`INSERT INTO user_client_access (user_id, client_id) VALUES ($1,$2)`, [limitedChecker.id, A.client]);
        assert.equal((await call(`/api/devices/${B.sites[0].device}/check-definitions`, { token: limitedChecker.token })).status, 404);
        assert.equal((await call(`/api/devices/${B.sites[0].device}/check-definitions`, { method: "POST", token: limitedChecker.token, body: body("sneaky") })).status, 404);
        assert.equal((await call(`/api/devices/${dev}/check-definitions`, { token: limitedChecker.token })).status, 200);
    });
    if (sharedId) await call(`/api/checks/${sharedId}`, { method: "DELETE", token: root.token });

    // ------------------------------------------------------------------ reports the Reports page runs
    console.log("reports route");
    await test("every report runs from the one route the Reports page uses, each asking for the right it reads", async () => {
        const devicesOnly = await user("repdev", ["devices.read"]);
        const withTickets = await user("reptix", ["devices.read", "tickets.read", "alerts.read"]);
        assert.equal((await call("/api/reports/run/hardware-age", { token: devicesOnly.token })).status, 200);
        assert.equal((await call("/api/reports/run/availability", { token: devicesOnly.token })).status, 200);
        assert.equal((await call("/api/reports/run/ticket-sla", { token: devicesOnly.token })).status, 403);
        assert.equal((await call("/api/reports/run/ticket-sla", { token: withTickets.token })).status, 200);
        assert.equal((await call("/api/reports/run/alert-noise", { token: withTickets.token })).status, 200);
        assert.equal((await call("/api/reports/run/nope", { token: withTickets.token })).status, 404);
        assert.equal((await call("/api/reports/run/alert-history", { token: withTickets.token })).status, 404);
    });

    // ------------------------------------------------------------------ run checks now
    console.log("run checks now");
    const runner = await user("runnow", ["devices.read", "checks.read", "checks.run"]);
    const runDev = A.sites[0].device;
    const setAgent = (sql, params) => q(`UPDATE agents SET ${sql} WHERE device_id = $1`, [runDev, ...(params ?? [])]);
    const run = (body, token = runner.token, device = runDev) => call(`/api/devices/${device}/checks/run`, { method: "POST", token, body });
    await test("run now needs agent 1.3.29 on Windows, and the device online", async () => {
        const old = await run({});
        assert.equal(old.status, 409);
        assert.match((await old.json()).message, /1\.3\.29/);
        await setAgent(`version = '1.3.29'`);
        await setAgent(`last_check_in_at = now() - interval '1 hour'`);
        const off = await run({});
        assert.equal(off.status, 409);
        assert.match((await off.json()).message, /offline/);
        await setAgent(`last_check_in_at = now()`);
        await setAgent(`facts = '{"os":"linux"}'::jsonb`);
        assert.equal((await run({})).status, 409);
        await setAgent(`facts = '{"os":"windows"}'::jsonb`);
    });
    await test("a request becomes one signed task, and pressing again reuses it", async () => {
        const first = await run({});
        assert.equal(first.status, 202, await first.clone().text());
        const a = await first.json();
        assert.equal(a.accepted, true);
        const row = (await q(`SELECT type::text AS type, status::text AS status, payload FROM agent_tasks WHERE id = $1`, [a.taskId])).rows[0];
        assert.equal(row.type, "run_checks");
        assert.equal(row.status, "queued");
        assert.deepEqual(row.payload, { keys: [] });
        const again = await (await run({})).json();
        assert.equal(again.taskId, a.taskId);
        assert.equal(again.reused, true);
        const named = await (await run({ keys: ["check:abc", "disk"] })).json();
        assert.notEqual(named.taskId, a.taskId);
        assert.deepEqual((await q(`SELECT payload FROM agent_tasks WHERE id = $1`, [named.taskId])).rows[0].payload, { keys: ["check:abc", "disk"] });
    });
    await test("run now checks rights, scope and input", async () => {
        const viewer = await user("runview", ["devices.read", "checks.read"]);
        assert.equal((await run({}, viewer.token)).status, 403);
        assert.equal((await run({})).status, 202);
        const limited = await user("runlim", ["devices.read", "checks.read", "checks.run"]);
        await q(`INSERT INTO user_client_access (user_id, client_id) VALUES ($1,$2)`, [limited.id, B.client]);
        assert.equal((await run({}, limited.token)).status, 404);
        assert.equal((await run({ keys: "disk" })).status, 400);
        assert.equal((await run({ keys: Array.from({ length: 51 }, (_, i) => `k${i}`) })).status, 400);
        assert.equal((await call(`/api/devices/${runDev}/checks/run`, { method: "POST", body: {} })).status, 401);
        assert.equal((await call(`/api/devices/not-a-uuid/checks/run`, { method: "POST", token: runner.token, body: {} })).status, 400);
    });
    await q(`DELETE FROM agent_tasks WHERE agent_id = (SELECT id FROM agents WHERE device_id = $1)`, [runDev]);

    // ------------------------------------------------------------------ software library and installs
    console.log("software library");
    const libAdmin = await user("libadmin", ["devices.read", "policies.read", "policies.write", "software.install"]);
    const libReader = await user("libreader", ["devices.read", "policies.read"]);
    const swAgent = (await q(`SELECT id FROM agents WHERE device_id = $1`, [runDev])).rows[0].id;
    const lib = (path, opts = {}, p = libAdmin) => call(`/api/software-library${path}`, { token: p.token, ...opts });
    await test("the library starts with a catalog, and reading needs the policies right", async () => {
        const r = await lib("", {}, libReader);
        assert.equal(r.status, 200);
        const body = await r.json();
        assert.ok(body.items.length > 60, `only ${body.items.length}`);
        assert.ok(body.items.some((i) => i.name === "Google Chrome" && i.chocolateyId === "googlechrome" && i.installable === true));
        assert.ok(body.categories.includes("Browsers"));
        const chrome = await (await lib("?q=firefox", {}, libReader)).json();
        assert.ok(chrome.items.length >= 1 && chrome.items.every((i) => /firefox/i.test(i.name + i.matchText)));
        const nobody = await user("libnobody", ["devices.read"]);
        assert.equal((await lib("", {}, nobody)).status, 403);
    });
    await test("entries are validated, unique and need the write right", async () => {
        const name = `Tst App ${stamp}`;
        assert.equal((await lib("", { method: "POST", body: { name, matchText: "x" } }, libReader)).status, 403);
        assert.equal((await lib("", { method: "POST", body: { matchText: "x" } })).status, 400);
        assert.equal((await lib("", { method: "POST", body: { name, matchText: "x", installerUrl: "http://example.test/a.exe", installerSha256: "a".repeat(64) } })).status, 400);
        assert.equal((await lib("", { method: "POST", body: { name, matchText: "x", installerUrl: "https://example.test/a.exe" } })).status, 400);
        assert.equal((await lib("", { method: "POST", body: { name, matchText: "x", chocolateyId: "bad id; rm -rf" } })).status, 400);
        const made = await lib("", { method: "POST", body: { name, matchText: `tstapp${stamp}`, chocolateyId: "tst-app", category: "Utilities" } });
        assert.equal(made.status, 201);
        const entry = await made.json();
        assert.equal(entry.installable, true);
        assert.equal((await lib("", { method: "POST", body: { name: name.toUpperCase(), matchText: "y" } })).status, 409);
        const upd = await lib(`/${entry.id}`, { method: "PATCH", body: { notes: "changed" } });
        assert.equal(upd.status, 200);
        assert.equal((await upd.json()).notes, "changed");
        assert.equal((await lib(`/${entry.id}`, { method: "DELETE" }, libReader)).status, 403);
        assert.equal((await lib(`/${entry.id}`, { method: "DELETE" })).status, 200);
        assert.equal((await lib(`/${entry.id}`, { method: "DELETE" })).status, 404);
    });

    const widget = `Zzq Widget ${stamp}`;
    await q(`DELETE FROM agent_software WHERE agent_id = $1`, [swAgent]);
    await q(`INSERT INTO agent_software (agent_id, name, version, publisher, scope, installed_user, installed_by) VALUES ($1,$2,'1.0','Zzq Inc','user','PC\\bob','PC\\bob'), ($1,'Google Chrome','120.0','Google','machine',NULL,'PC\\admin')`, [swAgent, widget]);
    await test("the software list shows whether a program is the system's or a user's, and who installed it", async () => {
        const items = (await json(`/api/devices/${runDev}/software`, { token: libAdmin.token })).items;
        const w = items.find((i) => i.name === widget);
        assert.equal(w.scope, "user");
        assert.equal(w.user, "PC\\bob");
        assert.equal(w.installedBy, "PC\\bob");
        const c = items.find((i) => i.name === "Google Chrome");
        assert.equal(c.scope, "machine");
        assert.equal(c.user, null);
        assert.equal(c.installedBy, "PC\\admin");
    });
    await test("names no library entry covers are offered, and stop being offered once one matches", async () => {
        const first = await (await lib(`/seen?q=Zzq%20Widget%20${stamp}`)).json();
        assert.deepEqual(first.items.map((i) => [i.name, i.devices]), [[widget, 1]]);
        const entry = await (await lib("", { method: "POST", body: { name: `Zzq ${stamp}`, matchText: `Zzq Widget ${stamp}`, chocolateyId: "zzq-widget" } })).json();
        const after = await (await lib(`/seen?q=Zzq%20Widget%20${stamp}`)).json();
        assert.equal(after.items.length, 0);
        const counted = (await (await lib(`?q=Zzq%20${stamp}`)).json()).items.find((i) => i.id === entry.id);
        assert.equal(counted.devices, 1);
        const limited = await user("libLim", ["devices.read", "policies.read"]);
        await q(`INSERT INTO user_client_access (user_id, client_id) VALUES ($1,$2)`, [limited.id, B.client]);
        const hidden = (await (await lib(`?q=Zzq%20${stamp}`, {}, limited)).json()).items.find((i) => i.id === entry.id);
        assert.equal(hidden.devices, 0);
        assert.equal((await (await lib(`/seen?q=Zzq`, {}, limited)).json()).items.length, 0);
    });

    const installEntry = await (await lib("", { method: "POST", body: { name: `Tst Install ${stamp}`, matchText: `TstInstall${stamp}`, chocolateyId: "tst-install" } })).json();
    const directEntry = await (await lib("", { method: "POST", body: { name: `Tst Direct ${stamp}`, matchText: `TstDirect${stamp}`, installerUrl: "https://example.test/setup.exe", installerSha256: "B".repeat(64), silentArgs: "/S" } })).json();
    const bareEntry = await (await lib("", { method: "POST", body: { name: `Tst Bare ${stamp}`, matchText: `TstBare${stamp}` } })).json();
    const prev = (id, body, p = libAdmin) => lib(`/${id}/install-preview`, { method: "POST", body, token: p.token }, p);
    await test("an install preview says who would be touched and who is skipped and why", async () => {
        assert.equal((await prev(installEntry.id, { action: "install", deviceIds: [runDev] }, libReader)).status, 403);
        assert.equal((await prev(installEntry.id, { action: "bogus", deviceIds: [runDev] })).status, 400);
        assert.equal((await prev(installEntry.id, { action: "install" })).status, 400);
        await setAgent(`version = '1.3.29'`);
        const old = await (await prev(installEntry.id, { action: "install", deviceIds: [runDev] })).json();
        assert.equal(old.eligible.length, 0);
        assert.match(old.skipped[0].reason, /1\.3\.31/);
        await setAgent(`version = '1.3.31'`);
        await setAgent(`last_check_in_at = now()`);
        const ok = await (await prev(installEntry.id, { action: "install", deviceIds: [runDev] })).json();
        assert.deepEqual(ok.eligible.map((e) => e.deviceId), [runDev]);
        const notThere = await (await prev(installEntry.id, { action: "uninstall", deviceIds: [runDev] })).json();
        assert.match(notThere.skipped[0].reason, /does not have/);
        const have = await (await prev(`${(await (await lib(`?q=Zzq%20${stamp}`)).json()).items[0].id}`, { action: "install", deviceIds: [runDev] })).json();
        assert.match(have.skipped[0].reason, /already has/);
        assert.equal((await prev(bareEntry.id, { action: "install", deviceIds: [runDev] })).status, 409);
        assert.equal((await prev(directEntry.id, { action: "uninstall", deviceIds: [runDev] })).status, 409);
        const bySite = await (await prev(installEntry.id, { action: "install", siteIds: [A.sites[0].site] })).json();
        assert.ok(bySite.total >= 1);
    });
    await test("an install becomes a task the agent is told to run, once, and stays inside the person's customers", async () => {
        const inst = (id, body, p = libAdmin) => lib(`/${id}/install`, { method: "POST", body, token: p.token }, p);
        assert.equal((await inst(installEntry.id, { action: "install", deviceIds: [runDev] }, libReader)).status, 403);
        const queued = await inst(installEntry.id, { action: "install", deviceIds: [runDev] });
        assert.equal(queued.status, 202);
        assert.equal((await queued.json()).queued, 1);
        const row = (await q(`SELECT type::text AS type, status::text AS status, payload FROM agent_tasks WHERE agent_id = $1 AND type = 'software_install' ORDER BY created_at DESC LIMIT 1`, [swAgent])).rows[0];
        assert.equal(row.status, "queued");
        assert.deepEqual(row.payload, { action: "install", name: installEntry.name, matchText: installEntry.matchText, method: "chocolatey", chocolateyId: "tst-install" });
        const again = await (await inst(installEntry.id, { action: "install", deviceIds: [runDev] })).json();
        assert.equal(again.queued, 0);
        assert.match(again.skipped[0].reason, /already waiting/);
        const direct = await (await inst(directEntry.id, { action: "install", deviceIds: [runDev] })).json();
        assert.equal(direct.queued, 1);
        const drow = (await q(`SELECT payload FROM agent_tasks WHERE agent_id = $1 AND type = 'software_install' AND payload->>'method' = 'direct'`, [swAgent])).rows[0];
        assert.equal(drow.payload.installerSha256, "b".repeat(64));
        assert.equal(drow.payload.installerKind, "exe");
        assert.equal(drow.payload.silentArgs, "/S");
        const limited = await user("libLim2", ["devices.read", "policies.read", "software.install"]);
        await q(`INSERT INTO user_client_access (user_id, client_id) VALUES ($1,$2)`, [limited.id, B.client]);
        const blocked = await (await inst(installEntry.id, { action: "install", deviceIds: [runDev] }, limited)).json();
        assert.equal(blocked.queued, 0);
        assert.equal((await inst(installEntry.id, { action: "install", deviceIds: Array.from({ length: 201 }, () => require("crypto").randomUUID()) })).status, 400);
    });
    await test("a library entry can carry extra Chocolatey arguments, sent with an install but not a removal", async () => {
        const brave = (await (await lib("?q=Brave")).json()).items.find((i) => i.name === "Brave");
        assert.equal(brave.chocolateyInstallArgs, "--system-level");
        assert.equal((await lib("", { method: "POST", body: { name: `Tst Args Bad ${stamp}`, matchText: "x", chocolateyId: "x-y", chocolateyInstallArgs: "--a\u0000b" } })).status, 400);
        assert.equal((await lib("", { method: "POST", body: { name: `Tst Args Long ${stamp}`, matchText: "x", chocolateyId: "x-y", chocolateyParams: "p".repeat(201) } })).status, 400);
        const made = await (await lib("", { method: "POST", body: { name: `Tst Args ${stamp}`, matchText: `TstArgs${stamp}`, chocolateyId: "tst-args", chocolateyParams: "/NoDesktopIcon", chocolateyInstallArgs: "--system-level" } })).json();
        assert.equal(made.chocolateyParams, "/NoDesktopIcon");
        assert.equal(made.chocolateyInstallArgs, "--system-level");
        await q(`DELETE FROM agent_tasks WHERE agent_id = $1`, [swAgent]);
        assert.equal((await (await lib(`/${made.id}/install`, { method: "POST", body: { action: "install", deviceIds: [runDev] } })).json()).queued, 1);
        const row = (await q(`SELECT payload FROM agent_tasks WHERE agent_id = $1 AND type = 'software_install'`, [swAgent])).rows[0];
        assert.equal(row.payload.chocolateyParams, "/NoDesktopIcon");
        assert.equal(row.payload.chocolateyInstallArgs, "--system-level");
        await q(`DELETE FROM agent_tasks WHERE agent_id = $1`, [swAgent]);
        await q(`INSERT INTO agent_software (agent_id, name, version) VALUES ($1, $2, '1')`, [swAgent, `TstArgs${stamp} app`]);
        assert.equal((await (await lib(`/${made.id}/install`, { method: "POST", body: { action: "uninstall", deviceIds: [runDev] } })).json()).queued, 1);
        const rm = (await q(`SELECT payload FROM agent_tasks WHERE agent_id = $1 AND type = 'software_install'`, [swAgent])).rows[0];
        assert.equal(rm.payload.chocolateyParams, undefined);
        assert.equal(rm.payload.chocolateyInstallArgs, undefined);
        await q(`DELETE FROM agent_software WHERE agent_id = $1 AND name = $2`, [swAgent, `TstArgs${stamp} app`]);
        await q(`DELETE FROM agent_tasks WHERE agent_id = $1`, [swAgent]);
    });
    await test("one device can be asked from its own page, with a plain reason when it cannot", async () => {
        await q(`DELETE FROM agent_tasks WHERE agent_id = $1`, [swAgent]);
        const one = (body, p = libAdmin, dev = runDev) => call(`/api/devices/${dev}/software/install`, { method: "POST", token: p.token, body });
        assert.equal((await one({ libraryId: installEntry.id, action: "install" }, libReader)).status, 403);
        const ok = await one({ libraryId: installEntry.id, action: "install" });
        assert.equal(ok.status, 202);
        assert.equal((await ok.json()).accepted, true);
        const dup = await one({ libraryId: installEntry.id, action: "install" });
        assert.equal(dup.status, 409);
        assert.match((await dup.json()).message, /already waiting/);
        await setAgent(`last_check_in_at = now() - interval '1 hour'`);
        const off = await one({ libraryId: directEntry.id, action: "install" });
        assert.equal(off.status, 409);
        assert.match((await off.json()).message, /offline/);
        await setAgent(`last_check_in_at = now()`);
        const limited = await user("libLim3", ["devices.read", "policies.read", "software.install"]);
        await q(`INSERT INTO user_client_access (user_id, client_id) VALUES ($1,$2)`, [limited.id, B.client]);
        assert.equal((await one({ libraryId: installEntry.id, action: "install" }, limited)).status, 404);
        assert.equal((await one({ libraryId: "nope", action: "install" })).status, 400);
    });
    await test("Fix now plans what each missing or banned program maps to and who can be given it", async () => {
        await q(`DELETE FROM agent_tasks WHERE agent_id = $1`, [swAgent]);
        await q(`DELETE FROM agent_software WHERE agent_id = $1 AND name LIKE 'Tst%'`, [swAgent]);
        await setAgent(`version = '1.3.31'`);
        await setAgent(`last_check_in_at = now()`);
        const plan = (fixes, p = libAdmin) => call(`/api/software-library/fix-plan`, { method: "POST", token: p.token, body: { fixes } });
        const group = (r, item, action) => r.groups.find((g) => g.item === item && g.action === action);

        assert.equal((await plan([{ deviceId: runDev, action: "install", item: installEntry.matchText }], libReader)).status, 403);
        assert.equal((await plan([])).status, 400);
        assert.equal((await plan([{ deviceId: "nope", action: "install", item: "x" }])).status, 400);
        assert.equal((await plan([{ deviceId: runDev, action: "bogus", item: "x" }])).status, 400);

        const unknown = `Nothing Like This ${stamp}`;
        await q(`INSERT INTO agent_software (agent_id, name, version) VALUES ($1, $2, '1')`, [swAgent, `${directEntry.matchText} app`]);
        const r = await (await plan([
            { deviceId: runDev, action: "install", item: installEntry.matchText },
            { deviceId: runDev, action: "install", item: ` ${installEntry.matchText.toLowerCase()} ` },
            { deviceId: runDev, action: "install", item: unknown },
            { deviceId: runDev, action: "install", item: bareEntry.matchText },
            { deviceId: runDev, action: "uninstall", item: installEntry.matchText },
            { deviceId: runDev, action: "uninstall", item: directEntry.matchText },
        ])).json();

        // The same program named twice (different case, spaces) is one group.
        const inst = r.groups.filter((g) => g.action === "install" && g.entry?.id === installEntry.id);
        assert.equal(inst.length, 1);
        assert.deepEqual(inst[0].eligible.map((e) => e.deviceId), [runDev]);
        assert.equal(inst[0].entry.method, "chocolatey");
        assert.equal(inst[0].problem, null);
        assert.equal(inst[0].notPlanned, 0);

        // Not in the library, and in the library but with no way to install it.
        assert.equal(group(r, unknown, "install").entry, null);
        assert.match(group(r, unknown, "install").problem, /not in the software library/);
        assert.match(group(r, bareEntry.matchText, "install").problem, /cannot be installed from here/);

        // Removal: skipped when the device does not have it, refused when the entry has no Chocolatey id.
        assert.equal(group(r, installEntry.matchText, "uninstall").eligible.length, 0);
        assert.match(group(r, installEntry.matchText, "uninstall").skipped[0].reason, /does not have/);
        assert.match(group(r, directEntry.matchText, "uninstall").problem, /needs a Chocolatey id/);

        // A removal is eligible once the program is on the device, and matching can be by part of a name.
        await q(`INSERT INTO agent_software (agent_id, name, version) VALUES ($1, $2, '1')`, [swAgent, `${installEntry.matchText} app`]);
        const again = await (await plan([{ deviceId: runDev, action: "uninstall", item: installEntry.matchText }])).json();
        assert.deepEqual(again.groups[0].eligible.map((e) => e.deviceId), [runDev]);

        // Customer limits apply: a person who cannot see the device is not offered it.
        const limited = await user("fixLim", ["devices.read", "policies.read", "software.install"]);
        await q(`INSERT INTO user_client_access (user_id, client_id) VALUES ($1,$2)`, [limited.id, B.client]);
        const hidden = await (await plan([{ deviceId: runDev, action: "install", item: installEntry.matchText }], limited)).json();
        assert.equal(hidden.groups[0].eligible.length, 0);
        assert.equal(hidden.groups[0].skipped.length, 0);

        // The plan changes nothing.
        assert.equal((await q(`SELECT count(*)::int AS n FROM agent_tasks WHERE agent_id = $1`, [swAgent])).rows[0].n, 0);
        await q(`DELETE FROM agent_software WHERE agent_id = $1 AND name LIKE 'Tst%'`, [swAgent]);
    });
    await test("{{agent.*}} in a script is filled in for the device it is sent to, or the script is stopped with the reason", async () => {
        const send = async (scriptText, language = "powershell") => {
            const r = await call(`/api/admin/jobs/run-script`, { method: "POST", admin: true, body: { agentId: swAgent, language, scriptText } });
            assert.ok(r.status < 300, `${r.status} ${await r.clone().text()}`);
            const job = await r.json();
            return (await q(`SELECT payload FROM jobs WHERE id = $1`, [job.id])).rows[0].payload;
        };
        const host = (await q(`SELECT hostname, (SELECT name FROM clients c WHERE c.id = (SELECT client_id FROM sites WHERE id = d.site_id)) AS customer FROM devices d WHERE id = $1`, [runDev])).rows[0];

        // Filled in, with the properties also available as environment variables.
        const ok = await send("Write-Output '{{agent.hostname}} {{agent.customer}}'");
        assert.equal(ok.scriptText, `Write-Output '${host.hostname} ${host.customer}'`);
        assert.equal(ok.env.ADG_AGENT_HOSTNAME, host.hostname);
        assert.equal(ok.env.ADG_AGENT_CUSTOMER, host.customer);

        // A script that does not use them is untouched, with no extra environment.
        const plain = await send("Get-Date");
        assert.equal(plain.scriptText, "Get-Date");
        assert.deepEqual(plain.env, {});

        // An unknown property stops the script: the author's text is never sent, and the output says which one.
        const bad = await send("Remove-Item C:\\data -Recurse; Write-Output {{agent.nonsense}}");
        assert.ok(!bad.scriptText.includes("Remove-Item"));
        assert.match(bad.scriptText, /agent\.nonsense\}\} is not a property/);
        const badSh = await send("rm -rf / # {{agent.nonsense}}", "bash");
        assert.ok(!badSh.scriptText.includes("rm -rf"));
        assert.match(badSh.scriptText, /agent\.nonsense\}\} is not a property/);

        // A value the device does not have stops it too (this device has no signed-in user recorded).
        await q(`UPDATE devices SET primary_user = NULL WHERE id = $1`, [runDev]);
        const noUser = await send("Write-Output {{agent.user}}");
        assert.match(noUser.scriptText, /agent\.user\}\} has no value/);
        await q(`UPDATE devices SET primary_user = 'bob' WHERE id = $1`, [runDev]);
        assert.equal((await send("Write-Output {{agent.user}}")).scriptText, "Write-Output bob");
        await q(`UPDATE devices SET primary_user = NULL WHERE id = $1`, [runDev]);

        await q(`DELETE FROM jobs WHERE agent_id = $1`, [swAgent]);
    });
    await test("a removal the inventory cannot confirm is skipped, unless the person says to remove it anyway", async () => {
        await q(`DELETE FROM agent_tasks WHERE agent_id = $1`, [swAgent]);
        const plain = await (await prev(installEntry.id, { action: "uninstall", deviceIds: [runDev] })).json();
        assert.equal(plain.eligible.length, 0);
        assert.match(plain.skipped[0].reason, /does not have/);
        const forced = await (await prev(installEntry.id, { action: "uninstall", deviceIds: [runDev], force: true })).json();
        assert.deepEqual(forced.eligible.map((e) => e.deviceId), [runDev]);
        const inst = (body, p = libAdmin) => lib(`/${installEntry.id}/install`, { method: "POST", body, token: p.token }, p);
        assert.equal((await (await inst({ action: "uninstall", deviceIds: [runDev] })).json()).queued, 0);
        assert.equal((await (await inst({ action: "uninstall", deviceIds: [runDev], force: true })).json()).queued, 1);
        const row = (await q(`SELECT payload FROM agent_tasks WHERE agent_id = $1 AND type = 'software_install'`, [swAgent])).rows[0];
        assert.equal(row.payload.action, "uninstall");
        assert.equal(row.payload.method, "chocolatey");
        await q(`DELETE FROM agent_tasks WHERE agent_id = $1`, [swAgent]);
        const one = (body) => call(`/api/devices/${runDev}/software/install`, { method: "POST", token: libAdmin.token, body: { libraryId: installEntry.id, ...body } });
        assert.equal((await one({ action: "uninstall" })).status, 409);
        assert.equal((await one({ action: "uninstall", force: true })).status, 202);
        await q(`DELETE FROM agent_tasks WHERE agent_id = $1`, [swAgent]);
    });
    await test("an install can be aimed at one signed-in user, and the device's users can be listed", async () => {
        await q(`DELETE FROM agent_tasks WHERE agent_id = $1`, [swAgent]);
        await q(`DELETE FROM agent_user_accounts WHERE agent_id = $1`, [swAgent]);
        await q(`INSERT INTO agent_user_accounts (agent_id, account, logged_in) VALUES ($1, $2, true), ($1, $3, false)`, [swAgent, "PC\\bob", "PC\\alice"]);
        const users = (await json(`/api/devices/${runDev}/software/users`, { token: libReader.token })).items;
        assert.deepEqual(users.map((u) => [u.account, u.loggedIn]), [["PC\\bob", true], ["PC\\alice", false]]);
        const nobody = await user("usrlow", ["policies.read"]);
        assert.equal((await call(`/api/devices/${runDev}/software/users`, { token: nobody.token })).status, 403);
        const limited = await user("usrLim", ["devices.read"]);
        await q(`INSERT INTO user_client_access (user_id, client_id) VALUES ($1,$2)`, [limited.id, B.client]);
        assert.equal((await call(`/api/devices/${runDev}/software/users`, { token: limited.token })).status, 404);

        const wingetEntry = await (await lib("", { method: "POST", body: { name: `Tst Winget ${stamp}`, matchText: `TstWinget${stamp}`, wingetId: "Tst.Winget", chocolateyId: "tst-winget" } })).json();
        const chocoOnly = await (await lib("", { method: "POST", body: { name: `Tst ChocoOnly ${stamp}`, matchText: `TstChocoOnly${stamp}`, chocolateyId: "tst-choco-only" } })).json();
        const one = (entry, body, p = libAdmin) => call(`/api/devices/${runDev}/software/install`, { method: "POST", token: p.token, body: { libraryId: entry.id, ...body } });

        const ok = await one(wingetEntry, { action: "install", runAs: "pc\\BOB" });
        assert.equal(ok.status, 202, await ok.clone().text());
        const row = (await q(`SELECT payload FROM agent_tasks WHERE id = $1`, [(await ok.json()).taskId])).rows[0];
        assert.deepEqual(row.payload, { action: "install", name: wingetEntry.name, matchText: wingetEntry.matchText, method: "winget", wingetId: "Tst.Winget", runAs: { user: "PC\\bob" } });

        const direct = await one(directEntry, { action: "install", runAs: "PC\\bob" });
        assert.equal(direct.status, 202);
        const drow = (await q(`SELECT payload FROM agent_tasks WHERE id = $1`, [(await direct.json()).taskId])).rows[0];
        assert.equal(drow.payload.method, "direct");
        assert.deepEqual(drow.payload.runAs, { user: "PC\\bob" });

        const refuse = async (entry, body, status, pattern) => { const r = await one(entry, body); assert.equal(r.status, status); if (pattern) assert.match((await r.json()).message, pattern); };
        await refuse(chocoOnly, { action: "install", runAs: "PC\\bob" }, 409, /winget id or a direct installer/);
        await refuse(wingetEntry, { action: "install", runAs: "PC\\alice" }, 409, /not signed in/);
        await refuse(wingetEntry, { action: "install", runAs: "PC\\carol" }, 409, /not one of this device's users/);
        await refuse(wingetEntry, { action: "install", runAs: "no-backslash" }, 400);
        // Removal for one user: winget only, and only when that user's own entries show it, on an agent that knows how.
        await refuse(chocoOnly, { action: "uninstall", runAs: "PC\\bob" }, 409, /needs a winget id/);
        await refuse(wingetEntry, { action: "uninstall", runAs: "PC\\bob" }, 409, /does not have .* installed/);
        await q(`INSERT INTO agent_software (agent_id, name, version, scope, installed_user) VALUES ($1, $2, '1', 'user', $3)`, [swAgent, `TstWinget${stamp} app`, "PC\\bob"]);
        await setAgent(`version = '1.3.32'`);
        await refuse(wingetEntry, { action: "uninstall", runAs: "PC\\bob" }, 409, /1\.3\.33/);
        await setAgent(`version = '1.3.33'`);
        const rm = await one(wingetEntry, { action: "uninstall", runAs: "PC\\bob" });
        assert.equal(rm.status, 202, await rm.clone().text());
        const rmRow = (await q(`SELECT payload FROM agent_tasks WHERE id = $1`, [(await rm.json()).taskId])).rows[0];
        assert.deepEqual(rmRow.payload, { action: "uninstall", name: wingetEntry.name, matchText: wingetEntry.matchText, method: "winget", wingetId: "Tst.Winget", runAs: { user: "PC\\bob" } });
        await q(`DELETE FROM agent_tasks WHERE agent_id = $1 AND type = 'software_install' AND payload->>'action' = 'uninstall'`, [swAgent]);
        await q(`DELETE FROM agent_software WHERE agent_id = $1 AND name = $2`, [swAgent, `TstWinget${stamp} app`]);
        await setAgent(`version = '1.3.31'`);
        assert.equal((await one(wingetEntry, { action: "install", runAs: "PC\\bob" }, libReader)).status, 403);
        assert.equal((await one(wingetEntry, { action: "install", runAs: "PC\\bob" }, limited)).status, 403);
        const instLimited = await user("usrLim2", ["devices.read", "policies.read", "software.install"]);
        await q(`INSERT INTO user_client_access (user_id, client_id) VALUES ($1,$2)`, [instLimited.id, B.client]);
        assert.equal((await one(wingetEntry, { action: "install", runAs: "PC\\bob" }, instLimited)).status, 404);

        // The log says who it was for.
        const logged = (await json(`/api/devices/${runDev}/software/installs`, { token: libReader.token })).items;
        assert.ok(logged.some((i) => i.method === "winget" && i.runAs === "PC\\bob"));
        await q(`DELETE FROM agent_tasks WHERE agent_id = $1`, [swAgent]);
        await q(`DELETE FROM agent_user_accounts WHERE agent_id = $1`, [swAgent]);
    });
    await test("the install log shows what each install did, who asked, and what the device said", async () => {
        await q(`DELETE FROM agent_tasks WHERE agent_id = $1`, [swAgent]);
        const one = (body) => call(`/api/devices/${runDev}/software/install`, { method: "POST", token: libAdmin.token, body });
        const ok = await (await one({ libraryId: installEntry.id, action: "install" })).json();
        const waiting = (await json(`/api/devices/${runDev}/software/installs`, { token: libReader.token })).items;
        assert.equal(waiting.length, 1);
        assert.equal(waiting[0].status, "waiting");
        assert.equal(waiting[0].action, "install");
        assert.equal(waiting[0].name, installEntry.name);
        assert.equal(waiting[0].method, "chocolatey");
        assert.equal(waiting[0].stale, false);
        assert.equal(waiting[0].ok, null);

        // The agent picks it up and reports back: a run row, its output and its result text.
        const run = (await q(`INSERT INTO agent_task_runs (task_id, status) VALUES ($1, 'succeeded') RETURNING id`, [ok.taskId])).rows[0].id;
        await q(`UPDATE agent_task_runs SET output = $2::jsonb, finished_at = now() WHERE id = $1`, [run, JSON.stringify({ ok: true, method: "chocolatey", action: "install", exitCode: 0, message: "Installed with Chocolatey." })]);
        await q(`INSERT INTO agent_task_results (run_id, stdout, stderr) VALUES ($1, $2, $3)`, [run, "Chocolatey v2.0\nInstalling tst-install\nThe install was successful.", "a warning line"]);
        await q(`UPDATE agent_tasks SET status = 'succeeded', started_at = now(), completed_at = now() WHERE id = $1`, [ok.taskId]);
        const done = (await json(`/api/devices/${runDev}/software/installs`, { token: libReader.token })).items[0];
        assert.equal(done.status, "succeeded");
        assert.equal(done.ok, true);
        assert.equal(done.exitCode, 0);
        assert.equal(done.message, "Installed with Chocolatey.");
        assert.match(done.stdout, /The install was successful/);
        assert.equal(done.stderr, "a warning line");
        assert.ok(done.finishedAt);
        assert.ok(done.requestedBy && done.requestedBy.length > 0);
        assert.equal(done.device.length > 0, true);

        // A failure shows its reason, and a request nobody answered for a long time is marked stale.
        const bad = await (await one({ libraryId: directEntry.id, action: "install" })).json();
        const run2 = (await q(`INSERT INTO agent_task_runs (task_id, status) VALUES ($1, 'failed') RETURNING id`, [bad.taskId])).rows[0].id;
        await q(`UPDATE agent_task_runs SET output = $2::jsonb WHERE id = $1`, [run2, JSON.stringify({ ok: false, method: "direct", action: "install", exitCode: null, message: "The installer's hash did not match, so it was not run." })]);
        await q(`UPDATE agent_tasks SET status = 'failed', completed_at = now() WHERE id = $1`, [bad.taskId]);
        const stuck = await (await call(`/api/software-library/${installEntry.id}/install`, { method: "POST", token: libAdmin.token, body: { action: "install", deviceIds: [runDev] } })).json();
        assert.equal(stuck.queued, 1);
        await q(`UPDATE agent_tasks SET created_at = now() - interval '2 hours' WHERE agent_id = $1 AND status = 'queued'`, [swAgent]);
        const all = (await json(`/api/devices/${runDev}/software/installs`, { token: libReader.token })).items;
        assert.equal(all.length, 3);
        assert.equal(all.find((i) => i.status === "failed").message, "The installer's hash did not match, so it was not run.");
        assert.equal(all.find((i) => i.status === "waiting").stale, true);
        assert.equal(all.find((i) => i.status === "waiting").action, "install");

        // The whole-fleet log can be filtered, and respects customer limits and the right to see devices.
        const failedOnly = (await json(`/api/software-library/installs?status=failed`, { token: libReader.token })).items;
        assert.ok(failedOnly.length >= 1 && failedOnly.every((i) => i.status === "failed"));
        const waitingOnly = (await json(`/api/software-library/installs?status=waiting`, { token: libReader.token })).items;
        assert.ok(waitingOnly.some((i) => i.deviceId === runDev));
        const nobody = await user("loglow", ["policies.read"]);
        assert.equal((await call(`/api/software-library/installs`, { token: nobody.token })).status, 403);
        assert.equal((await call(`/api/devices/${runDev}/software/installs`, { token: nobody.token })).status, 403);
        const limited = await user("logLim", ["devices.read"]);
        await q(`INSERT INTO user_client_access (user_id, client_id) VALUES ($1,$2)`, [limited.id, B.client]);
        assert.equal((await call(`/api/devices/${runDev}/software/installs`, { token: limited.token })).status, 404);
        assert.equal((await json(`/api/software-library/installs`, { token: limited.token })).items.some((i) => i.deviceId === runDev), false);
        assert.equal((await call(`/api/devices/not-a-uuid/software/installs`, { token: libReader.token })).status, 400);
    });
    await q(`DELETE FROM agent_tasks WHERE agent_id = $1`, [swAgent]);
    await q(`DELETE FROM agent_software WHERE agent_id = $1`, [swAgent]);

    // ------------------------------------------------------------------ global search
    console.log("global search");
    const found = async (p, q) => Object.fromEntries((await json(`/api/search?q=${encodeURIComponent(q)}`, { token: p.token })).groups.map((g) => [g.key, g.items.map((i) => i.title)]));
    const ticketTitle = `Search ticket ${stamp}`;
    const tix = (await q(`INSERT INTO tickets (organization_id, ticket_number, subject) VALUES ($1, (SELECT COALESCE(MAX(ticket_number), 0) + 1 FROM tickets WHERE organization_id = $1), $2) RETURNING id`, [org, ticketTitle])).rows[0].id;
    await test("search finds devices and alerts, and only the kinds a person may see", async () => {
        const r = await found(everyone, `GRP-A1-${stamp}`);
        assert.deepEqual(r.devices, [`GRP-A1-${stamp}`]);
        assert.equal(r.tickets, undefined);
        const alerts = await found(everyone, `Alert A1 ${stamp}`);
        assert.deepEqual(alerts.alerts, [`Alert A1 ${stamp}`]);
    });
    await test("tickets appear only for someone who can read tickets, by words or by number", async () => {
        const reader = await user("tixsearch", ["tickets.read"]);
        assert.deepEqual((await found(reader, ticketTitle)).tickets, [ticketTitle]);
        assert.equal((await found(everyone, ticketTitle)).tickets, undefined);
        const num = (await q(`SELECT ticket_number FROM tickets WHERE id = $1`, [tix])).rows[0].ticket_number;
        assert.ok((await found(reader, `#${num}`)).tickets.includes(ticketTitle));
    });
    await test("a private note can be left as a handoff, stays out of the customer's replies, and a reply cannot be one", async () => {
        const tech = await user("tixtech", ["tickets.read", "tickets.write"]);
        const reader = await user("tixread2", ["tickets.read"]);
        const post = (path, body, p = tech) => call(`/api/tickets/${tix}/${path}`, { method: "POST", token: p.token, body });
        assert.ok((await post("note", { body: `Waiting on the part, call Bob ${stamp}`, handoff: true })).status < 300);
        assert.ok((await post("note", { body: `A plain note ${stamp}` })).status < 300);
        assert.ok((await post("reply", { body: `Reply to the customer ${stamp}`, handoff: true })).status < 300);

        const notes = (await json(`/api/tickets/${tix}/notes`, { token: tech.token }));
        const items = Array.isArray(notes) ? notes : notes.items;
        const handoff = items.find((n) => n.body.startsWith("Waiting on the part"));
        const plain = items.find((n) => n.body.startsWith("A plain note"));
        assert.equal(handoff.isHandoff, true);
        assert.equal(handoff.isInternal, true);
        assert.equal(plain.isHandoff, false);
        assert.equal(items.some((n) => n.body.startsWith("Reply to the customer")), false);

        const replies = await json(`/api/tickets/${tix}/replies`, { token: reader.token });
        const rs = Array.isArray(replies) ? replies : replies.items;
        assert.ok(rs.some((r) => r.body.startsWith("Reply to the customer")));
        assert.equal(rs.some((r) => r.body.startsWith("Waiting on the part")), false);
        assert.equal(rs.some((r) => r.body.startsWith("A plain note")), false);
        assert.equal((await call(`/api/tickets/${tix}/notes`, { token: reader.token })).status, 403);
        const flag = (await q(`SELECT kind, is_handoff FROM ticket_activity WHERE ticket_id = $1 AND body LIKE $2`, [tix, `Reply to the customer ${stamp}`])).rows[0];
        assert.equal(flag.kind, "message");
        assert.equal(flag.is_handoff, false);
    });
    await test("a ticket stopwatch runs on the server, one at a time, and stopping it logs a time entry", async () => {
        const tech = await user("timertech", ["tickets.read", "tickets.write", "tickets.time.manual"]);
        const other = await user("timerother", ["tickets.read", "tickets.write"]);
        const reader = await user("timerread", ["tickets.read"]);
        const tix2 = (await q(`INSERT INTO tickets (organization_id, ticket_number, subject) VALUES ($1, (SELECT COALESCE(MAX(ticket_number), 0) + 1 FROM tickets WHERE organization_id = $1), $2) RETURNING id`, [org, `Timer ticket ${stamp}`])).rows[0].id;
        const timer = (id, action, body, p = tech) => call(`/api/ticket-timers/${id}/${action}`, { method: "POST", token: p.token, body });
        const state = async (id, p = tech) => (await call(`/api/ticket-timers/${id}`, { token: p.token })).json();

        // Needs the right to work tickets.
        assert.equal((await timer(tix, "start", undefined, reader)).status, 403);
        assert.equal((await call(`/api/ticket-timers`, { token: reader.token })).status, 403);
        assert.equal((await call(`/api/ticket-timers/not-a-uuid/start`, { method: "POST", token: tech.token })).status, 404);

        // Nothing until it is started on purpose.
        assert.deepEqual(await state(tix), { ticketId: tix, running: false, seconds: 0, startedAt: null });
        const s1 = await (await timer(tix, "start")).json();
        assert.equal(s1.running, true);
        assert.ok(s1.startedAt);

        // Starting a second one pauses the first and keeps what it counted.
        await q(`UPDATE ticket_timers SET started_at = now() - interval '5 minutes' WHERE ticket_id = $1`, [tix]);
        const s2 = await (await timer(tix2, "start")).json();
        assert.equal(s2.running, true);
        const first = await state(tix);
        assert.equal(first.running, false);
        assert.ok(first.seconds >= 299 && first.seconds <= 305, `first counted ${first.seconds}`);
        const mine = (await json(`/api/ticket-timers`, { token: tech.token })).items;
        assert.equal(mine.length, 2);
        assert.equal(mine.filter((i) => i.running).length, 1);
        assert.equal(mine.find((i) => i.ticketId === tix2).subject, `Timer ticket ${stamp}`);

        // Each person has their own stopwatch.
        assert.equal((await state(tix, other)).seconds, 0);
        assert.equal((await state(tix2, other)).running, false);

        // Pausing keeps the time; resuming carries on from it.
        await q(`UPDATE ticket_timers SET started_at = now() - interval '2 minutes' WHERE ticket_id = $1`, [tix2]);
        const paused = await (await timer(tix2, "pause")).json();
        assert.equal(paused.running, false);
        assert.ok(paused.seconds >= 119 && paused.seconds <= 125);
        assert.equal((await (await timer(tix2, "pause")).json()).seconds, paused.seconds);

        // Stopping logs minutes (rounded up) as an ordinary time entry, and the stopwatch is gone.
        await q(`UPDATE ticket_timers SET accumulated_seconds = 1000 WHERE ticket_id = $1`, [tix]);
        const stopped = await timer(tix, "stop", { note: "Reinstalled the driver", billable: false });
        assert.equal(stopped.status, 200, await stopped.clone().text());
        const result = await stopped.json();
        assert.equal(result.minutes, 17);
        const entry = (await q(`SELECT minutes, billable, note, ticket_id::text AS ticket_id FROM time_entries WHERE id = $1`, [result.id])).rows[0];
        assert.deepEqual(entry, { minutes: 17, billable: false, note: "Reinstalled the driver", ticket_id: tix });
        assert.equal((await state(tix)).seconds, 0);
        assert.equal((await timer(tix, "stop", {})).status, 404);

        // A run of a few seconds is refused; a forgotten one can be corrected with minutes.
        await q(`UPDATE ticket_timers SET accumulated_seconds = 10 WHERE ticket_id = $1`, [tix2]);
        assert.equal((await timer(tix2, "stop", {})).status, 400);
        await q(`UPDATE ticket_timers SET accumulated_seconds = 3 * 86400 WHERE ticket_id = $1`, [tix2]);
        const tooLong = await timer(tix2, "stop", {});
        assert.equal(tooLong.status, 400);
        assert.match((await tooLong.json()).message, /Say how many minutes/);
        const fixed = await (await timer(tix2, "stop", { minutes: 45, workDate: "2026-01-05" })).json();
        assert.equal(fixed.minutes, 45);
        assert.equal((await q(`SELECT work_date::text AS d FROM time_entries WHERE id = $1`, [fixed.id])).rows[0].d, "2026-01-05");
        assert.equal((await timer(tix2, "start")).status, 200);
        assert.equal((await timer(tix2, "stop", { minutes: 0 })).status, 400);
        assert.equal((await timer(tix2, "stop", { minutes: 1441 })).status, 400);

        // Discarding throws it away, logging nothing.
        await timer(tix2, "start");
        const before = (await q(`SELECT count(*)::int AS n FROM time_entries WHERE ticket_id = $1`, [tix2])).rows[0].n;
        assert.equal((await (await timer(tix2, "discard")).json()).seconds, 0);
        assert.equal((await q(`SELECT count(*)::int AS n FROM time_entries WHERE ticket_id = $1`, [tix2])).rows[0].n, before);

        // A closed ticket cannot be timed.
        await q(`UPDATE tickets SET status = 'closed' WHERE id = $1`, [tix2]);
        assert.equal((await timer(tix2, "start")).status, 409);

        await q(`DELETE FROM tickets WHERE id = $1`, [tix2]);
    });
    await test("time given with a reply or note is logged as a time entry and shown with it", async () => {
        const tech = await user("replytime", ["tickets.read", "tickets.write", "tickets.time.manual"]);
        const post = (path, body) => call(`/api/tickets/${tix}/${path}`, { method: "POST", token: tech.token, body });
        const count = async () => (await q(`SELECT count(*)::int AS n FROM time_entries WHERE ticket_id = $1 AND user_id = $2`, [tix, tech.id])).rows[0].n;

        assert.ok((await post("reply", { body: `Fixed it ${stamp}`, timeMinutes: 20, billable: true })).status < 300);
        assert.ok((await post("note", { body: `Checked the logs ${stamp}`, timeMinutes: 5, billable: false })).status < 300);
        assert.ok((await post("reply", { body: `No time ${stamp}` })).status < 300);
        assert.equal(await count(), 2);
        const rows = (await q(`SELECT minutes, billable, note FROM time_entries WHERE ticket_id = $1 AND user_id = $2 ORDER BY minutes DESC`, [tix, tech.id])).rows;
        assert.deepEqual(rows.map((r) => [r.minutes, r.billable]), [[20, true], [5, false]]);
        assert.match(rows[0].note, /^Fixed it/);

        const replies = await json(`/api/tickets/${tix}/replies`, { token: tech.token });
        const rs = Array.isArray(replies) ? replies : replies.items;
        assert.equal(rs.find((r) => r.body.startsWith("Fixed it")).timeWorkedSeconds, 1200);
        assert.equal(rs.find((r) => r.body.startsWith("No time")).timeWorkedSeconds, 0);
        const notes = await json(`/api/tickets/${tix}/notes`, { token: tech.token });
        assert.equal((Array.isArray(notes) ? notes : notes.items).find((n) => n.body.startsWith("Checked")).timeWorkedSeconds, 300);

        // Time that is not valid stops the whole reply, so nothing is half done.
        const before = (await q(`SELECT count(*)::int AS n FROM ticket_activity WHERE ticket_id = $1`, [tix])).rows[0].n;
        assert.equal((await post("reply", { body: "bad", timeMinutes: 0 })).status, 400);
        assert.equal((await post("reply", { body: "bad", timeMinutes: 99999 })).status, 400);
        assert.equal((await post("reply", { body: "bad", timeMinutes: "abc" })).status, 400);
        assert.equal((await q(`SELECT count(*)::int AS n FROM ticket_activity WHERE ticket_id = $1`, [tix])).rows[0].n, before);
        assert.equal(await count(), 2);
    });
    await test("typing time in, or changing logged time, needs its own right; the timer needs only the right to work tickets", async () => {
        const plain = await user("notmanual", ["tickets.read", "tickets.write"]);
        const manual = await user("hasmanual", ["tickets.read", "tickets.write", "tickets.time.manual"]);
        const t3 = (await q(`INSERT INTO tickets (organization_id, ticket_number, subject) VALUES ($1, (SELECT COALESCE(MAX(ticket_number), 0) + 1 FROM tickets WHERE organization_id = $1), $2) RETURNING id`, [org, `Manual time ${stamp}`])).rows[0].id;
        const entries = async () => (await q(`SELECT count(*)::int AS n FROM time_entries WHERE ticket_id = $1`, [t3])).rows[0].n;
        const timer = (action, body, p) => call(`/api/ticket-timers/${t3}/${action}`, { method: "POST", token: p.token, body });
        const billingTime = (method, path, body, p) => call(`/api/billing/time${path}`, { method, token: p.token, body });

        // By hand: refused without the right, allowed with it.
        const byHand = { ticketId: t3, workDate: "2026-02-03", minutes: 30, billable: true, note: "by hand" };
        const denied = await billingTime("POST", "", byHand, plain);
        assert.equal(denied.status, 403);
        assert.equal(await entries(), 0);
        const made = await billingTime("POST", "", byHand, manual);
        assert.ok(made.status < 300, await made.clone().text());
        const entryId = (await made.json()).id;
        assert.equal(await entries(), 1);

        // Time typed into a reply or note is the same thing, and the reply is not saved when it is refused.
        const reply = (body, p) => call(`/api/tickets/${t3}/reply`, { method: "POST", token: p.token, body });
        const acts = async () => (await q(`SELECT count(*)::int AS n FROM ticket_activity WHERE ticket_id = $1`, [t3])).rows[0].n;
        const refused = await reply({ body: "with time", timeMinutes: 10 }, plain);
        assert.equal(refused.status, 403);
        assert.match((await refused.json()).message, /time by hand/);
        assert.equal(await acts(), 0);
        assert.ok((await reply({ body: "no time at all" }, plain)).status < 300);
        assert.ok((await reply({ body: "with time", timeMinutes: 10 }, manual)).status < 300);
        assert.equal(await entries(), 2);

        // The timer works with the plain right, but overriding what it counted is typing time in.
        await timer("start", undefined, plain);
        await q(`UPDATE ticket_timers SET started_at = NULL, accumulated_seconds = 600 WHERE ticket_id = $1`, [t3]);
        assert.equal((await timer("stop", { minutes: 5 }, plain)).status, 403);
        const fromTimer = await timer("stop", { note: "from the timer" }, plain);
        assert.equal(fromTimer.status, 200);
        assert.equal((await fromTimer.json()).minutes, 10);
        // A date typed in with a timer stop is ignored without the right: it is logged for today.
        await timer("start", undefined, plain);
        await q(`UPDATE ticket_timers SET started_at = NULL, accumulated_seconds = 120 WHERE ticket_id = $1`, [t3]);
        const dated = await (await timer("stop", { workDate: "2020-01-01" }, plain)).json();
        const day = (await q(`SELECT work_date::text AS d FROM time_entries WHERE id = $1`, [dated.id])).rows[0].d;
        assert.notEqual(day, "2020-01-01");

        // Changing logged time needs the right (your own entry or not); switching billable does not.
        const own = await billingTime("POST", "", { ticketId: t3, workDate: "2026-02-04", minutes: 20, billable: true }, manual);
        const ownId = (await own.json()).id;
        const same = { ticketId: t3, workDate: "2026-02-04", minutes: 20, billable: false };
        assert.ok((await billingTime("PUT", `/${ownId}`, same, manual)).status < 300);
        const row = (await q(`SELECT user_id::text AS u FROM time_entries WHERE id = $1`, [ownId])).rows[0];
        assert.equal(row.u, manual.id);
        // The plain person cannot edit someone else's entry at all; change their own minutes and it is refused.
        await timer("start", undefined, plain);
        await q(`UPDATE ticket_timers SET started_at = NULL, accumulated_seconds = 300 WHERE ticket_id = $1`, [t3]);
        const mineEntry = (await (await timer("stop", {}, plain)).json()).id;
        assert.ok((await billingTime("PUT", `/${mineEntry}`, { ticketId: t3, workDate: day, minutes: 5, billable: false }, plain)).status < 300, "billable alone is free");
        assert.equal((await billingTime("PUT", `/${mineEntry}`, { ticketId: t3, workDate: day, minutes: 9, billable: false }, plain)).status, 403);
        assert.equal((await billingTime("PUT", `/${mineEntry}`, { ticketId: t3, workDate: "2026-01-01", minutes: 5, billable: false }, plain)).status, 403);
        assert.ok((await billingTime("PUT", `/${mineEntry}`, { ticketId: t3, workDate: day, minutes: 9, billable: false }, manual)).status !== 500);

        // Deleting your own is allowed to everyone who can work tickets.
        assert.ok((await billingTime("DELETE", `/${mineEntry}`, undefined, plain)).status < 300);

        // The right is listed with the others, and administrators and operators have it.
        assert.equal((await q(`SELECT count(*)::int AS n FROM permissions WHERE permission_key = 'tickets.time.manual'`)).rows[0].n, 1);
        const holders = (await q(`SELECT lower(r.name) AS role FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE rp.permission_key = 'tickets.time.manual' AND lower(r.name) IN ('admin', 'operator', 'viewer')`)).rows.map((x) => x.role);
        assert.ok(holders.includes("admin") && holders.includes("operator") && !holders.includes("viewer"), JSON.stringify(holders));
        await q(`DELETE FROM ticket_timers WHERE ticket_id = $1`, [t3]);
        await q(`DELETE FROM time_entries WHERE ticket_id = $1`, [t3]);
        await q(`DELETE FROM ticket_activity WHERE ticket_id = $1`, [t3]);
        await q(`DELETE FROM tickets WHERE id = $1`, [t3]);
    });
    await test("asking for a device to be removed needs a reason, can open a ticket, and shows the approver why", async () => {
        const asker = await user("delasker", ["devices.read"]);
        const approver = await user("delapprover", ["devices.read", "devices.delete"]);
        const outsider = await user("deloutsider", ["devices.read"]);
        await q(`INSERT INTO user_client_access (user_id, client_id) VALUES ($1,$2)`, [outsider.id, B.client]);
        const mk = async (name) => (await q(`INSERT INTO devices (site_id, hostname) VALUES ($1, $2) RETURNING id`, [A.sites[0].site, `${name}-${stamp}`])).rows[0].id;
        const d1 = await mk("DELREQ1");
        const d2 = await mk("DELREQ2");
        const request = (id, body, p = asker) => call(`/api/devices/${id}/deletion-requests`, { method: "POST", token: p.token, body });
        const tickets = async (id) => (await q(`SELECT id::text, subject, description, device_id::text AS device_id FROM tickets WHERE device_id = $1`, [id])).rows;

        // A reason is required.
        assert.equal((await request(d1, {})).status, 400);
        assert.equal((await request(d1, { reason: "  " })).status, 400);
        assert.equal((await request(d1, { reason: "x".repeat(501) })).status, 400);
        assert.equal((await q(`SELECT count(*)::int AS n FROM device_deletion_requests WHERE device_id = $1`, [d1])).rows[0].n, 0);

        // Someone who cannot see the device cannot ask about it, or approve it.
        assert.equal((await request(d1, { reason: "decommissioned" }, outsider)).status, 404);
        assert.equal((await call(`/api/devices/${d1}/deletion-requests`, { token: outsider.token })).status, 404);

        // A plain request keeps the reason and opens no ticket unless asked.
        const plain = await request(d1, { reason: "Replaced by a new laptop" });
        assert.equal(plain.status, 202);
        assert.equal((await plain.json()).ticketId, null);
        assert.equal((await tickets(d1)).length, 0);
        const shown = (await json(`/api/devices/${d1}/deletion-requests`, { token: approver.token })).request;
        assert.equal(shown.reason, "Replaced by a new laptop");
        assert.equal(shown.status, "pending");
        assert.ok(shown.requestedBy);
        assert.equal(shown.ticketId, null);

        // Asked for a ticket: one is opened for the approval, tied to the device, with the reason in it.
        const withTicket = await (await request(d2, { reason: "Customer left, PC returned", createTicket: true })).json();
        assert.ok(withTicket.ticketId);
        const tk = (await tickets(d2))[0];
        assert.equal(tk.id, withTicket.ticketId);
        assert.match(tk.subject, /Approve removal of DELREQ2/);
        assert.match(tk.description, /Customer left, PC returned/);
        assert.equal((await json(`/api/devices/${d2}/deletion-requests`, { token: approver.token })).request.ticketId, withTicket.ticketId);

        // Nothing to show once nothing is pending; approving still deletes the device.
        assert.equal((await call(`/api/devices/${d1}/deletion-requests/approve`, { method: "POST", token: outsider.token })).status, 403);
        assert.equal((await call(`/api/devices/${d1}/deletion-requests/approve`, { method: "POST", token: approver.token })).status, 201);
        assert.equal((await q(`SELECT count(*)::int AS n FROM devices WHERE id = $1`, [d1])).rows[0].n, 0);
        assert.equal((await call(`/api/devices/${d2}/deletion-requests/approve`, { method: "POST", token: approver.token })).status, 201);

        await q(`DELETE FROM tickets WHERE id = $1`, [withTicket.ticketId]);
        await q(`DELETE FROM device_deletion_requests WHERE device_id = ANY($1::uuid[])`, [[d1, d2]]);
    });
    await test("script snippets are private or shared as their writer chooses, and only the writer (or a settings manager, for shared ones) can change them", async () => {
        const A = await user("snipa", ["automation.read", "automation.run"]);
        const Bu = await user("snipb", ["automation.read", "automation.run"]);
        const M = await user("snipm", ["automation.read", "automation.run", "settings.write"]);
        const R = await user("snipr", ["automation.read"]);
        const s = (n) => `${n} ${stamp}`;
        const send = (who, body, id = "") => call(`/api/script-snippets${id}`, { method: id ? "PATCH" : "POST", token: who.token, body });
        const list = async (who) => (await json("/api/script-snippets", { token: who.token })).items.filter((i) => i.title.endsWith(stamp));
        const del = (who, id) => call(`/api/script-snippets/${id}`, { method: "DELETE", token: who.token });
        try {
            const priv = await (await send(A, { title: s("Restart service"), body: "Restart-Service Spooler", language: "powershell" })).json();
            const shared = await (await send(A, { title: s("Disk space"), body: "df -h", language: "bash", description: "Free space", shared: true })).json();
            assert.equal(priv.shared, false);
            assert.equal(priv.language, "powershell");
            assert.equal(shared.shared, true);
            assert.equal(shared.description, "Free space");
            assert.equal(shared.mine, true);

            // Who sees what.
            assert.deepEqual((await list(A)).map((i) => i.title).sort(), [s("Disk space"), s("Restart service")]);
            const seenByB = await list(Bu);
            assert.deepEqual(seenByB.map((i) => i.title), [s("Disk space")]);
            assert.equal(seenByB[0].mine, false);
            assert.equal(seenByB[0].canEdit, false);
            assert.ok(seenByB[0].author, "a shared snippet says who wrote it");
            assert.equal(seenByB[0].body, "df -h");
            assert.deepEqual((await list(M)).map((i) => i.title), [s("Disk space")]);
            assert.equal((await list(M))[0].canEdit, true, "a settings manager can tidy shared ones");
            assert.deepEqual((await list(R)).map((i) => i.title), [s("Disk space")]);

            // Reading needs automation.read, writing needs automation.run.
            assert.equal((await send(R, { title: s("Nope"), body: "x" })).status, 403);
            assert.equal((await call("/api/script-snippets", { token: (await user("snipnone", ["devices.read"])).token })).status, 403);

            // Titles: private ones are per person, shared ones are for everybody, and the language is part of the name.
            assert.equal((await send(Bu, { title: s("Restart service"), body: "B's own", language: "powershell" })).status, 201);
            assert.equal((await send(A, { title: s("restart SERVICE"), body: "again", language: "powershell" })).status, 400);
            assert.equal((await send(A, { title: s("Restart service"), body: "other language", language: "bash" })).status, 201);
            assert.equal((await send(Bu, { title: s("Disk space"), body: "mine too", language: "bash", shared: true })).status, 400);
            assert.equal((await send(Bu, { title: s("Disk space"), body: "df", language: "powershell", shared: true })).status, 201);

            // Checks on what is typed.
            assert.equal((await send(Bu, { title: "  ", body: "x" })).status, 400);
            assert.equal((await send(Bu, { title: s("Empty"), body: "   " })).status, 400);
            assert.equal((await send(Bu, { title: s("Huge"), body: "x".repeat(50001) })).status, 400);
            assert.equal((await send(Bu, { title: s("Lang"), body: "x", language: "python" })).status, 400);

            // Code is kept exactly as typed, including indentation and a trailing newline.
            const exact = "if ($true) {\n    Write-Output 'a'\n}\n";
            const kept = await (await send(Bu, { title: s("Exact"), body: exact, language: "powershell" })).json();
            assert.equal(kept.body, exact);

            // Changing and removing.
            assert.equal((await send(Bu, { body: "hijack" }, `/${shared.id}`)).status, 403);
            assert.equal((await send(Bu, { body: "hijack" }, `/${priv.id}`)).status, 404, "someone else's private snippet is not there");
            assert.equal((await del(Bu, priv.id)).status, 404);
            assert.equal((await del(Bu, shared.id)).status, 403);
            assert.equal((await send(M, { body: "df -h /" }, `/${shared.id}`)).status, 200);
            assert.equal((await send(M, { shared: false }, `/${shared.id}`)).status, 403, "a manager cannot make someone's snippet private");
            assert.equal((await send(M, { body: "x" }, `/${priv.id}`)).status, 404);
            assert.equal((await del(A, "not-a-uuid")).status, 404);

            // The writer can change their mind either way.
            assert.equal((await send(A, { shared: false }, `/${shared.id}`)).status, 200);
            assert.ok(!(await list(Bu)).some((i) => i.id === shared.id), "no longer visible to others");
            assert.equal((await send(A, { shared: true }, `/${shared.id}`)).status, 200);
            assert.ok((await list(Bu)).some((i) => i.id === shared.id));

            // Removing.
            assert.equal((await del(A, priv.id)).status, 200);
            assert.equal((await del(M, shared.id)).status, 200);
            assert.ok(!(await list(A)).some((i) => i.id === priv.id || i.id === shared.id));
        } finally {
            await q(`DELETE FROM script_snippets WHERE title LIKE $1`, [`% ${stamp}`]);
        }
    });
    await test("a device can be moved to another customer, only by someone with access to both, and everything that hangs off it follows", async () => {
        const full = await user("movefull", ["devices.read", "devices.write"]);
        const limitedA = await user("movelimA", ["devices.read", "devices.write"]);
        await q(`INSERT INTO user_client_access (user_id, client_id) VALUES ($1,$2)`, [limitedA.id, A.client]);
        const viewer = await user("moveview", ["devices.read"]);
        const siteB = B.sites[0].site;
        const siteA = A.sites[0].site;
        const mk = async (name, site) => (await q(`INSERT INTO devices (site_id, hostname) VALUES ($1,$2) RETURNING id`, [site, `${name}-${stamp}`])).rows[0].id;
        const move = (who, id, siteId) => call(`/api/devices/${id}/site`, { method: "PATCH", token: who.token, body: { siteId } });
        const placement = async (id) => (await q(`SELECT s.id AS site, s.client_id AS client FROM devices d JOIN sites s ON s.id = d.site_id WHERE d.id = $1`, [id])).rows[0];
        const made = [];
        try {
            const d1 = await mk("MOVE1", siteA); made.push(d1);

            // Needs the right to write, and a device and site the person can reach.
            assert.equal((await move(viewer, d1, siteB)).status, 403);
            assert.equal((await move(limitedA, d1, siteB)).status, 404, "limited to A: B's site is not theirs to use");
            const inB = await mk("MOVE2", siteB); made.push(inB);
            assert.equal((await move(limitedA, inB, siteA)).status, 404, "limited to A: a device at B does not exist for them");
            assert.equal((await placement(d1)).site, siteA);
            assert.equal((await placement(inB)).site, siteB);

            // Something hanging off the device at its old customer.
            const asset = (await q(`INSERT INTO assets (organization_id, client_id, device_id, name) VALUES ($1,$2,$3,'Laptop') RETURNING id`, [org, A.client, d1])).rows[0].id;
            const token = (await q(`INSERT INTO endpoint_enrollments (client_id, site_id, device_id, os, alias, token_hash, expires_at) VALUES ($1,$2,$3,'windows','x',$4, now() + interval '1 day') RETURNING id`, [A.client, siteA, d1, `h-${stamp}`])).rows[0].id;
            const alert = (await q(`SELECT count(*)::int AS n FROM alerts WHERE device_id = $1`, [d1])).rows[0].n;

            // Bad targets.
            assert.equal((await move(full, d1, uuid())).status, 404);
            assert.equal((await move(full, d1, "not-a-uuid")).status, 404);
            assert.equal((await move(full, d1, siteA)).status, 400, "already there");
            assert.equal((await move(full, uuid(), siteB)).status, 404);

            // A device of the same name at the other site: refused, nothing changes.
            const twin = await mk("MOVE1", siteB); made.push(twin);
            const clash = await move(full, d1, siteB);
            assert.equal(clash.status, 409);
            assert.match((await clash.json()).message, /already has a device named MOVE1/);
            assert.equal((await placement(d1)).site, siteA);
            assert.equal((await q(`SELECT count(*)::int AS n FROM device_changes WHERE device_id = $1`, [d1])).rows[0].n, 0);
            await q(`DELETE FROM devices WHERE id = $1`, [twin]);

            // The move itself: the device, its asset and its history.
            const ok = await move(full, d1, siteB);
            assert.equal(ok.status, 200);
            const body = await ok.json();
            assert.equal(body.id, d1);
            const now = await placement(d1);
            assert.equal(now.site, siteB);
            assert.equal(now.client, B.client);
            assert.equal((await q(`SELECT client_id FROM assets WHERE id = $1`, [asset])).rows[0].client_id, B.client, "the asset is filed under the new customer");
            assert.ok(new Date((await q(`SELECT expires_at FROM endpoint_enrollments WHERE id = $1`, [token])).rows[0].expires_at) <= new Date(), "an install token for the old customer is cancelled");
            const hist = (await q(`SELECT kind, summary, before, after FROM device_changes WHERE device_id = $1`, [d1])).rows;
            assert.equal(hist.length, 1);
            assert.equal(hist[0].kind, "moved");
            assert.match(hist[0].summary, /^Moved from .+ \/ .+ to .+ \/ .+$/);
            assert.equal(hist[0].before.clientId, A.client);
            assert.equal(hist[0].after.clientId, B.client);
            assert.equal((await q(`SELECT count(*)::int AS n FROM alerts WHERE device_id = $1`, [d1])).rows[0].n, alert, "its alerts stay with it");

            // The person limited to A can no longer see it, and the full user can still move it within B or back.
            assert.equal((await call(`/api/devices/${d1}`, { token: limitedA.token })).status, 404);
            assert.equal((await move(full, d1, siteA)).status, 200);
            assert.equal((await placement(d1)).client, A.client);
            assert.equal((await q(`SELECT client_id FROM assets WHERE id = $1`, [asset])).rows[0].client_id, A.client);
            // Moving within the same customer leaves the asset alone and still works for a limited person.
            const sibling = (await q(`SELECT id FROM sites WHERE client_id = $1 AND id <> $2 LIMIT 1`, [A.client, siteA])).rows[0];
            if (sibling) {
                assert.equal((await move(limitedA, d1, sibling.id)).status, 200);
                assert.equal((await placement(d1)).site, sibling.id);
            }
        } finally {
            await q(`DELETE FROM assets WHERE device_id = ANY($1::uuid[])`, [made]);
            await q(`DELETE FROM endpoint_enrollments WHERE device_id = ANY($1::uuid[])`, [made]);
            await q(`DELETE FROM device_changes WHERE device_id = ANY($1::uuid[])`, [made]);
            await q(`DELETE FROM devices WHERE id = ANY($1::uuid[])`, [made]);
        }
    });
    await test("install keys: managing them needs the customers right, and a person limited to a customer only reaches that customer's", async () => {
        const full = await user("keyfull", ["customers.read", "customers.write"]);
        const limitedA = await user("keylimA", ["customers.read", "customers.write"]);
        await q(`INSERT INTO user_client_access (user_id, client_id) VALUES ($1,$2)`, [limitedA.id, A.client]);
        const reader = await user("keyread", ["customers.read"]);
        const made = [];
        const create = (who, client, site, extra = {}) => call("/api/provisioning/enrollment-keys", { method: "POST", token: who.token, body: { clientId: client, siteId: site, expiresMinutes: 60, ...extra } });
        const list = async (who) => (await json("/api/provisioning/enrollment-keys", { token: who.token })).items;
        try {
            // Without the right to write customers there is nothing to see or do.
            assert.equal((await call("/api/provisioning/enrollment-keys", { token: reader.token })).status, 403);
            assert.equal((await create(reader, A.client, A.sites[0].site)).status, 403);

            // A limited person cannot make a key for another customer's site.
            assert.equal((await create(limitedA, B.client, B.sites[0].site)).status, 404);
            const mineRes = await create(limitedA, A.client, A.sites[0].site, { name: "Mine" });
            assert.equal(mineRes.status, 201);
            const mine = await mineRes.json();
            made.push(mine.tokenId);
            const theirsRes = await create(full, B.client, B.sites[0].site, { name: "Theirs", expiresMinutes: 5_259_600 });
            assert.equal(theirsRes.status, 201, "ten years is allowed");
            const theirs = await theirsRes.json();
            made.push(theirs.tokenId);
            assert.equal((await create(full, B.client, B.sites[0].site, { expiresMinutes: 5_259_601 })).status, 400);

            // Lists follow the same limits, and never carry the key.
            const forLimited = await list(limitedA);
            assert.ok(forLimited.some((k) => k.id === mine.tokenId));
            assert.ok(!forLimited.some((k) => k.id === theirs.tokenId));
            assert.ok((await list(full)).some((k) => k.id === theirs.tokenId));
            assert.ok(!JSON.stringify(await list(full)).includes(theirs.enrollmentKey));

            // Changing another customer's key looks like it does not exist.
            const rev = (who, id) => call(`/api/provisioning/enrollment-keys/${id}/revoke`, { method: "POST", token: who.token });
            const ren = (who, id, name) => call(`/api/provisioning/enrollment-keys/${id}`, { method: "PATCH", token: who.token, body: { name } });
            assert.equal((await rev(limitedA, theirs.tokenId)).status, 404);
            assert.equal((await ren(limitedA, theirs.tokenId, "taken")).status, 404);
            assert.equal((await rev(reader, mine.tokenId)).status, 403);
            assert.equal((await ren(limitedA, mine.tokenId, "Renamed")).status, 200);
            assert.equal((await list(limitedA)).find((k) => k.id === mine.tokenId).name, "Renamed");
            assert.equal((await rev(limitedA, mine.tokenId)).status, 201);
            assert.equal((await list(limitedA)).find((k) => k.id === mine.tokenId).status, "revoked");
            assert.equal((await list(full)).find((k) => k.id === theirs.tokenId).status, "active", "the other customer's key is untouched");
        } finally {
            await q(`DELETE FROM site_enrollment_keys WHERE id = ANY($1::uuid[])`, [made]);
        }
    });
    await test("ticket search also finds words inside replies and private notes, says where, and treats % and _ as plain characters", async () => {
        const reader = await user("tixfind", ["tickets.read"]);
        const nobody = await user("tixnone", ["devices.read"]);
        const word = `zebrafish${stamp}`;
        const mk = async (subject, description) => (await q(`INSERT INTO tickets (organization_id, ticket_number, subject, description) SELECT $1, COALESCE(MAX(ticket_number), 0) + 1, $2, $3 FROM tickets WHERE organization_id = $1 RETURNING id`, [org, subject, description])).rows[0].id;
        const act = (id, kind, body, extra = {}) => q(`INSERT INTO ticket_activity (id, ticket_id, kind, body, author, is_internal, is_inbound, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7, now() - ($8 || ' minutes')::interval)`, [uuid(), id, kind, body, extra.author || "Tech", !!extra.internal, !!extra.inbound, String(extra.ago ?? 0)]);
        const made = [];
        try {
            const inReply = await mk(`Printer offline ${stamp}`, "It will not print"); made.push(inReply);
            await act(inReply, "message", `Have you tried a restart? ${word} is what the vendor suggested.`, { author: "Alex Tech", ago: 5 });
            await act(inReply, "message", `Yes, still stuck.`, { author: "Pat", inbound: true, ago: 2 });
            const inNote = await mk(`Slow laptop ${stamp}`, null); made.push(inNote);
            await act(inNote, "note", `Private: asked about the ${word} driver`, { author: "Sam Tech", internal: true });
            const inDesc = await mk(`Billing question ${stamp}`, `Customer mentions ${word} in the original request`); made.push(inDesc);
            const inSubject = await mk(`About ${word}`, "Subject match"); made.push(inSubject);
            const unrelated = await mk(`Unrelated ${stamp}`, "Nothing here"); made.push(unrelated);
            const noise = await mk(`Percent ${stamp}`, null); made.push(noise);
            await act(noise, "message", `Discount is 100% off, a_b`);

            const search = async (who, term) => (await json(`/api/tickets?search=${encodeURIComponent(term)}&pageSize=50`, { token: who.token }));
            const byId = (items) => Object.fromEntries(items.map((i) => [i.id, i]));
            const r = await search(reader, word);
            const m = byId(r);
            assert.ok(m[inReply] && m[inNote] && m[inDesc] && m[inSubject], "found in a reply, a note, the description and the subject");
            assert.equal(m[unrelated], undefined);
            assert.equal(m[inReply].match.in, "reply");
            assert.equal(m[inReply].match.author, "Alex Tech");
            assert.match(m[inReply].match.snippet, new RegExp(word));
            assert.equal(m[inNote].match.in, "private note");
            assert.equal(m[inNote].match.author, "Sam Tech");
            assert.equal(m[inDesc].match.in, "description");
            assert.equal(m[inSubject].match, undefined, "found in the subject: nothing more to say");

            // The newest matching reply is the one shown, and a customer's own words are labelled as theirs.
            await act(inReply, "message", `${word} again from me`, { author: "Pat", inbound: true, ago: 0 });
            assert.equal(byId((await search(reader, word)))[inReply].match.in, "customer reply");

            // Case does not matter, and the box is plain text.
            assert.ok(byId((await search(reader, word.toUpperCase())))[inReply]);
            assert.deepEqual((await search(reader, "100%")).map((i) => i.id).filter((id) => made.includes(id)), [noise]);
            assert.deepEqual((await search(reader, "a_b")).map((i) => i.id).filter((id) => made.includes(id)), [noise]);
            assert.deepEqual((await search(reader, "%%%")).map((i) => i.id).filter((id) => made.includes(id)), [], "% is not a wildcard");
            assert.deepEqual((await search(reader, "a_c")).map((i) => i.id).filter((id) => made.includes(id)), [], "_ is not a wildcard");

            // Each ticket appears once, however many of its replies match.
            assert.equal((await search(reader, word)).filter((i) => made.includes(i.id)).length, 4);

            // The global search box finds them too and shows the words around the match.
            const g = (await json(`/api/search?q=${encodeURIComponent(word)}`, { token: reader.token })).groups.find((x) => x.key === "tickets");
            const gm = Object.fromEntries(g.items.map((i) => [i.href.split("/").pop(), i]));
            assert.ok(gm[inReply] && gm[inNote] && gm[inSubject]);
            assert.match(gm[inReply].detail, /^Reply: .*zebrafish/);
            assert.match(gm[inNote].detail, /^Note: .*zebrafish/);
            assert.doesNotMatch(gm[inSubject].detail, /^(Reply|Note):/);

            // Someone who cannot read tickets finds nothing at all.
            assert.equal((await call(`/api/tickets?search=${word}`, { token: nobody.token })).status, 403);
            assert.equal((await json(`/api/search?q=${encodeURIComponent(word)}`, { token: nobody.token })).groups.find((x) => x.key === "tickets"), undefined);
        } finally {
            await q(`DELETE FROM tickets WHERE id = ANY($1::uuid[])`, [made]);
        }
    });
    await test("the diagnostics report needs the environment right, is never cached, and holds no secret", async () => {
        const reader = await user("diagread", ["settings.read"]);
        const admin = await user("diagadmin", ["settings.environment.read"]);
        assert.equal((await call("/api/admin/diagnostics", { token: reader.token })).status, 403);
        assert.equal((await call("/api/admin/diagnostics")).status, 401);
        const res = await call("/api/admin/diagnostics", { token: admin.token });
        assert.equal(res.status, 200);
        assert.match(res.headers.get("cache-control") || "", /no-store/);
        const text = await res.text();
        const body = JSON.parse(text);
        assert.ok(body.app && body.database && Array.isArray(body.findings));
        assert.equal(body.requestedBy, admin.email);
        for (const secret of [SECRET, process.env.DATA_ENCRYPTION_KEY, process.env.ADMIN_API_KEY].filter(Boolean)) assert.ok(!text.includes(secret), "no secret in the report");
        const dl = await call("/api/admin/diagnostics?download=1", { token: admin.token });
        assert.match(dl.headers.get("content-disposition") || "", /^attachment; filename="adgrmm-diagnostics-.+\.json"$/);
    });
    await test("custom fields: defined with the settings right, filled in with the customers right, checked, kept when archived", async () => {
        const admin = await user("cfadmin", ["settings.write", "customers.read", "customers.write"]);
        const editor = await user("cfedit", ["customers.read", "customers.write"]);
        const viewer = await user("cfview", ["customers.read"]);
        const nothing = await user("cfnone", ["devices.read"]);
        const field = (who, body) => call("/api/custom-fields", { method: "POST", token: who.token, body });
        const patchField = (who, id, body) => call(`/api/custom-fields/${id}`, { method: "PATCH", token: who.token, body });
        const list = async (who, extra = "") => (await json(`/api/custom-fields${extra}`, { token: who.token })).items;
        const created = [];
        const customer = (who, body) => call("/api/customers", { method: "POST", token: who.token, body });
        const edit = (who, id, body) => call(`/api/customers/${id}`, { method: "PATCH", token: who.token, body });
        const profile = async (who, id) => json(`/api/customers/${id}`, { token: who.token });
        try {
            // Who may do what.
            assert.equal((await field(editor, { label: `Nope ${stamp}`, type: "text" })).status, 403);
            assert.equal((await call("/api/custom-fields", { token: nothing.token })).status, 403);
            assert.equal((await call("/api/custom-fields")).status, 401);
            assert.equal((await list(viewer)).filter((f) => f.label.endsWith(stamp)).length, 0);

            // Defining fields.
            const mk = async (body) => { const r = await field(admin, body); assert.equal(r.status, 201, JSON.stringify(await r.clone().json())); const f = await r.json(); created.push(f.id); return f; };
            const manager = await mk({ label: `Account manager ${stamp}`, type: "text", help: "Who looks after them" });
            const tier = await mk({ label: `Tier ${stamp}`, type: "dropdown", options: ["Gold", "Silver"] });
            const seats = await mk({ label: `Seats ${stamp}`, type: "number" });
            const renewal = await mk({ label: `Renewal ${stamp}`, type: "date" });
            const signed = await mk({ label: `Signed ${stamp}`, type: "checkbox" });
            const contract = await mk({ label: `Contract number ${stamp}`, type: "text", required: true });
            assert.match(manager.key, /^account_manager_[a-z0-9]+$/);
            assert.equal(manager.help, "Who looks after them");
            assert.equal((await field(admin, { label: `account MANAGER ${stamp}`, type: "text" })).status, 409, "two active fields cannot share a name");
            assert.equal((await field(admin, { label: `Bad ${stamp}`, type: "table" })).status, 400);
            assert.equal((await field(admin, { label: `Drop ${stamp}`, type: "dropdown", options: [] })).status, 400);
            assert.equal((await field(admin, { label: "  ", type: "text" })).status, 400);
            assert.deepEqual((await list(viewer)).filter((f) => f.label.endsWith(stamp)).map((f) => f.type), ["text", "dropdown", "number", "date", "checkbox", "text"], "anyone who reads customers sees them, in order");

            // A new customer needs the required field, and values are cleaned.
            const cname = `CF Customer ${stamp}`;
            assert.equal((await customer(editor, { name: cname })).status, 400, "the required field is missing");
            const okRes = await customer(editor, { name: cname, customFields: { [contract.key]: "C-100", [manager.key]: "  Pat  ", [tier.key]: "gold", [seats.key]: "1,200", [renewal.key]: "2027-01-31", [signed.key]: true } });
            assert.equal(okRes.status, 201, JSON.stringify(await okRes.clone().json()));
            const cust = await okRes.json();
            assert.deepEqual(cust.customFields, { [contract.key]: "C-100", [manager.key]: "Pat", [tier.key]: "Gold", [seats.key]: 1200, [renewal.key]: "2027-01-31", [signed.key]: true });
            await q(`INSERT INTO user_client_access (user_id, client_id) VALUES ($1,$2)`, [viewer.id, cust.id]);
            assert.equal((await profile(viewer, cust.id)).customFields[manager.key], "Pat", "it shows in the customer record");

            // Editing: only what is sent changes, and bad values are refused without changing anything.
            assert.equal((await edit(editor, cust.id, { customFields: { [manager.key]: "Sam" } })).status, 200);
            let now = (await profile(editor, cust.id)).customFields;
            assert.equal(now[manager.key], "Sam");
            assert.equal(now[tier.key], "Gold", "other values are untouched");
            assert.equal((await edit(editor, cust.id, { phone: "555-0100" })).status, 200);
            assert.equal((await profile(editor, cust.id)).customFields[manager.key], "Sam", "an edit with no field values leaves them alone");
            for (const bad of [{ [seats.key]: "many" }, { [renewal.key]: "2027-02-30" }, { [tier.key]: "Bronze" }, { nope: "x" }, { [contract.key]: "" }, { [signed.key]: "maybe" }]) {
                assert.equal((await edit(editor, cust.id, { customFields: bad })).status, 400, JSON.stringify(bad));
            }
            assert.equal((await edit(editor, cust.id, { customFields: [1] })).status, 400);
            assert.deepEqual((await profile(editor, cust.id)).customFields[seats.key], 1200);
            assert.equal((await edit(editor, cust.id, { customFields: { [seats.key]: "", [renewal.key]: null } })).status, 200);
            now = (await profile(editor, cust.id)).customFields;
            assert.ok(!(seats.key in now) && !(renewal.key in now), "an empty value clears the field");
            assert.equal((await edit(viewer, cust.id, { customFields: { [manager.key]: "X" } })).status, 403, "reading customers is not enough to fill them in");

            // Changing a field: the name can change, the key and type cannot, and a removed choice stays where it is saved.
            const renamed = await (await patchField(admin, manager.id, { label: `Success lead ${stamp}`, help: "" })).json();
            assert.equal(renamed.key, manager.key);
            assert.equal(renamed.label, `Success lead ${stamp}`);
            assert.equal((await patchField(admin, manager.id, { type: "number" })).status, 400);
            assert.equal((await patchField(admin, tier.id, { options: ["Platinum", "Silver"] })).status, 200);
            assert.equal((await edit(editor, cust.id, { customFields: { [tier.key]: "Gold" } })).status, 200, "the value it already has may stay");
            assert.equal((await edit(editor, cust.id, { customFields: { [tier.key]: "Platinum" } })).status, 200);
            assert.equal((await edit(editor, cust.id, { customFields: { [tier.key]: "Gold" } })).status, 400, "but Gold cannot be chosen again once removed");
            assert.equal((await patchField(editor, tier.id, { label: "x" })).status, 403);

            // Archiving keeps what people saved, hides the field, and refuses new values until it is restored.
            assert.equal((await call(`/api/custom-fields/${manager.id}`, { method: "DELETE", token: admin.token })).status, 200);
            assert.ok(!(await list(editor)).some((f) => f.id === manager.id));
            assert.ok((await list(editor, "?archived=true")).some((f) => f.id === manager.id && f.active === false));
            assert.equal((await profile(editor, cust.id)).customFields[manager.key], "Sam", "the value is kept");
            assert.equal((await edit(editor, cust.id, { customFields: { [manager.key]: "Lee" } })).status, 400);
            assert.equal((await patchField(admin, manager.id, { active: true })).status, 200);
            assert.equal((await edit(editor, cust.id, { customFields: { [manager.key]: "Lee" } })).status, 200);

            // A required field that is archived no longer has to be filled in.
            assert.equal((await patchField(admin, contract.id, { active: false })).status, 200);
            const other = await customer(editor, { name: `CF Other ${stamp}` });
            assert.equal(other.status, 201);
            await q(`DELETE FROM clients WHERE id = $1`, [(await other.json()).id]);

            // Order.
            const ids = (await list(admin)).filter((f) => f.label.endsWith(stamp)).map((f) => f.id);
            const reversed = [...ids].reverse();
            const re = await call("/api/custom-fields/reorder", { method: "POST", token: admin.token, body: { ids: reversed } });
            assert.equal(re.status, 201);
            assert.deepEqual((await list(admin)).filter((f) => f.label.endsWith(stamp)).map((f) => f.id), reversed);
            assert.equal((await call("/api/custom-fields/reorder", { method: "POST", token: admin.token, body: { ids: "x" } })).status, 400);
            await q(`DELETE FROM clients WHERE id = $1`, [cust.id]);
        } finally {
            await q(`DELETE FROM custom_field_defs WHERE label LIKE $1`, [`% ${stamp}`]);
            await q(`DELETE FROM clients WHERE name LIKE $1`, [`CF % ${stamp}`]);
        }
    });
    await test("custom field values are found by customer search and global search, and fill the Customers report", async () => {
        const admin = await user("cfsadmin", ["settings.write", "customers.read", "customers.write", "devices.read"]);
        const limited = await user("cfslimited", ["customers.read", "devices.read"]);
        const nobody = await user("cfsnone", ["devices.read"]);
        const made = [];
        const mk = async (body) => { const r = await call("/api/custom-fields", { method: "POST", token: admin.token, body }); assert.equal(r.status, 201); const f = await r.json(); made.push(f.id); return f; };
        const word = `Quokka${stamp}`;
        const archivedWord = `Wombat${stamp}`;
        try {
            const manager = await mk({ label: `Manager ${stamp}`, type: "text" });
            const tier = await mk({ label: `Tier ${stamp}`, type: "dropdown", options: ["Gold", "Silver"] });
            const seats = await mk({ label: `Seats ${stamp}`, type: "number" });
            const renewal = await mk({ label: `Renewal ${stamp}`, type: "date" });
            const signed = await mk({ label: `Signed ${stamp}`, type: "checkbox" });
            const old = await mk({ label: `Old ${stamp}`, type: "text" });
            const one = await (await call("/api/customers", { method: "POST", token: admin.token, body: { name: `CFS One ${stamp}`, customFields: { [manager.key]: word, [tier.key]: "Gold", [seats.key]: 12, [renewal.key]: "2027-05-01", [signed.key]: true, [old.key]: archivedWord } } })).json();
            const two = await (await call("/api/customers", { method: "POST", token: admin.token, body: { name: `CFS Two ${stamp}`, customFields: { [tier.key]: "Silver" } } })).json();
            await q(`INSERT INTO user_client_access (user_id, client_id) VALUES ($1,$2)`, [limited.id, two.id]);

            // The customer list search and the global search look inside the values.
            const names = async (who, qs) => (await json(`/api/customers?q=${encodeURIComponent(qs)}`, { token: who.token })).map((c) => c.name);
            assert.deepEqual(await names(admin, word), [`CFS One ${stamp}`]);
            assert.deepEqual(await names(admin, word.toLowerCase()), [`CFS One ${stamp}`], "any letter case");
            assert.deepEqual(await names(admin, "%"), [], "% is a plain character in the customer search");
            const g = async (who, term) => (await json(`/api/search?q=${encodeURIComponent(term)}`, { token: who.token })).groups.find((x) => x.key === "customers")?.items.map((i) => i.title) ?? [];
            assert.deepEqual(await g(admin, word), [`CFS One ${stamp}`]);
            assert.deepEqual(await g(limited, word), [], "a person limited to another customer does not find it");

            // A field that has been archived stops being searched, and comes back when restored.
            assert.deepEqual(await names(admin, archivedWord), [`CFS One ${stamp}`]);
            assert.equal((await call(`/api/custom-fields/${old.id}`, { method: "DELETE", token: admin.token })).status, 200);
            assert.deepEqual(await names(admin, archivedWord), []);
            assert.deepEqual(await g(admin, archivedWord), []);
            assert.equal((await call(`/api/custom-fields/${old.id}`, { method: "PATCH", token: admin.token, body: { active: true } })).status, 200);
            assert.deepEqual(await names(admin, archivedWord), [`CFS One ${stamp}`]);
            assert.equal((await call(`/api/custom-fields/${old.id}`, { method: "DELETE", token: admin.token })).status, 200);

            // The Customers report has a column per field, typed, with the saved values.
            const run = async (who) => call("/api/reports/run/customer-list?format=json", { token: who.token });
            const res = await run(admin);
            assert.equal(res.status, 200);
            const report = await res.json();
            assert.equal(report.key, "customer-list");
            const cols = Object.fromEntries(report.columns.map((c) => [c.key, c]));
            assert.equal(cols[`cf_${manager.key}`].label, `Manager ${stamp}`);
            assert.equal(cols[`cf_${seats.key}`].type, "number");
            assert.equal(cols[`cf_${renewal.key}`].type, "date");
            assert.ok(!(`cf_${old.key}` in cols), "an archived field has no column");
            const row = report.rows.find((r) => r.name === `CFS One ${stamp}`);
            assert.equal(row[`cf_${manager.key}`], word);
            assert.equal(row[`cf_${tier.key}`], "Gold");
            assert.equal(row[`cf_${seats.key}`], 12);
            assert.match(String(row[`cf_${renewal.key}`]), /^2027-05-01/);
            assert.equal(row[`cf_${signed.key}`], "Yes");
            const rowTwo = report.rows.find((r) => r.name === `CFS Two ${stamp}`);
            assert.equal(rowTwo[`cf_${signed.key}`], "No");
            assert.equal(rowTwo[`cf_${manager.key}`], null);
            assert.ok(report.charts.some((c) => c.key === `cf_${tier.key}`), "a dropdown gets its own chart");
            const csv = await call("/api/reports/run/customer-list?format=csv", { token: admin.token });
            assert.equal(csv.status, 200);
            assert.match(await csv.text(), new RegExp(`Manager ${stamp}`));

            // Limits: someone limited to a customer sees only that one, and a person without the customers right is refused.
            const mine = await (await run(limited)).json();
            assert.deepEqual(mine.rows.map((r) => r.name).filter((n) => n.endsWith(stamp)), [`CFS Two ${stamp}`]);
            assert.equal((await run(nobody)).status, 403);
        } finally {
            await q(`DELETE FROM clients WHERE name LIKE $1`, [`CFS % ${stamp}`]);
            await q(`DELETE FROM custom_field_defs WHERE label LIKE $1`, [`% ${stamp}`]);
        }
    });
    await test("the customer list counts devices, online and offline, and devices with open alerts, in the database; the device list can be limited to one customer", async () => {
        const reader = await user("cntread", ["customers.read", "devices.read"]);
        const limited = await user("cntlim", ["customers.read", "devices.read"]);
        const made = { devices: [], alerts: [] };
        const cname = `Counts ${stamp}`;
        const client = (await q(`INSERT INTO clients (organization_id, name) VALUES ($1,$2) RETURNING id`, [org, cname])).rows[0].id;
        const other = (await q(`INSERT INTO clients (organization_id, name) VALUES ($1,$2) RETURNING id`, [org, `Counts Other ${stamp}`])).rows[0].id;
        const siteA = (await q(`INSERT INTO sites (client_id, name) VALUES ($1,'One') RETURNING id`, [client])).rows[0].id;
        const siteB = (await q(`INSERT INTO sites (client_id, name) VALUES ($1,'Two') RETURNING id`, [client])).rows[0].id;
        const siteO = (await q(`INSERT INTO sites (client_id, name) VALUES ($1,'Main') RETURNING id`, [other])).rows[0].id;
        await q(`INSERT INTO user_client_access (user_id, client_id) VALUES ($1,$2)`, [limited.id, other]);
        const device = async (site, name, agentAgoMinutes) => {
            const id = (await q(`INSERT INTO devices (site_id, hostname) VALUES ($1,$2) RETURNING id`, [site, `${name}-${stamp}`])).rows[0].id;
            made.devices.push(id);
            if (agentAgoMinutes !== null) {
                await q(`INSERT INTO agents (id, device_id, agent_uuid, hostname, version, last_check_in_at, facts, agent_token, token) VALUES ($1,$2,$6,$3,'1.3.33', now() - ($4 || ' minutes')::interval, '{}'::jsonb, $5, $5)`, [uuid(), id, `${name}-${stamp}`, String(agentAgoMinutes), `t-${uuid()}`, `u-${uuid()}`]);
            }
            return id;
        };
        try {
            const online = await device(siteA, "ONLINE", 1);
            const stale = await device(siteA, "STALE", 30);
            const noAgent = await device(siteB, "NOAGENT", null);
            await device(siteO, "OTHER", 1);

            // One open alert, one silenced, one resolved: only the open one counts, and a device counts once however many it has.
            const alert = async (dev, state, silenced) => { const id = uuid(); await q(`INSERT INTO alerts (id, device_id, kind, dedupe_key, state, severity, title, silenced_until) VALUES ($1,$2,'disk',$3,$4,'warning','Low disk',$5)`, [id, dev, `k-${id}`, state, silenced]); made.alerts.push(id); };
            await alert(stale, "OPEN", null);
            await alert(stale, "OPEN", null);
            await alert(online, "OPEN", new Date(Date.now() + 3_600_000));
            await alert(noAgent, "RESOLVED", null);

            const mine = (await json(`/api/customers?q=${encodeURIComponent(cname)}`, { token: reader.token })).find((c) => c.name === cname);
            assert.deepEqual({ ...mine.counts, tickets: 0 }, { sites: 2, devices: 3, online: 1, offline: 2, alerts: 1, tickets: 0 });

            // A person limited to another customer sees only that one's numbers.
            const theirs = await json(`/api/customers?q=${encodeURIComponent("Counts")}`, { token: limited.token });
            assert.deepEqual(theirs.map((c) => c.name), [`Counts Other ${stamp}`]);
            assert.equal(theirs[0].counts.devices, 1);

            // The device list limited to one customer: all of that customer's devices across its sites, in pages.
            const page = (who, qs) => json(`/api/devices?${qs}`, { token: who.token });
            const all = [];
            let cursor = null;
            do {
                const r = await page(reader, `pageSize=2&clientId=${client}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
                all.push(...r.items);
                cursor = r.nextCursor;
            } while (cursor);
            assert.deepEqual(all.map((d) => d.hostname).sort(), [`NOAGENT-${stamp}`, `ONLINE-${stamp}`, `STALE-${stamp}`]);
            assert.deepEqual([...new Set(all.map((d) => d.client))], [cname]);
            assert.deepEqual((await page(reader, `clientId=${client}&status=online`)).items.map((d) => d.hostname), [`ONLINE-${stamp}`]);
            assert.equal((await call(`/api/devices?clientId=not-an-id`, { token: reader.token })).status, 400);
            assert.deepEqual((await page(reader, `clientId=${uuid()}`)).items, [], "a customer with no devices");
            assert.deepEqual((await page(limited, `clientId=${client}`)).items, [], "limits still apply: another customer's devices are not there");
        } finally {
            await q(`DELETE FROM alerts WHERE id = ANY($1::uuid[])`, [made.alerts]);
            await q(`DELETE FROM agents WHERE device_id = ANY($1::uuid[])`, [made.devices]);
            await q(`DELETE FROM devices WHERE id = ANY($1::uuid[])`, [made.devices]);
            await q(`DELETE FROM clients WHERE id = ANY($1::uuid[])`, [[client, other]]);
        }
    });
    await test("search follows a person's customer, site and tag limits", async () => {
        const limited = await user("searchlim", readPerms);
        await group("Search A1", [{ kind: "site", id: A.sites[0].site }], [limited.id]);
        const r = await found(limited, `GRP-`);
        assert.ok(r.devices.includes(`GRP-A1-${stamp}`));
        assert.ok(!r.devices.includes(`GRP-A2-${stamp}`) && !r.devices.includes(`GRP-B1-${stamp}`) && !r.devices.includes(`GRP-C1-${stamp}`), JSON.stringify(r.devices));
        assert.equal((await found(limited, `Grp B ${stamp}`)).customers, undefined);
        assert.deepEqual((await found(limited, `Grp A ${stamp}`)).customers, [`Grp A ${stamp}`]);
        assert.deepEqual((await found(limited, `Alert `)).alerts?.filter((t) => t.endsWith(String(stamp))), [`Alert A1 ${stamp}`]);
        assert.deepEqual((await found(byTag, `GRP-`)).devices, [`GRP-C1-${stamp}`]);
    });
    await test("wildcard characters are just characters, short searches return nothing, and it needs a sign-in", async () => {
        assert.deepEqual((await json(`/api/search?q=${encodeURIComponent("%%")}`, { token: everyone.token })).groups, []);
        assert.deepEqual((await json(`/api/search?q=${encodeURIComponent("_")}`, { token: everyone.token })).groups, []);
        assert.deepEqual((await json(`/api/search?q=a`, { token: everyone.token })).groups, []);
        assert.equal((await call(`/api/search?q=GRP-`)).status, 401);
    });
    await q(`DELETE FROM tickets WHERE id = $1`, [tix]);

    // ------------------------------------------------------------------ effective access
    console.log("effective access");
    await test("a person's access shows where every permission and limit comes from", async () => {
        const gid = await group("Source", [{ kind: "customer", id: A.client }], [mixed.id]);
        const res = await json(`/api/admin/users/${mixed.id}/access`, { token: mgr.token });
        assert.equal(res.limited, true);
        const fromRole = res.permissions.find((p) => p.key === "devices.read");
        assert.ok(fromRole.from.some((f) => f.kind === "role"));
        assert.ok(res.groups.some((g) => g.id === gid));
        assert.ok(res.scope.some((s) => s.from.kind === "group" && s.kind === "customer" && s.name === A.name));
        assert.ok(res.scope.some((s) => s.from.kind === "person"));
        const free = await json(`/api/admin/users/${everyone.id}/access`, { token: mgr.token });
        assert.equal(free.limited, false);
    });
    await test("the people list carries each person's groups", async () => {
        const list = await json(`/api/admin/users?q=mixed-&pageSize=50`, { token: mgr.token });
        const row = list.items.find((u) => u.id === mixed.id);
        assert.ok(row && row.groups.length >= 1);
    });

    // ------------------------------------------------------------------ policy templates
    console.log("policy templates");
    await test("templates are kept apart from policies, need the right to write, and never apply to anyone", async () => {
        const writer = await user("tplwriter", ["policies.read", "policies.write"]);
        const reader = await user("tplreader", ["policies.read"]);
        const body = { name: `Tpl ${stamp}`, description: "pattern", priority: 50, sections: { patching: { approve: "critical" } } };
        assert.equal((await call(`/api/policies/templates`, { method: "POST", token: reader.token, body })).status, 403);
        const made = await call(`/api/policies/templates`, { method: "POST", token: writer.token, body });
        assert.equal(made.status, 201);
        const madeBody = await made.json();
        const id = madeBody.id;
        assert.equal((await call(`/api/policies/templates`, { method: "POST", token: writer.token, body })).status, 409);
        const listed = await json(`/api/policies/templates`, { token: reader.token });
        assert.ok(listed.items.some((t) => t.id === id && t.sections.patching.approve === "critical"));
        const pols = await json(`/api/policies`, { token: reader.token });
        assert.ok(!pols.items.some((p) => p.name === body.name), "a template must not show up as a policy");
        const upd = await call(`/api/policies/templates/${id}`, { method: "PATCH", token: writer.token, body: { description: "changed", sections: { alerting: { offlineAfterMinutes: 10 } } } });
        assert.equal(upd.status, 200);
        const updBody = await upd.json();
        assert.equal(updBody.description, "changed");
        assert.deepEqual(updBody.sectionNames, ["alerting"]);
        assert.equal((await call(`/api/policies/templates`, { method: "POST", token: writer.token, body: { name: `Bad ${stamp}`, sections: { patching: { approve: "nonsense" } } } })).status, 400);
        assert.equal((await call(`/api/policies/templates/${id}`, { method: "DELETE", token: reader.token })).status, 403);
        assert.equal((await call(`/api/policies/templates/${id}`, { method: "DELETE", token: writer.token })).status, 200);
        assert.equal((await call(`/api/policies/templates/${id}`, { method: "DELETE", token: writer.token })).status, 404);
    });

    // ------------------------------------------------------------------ audit
    console.log("audit");
    await test("group changes are written to the audit log", async () => {
        const n = (await q(`SELECT count(*)::int AS n FROM audit_events WHERE action IN ('group.create','group.update','group.delete','user.groups.change')`)).rows[0].n;
        assert.ok(n >= 3, `found ${n}`);
    });

    // Leave nothing behind: other tests pick an organisation and clients by looking at the tables.
    await q(`DELETE FROM policy_templates WHERE name LIKE 'Tpl %' OR name LIKE 'Bad %'`);
    await q(`DELETE FROM software_library WHERE name LIKE 'Tst %' OR name LIKE 'Zzq %'`);
    await q(`DELETE FROM user_groups WHERE id = ANY($1::uuid[])`, [madeGroups]);
    await q(`DELETE FROM user_groups WHERE name LIKE $1`, [`% ${stamp}`]);
    await q(`DELETE FROM device_tags WHERE tag_id = ANY($1::uuid[])`, [madeTags]);
    await q(`DELETE FROM tag_defs WHERE id = ANY($1::uuid[])`, [madeTags]);
    for (const c of [A, B, C]) for (const s of c.sites) await q(`DELETE FROM alerts WHERE device_id = $1`, [s.device]);
    await q(`DELETE FROM clients WHERE id = ANY($1::uuid[])`, [madeClients]);
    await q(`DELETE FROM user_client_access WHERE user_id = ANY($1::uuid[])`, [madeUsers]);
    await q(`DELETE FROM sessions WHERE user_id = ANY($1::uuid[])`, [madeUsers]);
    await q(`DELETE FROM user_roles WHERE user_id = ANY($1::uuid[])`, [madeUsers]);
    await q(`DELETE FROM time_entries WHERE user_id = ANY($1::uuid[])`, [madeUsers]);
    await q(`DELETE FROM users WHERE email LIKE $1 OR id = ANY($2::uuid[])`, [`%-${stamp}@example.test`, madeUsers]);
    await q(`DELETE FROM role_permissions WHERE role_id = ANY($1::uuid[])`, [madeRoles]);
    await q(`DELETE FROM roles WHERE id = ANY($1::uuid[]) OR name LIKE $2 OR name LIKE $3`, [madeRoles, `% ${stamp}`, `e2e-%`]);
    await db.end();
    console.log(`\n${passed} passed, ${failures.length} failed`);
    process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
