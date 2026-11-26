#!/usr/bin/env node

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const net = require("net");
const { spawn, spawnSync } = require("child_process");
const { Client } = require("pg");

const ROOT = path.resolve(__dirname, "..");

require(path.join(ROOT, "node_modules/dotenv"))
    .config({
        path: path.join(ROOT, ".env"),
        quiet: true,
    });

function die(message) {
    console.error("PROMOTION_ERROR=" + message);
    process.exitCode = 1;
}

function arg(name) {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : undefined;
}

function has(name) {
    return process.argv.includes(name);
}

function databaseUrlFor(name) {
    const raw =
        process.env.DATABASE_URL ||
        process.env.PG_URL;

    if (!raw) {
        throw new Error(
            "DATABASE_URL/PG_URL missing"
        );
    }

    const u = new URL(raw);

    if (
        u.protocol !== "postgres:" &&
        u.protocol !== "postgresql:"
    ) {
        throw new Error(
            "Only PostgreSQL DATABASE_URL is supported"
        );
    }

    u.pathname = "/" + encodeURIComponent(name);
    return u.toString();
}

function productionDatabaseName() {
    const raw =
        process.env.DATABASE_URL ||
        process.env.PG_URL;

    if (!raw) {
        throw new Error(
            "DATABASE_URL/PG_URL missing"
        );
    }

    const u = new URL(raw);
    const name =
        decodeURIComponent(
            u.pathname.replace(/^\/+/, "")
        );

    if (!/^[A-Za-z0-9_]+$/.test(name)) {
        throw new Error(
            "Production database name is unsafe"
        );
    }

    if (
        name === "postgres" ||
        name === "template0" ||
        name === "template1"
    ) {
        throw new Error(
            "Refusing system database promotion"
        );
    }

    return name;
}

function pgEnv(databaseName) {
    const raw =
        process.env.DATABASE_URL ||
        process.env.PG_URL;

    const u = new URL(raw);

    const env = {
        ...process.env,
        PGHOST: u.hostname,
        PGPORT: u.port || "5432",
        PGUSER: decodeURIComponent(
            u.username
        ),
        PGDATABASE: databaseName,
    };

    if (u.password) {
        env.PGPASSWORD =
            decodeURIComponent(u.password);
    }

    const sslmode =
        u.searchParams.get("sslmode");

    if (sslmode) {
        env.PGSSLMODE = sslmode;
    }

    return env;
}

function run(command, args, opts = {}) {
    const res = spawnSync(
        command,
        args,
        {
            cwd: ROOT,
            env:
                opts.env ||
                process.env,
            encoding: "utf8",
            stdio:
                opts.capture
                    ? ["ignore", "pipe", "pipe"]
                    : "inherit",
        }
    );

    if (res.error) {
        throw res.error;
    }

    if (res.status !== 0) {
        const detail = opts.capture
            ? String(
                res.stderr ||
                res.stdout ||
                ""
            ).trim()
            : "";

        throw new Error(
            `${command} failed with exit ${res.status}` +
            (detail ? `: ${detail}` : "")
        );
    }

    return res;
}

async function sha256(file) {
    return await new Promise(
        (resolve, reject) => {
            const hash =
                crypto.createHash("sha256");

            const input =
                fs.createReadStream(file);

            input.on(
                "error",
                reject
            );

            input.on(
                "data",
                (chunk) =>
                    hash.update(chunk)
            );

            input.on(
                "end",
                () =>
                    resolve(
                        hash.digest("hex")
                    )
            );
        }
    );
}

function serviceMustBeOffline(
    database,
    testMode
) {
    if (testMode) {
        if (
            !/^adgrmm_dr_tooltest_[A-Za-z0-9_]+$/.test(
                database
            )
        ) {
            throw new Error(
                "--test-mode is restricted to " +
                "adgrmm_dr_tooltest_* databases"
            );
        }

        console.log(
            "DR_PROMOTION_TEST_MODE=1"
        );
        console.log(
            "DR_PROMOTION_TEST_DATABASE=" +
            database
        );
        return;
    }

    const res = spawnSync(
        "systemctl",
        [
            "is-active",
            "adgrmm-backend.service",
        ],
        {
            encoding: "utf8",
        }
    );

    const state =
        String(res.stdout || "")
            .trim();

    if (state === "active") {
        throw new Error(
            "adgrmm-backend.service is active; " +
            "promotion and rollback require offline mode"
        );
    }

    console.log(
        "BACKEND_SERVICE_OFFLINE=1"
    );
}

function ident(name) {
    if (!/^[A-Za-z0-9_]+$/.test(name)) {
        throw new Error(
            "Unsafe database identifier"
        );
    }

    return `"${name}"`;
}

