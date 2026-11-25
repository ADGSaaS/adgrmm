// backend/src/bulk/bulk.service.ts
//
// Bulk device actions (roadmap 1.13): one action on up to 500 devices chosen in the device list.
//
// Every device is checked on its own (does it exist, may this person see it, does the action fit it) and answers with
// what happened: done, queued (with the job or agent task it was given), skipped (the action does not apply, with the
// reason) or failed. One bad device never stops the others. The whole click is kept as one batch with one row per
// device, so the batch view can show how each one went, and one audit event describes the batch.
import { LINUX_RECOVER_SCRIPT, RECOVER_TOOL, WINDOWS_RECOVER_SCRIPT } from "./recover-agent.scripts";
import {
    BadRequestException,
    HttpException,
    Injectable,
    Logger,
    NotFoundException,
} from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../storage/prisma.service";
import { OrganizationContextService } from "../storage/organization-context.service";
import { AuditService } from "../audit/audit.service";
import { AccessScope, ClientAccessService, deviceWhereOf } from "../reports/client-access.service";
import { JobsService } from "../jobs/jobs.service";
import { RunsService } from "../jobs/runs.service";
import { PatchesService } from "../patches/patches.service";
import { approved } from "../patches/patch-automation.service";
import { DevicesService } from "../devices/devices.service";
import { PoliciesService } from "../policies/policies.service";
import { AgentUpdatesService, agentUpdatesEnabled } from "../agents/agent-updates.service";
import { AgentReleasesService } from "../agents/agent-releases.service";
import type { Ring } from "../agents/agent-release.core";
import { compareAgentVersions, parseAgentVersion } from "../agents/agent-version.util";
import { isCanonicalUuid } from "../common/agent-lookup.util";
import { SecurityService, isLinuxOs } from "../security/security.service";
import { VaultService } from "../vault/vault.service";

export const MAX_BULK_DEVICES = 500;
const CONCURRENCY = 8;
const KEEP_DAYS = 90;
const OUTPUT_LIMIT = 100_000;
// Same window the device list uses to call a device online, and the first agent release that can update itself.
const ONLINE_WINDOW_MS = 5 * 60_000;
const FIRST_SELF_UPDATING_VERSION = [1, 3, 0];
const MAX_TAGS_PER_DEVICE = 30;
const NOT_FOUND = "Device not found.";

export type BulkKind = "reboot" | "patch-scan" | "patch-install" | "update-agent" | "move-site" | "tags" | "delete-request" | "run-script" | "set-ring" | "security-scan" | "escrow-bitlocker" | "rotate-laps-password" | "run-saved-script" | "recover-agent";

export type ItemStatus = "done" | "queued" | "skipped" | "failed";
type Outcome = { status: ItemStatus; reason?: string; jobId?: string; taskId?: string };

type Ctx = {
    id: string;
    name: string;
    clientId: string | null;
    siteId: string | null;
    os: string;
    agent: { id: string; facts: any; version: string; lastCheckInAt: Date | null } | null;
};

/** The action does not apply to this device (not a failure of the device). */
class Skip extends Error { }

const clip = (s: string, n = 500) => (s.length > n ? `${s.slice(0, n - 1)}...` : s);

/** What an HttpException from the services the single-device routes use says, as plain text. */
function messageOf(e: unknown): string {
    if (e instanceof HttpException) {
        const r: any = e.getResponse();
        const m = typeof r === "string" ? r : Array.isArray(r?.message) ? r.message.join(" ") : r?.message;
        return clip(String(m || e.message));
    }
    return "Something went wrong on the server.";
}

async function pool<T>(items: T[], size: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
    let next = 0;
    const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
        for (;;) {
            const i = next++;
            if (i >= items.length) return;
            await fn(items[i], i);
        }
    });
    await Promise.all(workers);
}

export type Actor = { id: string | null; email: string | null; organizationId: string | null };

export type BatchResult = {
    batchId: string;
    action: BulkKind;
    summary: string;
    requested: number;
    succeeded: number;
    skipped: number;
    failed: number;
    items: Array<{ id: string; deviceId: string; name: string; status: ItemStatus; reason: string | null; hasJob: boolean }>;
};

