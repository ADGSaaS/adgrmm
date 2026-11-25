// lib/m365-api.ts
//
// Microsoft 365 tenants of customers (Monitoring > Microsoft 365). Read-only toward Microsoft.
import { jfetch } from "@/lib/api";

export type Severity = "critical" | "warning" | "info";
export type Finding = { id: string; severity: Severity; title: string; detail: string };

export type M365Summary = {
    organization: { name: string | null; domains: string[] };
    counts: { users: number; members: number; guests: number; enabled: number; disabled: number; licensed: number } | null;
    licenses: Array<{ sku: string; name: string; enabled: number; consumed: number; available: number; free: boolean }>;
    mfa: { checked: number; registered: number; missing: number; missingList: Array<{ name: string; upn: string }> } | null;
    admins: Array<{ role: string; members: Array<{ name: string; upn: string; mfa: boolean | null }> }>;
    conditionalAccess: { total: number; enabled: number; securityDefaults: boolean | null } | null;
    score: { current: number; max: number; percent: number } | null;
    wasted: Array<{ name: string; upn: string; why: string }>;
    inactive: Array<{ name: string; upn: string; lastSignIn: string | null }>;
    findings: Finding[];
    health: number | null;
    notRead: Record<string, string>;
    readAt: string;
};

export type M365Tenant = {
    id: string; clientId: string; customer: string | null; tenant: string; appId: string; name: string; status: "pending" | "ok" | "partial" | "error"; error: string | null;
    lastSyncedAt: string | null; syncing: boolean; health: number | null; critical: number; warnings: number; users: number | null; summary?: M365Summary | null;
};

export const m365 = {
    list: () => jfetch<{ items: M365Tenant[] }>("/api/m365/tenants"),
    get: (id: string) => jfetch<M365Tenant>(`/api/m365/tenants/${encodeURIComponent(id)}`),
    create: (body: { clientId: string; tenant: string; appId: string; secret: string }) => jfetch<M365Tenant>("/api/m365/tenants", { method: "POST", body }),
    update: (id: string, body: { appId?: string; secret?: string }) => jfetch<M365Tenant>(`/api/m365/tenants/${encodeURIComponent(id)}`, { method: "PATCH", body }),
    sync: (id: string) => jfetch<M365Tenant>(`/api/m365/tenants/${encodeURIComponent(id)}/sync`, { method: "POST", body: {} }),
    remove: (id: string) => jfetch<{ ok: boolean }>(`/api/m365/tenants/${encodeURIComponent(id)}`, { method: "DELETE" }),
};
