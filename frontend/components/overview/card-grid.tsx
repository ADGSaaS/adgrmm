"use client";

// components/overview/card-grid.tsx
//
// A group of cards (the summary cards, or the charts of the fleet breakdown). On a wide screen (1280 px and up) the cards can be
// dragged into a new order by their handle; the grid packs them into rows by itself, so hiding a card never leaves a hole. On
// smaller screens, and for anyone who cannot drag, it is a plain responsive grid in the same order.
//
// The saved layout of earlier versions (positions of each card) still works: it is read only as an order, sorted by row then
// column, and written back in the same format.
import * as React from "react";
import { Responsive as RGL, type Layout } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import { cn } from "@/lib/utils";

export const COLS = 12;
export const ROW_HEIGHT = 8;
export const MARGIN = 16;
/** The height of a card in grid rows: rows * 8 px + gaps. */
export const SUMMARY_ROWS = 13;
export const CHART_ROWS = 17;

export type GridCard = { key: string; node: React.ReactNode };

/** Cards in order, packed left to right into rows of equal-height cards. */
export function pack(keys: string[], w: number, h: number): Layout[] {
    const per = Math.max(1, Math.floor(COLS / w));
    return keys.map((i, n) => ({ i, x: (n % per) * w, y: Math.floor(n / per) * h, w, h, static: false }));
}

/** The order a saved layout describes: by row, then column. Keys it does not know come last, in their default order. */
export function orderFromLayout(layout: Array<{ i: string; x: number; y: number }> | undefined, defaults: string[]): string[] {
    const known = (layout ?? []).filter((l) => defaults.includes(l.i)).sort((a, b) => a.y - b.y || a.x - b.x).map((l) => l.i);
    return [...known, ...defaults.filter((k) => !known.includes(k))];
}

function useMeasuredWidth() {
    const [width, setWidth] = React.useState(0);
    const observer = React.useRef<ResizeObserver | null>(null);
    const ref = React.useCallback((node: HTMLDivElement | null) => {
        observer.current?.disconnect();
        if (!node) return;
        setWidth(node.getBoundingClientRect().width);
        observer.current = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
        observer.current.observe(node);
    }, []);
    return { ref, width };
}

export function CardGrid({
    cards, order, canArrange, onReorder, cardWidth, rows, plainClass, plainHeight, label,
}: {
    /** The cards to draw, already filtered to the ones that exist and are not hidden. */
    cards: GridCard[];
    /** The whole order of this group (hidden cards included), so their place is kept. */
    order: string[];
    canArrange: boolean;
    onReorder: (order: string[]) => void;
    /** Width of a card in grid columns out of 12. */
    cardWidth: number;
    rows: number;
    /** Column classes of the plain grid. */
    plainClass: string;
    /** Fixed card height of the plain grid in px (charts need one); cards that size themselves leave it out. */
    plainHeight?: number;
    label: string;
}) {
    const { ref, width } = useMeasuredWidth();
    const byKey = new Map(cards.map((c) => [c.key, c]));
    const shown = order.filter((k) => byKey.has(k));

    if (!canArrange) {
        return (
            <ul aria-label={label} className={cn("grid gap-4", plainClass)}>
                {shown.map((k) => <li key={k} className="min-w-0" style={plainHeight ? { height: plainHeight } : undefined}>{byKey.get(k)!.node}</li>)}
            </ul>
        );
    }

    const layout = pack(shown, cardWidth, rows);
    return (
        <div ref={ref} className="w-full min-w-0" role="list" aria-label={label}>
            {width > 0 ? (
                <RGL
                    width={width}
                    className="layout"
                    layouts={{ lg: layout }}
                    breakpoints={{ lg: 0 }}
                    cols={{ lg: COLS }}
                    rowHeight={ROW_HEIGHT}
                    margin={[MARGIN, MARGIN]}
                    containerPadding={[0, 0]}
                    draggableHandle=".move-handle"
                    isResizable={false}
                    compactType="vertical"
                    onLayoutChange={(current: Layout[]) => {
                        const next = [...current].sort((a, b) => a.y - b.y || a.x - b.x).map((l) => l.i);
                        if (next.length === shown.length && next.some((k, i) => k !== shown[i])) {
                            // Put the moved cards back among the hidden ones where they were.
                            const rest = order.filter((k) => !byKey.has(k));
                            onReorder([...next, ...rest]);
                        }
                    }}
                >
                    {shown.map((k) => <div key={k} role="listitem" className="h-full">{byKey.get(k)!.node}</div>)}
                </RGL>
            ) : null}
        </div>
    );
}
