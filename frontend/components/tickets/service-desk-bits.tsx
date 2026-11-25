"use client";

// The tickets list's service desk parts: views (all, mine, unassigned), a queue and an SLA filter with the counts the
// server gives, the notices people get when a ticket's SLA is close to its limit or has been missed, and a queue picker.
import * as React from "react";
import Link from "next/link";
import { BellRing, X } from "lucide-react";
import { readParam } from "@/lib/url-params";
import { Button } from "@/components/ui/button";
import { FilterSelect, SegmentedTabs } from "@/components/list-controls";
import { jfetch } from "@/lib/api";

type Counts = { open: number; mine: number; unassigned: number; noQueue: number; breached: number; queues: { id: string; name: string; enabled: boolean; open: number; unassigned: number }[] };

const SLA_OPTIONS = [
    { value: "any", label: "Any SLA" },
    { value: "breached", label: "SLA breached" },
    { value: "warning", label: "SLA warning" },
    { value: "at_risk", label: "Breached or warning" },
    { value: "paused", label: "On hold" },
    { value: "ok", label: "On track" },
    { value: "none", label: "No SLA" },
];

/** The filters, as a query string for /api/tickets, and the controls that set them. */
export function useServiceDeskFilters() {
    // The Overview opens this list already narrowed (?view=unassigned, ?sla=breached).
    const [view, setView] = React.useState<string>(() => readParam("view", ["all", "mine", "unassigned"] as const) ?? "all");
    const [queue, setQueue] = React.useState("all");
    const [sla, setSla] = React.useState<string>(() => readParam("sla", ["breached", "warning", "at_risk", "paused", "ok", "none"] as const) ?? "any");
    const [counts, setCounts] = React.useState<Counts | null>(null);
    const [available, setAvailable] = React.useState(true);

    React.useEffect(() => {
        let stopped = false;
        const load = () => {
            if (document.visibilityState === "hidden") return;
            jfetch<Counts>("/api/ticket-queues/counts")
                .then((c) => { if (!stopped) setCounts(c); })
                .catch(() => { if (!stopped) setAvailable(false); });
        };
        load();
        const t = window.setInterval(load, 30_000);
        return () => { stopped = true; window.clearInterval(t); };
    }, []);

    const qs = React.useMemo(() => {
        const p = new URLSearchParams();
        if (view === "mine") p.set("assignee", "me");
        if (view === "unassigned") p.set("assignee", "unassigned");
        if (queue !== "all") p.set("queueId", queue);
        if (sla !== "any") p.set("sla", sla);
        return p.toString();
    }, [view, queue, sla]);

    const queueOptions = React.useMemo(() => {
        const q = counts?.queues ?? [];
        return [
            { value: "all", label: "Any queue" },
            ...q.filter((x) => x.enabled || x.open > 0).map((x) => ({ value: x.id, label: `${x.name} (${x.open})` })),
            ...(q.length ? [{ value: "none", label: `No queue${counts ? ` (${counts.noQueue})` : ""}` }] : []),
        ];
    }, [counts]);

    const controls = available ? (
        <>
            <SegmentedTabs
                label="Whose tickets"
                value={view}
                onChange={setView}
                items={[
                    { key: "all", label: "All" },
                    { key: "mine", label: "My tickets", count: counts?.mine },
                    { key: "unassigned", label: "Unassigned", count: counts?.unassigned },
                ]}
            />
            {(counts?.queues.length ?? 0) > 0 ? <FilterSelect label="Filter by queue" value={queue} onChange={setQueue} options={queueOptions} /> : null}
            <FilterSelect label="Filter by SLA" value={sla} onChange={setSla} options={SLA_OPTIONS} />
        </>
    ) : null;

    return { qs, active: qs.length > 0, controls, counts, queues: counts?.queues ?? [] };
}

type Notice = { id: string; kind: string; title: string; body: string; ticketId: string | null; createdAt: string };

/** Notices for the signed-in person: SLA warnings and breaches, and tickets handed to them by a rule. */
export function SlaNotices() {
    const [items, setItems] = React.useState<Notice[]>([]);

    const load = React.useCallback(() => {
        jfetch<{ items: Notice[] }>("/api/sla/notices").then((r) => setItems(r.items)).catch(() => undefined);
    }, []);
    React.useEffect(() => {
        load();
        const t = window.setInterval(() => { if (document.visibilityState === "visible") load(); }, 30_000);
        return () => window.clearInterval(t);
    }, [load]);

    async function dismiss(ids: string[] | "all") {
        setItems((cur) => (ids === "all" ? [] : cur.filter((n) => !ids.includes(n.id))));
        try {
            await jfetch("/api/sla/notices/read", { method: "POST", body: ids === "all" ? { all: true } : { ids } });
        } catch {
            load();
        }
    }

    if (!items.length) return null;
    const shown = items.slice(0, 5);
    return (
        <div role="status" aria-live="polite" className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            <div className="mb-2 flex items-center justify-between gap-2">
                <span className="flex items-center gap-2 font-medium"><BellRing className="h-4 w-4" aria-hidden /> {items.length === 1 ? "1 notice" : `${items.length} notices`}</span>
                <Button size="sm" variant="ghost" onClick={() => void dismiss("all")}>Dismiss all</Button>
            </div>
            <ul className="grid gap-1.5">
                {shown.map((n) => (
                    <li key={n.id} className="flex items-start justify-between gap-2">
                        <span className="min-w-0">
                            {n.ticketId ? <Link href={`/tickets/${n.ticketId}`} className="font-medium hover:underline" onClick={() => void dismiss([n.id])}>{n.title}</Link> : <span className="font-medium">{n.title}</span>}
                            {n.body ? <span className="block truncate text-xs text-muted-foreground" title={n.body}>{n.body}</span> : null}
                        </span>
                        <Button size="icon" variant="ghost" className="h-6 w-6 shrink-0" aria-label="Dismiss this notice" onClick={() => void dismiss([n.id])}><X className="h-3.5 w-3.5" /></Button>
                    </li>
                ))}
            </ul>
            {items.length > shown.length ? <div className="mt-1 text-xs text-muted-foreground">and {items.length - shown.length} more</div> : null}
        </div>
    );
}

/** A queue to choose when making a ticket. Hidden when there are no queues. */
export function QueueSelect({ value, onChange, queues, id = "nt-queue" }: { value: string; onChange: (v: string) => void; queues: { id: string; name: string; enabled: boolean }[]; id?: string }) {
    const usable = queues.filter((q) => q.enabled);
    if (!usable.length) return null;
    return (
        <div className="grid gap-1">
            <label htmlFor={id} className="text-xs text-muted-foreground">Queue (rules may choose one when you leave this empty)</label>
            <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className="h-10 rounded-md border border-input bg-background px-3 text-sm">
                <option value="">No queue</option>
                {usable.map((q) => (
                    <option key={q.id} value={q.id}>{q.name}</option>
                ))}
            </select>
        </div>
    );
}
