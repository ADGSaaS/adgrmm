"use client";

// components/overview/attention.tsx
//
// "Needs attention": one short ranked list of what to do right now, built by the server in plain language. Red is for things
// that are broken or late, amber for things that are drifting, blue for housekeeping. Nothing to do shows a calm "All clear".
import * as React from "react";
import Link from "next/link";
import { AlertTriangle, Bell, CheckCircle2, ChevronRight, CircleHelp, Package, RotateCw, ShieldAlert, Ticket, WifiOff, Rocket, OctagonX } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { AttentionItem, Severity } from "@/lib/dashboard-api";
import { clock, fmt } from "./format";
import { Bone } from "./parts";
import { useNav } from "./nav";

const MAX_ROWS = 8;

const TONE: Record<Severity, { tile: string; label: string }> = {
    critical: { tile: "bg-red-500/10 text-red-600 dark:text-red-400", label: "Urgent" },
    warning: { tile: "bg-amber-500/10 text-amber-600 dark:text-amber-400", label: "Needs a look" },
    info: { tile: "bg-primary/10 text-primary", label: "To do" },
};

function iconFor(item: AttentionItem): React.ComponentType<React.SVGProps<SVGSVGElement>> {
    switch (item.id) {
        case "alerts-critical": return OctagonX;
        case "alerts-open": return Bell;
        case "sla-breached":
        case "sla-risk": return Ticket;
        case "security-critical":
        case "not-scanned": return ShieldAlert;
        case "devices-offline": return WifiOff;
        case "never-checked-in": return CircleHelp;
        case "update-failed": return AlertTriangle;
        case "needs-restart": return RotateCw;
        default: return item.id.startsWith("release-") ? Rocket : item.area === "patching" ? Package : Bell;
    }
}

/** The first number of the sentence in bold, so the eye finds the count first. */
function Sentence({ text, count }: { text: string; count: number }) {
    const shown = fmt(count);
    const raw = String(count);
    const i = text.indexOf(raw);
    if (i < 0) return <>{text}</>;
    return <>{text.slice(0, i)}<strong className="font-semibold tabular-nums">{shown}</strong>{text.slice(i + raw.length)}</>;
}

function Row({ item }: { item: AttentionItem }) {
    const nav = useNav();
    const Icon = iconFor(item);
    const tone = TONE[item.severity];
    return (
        <li>
            <Link
                href={nav.href(item.route, item.query)}
                onClick={(e) => nav.click(e, item.route, item.query)}
                className="group flex items-center gap-3 rounded-lg px-2 py-2 outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none sm:px-3"
            >
                <span className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-lg", tone.tile)} aria-hidden><Icon className="h-4 w-4" /></span>
                <span className="min-w-0 flex-1 text-sm leading-snug">
                    <span className="sr-only">{tone.label}: </span>
                    <Sentence text={item.text} count={item.count} />
                </span>
                <span className="hidden shrink-0 text-sm text-muted-foreground group-hover:text-foreground sm:inline">Open</span>
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground group-hover:text-foreground" aria-hidden />
            </Link>
        </li>
    );
}

export function NeedsAttention({
    items, loading, updatedAt, expanded, onToggle,
}: {
    items: AttentionItem[] | null;
    loading: boolean;
    updatedAt: number | null;
    expanded: boolean;
    onToggle: () => void;
}) {
    const shown = items ? (expanded ? items : items.slice(0, MAX_ROWS)) : [];
    const hidden = items ? Math.max(0, items.length - MAX_ROWS) : 0;
    const urgent = items?.filter((i) => i.severity === "critical").length ?? 0;
    return (
        <Card className="p-2 sm:p-3" role="region" aria-labelledby="ov-attention">
            <div className="flex items-center justify-between gap-3 px-2 pb-1 pt-2 sm:px-3">
                <h2 id="ov-attention" className="text-base font-semibold tracking-tight">Needs attention</h2>
                {items && items.length > 0 ? (
                    <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-medium tabular-nums", urgent ? "bg-red-500/10 text-red-600 dark:text-red-400" : "bg-muted text-muted-foreground")}>
                        {items.length} {items.length === 1 ? "item" : "items"}
                    </span>
                ) : null}
            </div>
            {loading && !items ? (
                <div className="space-y-2 p-2 sm:p-3" role="status" aria-label="Loading what needs attention">
                    {[0, 1, 2].map((i) => <Bone key={i} className="h-10 w-full" />)}
                </div>
            ) : items && items.length === 0 ? (
                <div className="flex items-center gap-3 px-2 pb-3 pt-1 sm:px-3">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" aria-hidden><CheckCircle2 className="h-5 w-5" /></span>
                    <div>
                        <p className="text-sm font-medium">All clear</p>
                        <p className="text-sm text-muted-foreground">Nothing needs your attention right now{updatedAt ? ` (checked ${clock(updatedAt)})` : ""}.</p>
                    </div>
                </div>
            ) : (
                <>
                    <ul className="space-y-0.5">{shown.map((i) => <Row key={i.id} item={i} />)}</ul>
                    {hidden > 0 ? (
                        <div className="px-2 pb-1 pt-1 sm:px-3">
                            <Button type="button" variant="ghost" size="sm" className="h-8 px-2 text-primary" onClick={onToggle} aria-expanded={expanded}>
                                {expanded ? "Show fewer" : `View all ${items!.length}`}
                            </Button>
                        </div>
                    ) : null}
                </>
            )}
        </Card>
    );
}
