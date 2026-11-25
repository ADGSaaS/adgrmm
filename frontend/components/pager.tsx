"use client";

// One way to page a list of rows, used by every list in the app.
//
//  - usePaged(items, "tickets")  pages a list that is already in the browser and gives you the rows to draw.
//  - <Pager {...paged} />        draws "Rows per page", the range, and Previous / Next.
//  - usePageSize + <PageSizeSelect>  for lists the server pages (the limit goes in the request).
//
// The choice is remembered per list under `riq.rows.<key>`, in this browser only.
import * as React from "react";
import { cn } from "@/lib/utils";

export const PAGE_SIZE_OPTIONS = [10, 25, 50, 100, 200] as const;

/** Lists the server hands out in pieces are loaded up to this many rows and then paged here like every other list. */
export const LOAD_CAP = 1000;

/**
 * For a list the server pages with a cursor: keeps asking for the next piece until everything (up to LOAD_CAP rows) is
 * here, so the list can use usePaged and the same <Pager> as every other list instead of its own "Show more" button.
 * Call it with the list's cursor, whether a request is running, how many rows are loaded, and the function that loads the next piece.
 */
export function useAutoLoadMore(nextCursor: string | null | undefined, loading: boolean, loaded: number, loadMore: () => void, cap: number = LOAD_CAP) {
    React.useEffect(() => {
        if (nextCursor && !loading && loaded < cap) loadMore();
        // loadMore is intentionally not a dependency: it changes with the cursor, which is what drives this.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [nextCursor, loading, loaded, cap]);
}

function readSize(key: string, fallback: number): number {
    try {
        const saved = Number(window.localStorage.getItem(`riq.rows.${key}`));
        return (PAGE_SIZE_OPTIONS as readonly number[]).includes(saved) ? saved : fallback;
    } catch {
        return fallback;
    }
}

/** The rows-per-page choice for one list. Starts at the default so the server and browser agree, then picks up the saved value. */
export function usePageSize(key: string, fallback = 25): [number, (n: number) => void] {
    const [size, setSizeState] = React.useState(fallback);
    React.useEffect(() => setSizeState(readSize(key, fallback)), [key, fallback]);
    const setSize = React.useCallback(
        (n: number) => {
            setSizeState(n);
            try { window.localStorage.setItem(`riq.rows.${key}`, String(n)); } catch { /* ignore */ }
        },
        [key],
    );
    return [size, setSize];
}

export function PageSizeSelect({ value, onChange, label = "Rows per page", className }: { value: number; onChange: (n: number) => void; label?: string; className?: string }) {
    const options = (PAGE_SIZE_OPTIONS as readonly number[]).includes(value) ? [...PAGE_SIZE_OPTIONS] : [...PAGE_SIZE_OPTIONS, value].sort((a, b) => a - b);
    return (
        <label className={cn("flex items-center gap-2 text-xs text-muted-foreground", className)}>
            {label}
            <select
                aria-label={label}
                value={value}
                onChange={(e) => onChange(Number(e.target.value))}
                className="h-8 rounded-md border border-input bg-card/40 px-2 text-sm text-foreground"
            >
                {options.map((n) => (
                    <option key={n} value={n}>{n}</option>
                ))}
            </select>
        </label>
    );
}

export type Paged<T> = {
    rows: T[];
    total: number;
    page: number; // 0-based
    pageCount: number;
    size: number;
    from: number; // 1-based, 0 when empty
    to: number;
    setPage: (p: number) => void;
    setSize: (n: number) => void;
};

/** Pages a list that is already loaded. Going past the end after a filter or deletion lands on the last page. */
export function usePaged<T>(items: T[], key: string, fallbackSize = 25): Paged<T> {
    const [size, setSizeRaw] = usePageSize(key, fallbackSize);
    const [page, setPage] = React.useState(0);
    const total = items.length;
    const pageCount = Math.max(1, Math.ceil(total / size));
    React.useEffect(() => {
        if (page > pageCount - 1) setPage(pageCount - 1);
    }, [page, pageCount]);
    const safePage = Math.min(page, pageCount - 1);
    const start = safePage * size;
    const rows = React.useMemo(() => items.slice(start, start + size), [items, start, size]);
    return {
        rows,
        total,
        page: safePage,
        pageCount,
        size,
        from: total === 0 ? 0 : start + 1,
        to: Math.min(total, start + size),
        setPage,
        setSize: (n: number) => {
            setSizeRaw(n);
            setPage(0);
        },
    };
}

/** Rows per page, "1 to 25 of 140", and Previous / Next. */
export function Pager<T>({ paged, className, noun = "results" }: { paged: Paged<T>; className?: string; noun?: string }) {
    return (
        <div className={cn("flex flex-wrap items-center justify-between gap-3", className)}>
            <span className="text-xs text-muted-foreground">
                {paged.total === 0 ? `No ${noun}` : `${paged.from} to ${paged.to} of ${paged.total} ${noun}`}
            </span>
            <div className="flex flex-wrap items-center gap-3">
                <PageSizeSelect value={paged.size} onChange={paged.setSize} />
                <span className="text-xs text-muted-foreground">Page {paged.page + 1} of {paged.pageCount}</span>
                <div className="flex gap-1.5">
                    <button
                        type="button"
                        onClick={() => paged.setPage(Math.max(0, paged.page - 1))}
                        disabled={paged.page === 0}
                        className="rounded-lg border border-input px-3 py-1 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-40"
                    >
                        Previous
                    </button>
                    <button
                        type="button"
                        onClick={() => paged.setPage(Math.min(paged.pageCount - 1, paged.page + 1))}
                        disabled={paged.page >= paged.pageCount - 1}
                        className="rounded-lg border border-input px-3 py-1 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-40"
                    >
                        Next
                    </button>
                </div>
            </div>
        </div>
    );
}
