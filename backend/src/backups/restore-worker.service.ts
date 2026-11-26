import { Injectable, Logger } from "@nestjs/common";
import { spawn, ChildProcess } from "child_process";
import * as crypto from "crypto";
import * as fsp from "fs/promises";
import * as http from "http";
import * as os from "os";
import * as path from "path";

import { PrismaService } from "../storage/prisma.service";
import { decryptArchiveFile, isEncryptedArchiveFile } from "./archive-crypto";
import {
    getPostgresConnectionMetadata,
    getPostgresDatabaseUrl,
    restorePostgresDump,
    schemaFingerprint,
    sha256File,
    validatePostgresDump,
} from "./postgres-dr";
import {
    gdriveDownloadAsBuffer,
    s3DownloadToFile,
    sftpDownloadToFile,
    webdavDownloadAsBuffer,
} from "./storage-clients";
import { findStorageConnection, toJsonValue } from "./storage-connection-lookup";

// Verification databases are not DATABASE_URL, so connections to them stay on pg.
const { Pool } = require("pg") as { Pool: any };

type RestoreClaim = {
    id: string;
    backup_job_id: string;
};

@Injectable()
export class RestoreWorkerService {
    private readonly log = new Logger("BackupsRestoreWorker");
    private running = false;

    constructor(private readonly prisma: PrismaService) {}

    async runOneIfAny(): Promise<void> {
        if (this.running) return;

        const restore = await this.claimRestore();
        if (!restore) return;

        this.running = true;

        try {
            await this.processRestore(
                restore.id,
                restore.backup_job_id,
            );
        } finally {
            this.running = false;
        }
    }

    private async claimRestore(): Promise<RestoreClaim | null> {
        return this.prisma.$transaction(async (tx) => {
            // Prisma has no FOR UPDATE SKIP LOCKED, and parallel workers must never claim the same restore.
            const [candidate] = await tx.$queryRaw<{ id: string }[]>`
                SELECT id
                  FROM backup_restores
                 WHERE status='queued'
                 ORDER BY requested_at ASC
                 FOR UPDATE SKIP LOCKED
                 LIMIT 1`;

            if (!candidate) return null;

            return tx.backup_restores.update({
                where: { id: candidate.id },
                data: {
                    status: "running",
                    updated_at: new Date(),
                    notes: "Isolated PostgreSQL restore verification running",
                },
                select: { id: true, backup_job_id: true },
            });
        });
    }

    private async loadSourceBackup(jobId: string): Promise<any> {
        const job = await this.prisma.backup_jobs.findUnique({
            where: { id: jobId },
            select: {
                id: true,
                status: true,
                backup_kind: true,
                verified: true,
                size_bytes: true,
                archive_name: true,
                checksum: true,
                artifact_location: true,
                backup_job_manifests: { select: { manifest: true } },
                backup_job_artifacts: {
                    where: { artifact_type: "postgresql-custom" },
                    orderBy: { created_at: "desc" },
                    take: 1,
                    select: {
                        artifact_type: true,
                        storage_location: true,
                        size_bytes: true,
                        checksum: true,
                    },
                },
            },
        });

        if (!job) {
            throw new Error("Backup job not found");
        }

        const artifact = job.backup_job_artifacts[0];

        const source: any = {
            id: job.id,
            status: job.status,
            backup_kind: job.backup_kind,
            verified: job.verified,
            size_bytes: job.size_bytes?.toString() ?? null,
            archive_name: job.archive_name,
            checksum: job.checksum,
            artifact_location: job.artifact_location,
            manifest: job.backup_job_manifests?.manifest ?? null,
            artifact_type: artifact?.artifact_type ?? null,
            storage_location: artifact?.storage_location ?? null,
            artifact_size_bytes: artifact?.size_bytes?.toString() ?? null,
            artifact_checksum: artifact?.checksum ?? null,
        };
        const manifest = source.manifest || {};

        if (source.status !== "completed") {
            throw new Error("Backup job is not completed");
        }

        if (source.backup_kind !== "postgresql") {
            throw new Error(
                "Only PostgreSQL disaster-recovery backups can be restored"
            );
        }

        if (source.verified !== true) {
            throw new Error("Backup job is not verified");
        }

        if (
            manifest.backupKind !== "postgresql" ||
            manifest.complete !== true ||
            manifest.verified !== true
        ) {
            throw new Error("Backup manifest is not verified and complete");
        }

        if (source.artifact_type !== "postgresql-custom") {
            throw new Error("PostgreSQL artifact metadata missing");
        }

        const checksums = [
            source.checksum,
            source.artifact_checksum,
            manifest?.artifact?.checksum?.value,
        ].map((v) => String(v || "").toLowerCase());

        if (
            checksums.some((v) => !/^[a-f0-9]{64}$/.test(v)) ||
            new Set(checksums).size !== 1
        ) {
            throw new Error(
                "Backup checksum metadata is missing or inconsistent"
            );
        }

        return source;
    }

