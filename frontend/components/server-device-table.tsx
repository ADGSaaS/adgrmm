"use client";

// Devices in the app's one device table, fetched a page at a time from the server, which also filters and sorts them.
// So a list of ten thousand devices costs the browser one page. The table's heading sort, the filter box and the
// rows-per-page choice all go to the server as they change.
import * as React from "react";
import type { ColumnDef, ColumnFiltersState, RowSelectionState, SortingState, VisibilityState } from "@tanstack/react-table";

import { mapApiToUi, useDashboard, type Device } from "@/app/(dashboard)/dashboard-context";
import { DataTable } from "@/components/data-table";
import { columns as allColumns } from "@/components/device-table-columns";
import type { DeviceFilters, DeviceSortKey } from "@/lib/api";
import { useDevicePage } from "@/lib/use-devices";
import { Button } from "@/components/ui/button";
import DeviceBulkBar from "@/components/bulk/device-bulk-bar";
import { fetchMatchingIds, MAX_BULK } from "@/lib/bulk-api";

/** Table column ids the server can sort by, and what it calls them. */
const SORT_KEYS: Record<string, DeviceSortKey> = {
    hostname: "hostname",
    status: "status",
    client: "client",
    site: "site",
    os: "os",
    user: "user",
    lastResponse: "lastSeen",
};

/** Column filters a saved view can carry, in the words people see. */
const COLUMN_LABELS: Record<string, string> = { status: "Status", os: "Operating system", client: "Customer", site: "Site", user: "User", tags: "Tags", lastResponse: "Last response", hostname: "Name" };

type ColumnFilterNote = { id: string; label: string; text: string; applied: boolean; why?: string };

const asText = (v: unknown) => (Array.isArray(v) ? v.map(String).join(", ") : String(v ?? "")).trim();

/**
 * Saved views and shared links can carry filters on columns other than the filter box. The server filters the list, so
 * the ones it understands go to it (status, operating system, customer, site with its customer, tags) and the others are
 * listed on the page as not applied, with a way to clear them: none is quietly ignored.
 */
export function serverFiltersFromColumns(columnFilters: { id: string; value: unknown }[], boxColumnId: string, fromPage: DeviceFilters): { filters: DeviceFilters; notes: ColumnFilterNote[] } {
    const filters: DeviceFilters = {};
    const notes: ColumnFilterNote[] = [];
    const rest = columnFilters.filter((f) => f.id !== boxColumnId && asText(f.value) !== "");
    const byId = new Map(rest.map((f) => [f.id, f.value]));
    for (const f of rest) {
        const text = asText(f.value);
        const label = COLUMN_LABELS[f.id] ?? f.id;
        const note = (applied: boolean, why?: string) => notes.push({ id: f.id, label, text, applied, why });
        switch (f.id) {
            case "status": {
                const v = (Array.isArray(f.value) ? f.value[0] : f.value) as string;
                if ((v === "online" || v === "offline") && !(Array.isArray(f.value) && f.value.length > 1)) {
                    if (fromPage.status && fromPage.status !== v) note(false, "it conflicts with the status chosen on the left");
                    else { filters.status = v; note(true); }
                } else note(false, "the server filters by online or offline only");
                break;
            }
            case "os": {
                const list = (Array.isArray(f.value) ? f.value : [f.value]).map((x) => String(x).trim().toLowerCase()).filter(Boolean);
                if (!list.length) break;
                if (fromPage.os?.length) note(false, "it conflicts with the system chosen on the left");
                else { filters.os = list; note(true); }
                break;
            }
            case "client": {
                if (fromPage.clientId || fromPage.places?.length) note(false, "it conflicts with the customer chosen on the left");
                else {
                    // A site filter on top of the customer narrows to that site.
                    const site = byId.has("site") ? asText(byId.get("site")) : "";
                    filters.places = [{ client: text, ...(site ? { site } : {}) }];
                    note(true);
                }
                break;
            }
            case "site": {
                if (byId.has("client")) note(true); // applied together with the customer filter above
                else note(false, "the server needs the customer too to find a site by name");
                break;
            }
            case "tags": {
                const ids = (Array.isArray(f.value) ? f.value : [f.value]).map(String).filter(Boolean);
                if (ids.length && !fromPage.tags?.length) { filters.tags = ids; note(true); }
                else note(false, ids.length ? "it conflicts with the tags chosen on the left" : "no tag given");
                break;
            }
            default:
                note(false, "the server cannot filter this column");
        }
    }
    return { filters, notes };
}

