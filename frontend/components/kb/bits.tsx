"use client";

import * as React from "react";
import { Users } from "lucide-react";

export function fmtDate(iso: string) {
    return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function fmtDateTime(iso: string) {
    return new Date(iso).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function StatusBadges({ a }: { a: { status: string; customerVisible: boolean } }) {
    return (
        <>
            {a.status === "draft" ? <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-300">Draft</span> : null}
            {a.customerVisible ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-sky-500/15 px-2 py-0.5 text-xs font-medium text-sky-700 dark:text-sky-300" title="Shown to customers in the client portal">
                    <Users className="h-3 w-3" aria-hidden /> Customers
                </span>
            ) : null}
        </>
    );
}
