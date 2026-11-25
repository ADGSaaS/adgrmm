import { Injectable, Logger } from "@nestjs/common";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as os from "os";
import * as path from "path";
import archiver from "archiver";
import { PrismaService } from "../storage/prisma.service";
import {
    s3PutObject,
    s3Head,
    ensureDir,
    webdavUpload,
    gdriveUpload,
    sftpUpload,
} from "./storage-clients";
import {
    ENCRYPTED_ARCHIVE_SUFFIX,
    archiveEncryptionManifest,
    encryptArchiveFile,
} from "./archive-crypto";
import { NotifierService } from "./notifier.service";
import { findStorageConnection, toJsonValue } from "./storage-connection-lookup";
import {
    SupportedBackupTarget,
    SUPPORTED_BACKUP_TARGETS,
    getBackupSourceForTarget,
    getUnsupportedBackupTargets,
    normalizeBackupTargets,
} from "./backup-targets";
import {
    createPostgresDump,
    getPostgresConnectionMetadata,
    getPostgresToolVersions,
    sha256File,
    validatePostgresDump,
} from "./postgres-dr";

type Job = { id: string; status: string; cancelled: boolean };

type FanoutDest =
    | { kind: "local"; path: string; priority?: number }
    | { kind: "s3"; connectionId: string; bucket?: string; prefix?: string; priority?: number }
    | { kind: "nextcloud"; connectionId: string; path: string; priority?: number }
    | { kind: "gdrive"; connectionId: string; subfolder?: string; priority?: number }
    | { kind: "remote"; connectionId: string; path: string; priority?: number };

type JobConfig = {
    backupKind: "logical" | "postgresql";
    targets: string[];
    destination:
    | { kind: "local"; path: string }
    | { kind: "s3"; connectionId: string; bucket?: string; prefix?: string }
    | { kind: "nextcloud"; connectionId: string; path: string }
    | { kind: "gdrive"; connectionId: string; subfolder?: string }
    | { kind: "remote"; connectionId: string; path: string };
    extras: FanoutDest[]; // additional destinations (fan-out)
    notifications: { email?: boolean; slack?: boolean; webhook?: boolean };
    /** Runner hints (from policy.options) */
    minSuccess?: number;
    parallelism?: number;
    /** Encrypt the artifact before it leaves this machine. */
    encrypt: boolean;
};

@Injectable()
export class WorkerService {
    private log = new Logger("BackupsWorker");
    private running = false;

    constructor(
        private readonly prisma: PrismaService,
        private readonly notifier: NotifierService
    ) { }

    /** Picks the oldest running job and processes it (re-entrant safe). */
    async runOneIfAny() {
        if (this.running) return;
        const job = await this.claimJob();
        if (!job) return;

        this.running = true;
        try {
            await this.process(job.id);
        } finally {
            this.running = false;
        }
    }

    private async claimJob(): Promise<Job | null> {
        return this.prisma.$transaction(async (tx) => {
            // Prisma has no FOR UPDATE SKIP LOCKED, and parallel workers must never claim the same job.
            const [candidate] = await tx.$queryRaw<{ id: string; note: string | null }[]>`
                SELECT id, note
                  FROM backup_jobs
                 WHERE status='queued'
                   AND cancelled=false
                 ORDER BY started_at ASC
                 FOR UPDATE SKIP LOCKED
                 LIMIT 1`;

            if (!candidate) return null;

            return tx.backup_jobs.update({
                where: { id: candidate.id },
                data: {
                    status: "running",
                    note: candidate.note || "Worker running",
                },
                select: { id: true, status: true, cancelled: true },
            });
        });
    }

    private async appendLog(jobId: string, chunk: string) {
        // Prisma has no atomic text append, and replicas log concurrently, so read-then-write would lose lines.
        await this.prisma.$executeRaw`
            INSERT INTO backup_job_logs (job_id, log_text)
            VALUES (${jobId}::text::uuid, ${chunk})
            ON CONFLICT (job_id)
            DO UPDATE SET log_text = backup_job_logs.log_text || EXCLUDED.log_text`;
    }

    private async saveManifest(jobId: string, manifest: any) {
        const value = toJsonValue(manifest);
        await this.prisma.backup_job_manifests.upsert({
            where: { job_id: jobId },
            create: { job_id: jobId, manifest: value },
            update: { manifest: value, updated_at: new Date() },
        });
    }

    /** Every column of a target's canonical table, keyed so a new target cannot compile without a reader. */
    private readTargetRows(target: string): Promise<unknown[]> {
        const readers: Record<SupportedBackupTarget, () => Promise<unknown[]>> = {
            users: () => this.prisma.users.findMany(),
            roles: () => this.prisma.roles.findMany(),
            devices: () => this.prisma.devices.findMany(),
            settings: () => this.prisma.organization_settings.findMany(),
        };
        return readers[target as SupportedBackupTarget]();
    }

