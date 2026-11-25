// components/reports/report-toolbar.tsx
"use client";

import * as React from "react";
import { ArrowDown, ArrowUp, Bookmark, Columns3, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { toast } from "@/components/ui/use-toast";
import { jfetch } from "@/lib/api";
import type { ReportColumn, ReportKey, SavedView, ViewConfig } from "./report-types";

const errorText = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong.");

/** Which columns to show, and in what order. */
export function ColumnPicker({ columns, selected, onChange, onReset }: { columns: ReportColumn[]; selected: string[]; onChange: (next: string[]) => void; onReset: () => void }) {
    const usable = columns.filter((c) => !c.internal);
    const byKey = new Map(usable.map((c) => [c.key, c]));
    const chosen = selected.map((k) => byKey.get(k)).filter((c): c is ReportColumn => !!c);
    const rest = usable.filter((c) => !selected.includes(c.key));
    const move = (i: number, by: -1 | 1) => {
        const next = [...selected];
        const j = i + by;
        if (j < 0 || j >= next.length) return;
        [next[i], next[j]] = [next[j], next[i]];
        onChange(next);
    };
    return (
        <Popover>
            <PopoverTrigger asChild>
                <Button type="button" variant="outline"><Columns3 className="mr-1 h-4 w-4" /> Columns ({chosen.length})</Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-80 max-h-96 overflow-y-auto">
                <div className="grid gap-1">
                    <div className="mb-1 flex items-center justify-between">
                        <span className="text-sm font-medium">Columns to show and export</span>
                        <Button type="button" variant="ghost" size="sm" onClick={onReset}>Reset</Button>
                    </div>
                    {chosen.map((c, i) => (
                        <div key={c.key} className="flex items-center gap-2 text-sm">
                            <Checkbox id={`col-${c.key}`} checked onCheckedChange={() => selected.length > 1 && onChange(selected.filter((k) => k !== c.key))} aria-label={`Show ${c.label}`} />
                            <label htmlFor={`col-${c.key}`} className="flex-1 truncate">{c.label}</label>
                            <Button type="button" variant="ghost" size="icon" className="h-7 w-7" aria-label={`Move ${c.label} up`} disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp className="h-3.5 w-3.5" /></Button>
                            <Button type="button" variant="ghost" size="icon" className="h-7 w-7" aria-label={`Move ${c.label} down`} disabled={i === chosen.length - 1} onClick={() => move(i, 1)}><ArrowDown className="h-3.5 w-3.5" /></Button>
                        </div>
                    ))}
                    {rest.length > 0 && <div className="mt-2 border-t border-border pt-2 text-xs text-muted-foreground">More columns</div>}
                    {rest.map((c) => (
                        <div key={c.key} className="flex items-center gap-2 text-sm">
                            <Checkbox id={`col-${c.key}`} checked={false} onCheckedChange={() => onChange([...selected, c.key])} aria-label={`Show ${c.label}`} />
                            <label htmlFor={`col-${c.key}`} className="flex-1 truncate">{c.label}</label>
                        </div>
                    ))}
                </div>
            </PopoverContent>
        </Popover>
    );
}

/** Saved views: open one, save the current settings under a name, update or remove your own. */
export function ViewsMenu({ reportKey, current, onApply }: { reportKey: ReportKey; current: () => ViewConfig; onApply: (view: SavedView) => void }) {
    const [open, setOpen] = React.useState(false);
    const [items, setItems] = React.useState<SavedView[] | null>(null);
    const [name, setName] = React.useState("");
    const [busy, setBusy] = React.useState(false);

    const load = React.useCallback(() => {
        jfetch<{ items: SavedView[] }>(`/api/reports/views?report=${reportKey}`)
            .then((r) => setItems(r.items))
            .catch((e) => {
                setItems([]);
                toast({ title: "Could not load saved views", description: errorText(e), variant: "destructive" });
            });
    }, [reportKey]);
    React.useEffect(() => {
        if (open) load();
    }, [open, load]);

    const run = async (action: () => Promise<unknown>, done?: string) => {
        setBusy(true);
        try {
            await action();
            if (done) toast({ title: done });
            load();
        } catch (e) {
            toast({ title: "That did not work", description: errorText(e), variant: "destructive" });
        } finally {
            setBusy(false);
        }
    };

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <Button type="button" variant="outline"><Bookmark className="mr-1 h-4 w-4" /> Views</Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-96">
                <div className="grid gap-2">
                    <span className="text-sm font-medium">Saved views</span>
                    {items === null && <p className="text-sm text-muted-foreground">Loading…</p>}
                    {items?.length === 0 && <p className="text-sm text-muted-foreground">Nothing saved for this report yet. Set up the filters, then save them here.</p>}
                    <ul className="grid max-h-60 gap-1 overflow-y-auto">
                        {items?.map((v) => (
                            <li key={v.id} className="flex items-center gap-1">
                                <Button type="button" variant="ghost" className="h-8 flex-1 justify-start truncate px-2" onClick={() => { onApply(v); setOpen(false); }}>
                                    {v.name}
                                </Button>
                                {v.mine && (
                                    <>
                                        <Button type="button" variant="ghost" size="sm" disabled={busy} title="Replace this view's settings with what is on screen now" onClick={() => run(() => jfetch(`/api/reports/views/${v.id}`, { method: "PUT", body: { config: current() } }), `Updated ${v.name}`)}>
                                            Update
                                        </Button>
                                        <Button type="button" variant="ghost" size="icon" className="h-8 w-8" aria-label={`Remove ${v.name}`} disabled={busy} onClick={() => run(() => jfetch(`/api/reports/views/${v.id}`, { method: "DELETE" }), `Removed ${v.name}`)}>
                                            <Trash2 className="h-4 w-4" />
                                        </Button>
                                    </>
                                )}
                            </li>
                        ))}
                    </ul>
                    <form
                        className="flex gap-2 border-t border-border pt-2"
                        onSubmit={(e) => {
                            e.preventDefault();
                            if (!name.trim()) return;
                            void run(() => jfetch("/api/reports/views", { method: "POST", body: { reportKey, name: name.trim(), config: current() } }).then(() => setName("")), "View saved");
                        }}
                    >
                        <Input aria-label="Name for this view" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="Name this view" />
                        <Button type="submit" disabled={busy || !name.trim()}>Save</Button>
                    </form>
                    <p className="text-xs text-muted-foreground">A view remembers the customer, limits, period, filters, sort, grouping and columns. Everyone can open it; only you can change it.</p>
                </div>
            </PopoverContent>
        </Popover>
    );
}
