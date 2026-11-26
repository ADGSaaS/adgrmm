import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { openSecretMap, sealSecretValue } from "../common/secret-box";
import { PrismaService } from "./prisma.service";
import { OrganizationContextService } from "./organization-context.service";
import {
  s3PutObject,
  s3Head,
  s3Delete,
  webdavProbe,
  webdavListDirs,
  sftpProbe,
} from "../backups/storage-clients";

type StorageKind = "s3" | "nextcloud" | "gdrive" | "sftp";

type StorageConnectionRow = {
  id: string;
  organization_id: string;
  name: string;
  kind: StorageKind;
  config: Record<string, any> | null;
  secrets: Record<string, any> | null;
  meta: Record<string, any> | null;
  capabilities: Record<string, any> | null;
  health: Record<string, any> | null;
};

type StorageConnectionDto = {
  id: string;
  name: string;
  kind: StorageKind;
  config: Record<string, any>;
  meta: Record<string, any>;
  capabilities: Record<string, any>;
  health: Record<string, any>;
  hasSecret?: {
    s3Credentials?: boolean;
    nextcloudPassword?: boolean;
    gdriveServiceAccountJson?: boolean;
    gdriveRefreshToken?: boolean;
    gdriveClientSecret?: boolean;
    sftpPassword?: boolean;
    sftpPrivateKey?: boolean;
  };
};

type SecretMap = Record<string, any>;

type CreateUpdatePayload = {
  id?: string;
  name: string;
  kind: StorageKind;
  config: Record<string, any>;
  meta?: Record<string, any>;
};

const ALLOWED_KINDS: StorageKind[] = ["s3", "nextcloud", "gdrive", "sftp"];

const DEFAULT_CAPABILITIES = {
  canUse: true,
  canEdit: true,
  canRotate: true,
  canDelete: true,
};

const DEFAULT_HEALTH = { status: "unknown" };

/** These belong in the encrypted secrets, and are never returned, even if an old row has them in config. */
export const STORAGE_SECRET_KEYS = [
  "accessKeyId",
  "secretAccessKey",
  "roleArn",
  "externalId",
  "password",
  "serviceAccountJson",
  "refreshToken",
  "clientSecret",
  "privateKey",
  "privateKeyPem",
  "passphrase",
];