@Injectable()
export class BulkService {
    private readonly logger = new Logger(BulkService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly orgs: OrganizationContextService,
        private readonly audit: AuditService,
        private readonly access: ClientAccessService,
        private readonly jobs: JobsService,
        private readonly runs: RunsService,
        private readonly patches: PatchesService,
        private readonly devices: DevicesService,
        private readonly updates: AgentUpdatesService,
        private readonly releases: AgentReleasesService,
        private readonly security: SecurityService,
        private readonly vault: VaultService,
    ) { }

    /* ------------------------------ checking the request ------------------------------ */

    /** The devices asked for, once each. Anything that is not a device id is a mistake in the request, not a device that failed. */
    private cleanIds(raw: unknown): string[] {
        if (!Array.isArray(raw) || raw.length === 0) throw new BadRequestException("Choose at least one device.");
        const ids = [...new Set(raw.map((x) => String(x ?? "").trim().toLowerCase()))];
        if (ids.length > MAX_BULK_DEVICES) throw new BadRequestException(`Choose at most ${MAX_BULK_DEVICES} devices at a time.`);
        if (ids.some((id) => !isCanonicalUuid(id))) throw new BadRequestException("One of the devices is not a device id.");
        return ids;
    }

    private async orgOf(actor: Actor) {
        return actor.organizationId || (await this.orgs.getDefaultOrganizationId());
    }

    private async scopeOf(actor: Actor): Promise<AccessScope | null> {
        return this.access.scopeFor(actor.id);
    }

    /** What each requested device is, for the ones this person may act on. The rest are absent (and reported as not found). */
    private async load(ids: string[], scope: AccessScope | null, orgId: string): Promise<Map<string, Ctx>> {
        const rows = await this.prisma.devices.findMany({
            where: { id: { in: ids }, ...(scope ? deviceWhereOf(scope) : {}) },
            select: {
                id: true, hostname: true, alias: true, site_id: true, operating_system: true,
                sites: { select: { client_id: true, clients: { select: { organization_id: true } } } },
                agents: { select: { id: true, facts: true, version: true, last_check_in_at: true } },
            },
        });
        const out = new Map<string, Ctx>();
        for (const d of rows) {
            const org = d.sites?.clients?.organization_id;
            if (org && org !== orgId) continue;
            out.set(d.id, {
                id: d.id,
                name: d.alias || d.hostname,
                clientId: d.sites?.client_id ?? null,
                siteId: d.site_id,
                os: String((d.agents?.facts as any)?.os || d.operating_system || ""),
                agent: d.agents ? { id: d.agents.id, facts: d.agents.facts, version: d.agents.version, lastCheckInAt: d.agents.last_check_in_at } : null,
            });
        }
        return out;
    }

    /* ------------------------------ the engine ------------------------------ */