    private async retrieveArtifact(
        source: any,
        outFile: string
    ): Promise<void> {
        const loc = source.artifact_location || {};

        if (loc.kind === "local") {
            if (!loc.path) {
                throw new Error("Local artifact path missing");
            }

            await fsp.copyFile(loc.path, outFile);
            await fsp.chmod(outFile, 0o600);
            return;
        }

        if (loc.kind === "s3") {
            const connectionId = loc.connectionId;
            if (!connectionId) {
                throw new Error("S3 connection ID missing");
            }

            const row = await findStorageConnection(this.prisma, connectionId, "s3");

            if (!row) {
                throw new Error("S3 connection not found");
            }

            const cfg = {
                ...(row.config || {}),
                ...(row.secrets || {}),
            };

            const bucket = loc.bucket || cfg.bucket;
            const key = loc.key;

            if (!bucket || !key) {
                throw new Error("S3 artifact location incomplete");
            }

            await s3DownloadToFile(
                cfg,
                bucket,
                key,
                outFile
            );
            return;
        }

        if (loc.kind === "nextcloud") {
            const row = await findStorageConnection(this.prisma, loc.connectionId, "nextcloud");

            if (!row) {
                throw new Error("Nextcloud connection not found");
            }

            const buf = await webdavDownloadAsBuffer({
                url: row.config?.webdavUrl,
                username: row.config?.username,
                password: row.secrets?.password,
                remotePath: loc.path,
            });

            await fsp.writeFile(outFile, buf, {
                mode: 0o600,
            });
            return;
        }

        if (loc.kind === "gdrive") {
            const row = await findStorageConnection(this.prisma, loc.connectionId, "gdrive");

            if (!row) {
                throw new Error("Google Drive connection not found");
            }

            const buf = await gdriveDownloadAsBuffer({
                credentialsJson:
                    row.secrets?.serviceAccountJson,
                fileId: loc.fileId,
            });

            await fsp.writeFile(outFile, buf, {
                mode: 0o600,
            });
            return;
        }

        if (loc.kind === "remote") {
            const row = await findStorageConnection(this.prisma, loc.connectionId, "sftp");

            if (!row) {
                throw new Error("SFTP connection not found");
            }

            await sftpDownloadToFile({
                host: row.config?.host,
                port: Number(row.config?.port || 22),
                username:
                    row.secrets?.username ||
                    row.config?.username,
                password: row.secrets?.password,
                privateKey:
                    row.secrets?.privateKey ||
                    row.secrets?.privateKeyPem ||
                    row.config?.privateKey,
                passphrase: row.secrets?.passphrase,
                remotePath: loc.path,
                outFile,
            });
            return;
        }

        throw new Error(
            `Unsupported restore artifact location '${loc.kind || "unknown"}'`
        );
    }

