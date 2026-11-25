// backend/src/m365/m365.service.ts
//
// Microsoft 365 tenants of customers: the connection a person keeps (tenant, the app's ID and its secret, which is stored encrypted and never
// shown again), the reading that runs once a day or on request, and what it came to. Read-only: nothing is ever changed in a tenant.
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { isCanonicalUuid } from "../common/agent-lookup.util";
import { decryptSecret, encryptSecret } from "../common/secret-box";
import { ClientAccessService } from "../reports/client-access.service";
import { OrganizationContextService } from "../storage/organization-context.service";
import { PrismaService } from "../storage/prisma.service";
import { WebhooksService } from "../webhooks/webhooks.service";
import { analyze, cleanAppId, cleanSecret, cleanTenant, type Summary } from "./m365.core";
import { GraphError, gather, getToken } from "./m365.graph";

export type Actor = { id: string | null; organizationId?: string | null };
type Input = { clientId?: unknown; tenant?: unknown; appId?: unknown; secret?: unknown };

type Row = {
    id: string; client_id: string; client_name: string | null; tenant: string; app_id: string; name: string | null; status: string; last_error: string | null;
    last_synced_at: Date | null; requested_at: Date | null; summary: Summary | null; created_at: Date;
};

const SELECT = `SELECT t.id::text AS id, t.client_id::text AS client_id, c.name AS client_name, t.tenant, t.app_id, t.name, t.status, t.last_error, t.last_synced_at, t.requested_at, t.summary, t.created_at
    FROM public.m365_tenants t JOIN public.clients c ON c.id = t.client_id`;
const DAILY_MS = 24 * 3_600_000;

const present = (r: Row, detail: boolean) => ({
    id: r.id, clientId: r.client_id, customer: r.client_name, tenant: r.tenant, appId: r.app_id, name: r.name ?? r.summary?.organization.name ?? r.tenant, status: r.status, error: r.last_error,
    lastSyncedAt: r.last_synced_at ? r.last_synced_at.toISOString() : null, syncing: !!r.requested_at && (!r.last_synced_at || r.requested_at > r.last_synced_at) && Date.now() - r.requested_at.getTime() < 5 * 60_000,
    health: r.summary?.health ?? null,
    critical: r.summary?.findings.filter((f) => f.severity === "critical").length ?? 0,
    warnings: r.summary?.findings.filter((f) => f.severity === "warning").length ?? 0,
    users: r.summary?.counts?.users ?? null,
    ...(detail ? { summary: r.summary } : {}),
});

@Injectable()
export class M365Service {
    private readonly logger = new Logger(M365Service.name);
    private busy = false;

    constructor(
        private readonly prisma: PrismaService,
        private readonly orgs: OrganizationContextService,
        private readonly access: ClientAccessService,
        private readonly hooks: WebhooksService,
    ) { }

    private async orgOf(actor: Actor) { return actor.organizationId || (await this.orgs.getDefaultOrganizationId()); }

    private async rows(actor: Actor, where: string, ...params: unknown[]): Promise<Row[]> {
        const org = await this.orgOf(actor);
        const allowed = await this.access.allowedFor(actor.id);
        const rows = (await this.prisma.$queryRawUnsafe(`${SELECT} WHERE c.organization_id = $1::uuid ${where} ORDER BY lower(c.name), lower(t.tenant)`, org, ...params)) as Row[];
        return allowed ? rows.filter((r) => allowed.includes(r.client_id)) : rows;
    }

    async list(actor: Actor) {
        return { items: (await this.rows(actor, "")).map((r) => present(r, false)) };
    }

    async get(actor: Actor, id: string) {
        if (!isCanonicalUuid(id)) throw new NotFoundException("Tenant not found");
        const r = (await this.rows(actor, "AND t.id = $2::uuid", id))[0];
        if (!r) throw new NotFoundException("Tenant not found");
        return present(r, true);
    }

    async create(actor: Actor, input: Input) {
        const tenant = cleanTenant(input.tenant), appId = cleanAppId(input.appId), secret = cleanSecret(input.secret);
        const clientId = String(input.clientId ?? "");
        if (!isCanonicalUuid(clientId)) throw new BadRequestException("Choose the customer this tenant belongs to.");
        const org = await this.orgOf(actor);
        const client = await this.prisma.clients.findFirst({ where: { id: clientId, organization_id: org }, select: { id: true } });
        if (!client) throw new BadRequestException("That customer does not exist.");
        this.access.assertClient(await this.access.allowedFor(actor.id), clientId);
        let id: string;
        try {
            const r = (await this.prisma.$queryRaw<Array<{ id: string }>>`INSERT INTO public.m365_tenants (organization_id, client_id, tenant, app_id, secret_enc, created_by)
                VALUES (${org}::uuid, ${clientId}::uuid, ${tenant}, ${appId}, ${encryptSecret(secret)}, ${actor.id}::uuid) RETURNING id::text AS id`)[0];
            id = r.id;
        } catch (e: any) {
            if (/23505/.test(`${e?.meta?.code ?? ""} ${e?.message ?? ""}`)) throw new ConflictException("That tenant is already connected.");
            throw e;
        }
        void this.sync(id).catch((e) => this.logger.warn(`First reading of ${tenant} failed: ${(e as Error).message}`));
        return this.get(actor, id);
    }

