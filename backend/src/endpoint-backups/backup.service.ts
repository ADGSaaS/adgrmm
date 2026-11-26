// backend/src/endpoint-backups/backup.service.ts
//
// Backup status of customers' computers. Off until an administrator turns it on. Then, for every online Windows or Linux computer, a signed,
// read-only script reads what protects it every few hours; ADG RMM judges the age (backup.core.ts), keeps the answer per product, shows it
// per customer, raises an alert for a computer whose backup failed or that has none, and can write the customer's backup report.
import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { Prisma } from "@prisma/client";
import { AlertsService } from "../alerts/alerts.service";
import { isCanonicalUuid } from "../common/agent-lookup.util";
import { JobsService } from "../jobs/jobs.service";
import { ClientAccessService, deviceSqlOf } from "../reports/client-access.service";
import { OrganizationContextService } from "../storage/organization-context.service";
import { PrismaService } from "../storage/prisma.service";
import {
    BackupOutputError, DEFAULT_SETTINGS, cleanSettings, judgeDevice, needsAttention, parseBackupOutput,
    type Overall, type Product, type ProductKind, type ReportedState, type Settings,
} from "./backup.core";
import { LINUX_BACKUP_SCRIPT, WINDOWS_BACKUP_SCRIPT } from "./backup.scripts";

export type Actor = { id: string | null; organizationId?: string | null };

const FINISHED = ["succeeded", "failed", "timeout"];
const GIVE_UP_MIN = 15;
const BATCH = 20;
const OVERALLS: Overall[] = ["ok", "warning", "failed", "unknown", "none"];

type Row = {
    device_id: string; name: string; client_id: string | null; customer: string | null; site: string | null; windows: boolean; online: boolean;
    status: string | null; checked_at: Date | null; requested_at: Date | null; message: string | null; overall: Overall | null; overall_detail: string | null; last_success_at: Date | null;
};

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

@Injectable()
export class EndpointBackupsService {
    private readonly logger = new Logger(EndpointBackupsService.name);
    private busy = false;

    constructor(
        private readonly prisma: PrismaService,
        private readonly orgs: OrganizationContextService,
        private readonly access: ClientAccessService,
        private readonly jobs: JobsService,
        private readonly alerts: AlertsService,
    ) { }

    private async orgOf(actor: Actor) { return actor.organizationId || (await this.orgs.getDefaultOrganizationId()); }

    /* ------------------------------ settings ------------------------------ */

    async settings(orgId: string): Promise<Settings> {
        const r = (await this.prisma.$queryRaw<Array<{ enabled: boolean; warn_hours: number; fail_hours: number; check_hours: number; alerts: boolean }>>`
            SELECT enabled, warn_hours, fail_hours, check_hours, alerts FROM public.endpoint_backup_settings WHERE organization_id = ${orgId}::uuid`)[0];
        return r ? { enabled: r.enabled, warnHours: r.warn_hours, failHours: r.fail_hours, checkHours: r.check_hours, alerts: r.alerts } : { ...DEFAULT_SETTINGS };
    }

    async saveSettings(orgId: string, actorId: string | null, input: Record<string, unknown>) {
        const before = await this.settings(orgId);
        const after = cleanSettings(input, before);
        await this.prisma.$executeRaw`INSERT INTO public.endpoint_backup_settings (organization_id, enabled, warn_hours, fail_hours, check_hours, alerts, updated_by, updated_at)
            VALUES (${orgId}::uuid, ${after.enabled}, ${after.warnHours}, ${after.failHours}, ${after.checkHours}, ${after.alerts}, ${actorId}::uuid, now())
            ON CONFLICT (organization_id) DO UPDATE SET enabled = EXCLUDED.enabled, warn_hours = EXCLUDED.warn_hours, fail_hours = EXCLUDED.fail_hours, check_hours = EXCLUDED.check_hours,
              alerts = EXCLUDED.alerts, updated_by = EXCLUDED.updated_by, updated_at = now()`;
        // the judgement changed, so the stored verdicts are worked out again from what the devices said
        if (before.warnHours !== after.warnHours || before.failHours !== after.failHours) await this.rejudge(orgId, after).catch((e) => this.logger.warn(`Could not re-judge: ${(e as Error).message}`));
        return { before, after };
    }

    /* ------------------------------ the list ------------------------------ */

