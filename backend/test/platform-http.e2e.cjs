#!/usr/bin/env node
// Secrets status, System, Migrations, Feature flags, Compliance, the roles matrix's API and CSV import/export,
// behind the real sign-in and permission checks. Run against a throwaway backend and database only:
//
//   ADG_E2E_ALLOW=1 BASE_URL=http://127.0.0.1:3961 DATABASE_URL=postgres://.../adg_e2e JWT_SECRET=... node test/platform-http.e2e.cjs
//
// The server under test must have been started with the same JWT_SECRET, and with DATA_ENCRYPTION_KEY and
// JWT_SECRET set, which the secrets checks look for. SECRET_MARKERS lists text that must never appear in a response.
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { Client } = require("pg");
const jwt = require("jsonwebtoken");

const BASE = process.env.BASE_URL || "http://127.0.0.1:3961";
const DB_URL = process.env.DATABASE_URL || "";
const SECRET = process.env.JWT_SECRET || "";
const COOKIE = process.env.AUTH_COOKIE_NAME || "auth_token";
const SECRET_MARKERS = (process.env.SECRET_MARKERS || `${SECRET},groupb-test-data-key`).split(",").filter(Boolean);

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

function call(path, { method = "GET", token, body, csv, headers = {} } = {}) {
    return fetch(`${BASE}${path}`, {
        method,
        headers: { ...(body ? { "content-type": "application/json" } : {}), ...(csv !== undefined ? { "content-type": "text/csv" } : {}), ...(token ? { cookie: `${COOKIE}=${token}` } : {}), ...headers },
        body: csv !== undefined ? csv : body ? JSON.stringify(body) : undefined,
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

    async function user(label, permissions, { organizationId = org, roleName, twoFactor = null } = {}) {
        const id = uuid();
        const email = `${label}-${id}@example.test`;
        await q(`INSERT INTO users (id, organization_id, email, first_name, last_name, status, password_hash) VALUES ($1,$2,$3,'E2E',$4,'active','x')`, [id, organizationId, email, label]);
        const roleId = uuid();
        await q(`INSERT INTO roles (id, organization_id, scope, name) VALUES ($1,$2,'organization',$3)`, [roleId, organizationId, roleName ?? `e2e-${label}-${id}`]);
        await q(`INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)`, [id, roleId]);
        for (const p of permissions) await q(`INSERT INTO role_permissions (role_id, permission_key) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [roleId, p]);
        if (twoFactor !== null) await q(`INSERT INTO user_security (user_id, two_factor_enabled, totp_secret, recovery_codes) VALUES ($1,$2,'TOTPSECRETMARKER',ARRAY['RECOVERYMARKER'])`, [id, twoFactor]);
        const jti = uuid();
        await q(`INSERT INTO sessions (id, user_id, refresh_token) VALUES ($1,$2,$3)`, [jti, id, sha256(jti)]);
        return { id, email, roleId, token: jwt.sign({ sub: id, email, jti }, SECRET, { expiresIn: "1h" }) };
    }

    const ADMIN = ["admin.access", "settings.read", "settings.write", "settings.environment.read", "users.read", "customers.read", "customers.write", "devices.read", "tickets.read", "roles.read", "roles.write", "audit.read"];
    const admin = await user("admin", ADMIN);
    const nobody = await user("nobody", ["devices.read"]);
    const reader = await user("reader", ["admin.access", "settings.read", "users.read", "customers.read", "devices.read", "tickets.read", "roles.read"]);
    const stranger = await user("stranger", ADMIN, { organizationId: otherOrg });

    const auditCount = async (action) => Number((await q(`SELECT count(*)::int AS n FROM audit_events WHERE action = $1`, [action])).rows[0].n);

    /* ------------------------------ secrets, system, migrations ------------------------------ */
    console.log("secrets and environment");
    for (const path of ["/api/admin/secrets-status", "/api/admin/system", "/api/admin/migrations", "/api/admin/compliance", "/api/admin/flags"]) {
        await test(`GET ${path} needs a sign-in`, async () => assert.ok([401, 403].includes((await call(path)).status)));
        await test(`GET ${path} is closed to someone without the right`, async () => assert.equal((await call(path, { token: nobody.token })).status, 403));
    }
    await test("settings.read alone does not open the secrets, system or migrations pages", async () => {
        for (const p of ["/api/admin/secrets-status", "/api/admin/system", "/api/admin/migrations"]) assert.equal((await call(p, { token: reader.token })).status, 403, p);
    });
    let secrets;
    await test("the secrets page lists settings as set or not set, with a description, and is audited", async () => {
        const before = await auditCount("settings.secrets.view");
        const res = await call("/api/admin/secrets-status", { token: admin.token });
        assert.equal(res.status, 200);
        assert.match(res.headers.get("cache-control"), /no-store/);
        secrets = await res.json();
        assert.equal(secrets.readOnly, true);
        assert.ok(secrets.items.length > 80);
        const jwtItem = secrets.items.find((i) => i.key === "JWT_SECRET");
        assert.equal(jwtItem.set, true);
        assert.equal(jwtItem.secret, true);
        assert.ok(jwtItem.description.length > 20);
        assert.equal(secrets.items.find((i) => i.key === "ENROLLMENT_SECRET").set, false);
        assert.ok(secrets.items.every((i) => i.description && !/See the deployment documentation/.test(i.description)), "every setting has its own description");
        assert.equal(secrets.summary.total, secrets.items.length);
        assert.equal(await auditCount("settings.secrets.view"), before + 1);
    });
    await test("no value, whole or partial, is ever returned", async () => {
        const text = JSON.stringify(secrets);
        for (const marker of SECRET_MARKERS) assert.ok(!text.includes(marker), `a secret leaked: ${marker.slice(0, 6)}...`);
        for (const i of secrets.items) assert.deepEqual(Object.keys(i).sort(), ["attention", "category", "configuredIn", "description", "importance", "key", "restartRequired", "secret", "set"]);
        // A setting that is not a secret, and has a value here, must not show it either.
        assert.ok(!text.includes(String(process.env.PORT ?? "3961")) || !/"value"/.test(text));
        assert.ok(!/"value"/.test(text));
    });
    await test("the system page has the server, database, disk and how it was started", async () => {
        const s = await (await call("/api/admin/system", { token: admin.token })).json();
        assert.ok(s.app.node.startsWith("v"));
        assert.ok(s.app.uptimeSeconds >= 0);
        assert.match(s.database.version, /PostgreSQL/);
        assert.ok(s.database.sizeMb >= 0 && s.database.connections >= 1);
        assert.ok(Array.isArray(s.disk) && s.disk.length >= 1);
        assert.ok(["docker", "systemd", "manual"].includes(s.install.mode));
        const text = JSON.stringify(s);
        for (const marker of SECRET_MARKERS) assert.ok(!text.includes(marker));
    });
    await test("the migrations page lists what was applied and says none failed", async () => {
        const m = await (await call("/api/admin/migrations", { token: admin.token })).json();
        assert.equal(m.folderFound, true);
        assert.equal(m.summary.failed, 0);
        // Anything still waiting is a migration that is on disk but not yet applied to this database, which is what pending means.
        assert.ok(Array.isArray(m.pending) && !m.pending.includes("20261114030000_feature_flags"));
        assert.equal(m.summary.pending, m.pending.length);
        assert.ok(m.summary.applied >= 10);
        const flags = m.items.find((i) => i.name === "20261114030000_feature_flags");
        assert.equal(flags.state, "applied");
        assert.ok(flags.appliedAt);
        assert.equal(m.items[0].name >= m.items[m.items.length - 1].name, true, "newest first");
    });
    await test("an unfinished migration shows as failed and a missing one as pending", async () => {
        const name = `20261231235959_e2e_failed_${stamp}`;
        await q(`INSERT INTO _prisma_migrations (id, checksum, migration_name, started_at, applied_steps_count, logs) VALUES ($1,'x',$2,now(),0,$3)`, [uuid(), name, "Migration failed: boom\nmore"]);
        try {
            const m = await (await call("/api/admin/migrations", { token: admin.token })).json();
            assert.ok(m.failed.includes(name));
            assert.equal(m.items.find((i) => i.name === name).state, "failed");
            assert.equal(m.items.find((i) => i.name === name).error, "Migration failed: boom");
        } finally {
            await q(`DELETE FROM _prisma_migrations WHERE migration_name = $1`, [name]);
        }
        const hidden = await q(`SELECT id, checksum, migration_name, started_at, finished_at, applied_steps_count, logs FROM _prisma_migrations WHERE migration_name = '20261114030000_feature_flags'`);
        await q(`DELETE FROM _prisma_migrations WHERE migration_name = '20261114030000_feature_flags'`);
        try {
            const m = await (await call("/api/admin/migrations", { token: admin.token })).json();
            assert.ok(m.pending.includes("20261114030000_feature_flags"));
        } finally {
            const r = hidden.rows[0];
            await q(`INSERT INTO _prisma_migrations (id, checksum, migration_name, started_at, finished_at, applied_steps_count, logs) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [r.id, r.checksum, r.migration_name, r.started_at, r.finished_at, r.applied_steps_count, r.logs]);
        }
    });

    /* ------------------------------ feature flags ------------------------------ */
    console.log("feature flags");
    await test("anyone signed in can read what is on; nobody else can", async () => {
        assert.ok([401, 403].includes((await call("/api/flags")).status));
        const res = await call("/api/flags", { token: nobody.token });
        assert.equal(res.status, 200);
        const { flags } = await res.json();
        assert.equal(flags.demo_data, true, "the default is how the product behaved before the flag");
        assert.equal(flags.freshdesk_import, true);
    });
    await test("the admin list names every flag with what turning it off changes", async () => {
        const { items } = await (await call("/api/admin/flags", { token: reader.token })).json();
        assert.deepEqual(items.map((i) => i.key).sort(), ["demo_data", "freshdesk_import"]);
        for (const i of items) assert.ok(i.label && i.description && i.effect && typeof i.enabled === "boolean");
    });
    await test("changing a flag needs the right to manage settings, and says what is wrong", async () => {
        assert.equal((await call("/api/admin/flags/demo_data", { method: "PUT", token: reader.token, body: { enabled: false } })).status, 403);
        assert.equal((await call("/api/admin/flags/demo_data", { method: "PUT", token: admin.token, body: { enabled: "no" } })).status, 400);
        assert.equal((await call("/api/admin/flags/made_up", { method: "PUT", token: admin.token, body: { enabled: true } })).status, 404);
    });
    await test("turning demo data off is audited, blocks turning it on, and is per organization", async () => {
        const before = await auditCount("settings.flag.set");
        const res = await call("/api/admin/flags/demo_data", { method: "PUT", token: admin.token, body: { enabled: false } });
        assert.equal(res.status, 200, await res.clone().text());
        const flag = await res.json();
        assert.equal(flag.enabled, false);
        assert.equal(flag.changed, true);
        assert.equal(flag.updatedBy, admin.email);
        assert.equal(await auditCount("settings.flag.set"), before + 1);
        const ev = (await q(`SELECT details, actor_email FROM audit_events WHERE action = 'settings.flag.set' ORDER BY created_at DESC LIMIT 1`)).rows[0];
        assert.equal(ev.details.flag, "demo_data");
        assert.equal(ev.details.from, true);
        assert.equal(ev.details.to, false);
        assert.equal(ev.actor_email, admin.email);
        assert.equal((await (await call("/api/flags", { token: nobody.token })).json()).flags.demo_data, false);
        const blocked = await call("/api/admin/demo/enable", { method: "POST", token: admin.token });
        assert.equal(blocked.status, 403);
        assert.match((await blocked.json()).message, /turned off/);
        assert.equal((await (await call("/api/flags", { token: stranger.token })).json()).flags.demo_data, true, "another organization is not affected");
    });
    await test("turning the Freshdesk import off blocks a preview and a run, and back on lets them through to their own checks", async () => {
        await call("/api/admin/flags/freshdesk_import", { method: "PUT", token: admin.token, body: { enabled: false } });
        assert.equal((await call("/api/admin/import/freshdesk/preview", { method: "POST", token: admin.token, body: { domain: "x", apiKey: "y" } })).status, 403);
        assert.equal((await call(`/api/admin/import/jobs/${uuid()}/run`, { method: "POST", token: admin.token, body: {} })).status, 403);
        await call("/api/admin/flags/freshdesk_import", { method: "PUT", token: admin.token, body: { enabled: true } });
        const res = await call("/api/admin/import/freshdesk/preview", { method: "POST", token: admin.token, body: {} });
        assert.notEqual(res.status, 403, "no longer blocked by the flag");
    });
    await test("turning demo data back on removes the block", async () => {
        const res = await call("/api/admin/flags/demo_data", { method: "PUT", token: admin.token, body: { enabled: true } });
        assert.equal((await res.json()).changed, false, "back to the default");
        assert.equal((await (await call("/api/flags", { token: nobody.token })).json()).flags.demo_data, true);
    });

    /* ------------------------------ compliance ------------------------------ */
    console.log("compliance");
    const crowd = [];
    await test("posture items come from the organization's real users, and none claims a framework", async () => {
        // A fresh organization with three staff, one using two-factor, and an Owner without it.
        const o = await orgOf(`posture-${stamp}`, `Posture ${stamp}`);
        const viewer = await user("posture-admin", ["settings.read", "users.read"], { organizationId: o, twoFactor: true });
        crowd.push(await user("p-a", [], { organizationId: o, twoFactor: false }));
        crowd.push(await user("p-owner", [], { organizationId: o, roleName: "Owner", twoFactor: false }));
        const res = await call("/api/admin/compliance", { token: viewer.token });
        assert.equal(res.status, 200, await res.clone().text());
        const report = await res.json();
        const items = Object.fromEntries(report.sections.flatMap((s) => s.items).map((i) => [i.key, i]));
        assert.match(items.mfa_adoption.detail, /^1 of 3 active accounts \(33%\)/);
        assert.equal(items.mfa_adoption.status, "fail");
        assert.equal(items.owner_mfa.status, "fail");
        assert.equal(items.password_length.status, "warn", "the default of 8 is a warning");
        assert.equal(items.data_key.status, "pass");
        assert.equal(items.jwt_secret.status, "pass");
        assert.ok(["pass", "warn", "fail"].includes(items.audit_retention.status));
        assert.ok(items.backups, "backups are reported");
        assert.equal(report.summary.pass + report.summary.warn + report.summary.fail + report.summary.info, report.sections.flatMap((s) => s.items).length);
        assert.match(report.notice, /not an audit or certification/);
        const text = JSON.stringify(report);
        assert.ok(!/SOC ?2 (compliant|certified)|HIPAA (compliant|certified)/i.test(text));
        for (const marker of SECRET_MARKERS) assert.ok(!text.includes(marker));
        for (const i of Object.values(items)) if (i.link) assert.match(i.link.href, /^\//);
    });
    await test("viewing the posture is audited", async () => assert.ok((await auditCount("settings.compliance.view")) >= 1));
    await test("device findings come from what the agents reported", async () => {
        const cid = uuid(), sid = uuid(), d1 = uuid(), d2 = uuid(), d3 = uuid();
        await q(`INSERT INTO clients (id, organization_id, name) VALUES ($1,$2,$3)`, [cid, org, `Posture-${stamp}`]);
        await q(`INSERT INTO sites (id, client_id, name) VALUES ($1,$2,'HQ')`, [sid, cid]);
        const facts = (os, bitlocker, av, fw) => JSON.stringify({ device: { os: { name: os }, security: { bitLocker: bitlocker, antivirus: av, firewall: fw } } });
        const mk = async (id, host, os, f) => {
            await q(`INSERT INTO devices (id, site_id, hostname, operating_system) VALUES ($1,$2,$3,$4)`, [id, sid, host, os]);
            await q(`INSERT INTO agents (device_id, agent_uuid, version, facts) VALUES ($1,$2,'1.0.0',$3::jsonb)`, [id, `agent-${id}`, f]);
        };
        await mk(d1, `old-${stamp}`, "Microsoft Windows 7 Pro", facts("Microsoft Windows 7 Pro", [{ mount: "C:", protection: "off" }], [{ name: "Defender", state: "off", upToDate: false }], { domain: true, private: false, public: false }));
        await mk(d2, `new-${stamp}`, "Microsoft Windows 11 Pro", facts("Microsoft Windows 11 Pro", [{ mount: "C:", protection: "on" }], [{ name: "Defender", state: "on", upToDate: true }], { domain: true, private: true, public: true }));
        await mk(d3, `srv-${stamp}`, "Microsoft Windows Server 2012 R2 Standard", facts("Microsoft Windows Server 2012 R2 Standard", [{ mount: "C:", protection: "off" }], [], { domain: true, private: true, public: true }));
        const viewer = await user("posture-viewer", ["settings.read", "users.read"]);
        const report = await (await call("/api/admin/compliance", { token: viewer.token })).json();
        const items = Object.fromEntries(report.sections.flatMap((s) => s.items).map((i) => [i.key, i]));
        assert.notEqual(items.disk_encryption.status, "pass");
        assert.match(items.disk_encryption.detail, /unencrypted system drive/);
        assert.notEqual(items.firewall.status, "pass");
        assert.notEqual(items.unsupported_os.status, "pass");
        assert.match(items.unsupported_os.detail, /Windows 7/);
        assert.match(items.unsupported_os.detail, /Windows Server 2012 R2/);
        assert.ok(!/Windows 11/.test(items.unsupported_os.detail), "a current release is never called unsupported");
    });

    /* ------------------------------ roles matrix ------------------------------ */
    console.log("roles matrix");
    await test("the matrix reads roles and permission keys from the real roles API", async () => {
        const roles = await (await call("/api/roles", { token: reader.token })).json();
        assert.ok(Array.isArray(roles) && roles.length >= 4);
        assert.ok(roles.every((r) => Array.isArray(r.permissions)));
        const keys = await (await call("/api/roles/permission-keys", { token: reader.token })).json();
        assert.ok(keys.groups.length > 5 && keys.permissions.includes("customers.write"));
    });
    await test("a role is edited by sending its full list, and nobody can hand out what they lack", async () => {
        const holder = await user("matrix-editor", ["admin.access", "roles.read", "roles.write", "devices.read", "tickets.read"]);
        const target = uuid();
        await q(`INSERT INTO roles (id, organization_id, scope, name) VALUES ($1,$2,'organization',$3)`, [target, org, `matrix-target-${stamp}`]);
        await q(`INSERT INTO role_permissions (role_id, permission_key) VALUES ($1,'devices.read')`, [target]);
        const patch = (perms) => call(`/api/roles/${target}`, { method: "PATCH", token: holder.token, body: { permissions: perms } });
        assert.equal((await patch(["devices.read", "tickets.read"])).status, 200);
        const stored = async () => (await q(`SELECT permission_key FROM role_permissions WHERE role_id = $1 ORDER BY 1`, [target])).rows.map((r) => r.permission_key);
        assert.deepEqual(await stored(), ["devices.read", "tickets.read"]);
        const refused = await patch(["devices.read", "billing.write"]);
        assert.equal(refused.status, 403, "billing.write is not held by this person");
        assert.deepEqual(await stored(), ["devices.read", "tickets.read"], "nothing changed");
        // A role stronger than the editor is not theirs to edit either.
        await q(`INSERT INTO role_permissions (role_id, permission_key) VALUES ($1,'billing.write')`, [target]);
        assert.equal((await patch(["devices.read"])).status, 403);
    });
    await test("Owner always has everything and cannot be changed", async () => {
        const ownerRole = (await q(`SELECT id FROM roles WHERE lower(name) = 'owner' AND organization_id = $1`, [org])).rows[0].id;
        const res = await call(`/api/roles/${ownerRole}`, { method: "PATCH", token: admin.token, body: { permissions: ["devices.read"] } });
        assert.ok([400, 403].includes(res.status), String(res.status));
        const roles = await (await call("/api/roles", { token: admin.token })).json();
        const o = roles.find((r) => r.name.toLowerCase() === "owner");
        assert.ok(o.permissions.length > 20, "still holds everything it did");
    });

    /* ------------------------------ export ------------------------------ */
    console.log("export");
    const cA = uuid(), cB = uuid(), sA = uuid(), sB = uuid();
    const nameA = `ExpA-${stamp}`, nameB = `ExpB-${stamp}`;
    await q(`INSERT INTO clients (id, organization_id, name, email, phone) VALUES ($1,$2,$3,'a@exp.test','+1 555 0100'), ($4,$2,$5,'b@exp.test',NULL)`, [cA, org, nameA, cB, nameB]);
    await q(`INSERT INTO sites (id, client_id, name) VALUES ($1,$2,'A-HQ'), ($3,$4,'B-HQ')`, [sA, cA, sB, cB]);
    await q(`INSERT INTO customer_contacts (client_id, name, email, role) VALUES ($1,'Ann Export','ann@exp.test','primary')`, [cA]);
    const devA = uuid(), devB = uuid();
    await q(`INSERT INTO devices (id, site_id, hostname) VALUES ($1,$2,$3), ($4,$5,$6)`, [devA, sA, `host-a-${stamp}`, devB, sB, `host-b-${stamp}`]);
    const tn = BigInt(stamp) * 10n;
    await q(`INSERT INTO tickets (organization_id, ticket_number, subject, client_id, created_at) VALUES ($1,$2,'Printer on fire',$3,'2026-03-10T12:00:00Z'), ($1,$4,'Old ticket',$5,'2025-01-10T12:00:00Z')`, [org, String(tn + 1n), cA, String(tn + 2n), cB]);
    const text = async (res) => (await res.text()).replace(/^﻿/, "");

    for (const kind of ["customers", "sites", "contacts", "devices", "users", "tickets"]) {
        await test(`${kind} export needs a sign-in`, async () => assert.ok([401, 403].includes((await call(`/api/admin/data/export/${kind}`)).status)));
        await test(`${kind} export is closed to someone without the right to read it`, async () => assert.equal((await call(`/api/admin/data/export/${kind}`, { token: nobody.token })).status, 403));
    }
    await test("customers export is a CSV download with a byte order mark and the customers", async () => {
        const res = await call("/api/admin/data/export/customers", { token: admin.token });
        assert.equal(res.status, 200);
        assert.match(res.headers.get("content-type"), /text\/csv/);
        assert.match(res.headers.get("content-disposition"), /attachment; filename="customers-\d{4}-\d{2}-\d{2}\.csv"/);
        const bytes = Buffer.from(await res.arrayBuffer());
        assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], "a byte order mark, so Excel reads it as UTF-8");
        const body = bytes.toString("utf8").replace(/^﻿/, "");
        assert.match(body.split("\r\n")[0], /^"id","name","status"/);
        assert.ok(body.includes(nameA) && body.includes(nameB));
        assert.ok(body.includes(`"'+1 555 0100"`), "a phone number that starts with + is kept as text, not run as a formula");
    });
    await test("exports of sites, contacts and devices carry the customer names", async () => {
        assert.match(await text(await call("/api/admin/data/export/sites", { token: admin.token })), new RegExp(`"${nameA}","${cA}","${sA}","A-HQ"`));
        assert.match(await text(await call("/api/admin/data/export/contacts", { token: admin.token })), new RegExp(`"${nameA}","${cA}","Ann Export","","ann@exp.test"`));
        const d = await text(await call("/api/admin/data/export/devices", { token: admin.token }));
        assert.ok(d.includes(`host-a-${stamp}`) && d.includes(nameA) && d.includes("A-HQ"));
    });
    await test("the users export never holds a password hash, a two-factor secret or a recovery code", async () => {
        const body = await text(await call("/api/admin/data/export/users", { token: admin.token }));
        const header = body.split("\r\n")[0];
        assert.ok(!/password|hash|secret|totp|recovery|token/i.test(header), header);
        assert.ok(body.includes(admin.email));
        for (const marker of ["TOTPSECRETMARKER", "RECOVERYMARKER"]) assert.ok(!body.includes(marker));
        assert.ok(!body.includes('"x"'), "the stored hash (x) is not exported");
        assert.ok(!body.includes(stranger.email), "another organization's people are not exported");
    });
    await test("the tickets export honours a date range", async () => {
        const all = await text(await call("/api/admin/data/export/tickets", { token: admin.token }));
        assert.ok(all.includes("Printer on fire") && all.includes("Old ticket"));
        const r = await text(await call("/api/admin/data/export/tickets?from=2026-01-01&to=2026-12-31", { token: admin.token }));
        assert.ok(r.includes("Printer on fire") && !r.includes("Old ticket"));
        const single = await text(await call("/api/admin/data/export/tickets?from=2026-03-10&to=2026-03-10", { token: admin.token }));
        assert.ok(single.includes("Printer on fire"), "the end date includes the whole day");
        assert.equal((await call("/api/admin/data/export/tickets?from=nope", { token: admin.token })).status, 400);
    });
    await test("a person limited to one customer exports only that customer's records", async () => {
        const limited = await user("limited", ["admin.access", "customers.read", "customers.write", "devices.read", "tickets.read"]);
        await q(`INSERT INTO user_client_access (user_id, client_id) VALUES ($1,$2)`, [limited.id, cA]);
        const c = await text(await call("/api/admin/data/export/customers", { token: limited.token }));
        assert.ok(c.includes(nameA) && !c.includes(nameB));
        const s = await text(await call("/api/admin/data/export/sites", { token: limited.token }));
        assert.ok(s.includes("A-HQ") && !s.includes("B-HQ"));
        const d = await text(await call("/api/admin/data/export/devices", { token: limited.token }));
        assert.ok(d.includes(`host-a-${stamp}`) && !d.includes(`host-b-${stamp}`));
        const t = await text(await call("/api/admin/data/export/tickets", { token: limited.token }));
        assert.ok(t.includes("Printer on fire") && !t.includes("Old ticket"));
    });
    await test("exports are audited with the kind and the row count, not the data", async () => {
        const ev = (await q(`SELECT details FROM audit_events WHERE action = 'data.export' AND target_id = 'customers' AND actor_email = $1 ORDER BY created_at ASC LIMIT 1`, [admin.email])).rows[0];
        assert.ok(ev.details.rows >= 2, JSON.stringify(ev.details));
        assert.ok(!JSON.stringify(ev.details).includes(nameA));
    });
    await test("an export is streamed, so a large one does not wait for the whole table", async () => {
        // 3,000 more customers: the response must start arriving before the last page is read, and be complete.
        await q(`INSERT INTO clients (organization_id, name) SELECT $1, $2 || '-' || g FROM generate_series(1,3000) g`, [org, `Bulk-${stamp}`]);
        const res = await call("/api/admin/data/export/customers", { token: admin.token });
        const lines = (await res.text()).split("\r\n").filter((l) => l.includes(`Bulk-${stamp}`));
        assert.equal(lines.length, 3000);
        await q(`DELETE FROM clients WHERE name LIKE $1`, [`Bulk-${stamp}-%`]);
    });

    /* ------------------------------ import ------------------------------ */
    console.log("import");
    const imp = (kind, mode, csv, { token = admin.token, existing } = {}) => call(`/api/admin/data/import/${kind}?mode=${mode}${existing ? `&existing=${existing}` : ""}`, { method: "POST", token, csv });
    const impName = `Imp-${stamp}`;
    const count = async (sql, params) => Number((await q(sql, params)).rows[0].n);
    const customersNow = () => count(`SELECT count(*)::int AS n FROM clients WHERE name LIKE $1`, [`${impName}%`]);

    await test("importing needs a sign-in and the right to change customers", async () => {
        assert.ok([401, 403].includes((await imp("customers", "preview", "name\nx", { token: "" })).status));
        assert.equal((await imp("customers", "preview", "name\nx", { token: reader.token })).status, 403);
        assert.equal((await call("/api/admin/data/import/customers/template", { token: reader.token })).status, 403);
    });
    await test("the template is a CSV with the columns the import reads", async () => {
        const t = await text(await call("/api/admin/data/import/contacts/template", { token: admin.token }));
        assert.match(t.split("\r\n")[0], /^"customer","name"/);
    });
    await test("a bad request is refused plainly", async () => {
        assert.equal((await call("/api/admin/data/import/customers?mode=preview", { method: "POST", token: admin.token, body: { name: "x" } })).status, 415);
        assert.equal((await imp("customers", "go", "name\nx")).status, 400);
        assert.equal((await imp("planets", "preview", "name\nx")).status, 404);
        const noName = await imp("customers", "preview", "phone\n1");
        assert.equal(noName.status, 400);
        assert.match((await noName.json()).message, /needs a column named "name"/);
        assert.equal((await imp("customers", "preview", "name,name\nx,y")).status, 400);
        assert.equal((await imp("customers", "preview", 'name\n"unclosed')).status, 400);
    });
    await test("a file that is too big or has too many rows is refused", async () => {
        const huge = `name\n${"x".repeat(1024)}\n`.repeat(1) + "y".repeat(5 * 1024 * 1024 + 10);
        assert.equal((await imp("customers", "preview", huge)).status, 413);
        const rows = ["name", ...Array.from({ length: 5001 }, (_, i) => `r${i}`)].join("\n");
        const res = await imp("customers", "preview", rows);
        assert.equal(res.status, 400);
        assert.match((await res.json()).message, /more than 5000 rows/);
    });

    const file = [
        "name,status,email,phone,address_city,tags",
        `${impName}-One,active,ONE@Imp.test,+1 555 0111,Springfield,a; b`,
        `${impName}-Two,prospect,not-an-email,,,`,
        `${impName}-One,active,dup@imp.test,,,`,
        `,active,x@imp.test,,,`,
        `${impName}-Three,sleeping,,,,`,
        `${impName}-Four,inactive,,,,`,
    ].join("\r\n");
    await test("a preview says what each row would do and writes nothing", async () => {
        const res = await imp("customers", "preview", file);
        assert.equal(res.status, 200, await res.clone().text());
        const r = await res.json();
        assert.equal(r.mode, "preview");
        assert.deepEqual(r.summary, { rows: 6, create: 2, update: 0, skip: 0, error: 4 });
        const by = Object.fromEntries(r.rows.map((x) => [x.row, x]));
        assert.equal(by[2].action, "create");
        assert.match(by[3].message, /not a valid email address/);
        assert.match(by[4].message, /already in the file on line 2/);
        assert.match(by[5].message, /name is empty/);
        assert.match(by[6].message, /Status must be active, prospect or inactive/);
        assert.equal(by[7].action, "create");
        assert.equal(await customersNow(), 0, "nothing was written");
        assert.equal(await auditCount("data.import.preview") >= 1, true);
        assert.equal(await auditCount("data.import.create"), 0, "the generic route event is switched off, so each import is recorded once");
    });
    await test("apply does what the preview said, row by row, with the same checks", async () => {
        const res = await imp("customers", "apply", file);
        const r = await res.json();
        assert.equal(r.mode, "apply");
        assert.deepEqual(r.summary, { rows: 6, create: 2, update: 0, skip: 0, error: 4 });
        assert.equal(await customersNow(), 2);
        const one = (await q(`SELECT email, phone, address, tags, organization_id FROM clients WHERE name = $1`, [`${impName}-One`])).rows[0];
        assert.equal(one.email, "one@imp.test", "cleaned like the customer form cleans it");
        assert.equal(one.phone, "+1 555 0111");
        assert.equal(one.address.city, "Springfield");
        assert.deepEqual(one.tags, ["a", "b"]);
        assert.equal(one.organization_id, org);
        const ev = (await q(`SELECT details FROM audit_events WHERE action = 'data.import.apply' ORDER BY created_at DESC LIMIT 1`)).rows[0];
        assert.equal(ev.details.create, 2);
        assert.ok(!JSON.stringify(ev.details).includes(impName), "the audit holds counts, not the data");
    });
    await test("running it again skips what exists, or updates only what the row fills in", async () => {
        const skipped = await (await imp("customers", "preview", file.split("\r\n").slice(0, 2).join("\r\n"))).json();
        assert.equal(skipped.summary.skip, 1);
        const again = ["name,phone,notes,address_city", `${impName}-one,+1 555 0999,Imported note,`, `${impName}-Four,,,`].join("\r\n");
        const up = await (await imp("customers", "apply", again, { existing: "update" })).json();
        assert.deepEqual(up.summary, { rows: 2, create: 0, update: 1, skip: 1, error: 0 });
        const one = (await q(`SELECT phone, notes, address, name FROM clients WHERE lower(name) = lower($1)`, [`${impName}-One`])).rows[0];
        assert.equal(one.phone, "+1 555 0999");
        assert.equal(one.notes, "Imported note");
        assert.equal(one.address.city, "Springfield", "an empty cell does not erase what is stored");
        assert.equal(one.name, `${impName}-One`, "the name keeps its stored spelling");
    });
    await test("a spreadsheet formula survives an export and import without turning into one", async () => {
        const exported = await text(await call("/api/admin/data/export/customers", { token: admin.token }));
        const line = exported.split("\r\n").find((l) => l.includes(`${impName}-One`));
        assert.ok(line.includes(`"'+1 555 0999"`));
        const round = `${exported.split("\r\n")[0]}\r\n${line}`;
        const r = await (await imp("customers", "preview", round, { existing: "update" })).json();
        assert.equal(r.summary.error, 0, JSON.stringify(r.rows));
        await (await imp("customers", "apply", round, { existing: "update" })).json();
        assert.equal((await q(`SELECT phone FROM clients WHERE name = $1`, [`${impName}-One`])).rows[0].phone, "+1 555 0999");
    });
    await test("sites need an existing customer, and are matched by name within it", async () => {
        const sites = ["customer,name,address_city,phone", `${impName}-One,HQ,Springfield,+1 555 1`, `${impName}-One,HQ,Dup,`, `Nobody Inc ${stamp},Annex,,`, `${impName}-One,Annex,Shelbyville,`].join("\r\n");
        const p = await (await imp("sites", "preview", sites)).json();
        assert.deepEqual(p.summary, { rows: 4, create: 2, update: 0, skip: 0, error: 2 });
        assert.match(p.rows.find((x) => x.row === 4).message, /no customer called/);
        assert.equal(await count(`SELECT count(*)::int AS n FROM sites s JOIN clients c ON c.id = s.client_id WHERE c.name = $1`, [`${impName}-One`]), 0);
        const a = await (await imp("sites", "apply", sites)).json();
        assert.equal(a.summary.create, 2);
        assert.equal(await count(`SELECT count(*)::int AS n FROM sites s JOIN clients c ON c.id = s.client_id WHERE c.name = $1`, [`${impName}-One`]), 2);
        const again = await (await imp("sites", "preview", sites.split("\r\n").slice(0, 2).join("\r\n"))).json();
        assert.equal(again.summary.skip, 1);
    });
    await test("contacts are added, matched by email, and a main contact replaces the old one", async () => {
        const contacts = ["customer,name,email,role,is_primary,job_title", `${impName}-One,Casey Import,casey@imp.test,billing,yes,Bookkeeper`, `${impName}-One,Dana Import,,technical,no,`, `${impName}-One,Bad Role,bad@imp.test,wizard,,`].join("\r\n");
        const p = await (await imp("contacts", "preview", contacts)).json();
        assert.deepEqual(p.summary, { rows: 3, create: 2, update: 0, skip: 0, error: 1 });
        assert.match(p.rows.find((x) => x.row === 4).message, /role we do not know/);
        assert.equal(await count(`SELECT count(*)::int AS n FROM customer_contacts cc JOIN clients c ON c.id = cc.client_id WHERE c.name = $1`, [`${impName}-One`]), 0);
        await imp("contacts", "apply", contacts);
        const rows = (await q(`SELECT cc.name, cc.email, cc.is_primary, cc.role FROM customer_contacts cc JOIN clients c ON c.id = cc.client_id WHERE c.name = $1 ORDER BY cc.name`, [`${impName}-One`])).rows;
        assert.equal(rows.length, 2);
        assert.equal(rows.find((r) => r.name === "Casey Import").is_primary, true);
        // A second file: same email updates, a new main contact takes over, existing contacts are kept.
        const next = ["customer,name,email,is_primary", `${impName}-One,Kay Import,casey@imp.test,no`, `${impName}-One,Evan Import,evan@imp.test,yes`].join("\r\n");
        const skipPlan = await (await imp("contacts", "preview", next)).json();
        assert.deepEqual(skipPlan.summary, { rows: 2, create: 1, update: 0, skip: 1, error: 0 });
        const done = await (await imp("contacts", "apply", next, { existing: "update" })).json();
        assert.deepEqual(done.summary, { rows: 2, create: 1, update: 1, skip: 0, error: 0 });
        const after = (await q(`SELECT cc.name, cc.email, cc.is_primary FROM customer_contacts cc JOIN clients c ON c.id = cc.client_id WHERE c.name = $1 ORDER BY cc.name`, [`${impName}-One`])).rows;
        assert.equal(after.length, 3, "nobody was deleted");
        assert.equal(after.find((r) => r.email === "casey@imp.test").name, "Kay Import");
        assert.deepEqual(after.filter((r) => r.is_primary).map((r) => r.name), ["Evan Import"], "one main contact");
    });
    await test("a person limited to some customers can import for those only, and cannot import customers", async () => {
        const limited = await user("limited-imp", ["admin.access", "customers.read", "customers.write"]);
        const mine = (await q(`SELECT id FROM clients WHERE name = $1`, [`${impName}-One`])).rows[0].id;
        await q(`INSERT INTO user_client_access (user_id, client_id) VALUES ($1,$2)`, [limited.id, mine]);
        const refused = await imp("customers", "preview", "name\nNew Co", { token: limited.token });
        assert.equal(refused.status, 400);
        assert.match((await refused.json()).message, /cannot import customers/);
        const r = await (await imp("sites", "preview", ["customer,name", `${impName}-One,Limited site`, `${nameA},Not mine`].join("\n"), { token: limited.token })).json();
        assert.equal(r.summary.create, 1);
        assert.match(r.rows.find((x) => x.label.startsWith(nameA)).message, /that you may change/);
    });
    await test("the organization comes from the sign-in, so another organization's customers are never touched", async () => {
        const r = await (await imp("sites", "preview", `customer,name\n${impName}-One,Elsewhere`, { token: stranger.token })).json();
        assert.equal(r.summary.error, 1, "the stranger's organization has no such customer");
        const c = await (await imp("customers", "apply", `name\n${impName}-Other`, { token: stranger.token })).json();
        assert.equal(c.summary.create, 1);
        assert.equal((await q(`SELECT organization_id FROM clients WHERE name = $1`, [`${impName}-Other`])).rows[0].organization_id, otherOrg);
    });
    await test("an import is large-file safe: thousands of rows preview without writing", async () => {
        const rows = ["name", ...Array.from({ length: 5000 }, (_, i) => `${impName}-Big-${i}`)].join("\n");
        const t0 = Date.now();
        const r = await (await imp("customers", "preview", rows)).json();
        assert.equal(r.summary.create, 5000);
        assert.ok(r.rows.length <= 1000 && r.truncated === true, "the listing is capped, the counts are not");
        assert.equal(await count(`SELECT count(*)::int AS n FROM clients WHERE name LIKE $1`, [`${impName}-Big-%`]), 0);
        console.log(`        (5000-row preview took ${Date.now() - t0} ms)`);
    });

    await db.end();
    console.log(`\n${passed} passed, ${failures.length} failed`);
    if (failures.length) {
        console.log(failures.map((f) => ` - ${f}`).join("\n"));
        process.exit(1);
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
