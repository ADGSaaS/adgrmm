// lib/tools-api.ts
//
// The Tools menu: actions on many devices chosen by a scope (everything, a customer or a site) and the two server tools.
import { jfetch } from "@/lib/api";

export type ToolScope = { kind: "all" | "client" | "site" | "tag"; clientId?: string; siteId?: string; tagId?: string; /** Devices the person unticked: left out of the run. */ exclude?: string[]; os: "any" | "windows" | "linux"; onlineOnly: boolean };

export const DEFAULT_SCOPE: ToolScope = { kind: "all", os: "any", onlineOnly: false };

export type ScopePreview = { total: number; windows: number; linux: number; other: number; online: number; offline: number; capped: boolean; max: number; sample: string[]; devices?: ScopeDevice[]; devicesCapped?: boolean };
export type ScopeDevice = { id: string; name: string; os: "windows" | "linux" | "other"; online: boolean };

export type ToolRun = {
    requested: number; succeeded: number; skipped: number; failed: number;
    batches: Array<{ batchId: string; summary: string; requested: number; succeeded: number; skipped: number; failed: number }>;
};

export type MaintenanceTask = { key: string; title: string; description: string; defaultDays: number };

const wire = (scope: ToolScope) => ({
    kind: scope.kind,
    ...(scope.kind === "client" ? { clientId: scope.clientId } : {}),
    ...(scope.kind === "site" ? { siteId: scope.siteId } : {}),
    ...(scope.kind === "tag" ? { tagId: scope.tagId } : {}),
    ...(scope.exclude?.length ? { exclude: scope.exclude } : {}),
    os: scope.os,
    onlineOnly: scope.onlineOnly,
});

/** A scope is ready when a customer or a site is chosen where one is needed. */
export const scopeReady = (s: ToolScope) => s.kind === "all" || (s.kind === "client" && !!s.clientId) || (s.kind === "site" && !!s.siteId) || (s.kind === "tag" && !!s.tagId);

export const tools = {
    preview: (scope: ToolScope) => jfetch<ScopePreview>("/api/tools/preview", { method: "POST", body: { scope: wire({ ...scope, exclude: undefined }) } }),
    command: (scope: ToolScope, body: { script: string; shell?: "powershell" | "bash" | "cmd"; timeoutSec?: number }) =>
        jfetch<ToolRun>("/api/tools/command", { method: "POST", body: { scope: wire(scope), ...body } }),
    script: (scope: ToolScope, scriptId: string, parameters: Record<string, string>) =>
        jfetch<ToolRun>("/api/tools/script", { method: "POST", body: { scope: wire(scope), scriptId, parameters } }),
    patches: (scope: ToolScope, action: "scan" | "install-critical" | "install-all", includeOptional: boolean) =>
        jfetch<ToolRun>("/api/tools/patches", { method: "POST", body: { scope: wire(scope), action, includeOptional } }),
    recover: (scope: ToolScope) => jfetch<ToolRun>("/api/tools/recover-agents", { method: "POST", body: { scope: wire(scope) } }),
    maintenanceList: () => jfetch<{ min: number; max: number; tasks: MaintenanceTask[] }>("/api/tools/maintenance"),
    maintenancePreview: (tasks: Array<{ key: string; days: number }>) =>
        jfetch<{ items: Array<{ key: string; title: string; days: number; count: number }> }>("/api/tools/maintenance/preview", { method: "POST", body: { tasks } }),
    maintenanceRun: (tasks: Array<{ key: string; days: number }>, optimize: boolean) =>
        jfetch<{ items: Array<{ key: string; title: string; days: number; removed: number; more: boolean }>; optimized: boolean }>("/api/tools/maintenance/run", { method: "POST", body: { tasks, optimize } }),
    clearCache: () => jfetch<{ cleared: string[] }>("/api/tools/clear-cache", { method: "POST", body: {} }),
};

export type SavedScript = { id: string; name: string; description: string | null; language: "powershell" | "bash"; script: string; parameters: Array<{ name: string; label?: string; required?: boolean; defaultValue?: string }>; builtin?: boolean; category?: string; platform?: "windows" | "linux" | "both" | "all" };
export const fetchScripts = () => jfetch<{ items: SavedScript[] }>("/api/scripts");

/** An error body from the server as plain words. */
export function toolError(e: unknown): string {
    const raw = e instanceof Error ? e.message : "Something went wrong.";
    try {
        const j = JSON.parse(raw) as { message?: string | string[] };
        return Array.isArray(j.message) ? j.message.join(" ") : j.message ?? raw;
    } catch {
        return raw;
    }
}
