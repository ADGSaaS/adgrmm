// backend/src/web-monitors/web-monitors.service.ts
//
// Domain, DNS and certificate monitors: the list a person keeps, the checks that run on a schedule, and what is done with the news.
// News goes three ways: the list itself (state and detail), outbound webhooks (monitor.failed, monitor.recovered; Slack and Teams
// included, see webhook-chat.ts) and an email to the recipients of the alert notification channels of type email.
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { Prisma } from "@prisma/client";
import { isCanonicalUuid } from "../common/agent-lookup.util";
import { ClientAccessService } from "../reports/client-access.service";
import { SmtpService } from "../smtp/smtp.service";
import { OrganizationContextService } from "../storage/organization-context.service";
import { PrismaService } from "../storage/prisma.service";
import { WebhooksService } from "../webhooks/webhooks.service";
import {
    DNS_TYPES, MAX_MONITORS, MONITOR_KINDS, cleanConfig, cleanHost, cleanName, cleanPort, daysLeft, evalCertificate, evalDns, evalDomain, nextCheckAfter, transition,
    type DnsType, type MonitorConfig, type MonitorKind, type MonitorStatus,
} from "./web-monitors.core";
import { readCertificate, readDns, readDomain } from "./web-monitors.probe";

export type Actor = { id: string | null; organizationId?: string | null };
type Input = { kind?: unknown; name?: unknown; host?: unknown; port?: unknown; clientId?: unknown; config?: unknown; enabled?: unknown };

type Row = {
    id: string; organization_id: string; client_id: string | null; client_name: string | null; kind: MonitorKind; name: string; host: string; port: number; config: MonitorConfig;
    enabled: boolean; status: MonitorStatus; detail: string | null; result: unknown; expires_at: Date | null; error_count: number; last_checked_at: Date | null;
    next_check_at: Date; status_since: Date; created_at: Date;
};

const SELECT = Prisma.sql`SELECT m.id::text AS id, m.organization_id::text AS organization_id, m.client_id::text AS client_id, c.name AS client_name, m.kind, m.name, m.host, m.port,
    m.config, m.enabled, m.status, m.detail, m.result, m.expires_at, m.error_count, m.last_checked_at, m.next_check_at, m.status_since, m.created_at
    FROM public.web_monitors m LEFT JOIN public.clients c ON c.id = m.client_id`;

/** A unique-index violation from a raw query (Postgres code 23505). */
const isDuplicate = (e: any) => /23505/.test(`${e?.meta?.code ?? ""} ${e?.message ?? ""}`);

const KIND_LABEL: Record<MonitorKind, string> = { certificate: "Certificate", domain: "Domain", dns: "DNS" };
const BATCH = 20;
const CONCURRENT = 5;

const present = (r: Row, now = new Date()) => ({
    id: r.id, kind: r.kind, name: r.name, host: r.host, port: r.port, clientId: r.client_id, customer: r.client_name, config: r.config, enabled: r.enabled,
    status: r.status, detail: r.detail, result: r.result, expiresAt: r.expires_at ? r.expires_at.toISOString() : null,
    daysLeft: r.expires_at ? daysLeft(r.expires_at, now) : null,
    lastCheckedAt: r.last_checked_at ? r.last_checked_at.toISOString() : null, statusSince: r.status_since.toISOString(), createdAt: r.created_at.toISOString(),
});

@Injectable()
export class WebMonitorsService {
    private readonly logger = new Logger(WebMonitorsService.name);
    private working = false;

    constructor(
        private readonly prisma: PrismaService,
        private readonly orgs: OrganizationContextService,
        private readonly access: ClientAccessService,
        private readonly hooks: WebhooksService,
        private readonly smtp: SmtpService,
    ) { }

    private async orgOf(actor: Actor) { return actor.organizationId || (await this.orgs.getDefaultOrganizationId()); }

    /** The customers a limited person may use, or null for everyone else. */
    private allowed(actor: Actor) { return this.access.allowedFor(actor.id); }

    /* ------------------------------ the list ------------------------------ */