    /** simple bounded-concurrency helper */
    private async pLimit<T>(limit: number, tasks: (() => Promise<T>)[]) {
        const results: Promise<T>[] = [];
        const pool: Promise<void>[] = [];
        let i = 0;
        const run = async () => {
            while (i < tasks.length) {
                const idx = i++;
                results[idx] = tasks[idx]();
                await results[idx].then(() => void 0, () => void 0);
            }
        };
        for (let k = 0; k < Math.max(1, limit); k++) pool.push(run());
        await Promise.all(pool);
        return Promise.allSettled(results);
    }

    /**
     * Process a single job:
     *  - export selected targets to NDJSON (skip missing)
     *  - tar.gz into an archive
     *  - write to local path or upload to remote destination(s)
     *  - fan-out to extra destinations
     *  - persist manifest/log
     *  - mark success (respecting minSuccess)
     */
    async process(jobId: string) {
        const started = Date.now();

        const cfg = await this.loadJobConfig(jobId);
        if (!cfg) {
            await this.fail(jobId, "Backup configuration missing");
            return;
        }

        const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "remoteiq-bkp-"));
        const exportDir = path.join(tmpRoot, "export");
        await ensureDir(exportDir);
        let manifest: any = null;

        try {
            if (cfg.backupKind === "postgresql") {
                await this.processPostgresql(jobId, cfg, tmpRoot, started);
                return;
            }

            // Export targets -> NDJSON files.
            // A requested target must be fully exported or the whole job fails.
            const targets = normalizeBackupTargets(
                cfg.targets.length ? cfg.targets : SUPPORTED_BACKUP_TARGETS
            );

            manifest = {
                id: jobId,
                targets,
                requestedTargets: targets,
                includedTargets: [],
                skippedTargets: [],
                failedTargets: [],
                files: [],
                counts: {},
                sources: {},
                complete: false,
                verified: false,
                createdAt: new Date().toISOString(),
            };

            await this.appendLog(jobId, `Exporting targets: ${targets.join(", ")}
`);

            const unsupported = getUnsupportedBackupTargets(targets);
            if (unsupported.length) {
                manifest.failedTargets.push(...unsupported);
                manifest.error =
                    `Unsupported backup target(s): ${unsupported.join(", ")}`;
                await this.appendLog(jobId, `${manifest.error}
`);
                await this.saveManifest(jobId, manifest);
                throw new Error(manifest.error);
            }

            const resolvedTables: Record<string, string> = {};

            for (const t of targets) {
                const table = await this.resolveExistingTableForTarget(jobId, t);

                if (!table) {
                    manifest.failedTargets.push(t);
                    manifest.counts[t] = null;
                    manifest.error = `Canonical source unavailable for backup target "${t}"`;
                    await this.appendLog(jobId, `  - ${t}: FAILED (${manifest.error})
`);
                    await this.saveManifest(jobId, manifest);
                    throw new Error(manifest.error);
                }

                resolvedTables[t] = table;
            }

            for (const t of targets) {
                const table = resolvedTables[t];
                const file = path.join(exportDir, `${t}.ndjson`);
                const ws = fs.createWriteStream(file, { flags: "w" });

                try {
                    const rows = await this.readTargetRows(t);
                    let count = 0;

                    for (const row of rows) {
                        ws.write(JSON.stringify(row) + "\n");
                        count++;
                    }

                    await new Promise((r) => ws.end(r));

                    manifest.files.push(path.basename(file));
                    manifest.counts[t] = count;
                    manifest.sources[t] = table;
                    manifest.includedTargets.push(t);

                    await this.appendLog(
                        jobId,
                        `  - ${t}: ${count} rows (from ${table})
`
                    );
                } catch (e: any) {
                    await new Promise((r) => ws.end(r));

                    manifest.failedTargets.push(t);
                    manifest.counts[t] = null;
                    manifest.error =
                        `Failed reading backup target "${t}" from ${table}: ` +
                        `${e?.message || e}`;

                    await this.appendLog(jobId, `  - ${t}: FAILED (${manifest.error})
`);
                    await this.saveManifest(jobId, manifest);
                    throw new Error(manifest.error);
                }
            }

            manifest.complete =
                manifest.includedTargets.length === targets.length &&
                manifest.failedTargets.length === 0 &&
                manifest.skippedTargets.length === 0;

            if (!manifest.complete) {
                manifest.error = "Backup export is incomplete";
                await this.saveManifest(jobId, manifest);
                throw new Error(manifest.error);
            }

            // Create archive (.tar.gz)
            let archiveName = `backup_${new Date()
                .toISOString()
                .replace(/[:]/g, "-")
                .replace(/\..+/, "")}.tar.gz`;
            let archivePath = path.join(tmpRoot, archiveName);
            await this.createTarGz(exportDir, archivePath);

            if (cfg.encrypt) {
                archivePath = await this.encryptArtifact(jobId, archivePath);
                archiveName = path.basename(archivePath);
            }

            const stat = await fsp.stat(archivePath);
            const checksum = await sha256File(archivePath);

            manifest.artifact = {
                type: "logical-export-tar-gz",
                name: archiveName,
                sizeBytes: ((stat as any).size ?? 0),
                checksum: {
                    algorithm: "sha256",
                    value: checksum,
                },
                ...(cfg.encrypt ? { encryption: archiveEncryptionManifest() } : {}),
            };

            await this.appendLog(
                jobId,
                `Archive created: ${archiveName} (${((stat as any).size ?? 0)} bytes) SHA256=${checksum}\n`
            );

            // Upload primary destination
            const dest = cfg.destination as any;
            let artifactLoc: any = null;
            let successCount = 0;

            if (dest.kind === "local") {
                const full = path.join(dest.path, path.basename(archivePath));
                await ensureDir(dest.path);
                await fsp.copyFile(archivePath, full);
                await fsp.chmod(full, 0o600);
                artifactLoc = { kind: "local", path: full };
                await this.appendLog(jobId, `Saved to local path: ${full}\n`);
                successCount += 1;
            } else if (dest.kind === "s3") {
                const cid = dest.connectionId;
                const conn = await findStorageConnection(this.prisma, cid, "s3");
                if (!conn) throw new Error("S3 connection not found");
                const cfgS3 = { ...(conn.config || {}), ...(conn.secrets || {}) };
                const bucket = dest.bucket || cfgS3.bucket;
                if (!bucket) throw new Error("S3 bucket not specified");
                const prefix = (dest.prefix || cfgS3.prefix || "").replace(/^\/+|\/+$/g, "");
                const key = (prefix ? `${prefix}/` : "") + path.basename(archivePath);
                await s3PutObject(cfgS3, bucket, key, fs.createReadStream(archivePath));
                await s3Head(cfgS3, bucket, key);
                artifactLoc = {
                    kind: "s3",
                    bucket,
                    key,
                    connectionId: cid,
                    region: cfgS3.region,
                    endpoint: cfgS3.endpoint,
                };
                await this.appendLog(jobId, `Uploaded to s3://${bucket}/${key}\n`);
                successCount += 1;
            } else if (dest.kind === "nextcloud") {
                const cid = dest.connectionId;
                const conn = await findStorageConnection(this.prisma, cid, "nextcloud");
                if (!conn) throw new Error("Nextcloud connection not found");
                const webdavUrl = conn.config?.webdavUrl;
                const username = conn.config?.username;
                const password = conn.secrets?.password;
                const directory = String(dest.path || conn.config?.path || "/").trim();
                if (!webdavUrl || !username || !password) {
                    throw new Error("Nextcloud connection incomplete (need webdavUrl, username, password)");
                }
                const remotePath = await webdavUpload({
                    url: webdavUrl,
                    username,
                    password,
                    directory,
                    filename: path.basename(archivePath),
                    body: fs.createReadStream(archivePath),
                });
                artifactLoc = { kind: "nextcloud", connectionId: cid, path: remotePath };
                await this.appendLog(jobId, `Uploaded to Nextcloud ${remotePath}\n`);
                successCount += 1;
            } else if (dest.kind === "gdrive") {
                const cid = dest.connectionId;
                const conn = await findStorageConnection(this.prisma, cid, "gdrive");
                if (!conn) throw new Error("GDrive connection not found");

                const credentialsJson = conn.secrets?.serviceAccountJson;
                const folderId: string | undefined = conn.config?.folderId;
                if (!credentialsJson || !folderId) {
                    throw new Error("GDrive connection incomplete (missing service account JSON or folderId)");
                }

                const { fileId } = await gdriveUpload({
                    credentialsJson,
                    folderId,
                    subfolder: dest.subfolder || undefined,
                    name: path.basename(archivePath),
                    body: fs.createReadStream(archivePath),
                });

                artifactLoc = {
                    kind: "gdrive",
                    connectionId: cid,
                    fileId,
                    name: path.basename(archivePath),
                };
                await this.appendLog(jobId, `Uploaded to Google Drive fileId=${fileId}\n`);
                successCount += 1;
            } else if (dest.kind === "remote") {
                const cid = dest.connectionId;
                const conn = await findStorageConnection(this.prisma, cid, "sftp");

                if (!conn) throw new Error("SFTP connection not found");

                const host = conn.config?.host;
                const port = Number(conn.config?.port || 22);
                const username = conn.secrets?.username || conn.config?.username;
                const password = conn.secrets?.password;
                const privateKey =
                    conn.secrets?.privateKey ||
                    conn.secrets?.privateKeyPem ||
                    conn.config?.privateKey;
                const passphrase = conn.secrets?.passphrase;
                const directory = dest.path || conn.config?.path;

                if (!host || !username || !directory) {
                    throw new Error("SFTP connection incomplete");
                }

                const uploaded = await sftpUpload({
                    host,
                    port,
                    username,
                    password,
                    privateKey,
                    passphrase,
                    directory,
                    filename: path.basename(archivePath),
                    body: fs.createReadStream(archivePath),
                });

                artifactLoc = {
                    kind: "remote",
                    connectionId: cid,
                    path: uploaded.path,
                };

                await this.appendLog(
                    jobId,
                    `Uploaded to SFTP ${uploaded.path}\n`
                );

                successCount += 1;
            } else {
                throw new Error(
                    `Destination kind '${dest.kind}' not supported for primary upload`
                );
            }

            // ---- Fan-out to extra destinations (replication) ----
            const replicaOk = await this.replicateExtras(
                jobId,
                cfg.extras || [],
                archivePath,
                path.basename(archivePath),
                cfg.parallelism ?? 2
            );
            successCount += replicaOk;

            // Enforce minSuccess if provided
            if (cfg.minSuccess && successCount < cfg.minSuccess) {
                throw new Error(`Only ${successCount} destination(s) succeeded; required minSuccess=${cfg.minSuccess}`);
            }

            // Save manifest & finalize only after every requested target
            // and the required destinations have succeeded.
            manifest.verified = true;
            manifest.completedAt = new Date().toISOString();
            await this.saveManifest(jobId, manifest);

            const durationSec = Math.max(
                1,
                Math.round((Date.now() - started) / 1000)
            );

            const finalized = await this.prisma.backup_jobs.updateMany({
                where: { id: jobId, status: "running", cancelled: false },
                data: {
                    finished_at: new Date(),
                    status: "completed",
                    size_bytes: BigInt((stat as any).size ?? 0),
                    duration_sec: durationSec,
                    verified: true,
                    error: null,
                    archive_name: archiveName,
                    checksum,
                    artifact_location: toJsonValue(artifactLoc),
                },
            });

            if (finalized.count === 0) {
                manifest.complete = false;
                manifest.verified = false;
                delete manifest.completedAt;
                manifest.cancelledAt = new Date().toISOString();
                manifest.error =
                    "Backup was cancelled before completion";

                await this.saveManifest(
                    jobId,
                    manifest
                );

                await this.appendLog(
                    jobId,
                    "Completion skipped because the job is no longer running\n"
                );

                return;
            }

            await this.prisma.backup_job_artifacts.create({
                data: {
                    backup_job_id: jobId,
                    artifact_type: "logical-export-tar-gz",
                    storage_location: JSON.stringify(artifactLoc),
                    size_bytes: BigInt((stat as any).size ?? 0),
                    checksum,
                },
            });

            await this.appendLog(jobId, `Done in ${durationSec}s
`);

            // Notify (best-effort)
            await this.notify(
                cfg.notifications,
                `Backup ${jobId} success`,
                `Size=${((stat as any).size ?? 0)} Duration=${durationSec}s DestinationsOK=${successCount}`
            );
        } catch (e: any) {
            const message = e?.message || "Worker error";
            this.log.error(`Backup job ${jobId} failed: ${message}`);

            if (manifest) {
                manifest.complete = false;
                manifest.verified = false;
                manifest.error = message;
                manifest.failedAt = new Date().toISOString();

                try {
                    await this.saveManifest(jobId, manifest);
                } catch (manifestError: any) {
                    this.log.error(
                        `Failed saving failure manifest for ${jobId}: ` +
                        `${manifestError?.message || manifestError}`
                    );
                }
            }

            const failed = await this.fail(
                jobId,
                message
            );

            if (failed) {
                try {
                    await this.notify(
                        cfg?.notifications ?? {},
                        `Backup ${jobId} failed`,
                        e?.message || "Worker error"
                    );
                } catch { }
            }
        } finally {
            // cleanup temp
            try {
                await fsp.rm(tmpRoot, { recursive: true, force: true });
            } catch { }
        }
    }

    private async processPostgresql(
        jobId: string,
        cfg: JobConfig,
        tmpRoot: string,
        started: number
    ) {
        const createdAt = new Date().toISOString();

        const manifest: any = {
            id: jobId,
            backupKind: "postgresql",
            format: "pg_dump-custom",
            complete: false,
            verified: false,
            createdAt,
        };

        try {
            const stamp = new Date()
                .toISOString()
                .replace(/[:]/g, "-")
                .replace(/\..+/, "");

            let archiveName = `remoteiq-postgresql_${stamp}.dump`;
            let archivePath = path.join(tmpRoot, archiveName);

            await this.appendLog(
                jobId,
                "Creating complete PostgreSQL disaster-recovery dump\n"
            );

            const tools = await getPostgresToolVersions();
            const connection = getPostgresConnectionMetadata();

            await createPostgresDump(archivePath);

            const dumpStat = await fsp.stat(archivePath);
            if (!Number((dumpStat as any).size)) {
                throw new Error("PostgreSQL dump artifact is empty");
            }

            // Structural validation of the custom-format archive, which pg_restore cannot do once encrypted.
            await validatePostgresDump(archivePath);

            if (cfg.encrypt) {
                archivePath = await this.encryptArtifact(jobId, archivePath);
                archiveName = path.basename(archivePath);
            }

            // Size and checksum describe the artifact as stored, which is what a restore downloads.
            const stat = await fsp.stat(archivePath);
            const sizeBytes = Number((stat as any).size ?? 0);

            if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
                throw new Error("PostgreSQL dump artifact is empty");
            }

            const checksum = await sha256File(archivePath);

            // A server setting, not a table, so Prisma has no query for it.
            const serverVersionRows = await this.prisma.$queryRaw<{ server_version: string }[]>`
                SELECT current_setting('server_version') AS server_version`;

            const serverVersion =
                serverVersionRows[0]?.server_version ?? null;

            // Prisma keeps _prisma_migrations out of its own client.
            const migrations = await this.prisma.$queryRaw<any[]>`
                SELECT migration_name,
                       checksum,
                       finished_at,
                       applied_steps_count
                  FROM "_prisma_migrations"
                 WHERE finished_at IS NOT NULL
                   AND rolled_back_at IS NULL
                 ORDER BY started_at ASC`;

            manifest.postgresql = {
                serverVersion,
                tools,
                database: connection.database,
                migrationCount: migrations.length,
                migrations,
            };

            manifest.artifact = {
                type: "postgresql-custom",
                name: archiveName,
                sizeBytes: sizeBytes,
                checksum: {
                    algorithm: "sha256",
                    value: checksum,
                },
                structureValidatedWithPgRestore: true,
                ...(cfg.encrypt ? { encryption: archiveEncryptionManifest() } : {}),
            };

            await this.appendLog(
                jobId,
                `PostgreSQL dump created: ${archiveName} (${sizeBytes} bytes) SHA256=${checksum}\n`
            );

            const dest = cfg.destination as any;
            let artifactLoc: any = null;
            let successCount = 0;

            if (dest.kind === "local") {
                const full = path.join(dest.path, archiveName);
                await ensureDir(dest.path);
                await fsp.copyFile(archivePath, full);
                await fsp.chmod(full, 0o600);

                artifactLoc = {
                    kind: "local",
                    path: full,
                };

                successCount += 1;
                await this.appendLog(jobId, `Saved DR artifact to ${full}\n`);
            } else if (dest.kind === "s3") {
                const cid = dest.connectionId;

                const conn = await findStorageConnection(this.prisma, cid, "s3");

                if (!conn) throw new Error("S3 connection not found");

                const s3Cfg = {
                    ...(conn.config || {}),
                    ...(conn.secrets || {}),
                };

                const bucket = dest.bucket || s3Cfg.bucket;
                if (!bucket) throw new Error("S3 bucket not specified");

                const prefix = (
                    dest.prefix ||
                    s3Cfg.prefix ||
                    ""
                ).replace(/^\/+|\/+$/g, "");

                const key =
                    (prefix ? `${prefix}/` : "") +
                    archiveName;

                await s3PutObject(
                    s3Cfg,
                    bucket,
                    key,
                    fs.createReadStream(archivePath)
                );

                await s3Head(s3Cfg, bucket, key);

                artifactLoc = {
                    kind: "s3",
                    bucket,
                    key,
                    connectionId: cid,
                    region: s3Cfg.region,
                    endpoint: s3Cfg.endpoint,
                };

                successCount += 1;
                await this.appendLog(
                    jobId,
                    `Uploaded DR artifact to s3://${bucket}/${key}\n`
                );
            } else if (dest.kind === "nextcloud") {
                const cid = dest.connectionId;

                const conn = await findStorageConnection(this.prisma, cid, "nextcloud");

                if (!conn) throw new Error("Nextcloud connection not found");

                const webdavUrl = conn.config?.webdavUrl;
                const username = conn.config?.username;
                const password = conn.secrets?.password;
                const directory =
                    String(dest.path || conn.config?.path || "/").trim();

                if (!webdavUrl || !username || !password) {
                    throw new Error("Nextcloud connection incomplete");
                }

                const remotePath = await webdavUpload({
                    url: webdavUrl,
                    username,
                    password,
                    directory,
                    filename: archiveName,
                    body: fs.createReadStream(archivePath),
                });

                artifactLoc = {
                    kind: "nextcloud",
                    connectionId: cid,
                    path: remotePath,
                };

                successCount += 1;
                await this.appendLog(
                    jobId,
                    `Uploaded DR artifact to Nextcloud ${remotePath}\n`
                );
            } else if (dest.kind === "gdrive") {
                const cid = dest.connectionId;

                const conn = await findStorageConnection(this.prisma, cid, "gdrive");

                if (!conn) throw new Error("GDrive connection not found");

                const credentialsJson =
                    conn.secrets?.serviceAccountJson;

                const folderId: string | undefined =
                    conn.config?.folderId;

                if (!credentialsJson || !folderId) {
                    throw new Error("GDrive connection incomplete");
                }

                const { fileId } = await gdriveUpload({
                    credentialsJson,
                    folderId,
                    subfolder: dest.subfolder || undefined,
                    name: archiveName,
                    body: fs.createReadStream(archivePath),
                    mimeType: "application/octet-stream",
                });

                artifactLoc = {
                    kind: "gdrive",
                    connectionId: cid,
                    fileId,
                    name: archiveName,
                };

                successCount += 1;
                await this.appendLog(
                    jobId,
                    `Uploaded DR artifact to Google Drive fileId=${fileId}\n`
                );
            } else if (dest.kind === "remote") {
                const cid = dest.connectionId;

                const conn = await findStorageConnection(this.prisma, cid, "sftp");

                if (!conn) throw new Error("SFTP connection not found");

                const host = conn.config?.host;
                const port = Number(conn.config?.port || 22);
                const username =
                    conn.secrets?.username || conn.config?.username;
                const password = conn.secrets?.password;
                const privateKey =
                    conn.secrets?.privateKey ||
                    conn.secrets?.privateKeyPem ||
                    conn.config?.privateKey;
                const passphrase = conn.secrets?.passphrase;
                const directory =
                    dest.path || conn.config?.path;

                if (!host || !username || !directory) {
                    throw new Error("SFTP connection incomplete");
                }

                const uploaded = await sftpUpload({
                    host,
                    port,
                    username,
                    password,
                    privateKey,
                    passphrase,
                    directory,
                    filename: archiveName,
                    body: fs.createReadStream(archivePath),
                });

                artifactLoc = {
                    kind: "remote",
                    connectionId: cid,
                    path: uploaded.path,
                };

                successCount += 1;
                await this.appendLog(
                    jobId,
                    `Uploaded DR artifact to SFTP ${uploaded.path}\n`
                );
            } else {
                throw new Error(
                    `Destination kind '${dest.kind}' not supported`
                );
            }

            const replicaOk = await this.replicateExtras(
                jobId,
                cfg.extras || [],
                archivePath,
                archiveName,
                cfg.parallelism ?? 2
            );

            successCount += replicaOk;

            if (cfg.minSuccess && successCount < cfg.minSuccess) {
                throw new Error(
                    `Only ${successCount} destination(s) succeeded; ` +
                    `required minSuccess=${cfg.minSuccess}`
                );
            }

            manifest.destinationsSucceeded = successCount;
            manifest.complete = true;
            manifest.verified = true;
            manifest.completedAt = new Date().toISOString();

            await this.saveManifest(jobId, manifest);

            const durationSec = Math.max(
                1,
                Math.round((Date.now() - started) / 1000)
            );

            const finalized = await this.prisma.backup_jobs.updateMany({
                where: { id: jobId, status: "running", cancelled: false },
                data: {
                    finished_at: new Date(),
                    status: "completed",
                    size_bytes: BigInt(sizeBytes),
                    duration_sec: durationSec,
                    verified: true,
                    error: null,
                    archive_name: archiveName,
                    checksum,
                    artifact_location: toJsonValue(artifactLoc),
                },
            });

            if (finalized.count === 0) {
                manifest.complete = false;
                manifest.verified = false;
                delete manifest.completedAt;
                manifest.cancelledAt = new Date().toISOString();
                manifest.error =
                    "Backup was cancelled before completion";

                await this.saveManifest(
                    jobId,
                    manifest
                );

                await this.appendLog(
                    jobId,
                    "Completion skipped because the job is no longer running\n"
                );

                return;
            }

            await this.prisma.backup_job_artifacts.create({
                data: {
                    backup_job_id: jobId,
                    artifact_type: "postgresql-custom",
                    storage_location: JSON.stringify(artifactLoc),
                    size_bytes: BigInt(sizeBytes),
                    checksum,
                },
            });

            await this.appendLog(
                jobId,
                `PostgreSQL DR backup verified and completed in ${durationSec}s\n`
            );

            await this.notify(
                cfg.notifications,
                `Backup ${jobId} success`,
                `PostgreSQL DR backup verified. ` +
                `Size=${sizeBytes} SHA256=${checksum} ` +
                `DestinationsOK=${successCount}`
            );
        } catch (e: any) {
            const message =
                e?.message || "PostgreSQL DR backup failed";

            manifest.complete = false;
            manifest.verified = false;
            manifest.error = message;
            manifest.failedAt = new Date().toISOString();

            try {
                await this.saveManifest(jobId, manifest);
            } catch { }

            throw e;
        }
    }

    private async fail(
        jobId: string,
        note: string
    ): Promise<boolean> {
        const { count } = await this.prisma.backup_jobs.updateMany({
            where: { id: jobId, status: "running", cancelled: false },
            data: {
                status: "failed",
                finished_at: new Date(),
                note,
                error: note,
                verified: false,
            },
        });

        return count > 0;
    }

    /** Replaces the plain artifact with an encrypted one. A job that asked for encryption never falls back to plain. */
    private async encryptArtifact(jobId: string, plainPath: string): Promise<string> {
        const encryptedPath = plainPath + ENCRYPTED_ARCHIVE_SUFFIX;
        await encryptArchiveFile(plainPath, encryptedPath);
        await fsp.rm(plainPath, { force: true });
        await this.appendLog(jobId, "Encrypted the archive\n");
        return encryptedPath;
    }

    private async createTarGz(srcDir: string, outFile: string) {
        await new Promise<void>((resolve, reject) => {
            const output = fs.createWriteStream(outFile);
            const archive = archiver("tar", { gzip: true, gzipOptions: { level: 9 } });
            output.on("close", () => resolve());
            archive.on("error", (err) => reject(err));
            archive.pipe(output);
            archive.directory(srcDir, false);
            archive.finalize().catch(reject);
        });
    }

    /**
     * Resolve a logical target through the canonical registry and verify
     * that the exact canonical source exists.
     */
    private async resolveExistingTableForTarget(
        jobId: string,
        target: string
    ): Promise<string | null> {
        const ident = getBackupSourceForTarget(target);

        if (!ident) {
            await this.appendLog(
                jobId,
                `    (unsupported backup target "${target}")
`
            );
            return null;
        }

        // Catalog check so a missing table fails the job before anything is exported; Prisma has no query for it.
        const reg = await this.prisma.$queryRaw<{ oid: string | null }[]>`
            SELECT to_regclass(${ident}::text)::text AS oid`;

        if (reg[0]?.oid) {
            return ident;
        }

        await this.appendLog(
            jobId,
            `    (canonical source "${ident}" missing for target "${target}")
`
        );
        return null;
    }

    /**
     * Load job config including the primary destination and fan-out destinations.
     */
    private async loadJobConfig(jobId: string): Promise<JobConfig | null> {
        const job = await this.prisma.backup_jobs.findUnique({
            where: { id: jobId },
            select: {
                backup_kind: true,
                config_snapshot: true,
                backup_policies: {
                    select: {
                        options: true,
                        backup_destinations: { select: { configuration: true } },
                    },
                },
            },
        });
        if (!job) return null;

        const head: any = {
            backup_kind: job.backup_kind,
            config_snapshot: job.config_snapshot,
            options: job.backup_policies?.options ?? null,
            destination_configuration:
                job.backup_policies?.backup_destinations?.configuration ?? null,
        };

        const backupKind: "logical" | "postgresql" =
            head.backup_kind === "postgresql" ? "postgresql" : "logical";

        const snapshot =
            head.config_snapshot &&
            typeof head.config_snapshot === "object"
                ? head.config_snapshot
                : {};

        if (Object.keys(snapshot).length > 0) {
            const destination =
                snapshot.destination && typeof snapshot.destination === "object"
                    ? snapshot.destination
                    : {};

            if (!destination.kind) return null;

            const targets = Array.isArray(snapshot.targets)
                ? snapshot.targets.filter((t: any) => typeof t === "string" && t.length > 0)
                : [];

            const notifications =
                snapshot.notifications && typeof snapshot.notifications === "object"
                    ? snapshot.notifications
                    : {};

            const extras: FanoutDest[] = Array.isArray(snapshot.extraDestinations)
                ? snapshot.extraDestinations.filter(
                    (d: any) => d && typeof d === "object"
                )
                : [];

            const minSuccess =
                snapshot.minSuccess != null
                    ? Number(snapshot.minSuccess)
                    : undefined;

            const parallelism =
                snapshot.parallelism != null
                    ? Number(snapshot.parallelism)
                    : undefined;

            return {
                backupKind,
                targets,
                destination,
                notifications,
                extras,
                minSuccess,
                parallelism,
                encrypt: snapshot.encrypt === true,
            };
        }

        // Compatibility path for jobs created before config_snapshot existed.
        const options = head.options && typeof head.options === "object" ? head.options : {};
        if (options.enabled === false) return null;

        const destination = head.destination_configuration || {};
        if (!destination.kind) return null;

        const targets = Array.isArray(options.targets) ? options.targets.filter(Boolean) : [];
        const notifications =
            options.notifications && typeof options.notifications === "object" ? options.notifications : {};
        const minSuccess =
            options.minSuccess != null ? Number(options.minSuccess) : undefined;
        const parallelism =
            options.parallelism != null ? Number(options.parallelism) : undefined;

        const extraRows = await this.prisma.backup_job_destinations.findMany({
            where: { job_id: jobId },
            orderBy: [{ is_primary: "desc" }, { priority: "asc" }],
            select: {
                is_primary: true,
                backup_destinations: { select: { configuration: true } },
            },
        });

        const extras: FanoutDest[] = extraRows
            .filter((r) => !r.is_primary)
            .map((r) => r.backup_destinations.configuration as unknown as FanoutDest);

        return {
            backupKind,
            targets,
            destination,
            notifications,
            extras,
            minSuccess,
            parallelism,
            encrypt: options.encrypt === true,
        };
    }

    private async notify(
        channels: { email?: boolean; slack?: boolean; webhook?: boolean },
        subject: string,
        body: string
    ) {
        try {
            await this.notifier.send(channels || {}, subject, body);
        } catch (e) {
            this.log.warn(`Notify failed: ${e}`);
        }
    }

    /**
     * Copy/upload the finished archive to each extra destination. Best-effort:
     * returns how many succeeded. Runs with bounded concurrency.
     */
    private async replicateExtras(
        jobId: string,
        extras: FanoutDest[],
        localArchivePath: string,
        finalFileName: string,
        parallelism = 2
    ): Promise<number> {
        if (!extras?.length) return 0;

        const ordered = [...extras].sort((a, b) => (a.priority ?? 1000) - (b.priority ?? 1000));

        const tasks = ordered.map((dest) => async () => {
            try {
                if (dest.kind === "local") {
                    const out = path.join(dest.path, finalFileName);
                    await ensureDir(dest.path);
                    await fsp.copyFile(localArchivePath, out);
                    await fsp.chmod(out, 0o600);
                    await this.appendLog(jobId, `[replica:local] ${out}\n`);
                    return true;
                } else if (dest.kind === "s3") {
                    const row = await findStorageConnection(this.prisma, dest.connectionId, "s3");
                    if (!row) throw new Error("S3 connection not found");
                    const s3Cfg = { ...(row.config || {}), ...(row.secrets || {}) };
                    const bucket = dest.bucket || s3Cfg.bucket;
                    if (!bucket) throw new Error("S3 bucket missing");
                    const prefix = (dest.prefix || s3Cfg.prefix || "").replace(/^\/+|\/+$/g, "");
                    const key = (prefix ? `${prefix}/` : "") + finalFileName;
                    await s3PutObject(s3Cfg, bucket, key, fs.createReadStream(localArchivePath));
                    await this.appendLog(jobId, `[replica:s3] s3://${bucket}/${key}\n`);
                    return true;
                } else if (dest.kind === "nextcloud") {
                    const row = await findStorageConnection(this.prisma, dest.connectionId, "nextcloud");
                    if (!row) throw new Error("Nextcloud connection not found");
                    const webdavUrl = row.config?.webdavUrl;
                    const username = row.config?.username;
                    const password = row.secrets?.password;
                    if (!webdavUrl || !username || !password || !dest.path) {
                        throw new Error("Nextcloud config incomplete");
                    }
                    await webdavUpload({
                        url: webdavUrl,
                        username,
                        password,
                        directory: dest.path,
                        filename: finalFileName,
                        body: fs.createReadStream(localArchivePath),
                    });
                    await this.appendLog(jobId, `[replica:nextcloud] ${dest.path}/${finalFileName}\n`);
                    return true;
                } else if (dest.kind === "gdrive") {
                    const row = await findStorageConnection(this.prisma, dest.connectionId, "gdrive");
                    if (!row) throw new Error("GDrive connection not found");
                    const credentialsJson = row.secrets?.serviceAccountJson;
                    const folderId: string | undefined = row.config?.folderId;
                    if (!credentialsJson || !folderId) throw new Error("GDrive connection incomplete");

                    await gdriveUpload({
                        credentialsJson,
                        folderId,
                        subfolder: dest.subfolder || undefined,
                        name: finalFileName,
                        body: fs.createReadStream(localArchivePath),
                    });
                    await this.appendLog(jobId, `[replica:gdrive] folderId=${folderId}${dest.subfolder ? `/${dest.subfolder}` : ""}/${finalFileName}\n`);
                    return true;
                } else if (dest.kind === "remote") {
                    const row = await findStorageConnection(this.prisma, dest.connectionId, "sftp");

                    if (!row) throw new Error("SFTP connection not found");

                    const host = row.config?.host;
                    const port = Number(row.config?.port || 22);
                    const username = row.secrets?.username || row.config?.username;
                    const password = row.secrets?.password;
                    const privateKey =
                        row.secrets?.privateKey ||
                        row.secrets?.privateKeyPem ||
                        row.config?.privateKey;
                    const passphrase = row.secrets?.passphrase;
                    const directory = dest.path || row.config?.path;

                    if (!host || !username || !directory) {
                        throw new Error("SFTP connection incomplete");
                    }

                    const uploaded = await sftpUpload({
                        host,
                        port,
                        username,
                        password,
                        privateKey,
                        passphrase,
                        directory,
                        filename: finalFileName,
                        body: fs.createReadStream(localArchivePath),
                    });

                    await this.appendLog(
                        jobId,
                        `[replica:sftp] ${uploaded.path}\n`
                    );

                    return true;
                } else {
                    await this.appendLog(jobId, `[replica:${(dest as any).kind}] Unknown kind (skipped)\n`);
                    return false;
                }
            } catch (err: any) {
                await this.appendLog(
                    jobId,
                    `[replica:${(dest as any).kind}] ERROR: ${(err?.message || String(err)).slice(0, 500)}\n`
                );
                return false;
            }
        });

        const settled = await this.pLimit(Math.max(1, Number(parallelism) || 2), tasks);
        return settled.reduce((ok, r) => ok + (r.status === "fulfilled" && r.value ? 1 : 0), 0);
    }
}
