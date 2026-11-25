"use client";

// components/overview/fleet-breakdown.tsx
//
// The charts of the fleet breakdown (the page's original charts, kept under their original keys): devices by system, by status
// and system, by customer and site, and the list of offline devices. They stay readable for a handful of devices and for
// thousands: long lists of customers and sites are cut to the biggest ones, with the rest grouped as "Other".
import * as React from "react";
import Link from "next/link";
import {
    ResponsiveContainer, PieChart, Pie, Cell, Legend, Tooltip as RTooltip, BarChart, Bar, CartesianGrid, XAxis, YAxis,
} from "recharts";
import { Card } from "@/components/ui/card";
import type { Device as ApiDevice, DeviceCounts } from "@/lib/api";
import { ago, fmt, fmtCompact } from "./format";
import { Bone, MoveHandle } from "./parts";

const OS_KEYS = ["Windows", "Linux", "macOS"] as const;
const MAX_CUSTOMERS = 10;
const MAX_SITES = 6;

const HUES: Record<string, string> = {
    Online: "hsl(160 55% 42%)",
    Offline: "hsl(220 10% 58%)",
    Windows: "hsl(217 80% 60%)",
    Linux: "hsl(173 60% 42%)",
    macOS: "hsl(262 60% 66%)",
    Other: "hsl(220 10% 68%)",
};
const PALETTE = ["hsl(210 75% 58%)", "hsl(275 60% 68%)", "hsl(160 60% 42%)", "hsl(25 80% 58%)", "hsl(335 65% 62%)", "hsl(45 80% 52%)", "hsl(190 70% 48%)", "hsl(125 45% 42%)"];
const pick = (i: number) => PALETTE[i % PALETTE.length];

const AXIS = { tickLine: false, axisLine: false, tick: { fill: "hsl(var(--muted-foreground))", fontSize: 12 } } as const;
const TOOLTIP = {
    contentStyle: {
        background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 12, color: "hsl(var(--popover-foreground))",
        boxShadow: "0 12px 32px -12px rgba(0,0,0,0.35)", fontSize: 12,
    },
    itemStyle: { color: "hsl(var(--popover-foreground))" },
    cursor: { fill: "hsl(var(--muted) / 0.5)" },
} as const;
const LEGEND = { iconType: "circle" as const, iconSize: 8, wrapperStyle: { fontSize: 12, color: "hsl(var(--muted-foreground))" } };

/** Devices in no customer or site are shown with an em dash, as in the device list. */
const nameOf = (n: string | null) => (n && n.trim() ? n : "—");

type Datum = { name: string; value: number };

/** The biggest `max` entries, and everything else added up as "Other". */
function topWithOther(rows: Datum[], max: number): Datum[] {
    const sorted = [...rows].filter((r) => r.value > 0).sort((a, b) => b.value - a.value);
    if (sorted.length <= max) return sorted;
    const rest = sorted.slice(max - 1).reduce((n, r) => n + r.value, 0);
    return [...sorted.slice(0, max - 1), { name: "Other", value: rest }];
}

export type BreakdownData = {
    counts: DeviceCounts | null;
    offline: ApiDevice[];
    loading: boolean;
    error: string | null;
};

function osBuckets(c: DeviceCounts | null) {
    const o = c?.byOs;
    const none = { total: 0, online: 0, offline: 0, withAlerts: 0 };
    // A system the agent did not name counts as Windows, as it always has on this page.
    const win = { total: (o?.windows.total ?? 0) + (o?.other.total ?? 0), online: (o?.windows.online ?? 0) + (o?.other.online ?? 0), offline: (o?.windows.offline ?? 0) + (o?.other.offline ?? 0) };
    return { Windows: win, Linux: o?.linux ?? none, macOS: o?.macos ?? none };
}

