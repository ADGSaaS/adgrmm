// backend/src/tools/tools.service.ts
//
// The Tools menu: actions that apply to MANY devices chosen by a scope (everything, one customer or one site, optionally one operating
// system, optionally only devices that are online) instead of by ticking rows. The scope is turned into the device ids this person may see
// and the work is handed to the bulk engine in groups of 500, so every device is checked on its own, every group is a batch in "Recent
// actions", and the customer limit of the person applies exactly as it does in the device list.
import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { DashboardService } from "../dashboard/dashboard.service";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../storage/prisma.service";
import { OrganizationContextService } from "../storage/organization-context.service";
import { AuditService } from "../audit/audit.service";
import { ClientAccessService, deviceWhereOf } from "../reports/client-access.service";
import { PoliciesService } from "../policies/policies.service";
import { forgetPolicyCache } from "../auth/security-policy";
import { isCanonicalUuid } from "../common/agent-lookup.util";
import { Actor, BatchResult, BulkService, MAX_BULK_DEVICES } from "../bulk/bulk.service";
import { MaintenanceService, type MaintenanceRequest } from "./maintenance.service";

export const MAX_SCOPE_DEVICES = 5000;
/** How many devices the preview lists for ticking and unticking. */
export const PREVIEW_LIST_MAX = 1000;
const ONLINE_WINDOW_MS = 5 * 60_000;

export type ScopeInput = {
    kind?: "all" | "client" | "site" | "tag"; clientId?: string; siteId?: string; tagId?: string; os?: "any" | "windows" | "linux"; onlineOnly?: boolean;
    /** Devices to leave out of the choice (the person unticked them). */
    exclude?: string[];
};

export type ScopeDevice = { id: string; name: string; os: "windows" | "linux" | "other"; online: boolean };

export type ScopeResult = { ids: string[]; all: ScopeDevice[]; excluded: number; total: number; windows: number; linux: number; other: number; online: number; offline: number; capped: boolean; sample: string[] };

export type ToolRun = {
    requested: number; succeeded: number; skipped: number; failed: number;
    batches: Array<{ batchId: string; summary: string; requested: number; succeeded: number; skipped: number; failed: number }>;
};

@Injectable()
export class ToolsService {
    private readonly logger = new Logger(ToolsService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly orgs: OrganizationContextService,
        private readonly access: ClientAccessService,
        private readonly bulk: BulkService,
        private readonly audit: AuditService,
        private readonly maintenance: MaintenanceService,
        private readonly dashboard: DashboardService,
    ) { }

    /* ------------------------------ the scope ------------------------------ */

    async resolve(actor: Actor, raw: ScopeInput | undefined): Promise<ScopeResult> {
        const s = raw ?? {};
        const kind = s.kind ?? "all";
        if (!["all", "client", "site", "tag"].includes(kind)) throw new BadRequestException("Choose all devices, a customer, a site or a tag.");
        if (kind === "client" && !isCanonicalUuid(String(s.clientId ?? ""))) throw new BadRequestException("Choose a customer.");
        if (kind === "site" && !isCanonicalUuid(String(s.siteId ?? ""))) throw new BadRequestException("Choose a site.");
        if (kind === "tag" && !isCanonicalUuid(String(s.tagId ?? ""))) throw new BadRequestException("Choose a tag.");
        const exclude = new Set((Array.isArray(s.exclude) ? s.exclude : []).map((x) => String(x).toLowerCase()));
        if (exclude.size > MAX_SCOPE_DEVICES || [...exclude].some((x) => !isCanonicalUuid(x))) throw new BadRequestException("The list of devices to leave out is not valid.");
        const os = s.os ?? "any";
        if (!["any", "windows", "linux"].includes(os)) throw new BadRequestException("The system must be any, windows or linux.");

        const orgId = actor.organizationId || (await this.orgs.getDefaultOrganizationId());
        const limit = await this.access.scopeFor(actor.id);
        const where: Prisma.devicesWhereInput = {
            AND: [
                { sites: { clients: { organization_id: orgId, ...(kind === "client" ? { id: s.clientId } : {}) }, ...(kind === "site" ? { id: s.siteId } : {}) } },
                { agents: { isNot: null } },
                ...(kind === "tag" ? [{ device_tags: { some: { tag_id: s.tagId, tag_defs: { organization_id: orgId } } } }] : []),
                ...(limit ? [deviceWhereOf(limit)] : []),
            ],
        };
        const rows = await this.prisma.devices.findMany({
            where, take: MAX_SCOPE_DEVICES + 1, orderBy: { hostname: "asc" },
            select: { id: true, hostname: true, alias: true, operating_system: true, agents: { select: { facts: true, last_check_in_at: true } } },
        });

        const now = Date.now();
        const ids: string[] = [];
        const all: ScopeDevice[] = [];
        let excluded = 0;
        const sample: string[] = [];
        let windows = 0, linux = 0, other = 0, online = 0, offline = 0;
        for (const d of rows.slice(0, MAX_SCOPE_DEVICES)) {
            const osName = String((d.agents?.facts as any)?.os || d.operating_system || "").toLowerCase();
            const kindOf = osName.startsWith("windows") ? "windows" : /linux|ubuntu|debian|fedora|rocky|alma|centos|red hat|rhel|suse|oracle|alpine|arch/.test(osName) ? "linux" : "other";
            if (os !== "any" && kindOf !== os) continue;
            const isOnline = now - (d.agents?.last_check_in_at?.getTime() ?? 0) <= ONLINE_WINDOW_MS;
            if (s.onlineOnly && !isOnline) continue;
            all.push({ id: d.id, name: d.alias || d.hostname, os: kindOf as ScopeDevice["os"], online: isOnline });
            if (exclude.has(d.id)) { excluded++; continue; }
            ids.push(d.id);
            if (sample.length < 5) sample.push(d.alias || d.hostname);
            if (kindOf === "windows") windows++; else if (kindOf === "linux") linux++; else other++;
            if (isOnline) online++; else offline++;
        }
        return { ids, all, excluded, total: ids.length, windows, linux, other, online, offline, capped: rows.length > MAX_SCOPE_DEVICES, sample };
    }

