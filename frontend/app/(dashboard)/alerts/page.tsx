// app/(dashboard)/alerts/page.tsx
"use client";

import { PageHeader, PageShell } from "@/components/page-shell";
import * as React from "react";
import Link from "next/link";
import { Activity, BellOff, Check, CheckCheck, ChevronDown, ChevronRight, RefreshCw, Settings2, Ticket } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { toast } from "@/components/ui/use-toast";
import { LOAD_CAP, Pager, useAutoLoadMore, usePaged } from "@/components/pager";
import { EmptyState, FilterSelect, ListToolbar, SearchField, SegmentedTabs } from "@/components/list-controls";
import AlertSettingsPanel from "@/components/alert-settings";
import ChecksPanel from "@/components/checks-panel";
import { readParam } from "@/lib/url-params";
import {
    ackAlert,
    bulkAlerts,
    fetchAlerts,
    fetchAlertTimeline,
    openAlertTicket,
    resolveAlert,
    silenceAlert,
    unsilenceAlert,
    type Alert,
    type AlertEvent,
    type AlertSeverity,
    type AlertState,
} from "@/lib/alerts-api";

const TABS: Array<{ value: AlertState; label: string }> = [
    { value: "OPEN", label: "Open" },
    { value: "ACKED", label: "Acknowledged" },
    { value: "SILENCED", label: "Silenced" },
    { value: "RESOLVED", label: "Resolved" },
];

const SILENCE_CHOICES = [
    { label: "1 hour", hours: 1 },
    { label: "4 hours", hours: 4 },
    { label: "1 day", hours: 24 },
    { label: "1 week", hours: 168 },
];

const EVENT_LABELS: Record<string, string> = {
    opened: "Opened",
    escalated: "Got worse",
    acknowledged: "Acknowledged",
    silenced: "Silenced",
    unsilenced: "Silence removed",
    "silence-ended": "Silence ended",
    "ticket-opened": "Ticket opened",
    resolved: "Resolved",
};

const REFRESH_MS = 30_000;

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "");
const hoursFromNow = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();
const errorText = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong.");

