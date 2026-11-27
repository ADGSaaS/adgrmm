"use client";
// Seat usage of a hosted plan: a small figure in the top bar, a banner under it, and a note on screens that add endpoints.
// All of it renders nothing when the install has no limits (self-hosted installs and the public demo).
import * as React from "react";
import { AlertTriangle, Info, X } from "lucide-react";
import { useEntitlements } from "@/lib/entitlements";

const TONE = {
    info: "border-sky-500/40 bg-sky-500/10",
    warn: "border-amber-500/50 bg-amber-500/10",
    error: "border-red-500/50 bg-red-500/10",
} as const;

const part = (label: string, used: number, max: number | null) => (max === null ? null : `${label} ${used}/${max}`);

/** "Endpoints 85/100 · Technicians 3/5", small, for the top bar. */
export function EntitlementsUsage() {
    const e = useEntitlements();
    if (!e || !e.usage || !e.limits) return null;
    const text = [part("Endpoints", e.usage.endpoints, e.limits.maxEndpoints), part("Technicians", e.usage.technicians, e.limits.maxTechnicians)].filter(Boolean).join(" · ");
    if (!text) return null;
    const level = e.banner?.level;
    const color = level === "error" ? "text-red-600 dark:text-red-400" : level === "warn" ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground";
    return (
        <span className={`hidden whitespace-nowrap text-xs xl:inline ${color}`} title="Seats used on your plan" data-testid="entitlements-usage">
            {text}
        </span>
    );
}

const dismissKey = (text: string) => `adg.entitlements.dismissed:${text.slice(0, 80)}`;
const readDismissed = (text: string) => {
    try { return window.sessionStorage.getItem(dismissKey(text)) === "1"; } catch { return false; }
};

/** The plan banner: warns near a limit, and stays (cannot be dismissed) when a limit is reached or payment failed. */
export function EntitlementsBanner() {
    const e = useEntitlements();
    const [hidden, setHidden] = React.useState<string | null>(null);
    const banner = e?.banner ?? null;
    React.useEffect(() => {
        if (banner && banner.level !== "error" && readDismissed(banner.text)) setHidden(banner.text);
    }, [banner]);
    if (!e || !banner || hidden === banner.text) return null;

    const dismissible = banner.level !== "error";
    const Icon = banner.level === "info" ? Info : AlertTriangle;
    return (
        <div role={banner.level === "error" ? "alert" : "status"} className={`flex items-start gap-2 border-b px-4 py-2 text-sm ${TONE[banner.level]}`} data-testid="entitlements-banner">
            <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <p className="min-w-0 flex-1 break-words">
                {banner.text}
                {e.upgradeUrl && !banner.text.includes(e.upgradeUrl) ? (
                    <> <a href={e.upgradeUrl} target="_blank" rel="noopener noreferrer" className="font-medium underline underline-offset-2">Manage plan</a></>
                ) : null}
            </p>
            {dismissible ? (
                <button
                    type="button"
                    aria-label="Dismiss"
                    className="shrink-0 rounded p-0.5 hover:bg-foreground/10"
                    onClick={() => {
                        setHidden(banner.text);
                        try { window.sessionStorage.setItem(dismissKey(banner.text), "1"); } catch { /* the banner just returns on reload */ }
                    }}
                >
                    <X className="h-4 w-4" aria-hidden="true" />
                </button>
            ) : null}
        </div>
    );
}

/** On screens that make installers or keys: says so when no new device can enroll. Nothing otherwise. */
export function EndpointLimitNote() {
    const e = useEntitlements();
    if (!e?.limits || e.limits.maxEndpoints === null || !e.usage) return null;
    if (e.usage.endpoints < e.limits.maxEndpoints) return null;
    return (
        <p role="alert" className="rounded-md border border-red-500/50 bg-red-500/10 p-2 text-sm">
            Your plan&apos;s endpoint limit ({e.limits.maxEndpoints}) is reached. New devices are refused when they try to enroll;
            devices already enrolled keep working.
            {e.upgradeUrl ? <> <a href={e.upgradeUrl} target="_blank" rel="noopener noreferrer" className="font-medium underline underline-offset-2">Upgrade your plan</a>.</> : null}
        </p>
    );
}
