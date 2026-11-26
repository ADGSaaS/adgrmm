// app/(dashboard)/automation/page.tsx
"use client";

import { PageHeader, PageShell } from "@/components/page-shell";
import * as React from "react";
import Link from "next/link";
import { ArrowLeft, CalendarClock, ChevronRight, Copy, Pencil, Play, Plus, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/use-toast";
import TargetPicker, { targetIsComplete, type Target } from "@/components/target-picker";
import { useDashboard } from "@/app/(dashboard)/dashboard-context";
import { fetchDevices, jfetch, type Device as ApiDevice } from "@/lib/api";
import { LOAD_CAP, Pager, useAutoLoadMore, usePaged } from "@/components/pager";
import { EmptyState, ListToolbar, SearchField, SegmentedTabs } from "@/components/list-controls";
import ScriptEditorDialog from "@/components/automation/script-editor-dialog";
import ScriptCategoryTiles from "@/components/automation/script-categories";
import { CATEGORY_RIGHT, UNCATEGORIZED, platformOfScript, type Script, type ScriptCategories, type ScriptParameter } from "@/components/automation/script-types";
import { useMe } from "@/lib/use-me";
import { hasPerm } from "@/lib/permissions";
import FailuresPanel from "@/components/automation/failures-panel";
import BulkBatchesPanel from "@/components/bulk/bulk-batches-panel";

type Parameter = ScriptParameter;

type Schedule = {
    id: string;
    automationId: string;
    scriptName: string | null;
    name: string;
    targetType: Target["type"];
    targetId: string | null;
    intervalMinutes: number;
    nextRunAt: string;
    lastRunAt: string | null;
    enabled: boolean;
    parameters: Record<string, string>;
};

type HistoryItem = {
    id: string;
    jobId: string;
    scriptName: string;
    scheduled: boolean;
    device: { id: string; name: string };
    status: string;
    createdAt: string;
    finishedAt: string | null;
    exitCode: number | null;
    stdout: string;
    stderr: string;
};

const errorText = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong.");
/** The words of a server error body (the message field), for places that show an error next to a form. */
const plain = (e: unknown) => {
    const raw = errorText(e);
    try {
        const j = JSON.parse(raw) as { message?: string | string[] };
        return Array.isArray(j.message) ? j.message.join(" ") : j.message ?? raw;
    } catch {
        return raw;
    }
};

/** Categories worked out from the scripts themselves, for a server that does not list categories yet. */
function deriveCategories(scripts: Script[]): ScriptCategories {
    const counts = new Map<string, { builtin: boolean; count: number }>();
    let uncategorized = 0;
    for (const x of scripts) {
        if (!x.category) { uncategorized++; continue; }
        const cur = counts.get(x.category) ?? { builtin: false, count: 0 };
        counts.set(x.category, { builtin: cur.builtin || !!x.builtin, count: cur.count + 1 });
    }
    return { items: [...counts.entries()].sort(([x], [y]) => x.localeCompare(y)).map(([name, v]) => ({ id: null, name, builtin: v.builtin, count: v.count })), uncategorized };
}
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "Not yet");
const failure = (title: string, e: unknown) => toast({ title, description: errorText(e), variant: "destructive", duration: 10_000 });

function every(minutes: number) {
    if (minutes % 10080 === 0) return `Every ${minutes / 10080 === 1 ? "week" : `${minutes / 10080} weeks`}`;
    if (minutes % 1440 === 0) return `Every ${minutes / 1440 === 1 ? "day" : `${minutes / 1440} days`}`;
    if (minutes % 60 === 0) return `Every ${minutes / 60 === 1 ? "hour" : `${minutes / 60} hours`}`;
    return `Every ${minutes} minutes`;
}

/* ---------------------------- running ---------------------------- */

function ParameterFields({ script, values, onChange }: { script: Script; values: Record<string, string>; onChange: (values: Record<string, string>) => void }) {
    if (!script.parameters.length) return null;
    return (
        <div className="grid gap-3">
            {script.parameters.map((p) => (
                <div key={p.name} className="grid gap-2">
                    <Label htmlFor={`param-${p.name}`}>{p.label || p.name}{p.required ? " (required)" : ""}</Label>
                    <Input
                        id={`param-${p.name}`}
                        required={!!p.required}
                        value={values[p.name] ?? p.defaultValue ?? ""}
                        onChange={(e) => onChange({ ...values, [p.name]: e.target.value })}
                    />
                </div>
            ))}
        </div>
    );
}