    /** Changes the app or its secret (for a secret that expired). The tenant itself stays. */
    async update(actor: Actor, id: string, input: Input) {
        await this.get(actor, id);
        if (input.appId !== undefined) await this.prisma.$executeRaw`UPDATE public.m365_tenants SET app_id = ${cleanAppId(input.appId)}, updated_at = now() WHERE id = ${id}::uuid`;
        if (input.secret !== undefined && String(input.secret) !== "") await this.prisma.$executeRaw`UPDATE public.m365_tenants SET secret_enc = ${encryptSecret(cleanSecret(input.secret))}, updated_at = now() WHERE id = ${id}::uuid`;
        void this.sync(id).catch(() => undefined);
        return this.get(actor, id);
    }

    async remove(actor: Actor, id: string) {
        await this.get(actor, id);
        await this.prisma.$executeRaw`DELETE FROM public.m365_tenants WHERE id = ${id}::uuid`;
        return { ok: true };
    }

    /** Reads now. The answer comes back when the reading is done (a tenant is read in a few seconds). */
    async syncNow(actor: Actor, id: string) {
        await this.get(actor, id);
        await this.sync(id);
        return this.get(actor, id);
    }

    @Interval(600_000)
    async tick(): Promise<void> {
        if ((process.env.M365_SYNC ?? "").toLowerCase() === "false" || this.busy) return;
        this.busy = true;
        try {
            const due = await this.prisma.$queryRaw<Array<{ id: string }>>`SELECT id::text AS id FROM public.m365_tenants
                WHERE (last_synced_at IS NULL OR last_synced_at < now() - ${DAILY_MS / 1000} * interval '1 second') AND (requested_at IS NULL OR requested_at < now() - interval '30 minutes') ORDER BY last_synced_at NULLS FIRST LIMIT 5`;
            for (const d of due) await this.sync(d.id).catch((e) => this.logger.warn(`Reading a tenant failed: ${(e as Error).message}`));
        } finally { this.busy = false; }
    }

    /** Signs in, reads, works out the findings, stores them. A failed reading keeps the last good one and says what went wrong. */
    async sync(id: string): Promise<void> {
        const t = (await this.prisma.$queryRaw<Array<{ tenant: string; app_id: string; secret_enc: string; organization_id: string; client_name: string; had: Summary | null }>>`
            SELECT t.tenant, t.app_id, t.secret_enc, t.organization_id::text AS organization_id, c.name AS client_name, t.summary AS had FROM public.m365_tenants t JOIN public.clients c ON c.id = t.client_id WHERE t.id = ${id}::uuid`)[0];
        if (!t) return;
        await this.prisma.$executeRaw`UPDATE public.m365_tenants SET requested_at = now() WHERE id = ${id}::uuid`;
        try {
            const token = await getToken(t.tenant, t.app_id, decryptSecret(t.secret_enc));
            const gathered = await gather(token);
            if (gathered.users === undefined && gathered.skus === undefined && gathered.mfa === undefined && gathered.roles === undefined) {
                // nothing at all could be read: the app has no permissions yet
                throw new GraphError(403, "Authorization_RequestDenied", Object.values(gathered.notRead)[0]);
            }
            const summary = analyze(gathered);
            const status = Object.keys(gathered.notRead).filter((k) => k !== "signIns").length ? "partial" : "ok";
            await this.prisma.$executeRaw`UPDATE public.m365_tenants SET summary = ${JSON.stringify(summary)}::jsonb, status = ${status}, last_error = NULL, last_synced_at = now(), updated_at = now(),
                name = COALESCE(${summary.organization.name}, name) WHERE id = ${id}::uuid`;
            await this.announceNew(t.organization_id, t.client_name, t.tenant, t.had, summary);
        } catch (e) {
            const message = e instanceof GraphError ? e.message : `The tenant could not be read (${(e as Error).message}).`;
            await this.prisma.$executeRaw`UPDATE public.m365_tenants SET status = 'error', last_error = ${message.slice(0, 400)}, last_synced_at = now(), updated_at = now() WHERE id = ${id}::uuid`;
        }
    }

    /** A critical finding that was not there at the last reading is news: it goes to the webhooks (Slack, Teams) like any other event. */
    private async announceNew(orgId: string, customer: string, tenant: string, before: Summary | null, after: Summary) {
        if (!before) return; // the first reading is a baseline, not a surprise
        const had = new Set(before.findings.filter((f) => f.severity === "critical").map((f) => f.id));
        const fresh = after.findings.filter((f) => f.severity === "critical" && !had.has(f.id));
        const base = (process.env.PUBLIC_CONSOLE_URL || "").replace(/\/+$/, "");
        for (const f of fresh) {
            await this.hooks.emit("monitor.failed", { monitor: { id: tenant, kind: "microsoft365", name: tenant, host: tenant, customer, url: base ? `${base}/microsoft-365` : null }, severity: "failed", detail: `${f.title}. ${f.detail}` }, orgId).catch(() => undefined);
        }
    }
}
