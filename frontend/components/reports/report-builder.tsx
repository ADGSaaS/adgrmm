// components/reports/report-builder.tsx
//
// Design your own report: a title, text for the cover and the foot of the page, and any number of the built-in reports
// as sections, each with its own title, limits, columns, filter, sort, grouping, charts and row limit.
"use client";

import * as React from "react";
import { ArrowDown, ArrowUp, ChevronDown, Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/use-toast";
import { jfetch } from "@/lib/api";
import { FilterBuilder } from "@/components/reports/filter-builder";
import { ColumnPicker } from "@/components/reports/report-toolbar";
import { cleanFilter, countConditions, emptyFilter, type FilterGroup, type ReportColumn, type ReportDef, type ReportKey, type SortKey } from "@/components/reports/report-types";

const selectClass = "h-10 rounded-md border border-input bg-background px-2 text-sm";
const INVALID = "border-destructive ring-1 ring-destructive focus-visible:ring-destructive";

export type CustomConfig = {
    title?: string;
    intro?: string;
    footer?: string;
    cover?: { scorecard?: boolean; recommendations?: boolean };
    days?: number;
    sections: Array<{ key: ReportKey; title?: string; params?: Record<string, string | number>; view?: { filter?: FilterGroup; sort?: SortKey[]; groupBy?: string | null; columns?: string[] }; charts?: boolean; maxRows?: number }>;
};
export type CustomReport = { id: string; name: string; description: string | null; config: CustomConfig; sections?: number };

type Section = {
    uid: string;
    key: ReportKey;
    title: string;
    params: Record<string, string>;
    filter: FilterGroup;
    sort: SortKey[];
    groupBy: string;
    columns: string[] | null;
    charts: boolean;
    maxRows: string;
    open: boolean;
};

let counter = 0;
const uid = () => `s${++counter}`;

const errorText = (e: unknown) => {
    if (!(e instanceof Error)) return "Something went wrong.";
    try {
        const body = JSON.parse(e.message) as { message?: string | string[] };
        const m = Array.isArray(body.message) ? body.message.join(" ") : body.message;
        if (m) return m;
    } catch {
        /* already words */
    }
    return e.message;
};

const blankSection = (key: ReportKey): Section => ({ uid: uid(), key, title: "", params: {}, filter: emptyFilter(), sort: [], groupBy: "", columns: null, charts: true, maxRows: "", open: true });

function fromConfig(config: CustomConfig): Section[] {
    return (config.sections ?? []).map((s) => ({
        uid: uid(),
        key: s.key,
        title: s.title ?? "",
        params: Object.fromEntries(Object.entries(s.params ?? {}).map(([k, v]) => [k, String(v)])),
        filter: s.view?.filter ?? emptyFilter(),
        sort: s.view?.sort ?? [],
        groupBy: s.view?.groupBy ?? "",
        columns: s.view?.columns?.length ? s.view.columns : null,
        charts: s.charts !== false,
        maxRows: s.maxRows ? String(s.maxRows) : "",
        open: false,
    }));
}

export function ReportBuilder({ catalog, initial, onSaved, onCancel }: { catalog: ReportDef[]; initial?: CustomReport | null; onSaved: (id: string) => void; onCancel: () => void }) {
    const [name, setName] = React.useState(initial?.name ?? "");
    const [description, setDescription] = React.useState(initial?.description ?? "");
    const [title, setTitle] = React.useState(initial?.config.title ?? "");
    const [intro, setIntro] = React.useState(initial?.config.intro ?? "");
    const [footer, setFooter] = React.useState(initial?.config.footer ?? "");
    const [days, setDays] = React.useState(initial?.config.days ? String(initial.config.days) : "");
    const [scorecard, setScorecard] = React.useState(initial?.config.cover?.scorecard !== false);
    const [recommendations, setRecommendations] = React.useState(initial?.config.cover?.recommendations !== false);
    const [sections, setSections] = React.useState<Section[]>(initial ? fromConfig(initial.config) : []);
    const [adding, setAdding] = React.useState<ReportKey | "">("");
    const [attempted, setAttempted] = React.useState(false);
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const [columns, setColumns] = React.useState<Record<string, ReportColumn[]>>({});

    const defOf = (key: ReportKey) => catalog.find((d) => d.key === key);

    // Columns are fetched once for each kind of report used, for choosing, filtering and sorting.
    React.useEffect(() => {
        for (const key of new Set(sections.map((s) => s.key))) {
            if (columns[key]) continue;
            jfetch<{ items: ReportColumn[] }>(`/api/reports/custom/columns/${key}`)
                .then((r) => setColumns((prev) => ({ ...prev, [key]: r.items })))
                .catch(() => setColumns((prev) => ({ ...prev, [key]: [] })));
        }
    }, [sections, columns]);

    const update = (id: string, patch: Partial<Section>) => setSections((list) => list.map((s) => (s.uid === id ? { ...s, ...patch } : s)));
    const move = (index: number, by: -1 | 1) =>
        setSections((list) => {
            const next = [...list];
            const j = index + by;
            if (j < 0 || j >= next.length) return list;
            [next[index], next[j]] = [next[j], next[index]];
            return next;
        });

    const missingName = attempted && !name.trim();
    const missingSections = attempted && sections.length === 0;

    const buildConfig = (): CustomConfig => ({
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(intro.trim() ? { intro: intro.trim() } : {}),
        ...(footer.trim() ? { footer: footer.trim() } : {}),
        cover: { scorecard, recommendations },
        ...(days.trim() ? { days: Number(days) } : {}),
        sections: sections.map((s) => {
            const cols = columns[s.key] ?? [];
            const filter = cleanFilter(s.filter, cols);
            const view = { ...(filter ? { filter } : {}), ...(s.sort.length ? { sort: s.sort } : {}), ...(s.groupBy ? { groupBy: s.groupBy } : {}), ...(s.columns ? { columns: s.columns } : {}) };
            const params = Object.fromEntries(Object.entries(s.params).filter(([, v]) => v.trim() !== ""));
            return {
                key: s.key,
                ...(s.title.trim() ? { title: s.title.trim() } : {}),
                ...(Object.keys(params).length ? { params } : {}),
                ...(Object.keys(view).length ? { view } : {}),
                ...(s.charts ? {} : { charts: false }),
                ...(s.maxRows.trim() ? { maxRows: Number(s.maxRows) } : {}),
            };
        }),
    });

    const save = async (event: React.FormEvent) => {
        event.preventDefault();
        setAttempted(true);
        setError(null);
        if (!name.trim() || sections.length === 0) return;
        setBusy(true);
        try {
            const body = { name: name.trim(), description: description.trim() || undefined, config: buildConfig() };
            const saved = initial
                ? await jfetch<{ id: string }>(`/api/reports/custom/${initial.id}`, { method: "PUT", body })
                : await jfetch<{ id: string }>("/api/reports/custom", { method: "POST", body });
            toast({ title: initial ? "Report saved" : "Report created" });
            onSaved(saved.id);
        } catch (e) {
            setError(errorText(e));
        } finally {
            setBusy(false);
        }
    };

    const groups = Array.from(new Set(catalog.map((d) => d.group)));

    return (
        <form onSubmit={save} className="grid gap-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                    <h2 className="text-base font-semibold">{initial ? `Edit ${initial.name}` : "Build a report"}</h2>
                    <p className="max-w-3xl text-sm text-muted-foreground">Choose the reports to include, in the order you want them, and shape each one: its title, columns, filter, sort and grouping. The finished report runs for any customer, site or device, downloads as a PDF or an Excel workbook, and can be scheduled.</p>
                </div>
                <div className="flex gap-2">
                    <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
                    <Button type="submit" disabled={busy}>{busy ? "Saving…" : "Save report"}</Button>
                </div>
            </div>
            {error && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}

            <div className="grid gap-3 rounded-md border border-border p-3 md:grid-cols-2">
                <div className="relative grid gap-1 pb-4">
                    <Label htmlFor="rb-name">Name</Label>
                    <Input id="rb-name" aria-invalid={missingName || undefined} className={cn(missingName && INVALID)} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="Monthly health pack" />
                    {missingName && <p className="absolute left-0 top-full -mt-4 text-xs text-destructive">Give the report a name</p>}
                </div>
                <div className="grid gap-1">
                    <Label htmlFor="rb-title">Title on the cover</Label>
                    <Input id="rb-title" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} placeholder="Same as the name" />
                </div>
                <div className="grid gap-1 md:col-span-2">
                    <Label htmlFor="rb-desc">Description (only you see this)</Label>
                    <Input id="rb-desc" value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} />
                </div>
                <div className="grid gap-1 md:col-span-2">
                    <Label htmlFor="rb-intro">Text on the cover</Label>
                    <Textarea id="rb-intro" rows={3} maxLength={4000} value={intro} onChange={(e) => setIntro(e.target.value)} placeholder="A short note for whoever reads this: what it covers and who it was prepared for." />
                </div>
                <div className="grid gap-1">
                    <Label htmlFor="rb-footer">Footer on every page</Label>
                    <Input id="rb-footer" value={footer} maxLength={160} onChange={(e) => setFooter(e.target.value)} placeholder="Confidential" />
                </div>
                <div className="grid gap-1">
                    <Label htmlFor="rb-days">Days of activity to cover</Label>
                    <Input id="rb-days" type="number" min={1} max={730} className="w-32" value={days} onChange={(e) => setDays(e.target.value)} placeholder="30" />
                </div>
                <label className="flex items-center gap-2 text-sm"><Switch checked={scorecard} onCheckedChange={setScorecard} aria-label="Show the scorecard on the cover" /> Scorecard on the cover</label>
                <label className="flex items-center gap-2 text-sm"><Switch checked={recommendations} onCheckedChange={setRecommendations} aria-label="Show what needs attention on the cover" /> &ldquo;What needs attention&rdquo; on the cover</label>
            </div>

            <div className="grid gap-2">
                <h3 className="text-sm font-semibold">Sections {sections.length > 0 && <span className="font-normal text-muted-foreground">({sections.length})</span>}</h3>
                {missingSections && <p role="alert" className="text-sm text-destructive">Add at least one section.</p>}
                {sections.map((s, index) => {
                    const def = defOf(s.key);
                    const cols = columns[s.key] ?? [];
                    const filters = countConditions(s.filter);
                    return (
                        <div key={s.uid} className="rounded-md border border-border">
                            <div className="flex flex-wrap items-center gap-2 bg-muted/40 px-3 py-2">
                                <span className="w-6 text-sm font-semibold tabular-nums">{index + 1}</span>
                                <select aria-label={`Report for section ${index + 1}`} className={cn(selectClass, "w-64")} value={s.key} onChange={(e) => update(s.uid, { ...blankSection(e.target.value as ReportKey), uid: s.uid, open: true })}>
                                    {groups.map((g) => (
                                        <optgroup key={g} label={g}>
                                            {catalog.filter((d) => d.group === g).map((d) => <option key={d.key} value={d.key}>{d.title}</option>)}
                                        </optgroup>
                                    ))}
                                </select>
                                <Input aria-label={`Title of section ${index + 1}`} className="h-10 w-64" maxLength={120} value={s.title} onChange={(e) => update(s.uid, { title: e.target.value })} placeholder={def?.title ?? "Title"} />
                                <span className="flex-1 text-xs text-muted-foreground">{[filters ? `${filters} filter${filters === 1 ? "" : "s"}` : "", s.columns ? `${s.columns.length} columns` : "", s.groupBy ? "grouped" : "", s.charts ? "" : "no charts"].filter(Boolean).join(", ")}</span>
                                <Button type="button" variant="ghost" size="icon" aria-label="Move up" disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp className="h-4 w-4" /></Button>
                                <Button type="button" variant="ghost" size="icon" aria-label="Move down" disabled={index === sections.length - 1} onClick={() => move(index, 1)}><ArrowDown className="h-4 w-4" /></Button>
                                <Button type="button" variant="ghost" size="sm" aria-expanded={s.open} onClick={() => update(s.uid, { open: !s.open })}>Settings <ChevronDown className={cn("ml-1 h-4 w-4 transition-transform", !s.open && "-rotate-90")} /></Button>
                                <Button type="button" variant="ghost" size="icon" aria-label="Remove section" onClick={() => setSections((list) => list.filter((x) => x.uid !== s.uid))}><Trash2 className="h-4 w-4" /></Button>
                            </div>
                            {s.open && (
                                <div className="grid gap-3 p-3">
                                    {def && <p className="text-xs text-muted-foreground">{def.description}</p>}
                                    {!!def?.params.length && (
                                        <div className="flex flex-wrap gap-2">
                                            {def.params.map((p) => (
                                                <div key={p.key} className="grid gap-1">
                                                    <Label htmlFor={`${s.uid}-${p.key}`}>{p.label}</Label>
                                                    <Input id={`${s.uid}-${p.key}`} className={p.type === "number" ? "w-28" : "w-72"} type={p.type === "number" ? "number" : "text"} min={p.min} max={p.max} value={s.params[p.key] ?? ""} placeholder={p.default !== undefined ? String(p.default) : undefined} onChange={(e) => update(s.uid, { params: { ...s.params, [p.key]: e.target.value } })} />
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                    {cols.length > 0 ? (
                                        <>
                                            <div className="flex flex-wrap items-end gap-2">
                                                <ColumnPicker columns={cols} selected={s.columns ?? cols.filter((c) => c.visible !== false).map((c) => c.key)} onChange={(next) => update(s.uid, { columns: next })} onReset={() => update(s.uid, { columns: null })} />
                                                <div className="grid gap-1">
                                                    <Label htmlFor={`${s.uid}-sort`}>Sort by</Label>
                                                    <div className="flex gap-1">
                                                        <select id={`${s.uid}-sort`} className={cn(selectClass, "w-48")} value={s.sort[0]?.key ?? ""} onChange={(e) => update(s.uid, { sort: e.target.value ? [{ key: e.target.value, dir: s.sort[0]?.dir ?? "asc" }] : [] })}>
                                                            <option value="">Default order</option>
                                                            {cols.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                                                        </select>
                                                        <select aria-label="Direction" className={cn(selectClass, "w-32")} disabled={!s.sort[0]} value={s.sort[0]?.dir ?? "asc"} onChange={(e) => update(s.uid, { sort: s.sort[0] ? [{ ...s.sort[0], dir: e.target.value as "asc" | "desc" }] : [] })}>
                                                            <option value="asc">Low to high</option>
                                                            <option value="desc">High to low</option>
                                                        </select>
                                                    </div>
                                                </div>
                                                <div className="grid gap-1">
                                                    <Label htmlFor={`${s.uid}-group`}>Group by</Label>
                                                    <select id={`${s.uid}-group`} className={cn(selectClass, "w-48")} value={s.groupBy} onChange={(e) => update(s.uid, { groupBy: e.target.value })}>
                                                        <option value="">No grouping</option>
                                                        {cols.filter((c) => c.type !== "date" && c.type !== "number" && c.type !== "percent").map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                                                    </select>
                                                </div>
                                                <div className="grid gap-1">
                                                    <Label htmlFor={`${s.uid}-rows`}>Rows to show in the PDF</Label>
                                                    <Input id={`${s.uid}-rows`} type="number" min={1} max={5000} className="w-32" value={s.maxRows} onChange={(e) => update(s.uid, { maxRows: e.target.value })} placeholder="300" />
                                                </div>
                                                <label className="flex items-center gap-2 pb-2 text-sm"><Switch checked={s.charts} onCheckedChange={(v) => update(s.uid, { charts: v })} aria-label="Show charts" /> Charts</label>
                                            </div>
                                            <div className="grid gap-1">
                                                <Label>Only include rows where</Label>
                                                <FilterBuilder columns={cols} rows={[]} value={s.filter} onChange={(next) => update(s.uid, { filter: next })} />
                                            </div>
                                        </>
                                    ) : (
                                        <p className="text-sm text-muted-foreground">Loading this report&apos;s columns…</p>
                                    )}
                                </div>
                            )}
                        </div>
                    );
                })}
                <div className="flex flex-wrap items-end gap-2">
                    <div className="grid gap-1">
                        <Label htmlFor="rb-add">Add a section</Label>
                        <select id="rb-add" className={cn(selectClass, "w-72")} value={adding} onChange={(e) => setAdding(e.target.value as ReportKey | "")}>
                            <option value="">Choose a report</option>
                            {groups.map((g) => (
                                <optgroup key={g} label={g}>
                                    {catalog.filter((d) => d.group === g).map((d) => <option key={d.key} value={d.key}>{d.title}</option>)}
                                </optgroup>
                            ))}
                        </select>
                    </div>
                    <Button type="button" variant="outline" disabled={!adding} onClick={() => { if (adding) { setSections((list) => [...list, blankSection(adding)]); setAdding(""); } }}>
                        <Plus className="mr-1 h-4 w-4" /> Add
                    </Button>
                </div>
            </div>
        </form>
    );
}