    private async execute(
        actor: Actor,
        req: any,
        kind: BulkKind,
        rawIds: unknown,
        summary: (n: number) => string,
        params: Record<string, unknown>,
        handler: (ctx: Ctx) => Promise<Outcome>,
        prepare?: (ctxs: Map<string, Ctx>, scope: AccessScope | null, orgId: string) => Promise<void>,
        after?: () => void,
    ): Promise<BatchResult> {
        const ids = this.cleanIds(rawIds);
        const orgId = await this.orgOf(actor);
        const scope = await this.scopeOf(actor);
        const known = await this.load(ids, scope, orgId);
        if (prepare) await prepare(known, scope, orgId);

        const results = new Map<string, Outcome & { name: string; clientId: string | null }>();
        await pool(ids, CONCURRENCY, async (id) => {
            const ctx = known.get(id);
            // A device this person may not see answers exactly like one that does not exist.
            if (!ctx) {
                results.set(id, { status: "failed", reason: NOT_FOUND, name: id, clientId: null });
                return;
            }
            try {
                results.set(id, { ...(await handler(ctx)), name: ctx.name, clientId: ctx.clientId });
            } catch (e) {
                if (e instanceof Skip) results.set(id, { status: "skipped", reason: clip(e.message), name: ctx.name, clientId: ctx.clientId });
                else if (e instanceof HttpException && [400, 404, 409].includes(e.getStatus())) results.set(id, { status: "skipped", reason: messageOf(e), name: ctx.name, clientId: ctx.clientId });
                else {
                    this.logger.warn(`Bulk ${kind} failed for a device: ${(e as Error)?.message ?? e}`);
                    results.set(id, { status: "failed", reason: messageOf(e), name: ctx.name, clientId: ctx.clientId });
                }
            }
        });
        after?.();

        const count = (s: ItemStatus[]) => ids.filter((id) => s.includes(results.get(id)!.status)).length;
        const succeeded = count(["done", "queued"]);
        const skipped = count(["skipped"]);
        const failed = count(["failed"]);
        const text = summary(ids.length);

        const batch = await this.prisma.bulk_batches.create({
            data: {
                organization_id: orgId,
                action: kind,
                summary: text,
                params: params as Prisma.InputJsonValue,
                requested: ids.length,
                succeeded,
                skipped,
                failed,
                created_by: actor.id && isCanonicalUuid(actor.id) ? actor.id : null,
                items: {
                    create: ids.map((id) => {
                        const r = results.get(id)!;
                        return {
                            device_id: id,
                            device_name: clip(r.name, 300),
                            client_id: r.clientId,
                            status: r.status,
                            reason: r.reason ?? null,
                            job_id: r.jobId ?? null,
                            task_id: r.taskId ?? null,
                        };
                    }),
                },
            },
            include: { items: { orderBy: { device_name: "asc" } } },
        });

        void this.audit.record({
            action: `device.bulk.${kind}`,
            category: "device",
            outcome: failed === ids.length ? "failure" : "success",
            actorUserId: actor.id,
            actorEmail: actor.email,
            req,
            targetType: "bulk_batch",
            targetId: batch.id,
            targetLabel: text,
            details: {
                devices: ids.length,
                succeeded,
                skipped,
                failed,
                ...params,
                // The per-device detail, kept short; the batch itself holds every row.
                results: ids.slice(0, 200).map((id) => {
                    const r = results.get(id)!;
                    return { device: id, status: r.status, ...(r.reason ? { reason: clip(r.reason, 160) } : {}) };
                }),
            },
        });

        return {
            batchId: batch.id,
            action: kind,
            summary: text,
            requested: ids.length,
            succeeded,
            skipped,
            failed,
            items: batch.items.map((i) => ({ id: i.id, deviceId: i.device_id, name: i.device_name, status: i.status as ItemStatus, reason: i.reason, hasJob: !!(i.job_id || i.task_id) })),
        };
    }

    private noun = (n: number) => `${n} ${n === 1 ? "device" : "devices"}`;

    private needAgent(ctx: Ctx) {
        if (!ctx.agent) throw new Skip("It has no agent.");
        return ctx.agent;
    }

    /* ------------------------------ the actions ------------------------------ */

    reboot(actor: Actor, req: any, ids: unknown) {
        return this.execute(actor, req, "reboot", ids, (n) => `Restart ${this.noun(n)}`, {}, async (ctx) => {
            const agent = this.needAgent(ctx);
            const windows = ctx.os.toLowerCase() === "windows";
            const job = await this.jobs.createRunScriptJob({
                agentId: agent.id,
                language: windows ? "powershell" : "bash",
                scriptText: windows ? "shutdown.exe /r /t 5" : "shutdown -r +0 >/dev/null 2>&1 &",
                timeoutSec: 60,
            });
            return { status: "queued", jobId: job.id };
        });
    }

    patchScan(actor: Actor, req: any, ids: unknown, includeOptional: boolean) {
        return this.execute(actor, req, "patch-scan", ids, (n) => `Scan ${this.noun(n)} for updates`, { includeOptional }, async (ctx) => {
            this.needAgent(ctx);
            const r = await this.patches.enqueueScan(ctx.id, includeOptional, actor.id);
            return { status: "queued", taskId: r.taskId };
        });
    }

    /** Installs what the last scan found on each device, at the chosen level: Critical and Important updates, or all of them. */
    patchInstall(actor: Actor, req: any, ids: unknown, level: "critical" | "all", includeOptional: boolean) {
        return this.execute(actor, req, "patch-install", ids, (n) => `Install ${level === "all" ? "all" : "critical and important"} updates on ${this.noun(n)}`, { level, includeOptional }, async (ctx) => {
            this.needAgent(ctx);
            const latest = await this.patches.getLatest(ctx.id);
            if (!latest.lastScanAt) throw new Skip("It has not been scanned yet. Scan it for updates first.");
            if (latest.installPending) throw new Skip("An update install is already waiting or running on it.");
            const wanted = latest.patches.filter((p) => approved(p, level)).map((p) => p.id);
            if (!wanted.length) throw new Skip(level === "all" ? "The last scan found no updates to install." : "The last scan found no critical or important updates.");
            const r = await this.patches.enqueueInstall(ctx.id, includeOptional, wanted, actor.id);
            return { status: "queued", taskId: r.taskId, reason: `${wanted.length} ${wanted.length === 1 ? "update" : "updates"}` };
        });
    }