    /**
     * Gets the retrieved artifact ready for pg_restore, and reports whether it was encrypted. The manifest
     * and the file have to agree, so a swapped file cannot turn an encrypted backup into a plain one.
     */
    private async prepareDump(
        source: any,
        artifactPath: string,
        dumpPath: string
    ): Promise<boolean> {
        const expected = Boolean(source.manifest?.artifact?.encryption);
        const actual = await isEncryptedArchiveFile(artifactPath);

        if (expected !== actual) {
            throw new Error(
                expected
                    ? "The backup manifest says this artifact is encrypted, but the file is not"
                    : "The backup manifest says this artifact is not encrypted, but the file is"
            );
        }

        if (actual) {
            await decryptArchiveFile(artifactPath, dumpPath);
            await fsp.rm(artifactPath, { force: true });
        } else {
            await fsp.rename(artifactPath, dumpPath);
        }

        return actual;
    }

    private poolForDatabase(databaseName: string): any {
        const ssl =
            (process.env.DATABASE_SSL || "")
                .toLowerCase() === "true"
                ? { rejectUnauthorized: false }
                : undefined;

        return new Pool({
            connectionString:
                getPostgresDatabaseUrl(databaseName),
            ssl,
            max: 2,
            min: 0,
        });
    }

    private assertRestoreDatabaseName(name: string): void {
        if (!/^adgrmm_restore_[a-f0-9_]+$/.test(name)) {
            throw new Error("Unsafe restore database name");
        }
    }

    private async createDatabase(name: string): Promise<void> {
        this.assertRestoreDatabaseName(name);

        const pool = this.poolForDatabase("postgres");

        try {
            await pool.query(
                `CREATE DATABASE "${name}" TEMPLATE template0`
            );
        } finally {
            await pool.end();
        }
    }

    private async dropDatabase(name: string): Promise<void> {
        this.assertRestoreDatabaseName(name);

        const pool = this.poolForDatabase("postgres");

        try {
            await pool.query(
                `SELECT pg_terminate_backend(pid)
                   FROM pg_stat_activity
                  WHERE datname=$1
                    AND pid <> pg_backend_pid()`,
                [name]
            );

            await pool.query(
                `DROP DATABASE IF EXISTS "${name}"`
            );
        } finally {
            await pool.end();
        }
    }

    private normalizeMigrations(rows: any[]): any[] {
        return rows.map((row) => ({
            migration_name: String(row.migration_name),
            checksum: String(row.checksum),
            applied_steps_count:
                Number(row.applied_steps_count),
        }));
    }

    private async readMigrations(pool: any): Promise<any[]> {
        const result = await pool.query(
            `SELECT
                 migration_name,
                 checksum,
                 applied_steps_count
               FROM "_prisma_migrations"
              WHERE finished_at IS NOT NULL
                AND rolled_back_at IS NULL
              ORDER BY started_at ASC`
        );

        return this.normalizeMigrations(result.rows);
    }

    private async runCommand(
        command: string,
        args: string[],
        env: NodeJS.ProcessEnv,
        cwd: string
    ): Promise<{ stdout: string; stderr: string }> {
        return new Promise((resolve, reject) => {
            const child = spawn(command, args, {
                cwd,
                env,
                stdio: ["ignore", "pipe", "pipe"],
            });

            let stdout = "";
            let stderr = "";

            child.stdout?.on("data", (chunk) => {
                if (stdout.length < 2 * 1024 * 1024) {
                    stdout += String(chunk);
                }
            });

            child.stderr?.on("data", (chunk) => {
                if (stderr.length < 2 * 1024 * 1024) {
                    stderr += String(chunk);
                }
            });

            child.on("error", reject);

            child.on("close", (code) => {
                if (code === 0) {
                    resolve({ stdout, stderr });
                    return;
                }

                reject(
                    new Error(
                        `${command} exited with status ${code}: ` +
                        `${(stderr || stdout).trim().slice(0, 4000)}`
                    )
                );
            });
        });
    }

    private async applyCurrentMigrations(
        databaseName: string
    ): Promise<void> {
        const url = getPostgresDatabaseUrl(databaseName);

        await this.runCommand(
            "npm",
            ["run", "prisma:migrate:deploy"],
            {
                ...process.env,
                DATABASE_URL: url,
                PG_URL: url,
            },
            "/opt/adgrmm/backend-repo/backend"
        );
    }