    async list(actor: Actor, filter: { clientId?: string; kind?: string; status?: string } = {}) {
        const org = await this.orgOf(actor);
        const allowed = await this.allowed(actor);
        const where: Prisma.Sql[] = [Prisma.sql`m.organization_id = ${org}::uuid`];
        // a limited person sees the monitors of their customers, never the ones that belong to no customer
        if (allowed) where.push(Prisma.sql`m.client_id::text = ANY(${allowed}::text[])`);
        if (filter.clientId && isCanonicalUuid(filter.clientId)) where.push(Prisma.sql`m.client_id = ${filter.clientId}::uuid`);
        if (filter.kind && (MONITOR_KINDS as readonly string[]).includes(filter.kind)) where.push(Prisma.sql`m.kind = ${filter.kind}`);
        if (filter.status && ["pending", "ok", "warning", "failed", "error"].includes(filter.status)) where.push(Prisma.sql`m.status = ${filter.status}`);
        const rows = await this.prisma.$queryRaw<Row[]>(Prisma.sql`${SELECT} WHERE ${Prisma.join(where, " AND ")}
            ORDER BY CASE m.status WHEN 'failed' THEN 0 WHEN 'error' THEN 1 WHEN 'warning' THEN 2 WHEN 'pending' THEN 3 ELSE 4 END, m.expires_at NULLS LAST, lower(m.name)`);
        const now = new Date();
        const items = rows.map((r) => present(r, now));
        const count = (s: string) => items.filter((i) => i.status === s).length;
        return { items, summary: { total: items.length, ok: count("ok"), warning: count("warning"), failed: count("failed") + count("error"), pending: count("pending") }, max: MAX_MONITORS };
    }

    private async find(actor: Actor, id: string): Promise<Row> {
        if (!isCanonicalUuid(id)) throw new NotFoundException("Monitor not found");
        const org = await this.orgOf(actor);
        const allowed = await this.allowed(actor);
        const rows = await this.prisma.$queryRaw<Row[]>(Prisma.sql`${SELECT} WHERE m.id = ${id}::uuid AND m.organization_id = ${org}::uuid`);
        const r = rows[0];
        if (!r || (allowed && (!r.client_id || !allowed.includes(r.client_id)))) throw new NotFoundException("Monitor not found");
        return r;
    }

    private async checkClient(actor: Actor, clientId: unknown): Promise<string | null> {
        if (clientId === undefined || clientId === null || clientId === "") {
            if (await this.allowed(actor)) throw new BadRequestException("Choose the customer this belongs to.");
            return null;
        }
        const id = String(clientId);
        if (!isCanonicalUuid(id)) throw new BadRequestException("Choose a customer.");
        const org = await this.orgOf(actor);
        const hit = await this.prisma.clients.findFirst({ where: { id, organization_id: org }, select: { id: true } });
        if (!hit) throw new BadRequestException("That customer does not exist.");
        this.access.assertClient(await this.allowed(actor), id);
        return id;
    }