async function clientFor(database) {
    const client = new Client({
        connectionString:
            databaseUrlFor(database),
    });

    await client.connect();
    return client;
}

async function activeWorkCount(database) {
    const c =
        await clientFor(database);

    try {
        const res = await c.query(`
            SELECT
                (
                    SELECT count(*)
                    FROM public.backup_jobs
                    WHERE status IN (
                        'queued',
                        'running'
                    )
                )
                +
                (
                    SELECT count(*)
                    FROM public.backup_restores
                    WHERE status IN (
                        'queued',
                        'running'
                    )
                ) AS n
        `);

        return Number(
            res.rows[0]?.n || 0
        );
    } finally {
        await c.end();
    }
}

async function ownerOf(database) {
    const c =
        await clientFor("postgres");

    try {
        const res = await c.query(
            `SELECT r.rolname
               FROM pg_database d
               JOIN pg_roles r
                 ON r.oid=d.datdba
              WHERE d.datname=$1`,
            [database]
        );

        if (!res.rows.length) {
            throw new Error(
                `Database ${database} missing`
            );
        }

        return res.rows[0].rolname;
    } finally {
        await c.end();
    }
}

async function terminateConnections(database) {
    const c =
        await clientFor("postgres");

    try {
        await c.query(
            `SELECT pg_terminate_backend(pid)
               FROM pg_stat_activity
              WHERE datname=$1
                AND pid <> pg_backend_pid()`,
            [database]
        );
    } finally {
        await c.end();
    }
}

async function renameDatabase(from, to) {
    const c =
        await clientFor("postgres");

    try {
        await c.query(
            `ALTER DATABASE ${ident(from)}
             RENAME TO ${ident(to)}`
        );
    } finally {
        await c.end();
    }
}

async function createDatabase(
    database,
    owner
) {
    const c =
        await clientFor("postgres");

    try {
        await c.query(
            `CREATE DATABASE ${ident(database)}
             WITH TEMPLATE template0
             OWNER ${ident(owner)}`
        );
    } finally {
        await c.end();
    }
}

async function dropDatabase(database) {
    const c =
        await clientFor("postgres");

    try {
        await c.query(
            `DROP DATABASE IF EXISTS
             ${ident(database)}`
        );
    } finally {
        await c.end();
    }
}

async function neutralizeWork(database) {
    const c =
        await clientFor(database);

    try {
        await c.query("BEGIN");

        await c.query(`
            UPDATE public.backup_jobs
               SET status='failed',
                   finished_at=NOW(),
                   cancelled=false,
                   verified=false,
                   error=
                     'Interrupted by offline DR promotion',
                   note=
                     'Interrupted by offline DR promotion'
             WHERE status IN (
                 'queued',
                 'running'
             )
        `);

        await c.query(`
            UPDATE public.backup_restores
               SET status='failed',
                   finished_at=NOW(),
                   error=
                     'Interrupted by offline DR promotion',
                   notes=
                     'Interrupted by offline DR promotion'
             WHERE status IN (
                 'queued',
                 'running'
             )
        `);

        await c.query(`
            UPDATE public.backup_run_destinations
               SET status='failed',
                   finished_at=NOW(),
                   error=
                     'Interrupted by offline DR promotion'
             WHERE status IN (
                 'pending',
                 'running'
             )
        `);

        await c.query("COMMIT");
    } catch (e) {
        try {
            await c.query("ROLLBACK");
        } catch {}

        throw e;
    } finally {
        await c.end();
    }
}

async function freePort() {
    return await new Promise(
        (resolve, reject) => {
            const server =
                net.createServer();

            server.on(
                "error",
                reject
            );

            server.listen(
                0,
                "127.0.0.1",
                () => {
                    const addr =
                        server.address();

                    const port =
                        typeof addr === "object"
                            ? addr.port
                            : 0;

                    server.close(
                        () => resolve(port)
                    );
                }
            );
        }
    );
}

