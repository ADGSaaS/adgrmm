// backend/src/agents/agent-releases.service.ts
//
// Staged rollout (roadmap 10.10): what the admin sees (release status, health gate) and what the admin does
// (promote, withdraw, set rings). The rules and file operations are in agent-release.core.ts.
import { BadRequestException, ConflictException, HttpException, Injectable, InternalServerErrorException, Logger, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { AuditService } from "../audit/audit.service";
import { isCanonicalUuid } from "../common/agent-lookup.util";
import { AgentSettingsService } from "../provisioning/agent-settings.service";
import { ProvisioningService } from "../provisioning/provisioning.service";
import type { AccessScope } from "../reports/client-access.service";
import { deviceWhereOf } from "../reports/client-access.service";
import { PrismaService } from "../storage/prisma.service";
import { agentUpdatesEnabled } from "./agent-updates.service";
import { compareAgentVersions } from "./agent-version.util";
import {
  computeGate, decidePromote, inspectSlot, isValid, promoteCandidate, withdrawCandidate, ReleaseOpError,
  type Gate, type GateDevice, type Ring, type SlotInspection,
} from "./agent-release.core";

export type ReleaseOs = "windows" | "linux";
export const RELEASE_OSES: readonly ReleaseOs[] = ["windows", "linux"];

export type Actor = { id: string | null; email: string | null; organizationId: string | null };

export type SlotView = {
  state: "absent" | "valid" | "problem";
  problem: string | null;
  version: string | null;
  sha256: string | null;
  sizeBytes: number | null;
  modifiedAt: string | null;
};

const view = (s: SlotInspection): SlotView => ({
  state: s.state,
  problem: s.problem,
  version: s.version,
  sha256: s.sha256 ?? s.declaredSha256,
  sizeBytes: s.sizeBytes,
  modifiedAt: s.modifiedAt ? s.modifiedAt.toISOString() : null,
});

// The system a device runs, from what its agent reported, else from the device's operating system text. Anything else is "other".
const OS_SQL = Prisma.sql`(CASE
  WHEN lower(COALESCE(a.facts->>'os','')) = 'windows' THEN 'windows'
  WHEN lower(COALESCE(a.facts->>'os','')) = 'linux' THEN 'linux'
  WHEN lower(COALESCE(d.operating_system,'')) LIKE '%windows%' THEN 'windows'
  WHEN lower(COALESCE(d.operating_system,'')) ~ '(linux|ubuntu|debian|centos|red hat|fedora|suse|alma|rocky)' THEN 'linux'
  ELSE 'other' END)`;

export type ReleaseLogRow = {
  at: string; actorEmail: string | null; action: string; os: string | null; version: string | null; previousVersion: string | null;
  forced: boolean; reason: string | null; ringCounts: unknown; details: unknown;
};

@Injectable()
export class AgentReleasesService {
  private readonly log = new Logger("AgentReleases");
  /** Promote and withdraw run one at a time. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly prisma: PrismaService,
    private readonly provisioning: ProvisioningService,
    private readonly settings: AgentSettingsService,
    private readonly audit: AuditService,
  ) { }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private layout(os: unknown) {
    if (os !== "windows" && os !== "linux") throw new BadRequestException('os must be "windows" or "linux".');
    const l = this.provisioning.agentPackageSlots(os);
    if (!l) throw new BadRequestException("There is no agent for that system.");
    return { os: os as ReleaseOs, ...l };
  }

  /* ------------------------------------------------------------------ counts */

  /** Devices of the organization by effective ring. */
  async ringCounts(orgId: string): Promise<{ pilot: number; stable: number }> {
    const rows = await this.prisma.$queryRaw<Array<{ ring: string; n: number }>>`
      SELECT COALESCE(d.update_ring, c.default_update_ring, 'stable') AS ring, count(*)::int AS n
        FROM public.devices d
        JOIN public.sites s ON s.id = d.site_id
        JOIN public.clients c ON c.id = s.client_id
       WHERE c.organization_id = ${orgId}::uuid
       GROUP BY 1`;
    const out = { pilot: 0, stable: 0 };
    for (const r of rows) if (r.ring === "pilot") out.pilot = r.n; else out.stable += r.n;
    return out;
  }

  /** Every pilot device with an agent of this system, with what the health gate needs. */
  private async pilotDevices(orgId: string, os: ReleaseOs): Promise<GateDevice[]> {
    const rows = await this.prisma.$queryRaw<Array<{ version: string | null; last_check_in_at: Date | null; version_changed_at: Date | null; failed: boolean }>>`
      SELECT a.version, a.last_check_in_at, a.version_changed_at,
             COALESCE((SELECT j.status IN ('failed', 'timeout')
                         FROM public.jobs j
                        WHERE j.agent_id = a.id AND j.type = 'AGENT_UPDATE' AND j.created_at > now() - interval '1 day'
                        ORDER BY j.created_at DESC LIMIT 1), false) AS failed
        FROM public.agents a
        JOIN public.devices d ON d.id = a.device_id
        JOIN public.sites s ON s.id = d.site_id
        JOIN public.clients c ON c.id = s.client_id
       WHERE c.organization_id = ${orgId}::uuid
         AND COALESCE(d.update_ring, c.default_update_ring, 'stable') = 'pilot'
         AND ${OS_SQL} = ${os}`;
    return rows.map((r) => ({
      ring: "pilot" as Ring, version: r.version, lastCheckInAt: r.last_check_in_at, versionChangedAt: r.version_changed_at, updateJobFailed: r.failed === true,
    }));
  }

  async gateFor(orgId: string, os: ReleaseOs, candidate: SlotInspection | null): Promise<Gate> {
    const version = candidate && isValid(candidate) ? candidate.version : null;
    if (!version) return computeGate(null, []);
    return computeGate(version, await this.pilotDevices(orgId, os));
  }

  /**
   * Candidate builds that are waiting for someone to promote them, one per system at most, for the Overview page. It reads the
   * two package slots only (no counts, no log), so it is cheap enough to ask on every refresh.
   */
  async waitingCandidates(): Promise<Array<{ os: ReleaseOs; version: string }>> {
    const out: Array<{ os: ReleaseOs; version: string }> = [];
    for (const os of RELEASE_OSES) {
      try {
        const l = this.layout(os);
        const [stable, candidate] = await Promise.all([inspectSlot("stable", l.stablePath), inspectSlot("candidate", l.candidatePath)]);
        if (!isValid(candidate)) continue;
        if (isValid(stable) && compareAgentVersions(candidate.parsed, stable.parsed) <= 0) continue;
        out.push({ os, version: candidate.version });
      } catch { /* no agent package for this system on this server: nothing waits */ }
    }
    return out;
  }

  /* ------------------------------------------------------------------ status */

  async status(orgId: string) {
    const systems = [] as any[];
    const counts = await this.prisma.$queryRaw<Array<{ os: string; version: string | null; ring: string; n: number }>>`
      SELECT ${OS_SQL} AS os, a.version, COALESCE(d.update_ring, c.default_update_ring, 'stable') AS ring, count(*)::int AS n
        FROM public.agents a
        JOIN public.devices d ON d.id = a.device_id
        JOIN public.sites s ON s.id = d.site_id
        JOIN public.clients c ON c.id = s.client_id
       WHERE c.organization_id = ${orgId}::uuid
       GROUP BY 1, 2, 3`;
    for (const os of RELEASE_OSES) {
      const l = this.layout(os);
      const [stable, candidate, previous] = await Promise.all([
        inspectSlot("stable", l.stablePath), inspectSlot("candidate", l.candidatePath), inspectSlot("previous", l.previousPath),
      ]);
      const byVersion = new Map<string, { version: string; pilot: number; stable: number }>();
      for (const r of counts) {
        if (r.os !== os) continue;
        const key = r.version ?? "unknown";
        const e = byVersion.get(key) ?? { version: key, pilot: 0, stable: 0 };
        if (r.ring === "pilot") e.pilot += r.n; else e.stable += r.n;
        byVersion.set(key, e);
      }
      const ringCounts = [...byVersion.values()].sort((a, b) => b.pilot + b.stable - (a.pilot + a.stable));
      systems.push({
        os,
        stable: view(stable),
        candidate: view(candidate),
        previous: view(previous),
        /** A usable candidate must be newer than stable; otherwise it is ignored and flagged. */
        candidateNotNewer: isValid(candidate) && isValid(stable) && compareAgentVersions(candidate.parsed, stable.parsed) <= 0,
        ringCounts,
        gate: await this.gateFor(orgId, os, candidate),
      });
    }
    const recent = await this.prisma.agent_releases_log.findMany({ orderBy: { at: "desc" }, take: 15 });
    return {
      /** The administrator's "automatic agent updates" switch. */
      autoUpdate: (await this.settings.get(orgId)).autoUpdate,
      /** AGENT_UPDATES_ENABLED on the server overrides the switch. */
      updatesDisabledByServer: !agentUpdatesEnabled(),
      rings: await this.ringCounts(orgId),
      systems,
      recent: recent.map((r): ReleaseLogRow => ({
        at: r.at.toISOString(), actorEmail: r.actor_email, action: r.action, os: r.os, version: r.version, previousVersion: r.previous_version,
        forced: r.forced, reason: r.reason, ringCounts: r.ring_counts, details: r.details,
      })),
    };
  }

  /* ------------------------------------------------------------------ record keeping */

  private async record(actor: Actor, orgId: string, req: any, row: {
    action: "ring-device" | "ring-customer" | "ring-bulk" | "promote" | "withdraw";
    auditAction: string; category: string; outcome?: "success" | "failure";
    os?: string | null; version?: string | null; previousVersion?: string | null; forced?: boolean; reason?: string | null;
    targetType?: string; targetId?: string | null; targetLabel?: string | null; details?: Record<string, unknown>;
  }) {
    let ringCounts: Record<string, unknown> = {};
    try { ringCounts = await this.ringCounts(orgId); } catch { /* the entry matters more than the counts */ }
    const outcome = row.outcome ?? "success";
    if (outcome === "success") {
      try {
        await this.prisma.agent_releases_log.create({
          data: {
            organization_id: orgId,
            actor_user_id: actor.id && isCanonicalUuid(actor.id) ? actor.id : null,
            actor_email: actor.email,
            action: row.action,
            os: row.os ?? null,
            version: row.version ?? null,
            previous_version: row.previousVersion ?? null,
            ring_counts: ringCounts as Prisma.InputJsonValue,
            forced: row.forced === true,
            reason: row.reason ?? null,
            details: (row.details ?? {}) as Prisma.InputJsonValue,
          },
        });
      } catch (e: any) {
        this.log.warn(`Could not write the release log: ${e?.code ?? e?.message ?? e}`);
      }
    }
    await this.audit.record({
      action: row.auditAction,
      category: row.category,
      outcome,
      actorUserId: actor.id,
      actorEmail: actor.email,
      req,
      targetType: row.targetType ?? "agent_release",
      targetId: row.targetId ?? (row.os ? `${row.os}` : null),
      targetLabel: row.targetLabel ?? undefined,
      details: {
        ...(row.os ? { os: row.os } : {}),
        ...(row.version ? { version: row.version } : {}),
        ...(row.previousVersion ? { previousVersion: row.previousVersion } : {}),
        ringCounts,
        ...(row.forced ? { forced: true, reason: row.reason } : {}),
        ...(row.details ?? {}),
      },
    });
  }

  /* ------------------------------------------------------------------ promote / withdraw */

  async promote(actor: Actor, orgId: string, req: any, input: { os: unknown; candidateVersion: unknown; force?: unknown; reason?: unknown }) {
    const l = this.layout(input.os);
    return this.serial(async () => {
      const [stable, candidate] = await Promise.all([inspectSlot("stable", l.stablePath), inspectSlot("candidate", l.candidatePath)]);
      const gate = await this.gateFor(orgId, l.os, candidate);
      const decision = decidePromote({ requestedVersion: input.candidateVersion, candidate, stable, gate, force: input.force, reason: input.reason });
      if (!decision.allow) {
        await this.record(actor, orgId, req, {
          action: "promote", auditAction: "agents.release.promote", category: "settings", outcome: "failure", os: l.os,
          version: candidate.version, details: { refused: decision.code, asked: String(input.candidateVersion ?? "").slice(0, 40) },
        });
        const body = { statusCode: decision.status, code: decision.code, message: decision.message, blockers: decision.blockers ?? [], gate };
        throw new HttpException(body, decision.status);
      }
      try {
        const done = await promoteCandidate({ stablePath: l.stablePath, candidatePath: l.candidatePath, previousPath: l.previousPath, expectedVersion: String(input.candidateVersion).trim() });
        await this.record(actor, orgId, req, {
          action: "promote", auditAction: "agents.release.promote", category: "settings", os: l.os, version: done.version,
          previousVersion: done.previousVersion, forced: decision.forced, reason: decision.reason,
          details: { sha256: done.sha256.slice(0, 16), gate: { pilotTotal: gate.pilotTotal, onCandidate: gate.onCandidate, seenOnlineAfterUpdate: gate.seenOnlineAfterUpdate, offlineSinceUpdating: gate.offlineSinceUpdating }, candidateRemoved: done.candidateRemoved },
        });
        return { ok: true, os: l.os, version: done.version, previousVersion: done.previousVersion, forced: decision.forced, candidateRemoved: done.candidateRemoved };
      } catch (e) {
        if (e instanceof ReleaseOpError) {
          await this.record(actor, orgId, req, {
            action: "promote", auditAction: "agents.release.promote", category: "settings", outcome: "failure", os: l.os, version: candidate.version, details: { failed: e.code },
          });
          const status = e.code === "version_changed" || e.code === "no_candidate" || e.code === "not_newer" || e.code === "candidate_invalid" ? 409 : 500;
          throw new HttpException({ statusCode: status, code: e.code, message: e.message }, status);
        }
        throw new InternalServerErrorException("Promoting failed.");
      }
    });
  }

  async withdraw(actor: Actor, orgId: string, req: any, input: { os: unknown; candidateVersion?: unknown }) {
    const l = this.layout(input.os);
    return this.serial(async () => {
      const candidate = await inspectSlot("candidate", l.candidatePath);
      const gate = await this.gateFor(orgId, l.os, candidate);
      try {
        const done = await withdrawCandidate(l.candidatePath, input.candidateVersion === undefined ? null : String(input.candidateVersion ?? ""));
        await this.record(actor, orgId, req, {
          action: "withdraw", auditAction: "agents.release.withdraw", category: "settings", os: l.os, version: done.version,
          details: { pilotDevicesOnCandidate: gate.onCandidate },
        });
        return {
          ok: true, os: l.os, version: done.version, pilotDevicesOnCandidate: gate.onCandidate,
          note: "Nobody else will be offered this build. Devices that already updated to it stay on it: there is no downgrade.",
        };
      } catch (e) {
        if (e instanceof ReleaseOpError) {
          await this.record(actor, orgId, req, { action: "withdraw", auditAction: "agents.release.withdraw", category: "settings", outcome: "failure", os: l.os, version: candidate.version, details: { failed: e.code } });
          throw new ConflictException({ statusCode: 409, code: e.code, message: e.message });
        }
        throw new InternalServerErrorException("Withdrawing failed.");
      }
    });
  }

  /* ------------------------------------------------------------------ rings */

  static parseRing(raw: unknown, allowInherit: boolean): Ring | null {
    if (raw === "pilot" || raw === "stable") return raw;
    if (allowInherit && raw === null) return null;
    throw new BadRequestException(allowInherit ? 'ring must be "pilot", "stable" or null (follow the customer).' : 'ring must be "pilot" or "stable".');
  }

  async setDeviceRing(actor: Actor, orgId: string, req: any, deviceId: string, ring: Ring | null, scope: AccessScope | null) {
    if (!isCanonicalUuid(deviceId)) throw new NotFoundException("Device not found.");
    const d = await this.prisma.devices.findFirst({
      where: { id: deviceId, ...(scope ? deviceWhereOf(scope) : {}) },
      select: { id: true, hostname: true, alias: true, update_ring: true, sites: { select: { clients: { select: { id: true, organization_id: true, default_update_ring: true } } } } },
    });
    const client = d?.sites?.clients;
    if (!d || !client || client.organization_id !== orgId) throw new NotFoundException("Device not found.");
    const before = d.update_ring;
    await this.prisma.devices.update({ where: { id: d.id }, data: { update_ring: ring } });
    const effective = ring ?? (client.default_update_ring === "pilot" ? "pilot" : "stable");
    await this.record(actor, orgId, req, {
      action: "ring-device", auditAction: "agents.ring.device", category: "device", targetType: "device", targetId: d.id, targetLabel: d.alias || d.hostname,
      details: { ring: ring ?? "customer default", was: before ?? "customer default", effective },
    });
    return { deviceId: d.id, updateRing: effective, updateRingOwn: ring };
  }

  async setCustomerRing(actor: Actor, orgId: string, req: any, clientId: string, ring: Ring, allowed: string[] | null) {
    if (!isCanonicalUuid(clientId)) throw new NotFoundException("Customer not found.");
    const c = await this.prisma.clients.findFirst({ where: { id: clientId, organization_id: orgId }, select: { id: true, name: true, default_update_ring: true } });
    if (!c || (allowed && !allowed.includes(c.id))) throw new NotFoundException("Customer not found.");
    await this.prisma.clients.update({ where: { id: c.id }, data: { default_update_ring: ring } });
    const following = await this.prisma.devices.count({ where: { update_ring: null, sites: { client_id: c.id } } });
    await this.record(actor, orgId, req, {
      action: "ring-customer", auditAction: "agents.ring.customer", category: "settings", targetType: "customer", targetId: c.id, targetLabel: c.name,
      details: { ring, was: c.default_update_ring, devicesFollowingTheDefault: following },
    });
    return { clientId: c.id, defaultUpdateRing: ring, devicesFollowingTheDefault: following };
  }

  async getCustomerRing(orgId: string, clientId: string, allowed: string[] | null) {
    if (!isCanonicalUuid(clientId)) throw new NotFoundException("Customer not found.");
    const c = await this.prisma.clients.findFirst({ where: { id: clientId, organization_id: orgId }, select: { id: true, default_update_ring: true } });
    if (!c || (allowed && !allowed.includes(c.id))) throw new NotFoundException("Customer not found.");
    const following = await this.prisma.devices.count({ where: { update_ring: null, sites: { client_id: c.id } } });
    return { clientId: c.id, defaultUpdateRing: c.default_update_ring === "pilot" ? "pilot" : "stable", devicesFollowingTheDefault: following };
  }

  /** One entry for a whole bulk change (the per-device results live in the bulk batch). */
  async logBulkRing(actor: Actor, orgId: string, req: any, ring: Ring | null, result: { batchId: string; requested: number; succeeded: number; skipped: number; failed: number }) {
    await this.record(actor, orgId, req, {
      action: "ring-bulk", auditAction: "agents.ring.bulk", category: "device", targetType: "bulk_batch", targetId: result.batchId,
      details: { ring: ring ?? "customer default", requested: result.requested, changed: result.succeeded, skipped: result.skipped, failed: result.failed },
    });
  }
}
