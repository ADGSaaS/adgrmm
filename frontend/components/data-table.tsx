//adgrmm-frontend\components\data-table.tsx

"use client";

import * as React from "react";
import {
    ColumnDef,
    flexRender,
    getCoreRowModel,
    getFilteredRowModel,
    getSortedRowModel,
    getPaginationRowModel,
    SortingState,
    VisibilityState,
    ColumnFiltersState,
    ColumnOrderState,
    RowSelectionState,
    useReactTable,
} from "@tanstack/react-table";

import { cn } from "@/lib/utils";

import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuTrigger,
    DropdownMenuContent,
    DropdownMenuCheckboxItem,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
    Table,
    TableHeader,
    TableHead,
    TableRow,
    TableBody,
    TableCell,
} from "@/components/ui/table";
import { ArrowLeft, ArrowRight, GripVertical, RotateCcw, SlidersHorizontal } from "lucide-react";
import { Pager, type Paged } from "@/components/pager";

const COLUMN_NAMES: Record<string, string> = { number: "Ticket number", updated: "Last updated", os: "Operating system", lastResponse: "Last response", user: "User", client: "Client" };
/** A readable name for a column id such as lastResponse. */
const columnName = (id: string) => COLUMN_NAMES[id] ?? id.replace(/[_-]/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());

// Every cell, pinned or not, has the same solid background and the same hover colour, drawn on the cell itself and
// triggered by the row, so all the columns change together and the pinned one never differs from the rest.
const HEAD_CELL = "bg-card transition-colors group-hover:bg-muted";
const BODY_CELL = "bg-card transition-colors group-hover:bg-accent";
const PINNED = "sticky left-0 z-[1] w-48";
/** The tick column, when a table has one: narrow, first, and the first real column sticks beside it. */
const SELECT_PINNED = "sticky left-0 z-[1] w-10 min-w-10 px-2";
const AFTER_SELECT_PINNED = "sticky left-10 z-[1] w-48";
const SELECT_WIDTH = 40;

const PAGE_SIZES = [10, 25, 50, 100, 200];
/** The narrowest a column can be dragged to. */
const MIN_COL = 60;

type ColumnMeta = { headerClassName?: string; cellClassName?: string };

export type TableSnapshot = {
    sorting: SortingState;
    columnVisibility: VisibilityState;
    columnFilters: ColumnFiltersState;
    pagination: { pageIndex: number; pageSize: number };
};

/** For a list the server sorts, filters and pages: `data` is the current page only, and the parent reads sorting, filters and page from here. */
export type ServerPaging = {
    /** Every row the filters match, not only this page. */
    total: number;
    /** Told whenever the page or the rows per page change. */
    onPaginationChange: (p: { pageIndex: number; pageSize: number }) => void;
    /** A request is running: the old rows stay, dimmed. */
    loading?: boolean;
    /** Changes whenever something outside the table (a filter) changes what the rows are, so the table goes back to page one. */
    resetKey?: string;
};

export type DataTableProps<TData extends { id?: string }, TValue> = {
    columns: ColumnDef<TData, TValue>[];
    data: TData[];
    /** Rows come one page at a time from the server (sorting and filtering happen there too). */
    server?: ServerPaging;

    filterColumn?: string;
    filterInputPlaceholder?: string;
    /** Show the Columns menu in the last (actions) heading instead of a bar above the table. With no filter box either, there is no bar at all. */
    columnsInHeader?: boolean;

    sorting: SortingState;
    setSorting: React.Dispatch<React.SetStateAction<SortingState>>;
    columnVisibility: VisibilityState;
    setColumnVisibility: React.Dispatch<React.SetStateAction<VisibilityState>>;
    columnFilters: ColumnFiltersState;
    setColumnFilters: React.Dispatch<React.SetStateAction<ColumnFiltersState>>;

    rowSelection?: RowSelectionState;
    setRowSelection?: React.Dispatch<React.SetStateAction<RowSelectionState>>;

    compact?: boolean;

    /** When set, people can reorder columns (drag a heading or use the arrows under Columns) and the order is remembered under this name. */
    orderStorageKey?: string;

    /** Rows shown per page. People can change it; with a storage key their choice is remembered. */
    defaultPageSize?: number;

    // Saved Views plumbing + styling
    className?: string;
    /** Register a function that returns the current table snapshot (used by Saved Views). */
    registerSnapshotGetter?: (fn: () => TableSnapshot) => void;
    /** Optional: notify parent whenever table state changes. */
    onTableStateChange?: (snap: TableSnapshot) => void;
};

