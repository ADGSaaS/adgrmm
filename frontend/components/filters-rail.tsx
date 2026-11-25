// components/filters-rail.tsx
"use client";

import * as React from "react";
import {
    useDashboard,
    type DeviceStatus,
    type Device,
} from "@/app/(dashboard)/dashboard-context";
import { Card } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { jfetch } from "@/lib/api";

// Canonical labels for the UI (and what we store)
const STATUS_LABELS = ["Healthy", "Warning", "Critical", "Offline"] as const;
type StatusLabel = (typeof STATUS_LABELS)[number];

/** `searchColumn` adds a search box under the heading that filters that table column (the device list uses it for the host name). */
export default function FiltersRail({ searchColumn, searchPlaceholder = "Filter devices…" }: { searchColumn?: string; searchPlaceholder?: string }) {
    const {
        operatingSystems, // e.g. ["Windows", "Linux", "macOS"]
        activeFilters,    // { status: DeviceStatus[]; os: Device["os"][] }
        setActiveFilters,
        columnFilters,
        setColumnFilters,
    } = useDashboard();

    const searchValue = searchColumn ? String(columnFilters.find((c) => c.id === searchColumn)?.value ?? "") : "";
    const setSearch = (value: string) =>
        setColumnFilters((prev) => [...prev.filter((c) => c.id !== searchColumn), ...(value ? [{ id: searchColumn!, value }] : [])]);

    const [tagList, setTagList] = React.useState<{ id: string; name: string }[]>([]);
    const [tagsLoaded, setTagsLoaded] = React.useState(false);
    const [droppedTags, setDroppedTags] = React.useState(0);
    React.useEffect(() => {
        jfetch<{ items: { id: string; name: string }[] }>("/api/tags").then((r) => { setTagList(r.items); setTagsLoaded(true); }).catch(() => setTagList([]));
    }, []);
    // A saved view can name a tag that was deleted since. It would hide every device without any way to see why, so it is let go and said so.
    React.useEffect(() => {
        if (!tagsLoaded) return;
        const known = new Set(tagList.map((t) => t.id));
        const stale = (activeFilters.tags ?? []).filter((id) => !known.has(id));
        if (!stale.length) return;
        setDroppedTags((n) => n + stale.length);
        setActiveFilters((prev) => ({ ...prev, tags: (prev.tags ?? []).filter((id) => known.has(id)) }));
    }, [tagsLoaded, tagList, activeFilters.tags, setActiveFilters]);

    // Build OS options from canonical values in context
    const osOptions = React.useMemo(
        () =>
            (operatingSystems ?? []).map((os) => ({
                key: os as Device["os"], // ensure canonical union type
                label: os === "macOS" ? "macOS" : os,
            })),
        [operatingSystems]
    );

    // Sets for quick membership checks
    const statusSet = React.useMemo(
        () => new Set(activeFilters.status ?? []),
        [activeFilters.status]
    );
    const osSet = React.useMemo(
        () => new Set(activeFilters.os ?? []),
        [activeFilters.os]
    );

    // Mutators (strictly typed)
    const toggleStatus = (label: StatusLabel, checked: boolean) => {
        const key = label as DeviceStatus; // TitleCase is valid in your union
        setActiveFilters((prev) => {
            const curr = new Set<DeviceStatus>(prev.status ?? []);
            if (checked) curr.add(key);
            else curr.delete(key);
            return { ...prev, status: Array.from(curr) as DeviceStatus[] };
        });
    };

    const toggleOs = (os: Device["os"], checked: boolean) => {
        setActiveFilters((prev) => {
            const curr = new Set<Device["os"]>(prev.os ?? []);
            if (checked) curr.add(os);
            else curr.delete(os);
            return { ...prev, os: Array.from(curr) as Device["os"][] };
        });
    };

    const toggleTag = (id: string, checked: boolean) =>
        setActiveFilters((prev) => {
            const curr = new Set(prev.tags ?? []);
            if (checked) curr.add(id);
            else curr.delete(id);
            return { ...prev, tags: Array.from(curr) };
        });
    const tagSet = new Set(activeFilters.tags ?? []);

    // Merge so future fields (if any) aren't wiped
    const clearAll = () =>
        setActiveFilters((prev) => ({
            ...prev,
            status: [] as DeviceStatus[],
            os: [] as Device["os"][],
            tags: [] as string[],
        }));

    return (
        <Card className="p-3 space-y-4">
            <div className="flex items-center justify-between">
                <h2 className="text-base font-semibold">Filters</h2>
                <Button
                    variant="outline"
                    size="sm"
                    onClick={clearAll}
                    title="Clear all filters"
                    aria-label="Clear all filters"
                >
                    Clear
                </Button>
            </div>

            {searchColumn ? (
                <Input value={searchValue} onChange={(e) => setSearch(e.target.value)} placeholder={searchPlaceholder} aria-label={searchPlaceholder} />
            ) : null}

            <div>
                <div className="text-xs font-medium text-muted-foreground mb-2">Status</div>
                <div className="space-y-2">
                    {STATUS_LABELS.map((label) => {
                        const checked = statusSet.has(label as DeviceStatus);
                        return (
                            <label key={label} className="flex items-center gap-2">
                                <Checkbox
                                    checked={checked}
                                    onCheckedChange={(v) => toggleStatus(label, v === true)}
                                    aria-label={label}
                                />
                                <span className="text-sm">{label}</span>
                            </label>
                        );
                    })}
                </div>
            </div>

            <Separator />

            <div>
                <div className="text-xs font-medium text-muted-foreground mb-2">OS</div>
                <div className="space-y-2">
                    {osOptions.map(({ key, label }) => {
                        const checked = osSet.has(key);
                        return (
                            <label key={key} className="flex items-center gap-2">
                                <Checkbox
                                    checked={checked}
                                    onCheckedChange={(v) => toggleOs(key, v === true)}
                                    aria-label={label}
                                />
                                <span className="text-sm">{label}</span>
                            </label>
                        );
                    })}
                </div>
            </div>

            {tagList.length > 0 && (
                <>
                    <Separator />
                    <div>
                        <div className="text-xs font-medium text-muted-foreground mb-2">Tags</div>
                        {droppedTags > 0 ? <p role="status" className="mb-2 text-xs text-amber-700 dark:text-amber-400">{droppedTags === 1 ? "A tag in this view no longer exists, so it was left out." : `${droppedTags} tags in this view no longer exist, so they were left out.`}</p> : null}
                        <div className="space-y-2">
                            {tagList.map((t) => (
                                <label key={t.id} className="flex items-center gap-2">
                                    <Checkbox checked={tagSet.has(t.id)} onCheckedChange={(v) => toggleTag(t.id, v === true)} aria-label={`Tag ${t.name}`} />
                                    <span className="text-sm">{t.name}</span>
                                </label>
                            ))}
                        </div>
                    </div>
                </>
            )}
        </Card>
    );
}
