// lib/web-monitors-api.ts
//
// Domain, DNS and certificate monitors (Monitoring > Domains and certificates).
import { jfetch } from "@/lib/api";

export type MonitorKind = "certificate" | "domain" | "dns";
export type MonitorStatus = "pending" | "ok" | "warning" | "failed" | "error";
export type DnsType = "A" | "AAAA" | "MX" | "NS" | "TXT" | "CNAME";
export const DNS_TYPES: DnsType[] = ["A", "AAAA", "MX", "NS", "TXT", "CNAME"];

export type MonitorConfig = { warnDays?: number; failDays?: number; records?: Array<{ type: DnsType; expected?: string[] }>; baseline?: Record<string, string[]> };

export type WebMonitor = {
    id: string; kind: MonitorKind; name: string; host: string; port: number; clientId: string | null; customer: string | null; config: MonitorConfig; enabled: boolean;
    status: MonitorStatus; detail: string | null; result: unknown; expiresAt: string | null; daysLeft: number | null; lastCheckedAt: string | null; statusSince: string; createdAt: string;
};

export type MonitorList = { items: WebMonitor[]; summary: { total: number; ok: number; warning: number; failed: number; pending: number }; max: number };

export type MonitorInput = { kind?: MonitorKind; name?: string; host?: string; port?: number; clientId?: string | null; config?: MonitorConfig; enabled?: boolean };

export const KIND_LABEL: Record<MonitorKind, string> = { certificate: "Certificate", domain: "Domain", dns: "DNS records" };

export const webMonitors = {
    list: (qs = "") => jfetch<MonitorList>(`/api/monitors/web${qs}`),
    create: (input: MonitorInput) => jfetch<WebMonitor>("/api/monitors/web", { method: "POST", body: input }),
    update: (id: string, input: MonitorInput) => jfetch<WebMonitor>(`/api/monitors/web/${encodeURIComponent(id)}`, { method: "PATCH", body: input }),
    remove: (id: string) => jfetch<{ ok: boolean }>(`/api/monitors/web/${encodeURIComponent(id)}`, { method: "DELETE" }),
    run: (id: string) => jfetch<WebMonitor>(`/api/monitors/web/${encodeURIComponent(id)}/run`, { method: "POST", body: {} }),
    accept: (id: string) => jfetch<WebMonitor>(`/api/monitors/web/${encodeURIComponent(id)}/accept`, { method: "POST", body: {} }),
};
