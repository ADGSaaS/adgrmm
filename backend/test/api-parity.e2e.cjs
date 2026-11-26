#!/usr/bin/env node
// Compares two backend builds, each on its own throwaway database. Every step runs
// against both, then responses and the resulting rows must match.
//
//   node test/api-parity.e2e.cjs seed     (before the backends start)
//   node test/api-parity.e2e.cjs run      (once both are up)
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

const DEVICE = "a0000000-0000-4000-8000-000000000001";
const AGENT = "a0000000-0000-4000-8000-000000000002";
const CLIENT = "a0000000-0000-4000-8000-000000000003";
const SITE = "a0000000-0000-4000-8000-000000000004";
const BARE_DEVICE = "a0000000-0000-4000-8000-000000000005";
const SCAN_TASK = "a0000000-0000-4000-8000-000000000011";
const SCAN_RUN = "a0000000-0000-4000-8000-000000000012";
const INSTALL_TASK = "a0000000-0000-4000-8000-000000000013";
const INSTALL_RUN = "a0000000-0000-4000-8000-000000000014";
const OPEN_RUN_TASK = "a0000000-0000-4000-8000-000000000015";
const OPEN_RUN = "a0000000-0000-4000-8000-000000000016";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Generated ids differ between the databases; fixture ids are fixed and compared.
const isFixtureId = (s) => s.startsWith("a0000000-") || /^(.)\1{7}-/.test(s);

const token = (sub, jti) => jwt.sign({ sub, email: `${sub}@example.test`, jti }, SECRET, { expiresIn: "1h" });
const adminCookie = token(ADMIN, SESSION.current);
const viewerCookie = token(VIEWER, crypto.randomUUID());

