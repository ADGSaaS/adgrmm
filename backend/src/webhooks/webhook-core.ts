// Outbound webhooks: the events that can be sent, how a delivery is signed and retried, and the rules for what an
// administrator may save. Pure: no database or network, so it can be tested alone.
import { BadRequestException } from "@nestjs/common";
import { createHmac, timingSafeEqual } from "node:crypto";

export const WEBHOOK_EVENTS = [
    { key: "ticket.created", label: "Ticket created", description: "A ticket was created: by staff, from the client portal, from an email, or automatically from an alert." },
    { key: "ticket.updated", label: "Ticket updated", description: "A ticket's status, priority, assignee, title, due date or custom fields changed." },
    { key: "ticket.survey_low", label: "Low survey score", description: "A customer gave a low score in a satisfaction survey (the score and what they wrote are included)." },
    { key: "ticket.sla_warning", label: "Ticket SLA warning", description: "A ticket has used up the warning share (80 percent by default) of its response or resolution time." },
    { key: "ticket.sla_breached", label: "Ticket SLA breached", description: "A ticket went past its response or resolution time." },
    { key: "alert.opened", label: "Alert opened", description: "An alert was raised for a device." },
    { key: "alert.resolved", label: "Alert resolved", description: "An alert was resolved, by a person or because the problem went away." },
    { key: "device.chat_message", label: "Chat message from a device", description: "Someone at a device wrote to support from the tray app (what they wrote is included)." },
    { key: "monitor.failed", label: "Domain, DNS or certificate problem", description: "A monitored certificate, domain or set of DNS records is about to run out, has run out, or is not as it should be (or could not be checked for a while)." },
    { key: "monitor.recovered", label: "Domain, DNS or certificate recovered", description: "A monitor that had a problem is fine again." },
    { key: "device.offline", label: "Device offline", description: "A device stopped checking in for longer than the offline limit." },
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number]["key"];
export const EVENT_KEYS: string[] = WEBHOOK_EVENTS.map((e) => e.key);

/** Roughly a day of trying, so a brief outage at the receiver does not lose an event. */
export const RETRY_DELAYS_MIN = [1, 5, 15, 60, 240, 720];
export const MAX_ENDPOINTS = 20;

/** The text signed with the endpoint's secret: the time it was sent, a dot, and the exact body. */
export function signedText(timestamp: string, body: string): string {
    return `${timestamp}.${body}`;
}

/** The value of the X-RemoteIQ-Signature header. */
export function sign(secret: string, timestamp: string, body: string): string {
    return `sha256=${createHmac("sha256", secret).update(signedText(timestamp, body)).digest("hex")}`;
}

/** What a receiver does: recompute the signature, compare without leaking timing, and refuse old timestamps. */
export function verify(secret: string, timestamp: string, body: string, header: string, nowSec = Math.floor(Date.now() / 1000), toleranceSec = 300): boolean {
    if (!/^\d+$/.test(timestamp) || Math.abs(nowSec - Number(timestamp)) > toleranceSec) return false;
    const expected = Buffer.from(sign(secret, timestamp, body));
    const got = Buffer.from(String(header));
    return expected.length === got.length && timingSafeEqual(expected, got);
}

/** Minutes to wait before attempt number `attempts + 1`, or undefined when it is time to give up. */
export function retryDelay(attemptsSoFar: number): number | undefined {
    return RETRY_DELAYS_MIN[attemptsSoFar - 1];
}

export function cleanName(v: unknown): string {
    const s = String(v ?? "").replace(/\s+/g, " ").trim();
    if (!s) throw new BadRequestException("Give the webhook a name.");
    if (s.length > 80) throw new BadRequestException("The name is too long (80 characters at most).");
    return s;
}

export function cleanEvents(v: unknown): string[] {
    if (!Array.isArray(v) || v.length === 0) throw new BadRequestException("Choose at least one event.");
    const events = [...new Set(v.map((e) => String(e)))];
    const bad = events.filter((e) => !EVENT_KEYS.includes(e));
    if (bad.length) throw new BadRequestException(`Unknown event: ${bad.join(", ")}.`);
    return EVENT_KEYS.filter((k) => events.includes(k));
}

/** The message format: "auto" (decided from the address) or one of the services. */
export const FORMAT_CHOICES = ["auto", "remoteiq", "slack", "discord", "teams"] as const;
export function cleanFormat(v: unknown): string {
    if (v === undefined || v === null || v === "") return "auto";
    const s = String(v);
    if (!(FORMAT_CHOICES as readonly string[]).includes(s)) throw new BadRequestException("The message format must be auto, remoteiq, slack, discord or teams.");
    return s;
}

export function cleanUrl(v: unknown): string {
    const s = String(v ?? "").trim();
    if (!s) throw new BadRequestException("Enter the address to send events to.");
    if (s.length > 2000) throw new BadRequestException("The address is too long.");
    let u: URL;
    try {
        u = new URL(s);
    } catch {
        throw new BadRequestException("That is not a valid address.");
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new BadRequestException("The address must start with https://.");
    if (u.username || u.password) throw new BadRequestException("Put the secret in the signature, not in the address.");
    return u.toString();
}
