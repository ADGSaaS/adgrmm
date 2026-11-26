#!/usr/bin/env node
// Compares two backend builds, each on its own throwaway database. Every step runs
// against both, then responses and the resulting rows must match.
//
//   node test/parity-batch5.e2e.cjs seed     (before the backends start)
//   node test/parity-batch5.e2e.cjs run      (once both are up)
//
// Required env: ADG_E2E_ALLOW=1, JWT_SECRET, BASE_A, BASE_B, DB_A, DB_B.
// It writes test rows, so it refuses any database whose name lacks "e2e".
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { Client } = require("pg");
const jwt = require("jsonwebtoken");

const { JWT_SECRET: SECRET, BASE_A, BASE_B, DB_A, DB_B } = process.env;
const COOKIE = process.env.AUTH_COOKIE_NAME || "auth_token";

const safe = (url) => {
    try {
        return /e2e/.test(new URL(url).pathname);
    } catch {
        return false;
    }
};
if (process.env.ADG_E2E_ALLOW !== "1" || !SECRET || !safe(DB_A) || !safe(DB_B)) {
    console.error("Refusing to run: set ADG_E2E_ALLOW=1, JWT_SECRET, and e2e-named DB_A and DB_B.");
    process.exit(2);
}

const ORG = "11111111-1111-4111-8111-111111111111";
const ADMIN = "22222222-2222-4222-8222-222222222222";
const VIEWER = "33333333-3333-4333-8333-333333333333";
const ADMIN_ROLE = "44444444-4444-4444-8444-444444444444";
const VIEWER_ROLE = "55555555-5555-4555-8555-555555555555";
const SESSION = {
    current: "66666666-6666-4666-8666-666666666666",
    active: "77777777-7777-4777-8777-777777777777",
    recentlyRevoked: "88888888-8888-4888-8888-888888888888",
    expiredRevoked: "99999999-9999-4999-8999-999999999999",
};

const READER = "a0000000-0000-4000-8000-000000000021";
const CANNED_READER = "a0000000-0000-4000-8000-000000000022";
const ORG2_ADMIN = "a0000000-0000-4000-8000-000000000023";
const ORG2 = "a0000000-0000-4000-8000-0000000000aa";
const CONTACT = "a0000000-0000-4000-8000-000000000031";
const CLIENT = "a0000000-0000-4000-8000-000000000003";
const SITE = "a0000000-0000-4000-8000-000000000004";
const DEVICE = "a0000000-0000-4000-8000-000000000001";
const MISSING = "a0000000-0000-4000-8000-000000000099";
const OTHER_TICKET = "a0000000-0000-4000-8000-000000000041";
const ALL_TICKET_PERMS = ["tickets.read", "tickets.write", "tickets.canned.read", "tickets.canned.write"];
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi;
// Generated ids differ between the databases; fixture ids are fixed and compared.
const isFixtureId = (s) => s.startsWith("a0000000-") || /^(.)\1{7}-/.test(s);

const token = (sub, jti) => jwt.sign({ sub, email: `${sub}@example.test`, jti }, SECRET, { expiresIn: "1h" });
const adminCookie = token(ADMIN, SESSION.current);
const viewerCookie = token(VIEWER, crypto.randomUUID());
const readerCookie = token(READER, crypto.randomUUID());
const cannedReaderCookie = token(CANNED_READER, crypto.randomUUID());
const org2Cookie = token(ORG2_ADMIN, crypto.randomUUID());

