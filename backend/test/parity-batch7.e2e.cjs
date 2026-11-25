#!/usr/bin/env node
// Compares two backend builds for the backups module, each on its own throwaway database.
// Every step runs against both, then responses and the resulting rows must match. It also
// runs real backups and restores, and races parallel workers on the new build.
//
//   node test/parity-batch7.e2e.cjs seed     (before the backends start)
//   node test/parity-batch7.e2e.cjs run      (once both are up)
//
// Required env: RIQ_E2E_ALLOW=1, JWT_SECRET, BASE_A, BASE_B, DB_A, DB_B, DB_C, DB_VERIFY,
// DEST_DIR (shared destination folder), DIST_B (new build's dist, for direct calls).
// It writes test rows, so it refuses any database whose name lacks "e2e".
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");
const { Client } = require("pg");
const jwt = require("jsonwebtoken");

const { JWT_SECRET: SECRET, BASE_A, BASE_B, DB_A, DB_B, DB_C, DB_VERIFY, DEST_DIR: ROOT, DIST_B } = process.env;
// Each build gets its own folder: archive names only have one-second resolution.
const DEST = "{dest}";
const COOKIE = process.env.AUTH_COOKIE_NAME || "auth_token";

const safe = (url) => {
    try {
        return /e2e/.test(new URL(url).pathname);
    } catch {
        return false;
    }
};
if (process.env.RIQ_E2E_ALLOW !== "1" || !SECRET || ![DB_A, DB_B, DB_C, DB_VERIFY].every(safe) || !ROOT || !DIST_B) {
    console.error("Refusing to run: set RIQ_E2E_ALLOW=1, JWT_SECRET, DEST_DIR, DIST_B and e2e-named DB_A, DB_B, DB_C, DB_VERIFY.");
    process.exit(2);
}

const ORG = "11111111-1111-4111-8111-111111111111";
const ADMIN = "22222222-2222-4222-8222-222222222222";
const VIEWER = "33333333-3333-4333-8333-333333333333";
const ADMIN_ROLE = "44444444-4444-4444-8444-444444444444";
const VIEWER_ROLE = "55555555-5555-4555-8555-555555555555";
const SESSION = "66666666-6666-4666-8666-666666666666";
const SITE = "a0000000-0000-4000-8000-000000000004";
const CLIENT = "a0000000-0000-4000-8000-000000000003";
const DEVICE = "a0000000-0000-4000-8000-000000000001";
const SEEDED_DEST = "a0000000-0000-4000-8000-000000000021";
const OTHER_POLICY = "a0000000-0000-4000-8000-000000000022";
const MISSING = "a0000000-0000-4000-8000-0000000000ff";
const CONN = {
    s3: "a0000000-0000-4000-8000-000000000031",
    nextcloud: "a0000000-0000-4000-8000-000000000032",
    gdrive: "a0000000-0000-4000-8000-000000000033",
    sftp: "a0000000-0000-4000-8000-000000000034",
};
const job = (n) => `b0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const JOB = {
    done: job(1), failed: job(2), running: job(3), cancelled: job(4), oldDone: job(5), oldFailedNoFinish: job(6),
    oldRunning: job(7), recentDone: job(8), noLocation: job(9), missingFile: job(10), s3: job(11), s3NoConn: job(12),
    nextcloud: job(13), gdrive: job(14), remote: job(15), weirdKind: job(16), ncNoConn: job(17), pgNoSum: job(18),
    pgNoManifest: job(19), otherPolicyOld: job(20), noLog: job(21), failedNoDest: job(22), runningToo: job(23),
};
const SECRETS = {
    s3: "s3-secret-key-b7", nextcloud: "nextcloud-secret-b7", sftp: "sftp-secret-b7", gdrive: "gdrive-secret-b7",
};
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi;
// Generated ids differ between the databases; fixture ids are fixed and compared.
const isFixtureId = (s) => /^[abc]0000000-/.test(s) || /^(.)\1{7}-/.test(s);

const token = (sub, jti) => jwt.sign({ sub, email: `${sub}@example.test`, jti }, SECRET, { expiresIn: "1h" });
const adminCookie = token(ADMIN, SESSION);
const viewerCookie = token(VIEWER, crypto.randomUUID());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function insertJob(db, id, fields) {
    const row = { id, status: "completed", ...fields };
    const keys = Object.keys(row);
    await db.query(
        `INSERT INTO backup_jobs (${keys.join(",")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(",")})`,
        keys.map((k) => (row[k] && typeof row[k] === "object" && !(row[k] instanceof Date) ? JSON.stringify(row[k]) : row[k])),
    );
}

async function seedUsers(db) {
    await db.query(`INSERT INTO organizations (id, name, slug) VALUES ($1,'Default Organization','default')`, [ORG]);
    for (const [id, name] of [[ADMIN, "admin"], [VIEWER, "viewer"]]) {
        await db.query(
            `INSERT INTO users (id, organization_id, email, first_name, last_name, status, password_hash, created_at, updated_at)
             VALUES ($1,$2,$3,'Parity',$4,'active','hash-kept-in-backups','2026-01-01Z','2026-01-01Z')`,
            [id, ORG, `${name}@example.test`, name],
        );
    }
    const backupPerms = ["read", "manage", "run", "prune", "restore", "download"].map((p) => `backups.${p}`);
    for (const [id, user, perms] of [
        [ADMIN_ROLE, ADMIN, backupPerms],
        [VIEWER_ROLE, VIEWER, ["backups.read"]],
    ]) {
        await db.query(
            `INSERT INTO roles (id, organization_id, scope, name, created_at, updated_at) VALUES ($1,$2,'organization',$3,'2026-01-01Z','2026-01-01Z')`,
            [id, ORG, `parity-${id}`],
        );
        await db.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)`, [user, id]);
        for (const perm of perms) {
            await db.query(`INSERT INTO role_permissions (role_id, permission_key) VALUES ($1,$2)`, [id, perm]);
        }
    }
    await db.query(`INSERT INTO clients (id, organization_id, name) VALUES ($1,$2,'Parity Client')`, [CLIENT, ORG]);
    await db.query(`INSERT INTO sites (id, client_id, name) VALUES ($1,$2,'Parity Site')`, [SITE, CLIENT]);
    await db.query(
        `INSERT INTO devices (id, site_id, hostname, created_at, updated_at) VALUES ($1,$2,'parity-host','2026-01-01Z','2026-01-01Z')`,
        [DEVICE, SITE],
    );
    await db.query(
        `INSERT INTO organization_settings (organization_id, branding, created_at, updated_at) VALUES ($1,'{"name":"x","n":1.5}','2026-01-01Z','2026-01-01Z')
         ON CONFLICT (organization_id) DO UPDATE SET branding=EXCLUDED.branding, created_at=EXCLUDED.created_at, updated_at=EXCLUDED.updated_at`,
        [ORG],
    );
    await db.query(`INSERT INTO sessions (id, user_id, refresh_token) VALUES ($1,$2,'x')`, [SESSION, ADMIN]);
    const connections = [
        [CONN.s3, "s3", { endpoint: "http://127.0.0.1:1", region: "us-east-1", bucket: "bkt", forcePathStyle: true }, { accessKeyId: "AKIDB7", secretAccessKey: SECRETS.s3 }],
        [CONN.nextcloud, "nextcloud", { webdavUrl: "http://127.0.0.1:1/dav", username: "nc", path: "/b" }, { password: SECRETS.nextcloud }],
        [CONN.gdrive, "gdrive", { folderId: "folder" }, { serviceAccountJson: JSON.stringify({ type: "service_account", client_email: "x@example.test", private_key: SECRETS.gdrive }) }],
        [CONN.sftp, "sftp", { host: "127.0.0.1", port: 1, username: "sf", path: "/b" }, { password: SECRETS.sftp }],
    ];
    for (const [id, kind, config, secrets] of connections) {
        await db.query(
            `INSERT INTO storage_connections (id, organization_id, name, kind, config, secrets) VALUES ($1,$2,$3,$4,$5,$6)`,
            [id, ORG, `parity-${kind}`, kind, JSON.stringify(config), JSON.stringify(secrets)],
        );
    }
}

