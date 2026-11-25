"use client";

// Recurring tickets: a ticket opened from a ticket template on a schedule, for a customer (and site, and device).
// Daily, weekly, monthly or yearly at a time in a time zone, with a start and end date, "skip if the previous one is
// still open", the next times shown before saving, pause and resume, run now, and the history of every run.
import * as React from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { History, Pause, Pencil, Play, Plus, Repeat, Trash2, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import DeviceSearchPicker from "@/components/tickets/device-search-picker";
import { fetchCustomers, fetchCustomerSites, jfetch, type CustomerClient, type CustomerSite } from "@/lib/api";
import { hasPerm } from "@/lib/permissions";
import { useMe } from "@/lib/use-me";
import type { ToastFn } from "../types";

const messageOf = (e: unknown) => {
    const raw = e instanceof Error ? e.message : "Something went wrong.";
    try {
        const j = JSON.parse(raw) as { message?: string | string[] };
        return Array.isArray(j.message) ? j.message.join(" ") : j.message ?? raw;
    } catch {
        return raw;
    }
};

type Recurring = {
    id: string;
    name: string;
    templateId: string | null;
    templateName: string | null;
    subject: string | null;
    description: string | null;
    priority: string | null;
    clientId: string;
    clientName: string | null;
    siteId: string | null;
    siteName: string | null;
    deviceId: string | null;
    deviceName: string | null;
    assigneeUserId: string | null;
    assigneeName: string | null;
    frequency: "daily" | "weekly" | "monthly" | "yearly";
    time: string;
    timezone: string;
    daysOfWeek: number[];
    dayOfMonth: number | null;
    monthOfYear: number | null;
    startDate: string | null;
    endDate: string | null;
    skipIfOpen: boolean;
    enabled: boolean;
    schedule: string;
    nextRunAt: string | null;
    nextRuns: string[];
    lastRunAt: string | null;
    lastStatus: string | null;
    lastError: string | null;
    openTickets: number;
    finished: boolean;
};

type Run = { id: string; scheduledFor: string; trigger: string; status: string; error: string | null; at: string; ticket: { id: string; number: number; title: string; status: string } | null };
type TemplateOpt = { id: string; name: string; subject: string };
type UserOpt = { id: string; label: string };

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const PRIORITIES = ["low", "medium", "high", "urgent"];

const browserZone = () => {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
        return "UTC";
    }
};
const zones = (): string[] => {
    try {
        return (Intl as any).supportedValuesOf?.("timeZone") ?? ["UTC"];
    } catch {
        return ["UTC"];
    }
};
const when = (iso: string | null, tz?: string) => {
    if (!iso) return "-";
    try {
        return new Date(iso).toLocaleString([], { timeZone: tz, dateStyle: "medium", timeStyle: "short" });
    } catch {
        return new Date(iso).toLocaleString();
    }
};