    private async visibleWhere(actor: Actor, orgId: string, filter: { clientId?: string; q?: string }): Promise<Prisma.Sql> {
        const parts: Prisma.Sql[] = [Prisma.sql`c.organization_id = ${orgId}::uuid`];
        const scope = await this.access.scopeFor(actor.id);
        if (scope) parts.push(deviceSqlOf(scope, { client: Prisma.sql`c.id::text`, site: Prisma.sql`s.id::text`, id: Prisma.sql`d.id::text` }));
        if (filter.clientId && isCanonicalUuid(filter.clientId)) parts.push(Prisma.sql`c.id = ${filter.clientId}::uuid`);
        if (filter.q?.trim()) parts.push(Prisma.sql`(d.hostname ILIKE ${`%${filter.q.trim().replace(/[%_\\]/g, "\\$&")}%`} OR d.alias ILIKE ${`%${filter.q.trim().replace(/[%_\\]/g, "\\$&")}%`})`);
        return Prisma.join(parts, " AND ");
    }

    private async rows(actor: Actor, filter: { clientId?: string; q?: string; status?: string }): Promise<Row[]> {
        const orgId = await this.orgOf(actor);
        const where = await this.visibleWhere(actor, orgId, filter);
        const status = filter.status && OVERALLS.includes(filter.status as Overall) ? Prisma.sql` AND k.overall = ${filter.status}` : filter.status === "unchecked" ? Prisma.sql` AND k.overall IS NULL` : Prisma.empty;
        return this.prisma.$queryRaw<Row[]>(Prisma.sql`
            SELECT d.id::text AS device_id, COALESCE(d.alias, d.hostname) AS name, c.id::text AS client_id, c.name AS customer, s.name AS site,
                   (lower(COALESCE(a.facts->>'os', d.operating_system, '')) LIKE 'windows%') AS windows, COALESCE(a.last_check_in_at > now() - interval '10 minutes', false) AS online,
                   k.status, k.checked_at, k.requested_at, k.message, k.overall, k.overall_detail, k.last_success_at
              FROM public.devices d JOIN public.sites s ON s.id = d.site_id JOIN public.clients c ON c.id = s.client_id LEFT JOIN public.agents a ON a.device_id = d.id
              LEFT JOIN public.endpoint_backup_checks k ON k.device_id = d.id
             WHERE ${where} AND a.id IS NOT NULL${status}
             ORDER BY CASE k.overall WHEN 'failed' THEN 0 WHEN 'none' THEN 1 WHEN 'warning' THEN 2 WHEN 'unknown' THEN 3 WHEN 'ok' THEN 5 ELSE 4 END, c.name, lower(COALESCE(d.alias, d.hostname))
             LIMIT 2000`);
    }

    private async productsOf(ids: string[]): Promise<Map<string, Array<{ product: string; kind: string; state: string; lastSuccessAt: string | null; lastAttemptAt: string | null; detail: string | null }>>> {
        const map = new Map<string, Array<{ product: string; kind: string; state: string; lastSuccessAt: string | null; lastAttemptAt: string | null; detail: string | null }>>();
        if (!ids.length) return map;
        const rows = await this.prisma.$queryRaw<Array<{ device_id: string; product: string; kind: string; state: string; last_success_at: Date | null; last_attempt_at: Date | null; detail: string | null }>>`
            SELECT device_id::text AS device_id, product, kind, state, last_success_at, last_attempt_at, detail FROM public.endpoint_backup_products WHERE device_id = ANY(${ids}::uuid[]) ORDER BY product`;
        for (const r of rows) {
            const list = map.get(r.device_id) ?? [];
            list.push({ product: r.product, kind: r.kind, state: r.state, lastSuccessAt: iso(r.last_success_at), lastAttemptAt: iso(r.last_attempt_at), detail: r.detail });
            map.set(r.device_id, list);
        }
        return map;
    }

