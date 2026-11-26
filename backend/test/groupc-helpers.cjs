// Shared by the tests of the ticket custom fields, templates and integrations: a database handle, signed-in staff
// users with chosen rights, and a tiny HTTP caller. Throwaway backend and database only (the name must contain "e2e").
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

function runner() {
    let passed = 0;
    const failures = [];
    return {
        async test(name, fn) {
            try {
                await fn();
                passed++;
                console.log(`  ok    ${name}`);
            } catch (e) {
                failures.push(name);
                console.log(`  FAIL  ${name}\n        ${e?.message ?? e}`);
            }
        },
        finish() {
            console.log(`\n${passed} passed, ${failures.length} failed`);
            if (failures.length) {
                console.log(failures.map((f) => ` - ${f}`).join("\n"));
                process.exit(1);
            }
        },
    };
}

const call = (path, { method = "GET", token, portal, body, headers = {} } = {}) =>
    fetch(`${BASE}${path}`, {
        method,
        redirect: "manual",
        headers: {
            ...(body !== undefined ? { "content-type": "application/json" } : {}),
            cookie: [token ? `${COOKIE}=${token}` : "", portal ? `portal_token=${portal}` : ""].filter(Boolean).join("; "),
            ...headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
const json = async (path, opts) => (await call(path, opts)).json().catch(() => null);

async function setup() {
    const db = new Client({ connectionString: DB_URL });
    await db.connect();
    const q = (sql, params) => db.query(sql, params);
    const org = (await q(`INSERT INTO organizations (name, slug) VALUES ('Default Organization','default') ON CONFLICT (slug) DO UPDATE SET slug = EXCLUDED.slug RETURNING id`)).rows[0].id;
    const made = { users: [], roles: [], clients: [] };

    async function staffUser(label, permissions) {
        for (const k of permissions) await q(`INSERT INTO permissions (permission_key, label, group_key, group_label) VALUES ($1,$1,'x','x') ON CONFLICT DO NOTHING`, [k]);
        const id = uuid();
        made.users.push(id);
        const email = `${label}-${id}@example.test`;
        await q(`INSERT INTO users (id, organization_id, email, first_name, last_name, status, password_hash) VALUES ($1,$2,$3,'E2E',$4,'active','x')`, [id, org, email, label]);
        const role = uuid();
        made.roles.push(role);
        await q(`INSERT INTO roles (id, organization_id, scope, name) VALUES ($1,$2,'organization',$3)`, [role, org, `e2e-${label}-${id}`]);
        for (const p of permissions) await q(`INSERT INTO role_permissions (role_id, permission_key) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [role, p]);
        await q(`INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)`, [id, role]);
        const jti = uuid();
        await q(`INSERT INTO sessions (id, user_id, refresh_token) VALUES ($1,$2,$3)`, [jti, id, sha256(jti)]);
        return { id, email, token: jwt.sign({ sub: id, email, jti }, SECRET, { expiresIn: "1h" }) };
    }

    async function cleanup() {
        await q(`DELETE FROM tickets WHERE client_id = ANY($1::uuid[]) OR subject LIKE 'GC %'`, [made.clients]);
        await q(`DELETE FROM clients WHERE id = ANY($1::uuid[])`, [made.clients]);
        await q(`DELETE FROM user_roles WHERE user_id = ANY($1::uuid[])`, [made.users]);
        await q(`DELETE FROM sessions WHERE user_id = ANY($1::uuid[])`, [made.users]);
        await q(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [made.users]);
        await q(`DELETE FROM role_permissions WHERE role_id = ANY($1::uuid[])`, [made.roles]);
        await q(`DELETE FROM roles WHERE id = ANY($1::uuid[])`, [made.roles]);
        await db.end();
    }
    return { db, q, org, made, staffUser, cleanup };
}

module.exports = { assert, BASE, uuid, call, json, runner, setup, sha256 };
