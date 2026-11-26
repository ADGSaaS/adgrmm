import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { randomBytes, randomUUID } from "node:crypto";
import { isCanonicalUuid } from "../common/agent-lookup.util";
import { decryptSecret, encryptSecret } from "../common/secret-box";
import { PrismaService } from "../storage/prisma.service";
import { OrganizationContextService } from "../storage/organization-context.service";
import { assertSafeWebhookUrl } from "../notifications/notifications.service";
import { safePost } from "../common/ssrf-guard";
import { MAX_ENDPOINTS, WEBHOOK_EVENTS, cleanEvents, cleanFormat, cleanName, cleanUrl, retryDelay, sign } from "./webhook-core";
import { chatBody, formatFor } from "./webhook-chat";

const WORK_EVERY_MS = 10_000;
const BATCH = 25;
const TIMEOUT_MS = 10_000;
const KEEP_DAYS = 30;

type Input = { name?: unknown; url?: unknown; events?: unknown; enabled?: unknown; rotateSecret?: unknown; format?: unknown };

type EndpointRow = { id: string; name: string; url: string; events: string[]; format: string; enabled: boolean; created_at: Date; updated_at: Date };

const present = (r: EndpointRow) => ({ id: r.id, name: r.name, url: r.url, events: r.events, format: r.format, sends: formatFor(r.url, r.format), enabled: r.enabled, createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString() });

const newSecret = () => `whsec_${randomBytes(32).toString("base64url")}`;

/** Outbound webhooks: signed copies of chosen events sent to addresses an administrator gives, with retries and a log. */
@Injectable()
export class WebhooksService {
    private readonly logger = new Logger(WebhooksService.name);
    private working = false;
    private lastPrune = 0;

    constructor(private readonly prisma: PrismaService, private readonly orgs: OrganizationContextService) { }

    /* ------------------------------ endpoints ------------------------------ */

    async list(orgId: string) {
        const rows = await this.prisma.webhook_endpoints.findMany({ where: { organization_id: orgId }, orderBy: { created_at: "asc" } });
        const since = new Date(Date.now() - 24 * 3_600_000);
        const out: Record<string, unknown>[] = [];
        for (const r of rows) {
            const last = await this.prisma.webhook_deliveries.findFirst({
                where: { endpoint_id: r.id, status: { in: ["delivered", "failed"] } },
                orderBy: { created_at: "desc" },
                select: { status: true, created_at: true, response_status: true, last_error: true, event: true },
            });
            const [pending, failed, delivered] = await Promise.all([
                this.prisma.webhook_deliveries.count({ where: { endpoint_id: r.id, status: "pending" } }),
                this.prisma.webhook_deliveries.count({ where: { endpoint_id: r.id, status: "failed", created_at: { gte: since } } }),
                this.prisma.webhook_deliveries.count({ where: { endpoint_id: r.id, status: "delivered", created_at: { gte: since } } }),
            ]);
            out.push({
                ...present(r),
                last: last ? { status: last.status, event: last.event, at: last.created_at.toISOString(), responseStatus: last.response_status, error: last.last_error } : null,
                pending,
                failedLast24h: failed,
                deliveredLast24h: delivered,
            });
        }
        return { items: out, events: WEBHOOK_EVENTS };
    }

    /** The signing secret is shown here, once. */
    async create(orgId: string, input: Input, userId: string | null) {
        const name = cleanName(input.name);
        const url = cleanUrl(input.url);
        const events = cleanEvents(input.events);
        const format = cleanFormat(input.format);
        await assertSafeWebhookUrl(url).catch((e) => { throw new BadRequestException(e.message); });
        if ((await this.prisma.webhook_endpoints.count({ where: { organization_id: orgId } })) >= MAX_ENDPOINTS) throw new BadRequestException(`There can be ${MAX_ENDPOINTS} webhooks at most.`);
        const secret = newSecret();
        try {
            const r = await this.prisma.webhook_endpoints.create({
                data: { organization_id: orgId, name, url, events, format, secret: encryptSecret(secret), enabled: input.enabled !== false, created_by: userId },
            });
            return { ...present(r), signingSecret: secret };
        } catch (e: any) {
            if (e?.code === "P2002" || e?.code === "P2010") throw new BadRequestException("There is already a webhook with that name.");
            throw e;
        }
    }