    async list(actor: Actor, filter: { clientId?: string; q?: string; status?: string } = {}) {
        const orgId = await this.orgOf(actor);
        // a check that has just finished is read back now, so the page shows it without waiting for the next round
        const waiting = await this.prisma.$queryRaw<Array<{ device_id: string }>>`SELECT device_id::text AS device_id FROM public.endpoint_backup_checks WHERE status = 'pending' AND requested_at > now() - interval '20 minutes' ORDER BY requested_at LIMIT 30`;
        for (const w of waiting) await this.refresh(w.device_id).catch(() => undefined);
        const [settings, rows] = await Promise.all([this.settings(orgId), this.rows(actor, filter)]);
        const products = await this.productsOf(rows.map((r) => r.device_id));
        const items = rows.map((r) => ({
            deviceId: r.device_id, name: r.name, clientId: r.client_id, customer: r.customer, site: r.site, os: r.windows ? "windows" : "linux", online: r.online,
            overall: r.overall, detail: r.overall_detail, lastSuccessAt: iso(r.last_success_at), checkedAt: iso(r.checked_at),
            checking: r.status === "pending" && !!r.requested_at && Date.now() - r.requested_at.getTime() < GIVE_UP_MIN * 60_000,
            problem: r.status === "failed" ? r.message : null,
            products: products.get(r.device_id) ?? [],
        }));
        const count = (o: Overall) => items.filter((i) => i.overall === o).length;
        return {
            settings,
            items,
            summary: { total: items.length, ok: count("ok"), warning: count("warning"), failed: count("failed"), none: count("none"), unknown: count("unknown"), unchecked: items.filter((i) => !i.overall).length },
        };
    }

    /* ------------------------------ checking ------------------------------ */

    /** Checks now: one computer, or every online computer of a customer. Answers with how many were started. */
    async checkNow(actor: Actor, input: { deviceId?: unknown; clientId?: unknown }) {
        const orgId = await this.orgOf(actor);
        if (!(await this.settings(orgId)).enabled) throw new BadRequestException("Backup checks are turned off. Turn them on first.");
        const filter = input.deviceId ? undefined : { clientId: String(input.clientId ?? "") };
        if (!input.deviceId && !isCanonicalUuid(String(input.clientId ?? ""))) throw new BadRequestException("Choose a computer or a customer.");
        const rows = (await this.rows(actor, filter ?? {})).filter((r) => (input.deviceId ? r.device_id === String(input.deviceId) : true));
        if (input.deviceId && rows.length === 0) throw new NotFoundException("Device not found");
        let started = 0, offline = 0;
        for (const r of rows.slice(0, 200)) {
            if (!r.online) { offline++; continue; }
            if (r.status === "pending" && r.requested_at && Date.now() - r.requested_at.getTime() < GIVE_UP_MIN * 60_000) continue;
            if (await this.start(r.device_id, r.windows).catch(() => false)) started++;
        }
        return { started, offline, total: rows.length };
    }

    private async start(deviceId: string, windows: boolean): Promise<boolean> {
        const agent = (await this.prisma.$queryRaw<Array<{ id: string }>>`SELECT id::text AS id FROM public.agents WHERE device_id = ${deviceId}::uuid`)[0];
        if (!agent) return false;
        const job = await this.jobs.createRunScriptJob({ agentId: agent.id, language: windows ? "powershell" : "bash", scriptText: windows ? WINDOWS_BACKUP_SCRIPT : LINUX_BACKUP_SCRIPT, env: {}, timeoutSec: 120 });
        await this.prisma.$executeRaw`INSERT INTO public.endpoint_backup_checks (device_id, job_id, status, requested_at) VALUES (${deviceId}::uuid, ${job.id}::uuid, 'pending', now())
            ON CONFLICT (device_id) DO UPDATE SET job_id = EXCLUDED.job_id, status = 'pending', requested_at = now(), message = NULL`;
        return true;
    }

    @Interval(60_000)
    async tick(): Promise<void> {
        if ((process.env.ENDPOINT_BACKUPS_POLLING ?? "").toLowerCase() === "false") return;
        await this.run();
    }