/** Devices listed at a time in the Run dialog. */
const RUN_PAGE = 100;

function RunDialog({ script, onClose, onStarted }: { script: Script; onClose: () => void; onStarted: () => void }) {
    const { aliases } = useDashboard();
    // The devices this script can run on are searched on the server, which holds them all, a page at a time.
    const kindOfScript = platformOfScript(script);
    // a script for both systems can run on any device
    const platform = kindOfScript === "both" || kindOfScript === "all" ? undefined : kindOfScript === "windows" ? "windows" : "other";
    const [query, setQuery] = React.useState("");
    const [q, setQ] = React.useState("");
    const [rows, setRows] = React.useState<ApiDevice[]>([]);
    const [nextCursor, setNextCursor] = React.useState<string | null>(null);
    const [matching, setMatching] = React.useState(0);
    const [listLoading, setListLoading] = React.useState(true);
    const [listError, setListError] = React.useState<string | null>(null);
    const [selected, setSelected] = React.useState<Set<string>>(new Set());
    const [selectingAll, setSelectingAll] = React.useState(false);

    React.useEffect(() => {
        const id = setTimeout(() => setQ(query.trim()), 250);
        return () => clearTimeout(id);
    }, [query]);

    React.useEffect(() => {
        const ac = new AbortController();
        setListLoading(true);
        setListError(null);
        fetchDevices(RUN_PAGE, null, { ...(platform ? { platform } : {}), ...(q ? { q } : {}) }, { total: true }, { signal: ac.signal })
            .then((r) => {
                if (ac.signal.aborted) return;
                setRows(r.items);
                setNextCursor(r.nextCursor);
                setMatching(r.total ?? r.items.length);
            })
            .catch((e) => {
                if (ac.signal.aborted || e?.name === "AbortError") return;
                setRows([]);
                setNextCursor(null);
                setMatching(0);
                setListError(errorText(e));
            })
            .finally(() => {
                if (!ac.signal.aborted) setListLoading(false);
            });
        return () => ac.abort();
    }, [platform, q]);

    const loadMore = async () => {
        if (!nextCursor) return;
        setListLoading(true);
        try {
            const r = await fetchDevices(RUN_PAGE, nextCursor, { ...(platform ? { platform } : {}), ...(q ? { q } : {}) });
            setRows((prev) => [...prev, ...r.items]);
            setNextCursor(r.nextCursor);
        } catch (e) {
            setListError(errorText(e));
        } finally {
            setListLoading(false);
        }
    };

    // Every device the search matches, not only the ones listed: fetched in pages of 200 and ticked.
    const selectAllMatching = async () => {
        setSelectingAll(true);
        setListError(null);
        try {
            const ids: string[] = [];
            let cursor: string | null = null;
            do {
                const r: Awaited<ReturnType<typeof fetchDevices>> = await fetchDevices(200, cursor, { ...(platform ? { platform } : {}), ...(q ? { q } : {}) });
                ids.push(...r.items.map((d) => d.id));
                cursor = r.nextCursor;
            } while (cursor);
            setSelected((prev) => new Set([...prev, ...ids]));
        } catch (e) {
            setListError(errorText(e));
        } finally {
            setSelectingAll(false);
        }
    };

    const visible = rows;
    const allVisible = visible.length > 0 && visible.every((d) => selected.has(d.id));

    const toggleAll = () =>
        setSelected((prev) => {
            const next = new Set(prev);
            visible.forEach((d) => (allVisible ? next.delete(d.id) : next.add(d.id)));
            return next;
        });

    const [values, setValues] = React.useState<Record<string, string>>({});
    const [running, setRunning] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        setRunning(true);
        setError(null);
        try {
            const result = await jfetch<{ started: unknown[]; skipped: Array<{ name: string; reason: string }> }>(`/api/scripts/${script.id}/run`, {
                method: "POST",
                body: { deviceIds: Array.from(selected), parameters: values },
            });
            toast({
                title: `Started on ${result.started.length} ${result.started.length === 1 ? "device" : "devices"}`,
                description: result.skipped.length ? `Skipped ${result.skipped.length}: ${result.skipped[0].reason}` : "Results appear under History.",
                variant: result.skipped.length ? "warning" : "success",
            });
            onStarted();
        } catch (err) {
            setError(errorText(err));
        } finally {
            setRunning(false);
        }
    };

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-h-[90dvh] overflow-y-auto">
                <form onSubmit={submit} className="space-y-4">
                    <DialogHeader>
                        <DialogTitle>Run {script.name}</DialogTitle>
                        <DialogDescription>Offline devices run it when they reconnect, if that is within the hour.</DialogDescription>
                    </DialogHeader>
                    <ParameterFields script={script} values={values} onChange={setValues} />
                    <div className="grid gap-2">
                        <Label htmlFor="run-find">Devices ({selected.size} selected)</Label>
                        <Input id="run-find" placeholder="Filter devices" value={query} onChange={(e) => setQuery(e.target.value)} />
                        <div className="max-h-56 overflow-y-auto rounded-md border">
                            <label className="flex items-center gap-2 border-b px-3 py-2 text-sm font-medium">
                                <Checkbox checked={allVisible} onCheckedChange={toggleAll} />
                                All shown ({visible.length}{nextCursor ? ` of ${matching}` : ""})
                            </label>
                            {visible.map((d) => (
                                <label key={d.id} className="flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-accent/50">
                                    <Checkbox
                                        checked={selected.has(d.id)}
                                        onCheckedChange={(v) =>
                                            setSelected((prev) => {
                                                const next = new Set(prev);
                                                if (v) next.add(d.id);
                                                else next.delete(d.id);
                                                return next;
                                            })
                                        }
                                    />
                                    <span className="min-w-0 truncate">{aliases[d.id] || d.hostname}</span>
                                    <span className="ml-auto truncate text-xs text-muted-foreground">{d.client}</span>
                                </label>
                            ))}
                            {visible.length === 0 && !listLoading && !listError ? <p className="px-3 py-4 text-center text-xs text-muted-foreground">No devices this script can run on.</p> : null}
                            {listLoading && visible.length === 0 ? <p className="px-3 py-4 text-center text-xs text-muted-foreground">Loading devices…</p> : null}
                            {listError ? <p role="alert" className="px-3 py-4 text-center text-xs text-destructive">{listError}</p> : null}
                            {nextCursor ? (
                                <div className="flex flex-wrap items-center gap-2 border-t px-3 py-2 text-xs text-muted-foreground">
                                    <span>Showing {visible.length} of {matching}.</span>
                                    <Button type="button" variant="outline" size="sm" className="h-7 text-xs" disabled={listLoading} onClick={() => void loadMore()}>Show more</Button>
                                    <Button type="button" variant="outline" size="sm" className="h-7 text-xs" disabled={selectingAll} onClick={() => void selectAllMatching()}>
                                        {selectingAll ? "Selecting…" : `Select all ${matching}`}
                                    </Button>
                                </div>
                            ) : null}
                        </div>
                    </div>
                    {error ? <p className="text-sm text-destructive">{error}</p> : null}
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
                        <Button type="submit" disabled={running || selected.size === 0} className="gap-1.5">
                            <Play className="h-4 w-4" aria-hidden="true" />
                            {running ? "Starting…" : "Run"}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

