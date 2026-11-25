"use client";

// components/overview/overview-view.tsx
//
// The Overview page, drawn from data it is given (nothing here fetches). Top to bottom, each section has one job:
//   header          title, one sentence, customer filter, last updated + refresh, Customize
//   Needs attention what to do right now (or "All clear")
//   status strip    Online, Offline, Critical, Warning, Total
//   summary cards   Security, Patching, Service desk, Today's schedule, Agent versions, Recent activity
//   fleet breakdown the charts, collapsible
// An install with no devices gets a start panel instead of all of that.
import * as React from "react";
import { AlertTriangle, ChevronDown, Lock, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
    DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PageShell } from "@/components/page-shell";
import { FilterSelect } from "@/components/list-controls";
import { cn } from "@/lib/utils";
import type { DashboardSummary } from "@/lib/dashboard-api";
import { BREAKDOWN_KEYS, CARD_CATALOG, GROUP_LABEL, SUMMARY_KEYS, type CardGroup } from "./catalog";
import { NeedsAttention } from "./attention";
import { StatusStrip, tilesOf } from "./status-strip";
import { SummaryCard, availableSummary } from "./summary-cards";
import { BreakdownChart, type BreakdownData } from "./fleet-breakdown";
import { CardGrid, CHART_ROWS, SUMMARY_ROWS, type GridCard } from "./card-grid";
import { StartPanel } from "./start-panel";
import { Bone, RefreshButton, SectionTitle } from "./parts";
import { clock, fmt } from "./format";
import type { SummaryState } from "./use-overview-data";

export type OverviewProps = {
    state: SummaryState;
    onRefresh: () => void;
    customers: Array<{ id: string; name: string }>;
    clientId: string;
    clientName: string | null;
    onClientChange: (id: string) => void;
    canAdmin: boolean;
    breakdown: BreakdownData & { open: boolean; onToggle: () => void };
    hidden: string[];
    onHiddenChange: (next: string[]) => void;
    summaryOrder: string[];
    breakdownOrder: string[];
    onReorder: (group: "summary" | "breakdown", order: string[]) => void;
};

/** The one plain sentence under the title. */
export function headline(s: DashboardSummary | null, clientName: string | null, failed = false): string {
    const d = s?.devices;
    const where = clientName ? ` for ${clientName}` : "";
    if (!s) return failed ? "The latest numbers are not available right now." : "Loading the latest numbers…";
    if (!d) return "Here is what needs your attention.";
    if (d.total === 0) return clientName ? `No devices for ${clientName} yet.` : "No devices have checked in yet.";
    const critical = s.alerts?.devicesCritical ?? 0;
    if (critical > 0) return `${fmt(critical)} ${critical === 1 ? "device needs" : "devices need"} attention now, out of ${fmt(d.total)}${where}.`;
    if (s.attention.some((i) => i.severity === "critical")) return `Some things need attention now, across ${fmt(d.total)} ${d.total === 1 ? "device" : "devices"}${where}.`;
    // Without the right to see alerts, "free of critical problems" would be a guess.
    if (!s.alerts) return `${fmt(d.online)} of ${fmt(d.total)} ${d.total === 1 ? "device is" : "devices are"} online${where}.`;
    return `All ${fmt(d.total)} ${d.total === 1 ? "device is" : "devices are"} free of critical problems${where}.`;
}

function useCanArrange() {
    const [can, setCan] = React.useState(false);
    React.useEffect(() => {
        const mq = window.matchMedia("(min-width: 1280px)");
        const update = () => setCan(mq.matches);
        update();
        mq.addEventListener("change", update);
        return () => mq.removeEventListener("change", update);
    }, []);
    return can;
}