const STATUS_STYLE: Record<string, string> = {
    created: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
    skipped: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
    failed: "bg-red-500/15 text-red-700 dark:text-red-300",
    pending: "bg-muted text-muted-foreground",
};
function Badge({ status }: { status: string }) {
    return <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium capitalize ${STATUS_STYLE[status] ?? "bg-muted text-muted-foreground"}`}>{status}</span>;
}

export default function RecurringTicketsTab({ push }: { push: ToastFn }) {
    const canManage = hasPerm(useMe().permissions, "settings.write");
    const params = useSearchParams();
    const [items, setItems] = React.useState<Recurring[] | null>(null);
    const [editing, setEditing] = React.useState<Recurring | { templateId?: string } | null>(null);
    const [history, setHistory] = React.useState<Recurring | null>(null);
    const [busy, setBusy] = React.useState<string | null>(null);

    const load = React.useCallback(async () => {
        try {
            setItems((await jfetch<{ items: Recurring[] }>("/api/recurring-tickets")).items);
        } catch (e) {
            setItems([]);
            push({ title: "Could not load recurring tickets", desc: messageOf(e), kind: "destructive" });
        }
    }, [push]);
    React.useEffect(() => {
        void load();
    }, [load]);

    // "Make recurring" on a ticket template links here with the template chosen.
    const handledLink = React.useRef(false);
    React.useEffect(() => {
        const t = params?.get("template");
        if (t && !handledLink.current && canManage) {
            handledLink.current = true;
            setEditing({ templateId: t });
        }
    }, [params, canManage]);

    async function act(r: Recurring, what: "pause" | "resume" | "run") {
        setBusy(r.id + what);
        try {
            const res = await jfetch<any>(`/api/recurring-tickets/${r.id}/${what}`, { method: "POST" });
            if (what === "run") {
                if (res.status === "created") push({ title: "Ticket opened", desc: `Made from "${r.name}".`, kind: "success" });
                else push({ title: res.status === "failed" ? "The ticket could not be opened" : "Nothing opened", desc: res.error ?? res.reason ?? "", kind: res.status === "failed" ? "destructive" : "warning" });
            } else push({ title: what === "pause" ? "Paused" : "Resumed", desc: r.name, kind: "success" });
            await load();
        } catch (e) {
            push({ title: "That did not work", desc: messageOf(e), kind: "destructive" });
        } finally {
            setBusy(null);
        }
    }

    async function remove(r: Recurring) {
        if (!window.confirm(`Delete "${r.name}"? The tickets it already opened stay.`)) return;
        try {
            await jfetch(`/api/recurring-tickets/${r.id}`, { method: "DELETE" });
            await load();
        } catch (e) {
            push({ title: "Could not delete", desc: messageOf(e), kind: "destructive" });
        }
    }

    if (!items) return <div className="p-4 text-sm text-muted-foreground">Loading…</div>;

    return (
        <div className="grid w-full min-w-0 gap-6">
            <div>
                <h2 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
                    <Repeat className="h-5 w-5" aria-hidden /> Recurring tickets
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                    Open the same kind of ticket again and again for a customer: a monthly check, a yearly renewal. Each one is made from a{" "}
                    <a className="underline underline-offset-2" href="/administration?tab=templates">
                        ticket template
                    </a>{" "}
                    at the time you choose, and it never opens twice for the same period, even after a restart.
                </p>
            </div>
            {canManage ? (
                <div>
                    <Button size="sm" onClick={() => setEditing({})}>
                        <Plus className="mr-1.5 h-4 w-4" aria-hidden /> New recurring ticket
                    </Button>
                </div>
            ) : null}

            {items.length === 0 ? (
                <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                    Nothing recurring yet. Add one, for example &ldquo;Monthly patch review&rdquo; for a customer on the last day of every month.
                </p>
            ) : (
                <div className="overflow-x-auto rounded-lg border">
                    <table className="w-full min-w-[900px] text-sm">
                        <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                            <tr>
                                <th className="p-2 font-medium">Name</th>
                                <th className="p-2 font-medium">For</th>
                                <th className="p-2 font-medium">Schedule</th>
                                <th className="p-2 font-medium">Next ticket</th>
                                <th className="p-2 font-medium">Last run</th>
                                <th className="p-2 font-medium">Open</th>
                                <th className="p-2" />
                            </tr>
                        </thead>
                        <tbody className="divide-y">
                            {items.map((r) => (
                                <tr key={r.id} className={r.enabled ? "" : "text-muted-foreground"}>
                                    <td className="p-2">
                                        <div className="font-medium text-foreground">{r.name}</div>
                                        <div className="text-xs">{r.templateName ? `Template: ${r.templateName}` : r.subject ? `Subject: ${r.subject}` : <span className="text-destructive">No template</span>}</div>
                                    </td>
                                    <td className="p-2">
                                        <div>{r.clientName ?? "-"}</div>
                                        <div className="text-xs">{[r.siteName, r.deviceName].filter(Boolean).join(" / ")}</div>
                                    </td>
                                    <td className="p-2">
                                        <div>{r.schedule}</div>
                                        {r.startDate || r.endDate ? <div className="text-xs">{[r.startDate ? `from ${r.startDate}` : "", r.endDate ? `until ${r.endDate}` : ""].filter(Boolean).join(" ")}</div> : null}
                                        {r.skipIfOpen ? <div className="text-xs">Skips while the last one is open</div> : null}
                                    </td>
                                    <td className="p-2">
                                        {r.enabled ? (
                                            <span title={r.nextRuns.map((n) => when(n, r.timezone)).join("\n")}>{when(r.nextRunAt, r.timezone)}</span>
                                        ) : r.finished ? (
                                            <span>Finished</span>
                                        ) : (
                                            <span>Paused</span>
                                        )}
                                    </td>
                                    <td className="p-2">
                                        {r.lastStatus ? <Badge status={r.lastStatus} /> : <span className="text-xs">Not yet</span>}
                                        {r.lastRunAt ? <div className="text-xs">{when(r.lastRunAt)}</div> : null}
                                        {r.lastStatus === "failed" && r.lastError ? <div className="max-w-[16rem] text-xs text-destructive">{r.lastError}</div> : null}
                                    </td>
                                    <td className="p-2 tabular-nums">{r.openTickets}</td>
                                    <td className="p-2">
                                        <div className="flex justify-end gap-1">
                                            <Button size="icon" variant="ghost" aria-label={`History of ${r.name}`} title="Run history" onClick={() => setHistory(r)}>
                                                <History className="h-4 w-4" />
                                            </Button>
                                            {canManage ? (
                                                <>
                                                    <Button size="icon" variant="ghost" aria-label={`Open a ticket now for ${r.name}`} title="Run now: open a ticket now as an extra" disabled={busy === r.id + "run"} onClick={() => void act(r, "run")}>
                                                        <Zap className="h-4 w-4" />
                                                    </Button>
                                                    {r.enabled ? (
                                                        <Button size="icon" variant="ghost" aria-label={`Pause ${r.name}`} title="Pause" disabled={busy === r.id + "pause"} onClick={() => void act(r, "pause")}>
                                                            <Pause className="h-4 w-4" />
                                                        </Button>
                                                    ) : (
                                                        <Button size="icon" variant="ghost" aria-label={`Resume ${r.name}`} title={r.finished ? "It has reached its end date: change the end date to resume" : "Resume"} disabled={r.finished || busy === r.id + "resume"} onClick={() => void act(r, "resume")}>
                                                            <Play className="h-4 w-4" />
                                                        </Button>
                                                    )}
                                                    <Button size="icon" variant="ghost" aria-label={`Edit ${r.name}`} onClick={() => setEditing(r)}>
                                                        <Pencil className="h-4 w-4" />
                                                    </Button>
                                                    <Button size="icon" variant="ghost" aria-label={`Delete ${r.name}`} onClick={() => void remove(r)}>
                                                        <Trash2 className="h-4 w-4" />
                                                    </Button>
                                                </>
                                            ) : null}
                                        </div>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            <RecurringDialog editing={editing} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await load(); }} push={push} />
            <HistoryDialog item={history} onClose={() => setHistory(null)} />
        </div>
    );
}

/* ------------------------------ history ------------------------------ */

function HistoryDialog({ item, onClose }: { item: Recurring | null; onClose: () => void }) {
    const [runs, setRuns] = React.useState<Run[] | null>(null);
    React.useEffect(() => {
        setRuns(null);
        if (!item) return;
        jfetch<{ items: Run[] }>(`/api/recurring-tickets/${item.id}/runs`)
            .then((r) => setRuns(r.items))
            .catch(() => setRuns([]));
    }, [item]);
    return (
        <Dialog open={!!item} onOpenChange={(o) => { if (!o) onClose(); }}>
            <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
                <DialogHeader>
                    <DialogTitle>Run history{item ? `: ${item.name}` : ""}</DialogTitle>
                    <DialogDescription>Every time the schedule ran: the ticket it opened, or why it did not.</DialogDescription>
                </DialogHeader>
                {runs === null ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
                {runs && runs.length === 0 ? <p className="text-sm text-muted-foreground">It has not run yet.</p> : null}
                {runs && runs.length > 0 ? (
                    <table className="w-full text-sm">
                        <thead className="border-b text-left text-xs text-muted-foreground">
                            <tr>
                                <th className="p-2 font-medium">When</th>
                                <th className="p-2 font-medium">Result</th>
                                <th className="p-2 font-medium">Ticket or reason</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y">
                            {runs.map((r) => (
                                <tr key={r.id}>
                                    <td className="p-2 align-top">
                                        <div>{when(r.at, item?.timezone)}</div>
                                        <div className="text-xs text-muted-foreground">{r.trigger === "manual" ? "Run now" : "On schedule"}</div>
                                    </td>
                                    <td className="p-2 align-top"><Badge status={r.status} /></td>
                                    <td className="p-2 align-top">
                                        {r.ticket ? (
                                            <Link href={`/tickets/${r.ticket.id}`} className="text-primary hover:underline">
                                                #{r.ticket.number} {r.ticket.title}
                                            </Link>
                                        ) : null}
                                        {r.ticket ? <span className="ml-2 text-xs capitalize text-muted-foreground">{r.ticket.status.replace("_", " ")}</span> : null}
                                        {r.error ? <div className={r.status === "failed" ? "text-destructive" : "text-muted-foreground"}>{r.error}</div> : null}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                ) : null}
                <DialogFooter>
                    <Button variant="outline" onClick={onClose}>Close</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

/* ------------------------------ editing ------------------------------ */

type Form = {
    name: string;
    templateId: string;
    subject: string;
    description: string;
    priority: string;
    clientId: string;
    siteId: string;
    device: { id: string; name: string } | null;
    assigneeUserId: string;
    frequency: Recurring["frequency"];
    time: string;
    timezone: string;
    daysOfWeek: number[];
    dayOfMonth: number;
    monthOfYear: number;
    startDate: string;
    endDate: string;
    skipIfOpen: boolean;
};

const blank = (templateId = ""): Form => ({
    name: "", templateId, subject: "", description: "", priority: "", clientId: "", siteId: "", device: null, assigneeUserId: "",
    frequency: "monthly", time: "08:00", timezone: browserZone(), daysOfWeek: [1], dayOfMonth: 1, monthOfYear: 1, startDate: "", endDate: "", skipIfOpen: true,
});

const fromRecurring = (r: Recurring): Form => ({
    name: r.name, templateId: r.templateId ?? "", subject: r.subject ?? "", description: r.description ?? "", priority: r.priority ?? "", clientId: r.clientId, siteId: r.siteId ?? "",
    device: r.deviceId ? { id: r.deviceId, name: r.deviceName ?? r.deviceId } : null, assigneeUserId: r.assigneeUserId ?? "", frequency: r.frequency, time: r.time, timezone: r.timezone,
    daysOfWeek: r.daysOfWeek.length ? r.daysOfWeek : [1], dayOfMonth: r.dayOfMonth ?? 1, monthOfYear: r.monthOfYear ?? 1, startDate: r.startDate ?? "", endDate: r.endDate ?? "", skipIfOpen: r.skipIfOpen,
});

function RecurringDialog({ editing, onClose, onSaved, push }: { editing: Recurring | { templateId?: string } | null; onClose: () => void; onSaved: () => Promise<void>; push: ToastFn }) {
    const existing = editing && "id" in editing ? editing : null;
    const [f, setF] = React.useState<Form>(blank());
    const [templates, setTemplates] = React.useState<TemplateOpt[]>([]);
    const [clients, setClients] = React.useState<CustomerClient[]>([]);
    const [sites, setSites] = React.useState<CustomerSite[]>([]);
    const [users, setUsers] = React.useState<UserOpt[]>([]);
    const [pickDevice, setPickDevice] = React.useState(false);
    const [preview, setPreview] = React.useState<{ schedule: string; runs: string[] } | null>(null);
    const [previewError, setPreviewError] = React.useState<string | null>(null);
    const [saving, setSaving] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const [tried, setTried] = React.useState(false);

    React.useEffect(() => {
        if (!editing) return;
        setTried(false);
        setError(null);
        setPickDevice(false);
        setF(existing ? fromRecurring(existing) : blank((editing as { templateId?: string }).templateId ?? ""));
    }, [editing, existing]);

    React.useEffect(() => {
        if (!editing) return;
        jfetch<{ items: TemplateOpt[] }>("/api/ticket-templates").then((r) => setTemplates(r.items)).catch(() => setTemplates([]));
        fetchCustomers().then((c) => setClients([...c].sort((a, b) => a.name.localeCompare(b.name)))).catch(() => setClients([]));
        jfetch<any>("/api/users")
            .then((r) => {
                const arr: any[] = Array.isArray(r) ? r : Array.isArray(r?.items) ? r.items : [];
                setUsers(arr.map((u) => ({ id: String(u.id), label: String(u.name || u.email || u.id) })).filter((u) => u.id));
            })
            .catch(() => setUsers([]));
    }, [editing]);

    React.useEffect(() => {
        setSites([]);
        if (!f.clientId) return;
        fetchCustomerSites(f.clientId).then((s) => setSites(s ?? [])).catch(() => setSites([]));
    }, [f.clientId]);

    // The next times, from the server's own arithmetic, so what is shown is what will happen.
    React.useEffect(() => {
        if (!editing) return;
        const id = setTimeout(() => {
            jfetch<{ schedule: string; runs: string[] }>("/api/recurring-tickets/preview", {
                method: "POST",
                body: { frequency: f.frequency, time: f.time, timezone: f.timezone, daysOfWeek: f.daysOfWeek, dayOfMonth: f.dayOfMonth, monthOfYear: f.monthOfYear, startDate: f.startDate || null, endDate: f.endDate || null },
            })
                .then((r) => { setPreview(r); setPreviewError(null); })
                .catch((e) => { setPreview(null); setPreviewError(messageOf(e)); });
        }, 250);
        return () => clearTimeout(id);
    }, [editing, f.frequency, f.time, f.timezone, f.daysOfWeek, f.dayOfMonth, f.monthOfYear, f.startDate, f.endDate]);

    const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((cur) => ({ ...cur, [k]: v }));
    const nameOk = f.name.trim().length > 0;
    const sourceOk = !!f.templateId || f.subject.trim().length > 0;
    const clientOk = !!f.clientId;

    async function save() {
        setTried(true);
        setError(null);
        if (!nameOk || !sourceOk || !clientOk) return;
        setSaving(true);
        try {
            const body = {
                name: f.name, templateId: f.templateId || null, subject: f.subject, description: f.description, priority: f.priority || null,
                clientId: f.clientId, siteId: f.siteId || null, deviceId: f.device?.id ?? null, assigneeUserId: f.assigneeUserId || null,
                frequency: f.frequency, time: f.time, timezone: f.timezone, daysOfWeek: f.daysOfWeek, dayOfMonth: f.dayOfMonth, monthOfYear: f.monthOfYear,
                startDate: f.startDate || null, endDate: f.endDate || null, skipIfOpen: f.skipIfOpen,
            };
            if (existing) await jfetch(`/api/recurring-tickets/${existing.id}`, { method: "PATCH", body });
            else await jfetch("/api/recurring-tickets", { method: "POST", body });
            push({ title: existing ? "Saved" : "Recurring ticket added", desc: f.name, kind: "success" });
            await onSaved();
        } catch (e) {
            setError(messageOf(e));
        } finally {
            setSaving(false);
        }
    }

    const toggleDay = (d: number) => set("daysOfWeek", f.daysOfWeek.includes(d) ? f.daysOfWeek.filter((x) => x !== d) : [...f.daysOfWeek, d].sort());
    const selectCls = "h-9 rounded-md border bg-background px-2 text-sm";
    const tz = React.useMemo(zones, []);

    return (
        <Dialog open={!!editing} onOpenChange={(o) => { if (!o) onClose(); }}>
            <DialogContent className="max-h-[92vh] max-w-2xl overflow-y-auto">
                <DialogHeader>
                    <DialogTitle>{existing ? "Edit recurring ticket" : "New recurring ticket"}</DialogTitle>
                    <DialogDescription>A ticket is opened from the template at the times below. Saving does not open one now.</DialogDescription>
                </DialogHeader>
                <div className="grid gap-3">
                    <div className="grid gap-1">
                        <Label htmlFor="rt-name" className={tried && !nameOk ? "text-destructive" : ""}>Name</Label>
                        <Input id="rt-name" value={f.name} maxLength={120} onChange={(e) => set("name", e.target.value)} placeholder="For example: Monthly patch review" autoFocus />
                    </div>

                    <fieldset className="grid gap-2 rounded-md border p-3">
                        <legend className="px-1 text-sm font-medium">The ticket</legend>
                        <div className="grid gap-1">
                            <Label htmlFor="rt-template" className={tried && !sourceOk ? "text-destructive" : ""}>Ticket template</Label>
                            <select id="rt-template" value={f.templateId} onChange={(e) => set("templateId", e.target.value)} className="h-10 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                                <option value="">No template (give a subject below)</option>
                                {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                            </select>
                        </div>
                        <div className="grid gap-1">
                            <Label htmlFor="rt-subject">Subject <span className="font-normal text-muted-foreground">(optional with a template)</span></Label>
                            <Input id="rt-subject" value={f.subject} maxLength={300} onChange={(e) => set("subject", e.target.value)} placeholder="Taken from the template" />
                            <p className="text-xs text-muted-foreground">You can use {"{{date}}"}, {"{{month}}"}, {"{{year}}"}, {"{{customer}}"} and {"{{site}}"}.</p>
                        </div>
                        <div className="grid gap-1">
                            <Label htmlFor="rt-desc">Description <span className="font-normal text-muted-foreground">(optional)</span></Label>
                            <Textarea id="rt-desc" rows={3} value={f.description} onChange={(e) => set("description", e.target.value)} placeholder="Taken from the template" />
                        </div>
                        <div className="grid gap-3 sm:grid-cols-2">
                            <div className="grid gap-1">
                                <Label htmlFor="rt-priority">Priority</Label>
                                <select id="rt-priority" value={f.priority} onChange={(e) => set("priority", e.target.value)} className="h-10 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                                    <option value="">From the template</option>
                                    {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
                                </select>
                            </div>
                            <div className="grid gap-1">
                                <Label htmlFor="rt-assignee">Assign to</Label>
                                <select id="rt-assignee" value={f.assigneeUserId} onChange={(e) => set("assigneeUserId", e.target.value)} className="h-10 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                                    <option value="">Nobody</option>
                                    {users.map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}
                                </select>
                            </div>
                        </div>
                    </fieldset>

                    <fieldset className="grid gap-2 rounded-md border p-3">
                        <legend className="px-1 text-sm font-medium">For</legend>
                        <div className="grid gap-3 sm:grid-cols-2">
                            <div className="grid gap-1">
                                <Label htmlFor="rt-client" className={tried && !clientOk ? "text-destructive" : ""}>Customer</Label>
                                <select id="rt-client" value={f.clientId} onChange={(e) => setF((cur) => ({ ...cur, clientId: e.target.value, siteId: "", device: null }))} className="h-10 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                                    <option value="">Choose a customer</option>
                                    {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                                </select>
                            </div>
                            <div className="grid gap-1">
                                <Label htmlFor="rt-site">Site <span className="font-normal text-muted-foreground">(optional)</span></Label>
                                <select id="rt-site" value={f.siteId} disabled={!f.clientId} onChange={(e) => set("siteId", e.target.value)} className="h-10 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                                    <option value="">Any</option>
                                    {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                                </select>
                            </div>
                        </div>
                        <div className="grid gap-1">
                            <span className="text-sm font-medium">Device <span className="font-normal text-muted-foreground">(optional)</span></span>
                            {f.device ? (
                                <div className="flex items-center justify-between gap-2 rounded-md border px-3 py-1.5 text-sm">
                                    <span className="truncate font-medium">{f.device.name}</span>
                                    <button type="button" className="text-xs text-muted-foreground hover:text-foreground hover:underline" onClick={() => set("device", null)}>Remove</button>
                                </div>
                            ) : pickDevice && f.clientId ? (
                                <div className="rounded-md border p-2">
                                    <DeviceSearchPicker clientId={f.clientId} idPrefix="rt-device" autoFocus onPick={(d) => { setF((cur) => ({ ...cur, device: { id: d.id, name: d.hostname } })); setPickDevice(false); }} />
                                    <div className="mt-2 flex justify-end"><Button type="button" variant="ghost" size="sm" onClick={() => setPickDevice(false)}>Cancel</Button></div>
                                </div>
                            ) : (
                                <div>
                                    <Button type="button" variant="outline" size="sm" disabled={!f.clientId} onClick={() => setPickDevice(true)}>Choose a device</Button>
                                    {!f.clientId ? <span className="ml-2 text-xs text-muted-foreground">Choose the customer first.</span> : null}
                                </div>
                            )}
                        </div>
                    </fieldset>

                    <fieldset className="grid gap-3 rounded-md border p-3">
                        <legend className="px-1 text-sm font-medium">When</legend>
                        <div className="flex flex-wrap items-end gap-3">
                            <div className="grid gap-1">
                                <Label htmlFor="rt-freq">Repeats</Label>
                                <select id="rt-freq" value={f.frequency} onChange={(e) => set("frequency", e.target.value as Form["frequency"])} className="h-10 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                                    <option value="daily">Every day</option>
                                    <option value="weekly">Every week</option>
                                    <option value="monthly">Every month</option>
                                    <option value="yearly">Every year</option>
                                </select>
                            </div>
                            <div className="grid gap-1">
                                <Label htmlFor="rt-time">At</Label>
                                <Input id="rt-time" type="time" value={f.time} onChange={(e) => set("time", e.target.value)} className="h-9 w-32" />
                            </div>
                            <div className="grid min-w-[12rem] flex-1 gap-1">
                                <Label htmlFor="rt-zone">Time zone</Label>
                                <Input id="rt-zone" list="rt-zones" value={f.timezone} onChange={(e) => set("timezone", e.target.value)} className="h-9" />
                                <datalist id="rt-zones">{tz.map((z) => <option key={z} value={z} />)}</datalist>
                            </div>
                        </div>
                        {f.frequency === "weekly" ? (
                            <div role="group" aria-label="Days of the week" className="flex flex-wrap gap-1.5">
                                {DAYS.map((d, i) => (
                                    <button key={d} type="button" aria-pressed={f.daysOfWeek.includes(i)} onClick={() => toggleDay(i)} className={`rounded-md border px-3 py-1 text-sm ${f.daysOfWeek.includes(i) ? "bg-primary text-primary-foreground" : "bg-background"}`}>
                                        {d}
                                    </button>
                                ))}
                            </div>
                        ) : null}
                        {f.frequency === "monthly" || f.frequency === "yearly" ? (
                            <div className="flex flex-wrap items-end gap-3">
                                {f.frequency === "yearly" ? (
                                    <div className="grid gap-1">
                                        <Label htmlFor="rt-month">Month</Label>
                                        <select id="rt-month" value={f.monthOfYear} onChange={(e) => set("monthOfYear", Number(e.target.value))} className="h-10 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                                            {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
                                        </select>
                                    </div>
                                ) : null}
                                <div className="grid gap-1">
                                    <Label htmlFor="rt-dom">Day of the month</Label>
                                    <select id="rt-dom" value={f.dayOfMonth} onChange={(e) => set("dayOfMonth", Number(e.target.value))} className="h-10 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                                        {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>{d}</option>)}
                                        <option value={-1}>Last day</option>
                                    </select>
                                </div>
                                <p className="pb-2 text-xs text-muted-foreground">In a shorter month a late day falls on its last day.</p>
                            </div>
                        ) : null}
                        <div className="grid gap-3 sm:grid-cols-2">
                            <div className="grid gap-1">
                                <Label htmlFor="rt-start">Start date <span className="font-normal text-muted-foreground">(optional)</span></Label>
                                <Input id="rt-start" type="date" value={f.startDate} onChange={(e) => set("startDate", e.target.value)} className="h-9" />
                            </div>
                            <div className="grid gap-1">
                                <Label htmlFor="rt-end">End date <span className="font-normal text-muted-foreground">(optional)</span></Label>
                                <Input id="rt-end" type="date" value={f.endDate} onChange={(e) => set("endDate", e.target.value)} className="h-9" />
                            </div>
                        </div>
                        <label className="flex items-start gap-2 text-sm">
                            <input type="checkbox" checked={f.skipIfOpen} onChange={(e) => set("skipIfOpen", e.target.checked)} className="h-4 w-4 shrink-0 rounded border-input accent-primary" />
                            <span>Skip it if the previous ticket from this schedule is still open<span className="block text-xs text-muted-foreground">So tickets do not pile up when nobody has closed the last one.</span></span>
                        </label>
                        <div aria-live="polite" className="rounded-md bg-muted/40 p-3 text-sm">
                            {previewError ? <span className="text-destructive">{previewError}</span> : preview ? (
                                <>
                                    <div className="font-medium">{preview.schedule}</div>
                                    {preview.runs.length ? (
                                        <ul className="mt-1 text-xs text-muted-foreground">
                                            {preview.runs.map((r) => <li key={r}>{when(r, f.timezone)}</li>)}
                                        </ul>
                                    ) : <div className="text-xs text-muted-foreground">It never runs with these dates.</div>}
                                </>
                            ) : <span className="text-muted-foreground">Working out the next times…</span>}
                        </div>
                    </fieldset>
                    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
                </div>
                <DialogFooter>
                    <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
                    <Button onClick={() => void save()} disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
