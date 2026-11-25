// components/reports/full-report.tsx
//
// The All report: everything in one document, for a device, a site, a customer or everything, as a PDF or an Excel
// workbook. Also the small Export report menu that sits on a device's page.
"use client";

import * as React from "react";
import { Download, FileSpreadsheet, FileText } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { apiUrl, fetchCustomers, fetchCustomerSites, jfetch, type CustomerClient } from "@/lib/api";

const selectClass = "h-10 rounded-md border border-input bg-background px-2 text-sm";
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

export type Scope = { clientId?: string; siteId?: string; deviceId?: string; from?: string; to?: string };

export type Mode = "full" | "qbr" | "custom";

export const fullReportPath = (scope: Scope, format: "pdf" | "xlsx" | "summary", mode: Mode = "full", customId?: string) => {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...scope, format })) if (v) sp.set(k, v);
    const base = mode === "custom" && customId ? `/api/reports/custom/${customId}/run` : mode === "qbr" ? "/api/reports/qbr" : "/api/reports/full";
    return `${base}?${sp.toString()}`;
};

type Summary = {
    kind?: "full" | "qbr" | "custom";
    intro?: string | null;
    recommendations?: string[];
    highlights?: string[];
    title: string;
    generatedAt: string;
    scope: { customer: string | null; site: string | null; device: string | null };
    period: { from: string; to: string } | null;
    scorecard: Array<{ label: string; value: string; detail?: string; tone: "good" | "warn" | "bad" | "neutral" }>;
    sections: Array<{ key: string; title: string; rows: number }>;
    omitted: Array<{ key: string; title: string; reason: string }>;
};

const TONE: Record<string, string> = {
    good: "border-l-emerald-600",
    warn: "border-l-amber-500",
    bad: "border-l-red-600",
    neutral: "border-l-foreground/60",
};

/** Devices that could be chosen for a customer or site, as the reports know them. */
export function useDeviceChoices(clientId: string, siteId: string) {
    const [devices, setDevices] = React.useState<Array<{ id: string; name: string }>>([]);
    React.useEffect(() => {
        if (!clientId) {
            setDevices([]);
            return;
        }
        let stale = false;
        const sp = new URLSearchParams({ clientId });
        if (siteId) sp.set("siteId", siteId);
        jfetch<{ rows: Array<{ deviceId?: string; name?: string }> }>(`/api/reports/run/hardware-inventory?${sp.toString()}`)
            .then((r) => {
                if (stale) return;
                const list = r.rows.filter((row) => row.deviceId).map((row) => ({ id: String(row.deviceId), name: String(row.name ?? row.deviceId) }));
                setDevices(list.sort((a, b) => a.name.localeCompare(b.name)));
            })
            .catch(() => { if (!stale) setDevices([]); });
        return () => { stale = true; };
    }, [clientId, siteId]);
    return devices;
}

export function useSites(clientId: string) {
    const [sites, setSites] = React.useState<Array<{ id: string; name: string }>>([]);
    React.useEffect(() => {
        if (!clientId) {
            setSites([]);
            return;
        }
        let stale = false;
        fetchCustomerSites(clientId).then((list) => { if (!stale) setSites(list.map((s) => ({ id: s.id, name: s.name }))); }).catch(() => { if (!stale) setSites([]); });
        return () => { stale = true; };
    }, [clientId]);
    return sites;
}