/* ---------------------------- schedules ---------------------------- */

const UNITS = [
    { value: 1, label: "minutes" },
    { value: 60, label: "hours" },
    { value: 1440, label: "days" },
    { value: 10080, label: "weeks" },
];

function ScheduleDialog({ scripts, initial, onClose, onSaved }: { scripts: Script[]; initial: Schedule | null; onClose: () => void; onSaved: () => void }) {
    const startingUnit = initial ? [...UNITS].reverse().find((u) => initial.intervalMinutes % u.value === 0)?.value ?? 1 : 1440;
    const [name, setName] = React.useState(initial?.name ?? "");
    const [automationId, setAutomationId] = React.useState(initial?.automationId ?? scripts[0]?.id ?? "");
    const [target, setTarget] = React.useState<Target>(initial ? { type: initial.targetType, id: initial.targetId } : { type: "organization" });
    const [amount, setAmount] = React.useState(initial ? initial.intervalMinutes / startingUnit : 1);
    const [unit, setUnit] = React.useState(startingUnit);
    const [startAt, setStartAt] = React.useState(() => {
        const date = initial ? new Date(initial.nextRunAt) : new Date(Date.now() + 3_600_000);
        return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
    });
    const [enabled, setEnabled] = React.useState(initial?.enabled ?? true);
    const [values, setValues] = React.useState<Record<string, string>>(initial?.parameters ?? {});
    const [saving, setSaving] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);

    const script = scripts.find((s) => s.id === automationId);

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        setSaving(true);
        setError(null);
        try {
            await jfetch(initial ? `/api/scripts/schedules/${initial.id}` : "/api/scripts/schedules", {
                method: initial ? "PUT" : "POST",
                body: {
                    automationId,
                    name,
                    targetType: target.type,
                    ...(target.type === "organization" ? {} : { targetId: target.id }),
                    intervalMinutes: amount * unit,
                    startAt: new Date(startAt).toISOString(),
                    enabled,
                    parameters: values,
                },
            });
            toast({ title: "Schedule saved", variant: "success" });
            onSaved();
        } catch (err) {
            setError(errorText(err));
        } finally {
            setSaving(false);
        }
    };

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-h-[90dvh] overflow-y-auto">
                <form onSubmit={submit} className="space-y-4">
                    <DialogHeader>
                        <DialogTitle>{initial ? "Edit schedule" : "New schedule"}</DialogTitle>
                        <DialogDescription>Devices that do not suit the script&apos;s language are skipped.</DialogDescription>
                    </DialogHeader>
                    <div className="grid gap-2">
                        <Label htmlFor="schedule-name">Name</Label>
                        <Input id="schedule-name" required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g., Clear temp files nightly" />
                    </div>
                    <div className="grid gap-2">
                        <Label htmlFor="schedule-script">Script</Label>
                        <select id="schedule-script" required value={automationId} onChange={(e) => setAutomationId(e.target.value)} className="h-9 rounded-md border bg-background px-2 text-sm">
                            {scripts.map((s) => (
                                <option key={s.id} value={s.id}>{s.name}</option>
                            ))}
                        </select>
                    </div>
                    {script ? <ParameterFields script={script} values={values} onChange={setValues} /> : null}
                    <div className="grid gap-2">
                        <Label>Runs on</Label>
                        <TargetPicker value={target} onChange={setTarget} idPrefix="schedule-target" />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                        <div className="grid gap-2">
                            <Label htmlFor="schedule-amount">Every</Label>
                            <div className="flex gap-2">
                                <Input id="schedule-amount" type="number" min={1} required className="w-20" value={amount} onChange={(e) => setAmount(Number(e.target.value))} />
                                <select aria-label="Unit" value={unit} onChange={(e) => setUnit(Number(e.target.value))} className="h-9 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm">
                                    {UNITS.map((u) => (
                                        <option key={u.value} value={u.value}>{u.label}</option>
                                    ))}
                                </select>
                            </div>
                        </div>
                        <div className="grid gap-2">
                            <Label htmlFor="schedule-start">{initial ? "Next run" : "First run"}</Label>
                            <Input id="schedule-start" type="datetime-local" required value={startAt} onChange={(e) => setStartAt(e.target.value)} />
                        </div>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                        <Label htmlFor="schedule-enabled">Turned on</Label>
                        <Switch id="schedule-enabled" checked={enabled} onCheckedChange={setEnabled} />
                    </div>
                    {error ? <p className="text-sm text-destructive">{error}</p> : null}
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
                        <Button type="submit" disabled={saving || !targetIsComplete(target) || !automationId}>{saving ? "Saving…" : "Save"}</Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