    /** What a scope matches, without doing anything. */
    async preview(actor: Actor, scope: ScopeInput | undefined) {
        // the list is what the choice reaches BEFORE anything is left out, so every device can be ticked or unticked
        const r = await this.resolve(actor, { ...(scope ?? {}), exclude: [] });
        return {
            total: r.total, windows: r.windows, linux: r.linux, other: r.other, online: r.online, offline: r.offline, capped: r.capped, max: MAX_SCOPE_DEVICES, sample: r.sample,
            devices: r.all.slice(0, PREVIEW_LIST_MAX), devicesCapped: r.all.length > PREVIEW_LIST_MAX,
        };
    }

    private async runGroups(ids: string[], fn: (group: string[]) => Promise<BatchResult>): Promise<ToolRun> {
        const out: ToolRun = { requested: 0, succeeded: 0, skipped: 0, failed: 0, batches: [] };
        for (let i = 0; i < ids.length; i += MAX_BULK_DEVICES) {
            const b = await fn(ids.slice(i, i + MAX_BULK_DEVICES));
            out.requested += b.requested; out.succeeded += b.succeeded; out.skipped += b.skipped; out.failed += b.failed;
            out.batches.push({ batchId: b.batchId, summary: b.summary, requested: b.requested, succeeded: b.succeeded, skipped: b.skipped, failed: b.failed });
        }
        return out;
    }

    private async scoped(actor: Actor, scope: ScopeInput | undefined) {
        const r = await this.resolve(actor, scope);
        if (r.total === 0) throw new BadRequestException("No device matches that choice, so nothing was done.");
        if (r.capped) throw new BadRequestException(`That matches more than ${MAX_SCOPE_DEVICES} devices. Choose a customer or a site.`);
        return r.ids;
    }

    /* ------------------------------ the tools ------------------------------ */

    /** Bulk command: one command typed here, run on every device in the scope. */
    async command(actor: Actor, req: any, scope: ScopeInput | undefined, input: { script: string; shell?: "powershell" | "bash" | "cmd"; timeoutSec?: number }) {
        const ids = await this.scoped(actor, scope);
        return this.runGroups(ids, (g) => this.bulk.runScript(actor, req, g, input));
    }

    /** Bulk script: a script from the scripts manager, with its parameters, on every device in the scope. */
    async script(actor: Actor, req: any, scope: ScopeInput | undefined, scriptId: string, parameters: Record<string, string>) {
        const ids = await this.scoped(actor, scope);
        return this.runGroups(ids, (g) => this.bulk.runSavedScript(actor, req, g, scriptId, parameters));
    }

    /** Bulk patch management: scan, or install what the last scan found, on every device in the scope. */
    async patches(actor: Actor, req: any, scope: ScopeInput | undefined, input: { action: "scan" | "install-critical" | "install-all"; includeOptional?: boolean }) {
        if (!["scan", "install-critical", "install-all"].includes(input?.action)) throw new BadRequestException("Choose scan, install critical or install all.");
        const ids = await this.scoped(actor, scope);
        const optional = !!input.includeOptional;
        return this.runGroups(ids, (g) => input.action === "scan"
            ? this.bulk.patchScan(actor, req, g, optional)
            : this.bulk.patchInstall(actor, req, g, input.action === "install-all" ? "all" : "critical", optional));
    }

    /** Recover agents: every online device in the scope is asked to restart its agent. */
    async recover(actor: Actor, req: any, scope: ScopeInput | undefined) {
        const ids = await this.scoped(actor, scope);
        return this.runGroups(ids, (g) => this.bulk.recoverAgents(actor, req, g));
    }

    /* ------------------------------ the server ------------------------------ */

    maintenanceList() { return this.maintenance.list(); }
    maintenancePreview(req: MaintenanceRequest) { return this.maintenance.preview(req); }

    async maintenanceRun(actor: Actor, req: any, body: MaintenanceRequest) {
        const result = await this.maintenance.run(body);
        void this.audit.record({
            action: "tools.maintenance", category: "admin", outcome: "success", actorUserId: actor.id, actorEmail: actor.email, req,
            targetType: "server", targetLabel: "Server maintenance",
            details: { removed: result.items.map((i) => ({ task: i.key, days: i.days, removed: i.removed })), optimized: result.optimized },
        });
        return result;
    }

    /** Forgets what the server keeps in memory for speed: policy results, the dashboard numbers and the sign-in policy. They are rebuilt on next use. */
    async clearCache(actor: Actor, req: any) {
        const cleared: string[] = [];
        PoliciesService.invalidate(); cleared.push("Policy results");
        forgetPolicyCache(); cleared.push("Sign-in policy");
        this.dashboard.clearCache(); cleared.push("Dashboard numbers");
        void this.audit.record({ action: "tools.clear-cache", category: "admin", outcome: "success", actorUserId: actor.id, actorEmail: actor.email, req, targetType: "server", targetLabel: "Server cache", details: { cleared } });
        return { cleared };
    }
}