    /** A security scan (a signed script job, read back by the security poller). A device with a scan already waiting is left alone. */
    securityScan(actor: Actor, req: any, ids: unknown) {
        return this.execute(actor, req, "security-scan", ids, (n) => `Run a security scan on ${this.noun(n)}`, {}, async (ctx) => {
            const agent = this.needAgent(ctx);
            if (!ctx.os.toLowerCase().startsWith("windows") && !isLinuxOs(ctx.os.toLowerCase() === "linux" ? "linux" : "", ctx.os)) throw new Skip("Security scans are available for Windows and Linux devices.");
            if (Date.now() - (agent.lastCheckInAt?.getTime() ?? 0) > ONLINE_WINDOW_MS) throw new Skip("It is offline. Try again when it is back online.");
            const r = await this.security.queueScan(ctx.id, agent.id);
            if (r.alreadyWaiting) throw new Skip("A security scan is already waiting for it.");
            return { status: "queued", jobId: r.jobId };
        });
    }

    /** Stores the BitLocker recovery keys of each device on this server (a secret job; the keys never appear in the batch). Needs the policy to be on. */
    escrowBitlocker(actor: Actor, req: any, ids: unknown) {
        return this.execute(actor, req, "escrow-bitlocker", ids, (n) => `Store the disk recovery keys of ${this.noun(n)}`, {}, async (ctx) => {
            this.needAgent(ctx);
            const d = await this.security.device(ctx.id);
            const r = await this.vault.requestEscrow(d, { id: actor.id, name: null, email: actor.email }, "bulk");
            if (r.alreadyWaiting) throw new Skip("A key read is already waiting for it.");
            return { status: "queued" };
        });
    }

    /** Changes the managed local administrator password of each device (generated on the device). Needs the policy to be on. */
    rotateLaps(actor: Actor, req: any, ids: unknown) {
        return this.execute(actor, req, "rotate-laps-password", ids, (n) => `Change the managed local administrator password of ${this.noun(n)}`, {}, async (ctx) => {
            this.needAgent(ctx);
            const d = await this.security.device(ctx.id);
            const r = await this.vault.requestRotate(d, { id: actor.id, name: null, email: actor.email }, "bulk");
            if (r.alreadyWaiting) throw new Skip("A password change is already waiting for it.");
            return { status: "queued" };
        });
    }

    updateAgent(actor: Actor, req: any, ids: unknown) {
        return this.execute(actor, req, "update-agent", ids, (n) => `Update the agent on ${this.noun(n)}`, {}, async (ctx) => {
            const agent = this.needAgent(ctx);
            if (Date.now() - (agent.lastCheckInAt?.getTime() ?? 0) > ONLINE_WINDOW_MS) throw new Skip("It is offline. Try again when it is back online.");
            const version = String(agent.version ?? "");
            const parsed = parseAgentVersion(version);
            if (!parsed || compareAgentVersions(parsed, FIRST_SELF_UPDATING_VERSION) < 0) {
                throw new Skip(`Agent ${version || "unknown"} cannot update itself. Run the installer on the device once.`);
            }
            if (!agentUpdatesEnabled()) throw new Skip("Agent updates are turned off on this server.");
            const manifest = await this.updates.getManifest(ctx.os, agent.facts?.arch, version, ctx.id);
            if (!manifest) return { status: "done", reason: `Already on the latest version (${version}).` };
            const job = await this.jobs.createAgentUpdateJob(agent.id);
            return { status: "queued", jobId: job.id, reason: `${version} to ${manifest.version}` };
        });
    }