type Props = {
    /** What narrows the list besides the table's own filter box (customer, site, status, system, tags). */
    filters: DeviceFilters;
    columns?: ColumnDef<Device>[];
    filterColumnId?: string;
    filterPlaceholder?: string;
    compact?: boolean;
    /** Leave the filter box out (the page puts one elsewhere) and keep the Columns menu in the table's own heading. */
    toolbarElsewhere?: boolean;
    /** Take over Saved Views' table snapshot (one table per page should). */
    registerSnapshot?: boolean;
    /** Told how many devices match, in all. */
    onTotal?: (total: number) => void;
};

/** The filter box's text, a moment after typing stops. */
function useDebounced<T>(value: T, ms = 300): T {
    const [v, setV] = React.useState(value);
    React.useEffect(() => {
        const id = setTimeout(() => setV(value), ms);
        return () => clearTimeout(id);
    }, [value, ms]);
    return v;
}

export default function ServerDeviceTable({
    filters,
    columns = allColumns,
    filterColumnId = "hostname",
    filterPlaceholder = "Filter devices…",
    compact = false,
    toolbarElsewhere = false,
    registerSnapshot = false,
    onTotal,
}: Props) {
    const { sorting, setSorting, columnVisibility, setColumnVisibility, columnFilters, setColumnFilters, registerSnapshotGetter, devicesVersion, aliases } = useDashboard();

    const text = String(columnFilters.find((f) => f.id === filterColumnId)?.value ?? "").trim();
    const q = useDebounced(text);

    const serverSort = React.useMemo(() => {
        const first = sorting.find((s) => SORT_KEYS[s.id]);
        return first ? { sort: SORT_KEYS[first.id], dir: (first.desc ? "desc" : "asc") as "asc" | "desc" } : {};
    }, [sorting]);

    const [paging, setPaging] = React.useState({ pageIndex: 0, pageSize: 25 });
    const fromColumns = React.useMemo(() => serverFiltersFromColumns(columnFilters as { id: string; value: unknown }[], filterColumnId, filters), [columnFilters, filterColumnId, filters]);
    const allFilters = React.useMemo<DeviceFilters>(() => ({ ...fromColumns.filters, ...filters, ...(q ? { q } : {}) }), [fromColumns, filters, q]);
    const { items, total, loading, error } = useDevicePage({ filters: allFilters, ...serverSort, pageIndex: paging.pageIndex, pageSize: paging.pageSize, version: devicesVersion });

    React.useEffect(() => {
        if (!loading) onTotal?.(total);
    }, [total, loading, onTotal]);

    const rows = React.useMemo<Device[]>(
        () => items.map((d) => {
            const ui = mapApiToUi(d);
            return aliases[ui.id] ? { ...ui, alias: aliases[ui.id] } : ui;
        }),
        [items, aliases]
    );

    const server = React.useMemo(
        () => ({
            total,
            loading,
            onPaginationChange: setPaging,
            // Filters that come from outside the table (not its own box, which it watches itself).
            resetKey: JSON.stringify([filters, fromColumns.filters]),
        }),
        [total, loading, filters, fromColumns]
    );

    // Ticked devices, by id with the name they were ticked under. They stay ticked across pages, and are let go when the
    // filters change (so "all selected" never means devices the filters no longer show).
    const [selectNote, setSelectNote] = React.useState<string | null>(null);
    const [picked, setPicked] = React.useState<Record<string, string>>({});
    const filterKey = JSON.stringify(allFilters);
    React.useEffect(() => {
        setPicked({});
        setSelectNote(null);
    }, [filterKey]);
    const rowSelection = React.useMemo<RowSelectionState>(() => Object.fromEntries(Object.keys(picked).map((id) => [id, true])), [picked]);
    const nameOf = React.useCallback((id: string) => {
        const r = rows.find((d) => d.id === id);
        return r ? r.alias || r.hostname : id;
    }, [rows]);
    const setRowSelection = React.useCallback<React.Dispatch<React.SetStateAction<RowSelectionState>>>((upd) => {
        setPicked((prev) => {
            const before: RowSelectionState = Object.fromEntries(Object.keys(prev).map((id) => [id, true]));
            const next = typeof upd === "function" ? upd(before) : upd;
            const out: Record<string, string> = {};
            for (const [id, on] of Object.entries(next)) if (on) out[id] = prev[id] ?? nameOf(id);
            return out;
        });
    }, [nameOf]);
    const selectAllMatching = React.useCallback(async () => {
        const r = await fetchMatchingIds(allFilters, serverSort);
        const out: Record<string, string> = {};
        for (const d of r.items) out[d.id] = aliases[d.id] || d.hostname;
        setPicked(out);
        setSelectNote(r.total > r.items.length ? `Selected the first ${r.items.length} of ${r.total}. Bulk actions take ${MAX_BULK} devices at a time: narrow the filters to reach the rest.` : null);
    }, [allFilters, serverSort, aliases]);
    const pickedList = React.useMemo(() => Object.entries(picked).map(([id, name]) => ({ id, name })), [picked]);
    const tooMany = pickedList.length > MAX_BULK;

    const clearNote = (id: string) => setColumnFilters((prev) => prev.filter((f) => f.id !== id));
    const notes = fromColumns.notes;

    return (
        <>
            {error ? <p className="mb-3 text-sm text-destructive">{String(error)}</p> : null}
            <DeviceBulkBar selected={pickedList} total={total} onSelectAllMatching={selectAllMatching} onClear={() => { setPicked({}); setSelectNote(null); }} note={tooMany ? `Bulk actions take ${MAX_BULK} devices at a time: untick some, or use Clear and select again.` : selectNote} />
            {notes.length > 0 ? (
                <div role="status" className="mb-3 rounded-md border bg-muted/40 px-3 py-2 text-sm" data-testid="column-filter-notes">
                    <p className="font-medium">Filters from this view</p>
                    <ul className="mt-1 grid gap-1">
                        {notes.map((n) => (
                            <li key={n.id} className="flex flex-wrap items-center gap-2">
                                <span className={n.applied ? "" : "text-amber-700 dark:text-amber-400"}>
                                    {n.label}: {n.text} {n.applied ? "(applied by the server)" : `(not applied: ${n.why})`}
                                </span>
                                <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => clearNote(n.id)}>
                                    Clear
                                </Button>
                            </li>
                        ))}
                    </ul>
                </div>
            ) : null}
            <DataTable<Device, unknown>
                columns={columns as ColumnDef<Device, unknown>[]}
                data={rows}
                server={server}
                filterColumn={toolbarElsewhere ? undefined : filterColumnId}
                columnsInHeader={toolbarElsewhere}
                filterInputPlaceholder={filterPlaceholder}
                sorting={sorting as SortingState}
                setSorting={setSorting as React.Dispatch<React.SetStateAction<SortingState>>}
                columnVisibility={columnVisibility as VisibilityState}
                setColumnVisibility={setColumnVisibility as React.Dispatch<React.SetStateAction<VisibilityState>>}
                columnFilters={columnFilters as ColumnFiltersState}
                setColumnFilters={setColumnFilters as React.Dispatch<React.SetStateAction<ColumnFiltersState>>}
                rowSelection={rowSelection}
                setRowSelection={setRowSelection}
                compact={compact}
                orderStorageKey="devices"
                defaultPageSize={25}
                registerSnapshotGetter={registerSnapshot ? registerSnapshotGetter : undefined}
            />
        </>
    );
}
