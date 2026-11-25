"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export type Level = "global" | "customer" | "site" | "tag" | "device";
export type Assignment = { level: Level; targetId: string | null; exclude: boolean; targetName?: string | null };
export type Sections = {
    alerting?: { offlineAfterMinutes?: number; renotifyAfterHours?: number; autoTicket?: boolean; autoTicketMinSeverity?: "WARN" | "CRIT"; autoResolveTicket?: boolean; holdMinutes?: number; reopenWithinMinutes?: number };
    hours?: { days: number[]; start: string; end: string; timezone: string };
    remote?: { consent?: "off" | "notice" | "consent"; record?: boolean };
    software?: { required?: string[]; banned?: string[]; waive?: string[] };
    checks?: { profileIds: string[] };
    maintenance?: { windows: { name: string; days: number[]; start: string; end: string; timezone: string }[]; muteAlerts: boolean };
    patching?: { approve?: "none" | "critical" | "all"; installIn?: "anytime" | "maintenance"; reboot?: "never" | "maintenance" | "always"; appScanHours?: number; appUpdate?: "none" | "listed" | "all"; appUpdateIn?: "anytime" | "maintenance" };
    security?: { scanHours?: number; bitlockerEscrow?: "off" | "on" };
    laps?: { enabled?: boolean; account?: string; passwordLength?: number; rotateDays?: number; rotateAfterRevealMinutes?: number };
};
export type Policy = {
    id: string;
    name: string;
    description: string | null;
    enabled: boolean;
    priority: number;
    os: "any" | "windows" | "linux" | "macos";
    enforced: boolean;
    applyToNewCustomers: boolean;
    sections: Sections;
    version: number;
    sectionNames: string[];
    settingCount: number;
    assignments: Assignment[];
    devices?: number;
    updatedAt: string | null;
};
/** A policy kept as a pattern. It is never applied; people copy it to a global, customer, site or tag policy. */
export type PolicyTemplate = {
    id: string;
    name: string;
    description: string | null;
    priority: number;
    os: Policy["os"];
    enforced: boolean;
    sections: Sections;
    sectionNames: string[];
    updatedAt: string | null;
};

/** The editor works on policies, so a template is shown to it as a policy that applies to nothing. */
export const templateAsPolicy = (t: PolicyTemplate): Policy => ({
    id: t.id, name: t.name, description: t.description, enabled: true, priority: t.priority, os: t.os, enforced: t.enforced, applyToNewCustomers: false,
    sections: t.sections, version: 1, sectionNames: t.sectionNames, settingCount: 0, assignments: [], updatedAt: t.updatedAt,
});

export type Source = { kind: "policy"; policyId: string; name: string; level: Level; enforced: boolean; priority: number } | { kind: "default"; label: string };

export const LEVEL_LABEL: Record<Level, string> = { global: "Everyone", customer: "Customer", site: "Site", tag: "Tag", device: "Device" };
/** The kinds of policy people choose from, broadest first. Endpoint policies are not listed: they live on the endpoint's own page. */
export const POLICY_KINDS = ["global", "customer", "site", "tag"] as const;
export type PolicyKind = (typeof POLICY_KINDS)[number];
export const KIND_LABEL: Record<PolicyKind, string> = { global: "Global", customer: "Customer", site: "Site", tag: "Tag" };
export const KIND_HELP: Record<PolicyKind, string> = {
    global: "Every endpoint. The base the others build on.",
    customer: "Every endpoint of a customer.",
    site: "Every endpoint at a site.",
    tag: "Every endpoint that carries a tag.",
};

/** Where a policy applies, ignoring "switched off for" rows, broadest first. Empty when it is not assigned yet. */
export function policyKinds(p: Pick<Policy, "assignments">): PolicyKind[] {
    const on = new Set(p.assignments.filter((a) => !a.exclude).map((a) => a.level));
    return POLICY_KINDS.filter((k) => on.has(k));
}

/** A policy that reaches only single endpoints. Those are managed on the endpoint, so the policies list leaves them out. */
export const isEndpointOnly = (p: Pick<Policy, "assignments">) => p.assignments.some((a) => !a.exclude && a.level === "device") && policyKinds(p).length === 0;

export const OS_LABEL: Record<string, string> = { any: "Any system", windows: "Windows", linux: "Linux", macos: "macOS" };
export const SECTION_LABEL: Record<string, string> = { alerting: "Alerting", hours: "Hours", remote: "Remote access", software: "Software", checks: "Checks", maintenance: "Maintenance", patching: "Patching", security: "Security", laps: "Device secrets" };
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const DAY_NAMES = DAYS;

export const errorText = (e: unknown) => {
    if (!(e instanceof Error)) return "Something went wrong.";
    try {
        const body = JSON.parse(e.message) as { message?: string | string[] };
        const m = Array.isArray(body.message) ? body.message.join(" ") : body.message;
        if (m) return m;
    } catch {
        /* already words */
    }
    return e.message;
};

export function daysText(days: number[]): string {
    const d = [...days].sort((a, b) => a - b);
    if (d.join() === "1,2,3,4,5") return "Mon to Fri";
    if (d.length === 7) return "Every day";
    return d.map((x) => DAYS[x]).join(", ");
}