/* ---------------------------- history ---------------------------- */

const STATUS_STYLES: Record<string, string> = {
    succeeded: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
    failed: "bg-red-500/15 text-red-600 dark:text-red-400",
    timeout: "bg-red-500/15 text-red-600 dark:text-red-400",
};

function HistoryRow({ item }: { item: HistoryItem }) {
    const [open, setOpen] = React.useState(false);
    return (
        <li>
            <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-5 py-4 text-left text-sm hover:bg-accent">
                <ChevronRight className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} aria-hidden="true" />
                <span className="min-w-0 flex-1 basis-48">
                    <span className="block truncate text-sm font-medium">{item.scriptName}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                        {item.device.name} · {when(item.createdAt)}{item.scheduled ? " · scheduled" : ""}
                    </span>
                </span>
                <span className={cn("rounded px-1.5 py-0.5 text-xs capitalize", STATUS_STYLES[item.status] ?? "bg-muted text-muted-foreground")}>{item.status}</span>
            </button>
            {open ? (
                <div className="space-y-2 border-t border-border/60 bg-muted/30 px-5 py-3">
                    <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                        {item.exitCode !== null ? <span>Exit code {item.exitCode}</span> : null}
                        <span>Finished: {when(item.finishedAt)}</span>
                        <Link href={`/devices/${encodeURIComponent(item.device.id)}`} className="underline underline-offset-2">Open {item.device.name}</Link>
                    </div>
                    {item.stdout ? <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-background p-2 font-mono text-xs">{item.stdout}</pre> : null}
                    {item.stderr ? <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-background p-2 font-mono text-xs text-red-600 dark:text-red-400">{item.stderr}</pre> : null}
                    {!item.stdout && !item.stderr ? <p className="text-xs text-muted-foreground">No output.</p> : null}
                </div>
            ) : null}
        </li>
    );
}

/* ---------------------------- page ---------------------------- */

const TABS = [
    { value: "scripts", label: "Scripts" },
    { value: "schedules", label: "Schedules" },
    { value: "history", label: "History" },
    { value: "failures", label: "Failures" },
    { value: "bulk", label: "Bulk actions" },
] as const;

export default function AutomationPage() {
    const [tab, setTab] = React.useState<(typeof TABS)[number]["value"]>("scripts");
    // A link from a bulk action's result opens this tab on that batch (?tab=bulk&batch=<id>).
    const [openBatch, setOpenBatch] = React.useState<string | null>(null);
    React.useEffect(() => {
        const sp = new URLSearchParams(window.location.search);
        const wanted = sp.get("tab");
        if (TABS.some((t) => t.value === wanted)) setTab(wanted as (typeof TABS)[number]["value"]);
        setOpenBatch(sp.get("batch"));
    }, []);
    const [scripts, setScripts] = React.useState<Script[] | null>(null);
    const [schedules, setSchedules] = React.useState<Schedule[] | null>(null);
    const [history, setHistory] = React.useState<HistoryItem[] | null>(null);
    const [cursor, setCursor] = React.useState<string | null>(null);
    const [error, setError] = React.useState<string | null>(null);

    const [editingScript, setEditingScript] = React.useState<Script | "new" | null>(null);
    const [runningScript, setRunningScript] = React.useState<Script | null>(null);
    const [editingSchedule, setEditingSchedule] = React.useState<Schedule | "new" | null>(null);
    const [scriptQuery, setScriptQuery] = React.useState("");
    const { user } = useMe();
    const canManageCategories = hasPerm(user?.permissions, CATEGORY_RIGHT);
    const [cats, setCats] = React.useState<ScriptCategories | null>(null);
    // The open category (its name, or UNCATEGORIZED), kept in the address (?category=) so a reload and the browser's Back button work.
    const [openCategory, setOpenCategory] = React.useState<string | null>(null);
    React.useEffect(() => {
        const read = () => setOpenCategory(new URLSearchParams(window.location.search).get("category") || null);
        read();
        window.addEventListener("popstate", read);
        return () => window.removeEventListener("popstate", read);
    }, []);
    const showCategory = (key: string | null) => {
        setOpenCategory(key);
        setScriptQuery("");
        const sp = new URLSearchParams(window.location.search);
        if (key) sp.set("category", key); else sp.delete("category");
        const qs = sp.toString();
        window.history.pushState(null, "", qs ? `?${qs}` : window.location.pathname);
    };

    const loadScripts = React.useCallback(() => jfetch<{ items: Script[] }>("/api/scripts").then((r) => setScripts(r.items)).catch((e) => setError(errorText(e))), []);
    const loadCategories = React.useCallback(() => jfetch<ScriptCategories>("/api/scripts/categories").then(setCats).catch(() => setCats(null)), []);
    const reloadScripts = React.useCallback(() => { void loadScripts(); void loadCategories(); }, [loadScripts, loadCategories]);
    const loadSchedules = React.useCallback(() => jfetch<{ items: Schedule[] }>("/api/scripts/schedules").then((r) => setSchedules(r.items)).catch((e) => setError(errorText(e))), []);
    const loadHistory = React.useCallback((after?: string | null) => {
        const query = `?limit=200${after ? `&cursor=${encodeURIComponent(after)}` : ""}`;
        return jfetch<{ items: HistoryItem[]; nextCursor: string | null }>(`/api/scripts/history${query}`)
            .then((r) => {
                setHistory((prev) => (after ? [...(prev ?? []), ...r.items] : r.items));
                setCursor(r.nextCursor);
            })
            .catch((e) => setError(errorText(e)));
    }, []);

    React.useEffect(() => {
        void loadScripts();
        void loadCategories();
        void loadSchedules();
    }, [loadScripts, loadCategories, loadSchedules]);

    React.useEffect(() => {
        if (tab === "history") void loadHistory();
    }, [loadHistory, tab]);

    useAutoLoadMore(cursor, false, history?.length ?? 0, () => void loadHistory(cursor));
    // The categories come from the server; for a server that does not list them yet they are worked out from the scripts.
    const catData = cats ?? (scripts ? deriveCategories(scripts) : null);
    const searching = scriptQuery.trim().length > 0;
    const showTiles = openCategory === null && !searching;
    const shownScripts = React.useMemo(() => {
        const q = scriptQuery.trim().toLowerCase();
        return (scripts ?? []).filter((x) => {
            if (openCategory === UNCATEGORIZED) { if (x.category) return false; }
            else if (openCategory !== null && x.category !== openCategory) return false;
            return !q || `${x.name} ${x.description ?? ""} ${x.category ?? ""} ${x.language}`.toLowerCase().includes(q);
        });
    }, [scripts, scriptQuery, openCategory]);
    const scriptsPaged = usePaged(shownScripts, "scripts", 25);

    const duplicateScript = async (script: Script) => {
        try {
            const copy = await jfetch<Script>(`/api/scripts/${script.id}/duplicate`, { method: "POST", body: {} });
            toast({ title: `Copied as "${copy.name}"`, description: "Your copy can be edited." });
            reloadScripts();
            setEditingScript(copy);
        } catch (e) {
            failure("It was not copied", e);
        }
    };
    const schedulesPaged = usePaged(schedules ?? [], "script-schedules", 25);
    const historyPaged = usePaged(history ?? [], "script-history", 50);

    const resetScript = async (script: Script) => {
        if (!window.confirm(`Put "${script.name}" back to the version ADG RMM ships? Your changes to it are lost.`)) return;
        try {
            await jfetch(`/api/scripts/${script.id}/reset`, { method: "POST", body: {} });
            toast({ title: "Back to the original", variant: "success" });
            reloadScripts();
        } catch (e) {
            failure("It was not reset", e);
        }
    };

    const createCategory = async (name: string): Promise<string | null> => {
        try {
            await jfetch("/api/scripts/categories", { method: "POST", body: { name } });
            toast({ title: `Category "${name}" created`, variant: "success" });
            await loadCategories();
            return null;
        } catch (e) {
            return plain(e);
        }
    };

    const deleteCategory = async (id: string, name: string) => {
        if (!window.confirm(`Delete the empty category "${name}"?`)) return;
        try {
            await jfetch(`/api/scripts/categories/${id}`, { method: "DELETE" });
            toast({ title: "Category deleted" });
            void loadCategories();
        } catch (e) {
            failure("It was not deleted", new Error(plain(e)));
        }
    };

    const removeScript = async (script: Script) => {
        if (!window.confirm(`Delete "${script.name}"? Its schedules are deleted too. Its history is kept.${script.builtin ? " A built-in script can be brought back with Restore." : ""}`)) return;
        try {
            await jfetch(`/api/scripts/${script.id}`, { method: "DELETE" });
            toast({ title: "Script deleted" });
            reloadScripts();
            void loadSchedules();
        } catch (e) {
            failure("It was not deleted", e);
        }
    };

    const removeSchedule = async (schedule: Schedule) => {
        if (!window.confirm(`Delete "${schedule.name}"?`)) return;
        try {
            await jfetch(`/api/scripts/schedules/${schedule.id}`, { method: "DELETE" });
            toast({ title: "Schedule deleted" });
            void loadSchedules();
        } catch (e) {
            failure("It was not deleted", e);
        }
    };

    return (
        <PageShell>
            <PageHeader
                title="Automation"
                actions={
                    <>
                        {tab === "history" ? (
                            <Button variant="ghost" size="icon" aria-label="Refresh" title="Refresh" onClick={() => void loadHistory()}>
                                <RefreshCw className="h-4 w-4" aria-hidden="true" />
                            </Button>
                        ) : null}
                        {tab === "scripts" ? (
                            <Button className="gap-1.5" onClick={() => setEditingScript("new")}>
                                <Plus className="h-4 w-4" aria-hidden="true" />
                                New script
                            </Button>
                        ) : null}
                        {tab === "schedules" ? (
                            <Button className="gap-1.5" disabled={!scripts?.length} onClick={() => setEditingSchedule("new")}>
                                <CalendarClock className="h-4 w-4" aria-hidden="true" />
                                New schedule
                            </Button>
                        ) : null}
                    </>
                }
            />

            <ListToolbar
                left={
                    <SegmentedTabs
                        label="Automation"
                        items={TABS.map((t) => ({ key: t.value, label: t.label }))}
                        value={tab}
                        onChange={(k) => setTab(k as (typeof TABS)[number]["value"])}
                    />
                }
            />

            {error ? <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm">{error}</div> : null}

            {tab === "failures" ? <FailuresPanel /> : null}

            {tab === "bulk" ? <BulkBatchesPanel initialBatchId={openBatch} /> : null}

            {tab === "scripts" ? (
                <>
                    {scripts === null || catData === null ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
                    {scripts && catData ? (
                        <>
                            <div className="flex flex-wrap items-center gap-3">
                                {openCategory !== null ? (
                                    <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={() => showCategory(null)} data-testid="back-to-categories">
                                        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                                        All categories
                                    </Button>
                                ) : null}
                                <div className="min-w-0">
                                    <h2 className="truncate text-lg font-semibold" data-testid="scripts-heading">
                                        {openCategory === null ? (searching ? "Search results" : "Script categories") : openCategory === UNCATEGORIZED ? "Uncategorized" : openCategory}
                                    </h2>
                                    <p className="text-xs text-muted-foreground">
                                        {showTiles ? "Pick a category to see its scripts." : `${shownScripts.length} ${shownScripts.length === 1 ? "script" : "scripts"}`}
                                    </p>
                                </div>
                                <div className="ml-auto">
                                    <SearchField label="Search scripts" placeholder="Search scripts" value={scriptQuery} onChange={setScriptQuery} />
                                </div>
                            </div>
                            {showTiles ? (
                                <>
                                    <ScriptCategoryTiles data={catData} canManage={canManageCategories} onOpen={showCategory} onCreate={createCategory} onDelete={(id, name) => void deleteCategory(id, name)} />
                                    <p className="text-sm text-muted-foreground" data-testid="builtin-note">
                                        Scripts marked <strong>Built-in</strong> come with ADG RMM. You can run, copy and edit them; an edited one shows as <strong>Customized</strong> and can be reset to the original.
                                    </p>
                                </>
                            ) : (
                                <>
                                    {shownScripts.length === 0 ? <EmptyState>{searching ? "No script matches that." : "There are no scripts in this category yet. Use New script to add one here."}</EmptyState> : null}
                                    {shownScripts.length > 0 ? (
                                        <div className="overflow-hidden rounded-xl border border-border/70 bg-card">
                                            <ul className="divide-y divide-border/60">
                                                {scriptsPaged.rows.map((script) => (
                                                    <li key={script.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 px-5 py-4 text-sm hover:bg-accent">
                                                        <div className="min-w-0 flex-1 basis-56">
                                                            <div className="flex items-center gap-2">
                                                                <span className="truncate text-sm font-medium">{script.name}</span>
                                                                {script.builtin ? <span className="shrink-0 rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">Built-in</span> : null}
                                                                {script.customized ? <span className="shrink-0 rounded-full border border-amber-500/50 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400">Customized</span> : null}
                                                            </div>
                                                            <div className="truncate text-xs text-muted-foreground">
                                                                {platformOfScript(script) === "all" ? "PowerShell and Bash, also macOS" : platformOfScript(script) === "both" ? "PowerShell and Bash" : script.language === "powershell" ? "PowerShell" : "Bash"}
                                                                {searching && script.category ? ` · ${script.category}` : ""}
                                                                {script.description ? ` · ${script.description}` : ""}
                                                            </div>
                                                        </div>
                                                        <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setRunningScript(script)}>
                                                            <Play className="h-3.5 w-3.5" aria-hidden="true" />
                                                            Run
                                                        </Button>
                                                        <Button variant="ghost" size="icon" aria-label={`Edit ${script.name}`} title="Edit" onClick={() => setEditingScript(script)}>
                                                            <Pencil className="h-4 w-4" aria-hidden="true" />
                                                        </Button>
                                                        <Button variant="ghost" size="icon" aria-label={`Duplicate ${script.name}`} title="Make a copy" onClick={() => void duplicateScript(script)}>
                                                            <Copy className="h-4 w-4" aria-hidden="true" />
                                                        </Button>
                                                        {script.customized ? (
                                                            <Button variant="ghost" size="icon" aria-label={`Reset ${script.name} to the original`} title="Reset to the original" onClick={() => void resetScript(script)}>
                                                                <RotateCcw className="h-4 w-4" aria-hidden="true" />
                                                            </Button>
                                                        ) : null}
                                                        <Button variant="ghost" size="icon" aria-label={`Delete ${script.name}`} title="Delete" onClick={() => void removeScript(script)}>
                                                            <Trash2 className="h-4 w-4" aria-hidden="true" />
                                                        </Button>
                                                    </li>
                                                ))}
                                            </ul>
                                        </div>
                                    ) : null}
                                    <Pager paged={scriptsPaged} noun="scripts" />
                                </>
                            )}
                        </>
                    ) : null}
                </>
            ) : null}

            {tab === "schedules" ? (
                <>
                    {schedules === null ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
                    {schedules?.length === 0 ? <EmptyState>{scripts?.length ? "No schedules yet." : "Save a script first, then it can be scheduled."}</EmptyState> : null}
                    {schedules && schedules.length > 0 ? (
                        <>
                            <div className="overflow-hidden rounded-xl border border-border/70 bg-card">
                                <ul className="divide-y divide-border/60">
                                    {schedulesPaged.rows.map((schedule) => (
                                        <li key={schedule.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 px-5 py-4 text-sm hover:bg-accent">
                                            <div className="min-w-0 flex-1 basis-56">
                                                <div className="flex items-center gap-2">
                                                    <span className="truncate text-sm font-medium">{schedule.name}</span>
                                                    {schedule.enabled ? null : <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">Off</span>}
                                                </div>
                                                <div className="truncate text-xs text-muted-foreground">
                                                    {schedule.scriptName} · {every(schedule.intervalMinutes)} · next {when(schedule.nextRunAt)}
                                                </div>
                                            </div>
                                            <Button variant="ghost" size="icon" aria-label={`Edit ${schedule.name}`} title="Edit" onClick={() => setEditingSchedule(schedule)}>
                                                <Pencil className="h-4 w-4" aria-hidden="true" />
                                            </Button>
                                            <Button variant="ghost" size="icon" aria-label={`Delete ${schedule.name}`} title="Delete" onClick={() => void removeSchedule(schedule)}>
                                                <Trash2 className="h-4 w-4" aria-hidden="true" />
                                            </Button>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                            <Pager paged={schedulesPaged} noun="schedules" />
                        </>
                    ) : null}
                </>
            ) : null}

            {tab === "history" ? (
                <>
                    {history === null ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
                    {history?.length === 0 ? <EmptyState>Nothing has run yet.</EmptyState> : null}
                    {history && history.length > 0 ? (
                        <>
                            <div className="overflow-hidden rounded-xl border border-border/70 bg-card">
                                <ul className="divide-y divide-border/60">
                                    {historyPaged.rows.map((item) => (
                                        <HistoryRow key={item.id} item={item} />
                                    ))}
                                </ul>
                            </div>
                            <Pager paged={historyPaged} noun="runs" />
                            {cursor && history.length >= LOAD_CAP ? <p className="text-xs text-muted-foreground">Showing the newest {LOAD_CAP}.</p> : null}
                        </>
                    ) : null}
                </>
            ) : null}

            {editingScript ? (
                <ScriptEditorDialog
                    key={editingScript === "new" ? "new" : editingScript.id}
                    initial={editingScript === "new" ? null : editingScript}
                    defaultCategory={openCategory}
                    categories={catData?.items ?? []}
                    canCreateCategory={canManageCategories}
                    onCategoryCreated={() => void loadCategories()}
                    onClose={() => setEditingScript(null)}
                    onSaved={() => {
                        setEditingScript(null);
                        reloadScripts();
                    }}
                />
            ) : null}
            {runningScript ? (
                <RunDialog
                    script={runningScript}
                    onClose={() => setRunningScript(null)}
                    onStarted={() => {
                        setRunningScript(null);
                        setTab("history");
                    }}
                />
            ) : null}
            {editingSchedule ? (
                <ScheduleDialog
                    scripts={scripts ?? []}
                    initial={editingSchedule === "new" ? null : editingSchedule}
                    onClose={() => setEditingSchedule(null)}
                    onSaved={() => {
                        setEditingSchedule(null);
                        void loadSchedules();
                    }}
                />
            ) : null}
        </PageShell>
    );
}