export function DataTable<TData extends { id?: string }, TValue>({
    columns,
    data,
    server,
    filterColumn,
    filterInputPlaceholder = "Filter…",
    columnsInHeader = false,
    sorting,
    setSorting,
    columnVisibility,
    setColumnVisibility,
    columnFilters,
    setColumnFilters,
    rowSelection,
    setRowSelection,
    compact = false,
    orderStorageKey,
    defaultPageSize = 10,
    className,
    registerSnapshotGetter,
    onTableStateChange,
}: DataTableProps<TData, TValue>) {
    // Columns that stay where they are: row pickers and the actions menu at the end.
    const pinned = React.useCallback((id: string) => id === "select" || id === "actions", []);
    const defaultOrder = React.useMemo(() => columns.map((c, i) => String((c as any).id ?? (c as any).accessorKey ?? i)), [columns]);
    const [columnOrder, setColumnOrder] = React.useState<ColumnOrderState>(defaultOrder);
    // Read the saved order after the first render so server and browser agree on what to draw first.
    React.useEffect(() => {
        if (!orderStorageKey) return;
        try {
            const saved = JSON.parse(window.localStorage.getItem(`adg.table.${orderStorageKey}.order`) ?? "null");
            if (Array.isArray(saved)) {
                // Keep what is saved, drop columns that no longer exist, and put new ones at the end of the movable part.
                const known = saved.filter((id: string) => defaultOrder.includes(id));
                const added = defaultOrder.filter((id) => !known.includes(id));
                // The tick column stays first and the actions column last, wherever an older saved order had them.
                const lead = defaultOrder.filter((id) => id === "select");
                const tail = defaultOrder.filter((id) => id === "actions");
                setColumnOrder([...lead, ...[...known, ...added].filter((id) => !pinned(id)), ...tail]);
            }
        } catch { /* a bad saved value just means the default order */ }
    }, [orderStorageKey, defaultOrder, pinned]);
    const applyOrder = React.useCallback((next: string[]) => {
        // Pinned columns that were last stay last.
        const movable = next.filter((id) => !pinned(id));
        const lead = defaultOrder.filter((id) => id === "select");
        const tail = defaultOrder.filter((id) => id === "actions");
        const order = [...lead, ...movable, ...tail];
        setColumnOrder(order);
        if (orderStorageKey) {
            try { window.localStorage.setItem(`adg.table.${orderStorageKey}.order`, JSON.stringify(order)); } catch { /* ignore */ }
        }
    }, [defaultOrder, orderStorageKey, pinned]);
    const move = (id: string, delta: -1 | 1) => {
        const movable = columnOrder.filter((c) => !pinned(c));
        const from = movable.indexOf(id);
        const to = from + delta;
        if (from < 0 || to < 0 || to >= movable.length) return;
        [movable[from], movable[to]] = [movable[to], movable[from]];
        applyOrder(movable);
    };
    const [pagination, setPagination] = React.useState({ pageIndex: 0, pageSize: defaultPageSize });
    React.useEffect(() => {
        if (!orderStorageKey) return;
        try {
            const saved = Number(window.localStorage.getItem(`adg.table.${orderStorageKey}.pageSize`));
            if (PAGE_SIZES.includes(saved)) setPagination((p) => ({ ...p, pageSize: saved }));
        } catch { /* ignore */ }
    }, [orderStorageKey]);
    // Tell the parent which page is wanted, and go back to the first page when sorting or filtering changes.
    const onServerPage = server?.onPaginationChange;
    React.useEffect(() => {
        onServerPage?.({ pageIndex: pagination.pageIndex, pageSize: pagination.pageSize });
    }, [onServerPage, pagination.pageIndex, pagination.pageSize]);
    const serverResetKey = server ? JSON.stringify([sorting, columnFilters, server.resetKey ?? ""]) : "";
    const firstReset = React.useRef(true);
    React.useEffect(() => {
        if (!server) return;
        if (firstReset.current) {
            firstReset.current = false;
            return;
        }
        setPagination((p) => (p.pageIndex === 0 ? p : { ...p, pageIndex: 0 }));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [serverResetKey]);
    // The rows ran out under the current page (a filter or deletion elsewhere): land on the last page that has any.
    React.useEffect(() => {
        if (!server || server.loading || server.total === 0) return;
        const last = Math.max(0, Math.ceil(server.total / pagination.pageSize) - 1);
        if (pagination.pageIndex > last) setPagination((p) => ({ ...p, pageIndex: last }));
    }, [server, pagination.pageIndex, pagination.pageSize]);
    const changePageSize = (n: number) => {
        setPagination({ pageIndex: 0, pageSize: n });
        if (orderStorageKey) {
            try { window.localStorage.setItem(`adg.table.${orderStorageKey}.pageSize`, String(n)); } catch { /* ignore */ }
        }
    };
    // Widths people have dragged, by column id (pixels). Columns without one share what is left.
    const [widths, setWidths] = React.useState<Record<string, number>>({});
    React.useEffect(() => {
        if (!orderStorageKey) return;
        try {
            const saved = JSON.parse(window.localStorage.getItem(`adg.table.${orderStorageKey}.widths`) ?? "null");
            if (saved && typeof saved === "object") {
                const clean: Record<string, number> = {};
                for (const [k, v] of Object.entries(saved)) if (typeof v === "number" && v >= MIN_COL && v <= 1200) clean[k] = v;
                setWidths(clean);
            }
        } catch { /* ignore */ }
    }, [orderStorageKey]);
    const saveWidths = React.useCallback((next: Record<string, number>) => {
        setWidths(next);
        if (orderStorageKey) {
            try { window.localStorage.setItem(`adg.table.${orderStorageKey}.widths`, JSON.stringify(next)); } catch { /* ignore */ }
        }
    }, [orderStorageKey]);
    const startResize = (id: string, e: React.MouseEvent<HTMLElement>) => {
        e.preventDefault();
        e.stopPropagation();
        const th = (e.currentTarget as HTMLElement).parentElement as HTMLElement;
        const startX = e.clientX;
        const startW = th.getBoundingClientRect().width;
        let latest = startW;
        const move = (ev: MouseEvent) => {
            latest = Math.min(1200, Math.max(MIN_COL, Math.round(startW + ev.clientX - startX)));
            setWidths((w) => ({ ...w, [id]: latest }));
        };
        const up = () => {
            window.removeEventListener("mousemove", move);
            window.removeEventListener("mouseup", up);
            document.body.style.userSelect = "";
            document.body.style.cursor = "";
            setWidths((w) => { saveWidths(w); return w; });
        };
        document.body.style.userSelect = "none";
        document.body.style.cursor = "col-resize";
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
    };
    const [dragId, setDragId] = React.useState<string | null>(null);
    const [overId, setOverId] = React.useState<string | null>(null);
    const dropOn = (targetId: string) => {
        if (!dragId || dragId === targetId || pinned(targetId)) return;
        const movable = columnOrder.filter((c) => !pinned(c) && c !== dragId);
        movable.splice(movable.indexOf(targetId), 0, dragId);
        applyOrder(movable);
    };

    const table = useReactTable({
        data,
        columns,
        state: {
            sorting,
            columnVisibility,
            columnFilters,
            columnOrder,
            pagination,
            rowSelection: rowSelection ?? {},
        },
        onColumnOrderChange: setColumnOrder,
        onPaginationChange: setPagination,
        onSortingChange: setSorting,
        onColumnVisibilityChange: setColumnVisibility,
        onColumnFiltersChange: setColumnFilters,
        enableRowSelection: !!setRowSelection,
        onRowSelectionChange: setRowSelection,
        getRowId: (row: any, index) => (row?.id ? String(row.id) : String(index)),
        getCoreRowModel: getCoreRowModel(),
        getFilteredRowModel: getFilteredRowModel(),
        getSortedRowModel: getSortedRowModel(),
        getPaginationRowModel: getPaginationRowModel(),
        ...(server ? { manualPagination: true, manualSorting: true, manualFiltering: true, autoResetPageIndex: false, rowCount: server.total } : {}),
    });

    // Which cells stick to the left: the tick column, and the first real column (beside it when there is one).
    const hasSelectColumn = table.getVisibleLeafColumns()[0]?.id === "select";
    const pinClass = (columnIndex: number, id: string) => (id === "select" ? SELECT_PINNED : columnIndex === (hasSelectColumn ? 1 : 0) ? (hasSelectColumn ? AFTER_SELECT_PINNED : PINNED) : undefined);

    const pageSizeNow = table.getState().pagination.pageSize;
    const totalRows = server ? server.total : table.getFilteredRowModel().rows.length;
    const pageIndexNow = table.getState().pagination.pageIndex;
    const pagedView: Paged<unknown> = {
        rows: [],
        total: totalRows,
        page: pageIndexNow,
        pageCount: Math.max(1, table.getPageCount()),
        size: pageSizeNow,
        from: totalRows === 0 ? 0 : pageIndexNow * pageSizeNow + 1,
        to: Math.min(totalRows, (pageIndexNow + 1) * pageSizeNow),
        setPage: (p: number) => table.setPageIndex(p),
        setSize: changePageSize,
    };

    // ---- Saved Views snapshot getter (FUNCTION, not value) ----
    const getSnapshot = React.useCallback<() => TableSnapshot>(() => {
        const s = table.getState();
        return {
            sorting: s.sorting,
            columnVisibility: s.columnVisibility,
            columnFilters: s.columnFilters,
            pagination: {
                pageIndex: s.pagination.pageIndex,
                pageSize: s.pagination.pageSize,
            },
        };
    }, [table]);

    // Register getter with consumer (e.g., DashboardContext)
    React.useEffect(() => {
        if (registerSnapshotGetter) registerSnapshotGetter(getSnapshot);
    }, [registerSnapshotGetter, getSnapshot]);

    // Notify consumer when state changes (for autosave/dirty indicators)
    const pageIndex = table.getState().pagination.pageIndex;
    const pageSize = table.getState().pagination.pageSize;
    React.useEffect(() => {
        if (onTableStateChange) onTableStateChange(getSnapshot());
    }, [sorting, columnVisibility, columnFilters, pageIndex, pageSize, onTableStateChange, getSnapshot]);

    const globalFilterValue =
        filterColumn ? ((table.getColumn(filterColumn)?.getFilterValue() as string) ?? "") : "";

    const columnsMenu = (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="gap-2" title="Show/hide columns">
                    <SlidersHorizontal className="h-4 w-4" />
                    Columns
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
                {table
                    .getAllLeafColumns()
                    .filter((col) => col.getCanHide?.() ?? true)
                    .map((col) => (
                        <DropdownMenuCheckboxItem
                            key={col.id}
                            checked={col.getIsVisible()}
                            onCheckedChange={(checked) => col.toggleVisibility(!!checked)}
                            onSelect={(e) => e.preventDefault()} // keep open for multi-toggle
                        >
                            {typeof col.columnDef.header === "string" ? col.columnDef.header : columnName(col.id)}
                        </DropdownMenuCheckboxItem>
                    ))}
                {Object.keys(widths).length > 0 && (
                    <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onSelect={(e) => { e.preventDefault(); saveWidths({}); }} className="gap-2">
                            <RotateCcw className="h-3.5 w-3.5" aria-hidden />
                            Reset column widths
                        </DropdownMenuItem>
                    </>
                )}
                {orderStorageKey && (
                    <>
                        <DropdownMenuSeparator />
                        <DropdownMenuLabel className="flex items-center justify-between text-xs font-normal text-muted-foreground">
                            Order (or drag a heading)
                        </DropdownMenuLabel>
                        {columnOrder
                            .filter((id) => !pinned(id) && table.getColumn(id)?.getIsVisible())
                            .map((id, i, all) => (
                                <DropdownMenuItem key={id} onSelect={(e) => e.preventDefault()} className="flex items-center gap-2">
                                    <GripVertical className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                                    <span className="flex-1">{columnName(id)}</span>
                                    <button type="button" aria-label={`Move ${columnName(id)} left`} disabled={i === 0} onClick={() => move(id, -1)} className="rounded p-1 hover:bg-accent disabled:opacity-30">
                                        <ArrowLeft className="h-3.5 w-3.5" />
                                    </button>
                                    <button type="button" aria-label={`Move ${columnName(id)} right`} disabled={i === all.length - 1} onClick={() => move(id, 1)} className="rounded p-1 hover:bg-accent disabled:opacity-30">
                                        <ArrowRight className="h-3.5 w-3.5" />
                                    </button>
                                </DropdownMenuItem>
                            ))}
                        <DropdownMenuItem onSelect={(e) => { e.preventDefault(); applyOrder(defaultOrder); }} className="gap-2">
                            <RotateCcw className="h-3.5 w-3.5" aria-hidden />
                            Reset order
                        </DropdownMenuItem>
                    </>
                )}
            </DropdownMenuContent>
        </DropdownMenu>
    );

    return (
        <div className={cn("space-y-3 min-w-0", className)}>
            {/* Toolbar */}
            {(filterColumn || !columnsInHeader) && <div className="flex flex-wrap items-center gap-2 min-w-0">
                {filterColumn ? (
                    <div className="relative w-full sm:w-auto">
                        <Input
                            value={globalFilterValue}
                            onChange={(e) => table.getColumn(filterColumn)?.setFilterValue(e.target.value)}
                            placeholder={filterInputPlaceholder}
                            className="w-full sm:w-[240px] md:w-[320px]"
                            aria-label="Filter rows"
                        />
                    </div>
                ) : null}

                <div className="ml-auto" />

                {!columnsInHeader && columnsMenu}
            </div>}

            {/* Table */}
            <div
                aria-busy={server?.loading || undefined}
                className={cn("overflow-hidden rounded-xl border border-border/70 bg-card shadow-[0_1px_2px_rgba(0,0,0,0.06),0_8px_24px_-12px_rgba(0,0,0,0.25)] backdrop-blur-sm transition-opacity", server?.loading && "opacity-60")}
            >
                {/* Fixed-layout columns share the width, so give each enough room and scroll when it does not fit. */}
                <Table className="table-fixed" style={{ minWidth: table.getVisibleLeafColumns().reduce((sum, c, i, all) => sum + (c.id === "select" ? SELECT_WIDTH : widths[c.id] ?? (i === (all[0]?.id === "select" ? 1 : 0) ? 192 : 132)), 0) }}>
                    <colgroup>
                        {table.getVisibleLeafColumns().map((c) => (
                            <col key={c.id} style={c.id === "select" ? { width: SELECT_WIDTH } : widths[c.id] ? { width: widths[c.id] } : undefined} />
                        ))}
                    </colgroup>
                    <TableHeader>
                        {table.getHeaderGroups().map((hg) => (
                            <TableRow key={hg.id} className="group hover:bg-transparent">
                                {hg.headers.map((header, columnIndex) => {
                                    const meta = header.column.columnDef.meta as ColumnMeta | undefined;
                                    const canDrag = !!orderStorageKey && !pinned(header.column.id);
                                    return (
                                        <TableHead
                                            key={header.id}
                                            draggable={canDrag}
                                            onDragStart={canDrag ? (e) => { setDragId(header.column.id); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", header.column.id); } : undefined}
                                            onDragOver={canDrag ? (e) => { if (dragId) { e.preventDefault(); setOverId(header.column.id); } } : undefined}
                                            onDrop={canDrag ? (e) => { e.preventDefault(); dropOn(header.column.id); setDragId(null); setOverId(null); } : undefined}
                                            onDragEnd={() => { setDragId(null); setOverId(null); }}
                                            title={canDrag ? "Drag to move this column" : undefined}
                                            className={cn("relative truncate", HEAD_CELL, canDrag && "cursor-grab", dragId === header.column.id && "opacity-50", overId === header.column.id && dragId && dragId !== header.column.id && "!bg-accent", pinClass(columnIndex, header.column.id), meta?.headerClassName)}
                                        >
                                            {columnsInHeader && header.column.id === "actions" ? (
                                                <div className="flex justify-end">{columnsMenu}</div>
                                            ) : header.isPlaceholder
                                                ? null
                                                : flexRender(header.column.columnDef.header, header.getContext())}
                                            {!header.isPlaceholder && header.column.id !== "select" && header.column.id !== "actions" ? (
                                                <div
                                                    role="separator"
                                                    aria-orientation="vertical"
                                                    aria-label={`Resize ${columnName(header.column.id)} column (double-click to reset)`}
                                                    title="Drag to resize, double-click to reset"
                                                    draggable={false}
                                                    onMouseDown={(e) => startResize(header.column.id, e)}
                                                    onClick={(e) => e.stopPropagation()}
                                                    onDoubleClick={(e) => { e.stopPropagation(); const { [header.column.id]: _gone, ...rest } = widths; saveWidths(rest); }}
                                                    className="absolute right-0 top-0 z-10 h-full w-2 cursor-col-resize select-none after:absolute after:right-0 after:top-1/4 after:h-1/2 after:w-px after:bg-border hover:after:w-0.5 hover:after:bg-primary"
                                                />
                                            ) : null}
                                        </TableHead>
                                    );
                                })}
                            </TableRow>
                        ))}
                    </TableHeader>

                    <TableBody>
                        {table.getRowModel().rows.length ? (
                            table.getRowModel().rows.map((row) => (
                                <TableRow
                                    key={row.id}
                                    data-state={row.getIsSelected() ? "selected" : undefined}
                                    className={cn("group hover:bg-transparent", compact ? "[&>td]:py-2" : "[&>td]:py-3")}
                                >
                                    {row.getVisibleCells().map((cell, columnIndex) => {
                                        const meta = cell.column.columnDef.meta as ColumnMeta | undefined;
                                        return (
                                            <TableCell key={cell.id} className={cn("truncate", BODY_CELL, pinClass(columnIndex, cell.column.id), meta?.cellClassName)}>
                                                {flexRender(cell.column.columnDef.cell, cell.getContext())}
                                            </TableCell>
                                        );
                                    })}
                                </TableRow>
                            ))
                        ) : (
                            <TableRow>
                                <TableCell colSpan={columns.length} className="h-24 text-center">
                                    No results.
                                </TableCell>
                            </TableRow>
                        )}
                    </TableBody>
                </Table>
                {/* The same pager every list uses */}
                <div className="border-t border-border/60 px-5 py-3">
                    <Pager paged={pagedView} noun="results" />
                </div>
            </div>
        </div>
    );
}