/** A setting's value in words. */
export function valueText(key: string, value: unknown): string {
    if (value === null || value === undefined) return "Not set";
    if (key === "hours") {
        const h = value as { days: number[]; start: string; end: string; timezone: string };
        return h.start === h.end ? `${daysText(h.days)}, all day (${h.timezone})` : `${daysText(h.days)}, ${h.start} to ${h.end} (${h.timezone})`;
    }
    if (key === "maintenance") {
        const m = value as { windows: { name: string; days: number[]; start: string; end: string; timezone: string }[]; muteAlerts: boolean };
        return m.windows.map((w) => `${w.name}: ${daysText(w.days)}, ${w.start === w.end ? "all day" : `${w.start} to ${w.end}`} (${w.timezone})`).join("; ") + (m.muteAlerts ? "; alerts held back" : "");
    }
    if (key === "patching.approve") return value === "all" ? "Every update" : value === "critical" ? "Critical and important updates (security on Linux)" : "No, install by hand";
    if (key === "patching.installIn") return value === "maintenance" ? "Only in a maintenance window" : "Any time";
    if (key === "patching.appScanHours") return Number(value) === 0 ? "Never, scan by hand" : `Every ${value} hours`;
    if (key === "security.scanHours") return Number(value) === 0 ? "Never, scan by hand" : `Every ${value} hours`;
    if (key === "security.bitlockerEscrow") return value === "on" ? "Collect and store disk recovery keys (BitLocker, LUKS)" : "Do not collect recovery keys";
    if (key === "laps.enabled") return value === true ? "Manage the local administrator password" : "Do not manage it";
    if (key === "laps.account") return `Account ${value}`;
    if (key === "laps.passwordLength") return `${value} characters`;
    if (key === "laps.rotateDays") return `Every ${value} ${Number(value) === 1 ? "day" : "days"}`;
    if (key === "laps.rotateAfterRevealMinutes") return Number(value) === 0 ? "Never, only on the schedule" : `${value} minutes after a reveal`;
    if (key === "patching.appUpdate") return value === "all" ? "Every outdated program except never-update ones" : value === "listed" ? "Only programs on the allowed list" : "No, update by hand";
    if (key === "patching.appUpdateIn") return value === "maintenance" ? "Only in a maintenance window" : "Any time";
    if (key === "patching.reboot") return value === "always" ? "As soon as an update needs it" : value === "maintenance" ? "In a maintenance window" : "Never, restart by hand";
    if (key === "alerting.holdMinutes") return Number(value) === 0 ? "Alert at once" : `${value} minutes`;
    if (key === "alerting.reopenWithinMinutes") return Number(value) === 0 ? "Start a new alert" : `Within ${value} minutes`;
    if (key === "alerting.offlineAfterMinutes") return `${value} minutes`;
    if (key === "alerting.renotifyAfterHours") return Number(value) === 0 ? "Never" : `Every ${value} hours`;
    if (typeof value === "boolean") return value ? "On" : "Off";
    if (key === "remote.consent") return value === "consent" ? "Ask permission first" : value === "off" ? "Show nothing" : "Show a notice";
    if (key === "alerting.autoTicketMinSeverity") return value === "WARN" ? "Warning and above" : "Critical only";
    if (Array.isArray(value)) return value.length ? value.join(", ") : "None";
    return String(value);
}

export function SourceBadge({ source }: { source: Source }) {
    if (source.kind === "default") return <span className="rounded border border-border px-1.5 py-0.5 text-xs text-muted-foreground">{source.label}</span>;
    return (
        <span className="inline-flex flex-wrap items-center gap-1 text-xs">
            <span className="font-medium">{source.name}</span>
            <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">{LEVEL_LABEL[source.level]}</span>
            {source.enforced && <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-600 dark:text-amber-400">Enforced</span>}
        </span>
    );
}

export function Pill({ children, tone = "muted" }: { children: React.ReactNode; tone?: "muted" | "good" | "warn" | "bad" }) {
    return (
        <span
            className={cn(
                "inline-flex items-center rounded px-1.5 py-0.5 text-xs",
                tone === "muted" && "bg-muted text-muted-foreground",
                tone === "good" && "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
                tone === "warn" && "bg-amber-500/15 text-amber-600 dark:text-amber-400",
                tone === "bad" && "bg-red-500/15 text-red-600 dark:text-red-400",
            )}
        >
            {children}
        </span>
    );
}

/** A label, a field, and a line under it that is always there, so a message never pushes the next field down. */
export function Field({ label, htmlFor, error, hint, className, children }: { label: string; htmlFor: string; error?: string; hint?: string; className?: string; children: React.ReactNode }) {
    return (
        <div className={cn("grid gap-1", className)}>
            <label htmlFor={htmlFor} className={cn("text-sm font-medium leading-none", error && "text-destructive")}>{label}</label>
            {children}
            <p className={cn("min-h-4 text-xs", error ? "text-destructive" : "text-muted-foreground")}>{error ?? hint ?? ""}</p>
        </div>
    );
}

export const selectClass = "h-10 w-full rounded-md border border-input bg-background px-2 text-sm";
export const badClass = "border-destructive focus-visible:ring-destructive";

export function assignmentSummary(p: Pick<Policy, "assignments">): string {
    const a = p.assignments;
    if (!a.length) return "Not assigned yet";
    const on = a.filter((x) => !x.exclude);
    const off = a.filter((x) => x.exclude);
    const count = (list: Assignment[], level: Level, one: string) => {
        const n = list.filter((x) => x.level === level).length;
        return n ? `${n} ${one}${n === 1 ? "" : "s"}` : null;
    };
    const parts = [on.some((x) => x.level === "global") ? "Everyone" : null, count(on, "customer", "customer"), count(on, "site", "site"), count(on, "tag", "tag"), count(on, "device", "device")].filter(Boolean);
    const excluded = off.length ? ` (not ${off.length} excluded)` : "";
    return (parts.join(", ") || "Nothing but exclusions") + excluded;
}