export function FullReportPanel({ mode = "full", customId, heading, blurb, onEdit, onDelete }: { mode?: Mode; customId?: string; heading?: string; blurb?: string; onEdit?: () => void; onDelete?: () => void }) {
    const qbr = mode === "qbr";
    const [clients, setClients] = React.useState<CustomerClient[]>([]);
    const [clientId, setClientId] = React.useState("");
    const [siteId, setSiteId] = React.useState("");
    const [deviceId, setDeviceId] = React.useState("");
    const [from, setFrom] = React.useState(isoDay(new Date(Date.now() - (qbr ? 89 : 30) * 86_400_000)));
    const [to, setTo] = React.useState(isoDay(new Date()));
    const [summary, setSummary] = React.useState<Summary | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [loading, setLoading] = React.useState(false);

    React.useEffect(() => { fetchCustomers().then(setClients).catch(() => setClients([])); }, []);
    const sites = useSites(clientId);
    const devices = useDeviceChoices(clientId, siteId);

    const scope: Scope = { clientId: clientId || undefined, siteId: siteId || undefined, deviceId: deviceId || undefined, from, to };
    const path = fullReportPath(scope, "summary", mode, customId);

    React.useEffect(() => {
        let stale = false;
        setLoading(true);
        const timer = window.setTimeout(() => {
            jfetch<Summary>(path)
                .then((r) => { if (!stale) { setSummary(r); setError(null); } })
                .catch((e) => { if (!stale) setError(e instanceof Error ? e.message.replace(/^\{.*"message":"([^"]+)".*\}$/, "$1") : "Something went wrong."); })
                .finally(() => { if (!stale) setLoading(false); });
        }, 250);
        return () => { stale = true; window.clearTimeout(timer); };
    }, [path]);

    const what = summary?.scope.device ?? summary?.scope.site ?? summary?.scope.customer ?? "everything";

    return (
        <div className="grid gap-4">
            <div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <h2 className="text-base font-semibold">{heading ?? (qbr ? "Quarterly business review" : "All report")}</h2>
                    {(onEdit || onDelete) && (
                        <div className="flex gap-2">
                            {onEdit && <Button type="button" variant="outline" size="sm" onClick={onEdit}>Edit</Button>}
                            {onDelete && <Button type="button" variant="outline" size="sm" onClick={onDelete}>Delete</Button>}
                        </div>
                    )}
                </div>
                <p className="max-w-3xl text-sm text-muted-foreground">
                    {mode === "custom"
                        ? blurb || "A report you designed. Choose who it is for and the dates, then download it as a PDF or an Excel workbook, or schedule it."
                        : qbr
                        ? "A pack to take to a customer: a scorecard, what needs attention, what was done, and the detail behind it: security, patching, hardware age, Windows support, availability, disk space, software, alerts, tickets, scripts and renewals. It covers the last 90 days unless you change the dates. The PDF has the charts; the Excel workbook has every row."
                        : "Every report in one document: hardware, health, security, patching, software, alerts and remote sessions. Choose a customer, a site or a single device, or leave it on everything. The PDF has a scorecard and every report with its charts; the Excel workbook has a sheet for each report with every row."}
                </p>
            </div>

            <div className="flex flex-wrap items-end gap-2">
                <div className="grid gap-1">
                    <Label htmlFor="all-customer">Customer</Label>
                    <select id="all-customer" className={cn(selectClass, "w-56")} value={clientId} onChange={(e) => { setClientId(e.target.value); setSiteId(""); setDeviceId(""); }}>
                        <option value="">All customers</option>
                        {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                </div>
                <div className="grid gap-1">
                    <Label htmlFor="all-site">Site</Label>
                    <select id="all-site" className={cn(selectClass, "w-48")} value={siteId} disabled={!clientId} onChange={(e) => { setSiteId(e.target.value); setDeviceId(""); }}>
                        <option value="">All sites</option>
                        {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                </div>
                <div className="grid gap-1">
                    <Label htmlFor="all-device">Device</Label>
                    <select id="all-device" className={cn(selectClass, "w-56")} value={deviceId} disabled={!clientId} onChange={(e) => setDeviceId(e.target.value)}>
                        <option value="">All devices</option>
                        {devices.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                    </select>
                </div>
                <div className="grid gap-1"><Label htmlFor="all-from">From</Label><Input id="all-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
                <div className="grid gap-1"><Label htmlFor="all-to">To</Label><Input id="all-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
                <Button asChild variant="outline">
                    <a href={apiUrl(fullReportPath(scope, "pdf", mode, customId))}><FileText className="mr-1 h-4 w-4" /> Download PDF</a>
                </Button>
                <Button asChild variant="outline">
                    <a href={apiUrl(fullReportPath(scope, "xlsx", mode, customId))}><FileSpreadsheet className="mr-1 h-4 w-4" /> Download Excel</a>
                </Button>
            </div>

            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            {summary && (
                <div className={cn("grid gap-4", loading && "opacity-60")}>
                    <p className="text-sm text-muted-foreground">
                        {summary.title}. As of {new Date(summary.generatedAt).toLocaleString()}.
                        {summary.period ? ` Activity from ${summary.period.from} to ${summary.period.to}.` : ""} Covers {what}.
                    </p>
                    {!!summary.recommendations?.length && (
                        <div className="rounded-md border border-border p-3">
                            <p className="mb-1 text-sm font-medium">What needs attention</p>
                            <ul className="grid gap-1 text-sm">
                                {summary.recommendations.map((t) => <li key={t} className="flex gap-2"><span aria-hidden>&bull;</span><span>{t}</span></li>)}
                            </ul>
                        </div>
                    )}
                    {!!summary.highlights?.length && (
                        <div className="rounded-md border border-border p-3">
                            <p className="mb-1 text-sm font-medium">What was done</p>
                            <ul className="grid gap-1 text-sm">
                                {summary.highlights.map((t) => <li key={t} className="flex gap-2"><span aria-hidden>&bull;</span><span>{t}</span></li>)}
                            </ul>
                        </div>
                    )}
                    {summary.intro && <p className="max-w-3xl whitespace-pre-line rounded-md border border-border bg-muted/30 p-3 text-sm">{summary.intro}</p>}
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                        {summary.scorecard.map((t) => (
                            <div key={t.label} className={cn("rounded-md border border-border border-l-4 p-3", TONE[t.tone])}>
                                <p className="text-xs text-muted-foreground">{t.label}</p>
                                <p className="text-2xl font-semibold tabular-nums">{t.value}</p>
                                {t.detail && <p className="text-xs text-muted-foreground">{t.detail}</p>}
                            </div>
                        ))}
                    </div>
                    <div className="rounded-md border border-border">
                        <p className="border-b border-border bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground">In this report</p>
                        <ul className="divide-y divide-border text-sm">
                            {summary.sections.map((s) => (
                                <li key={s.key} className="flex justify-between px-3 py-1.5"><span>{s.title}</span><span className="tabular-nums text-muted-foreground">{s.rows} row{s.rows === 1 ? "" : "s"}</span></li>
                            ))}
                        </ul>
                    </div>
                    {summary.omitted.length > 0 && (
                        <p className="text-sm text-muted-foreground">Left out: {summary.omitted.map((o) => `${o.title} (${o.reason})`).join(" ")}</p>
                    )}
                </div>
            )}
        </div>
    );
}

/** Export report, for a device's page: the same All report, for this one device. */
export function DeviceReportMenu({ deviceId }: { deviceId: string }) {
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="gap-2" title="Download a full report for this device">
                    <Download className="h-4 w-4" /> Export report
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
                <DropdownMenuItem asChild>
                    <a href={apiUrl(fullReportPath({ deviceId }, "pdf"))} className="flex items-center gap-2"><FileText className="h-4 w-4" /> PDF report</a>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                    <a href={apiUrl(fullReportPath({ deviceId }, "xlsx"))} className="flex items-center gap-2"><FileSpreadsheet className="h-4 w-4" /> Excel workbook</a>
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
