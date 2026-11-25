// components/billing/shared.tsx
"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export const errorText = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong.");

export const NativeSelect = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(function NativeSelect({ className, ...props }, ref) {
    return <select ref={ref} className={cn("h-9 w-full rounded-md border border-input bg-background px-2 text-sm", className)} {...props} />;
});

const TONES: Record<string, string> = {
    draft: "bg-muted text-muted-foreground",
    pending: "bg-muted text-muted-foreground",
    sent: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
    partial: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
    paused: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
    overdue: "bg-red-500/15 text-red-700 dark:text-red-300",
    declined: "bg-red-500/15 text-red-700 dark:text-red-300",
    paid: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
    accepted: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
    approved: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
    active: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
    void: "bg-muted text-muted-foreground line-through",
    ended: "bg-muted text-muted-foreground",
};

export function StatusPill({ status }: { status: string }) {
    return <span className={cn("inline-block rounded-full px-2 py-0.5 text-xs font-medium capitalize", TONES[status] ?? "bg-muted")}>{status}</span>;
}
