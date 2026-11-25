import { spawn } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";

type CommandResult = {
    stdout: string;
    stderr: string;
};

function connectionUrl(): URL {
    const raw = process.env.DATABASE_URL || process.env.PG_URL;
    if (!raw) {
        throw new Error("DATABASE_URL is required for PostgreSQL disaster-recovery backups");
    }

    const url = new URL(raw);
    if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
        throw new Error("DATABASE_URL must use the PostgreSQL protocol");
    }

    return url;
}

function postgresEnvironment(): NodeJS.ProcessEnv {
    const url = connectionUrl();
    const database = decodeURIComponent(url.pathname.replace(/^\/+/, ""));

    if (!database) {
        throw new Error("DATABASE_URL does not contain a database name");
    }

    const env: NodeJS.ProcessEnv = {
        ...process.env,
        PGHOST: url.hostname,
        PGPORT: url.port || "5432",
        PGUSER: decodeURIComponent(url.username),
        PGPASSWORD: decodeURIComponent(url.password),
        PGDATABASE: database,
    };

    const sslMode = url.searchParams.get("sslmode");
    if (sslMode) {
        env.PGSSLMODE = sslMode;
    } else if ((process.env.DATABASE_SSL || "").toLowerCase() === "true") {
        env.PGSSLMODE = "require";
    }

    return env;
}

const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;

function runCommand(
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv = process.env,
): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            env,
            stdio: ["ignore", "pipe", "pipe"],
        });

        let stdout = "";
        let stderr = "";
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let stdoutOverflow = false;
        let stderrOverflow = false;
        let settled = false;

        const capture = (
            chunk: Buffer | string,
            stream: "stdout" | "stderr",
        ) => {
            const buffer = Buffer.isBuffer(chunk)
                ? chunk
                : Buffer.from(String(chunk));

            if (stream === "stdout") {
                const remaining =
                    MAX_COMMAND_OUTPUT_BYTES - stdoutBytes;

                if (remaining > 0) {
                    const kept = buffer.subarray(
                        0,
                        Math.min(remaining, buffer.length),
                    );

                    stdout += kept.toString();
                    stdoutBytes += kept.length;
                }

                if (buffer.length > remaining) {
                    stdoutOverflow = true;
                }

                return;
            }

            const remaining =
                MAX_COMMAND_OUTPUT_BYTES - stderrBytes;

            if (remaining > 0) {
                const kept = buffer.subarray(
                    0,
                    Math.min(remaining, buffer.length),
                );

                stderr += kept.toString();
                stderrBytes += kept.length;
            }

            if (buffer.length > remaining) {
                stderrOverflow = true;
            }
        };

        child.stdout?.on(
            "data",
            (chunk) => capture(chunk, "stdout"),
        );

        child.stderr?.on(
            "data",
            (chunk) => capture(chunk, "stderr"),
        );

        child.on("error", (error) => {
            if (settled) return;
            settled = true;
            reject(error);
        });

        child.on("close", (code) => {
            if (settled) return;
            settled = true;

            if (
                stdoutOverflow ||
                stderrOverflow
            ) {
                const streams = [
                    stdoutOverflow
                        ? "stdout"
                        : null,
                    stderrOverflow
                        ? "stderr"
                        : null,
                ]
                    .filter(Boolean)
                    .join(" and ");

                reject(
                    new Error(
                        `${command} ${streams} exceeded ` +
                        `${MAX_COMMAND_OUTPUT_BYTES} bytes; ` +
                        "refusing truncated command output"
                    )
                );
                return;
            }

            if (code === 0) {
                resolve({
                    stdout,
                    stderr,
                });
                return;
            }

            const detail =
                stderr.trim() ||
                stdout.trim() ||
                "no command output";

            reject(
                new Error(
                    `${command} exited with status ${code}: ` +
                    detail.slice(0, 4000)
                )
            );
        });
    });
}

export function getPostgresConnectionMetadata() {
    const url = connectionUrl();

    return {
        host: url.hostname,
        port: Number(url.port || "5432"),
        database: decodeURIComponent(url.pathname.replace(/^\/+/, "")),
    };
}

export async function getPostgresToolVersions() {
    const pgDump = await runCommand(
        process.env.PG_DUMP_BIN || "pg_dump",
        ["--version"],
    );

    const pgRestore = await runCommand(
        process.env.PG_RESTORE_BIN || "pg_restore",
        ["--version"],
    );

    return {
        pgDump: pgDump.stdout.trim(),
        pgRestore: pgRestore.stdout.trim(),
    };
}

export async function createPostgresDump(outFile: string): Promise<void> {
    await fsp.mkdir(path.dirname(outFile), { recursive: true });

    await runCommand(
        process.env.PG_DUMP_BIN || "pg_dump",
        [
            "--format=custom",
            "--no-owner",
            "--no-privileges",
            "--file",
            outFile,
        ],
        postgresEnvironment(),
    );

    await fsp.chmod(outFile, 0o600);
}

export async function validatePostgresDump(archivePath: string): Promise<void> {
    await runCommand(
        process.env.PG_RESTORE_BIN || "pg_restore",
        ["--list", archivePath],
    );
}

export async function sha256File(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash("sha256");
        const input = fs.createReadStream(filePath);

        input.on("error", reject);
        input.on("data", (chunk) => hash.update(chunk));
        input.on("end", () => resolve(hash.digest("hex")));
    });
}

export function getPostgresDatabaseUrl(databaseName: string): string {
    if (!/^[A-Za-z0-9_]+$/.test(databaseName)) {
        throw new Error("Unsafe PostgreSQL database name");
    }

    const url = connectionUrl();
    url.pathname = "/" + databaseName;
    return url.toString();
}

function postgresEnvironmentForDatabase(
    databaseName: string
): NodeJS.ProcessEnv {
    const env = postgresEnvironment();
    env.PGDATABASE = databaseName;
    return env;
}

export async function restorePostgresDump(
    archivePath: string,
    databaseName: string
): Promise<void> {
    await runCommand(
        process.env.PG_RESTORE_BIN || "pg_restore",
        [
            "--exit-on-error",
            "--single-transaction",
            "--no-owner",
            "--no-privileges",
            "--dbname",
            databaseName,
            archivePath,
        ],
        postgresEnvironmentForDatabase(databaseName),
    );
}

export async function schemaFingerprint(
    databaseName: string
): Promise<{ sha256: string; bytes: number }> {
    const result = await runCommand(
        process.env.PG_DUMP_BIN || "pg_dump",
        [
            "--schema-only",
            "--no-owner",
            "--no-privileges",
        ],
        postgresEnvironmentForDatabase(databaseName),
    );

    const normalized = result.stdout
        .split(/\r?\n/)
        .filter((line) => !/^\\(?:un)?restrict /.test(line))
        .join("\n");

    return {
        sha256: crypto
            .createHash("sha256")
            .update(normalized, "utf8")
            .digest("hex"),
        bytes: new TextEncoder().encode(normalized).byteLength,
    };
}
