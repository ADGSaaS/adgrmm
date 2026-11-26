// lib/alerts-api.ts
import { jfetch } from "@/lib/api";

export type AlertState = "OPEN" | "ACKED" | "SILENCED" | "RESOLVED";
export type AlertSeverity = "WARN" | "CRIT";

export type Alert = {
    id: string;
    kind: "check" | "offline" | "discovery";
    state: AlertState;
    severity: AlertSeverity;
    title: string;
    detail: string | null;
    firstSeenAt: string;
    lastSeenAt: string;
    silencedUntil: string | null;
    resolvedAt: string | null;
    ticketId: string | null;
    device: { id: string; name: string; client: string | null; site: string | null };
};

export type AlertSummary = { open: number; openCritical: number; acknowledged: number; silenced: number };

export type AlertEvent = { id: string; type: string; reason: string | null; at: string; actor: string };

export type AlertSettings = {
    offlineAfterMinutes: number;
    renotifyAfterHours: number;
    autoTicket: boolean;
    autoTicketMinSeverity: AlertSeverity;
    autoResolveTicket: boolean;
};

export type NotificationChannel = {
    id: string;
    name: string;
    kind: "email" | "webhook";
    enabled: boolean;
    minSeverity: AlertSeverity;
    notifyOnResolve: boolean;
    recipients: string[];
    url: string | null;
    signingSecret?: string | null;
    /** How a webhook message is written: the one in use, and the one chosen (null follows the address). */
    format?: WebhookFormat | null;
    formatChosen?: WebhookFormat | null;
};

export type WebhookFormat = "adgrmm" | "slack" | "discord" | "teams";
export type WebhookFormatChoice = WebhookFormat | "auto";
export const WEBHOOK_FORMAT_LABEL: Record<WebhookFormat, string> = {
    slack: "Slack (also Mattermost and Rocket.Chat)",
    discord: "Discord",
    teams: "Microsoft Teams",
    adgrmm: "ADG RMM JSON (signed)",
};
/** What a channel is sent as a body of a create or update: the format may also be "auto". */
export type ChannelWrite = Omit<Partial<NotificationChannel>, "format" | "formatChosen"> & { format?: WebhookFormatChoice };

export function fetchAlerts(params: { state?: AlertState; severity?: AlertSeverity; deviceId?: string; q?: string; cursor?: string | null; limit?: number }) {
    const sp = new URLSearchParams();
    if (params.state) sp.set("state", params.state);
    if (params.severity) sp.set("severity", params.severity);
    if (params.deviceId) sp.set("deviceId", params.deviceId);
    if (params.q?.trim()) sp.set("q", params.q.trim());
    if (params.cursor) sp.set("cursor", params.cursor);
    if (params.limit) sp.set("limit", String(params.limit));
    return jfetch<{ items: Alert[]; nextCursor: string | null }>(`/api/alerts?${sp.toString()}`);
}

export const fetchAlertSummary = () => jfetch<AlertSummary>("/api/alerts/summary");
export const fetchAlertTimeline = (id: string) => jfetch<{ items: AlertEvent[] }>(`/api/alerts/${id}/timeline`);

export const ackAlert = (id: string) => jfetch(`/api/alerts/${id}/ack`, { method: "POST", body: {} });
export const silenceAlert = (id: string, until: string) => jfetch(`/api/alerts/${id}/silence`, { method: "POST", body: { until } });
export const unsilenceAlert = (id: string) => jfetch(`/api/alerts/${id}/unsilence`, { method: "POST", body: {} });
export const resolveAlert = (id: string) => jfetch(`/api/alerts/${id}/resolve`, { method: "POST", body: {} });
export const openAlertTicket = (id: string) => jfetch<{ ticketId: string }>(`/api/alerts/${id}/ticket`, { method: "POST", body: {} });

export const bulkAlerts = (action: "ack" | "silence" | "resolve", ids: string[], until?: string) =>
    jfetch<{ updated: number; failed: string[] }>("/api/alerts/bulk", { method: "POST", body: { action, ids, until } });

export const fetchAlertSettings = () => jfetch<AlertSettings>("/api/alerts/settings");
export const saveAlertSettings = (body: Partial<AlertSettings>) => jfetch<AlertSettings>("/api/alerts/settings", { method: "PUT", body });

export const fetchChannels = () => jfetch<{ items: NotificationChannel[] }>("/api/notifications/channels");
export const createChannel = (body: ChannelWrite) => jfetch<NotificationChannel>("/api/notifications/channels", { method: "POST", body });
export const updateChannel = (id: string, body: ChannelWrite) => jfetch<NotificationChannel>(`/api/notifications/channels/${id}`, { method: "PATCH", body });
export const deleteChannel = (id: string) => jfetch(`/api/notifications/channels/${id}`, { method: "DELETE" });
export const testChannel = (id: string) => jfetch<{ ok: boolean; message: string }>(`/api/notifications/channels/${id}/test`, { method: "POST", body: {} });