function ChartShell({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
    return (
        <Card className="group/card flex h-full flex-col p-5" role="region" aria-label={title}>
            <div className="flex shrink-0 items-start justify-between gap-2">
                <div className="min-w-0">
                    <h3 className="truncate text-sm font-semibold tracking-tight">{title}</h3>
                    {hint ? <p className="mt-0.5 truncate text-xs text-muted-foreground">{hint}</p> : null}
                </div>
                <MoveHandle label={title} />
            </div>
            <div className="mt-3 min-h-0 flex-1">{children}</div>
        </Card>
    );
}

function Empty({ children }: { children: React.ReactNode }) {
    return <div className="flex h-full items-center justify-center px-4 text-center text-sm text-muted-foreground">{children}</div>;
}

function Donut({ title, hint, data, loading }: { title: string; hint?: string; data: Datum[]; loading: boolean }) {
    const total = data.reduce((n, d) => n + d.value, 0);
    return (
        <ChartShell title={title} hint={hint}>
            {loading ? <Bone className="h-full w-full" /> : total === 0 ? <Empty>No devices to chart yet.</Empty> : (
                <div className="relative h-full" role="img" aria-label={`${title}: ${data.filter((d) => d.value > 0).map((d) => `${fmt(d.value)} ${d.name}`).join(", ")}`}>
                    <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                            <Pie data={data} dataKey="value" nameKey="name" innerRadius="62%" outerRadius="84%" paddingAngle={data.filter((d) => d.value > 0).length > 1 ? 2 : 0} cornerRadius={5} stroke="none" isAnimationActive={false}>
                                {data.map((d, i) => <Cell key={d.name} fill={HUES[d.name] ?? pick(i)} />)}
                            </Pie>
                            <Legend verticalAlign="bottom" height={24} {...LEGEND} />
                            <RTooltip {...TOOLTIP} formatter={(v) => fmt(Number(v))} />
                        </PieChart>
                    </ResponsiveContainer>
                    <div className="pointer-events-none absolute inset-x-0 top-0 flex h-[calc(100%-24px)] flex-col items-center justify-center">
                        <span className="text-2xl font-semibold leading-none tracking-tight tabular-nums">{fmtCompact(total)}</span>
                        <span className="mt-1 text-xs text-muted-foreground">devices</span>
                    </div>
                </div>
            )}
        </ChartShell>
    );
}

function StatusByOs({ counts, loading }: { counts: DeviceCounts | null; loading: boolean }) {
    const b = osBuckets(counts);
    const rows = OS_KEYS.map((os) => ({ os, Online: b[os].online, Offline: b[os].offline }));
    const total = rows.reduce((n, r) => n + r.Online + r.Offline, 0);
    return (
        <ChartShell title={"Status × OS"} hint="Online and offline devices on each system">
            {loading ? <Bone className="h-full w-full" /> : total === 0 ? <Empty>No devices to chart yet.</Empty> : (
                <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={rows} margin={{ left: 0, right: 8 }}>
                        <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="hsl(var(--border))" />
                        <XAxis dataKey="os" {...AXIS} />
                        <YAxis allowDecimals={false} width={44} tickFormatter={(v) => fmtCompact(Number(v))} {...AXIS} />
                        <Legend {...LEGEND} />
                        <RTooltip {...TOOLTIP} formatter={(v) => fmt(Number(v))} />
                        <Bar dataKey="Online" stackId="s" fill={HUES.Online} isAnimationActive={false} />
                        <Bar dataKey="Offline" stackId="s" fill={HUES.Offline} radius={[5, 5, 0, 0]} isAnimationActive={false} />
                    </BarChart>
                </ResponsiveContainer>
            )}
        </ChartShell>
    );
}

function ClientsSites({ counts, loading }: { counts: DeviceCounts | null; loading: boolean }) {
    const { matrix, sites, shown, all } = React.useMemo(() => {
        const clients = (counts?.clients ?? []).filter((c) => c.total > 0).sort((a, b) => b.total - a.total);
        const picked = clients.slice(0, MAX_CUSTOMERS);
        // The sites that hold the most devices across the chosen customers; the rest are one "Other" series.
        const siteTotals = new Map<string, number>();
        for (const c of picked) for (const s of c.sites) siteTotals.set(nameOf(s.name), (siteTotals.get(nameOf(s.name)) ?? 0) + s.total);
        const top = [...siteTotals.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_SITES).map(([n]) => n);
        const keep = new Set(top);
        const hasOther = siteTotals.size > top.length;
        const rows = picked.map((c) => {
            const row: Record<string, string | number> = { client: nameOf(c.name) };
            for (const s of c.sites) {
                const k = keep.has(nameOf(s.name)) ? nameOf(s.name) : "Other";
                row[k] = ((row[k] as number) ?? 0) + s.total;
            }
            return row;
        });
        return { matrix: rows, sites: hasOther ? [...top, "Other"] : top, shown: picked.length, all: clients.length };
    }, [counts]);
    return (
        <ChartShell title={"Customers → Sites"} hint={all > shown ? `Share of devices per site · biggest ${shown} of ${fmt(all)} customers` : "Share of devices per site"}>
            {loading ? <Bone className="h-full w-full" /> : matrix.length === 0 ? <Empty>No devices to chart yet.</Empty> : (
                <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={matrix} stackOffset="expand" layout="vertical" margin={{ left: 0, right: 8 }}>
                        <CartesianGrid horizontal={false} strokeDasharray="3 3" stroke="hsl(var(--border))" />
                        <XAxis type="number" tickFormatter={(v) => `${Math.round((v as number) * 100)}%`} {...AXIS} />
                        <YAxis type="category" dataKey="client" width={132} interval={0} tickFormatter={(v: string) => (v.length > 20 ? `${v.slice(0, 19)}…` : v)} {...AXIS} />
                        <Legend {...LEGEND} />
                        <RTooltip {...TOOLTIP} formatter={(v) => fmt(Number(v))} />
                        {sites.map((site, i) => <Bar key={site} dataKey={site} stackId="a" fill={site === "Other" ? HUES.Other : pick(i)} isAnimationActive={false} />)}
                    </BarChart>
                </ResponsiveContainer>
            )}
        </ChartShell>
    );
}

function OfflineList({ offline, total, loading, error }: { offline: ApiDevice[]; total: number; loading: boolean; error: string | null }) {
    return (
        <ChartShell title="Offline devices" hint="Devices that have not checked in, most recently seen first">
            {loading ? <Bone className="h-full w-full" /> : error ? <Empty>{error}</Empty> : offline.length === 0 ? <Empty>Everything has checked in recently.</Empty> : (
                <div className="h-full overflow-auto">
                    <table className="w-full text-sm">
                        <thead className="sticky top-0 bg-card text-left text-xs text-muted-foreground">
                            <tr className="border-b">
                                <th scope="col" className="py-2 pr-3 font-medium">Device</th>
                                <th scope="col" className="hidden py-2 pr-3 font-medium sm:table-cell">Customer</th>
                                <th scope="col" className="hidden py-2 pr-3 font-medium md:table-cell">Site</th>
                                <th scope="col" className="py-2 text-right font-medium">Last seen</th>
                            </tr>
                        </thead>
                        <tbody>
                            {offline.map((d) => (
                                <tr key={d.id} className="border-b border-border/60 last:border-0 hover:bg-muted/40">
                                    <td className="max-w-[10rem] truncate py-2 pr-3 font-medium"><Link href={`/devices/${encodeURIComponent(d.id)}`} className="rounded-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">{d.hostname}</Link></td>
                                    <td className="hidden max-w-[10rem] truncate py-2 pr-3 text-muted-foreground sm:table-cell">{d.client ?? "—"}</td>
                                    <td className="hidden max-w-[10rem] truncate py-2 pr-3 text-muted-foreground md:table-cell">{d.site ?? "—"}</td>
                                    <td className="whitespace-nowrap py-2 text-right text-muted-foreground">{ago(d.lastSeen)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    {total > offline.length ? <p className="py-2 text-xs text-muted-foreground">Showing {fmt(offline.length)} of {fmt(total)} offline devices. Open the device list to see them all.</p> : null}
                </div>
            )}
        </ChartShell>
    );
}

/** One chart of the breakdown by its key, or null for a key that is not a chart. */
export function BreakdownChart({ cardKey, data }: { cardKey: string; data: BreakdownData }) {
    const { counts, loading } = data;
    const b = React.useMemo(() => osBuckets(counts), [counts]);
    const clients = React.useMemo(() => {
        const byClient = new Map<string, number>();
        for (const c of counts?.clients ?? []) byClient.set(nameOf(c.name), (byClient.get(nameOf(c.name)) ?? 0) + c.total);
        return topWithOther([...byClient.entries()].map(([name, value]) => ({ name, value })), 8);
    }, [counts]);
    switch (cardKey) {
        case "donut-os": return <Donut title="OS distribution" hint="Devices by operating system" loading={loading} data={OS_KEYS.map((k) => ({ name: k, value: b[k].total }))} />;
        case "heat-status-os": return <StatusByOs counts={counts} loading={loading} />;
        case "stack-client-sites": return <ClientsSites counts={counts} loading={loading} />;
        case "donut-client": return <Donut title="Devices by customer" hint={(counts?.clients.length ?? 0) > 8 ? "Biggest customers; the rest grouped as Other" : "Devices per customer"} loading={loading} data={clients} />;
        case "table-offline": return <OfflineList offline={data.offline} total={counts?.offline ?? 0} loading={loading} error={data.error} />;
        case "donut-status": return <Donut title="Status" hint="Online and offline devices" loading={loading} data={[{ name: "Online", value: counts?.online ?? 0 }, { name: "Offline", value: counts?.offline ?? 0 }]} />;
        default: return null;
    }
}
