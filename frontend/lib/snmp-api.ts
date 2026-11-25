// lib/snmp-api.ts
//
// SNMP monitoring of network devices that have no agent (printers, switches, ...): a managed Windows or Linux device of the same site polls
// them. The community string is only ever sent to the server; it is never returned.
import { jfetch } from "@/lib/api";

export type SnmpKind = "printer" | "switch" | "other";
export type SnmpStatus = "unknown" | "ok" | "unreachable";

export type SnmpDevice = {
    id: string;
    siteId: string;
    site: string | null;
    clientId: string | null;
    customer: string | null;
    ip: string;
    port: number;
    name: string;
    label: string | null;
    sysName: string | null;
    description: string | null;
    location: string | null;
    kind: SnmpKind;
    kindChosen: "auto" | SnmpKind;
    status: SnmpStatus;
    enabled: boolean;
    alertEnabled: boolean;
    pollMinutes: number;
    pollerDeviceId: string | null;
    pollerName: string | null;
    assetProvider: string | null;
    assetRef: string | null;
    lastPolledAt: string | null;
    lastOkAt: string | null;
    failures: number;
    message: string | null;
    uptimeSeconds: number | null;
    polling: boolean;
    summary: { lowestSupplyPercent: number | null; pages: number | null; printerStatus: string | null; faults: string[]; portsUp: number | null; portsDown: number | null };
};

export type SnmpDetail = SnmpDevice & {
    supplies: Array<{ index: number; description: string; level: number; max: number | null; percent: number | null }>;
    printer: { status: number | null; errors: string | null; pages: number | null; faults: Array<{ text: string; severity: "WARN" | "CRIT" }> } | null;
    interfaces: Array<{ index: number; name: string; oper: number; speed: number; inOctets: number; outOctets: number }>;
    samples: Array<{ at: string; ok: boolean; uptimeSeconds: number | null; pages: number | null; lowestSupplyPercent: number | null }>;
};

export type SnmpList = { total: number; counts: { ok: number; unreachable: number; unknown: number }; items: SnmpDevice[] };
export type SnmpWrite = {
    siteId?: string; ip?: string; port?: number; community?: string; name?: string | null; kind?: string; pollMinutes?: number;
    enabled?: boolean; alertEnabled?: boolean; pollerDeviceId?: string | null;
};

export const POLL_CHOICES: Array<{ minutes: number; label: string }> = [
    { minutes: 5, label: "Every 5 minutes" }, { minutes: 15, label: "Every 15 minutes" }, { minutes: 30, label: "Every 30 minutes" }, { minutes: 60, label: "Every hour" },
];
export const KIND_CHOICES: Array<{ value: "auto" | SnmpKind; label: string }> = [
    { value: "auto", label: "Work it out from what it says" }, { value: "printer", label: "Printer" }, { value: "switch", label: "Switch or router" }, { value: "other", label: "Other device" },
];
export const KIND_TEXT: Record<SnmpKind, string> = { printer: "Printer", switch: "Switch or router", other: "Network device" };

export function uptimeText(seconds: number | null): string {
    if (seconds === null) return "unknown";
    const d = Math.floor(seconds / 86400), h = Math.floor((seconds % 86400) / 3600), m = Math.floor((seconds % 3600) / 60);
    return d > 0 ? `${d} day${d === 1 ? "" : "s"} ${h} h` : h > 0 ? `${h} h ${m} min` : `${m} min`;
}

export function speedText(bps: number): string {
    if (!bps) return "";
    return bps >= 1e9 ? `${Math.round(bps / 1e8) / 10} Gbit/s` : bps >= 1e6 ? `${Math.round(bps / 1e5) / 10} Mbit/s` : `${Math.round(bps / 1e3)} kbit/s`;
}

export const snmp = {
    list: (p: { status?: string; q?: string; clientId?: string; siteId?: string } = {}) => {
        const sp = new URLSearchParams();
        if (p.status) sp.set("status", p.status);
        if (p.q?.trim()) sp.set("q", p.q.trim());
        if (p.clientId) sp.set("clientId", p.clientId);
        if (p.siteId) sp.set("siteId", p.siteId);
        return jfetch<SnmpList>(`/api/snmp/devices${sp.toString() ? `?${sp.toString()}` : ""}`);
    },
    get: (id: string) => jfetch<SnmpDetail>(`/api/snmp/devices/${encodeURIComponent(id)}`),
    create: (body: SnmpWrite) => jfetch<SnmpDetail>("/api/snmp/devices", { method: "POST", body }),
    update: (id: string, body: SnmpWrite) => jfetch<SnmpDetail>(`/api/snmp/devices/${encodeURIComponent(id)}`, { method: "PATCH", body }),
    remove: (id: string) => jfetch<{ deleted: boolean }>(`/api/snmp/devices/${encodeURIComponent(id)}`, { method: "DELETE" }),
    poll: (id: string) => jfetch<{ pollId: string; alreadyPolling: boolean }>(`/api/snmp/devices/${encodeURIComponent(id)}/poll`, { method: "POST", body: {} }),
};