async function appHealthProof(database) {
    const port = await freePort();

    const child = spawn(
        process.execPath,
        ["dist/main.js"],
        {
            cwd: ROOT,
            env: {
                ...process.env,
                DATABASE_URL:
                    databaseUrlFor(database),
                PG_URL:
                    databaseUrlFor(database),
                PORT: String(port),
            },
            stdio: [
                "ignore",
                "pipe",
                "pipe",
            ],
        }
    );

    let log = "";

    const append = (chunk) => {
        log += chunk.toString();
        if (log.length > 1024 * 1024) {
            log = log.slice(
                -(1024 * 1024)
            );
        }
    };

    child.stdout.on("data", append);
    child.stderr.on("data", append);

    let ok = false;

    try {
        for (let i = 0; i < 120; i++) {
            if (child.exitCode !== null) {
                break;
            }

            try {
                const res = await fetch(
                    `http://127.0.0.1:${port}/healthz`
                );

                if (res.status === 200) {
                    ok = true;
                    break;
                }
            } catch {}

            await new Promise(
                (resolve) =>
                    setTimeout(resolve, 500)
            );
        }
    } finally {
        if (child.exitCode === null) {
            child.kill("SIGTERM");
        }

        await new Promise(
            (resolve) => {
                const timer =
                    setTimeout(() => {
                        if (
                            child.exitCode === null
                        ) {
                            child.kill(
                                "SIGKILL"
                            );
                        }
                        resolve();
                    }, 5000);

                child.once(
                    "exit",
                    () => {
                        clearTimeout(timer);
                        resolve();
                    }
                );
            }
        );
    }

    if (!ok) {
        throw new Error(
            "Current application failed isolated " +
            "health check after promotion"
        );
    }

    console.log(
        "PROMOTION_APP_HEALTH_HTTP=200"
    );
}

function timestamp() {
    return new Date()
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(/\.\d{3}Z$/, "Z");
}

async function promote() {
    const archive = arg("--archive");
    const expected =
        arg("--checksum");
    const confirm =
        arg("--confirm-live-database");

    if (
        !archive ||
        !expected ||
        !confirm
    ) {
        throw new Error(
            "Required: --archive PATH " +
            "--checksum SHA256 " +
            "--confirm-live-database NAME"
        );
    }

    if (
        !/^[a-f0-9]{64}$/i.test(
            expected
        )
    ) {
        throw new Error(
            "Checksum must be 64 hex characters"
        );
    }

    const live =
        productionDatabaseName();

    if (confirm !== live) {
        throw new Error(
            `Confirmation mismatch; live database is ${live}`
        );
    }

    const testMode =
        has("--test-mode");

    serviceMustBeOffline(
        live,
        testMode
    );

    const stat =
        await fsp.stat(archive);

    if (!stat.isFile()) {
        throw new Error(
            "Archive is not a regular file"
        );
    }

    const actual =
        await sha256(archive);

    console.log(
        "PROMOTION_ARCHIVE_SHA256=" +
        actual
    );

    if (
        actual.toLowerCase() !==
        expected.toLowerCase()
    ) {
        throw new Error(
            "Archive checksum mismatch"
        );
    }

    run(
        "pg_restore",
        ["--list", archive],
        { capture: true }
    );

    console.log(
        "PROMOTION_PG_RESTORE_LIST_VALID=1"
    );

    const active =
        await activeWorkCount(live);

    console.log(
        "PROMOTION_ACTIVE_WORK=" +
        active
    );

    if (active !== 0) {
        throw new Error(
            "Queued/running backup work exists"
        );
    }

    const stamp = timestamp();
    const rollback =
        `${live}_pre_dr_${stamp}`
            .replace(/[^A-Za-z0-9_]/g, "_");

    const safetyDir =
        `/opt/adgrmm/deploy-backups/` +
        `postgres-promotion/${stamp}`;

    await fsp.mkdir(
        safetyDir,
        {
            recursive: true,
            mode: 0o700,
        }
    );

    const safetyDump =
        path.join(
            safetyDir,
            `${live}-pre-promotion.dump`
        );

    run(
        "pg_dump",
        [
            "--format=custom",
            "--no-owner",
            "--no-privileges",
            "--file",
            safetyDump,
            live,
        ],
        {
            env: pgEnv(live),
        }
    );

    await fsp.chmod(
        safetyDump,
        0o600
    );

    const safetySha =
        await sha256(safetyDump);

    console.log(
        "PROMOTION_SAFETY_DUMP=" +
        safetyDump
    );
    console.log(
        "PROMOTION_SAFETY_SHA256=" +
        safetySha
    );

    const owner =
        await ownerOf(live);

    let renamed = false;
    let newLiveCreated = false;

    try {
        await terminateConnections(live);

        await renameDatabase(
            live,
            rollback
        );
        renamed = true;

        await createDatabase(
            live,
            owner
        );
        newLiveCreated = true;

        run(
            "pg_restore",
            [
                "--exit-on-error",
                "--single-transaction",
                "--no-owner",
                "--no-privileges",
                "--dbname",
                live,
                archive,
            ],
            {
                env: pgEnv(live),
            }
        );

        console.log(
            "PROMOTION_PG_RESTORE_COMPLETED=1"
        );

        run(
            "npm",
            [
                "run",
                "prisma:migrate:deploy",
            ],
            {
                env: {
                    ...process.env,
                    DATABASE_URL:
                        databaseUrlFor(live),
                    PG_URL:
                        databaseUrlFor(live),
                },
            }
        );

        run(
            "npm",
            [
                "run",
                "prisma:migrate:status",
            ],
            {
                env: {
                    ...process.env,
                    DATABASE_URL:
                        databaseUrlFor(live),
                    PG_URL:
                        databaseUrlFor(live),
                },
            }
        );

        await neutralizeWork(live);

        const {
            schemaFingerprint,
        } = require(
            path.join(
                ROOT,
                "dist/backups/postgres-dr.js"
            )
        );

        const promoted =
            await schemaFingerprint(live);

        const previous =
            await schemaFingerprint(
                rollback
            );

        console.log(
            "PROMOTION_SCHEMA_SHA256=" +
            promoted.sha256
        );

        console.log(
            "ROLLBACK_SCHEMA_SHA256=" +
            previous.sha256
        );

        if (
            promoted.sha256 !==
                previous.sha256 ||
            promoted.bytes !==
                previous.bytes
        ) {
            throw new Error(
                "Promoted schema does not match " +
                "pre-promotion production schema"
            );
        }

        console.log(
            "PROMOTION_SCHEMA_EXACT_MATCH=1"
        );

        await appHealthProof(live);

        console.log(
            "PROMOTION_COMPLETED=1"
        );
        console.log(
            "PROMOTION_LIVE_DATABASE=" +
            live
        );
        console.log(
            "PROMOTION_ROLLBACK_DATABASE=" +
            rollback
        );
        console.log(
            "PROMOTION_PRODUCTION_SERVICE_STARTED=0"
        );
    } catch (error) {
        console.error(
            "PROMOTION_FAILED=" +
            String(
                error?.message || error
            )
        );

        if (renamed) {
            try {
                if (newLiveCreated) {
                    await terminateConnections(
                        live
                    );
                    await dropDatabase(
                        live
                    );
                }

                await terminateConnections(
                    rollback
                );

                await renameDatabase(
                    rollback,
                    live
                );

                console.error(
                    "PROMOTION_AUTOMATIC_ROLLBACK=1"
                );
            } catch (rollbackError) {
                console.error(
                    "PROMOTION_AUTOMATIC_ROLLBACK=0"
                );
                console.error(
                    "PROMOTION_ROLLBACK_ERROR=" +
                    String(
                        rollbackError?.message ||
                        rollbackError
                    )
                );
            }
        }

        throw error;
    }
}