@Injectable()
export class StorageConnectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orgCtx: OrganizationContextService,
  ) {}

  private async orgId(): Promise<string> {
    return this.orgCtx.getDefaultOrganizationId();
  }

  private ensureKind(kind: string): asserts kind is StorageKind {
    if (!ALLOWED_KINDS.includes(kind as StorageKind)) {
      throw new BadRequestException(`Unsupported storage kind: ${kind}`);
    }
  }

  private clone<T>(value: T): T {
    return value ? JSON.parse(JSON.stringify(value)) : value;
  }

  /** Remove any UI-only keys from config before persisting/returning. */
  private stripUiKeys(obj: Record<string, any>): Record<string, any> {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(obj || {})) {
      if (k.startsWith("_")) continue; // e.g. _browse
      out[k] = v;
    }
    return out;
  }

  private withDefaults(meta: Record<string, any> | null | undefined): Record<string, any> {
    const incoming = { ...(meta ?? {}) };
    const defaultFor = {
      backups: false,
      exports: false,
      artifacts: false,
      ...(incoming.defaultFor ?? {}),
    };
    const tags = Array.isArray(incoming.tags) ? incoming.tags : [];
    return {
      ...incoming,
      environment: incoming.environment ?? "dev",
      defaultFor,
      tags,
      encryptionAtRest: incoming.encryptionAtRest ?? false,
      compression: incoming.compression ?? "none",
    };
  }

  private sanitizeConfig(kind: StorageKind, config: Record<string, any> | null | undefined): Record<string, any> {
    const base = this.stripUiKeys(this.clone(config ?? {}));

    if (kind === "s3") {
      if (!base.provider) base.provider = "aws";
      if (!base.region) base.region = "us-east-1";
      if (base.pathStyle === undefined) base.pathStyle = false;
      if (!base.sse) base.sse = "none";
    }
    if (kind === "nextcloud") {
      if (!base.path) base.path = "/Backups/AdgRmm";
    }
    if (kind === "sftp") {
      if (!base.port) base.port = 22;
      if (!base.path) base.path = "/srv/adgrmm/backups";
    }
    return base;
  }

  private buildHasSecret(kind: StorageKind, secrets: SecretMap): StorageConnectionDto["hasSecret"] {
    const map: StorageConnectionDto["hasSecret"] = {};

    if (kind === "s3") {
      map.s3Credentials = Boolean(
        secrets.accessKeyId || secrets.secretAccessKey || secrets.roleArn,
      );
    }
    if (kind === "nextcloud") {
      map.nextcloudPassword = Boolean(secrets.password);
    }
    if (kind === "gdrive") {
      map.gdriveServiceAccountJson = Boolean(secrets.serviceAccountJson);
      map.gdriveRefreshToken = Boolean(secrets.refreshToken);
      map.gdriveClientSecret = Boolean(secrets.clientSecret);
    }
    if (kind === "sftp") {
      map.sftpPassword = Boolean(secrets.password);
      map.sftpPrivateKey = Boolean(secrets.privateKeyPem || secrets.privateKey);
    }

    return map;
  }

  /**
   * Secret update semantics (deny-by-default):
   * - If secret key is NOT present in config input -> keep existing secret
   * - If secret key is "" or "****" -> keep existing secret (UI "unchanged")
   * - If secret key is null or "__clear__" -> delete secret
   * - Otherwise -> set secret
   */
  private partitionSecrets(
    kind: StorageKind,
    configInput: Record<string, any>,
    existingSecrets: SecretMap = {},
  ): { config: Record<string, any>; secrets: SecretMap } {
    const config = this.stripUiKeys(this.clone(configInput ?? {}));
    const secrets = { ...existingSecrets };

    const applySecret = (key: string) => {
      if (!(key in config)) return;

      const value = config[key];

      // Explicit clear
      if (value === null || value === "__clear__") {
        delete secrets[key];
        delete config[key];
        return;
      }

      // Common UI patterns meaning "unchanged"
      if (value === undefined || value === "" || value === "****") {
        delete config[key];
        return;
      }

      // Set/update
      secrets[key] = sealSecretValue(value);
      delete config[key];
    };

    if (kind === "s3") {
      ["accessKeyId", "secretAccessKey", "roleArn", "externalId"].forEach(applySecret);
    }
    if (kind === "nextcloud") {
      ["password"].forEach(applySecret);
    }
    if (kind === "gdrive") {
      ["serviceAccountJson", "refreshToken", "clientSecret"].forEach(applySecret);
    }
    if (kind === "sftp") {
      ["password", "privateKey", "privateKeyPem", "passphrase"].forEach(applySecret);
    }

    return { config, secrets };
  }

  private rowToDto(row: StorageConnectionRow): StorageConnectionDto {
    const config = this.sanitizeConfig(row.kind, row.config);
    for (const key of STORAGE_SECRET_KEYS) delete config[key];
    const meta = this.withDefaults(row.meta);
    const capabilities = { ...DEFAULT_CAPABILITIES, ...(row.capabilities ?? {}) };
    const health = { ...DEFAULT_HEALTH, ...(row.health ?? {}) };
    const secrets = row.secrets ?? {};
    const hasSecret = this.buildHasSecret(row.kind, secrets);

    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      config,
      meta,
      capabilities,
      health,
      hasSecret,
    };
  }

  private validatePayload(body: CreateUpdatePayload) {
    if (!body) throw new BadRequestException("Payload required");
    if (!body.name || typeof body.name !== "string" || !body.name.trim()) {
      throw new BadRequestException("Name is required");
    }
    this.ensureKind(body.kind);
    if (!body.config || typeof body.config !== "object") {
      throw new BadRequestException("Config object required");
    }

    if (body.kind === "s3") {
      if (!body.config.bucket || !String(body.config.bucket).trim()) {
        throw new BadRequestException("S3 bucket is required");
      }
      if (body.config.sse === "aws:kms" && !body.config.kmsKeyId) {
        throw new BadRequestException("KMS Key ID required for aws:kms");
      }
      if (body.config.sessionDurationSec) {
        const dur = Number(body.config.sessionDurationSec);
        if (!Number.isFinite(dur) || dur < 900 || dur > 43200) {
          throw new BadRequestException(
            "STS session duration must be between 900 and 43200 seconds",
          );
        }
      }
    }

    if (body.kind === "nextcloud") {
      if (!body.config.webdavUrl || typeof body.config.webdavUrl !== "string") {
        throw new BadRequestException("Nextcloud WebDAV URL is required");
      }
      if (!body.config.username || !String(body.config.username).trim()) {
        throw new BadRequestException("Nextcloud username is required");
      }
      if (!body.config.path || !String(body.config.path).startsWith("/")) {
        throw new BadRequestException("Nextcloud folder path must start with '/'");
      }
    }

    if (body.kind === "gdrive") {
      if (!body.config.folderId || !String(body.config.folderId).trim()) {
        throw new BadRequestException("Google Drive folderId is required");
      }
    }

    if (body.kind === "sftp") {
      if (!body.config.host || !String(body.config.host).trim()) {
        throw new BadRequestException("SFTP host is required");
      }
      if (!body.config.username || !String(body.config.username).trim()) {
        throw new BadRequestException("SFTP username is required");
      }
      if (!body.config.path || !String(body.config.path).trim()) {
        throw new BadRequestException("SFTP path is required");
      }
    }
  }

  async list(): Promise<{ items: StorageConnectionDto[] }> {
    const orgId = await this.orgId();
    const rows = (await this.prisma.storage_connections.findMany({
      where: { organization_id: orgId },
      orderBy: { name: "asc" },
    })) as unknown as StorageConnectionRow[];
    return { items: rows.map((row) => this.rowToDto(row)) };
  }

  async create(body: CreateUpdatePayload): Promise<{ id: string }> {
    this.validatePayload(body);
    const orgId = await this.orgId();

    // sanitize+strip UI keys BEFORE partitioning/persisting
    const inputCfg = this.sanitizeConfig(body.kind, body.config);
    const { config, secrets } = this.partitionSecrets(body.kind, inputCfg);

    const meta = this.withDefaults(body.meta ?? {});
    const capabilities = DEFAULT_CAPABILITIES;
    const health = DEFAULT_HEALTH;

    const { id } = await this.prisma.storage_connections.create({
      data: {
        organization_id: orgId,
        name: body.name.trim(),
        kind: body.kind,
        config,
        secrets,
        meta,
        capabilities,
        health,
      },
      select: { id: true },
    });

    return { id };
  }

  async update(id: string, body: CreateUpdatePayload): Promise<void> {
    if (!id || id.length !== 36) throw new BadRequestException("Valid id required");
    this.validatePayload(body);

    const orgId = await this.orgId();

    const row = (await this.prisma.storage_connections.findFirst({
      where: { id, organization_id: orgId },
    })) as unknown as StorageConnectionRow | null;
    if (!row) throw new NotFoundException("Connection not found");

    this.ensureKind(body.kind);

    const inputCfg = this.sanitizeConfig(body.kind, body.config);
    const { config, secrets } = this.partitionSecrets(body.kind, inputCfg, row.secrets ?? {});
    const meta = this.withDefaults(body.meta ?? {});

    await this.prisma.storage_connections.updateMany({
      where: { id, organization_id: orgId },
      data: {
        name: body.name.trim(),
        kind: body.kind,
        config,
        secrets,
        meta,
        updated_at: new Date(),
      },
    });
  }

  async delete(id: string): Promise<void> {
    if (!id || id.length !== 36) throw new BadRequestException("Valid id required");
    const orgId = await this.orgId();

    const deps = await this.getDependents(id);
    const inUse = deps.features.flatMap((f) => f.ids ?? []);
    if (inUse.length) {
      throw new BadRequestException("Connection still referenced by other features");
    }

    const { count } = await this.prisma.storage_connections.deleteMany({
      where: { id, organization_id: orgId },
    });
    if (!count) throw new NotFoundException("Connection not found");
  }

  async getDependents(id: string): Promise<{ features: { name: string; ids: string[] }[] }> {
    const orgId = await this.orgId();
    const deps: { name: string; ids: string[] }[] = [];

    const policies = await this.prisma.backup_destinations.findMany({
      where: { organization_id: orgId, configuration: { path: ["connectionId"], equals: id } },
      select: { id: true },
    });
    if (policies.length) {
      deps.push({ name: "backup_destinations", ids: policies.map((r) => r.id) });
    }

    return { features: deps };
  }

  async test(body: { id?: string; kind: StorageKind; config: Record<string, any> }): Promise<{ ok: boolean; phases: Record<string, boolean> }> {
    this.ensureKind(body.kind);

    let cfg = { ...(body.config || {}) };

    if (body.id) {
      const orgId = await this.orgId();
      const row = (await this.prisma.storage_connections.findFirst({
        where: { id: body.id, organization_id: orgId },
        select: { id: true, kind: true, config: true, secrets: true },
      })) as any;
      if (row && row.kind === body.kind) {
        const savedCfg = row.config || {};
        const secrets = openSecretMap(row.secrets);
        cfg = { ...savedCfg, ...cfg };

        if (body.kind === "nextcloud") {
          if (!cfg.password && secrets.password) cfg.password = secrets.password;
        }
        if (body.kind === "s3") {
          if (!cfg.accessKeyId && secrets.accessKeyId) cfg.accessKeyId = secrets.accessKeyId;
          if (!cfg.secretAccessKey && secrets.secretAccessKey) cfg.secretAccessKey = secrets.secretAccessKey;
          if (!cfg.roleArn && secrets.roleArn) cfg.roleArn = secrets.roleArn;
          if (!cfg.externalId && secrets.externalId) cfg.externalId = secrets.externalId;
        }
        if (body.kind === "gdrive") {
          if (!cfg.serviceAccountJson && secrets.serviceAccountJson) cfg.serviceAccountJson = secrets.serviceAccountJson;
          if (!cfg.refreshToken && secrets.refreshToken) cfg.refreshToken = secrets.refreshToken;
          if (!cfg.clientSecret && secrets.clientSecret) cfg.clientSecret = secrets.clientSecret;
        }
        if (body.kind === "sftp") {
          if (!cfg.password && secrets.password) cfg.password = secrets.password;
          if (!cfg.privateKeyPem && (secrets.privateKeyPem || secrets.privateKey)) cfg.privateKeyPem = secrets.privateKeyPem || secrets.privateKey;
          if (!cfg.passphrase && secrets.passphrase) cfg.passphrase = secrets.passphrase;
        }
      }
    }

    this.validatePayload({ name: "test", kind: body.kind, config: cfg });

    if (body.kind === "s3") {
      const bucket = cfg.bucket;
      const prefix = (cfg.prefix || "").replace(/^\/+|\/+$/g, "");
      const key = (prefix ? `${prefix}/` : "") + `.adgrmm_probe_${Date.now()}.txt`;
      const secret = {
        region: cfg.region,
        endpoint: cfg.endpoint,
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey,
        forcePathStyle: !!cfg.pathStyle,
      };
      await s3PutObject(secret, bucket, key, Buffer.from("probe"));
      const head = await s3Head(secret, bucket, key);
      const ok = !!head;
      await s3Delete(secret, bucket, key);
      return { ok, phases: { validate: true, write: true, read: ok, delete: true } };
    }

    if (body.kind === "nextcloud") {
      const phases = await webdavProbe({
        url: cfg.webdavUrl,
        username: cfg.username,
        password: cfg.password,
        path: cfg.path,
      });
      return { ok: phases.write && phases.read && phases.delete, phases: { validate: true, ...phases } };
    }

    if (body.kind === "sftp") {
      const phases = await sftpProbe({
        host: cfg.host,
        port: cfg.port ?? 22,
        username: cfg.username,
        password: cfg.password,
        privateKey: cfg.privateKeyPem,
        passphrase: cfg.passphrase,
        testPath: cfg.path,
      });
      return { ok: phases.write && phases.read && phases.delete, phases: { validate: true, ...phases } };
    }

    return { ok: true, phases: { validate: true, connect: true } };
  }

  async browseNextcloud(body: {
    connectionId?: string;
    config?: Record<string, any>;
    path: string;
  }): Promise<{ ok: boolean; dirs: string[] }> {
    if (!body?.path || !String(body.path).startsWith("/")) {
      throw new BadRequestException("Path must start with '/'");
    }

    const cfg = { ...(body.config ?? {}) };

    if (body.connectionId) {
      const orgId = await this.orgId();
      const row = (await this.prisma.storage_connections.findFirst({
        where: { id: body.connectionId, organization_id: orgId },
        select: { id: true, kind: true, config: true, secrets: true },
      })) as any;
      if (!row) throw new NotFoundException("Connection not found");
      if (row.kind !== "nextcloud") throw new BadRequestException("Connection is not Nextcloud/WebDAV");

      const storedCfg = this.sanitizeConfig("nextcloud", row.config || {});
      cfg.webdavUrl = storedCfg.webdavUrl;
      cfg.username = storedCfg.username;
      cfg.password = openSecretMap(row.secrets).password;
    }

    if (!cfg.webdavUrl || !cfg.username || !cfg.password) {
      throw new BadRequestException("webdavUrl, username, and password are required to browse.");
    }

    const dirs = await webdavListDirs({
      url: cfg.webdavUrl,
      username: cfg.username,
      password: cfg.password,
      basePath: body.path,
    });

    return { ok: true, dirs };
  }
}