function SilenceMenu({ onChoose, compact = false }: { onChoose: (until: string) => void; compact?: boolean }) {
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="h-8 gap-1.5">
                    <BellOff className="h-3.5 w-3.5" aria-hidden="true" />
                    {compact ? null : "Silence"}
                    <ChevronDown className="h-3 w-3 opacity-60" aria-hidden="true" />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
                {SILENCE_CHOICES.map(({ label, hours }) => (
                    <DropdownMenuItem key={hours} onSelect={() => onChoose(hoursFromNow(hours))}>
                        {label}
                    </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

function Timeline({ id }: { id: string }) {
    const [events, setEvents] = React.useState<AlertEvent[] | null>(null);
    const [failed, setFailed] = React.useState(false);

    React.useEffect(() => {
        fetchAlertTimeline(id).then((r) => setEvents(r.items)).catch(() => setFailed(true));
    }, [id]);

    if (failed) return <p className="text-xs text-muted-foreground">Could not load the history.</p>;
    if (!events) return <p className="text-xs text-muted-foreground">Loading…</p>;

    return (
        <ol className="space-y-1 text-xs">
            {events.map((e) => (
                <li key={e.id} className="flex flex-wrap gap-x-2">
                    <span className="text-muted-foreground">{when(e.at)}</span>
                    <span className="font-medium">{EVENT_LABELS[e.type] ?? e.type}</span>
                    <span className="text-muted-foreground">by {e.actor}</span>
                    {e.reason ? <span>· {e.reason}</span> : null}
                </li>
            ))}
        </ol>
    );
}

function AlertRow({ alert, selected, onSelect, onChanged }: { alert: Alert; selected: boolean; onSelect: (on: boolean) => void; onChanged: () => void }) {
    const [open, setOpen] = React.useState(false);
    const [busy, setBusy] = React.useState(false);

    const act = async (action: () => Promise<unknown>, done: string) => {
        setBusy(true);
        try {
            await action();
            toast({ title: done, variant: "success" });
            onChanged();
        } catch (e) {
            toast({ title: "That did not work", description: errorText(e), variant: "destructive", duration: 10_000 });
        } finally {
            setBusy(false);
        }
    };

    const place = [alert.device.client, alert.device.site].filter(Boolean).join(" / ");
    const resolved = alert.state === "RESOLVED";

    return (
        <li>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5">
                {resolved ? null : (
                    <Checkbox checked={selected} onCheckedChange={(v) => onSelect(!!v)} aria-label={`Select ${alert.title}`} />
                )}
                <button
                    type="button"
                    onClick={() => setOpen((v) => !v)}
                    aria-expanded={open}
                    className="flex min-w-0 flex-1 basis-64 items-start gap-2 text-left"
                >
                    <ChevronRight className={cn("mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} aria-hidden="true" />
                    <span
                        className={cn(
                            "mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase",
                            alert.severity === "CRIT" ? "bg-red-500/15 text-red-600 dark:text-red-400" : "bg-amber-500/15 text-amber-700 dark:text-amber-400"
                        )}
                    >
                        {alert.severity === "CRIT" ? "Critical" : "Warning"}
                    </span>
                    <span className="min-w-0">
                        <span className="block truncate text-sm font-medium">{alert.title}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                            {place ? `${place} · ` : ""}
                            {resolved ? `Resolved ${when(alert.resolvedAt)}` : `Since ${when(alert.firstSeenAt)}`}
                        </span>
                    </span>
                </button>

                {resolved ? null : (
                    <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                        {alert.state === "OPEN" ? (
                            <Button variant="outline" size="sm" className="h-8 gap-1.5" disabled={busy} onClick={() => act(() => ackAlert(alert.id), "Alert acknowledged")}>
                                <Check className="h-3.5 w-3.5" aria-hidden="true" />
                                Acknowledge
                            </Button>
                        ) : null}
                        {alert.state === "SILENCED" ? (
                            <Button variant="outline" size="sm" className="h-8" disabled={busy} onClick={() => act(() => unsilenceAlert(alert.id), "Silence removed")}>
                                Remove silence
                            </Button>
                        ) : (
                            <SilenceMenu compact onChoose={(until) => act(() => silenceAlert(alert.id, until), "Alert silenced")} />
                        )}
                        <Button variant="outline" size="sm" className="h-8 gap-1.5" disabled={busy} onClick={() => act(() => resolveAlert(alert.id), "Alert resolved")}>
                            <CheckCheck className="h-3.5 w-3.5" aria-hidden="true" />
                            Resolve
                        </Button>
                    </div>
                )}
            </div>

            {open ? (
                <div className="space-y-3 border-t border-border/60 bg-muted/30 px-4 py-3 sm:pl-11">
                    {alert.detail ? <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-background p-2 font-mono text-xs">{alert.detail}</pre> : null}
                    <div className="flex flex-wrap gap-2">
                        <Button asChild variant="outline" size="sm" className="h-8">
                            <Link href={`/devices/${encodeURIComponent(alert.device.id)}`}>Open {alert.device.name}</Link>
                        </Button>
                        {alert.ticketId ? (
                            <Button asChild variant="outline" size="sm" className="h-8 gap-1.5">
                                <Link href={`/tickets/${alert.ticketId}`}>
                                    <Ticket className="h-3.5 w-3.5" aria-hidden="true" />
                                    Open ticket
                                </Link>
                            </Button>
                        ) : (
                            <Button variant="outline" size="sm" className="h-8 gap-1.5" disabled={busy} onClick={() => act(() => openAlertTicket(alert.id), "Ticket opened")}>
                                <Ticket className="h-3.5 w-3.5" aria-hidden="true" />
                                Create ticket
                            </Button>
                        )}
                    </div>
                    <Timeline id={alert.id} />
                </div>
            ) : null}
        </li>
    );
}

export default function AlertsPage() {
    const [view, setView] = React.useState<AlertState | "settings" | "checks">("OPEN");
    const [severity, setSeverity] = React.useState<AlertSeverity | "">(() => readParam<AlertSeverity>("severity", ["CRIT", "WARN"]) ?? "");
    const [query, setQuery] = React.useState("");
    const [alerts, setAlerts] = React.useState<Alert[]>([]);
    const [nextCursor, setNextCursor] = React.useState<string | null>(null);
    const [loading, setLoading] = React.useState(true);
    const [error, setError] = React.useState<string | null>(null);
    const [selected, setSelected] = React.useState<Set<string>>(new Set());

    const load = React.useCallback(async (cursor?: string | null) => {
        if (view === "settings" || view === "checks") return;
        setLoading(true);
        try {
            const page = await fetchAlerts({ state: view, severity: severity || undefined, q: query, cursor, limit: 200 });
            setAlerts((prev) => (cursor ? [...prev, ...page.items] : page.items));
            setNextCursor(page.nextCursor);
            setError(null);
        } catch (e) {
            setError(errorText(e));
        } finally {
            setLoading(false);
        }
    }, [query, severity, view]);

    React.useEffect(() => {
        setSelected(new Set());
        const timer = window.setTimeout(() => void load(), 250);
        return () => window.clearTimeout(timer);
    }, [load]);

    // Replacing the list while someone is paging through would lose their place.
    React.useEffect(() => {
        const timer = window.setInterval(() => {
            if (!document.hidden && !nextCursor) void load();
        }, REFRESH_MS);
        return () => window.clearInterval(timer);
    }, [load, nextCursor]);

    useAutoLoadMore(nextCursor, loading, alerts.length, () => void load(nextCursor));
    const paged = usePaged(alerts, "alerts", 50);

    const runBulk = async (action: "ack" | "silence" | "resolve", until?: string) => {
        try {
            const result = await bulkAlerts(action, Array.from(selected), until);
            toast({
                title: `${result.updated} ${result.updated === 1 ? "alert" : "alerts"} updated`,
                description: result.failed.length ? `${result.failed.length} could not be changed.` : undefined,
                variant: result.failed.length ? "warning" : "success",
            });
            setSelected(new Set());
            void load();
        } catch (e) {
            toast({ title: "That did not work", description: errorText(e), variant: "destructive", duration: 10_000 });
        }
    };

    return (
        <PageShell>
            <PageHeader
                title="Alerts"
                actions={
                    <>
                    <Button variant={view === "checks" ? "default" : "outline"} size="sm" className="gap-2" onClick={() => setView(view === "checks" ? "OPEN" : "checks")}>
                        <Activity className="h-4 w-4" aria-hidden="true" />
                        Checks
                    </Button>
                    <Button variant={view === "settings" ? "default" : "outline"} size="sm" className="gap-2" onClick={() => setView(view === "settings" ? "OPEN" : "settings")}>
                        <Settings2 className="h-4 w-4" aria-hidden="true" />
                        Notifications and settings
                    </Button>
                    </>
                }
            />

            {view === "settings" ? (
                <AlertSettingsPanel />
            ) : view === "checks" ? (
                <ChecksPanel />
            ) : (
                <>
                    <ListToolbar
                        left={
                            <SegmentedTabs
                                label="Alert state"
                                items={TABS.map((t) => ({ key: t.value, label: t.label }))}
                                value={view}
                                onChange={(k) => setView(k as AlertState)}
                            />
                        }
                        right={
                            <>
                                <FilterSelect
                                    label="Severity"
                                    value={severity}
                                    onChange={(v) => setSeverity(v as AlertSeverity | "")}
                                    options={[
                                        { value: "", label: "All severities" },
                                        { value: "CRIT", label: "Critical" },
                                        { value: "WARN", label: "Warning" },
                                    ]}
                                />
                                <SearchField value={query} onChange={setQuery} placeholder="Find an alert" />
                                <Button variant="ghost" size="icon" aria-label="Refresh" title="Refresh" onClick={() => void load()}>
                                    <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} aria-hidden="true" />
                                </Button>
                            </>
                        }
                    />

                    {selected.size > 0 ? (
                        <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 px-3 py-2">
                            <span className="text-sm font-medium">{selected.size} selected</span>
                            <Button variant="outline" size="sm" className="h-8" onClick={() => void runBulk("ack")}>Acknowledge</Button>
                            <SilenceMenu onChoose={(until) => void runBulk("silence", until)} />
                            <Button variant="outline" size="sm" className="h-8" onClick={() => void runBulk("resolve")}>Resolve</Button>
                            <Button variant="ghost" size="sm" className="h-8" onClick={() => setSelected(new Set())}>Clear</Button>
                        </div>
                    ) : null}

                    {error ? <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm">{error}</div> : null}

                    {alerts.length === 0 && !loading ? (
                        <EmptyState>{view === "OPEN" ? "No open alerts. Everything is quiet." : "Nothing here."}</EmptyState>
                    ) : (
                        <div className="overflow-hidden rounded-xl border border-border/70 bg-card">
                            <ul className="divide-y divide-border/60">
                                {paged.rows.map((alert) => (
                                    <AlertRow
                                        key={alert.id}
                                        alert={alert}
                                        selected={selected.has(alert.id)}
                                        onSelect={(on) =>
                                            setSelected((prev) => {
                                                const next = new Set(prev);
                                                if (on) next.add(alert.id);
                                                else next.delete(alert.id);
                                                return next;
                                            })
                                        }
                                        onChanged={() => void load()}
                                    />
                                ))}
                            </ul>
                        </div>
                    )}
                    {loading && alerts.length === 0 ? <p className="text-sm text-muted-foreground">Loading…</p> : null}

                    <Pager paged={paged} noun="alerts" />
                    {nextCursor && alerts.length >= LOAD_CAP ? <p className="text-xs text-muted-foreground">Showing the newest {LOAD_CAP}.</p> : null}
                </>
            )}
        </PageShell>
    );
}