async function seedDb(db, DEST) {
    await seedUsers(db);
    await db.query(
        `INSERT INTO backup_destinations (id, organization_id, name, provider, configuration, created_at, updated_at)
         VALUES ($1,$2,'Seeded','local',$3,'2026-01-01Z','2026-01-01Z')`,
        [SEEDED_DEST, ORG, JSON.stringify({ kind: "local", path: DEST })],
    );
    const at = (s) => new Date(s);
    const snapshot = {
        version: 1, backupKind: "logical", artifactFormat: "ndjson-tar-gz", targets: ["users", "roles"],
        destination: { kind: "local", path: DEST }, extraDestinations: [], notifications: {}, minSuccess: 1, parallelism: 1,
    };
    const local = (name) => ({ kind: "local", path: `${DEST}/${name}` });
    await insertJob(db, JOB.done, {
        verified: true, size_bytes: "9007199254740993", duration_sec: 12, note: "Nightly DONE", archive_name: "fixture.bin",
        checksum: "a".repeat(64), started_at: at("2026-03-10T05:00:00Z"), finished_at: at("2026-03-10T05:00:12Z"), artifact_location: local("fixture.bin"),
    });
    await db.query(`INSERT INTO backup_job_logs (job_id, log_text, created_at, updated_at) VALUES ($1,'line one\nline two\n','2026-01-01Z','2026-01-01Z')`, [JOB.done]);
    await db.query(`INSERT INTO backup_job_manifests (job_id, manifest, created_at, updated_at) VALUES ($1,$2,'2026-01-01Z','2026-01-01Z')`, [JOB.done, JSON.stringify({ id: JOB.done, nested: { a: [1, 2, null] } })]);
    await insertJob(db, JOB.failed, {
        status: "failed", verified: false, note: "Boom 100% _x_", error: "Boom", started_at: at("2026-03-11T23:30:00Z"), finished_at: at("2026-03-11T23:31:00Z"),
        config_snapshot: snapshot, min_success: 1, parallelism: 1,
    });
    await db.query(`INSERT INTO backup_job_destinations (job_id, destination_id, is_primary, priority) VALUES ($1,$2,true,7)`, [JOB.failed, SEEDED_DEST]);
    await insertJob(db, JOB.failedNoDest, { status: "failed", note: "no dest", started_at: at("2026-03-11T00:00:00Z"), config_snapshot: snapshot });
    await insertJob(db, JOB.running, { status: "running", note: "in flight", started_at: at("2026-03-12T00:00:00Z"), config_snapshot: snapshot });
    await insertJob(db, JOB.runningToo, { status: "running", note: null, started_at: at("2026-03-12T00:00:01Z") });
    await insertJob(db, JOB.cancelled, { status: "cancelled", cancelled: true, note: "x", started_at: at("2026-03-13T00:00:00Z"), finished_at: at("2026-03-13T00:01:00Z") });
    await insertJob(db, JOB.oldDone, { note: "old done", started_at: at("2020-01-01T00:00:00Z"), finished_at: at("2020-01-01T00:01:00Z") });
    await insertJob(db, JOB.oldFailedNoFinish, { status: "failed", note: "old failed", started_at: at("2020-01-02T00:00:00Z") });
    await insertJob(db, JOB.oldRunning, { status: "running", note: "old running", started_at: at("2020-01-03T00:00:00Z") });
    await db.query(
        `INSERT INTO backup_jobs (id, status, note, started_at, finished_at)
         VALUES ($1,'completed','recent finish, old start','2020-01-04Z', now() - interval '1 day')`,
        [JOB.recentDone],
    );
    await insertJob(db, JOB.noLocation, { note: "no location", started_at: at("2026-02-01T00:00:00Z") });
    await insertJob(db, JOB.noLog, { status: "failed", note: "no log", started_at: at("2026-02-01T00:00:01Z") });
    await insertJob(db, JOB.missingFile, { note: "gone", started_at: at("2026-02-02T00:00:00Z"), artifact_location: local("gone.bin") });
    await insertJob(db, JOB.s3, { note: "s3", started_at: at("2026-02-03T00:00:00Z"), artifact_location: { kind: "s3", bucket: "bkt", key: "p/a.tar.gz", connectionId: CONN.s3 } });
    await insertJob(db, JOB.s3NoConn, { note: "s3 no conn", started_at: at("2026-02-04T00:00:00Z"), artifact_location: { kind: "s3", bucket: "bkt", key: "p/a.tar.gz" } });
    await insertJob(db, JOB.nextcloud, { note: "nc", started_at: at("2026-02-05T00:00:00Z"), artifact_location: { kind: "nextcloud", connectionId: CONN.nextcloud, path: "/b/a.tar.gz" } });
    await insertJob(db, JOB.ncNoConn, { note: "nc none", started_at: at("2026-02-05T00:00:01Z"), artifact_location: { kind: "nextcloud", connectionId: MISSING, path: "/b/a.tar.gz" } });
    await insertJob(db, JOB.gdrive, { note: "gd", started_at: at("2026-02-06T00:00:00Z"), artifact_location: { kind: "gdrive", connectionId: CONN.gdrive, fileId: "f", name: "a.tar.gz" } });
    await insertJob(db, JOB.remote, { note: "sf", started_at: at("2026-02-07T00:00:00Z"), artifact_location: { kind: "remote", connectionId: CONN.sftp, path: "/b/a.tar.gz" } });
    await insertJob(db, JOB.weirdKind, { note: "weird", started_at: at("2026-02-08T00:00:00Z"), artifact_location: { kind: "ftp" } });
    await insertJob(db, JOB.pgNoSum, { backup_kind: "postgresql", verified: true, note: "pg no sum", started_at: at("2026-02-09T00:00:00Z") });
    await insertJob(db, JOB.pgNoManifest, { backup_kind: "postgresql", verified: true, checksum: "b".repeat(64), note: "pg no manifest", started_at: at("2026-02-10T00:00:00Z"), artifact_location: local("fixture.bin") });
    await db.query(
        `INSERT INTO backup_jobs (id, status, note, started_at, finished_at)
         SELECT ('c0000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, 'completed', 'page ' || n,
                timestamptz '2025-01-01Z' + n * interval '1 hour', timestamptz '2025-01-01Z' + n * interval '1 hour'
           FROM generate_series(1, 55) AS n`,
    );
}

// Volatile fields are compared for presence only. Sizes and times of generated rows vary by
// a few bytes and seconds between builds, so only fixture rows compare them exactly.
function scrub(text) {
    return text
        .split(`${ROOT}/a`).join("<dest>")
        .split(`${ROOT}/b`).join("<dest>")
        .replace(/backup_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.tar\.gz/g, "<archive>")
        .replace(/remoteiq-postgresql_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.dump/g, "<dump>")
        .replace(/remoteiq_restore_[0-9a-f]+/g, "<restoredb>")
        .replace(/riq_e2e_[ab]\b/g, "<db>")
        .replace(/\b[0-9a-f]{64}\b/g, "<sha>")
        .replace(/\b\d+ bytes\b/g, "<n> bytes")
        .replace(/\b(in|Duration=)\s?\d+s\b/g, "$1 <n>s")
        .replace(/Size=\d+/g, "Size=<n>")
        .replace(/remoteiq-(bkp|restore)-\w+/g, "<tmp>")
        .replace(UUID, (id) => (isFixtureId(id) ? id : "<uuid>"));
}
function normalize(value) {
    if (Array.isArray(value)) return value.map(normalize);
    if (value instanceof Date) return "<time>";
    if (value && typeof value === "object") {
        // A fixture id can still carry a real run's archive, whose size and time vary.
        const ranForReal = typeof value.archive_name === "string" && value.archive_name !== "fixture.bin";
        const generated = ranForReal || !(typeof value.id === "string" && isFixtureId(value.id));
        const out = {};
        for (const key of Object.keys(value).sort()) {
            const volatile =
                (/(_at|At|^lastUpdated)$/.test(key) && value[key] !== null) ||
                (generated && /^(size_bytes|sizeBytes|bytes|duration_sec|durationSec|at|port|logSha256)$/.test(key) && value[key] !== null);
            out[key] = volatile ? "<volatile>" : normalize(value[key]);
        }
        return out;
    }
    if (typeof value === "string") return scrub(value);
    if (typeof value === "bigint") return String(value);
    return value;
}

// {name} in a path, body or SQL becomes the id captured from that build's earlier response.
const fill = (text, vars) => text.replace(/\{(\w+)\}/g, (m, name) => vars[name] ?? m);