function CustomizeMenu({ hidden, onChange }: { hidden: string[]; onChange: (next: string[]) => void }) {
    const shown = CARD_CATALOG.length - CARD_CATALOG.filter((c) => hidden.includes(c.key)).length;
    const set = (key: string, off: boolean) => onChange(off ? (hidden.includes(key) ? hidden : [...hidden, key]) : hidden.filter((k) => k !== key));
    const groups: CardGroup[] = ["status", "summary", "breakdown"];
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="h-9 gap-2" title="Show or hide cards">
                    <SlidersHorizontal className="h-4 w-4" aria-hidden />
                    Customize
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-[70vh] w-64 overflow-y-auto">
                <DropdownMenuLabel>Cards ({shown}/{CARD_CATALOG.length})</DropdownMenuLabel>
                {groups.map((g) => (
                    <React.Fragment key={g}>
                        <DropdownMenuSeparator />
                        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">{GROUP_LABEL[g]}</DropdownMenuLabel>
                        {CARD_CATALOG.filter((c) => c.group === g).map(({ key, label }) => (
                            <DropdownMenuCheckboxItem key={key} checked={!hidden.includes(key)} onCheckedChange={(on) => set(key, !on)} onSelect={(e) => e.preventDefault()} className="truncate">
                                {label}
                            </DropdownMenuCheckboxItem>
                        ))}
                    </React.Fragment>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={(e) => { e.preventDefault(); onChange([]); }} disabled={hidden.length === 0}>Show all</DropdownMenuItem>
                <DropdownMenuItem onSelect={(e) => { e.preventDefault(); onChange(CARD_CATALOG.map((c) => c.key)); }} disabled={shown === 0}>Hide all</DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

export function OverviewView(p: OverviewProps) {
    const { state, hidden } = p;
    const s = state.data;
    const canArrange = useCanArrange();
    const isHidden = React.useCallback((k: string) => hidden.includes(k), [hidden]);
    const [attentionOpen, setAttentionOpen] = React.useState(false);

    const empty = !!s?.setup && !s.setup.hasDevices;
    const nothingVisible = !!s && !s.devices && !s.alerts && !s.tickets && !s.schedule && !s.activity && !s.security && !s.patching && !s.agents;
    const tiles = s ? tilesOf(s, isHidden) : null;

    const summaryKeys = s ? availableSummary(s).filter((k) => !isHidden(k)) : [];
    const summaryCards: GridCard[] = s ? summaryKeys.map((k) => ({ key: k, node: <SummaryCard cardKey={k} s={s} canAdmin={p.canAdmin} /> })) : [];
    const breakdownKeys = BREAKDOWN_KEYS.filter((k) => !isHidden(k));
    const showBreakdown = !!s?.devices && s.devices.total > 0 && breakdownKeys.length > 0;
    const chartCards: GridCard[] = breakdownKeys.map((k) => ({ key: k, node: <BreakdownChart cardKey={k} data={p.breakdown} /> }));

    return (
        <PageShell className="space-y-8">
            {/* header */}
            <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                <div className="min-w-0">
                    <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
                    <p className="mt-1 text-sm text-muted-foreground" aria-live="polite">{headline(s, p.clientName, !!state.error)}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2 lg:justify-end">
                    {p.customers.length > 1 ? (
                        <FilterSelect
                            label="Customer" value={p.clientId} onChange={p.onClientChange} className="h-9 max-w-[16rem] truncate"
                            options={[{ value: "", label: "All customers" }, ...p.customers.map((c) => ({ value: c.id, label: c.name }))]}
                        />
                    ) : null}
                    <span className="order-last w-full text-xs text-muted-foreground sm:order-none sm:w-auto" role="status">
                        {state.error && s ? <span className="inline-flex items-center gap-1"><AlertTriangle className="h-3.5 w-3.5" aria-hidden /> Could not refresh</span> : state.updatedAt ? `Updated ${clock(state.updatedAt)}` : ""}
                    </span>
                    <RefreshButton busy={state.refreshing} onClick={p.onRefresh} />
                    <CustomizeMenu hidden={hidden} onChange={p.onHiddenChange} />
                </div>
            </header>

            {state.error && !s ? (
                <Card className="flex flex-col items-start gap-3 p-6" role="alert">
                    <div className="flex items-center gap-2 font-medium"><AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-400" aria-hidden /> The overview could not be loaded</div>
                    <p className="text-sm text-muted-foreground">{state.error}</p>
                    <Button type="button" size="sm" onClick={p.onRefresh}>Try again</Button>
                </Card>
            ) : empty ? (
                <StartPanel customers={s!.setup!.customers} canAdmin={p.canAdmin} canCustomers={!!s!.access.customers} />
            ) : nothingVisible ? (
                <Card className="flex items-start gap-3 p-6" role="status">
                    <Lock className="mt-0.5 h-5 w-5 text-muted-foreground" aria-hidden />
                    <div>
                        <p className="font-medium">Nothing to show here yet</p>
                        <p className="mt-1 text-sm text-muted-foreground">Your role does not include any of the overview sections. Ask an administrator if you need access.</p>
                    </div>
                </Card>
            ) : (
                <>
                    <section aria-label="Needs attention and device status" className="space-y-4">
                        <NeedsAttention items={s ? s.attention : null} loading={state.loading} updatedAt={state.updatedAt} expanded={attentionOpen} onToggle={() => setAttentionOpen((v) => !v)} />
                        <StatusStrip tiles={tiles} loading={state.loading} />
                        {s?.devices && s.devices.total === 0 && s.setup?.hasDevices ? (
                            <p className="text-sm text-muted-foreground">{p.clientName ? `${p.clientName} has no devices yet.` : "No devices yet."}</p>
                        ) : null}
                    </section>

                    {state.loading && !s ? (
                        <section aria-label="Loading summaries" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" role="status">
                            {[0, 1, 2].map((i) => <Bone key={i} className="h-[200px]" />)}
                        </section>
                    ) : summaryCards.length > 0 ? (
                        <section aria-labelledby="ov-summaries" className="space-y-4">
                            <SectionTitle id="ov-summaries" title="At a glance" />
                            <CardGrid
                                label="Summary cards" cards={summaryCards} order={p.summaryOrder} canArrange={canArrange} cardWidth={4} rows={SUMMARY_ROWS}
                                plainClass="grid-cols-1 sm:grid-cols-2 xl:grid-cols-3" onReorder={(o) => p.onReorder("summary", o)}
                            />
                        </section>
                    ) : null}

                    {showBreakdown ? (
                        <section aria-labelledby="ov-breakdown" className="space-y-4">
                            <SectionTitle
                                id="ov-breakdown" title="Fleet breakdown" hint="Your devices by status, system, customer and site."
                                right={
                                    <Button type="button" variant="ghost" size="sm" className="h-8 gap-1" onClick={p.breakdown.onToggle} aria-expanded={p.breakdown.open} aria-controls="ov-breakdown-body">
                                        {p.breakdown.open ? "Hide" : "Show"}
                                        <ChevronDown className={cn("h-4 w-4 transition-transform motion-reduce:transition-none", p.breakdown.open && "rotate-180")} aria-hidden />
                                    </Button>
                                }
                            />
                            <div id="ov-breakdown-body" hidden={!p.breakdown.open}>
                                {p.breakdown.open ? (
                                    <CardGrid
                                        label="Fleet breakdown charts" cards={chartCards} order={p.breakdownOrder} canArrange={canArrange} cardWidth={6} rows={CHART_ROWS}
                                        plainClass="grid-cols-1 lg:grid-cols-2" plainHeight={392} onReorder={(o) => p.onReorder("breakdown", o)}
                                    />
                                ) : null}
                            </div>
                        </section>
                    ) : null}
                </>
            )}
        </PageShell>
    );
}

export { SUMMARY_KEYS };
