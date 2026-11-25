"use client";

// Automation > Bulk actions: what people did to many devices at once from the device list, newest first, with how each
// device in the chosen batch went (the same view the action dialog shows right after it).
import * as React from "react";
import { fetchBatches, BULK_LABEL, type BatchSummary } from "@/lib/bulk-api";
import { EmptyState } from "@/components/list-controls";
import { errorText, Pill } from "@/components/policies/shared";
import { Pager, usePaged } from "@/components/pager";
import BatchDetail from "@/components/bulk/batch-detail";

export default function BulkBatchesPanel({ initialBatchId }: { initialBatchId?: string | null }) {
    const [items, setItems] = React.useState<BatchSummary[] | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [open, setOpen] = React.useState<string | null>(initialBatchId ?? null);
    const paged = usePaged(items ?? [], "automation-bulk-batches", 15);

    React.useEffect(() => {
        let alive = true;
        fetchBatches().then((r) => alive && setItems(r.items)).catch((e) => alive && setError(errorText(e)));
        return () => { alive = false; };
    }, []);

    return (
        <div className="space-y-4">
            <p className="text-sm text-muted-foreground">Actions started on several devices at once from the device list. Open one to see how each device went; the last 90 days are kept.</p>
            {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
            {!items && !error ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
            {items && items.length === 0 ? <EmptyState>Nothing has been done to several devices at once yet. Tick devices in the device list to start.</EmptyState> : null}
            {items && items.length > 0 ? (
                <div className="overflow-hidden rounded-xl border border-border/70 bg-card">
                    <ul className="divide-y divide-border/60">
                        {paged.rows.map((b) => (
                            <li key={b.id} className="px-5 py-4 text-sm">
                                <button type="button" className="flex w-full flex-wrap items-center gap-2 text-left" onClick={() => setOpen(open === b.id ? null : b.id)} aria-expanded={open === b.id}>
                                    <span className="font-medium">{b.summary}</span>
                                    <span className="text-xs text-muted-foreground">{BULK_LABEL[b.action] ?? b.action}</span>
                                    <Pill tone="good">{b.succeeded} accepted</Pill>
                                    {b.skipped ? <Pill tone="warn">{b.skipped} skipped</Pill> : null}
                                    {b.failed ? <Pill tone="bad">{b.failed} failed</Pill> : null}
                                    <span className="ml-auto text-xs text-muted-foreground">{new Date(b.createdAt).toLocaleString()}{b.by ? ` by ${b.by}` : ""}</span>
                                </button>
                                {open === b.id ? <div className="mt-3"><BatchDetail batchId={b.id} /></div> : null}
                            </li>
                        ))}
                    </ul>
                    <div className="border-t border-border/60 px-5 py-3"><Pager paged={paged} noun="batches" /></div>
                </div>
            ) : null}
            {open && items && !items.some((b) => b.id === open) ? <div className="rounded-xl border border-border/70 bg-card p-4"><BatchDetail batchId={open} /></div> : null}
        </div>
    );
}