async function rollback() {
    const rollbackDb =
        arg("--rollback-database");

    const confirm =
        arg("--confirm-live-database");

    if (
        !rollbackDb ||
        !confirm
    ) {
        throw new Error(
            "Required: --rollback-database NAME " +
            "--confirm-live-database NAME"
        );
    }

    const live =
        productionDatabaseName();

    if (confirm !== live) {
        throw new Error(
            `Confirmation mismatch; live database is ${live}`
        );
    }

    if (
        !rollbackDb.startsWith(
            `${live}_pre_dr_`
        )
    ) {
        throw new Error(
            "Rollback database name is not an " +
            "expected promotion rollback database"
        );
    }

    const testMode =
        has("--test-mode");

    serviceMustBeOffline(
        live,
        testMode
    );

    const failedName =
        `${live}_failed_${timestamp()}`
            .replace(/[^A-Za-z0-9_]/g, "_");

    await terminateConnections(live);
    await terminateConnections(
        rollbackDb
    );

    await renameDatabase(
        live,
        failedName
    );

    try {
        await renameDatabase(
            rollbackDb,
            live
        );
    } catch (error) {
        await renameDatabase(
            failedName,
            live
        );
        throw error;
    }

    console.log(
        "ROLLBACK_COMPLETED=1"
    );
    console.log(
        "ROLLBACK_LIVE_DATABASE=" +
        live
    );
    console.log(
        "ROLLBACK_FAILED_PROMOTION_DATABASE=" +
        failedName
    );
    console.log(
        "ROLLBACK_PRODUCTION_SERVICE_STARTED=0"
    );
}

async function main() {
    if (has("--promote")) {
        await promote();
        return;
    }

    if (has("--rollback")) {
        await rollback();
        return;
    }

    console.log(
        "Usage:\n" +
        "  node scripts/postgres-dr-promote.cjs " +
        "--promote --archive PATH --checksum SHA256 " +
        "--confirm-live-database NAME\n\n" +
        "  node scripts/postgres-dr-promote.cjs " +
        "--rollback --rollback-database NAME " +
        "--confirm-live-database NAME\n\n" +
        "  --test-mode may only be used when the " +
        "DATABASE_URL database begins with " +
        "adgrmm_dr_tooltest_"
    );
}

main().catch((error) => {
    die(
        String(
            error?.message || error
        )
    );
});
