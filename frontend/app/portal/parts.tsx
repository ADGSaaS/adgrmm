"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

const TONE: Record<string, string> = {
    open: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
    in_progress: "bg-indigo-500/15 text-indigo-700 dark:text-indigo-300",
    pending: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
    resolved: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
    closed: "bg-muted text-muted-foreground",
    sent: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
    partial: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
    paid: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
    online: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
    offline: "bg-muted text-muted-foreground",
    overdue: "bg-red-500/15 text-red-700 dark:text-red-300",
};

export function Pill({ tone, children }: { tone: string; children: React.ReactNode }) {
    return <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium", TONE[tone] ?? TONE.closed)}>{children}</span>;
}

export function PageTitle({ title, children }: { title: string; children?: React.ReactNode }) {
    return (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <h1 className="text-xl font-semibold">{title}</h1>
            {children}
        </div>
    );
}

export function Panel({ className, children }: { className?: string; children: React.ReactNode }) {
    return <div className={cn("rounded-xl border bg-card", className)}>{children}</div>;
}

export function Empty({ children }: { children: React.ReactNode }) {
    return <p className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">{children}</p>;
}

/** Loads something once and says plainly when it could not. */
export function useLoad<T>(load: () => Promise<T>, deps: React.DependencyList = []) {
    const [data, setData] = React.useState<T | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const run = React.useCallback(load, deps);
    React.useEffect(() => {
        let stale = false;
        setError(null);
        run().then((d) => { if (!stale) setData(d); }).catch((e) => { if (!stale) setError(e?.message || "Could not load this."); });
        return () => { stale = true; };
    }, [run]);
    return { data, error, setData };
}
