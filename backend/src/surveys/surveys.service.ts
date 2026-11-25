import { BadRequestException, ConflictException, GoneException, HttpException, HttpStatus, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { randomUUID } from "node:crypto";
import { isCanonicalUuid } from "../common/agent-lookup.util";
import { AuditService } from "../audit/audit.service";
import { PrismaService } from "../storage/prisma.service";
import { OrganizationContextService } from "../storage/organization-context.service";
import { SmtpService } from "../smtp/smtp.service";
import { EmailTemplatesService } from "../templates/email-templates.service";
import { WebhooksService } from "../webhooks/webhooks.service";
import type { PortalActor } from "../portal/portal-auth.service";
import { DEFAULT_SETTINGS, cleanComment, cleanScore, mergeSettings, ratingLinks, readSurveyToken, signSurveyToken, skipReason, type SurveySettings } from "./survey-core";

/** The worker looks every minute; the tests set SURVEY_WORK_MS to look sooner. */
const WORK_EVERY_MS = Math.max(500, Number(process.env.SURVEY_WORK_MS) || 60_000);
const SEND_BATCH = 25;
const SCAN_BATCH = 50;
/** A ticket whose status changed longer ago than this is not asked about (so turning surveys on never reaches far back). */
const LOOKBACK_DAYS = 30;
const MAX_ATTEMPTS = 5;
const INVALID = "This survey link is not valid.";

/** The public endpoints can be called by anyone with a link, so each address has a budget; wrong links cost more than right ones. */
const WINDOW_MS = 10 * 60_000;
const BUDGET = 60;
const INVALID_COST = 5;
const MAX_TRACKED = 20_000;

type Row = {
    id: string;
    organization_id: string;
    ticket_id: string;
    client_id: string | null;
    recipient_email: string;
    recipient_name: string;
    technician_user_id: string | null;
    status: string;
    expires_at: Date | null;
    sent_at: Date | null;
    answered_at: Date | null;
    score: number | null;
    comment: string | null;
    portal_link: boolean;
    attempts: number;
};

const nameOf = (first?: string | null, last?: string | null, email?: string | null) => `${first ?? ""} ${last ?? ""}`.trim() || email || "";

@Injectable()
export class SurveysService {
    private readonly logger = new Logger(SurveysService.name);
    private working = false;
    private readonly budget = new Map<string, { used: number; resetAt: number }>();

    constructor(
        private readonly prisma: PrismaService,
        private readonly orgs: OrganizationContextService,
        private readonly smtp: SmtpService,
        private readonly templates: EmailTemplatesService,
        private readonly webhooks: WebhooksService,
        private readonly audit: AuditService,
    ) { }

    /* -------------------------------- settings -------------------------------- */

    async getSettings(orgId: string): Promise<SurveySettings> {
        const r = await this.prisma.survey_settings.findUnique({ where: { organization_id: orgId } });
        if (!r) return { ...DEFAULT_SETTINGS };
        return {
            enabled: r.enabled,
            triggerStatuses: r.trigger_statuses,
            delayMinutes: r.delay_minutes,
            scope: r.scope === "selected" ? "selected" : "all",
            clientIds: r.client_ids,
            throttleDays: r.throttle_days,
            reminderEnabled: r.reminder_enabled,
            reminderAfterDays: r.reminder_after_days,
            expiryDays: r.expiry_days,
            scale: r.scale === "thumbs" ? "thumbs" : "stars",
            lowThreshold: r.low_threshold,
            alertUserIds: r.alert_user_ids,
            alertGroupIds: r.alert_group_ids,
        };
    }

    async saveSettings(orgId: string, input: Record<string, unknown>, userId: string | null): Promise<SurveySettings> {
        const cur = await this.getSettings(orgId);
        const next = mergeSettings(cur, input ?? {});
        // Only things that exist in this organization may be named.
        if (next.clientIds.length) {
            const n = await this.prisma.clients.count({ where: { organization_id: orgId, id: { in: next.clientIds } } });
            if (n !== next.clientIds.length) throw new BadRequestException("One of the customers does not exist.");
        }
        if (next.alertUserIds.length) {
            const n = await this.prisma.users.count({ where: { organization_id: orgId, id: { in: next.alertUserIds } } });
            if (n !== next.alertUserIds.length) throw new BadRequestException("One of the people does not exist.");
        }
        if (next.alertGroupIds.length) {
            const n = await this.prisma.user_groups.count({ where: { organization_id: orgId, id: { in: next.alertGroupIds } } });
            if (n !== next.alertGroupIds.length) throw new BadRequestException("One of the groups does not exist.");
        }
        const existing = await this.prisma.survey_settings.findUnique({ where: { organization_id: orgId }, select: { enabled: true, enabled_at: true } });
        // Tickets finished before surveys were switched on are never asked about.
        const enabledAt = next.enabled ? (existing?.enabled && existing.enabled_at ? existing.enabled_at : new Date()) : existing?.enabled_at ?? null;
        const data = {
            enabled: next.enabled,
            trigger_statuses: next.triggerStatuses,
            delay_minutes: next.delayMinutes,
            scope: next.scope,
            client_ids: next.clientIds,
            throttle_days: next.throttleDays,
            reminder_enabled: next.reminderEnabled,
            reminder_after_days: next.reminderAfterDays,
            expiry_days: next.expiryDays,
            scale: next.scale,
            low_threshold: next.lowThreshold,
            alert_user_ids: next.alertUserIds,
            alert_group_ids: next.alertGroupIds,
            enabled_at: enabledAt,
            updated_by: userId,
            updated_at: new Date(),
        };
        await this.prisma.survey_settings.upsert({ where: { organization_id: orgId }, create: { organization_id: orgId, ...data }, update: data });
        return next;
    }

    /** For the pickers on the settings screen. */
    async options(orgId: string) {
        const [clients, users, groups] = await Promise.all([
            this.prisma.clients.findMany({ where: { organization_id: orgId }, select: { id: true, name: true }, orderBy: { name: "asc" }, take: 1000 }),
            this.prisma.users.findMany({ where: { organization_id: orgId, status: "active" }, select: { id: true, first_name: true, last_name: true, email: true }, orderBy: { email: "asc" }, take: 500 }),
            this.prisma.user_groups.findMany({ where: { organization_id: orgId }, select: { id: true, name: true }, orderBy: { name: "asc" }, take: 200 }),
        ]);
        return { clients, users: users.map((u) => ({ id: u.id, name: nameOf(u.first_name, u.last_name, u.email), email: u.email })), groups };
    }

    /* --------------------------------- worker --------------------------------- */

    @Interval(WORK_EVERY_MS)
    async work(): Promise<void> {
        if (this.working) return;
        this.working = true;
        try {
            const all = await this.prisma.survey_settings.findMany({ where: { enabled: true }, select: { organization_id: true } });
            for (const o of all) await this.scan(o.organization_id).catch((e) => this.logger.warn(`Survey scan failed: ${e?.code ?? e?.name}`));
            await this.sendDue();
            await this.remind();
            await this.prisma.ticket_surveys.updateMany({ where: { status: "sent", expires_at: { lt: new Date() } }, data: { status: "expired" } });
        } catch (e: any) {
            this.logger.warn(`Survey work failed: ${e?.code ?? e?.name}`);
        } finally {
            this.working = false;
        }
    }

    /** Finds finished tickets with no survey yet and decides, once, whether each gets one. Exposed for tests. */
    async scan(orgId: string): Promise<number> {
        const s = await this.getSettings(orgId);
        const meta = await this.prisma.survey_settings.findUnique({ where: { organization_id: orgId }, select: { enabled_at: true } });
        if (!s.enabled || !meta?.enabled_at) return 0;
        const rows = await this.prisma.$queryRaw<{ id: string; client_id: string | null; tech: string | null; pa_id: string | null; triggered_at: Date; email: string | null; name: string | null }[]>`
            SELECT t.id::text AS id, t.client_id::text AS client_id, t.assignee_user_id::text AS tech, t.portal_account_id::text AS pa_id,
                   COALESCE(trig.at, t.closed_at) AS triggered_at,
                   COALESCE(pa.email::text, c.email::text) AS email, COALESCE(pa.name, c.name) AS name
              FROM tickets t
              LEFT JOIN LATERAL (SELECT max(a.created_at) AS at FROM ticket_activity a
                                  WHERE a.ticket_id = t.id AND a.kind = 'change' AND a.field = 'status' AND a.to_value = ANY(${s.triggerStatuses}::text[])) trig ON true
              LEFT JOIN portal_accounts pa ON pa.id = t.portal_account_id
              LEFT JOIN contacts c ON c.id = t.requester_contact_id
             WHERE t.organization_id = ${orgId}::uuid
               AND t.status::text = ANY(${s.triggerStatuses}::text[])
               AND NOT EXISTS (SELECT 1 FROM ticket_surveys x WHERE x.ticket_id = t.id)
               AND COALESCE(trig.at, t.closed_at) >= ${meta.enabled_at}
               AND COALESCE(trig.at, t.closed_at) >= now() - (${LOOKBACK_DAYS} * interval '1 day')
               AND COALESCE(trig.at, t.closed_at) <= now() - (${s.delayMinutes} * interval '1 minute')
             ORDER BY 5 LIMIT ${SCAN_BATCH}`;
        let made = 0;
        for (const r of rows) {
            const email = (r.email ?? "").trim().toLowerCase() || null;
            let recentlyAsked = false;
            if (email && s.throttleDays > 0) {
                const n = await this.prisma.$queryRaw<{ n: number }[]>`
                    SELECT count(*)::int AS n FROM ticket_surveys
                     WHERE organization_id = ${orgId}::uuid AND lower(recipient_email) = ${email} AND status IN ('pending', 'sent', 'answered', 'expired')
                       AND COALESCE(sent_at, created_at) > now() - (${s.throttleDays} * interval '1 day')`;
                recentlyAsked = (n[0]?.n ?? 0) > 0;
            }
            const reason = skipReason(s, { email, clientId: r.client_id, recentlyAsked });
            let portal = !!r.pa_id;
            if (!portal && email && !reason) portal = !!(await this.prisma.portal_accounts.findFirst({ where: { email, ...(r.client_id ? { client_id: r.client_id } : {}) }, select: { id: true } }));
            const res = await this.prisma.ticket_surveys.createMany({
                skipDuplicates: true,
                data: [{
                    id: randomUUID(), organization_id: orgId, ticket_id: r.id, client_id: r.client_id, recipient_email: email ?? "", recipient_name: (r.name ?? "").slice(0, 200),
                    technician_user_id: r.tech, status: reason ? "skipped" : "pending", skip_reason: reason, portal_link: portal, triggered_at: r.triggered_at,
                }],
            });
            made += res.count;
        }
        return made;
    }

    /** Sends the surveys that are due, taking each so a second worker would not send it again. */
    async sendDue(): Promise<number> {
        const claimed = await this.prisma.$queryRaw<{ id: string }[]>`
            UPDATE ticket_surveys SET next_attempt_at = now() + interval '10 minutes'
             WHERE id IN (SELECT id FROM ticket_surveys WHERE status = 'pending' AND next_attempt_at <= now() ORDER BY next_attempt_at LIMIT ${SEND_BATCH} FOR UPDATE SKIP LOCKED)
            RETURNING id::text AS id`;
        for (const c of claimed) await this.sendOne(c.id).catch((e) => this.logger.warn(`Survey send failed: ${e?.code ?? e?.name}`));
        return claimed.length;
    }

    private async base(portal: boolean): Promise<string | null> {
        if (portal) {
            const p = await this.prisma.portal_settings.findFirst({ where: { enabled: true, domain: { not: null } }, select: { domain: true } });
            if (p?.domain) return `https://${p.domain}`;
        }
        const env = (process.env.PUBLIC_CONSOLE_URL || String(process.env.FRONTEND_ORIGINS || "").split(",")[0] || "").trim().replace(/\/+$/, "");
        return env || null;
    }

    private async company(): Promise<string> {
        const r = await this.prisma.$queryRaw<{ name: string | null }[]>`SELECT name FROM organizations LIMIT 1`.catch(() => []);
        return String(r[0]?.name ?? "").trim();
    }

    private async compose(row: Row, s: SurveySettings, expiresAt: Date, reminder: boolean) {
        const base = await this.base(row.portal_link);
        if (!base) throw new Error("The address of the console is not set (PUBLIC_CONSOLE_URL), so a survey link cannot be made.");
        const t = await this.prisma.tickets.findUnique({ where: { id: row.ticket_id }, select: { ticket_number: true, subject: true } });
        const tech = row.technician_user_id ? await this.prisma.users.findUnique({ where: { id: row.technician_user_id }, select: { first_name: true, last_name: true, email: true } }) : null;
        const token = signSurveyToken(row.id, expiresAt);
        const company = await this.company();
        const mail = await this.templates.render("survey_request", {
            name: row.recipient_name || "there",
            company: company || "Your IT provider",
            company_prefix: company ? `${company}: ` : "",
            ticket_number: String(t?.ticket_number ?? ""),
            ticket_subject: String(t?.subject ?? ""),
            technician: tech ? nameOf(tech.first_name, tech.last_name, tech.email) : "",
            link: `${base}/survey?t=${token}`,
            rating_links: ratingLinks(base, token, s.scale),
            valid_days: String(Math.max(1, Math.ceil((expiresAt.getTime() - Date.now()) / 86_400_000))),
        }, row.organization_id);
        return { subject: reminder ? `Reminder: ${mail.subject}` : mail.subject, body: mail.body };
    }

    private async load(id: string): Promise<Row | null> {
        return (await this.prisma.ticket_surveys.findUnique({ where: { id } })) as Row | null;
    }

    private async sendOne(id: string, reminder = false): Promise<void> {
        const row = await this.load(id);
        if (!row || (!reminder && row.status !== "pending")) return;
        const s = await this.getSettings(row.organization_id);
        const ticket = await this.prisma.tickets.findUnique({ where: { id: row.ticket_id }, select: { status: true } });
        if (!reminder) {
            const stop = !s.enabled ? "turned_off" : !ticket || !s.triggerStatuses.includes(String(ticket.status)) ? "ticket_reopened" : null;
            if (stop) {
                await this.prisma.ticket_surveys.updateMany({ where: { id, status: "pending" }, data: { status: "skipped", skip_reason: stop } });
                return;
            }
        }
        const expiresAt = reminder && row.expires_at ? row.expires_at : new Date(Date.now() + s.expiryDays * 86_400_000);
        let error: string | null = null;
        try {
            const mail = await this.compose(row, s, expiresAt, reminder);
            const res = await this.smtp.sendPlain("tickets", row.recipient_email, mail.subject, mail.body);
            if (!res.ok) error = res.result;
        } catch (e: any) {
            error = String(e?.message ?? "Could not send");
        }
        if (reminder) return;
        if (!error) {
            await this.prisma.ticket_surveys.updateMany({ where: { id, status: "pending" }, data: { status: "sent", sent_at: new Date(), expires_at: expiresAt, attempts: row.attempts + 1, last_error: null } });
            return;
        }
        const attempts = row.attempts + 1;
        await this.prisma.ticket_surveys.updateMany({
            where: { id, status: "pending" },
            data: attempts >= MAX_ATTEMPTS
                ? { status: "failed", attempts, last_error: error.slice(0, 500) }
                : { attempts, last_error: error.slice(0, 500), next_attempt_at: new Date(Date.now() + attempts * 15 * 60_000) },
        });
    }

    /** One reminder, once, to people who have not answered. */
    async remind(): Promise<number> {
        let n = 0;
        const orgs = await this.prisma.survey_settings.findMany({ where: { enabled: true, reminder_enabled: true } });
        for (const o of orgs) {
            const claimed = await this.prisma.$queryRaw<{ id: string }[]>`
                UPDATE ticket_surveys SET reminded_at = now()
                 WHERE id IN (SELECT id FROM ticket_surveys WHERE organization_id = ${o.organization_id}::uuid AND status = 'sent' AND reminded_at IS NULL
                                 AND sent_at <= now() - (${o.reminder_after_days} * interval '1 day') AND expires_at > now() + interval '1 hour'
                               LIMIT ${SEND_BATCH} FOR UPDATE SKIP LOCKED)
                RETURNING id::text AS id`;
            for (const c of claimed) {
                await this.sendOne(c.id, true).catch(() => undefined);
                n++;
            }
        }
        return n;
    }

    /* ---------------------------- the public link ---------------------------- */

    /** Counts a call against the address's budget, and refuses when it is spent. */
    spend(ip: string, cost = 1): void {
        const now = Date.now();
        let e = this.budget.get(ip);
        if (!e || e.resetAt <= now) {
            if (this.budget.size >= MAX_TRACKED) this.budget.clear();
            e = { used: 0, resetAt: now + WINDOW_MS };
            this.budget.set(ip, e);
        }
        if (e.used >= BUDGET) throw new HttpException("Too many requests. Try again later.", HttpStatus.TOO_MANY_REQUESTS);
        e.used += cost;
    }

    /** A link that was not made by this server, or that names nothing, all look the same from outside. */
    private async byToken(token: unknown, ip: string): Promise<{ row: Row; expired: boolean }> {
        const t = readSurveyToken(token);
        const row = t.ok ? await this.load(t.id) : null;
        if (!t.ok || !row || (row.status !== "sent" && row.status !== "answered" && row.status !== "expired")) {
            this.spend(ip, INVALID_COST - 1);
            throw new NotFoundException(INVALID);
        }
        return { row, expired: t.expired || row.status === "expired" || (!!row.expires_at && row.expires_at.getTime() <= Date.now()) };
    }

    private async viewFor(row: Row, expired: boolean) {
        const [s, t] = await Promise.all([this.getSettings(row.organization_id), this.prisma.tickets.findUnique({ where: { id: row.ticket_id }, select: { ticket_number: true, subject: true } })]);
        const company = await this.company();
        const state = row.status === "answered" ? "answered" : expired ? "expired" : "open";
        return { state, company, scale: s.scale, ticketNumber: t ? Number(t.ticket_number) : null, subject: state === "open" ? (t?.subject ?? "") : "" };
    }

    /** What the survey page shows. Opening it records nothing: mail scanners open links, so a rating needs a deliberate answer. */
    async describe(token: unknown, ip: string) {
        this.spend(ip);
        const { row, expired } = await this.byToken(token, ip);
        return this.viewFor(row, expired);
    }

    async answerByLink(token: unknown, body: { score?: unknown; comment?: unknown }, ip: string, req: unknown) {
        this.spend(ip);
        const { row, expired } = await this.byToken(token, ip);
        if (row.status === "answered") throw new ConflictException("This survey has already been answered. Thank you.");
        if (expired) throw new GoneException("This survey link has expired.");
        const s = await this.getSettings(row.organization_id);
        await this.record(row, s, cleanScore(body?.score, s.scale), cleanComment(body?.comment), "link", req);
        return { ok: true };
    }

    /** The one place an answer is saved: only a sent, unexpired survey that nobody has answered, and only once. */
    private async record(row: Row, s: SurveySettings, score: number, comment: string | null, via: "link" | "portal", req: unknown) {
        const res = await this.prisma.ticket_surveys.updateMany({
            where: { id: row.id, status: "sent", expires_at: { gt: new Date() } },
            data: { status: "answered", score, comment, answered_at: new Date(), answered_via: via },
        });
        if (res.count !== 1) throw new ConflictException("This survey has already been answered, or has expired.");
        void this.audit.record({ action: "survey.response", category: "ticket", outcome: "success", targetType: "ticket", targetId: row.ticket_id, actorEmail: row.recipient_email, details: { score, via, hasComment: !!comment }, req: req as never }).catch(() => undefined);
        if (score <= s.lowThreshold) void this.alertLow(row.id).catch((e) => this.logger.warn(`Low score alert failed: ${e?.code ?? e?.name}`));
    }

    /* --------------------------------- alerts --------------------------------- */

    private async alertLow(id: string): Promise<void> {
        const row = await this.load(id);
        if (!row || row.score === null) return;
        const claim = await this.prisma.ticket_surveys.updateMany({ where: { id, low_alerted_at: null }, data: { low_alerted_at: new Date() } });
        if (claim.count !== 1) return;
        const s = await this.getSettings(row.organization_id);
        const [t, tech, client] = await Promise.all([
            this.prisma.tickets.findUnique({ where: { id: row.ticket_id }, select: { ticket_number: true, subject: true } }),
            row.technician_user_id ? this.prisma.users.findUnique({ where: { id: row.technician_user_id }, select: { first_name: true, last_name: true, email: true } }) : null,
            row.client_id ? this.prisma.clients.findUnique({ where: { id: row.client_id }, select: { name: true } }) : null,
        ]);
        const technician = tech ? nameOf(tech.first_name, tech.last_name, tech.email) : "";
        const consoleBase = (process.env.PUBLIC_CONSOLE_URL || "").replace(/\/+$/, "");
        await this.webhooks.emit("ticket.survey_low", {
            ticket: { id: row.ticket_id, number: t ? Number(t.ticket_number) : null, subject: t?.subject ?? "", customer: client?.name ?? null, technician: technician || null, url: consoleBase ? `${consoleBase}/tickets/${row.ticket_id}` : null },
            survey: { score: row.score, comment: row.comment, requester: row.recipient_name || row.recipient_email, answeredAt: row.answered_at?.toISOString() ?? null },
        }, row.organization_id);

        const ids = new Set(s.alertUserIds);
        if (s.alertGroupIds.length) {
            const m = await this.prisma.user_group_members.findMany({ where: { group_id: { in: s.alertGroupIds } }, select: { user_id: true } });
            m.forEach((x) => ids.add(x.user_id));
        }
        if (!ids.size) return;
        const people = await this.prisma.users.findMany({ where: { id: { in: [...ids] }, status: "active" }, select: { email: true } });
        const mail = await this.templates.render("survey_low_score", {
            score: String(row.score),
            customer: client?.name ?? "",
            customer_line: client?.name ? `Customer: ${client.name}` : "",
            requester: row.recipient_name || row.recipient_email,
            ticket_number: String(t?.ticket_number ?? ""),
            ticket_subject: String(t?.subject ?? ""),
            technician,
            comment: row.comment ?? "",
            link_line: consoleBase ? `Open the ticket: ${consoleBase}/tickets/${row.ticket_id}` : "",
        }, row.organization_id);
        for (const p of people) await this.smtp.sendPlain("alerts", String(p.email), mail.subject, mail.body).catch(() => undefined);
    }

    /* ------------------------------ staff and portal ------------------------------ */

    private presentForStaff(r: Row & { skip_reason: string | null; reminded_at: Date | null; last_error: string | null; answered_via: string | null }) {
        return {
            status: r.status,
            skipReason: r.skip_reason,
            recipient: r.recipient_email || null,
            recipientName: r.recipient_name || null,
            sentAt: r.sent_at?.toISOString() ?? null,
            remindedAt: r.reminded_at?.toISOString() ?? null,
            expiresAt: r.expires_at?.toISOString() ?? null,
            answeredAt: r.answered_at?.toISOString() ?? null,
            answeredVia: r.answered_via,
            score: r.score,
            comment: r.comment,
            lastError: r.status === "pending" || r.status === "failed" ? r.last_error : null,
        };
    }

    /** The survey of one ticket, for its page. */
    async forTicket(orgId: string, ticketId: string) {
        if (!isCanonicalUuid(ticketId)) throw new NotFoundException("Ticket not found");
        const t = await this.prisma.tickets.findFirst({ where: { id: ticketId, organization_id: orgId }, select: { id: true } });
        if (!t) throw new NotFoundException("Ticket not found");
        const r = await this.prisma.ticket_surveys.findUnique({ where: { ticket_id: ticketId } });
        return r ? this.presentForStaff(r as never) : null;
    }

    /** The portal person's ticket, or nothing: the same limits as the portal ticket list. */
    private async portalRow(actor: PortalActor, ticketId: string): Promise<Row> {
        if (!isCanonicalUuid(ticketId)) throw new NotFoundException("Ticket not found");
        const r = await this.prisma.$queryRaw<{ id: string }[]>`
            SELECT s.id::text AS id FROM ticket_surveys s JOIN tickets t ON t.id = s.ticket_id
             WHERE s.ticket_id = ${ticketId}::uuid AND t.client_id = ${actor.clientId}::uuid AND s.status IN ('sent', 'answered')
               AND (${actor.role === "manager"} OR t.portal_account_id = ${actor.accountId}::uuid)`;
        const row = r[0] ? await this.load(r[0].id) : null;
        if (!row) throw new NotFoundException("No survey for this ticket.");
        return row;
    }

    async portalGet(actor: PortalActor, ticketId: string) {
        try {
            const row = await this.portalRow(actor, ticketId);
            const expired = !!row.expires_at && row.expires_at.getTime() <= Date.now();
            const v = await this.viewFor(row, expired);
            return { available: true, state: v.state, scale: v.scale, score: v.state === "answered" ? row.score : null };
        } catch (e) {
            if (e instanceof NotFoundException) return { available: false };
            throw e;
        }
    }

    async portalAnswer(actor: PortalActor, ticketId: string, body: { score?: unknown; comment?: unknown }, req: unknown) {
        const row = await this.portalRow(actor, ticketId);
        const s = await this.getSettings(row.organization_id);
        await this.record(row, s, cleanScore(body?.score, s.scale), cleanComment(body?.comment), "portal", req);
        return { ok: true };
    }

    /* --------------------------------- results --------------------------------- */

    async summary(orgId: string, daysIn: unknown) {
        const days = Math.min(365, Math.max(1, Math.trunc(Number(daysIn)) || 90));
        const since = new Date(Date.now() - days * 86_400_000);
        const s = await this.getSettings(orgId);
        const [t] = await this.prisma.$queryRaw<any[]>`
            SELECT count(*) FILTER (WHERE status IN ('sent', 'answered', 'expired'))::int AS sent,
                   count(*) FILTER (WHERE status = 'answered')::int AS answered,
                   avg(score) FILTER (WHERE status = 'answered')::float AS average,
                   count(*) FILTER (WHERE status = 'answered' AND score >= 4)::int AS positive,
                   count(*) FILTER (WHERE status = 'answered' AND score <= ${s.lowThreshold})::int AS low,
                   count(*) FILTER (WHERE status = 'answered' AND score = 1)::int AS s1, count(*) FILTER (WHERE status = 'answered' AND score = 2)::int AS s2,
                   count(*) FILTER (WHERE status = 'answered' AND score = 3)::int AS s3, count(*) FILTER (WHERE status = 'answered' AND score = 4)::int AS s4,
                   count(*) FILTER (WHERE status = 'answered' AND score = 5)::int AS s5,
                   count(*) FILTER (WHERE status = 'pending')::int AS waiting, count(*) FILTER (WHERE status = 'failed')::int AS failed,
                   count(*) FILTER (WHERE status = 'skipped' AND skip_reason = 'throttled')::int AS throttled
              FROM ticket_surveys WHERE organization_id = ${orgId}::uuid AND COALESCE(sent_at, created_at) >= ${since}`;
        const group = async (by: "tech" | "client") => {
            const rows = by === "tech"
                ? await this.prisma.$queryRaw<any[]>`
                    SELECT s.technician_user_id::text AS id, COALESCE(NULLIF(trim(concat_ws(' ', u.first_name, u.last_name)), ''), u.email::text, 'Unassigned') AS name,
                           count(*) FILTER (WHERE s.status IN ('sent', 'answered', 'expired'))::int AS sent, count(*) FILTER (WHERE s.status = 'answered')::int AS answered,
                           avg(s.score) FILTER (WHERE s.status = 'answered')::float AS average, count(*) FILTER (WHERE s.status = 'answered' AND s.score <= ${s.lowThreshold})::int AS low
                      FROM ticket_surveys s LEFT JOIN users u ON u.id = s.technician_user_id
                     WHERE s.organization_id = ${orgId}::uuid AND s.status IN ('sent', 'answered', 'expired') AND COALESCE(s.sent_at, s.created_at) >= ${since}
                     GROUP BY 1, 2 ORDER BY average DESC NULLS LAST, sent DESC LIMIT 100`
                : await this.prisma.$queryRaw<any[]>`
                    SELECT s.client_id::text AS id, COALESCE(c.name, 'No customer') AS name,
                           count(*) FILTER (WHERE s.status IN ('sent', 'answered', 'expired'))::int AS sent, count(*) FILTER (WHERE s.status = 'answered')::int AS answered,
                           avg(s.score) FILTER (WHERE s.status = 'answered')::float AS average, count(*) FILTER (WHERE s.status = 'answered' AND s.score <= ${s.lowThreshold})::int AS low
                      FROM ticket_surveys s LEFT JOIN clients c ON c.id = s.client_id
                     WHERE s.organization_id = ${orgId}::uuid AND s.status IN ('sent', 'answered', 'expired') AND COALESCE(s.sent_at, s.created_at) >= ${since}
                     GROUP BY 1, 2 ORDER BY average DESC NULLS LAST, sent DESC LIMIT 100`;
            return rows.map((r) => ({ id: r.id, name: r.name, sent: r.sent, answered: r.answered, responseRate: r.sent ? r.answered / r.sent : null, average: r.average, low: r.low }));
        };
        const recent = async (low: boolean) => {
            const rows = await this.prisma.$queryRaw<any[]>`
                SELECT s.id::text AS id, s.ticket_id::text AS ticket_id, t.ticket_number::int AS number, t.subject, s.score, s.comment, s.answered_at,
                       COALESCE(NULLIF(s.recipient_name, ''), s.recipient_email) AS requester, c.name AS customer,
                       COALESCE(NULLIF(trim(concat_ws(' ', u.first_name, u.last_name)), ''), u.email::text) AS technician
                  FROM ticket_surveys s JOIN tickets t ON t.id = s.ticket_id LEFT JOIN clients c ON c.id = s.client_id LEFT JOIN users u ON u.id = s.technician_user_id
                 WHERE s.organization_id = ${orgId}::uuid AND s.status = 'answered' AND s.answered_at >= ${since}
                   AND (${low}::boolean = false OR s.score <= ${s.lowThreshold}) AND (${low}::boolean = true OR (s.comment IS NOT NULL AND s.comment <> ''))
                 ORDER BY s.answered_at DESC LIMIT 25`;
            return rows.map((r) => ({ id: r.id, ticketId: r.ticket_id, number: r.number, subject: r.subject, score: r.score, comment: r.comment, answeredAt: r.answered_at.toISOString(), requester: r.requester, customer: r.customer, technician: r.technician }));
        };
        return {
            days,
            scale: s.scale,
            lowThreshold: s.lowThreshold,
            sent: t.sent,
            answered: t.answered,
            responseRate: t.sent ? t.answered / t.sent : null,
            average: t.average,
            satisfied: t.answered ? t.positive / t.answered : null,
            low: t.low,
            distribution: [1, 2, 3, 4, 5].map((n) => ({ score: n, count: t[`s${n}`] })),
            waiting: t.waiting,
            failed: t.failed,
            throttled: t.throttled,
            byTechnician: await group("tech"),
            byCustomer: await group("client"),
            comments: await recent(false),
            lowScores: await recent(true),
        };
    }
}