    private async find(orgId: string, id: string) {
        if (!isCanonicalUuid(id)) throw new NotFoundException("Webhook not found");
        const r = await this.prisma.webhook_endpoints.findFirst({ where: { id, organization_id: orgId } });
        if (!r) throw new NotFoundException("Webhook not found");
        return r;
    }

    async update(orgId: string, id: string, input: Input) {
        await this.find(orgId, id);
        const data: { name?: string; url?: string; events?: string[]; format?: string; enabled?: boolean; secret?: string; updated_at: Date } = { updated_at: new Date() };
        if (input.name !== undefined) data.name = cleanName(input.name);
        if (input.url !== undefined) {
            data.url = cleanUrl(input.url);
            await assertSafeWebhookUrl(data.url).catch((e) => { throw new BadRequestException(e.message); });
        }
        if (input.events !== undefined) data.events = cleanEvents(input.events);
        if (input.format !== undefined) data.format = cleanFormat(input.format);
        if (input.enabled !== undefined) data.enabled = input.enabled === true;
        let signingSecret: string | undefined;
        if (input.rotateSecret === true) {
            signingSecret = newSecret();
            data.secret = encryptSecret(signingSecret);
        }
        try {
            const r = await this.prisma.webhook_endpoints.update({ where: { id }, data });
            return { ...present(r), ...(signingSecret ? { signingSecret } : {}) };
        } catch (e: any) {
            if (e?.code === "P2002" || e?.code === "P2010") throw new BadRequestException("There is already a webhook with that name.");
            throw e;
        }
    }

    async remove(orgId: string, id: string) {
        await this.find(orgId, id);
        await this.prisma.webhook_endpoints.delete({ where: { id } });
        return { ok: true };
    }

    async deliveries(orgId: string, id: string) {
        await this.find(orgId, id);
        const rows = await this.prisma.webhook_deliveries.findMany({ where: { endpoint_id: id }, orderBy: { created_at: "desc" }, take: 50 });
        return {
            items: rows.map((d) => ({
                id: d.id,
                event: d.event,
                status: d.status,
                attempts: d.attempts,
                responseStatus: d.response_status,
                error: d.last_error,
                createdAt: d.created_at.toISOString(),
                deliveredAt: d.delivered_at ? d.delivered_at.toISOString() : null,
                nextAttemptAt: d.status === "pending" ? d.next_attempt_at.toISOString() : null,
            })),
        };
    }

    /** Sends a sample event now, so the address and secret can be checked. It is logged like any delivery, and not retried. */
    async test(orgId: string, id: string) {
        const ep = await this.find(orgId, id);
        const payload = this.envelope("webhook.test", { message: "This is a test from ADG RMM.", webhook: ep.name });
        const row = await this.prisma.webhook_deliveries.create({ data: { endpoint_id: ep.id, event: "webhook.test", payload: payload as object, status: "pending", attempts: 0, next_attempt_at: new Date(Date.now() + 3_600_000) } });
        const result = await this.deliver(ep, row.id, "webhook.test", payload, 1);
        return { ok: result.ok, status: result.status ?? null, message: result.ok ? `The address answered with status ${result.status}.` : result.error };
    }

    /* ------------------------------ events ------------------------------ */

    private envelope(event: string, data: unknown) {
        return { id: randomUUID(), event, createdAt: new Date().toISOString(), data };
    }