    /** One round: read back finished checks, then start the checks that are due. */
    async run(): Promise<{ read: number; started: number }> {
        if (this.busy) return { read: 0, started: 0 };
        this.busy = true;
        let read = 0, started = 0;
        try {
            const pending = await this.prisma.$queryRaw<Array<{ device_id: string }>>`SELECT device_id::text AS device_id FROM public.endpoint_backup_checks WHERE status = 'pending' ORDER BY requested_at LIMIT 100`;
            for (const p of pending) { try { if ((await this.refresh(p.device_id)) !== "waiting") read++; } catch (e) { this.logger.warn(`Reading a backup check back failed: ${(e as Error).message}`); } }
            const orgs = await this.prisma.$queryRaw<Array<{ organization_id: string; check_hours: number }>>`SELECT organization_id::text AS organization_id, check_hours FROM public.endpoint_backup_settings WHERE enabled`;
            for (const o of orgs) {
                const due = await this.prisma.$queryRaw<Array<{ device_id: string; windows: boolean }>>`
                    SELECT d.id::text AS device_id, (lower(COALESCE(a.facts->>'os', d.operating_system, '')) LIKE 'windows%') AS windows
                      FROM public.devices d JOIN public.sites s ON s.id = d.site_id JOIN public.clients c ON c.id = s.client_id JOIN public.agents a ON a.device_id = d.id
                      LEFT JOIN public.endpoint_backup_checks k ON k.device_id = d.id
                     WHERE c.organization_id = ${o.organization_id}::uuid AND a.last_check_in_at > now() - interval '5 minutes'
                       AND (lower(COALESCE(a.facts->>'os', d.operating_system, '')) LIKE 'windows%' OR lower(COALESCE(a.facts->>'os', '')) = 'linux'
                            OR lower(COALESCE(d.operating_system, '')) ~ 'linux|ubuntu|debian|fedora|rocky|alma|centos|red hat|rhel|suse|oracle|alpine')
                       AND (k.device_id IS NULL OR (k.status <> 'pending' AND k.requested_at <= now() - make_interval(hours => ${o.check_hours}::int))
                            OR (k.status = 'pending' AND k.requested_at < now() - make_interval(mins => ${GIVE_UP_MIN}::int)))
                     ORDER BY k.requested_at NULLS FIRST LIMIT ${BATCH}`;
                for (const d of due) { try { if (await this.start(d.device_id, d.windows)) started++; } catch (e) { this.logger.warn(`Starting a backup check failed: ${(e as Error).message}`); } }
            }
        } finally {
            this.busy = false;
        }
        return { read, started };
    }

    async refresh(deviceId: string): Promise<"waiting" | "done" | "failed"> {
        const k = (await this.prisma.$queryRaw<Array<{ job_id: string | null; status: string; requested_at: Date; org: string | null }>>`
            SELECT k.job_id::text AS job_id, k.status, k.requested_at, c.organization_id::text AS org FROM public.endpoint_backup_checks k JOIN public.devices d ON d.id = k.device_id
              LEFT JOIN public.sites s ON s.id = d.site_id LEFT JOIN public.clients c ON c.id = s.client_id WHERE k.device_id = ${deviceId}::uuid`)[0];
        if (!k || k.status !== "pending") return k?.status === "done" ? "done" : "failed";
        const fail = async (message: string) => {
            await this.prisma.$executeRaw`UPDATE public.endpoint_backup_checks SET status = 'failed', message = ${message.slice(0, 300)} WHERE device_id = ${deviceId}::uuid AND status = 'pending'`;
            return "failed" as const;
        };
        if (!k.job_id) return fail("The check was never started.");
        const job = await this.jobs.getJobWithResult(k.job_id).catch(() => null);
        if (!job) return fail("The check job is gone.");
        if (!FINISHED.includes(String(job.status))) return Date.now() - k.requested_at.getTime() > GIVE_UP_MIN * 60_000 ? fail("The computer did not answer in time.") : "waiting";
        if (job.status === "timeout") return fail("The check took too long on the computer.");
        let products: Product[];
        try {
            products = parseBackupOutput(job.stdout ?? "");
        } catch (e) {
            if (!(e instanceof BackupOutputError)) throw e;
            return fail(e.message);
        }
        const orgId = k.org ?? (await this.orgs.getDefaultOrganizationId());
        const settings = await this.settings(orgId);
        await this.store(deviceId, products, settings);
        return "done";
    }

    private async store(deviceId: string, products: Product[], settings: Settings): Promise<void> {
        const verdict = judgeDevice(products, settings);
        await this.prisma.$transaction(async (tx) => {
            await tx.$executeRaw`DELETE FROM public.endpoint_backup_products WHERE device_id = ${deviceId}::uuid`;
            for (const p of products) {
                await tx.$executeRaw`INSERT INTO public.endpoint_backup_products (device_id, product, kind, state, last_success_at, last_attempt_at, detail)
                    VALUES (${deviceId}::uuid, ${p.product}, ${p.kind}, ${p.state}, ${p.lastSuccessAt}, ${p.lastAttemptAt}, ${p.detail})`;
            }
            await tx.$executeRaw`UPDATE public.endpoint_backup_checks SET status = 'done', checked_at = now(), message = NULL, overall = ${verdict.overall}, overall_detail = ${verdict.detail.slice(0, 600)},
                last_success_at = ${verdict.lastSuccessAt} WHERE device_id = ${deviceId}::uuid`;
        });
        await this.syncAlert(deviceId, verdict.overall, verdict.detail, settings).catch((e) => this.logger.warn(`Backup alert failed: ${(e as Error).message}`));
    }

