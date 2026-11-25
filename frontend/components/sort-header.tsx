"use client";

import * as React from "react";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";

/** The column heading every sortable table uses: small capitals, with an arrow showing the sort. */
export function SortHeader({ column, label }: { column: any; label: string }) {
    const sorted = column.getIsSorted() as false | "asc" | "desc";
    return (
        <button
            type="button"
            onClick={() => column.toggleSorting(sorted === "asc")}
            className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
            aria-label={`Sort by ${label}${sorted ? ` (currently ${sorted === "asc" ? "ascending" : "descending"})` : ""}`}
            title={`Sort by ${label}`}
        >
            {label}
            {sorted === "asc" ? <ArrowUp className="h-3 w-3" aria-hidden /> : sorted === "desc" ? <ArrowDown className="h-3 w-3" aria-hidden /> : <ArrowUpDown className="h-3 w-3 opacity-50" aria-hidden />}
        </button>
    );
}