async function request(base, { method = "GET", path: p, body, cookie = adminCookie, capture, binary }, vars = {}) {
    const res = await fetch(`${base}${fill(p, vars)}`, {
        method,
        redirect: "manual",
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
    // A presigned URL carries a time and signature, so compare where it points.
    const location = res.headers.get("location")?.split("?")[0];
    const disposition = res.headers.get("content-disposition");
    return {
        status: res.status,
        body: binary ? `<${text.length > 0 ? "bytes" : "empty"}>` : normalize(parsed),
        ...(location ? { location } : {}),
        ...(disposition ? { disposition: scrub(disposition) } : {}),
    };
}

const get = (p, cookie) => ({ path: p, cookie });
const archive = (p) => ({ path: p, binary: true });
const post = (p, body, capture) => ({ method: "POST", path: p, body, capture });
const put = (p, body) => ({ method: "PUT", path: p, body });
const API = "/api/admin/backups";
const waitDone = (id, table = "backup_jobs") => ({
    wait: `SELECT 1 FROM ${table} WHERE id='{${id}}' AND status NOT IN ('queued','running')`,
});

const baseConfig = (over = {}) => ({
    enabled: true,
    targets: ["users", "roles", "devices", "settings"],
    schedule: "daily",
    retentionDays: 30,
    destination: { kind: "local", path: `${DEST}/primary` },
    notifications: { email: false },
    parallelism: 1,
    minSuccess: 1,
    ...over,
});

const JOB_TABLES = [
    "backup_jobs", "backup_job_destinations", "backup_job_logs", "backup_job_manifests", "backup_job_artifacts", "backup_restores",
];
const CONFIG_TABLES = ["backup_policies", "backup_destinations", "backup_policy_destinations"];

const MODULES = {
    "permissions and auth": {
        tables: [],
        steps: [
            get(`${API}/config`, null),
            get(`${API}/permissions`, null),
            get(`${API}/permissions`),
            get(`${API}/permissions`, viewerCookie),
            get(`${API}/config`, viewerCookie),
            { method: "PUT", path: `${API}/config`, body: baseConfig(), cookie: viewerCookie },
            { method: "POST", path: `${API}/run`, cookie: viewerCookie },
            { method: "POST", path: `${API}/prune`, cookie: viewerCookie },
            { method: "POST", path: `${API}/test-destination`, body: { destination: { kind: "local", path: DEST } }, cookie: viewerCookie },
            { method: "POST", path: `${API}/${JOB.failed}/retry`, cookie: viewerCookie },
            { method: "POST", path: `${API}/${JOB.running}/cancel`, cookie: viewerCookie },
            { method: "POST", path: `${API}/${JOB.done}/restore`, cookie: viewerCookie },
            get(`${API}/${JOB.done}/download`, viewerCookie),
            get(`${API}/${JOB.done}/log`, viewerCookie),
        ],
    },
    "no policy yet": {
        tables: CONFIG_TABLES,
        steps: [
            get(`${API}/config`),
            post(`${API}/run`),
            post(`${API}/prune`),
            get(`${API}/history`),
            get(`${API}/history?status=running`),
        ],
    },
    "config save": {
        tables: CONFIG_TABLES,
        steps: [
            put(`${API}/config`, baseConfig({ encrypt: true })),
            put(`${API}/config`, baseConfig({ targets: [] })),
            put(`${API}/config`, baseConfig({ targets: ["users", "nonsense"] })),
            put(`${API}/config`, baseConfig({ targets: "users" })),
            put(`${API}/config`, baseConfig({ schedule: "cron" })),
            put(`${API}/config`, baseConfig({ schedule: "never" })),
            put(`${API}/config`, baseConfig({ cronExpr: "bad" })),
            put(`${API}/config`, baseConfig({ retentionDays: 0 })),
            put(`${API}/config`, baseConfig({ retentionDays: "30" })),
            put(`${API}/config`, baseConfig({ backupKind: "physical" })),
            put(`${API}/config`, baseConfig({ destination: { kind: "local", path: "relative/path" } })),
            put(`${API}/config`, baseConfig({ destination: { kind: "local", path: `${DEST}/../x` } })),
            put(`${API}/config`, baseConfig({ destination: { kind: "remote", connectionId: CONN.sftp, path: "/x" } })),
            put(`${API}/config`, baseConfig({ destination: { kind: "s3" } })),
            put(`${API}/config`, baseConfig({ destination: { kind: "nextcloud", connectionId: CONN.nextcloud, path: "x" } })),
            put(`${API}/config`, baseConfig({ destination: {} })),
            put(`${API}/config`, baseConfig({ extraDestinations: [{ kind: "local", path: "rel" }] })),
            put(`${API}/config`, baseConfig({ extraDestinations: [{ kind: "s3" }] })),
            put(`${API}/config`, baseConfig({ extraDestinations: [{ kind: "remote", connectionId: CONN.sftp, path: "rel" }] })),
            get(`${API}/config`),
            put(`${API}/config`, baseConfig({
                schedule: "cron",
                cronExpr: "0 3 * * *",
                targets: [" users ", "users", "roles"],
                extraDestinations: [
                    { kind: "local", path: `${DEST}/extra1`, priority: 50 },
                    { kind: "local", path: `${DEST}/extra2` },
                    { kind: "s3", connectionId: CONN.s3, bucket: "bkt", prefix: "/p/" },
                ],
                notifications: { email: false, slack: false, webhook: false },
            })),
            get(`${API}/config`),
            put(`${API}/config`, baseConfig({ extraDestinations: [{ kind: "local", path: `${DEST}/extra1` }] })),
            get(`${API}/config`),
            put(`${API}/config`, { enabled: false, targets: ["users"], schedule: "weekly", retentionDays: 7, destination: { kind: "s3", connectionId: CONN.s3, bucket: "bkt" } }),
            get(`${API}/config`),
            post(`${API}/run`),
            put(`${API}/config`, baseConfig({ destination: { kind: "nextcloud", connectionId: CONN.nextcloud, path: "/b" } })),
            get(`${API}/config`),
            put(`${API}/config`, baseConfig({ destination: { kind: "gdrive", connectionId: CONN.gdrive, subfolder: "s" } })),
            get(`${API}/config`),
            put(`${API}/config`, baseConfig()),
            get(`${API}/config`),
        ],
    },
    "test destination": {
        tables: [],
        steps: [
            post(`${API}/test-destination`, { destination: { kind: "local", path: `${DEST}/probe` } }),
            post(`${API}/test-destination`, { destination: { kind: "local", path: "rel" } }),
            post(`${API}/test-destination`, { destination: { kind: "local", path: `${DEST}/../x` } }),
            post(`${API}/test-destination`, {}),
            post(`${API}/test-destination`, { destination: { kind: "ftp" } }),
            ...["s3", "nextcloud", "remote", "gdrive"].flatMap((kind) => [
                post(`${API}/test-destination`, { destination: { kind } }),
                post(`${API}/test-destination`, { destination: { kind, connectionId: MISSING, path: "/x" } }),
                post(`${API}/test-destination`, { destination: { kind, connectionId: "not-a-uuid", path: "/x" } }),
                post(`${API}/test-destination`, { destination: { kind, connectionId: { not: MISSING }, path: "/x" } }),
                post(`${API}/test-destination`, { destination: { kind, connectionId: 5, path: "/x" } }),
            ]),
            post(`${API}/test-destination`, { destination: { kind: "s3", connectionId: CONN.nextcloud } }),
            post(`${API}/test-destination`, { destination: { kind: "s3", connectionId: CONN.s3 } }),
            post(`${API}/test-destination`, { destination: { kind: "nextcloud", connectionId: CONN.nextcloud, path: "/x" } }),
            post(`${API}/test-destination`, { destination: { kind: "remote", connectionId: CONN.sftp, path: "/x" } }),
            post(`${API}/test-destination`, { destination: { kind: "gdrive", connectionId: CONN.gdrive } }),
        ],
    },
    history: {
        tables: [],
        steps: [
            get(`${API}/history`),
            get(`${API}/history?status=success`),
            get(`${API}/history?status=failed`),
            get(`${API}/history?status=running`),
            get(`${API}/history?status=bogus`),
            get(`${API}/history?q=nightly`),
            get(`${API}/history?q=%20NIGHTLY%20`),
            get(`${API}/history?q=${JOB.done.slice(0, 13)}`),
            get(`${API}/history?q=${JOB.done.toUpperCase()}`),
            get(`${API}/history?q=100%25`),
            get(`${API}/history?q=%25`),
            get(`${API}/history?q=_x_`),
            get(`${API}/history?q=o_d`),
            get(`${API}/history?q=%27%3B%20DROP%20TABLE%20backup_jobs%3B--`),
            get(`${API}/history?q=%5C`),
            get(`${API}/history?q=%20%20`),
            get(`${API}/history?q=a&q=b`),
            get(`${API}/history?from=2026-03-11`),
            get(`${API}/history?to=2026-03-10`),
            get(`${API}/history?from=2026-03-10&to=2026-03-11`),
            get(`${API}/history?from=2026-03-11&to=2026-03-11&status=failed`),
            get(`${API}/history?from=2026-03-10&to=2026-03-11&status=success&q=done`),
            get(`${API}/history?from=not-a-date`),
            get(`${API}/history?from=2026-13-45`),
            get(`${API}/history?to=2026-02-30`),
            get(`${API}/history?cursor=${b64({ page: 1 })}`),
            get(`${API}/history?cursor=${b64({ page: 2 })}`),
            get(`${API}/history?cursor=${b64({ page: 9 })}`),
            get(`${API}/history?cursor=${b64({ page: -1 })}`),
            get(`${API}/history?cursor=${b64({ page: 1.5 })}`),
            get(`${API}/history?cursor=${b64({ page: 0.01 })}`),
            get(`${API}/history?cursor=${b64({ page: "x" })}`),
            get(`${API}/history?cursor=${b64({ page: 1e400 })}`),
            get(`${API}/history?cursor=garbage`),
            { sql: `INSERT INTO backup_policies (id, organization_id, name, schedule, retention, target_type) VALUES ('${OTHER_POLICY}','${ORG}','Other','daily','{"days":1}','organization')` },
            { sql: `INSERT INTO backup_jobs (id, policy_id, status, note, started_at, finished_at) VALUES ('${JOB.otherPolicyOld}','${OTHER_POLICY}','completed','other policy','2020-01-05Z','2020-01-05Z')` },
            get(`${API}/history?q=other%20policy`),
            get(`${API}/history?from=2020-01-05&to=2020-01-05`),
            get(`${API}/config`),
        ],
    },
    "prune, retry, cancel": {
        tables: [...JOB_TABLES],
        steps: [
            // Keeps the 2025 and 2026 fixtures that later steps use; removes the 2020 ones.
            put(`${API}/config`, baseConfig({ retentionDays: 1500 })),
            post(`${API}/prune`),
            post(`${API}/prune`),
            put(`${API}/config`, baseConfig()),
            post(`${API}/${MISSING}/retry`),
            post(`${API}/not-a-uuid/retry`),
            post(`${API}/${JOB.done}/retry`),
            post(`${API}/${JOB.running}/retry`),
            post(`${API}/${JOB.cancelled}/retry`),
            post(`${API}/${MISSING}/cancel`),
            post(`${API}/not-a-uuid/cancel`),
            post(`${API}/${JOB.done}/cancel`),
            post(`${API}/${JOB.failed}/cancel`),
            post(`${API}/${JOB.cancelled}/cancel`),
            post(`${API}/${JOB.running}/cancel`),
            post(`${API}/${JOB.running}/cancel`),
            post(`${API}/${JOB.runningToo}/cancel`),
            post(`${API}/${JOB.failed}/retry`, undefined, "retry1"),
            waitDone("retry1"),
            post(`${API}/${JOB.failedNoDest}/retry`, undefined, "retry2"),
            waitDone("retry2"),
            get(`${API}/{retry1}/log`),
            get(`${API}/{retry1}/manifest`),
            archive(`${API}/{retry1}/download`),
            post(`${API}/{retry1}/retry`),
        ],
    },
    "logs, manifests, downloads": {
        tables: [],
        steps: [
            get(`${API}/${JOB.done}/log`),
            get(`${API}/${JOB.noLog}/log`),
            get(`${API}/${MISSING}/log`),
            get(`${API}/not-a-uuid/log`),
            get(`${API}/${JOB.done}/manifest`),
            get(`${API}/${JOB.noLog}/manifest`),
            get(`${API}/${MISSING}/manifest`),
            get(`${API}/not-a-uuid/manifest`),
            get(`${API}/${JOB.done}/download`),
            get(`${API}/${JOB.noLog}/download`),
            get(`${API}/${MISSING}/download`),
            get(`${API}/not-a-uuid/download`),
            get(`${API}/${JOB.noLocation}/download`),
            get(`${API}/${JOB.missingFile}/download`),
            get(`${API}/${JOB.s3}/download`),
            get(`${API}/${JOB.s3NoConn}/download`),
            get(`${API}/${JOB.nextcloud}/download`),
            get(`${API}/${JOB.ncNoConn}/download`),
            get(`${API}/${JOB.gdrive}/download`),
            get(`${API}/${JOB.remote}/download`),
            get(`${API}/${JOB.weirdKind}/download`),
        ],
    },
    "real logical backup": {
        tables: [...JOB_TABLES, ...CONFIG_TABLES],
        steps: [
            post(`${API}/run`, undefined, "run1"),
            waitDone("run1"),
            get(`${API}/{run1}/log`),
            get(`${API}/{run1}/manifest`),
            archive(`${API}/{run1}/download`),
            get(`${API}/history?q=Manual&status=success`),
            post(`${API}/{run1}/cancel`),
            post(`${API}/{run1}/retry`),
            post(`${API}/{run1}/restore`),
        ],
    },
    "failing destinations": {
        tables: [...JOB_TABLES, ...CONFIG_TABLES],
        steps: [
            put(`${API}/config`, baseConfig({
                extraDestinations: [
                    { kind: "local", path: `${DEST}/extra1` },
                    { kind: "s3", connectionId: CONN.s3 },
                    { kind: "s3", connectionId: MISSING },
                    { kind: "nextcloud", connectionId: CONN.nextcloud, path: "/b" },
                    { kind: "gdrive", connectionId: CONN.gdrive },
                    { kind: "remote", connectionId: CONN.sftp, path: "/b" },
                ],
            })),
            post(`${API}/run`, undefined, "fan"),
            waitDone("fan"),
            get(`${API}/{fan}/log`),
            put(`${API}/config`, baseConfig({ minSuccess: 2, extraDestinations: [{ kind: "s3", connectionId: MISSING }] })),
            post(`${API}/run`, undefined, "short"),
            waitDone("short"),
            get(`${API}/{short}/log`),
            get(`${API}/{short}/manifest`),
            get(`${API}/{short}/download`),
            ...[
                ["s3", { kind: "s3", connectionId: CONN.s3 }],
                ["s3miss", { kind: "s3", connectionId: MISSING }],
                ["nc", { kind: "nextcloud", connectionId: CONN.nextcloud, path: "/b" }],
                ["ncmiss", { kind: "nextcloud", connectionId: MISSING, path: "/b" }],
                ["gd", { kind: "gdrive", connectionId: CONN.gdrive }],
                ["gdmiss", { kind: "gdrive", connectionId: MISSING }],
            ].flatMap(([name, destination]) => [
                put(`${API}/config`, baseConfig({ destination })),
                post(`${API}/run`, undefined, name),
                waitDone(name),
                get(`${API}/{${name}}/log`),
                get(`${API}/{${name}}/manifest`),
            ]),
            // A primary SFTP destination cannot be saved, so it can only come from a snapshot.
            { sql: `INSERT INTO backup_jobs (id, status, note, config_snapshot) VALUES ('${job(31)}','queued',NULL,'{"destination":{"kind":"remote","connectionId":"${CONN.sftp}","path":"/b"},"targets":["roles"]}')` },
            { sql: `INSERT INTO backup_jobs (id, status, note, config_snapshot) VALUES ('${job(32)}','queued','','{"destination":{"kind":"remote","connectionId":"${MISSING}","path":"/b"},"targets":["roles"]}')` },
            { wait: `SELECT 1 WHERE (SELECT count(*) FROM backup_jobs WHERE id IN ('${job(31)}','${job(32)}') AND status='failed')=2` },
            get(`${API}/${job(31)}/log`),
            get(`${API}/${job(32)}/manifest`),
            // Older jobs without a snapshot read the policy and their destination rows.
            put(`${API}/config`, baseConfig({ extraDestinations: [{ kind: "local", path: `${DEST}/extra2` }] })),
            { sql: `INSERT INTO backup_jobs (id, policy_id, status) SELECT '${job(33)}', id, 'queued' FROM backup_policies WHERE is_default` },
            { wait: `SELECT 1 FROM backup_jobs WHERE id='${job(33)}' AND status NOT IN ('queued','running')` },
            get(`${API}/${job(33)}/log`),
            get(`${API}/${job(33)}/manifest`),
            // A snapshot with no destination fails closed.
            { sql: `INSERT INTO backup_jobs (id, status, config_snapshot) VALUES ('${job(34)}','queued','{"targets":["users"]}')` },
            // Unsupported target in a snapshot, then a missing canonical table: both fail closed.
            { sql: `INSERT INTO backup_jobs (id, status, config_snapshot) VALUES ('${job(35)}','queued','{"destination":{"kind":"local","path":"${DEST}/primary"},"targets":["users","nonsense"]}')` },
            { wait: `SELECT 1 WHERE (SELECT count(*) FROM backup_jobs WHERE id IN ('${job(34)}','${job(35)}') AND status NOT IN ('queued','running'))=2` },
            get(`${API}/${job(35)}/manifest`),
            get(`${API}/${job(35)}/log`),
            put(`${API}/config`, baseConfig({ targets: ["users", "settings"] })),
            { sql: `ALTER TABLE organization_settings RENAME TO organization_settings_moved` },
            post(`${API}/run`, undefined, "gone"),
            waitDone("gone"),
            { sql: `ALTER TABLE organization_settings_moved RENAME TO organization_settings` },
            get(`${API}/{gone}/manifest`),
            get(`${API}/{gone}/log`),
            put(`${API}/config`, baseConfig()),
        ],
    },
    "real PostgreSQL backup and restore": {
        tables: [...JOB_TABLES, ...CONFIG_TABLES],
        steps: [
            post(`${API}/${JOB.done}/restore`),
            post(`${API}/${JOB.failed}/restore`),
            post(`${API}/${MISSING}/restore`),
            post(`${API}/not-a-uuid/restore`),
            post(`${API}/${JOB.pgNoSum}/restore`),
            get(`${API}/restores/${MISSING}`),
            get(`${API}/restores/not-a-uuid`),
            put(`${API}/config`, baseConfig({ backupKind: "postgresql", extraDestinations: [{ kind: "local", path: `${DEST}/extra1` }] })),
            get(`${API}/config`),
            post(`${API}/run`, undefined, "pg1"),
            waitDone("pg1"),
            get(`${API}/{pg1}/log`),
            get(`${API}/{pg1}/manifest`),
            archive(`${API}/{pg1}/download`),
            { dump: "pg1" },
            post(`${API}/{pg1}/restore`, undefined, "restore1"),
            waitDone("restore1", "backup_restores"),
            get(`${API}/restores/{restore1}`),
            // Fails closed: metadata with no manifest or artifact row.
            post(`${API}/${JOB.pgNoManifest}/restore`, undefined, "restoreBad"),
            waitDone("restoreBad", "backup_restores"),
            get(`${API}/restores/{restoreBad}`),
            // Fails closed: truncated file, then checksum metadata that disagrees.
            { corrupt: { from: "pg1", id: job(40), mode: "truncate" } },
            post(`${API}/${job(40)}/restore`, undefined, "restoreTrunc"),
            waitDone("restoreTrunc", "backup_restores"),
            get(`${API}/restores/{restoreTrunc}`),
            { corrupt: { from: "pg1", id: job(41), mode: "checksum" } },
            post(`${API}/${job(41)}/restore`, undefined, "restoreSum"),
            waitDone("restoreSum", "backup_restores"),
            get(`${API}/restores/{restoreSum}`),
            { corrupt: { from: "pg1", id: job(42), mode: "size" } },
            post(`${API}/${job(42)}/restore`, undefined, "restoreSize"),
            waitDone("restoreSize", "backup_restores"),
            get(`${API}/restores/{restoreSize}`),
            { corrupt: { from: "pg1", id: job(43), mode: "unverified-manifest" } },
            post(`${API}/${job(43)}/restore`, undefined, "restoreManifest"),
            waitDone("restoreManifest", "backup_restores"),
            get(`${API}/restores/{restoreManifest}`),
            { corrupt: { from: "pg1", id: job(44), mode: "garbage" } },
            post(`${API}/${job(44)}/restore`, undefined, "restoreGarbage"),
            waitDone("restoreGarbage", "backup_restores"),
            get(`${API}/restores/{restoreGarbage}`),
            put(`${API}/config`, baseConfig()),
        ],
    },
};

function b64(value) {
    // JSON.stringify would turn Infinity into null, so 1e400 is written by hand.
    const text = value.page === Infinity ? '{"page":1e400}' : JSON.stringify(value);
    return encodeURIComponent(Buffer.from(text, "utf8").toString("base64"));
}

async function rows(db, table) {
    const { rows: found } = await db.query(`SELECT * FROM ${table}`);
    // Generated ids change per database, so order by normalized content.
    return found.map(normalize).map((r) => JSON.stringify(r)).sort();
}

// Makes a copy of a finished PostgreSQL backup with one thing wrong with it.
async function corruptCopy(db, vars, { from, id, mode }) {
    const fromId = vars[from];
    const { rows: [src] } = await db.query(`SELECT * FROM backup_jobs WHERE id=$1`, [fromId]);
    const { rows: [man] } = await db.query(`SELECT manifest FROM backup_job_manifests WHERE job_id=$1`, [fromId]);
    const { rows: [art] } = await db.query(`SELECT * FROM backup_job_artifacts WHERE backup_job_id=$1`, [fromId]);
    let file = src.artifact_location.path;
    let checksum = src.checksum;
    let size = src.size_bytes;
    let manifest = man.manifest;
    const copy = `${vars.dest}/corrupt-${mode}.dump`;
    if (mode === "truncate") {
        const data = fs.readFileSync(file);
        fs.writeFileSync(copy, data.subarray(0, Math.floor(data.length / 2)));
        file = copy;
    } else if (mode === "garbage") {
        // Checksum and size agree with the file, so only pg_restore --list can reject it.
        const data = Buffer.from("not a dump, but correctly described\n");
        fs.writeFileSync(copy, data);
        file = copy;
        checksum = crypto.createHash("sha256").update(data).digest("hex");
        size = String(data.length);
        manifest = { ...manifest, artifact: { ...manifest.artifact, sizeBytes: data.length, checksum: { algorithm: "sha256", value: checksum } } };
    } else if (mode === "checksum") {
        manifest = { ...manifest, artifact: { ...manifest.artifact, checksum: { algorithm: "sha256", value: "0".repeat(64) } } };
    } else if (mode === "size") {
        size = String(Number(size) + 1);
    } else if (mode === "unverified-manifest") {
        manifest = { ...manifest, verified: false };
    }
    await insertJob(db, id, {
        backup_kind: "postgresql", verified: true, checksum, size_bytes: size, note: `corrupt ${mode}`,
        archive_name: src.archive_name, artifact_location: { kind: "local", path: file },
    });
    await db.query(`INSERT INTO backup_job_manifests (job_id, manifest) VALUES ($1,$2)`, [id, JSON.stringify(manifest)]);
    await db.query(
        `INSERT INTO backup_job_artifacts (backup_job_id, artifact_type, storage_location, size_bytes, checksum) VALUES ($1,$2,$3,$4,$5)`,
        [id, art.artifact_type, JSON.stringify({ kind: "local", path: file }), mode === "size" ? src.size_bytes : size, checksum],
    );
}

async function downloadBytes(base, id) {
    const res = await fetch(`${base}${API}/${id}/download`, { headers: { cookie: `${COOKIE}=${adminCookie}` } });
    assert.equal(res.status, 200);
    return Buffer.from(await res.arrayBuffer());
}

function extractNdjson(bytes) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "riq-b7-x-"));
    try {
        fs.writeFileSync(path.join(dir, "a.tar.gz"), bytes);
        execFileSync("tar", ["xzf", "a.tar.gz"], { cwd: dir });
        const out = {};
        for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".ndjson")).sort()) {
            out[f] = fs.readFileSync(path.join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
        }
        return out;
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

const pgEnv = (url) => {
    const u = new URL(url);
    return { ...process.env, PGHOST: u.hostname, PGPORT: u.port, PGUSER: decodeURIComponent(u.username), PGPASSWORD: decodeURIComponent(u.password) };
};

// The auth middleware moves last_seen_at on every request after the dump; all else must match.
const SESSION_COLUMNS = "ROW(t.id, t.user_id, t.refresh_token, t.user_agent, t.ip_address, t.trusted, t.created_at, t.revoked_at)";

async function tableDigests(db, skip, columns = {}) {
    const { rows: tables } = await db.query(`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1`);
    const out = {};
    for (const { tablename } of tables) {
        const filter = skip[tablename] ?? "";
        if (filter === false) continue;
        const { rows: [r] } = await db.query(
            `SELECT count(*)::int AS n, md5(coalesce(string_agg((${columns[tablename] ?? "t"})::text, '|' ORDER BY (${columns[tablename] ?? "t"})::text), '')) AS digest FROM "${tablename}" t ${filter}`,
        );
        out[tablename] = r;
    }
    return out;
}

/* -------- Worker processes for the claim races (new build, DB_C) -------- */

function buildServices() {
    const load = (p) => require(`${DIST_B}/${p}`);
    const { PrismaService } = load("storage/prisma.service.js");
    const { WorkerService } = load("backups/worker.service.js");
    const { RestoreWorkerService } = load("backups/restore-worker.service.js");
    const { BackupsService } = load("backups/backups.service.js");
    const { OrganizationContextService } = load("storage/organization-context.service.js");
    const prisma = new PrismaService();
    const notifier = { send: async () => {} };
    const worker = new WorkerService(prisma, notifier);
    const restoreWorker = new RestoreWorkerService(prisma);
    const svc = new BackupsService(prisma, notifier, worker, new OrganizationContextService(prisma));
    return { prisma, worker, restoreWorker, svc };
}

async function childMain(kind) {
    process.env.DATABASE_URL = DB_C;
    const { prisma, worker, restoreWorker } = buildServices();
    const claimed = [];
    await new Promise((r) => process.once("message", r)); // start together
    if (kind === "claim-jobs" || kind === "claim-restores") {
        const claim = kind === "claim-jobs" ? () => worker.claimJob() : () => restoreWorker.claimRestore();
        const loop = async () => {
            for (;;) {
                const row = await claim();
                if (!row) return;
                claimed.push(row.id);
            }
        };
        await Promise.all([loop(), loop(), loop()]);
    } else {
        // Real work: each process keeps taking jobs until none are left.
        const { Client: C } = require("pg");
        const db = new C({ connectionString: DB_C });
        await db.connect();
        for (;;) {
            await Promise.all([worker.runOneIfAny()]);
            const { rows: [r] } = await db.query(`SELECT count(*)::int AS n FROM backup_jobs WHERE status='queued' AND id::text LIKE 'd%'`);
            if (r.n === 0) break;
        }
        await db.end();
    }
    await prisma.$disconnect();
    process.send({ claimed }, () => process.exit(0));
}

function race(kind, count) {
    const children = Array.from({ length: count }, () =>
        spawn(process.execPath, [__filename, "child", kind], { stdio: ["ignore", "inherit", "inherit", "ipc"], env: process.env }));
    return new Promise((resolve, reject) => {
        const results = [];
        let ready = 0;
        children.forEach((c) => {
            c.once("message", (m) => {
                results.push(m.claimed);
                if (results.length === count) resolve(results);
            });
            c.once("error", reject);
            c.once("exit", (code) => {
                if (code) reject(new Error(`worker child exited ${code}`));
            });
            c.once("spawn", () => {
                ready++;
                // Give every process time to load before releasing them together.
                if (ready === count) setTimeout(() => children.forEach((x) => x.send("go")), 4000);
            });
        });
    });
}

async function directTests(dbC, fail) {
    console.log("direct calls (new build, own database)");
    const DEST = `${ROOT}/c`;
    fs.mkdirSync(DEST, { recursive: true });
    process.env.DATABASE_URL = DB_C;
    const { prisma, worker, restoreWorker, svc } = buildServices();
    const check = async (label, fn) => {
        try {
            await fn();
            console.log(`  ok    ${label}`);
        } catch (e) {
            fail(label, "", String(e?.message ?? e));
        }
    };
    const snap = (dest) => JSON.stringify({ destination: { kind: "local", path: dest }, targets: ["roles"], parallelism: 1, minSuccess: 1 });
    const pgSnap = (dest, extra = {}) => JSON.stringify({ backupKind: "postgresql", destination: { kind: "local", path: dest }, targets: [], minSuccess: 1, ...extra });
    const status = async (id) => (await dbC.query(`SELECT j.status, j.cancelled, j.verified, j.error, j.note, l.log_text, m.manifest,
            (SELECT count(*)::int FROM backup_job_artifacts a WHERE a.backup_job_id=j.id) AS artifacts
          FROM backup_jobs j LEFT JOIN backup_job_logs l ON l.job_id=j.id LEFT JOIN backup_job_manifests m ON m.job_id=j.id WHERE j.id=$1`, [id])).rows[0];
    const clearQueue = () => dbC.query(`DELETE FROM backup_jobs`);
    const wrapper = (name, body) => {
        const p = path.join(DEST, `${name}.sh`);
        fs.writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
        return p;
    };
    const realDump = execFileSync("sh", ["-c", "command -v pg_dump"]).toString().trim();

    await check("parallel processes claim each of 60 queued jobs exactly once", async () => {
        await clearQueue();
        await dbC.query(
            `INSERT INTO backup_jobs (id, status, started_at, config_snapshot)
             SELECT gen_random_uuid(), 'queued', now() - n * interval '1 second', '{}'::jsonb FROM generate_series(1, 60) n`,
        );
        const results = await race("claim-jobs", 4);
        const all = results.flat();
        assert.equal(all.length, 60, `claimed ${all.length}`);
        assert.equal(new Set(all).size, 60, "a job was claimed twice");
        assert.ok(results.filter((r) => r.length).length >= 2, "only one process claimed anything, so nothing raced");
        const { rows: [r] } = await dbC.query(`SELECT count(*)::int AS n FROM backup_jobs WHERE status='running' AND note='Worker running'`);
        assert.equal(r.n, 60);
    });

    await check("parallel processes claim each of 40 queued restores exactly once", async () => {
        await clearQueue();
        await dbC.query(`INSERT INTO backup_jobs (id, status) VALUES ('${job(50)}','completed')`);
        await dbC.query(`INSERT INTO backup_restores (backup_job_id, status, requested_at)
            SELECT '${job(50)}', 'queued', now() - n * interval '1 second' FROM generate_series(1, 40) n`);
        const results = await race("claim-restores", 4);
        const all = results.flat();
        assert.equal(all.length, 40);
        assert.equal(new Set(all).size, 40, "a restore was claimed twice");
        assert.ok(results.filter((r) => r.length).length >= 2, "only one process claimed anything, so nothing raced");
    });

    await check("parallel workers run each of 16 real jobs exactly once", async () => {
        await clearQueue();
        const ids = Array.from({ length: 16 }, (_, i) => `d0000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
        for (const [i, id] of ids.entries()) {
            await dbC.query(
                `INSERT INTO backup_jobs (id, status, note, started_at, config_snapshot) VALUES ($1,'queued','Keep me', now() - $2 * interval '1 second', $3)`,
                [id, i, snap(`${DEST}/real/${id}`)],
            );
        }
        const results = await race("run-jobs", 4);
        assert.equal(results.length, 4);
        for (const id of ids) {
            const s = await status(id);
            assert.equal(s.status, "completed", `${id}: ${s.status} ${s.error}`);
            assert.equal(s.note, "Keep me");
            assert.equal((s.log_text.match(/Exporting targets/g) || []).length, 1, `${id} ran more than once`);
            assert.equal((s.log_text.match(/Done in/g) || []).length, 1, `${id} finished more than once`);
            assert.equal(s.artifacts, 1);
            assert.equal(fs.readdirSync(`${DEST}/real/${id}`).length, 1);
        }
    });

    await check("a claim skips a row another transaction has locked, and cancelled queued jobs", async () => {
        await clearQueue();
        const [first, second, third] = [job(51), job(52), job(53)];
        await dbC.query(`INSERT INTO backup_jobs (id, status, started_at, cancelled) VALUES
            ('${third}','queued','2020-01-01Z',true), ('${first}','queued','2020-01-02Z',false), ('${second}','queued','2020-01-03Z',false)`);
        const locker = new Client({ connectionString: DB_C });
        await locker.connect();
        await locker.query("BEGIN");
        await locker.query(`SELECT 1 FROM backup_jobs WHERE id='${first}' FOR UPDATE`);
        const claimed = await worker.claimJob();
        assert.equal(claimed.id, second);
        assert.equal(claimed.status, "running");
        assert.equal(claimed.cancelled, false);
        assert.equal(await worker.claimJob(), null);
        await locker.query("ROLLBACK");
        await locker.end();
        assert.equal((await worker.claimJob()).id, first);
        assert.equal(await worker.claimJob(), null);
    });

    await check("cancelling a queued job stops it being claimed", async () => {
        await clearQueue();
        const id = job(58);
        await dbC.query(`INSERT INTO backup_jobs (id, status, note, config_snapshot) VALUES ($1,'queued','q',$2)`, [id, snap(`${DEST}/q`)]);
        assert.deepEqual(await svc.cancelJob(id), { sent: true });
        const s = await status(id);
        assert.deepEqual([s.status, s.cancelled, s.note], ["cancelled", true, "Cancelled by user"]);
        assert.equal(await worker.claimJob(), null);
    });

    await check("cancel during a real pg_dump: the job stays cancelled with no artifact", async () => {
        await clearQueue();
        const id = job(54);
        await dbC.query(`INSERT INTO backup_jobs (id, status, note, backup_kind, config_snapshot) VALUES ($1,'running','x','postgresql',$2)`, [id, pgSnap(`${DEST}/cancel`)]);
        process.env.PG_DUMP_BIN = wrapper("slowdump", `case "$1" in --version) exec ${realDump} --version;; esac\nsleep 3\nexec ${realDump} "$@"`);
        const running = worker.process(id);
        await sleep(1500);
        assert.deepEqual(await svc.cancelJob(id), { sent: true });
        await running;
        delete process.env.PG_DUMP_BIN;
        const s = await status(id);
        assert.equal(s.status, "cancelled");
        assert.equal(s.cancelled, true);
        assert.equal(s.note, "Cancelled by user");
        assert.equal(s.artifacts, 0);
        assert.equal(s.manifest.complete, false);
        assert.equal(s.manifest.verified, false);
        assert.match(s.manifest.error, /cancelled before completion/);
        assert.match(s.log_text, /Completion skipped/);
        await assert.rejects(svc.cancelJob(id), /Job not running/);
        await assert.rejects(svc.retryJob(id), /Job not in failed state/);
    });

    await check("a failure after cancel does not overwrite the cancelled state", async () => {
        const id = job(55);
        await dbC.query(`INSERT INTO backup_jobs (id, status, note, backup_kind, config_snapshot) VALUES ($1,'running','x','postgresql',$2)`, [id, pgSnap(`${DEST}/cancel2`)]);
        process.env.PG_DUMP_BIN = wrapper("slowfail", `case "$1" in --version) exec ${realDump} --version;; esac\nsleep 3\nexit 3`);
        const running = worker.process(id);
        await sleep(1500);
        await svc.cancelJob(id);
        await running;
        delete process.env.PG_DUMP_BIN;
        const s = await status(id);
        assert.equal(s.status, "cancelled");
        assert.equal(s.note, "Cancelled by user");
    });

    const failing = [
        ["pg_dump failing", wrapper("failing", `case "$1" in --version) exec ${realDump} --version;; esac\necho nope >&2\nexit 3`), /pg_dump|failing.sh.*exited with status 3/],
        ["pg_dump writing an empty file", wrapper("empty", `case "$1" in --version) exec ${realDump} --version;; esac\nwhile [ $# -gt 0 ]; do [ "$1" = --file ] && : > "$2"; shift; done`), /dump artifact is empty/],
        ["pg_dump output over the limit (truncated output fails closed)", wrapper("overflow", `case "$1" in --version) exec ${realDump} --version;; esac\nhead -c 1100000 /dev/zero | tr '\\0' x >&2`), /refusing truncated command output/],
    ];
    for (const [label, bin, expected] of failing) {
        await check(`${label}: job fails with no artifact, and only failed jobs retry`, async () => {
            const id = crypto.randomUUID();
            await dbC.query(`INSERT INTO backup_jobs (id, status, note, backup_kind, config_snapshot) VALUES ($1,'running','x','postgresql',$2)`, [id, pgSnap(`${DEST}/failing`)]);
            process.env.PG_DUMP_BIN = bin;
            await worker.process(id);
            delete process.env.PG_DUMP_BIN;
            const s = await status(id);
            assert.equal(s.status, "failed");
            assert.equal(s.verified, false);
            assert.equal(s.artifacts, 0);
            assert.equal(s.manifest.complete, false);
            assert.equal(s.manifest.verified, false);
            assert.match(s.error, expected);
            await assert.rejects(svc.startRestore(id), /must be completed and verified/);
        });
    }

    await check("pg_restore rejecting the dump fails the backup", async () => {
        const id = job(56);
        await dbC.query(`INSERT INTO backup_jobs (id, status, note, backup_kind, config_snapshot) VALUES ($1,'running','x','postgresql',$2)`, [id, pgSnap(`${DEST}/badlist`)]);
        const realRestore = execFileSync("sh", ["-c", "command -v pg_restore"]).toString().trim();
        process.env.PG_RESTORE_BIN = wrapper("badlist", `case "$1" in --version) exec ${realRestore} --version;; esac\nexit 1`);
        await worker.process(id);
        delete process.env.PG_RESTORE_BIN;
        const s = await status(id);
        assert.equal(s.status, "failed");
        assert.equal(s.artifacts, 0);
        assert.deepEqual(fs.existsSync(`${DEST}/badlist`), false);
    });

    await check("retry copies the job and its destinations atomically, only from failed", async () => {
        const dest = await dbC.query(`INSERT INTO backup_destinations (organization_id, name, provider, configuration) VALUES ($1,'D1','local','{"kind":"local"}') RETURNING id`, [ORG]);
        const id = job(57);
        await dbC.query(`INSERT INTO backup_jobs (id, status, backup_kind, config_snapshot, min_success, parallelism) VALUES ($1,'failed','logical','{"a":1}',3,4)`, [id]);
        await dbC.query(`INSERT INTO backup_job_destinations (job_id, destination_id, is_primary, priority) VALUES ($1,$2,true,9)`, [id, dest.rows[0].id]);
        const out = await svc.retryJob(id);
        worker.running = false;
        const { rows: [n] } = await dbC.query(`SELECT status, note, backup_kind, config_snapshot, min_success, parallelism, cancelled FROM backup_jobs WHERE id=$1`, [out.id]);
        assert.equal(n.note, `Retry of ${id}`);
        assert.deepEqual([n.backup_kind, n.config_snapshot, n.min_success, n.parallelism, n.cancelled], ["logical", { a: 1 }, 3, 4, false]);
        const { rows: d } = await dbC.query(`SELECT is_primary, priority FROM backup_job_destinations WHERE job_id=$1`, [out.id]);
        assert.deepEqual(d, [{ is_primary: true, priority: 9 }]);
        await sleep(500);
        await clearQueue();
    });

    await check("markScheduledOnce only stamps a policy once per 30 seconds", async () => {
        assert.deepEqual(await svc.markScheduledOnce(new Date()), { updated: false }); // no policy yet
        await dbC.query(`INSERT INTO backup_policies (organization_id, name, schedule, retention, target_type, is_default, options) VALUES ($1,'P','daily','{"days":1}','organization',true,'{"keep":1}')`, [ORG]);
        const t = new Date("2026-05-01T00:00:00Z");
        assert.deepEqual(await svc.markScheduledOnce(t), { updated: true });
        assert.deepEqual(await svc.markScheduledOnce(new Date(+t + 10_000)), { updated: false });
        assert.deepEqual(await svc.markScheduledOnce(new Date(+t + 31_000)), { updated: true });
        const { rows: [p] } = await dbC.query(`SELECT options FROM backup_policies WHERE name='P'`);
        assert.equal(p.options.keep, 1);
        assert.equal(new Date(p.options.lastScheduledAt).getTime(), +t + 31_000);
    });

    await check("permissions helper: a non-uuid user has nothing, duplicates collapse", async () => {
        assert.deepEqual(await svc.getPermissions("nope"), { restore: false, download: false });
        assert.deepEqual(await svc.getPermissions(ADMIN), { restore: true, download: true });
        assert.deepEqual(await svc.getPermissions(VIEWER), { restore: false, download: false });
    });

    await check("a connection id cannot pick up another connection's secrets", async () => {
        const { findStorageConnection } = require(`${DIST_B}/backups/storage-connection-lookup.js`);
        assert.equal(await findStorageConnection(prisma, undefined, "s3"), null);
        assert.equal(await findStorageConnection(prisma, null, "s3"), null);
        await assert.rejects(findStorageConnection(prisma, { not: MISSING }, "s3"));
        assert.equal(await findStorageConnection(prisma, CONN.nextcloud, "s3"), null);
        assert.ok(await findStorageConnection(prisma, CONN.s3, "s3"));
    });

    await prisma.$disconnect();
    void restoreWorker;
}

