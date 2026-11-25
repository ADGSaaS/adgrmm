"use client";

// components/overview/status-strip.tsx
//
// Five small tiles: Online, Offline, Critical, Warning, Total. Each opens the matching list. Critical and Warning count devices
// with an open critical alert, or open alerts that are all warnings; they show only to people who may see alerts. A number is
// coloured only when there is something to do about it.
import * as React from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import type { DashboardSummary } from "@/lib/dashboard-api";
import { fmt, pct } from "./format";
import { Bone } from "./parts";
import { useNav } from "./nav";

type Tile = { key: string; label: string; value: number; sub: string; dot?: string; alarm?: "bad" | "warn"; route: string; query: Record<string, string>; aria: string };

export function tilesOf(s: Pick<DashboardSummary, "devices" | "alerts">, hidden: (key: string) => boolean): Tile[] {
    const d = s.devices;
    if (!d) return [];
    const a = s.alerts;
    const all: Tile[] = [
        { key: "kpi-healthy", label: "Online", value: d.online, sub: `${pct(d.online, d.total)} of devices`, dot: "bg-emerald-500", route: "/customers", query: { status: "online" }, aria: "online devices" },
        { key: "kpi-offline", label: "Offline", value: d.offline, sub: d.offlineOver24h ? `${fmt(d.offlineOver24h)} for over a day` : "none for over a day", dot: "bg-slate-400", route: "/customers", query: { status: "offline" }, aria: "offline devices" },
        ...(a ? [
            { key: "kpi-critical", label: "Critical", value: a.devicesCritical, sub: a.devicesCritical ? "need action now" : "all quiet", alarm: "bad" as const, route: "/alerts", query: { severity: "CRIT" }, aria: "devices with a critical alert (need action now)" },
            { key: "kpi-warning", label: "Warning", value: a.devicesWarning, sub: a.devicesWarning ? "worth a look" : "all quiet", alarm: "warn" as const, route: "/alerts", query: { severity: "WARN" }, aria: "devices with warnings" },
        ] : []),
        { key: "kpi-total", label: "Total", value: d.total, sub: d.total === 1 ? "device" : "devices", route: "/customers", query: {}, aria: "all devices" },
    ];
    return all.filter((t) => !hidden(t.key));
}

export function StatusStrip({ tiles, loading }: { tiles: Tile[] | null; loading: boolean }) {
    const nav = useNav();
    if (loading && !tiles) {
        return (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5" role="status" aria-label="Loading device status">
                {[0, 1, 2, 3, 4].map((i) => <Bone key={i} className={cn("h-[92px]", i === 4 && "col-span-2 sm:col-span-1")} />)}
            </div>
        );
    }
    if (!tiles || tiles.length === 0) return null;
    return (
        <ul aria-label="Device status" className={cn("grid grid-cols-2 gap-3", tiles.length >= 5 ? "sm:grid-cols-5" : tiles.length === 4 ? "sm:grid-cols-4" : tiles.length === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2")}>
            {tiles.map((t, i) => (
                <li key={t.key} className={cn(tiles.length % 2 === 1 && i === tiles.length - 1 && "col-span-2 sm:col-span-1")}>
                    <Link
                        href={nav.href(t.route, t.query)}
                        onClick={(e) => nav.click(e, t.route, t.query)}
                        aria-label={`${fmt(t.value)} ${t.aria}`}
                        className="block h-full rounded-xl border border-border/70 bg-card p-4 outline-none transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
                    >
                        <span className="flex items-center gap-2 text-sm text-muted-foreground">
                            {t.dot ? <span className={cn("h-2 w-2 rounded-full", t.dot)} aria-hidden /> : null}
                            {t.label}
                        </span>
                        <span className={cn("mt-1 block text-2xl font-semibold leading-tight tracking-tight tabular-nums",
                            t.value > 0 && t.alarm === "bad" && "text-red-600 dark:text-red-400", t.value > 0 && t.alarm === "warn" && "text-amber-600 dark:text-amber-400")}>
                            {fmt(t.value)}
                        </span>
                        <span className="mt-0.5 block truncate text-xs text-muted-foreground">{t.sub}</span>
                    </Link>
                </li>
            ))}
        </ul>
    );
}