    private async neutralizeInterruptedWork(
        pool: any
    ): Promise<{
        backupJobs: number;
        restores: number;
        runDestinations: number;
    }> {
        const jobs = await pool.query(
            `UPDATE backup_jobs
                SET status='failed',
                    verified=false,
                    finished_at=COALESCE(finished_at, NOW()),
                    error=COALESCE(
                        error,
                        'Interrupted by PostgreSQL database recovery'
                    ),
                    note='Interrupted by PostgreSQL database recovery'
              WHERE status IN ('queued','running')`
        );

        const restores = await pool.query(
            `UPDATE backup_restores
                SET status='failed',
                    finished_at=COALESCE(finished_at, NOW()),
                    error=COALESCE(
                        error,
                        'Interrupted by PostgreSQL database recovery'
                    ),
                    updated_at=NOW()
              WHERE status IN ('queued','running')`
        );

        const destinations = await pool.query(
            `UPDATE backup_run_destinations
                SET status='failed',
                    error=COALESCE(
                        error,
                        'Interrupted by PostgreSQL database recovery'
                    ),
                    finished_at=COALESCE(finished_at, NOW())
              WHERE status IN ('pending','running')`
        );

        return {
            backupJobs: Number(jobs.rowCount || 0),
            restores: Number(restores.rowCount || 0),
            runDestinations:
                Number(destinations.rowCount || 0),
        };
    }

    private async findFreePort(): Promise<number> {
        const net = await import("net");

        return new Promise((resolve, reject) => {
            const server = net.createServer();

            server.once("error", reject);

            server.listen(
                0,
                "127.0.0.1",
                () => {
                    const address = server.address();

                    if (
                        !address ||
                        typeof address === "string"
                    ) {
                        server.close();
                        reject(
                            new Error(
                                "Unable to allocate verification port"
                            )
                        );
                        return;
                    }

                    const port = address.port;

                    server.close((error) => {
                        if (error) reject(error);
                        else resolve(port);
                    });
                }
            );
        });
    }

    private async healthOk(port: number): Promise<boolean> {
        return new Promise((resolve) => {
            const req = http.get(
                {
                    hostname: "127.0.0.1",
                    port,
                    path: "/healthz",
                    timeout: 1000,
                },
                (res) => {
                    res.resume();
                    resolve(res.statusCode === 200);
                }
            );

            req.on("timeout", () => {
                req.destroy();
                resolve(false);
            });

            req.on("error", () => resolve(false));
        });
    }

    private async stopChild(
        child: ChildProcess
    ): Promise<void> {
        if (child.exitCode !== null) return;

        child.kill("SIGTERM");

        await Promise.race([
            new Promise<void>((resolve) =>
                child.once("exit", () => resolve())
            ),
            new Promise<void>((resolve) =>
                setTimeout(resolve, 5000)
            ),
        ]);

        if (child.exitCode === null) {
            child.kill("SIGKILL");
        }
    }

    private async verifyApplicationBoot(
        databaseName: string
    ): Promise<{
        port: number;
        httpStatus: number;
        logSha256: string;
    }> {
        const port = await this.findFreePort();
        const databaseUrl =
            getPostgresDatabaseUrl(databaseName);

        let output = "";

        const child = spawn(
            "/usr/local/bin/node",
            ["/opt/adgrmm/backend-repo/backend/dist/main.js"],
            {
                cwd: "/opt/adgrmm/backend-repo/backend",
                env: {
                    ...process.env,
                    DATABASE_URL: databaseUrl,
                    PG_URL: databaseUrl,
                    PORT: String(port),
                },
                stdio: ["ignore", "pipe", "pipe"],
            }
        );

        child.stdout?.on("data", (chunk) => {
            if (output.length < 2 * 1024 * 1024) {
                output += String(chunk);
            }
        });

        child.stderr?.on("data", (chunk) => {
            if (output.length < 2 * 1024 * 1024) {
                output += String(chunk);
            }
        });

        try {
            for (let i = 0; i < 80; i++) {
                if (child.exitCode !== null) {
                    throw new Error(
                        "Verification application exited before health check: " +
                        output.slice(-4000)
                    );
                }

                if (await this.healthOk(port)) {
                    return {
                        port,
                        httpStatus: 200,
                        logSha256: crypto
                            .createHash("sha256")
                            .update(output)
                            .digest("hex"),
                    };
                }

                await new Promise((resolve) =>
                    setTimeout(resolve, 500)
                );
            }

            throw new Error(
                "Verification application did not become healthy: " +
                output.slice(-4000)
            );
        } finally {
            await this.stopChild(child);
        }
    }