    /** Staged rollout: put devices in the Pilot ring, the Everyone ring, or back to following their customer's default ("inherit"). */
    async setRing(actor: Actor, req: any, ids: unknown, ringRaw: unknown) {
        const ring: Ring | null = ringRaw === "inherit" ? null : AgentReleasesService.parseRing(ringRaw, false);
        const label = ring === "pilot" ? "Pilot" : ring === "stable" ? "Everyone" : "the customer's default";
        const orgId = await this.orgOf(actor);
        const res = await this.execute(actor, req, "set-ring", ids, (n) => `Set the update ring of ${this.noun(n)} to ${label}`, { ring: ring ?? "inherit" }, async (ctx) => {
            const d = await this.prisma.devices.findUnique({ where: { id: ctx.id }, select: { update_ring: true } });
            if ((d?.update_ring ?? null) === ring) throw new Skip(`It is already set to ${label}.`);
            await this.prisma.devices.update({ where: { id: ctx.id }, data: { update_ring: ring } });
            return { status: "done" };
        });
        await this.releases.logBulkRing(actor, orgId, req, ring, res);
        return res;
    }

    async moveToSite(actor: Actor, req: any, ids: unknown, siteId: string) {
        const scope = await this.scopeOf(actor);
        const site = isCanonicalUuid(siteId) ? await this.prisma.sites.findUnique({ where: { id: siteId }, select: { name: true, clients: { select: { name: true } } } }) : null;
        if (!site || !(await this.access.canSeeSite(scope, siteId))) throw new NotFoundException("Target site not found");
        const where = `${site.clients.name} / ${site.name}`;
        return this.execute(actor, req, "move-site", ids, (n) => `Move ${this.noun(n)} to ${where}`, { siteId, site: where }, async (ctx) => {
            if (ctx.siteId === siteId) throw new Skip("It is already at that site.");
            await this.devices.moveToSite(ctx.id, siteId);
            return { status: "done" };
        });
    }

    async tags(actor: Actor, req: any, ids: unknown, tagId: string, remove: boolean) {
        const orgId = await this.orgOf(actor);
        const tag = isCanonicalUuid(tagId) ? await this.prisma.tag_defs.findFirst({ where: { id: tagId, organization_id: orgId }, select: { name: true } }) : null;
        if (!tag) throw new NotFoundException("That tag does not exist.");
        return this.execute(actor, req, "tags", ids, (n) => `${remove ? "Remove" : "Add"} the tag "${tag.name}" ${remove ? "from" : "to"} ${this.noun(n)}`, { tagId, tag: tag.name, remove }, async (ctx) => {
            if (remove) {
                const r = await this.prisma.device_tags.deleteMany({ where: { device_id: ctx.id, tag_id: tagId } });
                if (!r.count) throw new Skip("It does not have that tag.");
                return { status: "done" };
            }
            const have = await this.prisma.device_tags.findMany({ where: { device_id: ctx.id }, select: { tag_id: true } });
            if (have.some((h) => h.tag_id === tagId)) throw new Skip("It already has that tag.");
            if (have.length >= MAX_TAGS_PER_DEVICE) throw new Skip(`A device can have ${MAX_TAGS_PER_DEVICE} tags at most.`);
            await this.prisma.device_tags.createMany({ data: [{ device_id: ctx.id, tag_id: tagId }], skipDuplicates: true });
            return { status: "done" };
        }, undefined, () => PoliciesService.invalidate());
    }

