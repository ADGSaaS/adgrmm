// backend/src/notifications/notifications.service.ts
import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { createHmac, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { PrismaService } from "../storage/prisma.service";
import { SmtpService } from "../smtp/smtp.service";
import { EmailTemplatesService } from "../templates/email-templates.service";
import { decryptSecret, encryptSecret } from "../common/secret-box";
import { isPrivateAddress, safePost } from "../common/ssrf-guard";
import { looksLikeEmail } from "../common/text-util";

export type AlertEventName = "opened" | "escalated" | "reminder" | "resolved";

export type ChannelInput = {
    name: string;
    kind: "email" | "webhook";
    enabled?: boolean;
    minSeverity?: "WARN" | "CRIT";
    notifyOnResolve?: boolean;
    recipients?: string[];
    url?: string;
    /** How the message is written; when left out it follows the address (Slack, Discord, Teams) or is ADG RMM's own. */
    format?: WebhookFormat | "auto";
};

const WORK_EVERY_MS = 15_000;
const BATCH = 25;
const WEBHOOK_TIMEOUT_MS = 10_000;
// Roughly a day of trying, so a brief outage does not lose an alert.
const RETRY_DELAYS_MIN = [1, 5, 15, 60, 240, 720];
const SEVERITY_RANK: Record<string, number> = { WARN: 1, CRIT: 2 };

type ChannelConfig = { recipients?: string[]; url?: string; secret?: string; format?: WebhookFormat };

/* ------------------------------ what a webhook is sent ------------------------------ */

export type WebhookFormat = "adgrmm" | "slack" | "discord" | "teams";
export const WEBHOOK_FORMATS: WebhookFormat[] = ["adgrmm", "slack", "discord", "teams"];

/**
 * Chat services only accept their own message shape and answer anything else with a 400, so the address says which one this is:
 * Slack (and Mattermost-style "hooks.slack.com" copies), Discord, and Microsoft Teams (Workflows and the older connectors).
 * Any other address gets ADG RMM's own signed JSON, which is what a receiver written for ADG RMM expects.
 */
export function webhookFormatFor(rawUrl: string, chosen?: unknown): WebhookFormat {
    if (typeof chosen === "string" && (WEBHOOK_FORMATS as string[]).includes(chosen)) return chosen as WebhookFormat;
    let u: URL;
    try { u = new URL(rawUrl); } catch { return "adgrmm"; }
    const host = u.hostname.toLowerCase();
    if (host === "hooks.slack.com" || host.endsWith(".slack.com")) return "slack";
    if ((host === "discord.com" || host === "discordapp.com" || host.endsWith(".discord.com")) && /^\/api\/webhooks\//i.test(u.pathname)) return "discord";
    if (host.endsWith(".webhook.office.com") || host === "outlook.office.com" || host.endsWith(".logic.azure.com") || host.endsWith(".powerplatform.com") || host.endsWith(".environment.api.powerplatform.com")) return "teams";
    return "adgrmm";
}

const EVENT_LABEL: Record<string, string> = { resolved: "Resolved", reminder: "Still open", test: "Test" };

/** The message a person reads in a chat: what happened, where, and a link, in plain words. */
export function webhookText(payload: { event: string; alert: any }, consoleUrl = ""): string {
    const a = payload.alert ?? {};
    const label = EVENT_LABEL[payload.event] ?? (a.severity === "CRIT" ? "Critical alert" : "Warning");
    const where = a.device ? [a.device.customer, a.device.site].filter(Boolean).join(" / ") : "";
    const lines = [
        `${label}: ${String(a.title ?? "ADG RMM alert")}${a.device?.name ? ` on ${a.device.name}` : ""}${where ? ` (${where})` : ""}`,
        a.detail ? String(a.detail) : "",
        consoleUrl && a.device?.id ? `Open the device: ${consoleUrl}/devices/${a.device.id}` : "",
    ];
    return lines.filter(Boolean).join("\n").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ");
}

/** The JSON body for one format. ADG RMM's own format is the event and the alert as they always were, plus the time. */
export function webhookBody(format: WebhookFormat, payload: { event: string; alert: any }, consoleUrl = "", sentAt = new Date().toISOString()): unknown {
    if (format === "slack") return { text: webhookText(payload, consoleUrl).slice(0, 3000) };
    if (format === "discord") return { content: webhookText(payload, consoleUrl).slice(0, 1900), allowed_mentions: { parse: [] } };
    if (format === "teams") {
        const text = webhookText(payload, consoleUrl);
        return {
            type: "message",
            attachments: [{
                contentType: "application/vnd.microsoft.card.adaptive",
                contentUrl: null,
                content: { $schema: "http://adaptivecards.io/schemas/adaptive-card.json", type: "AdaptiveCard", version: "1.2", body: [{ type: "TextBlock", wrap: true, text: text.slice(0, 3000) }] },
            }],
        };
    }
    return { ...payload, sentAt };
}

/**
 * A webhook that said no. A 4xx answer other than "try again later" means the message itself is wrong for that address, and sending the
 * same message again will not change that, so it is not retried; a 429 or a 5xx is a busy or broken receiver and is.
 */
export class WebhookRejected extends Error {
    constructor(readonly status: number, message: string, readonly retryAfterSec: number | null = null) { super(message); }
    get permanent(): boolean {
        return this.status >= 400 && this.status < 500 && ![408, 425, 429].includes(this.status);
    }
}


// The address rules live in common/ssrf-guard (IPv4 inside IPv6, NAT64, 6to4, metadata and special ranges); re-exported for existing callers.
export { isPrivateAddress };

/**
 * A webhook makes this server call an address someone typed in. Without this it could reach
 * internal services, such as the database host or a cloud metadata address, and show the response.
 */
export async function assertSafeWebhookUrl(raw: string): Promise<void> {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw new Error("That is not a valid address.");
    }
    // For webhooks on the same private network as this server, which is opted into deliberately.
    if (process.env.ALLOW_PRIVATE_WEBHOOKS === "true") return;

    if (url.protocol !== "https:") throw new Error("Webhooks must use https.");

    const host = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
    if (addresses.some(isPrivateAddress)) throw new Error("Webhooks cannot point at a private network address.");
}

@Injectable()
export class NotificationsService {
    private readonly logger = new Logger(NotificationsService.name);
    private working = false;

    constructor(
        private readonly prisma: PrismaService,
        private readonly smtp: SmtpService,
        private readonly templates: EmailTemplatesService,
    ) { }

    /* ------------------------------ channels ------------------------------ */

    private present(c: { id: string; name: string; kind: string; enabled: boolean; min_severity: string; notify_on_resolve: boolean; config: unknown }) {
        const config = (c.config ?? {}) as ChannelConfig;
        return {
            id: c.id,
            name: c.name,
            kind: c.kind,
            enabled: c.enabled,
            minSeverity: c.min_severity,
            notifyOnResolve: c.notify_on_resolve,
            recipients: config.recipients ?? [],
            url: config.url ?? null,
            // The format in use, and the one a person chose (null means "follow the address").
            format: config.url ? webhookFormatFor(config.url, config.format) : null,
            formatChosen: config.format ?? null,
        };
    }

    async listChannels() {
        const rows = await this.prisma.notification_channels.findMany({ orderBy: { created_at: "asc" } });
        return { items: rows.map((c) => this.present(c)) };
    }

    private validate(input: ChannelInput) {
        if (input.kind === "email") {
            const recipients = (input.recipients ?? []).map((r) => r.trim()).filter(Boolean);
            if (!recipients.length) throw new BadRequestException("Add at least one email address.");
            if (recipients.some((r) => !looksLikeEmail(r))) {
                throw new BadRequestException("One of those email addresses is not valid.");
            }
            return { recipients };
        }
        if (!input.url?.trim()) throw new BadRequestException("Enter the webhook address.");
        if (input.format !== undefined && input.format !== "auto" && !(WEBHOOK_FORMATS as string[]).includes(input.format)) throw new BadRequestException("The message format must be auto, adgrmm, slack, discord or teams.");
        return { url: input.url.trim(), ...(input.format && input.format !== "auto" ? { format: input.format } : {}) };
    }

    /** The signing secret is only ever shown here, once. */
    async createChannel(input: ChannelInput) {
        const validated = this.validate(input);
        let signingSecret: string | null = null;
        const config: ChannelConfig = { ...validated };

        if (input.kind === "webhook") {
            await assertSafeWebhookUrl((validated as { url: string }).url).catch((e) => { throw new BadRequestException(e.message); });
            signingSecret = randomBytes(32).toString("base64url");
            config.secret = encryptSecret(signingSecret);
        }

        const row = await this.prisma.notification_channels.create({
            data: {
                name: input.name.trim(),
                kind: input.kind,
                enabled: input.enabled ?? true,
                min_severity: input.minSeverity ?? "WARN",
                notify_on_resolve: input.notifyOnResolve ?? true,
                config: config as object,
            },
        });
        return { ...this.present(row), signingSecret };
    }

    async updateChannel(id: string, input: Partial<ChannelInput>) {
        const row = await this.prisma.notification_channels.findUnique({ where: { id } });
        if (!row) throw new NotFoundException("Channel not found");

        const config = { ...(row.config as ChannelConfig) };
        if (row.kind === "email" && input.recipients) {
            config.recipients = this.validate({ name: row.name, kind: "email", recipients: input.recipients }).recipients;
        }
        if (row.kind === "webhook" && input.url) {
            await assertSafeWebhookUrl(input.url.trim()).catch((e) => { throw new BadRequestException(e.message); });
            config.url = input.url.trim();
        }
        if (row.kind === "webhook" && input.format !== undefined) {
            if (input.format === "auto") delete config.format;
            else if (!(WEBHOOK_FORMATS as string[]).includes(input.format)) throw new BadRequestException("The message format must be auto, adgrmm, slack, discord or teams.");
            else config.format = input.format;
        }

        const updated = await this.prisma.notification_channels.update({
            where: { id },
            data: {
                name: input.name?.trim() || undefined,
                enabled: input.enabled,
                min_severity: input.minSeverity,
                notify_on_resolve: input.notifyOnResolve,
                config: config as object,
                updated_at: new Date(),
            },
        });
        return this.present(updated);
    }

    async deleteChannel(id: string) {
        await this.prisma.notification_channels.delete({ where: { id } }).catch(() => {
            throw new NotFoundException("Channel not found");
        });
        return { id, deleted: true };
    }

    async testChannel(id: string) {
        const channel = await this.prisma.notification_channels.findUnique({ where: { id } });
        if (!channel) throw new NotFoundException("Channel not found");

        try {
            await this.send(channel, {
                event: "test",
                alert: {
                    id: null,
                    title: "Test notification from ADG RMM",
                    severity: "WARN",
                    state: "OPEN",
                    detail: "If this arrived, this channel works.",
                    device: null,
                },
            });
            return { ok: true, message: "Sent." };
        } catch (err) {
            return { ok: false, message: (err as Error).message };
        }
    }

    /* ------------------------------ delivery ------------------------------ */

    async enqueueForAlert(alertId: string, event: AlertEventName): Promise<void> {
        const alert = await this.prisma.alerts.findUnique({ where: { id: alertId }, select: { severity: true } });
        if (!alert) return;

        const channels = await this.prisma.notification_channels.findMany({ where: { enabled: true } });
        const targets = channels.filter(
            (c) =>
                (SEVERITY_RANK[alert.severity] ?? 0) >= (SEVERITY_RANK[c.min_severity] ?? 0) &&
                (event !== "resolved" || c.notify_on_resolve),
        );

        if (targets.length) {
            await this.prisma.notification_deliveries.createMany({
                data: targets.map((c) => ({ channel_id: c.id, alert_id: alertId, event })),
            });
        }
        await this.prisma.alerts.update({ where: { id: alertId }, data: { last_notified_at: new Date() } });
    }

    @Interval(WORK_EVERY_MS)
    async work(): Promise<void> {
        if (this.working) return;
        this.working = true;
        try {
            const due = await this.prisma.notification_deliveries.findMany({
                where: { status: "pending", next_attempt_at: { lte: new Date() } },
                orderBy: { created_at: "asc" },
                take: BATCH,
                include: {
                    notification_channels: true,
                    alerts: {
                        include: {
                            devices: { select: { id: true, hostname: true, alias: true, sites: { select: { name: true, clients: { select: { name: true } } } } } },
                        },
                    },
                },
            });

            for (const delivery of due) await this.attempt(delivery);
        } catch (err) {
            this.logger.error(`Notification delivery failed: ${(err as Error).message}`);
        } finally {
            this.working = false;
        }
    }

    private async attempt(delivery: any): Promise<void> {
        const alert = delivery.alerts;
        const channel = delivery.notification_channels;
        const attempts = delivery.attempts + 1;

        try {
            await this.send(channel, {
                event: delivery.event,
                alert: alert && {
                    id: alert.id,
                    title: alert.title,
                    severity: alert.severity,
                    state: alert.state,
                    detail: alert.detail,
                    firstSeenAt: alert.first_seen_at,
                    device: {
                        id: alert.devices.id,
                        name: alert.devices.alias || alert.devices.hostname,
                        customer: alert.devices.sites?.clients?.name ?? null,
                        site: alert.devices.sites?.name ?? null,
                    },
                },
            });
            await this.prisma.notification_deliveries.update({
                where: { id: delivery.id },
                data: { status: "delivered", attempts, delivered_at: new Date(), last_error: null },
            });
        } catch (err) {
            const message = (err as Error).message?.slice(0, 500) ?? "Unknown error";
            const rejected = err instanceof WebhookRejected ? err : null;
            // An answer that says the message itself is wrong is final; a busy receiver is asked again, no sooner than it said.
            let delay: number | undefined = rejected?.permanent ? undefined : RETRY_DELAYS_MIN[attempts - 1];
            if (delay !== undefined && rejected?.retryAfterSec) delay = Math.max(delay, Math.ceil(rejected.retryAfterSec / 60));
            await this.prisma.notification_deliveries.update({
                where: { id: delivery.id },
                data: delay === undefined
                    ? { status: "failed", attempts, last_error: message }
                    : { attempts, last_error: message, next_attempt_at: new Date(Date.now() + delay * 60_000) },
            });
            if (delay === undefined) this.logGaveUp(channel.name, message, !!rejected?.permanent);
        }
    }

    private readonly gaveUpLoggedAt = new Map<string, number>();

    /** One line a minute per channel: a channel that keeps refusing used to fill the log with the same line for every alert. */
    private logGaveUp(channel: string, message: string, permanent: boolean) {
        const last = this.gaveUpLoggedAt.get(channel) ?? 0;
        if (Date.now() - last < 60_000) return;
        this.gaveUpLoggedAt.set(channel, Date.now());
        this.logger.error(`Gave up on a notification to "${channel}": ${message}${permanent ? " It was not retried, because the receiver refuses this message and would again. Check the address in Administration > Notifications." : ""}`);
    }

    private async send(channel: { name: string; kind: string; config: unknown }, payload: { event: string; alert: any }): Promise<void> {
        const config = (channel.config ?? {}) as ChannelConfig;
        if (channel.kind === "email") await this.sendEmail(config, payload);
        else if (channel.kind === "webhook") await this.sendWebhook(config, payload);
        else throw new Error(`Unknown channel type ${channel.kind}`);
    }

    private async sendEmail(config: ChannelConfig, { event, alert }: { event: string; alert: any }) {
        const label = event === "resolved" ? "Resolved" : event === "reminder" ? "Still open" : event === "test" ? "Test" : alert.severity === "CRIT" ? "Critical" : "Warning";
        const where = alert.device ? [alert.device.customer, alert.device.site].filter(Boolean).join(" / ") : "";
        const console = (process.env.PUBLIC_CONSOLE_URL || "").replace(/\/+$/, "");

        // The wording is the built-in one unless an administrator changed it (Administration > Templates).
        const mail = await this.templates.render("alert", {
            event: label,
            title: String(alert.title ?? ""),
            customer: where,
            customer_line: where ? `Customer: ${where}` : "",
            detail: String(alert.detail ?? ""),
            device_line: console && alert.device ? `Open the device: ${console}/devices/${alert.device.id}` : "",
            alerts_line: console && alert.id ? `All alerts: ${console}/alerts` : "",
        });

        const result = await this.smtp.sendPlain("alerts", (config.recipients ?? []).join(", "), mail.subject, mail.body);
        if (!result.ok) throw new Error(result.result);
    }

    private async sendWebhook(config: ChannelConfig, payload: { event: string; alert: any }) {
        if (!config.url) throw new Error("This webhook has no address.");

        // Checked again on every send, because a name can start pointing somewhere else after it was saved.
        await assertSafeWebhookUrl(config.url);

        const format = webhookFormatFor(config.url, config.format);
        const consoleUrl = (process.env.PUBLIC_CONSOLE_URL || "").replace(/\/+$/, "");
        const body = JSON.stringify(webhookBody(format, payload, consoleUrl));
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const secret = config.secret ? decryptSecret(config.secret) : "";
        const signature = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");

        // Connects only to an address that passed the check at connection time, so a name cannot switch to a private address after it.
        const res = await safePost(config.url, {
            timeoutMs: WEBHOOK_TIMEOUT_MS,
            allowPrivate: process.env.ALLOW_PRIVATE_WEBHOOKS === "true",
            headers: {
                "Content-Type": "application/json",
                "User-Agent": "AdgRmm-Webhook",
                "X-ADG-Event": payload.event,
                "X-ADG-Timestamp": timestamp,
                "X-ADG-Signature": `sha256=${signature}`,
            },
            body,
        });
        if (!res.ok) {
            // What the receiver said is the most useful thing to show: "Cannot send an empty message" tells more than "400".
            const said = (await res.text().catch(() => "")).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
            const retryAfter = Number(res.headers.get("retry-after"));
            throw new WebhookRejected(res.status, `The webhook answered with status ${res.status}${said ? `: ${said}` : ""}.`, Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 86_400) : null);
        }
    }
}