    private async processRestore(
        restoreId: string,
        backupJobId: string
    ): Promise<void> {
        const tmpRoot = await fsp.mkdtemp(
            path.join(os.tmpdir(), "adgrmm-restore-")
        );

        await fsp.chmod(tmpRoot, 0o700);

        const dbName =
            "adgrmm_restore_" +
            restoreId
                .replace(/-/g, "")
                .slice(0, 16)
                .toLowerCase();

        const artifactPath =
            path.join(tmpRoot, "backup.artifact");
        const dumpPath =
            path.join(tmpRoot, "backup.dump");

        const verification: any = {
            mode: "isolated-verification",
            productionDatabaseChanged: false,
            backupJobId,
            restoreId,
            startedAt: new Date().toISOString(),
        };

        let databaseCreated = false;

        try {
            const source =
                await this.loadSourceBackup(backupJobId);

            await this.retrieveArtifact(
                source,
                artifactPath
            );

            const stat = await fsp.stat(artifactPath);
            const sizeBytes =
                Number((stat as any).size ?? 0);

            if (
                !Number.isFinite(sizeBytes) ||
                sizeBytes <= 0
            ) {
                throw new Error(
                    "Retrieved PostgreSQL artifact is empty"
                );
            }

            const actualChecksum =
                await sha256File(artifactPath);

            const expectedChecksum =
                String(source.checksum).toLowerCase();

            if (actualChecksum !== expectedChecksum) {
                throw new Error(
                    "Retrieved artifact SHA-256 does not match metadata"
                );
            }

            const expectedJobSize =
                Number(source.size_bytes || 0);
            const expectedArtifactSize =
                Number(source.artifact_size_bytes || 0);
            const expectedManifestSize =
                Number(
                    source.manifest?.artifact?.sizeBytes ||
                    0
                );

            const expectedSizes = [
                expectedJobSize,
                expectedArtifactSize,
                expectedManifestSize,
            ].filter((v) => v > 0);

            if (
                expectedSizes.some(
                    (value) => value !== sizeBytes
                )
            ) {
                throw new Error(
                    "Retrieved artifact size does not match metadata"
                );
            }

            verification.artifact = {
                sizeBytes,
                checksumAlgorithm: "sha256",
                checksum: actualChecksum,
                metadataAgreement: true,
            };

            verification.artifact.encrypted =
                await this.prepareDump(source, artifactPath, dumpPath);

            await validatePostgresDump(dumpPath);

            verification.pgRestoreListValidated = true;

            await this.createDatabase(dbName);
            databaseCreated = true;

            await this.prisma.backup_restores.updateMany({
                where: { id: restoreId },
                data: {
                    restore_database: dbName,
                    updated_at: new Date(),
                },
            });

            await restorePostgresDump(
                dumpPath,
                dbName
            );

            verification.pgRestoreCompleted = true;

            let restoredPool =
                this.poolForDatabase(dbName);

            try {
                const snapshotMigrations =
                    await this.readMigrations(restoredPool);

                const expectedSnapshotMigrations =
                    this.normalizeMigrations(
                        source.manifest?.postgresql
                            ?.migrations || []
                    );

                if (
                    JSON.stringify(snapshotMigrations) !==
                    JSON.stringify(
                        expectedSnapshotMigrations
                    )
                ) {
                    throw new Error(
                        "Restored snapshot migration history does not match backup manifest"
                    );
                }

                verification.snapshotMigrationHistory = {
                    exactMatch: true,
                    count:
                        snapshotMigrations.length,
                };

                const tables = await restoredPool.query(
                    `SELECT count(*)::int AS count
                       FROM pg_tables
                      WHERE schemaname='public'`
                );

                verification.snapshotPublicTables =
                    Number(
                        tables.rows?.[0]?.count || 0
                    );
            } finally {
                await restoredPool.end();
            }

            await this.applyCurrentMigrations(dbName);

            restoredPool =
                this.poolForDatabase(dbName);

            try {
                const currentRestoredMigrations =
                    await this.readMigrations(restoredPool);

                const productionMigrations =
                    this.normalizeMigrations(
                        // Prisma keeps _prisma_migrations out of its own client.
                        await this.prisma.$queryRaw<any[]>`
                            SELECT migration_name,
                                   checksum,
                                   applied_steps_count
                              FROM "_prisma_migrations"
                             WHERE finished_at IS NOT NULL
                               AND rolled_back_at IS NULL
                             ORDER BY started_at ASC`
                    );

                if (
                    JSON.stringify(
                        currentRestoredMigrations
                    ) !==
                    JSON.stringify(productionMigrations)
                ) {
                    throw new Error(
                        "Restored database does not match current migration history"
                    );
                }

                verification.currentMigrationHistory = {
                    exactMatch: true,
                    count:
                        currentRestoredMigrations.length,
                };

                verification.interruptedWork =
                    await this.neutralizeInterruptedWork(
                        restoredPool
                    );
            } finally {
                await restoredPool.end();
            }

            const productionDatabase =
                getPostgresConnectionMetadata().database;

            const productionSchema =
                await schemaFingerprint(
                    productionDatabase
                );

            const restoredSchema =
                await schemaFingerprint(dbName);

            verification.schema = {
                production: productionSchema,
                restored: restoredSchema,
                exactMatch:
                    productionSchema.sha256 ===
                    restoredSchema.sha256,
            };

            if (!verification.schema.exactMatch) {
                throw new Error(
                    "Restored database schema fingerprint does not match production"
                );
            }

            verification.application =
                await this.verifyApplicationBoot(
                    dbName
                );

            verification.completedAt =
                new Date().toISOString();
            verification.verified = true;

            await this.dropDatabase(dbName);
            databaseCreated = false;

            await fsp.rm(tmpRoot, {
                recursive: true,
                force: true,
            });

            await this.prisma.backup_restores.updateMany({
                where: { id: restoreId },
                data: {
                    status: "completed",
                    finished_at: new Date(),
                    error: null,
                    notes:
                        "Isolated restore verification completed; production database unchanged",
                    verification: toJsonValue(verification),
                    updated_at: new Date(),
                },
            });

            this.log.log(
                `Restore verification ${restoreId} completed for backup ${backupJobId}`
            );
        } catch (error: any) {
            const message =
                error?.message ||
                "PostgreSQL restore verification failed";

            verification.completedAt =
                new Date().toISOString();
            verification.verified = false;
            verification.error = message;

            if (databaseCreated) {
                try {
                    await this.dropDatabase(dbName);
                    databaseCreated = false;
                } catch (cleanupError: any) {
                    verification.databaseCleanupError =
                        cleanupError?.message ||
                        String(cleanupError);
                }
            }

            try {
                await fsp.rm(tmpRoot, {
                    recursive: true,
                    force: true,
                });
            } catch (cleanupError: any) {
                verification.tempCleanupError =
                    cleanupError?.message ||
                    String(cleanupError);
            }

            await this.prisma.backup_restores.updateMany({
                where: { id: restoreId },
                data: {
                    status: "failed",
                    finished_at: new Date(),
                    error: message,
                    verification: toJsonValue(verification),
                    updated_at: new Date(),
                },
            });

            this.log.error(
                `Restore verification ${restoreId} failed: ${message}`
            );
        }
    }
}
