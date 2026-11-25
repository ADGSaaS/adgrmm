// app/(dashboard)/reports/page.tsx
"use client";

import { PageHeader, PageShell } from "@/components/page-shell";
import * as React from "react";
import Link from "next/link";
import { Activity, BarChart3, Boxes, ChevronDown, ClipboardList, Download, Filter, HeartPulse, Hourglass, Layers, LifeBuoy, Package, Plus, ShieldCheck, Trash2, Users, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/use-toast";
import { Pager, usePaged } from "@/components/pager";
import { EmptyState } from "@/components/list-controls";
import { apiUrl, fetchCustomers, fetchCustomerSites, jfetch, type CustomerClient } from "@/lib/api";
import { ChartsPanel } from "@/components/reports/charts";
import { FilterBuilder } from "@/components/reports/filter-builder";
import { ColumnPicker, ViewsMenu } from "@/components/reports/report-toolbar";
import { SoftwareFixDialog } from "@/components/reports/software-fix-dialog";
import { useMe } from "@/lib/use-me";
import { hasPerm } from "@/lib/permissions";
import { FullReportPanel, useDeviceChoices, useSites } from "@/components/reports/full-report";
import { ReportBuilder, type CustomReport } from "@/components/reports/report-builder";
import { BusinessHoursPanel, DeliveryLog, SoftwarePoliciesPanel } from "@/components/reports/report-settings-panels";
import { readParam } from "@/lib/url-params";
import {
    cleanFilter,
    countConditions,
    displayValue,
    emptyFilter,
    isGroup,
    newCondition,
    type FilterGroup,
    type ReportColumn,
    type ReportDef,
    type ReportKey,
    type ReportResult,
    type Row,
    type SavedView,
    type SortKey,
    type ViewConfig,
    type ViewSpec,
} from "@/components/reports/report-types";

/** What went wrong, in words. The server's validation errors arrive as JSON; this reads the message out of them. */
const errorText = (e: unknown) => {
    if (!(e instanceof Error)) return "Something went wrong.";
    try {
        const body = JSON.parse(e.message) as { message?: string | string[] };
        const m = Array.isArray(body.message) ? body.message.join(" ") : body.message;
        if (m) return m;
    } catch {
        /* not JSON: it is already words */
    }
    return e.message;
};
/** The look of a field that still needs filling in. */
const INVALID = "border-destructive ring-1 ring-destructive focus-visible:ring-destructive";
const selectClass = "h-10 rounded-md border border-input bg-background px-2 text-sm";
const dateText = (value: string | null | undefined) => (value ? new Date(value).toLocaleString() : "");

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => isoDay(new Date(Date.now() - n * 86_400_000));
const today = () => isoDay(new Date());

const CustomersContext = React.createContext<CustomerClient[]>([]);

/** A category in the reports menu: a clear heading with an icon, and its reports indented beneath it. */
const GROUP_ICONS: Record<string, LucideIcon> = {
    Everything: Layers,
    "My reports": ClipboardList,
    Inventory: Boxes,
    Lifecycle: Hourglass,
    Health: HeartPulse,
    Security: ShieldCheck,
    Patching: Package,
    Activity: Activity,
    Service: LifeBuoy,
    Customers: Users,
};

function NavGroup({ title, open, onToggle, children }: { title: string; open: boolean; onToggle: () => void; children: React.ReactNode }) {
    const Icon = GROUP_ICONS[title] ?? BarChart3;
    const id = `nav-${title.toLowerCase()}`;
    return (
        <div className="grid gap-1">
            <h2>
                <button
                    type="button"
                    aria-expanded={open}
                    aria-controls={id}
                    onClick={onToggle}
                    className="flex w-full items-center gap-2 rounded-md bg-muted px-3 py-1.5 text-left text-xs font-bold uppercase tracking-wider text-foreground hover:bg-muted/70"
                >
                    <Icon className="h-4 w-4 text-primary" aria-hidden />
                    <span className="flex-1">{title}</span>
                    <ChevronDown className={cn("h-4 w-4 text-muted-foreground transition-transform", !open && "-rotate-90")} aria-hidden />
                </button>
            </h2>
            {open && <div id={id} className="ml-4 grid gap-0.5 border-l border-border pl-2">{children}</div>}
        </div>
    );
}

const EXPANDED_KEY = "reports.menu.expanded";

const query = (params: Record<string, string | undefined>) => {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) sp.set(k, v);
    return sp.toString();
};