async function seedDb(db) {
    await db.query(`INSERT INTO organizations (id, name, slug) VALUES ($1,'Default Organization','default'), ($2,'Second','second')`, [ORG, ORG2]);
    const people = [
        [ADMIN, ORG, "admin", ALL_TICKET_PERMS, ADMIN_ROLE],
        [VIEWER, ORG, "viewer", ["devices.read"], VIEWER_ROLE],
        [READER, ORG, "reader", ["tickets.read"], "a0000000-0000-4000-8000-000000000051"],
        [CANNED_READER, ORG, "cannedreader", ["tickets.canned.read"], "a0000000-0000-4000-8000-000000000052"],
        [ORG2_ADMIN, ORG2, "org2admin", ALL_TICKET_PERMS, "a0000000-0000-4000-8000-000000000053"],
    ];
    for (const [id, org, name, perms, role] of people) {
        await db.query(
            `INSERT INTO users (id, organization_id, email, first_name, last_name, status, password_hash)
             VALUES ($1,$2,$3,'Parity',$4,'active','x')`,
            [id, org, `${name}@example.test`, name],
        );
        await db.query(`INSERT INTO roles (id, organization_id, scope, name) VALUES ($1,$2,'organization',$3)`, [role, org, `parity-${role}`]);
        await db.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)`, [id, role]);
        for (const perm of perms) {
            await db.query(`INSERT INTO role_permissions (role_id, permission_key) VALUES ($1,$2)`, [role, perm]);
        }
    }
    await db.query(`INSERT INTO clients (id, organization_id, name) VALUES ($1,$2,'Parity Client')`, [CLIENT, ORG]);
    await db.query(`INSERT INTO sites (id, client_id, name) VALUES ($1,$2,'Parity Site')`, [SITE, CLIENT]);
    await db.query(`INSERT INTO devices (id, site_id, hostname) VALUES ($1,$2,'ticketed')`, [DEVICE, SITE]);
    await db.query(`INSERT INTO contacts (id, organization_id, name, email) VALUES ($1,$2,'  Requester Rae ','Rae@Example.test')`, [CONTACT, ORG]);
    await db.query(`INSERT INTO sessions (id, user_id, refresh_token) VALUES ($1,$2,'x')`, [SESSION.current, ADMIN]);
    await db.query(
        `INSERT INTO tickets (id, organization_id, ticket_number, subject, description) VALUES ($1,$2,7,'Second org ticket','private')`,
        [OTHER_TICKET, ORG2],
    );
}

// Only clock-driven fields are volatile; due and closed dates are set by the test, so they are compared.
function normalize(value) {
    if (Array.isArray(value)) return value.map(normalize);
    if (value instanceof Date) return value.toISOString();
    if (value && typeof value === "object") {
        const out = {};
        for (const key of Object.keys(value).sort()) {
            const volatile =
                (/^(created_at|updated_at|createdAt|updatedAt|at)$/.test(key) ||
                    (key === "value" && String(value.key ?? "").startsWith("now."))) &&
                value[key] !== null;
            out[key] = volatile ? "<time>" : normalize(value[key]);
        }
        return out;
    }
    if (typeof value === "string") return value.replace(UUID, (m) => (isFixtureId(m) ? m : "<uuid>"));
    if (typeof value === "bigint") return String(value);
    return value;
}

// {name} in a path, body or SQL becomes the id captured from that build's earlier response.
const fill = (text, vars) => text.replace(/\{(\w+)\}/g, (m, name) => vars[name] ?? m);

async function request(base, { method = "GET", path, body, cookie = adminCookie, capture, files }, vars = {}) {
    let payload;
    const headers = { ...(cookie ? { cookie: `${COOKIE}=${cookie}` } : {}) };
    if (files) {
        payload = new FormData();
        for (const [name, text] of files) payload.append("files", new Blob([text]), name);
    } else if (body) {
        headers["content-type"] = "application/json";
        payload = fill(JSON.stringify(body), vars);
    }
    const res = await fetch(`${base}${fill(path, vars)}`, { method, headers, body: payload });
    const text = await res.text();
    let parsed = text;
    try {
        parsed = text ? JSON.parse(text) : null;
    } catch {
        /* keep text */
    }
    if (capture && parsed?.id) vars[capture] = parsed.id;
    return { status: res.status, body: normalize(parsed) };
}

const get = (path, cookie) => ({ path, cookie });
const post = (path, body) => ({ method: "POST", path, body });
const put = (path, body) => ({ method: "PUT", path, body });
const patch = (path, body) => ({ method: "PATCH", path, body });
const del = (path) => ({ method: "DELETE", path });

// A step is an HTTP request, or `sql` to put both databases in an unusual state first.
const T = "/api/tickets";
const A = "/api/admin/ticketing";
const as = (cookie, step) => ({ ...step, cookie });
const historyOf = (name) => [get(`${T}/{${name}}`), get(`${T}/{${name}}/history`)];
const setAge = (name, days) => ({ sql: `UPDATE tickets SET created_at = '2026-01-01 00:00:00+00'::timestamptz + interval '${days} days' WHERE id = '{${name}}'` });
const template = "Hi {{requester.name}} <{{ requester.email }}>: #{{ticket.number}} {{ticket.title}} [{{ticket.status}}/{{ticket.priority}}] due {{ticket.dueAt}} by {{assignee.name}}|{{assignee.email}} from {{company.name}}/{{company.legalName}}/{{company.country}} {{branding.primaryColor}} {{branding.logoUrl}} {{branding.emailFooter}} custom={{custom.Greeting}} var={{var.Greeting}} bare={{Greeting}} off={{custom.Disabled}} missing={{nope.nothing}}{{ nope }} id={{ticket.id}}/{{ticket.uuid}} {{ bad key }}";

const MODULES = {
    "tickets: permissions": {
        tables: [],
        steps: [
            get(T, null),
            get(`${T}/${OTHER_TICKET}`, null),
            get(`${A}/canned-responses`, null),
            get(`${A}/canned-variables`, null),
            get(`${T}/canned-responses`, null),
            as(null, post(T, { subject: "nope" })),
            as(null, post(`${A}/canned-responses`, { title: "x", body: "y" })),
            get(T, viewerCookie),
            as(viewerCookie, post(T, { subject: "nope" })),
            get(`${T}/canned-responses`, viewerCookie),
            get(`${A}/canned-responses`, viewerCookie),
            get(T, readerCookie),
            as(readerCookie, post(T, { subject: "nope" })),
            get(`${A}/canned-responses`, readerCookie),
            as(readerCookie, post(`${A}/canned-variables`, { key: "x", value: "y" })),
            get(`${A}/canned-responses`, cannedReaderCookie),
            get(`${A}/canned-variables`, cannedReaderCookie),
            as(cannedReaderCookie, post(`${A}/canned-responses`, { title: "x", body: "y" })),
            as(cannedReaderCookie, patch(`${A}/canned-variables/${MISSING}`, { value: "y" })),
            as(cannedReaderCookie, del(`${A}/canned-responses/${MISSING}`)),
        ],
    },
    "tickets: create": {
        tables: ["tickets"],
        steps: [
            { ...post(T, { subject: "  Printer on fire  " }), capture: "t1" },
            { ...post(T, { title: "Legacy title", description: "Paper jam 100% stuck_here", status: "in_progress", priority: "high", assigneeUserId: ADMIN, requesterContactId: CONTACT, deviceId: DEVICE }), capture: "t2" },
            { ...post(T, { subject: "email outage", description: "", status: "resolved", priority: "low" }), capture: "t3" },
            { ...post(T, { subject: "VPN down", description: "back\\slash", status: "closed", priority: "urgent" }), capture: "t4" },
            { ...post(T, { subject: "Medium one", priority: "medium" }), capture: "t5" },
            post(T, { subject: "Unknown field", nonsense: "x" }),
            { ...post(T, { subject: "wins over title", title: "ignored", assigneeUserId: null, description: null }), capture: "t6" },
            { ...post(T, { subject: "Into other org", organizationId: ORG2 }), capture: "o2" },
            { ...post(T, { subject: "Alias other org", customerId: ORG2 }), capture: "o3" },
            { ...post(T, { subject: "Uppercase org", organizationId: ORG2.toUpperCase() }), capture: "o4" },
            post(T, {}),
            post(T, { subject: "   " }),
            post(T, { subject: "x".repeat(301) }),
            post(T, { subject: "bad", status: "pending" }),
            post(T, { subject: "bad", status: "OPEN" }),
            post(T, { subject: "bad", priority: "normal" }),
            post(T, { subject: "bad", priority: "HIGH" }),
            post(T, { subject: 5 }),
            post(T, { subject: "bad", organizationId: "not-a-uuid" }),
            post(T, { subject: "bad", assigneeUserId: "not-a-uuid" }),
            post(T, { subject: "bad", organizationId: MISSING }),
            post(T, { subject: "bad", assigneeUserId: MISSING }),
            post(T, { subject: "bad", requesterContactId: MISSING }),
            post(T, { subject: "bad", deviceId: MISSING }),
            post(T, { subject: "nul \u0000 byte" }),
        ],
    },
    "tickets: list, search, sort, pagination": {
        tables: ["tickets"],
        steps: [
            setAge("t1", 5), setAge("t2", 4), setAge("t3", 3), setAge("t4", 2), setAge("t5", 1), setAge("t6", 0),
            get(T),
            get(T, readerCookie),
            get(T, org2Cookie),
            ...["open", "in_progress", "resolved", "closed", "pending", "OPEN"].map((v) => get(`${T}?status=${v}`)),
            ...["low", "medium", "high", "urgent", "normal", "HIGH"].map((v) => get(`${T}?priority=${v}`)),
            ...["printer", "PRINTER", "paper", "email", "%25", "_", "%5C", "stuck_here", "stuck%25here", "stuck%5C_here", "100%25", "%20printer%20", "%20%20%20", "", "no-such-thing", "'", "a0000000", "-4", "é"]
                .map((v) => get(`${T}?search=${v}`)),
            get(`${T}?search={t1}`),
            // Long enough that a random id cannot contain it.
            { sql: `UPDATE tickets SET ticket_number = 987654321987 WHERE id = '{t3}'` },
            get(`${T}?search=987654321987`),
            get(`${T}?search=654321987&status=resolved`),
            { sql: `UPDATE tickets SET ticket_number = 3 WHERE id = '{t3}'` },
            get(`${T}?search=%00`),
            get(`${T}?search=${"p".repeat(3000)}`),
            get(`${T}?search=e&status=open`),
            get(`${T}?search=e&status=open&priority=medium`),
            get(`${T}?search=e&priority=urgent&status=closed&pageSize=1`),
            get(`${T}?search=e&pageSize=2&page=2`),
            get(`${T}?search=e&pageSize=2&page=99`),
            get(`${T}?status=open&priority=medium&pageSize=1`),
            get(`${T}?pageSize=2`),
            get(`${T}?pageSize=2&page=2`),
            get(`${T}?pageSize=2&page=3`),
            get(`${T}?pageSize=2&page=99`),
            get(`${T}?pageSize=200`),
            get(`${T}?pageSize=201`),
            get(`${T}?pageSize=0`),
            get(`${T}?pageSize=abc`),
            get(`${T}?page=0`),
            get(`${T}?page=1.5`),
            get(`${T}?page=100000000&pageSize=200`),
            get(`${T}?page=100000000&pageSize=200&search=e`),
            get(`${T}?page=1000000000000000&pageSize=200`),
            get(`${T}?page=1000000000000000000000&pageSize=200`),
            get(`${T}?page=1000000000000000000000&pageSize=200&search=e`),
            get(`${T}?organizationId=${ORG2}`),
            get(`${T}?customerId=${ORG2}`),
            get(`${T}?organizationId=${ORG2}&search=other`),
            get(`${T}?organizationId=${ORG2.toUpperCase()}`),
            get(`${T}?organizationId=${ORG2.toUpperCase()}&search=other`),
            get(`${T}?organizationId=not-a-uuid`),
            get(`${T}?organizationId=${MISSING}`),
            // Equal created_at: the tie-break is whatever Postgres does, on both builds.
            { sql: `UPDATE tickets SET created_at = '2026-01-01 00:00:00+00' WHERE subject IN ('email outage','VPN down')` },
            { ...get(T), unordered: true },
            { ...get(`${T}?search=e`), unordered: true },
            setAge("t3", 3), setAge("t4", 2),
        ],
    },
    "tickets: detail": {
        tables: [],
        steps: [
            get(`${T}/{t1}`),
            get(`${T}/{t2}`, readerCookie),
            get(`${T}/{t3}`),
            get(`${T}/{t2}`, viewerCookie),
            get(`${T}/{t2}`, org2Cookie),
            get(`${T}/${OTHER_TICKET}`),
            get(`${T}/${OTHER_TICKET}`, org2Cookie),
            get(`${T}/${OTHER_TICKET.toUpperCase()}`, org2Cookie),
            get(`${T}/${MISSING}`),
            get(`${T}/not-a-uuid`),
            get(`${T}/%20`),
        ],
    },
    "tickets: update, status, assignee, history": {
        tables: ["tickets", "ticket_activity"],
        steps: [
            patch(`${T}/{t1}`, {}),
            ...historyOf("t1"),
            patch(`${T}/{t1}`, { status: "in_progress" }),
            ...historyOf("t1"),
            patch(`${T}/{t1}`, { status: "in_progress" }),
            ...historyOf("t1"),
            patch(`${T}/{t1}`, { assigneeUserId: ADMIN }),
            ...historyOf("t1"),
            patch(`${T}/{t1}`, { assigneeUserId: READER }),
            patch(`${T}/{t1}`, { assigneeUserId: null }),
            ...historyOf("t1"),
            // Every logged field at once, which pins the order of the history entries.
            patch(`${T}/{t1}`, { subject: " New subject ", status: "resolved", priority: "urgent", assigneeUserId: ADMIN, dueAt: "2027-03-04T05:06:07.890Z", closedAt: "2027-03-05T00:00:00Z", description: "changed", deviceId: DEVICE, requesterContactId: CONTACT }),
            ...historyOf("t1"),
            patch(`${T}/{t1}`, { subject: "Second round", status: "closed", priority: "low", assigneeUserId: READER, dueAt: "2027-04-04T05:06:07Z" }),
            ...historyOf("t1"),
            patch(`${T}/{t1}`, { title: "via title alias" }),
            patch(`${T}/{t1}`, { subject: null, title: "null subject falls back" }),
            patch(`${T}/{t1}`, { priority: "medium" }),
            ...historyOf("t1"),
            patch(`${T}/{t1}`, { description: null }),
            get(`${T}/{t1}`),
            patch(`${T}/{t1}`, { description: "" }),
            get(`${T}/{t1}`),
            ...["2027-01-02", "2027-01-02T03:04:05", "2027-01-02 03:04:05+02", "Jan 5 2027 10:00", "2027-01-02T03:04:05.123456Z", "1/2/2027"].flatMap((dueAt) => [
                patch(`${T}/{t2}`, { dueAt }),
                get(`${T}/{t2}`),
                get(`${T}/{t2}/history`),
            ]),
            patch(`${T}/{t2}`, { closedAt: "Feb 6 2027 11:00" }),
            get(`${T}/{t2}`),
            patch(`${T}/{t2}`, { dueAt: "garbage" }),
            patch(`${T}/{t2}`, { dueAt: "" }),
            patch(`${T}/{t2}`, { closedAt: "garbage", status: "closed" }),
            patch(`${T}/{t2}`, { dueAt: 5 }),
            patch(`${T}/{t2}`, { dueAt: null, closedAt: null }),
            ...historyOf("t2"),
            patch(`${T}/{t2}`, { subject: "   " }),
            patch(`${T}/{t2}`, { status: "pending" }),
            patch(`${T}/{t2}`, { status: null }),
            patch(`${T}/{t2}`, { priority: "normal" }),
            patch(`${T}/{t2}`, { priority: null }),
            patch(`${T}/{t2}`, { assigneeUserId: "not-a-uuid" }),
            patch(`${T}/{t2}`, { assigneeUserId: MISSING }),
            patch(`${T}/{t2}`, { requesterContactId: MISSING }),
            patch(`${T}/{t2}`, { deviceId: MISSING }),
            patch(`${T}/{t2}`, { organizationId: MISSING }),
            patch(`${T}/{t2}`, { organizationId: null, customerId: null }),
            patch(`${T}/{t2}`, { requesterContactId: null, deviceId: null }),
            ...historyOf("t2"),
            patch(`${T}/${MISSING}`, { status: "open" }),
            patch(`${T}/not-a-uuid`, { status: "open" }),
            patch(`${T}/${OTHER_TICKET}`, { status: "closed" }),
            patch(`${T}/${OTHER_TICKET.toUpperCase()}`, { status: "closed" }),
            as(viewerCookie, patch(`${T}/{t2}`, { status: "closed" })),
            as(readerCookie, patch(`${T}/{t2}`, { status: "closed" })),
            get(`${T}/${MISSING}/history`),
            get(`${T}/not-a-uuid/history`),
            get(`${T}/{t2}/history`, readerCookie),
            // Moving a ticket out of the org hides it from the "after" read, so nothing is logged.
            patch(`${T}/{t6}`, { organizationId: ORG2, status: "resolved" }),
            get(`${T}/{t6}`),
            as(org2Cookie, get(`${T}/{t6}/history`)),
            as(org2Cookie, patch(`${T}/{t6}`, { customerId: ORG })),
            get(`${T}/{t6}`),
            // A change row written before field columns were used falls back to its body.
            { sql: `INSERT INTO ticket_activity (id, ticket_id, kind, body, author, created_at) VALUES (gen_random_uuid(), '{t2}', 'change', 'old style body', 'Old', '2020-01-01 00:00:00+00')` },
            get(`${T}/{t2}/history`),
            // Only the newest 100 history rows come back.
            { sql: `INSERT INTO ticket_activity (id, ticket_id, kind, author, field, to_value, created_at) SELECT gen_random_uuid(), '{t5}', 'change', 'Bulk', 'status', n::text, '2020-01-01 00:00:00+00'::timestamptz + (n || ' minutes')::interval FROM generate_series(1,120) n` },
            get(`${T}/{t5}/history`),
        ],
    },
    "tickets: replies and notes": {
        tables: ["tickets", "ticket_activity"],
        steps: [
            get(`${T}/{t3}/replies`),
            get(`${T}/{t3}/activity`),
            get(`${T}/{t3}/notes`),
            post(`${T}/{t3}/reply`, { body: "  first reply  ", timeWorkedSeconds: 60, notifyCustomer: true, attachments: [{ id: "att-1", name: "a.txt", size: 3, url: "/static/a.txt", extra: { kept: [1, null] } }, { name: "no id size", size: "3", url: "/static/b.txt" }, { name: "no url" }, null, "text", 5] }),
            get(`${T}/{t3}/replies`),
            post(`${T}/{t3}/reply`, {}),
            post(`${T}/{t3}/reply`, { body: 123, attachments: "not-an-array", notifyCustomer: "yes" }),
            post(`${T}/{t3}/reply`, { body: "closing", submitAs: "reply_and_close" }),
            ...historyOf("t3"),
            post(`${T}/{t3}/reply`, { body: "resolving", submitAs: "reply_and_resolve" }),
            ...historyOf("t3"),
            post(`${T}/{t3}/reply`, { body: "unknown submit", submitAs: "whatever" }),
            get(`${T}/{t3}/replies`),
            get(`${T}/{t3}/activity`),
            get(`${T}/{t3}/replies`, readerCookie),
            post(`${T}/{t3}/note`, { body: " internal ", notifyCustomer: true, attachments: [{ name: "n.txt", url: "/static/n.txt" }], submitAs: "reply_and_close" }),
            post(`${T}/{t3}/note`, {}),
            get(`${T}/{t3}/notes`),
            get(`${T}/{t3}/notes`, readerCookie),
            get(`${T}/{t3}/replies`),
            as(readerCookie, post(`${T}/{t3}/reply`, { body: "x" })),
            as(readerCookie, post(`${T}/{t3}/note`, { body: "x" })),
            post(`${T}/${MISSING}/reply`, { body: "x" }),
            post(`${T}/${MISSING}/reply`, { body: "x", submitAs: "reply_and_close" }),
            post(`${T}/not-a-uuid/reply`, { body: "x" }),
            post(`${T}/not-a-uuid/note`, { body: "x" }),
            post(`${T}/${OTHER_TICKET}/note`, { body: "x" }),
            get(`${T}/${OTHER_TICKET}/replies`),
            get(`${T}/not-a-uuid/replies`),
            get(`${T}/not-a-uuid/notes`),
            post(`${T}/{t3}/note`, { body: "nul \u0000" }),
            // Non-array attachments stored by older versions read back as empty.
            { sql: `INSERT INTO ticket_activity (id, ticket_id, kind, body, attachments, author) VALUES (gen_random_uuid(), '{t4}', 'message', 'old', '{"a":1}', 'Old')` },
            get(`${T}/{t4}/replies`),
        ],
    },
    "tickets: linked": {
        tables: ["ticket_links"],
        steps: [
            get(`${T}/{t1}/linked`),
            post(`${T}/{t1}/linked`, { linkedId: "{t2}" }),
            get(`${T}/{t1}/linked`),
            get(`${T}/{t2}/linked`),
            post(`${T}/{t1}/linked`, { linkedId: "{t2}" }),
            post(`${T}/{t2}/linked`, { linkedId: "{t1}" }),
            post(`${T}/{t1}/linked`, { linkedId: " 3 " }),
            post(`${T}/{t1}/linked`, { linkedId: 4 }),
            get(`${T}/{t1}/linked`),
            get(`${T}/{t1}/linked`, readerCookie),
            post(`${T}/{t1}/linked`, { linkedId: "{t1}" }),
            post(`${T}/{t1}/linked`, { linkedId: "1" }),
            post(`${T}/{t1}/linked`, {}),
            post(`${T}/{t1}/linked`, { linkedId: "  " }),
            post(`${T}/{t1}/linked`, { linkedId: "abc" }),
            post(`${T}/{t1}/linked`, { linkedId: "-1" }),
            post(`${T}/{t1}/linked`, { linkedId: "0" }),
            post(`${T}/{t1}/linked`, { linkedId: "1.5" }),
            post(`${T}/{t1}/linked`, { linkedId: "999" }),
            post(`${T}/{t1}/linked`, { linkedId: "99999999999999999999" }),
            post(`${T}/{t1}/linked`, { linkedId: "9".repeat(400) }),
            post(`${T}/{t1}/linked`, { linkedId: MISSING }),
            post(`${T}/{t1}/linked`, { linkedId: OTHER_TICKET }),
            post(`${T}/{t1}/linked`, { linkedId: "A0000000-0000-4000-8000-000000000041" }),
            post(`${T}/${MISSING}/linked`, { linkedId: "{t2}" }),
            post(`${T}/not-a-uuid/linked`, { linkedId: "{t2}" }),
            post(`${T}/${OTHER_TICKET}/linked`, { linkedId: "{t2}" }),
            as(readerCookie, post(`${T}/{t1}/linked`, { linkedId: "{t5}" })),
            get(`${T}/${MISSING}/linked`),
            get(`${T}/not-a-uuid/linked`),
            // Order follows the linked ticket's age; a link that crosses orgs stays hidden.
            setAge("t2", 30),
            get(`${T}/{t1}/linked`),
            { sql: `INSERT INTO ticket_links (ticket_id, linked_ticket_id) VALUES ('{t1}', '${OTHER_TICKET}')` },
            get(`${T}/{t1}/linked`),
            // Two tickets in the other org link fine by number in that org.
            as(org2Cookie, post(`${T}/${OTHER_TICKET}/linked`, { linkedId: "8" })),
            as(org2Cookie, get(`${T}/${OTHER_TICKET}/linked`)),
        ],
    },
    "tickets: large ticket numbers": {
        tables: ["tickets", "ticket_links"],
        steps: [
            { sql: `UPDATE tickets SET ticket_number = 9007199254740993 WHERE id = '{t5}'` },
            get(`${T}/{t5}`),
            get(`${T}?pageSize=3`),
            get(`${T}?search=9007199254740993`),
            post(`${T}/{t4}/linked`, { linkedId: "9007199254740993" }),
            post(`${T}/{t4}/linked`, { linkedId: "9007199254740992" }),
            get(`${T}/{t4}/linked`),
            post(`${T}/{t4}/canned-render`, { template: "{{ticket.number}}" }),
            post(`${T}/{t5}/canned-render`, { template: "{{ticket.number}}" }),
            { ...post(T, { subject: "After a big number" }), capture: "big" },
            get(`${T}/{big}`),
            { sql: `UPDATE tickets SET ticket_number = 9223372036854775807 WHERE id = '{big}'` },
            get(`${T}/{big}`),
            post(T, { subject: "Past the bigint limit" }),
            { sql: `UPDATE tickets SET ticket_number = 100 WHERE id = '{big}'` },
            { sql: `UPDATE tickets SET ticket_number = 50 WHERE id = '{t5}'` },
        ],
    },
    "tickets: attachments": {
        tables: ["ticket_attachments"],
        steps: [
            { method: "POST", path: `${T}/{t1}/attachments`, files: [["one.txt", "1"], ["two.PNG", "22"], ["noext", "3"], ["weird.$$$", "4"]] },
            { method: "POST", path: `${T}/${MISSING}/attachments`, files: [["one.txt", "1"]] },
            { method: "POST", path: `${T}/{t1}/attachments` },
            { method: "POST", path: `${T}/{t1}/attachments`, files: Array.from({ length: 11 }, (_, i) => [`f${i}.txt`, "x"]) },
            { method: "POST", path: `${T}/{t1}/attachments`, files: [["one.txt", "1"]], cookie: readerCookie },
            { method: "POST", path: `${T}/{t1}/attachments`, files: [["one.txt", "1"]], cookie: null },
        ],
    },
    "canned responses (admin)": {
        tables: ["canned_responses"],
        steps: [
            get(`${A}/canned-responses`),
            { ...post(`${A}/canned-responses`, { title: " banana ", body: " Body B {{ticket.title}} " }), capture: "cb" },
            { ...post(`${A}/canned-responses`, { title: "Apple", body: "Body A", isActive: true }), capture: "ca" },
            { ...post(`${A}/canned-responses`, { title: "cherry", body: "Hidden", isActive: false }), capture: "cc" },
            { ...post(`${A}/canned-responses`, { title: "Zed", body: "Z", isActive: "no" }), capture: "cz" },
            { ...post(`${A}/canned-responses`, { title: "_under", body: "U", isActive: null }), capture: "cu" },
            { ...post(`${A}/canned-responses`, { title: "éclair", body: "E" }), capture: "ce" },
            { ...post(`${A}/canned-responses`, { title: "10 items", body: "N" }), capture: "cn" },
            { ...post(`${A}/canned-responses`, { title: "2 items", body: "N" }), capture: "cm" },
            get(`${A}/canned-responses`),
            get(`${A}/canned-responses`, cannedReaderCookie),
            get(`${T}/canned-responses`),
            get(`${T}/canned-responses`, readerCookie),
            // lower(title) is unique per org, which only the database's expression index knows.
            post(`${A}/canned-responses`, { title: "APPLE", body: "dup" }),
            post(`${A}/canned-responses`, { title: "  apple  ", body: "dup" }),
            as(org2Cookie, post(`${A}/canned-responses`, { title: "apple", body: "fine in another org" })),
            as(org2Cookie, get(`${A}/canned-responses`)),
            as(org2Cookie, get(`${T}/canned-responses`)),
            post(`${A}/canned-responses`, {}),
            post(`${A}/canned-responses`, { title: "   ", body: "x" }),
            post(`${A}/canned-responses`, { title: "x", body: "  " }),
            post(`${A}/canned-responses`, { title: "x".repeat(201), body: "x" }),
            post(`${A}/canned-responses`, { title: "x".repeat(200), body: "x".repeat(20001) }),
            { ...post(`${A}/canned-responses`, { title: "x".repeat(200), body: "x".repeat(20000) }), capture: "cl" },
            post(`${A}/canned-responses`, { title: "nul \u0000", body: "x" }),
            post(`${A}/canned-responses`, { title: 12, body: 34 }),
            patch(`${A}/canned-responses/{ca}`, {}),
            patch(`${A}/canned-responses/${MISSING}`, {}),
            patch(`${A}/canned-responses/not-a-uuid`, {}),
            patch(`${A}/canned-responses/{ca}`, { title: " Apricot ", body: " New ", isActive: 0 }),
            get(`${A}/canned-responses`),
            get(`${T}/canned-responses`),
            patch(`${A}/canned-responses/{ca}`, { isActive: "yes" }),
            patch(`${A}/canned-responses/{ca}`, { title: "BANANA" }),
            patch(`${A}/canned-responses/{ca}`, { title: "apricot" }),
            patch(`${A}/canned-responses/{ca}`, { title: "  " }),
            patch(`${A}/canned-responses/{ca}`, { title: "x".repeat(201) }),
            patch(`${A}/canned-responses/{ca}`, { body: "  " }),
            patch(`${A}/canned-responses/{ca}`, { body: "x".repeat(20001) }),
            patch(`${A}/canned-responses/${MISSING}`, { title: "ghost" }),
            patch(`${A}/canned-responses/not-a-uuid`, { title: "ghost" }),
            patch(`${A}/canned-responses/{ca}`, { title: "Apricot2" }),
            as(org2Cookie, patch(`${A}/canned-responses/{cb}`, { title: "theft" })),
            as(org2Cookie, del(`${A}/canned-responses/{cb}`)),
            del(`${A}/canned-responses/{cz}`),
            del(`${A}/canned-responses/{cz}`),
            del(`${A}/canned-responses/${MISSING}`),
            del(`${A}/canned-responses/not-a-uuid`),
            get(`${A}/canned-responses`),
        ],
    },
    "canned variables (admin and agent)": {
        tables: ["canned_variables"],
        steps: [
            get(`${A}/canned-variables`),
            get(`${T}/canned-variables`),
            { ...post(`${A}/canned-variables`, { key: " Greeting ", value: " Hello there " }), capture: "vg" },
            { ...post(`${A}/canned-variables`, { key: "alpha", value: "A", isActive: true }), capture: "va" },
            { ...post(`${A}/canned-variables`, { key: "Disabled", value: "hidden", isActive: false }), capture: "vd" },
            { ...post(`${A}/canned-variables`, { key: "zeta_x-1", value: "Z", isActive: "no" }), capture: "vz" },
            get(`${A}/canned-variables`),
            get(`${A}/canned-variables`, cannedReaderCookie),
            get(`${T}/canned-variables`),
            get(`${T}/canned-variables`, readerCookie),
            get(`${T}/canned-variables`, viewerCookie),
            post(`${A}/canned-variables`, { key: "GREETING", value: "dup" }),
            as(org2Cookie, post(`${A}/canned-variables`, { key: "greeting", value: "other org" })),
            as(org2Cookie, get(`${T}/canned-variables`)),
            post(`${A}/canned-variables`, {}),
            post(`${A}/canned-variables`, { key: "x", value: "  " }),
            post(`${A}/canned-variables`, { key: "1bad", value: "x" }),
            post(`${A}/canned-variables`, { key: "has.dot", value: "x" }),
            post(`${A}/canned-variables`, { key: "k".repeat(81), value: "x" }),
            post(`${A}/canned-variables`, { key: "big", value: "x".repeat(20001) }),
            post(`${A}/canned-variables`, { key: "nul", value: "\u0000" }),
            patch(`${A}/canned-variables/{va}`, {}),
            patch(`${A}/canned-variables/not-a-uuid`, {}),
            patch(`${A}/canned-variables/{va}`, { key: "beta", value: " B ", isActive: 1 }),
            get(`${A}/canned-variables`),
            patch(`${A}/canned-variables/{va}`, { key: "greeting" }),
            patch(`${A}/canned-variables/{va}`, { key: "BETA" }),
            patch(`${A}/canned-variables/{va}`, { key: "9" }),
            patch(`${A}/canned-variables/{va}`, { value: "  " }),
            patch(`${A}/canned-variables/{va}`, { value: "x".repeat(20001) }),
            patch(`${A}/canned-variables/${MISSING}`, { value: "x" }),
            patch(`${A}/canned-variables/not-a-uuid`, { value: "x" }),
            as(org2Cookie, patch(`${A}/canned-variables/{vg}`, { value: "theft" })),
            as(org2Cookie, del(`${A}/canned-variables/{vg}`)),
            del(`${A}/canned-variables/{vz}`),
            del(`${A}/canned-variables/{vz}`),
            del(`${A}/canned-variables/${MISSING}`),
            del(`${A}/canned-variables/not-a-uuid`),
            get(`${A}/canned-variables`),
            get(`${T}/canned-variables`),
        ],
    },
    "canned render": {
        tables: ["tickets"],
        steps: [
            // No company or branding rows yet, then real ones.
            { sql: `DELETE FROM company_profile` },
            { sql: `DELETE FROM branding_settings` },
            post(`${T}/{t2}/canned-render`, { template }),
            get(`${T}/{t2}/canned-variables`),
            { sql: `INSERT INTO company_profile (id, name, legal_name, email, phone, fax, website, vat_tin, address1, address2, city, state, postal, country) VALUES (1,' Acme ','Acme LLC','hi@acme.example','555','556','https://acme.example','VAT1','1 Main','Ste 2','Town','OH','45000',NULL)` },
            { sql: `INSERT INTO branding_settings (id, primary_color, secondary_color, logo_light_url, logo_dark_url, email_header, email_footer) VALUES (1,'#112233','#fff',NULL,'https://x.example/d.svg','<b>h</b>',' <i>f</i> ')` },
            post(`${T}/{t2}/canned-render`, { template }),
            get(`${T}/{t2}/canned-variables`),
            { sql: `UPDATE branding_settings SET logo_light_url='https://x.example/l.svg'` },
            // Assigned, with a requester and a due date.
            patch(`${T}/{t2}`, { assigneeUserId: ADMIN, requesterContactId: CONTACT, dueAt: "2027-07-08T09:10:11Z", status: "in_progress", priority: "medium" }),
            post(`${T}/{t2}/canned-render`, { template }),
            get(`${T}/{t2}/canned-variables`),
            get(`${T}/{t2}/canned-variables`, readerCookie),
            post(`${T}/{t2}/canned-render`, {}),
            post(`${T}/{t2}/canned-render`, { template: 5 }),
            post(`${T}/{t2}/canned-render`, { template: "plain {{ }} {{nope}} {not}" }),
            as(readerCookie, post(`${T}/{t2}/canned-render`, { template: "{{Greeting}}" })),
            as(viewerCookie, post(`${T}/{t2}/canned-render`, { template: "{{Greeting}}" })),
            as(org2Cookie, post(`${T}/{t2}/canned-render`, { template: "{{Greeting}}" })),
            as(org2Cookie, post(`${T}/${OTHER_TICKET}/canned-render`, { template: "{{custom.greeting}} {{Greeting}} {{ticket.number}}" })),
            as(org2Cookie, get(`${T}/${OTHER_TICKET}/canned-variables`)),
            post(`${T}/${MISSING}/canned-render`, { template: "x" }),
            post(`${T}/not-a-uuid/canned-render`, { template: "x" }),
            post(`${T}/${OTHER_TICKET.toUpperCase()}/canned-render`, { template: "x" }),
            get(`${T}/${MISSING}/canned-variables`),
            get(`${T}/not-a-uuid/canned-variables`),
            // A variable named like a preset does not overwrite it, and turning one off removes it.
            { sql: `INSERT INTO canned_variables (id, organization_id, key, value) VALUES (gen_random_uuid(), '${ORG}', 'dotted.key', 'dv'), (gen_random_uuid(), '${ORG}', 'ticket', 'tv')` },
            post(`${T}/{t2}/canned-render`, { template: "{{custom.dotted.key}} {{var.dotted.key}} {{dotted.key}} {{ticket}}" }),
            patch(`${A}/canned-variables/{vg}`, { isActive: false }),
            post(`${T}/{t2}/canned-render`, { template: "[{{Greeting}}][{{custom.Greeting}}]" }),
            get(`${T}/canned-variables`),
            // The contact lookup can miss only if the row goes away.
            { sql: `UPDATE tickets SET requester_contact_id = NULL WHERE id = '{t2}'` },
            post(`${T}/{t2}/canned-render`, { template: "[{{requester.name}}][{{requester.email}}]" }),
            { sql: `DELETE FROM company_profile` },
            { sql: `DELETE FROM branding_settings` },
            post(`${T}/{t2}/canned-render`, { template: "[{{company.name}}][{{branding.logoUrl}}]" }),
        ],
    },
};

async function rows(db, table) {
    const { rows: found } = await db.query(`SELECT * FROM ${table}`);
    // Generated ids change per database, so order by normalized content.
    return found.map(normalize).map((r) => JSON.stringify(r)).sort();
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
        console.log("seeded");
        return;
    }
    assert.equal(mode, "run", "usage: parity-batch5.e2e.cjs seed|run");

    let compared = 0;
    let succeeded = 0;
    const failures = [];
    const fail = (label, a, b) => {
        failures.push(label);
        console.log(`  DIFF  ${label}\n        A: ${JSON.stringify(a).slice(0, 400)}\n        B: ${JSON.stringify(b).slice(0, 400)}`);
    };
    const same = (a, b) => {
        try {
            assert.deepEqual(a, b);
            return true;
        } catch {
            return false;
        }
    };

    const varsA = {};
    const varsB = {};
    for (const [name, mod] of Object.entries(MODULES)) {
        console.log(name);
        const before = failures.length;
        let ok2xx = 0;
        for (const [i, step] of mod.steps.entries()) {
            if (step.sql) {
                await dbA.query(fill(step.sql, varsA));
                await dbB.query(fill(step.sql, varsB));
                continue;
            }
            const [a, b] = await Promise.all([request(BASE_A, step, varsA), request(BASE_B, step, varsB)]);
            if (step.unordered) for (const r of [a, b]) r.body = r.body.map((x) => JSON.stringify(x)).sort();
            compared++;
            if (process.env.PARITY_VERBOSE) console.log(`  ${a.status} ${b.status} ${step.method ?? "GET"} ${fill(step.path, varsA).slice(0, 90)}`);
            if (a.status < 300) ok2xx++;
            if (!same(a, b)) fail(`${name} step ${i}: ${step.method ?? "GET"} ${step.path}`, a, b);
        }
        for (const table of mod.tables) {
            const [a, b] = await Promise.all([rows(dbA, table), rows(dbB, table)]);
            compared++;
            if (!same(a, b)) fail(`${name} rows: ${table}`, a, b);
        }
        if (ok2xx === 0) fail(`${name}: no step succeeded, so nothing real was compared`, 0, 0);
        succeeded += ok2xx;
        if (failures.length === before) console.log(`  ok    ${mod.steps.length} steps`);
    }

    console.log("concurrency");
    const burst = (base) => Promise.all(Array.from({ length: 12 }, (_, i) => request(base, post(T, { subject: `Burst ${i}` }))));
    const [burstA, burstB] = [await burst(BASE_A), await burst(BASE_B)];
    const okCount = (list) => list.filter((r) => r.status < 300).length;
    console.log(`  info  12 concurrent creates: old ${okCount(burstA)} succeeded, new ${okCount(burstB)}`);
    if (okCount(burstB) < okCount(burstA)) fail("B: concurrent creates must not fail more often than A", okCount(burstA), okCount(burstB));
    const dupes = async (db) => (await db.query(`SELECT ticket_number FROM tickets WHERE organization_id = $1 GROUP BY 1 HAVING COUNT(*) > 1`, [ORG])).rows.length;
    if ((await dupes(dbA)) || (await dupes(dbB))) fail("ticket numbers stay unique", 0, 1);

    console.log("intentional difference: unstorable due date");
    const inf = patch(`${T}/{t4}`, { dueAt: "infinity" });
    const [ia, ib] = [await request(BASE_A, inf, varsA), await request(BASE_B, inf, varsB)];
    console.log(`  info  dueAt=infinity: old ${ia.status}, new ${ib.status}`);
    const lista = await request(BASE_A, get(T));
    const listb = await request(BASE_B, get(T));
    console.log(`  info  list afterwards: old ${lista.status}, new ${listb.status}`);
    if (ib.status !== 500 || listb.status !== 200) fail("infinity must be refused on the new build without breaking the list", 500, ib.status);

    // Code paths with no HTTP route: totals, and calls with no organization on the request.
    if (process.env.DIST_B) {
        console.log("direct calls (new build)");
        process.env.DATABASE_URL = DB_B;
        const load = (p) => require(`${process.env.DIST_B}/${p}`);
        const { PrismaService } = load("storage/prisma.service.js");
        const { TicketsService } = load("tickets/tickets.service.js");
        const { TicketTimeService } = load("tickets/ticket-time.service.js");
        const { CannedResponsesService } = load("tickets/canned-responses.service.js");
        const prisma = new PrismaService();
        const tickets = new TicketsService(prisma, new TicketTimeService(prisma), { sendReply: async () => ({ sent: false }) });
        const canned = new CannedResponsesService(prisma);
        const inOrg = { user: { organizationId: ORG, name: "Direct" } };
        const check = async (label, fn) => {
            try {
                await fn();
                console.log(`  ok    ${label}`);
            } catch (e) {
                fail(label, "", String(e?.message ?? e));
            }
        };
        const count = async (sql, params) => (await dbB.query(sql, params)).rows[0].n;
        await check("list totals match SQL, plain and searched", async () => {
            const all = await count(`SELECT COUNT(*)::int AS n FROM tickets WHERE organization_id = $1`, [ORG]);
            const page = await tickets.list({ page: 1, pageSize: 2 }, inOrg);
            assert.equal(page.total, all);
            assert.equal(page.items.length, 2);
            const hits = await count(
                `SELECT COUNT(*)::int AS n FROM tickets t WHERE organization_id = $1 AND (subject ILIKE '%1%' OR description ILIKE '%1%' OR id::text ILIKE '%1%' OR ticket_number::text ILIKE '%1%')`,
                [ORG],
            );
            const found = await tickets.list({ page: 1, pageSize: 2, search: "1" }, inOrg);
            assert.equal(found.total, hits);
            assert.equal(found.items.length, Math.min(2, hits));
            assert.equal(typeof found.items[0].ticketNumber, "number");
        });
        await check("priority 'normal' reaches the database as normal", async () => {
            const page = await tickets.list({ priority: "normal", pageSize: 200 }, inOrg);
            const n = await count(`SELECT COUNT(*)::int AS n FROM tickets WHERE organization_id = $1 AND priority = 'normal'`, [ORG]);
            assert.equal(page.total, n);
            assert.ok(page.items.every((t) => t.priority === "medium"));
        });
        await check("no organization on the request", async () => {
            const across = await tickets.list({ page: 1, pageSize: 200 }, {});
            const everything = await count(`SELECT COUNT(*)::int AS n FROM tickets`);
            assert.equal(across.total, everything);
            assert.ok((await tickets.getOne(OTHER_TICKET, {}))?.id);
            await assert.rejects(tickets.create({ subject: "x" }, {}), /organizationId is required/);
            await assert.rejects(tickets.addLink(OTHER_TICKET, "1", {}), /requires organization context/);
            assert.deepEqual(await canned.listForTicketUse({}), []);
            assert.deepEqual(await canned.adminList({}), []);
            assert.deepEqual(await canned.adminListVariables({}), []);
            assert.ok((await canned.listVariableDefinitionsForTicketUse({})).every((d) => d.source === "preset"));
            await assert.rejects(canned.adminCreate({}, { title: "x", body: "y" }), /No organization context/);
            await assert.rejects(canned.adminDelete({}, MISSING), /No organization context/);
            assert.equal(await canned.renderForTicket(OTHER_TICKET, "{{ticket.title}}", {}), "Second org ticket");
        });
        await check("an unusable organization id matches nothing rather than throwing", async () => {
            const odd = { user: { organizationId: "not-a-uuid" } };
            assert.equal((await tickets.list({}, odd)).total, 0);
            assert.equal(await tickets.getOne(OTHER_TICKET, odd), null);
            await assert.rejects(tickets.getReplies(OTHER_TICKET, odd), /Ticket not found/);
            await assert.rejects(canned.renderForTicket(OTHER_TICKET, "x", odd), /Ticket not found/);
        });
        await check("Prisma errors do not echo stored values", async () => {
            const secret = "super-secret-value";
            let message = "";
            try {
                await prisma.canned_variables.create({ data: { value: secret } });
            } catch (e) {
                message = String(e?.message ?? e);
            }
            assert.ok(message, "expected a validation error");
            assert.ok(!message.includes(secret), "error message contains the stored value");
        });
        await prisma.$disconnect();
    }

    await Promise.all([dbA.end(), dbB.end()]);
    console.log(`\n${compared} comparisons (${succeeded} on successful requests), ${failures.length} failed`);
    process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
