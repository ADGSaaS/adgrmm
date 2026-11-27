// backend/src/auth/auth.service.ts
import { fireWorkflow } from "../workflows/workflows.bus";
import {
  Injectable,
  UnauthorizedException,
  ForbiddenException,
  InternalServerErrorException,
  Logger,
  BadRequestException,
  ConflictException,
} from "@nestjs/common";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { PrismaService } from "../storage/prisma.service";
import { EntitlementsService } from "../entitlements/entitlements.service";

function newOpaqueToken(): string {
  return randomBytes(24).toString("base64url");
}
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

type EnrollInput = {
  enrollmentSecret?: string; // one-time device-scoped token
  enrollmentKey?: string; // reusable site-scoped key
  deviceId: string; // uuid string
  hostname: string;
  os: string;
  arch: string;
  version: string;
};

type EnrollmentRow = {
  device_id: string;
  site_id: string;
  client_id: string;
  os: string;
  alias: string;
  expires_at: Date;
};

type SiteKeyRow = {
  site_id: string;
  client_id: string;
  name: string | null;
  expires_at: Date;
};

/** Agents check in at least once a minute, so this long without one means it is gone. */
const REINSTALL_OFFLINE_MS = 3 * 60_000;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(private readonly prisma: PrismaService, private readonly entitlements: EntitlementsService) { }

  /** Accept either enrollmentSecret (one-time) or enrollmentKey (reusable). */
  private getEnrollmentToken(input: EnrollInput): string {
    return String(input.enrollmentSecret ?? input.enrollmentKey ?? "").trim();
  }

  private async tryConsumeOneTimeEnrollment(
    input: EnrollInput
  ): Promise<EnrollmentRow | null> {
    const token = this.getEnrollmentToken(input);
    if (!token) return null;

    const tokenHash = hashToken(token);

    // A single UPDATE consumes the token atomically, so concurrent requests cannot both use it.
    const now = new Date();
    const { count } = await this.prisma.endpoint_enrollments.updateMany({
      where: {
        token_hash: tokenHash,
        used_at: null,
        expires_at: { gt: now },
        device_id: input.deviceId,
      },
      data: { used_at: now, updated_at: now },
    });

    if (count === 1) {
      // Only the request whose update matched reaches this read.
      return this.prisma.endpoint_enrollments.findUniqueOrThrow({
        where: { token_hash: tokenHash },
        select: { device_id: true, site_id: true, client_id: true, os: true, alias: true, expires_at: true },
      });
    }

    const other = await this.prisma.endpoint_enrollments.findFirst({
      where: { token_hash: tokenHash, used_at: null, expires_at: { gt: now } },
      select: { id: true },
    });
    if (other) {
      throw new UnauthorizedException("Enrollment token does not match deviceId");
    }

    return null;
  }

  /**
   * Reusable enrollment key path:
   * - Token is NOT consumed.
   * - It only maps to (client_id, site_id) and must be unrevoked + unexpired.
   */
  private async tryUseReusableEnrollmentKey(
    input: EnrollInput
  ): Promise<SiteKeyRow | null> {
    const token = this.getEnrollmentToken(input);
    if (!token) return null;

    const tokenHash = hashToken(token);

    const now = new Date();
    const found = await this.prisma.site_enrollment_keys.findFirst({
      where: { token_hash: tokenHash, revoked_at: null, expires_at: { gt: now } },
      select: { site_id: true, client_id: true, name: true, expires_at: true },
    });
    if (!found) return null;

    // bump last_used_at (best-effort)
    this.prisma.site_enrollment_keys
      .updateMany({
        where: { token_hash: tokenHash },
        data: { last_used_at: now, updated_at: now, use_count: { increment: 1 } },
      })
      .catch(() => { });

    return found;
  }

  /** Returns the site of an already-registered device, or undefined if it is new. */
  private async findExistingDeviceSite(deviceId: string): Promise<string | null | undefined> {
    const device = await this.prisma.devices.findUnique({
      where: { id: deviceId },
      select: { site_id: true },
    });
    return device ? device.site_id : undefined;
  }

  /**
   * A site can only have one device per hostname. A machine rebuilt or reinstalled from
   * scratch arrives with a new device id, so it takes over its old row instead of failing.
   * An agent that is still checking in is a different machine with the same name.
   */
  private async reuseDeviceForReinstall(input: EnrollInput, siteId: string): Promise<string> {
    const hostname = String(input.hostname ?? "").trim();
    if (!hostname) return input.deviceId;

    const existing = await this.prisma.devices.findFirst({
      where: { site_id: siteId, hostname },
      select: { id: true },
    });
    if (!existing) return input.deviceId;

    const agent = await this.prisma.agents.findUnique({
      where: { device_id: existing.id },
      select: { last_check_in_at: true },
    });
    const lastSeen = agent?.last_check_in_at?.getTime() ?? 0;
    if (Date.now() - lastSeen < REINSTALL_OFFLINE_MS) {
      throw new ConflictException(
        `Another online device in this site is already named ${hostname}. Rename one of them, or stop its agent and try again in a few minutes.`,
      );
    }

    this.logger.log(`Reinstall of ${existing.id}: replacing device id ${input.deviceId}.`);
    return existing.id;
  }

  /**
   * A reusable site key sits on every machine of a customer, so holding it must not be enough to take
   * over a running agent: its token would be replaced and the real agent locked out. An agent that is
   * still checking in cannot be re-enrolled with a site key; one that has gone quiet (a reinstall or a
   * rebuilt machine) can, and every such re-enrollment is written to the audit log so it is visible.
   */
  private async guardReenrollment(input: EnrollInput, siteKey: SiteKeyRow): Promise<void> {
    const agent = await this.prisma.agents.findUnique({
      where: { device_id: input.deviceId },
      select: { last_check_in_at: true },
    });
    if (!agent) return;

    const lastSeen = agent.last_check_in_at?.getTime() ?? 0;
    if (Date.now() - lastSeen < REINSTALL_OFFLINE_MS) {
      this.logger.warn(`Refused re-enrollment of online device ${input.deviceId} with a site key.`);
      throw new ConflictException(
        "This device is online and already enrolled. To reinstall it, stop its agent or wait a few minutes, then run the installer again.",
      );
    }

    this.logger.warn(`Device ${input.deviceId} re-enrolled with site key "${siteKey.name ?? "unnamed"}".`);
    await this.prisma.audit_events
      .create({
        data: {
          action: "agent.reenrolled",
          category: "agents",
          target_type: "device",
          target_id: input.deviceId,
          target_label: input.hostname ? String(input.hostname).slice(0, 300) : null,
          outcome: "success",
          details: { via: "site enrollment key", keyName: siteKey.name ?? null },
        },
      })
      .catch(() => { });
  }

  private matchesLegacySecret(provided: string): boolean {
    // The shared secret is not tied to a customer, so production never accepts it.
    if ((process.env.NODE_ENV || "").toLowerCase() === "production") return false;
    const expected = process.env.ENROLLMENT_SECRET || "";
    if (!expected || !provided) return false;
    const a = Buffer.from(hashToken(provided), "hex");
    const b = Buffer.from(hashToken(expected), "hex");
    return timingSafeEqual(a, b);
  }

  private async ensureDeviceRow(params: {
    deviceId: string;
    siteId?: string | null;
    alias?: string | null;
    /** Reinstalls must not replace a name a technician set in the console. */
    keepExistingAlias?: boolean;
    hostname?: string | null;
    os?: string | null;
    arch?: string | null;
  }) {
    const deviceId = String(params.deviceId).trim();
    if (!deviceId) throw new BadRequestException("deviceId is required");

    const now = new Date();
    const hostname = params.hostname || "unknown";
    const alias = params.alias || null;
    const os = params.os || null;
    const arch = params.arch || null;

    await this.prisma.devices.upsert({
      where: { id: deviceId },
      create: {
        id: deviceId,
        site_id: params.siteId ?? null,
        hostname,
        alias,
        operating_system: os,
        architecture: arch,
        status: "online",
        last_seen_at: now,
        created_at: now,
        updated_at: now,
      },
      update: {
        hostname,
        last_seen_at: now,
        updated_at: now,
        ...(params.siteId ? { site_id: params.siteId } : {}),
        ...(alias && !params.keepExistingAlias ? { alias } : {}),
        ...(os ? { operating_system: os } : {}),
        ...(arch ? { architecture: arch } : {}),
      },
    });
  }

  async enrollAgent(input: EnrollInput): Promise<{
    agentId: string;
    agentToken: string;
    deviceId: string;
    agentUuid: string | null;
  }> {
    // 1) Preferred: one-time expiring per-device token, else reusable site key
    let oneTime: EnrollmentRow | null = null;
    let siteKey: SiteKeyRow | null = null;

    oneTime = await this.tryConsumeOneTimeEnrollment(input);
    if (!oneTime) siteKey = await this.tryUseReusableEnrollmentKey(input);

    // 2) Legacy dev fallback: new devices only, never in production
    if (!oneTime && !siteKey) {
      if (!this.matchesLegacySecret(this.getEnrollmentToken(input))) {
        throw new UnauthorizedException("Invalid enrollment secret");
      }
      if ((await this.findExistingDeviceSite(input.deviceId)) !== undefined) {
        throw new ForbiddenException("This device is already registered");
      }
    }

    // 3) A reusable key only reaches devices in its own site, so one customer's
    //    key cannot move or re-issue tokens for another customer's device.
    if (siteKey) {
      const existingSite = await this.findExistingDeviceSite(input.deviceId);
      if (existingSite !== undefined && existingSite !== siteKey.site_id) {
        throw new ForbiddenException("This device belongs to a different site");
      }
      if (existingSite === undefined) {
        input = {
          ...input,
          deviceId: await this.reuseDeviceForReinstall(input, siteKey.site_id),
        };
      } else {
        await this.guardReenrollment(input, siteKey);
      }
    }

    // 4) Seat limit (hosted plans): only a device with no agent yet takes a new seat, so re-enrollment always works.
    //    A refused enrollment gives back the one-time token it consumed, so the same install command works after an upgrade.
    const alreadyEnrolled = await this.prisma.agents.findUnique({ where: { device_id: input.deviceId }, select: { id: true } });
    if (!alreadyEnrolled) {
      try {
        await this.entitlements.assertCanEnrollEndpoint();
      } catch (e) {
        if (oneTime) {
          await this.prisma.endpoint_enrollments
            .updateMany({ where: { token_hash: hashToken(this.getEnrollmentToken(input)) }, data: { used_at: null, updated_at: new Date() } })
            .catch(() => { });
        }
        throw e;
      }
    }

    try {
      const token = newOpaqueToken();
      const tokenHash = hashToken(token);

      const factsPatch: Record<string, any> = {};
      if (input.os) factsPatch.os = input.os;
      if (input.arch) factsPatch.arch = input.arch;

      // Determine target site + alias for device row
      const effectiveSiteId = oneTime?.site_id ?? siteKey?.site_id ?? null;

      // For reusable key enrollments, set alias to hostname by default
      const effectiveAlias =
        oneTime?.alias ??
        (input.hostname ? String(input.hostname).trim() : null) ??
        null;

      await this.ensureDeviceRow({
        deviceId: input.deviceId,
        siteId: effectiveSiteId,
        alias: effectiveAlias,
        keepExistingAlias: !oneTime,
        hostname: input.hostname ?? null,
        os: (input.os ?? oneTime?.os ?? null) as any,
        arch: input.arch ?? null,
      });

      // Re-enroll if agent already exists for this device
      const existing = await this.prisma.agents.findUnique({
        where: { device_id: input.deviceId },
        select: { id: true },
      });

      if (existing) {
        const agentId = existing.id;

        // Raw because the jsonb merge has to happen in the database, or a concurrent
        // agent update to facts would be overwritten.
        const rows = await this.prisma.$queryRaw<
          { id: string; device_id: string; agent_uuid: string | null }[]
        >`
          UPDATE public.agents
             SET hostname         = ${input.hostname},
                 version          = ${input.version},
                 last_check_in_at = NOW(),
                 facts            = COALESCE(facts, '{}'::jsonb) || ${JSON.stringify(factsPatch)}::jsonb,
                 agent_token      = ${tokenHash},
                 token            = ${tokenHash},
                 updated_at       = NOW(),
                 agent_uuid       = COALESCE(NULLIF(agent_uuid, ''), id::text)
           WHERE id = ${agentId}::uuid
           RETURNING id::text AS id, device_id::text AS device_id, agent_uuid`;

        const out = rows[0];
        this.logger.log(`Re-enrolled agent ${out.id} (deviceId=${out.device_id}).`);

        return {
          agentId: out.id,
          agentToken: token,
          deviceId: out.device_id,
          agentUuid: out.agent_uuid ?? out.id,
        };
      }

      const newId = randomUUID();

      const createdAt = new Date();
      const out = await this.prisma.agents.create({
        data: {
          id: newId,
          device_id: input.deviceId,
          agent_uuid: newId,
          hostname: input.hostname,
          version: input.version,
          last_check_in_at: createdAt,
          facts: factsPatch,
          agent_token: tokenHash,
          token: tokenHash,
          created_at: createdAt,
          updated_at: createdAt,
        },
        select: { id: true, device_id: true, agent_uuid: true },
      });

      this.logger.log(
        `Enrolled new agent ${out.id} (deviceId=${out.device_id}).`
      );
      fireWorkflow({ trigger: "device.registered", deviceId: out.device_id });

      return {
        agentId: out.id,
        agentToken: token,
        deviceId: out.device_id,
        agentUuid: out.agent_uuid ?? out.id,
      };
    } catch (e: any) {
      if (e?.code === "P2002") {
        throw new ConflictException("Another device in this site already has this hostname.");
      }
      const msg = e?.message ?? String(e);
      this.logger.error(`Enroll failed: ${msg}`, e?.stack ?? undefined);
      const dev = (process.env.NODE_ENV || "").toLowerCase() === "development";
      throw new InternalServerErrorException(dev ? `Enroll failed: ${msg}` : "Enroll failed");
    }
  }

  async validateAgentToken(rawToken: string): Promise<string | null> {
    // Prisma ignores undefined conditions, so a missing token would match every agent.
    if (typeof rawToken !== "string" || !rawToken) return null;
    const agent = await this.prisma.agents.findFirst({
      where: { OR: [{ agent_token: hashToken(rawToken) }, { token: hashToken(rawToken) }] },
      select: { id: true },
    });
    return agent?.id ?? null;
  }
}
