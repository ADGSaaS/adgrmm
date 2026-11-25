"use client";

// The controls above every list, so every page has the same ones:
//   <SegmentedTabs>  status tabs with counts (All / Open / Resolved ...)
//   <FilterSelect>   a dropdown filter (priority, customer, period ...)
//   <SearchField>    the search box with a magnifier
//   <ListToolbar>    lays them out: tabs on the left, filters and search on the right; stacks on a phone
//   <EmptyState>     the message when a list has nothing in it
// Pair them with <DataTable> for the table and <Pager> / usePaged for paging.
import * as React from "react";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";

export type SegmentedItem = { key: string; label: string; count?: number };

export function SegmentedTabs({ items, value, onChange, label = "Filter" }: { items: SegmentedItem[]; value: string; onChange: (key: string) => void; label?: string }) {
    return (
        <div role="tablist" aria-label={label} className="flex flex-wrap gap-1 rounded-xl border border-border/70 bg-card p-1">
            {items.map((tab) => (
                <button
                    key={tab.key}
                    role="tab"
                    type="button"
                    aria-selected={value === tab.key}
                    onClick={() => onChange(tab.key)}
                    className={cn(
                        "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
                        value === tab.key ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:bg-accent hover:text-foreground",
                    )}
                >
                    {tab.label}
                    {tab.count !== undefined ? (
                        <span className={cn("rounded-full px-1.5 text-[11px] tabular-nums", value === tab.key ? "bg-primary-foreground/20" : "bg-muted")}>{tab.count}</span>
                    ) : null}
                </button>
            ))}
        </div>
    );
}

export type FilterOption = { value: string; label: string };

/** A dropdown filter. One look everywhere: same height, corners and colours as the search box. */
export function FilterSelect({
    value,
    onChange,
    options,
    label,
    className,
}: {
    value: string;
    onChange: (value: string) => void;
    options: FilterOption[];
    /** Read out by screen readers; there is no visible label. */
    label: string;
    className?: string;
}) {
    return (
        <select
            aria-label={label}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className={cn("h-10 rounded-lg border border-input bg-card px-3 text-sm shadow-sm outline-none focus:border-ring focus:ring-1 focus:ring-ring", className)}
        >
            {options.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
            ))}
        </select>
    );
}

export function SearchField({ value, onChange, placeholder = "Search", label, className }: { value: string; onChange: (value: string) => void; placeholder?: string; label?: string; className?: string }) {
    return (
        <div className={cn("relative w-full sm:w-72", className)}>
            <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" aria-hidden="true" />
            <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={label ?? placeholder} className="pl-9" />
        </div>
    );
}

/** Tabs on the left, filters and search on the right. Stacks on a phone. */
export function ListToolbar({ left, right, className }: { left?: React.ReactNode; right?: React.ReactNode; className?: string }) {
    return (
        <div className={cn("flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between", className)}>
            <div className="min-w-0">{left}</div>
            <div className="flex flex-wrap items-center gap-2">{right}</div>
        </div>
    );
}

export function EmptyState({ children, className }: { children: React.ReactNode; className?: string }) {
    return <div className={cn("rounded-xl border border-dashed border-border/70 px-4 py-10 text-center text-sm text-muted-foreground", className)}>{children}</div>;
}
