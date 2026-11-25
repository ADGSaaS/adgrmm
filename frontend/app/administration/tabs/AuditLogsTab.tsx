"use client";

import * as React from "react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TabsContent } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Download, Loader2, SlidersHorizontal, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { apiUrl, jfetch } from "@/lib/api";
import { formatUsDateTime } from "@/lib/time";
import { LOAD_CAP, Pager, usePaged, useAutoLoadMore } from "@/components/pager";
import { EmptyState, FilterSelect, ListToolbar, SearchField } from "@/components/list-controls";
import { ToastFn } from "../types";

interface AuditTabProps {
    push: ToastFn;
}

type AuditEvent = {
    id: string;
    created_at: string;
    actor_user_id: string | null;
    actor_email: string | null;
    action: string;
    category: string;
    target_type: string | null;
    target_id: string | null;
    target_label: string | null;
    ip: string | null;
    user_agent: string | null;
    outcome: "success" | "failure";
    details: Record<string, unknown> | null;
};

type AuditPage = { items: AuditEvent[]; nextCursor: string | null };

type Filters = {
    q: string;
    category: string;
    outcome: string;
    actor: string;
    action: string;
    target: string;
    from: string;
    to: string;
};

const NO_FILTERS: Filters = { q: "", category: "all", outcome: "all", actor: "", action: "", target: "", from: "", to: "" };

const CATEGORIES: { value: string; label: string }[] = [
    { value: "auth", label: "Sign-in and security" },
    { value: "account", label: "My account" },
    { value: "user", label: "Users" },
    { value: "role", label: "Roles" },
    { value: "device", label: "Devices" },
    { value: "script", label: "Scripts" },
    { value: "file", label: "Files" },
    { value: "remote", label: "Remote sessions" },
    { value: "customer", label: "Customers and sites" },
    { value: "provisioning", label: "Installers and enrollment" },
    { value: "email", label: "Email settings" },
    { value: "storage", label: "Storage settings" },
    { value: "backup", label: "Backups" },
    { value: "ticket", label: "Tickets" },
    { value: "alert", label: "Alerts" },
    { value: "check", label: "Checks" },
    { value: "settings", label: "Organization settings" },
    { value: "audit", label: "Audit log" },
];

const TYPING_DELAY_MS = 350;

function toQuery(filters: Filters): URLSearchParams {
    const params = new URLSearchParams();
    for (const key of ["q", "actor", "action", "target"] as const) {
        const value = filters[key].trim();
        if (value) params.set(key, value);
    }
    if (filters.category !== "all") params.set("category", filters.category);
    if (filters.outcome !== "all") params.set("outcome", filters.outcome);
    // The date inputs mean whole days in the viewer's own time zone.
    if (filters.from) params.set("from", new Date(`${filters.from}T00:00:00`).toISOString());
    if (filters.to) params.set("to", new Date(`${filters.to}T23:59:59.999`).toISOString());
    return params;
}

function targetText(event: AuditEvent): string {
    return event.target_label || event.target_id || "—";
}

function OutcomeBadge({ outcome }: { outcome: AuditEvent["outcome"] }) {
    return outcome === "success" ? (
        <Badge variant="secondary">Success</Badge>
    ) : (
        <Badge variant="destructive">Failure</Badge>
    );
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
    return (
        <div className="grid gap-0.5 sm:grid-cols-[130px_1fr] sm:gap-3">
            <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
            <dd className="min-w-0 break-words text-sm">{value || "—"}</dd>
        </div>
    );
}

function detailText(value: unknown): string {
    if (typeof value === "string") return value;
    return JSON.stringify(value);
}

function EventDialog({ event, onClose }: { event: AuditEvent | null; onClose: () => void }) {
    const details = Object.entries(event?.details ?? {});
    return (
        <Dialog open={!!event} onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
                <DialogHeader>
                    <DialogTitle className="break-all pr-6 font-mono text-base">{event?.action}</DialogTitle>
                    <DialogDescription>{formatUsDateTime(event?.created_at)}</DialogDescription>
                </DialogHeader>
                {event && (
                    <dl className="space-y-3">
                        <DetailRow label="Outcome" value={<OutcomeBadge outcome={event.outcome} />} />
                        <DetailRow label="Category" value={event.category} />
                        <DetailRow label="Who" value={event.actor_email} />
                        <DetailRow label="User ID" value={event.actor_user_id} />
                        <DetailRow label="Target" value={event.target_label} />
                        <DetailRow label="Target type" value={event.target_type} />
                        <DetailRow label="Target ID" value={event.target_id} />
                        <DetailRow label="IP address" value={event.ip} />
                        <DetailRow label="Browser" value={event.user_agent} />
                        {details.map(([key, value]) => (
                            <DetailRow key={key} label={key} value={detailText(value)} />
                        ))}
                    </dl>
                )}
            </DialogContent>
        </Dialog>
    );
}