async function main() {
    const mode = process.argv[2];
    if (mode === "child") return childMain(process.argv[3]);

    const dbA = new Client({ connectionString: DB_A });
    const dbB = new Client({ connectionString: DB_B });
    const dbC = new Client({ connectionString: DB_C });
    await Promise.all([dbA.connect(), dbB.connect(), dbC.connect()]);

    if (mode === "seed") {
        for (const [db, name] of [[dbA, "a"], [dbB, "b"]]) {
            const dest = `${ROOT}/${name}`;
            fs.mkdirSync(dest, { recursive: true });
            fs.writeFileSync(`${dest}/fixture.bin`, "fixture-bytes\n");
            await seedDb(db, dest);
        }
        await seedUsers(dbC);
        await Promise.all([dbA.end(), dbB.end(), dbC.end()]);
        console.log("seeded");
        return;
    }
    assert.equal(mode, "run", "usage: parity-batch7.e2e.cjs seed|run");

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

    const varsA = { dest: `${ROOT}/a` };
    const varsB = { dest: `${ROOT}/b` };
    const pgDumpTime = {};
    const waitFor = async (db, sql, label) => {
        const deadline = Date.now() + 180_000;
        while (Date.now() < deadline) {
            if ((await db.query(sql)).rows.length) return true;
            await sleep(300);
        }
        fail(`timed out: ${label}`, sql, "");
        return false;
    };
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
            if (step.wait) {
                await Promise.all([
                    waitFor(dbA, fill(step.wait, varsA), `A ${name} step ${i}`),
                    waitFor(dbB, fill(step.wait, varsB), `B ${name} step ${i}`),
                ]);
                continue;
            }
            if (step.corrupt) {
                await corruptCopy(dbA, varsA, step.corrupt);
                await corruptCopy(dbB, varsB, step.corrupt);
                continue;
            }
            if (step.dump) {
                pgDumpTime.id = varsB[step.dump];
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
            if (!same(a, b)) fail(`${name} rows: ${table}`, a.filter((x) => !b.includes(x)), b.filter((x) => !a.includes(x)));
        }
        if (ok2xx === 0) fail(`${name}: no step succeeded, so nothing real was compared`, 0, 0);
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

    console.log("real results on both builds");
    await check("logical archive: same rows, columns and column order on both builds, matching the tables", async () => {
        const a = extractNdjson(await downloadBytes(BASE_A, varsA.run1));
        const b = extractNdjson(await downloadBytes(BASE_B, varsB.run1));
        assert.deepEqual(Object.keys(b), ["devices.ndjson", "roles.ndjson", "settings.ndjson", "users.ndjson"]);
        const sort = (list) => [...list].sort((x, y) => String(x.id ?? x.organization_id).localeCompare(String(y.id ?? y.organization_id)));
        const comparable = (list) => list.map((r) => (isFixtureId(String(r.id ?? r.organization_id))
            ? JSON.stringify(r)
            : JSON.stringify(Object.entries(r).map(([k, v]) => [k, /^id$|_at$/.test(k) ? "<generated>" : v])))).sort();
        for (const file of Object.keys(b)) {
            // Text comparison, so key order and every timestamp format count too.
            assert.deepEqual(comparable(b[file]), comparable(a[file]), `${file} differs`);
            assert.ok(b[file].length > 0, `${file} is empty`);
        }
        const { rows: users } = await dbB.query(`SELECT * FROM users`);
        assert.equal(b["users.ndjson"].length, users.length);
        assert.equal(JSON.stringify(sort(b["users.ndjson"])), JSON.stringify(sort(users)), "archive differs from SELECT *");
        assert.ok(b["users.ndjson"].every((u) => u.password_hash === "hash-kept-in-backups"));
    });
    await check("postgres job and restore finished as expected on the new build", async () => {
        const j = await dbB.query(`SELECT status, verified, checksum, size_bytes::text AS size, archive_name, artifact_location FROM backup_jobs WHERE id=$1`, [varsB.pg1]);
        assert.equal(j.rows[0].status, "completed");
        assert.equal(j.rows[0].verified, true);
        const file = j.rows[0].artifact_location.path;
        assert.equal(crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"), j.rows[0].checksum);
        assert.equal(String(fs.statSync(file).size), j.rows[0].size);
        assert.equal(fs.statSync(file).mode & 0o777, 0o600);
        assert.ok(fs.existsSync(`${varsB.dest}/extra1/${path.basename(file)}`), "replica missing");
        const r = await dbB.query(`SELECT status, error, verification, restore_database FROM backup_restores WHERE id=$1`, [varsB.restore1]);
        assert.equal(r.rows[0].status, "completed", r.rows[0].error ?? "");
        const v = r.rows[0].verification;
        assert.equal(v.verified, true);
        assert.equal(v.schema.exactMatch, true);
        assert.equal(v.snapshotMigrationHistory.exactMatch, true);
        assert.ok(v.snapshotMigrationHistory.count > 0, "no migrations in the manifest, so the check proved nothing");
        assert.equal(v.currentMigrationHistory.exactMatch, true);
        assert.equal(v.application.httpStatus, 200);
        assert.equal(v.productionDatabaseChanged, false);
        const { rows: [tables] } = await dbB.query(`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public'`);
        assert.equal(v.snapshotPublicTables, tables.n);
    });
    await check("each bad restore failed closed for the expected reason on the new build", async () => {
        const expected = {
            restoreBad: /manifest is not verified/,
            restoreTrunc: /SHA-256 does not match/,
            restoreSum: /checksum metadata is missing or inconsistent/,
            restoreSize: /size does not match/,
            restoreManifest: /manifest is not verified/,
            restoreGarbage: /pg_restore/,
        };
        for (const [key, re] of Object.entries(expected)) {
            const { rows: [r] } = await dbB.query(`SELECT status, error, verification FROM backup_restores WHERE id=$1`, [varsB[key]]);
            assert.equal(r.status, "failed", key);
            assert.match(r.error, re, key);
            assert.equal(r.verification.verified, false, key);
        }
        for (const [label, db] of [["A", dbA], ["B", dbB]]) {
            const { rows: left } = await db.query(`SELECT datname FROM pg_database WHERE datname LIKE 'remoteiq_restore_%'`);
            assert.deepEqual(left, [], `${label} left a restore database behind`);
        }
    });
    await check("the downloaded PostgreSQL dump restores to a database with the same data", async () => {
        const dump = await downloadBytes(BASE_B, varsB.pg1);
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "riq-b7-r-"));
        const verify = new URL(DB_VERIFY);
        const verifyName = verify.pathname.slice(1);
        const env = pgEnv(DB_VERIFY);
        try {
            const file = path.join(dir, "a.dump");
            fs.writeFileSync(file, dump);
            execFileSync("pg_restore", ["--exit-on-error", "--single-transaction", "--no-owner", "--no-privileges", "--dbname", verifyName, file], { env, stdio: "pipe" });
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
        const dbV = new Client({ connectionString: DB_VERIFY });
        await dbV.connect();
        try {
            // The running job's own rows, and anything written after the dump, necessarily differ.
            const notSelf = `WHERE t.id <> '${varsB.pg1}' AND t.id::text NOT LIKE 'b0000000-0000-4000-8000-00000000004%'`;
            const skip = {
                backup_jobs: notSelf,
                backup_job_logs: `WHERE t.job_id <> '${varsB.pg1}' AND t.job_id::text NOT LIKE 'b0000000-0000-4000-8000-00000000004%'`,
                backup_job_manifests: `WHERE t.job_id <> '${varsB.pg1}' AND t.job_id::text NOT LIKE 'b0000000-0000-4000-8000-00000000004%'`,
                backup_job_artifacts: `WHERE t.backup_job_id <> '${varsB.pg1}' AND t.backup_job_id::text NOT LIKE 'b0000000-0000-4000-8000-00000000004%'`,
                backup_restores: false,
                // The config is put back to logical after the restore steps.
                backup_policies: false,
                backup_policy_destinations: false,
                backup_destinations: false,
            };
            const columns = { sessions: SESSION_COLUMNS };
            const [src, restored] = await Promise.all([tableDigests(dbB, skip, columns), tableDigests(dbV, skip, columns)]);
            assert.deepEqual(Object.keys(restored), Object.keys(src));
            const differs = Object.keys(src).filter((t) => src[t].digest !== restored[t].digest || src[t].n !== restored[t].n);
            assert.deepEqual(differs, [], `tables differ: ${differs.join(",")}`);
            assert.ok(src.users.n >= 2 && src.backup_jobs.n > 50 && src.storage_connections.n === 4, "seed rows missing from the comparison");
            console.log(`        ${Object.keys(src).length} tables identical, ${Object.values(src).reduce((s, t) => s + t.n, 0)} rows`);
        } finally {
            await dbV.end();
        }
    });

    console.log("concurrency");
    const burst = await Promise.all(
        Array.from({ length: 12 }, (_, i) => request(BASE_B, put(`${API}/config`, baseConfig({ retentionDays: 10 + i, extraDestinations: [{ kind: "local", path: `${DEST}/extra1` }, { kind: "local", path: `${DEST}/extra2` }] })), varsB)),
    );
    if (burst.some((r) => r.status >= 300)) fail("B: concurrent config saves must all succeed", {}, burst.map((r) => [r.status, r.body]));
    else console.log("  ok    12 concurrent config saves");
    const { rows: fan } = await dbB.query(`SELECT count(*)::int AS n FROM backup_policy_destinations pd JOIN backup_policies p ON p.id=pd.policy_id WHERE p.name='Default Backup Policy'`);
    if (fan[0].n !== 3) fail("B: a burst of saves leaves one set of destinations", 3, fan[0].n);

    const hits = await Promise.all(Array.from({ length: 8 }, () => request(BASE_B, post(`${API}/run`))));
    const newIds = await Promise.all(hits.map(async (h) => h.status));
    if (newIds.some((s) => s >= 300)) fail("B: concurrent runs must all queue", {}, newIds);
    else console.log("  ok    8 concurrent runs queued");
    await waitFor(dbB, `SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM backup_jobs WHERE status IN ('queued') )`, "B drains its queue");
    await sleep(4000);
    const { rows: twice } = await dbB.query(`SELECT j.id FROM backup_jobs j JOIN backup_job_logs l ON l.job_id=j.id WHERE (length(l.log_text) - length(replace(l.log_text, 'Exporting targets', ''))) > length('Exporting targets')`);
    if (twice.length) fail("B: a job ran twice", [], twice);
    else console.log("  ok    every queued job ran once through the HTTP pump");

    await directTests(dbC, fail);

    await Promise.all([dbA.end(), dbB.end(), dbC.end()]);
    console.log(`\n${compared} comparisons (${succeeded} on successful requests), ${failures.length} failed`);
    process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