    async create(actor: Actor, input: Input) {
        const kind = String(input.kind ?? "") as MonitorKind;
        if (!(MONITOR_KINDS as readonly string[]).includes(kind)) throw new BadRequestException("Choose what to monitor: a certificate, a domain or DNS records.");
        const org = await this.orgOf(actor);
        const host = cleanHost(input.host, kind);
        const port = cleanPort(input.port, kind);
        const config = cleanConfig(kind, input.config);
        const name = cleanName(input.name, `${host}${kind === "certificate" && port !== 443 ? `:${port}` : ""}`);
        const clientId = await this.checkClient(actor, input.clientId);
        const [{ n }] = await this.prisma.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM public.web_monitors WHERE organization_id = ${org}::uuid`;
        if (n >= MAX_MONITORS) throw new BadRequestException(`There can be ${MAX_MONITORS} monitors at most.`);
        let id: string;
        try {
            const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`INSERT INTO public.web_monitors (organization_id, client_id, kind, name, host, port, config, enabled, created_by)
                VALUES (${org}::uuid, ${clientId}::uuid, ${kind}, ${name}, ${host}, ${port}, ${JSON.stringify(config)}::jsonb, ${input.enabled !== false}, ${actor.id}::uuid) RETURNING id::text AS id`;
            id = rows[0].id;
        } catch (e: any) {
            if (isDuplicate(e)) throw new ConflictException(`${KIND_LABEL[kind]} of ${host} is already monitored.`);
            throw e;
        }
        void this.check(id).catch((e) => this.logger.warn(`First check of ${host} failed: ${(e as Error).message}`));
        return present(await this.find(actor, id));
    }

    async update(actor: Actor, id: string, input: Input) {
        const cur = await this.find(actor, id);
        const name = input.name !== undefined ? cleanName(input.name, cur.name) : cur.name;
        const host = input.host !== undefined ? cleanHost(input.host, cur.kind) : cur.host;
        const port = input.port !== undefined ? cleanPort(input.port, cur.kind) : cur.port;
        let config = cur.config;
        if (input.config !== undefined) {
            config = cleanConfig(cur.kind, input.config);
            // changing what is watched means what was remembered no longer applies
            if (cur.kind === "dns") config = { ...config, baseline: undefined };
        }
        const clientId = input.clientId !== undefined ? await this.checkClient(actor, input.clientId) : cur.client_id;
        const enabled = input.enabled !== undefined ? input.enabled === true : cur.enabled;
        const retarget = host !== cur.host || port !== cur.port || JSON.stringify(config) !== JSON.stringify(cur.config);
        try {
            await this.prisma.$executeRaw`UPDATE public.web_monitors SET name = ${name}, host = ${host}, port = ${port}, client_id = ${clientId}::uuid, config = ${JSON.stringify(config)}::jsonb,
                enabled = ${enabled}, updated_at = now(), next_check_at = CASE WHEN ${retarget} THEN now() ELSE next_check_at END WHERE id = ${id}::uuid`;
        } catch (e: any) {
            if (isDuplicate(e)) throw new ConflictException(`${KIND_LABEL[cur.kind]} of ${host} is already monitored.`);
            throw e;
        }
        if (retarget && enabled) void this.check(id).catch(() => undefined);
        return present(await this.find(actor, id));
    }

    async remove(actor: Actor, id: string) {
        await this.find(actor, id);
        await this.prisma.$executeRaw`DELETE FROM public.web_monitors WHERE id = ${id}::uuid`;
        return { ok: true };
    }

    /** Checks now and answers with the result. */
    async runNow(actor: Actor, id: string) {
        await this.find(actor, id);
        await this.check(id);
        return present(await this.find(actor, id));
    }

    /** DNS only: the records as they are now become the ones the monitor remembers. */
    async acceptBaseline(actor: Actor, id: string) {
        const cur = await this.find(actor, id);
        if (cur.kind !== "dns") throw new BadRequestException("Only a DNS monitor remembers records.");
        const current = (cur.result as { records?: Record<string, string[]> } | null)?.records;
        if (!current) throw new BadRequestException("It has not been checked yet.");
        const rules = (cur.config.records ?? []).map((r) => (r.expected && r.expected.length ? r : { type: r.type }));
        const baseline: Record<string, string[]> = {};
        for (const r of rules) if (!r.expected) baseline[r.type] = current[r.type] ?? [];
        const config = { ...cur.config, baseline };
        await this.prisma.$executeRaw`UPDATE public.web_monitors SET config = ${JSON.stringify(config)}::jsonb, updated_at = now(), next_check_at = now() WHERE id = ${id}::uuid`;
        await this.check(id);
        return present(await this.find(actor, id));
    }

    /* ------------------------------ checking ------------------------------ */

    @Interval(60_000)
    async work(): Promise<void> {
        if (this.working || (process.env.WEB_MONITORS_POLLING ?? "").toLowerCase() === "false") return;
        this.working = true;
        try {
            // claim the due ones in one step, so a second run never takes the same monitor
            const due = await this.prisma.$queryRaw<Array<{ id: string }>>`UPDATE public.web_monitors SET next_check_at = now() + interval '10 minutes'
                WHERE id IN (SELECT id FROM public.web_monitors WHERE enabled AND next_check_at <= now() ORDER BY next_check_at LIMIT ${BATCH} FOR UPDATE SKIP LOCKED) RETURNING id::text AS id`;
            for (let i = 0; i < due.length; i += CONCURRENT) {
                await Promise.all(due.slice(i, i + CONCURRENT).map((d) => this.check(d.id).catch((e) => this.logger.warn(`Check failed: ${(e as Error).message}`))));
            }
        } catch (e) {
            this.logger.error(`Web monitoring failed: ${(e as Error).message}`);
        } finally {
            this.working = false;
        }
    }

    /** One check of one monitor: read, judge, store, and tell people when the state changed. */
    async check(id: string): Promise<void> {
        const rows = await this.prisma.$queryRaw<Row[]>(Prisma.sql`${SELECT} WHERE m.id = ${id}::uuid`);
        const m = rows[0];
        if (!m) return;
        let outcome: { status: "ok" | "warning" | "failed" } | { error: string };
        let detail = "";
        let expiresAt: Date | null = null;
        let result: unknown = null;
        let baselineToStore: Record<string, string[]> | undefined;
        try {
            if (m.kind === "certificate") {
                const r = await readCertificate(m.host, m.port);
                const ev = evalCertificate(r, m.config);
                outcome = { status: ev.status }; detail = ev.detail; expiresAt = ev.expiresAt; result = r;
            } else if (m.kind === "domain") {
                const r = await readDomain(m.host);
                const ev = evalDomain(r, m.config);
                outcome = { status: ev.status }; detail = ev.detail; expiresAt = ev.expiresAt; result = r;
            } else {
                const types = (m.config.records ?? []).map((r) => r.type).filter((t): t is DnsType => (DNS_TYPES as readonly string[]).includes(t));
                const r = await readDns(m.host, types);
                const ev = evalDns(r, m.config);
                outcome = { status: ev.status }; detail = ev.detail; baselineToStore = ev.baselineToStore; result = { records: r, changed: ev.changed };
            }
        } catch (e) {
            outcome = { error: (e as Error).message };
            detail = (e as Error).message;
        }
        const t = transition(m.status, m.error_count, outcome);
        const hadError = "error" in outcome;
        // while errors have not lasted, the last good result stays on show and only the time and the try count move
        const keep = hadError && t.next !== "error";
        const config = baselineToStore ? { ...m.config, baseline: baselineToStore } : m.config;
        const since = t.next !== m.status ? new Date() : m.status_since;
        await this.prisma.$executeRaw`UPDATE public.web_monitors SET
            status = ${t.next}, error_count = ${t.errorCount}, last_checked_at = now(), next_check_at = ${nextCheckAfter(m.kind, hadError)}, status_since = ${since},
            detail = ${keep ? `Could not be checked (${t.errorCount} in a row): ${detail}` : detail}, result = ${keep ? JSON.stringify(m.result ?? null) : JSON.stringify(result)}::jsonb,
            expires_at = ${keep ? m.expires_at : expiresAt}, config = ${JSON.stringify(config)}::jsonb
            WHERE id = ${id}::uuid`;
        if (t.notify) await this.announce(m, t.notify, t.severity ?? "failed", detail, expiresAt ?? m.expires_at).catch((e) => this.logger.warn(`Could not announce ${m.host}: ${(e as Error).message}`));
    }

    /* ------------------------------ news ------------------------------ */

    private consoleUrl() { return (process.env.PUBLIC_CONSOLE_URL || "").replace(/\/+$/, ""); }

    private async announce(m: Row, what: "failed" | "recovered", severity: "warning" | "failed" | "error", detail: string, expiresAt: Date | null) {
        const base = this.consoleUrl();
        const monitor = {
            id: m.id, kind: m.kind, name: m.name, host: m.host, port: m.port, customer: m.client_name, expiresAt: expiresAt ? expiresAt.toISOString() : null,
            url: base ? `${base}/monitoring/web` : null,
        };
        await this.hooks.emit(what === "failed" ? "monitor.failed" : "monitor.recovered", { monitor, severity: what === "failed" ? severity : "ok", detail }, m.organization_id);
        await this.email(m, what, severity, detail);
    }

    private async email(m: Row, what: "failed" | "recovered", severity: string, detail: string) {
        const channels = await this.prisma.notification_channels.findMany({ where: { kind: "email", enabled: true }, select: { config: true } });
        const to = [...new Set(channels.flatMap((c) => ((c.config as { recipients?: string[] } | null)?.recipients ?? [])))];
        if (!to.length) return;
        const label = what === "recovered" ? "Recovered" : severity === "warning" ? "Warning" : severity === "error" ? "Could not be checked" : "Problem";
        const subject = `${label}: ${KIND_LABEL[m.kind].toLowerCase()} monitor ${m.name}${m.client_name ? ` (${m.client_name})` : ""}`;
        const base = this.consoleUrl();
        const body = [`${KIND_LABEL[m.kind]} of ${m.host}${m.kind === "certificate" ? `:${m.port}` : ""}`, m.client_name ? `Customer: ${m.client_name}` : "", detail, base ? `Open it: ${base}/monitoring/web` : ""].filter(Boolean).join("\n");
        const r = await this.smtp.sendPlain("alerts", to.join(", "), subject, body);
        if (!r.ok) throw new Error(r.result);
    }
}
