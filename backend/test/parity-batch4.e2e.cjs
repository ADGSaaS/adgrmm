#!/usr/bin/env node
// Batch 4 parity: customers, compat, devices, checks and provisioning. Compares two backend
// builds, each on its own throwaway database. Every step runs against both, then responses
// and the resulting rows must match.
//
//   node test/parity-batch4.e2e.cjs seed     (before the backends start)
//   node test/parity-batch4.e2e.cjs run      (once both are up)
//
// Required env: RIQ_E2E_ALLOW=1, JWT_SECRET, BASE_A, BASE_B, DB_A, DB_B. DIST_B enables direct calls.
// Both builds need AGENT_PKG_WINDOWS_PATH set to a real file and AGENT_PKG_LINUX_PATH to a missing one.
// It writes test rows, so it refuses any database whose name lacks "e2e".
"use strict";

const assert = require("node:assert/strict");
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
if (process.env.RIQ_E2E_ALLOW !== "1" || !SECRET || !safe(DB_A) || !safe(DB_B)) {
    console.error("Refusing to run: set RIQ_E2E_ALLOW=1, JWT_SECRET, and e2e-named DB_A and DB_B.");
    process.exit(2);
}

const ORG = "11111111-1111-4111-8111-111111111111";
const ADMIN = "22222222-2222-4222-8222-222222222222";
const VIEWER = "33333333-3333-4333-8333-333333333333";
const ADMIN_ROLE = "44444444-4444-4444-8444-444444444444";
const VIEWER_ROLE = "55555555-5555-4555-8555-555555555555";
const SESSION = {
    current: "66666666-6666-4666-8666-666666666666",
    viewer: "77777777-7777-4777-8777-777777777777",
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Generated ids differ between the databases; fixture ids are fixed and compared.
const isFixtureId = (s) => /^a0000000-/i.test(s) || /^(.)\1{7}-/.test(s);
// Random per database, compared for presence only.
const SECRET_KEYS = /^(token_hash|download_token_hash|content|agent_token|token|enrollmentKey|enrollmentSecret|agentToken|url)$/;

const token = (sub, jti) => jwt.sign({ sub, email: `${sub}@example.test`, jti }, SECRET, { expiresIn: "1h" });
const adminCookie = token(ADMIN, SESSION.current);
const viewerCookie = token(VIEWER, SESSION.viewer);

// Volatile fields are compared for presence only. Fixed timestamps stay exact.
const isRecent = (v) => typeof v === "string" && Math.abs(Date.now() - Date.parse(v)) < 86_400_000;
function normalize(value) {
    if (Array.isArray(value)) return value.map(normalize);
    if (value instanceof Date) return "<time>";
    if (value && typeof value === "object") {
        const out = {};
        for (const key of Object.keys(value).sort()) {
            const v = value[key];
            if (v !== null && SECRET_KEYS.test(key)) out[key] = `<${typeof v}>`;
            else if (v !== null && /(_at|At)$/.test(key)) out[key] = "<time>";
            else if (/^(lastSeen|lastRun)$/.test(key) && isRecent(v)) out[key] = "<recent>";
            else out[key] = normalize(v);
        }
        return out;
    }
    if (typeof value === "string" && UUID.test(value) && !isFixtureId(value)) return "<uuid>";
    if (typeof value === "bigint") return String(value);
    return value;
}

// {name} in a path, body or SQL becomes the value captured from that build's earlier response.
const fill = (text, vars) => text.replace(/\{(\w+)\}/g, (m, name) => vars[name] ?? m);

async function request(base, { method = "GET", path, body, cookie = adminCookie, agent, capture, scrub }, vars = {}) {
    const res = await fetch(`${base}${fill(path, vars)}`, {
        method,
        headers: {
            ...(body ? { "content-type": "application/json" } : {}),
            ...(cookie ? { cookie: `${COOKIE}=${cookie}` } : {}),
            ...(agent ? { authorization: `Bearer ${fill(agent, vars)}` } : {}),
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
    for (const [name, field] of Object.entries(capture ?? {})) {
        if (parsed?.[field] != null) vars[name] = String(parsed[field]);
        // The agent package link uses the same token as the bundle's download link.
        if (field === "bundleId" && parsed?.url) vars[`${name}Pkg`] = parsed.url.replace("/download?", "/agent-package?");
    }
    if (scrub) {
        return {
            status: res.status,
            type: res.headers.get("content-type"),
            disposition: res.headers.get("content-disposition"),
            cache: res.headers.get("cache-control"),
            sniff: res.headers.get("x-content-type-options"),
            // Bundle ids, tokens and the backend's own address differ between builds.
            body: String(text).replace(/[A-Za-z0-9_-]{32,}/g, "<random>").replace(/127\.0\.0\.1:\d+/g, "<host>"),
        };
    }
    return { status: res.status, body: normalize(parsed) };
}

const get = (path, cookie) => ({ path, cookie });
const post = (path, body) => ({ method: "POST", path, body });
const put = (path, body) => ({ method: "PUT", path, body });
const patch = (path, body) => ({ method: "PATCH", path, body });
const del = (path) => ({ method: "DELETE", path });

const id = (n) => `a0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const CLIENT = id(3);
const SITE = id(4);
const SITE2 = id(6);
const CLIENT_B = id(7);
const SITE_B = id(8);
const OTHER_ORG = id(9);
const OTHER_CLIENT = id(10);
const OTHER_SITE = id(11);
const EMPTY_CLIENT = id(12);
const EMPTY_SITE = id(13);

const ONLINE = id(101);
const ONLINE_AGENT = id(201);
const STALE = id(102);
const STALE_AGENT = id(202);
const NEVER = id(103);
const NEVER_AGENT = id(203);
const BLANK_UUID = id(104);
const BLANK_UUID_AGENT = id(204);
const BARE_ONLINE = id(105);
const BARE_OLD = id(106);
const NO_SITE = id(107);
const MOVE = id(108);
const MOVE_AGENT = id(208);
const DEL_AGENT_DEV = id(110);
const DEL_AGENT = id(210);
const DEL_BARE = id(111);
const DEL_DONE = id(112);
const DEL_THREE = id(113);
const DEL_THREE_AGENT = id(213);
const REQ_VIEW = id(114);
const FILES = id(115);
const FILES_AGENT = id(215);
const INGEST = id(120);
const INGEST_AGENT = id(220);
const RUNTIME = id(121);
const RUNTIME_AGENT = id(221);
const BURST = id(122);
const BURST_AGENT = id(222);
const BURST2 = id(123);
const BURST2_AGENT = id(223);
const DUP = id(124);
const DUP_AGENT = id(224);
const MISSING = id(999);
const NEW_DEVICE = id(301);
const NEW_DEVICE2 = id(302);
const ENROLLED = id(303);
const ENROLLED2 = id(304);
const DENIED = id(305);

const PERMISSIONS = [
    "customers.read", "customers.write", "devices.read", "devices.write", "devices.delete", "devices.actions",
    "checks.read", "checks.write", "checks.delete", "checks.run", "users.read", "me.read",
];

async function seedDb(db) {
    await db.query(`INSERT INTO organizations (id, name, slug) VALUES ($1,'Default Organization','default'), ($2,'Other Org','other')`, [ORG, OTHER_ORG]);
    for (const p of PERMISSIONS) {
        await db.query(
            `INSERT INTO permissions (permission_key, label, group_key, group_label) VALUES ($1,$1,'parity','Parity') ON CONFLICT DO NOTHING`,
            [p],
        );
    }
    for (const [uid, name] of [[ADMIN, "admin"], [VIEWER, "viewer"]]) {
        await db.query(
            `INSERT INTO users (id, organization_id, email, first_name, last_name, status, password_hash)
             VALUES ($1,$2,$3,'Parity',$4,'active','x')`,
            [uid, ORG, `${name}@example.test`, name],
        );
    }
    for (const [rid, user, perms] of [
        [ADMIN_ROLE, ADMIN, PERMISSIONS],
        [VIEWER_ROLE, VIEWER, ["devices.read"]],
    ]) {
        await db.query(`INSERT INTO roles (id, organization_id, scope, name) VALUES ($1,$2,'organization',$3)`, [rid, ORG, `parity-${rid}`]);
        await db.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)`, [user, rid]);
        for (const perm of perms) {
            await db.query(`INSERT INTO role_permissions (role_id, permission_key) VALUES ($1,$2)`, [rid, perm]);
        }
    }
    await db.query(`INSERT INTO sessions (id, user_id, refresh_token) VALUES ($1,$2,'x'), ($3,$4,'y')`, [SESSION.current, ADMIN, SESSION.viewer, VIEWER]);

    await db.query(
        `INSERT INTO clients (id, organization_id, name) VALUES
           ('${CLIENT}','${ORG}','Parity Client'), ('${CLIENT_B}','${ORG}','Second Client'),
           ('${EMPTY_CLIENT}','${ORG}','Empty Sites Client'), ('${OTHER_CLIENT}','${OTHER_ORG}','Foreign Client')`,
    );
    await db.query(
        `INSERT INTO sites (id, client_id, name) VALUES
           ('${SITE}','${CLIENT}','Parity Site'), ('${SITE2}','${CLIENT}','annex'), ('${SITE_B}','${CLIENT_B}','Second Site'),
           ('${EMPTY_SITE}','${EMPTY_CLIENT}','Unused'), ('${OTHER_SITE}','${OTHER_CLIENT}','Foreign Site')`,
    );
    const devices = [
        [ONLINE, SITE, "dev-online", "Windows"], [STALE, SITE, "dev-stale", "Linux"], [NEVER, SITE, "dev-never", "FreeBSD"],
        [BLANK_UUID, SITE, "dev-blank", ""], [BARE_ONLINE, SITE, "Bare-Online", "macOS"], [BARE_OLD, SITE, "bare_old", ""],
        [NO_SITE, null, "no-site", null], [MOVE, SITE, "mover", "Windows"], [DEL_AGENT_DEV, SITE, "del-agent", "Windows"],
        [DEL_BARE, SITE, "del-bare", "Linux"], [DEL_DONE, SITE, "del-done", "Linux"], [DEL_THREE, SITE, "del-three", "Linux"],
        [REQ_VIEW, SITE, "req-view", "Linux"], [FILES, SITE, "files", "Windows"], [INGEST, SITE, "ingest", "Windows"],
        [RUNTIME, SITE, "runtime", "Windows"], [BURST, SITE, "burst", "Windows"], [BURST2, SITE, "burst2", "Windows"], [DUP, SITE, "dup", "Windows"],
        [id(130), SITE, "same-host", "Linux"], [id(131), SITE2, "same-host", "Linux"], [id(132), SITE2, "Alpha", "Linux"],
        [id(133), SITE2, "alpha2", "Linux"], [id(134), SITE2, "BETA_1", "Linux"], [id(135), SITE2, "beta%2", "Linux"],
        [id(136), SITE2, "Çay", "Linux"], [id(137), SITE2, "10-x", "Linux"], [id(138), SITE2, "9-x", "Linux"],
        [id(139), SITE2, "mover", "Linux"],
    ];
    for (const [did, site, host, os] of devices) {
        await db.query(`INSERT INTO devices (id, site_id, hostname, operating_system) VALUES ($1,$2,$3,$4)`, [did, site, host, os]);
    }
    await db.query(`UPDATE devices SET architecture='arm64', last_seen_at='2026-01-01 00:00:00+00' WHERE id IN ('${STALE}','${NEVER}')`);
    await db.query(`UPDATE devices SET last_seen_at='2025-02-03 04:05:06+00' WHERE id='${id(130)}'`);
    const agents = [
        [ONLINE_AGENT, ONLINE, ONLINE_AGENT, "1.0", "agent-host-zeta", `{"os":"Windows 11","arch":"x64","user":"ann","logged_in_user":"zed","primary_ip":"10.0.0.1","nested":{"b":1,"a":[1,"x",null]}}`],
        [STALE_AGENT, STALE, "stale-uuid", "1.1", null, `{"os":"","logged_in_user":"zed","primary_ip":""}`],
        [NEVER_AGENT, NEVER, "never-uuid", "", null, `{"os":7,"arch":""}`],
        [BLANK_UUID_AGENT, BLANK_UUID, "", "2", null, `{}`],
        [MOVE_AGENT, MOVE, "move-uuid", "1", null, `{}`],
        [DEL_AGENT, DEL_AGENT_DEV, "del-uuid", "1", null, `{}`],
        [DEL_THREE_AGENT, DEL_THREE, "del3-uuid", "1", null, `{}`],
        [FILES_AGENT, FILES, "files-uuid", "1", null, `{}`],
        [INGEST_AGENT, INGEST, "ingest-uuid", "1", null, `{}`],
        [RUNTIME_AGENT, RUNTIME, "runtime-uuid", "1", null, `{}`],
        [BURST_AGENT, BURST, "burst-uuid", "1", null, `{}`],
        [BURST2_AGENT, BURST2, "burst2-uuid", "1", null, `{}`],
        [DUP_AGENT, DUP, "dup-uuid", "1", null, `{}`],
    ];
    for (const [aid, did, uuid, version, host, facts] of agents) {
        await db.query(
            `INSERT INTO agents (id, device_id, agent_uuid, version, hostname, facts, agent_token) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [aid, did, uuid, version, host, facts, `token-${aid}`],
        );
    }
    await db.query(
        `INSERT INTO agent_software (id, agent_id, name, publisher, version, install_date) VALUES
           ('${id(401)}','${ONLINE_AGENT}','zip','Igor','24','2024-05-11 01:02:03.456+00'),
           ('${id(402)}','${ONLINE_AGENT}','Chrome','Google',NULL,NULL),
           ('${id(403)}','${ONLINE_AGENT}','chrome','Google','10',NULL),
           ('${id(404)}','${ONLINE_AGENT}','chrome','Google','9',NULL),
           ('${id(405)}','${ONLINE_AGENT}','Édit',NULL,'',NULL),
           ('${id(406)}','${DEL_AGENT}','gone','x','1',NULL)`,
    );
    await db.query(
        `INSERT INTO tickets (id, organization_id, ticket_number, subject, device_id) VALUES
           ('${id(501)}','${ORG}',1,'t1','${ONLINE}'), ('${id(502)}','${ORG}',2,'t2','${DEL_AGENT_DEV}'), ('${id(503)}','${ORG}',3,'t3',NULL)`,
    );
    await db.query(`INSERT INTO device_deletion_requests (id, device_id, status, requested_at, completed_at) VALUES ('${id(601)}','${DEL_DONE}','completed','2026-01-01','2026-01-02')`);
    await db.query(`INSERT INTO jobs (id, agent_id, type, status) VALUES ('${id(602)}','${DEL_AGENT}','run_script','queued')`);
    await db.query(
        `INSERT INTO check_assignments (id, target_type, target_id, dedupe_key, check_type, check_name) VALUES
           ('${id(701)}','device','${ONLINE}','k1','PING','beta'),
           ('${id(702)}','device','${ONLINE}','k2','CPU','Alpha'),
           ('${id(703)}','device','${ONLINE}','k3','DISK',''),
           ('${id(704)}','device','${ONLINE}','k4','',''),
           ('${id(705)}','device','${ONLINE}','k5','MEM','never ran'),
           ('${id(706)}','site','${ONLINE}','k6','X','wrong target type'),
           ('${id(707)}','device','${BARE_ONLINE}','k7','PING','bare assignment')`,
    );
    await db.query(
        `INSERT INTO check_runs (assignment_id, status, severity, started_at, finished_at, metrics, output, device_id, created_at) VALUES
           ('${id(701)}','OK',NULL,'2026-01-01','2026-01-02 00:00:00+00','{"z":1,"a":2}','old','x','2026-01-02'),
           ('${id(701)}','CRIT','critical','2026-01-01','2026-01-03 00:00:00+00',NULL,'newest','x','2026-01-03'),
           ('${id(701)}','WARN',NULL,'2026-01-01',NULL,NULL,'unfinished sorts last','x','2026-01-04'),
           ('${id(702)}','WARN','low','2026-01-01','2026-01-03 00:00:00+00',NULL,repeat('y',9000),'x','2026-01-03'),
           ('${id(703)}','TIMEOUT',NULL,'2026-01-01','2026-01-04 00:00:00+00',NULL,NULL,'x','2026-01-04')`,
    );
}

// `expect` also pins the status on the old build, so a blanket error cannot pass as parity.
const ok = (step, expect) => ({ ...step, expect });
const agentPost = (path, agent, body) => ({ method: "POST", path, body, cookie: null, agent });
const agentGet = (path, agent) => ({ path, cookie: null, agent });
const tokenOf = (agentId) => `token-${agentId}`;
const freshTimes = {
    sql: `UPDATE agents SET last_check_in_at = now() - interval '4 minutes 30 seconds' WHERE id = '${ONLINE_AGENT}';
          UPDATE agents SET last_check_in_at = now() - interval '5 minutes 10 seconds' WHERE id = '${STALE_AGENT}';
          UPDATE devices SET last_seen_at = now() - interval '4 minutes 30 seconds' WHERE id IN ('${BARE_ONLINE}','${STALE}');
          UPDATE devices SET last_seen_at = now() - interval '5 minutes 10 seconds' WHERE id = '${BARE_OLD}'`,
};
const cursorOf = (text) => Buffer.from(text).toString("base64url");
const keyBody = (over = {}) => ({ clientId: CLIENT, siteId: SITE, ...over });
const enroll = (over) => ({
    method: "POST", path: "/api/agent/enroll", cookie: null,
    body: { hostname: "enrolled", os: "linux", arch: "x64", version: "3.0", ...over },
});
const checkDto = { scope: "GLOBAL", type: "PING", name: "c", severityDefault: "WARN", intervalSec: 60, timeoutSec: 5, enabled: true };

// A step is an HTTP request, or `sql` to put both databases in an unusual state first.
const MODULES = {
    customers: {
        tables: ["clients", "sites"],
        steps: [
            ok(get("/api/customers", null), 401),
            ok(get("/api/customers", viewerCookie), 403),
            ok(get("/api/customers"), 200),
            ok(get("/api/customers?q=parity"), 200),
            get("/api/customers?q=PARITY"),
            get("/api/customers?q=%20parity%20"),
            get("/api/customers?q=%25"),
            get("/api/customers?q=P_rity"),
            get("/api/customers?q=%5C"),
            get("/api/customers?q=foreign"),
            ok({ ...post("/api/customers", { name: " beta Co ", labels: { a: 1 } }), capture: { beta: "id" } }, 201),
            ok(post("/api/customers", { name: "beta Co" }), 500),
            post("/api/customers", { name: "BETA CO" }),
            ok(post("/api/customers", { name: "   " }), 400),
            ok(post("/api/customers", {}), 400),
            post("/api/customers", { name: 42 }),
            { ...post("/api/customers", { name: "viewer try" }), cookie: viewerCookie },
            ok(post("/api/customers", { name: "A_B" }), 201),
            ok(post("/api/customers", { name: "AxB" }), 201),
            ok(post("/api/customers", { name: "100%" }), 201),
            ok(post("/api/customers", { name: "1000" }), 201),
            post("/api/customers", { name: "back\\slash" }),
            post("/api/customers", { name: "Çedilla" }),
            post("/api/customers", { name: "_under" }),
            post("/api/customers", { name: "10 z" }),
            post("/api/customers", { name: "9 z" }),
            post("/api/customers", { name: "zed" }),
            post("/api/customers", { name: "Zed2" }),
            get("/api/customers"),
            ok(get(`/api/customers/${CLIENT}/sites`), 200),
            get("/api/customers/parity%20client/sites"),
            get("/api/customers/PARITY%20CLIENT/sites"),
            get(`/api/customers/${CLIENT.toUpperCase()}/sites`),
            get(`/api/customers/${OTHER_CLIENT}/sites`),
            get("/api/customers/Foreign%20Client/sites"),
            get("/api/customers/nope/sites"),
            get("/api/customers/00000000-0000-0000-0000-000000000000/sites"),
            get("/api/customers/P_rity%20Client/sites"),
            get("/api/customers/%25/sites"),
            ok(post("/api/customers/A_B/sites", { name: "under site" }), 201),
            get("/api/customers/AxB/sites"),
            get("/api/customers/a_b/sites"),
            ok(post("/api/customers/100%25/sites", { name: "percent site" }), 201),
            get("/api/customers/1000/sites"),
            post("/api/customers/back%5Cslash/sites", { name: "slash site" }),
            get("/api/customers/back%5Cslash/sites"),
            ok({ ...post(`/api/customers/${CLIENT}/sites`, { name: " site one ", labels: "{bad" }), capture: { s1: "id" } }, 201),
            ok(post(`/api/customers/${CLIENT}/sites`, { name: "site one" }), 500),
            post("/api/customers/parity%20client/sites", { name: "Zeta site" }),
            post("/api/customers/parity%20client/sites", { name: "Alpha_site" }),
            post("/api/customers/parity%20client/sites", { name: "alpha%site" }),
            ok(post(`/api/customers/${CLIENT}/sites`, { name: "" }), 400),
            ok(post("/api/customers/nope/sites", { name: "x" }), 400),
            ok(post(`/api/customers/${OTHER_CLIENT}/sites`, { name: "x" }), 400),
            post(`/api/customers/${CLIENT.toUpperCase()}/sites`, { name: "x" }),
            get(`/api/customers/${CLIENT}/sites`),
            ok(del(`/api/customers/${CLIENT}/sites/${SITE}`), 409),
            ok(del(`/api/customers/${CLIENT}/sites/parity%20site`), 409),
            ok(del(`/api/customers/${CLIENT_B}/sites/${SITE}`), 404),
            ok(del(`/api/customers/${OTHER_CLIENT}/sites/${OTHER_SITE}`), 404),
            del(`/api/customers/${CLIENT}/sites/${MISSING}`),
            del(`/api/customers/${CLIENT}/sites/${SITE.toUpperCase()}`),
            del(`/api/customers/${CLIENT}/sites/nope`),
            del(`/api/customers/${CLIENT}/sites/Alphaxsite`),
            ok(del(`/api/customers/${CLIENT}/sites/ALPHA_SITE`), 200),
            ok(del(`/api/customers/${CLIENT}/sites/{s1}`), 200),
            ok(del(`/api/customers/${CLIENT}/sites/{s1}`), 404),
            get(`/api/customers/${CLIENT}/sites`),
            ok(del(`/api/customers/${CLIENT}`), 409),
            ok(del(`/api/customers/${CLIENT}?force=true`), 409),
            ok(del("/api/customers/nope"), 404),
            ok(del(`/api/customers/${OTHER_CLIENT}?force=true`), 404),
            del(`/api/customers/${CLIENT.toUpperCase()}`),
            ok(del(`/api/customers/${EMPTY_CLIENT}`), 409),
            ok(del(`/api/customers/${EMPTY_CLIENT}?force=TRUE&x=1`), 200),
            ok(del("/api/customers/{beta}"), 200),
            del("/api/customers/{beta}"),
            ok(del("/api/customers/zed"), 200),
            { ...del("/api/customers/zed2"), cookie: viewerCookie },
            get("/api/customers"),
        ],
    },
    compat: {
        tables: [],
        steps: [
            ok(get("/api/clients", null), 401),
            ok(get("/api/clients"), 200),
            ok(get("/api/sites"), 200),
            ok(get("/api/locations"), 200),
            ok(get("/api/clients", viewerCookie), 403),
            ok(get("/api/sites", viewerCookie), 403),
        ],
    },
    "device list": {
        tables: ["devices"],
        steps: [
            freshTimes,
            ok(get("/api/devices", null), 401),
            ok(get("/api/devices"), 200),
            ok(get("/api/devices", viewerCookie), 200),
            ok(get("/api/devices?pageSize=200"), 200),
            ok({ ...get("/api/devices?pageSize=7"), capture: { c1: "nextCursor" } }, 200),
            ok({ ...get("/api/devices?pageSize=7&cursor={c1}"), capture: { c2: "nextCursor" } }, 200),
            ok({ ...get("/api/devices?pageSize=7&cursor={c2}"), capture: { c3: "nextCursor" } }, 200),
            get("/api/devices?pageSize=7&cursor={c3}"),
            get(`/api/devices?pageSize=1&cursor=${cursorOf("4")}`),
            get(`/api/devices?pageSize=5&cursor=${cursorOf("1000")}`),
            get("/api/devices?cursor=!!!"),
            get(`/api/devices?cursor=${cursorOf("-3")}`),
            get(`/api/devices?cursor=${cursorOf("99999999999999999999")}`),
            get(`/api/devices?cursor=${cursorOf("1000000000000000000000000")}`),
            ok(get("/api/devices?pageSize=0"), 400),
            ok(get("/api/devices?pageSize=201"), 400),
            ok(get("/api/devices?pageSize=abc"), 400),
            ok(get("/api/devices?q=dev"), 200),
            get("/api/devices?q=DEV-"),
            get("/api/devices?q=%20bare%20"),
            get("/api/devices?q=%25"),
            get("/api/devices?q=_"),
            get("/api/devices?q=beta%25"),
            get("/api/devices?q=beta_"),
            get("/api/devices?q=%5C"),
            get("/api/devices?q=zeta"),
            get("/api/devices?q=dev-online"),
            get(`/api/devices?q=${ONLINE.slice(0, 8)}`),
            get("/api/devices?q=nothing-matches"),
            ok(get("/api/devices?status=online"), 200),
            ok(get("/api/devices?status=offline&pageSize=200"), 200),
            ok(get("/api/devices?status=weird"), 400),
            ok(get("/api/devices?os=linux"), 200),
            get("/api/devices?os=LINUX&pageSize=3"),
            get("/api/devices?os=windows%2011"),
            get("/api/devices?os=7"),
            get("/api/devices?os=unknown"),
            get("/api/devices?os=linux&os=macos"),
            get("/api/devices?os="),
            get("/api/devices?q=dev&status=offline&os=linux&os=7"),
            ok(get(`/api/devices/${ONLINE}`), 200),
            ok(get(`/api/devices/${ONLINE_AGENT}`), 200),
            ok(get(`/api/devices/${STALE}`), 200),
            get(`/api/devices/${NEVER}`),
            get(`/api/devices/${BLANK_UUID}`),
            get(`/api/devices/${BARE_ONLINE}`),
            get(`/api/devices/${BARE_OLD}`),
            get(`/api/devices/${NO_SITE}`),
            ok(get(`/api/devices/${MISSING}`), 404),
            ok(get(`/api/devices/${ONLINE.toUpperCase()}`), 404),
            ok(get("/api/devices/not-a-uuid"), 404),
            get(`/api/devices/${ONLINE}`, viewerCookie),
            get(`/api/devices/${ONLINE}`, null),
            ok(get(`/api/devices/${ONLINE}/software`), 200),
            ok(get(`/api/devices/${ONLINE_AGENT}/software`), 200),
            get(`/api/devices/${BARE_ONLINE}/software`),
            get(`/api/devices/${MISSING}/software`),
            get(`/api/devices/${ONLINE.toUpperCase()}/software`),
            get("/api/devices/not-a-uuid/software"),
            get(`/api/devices/${ONLINE}/software`, viewerCookie),
        ],
    },
    "device moves": {
        tables: ["devices"],
        steps: [
            ok(patch(`/api/devices/${MOVE}/site`, { siteId: SITE_B }), 400),
            ok(patch(`/api/devices/${MOVE}/site`, { siteId: MISSING }), 404),
            ok(patch(`/api/devices/${MOVE}/site`, { siteId: "not-a-uuid" }), 500),
            ok(patch(`/api/devices/${MOVE}/site`, {}), 400),
            ok(patch(`/api/devices/${MOVE}/site`, { siteId: "   " }), 400),
            ok(patch(`/api/devices/${MISSING}/site`, { siteId: SITE2 }), 404),
            ok(patch(`/api/devices/${MOVE.toUpperCase()}/site`, { siteId: SITE2 }), 404),
            ok(patch("/api/devices/not-a-uuid/site", { siteId: SITE2 }), 404),
            // SITE2 already has a device with this hostname.
            ok(patch(`/api/devices/${MOVE}/site`, { siteId: SITE2 }), 500),
            { sql: `DELETE FROM devices WHERE id = '${id(139)}'` },
            ok(patch(`/api/devices/${MOVE}/site`, { siteId: SITE2 }), 200),
            get(`/api/devices/${MOVE}`),
            ok(patch(`/api/devices/${MOVE_AGENT}/site`, { site_id: SITE }), 200),
            ok(patch(`/api/devices/${MOVE_AGENT}/site`, { siteId: SITE2.toUpperCase() }), 200),
            ok(patch(`/api/devices/${BARE_OLD}/site`, { siteId: SITE2 }), 200),
            ok(patch(`/api/devices/${NO_SITE}/site`, { siteId: SITE_B }), 200),
            { ...patch(`/api/devices/${BARE_OLD}/site`, { siteId: SITE }), cookie: viewerCookie },
            { ...patch(`/api/devices/${BARE_OLD}/site`, { siteId: SITE }), cookie: null },
        ],
    },
    "device deletion": {
        tables: ["device_deletion_requests", "devices", "agents", "agent_software", "jobs", "tickets"],
        steps: [
            ok(post(`/api/devices/${DEL_BARE}/deletion-requests`), 202),
            ok(post(`/api/devices/${DEL_BARE}/deletion-requests`), 202),
            ok(get(`/api/devices/${DEL_BARE}`), 200),
            get("/api/devices?q=del-"),
            ok(post(`/api/devices/${DEL_THREE_AGENT}/deletion-requests`), 202),
            get(`/api/devices/${DEL_THREE}`),
            ok(post(`/api/devices/${DEL_DONE}/deletion-requests`), 202),
            get(`/api/devices/${DEL_DONE}`),
            ok({ ...post(`/api/devices/${REQ_VIEW}/deletion-requests`), cookie: viewerCookie }, 202),
            ok(post(`/api/devices/${MISSING}/deletion-requests`), 404),
            ok(post(`/api/devices/${DEL_BARE.toUpperCase()}/deletion-requests`), 404),
            ok(post("/api/devices/not-a-uuid/deletion-requests"), 404),
            { ...post(`/api/devices/${DEL_BARE}/deletion-requests`), cookie: null },
            ok({ ...post(`/api/devices/${DEL_BARE}/deletion-requests/approve`), cookie: viewerCookie }, 403),
            ok(post(`/api/devices/${MISSING}/deletion-requests/approve`), 404),
            ok(post(`/api/devices/${DEL_BARE.toUpperCase()}/deletion-requests/approve`), 404),
            ok(post("/api/devices/not-a-uuid/deletion-requests/approve"), 404),
            ok(post(`/api/devices/${DEL_BARE}/deletion-requests/approve`), 201),
            ok(get(`/api/devices/${DEL_BARE}`), 404),
            ok(post(`/api/devices/${DEL_BARE}/deletion-requests/approve`), 404),
            // Approved directly by agent id, with no request made first; agent, software and jobs go too.
            ok(post(`/api/devices/${DEL_AGENT}/deletion-requests/approve`), 201),
            ok(get(`/api/devices/${DEL_AGENT_DEV}`), 404),
            ok(get(`/api/devices/${DEL_AGENT}`), 404),
            ok(post(`/api/devices/${DEL_THREE}/deletion-requests/approve`), 201),
            get("/api/devices?q=del-"),
            // A device coming back under a completed request flips it to pending.
            { sql: `INSERT INTO devices (id, site_id, hostname) VALUES ('${DEL_BARE}','${SITE}','del-bare')` },
            ok(post(`/api/devices/${DEL_BARE}/deletion-requests`), 202),
            get(`/api/devices/${DEL_BARE}`),
            { sql: `UPDATE device_deletion_requests SET status='held' WHERE device_id='${DEL_BARE}'` },
            ok(post(`/api/devices/${DEL_BARE}/deletion-requests`), 202),
            get(`/api/devices/${DEL_BARE}`),
        ],
    },
    "device actions and files": {
        tables: ["jobs"],
        steps: [
            ok(post(`/api/devices/${FILES}/actions/reboot`, { reason: "r" }), 202),
            ok(post(`/api/devices/${FILES_AGENT}/actions/reboot`, {}), 202),
            ok(post(`/api/devices/${FILES}/actions/patch`, {}), 202),
            ok(post(`/api/devices/${FILES_AGENT}/actions/uninstall`, { name: "7-Zip" }), 202),
            post(`/api/devices/${FILES}/actions/uninstall`, {}),
            ok(post(`/api/devices/${BARE_ONLINE}/actions/reboot`, {}), 404),
            ok(post(`/api/devices/${MISSING}/actions/patch`, {}), 404),
            ok(post(`/api/devices/${FILES.toUpperCase()}/actions/reboot`, {}), 404),
            ok(post("/api/devices/not-a-uuid/actions/reboot", {}), 404),
            ok({ ...post(`/api/devices/${FILES}/actions/reboot`, {}), cookie: viewerCookie }, 403),
            ok(get(`/api/devices/${FILES}/files/roots`), 200),
            ok(get(`/api/devices/${FILES_AGENT}/files/roots`), 200),
            // A blank agent_uuid falls back to agents.id, which the job lookup does not accept.
            ok(get(`/api/devices/${BLANK_UUID}/files/roots`), 404),
            ok(get(`/api/devices/${BARE_ONLINE}/files/roots`), 404),
            ok(get(`/api/devices/${MISSING}/files/roots`), 404),
            ok(get(`/api/devices/${FILES.toUpperCase()}/files/roots`), 404),
            ok(get("/api/devices/not-a-uuid/files/roots"), 404),
            ok(get(`/api/devices/${FILES}/files?path=C:%5Cx&recursive=true`), 200),
            ok(get(`/api/devices/${FILES}/files`), 400),
            ok(get(`/api/devices/${FILES}/files/read?path=/a&maxBytes=10`), 200),
            ok(get(`/api/devices/${FILES}/files/read?path=/a&maxBytes=0`), 400),
            ok(post(`/api/devices/${FILES}/files/write`, { path: "/a", contentBase64: "eA==" }), 201),
            ok(post(`/api/devices/${FILES}/files/mkdir`, { path: "/d" }), 201),
            ok(post(`/api/devices/${FILES}/files/delete`, { path: "/d", recursive: true }), 201),
            ok(post(`/api/devices/${FILES}/files/move`, { from: "/a", to: "/b" }), 201),
            ok(post(`/api/devices/${FILES}/files/copy`, { from: "/a", to: "/b", recursive: "yes" }), 201),
            ok(post(`/api/devices/${FILES}/files/move`, { from: " ", to: "/b" }), 400),
            ok({ ...post(`/api/devices/${FILES}/files/write`, { path: "/a", contentBase64: "eA==" }), cookie: viewerCookie }, 403),
            ok(get(`/api/devices/${FILES}/files/roots`, viewerCookie), 200),
            ok(get(`/api/devices/${FILES}/files/roots?wait=true`), 504),
        ],
    },
    "checks definitions": {
        tables: ["checks"],
        steps: [
            ok(get("/api/checks", null), 401),
            ok(get("/api/checks", viewerCookie), 403),
            ok(get("/api/checks"), 501),
            ok(post("/api/checks", checkDto), 501),
            post("/api/checks", {}),
            ok(put(`/api/checks/${MISSING}`, { name: "n" }), 501),
            ok(del(`/api/checks/${MISSING}`), 501),
            ok(post(`/api/checks/${MISSING}/assignments/rebuild`), 501),
            ok(post(`/api/checks/${MISSING}/run`, { deviceIds: [ONLINE] }), 501),
            { ...post(`/api/checks/${MISSING}/assignments/rebuild`), cookie: viewerCookie },
        ],
    },
    "device checks": {
        tables: ["check_assignments", "check_runs"],
        steps: [
            // ChecksReadController owns this path, so it needs checks.read, not devices.read.
            ok(get(`/api/devices/${ONLINE}/checks`, viewerCookie), 403),
            ok(get(`/api/devices/${ONLINE}/checks`), 200),
            ok(get(`/api/devices/${ONLINE_AGENT}/checks`), 200),
            get(`/api/devices/${ONLINE}/checks?limit=2`),
            get(`/api/devices/${ONLINE}/checks?limit=0`),
            get(`/api/devices/${ONLINE}/checks?limit=-4`),
            get(`/api/devices/${ONLINE}/checks?limit=abc`),
            get(`/api/devices/${ONLINE}/checks?limit=9999`),
            get(`/api/devices/${BARE_ONLINE}/checks`),
            get(`/api/devices/${STALE}/checks`),
            ok(get(`/api/devices/${MISSING}/checks`), 200),
            get(`/api/devices/${ONLINE.toUpperCase()}/checks`),
            get("/api/devices/not-a-uuid/checks"),
            { ...get(`/api/devices/${ONLINE}/checks`), cookie: null },
        ],
    },
    "check-runs ingest (text device id)": {
        tables: ["check_assignments", "check_runs"],
        steps: [
            ok(agentPost("/api/agent/check-runs", null, { runs: [{ status: "OK" }] }), 401),
            ok(agentPost("/api/agent/check-runs", "bad-token", { runs: [{ status: "OK" }] }), 401),
            ok(agentGet("/api/agent/assignments", tokenOf(INGEST_AGENT)), 200),
            ok(agentPost("/api/agent/check-runs", tokenOf(INGEST_AGENT), { runs: [] }), 400),
            ok(agentPost("/api/agent/check-runs", tokenOf(INGEST_AGENT), { deviceId: ONLINE, runs: [{ status: "OK" }] }), 403),
            ok(agentPost("/api/agent/check-runs", tokenOf(INGEST_AGENT), {
                deviceId: INGEST,
                runs: [
                    { dedupeKey: "dk1", checkType: "ping", checkName: "Ping A", status: "ok", output: "fine", metrics: { b: 1, a: [1] }, severity: "WARN", startedAt: "2026-02-01T00:00:00Z", finishedAt: "2026-02-01T00:00:01.5Z" },
                    { checkType: " cpu ", checkName: "  Load ", status: "warning", severity: "CRIT" },
                    { dedupeKey: "", checkType: "disk", status: "failing", severity: "X" },
                    { status: "weird" },
                    { dedupeKey: "dk1", checkType: "other", checkName: "Same key in one batch", status: "CRIT" },
                    { checkType: "CPU", checkName: "load", status: "error" },
                ],
            }), 201),
            ok(agentGet("/api/agent/assignments", tokenOf(INGEST_AGENT)), 200),
            ok(agentPost("/api/agent/check-runs", tokenOf(INGEST_AGENT), { runs: [{ dedupeKey: "dk1", checkType: "changed", checkName: "not renamed", status: "OK" }, { dedupeKey: "dk-new", status: "OK", output: "x".repeat(70000) }] }), 201),
            ok(agentPost("/api/agent/check-runs", tokenOf(INGEST_AGENT), { runs: [{ assignmentId: id(701), dedupeKey: "dk-explicit", status: "OK" }] }), 201),
            agentPost("/api/agent/check-runs", tokenOf(INGEST_AGENT), { runs: [{ assignmentId: MISSING, dedupeKey: "dk-fk", status: "OK" }] }),
            agentPost("/api/agent/check-runs", tokenOf(INGEST_AGENT), { runs: [{ assignmentId: "not-a-uuid", dedupeKey: "dk-text", status: "OK" }] }),
            agentPost("/api/agent/check-runs", tokenOf(INGEST_AGENT), { runs: [{ dedupeKey: "dk-date", status: "OK", startedAt: "garbage" }] }),
            ok(agentGet("/api/agent/assignments", tokenOf(INGEST_AGENT)), 200),
            ok(agentGet(`/api/agent/assignments?deviceId=${ONLINE}`, tokenOf(INGEST_AGENT)), 403),
            ok(agentGet(`/api/agent/assignments?deviceId=${INGEST}`, tokenOf(INGEST_AGENT)), 200),
            agentGet("/api/agent/assignments", tokenOf(RUNTIME_AGENT)),
            agentGet("/api/agent/assignments", null),
        ],
    },
    "check-runs ingest (device target)": {
        tables: ["check_assignments", "check_runs"],
        steps: [
            ok(agentPost("/api/agent/ingest/check-runs", null, { deviceId: RUNTIME, runs: [{ status: "OK" }] }), 401),
            ok(agentPost("/api/agent/ingest/check-runs", tokenOf(RUNTIME_AGENT), { deviceId: ONLINE, runs: [{ status: "OK" }] }), 403),
            ok(agentPost("/api/agent/ingest/check-runs", tokenOf(RUNTIME_AGENT), { deviceId: RUNTIME, runs: [] }), 201),
            ok(agentPost("/api/agent/ingest/check-runs", tokenOf(RUNTIME_AGENT), { runs: [] }), 400),
            ok(agentPost("/api/agent/ingest/check-runs", tokenOf(RUNTIME_AGENT), {
                deviceId: RUNTIME,
                runs: [
                    { dedupeKey: "rk1", checkType: "ping", checkName: "Ping A", status: "passing", output: "fine", metrics: { z: 1, a: { b: 2 } }, severity: "high", startedAt: "2026-02-01T00:00:00Z", finishedAt: "2026-02-01T00:00:01.5Z" },
                    { checkType: " cpu ", checkName: "  Load ", status: "WARNING", severity: "medium", finishedAt: "2026-02-02T00:00:00Z" },
                    { checkName: "only name", status: "critical", severity: "low" },
                    { status: "unknownish", severity: "info" },
                    { dedupeKey: "  ", checkType: "disk", status: "timeout", severity: "crit" },
                    { dedupeKey: "rk-sev", status: "FAILED", severity: "nonsense" },
                ],
            }), 201),
            ok(get(`/api/devices/${RUNTIME}/checks`), 200),
            ok(agentPost("/api/agent/ingest/check-runs", tokenOf(RUNTIME_AGENT), { deviceId: RUNTIME, runs: [{ dedupeKey: "rk1", checkType: "changed", checkName: "renamed", status: "CRIT", output: "second", finishedAt: "2026-03-01T00:00:00Z" }] }), 201),
            ok(get(`/api/devices/${RUNTIME_AGENT}/checks`), 200),
            ok(agentPost("/api/agent/ingest/check-runs", tokenOf(RUNTIME_AGENT), { deviceId: RUNTIME, runs: [{ assignmentId: id(707), dedupeKey: "rk2", status: "OK" }] }), 201),
            ok(agentPost("/api/agent/ingest/check-runs", tokenOf(RUNTIME_AGENT), { deviceId: RUNTIME, runs: [{ assignmentId: MISSING, dedupeKey: "rk-fk", status: "OK" }] }), 500),
            ok(agentPost("/api/agent/ingest/check-runs", tokenOf(RUNTIME_AGENT), { deviceId: RUNTIME, runs: [{ assignmentId: "nope", dedupeKey: "rk-text", status: "OK" }] }), 201),
            ok(agentPost("/api/agent/ingest/check-runs", tokenOf(RUNTIME_AGENT), { deviceId: RUNTIME, runs: [{ dedupeKey: "rk-date", status: "OK", startedAt: "garbage" }] }), 500),
            ok(agentPost("/api/agent/ingest/check-runs", tokenOf(RUNTIME_AGENT), { deviceId: RUNTIME, runs: [{ status: 5 }] }), 400),
            ok(get(`/api/devices/${RUNTIME}/checks?limit=3`), 200),
            ok(get(`/api/devices/${BARE_ONLINE}/checks`), 200),
        ],
    },
    provisioning: {
        tables: ["devices", "endpoint_enrollments", "site_enrollment_keys", "installer_bundles", "agents"],
        steps: [
            ok({ ...post("/api/provisioning/endpoints", keyBody({ deviceId: NEW_DEVICE, os: "windows", alias: "new-one" })), cookie: null }, 401),
            ok({ ...post("/api/provisioning/endpoints", keyBody({ deviceId: NEW_DEVICE, os: "windows", alias: "new-one" })), cookie: viewerCookie }, 403),
            ok({ ...post("/api/provisioning/endpoints", keyBody({ deviceId: NEW_DEVICE, os: "windows", alias: " new-one " })), capture: { secret1: "enrollmentSecret" } }, 201),
            ok(get(`/api/devices/${NEW_DEVICE}`), 200),
            ok(post("/api/provisioning/endpoints", keyBody({ deviceId: NEW_DEVICE, os: "linux", alias: "renamed", expiresMinutes: 5 })), 201),
            ok(get(`/api/devices/${NEW_DEVICE}`), 200),
            ok(post("/api/provisioning/endpoints", keyBody({ deviceId: NEW_DEVICE, siteId: SITE2, os: "macos", alias: "moved" })), 201),
            ok(post("/api/provisioning/endpoints", keyBody({ deviceId: NEW_DEVICE2, os: "windows", alias: "dev-online" })), 500),
            ok(get(`/api/devices/${NEW_DEVICE2}`), 404),
            ok(post("/api/provisioning/endpoints", keyBody({ deviceId: NEW_DEVICE2, siteId: MISSING, os: "windows", alias: "x" })), 404),
            ok(post("/api/provisioning/endpoints", keyBody({ deviceId: NEW_DEVICE2, clientId: CLIENT_B, os: "windows", alias: "x" })), 400),
            ok(post("/api/provisioning/endpoints", keyBody({ deviceId: "nope", os: "windows", alias: "x" })), 400),
            ok(post("/api/provisioning/endpoints", keyBody({ deviceId: NEW_DEVICE2, os: "beos", alias: "x" })), 400),
            ok(post("/api/provisioning/endpoints", keyBody({ deviceId: NEW_DEVICE2, os: "windows", alias: "  " })), 400),
            ok(post("/api/provisioning/endpoints", keyBody({ deviceId: NEW_DEVICE2, os: "windows", alias: "x", expiresMinutes: 1441 })), 400),
            ok(post("/api/provisioning/endpoints", keyBody({ deviceId: NEW_DEVICE2, clientId: CLIENT.toUpperCase(), os: "windows", alias: "x" })), 400),
            ok(post("/api/provisioning/endpoints", keyBody({ deviceId: NEW_DEVICE2.toUpperCase(), siteId: SITE.toUpperCase(), os: "windows", alias: "upper" })), 201),
            get(`/api/devices/${NEW_DEVICE2}`),
            ok({ ...post("/api/provisioning/enrollment-keys", keyBody()), cookie: viewerCookie }, 403),
            ok({ ...post("/api/provisioning/enrollment-keys", keyBody({ name: " site key " })), capture: { key: "enrollmentKey" } }, 201),
            ok({ ...post("/api/provisioning/enrollment-keys", keyBody({ name: "   ", expiresMinutes: 60 })), capture: { key2: "enrollmentKey" } }, 201),
            ok({ ...post("/api/provisioning/enrollment-keys", keyBody()), capture: { keyRevoked: "enrollmentKey", keyRevokedId: "tokenId" } }, 201),
            ok({ ...post("/api/provisioning/enrollment-keys", keyBody()), capture: { keyExpired: "enrollmentKey", keyExpiredId: "tokenId" } }, 201),
            ok(post("/api/provisioning/enrollment-keys", keyBody({ siteId: MISSING })), 404),
            ok(post("/api/provisioning/enrollment-keys", keyBody({ clientId: CLIENT_B })), 400),
            ok(post("/api/provisioning/enrollment-keys", keyBody({ expiresMinutes: 0 })), 400),
            ok(post("/api/provisioning/enrollment-keys", keyBody({ expiresMinutes: 43201 })), 400),
            ok(post("/api/provisioning/enrollment-keys", keyBody({ siteId: "x" })), 400),
            { sql: `UPDATE site_enrollment_keys SET revoked_at = now() WHERE id = '{keyRevokedId}'; UPDATE site_enrollment_keys SET expires_at = now() - interval '1 minute' WHERE id = '{keyExpiredId}'` },
            ok({ ...post("/api/provisioning/installer-bundles", { enrollmentKey: "{key}", os: "windows" }), cookie: viewerCookie }, 403),
            ok({ ...post("/api/provisioning/installer-bundles", { enrollmentKey: "{key}", os: "windows" }), capture: { win: "bundleId", winUrl: "url" } }, 201),
            ok({ ...post("/api/provisioning/installer-bundles", { enrollmentKey: "{key}", os: "linux", label: "Huber Heights!" }), capture: { lin: "bundleId", linUrl: "url" } }, 201),
            ok({ ...post("/api/provisioning/installer-bundles", { enrollmentKey: "{key2}", os: "macos" }), capture: { mac: "bundleId", macUrl: "url" } }, 201),
            ok({ ...post("/api/provisioning/installer-bundles", { enrollmentKey: "{key}", os: "windows" }), capture: { old: "bundleId", oldUrl: "url" } }, 201),
            ok(post("/api/provisioning/installer-bundles", { enrollmentKey: "{keyRevoked}", os: "windows" }), 401),
            ok(post("/api/provisioning/installer-bundles", { enrollmentKey: "{keyExpired}", os: "windows" }), 401),
            ok(post("/api/provisioning/installer-bundles", { enrollmentKey: "nope", os: "windows" }), 401),
            ok(post("/api/provisioning/installer-bundles", { enrollmentKey: "   ", os: "windows" }), 400),
            ok(post("/api/provisioning/installer-bundles", { enrollmentKey: "{key}", os: "beos" }), 400),
            { sql: `UPDATE installer_bundles SET expires_at = now() - interval '1 minute' WHERE id = '{old}'` },
            ok({ path: "{winUrl}", cookie: null, scrub: true }, 200),
            ok({ path: "{linUrl}", cookie: null, scrub: true }, 200),
            ok({ path: "{macUrl}", cookie: null, scrub: true }, 200),
            ok({ path: "{oldUrl}", cookie: null }, 404),
            ok({ path: "/api/provisioning/installer-bundles/{win}/download", cookie: null }, 401),
            ok({ path: "/api/provisioning/installer-bundles/{win}/download?token=%20", cookie: null }, 401),
            ok({ path: "/api/provisioning/installer-bundles/{win}/download?token=wrong", cookie: null }, 404),
            ok({ path: `/api/provisioning/installer-bundles/${MISSING}/download?token=wrong`, cookie: null }, 404),
            ok({ path: "/api/provisioning/installer-bundles/not-a-uuid/download?token=wrong", cookie: null }, 500),
            ok({ path: "{winPkg}", cookie: null, scrub: true }, 200),
            ok({ path: "{linPkg}", cookie: null }, 404),
            ok({ path: "{oldPkg}", cookie: null }, 404),
            ok({ path: "/api/provisioning/installer-bundles/{win}/agent-package", cookie: null }, 401),
            ok({ path: "/api/provisioning/installer-bundles/{win}/agent-package?token=wrong", cookie: null }, 404),
            ok({ path: "/api/provisioning/installer-bundles/not-a-uuid/agent-package?token=wrong", cookie: null }, 500),
            // Enrollment with what provisioning issued.
            ok({ ...enroll({ enrollmentKey: "{key}", deviceId: ENROLLED, hostname: "enrolled-one" }), capture: { enrolledToken: "agentToken" } }, 201),
            ok(enroll({ enrollmentKey: "{key2}", deviceId: ENROLLED2, hostname: "enrolled-two" }), 201),
            ok({ ...enroll({ enrollmentSecret: "{secret1}", deviceId: NEW_DEVICE, hostname: "one-time" }), capture: { oneTimeToken: "agentToken" } }, 201),
            ok(enroll({ enrollmentKey: "{keyRevoked}", deviceId: DENIED, hostname: "denied" }), 401),
            ok(enroll({ enrollmentKey: "{keyExpired}", deviceId: DENIED, hostname: "denied" }), 401),
            ok(enroll({ enrollmentSecret: "{secret1}", deviceId: NEW_DEVICE, hostname: "again" }), 401),
            ok(get(`/api/devices/${ENROLLED}`), 200),
            ok(get(`/api/devices/${DENIED}`), 404),
            ok(agentPost("/api/agent/ingest/check-runs", "{enrolledToken}", { deviceId: ENROLLED, runs: [{ dedupeKey: "after-enroll", status: "OK" }] }), 201),
            ok(agentPost("/api/agent/check-runs", "{oneTimeToken}", { runs: [{ dedupeKey: "after-enroll", status: "OK" }] }), 201),
            ok(get(`/api/devices/${ENROLLED}/checks`), 200),
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
    assert.equal(mode, "run", "usage: parity-batch4.e2e.cjs seed|run");

    let compared = 0;
    let succeeded = 0;
    const failures = [];
    const fail = (label, a, b) => {
        failures.push(label);
        console.log(`  DIFF  ${label}\n        A: ${JSON.stringify(a).slice(0, 900)}\n        B: ${JSON.stringify(b).slice(0, 900)}`);
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
            const label = `${name} step ${i}: ${step.method ?? "GET"} ${step.path}`;
            if (!same(a, b)) fail(label, a, b);
            if (step.expect && a.status !== step.expect) fail(`${label}: expected ${step.expect} on the old build`, a, b);
        }
        for (const table of mod.tables) {
            const [a, b] = await Promise.all([rows(dbA, table), rows(dbB, table)]);
            compared++;
            if (!same(a, b)) {
                const onlyA = a.filter((r) => !b.includes(r));
                const onlyB = b.filter((r) => !a.includes(r));
                fail(`${name} rows: ${table} (${a.length} vs ${b.length})`, onlyA, onlyB);
            }
        }
        // Check definitions are all 501 placeholders, pinned by `expect` above.
        if (ok2xx === 0 && name !== "checks definitions") fail(`${name}: no step succeeded, so nothing real was compared`, 0, 0);
        succeeded += ok2xx;
        if (failures.length === before) console.log(`  ok    ${mod.steps.length} steps`);
    }

    const check = async (label, fn) => {
        try {
            await fn();
            console.log(`  ok    ${label}`);
        } catch (e) {
            fail(label, "", String(e?.message ?? e));
        }
    };

    console.log("device status rule and paging (both builds)");
    for (const [base, db] of [[BASE_A, dbA], [BASE_B, dbB]]) {
        await db.query(freshTimes.sql);
        await check(`online within 5 minutes, otherwise offline: ${base}`, async () => {
            const res = await request(base, get("/api/devices?pageSize=200"));
            const status = Object.fromEntries(res.body.items.map((d) => [d.id, d.status]));
            assert.equal(status[ONLINE], "online");
            assert.equal(status[STALE], "offline", "agent check-in decides, not the device's last_seen_at");
            assert.equal(status[NEVER], "offline");
            assert.equal(status[BARE_ONLINE], "online");
            assert.equal(status[BARE_OLD], "offline");
            assert.equal(status[id(132)], "offline", "never seen");
        });
        await check(`pages walk every device once, in order: ${base}`, async () => {
            const all = (await request(base, get("/api/devices?pageSize=200"))).body.items.map((d) => d.id);
            const walked = [];
            let cursor = "";
            for (;;) {
                const res = await fetch(`${base}/api/devices?pageSize=3${cursor ? `&cursor=${cursor}` : ""}`, { headers: { cookie: `${COOKIE}=${adminCookie}` } });
                const page = await res.json();
                walked.push(...page.items.map((d) => d.id));
                if (!page.nextCursor) break;
                cursor = page.nextCursor;
            }
            assert.deepEqual(walked, all);
        });
    }

    console.log("intentional difference");
    const dupBatch = agentPost("/api/agent/ingest/check-runs", tokenOf(DUP_AGENT), {
        deviceId: DUP,
        runs: [{ dedupeKey: "same", checkName: "first", status: "OK" }, { dedupeKey: "same", checkName: "second", status: "CRIT" }],
    });
    const [dupOld, dupNew] = await Promise.all([request(BASE_A, dupBatch), request(BASE_B, dupBatch)]);
    console.log(`  info  two runs of one check in a batch: old ${dupOld.status}, new ${dupNew.status}`);
    if (dupOld.status !== 500 || dupNew.status !== 201) fail("duplicate key in a batch: expected old 500 and new 201", dupOld, dupNew);
    const dupRows = await dbB.query(`SELECT check_name FROM check_assignments WHERE target_id = $1`, [DUP]);
    const dupRuns = await dbB.query(`SELECT count(*)::int AS n FROM check_runs r JOIN check_assignments a ON a.id = r.assignment_id WHERE a.target_id = $1`, [DUP]);
    if (!same(dupRows.rows, [{ check_name: "second" }]) || dupRuns.rows[0].n !== 2) fail("duplicate key stores one assignment and both runs", dupRows.rows, dupRuns.rows);

    console.log("concurrency (new build)");
    await check("12 concurrent device-target ingests", async () => {
        const res = await Promise.all(Array.from({ length: 12 }, () => request(BASE_B, agentPost("/api/agent/ingest/check-runs", tokenOf(BURST_AGENT), { deviceId: BURST, runs: [{ dedupeKey: "b1", status: "OK" }, { dedupeKey: "b2", status: "OK" }] }))));
        assert.deepEqual(res.map((r) => r.status), Array(12).fill(201));
        const { rows: r } = await dbB.query(`SELECT count(*)::int AS n FROM check_assignments WHERE target_id = $1`, [BURST]);
        assert.equal(r[0].n, 2);
    });
    await check("12 concurrent text-device ingests", async () => {
        const res = await Promise.all(Array.from({ length: 12 }, () => request(BASE_B, agentPost("/api/agent/check-runs", tokenOf(BURST2_AGENT), { runs: [{ dedupeKey: "b1", status: "OK" }, { checkType: "t", checkName: "n", status: "OK" }] }))));
        assert.deepEqual(res.map((r) => r.status), Array(12).fill(201));
        const { rows: r } = await dbB.query(`SELECT count(*)::int AS n, sum((SELECT count(*) FROM check_runs cr WHERE cr.assignment_id = ca.id))::int AS runs FROM check_assignments ca WHERE device_id = $1`, [BURST2]);
        assert.deepEqual(r[0], { n: 2, runs: 24 });
    });
    await check("12 concurrent deletion requests", async () => {
        const res = await Promise.all(Array.from({ length: 12 }, () => request(BASE_B, post(`/api/devices/${BURST}/deletion-requests`))));
        assert.deepEqual(res.map((r) => r.status), Array(12).fill(202));
    });

    // Code with no HTTP route, called directly on the new build.
    if (process.env.DIST_B) {
        console.log("direct calls (new build)");
        process.env.DATABASE_URL = DB_B;
        const load = (p) => require(`${process.env.DIST_B}/${p}`);
        const { PrismaService } = load("storage/prisma.service.js");
        const prisma = new PrismaService();
        const sockets = { broadcastToDevice: () => 0 };
        await check("ChecksService.listByDevice: latest run per assignment, newest first", async () => {
            const { ChecksService } = load("checks/checks.service.js");
            const svc = new ChecksService(prisma, sockets);
            await dbB.query(`INSERT INTO check_assignments (id, device_id, dedupe_key, check_name) VALUES ('${id(801)}','text-dev','a','named'), ('${id(802)}','text-dev','b',''), ('${id(803)}','other','c','x')`);
            await dbB.query(`INSERT INTO check_runs (assignment_id, device_id, status, output, finished_at) VALUES
                ('${id(801)}','text-dev','OK','old','2026-01-01'), ('${id(801)}','text-dev','CRIT','new','2026-01-02'), ('${id(801)}','elsewhere','OK','ignored','2026-02-01')`);
            const { items } = await svc.listByDevice("text-dev");
            assert.deepEqual(items.map((i) => [i.id, i.name, i.status, i.output]), [[id(801), "named", "Failing", "new"], [id(802), "Check", "Failing", ""]]);
            assert.equal((await svc.listByDevice("text-dev", 0)).items.length, 1);
            assert.deepEqual(await svc.listByDevice("nothing"), { items: [] });
        });
        await check("ChecksRuntimeService.getAssignmentsForDevice and unknown agents", async () => {
            const { ChecksRuntimeService } = load("checks/checks.runtime.service.js");
            const svc = new ChecksRuntimeService(prisma, sockets);
            const { items } = await svc.getAssignmentsForDevice(RUNTIME_AGENT);
            assert.ok(items.some((i) => i.dedupeKey === "rk1" && i.name === "renamed" && i.intervalSec === 60));
            assert.deepEqual(await svc.getAssignmentsForDevice("nope"), { items: [] });
            assert.deepEqual(await svc.getAssignmentsForDevice(ONLINE.toUpperCase()), { items: [] });
            assert.deepEqual(await svc.ingestAgentRuns({ agentId: "nope", deviceId: "x", runs: [{ status: "OK" }] }), { inserted: 0, assignmentsCreated: 0 });
            assert.deepEqual(await svc.ingestAgentRuns({ agentId: MISSING, deviceId: "x", runs: [] }), { inserted: 0, assignmentsCreated: 0 });
        });
        await check("shadowed DevicesController.checks: empty for a device, 404 otherwise", async () => {
            const { DevicesController } = load("devices/devices.controller.js");
            const { DevicesService } = load("devices/devices.service.js");
            const ctl = new DevicesController(new DevicesService(prisma));
            assert.deepEqual(await ctl.checks(ONLINE), { items: [] });
            await assert.rejects(ctl.checks(MISSING), /Device not found/);
        });
        await check("device deletion rolls back as a whole", async () => {
            const { DevicesService } = load("devices/devices.service.js");
            const svc = new DevicesService(prisma);
            await dbB.query(`CREATE OR REPLACE FUNCTION parity_block() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'blocked'; END $$ LANGUAGE plpgsql`);
            await dbB.query(`CREATE TRIGGER parity_block BEFORE DELETE ON devices FOR EACH ROW EXECUTE FUNCTION parity_block()`);
            try {
                await assert.rejects(svc.approveAndDeleteDevice(ONLINE, ADMIN));
            } finally {
                await dbB.query(`DROP TRIGGER parity_block ON devices; DROP FUNCTION parity_block()`);
            }
            const { rows: left } = await dbB.query(`SELECT (SELECT count(*)::int FROM agents WHERE device_id=$1) AS agents, (SELECT count(*)::int FROM agent_software WHERE agent_id=$2) AS software, (SELECT count(*)::int FROM device_deletion_requests WHERE device_id=$1) AS requests`, [ONLINE, ONLINE_AGENT]);
            assert.deepEqual(left[0], { agents: 1, software: 5, requests: 0 });
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