    deleteRequest(actor: Actor, req: any, ids: unknown, reason: unknown) {
        const text = String(reason ?? "").trim();
        if (text.length < 3) throw new BadRequestException("Say why these devices should be removed (at least a few words).");
        if (text.length > 500) throw new BadRequestException("The reason is too long (500 characters at most).");
        if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text)) throw new BadRequestException("The reason has characters that are not allowed.");
        let pending = new Set<string>();
        return this.execute(actor, req, "delete-request", ids, (n) => `Ask for ${this.noun(n)} to be removed`, { reason: text }, async (ctx) => {
            if (pending.has(ctx.id)) throw new Skip("A removal request is already waiting for approval.");
            await this.devices.requestDeviceDeletion(ctx.id, actor.id, { reason: text, createTicket: false });
            return { status: "done", reason: "Waiting for approval." };
        }, async (ctxs) => {
            const rows = await this.prisma.device_deletion_requests.findMany({ where: { device_id: { in: [...ctxs.keys()] }, status: "pending" }, select: { device_id: true } });
            pending = new Set(rows.map((r) => r.device_id));
        });
    }

    runScript(actor: Actor, req: any, ids: unknown, input: { script: string; shell?: "powershell" | "bash" | "cmd"; timeoutSec?: number }) {
        const script = String(input.script ?? "");
        if (!script.trim()) throw new BadRequestException("The script is empty.");
        return this.execute(actor, req, "run-script", ids, (n) => `Run a script on ${this.noun(n)}`,
            // The script text itself is never kept in the audit trail; its size and shell are enough to tell runs apart.
            { shell: input.shell ?? "default for each system", timeoutSec: input.timeoutSec ?? 600, length: new TextEncoder().encode(script).length },
            async (ctx) => {
                this.needAgent(ctx);
                const jobId = await this.runs.startRun({ deviceId: ctx.id, script, shell: input.shell, timeoutSec: input.timeoutSec }, { watch: false });
                return { status: "queued", jobId };
            });
    }

    /**
     * A saved script from the scripts manager on many devices. Parameter values reach the script only as RIQ_<NAME> environment variables,
     * exactly as a single run does, and are never kept in the audit trail (only their names).
     */
    runSavedScript(actor: Actor, req: any, ids: unknown, scriptId: string, supplied: Record<string, string>) {
        let script: { id: string; name: string; script: string | null; configuration: any } | null = null;
        let env: Record<string, string> = {};
        let language: "powershell" | "bash" = "powershell";
        let platform: "windows" | "linux" | "both" | "all" = "windows";
        let linuxText = "";
        let macosText = "";
        let timeoutSec = 300;
        return this.execute(actor, req, "run-saved-script", ids, (n) => `Run "${script?.name ?? "a saved script"}" on ${this.noun(n)}`,
            { scriptId, parameterNames: Object.keys(supplied ?? {}).slice(0, 30) },
            async (ctx) => {
                const agent = this.needAgent(ctx);
                const windows = ctx.os.toLowerCase().includes("windows");
                const mac = !windows && /mac|darwin/i.test(ctx.os);
                const multi = platform === "both" || platform === "all";
                // a script for several systems runs its Windows (PowerShell) part on Windows, its macOS part on a Mac and its bash part on Linux
                if (platform === "both" && mac) throw new Skip("This script is made for Windows and Linux, not for macOS.");
                if (!multi && (language === "powershell") !== windows) throw new Skip(`This ${language} script does not run on ${ctx.os || "this system"}.`);
                const runLanguage = multi ? (windows ? "powershell" : "bash") : language;
                const runText = multi && mac ? macosText : multi && !windows ? linuxText : script!.script ?? "";
                const job = await this.jobs.createRunScriptJob({ agentId: agent.id, language: runLanguage, scriptText: runText, env, timeoutSec });
                await this.prisma.script_runs.create({ data: { automation_id: script!.id, script_name: script!.name, job_id: job.id, device_id: ctx.id, triggered_by: actor.id && isCanonicalUuid(actor.id) ? actor.id : null } });
                return { status: "queued", jobId: job.id };
            },
            async () => {
                if (!isCanonicalUuid(scriptId)) throw new BadRequestException("Choose a script.");
                script = await this.prisma.automations.findFirst({ where: { id: scriptId, type: "script" } });
                if (!script) throw new BadRequestException("That script no longer exists.");
                const c = (script.configuration ?? {}) as { language?: string; platform?: string; linuxScript?: string; macosScript?: string; timeoutSec?: number; parameters?: Array<{ name: string; label?: string; required?: boolean; defaultValue?: string }> };
                language = c.language === "bash" ? "bash" : "powershell";
                platform = c.platform === "both" ? "both" : c.platform === "all" ? "all" : language === "bash" ? "linux" : "windows";
                linuxText = typeof c.linuxScript === "string" ? c.linuxScript : "";
                macosText = typeof c.macosScript === "string" ? c.macosScript : "";
                timeoutSec = Number(c.timeoutSec) || 300;
                env = {};
                for (const p of Array.isArray(c.parameters) ? c.parameters : []) {
                    const value = String((supplied ?? {})[p.name] ?? p.defaultValue ?? "");
                    if (p.required && !value) throw new BadRequestException(`"${p.label || p.name}" is required.`);
                    env[`RIQ_${String(p.name).toUpperCase()}`] = value.slice(0, 2000);
                }
            });
    }

    /**
     * Recover agents: each device whose agent is online is asked to restart its own agent service (a signed script job; the restart is
     * handed to something that outlives the agent). A device that is offline cannot be reached from here, and is said so.
     */
    recoverAgents(actor: Actor, req: any, ids: unknown) {
        return this.execute(actor, req, "recover-agent", ids, (n) => `Restart the agent on ${this.noun(n)}`, {}, async (ctx) => {
            const agent = this.needAgent(ctx);
            if (Date.now() - (agent.lastCheckInAt?.getTime() ?? 0) > ONLINE_WINDOW_MS) throw new Skip("It is offline, so it cannot be told to restart from here. Restart the RemoteIQ agent service on the device, or run the installer there again.");
            const windows = ctx.os.toLowerCase().includes("windows");
            const linux = isLinuxOs(ctx.os.toLowerCase() === "linux" ? "linux" : "", ctx.os);
            if (!windows && !linux) throw new Skip("This system is not supported.");
            const job = await this.jobs.createRunScriptJob({
                agentId: agent.id, language: windows ? "powershell" : "bash", scriptText: windows ? WINDOWS_RECOVER_SCRIPT : LINUX_RECOVER_SCRIPT,
                env: { RIQ_TOOL: RECOVER_TOOL }, timeoutSec: 120,
            });
            return { status: "queued", jobId: job.id };
        });
    }

    /* ------------------------------ the batch view ------------------------------ */

    private async visibleBatchWhere(actor: Actor): Promise<{ where: Prisma.bulk_batchesWhereInput; scope: AccessScope | null }> {
        const orgId = await this.orgOf(actor);
        const scope = await this.scopeOf(actor);
        // Someone limited to some customers sees only their own batches.
        return { where: { organization_id: orgId, ...(scope ? { created_by: actor.id ?? "00000000-0000-0000-0000-000000000000" } : {}) }, scope };
    }

    private async names(userIds: string[]): Promise<Map<string, string>> {
        const ids = [...new Set(userIds.filter(Boolean))];
        if (!ids.length) return new Map();
        const rows = await this.prisma.users.findMany({ where: { id: { in: ids } }, select: { id: true, first_name: true, last_name: true, email: true } });
        return new Map(rows.map((u) => [u.id, [u.first_name, u.last_name].filter(Boolean).join(" ") || String(u.email)]));
    }

    async listBatches(actor: Actor, limit = 30) {
        const { where } = await this.visibleBatchWhere(actor);
        const rows = await this.prisma.bulk_batches.findMany({ where, orderBy: { created_at: "desc" }, take: Math.min(Math.max(Math.floor(limit) || 30, 1), 100) });
        const who = await this.names(rows.map((r) => r.created_by ?? ""));
        return {
            items: rows.map((r) => ({
                id: r.id, action: r.action, summary: r.summary, requested: r.requested, succeeded: r.succeeded, skipped: r.skipped, failed: r.failed,
                createdAt: r.created_at.toISOString(), by: r.created_by ? who.get(r.created_by) ?? null : null,
            })),
        };
    }

    /** How a job or agent task is going, in the words the batch view uses. */
    private live(job: { status: string; exit: number | null } | undefined, task: { status: string } | undefined): { state: "waiting" | "running" | "done" | "failed" | "timeout" | "cancelled"; text: string } | null {
        if (job) {
            const s = job.status;
            if (s === "succeeded") return { state: "done", text: "Finished" };
            if (s === "failed") return { state: "failed", text: job.exit != null ? `Failed (exit ${job.exit})` : "Failed" };
            if (s === "timeout") return { state: "timeout", text: "Timed out" };
            if (s === "queued") return { state: "waiting", text: "Waiting for the device" };
            return { state: "running", text: "Running" };
        }
        if (task) {
            const s = task.status;
            if (s === "succeeded") return { state: "done", text: "Finished" };
            if (s === "failed") return { state: "failed", text: "Failed" };
            if (s === "cancelled") return { state: "cancelled", text: "Cancelled" };
            if (s === "running") return { state: "running", text: "Running" };
            return { state: "waiting", text: "Waiting for the device" };
        }
        return null;
    }

    async getBatch(actor: Actor, id: string) {
        if (!isCanonicalUuid(id)) throw new NotFoundException("Batch not found");
        const { where, scope } = await this.visibleBatchWhere(actor);
        const batch = await this.prisma.bulk_batches.findFirst({ where: { ...where, id }, include: { items: { orderBy: [{ device_name: "asc" }, { id: "asc" }] } } });
        if (!batch) throw new NotFoundException("Batch not found");

        let items = batch.items;
        if (scope) {
            const visible = await this.prisma.devices.findMany({ where: { id: { in: items.map((i) => i.device_id) }, ...deviceWhereOf(scope) }, select: { id: true } });
            const ok = new Set(visible.map((d) => d.id));
            // Devices that were never found carry nothing to hide, so they stay in the list of the person who asked.
            items = items.filter((i) => ok.has(i.device_id) || (i.status === "failed" && i.reason === NOT_FOUND));
        }
        const jobIds = items.flatMap((i) => (i.job_id ? [i.job_id] : []));
        const taskIds = items.flatMap((i) => (i.task_id ? [i.task_id] : []));
        const jobs = jobIds.length ? await this.prisma.jobs.findMany({ where: { id: { in: jobIds } }, select: { id: true, status: true, job_results: { select: { exit_code: true } } } }) : [];
        const tasks = taskIds.length ? await this.prisma.agent_tasks.findMany({ where: { id: { in: taskIds } }, select: { id: true, status: true } }) : [];
        const jobBy = new Map<string, { status: string; exit: number | null }>(jobs.map((j) => [j.id, { status: j.status, exit: j.job_results?.exit_code ?? null }] as [string, { status: string; exit: number | null }]));
        const taskBy = new Map<string, { status: string }>(tasks.map((t) => [t.id, { status: String(t.status) }] as [string, { status: string }]));
        const who = await this.names([batch.created_by ?? ""]);

        const out = items.map((i) => ({
            id: i.id,
            deviceId: i.device_id,
            name: i.device_name,
            status: i.status as ItemStatus,
            reason: i.reason,
            live: this.live(i.job_id ? jobBy.get(i.job_id) : undefined, i.task_id ? taskBy.get(i.task_id) : undefined),
            hasOutput: !!i.job_id,
        }));
        const live = (s: string) => out.filter((i) => i.live?.state === s).length;
        return {
            id: batch.id,
            action: batch.action,
            summary: batch.summary,
            createdAt: batch.created_at.toISOString(),
            by: batch.created_by ? who.get(batch.created_by) ?? null : null,
            requested: batch.requested,
            succeeded: batch.succeeded,
            skipped: batch.skipped,
            failed: batch.failed,
            progress: { waiting: live("waiting"), running: live("running"), done: live("done"), failed: live("failed") + live("timeout") + live("cancelled") },
            items: out,
        };
    }

    /** What the script printed on one device of a run-script batch. */
    async itemOutput(actor: Actor, batchId: string, itemId: string) {
        if (!isCanonicalUuid(batchId) || !isCanonicalUuid(itemId)) throw new NotFoundException("Result not found");
        const { where, scope } = await this.visibleBatchWhere(actor);
        const item = await this.prisma.bulk_batch_items.findFirst({ where: { id: itemId, batch_id: batchId, batch: where } });
        if (!item || !item.job_id) throw new NotFoundException("Result not found");
        if (scope) {
            const ok = await this.access.canSeeDevice(scope, item.device_id);
            if (!ok) throw new NotFoundException("Result not found");
        }
        const job = await this.prisma.jobs.findUnique({ where: { id: item.job_id }, select: { status: true, job_results: { select: { exit_code: true, stdout: true, stderr: true } } } });
        if (!job) throw new NotFoundException("Result not found");
        const r = job.job_results;
        const cut = (s: string) => (s.length > OUTPUT_LIMIT ? `${s.slice(0, OUTPUT_LIMIT)}\n... (shortened)` : s);
        return { status: job.status, exitCode: r?.exit_code ?? null, stdout: cut(r?.stdout ?? ""), stderr: cut(r?.stderr ?? "") };
    }

    @Interval(24 * 60 * 60 * 1000)
    async prune() {
        try {
            await this.prisma.bulk_batches.deleteMany({ where: { created_at: { lt: new Date(Date.now() - KEEP_DAYS * 86_400_000) } } });
        } catch (err) {
            this.logger.warn(`Could not clean up old bulk batches: ${(err as any)?.code ?? (err as Error)?.name}`);
        }
    }
}