    /** Queues an event for every enabled webhook that wants it. It never fails the thing that happened. */
    async emit(event: string, data: unknown, orgId?: string): Promise<void> {
        try {
            const org = orgId ?? (await this.orgs.getDefaultOrganizationId());
            const endpoints = await this.prisma.webhook_endpoints.findMany({ where: { organization_id: org, enabled: true, events: { has: event } }, select: { id: true } });
            if (!endpoints.length) return;
            const payload = this.envelope(event, data);
            await this.prisma.webhook_deliveries.createMany({ data: endpoints.map((e) => ({ endpoint_id: e.id, event, payload: payload as object })) });
        } catch (err) {
            this.logger.warn(`Could not queue the ${event} webhook: ${(err as Error).message}`);
        }
    }

    private consoleUrl(path: string): string | null {
        const base = (process.env.PUBLIC_CONSOLE_URL || "").replace(/\/+$/, "");
        return base ? `${base}${path}` : null;
    }

    /** A ticket event: what the ticket is now, and for an update which things changed. */
    async emitTicket(event: "ticket.created" | "ticket.updated" | "ticket.sla_warning" | "ticket.sla_breached", ticketId: string, extra: Record<string, unknown> = {}, orgId?: string): Promise<void> {
        try {
            const t = await this.prisma.tickets.findUnique({
                where: { id: ticketId },
                select: { id: true, organization_id: true, ticket_number: true, subject: true, status: true, priority: true, client_id: true, assignee_user_id: true, device_id: true, created_at: true },
            });
            if (!t) return;
            const client = t.client_id ? await this.prisma.clients.findUnique({ where: { id: t.client_id }, select: { name: true } }) : null;
            await this.emit(event, {
                ticket: {
                    id: t.id,
                    number: Number(t.ticket_number),
                    subject: t.subject,
                    status: t.status,
                    priority: t.priority === "normal" ? "medium" : t.priority,
                    customerId: t.client_id,
                    customer: client?.name ?? null,
                    assigneeUserId: t.assignee_user_id,
                    deviceId: t.device_id,
                    createdAt: t.created_at.toISOString(),
                    url: this.consoleUrl(`/tickets/${t.id}`),
                },
                ...extra,
            }, orgId ?? t.organization_id);
        } catch (err) {
            this.logger.warn(`Could not queue the ${event} webhook: ${(err as Error).message}`);
        }
    }

    /** An alert event. A device-offline alert that opens is also a device.offline event. */
    async emitForAlert(alertId: string, event: string): Promise<void> {
        if (event !== "opened" && event !== "resolved") return;
        try {
            const a = await this.prisma.alerts.findUnique({
                where: { id: alertId },
                include: { devices: { select: { id: true, hostname: true, alias: true, sites: { select: { name: true, clients: { select: { name: true } } } } } } },
            });
            if (!a) return;
            const device = { id: a.devices.id, name: a.devices.alias || a.devices.hostname, customer: a.devices.sites?.clients?.name ?? null, site: a.devices.sites?.name ?? null };
            const alert = { id: a.id, kind: a.kind, title: a.title, detail: a.detail, severity: a.severity, state: a.state, firstSeenAt: a.first_seen_at.toISOString(), resolvedAt: a.resolved_at ? a.resolved_at.toISOString() : null, url: this.consoleUrl("/alerts") };
            await this.emit(event === "opened" ? "alert.opened" : "alert.resolved", { alert, device, url: this.consoleUrl(`/devices/${device.id}`) });
            if (event === "opened" && a.kind === "offline") await this.emit("device.offline", { device, alert: { id: a.id, title: a.title, firstSeenAt: alert.firstSeenAt }, url: this.consoleUrl(`/devices/${device.id}`) });
        } catch (err) {
            this.logger.warn(`Could not queue the alert webhook: ${(err as Error).message}`);
        }
    }

    /* ------------------------------ delivery ------------------------------ */

