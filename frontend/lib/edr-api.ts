// lib/edr-api.ts
//
// EDR and antivirus consoles (Monitoring > EDR and antivirus). Read-only toward the console; credentials are never sent back.
import { jfetch } from "@/lib/api";

export type Vendor = "mde" | "sentinelone" | "huntress" | "crowdstrike";
export type Health = "healthy" | "warning" | "unhealthy" | "unknown";
export type Verdict = Health | "none";

export type VendorDef = { key: Vendor; label: string; fields: Array<{ name: string; label: string; secret?: boolean; help: string; options?: string[] }> };

export type EdrConnection = {
    id: string; vendor: Vendor; vendorName: string; name: string; clientId: string | null; customer: string | null; config: Record<string, string>;
    status: "pending" | "ok" | "error"; error: string | null; endpoints: number; lastSyncedAt: string | null; syncing: boolean;
};

export type EdrProduct = { vendor: Vendor; vendorName: string; connection: string; health: Health; detail: string; lastSeenAt: string | null; agentVersion: string | null };
export type EdrDevice = { deviceId: string; name: string; customer: string | null; clientId: string | null; site: string | null; os: "windows" | "linux"; online: boolean; verdict: Verdict; products: EdrProduct[] };
export type EdrUnmatched = { hostname: string; connection: string; vendor: Vendor; health: Health; lastSeenAt: string | null };

export type EdrCoverage = {
    connections: EdrConnection[];
    summary: { total: number; healthy: number; warning: number; unhealthy: number; unknown: number; none: number; coveredPercent: number | null };
    items: EdrDevice[];
    unmatched: EdrUnmatched[];
};

export const edr = {
    vendors: () => jfetch<{ vendors: VendorDef[] }>("/api/edr/vendors"),
    coverage: (qs = "") => jfetch<EdrCoverage>(`/api/edr/coverage${qs}`),
    create: (body: Record<string, unknown>) => jfetch<EdrConnection>("/api/edr/connections", { method: "POST", body }),
    update: (id: string, body: Record<string, unknown>) => jfetch<EdrConnection>(`/api/edr/connections/${encodeURIComponent(id)}`, { method: "PATCH", body }),
    sync: (id: string) => jfetch<EdrConnection>(`/api/edr/connections/${encodeURIComponent(id)}/sync`, { method: "POST", body: {} }),
    remove: (id: string) => jfetch<{ ok: boolean }>(`/api/edr/connections/${encodeURIComponent(id)}`, { method: "DELETE" }),
};
