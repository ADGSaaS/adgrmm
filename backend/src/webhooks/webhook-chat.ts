// backend/src/webhooks/webhook-chat.ts
//
// Outbound webhooks to chat services. Slack, Discord and Microsoft Teams only accept their own message shape and answer anything else with
// a 400, so a webhook whose address is one of theirs (or that was told which one it is) gets a message a person reads in the channel instead
// of ADG RMM's signed JSON. Pure: no database, no network.
//
// Text from tickets and alerts is written by customers and by devices, so it is cleaned before it goes into a channel: Slack would turn
// <!channel> or <@U123> into a mention of everyone, so < > & are written as entities for Slack; Discord gets allowed_mentions with nothing in
// it; control characters go everywhere; and nothing is longer than the services allow.
import { webhookFormatFor, type WebhookFormat } from "../notifications/notifications.service";

export { webhookFormatFor, WEBHOOK_FORMATS, type WebhookFormat } from "../notifications/notifications.service";

type Envelope = { id?: string; event: string; createdAt?: string; data?: any };

const clean = (v: unknown, max = 300): string => String(v ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const where = (d: any) => [d?.customer, d?.site].filter(Boolean).map((x: unknown) => clean(x, 80)).join(" / ");

const LABEL: Record<string, string> = {
    "ticket.created": "New ticket",
    "ticket.updated": "Ticket updated",
    "ticket.survey_low": "Low survey score",
    "ticket.sla_warning": "Ticket close to its SLA limit",
    "ticket.sla_breached": "Ticket past its SLA limit",
    "alert.opened": "Alert",
    "alert.resolved": "Alert resolved",
    "device.offline": "Device offline",
    "monitor.failed": "Problem",
    "monitor.recovered": "Recovered",
    "device.chat_message": "Chat",
    "webhook.test": "Test",
};

export type ChatMessage = { title: string; lines: string[]; link?: { url: string; label: string } };

/** What a person reads: one headline and a few plain lines, with a link when there is somewhere to go. */
export function chatMessage(env: Envelope): ChatMessage {
    const d = env.data ?? {};
    const label = LABEL[env.event] ?? env.event;
    if (env.event === "webhook.test") return { title: "Test from ADG RMM", lines: [clean(d.message ?? "This webhook works."), d.webhook ? `Webhook: ${clean(d.webhook, 80)}` : ""].filter(Boolean) };

    if (env.event.startsWith("ticket.") && d.ticket) {
        const t = d.ticket;
        const head = `${label}: #${clean(t.number, 12)} ${clean(t.subject, 160)}`;
        const meta = [t.customer && clean(t.customer, 80), t.priority && `priority ${clean(t.priority, 20)}`, t.status && clean(t.status, 30)].filter(Boolean).join(" · ");
        const lines = [meta];
        if (Array.isArray(d.changes) && d.changes.length) {
            lines.push(d.changes.slice(0, 5).map((c: any) => `${clean(c.field, 40)}: ${c.from === null || c.from === undefined || c.from === "" ? "none" : clean(c.from, 60)} to ${c.to === null || c.to === undefined || c.to === "" ? "none" : clean(c.to, 60)}`).join("; "));
            if (d.changedBy) lines.push(`By ${clean(d.changedBy, 60)}`);
        }
        if (d.source) lines.push(`Source: ${clean(d.source, 30)}`);
        if (typeof d.score === "number") lines.push(`Score: ${d.score}${d.comment ? ` - ${clean(d.comment, 200)}` : ""}`);
        return { title: head, lines: lines.filter(Boolean), link: t.url ? { url: String(t.url), label: "Open the ticket" } : undefined };
    }

    if (env.event.startsWith("alert.") && d.alert) {
        const a = d.alert;
        const sev = env.event === "alert.resolved" ? "" : a.severity === "CRIT" ? "Critical alert" : a.severity === "WARN" ? "Warning" : label;
        const dev = d.device;
        const head = `${sev || label}: ${clean(a.title, 160)}${dev?.name ? ` on ${clean(dev.name, 80)}` : ""}`;
        return { title: head, lines: [where(dev), a.detail ? clean(a.detail, 300) : ""].filter(Boolean), link: dev?.id && d.url ? { url: String(d.url), label: "Open the device" } : undefined };
    }

    if (env.event === "device.offline") {
        const dev = d.device ?? {};
        return { title: `Device offline: ${clean(dev.name, 80)}`, lines: [where(dev), d.alert?.title ? clean(d.alert.title, 160) : ""].filter(Boolean), link: d.url ? { url: String(d.url), label: "Open the device" } : undefined };
    }

    if (env.event === "device.chat_message" && d.device) {
        return {
            title: `Chat from ${clean(d.message?.from, 80)} on ${clean(d.device.name, 80)}`,
            lines: [where(d.device), clean(d.message?.text, 300)].filter(Boolean),
            link: d.url ? { url: String(d.url), label: "Open the chat" } : undefined,
        };
    }

    if (env.event.startsWith("monitor.") && d.monitor) {
        const m = d.monitor;
        const kind = m.kind === "certificate" ? "Certificate" : m.kind === "domain" ? "Domain" : m.kind === "microsoft365" ? "Microsoft 365 tenant" : "DNS records";
        const sev = env.event === "monitor.recovered" ? "Recovered" : d.severity === "warning" ? "Warning" : d.severity === "error" ? "Could not be checked" : "Problem";
        return {
            title: `${sev}: ${kind}${m.kind === "microsoft365" ? " " : " of "}${clean(m.host, 120)}${m.kind === "certificate" && m.port && m.port !== 443 ? `:${clean(m.port, 6)}` : ""}`,
            lines: [m.customer ? `Customer: ${clean(m.customer, 80)}` : "", clean(d.detail, 400)].filter(Boolean),
            link: m.url ? { url: String(m.url), label: "Open the monitors" } : undefined,
        };
    }

    return { title: label, lines: [clean(JSON.stringify(d), 300)].filter((x) => x && x !== "{}") };
}

const slackEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The JSON body for a chat format, or null for ADG RMM's own format (which keeps the envelope as it always was). */
export function chatBody(format: WebhookFormat, env: Envelope): unknown | null {
    if (format === "adgrmm") return null;
    const m = chatMessage(env);
    if (format === "slack") {
        const text = [`*${slackEscape(m.title)}*`, ...m.lines.map(slackEscape), m.link ? `<${m.link.url.replace(/[<>|\s]/g, "")}|${m.link.label}>` : ""].filter(Boolean).join("\n");
        return { text: text.slice(0, 3000), unfurl_links: false };
    }
    const plain = [m.title, ...m.lines, m.link ? `${m.link.label}: ${m.link.url}` : ""].filter(Boolean).join("\n");
    if (format === "discord") return { content: `**${m.title.replace(/[*_`~|>]/g, "")}**${plain.slice(m.title.length)}`.slice(0, 1900), allowed_mentions: { parse: [] } };
    // Teams (Workflows and the older connectors): an adaptive card with a bold headline, the lines and a button
    return {
        type: "message",
        attachments: [{
            contentType: "application/vnd.microsoft.card.adaptive",
            contentUrl: null,
            content: {
                $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
                type: "AdaptiveCard",
                version: "1.2",
                body: [
                    { type: "TextBlock", wrap: true, weight: "Bolder", size: "Medium", text: m.title.slice(0, 500) },
                    ...(m.lines.length ? [{ type: "TextBlock", wrap: true, spacing: "Small", text: m.lines.join("\n\n").slice(0, 2500) }] : []),
                ],
                ...(m.link && /^https?:\/\//i.test(m.link.url) ? { actions: [{ type: "Action.OpenUrl", title: m.link.label, url: m.link.url }] } : {}),
            },
        }],
    };
}

/** The format an endpoint uses: the one chosen, or from its address when it is "auto". */
export function formatFor(url: string, chosen: string | null | undefined): WebhookFormat {
    return webhookFormatFor(url, chosen === "auto" || !chosen ? undefined : chosen);
}