    /** A computer with no backup at all, or whose backup is failing, is an alert; it clears when that is no longer so. */
    private async syncAlert(deviceId: string, overall: Overall, detail: string, settings: Settings): Promise<void> {
        const key = `backup:${deviceId}`;
        if (settings.alerts && (overall === "failed" || overall === "none")) {
            const name = (await this.prisma.devices.findUnique({ where: { id: deviceId }, select: { alias: true, hostname: true } })) ?? { alias: null, hostname: "this computer" };
            await this.alerts.raise({
                deviceId, kind: "backup", dedupeKey: key, severity: overall === "failed" ? "CRIT" : "WARN",
                title: overall === "failed" ? `Backup is failing on ${name.alias || name.hostname}` : `${name.alias || name.hostname} has no backup`, detail,
            });
        } else {
            await this.alerts.clear(key, "The backup is no longer a problem.");
        }
    }

    /** Works the verdicts out again from what the devices said (after the thresholds changed). */
    private async rejudge(orgId: string, settings: Settings): Promise<void> {
        const rows = await this.prisma.$queryRaw<Array<{ device_id: string }>>`
            SELECT k.device_id::text AS device_id FROM public.endpoint_backup_checks k JOIN public.devices d ON d.id = k.device_id JOIN public.sites s ON s.id = d.site_id JOIN public.clients c ON c.id = s.client_id
             WHERE c.organization_id = ${orgId}::uuid AND k.status = 'done'`;
        for (const r of rows) {
            const ps = await this.prisma.$queryRaw<Array<{ product: string; kind: string; state: string; last_success_at: Date | null; last_attempt_at: Date | null; detail: string | null }>>`
                SELECT product, kind, state, last_success_at, last_attempt_at, detail FROM public.endpoint_backup_products WHERE device_id = ${r.device_id}::uuid`;
            const products: Product[] = ps.map((p) => ({ product: p.product, kind: p.kind as ProductKind, state: p.state as ReportedState, lastSuccessAt: p.last_success_at, lastAttemptAt: p.last_attempt_at, detail: p.detail ?? "" }));
            const v = judgeDevice(products, settings);
            await this.prisma.$executeRaw`UPDATE public.endpoint_backup_checks SET overall = ${v.overall}, overall_detail = ${v.detail.slice(0, 600)}, last_success_at = ${v.lastSuccessAt} WHERE device_id = ${r.device_id}::uuid`;
            await this.syncAlert(r.device_id, v.overall, v.detail, settings).catch(() => undefined);
        }
    }

    /* ------------------------------ the customer's report ------------------------------ */

    /** The backup report of one customer (or all that a person may see): a summary and a line per computer. */
    async report(actor: Actor, clientId?: string) {
        const data = await this.list(actor, { clientId });
        const customer = clientId && isCanonicalUuid(clientId) ? data.items.find((i) => i.clientId === clientId)?.customer ?? null : null;
        const protectedCount = data.summary.ok;
        const checked = data.summary.total - data.summary.unchecked;
        return {
            generatedAt: new Date().toISOString(),
            customer,
            thresholds: { warnHours: data.settings.warnHours, failHours: data.settings.failHours },
            summary: { ...data.summary, checked, protectedPercent: checked ? Math.round((100 * protectedCount) / checked) : null },
            items: data.items.map((i) => ({
                customer: i.customer, site: i.site, computer: i.name, os: i.os, status: i.overall ?? "not checked", lastSuccessAt: i.lastSuccessAt, checkedAt: i.checkedAt, detail: i.detail,
                products: i.products.map((p) => p.product).join("; "), attention: i.overall ? needsAttention(i.overall) : false,
            })),
        };
    }

    static csv(report: Awaited<ReturnType<EndpointBackupsService["report"]>>): string {
        const q = (v: unknown) => {
            let s = String(v ?? "");
            // a cell that starts like a formula is made harmless for spreadsheets
            if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
            return `"${s.replace(/"/g, '""')}"`;
        };
        const head = ["Customer", "Site", "Computer", "System", "Backup status", "Last successful backup (UTC)", "Checked (UTC)", "Backup software", "Detail"];
        const lines = report.items.map((i) => [i.customer, i.site, i.computer, i.os, i.status, i.lastSuccessAt, i.checkedAt, i.products, i.detail].map(q).join(","));
        return [head.map(q).join(","), ...lines].join("\r\n") + "\r\n";
    }
}
