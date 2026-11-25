// lib/network-discovery-api.ts
//
// Network discovery: a managed Windows or Linux device scans its own network; the hosts it saw are listed, and the ones that are not
// managed devices yet are the interesting part.
import { jfetch } from "@/lib/api";

export type HostStatus = "unmanaged" | "managed" | "ignored" | "all";

export type DiscoveredHost = {
    id: string;
    siteId: string;
    site: string | null;
    clientId: string | null;
    customer: string | null;
    ip: string;
    mac: string | null;
    hostname: string | null;
    vendor: string | null;
    kind: string;
    kindText: string;
    ports: number[];
    firstSeen: string;
    lastSeen: string;
    seenRuns: number;
    deviceId: string | null;
    deviceName: string | null;
    ignored: boolean;
    assetProvider: string | null;
    assetRef: string | null;
    /** Where the name came from: dns, nbns (NetBIOS) or mdns (Bonjour), with its words. */
    nameSource: "dns" | "nbns" | "mdns" | null;
    nameSourceText: string | null;
};

export type HostPage = {
    counts: { unmanaged: number; managed: number; ignored: number; all: number };
    total: number;
    items: DiscoveredHost[];
};

export type DiscoveryRun = {
    id: string;
    siteId: string;
    site: string | null;
    customer: string | null;
    scanner: string | null;
    scannerDeviceId: string | null;
    status: "pending" | "succeeded" | "failed";
    requestedAt: string;
    finishedAt: string | null;
    ranges: string[];
    hostsFound: number;
    newHosts: number;
    seconds: number | null;
    message: string | null;
};

export type DiscoverySchedule = {
    siteId: string;
    site: string | null;
    clientId: string | null;
    customer: string | null;
    enabled: boolean;
    intervalHours: number;
    ranges: string[];
    scannerDeviceId: string | null;
    scannerName: string | null;
    alertNew: boolean;
    lastRequestedAt: string | null;
    nextDueAt: string | null;
    message: string | null;
};
export type ScheduleWrite = { enabled?: boolean; intervalHours?: number; ranges?: string[]; scannerDeviceId?: string | null; alertNew?: boolean };
export const SCHEDULE_INTERVALS: Array<{ hours: number; label: string }> = [
    { hours: 1, label: "Every hour" }, { hours: 6, label: "Every 6 hours" }, { hours: 12, label: "Every 12 hours" },
    { hours: 24, label: "Every day" }, { hours: 48, label: "Every 2 days" }, { hours: 168, label: "Every week" },
];

export type ScanManyResult = {
    started: number; alreadyRunning: number; skipped: number;
    results: Array<{ deviceId: string; name: string; status: "started" | "already_running" | "skipped"; runId?: string; reason?: string }>;
};
/** The most devices one request may scan from. */
export const MAX_SCAN_DEVICES = 25;

export type Scanner = { deviceId: string; name: string; os: string | null; customer: string | null; clientId: string | null; site: string | null; siteId: string };

/** Names of the TCP ports a scan tries, for the table. */
export const PORT_NAMES: Record<number, string> = {
    22: "SSH", 23: "Telnet", 53: "DNS", 80: "Web", 135: "RPC", 139: "NetBIOS", 161: "SNMP", 443: "Secure web", 445: "File sharing", 515: "Print (LPD)",
    554: "Video (RTSP)", 631: "Print (IPP)", 3389: "Remote Desktop", 5900: "VNC", 8080: "Web (8080)", 9100: "Print (RAW)",
};

export const discovery = {
    hosts: (p: { status?: HostStatus; q?: string; clientId?: string; siteId?: string; limit?: number; offset?: number }) => {
        const sp = new URLSearchParams();
        if (p.status) sp.set("status", p.status);
        if (p.q?.trim()) sp.set("q", p.q.trim());
        if (p.clientId) sp.set("clientId", p.clientId);
        if (p.siteId) sp.set("siteId", p.siteId);
        sp.set("limit", String(p.limit ?? 100));
        sp.set("offset", String(p.offset ?? 0));
        return jfetch<HostPage>(`/api/network-discovery/hosts?${sp.toString()}`);
    },
    runs: () => jfetch<{ items: DiscoveryRun[] }>("/api/network-discovery/runs"),
    run: (id: string) => jfetch<DiscoveryRun | null>(`/api/network-discovery/runs/${encodeURIComponent(id)}`),
    scanners: () => jfetch<{ items: Scanner[] }>("/api/network-discovery/scanners"),
    scan: (deviceId: string, ranges: string[]) => jfetch<{ runId: string; jobId: string; alreadyRunning: boolean; ranges: string[] }>("/api/network-discovery/scan", { method: "POST", body: { deviceId, ranges } }),
    schedules: () => jfetch<{ items: DiscoverySchedule[] }>("/api/network-discovery/schedules"),
    saveSchedule: (siteId: string, body: ScheduleWrite) => jfetch<DiscoverySchedule>(`/api/network-discovery/schedules/${encodeURIComponent(siteId)}`, { method: "PUT", body }),
    deleteSchedule: (siteId: string) => jfetch<{ deleted: boolean }>(`/api/network-discovery/schedules/${encodeURIComponent(siteId)}`, { method: "DELETE" }),
    /** Scans from several devices at once (a whole site, or a whole customer). Devices that cannot scan are skipped with a reason. */
    scanMany: (deviceIds: string[], ranges: string[]) => jfetch<ScanManyResult>("/api/network-discovery/scan-many", { method: "POST", body: { deviceIds, ranges } }),
    ignore: (ids: string[], ignored: boolean) => jfetch<{ changed: number }>("/api/network-discovery/ignore", { method: "POST", body: { ids, ignored } }),
};
