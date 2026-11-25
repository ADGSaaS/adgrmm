// lib/dashboard-api.ts
//
// The Overview page's one summary call (GET /api/dashboard/summary). Every section is null when the person may not see it.
import { jfetch } from "@/lib/api";

export type Severity = "critical" | "warning" | "info";
export type Grade = "A" | "B" | "C" | "D" | "F" | "none";

export type AttentionItem = {
    id: string;
    severity: Severity;
    count: number;
    /** One plain sentence that already holds the count. */
    text: string;
    area: "alerts" | "tickets" | "security" | "devices" | "patching" | "agents";
    /** The page that shows exactly these things, and the filters to open it with. */
    route: string;
    query: Record<string, string>;
};

export type DashboardSummary = {
    generatedAt: string;
    cacheSeconds: number;
    clientId: string | null;
    access: { devices: boolean; alerts: boolean; tickets: boolean; schedule: boolean; activity: boolean; release: boolean; customers: boolean; security: boolean; patching: boolean; agents: boolean };
    setup: { hasDevices: boolean; customers: number | null } | null;
    attention: AttentionItem[];
    devices: { total: number; online: number; offline: number; offlineOver24h: number; neverCheckedIn: number } | null;
    alerts: { open: number; openCritical: number; acknowledged: number; silenced: number; devicesCritical: number; devicesWarning: number } | null;
    security: {
        windowsDevices: number; withAgent: number; scanned: number; neverScanned: number; stale: number; lastScanFailed: number;
        averageScore: number | null; devicesWithCriticalFailures: number; devicesNeedingAction: number; grades: Record<Grade, number>;
        topFailingRules: Array<{ id: string; title: string; severity: string; group: string; devices: number }>;
    } | null;
    patching: {
        devicesWithAgent: number; scanned: number; neverScanned: number; withPendingUpdates: number; needRestart: number; installFailed: number;
        outdatedSoftwareDevices: number; outdatedSoftwareApps: number;
    } | null;
    agents: {
        devicesWithAgent: number; latestVersion: string | null; onLatest: number; distinctVersions: number; pilotDevices: number;
        versions: Array<{ version: string; devices: number; pilot: number }>;
        otherVersions: { versions: number; devices: number } | null;
        release: Array<{ os: string; version: string }> | null;
    } | null;
    tickets: { open: number; unassigned: number; breached: number; warning: number; hasTickets: boolean } | null;
    schedule: {
        today: number; remainingToday: number; doneToday: number; nextSevenDays: number; timeZone: string;
        next: { title: string; startsAt: string; customer: string | null } | null;
    } | null;
    activity: { items: Array<{ id: string; at: string; actor: string; text: string; failed: boolean }>; allCustomers: boolean } | null;
};

export function fetchDashboardSummary(clientId?: string | null, init?: { signal?: AbortSignal }): Promise<DashboardSummary> {
    const qs = clientId ? `?clientId=${encodeURIComponent(clientId)}` : "";
    return jfetch<DashboardSummary>(`/api/dashboard/summary${qs}`, init);
}