export default function AuditTab({ push }: AuditTabProps) {
    const [filters, setFilters] = React.useState<Filters>(NO_FILTERS);
    const [applied, setApplied] = React.useState<Filters>(NO_FILTERS);
    const [items, setItems] = React.useState<AuditEvent[]>([]);
    const [nextCursor, setNextCursor] = React.useState<string | null>(null);
    const [loading, setLoading] = React.useState(true);
    const [loadingMore, setLoadingMore] = React.useState(false);
    const [exporting, setExporting] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const [selected, setSelected] = React.useState<AuditEvent | null>(null);
    // On a phone the full set of filters would push the results off the screen.
    const [showFilters, setShowFilters] = React.useState(false);

    // Only the newest request may fill the list, so a slow old search can't overwrite a newer one.
    const requestId = React.useRef(0);

    React.useEffect(() => {
        const timer = window.setTimeout(() => setApplied(filters), TYPING_DELAY_MS);
        return () => window.clearTimeout(timer);
    }, [filters]);

    const load = React.useCallback(async (from: Filters, cursor: string | null) => {
        const id = ++requestId.current;
        if (cursor) setLoadingMore(true);
        else setLoading(true);
        setError(null);
        try {
            const params = toQuery(from);
            params.set("limit", "200");
            if (cursor) params.set("cursor", cursor);
            const page = await jfetch<AuditPage>(`/api/admin/audit-events?${params}`);
            if (id !== requestId.current) return;
            setItems((prev) => (cursor ? [...prev, ...page.items] : page.items));
            setNextCursor(page.nextCursor);
        } catch (e: any) {
            if (id === requestId.current) setError(e?.message || "Could not load the audit log.");
        } finally {
            if (id === requestId.current) {
                setLoading(false);
                setLoadingMore(false);
            }
        }
    }, []);

    // A new filter starts again from the first page.
    React.useEffect(() => {
        void load(applied, null);
    }, [applied, load]);

    // Everything up to LOAD_CAP entries is fetched, then paged here like every other list.
    useAutoLoadMore(nextCursor, loading || loadingMore, items.length, () => { if (nextCursor) void load(applied, nextCursor); });
    const paged = usePaged(items, "audit-log", 50);

    const set = <K extends keyof Filters>(key: K, value: Filters[K]) =>
        setFilters((prev) => ({ ...prev, [key]: value }));

    const hasFilters = JSON.stringify(filters) !== JSON.stringify(NO_FILTERS);

    async function exportCsv() {
        setExporting(true);
        try {
            const res = await fetch(apiUrl(`/api/admin/audit-events/export?${toQuery(applied)}`), {
                credentials: "include",
                cache: "no-store",
            });
            if (!res.ok) throw new Error(`Export failed (${res.status})`);
            const blob = await res.blob();
            const link = document.createElement("a");
            link.href = URL.createObjectURL(blob);
            link.download = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
            document.body.appendChild(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(link.href);
        } catch (e: any) {
            push({ title: "Could not export the audit log", desc: e?.message, kind: "destructive" });
        } finally {
            setExporting(false);
        }
    }

    return (
        <TabsContent value="audit" className="mt-0">
            <Card className="border-0 bg-transparent shadow-none">
                <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:space-y-0 p-0 pb-5">
                    <div className="space-y-1.5">
                        <CardTitle className="text-xl tracking-tight">Audit log</CardTitle>
                        <CardDescription>Who did what, and whether it worked. Entries cannot be changed.</CardDescription>
                    </div>
                    <Button variant="outline" onClick={exportCsv} disabled={exporting} className="w-full shrink-0 sm:w-auto">
                        {exporting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
                        Export CSV
                    </Button>
                </CardHeader>
                <CardContent className="space-y-4 rounded-xl border border-border/70 bg-card p-5 shadow-sm">
                    <ListToolbar
                        right={
                            <>
                                <FilterSelect
                                    label="Category"
                                    value={filters.category}
                                    onChange={(v) => set("category", v)}
                                    options={[{ value: "all", label: "All categories" }, ...CATEGORIES.map((c) => ({ value: c.value, label: c.label }))]}
                                />
                                <FilterSelect
                                    label="Outcome"
                                    value={filters.outcome}
                                    onChange={(v) => set("outcome", v)}
                                    options={[
                                        { value: "all", label: "All outcomes" },
                                        { value: "success", label: "Success" },
                                        { value: "failure", label: "Failure" },
                                    ]}
                                />
                                <SearchField value={filters.q} onChange={(v) => set("q", v)} placeholder="Action, person, target or IP address" label="Search the audit log" />
                                <Button variant="outline" aria-expanded={showFilters} onClick={() => setShowFilters((open) => !open)}>
                                    <SlidersHorizontal className="mr-2 h-4 w-4" />
                                    {showFilters ? "Hide filters" : "More filters"}
                                </Button>
                            </>
                        }
                    />
                    {showFilters && (
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
                            <div className="space-y-1">
                                <Label htmlFor="audit-actor">Who</Label>
                                <Input id="audit-actor" placeholder="Email or user ID" value={filters.actor} onChange={(e) => set("actor", e.target.value)} />
                            </div>
                            <div className="space-y-1">
                                <Label htmlFor="audit-action">Action</Label>
                                <Input id="audit-action" placeholder="For example device.reboot" value={filters.action} onChange={(e) => set("action", e.target.value)} />
                            </div>
                            <div className="space-y-1">
                                <Label htmlFor="audit-target">Target</Label>
                                <Input id="audit-target" placeholder="Name or ID" value={filters.target} onChange={(e) => set("target", e.target.value)} />
                            </div>
                            <div className="min-w-0 space-y-1">
                                <Label htmlFor="audit-from">From</Label>
                                <Input id="audit-from" type="date" value={filters.from} onChange={(e) => set("from", e.target.value)} />
                            </div>
                            <div className="min-w-0 space-y-1">
                                <Label htmlFor="audit-to">To</Label>
                                <Input id="audit-to" type="date" value={filters.to} onChange={(e) => set("to", e.target.value)} />
                            </div>
                        </div>
                    )}

                    {hasFilters && (
                        <Button variant="ghost" size="sm" onClick={() => setFilters(NO_FILTERS)}>
                            <X className="mr-2 h-4 w-4" />
                            Clear filters
                        </Button>
                    )}

                    {error ? (
                        <div className="rounded-md border border-destructive/40 p-4 text-sm">
                            <p className="text-destructive">{error}</p>
                            <Button variant="outline" size="sm" className="mt-3" onClick={() => load(applied, null)}>
                                Try again
                            </Button>
                        </div>
                    ) : loading ? (
                        <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
                            <Loader2 className="h-4 w-4 animate-spin" />
                            Loading…
                        </div>
                    ) : items.length === 0 ? (
                        <EmptyState>{hasFilters ? "No entries match these filters." : "Nothing has been recorded yet."}</EmptyState>
                    ) : (
                        <>
                            {/* Phone width */}
                            <ul className="space-y-2 md:hidden">
                                {paged.rows.map((event) => (
                                    <li key={event.id}>
                                        <button
                                            type="button"
                                            onClick={() => setSelected(event)}
                                            className="w-full rounded-md border p-3 text-left hover:bg-muted/50"
                                        >
                                            <div className="flex items-start justify-between gap-2">
                                                <span className="min-w-0 break-all font-mono text-sm">{event.action}</span>
                                                <OutcomeBadge outcome={event.outcome} />
                                            </div>
                                            <div className="mt-1 break-words text-sm">{event.actor_email || "—"}</div>
                                            <div className="break-words text-sm text-muted-foreground">{targetText(event)}</div>
                                            <div className="mt-1 text-xs text-muted-foreground">{formatUsDateTime(event.created_at)}</div>
                                        </button>
                                    </li>
                                ))}
                            </ul>

                            <div className="hidden overflow-x-auto rounded-xl border border-border/70 bg-card md:block">
                                <table className="w-full text-left">
                                    <thead>
                                        <tr className="border-b border-border/60">
                                            <th className="px-5 py-3 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Time</th>
                                            <th className="px-5 py-3 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Who</th>
                                            <th className="px-5 py-3 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Action</th>
                                            <th className="px-5 py-3 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Target</th>
                                            <th className="px-5 py-3 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Outcome</th>
                                            <th className="px-5 py-3 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">IP address</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-border/60">
                                        {paged.rows.map((event) => (
                                            <tr
                                                key={event.id}
                                                tabIndex={0}
                                                className="cursor-pointer hover:bg-accent"
                                                onClick={() => setSelected(event)}
                                                onKeyDown={(e) => {
                                                    if (e.key === "Enter" || e.key === " ") {
                                                        e.preventDefault();
                                                        setSelected(event);
                                                    }
                                                }}
                                            >
                                                <td className="whitespace-nowrap px-5 py-4 text-sm">{formatUsDateTime(event.created_at)}</td>
                                                <td className="max-w-[220px] truncate px-5 py-4 text-sm">{event.actor_email || "—"}</td>
                                                <td className="px-5 py-4 font-mono text-sm">{event.action}</td>
                                                <td className="max-w-[220px] truncate px-5 py-4 text-sm">{targetText(event)}</td>
                                                <td className="px-5 py-4 text-sm"><OutcomeBadge outcome={event.outcome} /></td>
                                                <td className="whitespace-nowrap px-5 py-4 text-sm">{event.ip || "—"}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>

                            <Pager paged={paged} noun="entries" />
                            {nextCursor || items.length >= LOAD_CAP ? (
                                <p className="text-xs text-muted-foreground">Showing the newest {LOAD_CAP}. Narrow the filters or dates to reach older entries.</p>
                            ) : null}
                        </>
                    )}
                </CardContent>
            </Card>

            <EventDialog event={selected} onClose={() => setSelected(null)} />
        </TabsContent>
    );
}