function CustomerFilter({ value, onChange, required, invalid }: { value: string; onChange: (v: string) => void; required?: boolean; invalid?: boolean }) {
    const clients = React.useContext(CustomersContext);
    return (
        <div className="grid gap-1">
            <Label htmlFor="report-customer">Customer</Label>
            <select id="report-customer" aria-invalid={invalid || undefined} className={cn(selectClass, "w-56", invalid && INVALID)} value={value} onChange={(e) => onChange(e.target.value)}>
                <option value="">{required ? "Choose a customer" : "All customers"}</option>
                {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
        </div>
    );
}

function DateRange({ from, to, setFrom, setTo }: { from: string; to: string; setFrom: (v: string) => void; setTo: (v: string) => void }) {
    return (
        <>
            <div className="grid gap-1"><Label htmlFor="report-from">From</Label><Input id="report-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
            <div className="grid gap-1"><Label htmlFor="report-to">To</Label><Input id="report-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
        </>
    );
}

function Download_({ href, label = "Export CSV" }: { href: string; label?: string }) {
    return (
        <Button asChild variant="outline">
            <a href={apiUrl(href)}><Download className="mr-1 h-4 w-4" /> {label}</a>
        </Button>
    );
}

const Empty = ({ children }: { children: React.ReactNode }) => <EmptyState>{children}</EmptyState>;

function Table({ head, children, minWidth = 720 }: { head: string[]; children: React.ReactNode; minWidth?: number }) {
    return (
        <div className="overflow-x-auto rounded-xl border border-border/70 bg-card">
            <table className="w-full text-sm" style={{ minWidth }}>
                <thead className="border-b border-border/60">
                    <tr>{head.map((h, i) => <th key={`${h}-${i}`} className="px-5 py-3 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{h}</th>)}</tr>
                </thead>
                <tbody className="divide-y divide-border/60">{children}</tbody>
            </table>
        </div>
    );
}

/** Loads a report whenever its address changes, ignoring an answer to an older request, and says while it is loading. */
function useReport<T>(path: string | null) {
    const [data, setData] = React.useState<T | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [loading, setLoading] = React.useState(false);
    React.useEffect(() => {
        if (!path) {
            setData(null);
            setLoading(false);
            return;
        }
        let stale = false;
        setLoading(true);
        const timer = window.setTimeout(() => {
            jfetch<T>(path)
                .then((r) => { if (!stale) { setData(r); setError(null); } })
                .catch((e) => { if (!stale) setError(errorText(e)); })
                .finally(() => { if (!stale) setLoading(false); });
        }, 200);
        return () => { stale = true; window.clearTimeout(timer); };
    }, [path]);
    return { data, error, loading };
}

const TooMany = ({ show }: { show?: boolean }) => (show ? <p className="text-sm text-muted-foreground">Showing the first 20,000 rows. Narrow the filters to see the rest.</p> : null);

/* ---------------------- endpoint reports ---------------------- */

const GROUPS = ["Inventory", "Lifecycle", "Health", "Security", "Patching", "Activity", "Service"] as const;
const ROWS_SHOWN = 1000;
const MAX_SORT = 3;

/** Hardware, software and health reports share one route. The two activity reports keep the rights of what they read. */
const runPath = (key: ReportKey) => (key === "alert-history" ? "/api/reports/alert-history" : key === "remote-sessions" ? "/api/reports/remote-sessions" : `/api/reports/run/${key}`);

const BAD = /offline|needs attention|crit|open|refused|denied|failed|^off$|out of date|not encrypted|missing|overdue|not scanned|replace now|out of support|not ready|stale|no agent|never seen|^[DF]$|expired|full soon|below target|high risk|medium risk|non-compliant|noisy|breached|late|too long|never resolved/i;
const GOOD = /^(online|healthy|success|resolved|on|encrypted|protected|compliant|current|supported|ready|probably ready|in warranty|meets target|no findings|met|[AB])$/i;

function cellText(column: ReportColumn, value: unknown): string {
    if (value === null || value === undefined || value === "") return "";
    if (column.type === "date") return new Date(String(value)).toLocaleString();
    if (column.type === "percent") return `${value}%`;
    if (column.type === "number" && typeof value === "number") return value.toLocaleString();
    return String(value);
}

const defaultColumnKeys = (columns: ReportColumn[]) => columns.filter((c) => !c.internal && c.visible !== false).map((c) => c.key);

function EndpointReport({ def }: { def: ReportDef }) {
    const { permissions: myPermissions } = useMe();
    const canFix = def.key === "software-compliance" && hasPerm(myPermissions, "software.install");
    const [fixOpen, setFixOpen] = React.useState(false);
    const [clientId, setClientId] = React.useState("");
    const [siteId, setSiteId] = React.useState("");
    const [sites, setSites] = React.useState<Array<{ id: string; name: string }>>([]);
    const pendingSite = React.useRef("");
    const [from, setFrom] = React.useState(daysAgo(30));
    const [to, setTo] = React.useState(today());
    const [values, setValues] = React.useState<Record<string, string>>({});
    const [filter, setFilter] = React.useState<FilterGroup>(emptyFilter());
    const [sort, setSort] = React.useState<SortKey[]>([]);
    const [groupBy, setGroupBy] = React.useState("");
    const [chosenColumns, setChosenColumns] = React.useState<string[] | null>(null);
    const [showFilters, setShowFilters] = React.useState(false);
    const [showCharts, setShowCharts] = React.useState(false);
    const [collapsed, setCollapsed] = React.useState<Set<string>>(new Set());

    React.useEffect(() => {
        if (!pendingSite.current) setSiteId("");
        if (!clientId || !def.scoped) {
            setSites([]);
            return;
        }
        let stale = false;
        fetchCustomerSites(clientId)
            .then((list) => {
                if (stale) return;
                setSites(list.map((s) => ({ id: s.id, name: s.name })));
                if (pendingSite.current) {
                    setSiteId(pendingSite.current);
                    pendingSite.current = "";
                }
            })
            .catch(() => { if (!stale) setSites([]); });
        return () => { stale = true; };
    }, [clientId, def.scoped]);

    // What the server needs to know to build the report, apart from how it is shown.
    const baseParams = {
        clientId: def.scoped ? clientId || undefined : undefined,
        siteId: def.scoped ? siteId || undefined : undefined,
        from: def.dated ? from : undefined,
        to: def.dated ? to : undefined,
        ...Object.fromEntries(def.params.map((p) => [p.key, (values[p.key] ?? "").toString().trim() || undefined])),
    };

    // The columns arrive with the first answer, so a filter can only be cleaned once they are known.
    const [knownColumns, setKnownColumns] = React.useState<ReportColumn[]>([]);
    const cleaned = React.useMemo(() => cleanFilter(filter, knownColumns), [filter, knownColumns]);
    const viewForData: ViewSpec = { filter: cleaned, sort: sort.length ? sort : undefined, groupBy: groupBy || undefined };
    const hasView = !!(viewForData.filter || viewForData.sort || viewForData.groupBy);
    const dataQuery = query({ ...baseParams, view: hasView ? JSON.stringify(viewForData) : undefined });
    const { data, error, loading } = useReport<ReportResult>(`${runPath(def.key)}?${dataQuery}`);

    React.useEffect(() => {
        if (data?.columns) setKnownColumns(data.columns);
    }, [data?.columns]);

    const columns = data?.columns ?? knownColumns;
    const visibleKeys = chosenColumns ?? defaultColumnKeys(columns);
    const shownColumns = visibleKeys.map((k) => columns.find((c) => c.key === k)).filter((c): c is ReportColumn => !!c);

    const exportHref = (format: "csv" | "pdf") => `${runPath(def.key)}?${query({ ...baseParams, format, view: JSON.stringify({ ...viewForData, columns: visibleKeys }) })}`;

    const rows = React.useMemo(() => data?.rows ?? [], [data?.rows]);
    const shownRows = React.useMemo(() => rows.slice(0, ROWS_SHOWN), [rows]);
    const paged = usePaged(shownRows, "report-rows", 50);
    const ready = !!data && data.key === def.key;
    const conditions = countConditions(filter);

    const toggleSort = (key: string, additive: boolean) =>
        setSort((current) => {
            const at = current.findIndex((s) => s.key === key);
            if (at < 0) return additive ? [...current, { key, dir: "asc" as const }].slice(-MAX_SORT) : [{ key, dir: "asc" as const }];
            if (current[at].dir === "asc") return current.map((s, i) => (i === at ? { ...s, dir: "desc" as const } : s));
            return current.filter((_, i) => i !== at);
        });

    const addColumnFilter = (column: ReportColumn) => {
        setFilter((f) => ({ ...f, conditions: [...f.conditions, newCondition(column)] }));
        setShowFilters(true);
    };

    const reset = () => {
        setFilter(emptyFilter());
        setSort([]);
        setGroupBy("");
        setChosenColumns(null);
        setCollapsed(new Set());
    };

    const currentConfig = (): ViewConfig => {
        const params: Record<string, string | number> = {};
        for (const p of def.params) {
            const raw = (values[p.key] ?? "").trim();
            if (raw) params[p.key] = p.type === "number" ? Number(raw) : raw;
        }
        const days = def.dated ? Math.max(1, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 86_400_000) + 1) : undefined;
        return {
            scope: clientId ? { clientId, ...(siteId ? { siteId } : {}) } : undefined,
            params: Object.keys(params).length ? params : undefined,
            days,
            view: { filter: cleaned, sort: sort.length ? sort : undefined, groupBy: groupBy || undefined, columns: chosenColumns ?? undefined },
        };
    };

    const applyView = (saved: SavedView) => {
        const c = saved.config;
        setClientId(c.scope?.clientId ?? "");
        pendingSite.current = c.scope?.clientId ? c.scope.siteId ?? "" : "";
        if (!c.scope?.clientId) setSiteId("");
        setValues(Object.fromEntries(Object.entries(c.params ?? {}).map(([k, v]) => [k, String(v)])));
        if (def.dated && c.days) {
            setFrom(daysAgo(c.days - 1));
            setTo(today());
        }
        setFilter(c.view?.filter ?? emptyFilter());
        setSort(c.view?.sort ?? []);
        setGroupBy(c.view?.groupBy ?? "");
        setChosenColumns(c.view?.columns ?? null);
        setCollapsed(new Set());
        setShowFilters(!!c.view?.filter);
    };

    // Group headings go in as the grouped value changes, so collapsing one hides its rows.
    const body: Array<{ kind: "group"; value: string; count: number } | { kind: "row"; row: Row; index: number }> = [];
    if (ready) {
        const counts = new Map(data.groups.map((g) => [g.value, g.count]));
        let current: string | null = null;
        paged.rows.forEach((row, index) => {
            if (groupBy) {
                const value = displayValue(row[groupBy]);
                if (value !== current) {
                    current = value;
                    body.push({ kind: "group", value, count: counts.get(value) ?? 0 });
                }
                if (collapsed.has(value)) return;
            }
            body.push({ kind: "row", row, index });
        });
    }

    const filterable = columns.filter((c) => !c.internal);

    return (
        <div className="grid gap-3">
            <div>
                <h2 className="text-base font-semibold">{def.title}</h2>
                <p className="max-w-3xl text-sm text-muted-foreground">{def.description}</p>
            </div>

            <div className="flex flex-wrap items-end justify-between gap-2">
                <div className="flex flex-wrap items-end gap-2">
                    {def.scoped && (
                        <>
                            <CustomerFilter value={clientId} onChange={setClientId} />
                            {!!clientId && (
                                <div className="grid gap-1">
                                    <Label htmlFor="report-site">Site</Label>
                                    <select id="report-site" className={cn(selectClass, "w-44")} value={siteId} onChange={(e) => setSiteId(e.target.value)}>
                                        <option value="">All sites</option>
                                        {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                                    </select>
                                </div>
                            )}
                        </>
                    )}
                    {def.dated && <DateRange from={from} to={to} setFrom={setFrom} setTo={setTo} />}
                    {def.params.map((p) => (
                        <div key={p.key} className="grid gap-1">
                            <Label htmlFor={`param-${p.key}`}>{p.label}</Label>
                            <Input
                                id={`param-${p.key}`}
                                className={p.type === "number" ? "w-28" : p.default ? "w-80" : "w-56"}
                                type={p.type === "number" ? "number" : "text"}
                                min={p.min}
                                max={p.max}
                                value={values[p.key] ?? ""}
                                placeholder={p.default !== undefined ? String(p.default) : undefined}
                                onChange={(e) => setValues((v) => ({ ...v, [p.key]: e.target.value }))}
                            />
                        </div>
                    ))}
                </div>
                <div className="flex gap-2">
                    <Button asChild variant="outline"><a href={apiUrl(exportHref("csv"))}><Download className="mr-1 h-4 w-4" /> Export CSV</a></Button>
                    <Button asChild variant="outline"><a href={apiUrl(exportHref("pdf"))}><Download className="mr-1 h-4 w-4" /> Download PDF</a></Button>
                </div>
            </div>

            <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label="How to view this report">
                <Button type="button" variant="outline" className={cn((showFilters || conditions > 0) && "bg-accent")} aria-expanded={showFilters} onClick={() => setShowFilters((s) => !s)}>
                    <Filter className="mr-1 h-4 w-4" /> Filters{conditions ? ` (${conditions})` : ""}
                </Button>
                {ready && (
                    <div className="flex items-center gap-1">
                        <Label htmlFor="report-group" className="text-xs text-muted-foreground">Group by</Label>
                        <select id="report-group" className={cn(selectClass, "w-40")} value={groupBy} onChange={(e) => { setGroupBy(e.target.value); setCollapsed(new Set()); }}>
                            <option value="">No grouping</option>
                            {filterable.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                        </select>
                    </div>
                )}
                {ready && <ColumnPicker columns={columns} selected={visibleKeys} onChange={setChosenColumns} onReset={() => setChosenColumns(null)} />}
                <ViewsMenu reportKey={def.key} current={currentConfig} onApply={applyView} />
                <Button type="button" variant="outline" className={cn(showCharts && "bg-accent")} aria-pressed={showCharts} onClick={() => setShowCharts((s) => !s)}>
                    <BarChart3 className="mr-1 h-4 w-4" /> Charts
                </Button>
                {ready && canFix && (
                    <>
                        <Button type="button" variant="success" onClick={() => setFixOpen(true)} title="Install the missing software and, if you choose, remove the banned software, for the devices in this report">
                            Fix now…
                        </Button>
                        <SoftwareFixDialog open={fixOpen} onOpenChange={setFixOpen} rows={rows as Array<Record<string, unknown>>} />
                    </>
                )}
                {(conditions > 0 || sort.length > 0 || groupBy || chosenColumns) && <Button type="button" variant="ghost" onClick={reset}>Reset view</Button>}
                {loading && <span className="text-xs text-muted-foreground" role="status">Updating…</span>}
            </div>

            {showFilters && (
                <div className="rounded-md border border-border p-3">
                    {ready ? (
                        <>
                            <FilterBuilder columns={columns} rows={rows} value={filter} onChange={setFilter} />
                            {conditions === 0 && <p className="mt-2 text-xs text-muted-foreground">Add a condition to narrow the report. The summary, charts and both downloads follow the filter. You can also use the funnel on a column heading.</p>}
                        </>
                    ) : (
                        <p className="text-sm text-muted-foreground">Loading…</p>
                    )}
                </div>
            )}

            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

            {ready && data && (
                <div className={cn("grid gap-3", loading && "opacity-70")}>
                    <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-6">
                        {data.summary.map((s) => <Stat key={s.label} label={s.label} value={typeof s.value === "number" ? s.value.toLocaleString() : s.value} />)}
                    </div>
                    <p className="text-xs text-muted-foreground">
                        As of {new Date(data.generatedAt).toLocaleString()}.{" "}
                        {[data.scope.customer, data.scope.site].filter(Boolean).join(" / ") || "All customers"}
                        {data.period ? `, ${data.period.from} to ${data.period.to}` : ""}.
                        {" "}Devices that are offline show what they last reported.
                    </p>
                    {data.notes.map((n) => <p key={n} className="text-xs text-muted-foreground">{n}</p>)}

                    {showCharts && <ChartsPanel charts={data.charts} />}

                    {data.totalRows === 0 ? (
                        <Empty>Nothing to report for this selection.</Empty>
                    ) : data.matchedRows === 0 ? (
                        <Empty>No rows match the filters. {data.totalRows.toLocaleString()} rows were left out.</Empty>
                    ) : (
                        <>
                            <p className="text-xs text-muted-foreground">
                                {data.matchedRows === data.totalRows ? `${data.totalRows.toLocaleString()} rows` : `${data.matchedRows.toLocaleString()} of ${data.totalRows.toLocaleString()} rows match the filters`}
                                {sort.length > 1 ? ". Sorted by several columns" : ""}
                            </p>
                            <div className="overflow-x-auto rounded-xl border border-border/70 bg-card">
                                <table className="w-full text-sm" style={{ minWidth: Math.max(720, shownColumns.length * 110) }}>
                                    <thead className="border-b border-border/60">
                                        <tr>
                                            {shownColumns.map((c) => {
                                                const at = sort.findIndex((s) => s.key === c.key);
                                                const active = filter.conditions.filter((x) => !isGroup(x) && x.field === c.key).length;
                                                return (
                                                    <th key={c.key} className="px-5 py-3 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground" aria-sort={at >= 0 ? (sort[at].dir === "asc" ? "ascending" : "descending") : "none"}>
                                                        <span className="inline-flex items-center gap-1">
                                                            <button type="button" className="inline-flex items-center gap-1 uppercase hover:text-foreground" title="Sort. Hold Shift to sort by more than one column." onClick={(e) => toggleSort(c.key, e.shiftKey)}>
                                                                {c.label}
                                                                {at >= 0 ? ` ${sort[at].dir === "asc" ? "▲" : "▼"}${sort.length > 1 ? at + 1 : ""}` : ""}
                                                            </button>
                                                            <button type="button" aria-label={`Filter ${c.label}`} title={`Filter ${c.label}`} className={cn("rounded p-0.5 hover:text-foreground", active ? "text-primary" : "opacity-50")} onClick={() => addColumnFilter(c)}>
                                                                <Filter className="h-3 w-3" />
                                                            </button>
                                                        </span>
                                                    </th>
                                                );
                                            })}
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-border/60">
                                        {body.map((item, i) =>
                                            item.kind === "group" ? (
                                                <tr key={`g-${item.value}-${i}`} className="bg-muted/30">
                                                    <td colSpan={shownColumns.length} className="px-5 py-2">
                                                        <button
                                                            type="button"
                                                            className="flex w-full items-center gap-2 text-left text-sm font-medium"
                                                            aria-expanded={!collapsed.has(item.value)}
                                                            onClick={() => setCollapsed((s) => { const n = new Set(s); if (n.has(item.value)) n.delete(item.value); else n.add(item.value); return n; })}
                                                        >
                                                            <span aria-hidden>{collapsed.has(item.value) ? "▸" : "▾"}</span>
                                                            {columns.find((c) => c.key === groupBy)?.label}: {item.value}
                                                            <span className="font-normal text-muted-foreground">({item.count.toLocaleString()})</span>
                                                        </button>
                                                    </td>
                                                </tr>
                                            ) : (
                                                <tr key={item.index} className="align-top hover:bg-accent">
                                                    {shownColumns.map((c) => {
                                                        const text = cellText(c, item.row[c.key]);
                                                        const tone = c.type === "status" ? (BAD.test(text) ? "font-medium text-destructive" : GOOD.test(text) ? "text-emerald-600 dark:text-emerald-400" : "") : "";
                                                        const deviceId = typeof item.row.deviceId === "string" ? item.row.deviceId : null;
                                                        const isDeviceName = deviceId && (c.key === "name" || c.key === "device");
                                                        return (
                                                            <td key={c.key} className={cn("px-5 py-4 text-sm", c.type === "date" && "whitespace-nowrap tabular-nums", (c.type === "number" || c.type === "percent") && "tabular-nums", tone)}>
                                                                {isDeviceName ? <Link href={`/devices/${deviceId}`} className="font-medium underline-offset-2 hover:underline">{text}</Link> : text}
                                                            </td>
                                                        );
                                                    })}
                                                </tr>
                                            ),
                                        )}
                                    </tbody>
                                </table>
                            </div>
                            <Pager paged={paged} noun="rows" />
                            {rows.length > ROWS_SHOWN && <p className="text-xs text-muted-foreground">Showing the newest {ROWS_SHOWN.toLocaleString()} of {rows.length.toLocaleString()} rows here. The export has them all.</p>}
                        </>
                    )}
                    {data.truncated && <p className="text-sm text-muted-foreground">Only the first 20,000 rows are included. Narrow the filters to see the rest.</p>}
                </div>
            )}
        </div>
    );
}

/* ---------------------- customer health ---------------------- */

type Health = {
    client: { id: string; name: string };
    devices: { total: number; online: number; offline: Array<{ name: string; lastSeenAt: string | null }>; byOs: Array<{ os: string; count: number }> };
    alerts: { total: number; critical: number; resolved: number; stillOpen: number; averageMinutesToResolve: number | null; mostCommon: Array<{ title: string; count: number }> };
    checks: { runs: number; passedPercent: number | null };
    tickets: { opened: number; closed: number };
};

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
    return (
        <div className="rounded-md border border-border p-3">
            <div className="text-xs text-muted-foreground">{label}</div>
            <div className="text-xl font-semibold tabular-nums">{value}</div>
        </div>
    );
}

function HealthTab() {
    const [clientId, setClientId] = React.useState("");
    const [from, setFrom] = React.useState(daysAgo(30));
    const [to, setTo] = React.useState(today());
    const qs = query({ clientId, from, to });
    const { data, error } = useReport<Health>(clientId ? `/api/reports/customer-health?${qs}` : null);

    return (
        <div className="grid gap-4">
            <div className="flex flex-wrap items-end justify-between gap-2">
                <div className="flex flex-wrap items-end gap-2">
                    <CustomerFilter value={clientId} onChange={setClientId} required />
                    <DateRange from={from} to={to} setFrom={setFrom} setTo={setTo} />
                </div>
                {clientId && <Download_ href={`/api/reports/customer-health.pdf?${qs}`} label="Download PDF" />}
            </div>
            {!clientId && <Empty>Choose a customer to see their report.</Empty>}
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            {clientId && data && (
                <>
                    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
                        <Stat label="Devices" value={data.devices.total} />
                        <Stat label="Online now" value={data.devices.online} />
                        <Stat label="Checks passed" value={data.checks.passedPercent === null ? "No runs" : `${data.checks.passedPercent}%`} />
                        <Stat label="Alerts raised" value={data.alerts.total} />
                        <Stat label="Critical alerts" value={data.alerts.critical} />
                        <Stat label="Average time to resolve" value={data.alerts.averageMinutesToResolve === null ? "None" : `${data.alerts.averageMinutesToResolve} min`} />
                    </div>
                    <div className="grid gap-4 lg:grid-cols-3">
                        <section className="grid content-start gap-1 text-sm">
                            <h2 className="text-base font-semibold">Operating systems</h2>
                            {data.devices.byOs.length === 0 && <p className="text-muted-foreground">No devices.</p>}
                            {data.devices.byOs.map((o) => <p key={o.os} className="flex justify-between gap-3"><span>{o.os}</span><span className="tabular-nums">{o.count}</span></p>)}
                        </section>
                        <section className="grid content-start gap-1 text-sm">
                            <h2 className="text-base font-semibold">Most common alerts</h2>
                            {data.alerts.mostCommon.length === 0 && <p className="text-muted-foreground">No alerts in these dates.</p>}
                            {data.alerts.mostCommon.map((a) => <p key={a.title} className="flex justify-between gap-3"><span className="truncate">{a.title}</span><span className="tabular-nums">{a.count}</span></p>)}
                        </section>
                        <section className="grid content-start gap-1 text-sm">
                            <h2 className="text-base font-semibold">Offline now</h2>
                            {data.devices.offline.length === 0 && <p className="text-muted-foreground">Everything is online.</p>}
                            {data.devices.offline.map((d) => <p key={d.name} className="flex justify-between gap-3"><span className="truncate">{d.name}</span><span className="text-xs text-muted-foreground">{d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleDateString() : ""}</span></p>)}
                        </section>
                    </div>
                </>
            )}
        </div>
    );
}

/* ---------------------- schedules ---------------------- */

type Frequency = "daily" | "weekly" | "monthly" | "once";
type SendFormat = "pdf" | "csv" | "xlsx" | "both";
type Rule = {
    kind: Frequency;
    time: string;
    timezone: string;
    daysOfWeek?: number[];
    dayOfMonth?: number;
    nth?: { week: number; weekday: number };
    onceDate?: string;
};
type Schedule = {
    id: string;
    reportKey: string;
    title: string;
    client: { id: string; name: string } | null;
    site?: { id: string; name: string } | null;
    device?: { id: string; name: string } | null;
    frequency: Frequency;
    schedule: Rule;
    description: string;
    format: SendFormat;
    sendIfEmpty: boolean;
    filtered: boolean;
    recipients: string[];
    enabled: boolean;
    nextRunAt: string;
    lastRunAt: string | null;
    lastResult: string | null;
    lastError: string | null;
};

/** Everything that decides when a schedule sends, as the form holds it. */
type Timing = {
    frequency: Frequency;
    daysOfWeek: number[];
    monthlyMode: "day" | "nth";
    dayOfMonth: number;
    nthWeek: number;
    nthWeekday: number;
    onceDate: string;
    time: string;
    timezone: string;
};

const CUSTOMER_SUMMARY_KEY = "customer-health";
const FULL_REPORT_KEY = "full-report";
const QBR_REPORT_KEY = "quarterly-review";
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
// Monday first, as most people read a week.
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const NTH_LABEL: Array<[number, string]> = [[1, "first"], [2, "second"], [3, "third"], [4, "fourth"], [-1, "last"]];

const browserZone = () => {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
        return "UTC";
    }
};
const allZones = (): string[] => {
    try {
        const list = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone");
        if (list?.length) return Array.from(new Set(["UTC", ...list]));
    } catch {
        /* fall through */
    }
    return ["UTC", "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "Europe/London", "Europe/Berlin", "Asia/Kolkata", "Asia/Tokyo", "Australia/Sydney"];
};

const defaultTiming = (): Timing => ({
    frequency: "monthly",
    daysOfWeek: [1],
    monthlyMode: "day",
    dayOfMonth: 1,
    nthWeek: 1,
    nthWeekday: 1,
    onceDate: "",
    time: "07:00",
    timezone: browserZone(),
});

/** What the server needs to know about when a schedule sends. */
const timingBody = (t: Timing) => ({
    frequency: t.frequency,
    time: t.time,
    timezone: t.timezone,
    ...(t.frequency === "weekly" ? { daysOfWeek: t.daysOfWeek } : {}),
    ...(t.frequency === "monthly" ? (t.monthlyMode === "day" ? { dayOfMonth: t.dayOfMonth } : { nthWeek: t.nthWeek, nthWeekday: t.nthWeekday }) : {}),
    ...(t.frequency === "once" ? { onceDate: t.onceDate } : {}),
});

const timingFromRule = (r: Rule): Timing => ({
    frequency: r.kind,
    daysOfWeek: r.daysOfWeek?.length ? r.daysOfWeek : [1],
    monthlyMode: r.nth ? "nth" : "day",
    dayOfMonth: r.dayOfMonth ?? 1,
    nthWeek: r.nth?.week ?? 1,
    nthWeekday: r.nth?.weekday ?? 1,
    onceDate: r.onceDate ?? "",
    time: r.time,
    timezone: r.timezone,
});

type Preview = { description: string; runs: Array<{ at: string; local: string }> };

/** The fields that still need filling in for the timing, by name. Nothing is sent to the server while any are missing. */
function timingProblems(t: Timing): Partial<Record<"time" | "onceDate" | "daysOfWeek", string>> {
    const problems: Partial<Record<"time" | "onceDate" | "daysOfWeek", string>> = {};
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t.time)) problems.time = "Choose a time";
    if (t.frequency === "once" && !/^\d{4}-\d{2}-\d{2}$/.test(t.onceDate)) problems.onceDate = "Choose a date";
    if (t.frequency === "weekly" && t.daysOfWeek.length === 0) problems.daysOfWeek = "Choose at least one day";
    return problems;
}

/** When it will send, in words and as the next few times, in the zone the customer is in. */
function usePreview(timing: Timing, ready: boolean) {
    const [preview, setPreview] = React.useState<Preview | null>(null);
    const [problem, setProblem] = React.useState<string | null>(null);
    const body = JSON.stringify(timingBody(timing));
    React.useEffect(() => {
        if (!ready) {
            setPreview(null);
            setProblem(null);
            return;
        }
        let stale = false;
        const timer = window.setTimeout(() => {
            jfetch<Preview>("/api/reports/schedules/preview", { method: "POST", body: JSON.parse(body) })
                .then((r) => { if (!stale) { setPreview(r); setProblem(null); } })
                .catch((e) => { if (!stale) { setPreview(null); setProblem(errorText(e)); } });
        }, 250);
        return () => { stale = true; window.clearTimeout(timer); };
    }, [body, ready]);
    return { preview, problem };
}

function TimingControls({ timing, onChange, problems }: { timing: Timing; onChange: (next: Timing) => void; problems: ReturnType<typeof timingProblems> }) {
    const set = (patch: Partial<Timing>) => onChange({ ...timing, ...patch });
    const zones = React.useMemo(() => {
        const list = allZones();
        return list.includes(timing.timezone) ? list : [timing.timezone, ...list];
    }, [timing.timezone]);
    const toggleDay = (d: number) => {
        const has = timing.daysOfWeek.includes(d);
        set({ daysOfWeek: has ? timing.daysOfWeek.filter((x) => x !== d) : [...timing.daysOfWeek, d].sort((a, b) => a - b) });
    };
    return (
        <div className="grid gap-3">
            <div className="flex flex-wrap items-end gap-2 pb-4">
                <div className="grid gap-1">
                    <Label htmlFor="schedule-frequency">Repeat</Label>
                    <select id="schedule-frequency" className={cn(selectClass, "w-60")} value={timing.frequency} onChange={(e) => set({ frequency: e.target.value as Frequency })}>
                        <option value="daily">Every day</option>
                        <option value="weekly">On chosen days of the week</option>
                        <option value="monthly">Every month</option>
                        <option value="once">Once, on a date</option>
                    </select>
                </div>
                {timing.frequency === "once" && (
                    <div className="relative grid gap-1">
                        <Label htmlFor="schedule-once">Date</Label>
                        <Input id="schedule-once" type="date" aria-invalid={!!problems.onceDate} aria-describedby={problems.onceDate ? "schedule-once-problem" : undefined} className={cn("w-44", problems.onceDate && INVALID)} value={timing.onceDate} onChange={(e) => set({ onceDate: e.target.value })} />
                        {problems.onceDate && <p id="schedule-once-problem" className="absolute left-0 top-full whitespace-nowrap pt-0.5 text-xs text-destructive">{problems.onceDate}</p>}
                    </div>
                )}
                <div className="relative grid gap-1">
                    <Label htmlFor="schedule-time">At</Label>
                    <Input id="schedule-time" type="time" aria-invalid={!!problems.time} className={cn("w-32", problems.time && INVALID)} value={timing.time} onChange={(e) => set({ time: e.target.value })} />
                    {problems.time && <p className="absolute left-0 top-full whitespace-nowrap pt-0.5 text-xs text-destructive">{problems.time}</p>}
                </div>
                <div className="grid gap-1">
                    <Label htmlFor="schedule-zone">Time zone</Label>
                    <select id="schedule-zone" className={cn(selectClass, "w-64")} value={timing.timezone} onChange={(e) => set({ timezone: e.target.value })}>
                        {zones.map((z) => <option key={z} value={z}>{z.replace(/_/g, " ")}</option>)}
                    </select>
                </div>
            </div>

            {timing.frequency === "weekly" && (
                <fieldset className="flex flex-wrap items-center gap-2">
                    <legend className="mb-1 text-sm font-medium">Send on</legend>
                    {DAY_ORDER.map((d) => (
                        <Button
                            key={d}
                            type="button"
                            size="sm"
                            className={cn(problems.daysOfWeek && !timing.daysOfWeek.includes(d) && "border-destructive")}
                            variant={timing.daysOfWeek.includes(d) ? "default" : "outline"}
                            aria-pressed={timing.daysOfWeek.includes(d)}
                            title={DAY_NAMES[d]}
                            onClick={() => toggleDay(d)}
                        >
                            {DAY_NAMES[d].slice(0, 3)}
                        </Button>
                    ))}
                    <Button type="button" size="sm" variant="ghost" onClick={() => set({ daysOfWeek: [1, 2, 3, 4, 5] })}>Weekdays</Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => set({ daysOfWeek: [0, 1, 2, 3, 4, 5, 6] })}>Every day</Button>
                    {problems.daysOfWeek && <p role="alert" className="w-full text-xs text-destructive">{problems.daysOfWeek}</p>}
                </fieldset>
            )}

            {timing.frequency === "monthly" && (
                <fieldset className="flex flex-wrap items-center gap-3 text-sm">
                    <legend className="sr-only">Which day of the month</legend>
                    <label className="flex items-center gap-2">
                        <input type="radio" name="monthly-mode" checked={timing.monthlyMode === "day"} onChange={() => set({ monthlyMode: "day" })} />
                        On day
                        <select aria-label="Day of the month" className={cn(selectClass, "w-28")} disabled={timing.monthlyMode !== "day"} value={timing.dayOfMonth} onChange={(e) => set({ dayOfMonth: Number(e.target.value) })}>
                            {Array.from({ length: 31 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}
                            <option value={-1}>Last day</option>
                        </select>
                    </label>
                    <label className="flex items-center gap-2">
                        <input type="radio" name="monthly-mode" checked={timing.monthlyMode === "nth"} onChange={() => set({ monthlyMode: "nth" })} />
                        On the
                        <select aria-label="Which one" className={cn(selectClass, "w-28")} disabled={timing.monthlyMode !== "nth"} value={timing.nthWeek} onChange={(e) => set({ nthWeek: Number(e.target.value) })}>
                            {NTH_LABEL.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                        </select>
                        <select aria-label="Which weekday" className={cn(selectClass, "w-36")} disabled={timing.monthlyMode !== "nth"} value={timing.nthWeekday} onChange={(e) => set({ nthWeekday: Number(e.target.value) })}>
                            {DAY_ORDER.map((d) => <option key={d} value={d}>{DAY_NAMES[d]}</option>)}
                        </select>
                    </label>
                    <span className="text-xs text-muted-foreground">A day that a month does not have (the 31st in April) is sent on that month&apos;s last day.</span>
                </fieldset>
            )}
        </div>
    );
}

function SchedulesTab({ catalog, customReports }: { catalog: ReportDef[]; customReports: CustomReport[] }) {
    const [historyFor, setHistoryFor] = React.useState<string | null>(null);
    const [items, setItems] = React.useState<Schedule[] | null>(null);
    const pagedItems = usePaged(items ?? [], "report-schedules", 25);
    const [error, setError] = React.useState<string | null>(null);
    const [reportKey, setReportKey] = React.useState<string>(CUSTOMER_SUMMARY_KEY);
    const [clientId, setClientId] = React.useState("");
    const [siteId, setSiteId] = React.useState("");
    const [deviceId, setDeviceId] = React.useState("");
    const [views, setViews] = React.useState<SavedView[]>([]);
    const [viewId, setViewId] = React.useState("");
    const [timing, setTiming] = React.useState<Timing>(defaultTiming);
    const [format, setFormat] = React.useState<SendFormat>("pdf");
    const [skipEmpty, setSkipEmpty] = React.useState(false);
    const [recipients, setRecipients] = React.useState("");
    const [busy, setBusy] = React.useState<string | null>(null);
    const [editing, setEditing] = React.useState<Schedule | null>(null);

    // Reports about devices only: the alert and audit reports need their own rights to read, so they are not emailed.
    const schedulable = catalog.filter((d) => d.permission === "devices.read");
    const isSummary = reportKey === CUSTOMER_SUMMARY_KEY;
    const isFull = reportKey === FULL_REPORT_KEY || reportKey === QBR_REPORT_KEY || reportKey.startsWith("custom:");
    const siteChoices = useSites(isFull ? clientId : "");
    const deviceChoices = useDeviceChoices(isFull ? clientId : "", siteId);
    const [attempted, setAttempted] = React.useState(false);
    const problems = timingProblems(timing);
    const timingReady = Object.keys(problems).length === 0;
    const { preview, problem } = usePreview(timing, timingReady);
    // Fields that are only wrong once someone tries to save: an empty customer or recipients box is normal on a fresh form.
    const recipientList = recipients.split(/[,;\s]+/).filter(Boolean);
    const missingRecipients = attempted && recipientList.length === 0;
    const missingCustomer = attempted && !editing && isSummary && !clientId;
    // A site or a device is picked from a customer's list, so one needs the customer first.
    const missingCustomerForScope = attempted && !editing && isFull && !clientId && (!!siteId || !!deviceId);

    const load = React.useCallback(() => {
        jfetch<{ items: Schedule[] }>("/api/reports/schedules").then((r) => { setItems(r.items); setError(null); }).catch((e) => setError(errorText(e)));
    }, []);
    React.useEffect(load, [load]);

    React.useEffect(() => {
        if (editing) return;
        setViewId("");
        if (isSummary || isFull) {
            setViews([]);
            setFormat("pdf");
            return;
        }
        let stale = false;
        jfetch<{ items: SavedView[] }>(`/api/reports/views?report=${reportKey}`).then((r) => { if (!stale) setViews(r.items); }).catch(() => { if (!stale) setViews([]); });
        return () => { stale = true; };
    }, [reportKey, isSummary, isFull, editing]);

    // Changing the customer or site clears what no longer belongs to it.
    React.useEffect(() => { setSiteId(""); setDeviceId(""); }, [clientId, reportKey]);
    React.useEffect(() => { setDeviceId(""); }, [siteId]);

    // A saved view brings its own customer, so the picker only matters when none is chosen.
    const chosenView = views.find((v) => v.id === viewId);

    const resetForm = () => {
        setAttempted(false);
        setEditing(null);
        setRecipients("");
        setTiming(defaultTiming());
        setSkipEmpty(false);
    };

    const startEditing = (s: Schedule) => {
        setEditing(s);
        setReportKey(s.reportKey);
        setClientId(s.client?.id ?? "");
        setTiming(timingFromRule(s.schedule));
        setFormat(s.format);
        setSkipEmpty(!s.sendIfEmpty);
        setRecipients(s.recipients.join(", "));
        window.scrollTo({ top: 0, behavior: "smooth" });
    };

    const save = async (event: React.FormEvent) => {
        event.preventDefault();
        const list = recipientList;
        setAttempted(true);
        // Anything missing is marked in red on the form; nothing is sent until it is filled in.
        if (!timingReady || list.length === 0 || (!editing && isSummary && !clientId)) return;
        setBusy("save");
        try {
            if (editing) {
                await jfetch(`/api/reports/schedules/${editing.id}`, { method: "PUT", body: { ...timingBody(timing), recipients: list, format, sendIfEmpty: !skipEmpty, enabled: editing.enabled } });
                toast({ title: "Schedule changed", description: "It will send at the next time that matches." });
            } else {
                await jfetch("/api/reports/schedules", {
                    method: "POST",
                    body: { reportKey, clientId: clientId || undefined, siteId: isFull ? siteId || undefined : undefined, deviceId: isFull ? deviceId || undefined : undefined, viewId: viewId || undefined, ...timingBody(timing), format, sendIfEmpty: !skipEmpty, recipients: list },
                });
                toast({ title: "Scheduled" });
            }
            resetForm();
            load();
        } catch (e) {
            toast({ title: editing ? "Could not change that" : "Could not schedule that", description: errorText(e), variant: "destructive" });
        } finally {
            setBusy(null);
        }
    };

    const fail = (e: unknown) => toast({ title: "That did not work", description: errorText(e), variant: "destructive" });

    const sendNow = async (s: Schedule) => {
        setBusy(s.id);
        try {
            const r = await jfetch<{ result: string }>(`/api/reports/schedules/${s.id}/send-now`, { method: "POST" });
            toast({ title: r.result.startsWith("Skipped") ? "Nothing was sent" : "Sent", description: r.result.startsWith("Skipped") ? "There was nothing to report, and this schedule skips empty reports." : `A copy of ${s.title} went to ${s.recipients.join(", ")}.` });
            load();
        } catch (e) {
            fail(e);
            load();
        } finally {
            setBusy(null);
        }
    };

    const nextText = (s: Schedule) =>
        s.enabled
            ? new Date(s.nextRunAt).toLocaleString(undefined, { timeZone: s.schedule.timezone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" })
            : "";

    return (
        <div className="grid gap-3">
            <div>
                <h2 className="text-base font-semibold">Scheduled reports</h2>
                <p className="max-w-3xl text-sm text-muted-foreground">Email a report on the days and at the time each customer wants it, in their own time zone. Set up the filters you want on the report first and save them as a view, then pick that view here. The schedule keeps its own copy, so changing the view later does not change what is sent.</p>
            </div>
            <form onSubmit={save} className="grid gap-4 rounded-md border border-border p-3">
                {editing && (
                    <p className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/50 px-3 py-2 text-sm">
                        <span>Changing the schedule for <strong>{editing.title}</strong>{editing.client ? <> for <strong>{editing.client.name}</strong></> : null}. To change what it covers, remove it and make a new one.</span>
                        <Button type="button" variant="ghost" size="sm" onClick={resetForm}>Cancel</Button>
                    </p>
                )}
                {!editing && (
                    <div className="flex flex-wrap items-end gap-2">
                        <div className="grid gap-1">
                            <Label htmlFor="schedule-report">Report</Label>
                            <select id="schedule-report" className={cn(selectClass, "w-56")} value={reportKey} onChange={(e) => setReportKey(e.target.value)}>
                                <option value={CUSTOMER_SUMMARY_KEY}>Customer summary</option>
                                <option value={FULL_REPORT_KEY}>All report (everything)</option>
                                <option value={QBR_REPORT_KEY}>Quarterly business review</option>
                                {customReports.length > 0 && (
                                    <optgroup label="My reports">
                                        {customReports.map((c) => <option key={c.id} value={`custom:${c.id}`}>{c.name}</option>)}
                                    </optgroup>
                                )}
                                {schedulable.map((d) => <option key={d.key} value={d.key}>{d.group}: {d.title}</option>)}
                            </select>
                        </div>
                        {!isSummary && !isFull && (
                            <div className="grid gap-1">
                                <Label htmlFor="schedule-view">Saved view</Label>
                                <select id="schedule-view" className={cn(selectClass, "w-56")} value={viewId} onChange={(e) => setViewId(e.target.value)}>
                                    <option value="">No saved view (everything)</option>
                                    {views.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                                </select>
                            </div>
                        )}
                        {(isSummary || isFull || !chosenView?.config.scope?.clientId) && <CustomerFilter value={clientId} onChange={setClientId} required={isSummary} invalid={missingCustomer || missingCustomerForScope} />}
                        {isFull && (
                            <>
                                <div className="grid gap-1">
                                    <Label htmlFor="schedule-site">Site</Label>
                                    <select id="schedule-site" className={cn(selectClass, "w-44")} value={siteId} disabled={!clientId} onChange={(e) => setSiteId(e.target.value)}>
                                        <option value="">All sites</option>
                                        {siteChoices.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                                    </select>
                                </div>
                                <div className="grid gap-1">
                                    <Label htmlFor="schedule-device">Device</Label>
                                    <select id="schedule-device" className={cn(selectClass, "w-52")} value={deviceId} disabled={!clientId} onChange={(e) => setDeviceId(e.target.value)}>
                                        <option value="">All devices</option>
                                        {deviceChoices.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                                    </select>
                                </div>
                            </>
                        )}
                    </div>
                )}

                <TimingControls timing={timing} onChange={setTiming} problems={problems} />

                <div className="rounded-md border border-dashed border-border p-3 text-sm" aria-live="polite">
                    {!timingReady ? (
                        <p className="text-muted-foreground">Fill in the fields marked in red to see when this will send.</p>
                    ) : problem ? (
                        <p className="text-destructive">{problem}</p>
                    ) : preview ? (
                        <div className="grid gap-1">
                            <p className="font-medium">{preview.description}</p>
                            <p className="text-xs text-muted-foreground">Next sends:</p>
                            <ul className="grid gap-0.5 text-xs">
                                {preview.runs.slice(0, 4).map((r) => <li key={r.at}>{r.local}</li>)}
                            </ul>
                        </div>
                    ) : (
                        <p className="text-muted-foreground">Working out the times…</p>
                    )}
                </div>

                <div className="flex flex-wrap items-end gap-2 pb-4">
                    <div className="grid gap-1">
                        <Label htmlFor="schedule-format">As</Label>
                        <select id="schedule-format" className={cn(selectClass, "w-32")} value={format} disabled={isSummary} onChange={(e) => setFormat(e.target.value as SendFormat)}>
                            <option value="pdf">PDF</option>
                            {isFull ? <option value="xlsx">Excel</option> : <option value="csv">CSV</option>}
                            <option value="both">{isFull ? "PDF and Excel" : "PDF and CSV"}</option>
                        </select>
                    </div>
                    <div className="relative grid min-w-64 flex-1 gap-1">
                        <Label htmlFor="schedule-to">To</Label>
                        <Input id="schedule-to" aria-invalid={missingRecipients || undefined} className={cn(missingRecipients && INVALID)} value={recipients} onChange={(e) => setRecipients(e.target.value)} placeholder="owner@customer.com, you@yourcompany.com" />
                        {missingRecipients && <p className="absolute left-0 top-full whitespace-nowrap pt-0.5 text-xs text-destructive">Enter at least one email address</p>}
                    </div>
                    {!isSummary && (
                        <label className="flex items-center gap-2 pb-2 text-sm">
                            <Switch checked={skipEmpty} onCheckedChange={setSkipEmpty} aria-label="Skip when there is nothing to report" />
                            Skip when there is nothing to report
                        </label>
                    )}
                    <Button type="submit" disabled={busy === "save"}>
                        {editing ? "Save changes" : <><Plus className="mr-1 h-4 w-4" /> Schedule</>}
                    </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                    {isSummary
                        ? "Sends the customer summary as a PDF, covering the period just finished."
                        : isFull
                        ? reportKey.startsWith("custom:") ? "Sends the report you designed, for the customer, site or device you choose. Tickets, technician activity and remote sessions are never emailed." : reportKey === QBR_REPORT_KEY ? "Sends the quarterly review: what needs attention, what was done and the detail, covering the last 90 days. Tickets, technician activity and remote sessions are never emailed." : "Sends every report in one document for the customer, site or device you choose, with activity for the period just finished. Tickets, technician activity and remote sessions are never emailed."
                        : "Reports about devices only. The alert and remote session reports are not emailed. A report with a period covers the period just finished, or the number of days a view was saved with."}
                    {" "}Uses the mailbox set up in Administration.
                </p>
            </form>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            {items?.length === 0 && <Empty>No reports scheduled yet.</Empty>}
            {!!items?.length && (
                <Table minWidth={1100} head={["Report", "Customer", "When", "Next", "As", "To", "Last result", "On", ""]}>
                    {pagedItems.rows.map((s) => (
                        <React.Fragment key={s.id}>
                        <tr className={cn("align-top hover:bg-accent", editing?.id === s.id && "bg-muted/40")}>
                            <td className="px-5 py-4 text-sm font-medium">
                                {s.title}
                                {s.filtered && <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[11px] font-normal text-muted-foreground">filtered</span>}
                                {!s.sendIfEmpty && <span className="ml-1 rounded bg-muted px-1.5 py-0.5 text-[11px] font-normal text-muted-foreground">skips empty</span>}
                            </td>
                            <td className="px-5 py-4 text-sm">{s.client?.name ?? "All customers"}{(s.device || s.site) && <span className="block text-xs text-muted-foreground">{s.device ? `Device: ${s.device.name}` : `Site: ${s.site!.name}`}</span>}</td>
                            <td className="px-5 py-4 text-sm">{s.description}</td>
                            <td className="whitespace-nowrap px-5 py-4 text-sm tabular-nums">{nextText(s)}</td>
                            <td className="px-5 py-4 text-sm uppercase">{s.format === "both" ? (s.reportKey === FULL_REPORT_KEY || s.reportKey === QBR_REPORT_KEY || s.reportKey.startsWith("custom:") ? "PDF + Excel" : "PDF + CSV") : s.format === "xlsx" ? "Excel" : s.format}</td>
                            <td className="px-5 py-4 text-sm">{s.recipients.join(", ")}</td>
                            <td className={cn("px-5 py-4 text-sm", s.lastError && "text-destructive")}>{s.lastError ?? (s.lastResult ? `${s.lastResult}${s.lastRunAt ? `, ${new Date(s.lastRunAt).toLocaleDateString()}` : ""}` : "")}</td>
                            <td className="px-5 py-4 text-sm">
                                <Switch
                                    aria-label={`Send ${s.title} for ${s.client?.name ?? "all customers"}`}
                                    checked={s.enabled}
                                    onCheckedChange={(enabled) => jfetch(`/api/reports/schedules/${s.id}`, { method: "PUT", body: { frequency: s.frequency, recipients: s.recipients, format: s.format, sendIfEmpty: s.sendIfEmpty, enabled } }).then(load).catch(fail)}
                                />
                            </td>
                            <td className="whitespace-nowrap px-5 py-2 text-right">
                                <Button variant="ghost" size="sm" onClick={() => startEditing(s)}>Edit</Button>
                                <Button variant="ghost" size="sm" aria-expanded={historyFor === s.id} onClick={() => setHistoryFor(historyFor === s.id ? null : s.id)}>History</Button>
                                <Button variant="ghost" size="sm" disabled={busy === s.id} title="Email it now to see what it looks like. The schedule does not change." onClick={() => void sendNow(s)}>
                                    {busy === s.id ? "Sending…" : "Send now"}
                                </Button>
                                <Button variant="ghost" size="icon" aria-label={`Remove ${s.title} schedule`} onClick={() => jfetch(`/api/reports/schedules/${s.id}`, { method: "DELETE" }).then(() => { if (editing?.id === s.id) resetForm(); load(); }).catch(fail)}>
                                    <Trash2 className="h-4 w-4" />
                                </Button>
                            </td>
                        </tr>
                        {historyFor === s.id && (
                            <tr className="bg-muted/20">
                                <td colSpan={9} className="px-5 py-3"><DeliveryLog scheduleId={s.id} /></td>
                            </tr>
                        )}
                        </React.Fragment>
                    ))}
                </Table>
            )}
            {!!items?.length && <Pager paged={pagedItems} noun="schedules" />}
        </div>
    );
}

/* ---------------------- page ---------------------- */

type Selection = ReportKey | "customer-summary" | "schedules" | "full-report" | "quarterly-review" | "builder" | "policies" | "hours" | `custom:${string}`;

export default function ReportsPage() {
    const [selected, setSelected] = React.useState<Selection>(() => readParam("report", ["patch-compliance", "patch-missing", "patch-activity"] as const) ?? "hardware-inventory");
    const [clients, setClients] = React.useState<CustomerClient[]>([]);
    const [catalog, setCatalog] = React.useState<ReportDef[] | null>(null);
    const [catalogError, setCatalogError] = React.useState<string | null>(null);
    const [customReports, setCustomReports] = React.useState<CustomReport[]>([]);
    const [building, setBuilding] = React.useState<{ initial: CustomReport | null } | null>(null);
    const loadCustom = React.useCallback(() => {
        jfetch<{ items: CustomReport[] }>("/api/reports/custom").then((r) => setCustomReports(r.items)).catch(() => setCustomReports([]));
    }, []);
    React.useEffect(loadCustom, [loadCustom]);
    // Categories start folded. The ones the person opens are remembered between visits.
    const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
    React.useEffect(() => {
        try {
            const saved = JSON.parse(window.localStorage.getItem(EXPANDED_KEY) ?? "[]");
            if (Array.isArray(saved)) setExpanded(new Set(saved.filter((x): x is string => typeof x === "string")));
        } catch {
            /* nothing saved, or storage is not available */
        }
    }, []);
    const toggleGroup = (title: string) =>
        setExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(title)) next.delete(title);
            else next.add(title);
            try { window.localStorage.setItem(EXPANDED_KEY, JSON.stringify([...next])); } catch { /* not saved */ }
            return next;
        });

    React.useEffect(() => {
        fetchCustomers().then(setClients).catch(() => setClients([]));
        jfetch<{ items: ReportDef[] }>("/api/reports/catalog").then((r) => setCatalog(r.items)).catch((e) => setCatalogError(errorText(e)));
    }, []);

    const def = catalog?.find((d) => d.key === selected);
    // The category holding the page being looked at stays open, so the highlighted item is never hidden.
    const selectedGroup = selected === "full-report" || selected === "quarterly-review" ? "Everything" : selected === "builder" || selected.startsWith("custom:") ? "My reports" : selected === "customer-summary" || selected === "schedules" || selected === "policies" || selected === "hours" ? "Customers" : def?.group;
    const customSelected = selected.startsWith("custom:") ? customReports.find((c) => `custom:${c.id}` === selected) : undefined;
    const isOpen = (title: string) => title === selectedGroup || expanded.has(title);
    const item = (value: Selection, label: string) => (
        <button
            key={value}
            type="button"
            aria-current={selected === value ? "page" : undefined}
            onClick={() => setSelected(value)}
            className={cn("w-full rounded-md px-3 py-1.5 text-left text-sm", selected === value ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground")}
        >
            {label}
        </button>
    );

    return (
        <CustomersContext.Provider value={clients}>
            <PageShell as="div">
                <PageHeader title="Reports" />
                <div className="grid gap-6 md:grid-cols-[14rem_minmax(0,1fr)]">
                    <nav aria-label="Reports" className="grid content-start gap-4">
                        {catalogError && <p role="alert" className="text-sm text-destructive">{catalogError}</p>}
                        <NavGroup title="Everything" open={isOpen("Everything")} onToggle={() => toggleGroup("Everything")}>
                            {item("full-report", "All report")}
                            {item("quarterly-review", "Quarterly review")}
                        </NavGroup>
                        <NavGroup title="My reports" open={isOpen("My reports")} onToggle={() => toggleGroup("My reports")}>
                            {customReports.map((c) => item(`custom:${c.id}`, c.name))}
                            {item("builder", "+ Build a report")}
                        </NavGroup>
                        {GROUPS.map((g) => {
                            const list = catalog?.filter((d) => d.group === g) ?? [];
                            return list.length ? (
                                <NavGroup key={g} title={g} open={isOpen(g)} onToggle={() => toggleGroup(g)}>
                                    {list.map((d) => item(d.key, d.title))}
                                </NavGroup>
                            ) : null;
                        })}
                        <NavGroup title="Customers" open={isOpen("Customers")} onToggle={() => toggleGroup("Customers")}>
                            {item("customer-summary", "Customer summary")}
                            {item("schedules", "Scheduled")}
                            {item("policies", "Software policies")}
                            {item("hours", "Business hours")}
                        </NavGroup>
                    </nav>
                    <div className="min-w-0">
                        {def && <EndpointReport key={def.key} def={def} />}
                        {selected === "full-report" && <FullReportPanel mode="full" />}
                        {selected === "quarterly-review" && <FullReportPanel mode="qbr" key="qbr" />}
                        {selected === "customer-summary" && <HealthTab />}
                        {selected === "schedules" && <SchedulesTab catalog={catalog ?? []} customReports={customReports} />}
                        {selected === "policies" && <SoftwarePoliciesPanel />}
                        {selected === "hours" && <BusinessHoursPanel />}
                        {selected === "builder" && (
                            <ReportBuilder
                                key={building?.initial?.id ?? "new"}
                                catalog={catalog ?? []}
                                initial={building?.initial ?? null}
                                onCancel={() => { setBuilding(null); setSelected(building?.initial ? (`custom:${building.initial.id}` as Selection) : "full-report"); }}
                                onSaved={(id) => { setBuilding(null); loadCustom(); setSelected(`custom:${id}` as Selection); }}
                            />
                        )}
                        {customSelected && (
                            <FullReportPanel
                                key={customSelected.id}
                                mode="custom"
                                customId={customSelected.id}
                                heading={customSelected.name}
                                blurb={customSelected.description ?? undefined}
                                onEdit={() => { setBuilding({ initial: customSelected }); setSelected("builder"); }}
                                onDelete={() => {
                                    if (!window.confirm(`Delete "${customSelected.name}"? Schedules for it are removed too.`)) return;
                                    jfetch(`/api/reports/custom/${customSelected.id}`, { method: "DELETE" }).then(() => { loadCustom(); setSelected("full-report"); }).catch((e) => toast({ title: "Could not delete that", description: errorText(e), variant: "destructive" }));
                                }}
                            />
                        )}
                        {!def && selected !== "customer-summary" && selected !== "schedules" && selected !== "full-report" && selected !== "quarterly-review" && selected !== "builder" && selected !== "policies" && selected !== "hours" && !customSelected && !selected.startsWith("custom:") && !catalogError && <p className="text-sm text-muted-foreground">Loading reports…</p>}
                    </div>
                </div>
            </PageShell>
        </CustomersContext.Provider>
    );
}
