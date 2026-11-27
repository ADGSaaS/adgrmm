import {
    BadRequestException,
    Injectable,
    NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { hasDataKey } from "../common/secret-box";
import { PrismaService } from "../storage/prisma.service";
import { OrganizationContextService } from "../storage/organization-context.service";
import { BackupConfigDto, HistoryQueryDto, FanoutDestinationDto } from "./dto";
import { Readable } from "stream";
import * as crypto from "crypto";
import { WorkerService } from "./worker.service";
import { NotifierService } from "./notifier.service";
import {
    s3PresignGet,
    webdavDownloadAsBuffer,
    gdriveDownloadAsBuffer,
    sftpDownloadAsBuffer,
} from "./storage-clients";
import {
    SUPPORTED_BACKUP_TARGETS,
    getUnsupportedBackupTargets,
    normalizeBackupTargets,
} from "./backup-targets";
import { findStorageConnection, toJsonValue } from "./storage-connection-lookup";
import { trimBoth } from "../common/text-util";
import { isAbsolutePath, sanitizeLocalPath } from "./local-path";
import * as pathMod from "path";

type JobRow = {
    id: string;
    started_at: Date;
    finished_at: Date | null;
    status: "queued" | "running" | "completed" | "failed" | "cancelled";
    backup_kind: "logical" | "postgresql";
    note: string | null;
    size_bytes: bigint | null;
    duration_sec: number | null;
    verified: boolean | null;
};

type HistoryStatus = "success" | "failed" | "running";

function mapFilterStatus(status: HistoryStatus | undefined): string | undefined {
    if (!status) return undefined;
    if (status === "success") return "completed";
    return status;
}
function projectStatus(status: string): HistoryStatus {
    switch (status) {
        case "completed": return "success";
        case "failed":
        case "cancelled": return "failed";
        default: return "running";
    }
}

function parseCursor(cur?: string | null): number {
    if (!cur) return 0;
    try {
        const { page } = JSON.parse(Buffer.from(cur, "base64").toString("utf8"));
        return Number(page) || 0;
    } catch {
        return 0;
    }
}
function makeCursor(page: number) {
    return Buffer.from(JSON.stringify({ page }), "utf8").toString("base64");
}

type PolicyRow = {
    id: string;
    backup_kind: string;
    schedule: string;
    retention: any;
    options: any;
    destination_id: string | null;
    destination_provider: string | null;
    destination_configuration: any | null;
};

const POLICY_SELECT = {
    id: true,
    backup_kind: true,
    schedule: true,
    retention: true,
    options: true,
    destination_id: true,
    backup_destinations: { select: { provider: true, configuration: true } },
} as const;

type PolicyConfig = {
    policyId: string;
    backupKind: "logical" | "postgresql";
    enabled: boolean;
    targets: string[];
    schedule: string;
    cronExpr?: string;
    retentionDays: number;
    encrypt: boolean;
    destination: any | null;
    extraDestinations: any[];
    notifications: Record<string, any>;
    lastScheduledAt?: string | null;
    minSuccess?: number | null;
    parallelism?: number | null;
};

@Injectable()
export class BackupsService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly notifier: NotifierService,
        private readonly worker: WorkerService,
        private readonly orgContext: OrganizationContextService,
    ) { }

    private async orgId(): Promise<string> {
        return this.orgContext.getDefaultOrganizationId();
    }

    private retentionDays(retention: any): number {
        if (!retention) return 30;
        if (typeof retention.days === "number") return retention.days;
        if (typeof retention.value === "number" && retention.unit === "days") return retention.value;
        return 30;
    }

    private validateTargets(targets: unknown): string[] {
        const normalized = normalizeBackupTargets(targets);

        if (!normalized.length) {
            throw new BadRequestException("Select at least one backup target");
        }

        const unsupported = getUnsupportedBackupTargets(normalized);
        if (unsupported.length) {
            throw new BadRequestException(
                `Unsupported backup target(s): ${unsupported.join(", ")}. ` +
                `Supported targets: ${SUPPORTED_BACKUP_TARGETS.join(", ")}`
            );
        }

        return normalized;
    }

    private async loadFanout(policyId: string): Promise<any[]> {
        const rows = await this.prisma.backup_policy_destinations.findMany({
            where: { policy_id: policyId },
            orderBy: [
                { is_primary: "desc" },
                { priority: "asc" },
                { backup_destinations: { name: "asc" } },
            ],
            select: { backup_destinations: { select: { configuration: true } } },
        });
        return rows.slice(1).map((r) => r.backup_destinations.configuration || {});
    }

    private parsePolicy(row: PolicyRow | null): PolicyConfig | null {
        if (!row) return null;
        const options = row.options && typeof row.options === "object" ? row.options : {};
        const backupKind: "logical" | "postgresql" =
            row.backup_kind === "postgresql" ? "postgresql" : "logical";
        const destination =
            row.destination_configuration && typeof row.destination_configuration === "object"
                ? row.destination_configuration
                : null;

        const cronExpr = options.cronExpr ?? options.cron_expr ?? undefined;
        const notifications =
            options.notifications && typeof options.notifications === "object" ? options.notifications : {};

        const enabled = options.enabled ?? false;
        const rawTargets = Array.isArray(options.targets)
            ? options.targets.filter((t: any) => typeof t === "string" && t.trim().length)
            : [];
        const targets = rawTargets.length ? rawTargets : [...SUPPORTED_BACKUP_TARGETS];
        const encrypt = options.encrypt === true;
        const lastScheduledAt = options.lastScheduledAt ?? options.last_scheduled_at ?? null;
        const minSuccess = options.minSuccess != null ? Number(options.minSuccess) : null;
        const parallelism = options.parallelism != null ? Number(options.parallelism) : null;

        return {
            policyId: row.id,
            backupKind,
            enabled,
            targets,
            schedule: row.schedule,
            cronExpr: cronExpr ?? undefined,
            retentionDays: this.retentionDays(row.retention),
            encrypt,
            destination,
            extraDestinations: [],
            notifications,
            lastScheduledAt,
            minSuccess,
            parallelism,
        };
    }

    private normalizeDestinationInput(dest: any): { provider: string; configuration: any } {
        if (!dest || typeof dest !== "object") throw new BadRequestException("Destination required");
        const provider = dest.kind === "remote" ? "sftp" : dest.kind;
        return { provider, configuration: { ...dest } };
    }

    private toPolicyRow(row: Prisma.backup_policiesGetPayload<{ select: typeof POLICY_SELECT }>): PolicyRow {
        return {
            id: row.id,
            backup_kind: row.backup_kind,
            schedule: row.schedule,
            retention: row.retention,
            options: row.options,
            destination_id: row.destination_id,
            destination_provider: row.backup_destinations?.provider ?? null,
            destination_configuration: row.backup_destinations?.configuration ?? null,
        };
    }

    private async fetchDefaultPolicyRow(): Promise<PolicyRow | null> {
        const orgId = await this.orgId();
        const row = await this.prisma.backup_policies.findFirst({
            where: { organization_id: orgId },
            orderBy: [{ is_default: "desc" }, { created_at: "asc" }],
            select: POLICY_SELECT,
        });
        return row ? this.toPolicyRow(row) : null;
    }

    private async fetchDefaultPolicy(): Promise<PolicyConfig | null> {
        const row = await this.fetchDefaultPolicyRow();
        const parsed = this.parsePolicy(row);
        if (!parsed) return null;
        parsed.extraDestinations = row?.id ? await this.loadFanout(row.id) : [];
        return parsed;
    }

    private async upsertDestination(
        orgId: string,
        dest: any,
        name: string,
    ): Promise<{ id: string; provider: string; configuration: any }> {
        const { provider, configuration } = this.normalizeDestinationInput(dest);
        const value = toJsonValue(configuration);
        return this.prisma.backup_destinations.upsert({
            where: { organization_id_name: { organization_id: orgId, name } },
            create: { organization_id: orgId, name, provider, configuration: value },
            update: { provider, configuration: value, updated_at: new Date() },
            select: { id: true, provider: true, configuration: true },
        });
    }

    private fanoutName(i: number) {
        return i === 0 ? "Default Backup Destination" : `Backup Destination #${i + 1}`;
    }

    private validateFanoutItem(item: FanoutDestinationDto) {
        if (!item || typeof item !== "object") throw new BadRequestException("Bad destination");
        switch (item.kind) {
            case "local":
                if (!item.path) throw new BadRequestException("Local path required");
                sanitizeLocalPath(item.path);
                return;
            case "s3":
            case "nextcloud":
            case "gdrive":
            case "remote":
                if (!item.connectionId || !/^[0-9a-f-]{36}$/i.test(item.connectionId)) {
                    throw new BadRequestException("Valid connectionId required");
                }
                if (item.kind === "nextcloud") {
                    const p = String(item.path || "");
                    if (!p.startsWith("/")) throw new BadRequestException("Nextcloud path must start with '/'");
                }
                if (item.kind === "remote") {
                    const p = String(item.path || "");
                    if (!isAbsolutePath(p)) throw new BadRequestException("Remote path must be absolute");
                }
                return;
            default:
                throw new BadRequestException("Unsupported destination");
        }
    }

    private async upsertPolicyWithFanout(orgId: string, cfg: BackupConfigDto): Promise<PolicyConfig | null> {
        // A client that does not send the field must not turn encryption off by saving something else.
        const encrypt = cfg.encrypt ?? (await this.fetchDefaultPolicy())?.encrypt ?? false;

        const primary = await this.upsertDestination(orgId, cfg.destination, this.fanoutName(0));

        const mergedOptions: Record<string, any> = {
            enabled: !!cfg.enabled,
            targets: cfg.targets,
            cronExpr: cfg.schedule === "cron" ? cfg.cronExpr ?? null : null,
            cron_expr: cfg.schedule === "cron" ? cfg.cronExpr ?? null : null, // legacy spell
            encrypt,
            notifications: cfg.notifications ?? {},
        };
        if (cfg.minSuccess != null) mergedOptions.minSuccess = Number(cfg.minSuccess);
        if (cfg.parallelism != null) mergedOptions.parallelism = Number(cfg.parallelism);
        if (mergedOptions.cronExpr == null) delete (mergedOptions as any).cronExpr;
        if (mergedOptions.cron_expr == null) delete (mergedOptions as any).cron_expr;

        const policyFields = {
            description: "Normalized default backups policy",
            schedule: cfg.schedule,
            retention: toJsonValue({ days: cfg.retentionDays }),
            backup_kind: cfg.backupKind ?? "logical",
            destination_id: primary.id,
            target_type: "organization" as const,
            target_id: null,
            options: toJsonValue(mergedOptions),
            is_default: true,
        };
        const policyIns = await this.prisma.backup_policies.upsert({
            where: { organization_id_name: { organization_id: orgId, name: "Default Backup Policy" } },
            create: { organization_id: orgId, name: "Default Backup Policy", ...policyFields },
            update: { ...policyFields, updated_at: new Date() },
            select: { id: true },
        });
        const policyId = policyIns.id;

        const extras = Array.isArray(cfg.extraDestinations) ? cfg.extraDestinations : [];
        for (const e of extras) this.validateFanoutItem(e);

        const withPrimary = [{ ...cfg.destination, isPrimary: true, priority: 10 } as FanoutDestinationDto]
            .concat(extras.map((e, i) => ({ ...e, isPrimary: false, priority: e.priority ?? (i + 2) * 10 })));

        const destIds: { id: string; isPrimary: boolean; priority: number }[] = [];
        for (let i = 0; i < withPrimary.length; i++) {
            const ent = withPrimary[i];
            const ins = await this.upsertDestination(orgId, ent, this.fanoutName(i));
            destIds.push({ id: ins.id, isPrimary: !!ent.isPrimary, priority: ent.priority ?? (i + 1) * 10 });
        }

        await this.prisma.backup_policy_destinations.deleteMany({ where: { policy_id: policyId } });

        if (destIds.length) {
            // Upserts, because a concurrent save may have inserted the same pairs since the delete.
            await this.prisma.$transaction(
                destIds.map((d) =>
                    this.prisma.backup_policy_destinations.upsert({
                        where: { policy_id_destination_id: { policy_id: policyId, destination_id: d.id } },
                        create: {
                            policy_id: policyId,
                            destination_id: d.id,
                            is_primary: d.isPrimary,
                            priority: d.priority,
                        },
                        update: { is_primary: d.isPrimary, priority: d.priority },
                    })
                )
            );
        }

        const detail = await this.prisma.backup_policies.findUnique({
            where: { id: policyId },
            select: POLICY_SELECT,
        });
        const parsed = this.parsePolicy(detail ? this.toPolicyRow(detail) : null);
        if (!parsed) return null;
        parsed.extraDestinations = await this.loadFanout(policyId);
        return parsed;
    }

    /* ---------------- Permissions (UI helper) --------------- */
    async getPermissions(userId: string) {
        if (
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
                userId
            )
        ) {
            return {
                restore: false,
                download: false,
            };
        }

        const rows = await this.prisma.role_permissions.findMany({
            where: {
                permission_key: { in: ["backups.restore", "backups.download"] },
                roles: { user_roles: { some: { user_id: userId } } },
            },
            distinct: ["permission_key"],
            select: { permission_key: true },
        });

        const permissions = new Set(
            rows.map((row) =>
                String(row.permission_key || "")
                    .toLowerCase()
            )
        );

        return {
            restore:
                permissions.has("backups.restore"),
            download:
                permissions.has("backups.download"),
        };
    }

    /* ---------------- Config (load/save) --------------------- */
    async getConfig() {
        const policy = await this.fetchDefaultPolicy();
        if (!policy) {
            return {
                backupKind: "logical",
                enabled: false,
                targets: [...SUPPORTED_BACKUP_TARGETS],
                schedule: "daily",
                cronExpr: "0 3 * * *",
                retentionDays: 30,
                encrypt: false,
                encryptionSupported: hasDataKey(),
                destination: { kind: "local", path: "/var/adgrmm/backups" },
                extraDestinations: [],
                notifications: { email: false, webhook: false, slack: false },
                minSuccess: 1,
                parallelism: 2,
            };
        }

        return {
            backupKind: policy.backupKind,
            enabled: policy.enabled,
            targets: policy.targets,
            schedule: policy.schedule as any,
            cronExpr: policy.cronExpr,
            retentionDays: policy.retentionDays,
            encrypt: policy.encrypt,
            encryptionSupported: hasDataKey(),
            destination: policy.destination ?? { kind: "local", path: "/var/adgrmm/backups" },
            extraDestinations: policy.extraDestinations ?? [],
            notifications: policy.notifications,
            minSuccess: policy.minSuccess ?? undefined,
            parallelism: policy.parallelism ?? undefined,
        };
    }

    validateDestination(dest: any) {
        if (!dest || typeof dest !== "object" || !dest.kind) {
            throw new BadRequestException("Destination required");
        }

        switch (dest.kind) {
            case "local":
                sanitizeLocalPath(String(dest.path || ""));
                break;
            case "s3":
            case "nextcloud":
            case "gdrive":
                if (!dest.connectionId || !/^[0-9a-f-]{36}$/i.test(dest.connectionId)) {
                    throw new BadRequestException("Valid connectionId required");
                }
                if (dest.kind === "nextcloud") {
                    const p = String(dest.path || "");
                    if (!p.startsWith("/"))
                        throw new BadRequestException("Nextcloud path must start with '/'");
                }
                break;
            case "remote":
                // still unsupported for primary
                throw new BadRequestException("Primary SFTP not yet supported. Use as an extra destination.");
            default:
                throw new BadRequestException("Unsupported destination");
        }
    }

    async saveConfig(cfg: BackupConfigDto) {
        if (cfg.encrypt === true && !hasDataKey()) {
            throw new BadRequestException(
                "Backups cannot be encrypted because DATA_ENCRYPTION_KEY_FILE is not set or cannot be read"
            );
        }

        // A full PostgreSQL backup takes the whole database, so it has no export targets to choose (the page sends none).
        cfg.targets = cfg.backupKind === "postgresql" && !normalizeBackupTargets(cfg.targets).length
            ? [...SUPPORTED_BACKUP_TARGETS]
            : this.validateTargets(cfg.targets);

        if (cfg.schedule === "cron" && !cfg.cronExpr) {
            throw new BadRequestException("cronExpr required for schedule=cron");
        }
        this.validateDestination(cfg.destination);
        if (Array.isArray(cfg.extraDestinations)) {
            for (const e of cfg.extraDestinations) this.validateFanoutItem(e);
        }

        const orgId = await this.orgId();
        const policy = await this.upsertPolicyWithFanout(orgId, cfg);
        return { ok: true, policyId: policy?.policyId };
    }

    /* ---------------- History -------------------- */
    async listHistory(q: HistoryQueryDto) {
        const pageSize = 50;
        const page = parseCursor(q.cursor);
        const offset = page * pageSize;

        const where: Prisma.Sql[] = [];

        const policy = await this.fetchDefaultPolicy();
        if (policy?.policyId) {
            where.push(Prisma.sql`(policy_id = ${policy.policyId}::text::uuid OR policy_id IS NULL)`);
        }
        const statusFilter = mapFilterStatus(q.status as any);
        if (statusFilter === "running") {
            where.push(Prisma.sql`status IN ('queued','running')`);
        } else if (statusFilter) {
            where.push(Prisma.sql`status = ${statusFilter}::text::backup_status`);
        }
        if (q.q?.trim()) {
            const pattern = `%${q.q.trim()}%`;
            where.push(Prisma.sql`(id::text ILIKE ${pattern} OR note ILIKE ${pattern})`);
        }
        if (q.from) {
            where.push(Prisma.sql`started_at >= ${q.from}::text::date`);
        }
        if (q.to) {
            where.push(Prisma.sql`started_at < (${q.to}::text::date + INTERVAL '1 day')`);
        }
        const whereSql = where.length
            ? Prisma.sql`WHERE ${Prisma.join(where, " AND ")}`
            : Prisma.empty;

        // Prisma cannot search a uuid as text, keep LIKE wildcards in a search, or use the
        // database session's time zone for date bounds. offset is always a Number here.
        const rows = await this.prisma.$queryRaw<JobRow[]>`
      SELECT id, started_at, status,
                 backup_kind, note, size_bytes, duration_sec, verified
      FROM backup_jobs
      ${whereSql}
      ORDER BY started_at DESC
      LIMIT ${Prisma.raw(String(pageSize + 1))}
      OFFSET ${Prisma.raw(String(offset))}
    `;
        const items = rows.slice(0, pageSize).map((r) => ({
            id: r.id,
            at: r.started_at.toISOString().slice(0, 16).replace("T", " "),
            status: projectStatus(r.status),
            backupKind:
                r.backup_kind === "postgresql"
                    ? "postgresql"
                    : "logical",
            note: r.note ?? undefined,
            sizeBytes: r.size_bytes?.toString() ?? undefined,
            durationSec: r.duration_sec ?? undefined,
            verified: r.verified ?? undefined,
        }));

        const hasMore = rows.length > pageSize;
        return { items, nextCursor: hasMore ? makeCursor(page + 1) : undefined };
    }

    /* ---------------- Scheduler hooks ------------- */
    async markScheduledOnce(now: Date) {
        const policy = await this.fetchDefaultPolicyRow();
        if (!policy) return { updated: false };

        // Prisma cannot compare or set a value inside a JSON column atomically.
        const updated = await this.prisma.$executeRaw`
            UPDATE backup_policies
               SET options = jsonb_set(
                   COALESCE(options, '{}'::jsonb),
                   '{lastScheduledAt}',
                   to_jsonb((${now.toISOString()}::text)::timestamptz),
                   true
               )
             WHERE id = ${policy.id}::text::uuid
               AND (
                    options->>'lastScheduledAt' IS NULL
                 OR (options->>'lastScheduledAt')::timestamptz < (${now.toISOString()}::text)::timestamptz - interval '30 seconds'
               )`;
        return { updated: updated > 0 };
    }

    async kickWorker() {
        await this.worker.runOneIfAny();
    }

    /* ---------------- Actions -------------------- */
    async startBackupNow() {
        const policy = await this.fetchDefaultPolicy();
        if (!policy) throw new BadRequestException("Backups not configured");
        if (!policy.enabled) throw new BadRequestException("Backups disabled");

        const backupKind = policy.backupKind;

        if (backupKind === "logical") {
            policy.targets = this.validateTargets(policy.targets);
        }

        const configSnapshot = {
            version: 1,
            backupKind,
            artifactFormat:
                backupKind === "postgresql"
                    ? "pg_dump-custom"
                    : "ndjson-tar-gz",
            targets:
                backupKind === "logical"
                    ? [...policy.targets]
                    : [],
            destination: policy.destination ? { ...policy.destination } : null,
            extraDestinations: Array.isArray(policy.extraDestinations)
                ? policy.extraDestinations.map((d: any) => ({ ...d }))
                : [],
            notifications: policy.notifications ?? {},
            minSuccess: policy.minSuccess ?? 1,
            parallelism: policy.parallelism ?? 2,
            encrypt: policy.encrypt,
        };

        const id = crypto.randomUUID();
        await this.prisma.backup_jobs.create({
            data: {
                id,
                policy_id: policy.policyId,
                started_at: new Date(),
                status: "queued",
                note: "Manual run queued",
                backup_kind: backupKind,
                config_snapshot: toJsonValue(configSnapshot),
                min_success: configSnapshot.minSuccess,
                parallelism: configSnapshot.parallelism,
            },
        });

        // Snapshot fan-out into backup_job_destinations for the worker
        const snap = await this.prisma.backup_policy_destinations.findMany({
            where: { policy_id: policy.policyId },
            orderBy: { priority: "asc" },
            select: { destination_id: true, is_primary: true, priority: true },
        });
        if (snap.length) {
            await this.prisma.backup_job_destinations.createMany({
                data: snap.map((r) => ({
                    job_id: id,
                    destination_id: r.destination_id,
                    is_primary: r.is_primary,
                    priority: r.priority,
                })),
            });
        }

        return { id, startedAt: new Date().toISOString() };
    }

    async pruneOld() {
        const policy = await this.fetchDefaultPolicy();
        if (!policy) return { removed: 0 };

        const cutoff = new Date(Date.now() - policy.retentionDays * 86_400_000);
        const { count } = await this.prisma.backup_jobs.deleteMany({
            where: {
                // COALESCE(finished_at, started_at) < cutoff
                OR: [
                    { finished_at: { lt: cutoff } },
                    { finished_at: null, started_at: { lt: cutoff } },
                ],
                status: { in: ["completed", "failed", "cancelled"] },
                ...(policy.policyId
                    ? { AND: [{ OR: [{ policy_id: policy.policyId }, { policy_id: null }] }] }
                    : {}),
            },
        });
        return { removed: count };
    }

    // -------- Destination probe implementations --------
    async testDestination(dest: any) {
        if (dest.kind === "local") {
            const localDir = sanitizeLocalPath(dest.path);
            const { ensureDir } = await import("./storage-clients");
            const fs = await import("fs/promises");
            const p = pathMod.join(localDir, ".adgrmm_probe.txt");
            await ensureDir(localDir);
            await fs.writeFile(p, "probe");
            const r = await fs.readFile(p, "utf8");
            await fs.unlink(p);
            return { ok: r === "probe", phases: { write: true, read: r === "probe", delete: true } };
        }

        if (dest.kind === "s3") {
            const cid = dest.connectionId;
            const row = await findStorageConnection(this.prisma, cid, "s3");
            if (!row) throw new BadRequestException("S3 connection not found");
            const cfgS3 = { ...(row.config || {}), ...(row.secrets || {}) };
            const bucket = dest.bucket || cfgS3.bucket;
            const prefix = trimBoth(String(dest.prefix || cfgS3.prefix || ""), "/");
            const key = (prefix ? `${prefix}/` : "") + ".adgrmm_probe.txt";
            const { s3PutObject, s3Head, s3Delete } = await import("./storage-clients");
            await s3PutObject(cfgS3, bucket, key, Buffer.from("probe"));
            const head = await s3Head(cfgS3, bucket, key);
            const ok = !!head;
            await s3Delete(cfgS3, bucket, key);
            return { ok, phases: { write: true, read: ok, delete: true } };
        }

        if (dest.kind === "nextcloud") {
            const cid = dest.connectionId;
            const row = await findStorageConnection(this.prisma, cid, "nextcloud");
            if (!row) throw new BadRequestException("Nextcloud connection not found");
            const { webdavProbe } = await import("./storage-clients");
            const url = row.config?.webdavUrl;
            const username = row.config?.username;
            const password = row.secrets?.password;
            const path = dest.path;
            const phases = await webdavProbe({ url, username, password, path });
            return { ok: phases.write && phases.read && phases.delete, phases };
        }

        if (dest.kind === "remote") {
            const cid = dest.connectionId;
            const row = await findStorageConnection(this.prisma, cid, "sftp");
            if (!row) throw new BadRequestException("SFTP connection not found");
            const { sftpProbe } = await import("./storage-clients");
            const host = row.config?.host;
            const port = row.config?.port;
            const username = row.secrets?.username || row.config?.username;
            const password = row.secrets?.password;
            const privateKey = row.secrets?.privateKey;
            const passphrase = row.secrets?.passphrase;
            const phases = await sftpProbe({
                host,
                port,
                username,
                password,
                privateKey,
                passphrase,
                testPath: dest.path,
            });
            return { ok: phases.write && phases.read && phases.delete, phases };
        }

        if (dest.kind === "gdrive") {
            const cid = dest.connectionId;
            const row = await findStorageConnection(this.prisma, cid, "gdrive");
            if (!row) throw new BadRequestException("GDrive connection not found");
            const { gdriveProbe } = await import("./storage-clients");
            const credentialsJson = row.secrets?.serviceAccountJson;
            const folderId = row.config?.folderId || undefined;
            const phases = await gdriveProbe({ credentialsJson, folderId });
            return { ok: phases.write && phases.read && phases.delete, phases };
        }

        throw new BadRequestException("Unsupported destination");
    }

    async testNotification() {
        await this.notifier.send(
            { email: true, slack: true, webhook: true },
            "ADG RMM Backups: Test",
            "This is a test notification."
        );
        return { sent: true };
    }

    async retryJob(id: string) {
        const newId = crypto.randomUUID();
        const note = `Retry of ${id}`;

        const queued = await this.prisma.$transaction(async (tx) => {
            const source = await tx.backup_jobs.findFirst({
                where: { id, status: "failed" },
                select: {
                    policy_id: true,
                    backup_kind: true,
                    config_snapshot: true,
                    min_success: true,
                    parallelism: true,
                },
            });
            if (!source) return false;

            await tx.backup_jobs.create({
                data: {
                    id: newId,
                    policy_id: source.policy_id,
                    started_at: new Date(),
                    status: "queued",
                    note,
                    backup_kind: source.backup_kind,
                    config_snapshot: source.config_snapshot ?? Prisma.JsonNull,
                    min_success: source.min_success,
                    parallelism: source.parallelism,
                },
            });

            const destinations = await tx.backup_job_destinations.findMany({
                where: { job_id: id },
                select: { destination_id: true, is_primary: true, priority: true },
            });
            await tx.backup_job_destinations.createMany({
                data: destinations.map((d) => ({ ...d, job_id: newId })),
                skipDuplicates: true,
            });
            return true;
        });

        if (!queued) {
            throw new BadRequestException(
                "Job not in failed state"
            );
        }

        this.worker.runOneIfAny().catch(() => { });

        return {
            queued: true,
            id: newId,
            retryOf: id,
        };
    }

    async cancelJob(id: string) {
        const { count } = await this.prisma.backup_jobs.updateMany({
            where: { id, status: { in: ["queued", "running"] } },
            data: {
                cancelled: true,
                status: "cancelled",
                finished_at: new Date(),
                note: "Cancelled by user",
            },
        });
        if (count === 0) throw new BadRequestException("Job not running");
        return { sent: true };
    }

    async startRestore(id: string) {
        const job = await this.prisma.backup_jobs.findUnique({
            where: { id },
            select: {
                id: true,
                status: true,
                backup_kind: true,
                verified: true,
                checksum: true,
            },
        });

        if (!job) {
            throw new NotFoundException("Backup not found");
        }

        if (
            job.status !== "completed" ||
            job.verified !== true
        ) {
            throw new BadRequestException(
                "Backup must be completed and verified before restore verification"
            );
        }

        if (job.backup_kind !== "postgresql") {
            throw new BadRequestException(
                "Only PostgreSQL disaster-recovery backups support restore verification"
            );
        }

        if (
            !/^[a-f0-9]{64}$/i.test(
                String(job.checksum || "")
            )
        ) {
            throw new BadRequestException(
                "Backup checksum is missing or invalid"
            );
        }

        const restoreId = crypto.randomUUID();

        await this.prisma.backup_restores.create({
            data: {
                id: restoreId,
                backup_job_id: id,
                requested_at: new Date(),
                status: "queued",
                notes: "Isolated restore verification queued; production database will not be replaced",
                verification: {},
            },
        });

        return {
            id: restoreId,
            backupJobId: id,
            status: "queued",
            mode: "isolated-verification",
            productionDatabaseChanged: false,
        };
    }

    async getRestore(id: string) {
        return this.prisma.backup_restores.findUnique({
            where: { id },
            select: {
                id: true,
                backup_job_id: true,
                requested_at: true,
                finished_at: true,
                status: true,
                notes: true,
                error: true,
                restore_database: true,
                verification: true,
                created_at: true,
                updated_at: true,
            },
        });
    }

    /* ---------------- Artifacts ------------------- */
    async openLogStream(id: string): Promise<Readable | null> {
        const row = await this.prisma.backup_job_logs.findUnique({
            where: { job_id: id },
            select: { log_text: true },
        });
        if (!row) return null;
        const text: string = row.log_text ?? "";
        return Readable.from(text);
    }

    async getManifest(id: string): Promise<any | null> {
        const row = await this.prisma.backup_job_manifests.findUnique({
            where: { job_id: id },
            select: { manifest: true },
        });
        if (!row) return null;
        return row.manifest;
    }

    async getDownload(id: string): Promise<{ presignedUrl?: string; stream?: Readable; filename: string } | null> {
        const job = await this.prisma.backup_jobs.findUnique({
            where: { id },
            select: {
                status: true,
                backup_kind: true,
                artifact_location: true,
                backup_policies: {
                    select: { backup_destinations: { select: { configuration: true } } },
                },
            },
        });
        if (!job) return null;
        if (job.status !== "completed")
            throw new BadRequestException("Backup not successful");

        const loc: any = job.artifact_location || {};
        if (loc.kind === "local") {
            const fs = await import("fs");
            if (!fs.existsSync(loc.path)) return null;
            const filename = String(loc.path).split(/[\\/]/).pop() || "backup.tar.gz";
            return { filename, stream: fs.createReadStream(loc.path) };
        }
        if (loc.kind === "s3") {
            const destConfig: any = job.backup_policies?.backup_destinations?.configuration || {};
            const connectionId = loc.connectionId || destConfig.connectionId;
            if (!connectionId) throw new BadRequestException("S3 connection missing");
            const row = await findStorageConnection(this.prisma, connectionId, "s3");
            if (!row) throw new BadRequestException("S3 connection missing");
            const s3Cfg = { ...(row.config || {}), ...(row.secrets || {}) };
            const bucket = loc.bucket || destConfig.bucket || s3Cfg.bucket;
            const key = loc.key || destConfig.key;
            if (!bucket || !key) throw new BadRequestException("S3 location incomplete");
            const url = await s3PresignGet(s3Cfg, bucket, key, 60 * 10);
            const filename = String(key || "").split("/").pop() || "backup.tar.gz";
            return { presignedUrl: url, filename };
        }
        if (loc.kind === "nextcloud") {
            const connectionId = loc.connectionId;
            if (!connectionId) throw new BadRequestException("Nextcloud connection missing");
            const row = await findStorageConnection(this.prisma, connectionId, "nextcloud");
            if (!row) throw new BadRequestException("Nextcloud connection missing");
            const webdavUrl = row.config?.webdavUrl;
            const username = row.config?.username;
            const password = row.secrets?.password;
            const remotePath = loc.path;
            if (!webdavUrl || !username || !password || !remotePath) {
                throw new BadRequestException("Nextcloud location incomplete");
            }
            const buf = await webdavDownloadAsBuffer({ url: webdavUrl, username, password, remotePath });
            const filename = String(remotePath).split("/").pop() || "backup.tar.gz";
            return { filename, stream: Readable.from(buf) };
        }
        if (loc.kind === "gdrive") {
            const connectionId = loc.connectionId;
            if (!connectionId) throw new BadRequestException("GDrive connection missing");
            const row = await findStorageConnection(this.prisma, connectionId, "gdrive");
            if (!row) throw new BadRequestException("GDrive connection missing");
            const credentialsJson = row.secrets?.serviceAccountJson;
            const fileId = loc.fileId;
            if (!credentialsJson || !fileId) throw new BadRequestException("GDrive location incomplete");
            const buf = await gdriveDownloadAsBuffer({ credentialsJson, fileId });
            const filename = loc.name || "backup.tar.gz";
            return { filename, stream: Readable.from(buf) };
        }

        if (loc.kind === "remote") {
            const connectionId = loc.connectionId;
            if (!connectionId) {
                throw new BadRequestException(
                    "SFTP connection missing"
                );
            }

            const row = await findStorageConnection(this.prisma, connectionId, "sftp");

            if (!row) {
                throw new BadRequestException(
                    "SFTP connection missing"
                );
            }

            if (!loc.path) {
                throw new BadRequestException(
                    "SFTP artifact path missing"
                );
            }

            const buf = await sftpDownloadAsBuffer({
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
            });

            const filename =
                String(loc.path)
                    .split("/")
                    .pop() ||
                (job.backup_kind === "postgresql"
                    ? "backup.dump"
                    : "backup.tar.gz");

            return {
                filename,
                stream: Readable.from(buf),
            };
        }

        return null;
    }
}
