// lib/endpoint-backups-api.ts
//
// Backup status of customers' computers (Devices > Endpoint backups) and the customer backup report.
import { apiUrl, jfetch } from "@/lib/api";

export type Overall = "ok" | "warning" | "failed" | "unknown" | "none";

export type BackupProduct = { product: string; kind: string; state: string; lastSuccessAt: string | null; lastAttemptAt: string | null; detail: string | null };

export type BackupItem = {
    deviceId: string; name: string; clientId: string | null; customer: string | null; site: string | null; os: "windows" | "linux"; online: boolean;
    overall: Overall | null; detail: string | null; lastSuccessAt: string | null; checkedAt: string | null; checking: boolean; problem: string | null; products: BackupProduct[];
};

export type BackupSettings = { enabled: boolean; warnHours: number; failHours: number; checkHours: number; alerts: boolean };

export type BackupList = {
    settings: BackupSettings;
    items: BackupItem[];
    summary: { total: number; ok: number; warning: number; failed: number; none: number; unknown: number; unchecked: number };
};

export const endpointBackups = {
    list: (qs = "") => jfetch<BackupList>(`/api/endpoint-backups${qs}`),
    check: (body: { deviceId?: string; clientId?: string }) => jfetch<{ started: number; offline: number; total: number }>("/api/endpoint-backups/check", { method: "POST", body }),
    settings: () => jfetch<BackupSettings>("/api/endpoint-backups/settings"),
    saveSettings: (body: Partial<BackupSettings>) => jfetch<BackupSettings>("/api/endpoint-backups/settings", { method: "PUT", body }),
    /** The address of the customer's report as a spreadsheet (the browser downloads it with the person's own sign-in). */
    reportCsv: (clientId?: string) => apiUrl(`/api/endpoint-backups/report?format=csv${clientId ? `&clientId=${encodeURIComponent(clientId)}` : ""}`),
};