    @Interval(WORK_EVERY_MS)
    async work(): Promise<void> {
        if (this.working) return;
        this.working = true;
        try {
            const due = await this.prisma.webhook_deliveries.findMany({
                where: { status: "pending", next_attempt_at: { lte: new Date() } },
                orderBy: { created_at: "asc" },
                take: BATCH,
                include: { endpoint: true },
            });
            for (const d of due) {
                if (!d.endpoint.enabled) {
                    await this.prisma.webhook_deliveries.update({ where: { id: d.id }, data: { status: "failed", last_error: "The webhook was turned off." } });
                    continue;
                }
                const r = await this.deliver(d.endpoint, d.id, d.event, d.payload, d.attempts + 1);
                if (!r.ok) this.logger.debug(`Webhook "${d.endpoint.name}" ${d.event}: ${r.error}`);
            }
            if (Date.now() - this.lastPrune > 3_600_000) {
                this.lastPrune = Date.now();
                await this.prisma.webhook_deliveries.deleteMany({ where: { created_at: { lt: new Date(Date.now() - KEEP_DAYS * 86_400_000) }, status: { not: "pending" } } });
            }
        } catch (err) {
            this.logger.error(`Webhook delivery failed: ${(err as Error).message}`);
        } finally {
            this.working = false;
        }
    }

    /** One attempt. On success the delivery is done; on failure it is tried again later, or given up on (a test is never retried). */
    private async deliver(ep: { id: string; url: string; secret: string; name: string; format?: string }, deliveryId: string, event: string, payload: unknown, attempt: number): Promise<{ ok: boolean; status?: number; error: string }> {
        let status: number | undefined;
        let error = "";
        let permanent = false;
        try {
            // Checked on every send, because a name can start pointing somewhere else after it was saved.
            await assertSafeWebhookUrl(ep.url);
            // a chat service gets a message it can show; anything else gets the signed envelope as it always was
            const format = formatFor(ep.url, ep.format);
            const chat = format === "adgrmm" ? null : chatBody(format, payload as { event: string; data?: unknown });
            const body = JSON.stringify(chat ?? payload);
            const timestamp = Math.floor(Date.now() / 1000).toString();
            // Connects only to an address that passed the check at connection time (no DNS rebinding between check and send).
            const res = await safePost(ep.url, {
                timeoutMs: TIMEOUT_MS,
                allowPrivate: process.env.ALLOW_PRIVATE_WEBHOOKS === "true",
                headers: {
                    "Content-Type": "application/json",
                    "User-Agent": "AdgRmm-Webhook",
                    "X-ADG-Event": event,
                    "X-ADG-Delivery": deliveryId,
                    "X-ADG-Timestamp": timestamp,
                    "X-ADG-Signature": sign(decryptSecret(ep.secret), timestamp, body),
                },
                body,
            });
            status = res.status;
            if (!res.ok) {
                // what a chat service said is the most useful thing to show: "Cannot send an empty message" tells more than "400"
                const said = chat ? (await res.text().catch(() => "")).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 160) : "";
                error = `The address answered with status ${res.status}${said ? `: ${said}` : ""}.`;
                // a chat service that says the message itself is wrong will say so again: only a busy or broken one is worth trying again
                if (chat && res.status >= 400 && res.status < 500 && ![408, 425, 429].includes(res.status)) permanent = true;
            }
        } catch (e) {
            error = String((e as Error)?.message ?? e).slice(0, 500) || "Could not reach the address.";
        }

        if (!error) {
            await this.prisma.webhook_deliveries.update({ where: { id: deliveryId }, data: { status: "delivered", attempts: attempt, response_status: status ?? null, last_error: null, delivered_at: new Date() } });
            return { ok: true, status, error: "" };
        }
        const delay = event === "webhook.test" || permanent ? undefined : retryDelay(attempt);
        await this.prisma.webhook_deliveries.update({
            where: { id: deliveryId },
            data: delay === undefined
                ? { status: "failed", attempts: attempt, response_status: status ?? null, last_error: error }
                : { attempts: attempt, response_status: status ?? null, last_error: error, next_attempt_at: new Date(Date.now() + delay * 60_000) },
        });
        return { ok: false, status, error };
    }
}
