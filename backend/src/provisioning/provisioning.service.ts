// backend/src/provisioning/provisioning.service.ts
import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { PrismaService } from "../storage/prisma.service";
import type { AccessScope } from "../reports/client-access.service";
import { CreateEndpointDto, type CreateEndpointResult } from "./dto/create-endpoint.dto";
import {
  CreateEnrollmentKeyDto,
  type CreateEnrollmentKeyResult,
} from "./dto/create-enrollment-key.dto";
import {
  CreateInstallerBundleDto,
  type CreateInstallerBundleResult,
  type InstallerOs,
} from "./dto/create-installer-bundle.dto";
import { linuxInstallerScript, windowsInstallerScript } from "./installer-scripts";

function newOpaqueToken(): string {
  return randomBytes(24).toString("base64url");
}
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * A saved script contains the enrollment key, so it is stored encrypted under the download
 * token, of which the database only has a hash. Reading the table alone yields no keys.
 */
function bundleCipherKey(token: string): Buffer {
  return createHash("sha256").update(`installer-bundle:${token}`).digest();
}
function sealBundle(content: string, token: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", bundleCipherKey(token), iv);
  const data = Buffer.concat([cipher.update(content, "utf8"), cipher.final()]);
  return `enc1:${Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64")}`;
}
function openBundle(stored: string, token: string): string {
  if (!stored.startsWith("enc1:")) return stored;
  const raw = Buffer.from(stored.slice(5), "base64");
  const decipher = createDecipheriv("aes-256-gcm", bundleCipherKey(token), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
}

type BundleDownload = {
  filename: string;
  contentType: string;
  content: string;
};

type AgentPackage = {
  filename: string;
  contentType: string;
  absPath: string;
  sizeBytes: number;
  sha256: string;
};

/** Hashing a package takes a moment, so it is remembered until the file changes. */
const packageHashCache = new Map<string, { size: number; mtimeMs: number; sha256: string }>();

@Injectable()
export class ProvisioningService {
  constructor(private readonly prisma: PrismaService) { }

  /** Enforce: site must belong to client */
  private async assertSiteBelongsToClient(siteId: string, clientId: string): Promise<void> {
    const site = await this.prisma.sites.findUnique({
      where: { id: siteId },
      select: { client_id: true },
    });
    if (!site) throw new NotFoundException("Site not found");
    if (site.client_id !== clientId) {
      throw new BadRequestException("Site does not belong to the selected client");
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Existing: one-time endpoint enrollments
  // ────────────────────────────────────────────────────────────────────────────
  async createEndpoint(dto: CreateEndpointDto): Promise<CreateEndpointResult> {
    const clientId = String(dto.clientId ?? "").trim();
    const siteId = String(dto.siteId ?? "").trim();
    const deviceId = String(dto.deviceId ?? "").trim();
    const os = dto.os;
    const alias = String(dto.alias ?? "").trim();
    const expiresMinutes = Number.isFinite(dto.expiresMinutes as any)
      ? Number(dto.expiresMinutes)
      : 30;

    if (!clientId) throw new BadRequestException("clientId is required");
    if (!siteId) throw new BadRequestException("siteId is required");
    if (!deviceId) throw new BadRequestException("deviceId is required");
    if (!alias) throw new BadRequestException("alias is required");
    if (!(expiresMinutes >= 1 && expiresMinutes <= 1440)) {
      throw new BadRequestException("expiresMinutes must be between 1 and 1440");
    }

    await this.assertSiteBelongsToClient(siteId, clientId);

    // Create device row if missing (FK for agents.device_id requires this)
    const now = new Date();
    await this.prisma.devices.upsert({
      where: { id: deviceId },
      create: {
        id: deviceId,
        site_id: siteId,
        hostname: alias,
        alias,
        operating_system: os,
        architecture: null,
        status: "offline",
        last_seen_at: null,
        created_at: now,
        updated_at: now,
      },
      update: { site_id: siteId, alias, operating_system: os, updated_at: now },
    });

    // Generate one-time token and store hash
    const enrollmentSecret = newOpaqueToken();
    const tokenHash = hashToken(enrollmentSecret);

    const created = await this.prisma.endpoint_enrollments.create({
      data: {
        client_id: clientId,
        site_id: siteId,
        device_id: deviceId,
        os,
        alias,
        token_hash: tokenHash,
        expires_at: new Date(Date.now() + expiresMinutes * 60_000),
        used_at: null,
      },
      select: { expires_at: true },
    });
    const expiresAtIso = created.expires_at.toISOString();

    return {
      deviceId,
      enrollmentSecret,
      expiresAt: expiresAtIso,
      clientId,
      siteId,
      os,
      alias,
    };
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Existing: reusable site enrollment keys
  // ────────────────────────────────────────────────────────────────────────────
  async createEnrollmentKey(
    dto: CreateEnrollmentKeyDto,
    createdByUserId: string | null,
    /** What to use when the request does not say how long the key lasts (Administration > Agents & Endpoints). */
    defaultExpiresMinutes: number = 7 * 24 * 60
  ): Promise<CreateEnrollmentKeyResult> {
    const clientId = String(dto.clientId ?? "").trim();
    const siteId = String(dto.siteId ?? "").trim();
    const name = dto.name != null ? String(dto.name).trim() : "";
    const expiresMinutes = Number.isFinite(dto.expiresMinutes as any)
      ? Number(dto.expiresMinutes)
      : defaultExpiresMinutes;

    if (!clientId) throw new BadRequestException("clientId is required");
    if (!siteId) throw new BadRequestException("siteId is required");
    // Up to 10 years: a key put in a Group Policy script is meant to last, and can be revoked at any time.
    if (!(expiresMinutes >= 1 && expiresMinutes <= 5_259_600)) {
      throw new BadRequestException("expiresMinutes must be between 1 and 5259600 (10 years)");
    }

    await this.assertSiteBelongsToClient(siteId, clientId);

    const enrollmentKey = newOpaqueToken();
    const tokenHash = hashToken(enrollmentKey);
    const tokenId = randomUUID();

    const created = await this.prisma.site_enrollment_keys.create({
      data: {
        id: tokenId,
        client_id: clientId,
        site_id: siteId,
        name: name || null,
        token_hash: tokenHash,
        expires_at: new Date(Date.now() + expiresMinutes * 60_000),
        revoked_at: null,
        last_used_at: null,
        created_by_user_id: createdByUserId,
      },
      select: { expires_at: true },
    });
    const expiresAtIso = created.expires_at.toISOString();

    return {
      enrollmentKey,
      tokenId,
      expiresAt: expiresAtIso,
      clientId,
      siteId,
      name: name || null,
    };
  }

  /** Install keys, newest first, as far as the person may see them. The key itself is never shown again. */
  async listEnrollmentKeys(scope: AccessScope | null) {
    const rows = await this.prisma.site_enrollment_keys.findMany({
      where: scope ? { OR: [{ client_id: { in: scope.clients } }, { site_id: { in: scope.sites } }] } : {},
      orderBy: { created_at: "desc" },
      take: 500,
      include: { clients: { select: { name: true } }, sites: { select: { name: true } }, users: { select: { first_name: true, last_name: true, email: true } } },
    });
    const now = Date.now();
    return rows.map((r) => ({
      id: r.id,
      name: r.name ?? "",
      clientId: r.client_id,
      clientName: r.clients.name,
      siteId: r.site_id,
      siteName: r.sites.name,
      createdAt: r.created_at.toISOString(),
      createdBy: r.users ? [r.users.first_name, r.users.last_name].filter(Boolean).join(" ") || String(r.users.email) : "",
      expiresAt: r.expires_at.toISOString(),
      revokedAt: r.revoked_at?.toISOString() ?? null,
      lastUsedAt: r.last_used_at?.toISOString() ?? null,
      useCount: r.use_count,
      status: r.revoked_at ? ("revoked" as const) : r.expires_at.getTime() <= now ? ("expired" as const) : ("active" as const),
    }));
  }

  private async keyInScope(id: string, scope: AccessScope | null) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new NotFoundException("Install key not found");
    const row = await this.prisma.site_enrollment_keys.findUnique({ where: { id }, select: { id: true, client_id: true, site_id: true, revoked_at: true } });
    // Someone limited to some customers cannot tell a key at another customer exists.
    if (!row || (scope && !scope.clients.includes(row.client_id) && !scope.sites.includes(row.site_id))) throw new NotFoundException("Install key not found");
    return row;
  }

  /**
   * Stops a key working, at once. Devices already enrolled with it keep working: it only lets new ones in, and the
   * installer scripts made from it stop downloading the agent.
   */
  async revokeEnrollmentKey(id: string, scope: AccessScope | null) {
    const row = await this.keyInScope(id, scope);
    if (!row.revoked_at) {
      await this.prisma.site_enrollment_keys.update({ where: { id }, data: { revoked_at: new Date(), updated_at: new Date() } });
    }
    return { ok: true };
  }

  async renameEnrollmentKey(id: string, name: string, scope: AccessScope | null) {
    const row = await this.keyInScope(id, scope);
    const clean = String(name ?? "").trim().slice(0, 120);
    await this.prisma.site_enrollment_keys.update({ where: { id: row.id }, data: { name: clean || null, updated_at: new Date() } });
    return { ok: true, name: clean };
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Installer bundles
  // ────────────────────────────────────────────────────────────────────────────

  private async validateReusableEnrollmentKey(
    rawEnrollmentKey: string
  ): Promise<{ clientId: string; siteId: string; expiresAt: Date }> {
    const key = String(rawEnrollmentKey ?? "").trim();
    if (!key) throw new BadRequestException("enrollmentKey is required");

    const h = hashToken(key);

    const row = await this.prisma.site_enrollment_keys.findFirst({
      where: { token_hash: h, revoked_at: null, expires_at: { gt: new Date() } },
      select: { client_id: true, site_id: true, expires_at: true },
    });

    if (!row) {
      throw new UnauthorizedException("Invalid, revoked, or expired enrollment key.");
    }

    return { clientId: row.client_id, siteId: row.site_id, expiresAt: row.expires_at };
  }

  private agentPackagePath(os: InstallerOs): { absPath: string; filename: string; contentType: string } | null {
    const baseDir = process.env.AGENT_PKG_DIR
      ? path.resolve(process.env.AGENT_PKG_DIR)
      : path.join(process.cwd(), "assets", "agent-packages");

    if (os === "windows") {
      const filename = "adgrmm-agent-windows.zip";
      const absPath = process.env.AGENT_PKG_WINDOWS_PATH
        ? path.resolve(process.env.AGENT_PKG_WINDOWS_PATH)
        : path.join(baseDir, "windows", filename);
      return { absPath, filename, contentType: "application/zip" };
    }

    if (os === "linux") {
      const filename = "adgrmm-agent-linux-x64.tar.gz";
      const absPath = process.env.AGENT_PKG_LINUX_PATH
        ? path.resolve(process.env.AGENT_PKG_LINUX_PATH)
        : path.join(baseDir, "linux", filename);
      return { absPath, filename, contentType: "application/gzip" };
    }

    return null;
  }

  /**
   * Where the package slots of a system live. 'stable' is the folder agents and installers have always used (and honours the
   * AGENT_PKG_*_PATH overrides); 'candidate' and 'previous' are siblings of the package base folder: <base>/candidate/<os>/ and
   * <base>/previous/<os>/, each holding the same package file name plus version.json.
   */
  agentPackageSlots(os: InstallerOs): { filename: string; contentType: string; stablePath: string; candidatePath: string; previousPath: string } | null {
    const stable = this.agentPackagePath(os);
    if (!stable || (os !== "windows" && os !== "linux")) return null;
    const baseDir = process.env.AGENT_PKG_DIR
      ? path.resolve(process.env.AGENT_PKG_DIR)
      : path.join(process.cwd(), "assets", "agent-packages");
    return {
      filename: stable.filename,
      contentType: stable.contentType,
      stablePath: stable.absPath,
      candidatePath: path.join(baseDir, "candidate", os, stable.filename),
      previousPath: path.join(baseDir, "previous", os, stable.filename),
    };
  }

  /** Finds a package and its hash, or explains why this OS cannot be installed yet. */
  async getAgentPackage(os: InstallerOs): Promise<AgentPackage> {
    const location = this.agentPackagePath(os);
    if (!location) {
      throw new ServiceUnavailableException(`There is no ADG RMM agent for ${os} yet.`);
    }

    let stat: any;
    try {
      stat = await fs.promises.stat(location.absPath);
    } catch {
      throw new ServiceUnavailableException(`The ${os} agent package has not been uploaded to this server.`);
    }
    if (!stat.isFile()) {
      throw new ServiceUnavailableException(`The ${os} agent package has not been uploaded to this server.`);
    }

    let cached = packageHashCache.get(location.absPath);
    if (!cached || cached.size !== stat.size || cached.mtimeMs !== stat.mtimeMs) {
      const hash = createHash("sha256");
      for await (const chunk of fs.createReadStream(location.absPath)) hash.update(chunk as Buffer);
      cached = { size: stat.size, mtimeMs: stat.mtimeMs, sha256: hash.digest("hex") };
      packageHashCache.set(location.absPath, cached);
    }

    return { ...location, sizeBytes: stat.size, sha256: cached.sha256 };
  }

  async createInstallerBundle(
    dto: CreateInstallerBundleDto,
    derivedBaseUrl?: string | null
  ): Promise<CreateInstallerBundleResult> {
    const enrollmentKey = String(dto.enrollmentKey ?? "").trim();
    const os = dto.os;

    const { clientId, siteId, expiresAt } = await this.validateReusableEnrollmentKey(enrollmentKey);
    const agentPackage = await this.getAgentPackage(os);

    // An installer is meant to be run on many machines, so its link lasts as long as its key.
    const bundleId = randomUUID();
    const downloadToken = newOpaqueToken();
    const downloadTokenHash = hashToken(downloadToken);

    // A public URL set by the operator wins over one taken from request headers.
    const baseUrl = (process.env.PUBLIC_API_BASE_URL || derivedBaseUrl || "").trim().replace(/\/+$/, "");
    if (!baseUrl) {
      throw new BadRequestException("Could not determine this server's public URL. Set PUBLIC_API_BASE_URL.");
    }

    const onlyIfMissing = dto.onlyIfMissing === true;
    const values = { baseUrl, enrollmentKey, packageSha256: agentPackage.sha256, onlyIfMissing };
    const built =
      os === "windows"
        ? {
            filename: "AdgRmm-Installer-Windows.ps1",
            content: windowsInstallerScript(values),
          }
        : {
            filename: "AdgRmm-Installer-Linux.sh",
            content: linuxInstallerScript(values),
          };

    const label = [onlyIfMissing ? "GPO" : "", String(dto.label ?? "").trim()].filter(Boolean).join("-");
    const filename = label
      ? built.filename.replace(
        /AdgRmm-Installer/,
        `AdgRmm-Installer-${label.replace(/[^a-zA-Z0-9-_]+/g, "-")}`
      )
      : built.filename;

    await this.prisma.installer_bundles.create({
      data: {
        id: bundleId,
        client_id: clientId,
        site_id: siteId,
        os,
        filename,
        content: sealBundle(built.content, downloadToken),
        download_token_hash: downloadTokenHash,
        expires_at: expiresAt,
      },
    });

    const url = `/api/provisioning/installer-bundles/${encodeURIComponent(
      bundleId
    )}/download?token=${encodeURIComponent(downloadToken)}`;
    const absoluteUrl = `${baseUrl}${url}`;
    const installCommand =
      os === "windows"
        ? `powershell -NoProfile -ExecutionPolicy Bypass -Command "iex (irm '${absoluteUrl}')"`
        : `curl -fsSL '${absoluteUrl}' | sudo bash`;

    return {
      bundleId,
      url,
      filename,
      expiresAt: expiresAt.toISOString(),
      os,
      clientId,
      siteId,
      installCommand,
      onlyIfMissing,
    };
  }

  async getInstallerBundleDownload(bundleId: string, token?: string): Promise<BundleDownload> {
    const id = String(bundleId ?? "").trim();
    if (!id) throw new BadRequestException("bundle id is required");

    const raw = String(token ?? "").trim();
    if (!raw) throw new UnauthorizedException("Missing download token.");

    const h = hashToken(raw);

    const row = await this.prisma.installer_bundles.findFirst({
      where: { id, download_token_hash: h, expires_at: { gt: new Date() } },
      select: { filename: true, content: true },
    });

    if (!row?.filename || row.content == null) {
      throw new NotFoundException("Installer bundle not found, expired, or token invalid.");
    }

    return {
      filename: row.filename,
      contentType: "text/plain; charset=utf-8",
      content: openBundle(row.content, raw),
    };
  }

  /** The installer script proves it may download the agent with its enrollment key. */
  async getAgentPackageDownload(os: string, enrollmentKey?: string): Promise<AgentPackage> {
    await this.validateReusableEnrollmentKey(String(enrollmentKey ?? ""));

    if (os !== "windows" && os !== "linux" && os !== "macos") {
      throw new NotFoundException("Unknown operating system.");
    }
    return this.getAgentPackage(os);
  }
}