async function seedDb(db) {
    await db.query(`INSERT INTO organizations (id, name, slug) VALUES ($1,'Default Organization','default')`, [ORG]);
    for (const [id, name] of [[ADMIN, "admin"], [VIEWER, "viewer"]]) {
        await db.query(
            `INSERT INTO users (id, organization_id, email, first_name, last_name, status, password_hash)
             VALUES ($1,$2,$3,'Parity',$4,'active','x')`,
            [id, ORG, `${name}@example.test`, name],
        );
    }
    for (const [id, user, perms] of [
        [ADMIN_ROLE, ADMIN, ["settings.read", "settings.write", "backups.manage", "devices.actions", "me.read", "me.write"]],
        [VIEWER_ROLE, VIEWER, ["devices.read"]],
    ]) {
        await db.query(
            `INSERT INTO roles (id, organization_id, scope, name) VALUES ($1,$2,'organization',$3)`,
            [id, ORG, `parity-${id}`],
        );
        await db.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)`, [user, id]);
        for (const perm of perms) {
            await db.query(`INSERT INTO role_permissions (role_id, permission_key) VALUES ($1,$2)`, [id, perm]);
        }
    }
    await db.query(`INSERT INTO clients (id, organization_id, name) VALUES ($1,$2,'Parity Client')`, [CLIENT, ORG]);
    await db.query(`INSERT INTO sites (id, client_id, name) VALUES ($1,$2,'Parity Site')`, [SITE, CLIENT]);
    await db.query(`INSERT INTO devices (id, site_id, hostname) VALUES ($1,$2,'patched'), ($3,$2,'bare')`, [DEVICE, SITE, BARE_DEVICE]);
    await db.query(`INSERT INTO agents (id, device_id, agent_uuid, version) VALUES ($1::uuid,$2,$1::text,'1.0')`, [AGENT, DEVICE]);
    const sessions = [
        [SESSION.current, null],
        [SESSION.active, null],
        [SESSION.recentlyRevoked, "now() - interval '29 days'"],
        [SESSION.expiredRevoked, "now() - interval '31 days'"],
    ];
    for (const [id, revoked] of sessions) {
        await db.query(
            `INSERT INTO sessions (id, user_id, refresh_token, revoked_at)
             VALUES ($1,$2,'x',${revoked ?? "NULL"})`,
            [id, ADMIN],
        );
    }
}

// Volatile fields are compared for presence only.
function normalize(value) {
    if (Array.isArray(value)) return value.map(normalize);
    if (value instanceof Date) return "<time>";
    if (value && typeof value === "object") {
        const out = {};
        for (const key of Object.keys(value).sort()) {
            const volatile = /(_at|At|^lastUpdated)$/.test(key) && value[key] !== null;
            out[key] = volatile ? "<time>" : normalize(value[key]);
        }
        return out;
    }
    if (typeof value === "string" && UUID.test(value) && !isFixtureId(value)) return "<uuid>";
    if (typeof value === "bigint") return String(value);
    return value;
}

// {name} in a path, body or SQL becomes the id captured from that build's earlier response.
const fill = (text, vars) => text.replace(/\{(\w+)\}/g, (m, name) => vars[name] ?? m);

async function request(base, { method = "GET", path, body, cookie = adminCookie, capture }, vars = {}) {
    const res = await fetch(`${base}${fill(path, vars)}`, {
        method,
        headers: {
            ...(body ? { "content-type": "application/json" } : {}),
            ...(cookie ? { cookie: `${COOKIE}=${cookie}` } : {}),
        },
        body: body ? fill(JSON.stringify(body), vars) : undefined,
    });
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

const company = {
    name: "Acme", legalName: "Acme LLC", email: "hi@acme.example", phone: "555", fax: "556",
    website: "https://acme.example", vatTin: "VAT1", address1: "1 Main", address2: "Ste 2",
    city: "Town", state: "OH", postal: "45000", country: "US",
};
const branding = {
    primaryColor: "#112233", secondaryColor: "#fff", logoLightUrl: "https://x.example/l.svg",
    logoDarkUrl: "https://x.example/d.svg", loginBackgroundUrl: "https://x.example/b.jpg",
    faviconUrl: "https://x.example/f.ico", emailHeader: "<b>h</b>", emailFooter: "<i>f</i>",
    customCss: "a{color:red}", allowClientThemeToggle: true,
};
const legal = {
    supportEmail: "s@acme.example", supportPhone: "555", knowledgeBaseUrl: "https://kb.acme.example",
    statusPageUrl: "https://status.acme.example", privacyPolicyUrl: "https://acme.example/p",
    termsUrl: "https://acme.example/t", gdprContactEmail: "g@acme.example", legalAddress: "1 Main",
    ticketPortalUrl: "https://t.acme.example", phoneHours: "9-5", notesHtml: "<p>n</p>",
};
const locale = {
    language: "fr-FR", dateFormat: "DD/MM/YYYY", timeFormat: "12h", numberFormat: "1.234,56",
    timeZone: "Europe/Paris", firstDayOfWeek: "monday", currency: "EUR",
};

const get = (path, cookie) => ({ path, cookie });
const post = (path, body) => ({ method: "POST", path, body });
const put = (path, body) => ({ method: "PUT", path, body });
const patch = (path, body) => ({ method: "PATCH", path, body });
const del = (path) => ({ method: "DELETE", path });

const emailProfile = (over = {}) => ({
    enabled: true,
    smtp: { host: "smtp.example.test", port: 587, username: "mailer", password: "smtp-secret", useTLS: true, useSSL: false, fromAddress: "no-reply@example.test", ...over.smtp },
    imap: { host: "imap.example.test", port: 993, username: "mailer", password: "imap-secret", useSSL: true, ...over.imap },
    pop: { host: "pop.example.test", port: 995, username: "mailer", password: "pop-secret", useSSL: true, ...over.pop },
});
const s3Conn = (name, over = {}) => ({
    name, kind: "s3",
    config: { bucket: "b1", region: "us-east-2", accessKeyId: "AK", secretAccessKey: "SK", _browse: "ui-only", ...over },
    meta: { environment: "prod", tags: ["a"] },
});
const patchSeed = `
  INSERT INTO agent_tasks (id, agent_id, type, payload, status, created_by) VALUES
    ('${SCAN_TASK}', '${AGENT}', 'patch_scan', '{}', 'succeeded', '${ADMIN}'),
    ('${INSTALL_TASK}', '${AGENT}', 'patch_install', '{"ids":["KB2"]}', 'succeeded', '${ADMIN}'),
    ('${OPEN_RUN_TASK}', '${AGENT}', 'patch_install', '{"ids":["KB3"]}', 'running', NULL);
  INSERT INTO agent_task_runs (id, task_id, status, started_at, finished_at, output) VALUES
    ('${SCAN_RUN}', '${SCAN_TASK}', 'succeeded', '2026-01-01 00:00:00+00', '2026-01-01 00:10:00+00', '{"patches":[{"id":"ignored"}]}'),
    ('${INSTALL_RUN}', '${INSTALL_TASK}', 'succeeded', '2026-01-02 00:00:00+00', '2026-01-02 00:10:00+00', '{"artifacts":{"installed":["kb2"],"requiresReboot":"true"}}'),
    ('${OPEN_RUN}', '${OPEN_RUN_TASK}', 'running', '2026-01-03 00:00:00+00', NULL, NULL);
  INSERT INTO agent_task_results (run_id, artifacts) VALUES
    ('${SCAN_RUN}', '{"patches":[{"id":"KB1","title":"One","severity":"high","requiresReboot":true,"kbIds":[1,"x"]},{"id":"KB2","title":"Two"},{"id":"KB3"},{"title":"No id"}]}')`;

// A step is an HTTP request, or `sql` to put both databases in an unusual state first.
const MODULES = {
    branding: {
        tables: ["branding_settings"],
        steps: [
            { ...get("/api/branding", null), public: true },
            post("/api/branding", branding),
            get("/api/branding"),
            post("/api/branding", { primaryColor: "#abc" }),
            get("/api/branding"),
            post("/api/branding", { primaryColor: "not-a-color" }),
            { ...post("/api/branding", branding), cookie: viewerCookie },
            { sql: `INSERT INTO branding_settings (id, primary_color) VALUES (7, '#777')` },
            { ...get("/api/branding", null), public: true },
        ],
    },
    company: {
        tables: ["company_profile"],
        steps: [
            get("/api/admin/company", null),
            get("/api/admin/company", viewerCookie),
            get("/api/admin/company"),
            post("/api/admin/company/save", company),
            get("/api/admin/company"),
            post("/api/admin/company/save", { name: "Only Name" }),
            get("/api/admin/company"),
            post("/api/admin/company/save", { name: "Bad", email: "nope" }),
            post("/api/admin/company/save", {}),
        ],
    },
    localization: {
        tables: ["localization_settings"],
        steps: [
            get("/api/admin/localization", null),
            get("/api/admin/localization"),
            post("/api/admin/localization/save", { ...locale, currency: undefined }),
            get("/api/admin/localization"),
            post("/api/admin/localization/save", locale),
            get("/api/admin/localization"),
            post("/api/admin/localization/save", { ...locale, currency: undefined, firstDayOfWeek: "sunday" }),
            get("/api/admin/localization"),
            post("/api/admin/localization/save", { ...locale, firstDayOfWeek: "tuesday" }),
            ...[
                `time_format='HH:mm', date_format='yyyy-mm-dd'`,
                `time_format='h:mm', date_format='YYYY-MM-DD'`,
                `time_format='24H', date_format=''`,
                `time_format='', number_format=''`,
                `language='', locale='de-DE'`,
                `language='', locale=''`,
                `time_zone='', timezone='Asia/Tokyo'`,
                `time_zone='', timezone=''`,
                `currency=''`,
                `first_day_of_week=3`,
            ].flatMap((set) => [
                { sql: `UPDATE localization_settings SET ${set}` },
                get("/api/admin/localization"),
            ]),
        ],
    },
    email: {
        tables: ["email_settings", "dkim_settings"],
        steps: [
            get("/api/admin/email", null),
            get("/api/admin/email"),
            post("/api/admin/email/save", { profiles: { alerts: emailProfile() } }),
            get("/api/admin/email"),
            // Omitted passwords must keep the saved ones.
            post("/api/admin/email/save", { profiles: { alerts: emailProfile({
                smtp: { password: undefined, host: "smtp2.example.test" }, imap: { password: "" }, pop: { password: undefined },
            }) } }),
            get("/api/admin/email"),
            // profiles is not validated as nested data, so the form can send strings.
            post("/api/admin/email/save", { profiles: { invites: emailProfile({ smtp: { port: "2525" }, imap: { port: "" }, pop: { port: null } }) } }),
            get("/api/admin/email"),
            post("/api/admin/email/save", { profiles: { reports: emailProfile({ smtp: { useTLS: "true", useSSL: "false" } }) } }),
            get("/api/admin/email"),
            { path: "/healthz/email", cookie: null },
            get("/api/admin/email/dkim"),
            post("/api/admin/email/dkim", { domain: "example.test", selector: "s1", privateKey: "PEM-1" }),
            get("/api/admin/email/dkim"),
            post("/api/admin/email/dkim", { domain: "example.test", selector: "s2" }),
            get("/api/admin/email/dkim"),
            post("/api/admin/email/dkim", { selector: "s3" }),
        ],
    },
    storage: {
        tables: ["storage_connections", "backup_destinations"],
        steps: [
            get("/api/admin/storage/connections", null),
            get("/api/admin/storage/connections"),
            { ...post("/api/admin/storage/connections", s3Conn("zeta")), capture: "s3" },
            get("/api/admin/storage/connections"),
            { ...post("/api/admin/storage/connections", { name: " alpha ", kind: "gdrive", config: { folderId: "f1", refreshToken: "RT" } }), capture: "drive" },
            { ...post("/api/admin/storage/connections", { name: "mid", kind: "nextcloud", config: { webdavUrl: "https://dav.example.test", username: "u", path: "/x", password: "P" } }), capture: "dav" },
            get("/api/admin/storage/connections"),
            post("/api/admin/storage/connections", s3Conn("zeta")),
            post("/api/admin/storage/connections", { name: "x", kind: "floppy", config: {} }),
            post("/api/admin/storage/connections", { name: "x", kind: "s3", config: {} }),
            // "****" and omitted secrets must keep the saved ones.
            put("/api/admin/storage/connections/{s3}", s3Conn("zeta", { accessKeyId: "****", secretAccessKey: undefined, bucket: "b2" })),
            get("/api/admin/storage/connections"),
            put("/api/admin/storage/connections/{dav}", { name: "mid", kind: "nextcloud", config: { webdavUrl: "https://dav.example.test", username: "u", path: "/x", password: null } }),
            put(`/api/admin/storage/connections/${BARE_DEVICE}`, s3Conn("ghost")),
            put("/api/admin/storage/connections/not-valid", s3Conn("ghost")),
            put("/api/admin/storage/connections/00000000-0000-0000-0000-00000000000x", s3Conn("ghost")),
            get("/api/admin/storage/connections/{s3}/dependents"),
            { sql: `INSERT INTO backup_destinations (organization_id, name, provider, configuration) VALUES ('${ORG}', 'dest', 's3', '{"connectionId":"{s3}"}')` },
            get("/api/admin/storage/connections/{s3}/dependents"),
            del("/api/admin/storage/connections/{s3}"),
            post("/api/admin/storage/test", { id: "{drive}", kind: "gdrive", config: { folderId: "f2" } }),
            post("/api/admin/storage/test", { id: BARE_DEVICE, kind: "gdrive", config: { folderId: "f2" } }),
            post("/api/admin/storage/browse", { connectionId: "{s3}", path: "/" }),
            post("/api/admin/storage/browse", { connectionId: BARE_DEVICE, path: "/" }),
            del("/api/admin/storage/connections/{drive}"),
            del("/api/admin/storage/connections/{drive}"),
            get("/api/admin/storage/connections"),
        ],
    },
    patches: {
        tables: ["agent_tasks"],
        steps: [
            get("/api/patches/latest", null),
            get("/api/patches/latest"),
            get("/api/patches/history"),
            get(`/api/patches/latest?deviceId=${BARE_DEVICE}`),
            get("/api/patches/latest?deviceId=nope"),
            get("/api/patches/history?deviceId=nope"),
            get(`/api/patches/latest?deviceId=${DEVICE}`),
            get(`/api/patches/history?deviceId=${DEVICE}`),
            post("/api/patches/scan", { deviceId: DEVICE, includeOptional: true }),
            post("/api/patches/scan", { deviceId: BARE_DEVICE }),
            post("/api/patches/install", { deviceId: DEVICE, ids: ["KB9", " "] }),
            post("/api/patches/install", { deviceId: DEVICE, ids: [] }),
            { ...post("/api/patches/scan", { deviceId: DEVICE }), cookie: viewerCookie },
            { sql: patchSeed },
            get(`/api/patches/latest?deviceId=${DEVICE}`),
            get(`/api/patches/history?deviceId=${DEVICE}`),
            get(`/api/patches/history?deviceId=${DEVICE}&limit=1`),
            { sql: `UPDATE users SET first_name=NULL, last_name=NULL WHERE id='${ADMIN}'` },
            get(`/api/patches/history?deviceId=${DEVICE}`),
            { sql: `UPDATE users SET first_name='Parity', last_name='' WHERE id='${ADMIN}'` },
            get(`/api/patches/history?deviceId=${DEVICE}`),
            { sql: `UPDATE agent_task_runs SET finished_at=NULL WHERE id='${SCAN_RUN}'` },
            get(`/api/patches/latest?deviceId=${DEVICE}`),
            { sql: `UPDATE users SET first_name='Parity', last_name='admin' WHERE id='${ADMIN}'` },
        ],
    },
    profile: {
        tables: ["users"],
        steps: [
            get("/api/users/me", null),
            get("/api/users/me"),
            patch("/api/users/me", { name: "Ada  Mary  Lovelace", phone: "555", timezone: "UTC", locale: "en", address1: "1", address2: "2", city: "c", state: "s", postal: "p", country: "US" }),
            get("/api/users/me"),
            patch("/api/users/me", { name: "Solo" }),
            patch("/api/users/me", { name: "   " }),
            get("/api/users/me"),
            patch("/api/users/me", {}),
            patch("/api/users/me", { nonsense: "x" }),
            patch("/api/users/me", { phone: 123 }),
            patch("/api/users/me", { phone: null }),
            patch("/api/users/me", { avatarUrl: "https://x.example/a.png" }),
            get("/api/users/me"),
            del("/api/users/me/avatar"),
            get("/api/users/me"),
            patch("/api/users/me", { email: "viewer@example.test" }),
            patch("/api/users/me", { email: "ADMIN2@Example.test", name: "Parity admin" }),
            get("/api/users/me"),
            patch("/api/users/me", { email: "admin@example.test" }),
            { sql: `UPDATE users SET first_name='', last_name='' WHERE id='${ADMIN}'` },
            get("/api/users/me"),
            { sql: `UPDATE users SET first_name='Parity', last_name='admin' WHERE id='${ADMIN}'` },
        ],
    },
    "support-legal": {
        tables: ["support_legal"],
        steps: [
            get("/api/admin/support-legal", null),
            get("/api/admin/support-legal"),
            post("/api/admin/support-legal/save", legal),
            get("/api/admin/support-legal"),
            post("/api/admin/support-legal/save", { supportPhone: "111" }),
            get("/api/admin/support-legal"),
            post("/api/admin/support-legal/save", { termsUrl: "not-a-url" }),
            post("/api/admin/support-legal/save", {}),
            get("/api/admin/support-legal"),
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
    assert.equal(mode, "run", "usage: api-parity.e2e.cjs seed|run");

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
            compared++;
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
    const burst = await Promise.all(
        Array.from({ length: 12 }, (_, i) => request(BASE_B, post("/api/admin/company/save", { name: `Burst ${i}` }))),
    );
    if (burst.some((r) => r.status >= 300)) fail("B: concurrent saves must all succeed", {}, burst.map((r) => r.status));
    else console.log("  ok    12 concurrent saves");

    console.log("session cleanup");
    const left = async (db) =>
        (await db.query(`SELECT id::text AS id FROM sessions ORDER BY id`)).rows.map((r) => r.id);
    const expected = [SESSION.current, SESSION.active, SESSION.recentlyRevoked].sort();
    const [sa, sb] = await Promise.all([left(dbA), left(dbB)]);
    if (!same(sa, expected) || !same(sb, expected)) fail("sessions older than 30 days are pruned, others kept", sa, sb);
    else console.log("  ok    only the expired revoked session was removed");

    console.log("removed route");
    const stale = { method: "POST", path: "/endpoints", body: { clientId: CLIENT, siteId: SITE, deviceId: "a0000000-0000-4000-8000-000000000099", alias: "x", os: "windows", expiresMinutes: 5 } };
    const [ra, rb] = await Promise.all([request(BASE_A, stale), request(BASE_B, stale)]);
    console.log(`  info  POST /endpoints: old ${ra.status}, new ${rb.status}`);
    if (rb.status !== 404) fail("/endpoints: expected 404 on the new build", ra.status, rb.status);
    const strayB = await dbB.query(`SELECT 1 FROM devices WHERE id = $1`, [stale.body.deviceId]);
    if (strayB.rows.length) fail("/endpoints must not create a device on the new build", 0, strayB.rows.length);

    // Code with no HTTP route, called directly on the new build.
    if (process.env.DIST_B) {
        console.log("direct calls (new build)");
        process.env.DATABASE_URL = DB_B;
        const load = (p) => require(`${process.env.DIST_B}/${p}`);
        const { PrismaService } = load("storage/prisma.service.js");
        const prisma = new PrismaService();
        const check = async (label, fn) => {
            try {
                await fn();
                console.log(`  ok    ${label}`);
            } catch (e) {
                fail(label, "", String(e?.message ?? e));
            }
        };
        await check("IMAP ingest stores a message once", async () => {
            const { ImapIngestRepository } = load("imap/imap-ingest.repository.js");
            const repo = new ImapIngestRepository(prisma);
            const mail = { purpose: "alerts", uid: 4294967296, from_addr: "a@example.test", subject: "first", size_bytes: 10, headers_snippet: "h", is_bounce: true, bounce_recipient: "r", bounce_status: "5.0.0", bounce_action: "failed", bounce_diagnostic: "d" };
            await repo.insertIngested(mail);
            await repo.insertIngested({ ...mail, subject: "second" });
            const { rows: r } = await dbB.query(`SELECT uid::text AS uid, subject, is_bounce FROM imap_ingested`);
            assert.deepEqual(r, [{ uid: "4294967296", subject: "first", is_bounce: true }]);
        });
        await check("default organization: existing, then created with settings", async () => {
            const { OrganizationContextService } = load("storage/organization-context.service.js");
            const svc = () => new OrganizationContextService(prisma);
            assert.equal(await svc().getDefaultOrganizationId(), ORG);
            process.env.DEFAULT_ORGANIZATION_SLUG = "Parity New Org!";
            process.env.DEFAULT_ORGANIZATION_NAME = "Parity New";
            const created = await svc().getDefaultOrganizationId();
            delete process.env.DEFAULT_ORGANIZATION_SLUG;
            delete process.env.DEFAULT_ORGANIZATION_NAME;
            const { rows: r } = await dbB.query(
                `SELECT o.slug, o.name, s.organization_id IS NOT NULL AS has_settings
                   FROM organizations o LEFT JOIN organization_settings s ON s.organization_id = o.id
                  WHERE o.id = $1`,
                [created],
            );
            assert.deepEqual(r, [{ slug: "parity-new-org", name: "Parity New", has_settings: true }]);
        });
        await check("automation queues a job for the device's agent", async () => {
            const { AutomationService } = load("automation/automation.service.js");
            let seen = null;
            const svc = new AutomationService(prisma, { createRunScriptJob: async (a) => ((seen = a), { id: "job-1" }) });
            assert.deepEqual(await svc.enqueue({ deviceId: DEVICE, script: "x", shell: "powershell" }), { jobId: "job-1" });
            assert.equal(seen.agentId, AGENT);
            await assert.rejects(svc.enqueue({ deviceId: BARE_DEVICE, script: "x" }), /Agent not found/);
        });
        await check("Prisma errors do not echo stored values", async () => {
            const secret = "super-secret-value";
            let message = "";
            try {
                await prisma.email_settings.create({ data: { smtp_password: secret } });
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
