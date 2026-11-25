"use client";

// components/overview/parts.tsx
// The small pieces every section of the Overview page shares, so they all look and behave the same.
import * as React from "react";
import Link from "next/link";
import { ArrowRight, GripVertical, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/** A grey block that pulses (and stays still when the person asks for less motion). */
export function Bone({ className }: { className?: string }) {
    return <div aria-hidden className={cn("rounded-md bg-muted motion-safe:animate-pulse", className)} />;
}

/** The title of a section of the page. */
export function SectionTitle({ title, hint, right, id }: { title: string; hint?: string; right?: React.ReactNode; id: string }) {
    return (
        <div className="flex items-end justify-between gap-3">
            <div className="min-w-0">
                <h2 id={id} className="text-base font-semibold tracking-tight">{title}</h2>
                {hint ? <p className="mt-0.5 text-sm text-muted-foreground">{hint}</p> : null}
            </div>
            {right ? <div className="shrink-0">{right}</div> : null}
        </div>
    );
}

/** The drag handle shown on a card when cards can be arranged (wide screens only). */
export function MoveHandle({ label }: { label: string }) {
    return (
        <Button
            type="button"
            variant="ghost"
            size="icon"
            title={`Drag to move ${label}`}
            // Moving cards is a mouse job; the Customize menu is the keyboard way to choose what shows. So this is not a tab stop.
            tabIndex={-1}
            aria-hidden
            className="move-handle -mr-2 -mt-1 hidden h-7 w-7 shrink-0 cursor-grab text-muted-foreground opacity-0 transition-opacity focus-visible:opacity-100 active:cursor-grabbing group-hover/card:opacity-100 xl:inline-flex motion-reduce:transition-none"
        >
            <GripVertical className="h-4 w-4" aria-hidden />
        </Button>
    );
}

/** "View ..." link. With an onOpen handler it is a button that does the navigation itself (filters are set first). */
export function OpenLink({ href, onOpen, children }: { href?: string; onOpen?: () => void; children: React.ReactNode }) {
    const cls = "inline-flex items-center gap-1 rounded-sm text-sm font-medium text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring";
    const inner = (<>{children}<ArrowRight className="h-3.5 w-3.5" aria-hidden /></>);
    if (onOpen) return <button type="button" onClick={onOpen} className={cls}>{inner}</button>;
    return <Link href={href ?? "#"} className={cls}>{inner}</Link>;
}

/** A summary card: title, one headline number, a few supporting lines and a link, in the same places on every card. */
export function SummaryShell({
    title, icon: Icon, headline, headlineHint, href, onOpen, linkLabel, children, tone,
}: {
    title: string;
    icon: React.ComponentType<React.SVGProps<SVGSVGElement>>;
    headline: React.ReactNode;
    /** What the headline number counts, in a few words. */
    headlineHint: string;
    href?: string;
    onOpen?: () => void;
    linkLabel: string;
    children?: React.ReactNode;
    tone?: "bad" | "warn";
}) {
    return (
        <Card className="group/card flex h-full flex-col p-5" role="region" aria-label={title}>
            <div className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2 text-muted-foreground">
                    <Icon className="h-4 w-4 shrink-0" aria-hidden />
                    <h3 className="truncate text-sm font-medium">{title}</h3>
                </div>
                <MoveHandle label={title} />
            </div>
            <div className="mt-3 flex items-baseline gap-2">
                <span className={cn("text-3xl font-semibold leading-none tracking-tight tabular-nums",
                    tone === "bad" && "text-red-600 dark:text-red-400", tone === "warn" && "text-amber-600 dark:text-amber-400")}>{headline}</span>
                <span className="min-w-0 truncate text-sm text-muted-foreground">{headlineHint}</span>
            </div>
            <div className="mt-3 min-h-0 flex-1 space-y-1.5 text-sm">{children}</div>
            {href || onOpen ? (
                <div className="mt-3 border-t border-border/60 pt-3">
                    <OpenLink href={href} onOpen={onOpen}>{linkLabel}</OpenLink>
                </div>
            ) : null}
        </Card>
    );
}

/** One supporting line of a card: a short label and a number, aligned the same way everywhere. */
export function Line({ children, value, tone }: { children: React.ReactNode; value?: React.ReactNode; tone?: "bad" | "warn" | "muted" }) {
    return (
        <p className="flex items-baseline justify-between gap-3">
            <span className={cn("min-w-0 truncate", tone === "muted" && "text-muted-foreground")}>{children}</span>
            {value !== undefined ? (
                <span className={cn("shrink-0 font-medium tabular-nums", tone === "bad" && "text-red-600 dark:text-red-400", tone === "warn" && "text-amber-600 dark:text-amber-400")}>{value}</span>
            ) : null}
        </p>
    );
}

/** The refresh button: spins while it works, but only for people who have not asked for less motion. */
export function RefreshButton({ busy, onClick }: { busy: boolean; onClick: () => void }) {
    return (
        <Button type="button" variant="outline" size="icon" className="h-9 w-9" onClick={onClick} disabled={busy} title="Refresh" aria-label="Refresh the overview">
            <RefreshCw className={cn("h-4 w-4", busy && "motion-safe:animate-spin")} aria-hidden />
        </Button>
    );
}
