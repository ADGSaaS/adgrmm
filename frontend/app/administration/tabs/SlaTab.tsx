"use client";

// SLAs: how fast tickets should be answered and resolved, by priority; the working hours those times count in; which
// customers have a policy of their own; and who is told, and what happens, when a ticket nears or passes its limit.
import * as React from "react";
import { CalendarClock, Pencil, Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { jfetch } from "@/lib/api";
import { PRIORITIES, errorText, minutesLabel, type Priority } from "@/lib/service-desk";
import type { ToastFn } from "../types";

type Targets = Record<Priority, { response: number | null; resolution: number | null }>;
type Side = { users: string[]; groups: string[]; notifyAssignee: boolean; email: boolean };
type Escalation = { warning: Side; breach: Side & { raisePriority: boolean; reassignUserId: string | null; moveToQueueId: string | null } };
type Policy = {
    id: string; name: string; description: string; calendarId: string | null; calendarName: string | null; isDefault: boolean; enabled: boolean;
    targets: Targets; pauseStatuses: string[]; warnPercent: number; escalation: Escalation; customers: number;
};
type Calendar = { id: string; name: string; timezone: string; days: number[]; start: string; end: string; holidays: { date: string; name: string }[]; policies: number };
type ClientPolicy = { clientId: string; clientName: string; policyId: string; policyName: string };
type Option = { id: string; name: string };

const DAYS = [
    [1, "Mon"], [2, "Tue"], [3, "Wed"], [4, "Thu"], [5, "Fri"], [6, "Sat"], [0, "Sun"],
] as const;
const dayNames = (d: number[]) => {
    const set = new Set(d);
    if (set.size === 7) return "Every day";
    if ([1, 2, 3, 4, 5].every((x) => set.has(x)) && set.size === 5) return "Mon to Fri";
    return DAYS.filter(([n]) => set.has(n)).map(([, l]) => l).join(", ");
};

const emptyTargets = (): Targets => ({
    low: { response: 480, resolution: 4320 },
    medium: { response: 240, resolution: 1440 },
    high: { response: 60, resolution: 480 },
    urgent: { response: 15, resolution: 120 },
});
const emptyEscalation = (): Escalation => ({
    warning: { users: [], groups: [], notifyAssignee: false, email: false },
    breach: { users: [], groups: [], notifyAssignee: true, email: false, raisePriority: false, reassignUserId: null, moveToQueueId: null },
});

/** A length of time typed as a number and a unit, kept as minutes. Empty means no target. */
function DurationInput({ id, label, value, onChange }: { id: string; label: string; value: number | null; onChange: (v: number | null) => void }) {
    const initialUnit = value && value % 1440 === 0 ? 1440 : value && value % 60 === 0 ? 60 : 1;
    const [unit, setUnit] = React.useState(initialUnit);
    const [text, setText] = React.useState(value ? String(value / initialUnit) : "");
    const last = React.useRef(value);
    React.useEffect(() => {
        // Set from outside (a different policy opened): show it in the natural unit.
        if (value !== last.current) {
            const u = value && value % 1440 === 0 ? 1440 : value && value % 60 === 0 ? 60 : 1;
            setUnit(u);
            setText(value ? String(value / u) : "");
            last.current = value;
        }
    }, [value]);
    function emit(t: string, u: number) {
        setText(t);
        const n = Number(t);
        const next = t.trim() === "" ? null : Number.isFinite(n) && n > 0 ? Math.round(n * u) : null;
        last.current = next;
        onChange(next);
    }
    return (
        <div className="flex gap-1">
            <Input id={id} aria-label={label} inputMode="decimal" className="h-9 w-20" value={text} placeholder="none" onChange={(e) => emit(e.target.value, unit)} />
            <select aria-label={`${label} unit`} className="h-10 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" value={unit} onChange={(e) => { const u = Number(e.target.value); setUnit(u); emit(text, u); }}>
                <option value={1}>min</option>
                <option value={60}>hours</option>
                <option value={1440}>days</option>
            </select>
        </div>
    );
}

/** People or groups picked from a list: chips, and a box to add more. */
function Picker({ label, options, value, onChange, empty }: { label: string; options: Option[]; value: string[]; onChange: (v: string[]) => void; empty: string }) {
    const name = (id: string) => options.find((o) => o.id === id)?.name ?? "Unknown";
    const left = options.filter((o) => !value.includes(o.id));
    return (
        <div className="grid gap-1">
            <Label className="text-xs">{label}</Label>
            <div className="flex flex-wrap items-center gap-1.5">
                {value.map((id) => (
                    <span key={id} className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs">
                        {name(id)}
                        <button type="button" aria-label={`Remove ${name(id)}`} onClick={() => onChange(value.filter((x) => x !== id))}><X className="h-3 w-3" /></button>
                    </span>
                ))}
                <select aria-label={`Add to: ${label}`} value="" onChange={(e) => e.target.value && onChange([...value, e.target.value])} className="h-10 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    <option value="">{left.length ? "Add…" : empty}</option>
                    {left.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
            </div>
        </div>
    );
}

export default function SlaTab({ push }: { push: ToastFn }) {
    const [policies, setPolicies] = React.useState<Policy[] | null>(null);
    const [calendars, setCalendars] = React.useState<Calendar[]>([]);
    const [mine, setMine] = React.useState<ClientPolicy[]>([]);
    const [people, setPeople] = React.useState<Option[]>([]);
    const [groups, setGroups] = React.useState<Option[]>([]);
    const [customers, setCustomers] = React.useState<Option[]>([]);
    const [queues, setQueues] = React.useState<Option[]>([]);
    const [editingPolicy, setEditingPolicy] = React.useState<Policy | "new" | null>(null);
    const [editingCal, setEditingCal] = React.useState<Calendar | "new" | null>(null);
    const [busy, setBusy] = React.useState(false);
    const [pickClient, setPickClient] = React.useState("");
    const [pickPolicy, setPickPolicy] = React.useState("");

    const load = React.useCallback(async () => {
        try {
            const [p, c, m] = await Promise.all([
                jfetch<{ items: Policy[] }>("/api/sla/policies"),
                jfetch<{ items: Calendar[] }>("/api/sla/calendars"),
                jfetch<{ items: ClientPolicy[] }>("/api/sla/clients"),
            ]);
            setPolicies(p.items);
            setCalendars(c.items);
            setMine(m.items);
        } catch (e) {
            setPolicies([]);
            push({ title: "Could not load the SLA settings", desc: errorText(e), kind: "destructive" });
        }
    }, [push]);

    React.useEffect(() => { void load(); }, [load]);
    React.useEffect(() => {
        // Lists for the pickers. A person without the right to see one simply gets an empty list.
        jfetch<any>("/api/users").then((r) => setPeople((Array.isArray(r) ? r : r?.items ?? []).map((u: any) => ({ id: String(u.id), name: String(u.name || u.email || u.id) })))).catch(() => setPeople([]));
        jfetch<any[]>("/api/admin/groups").then((r) => setGroups((r ?? []).map((g: any) => ({ id: String(g.id), name: String(g.name) })))).catch(() => setGroups([]));
        jfetch<any[]>("/api/customers").then((r) => setCustomers((Array.isArray(r) ? r : []).filter((c) => c?.key && c?.name).map((c) => ({ id: String(c.key), name: String(c.name) })).sort((a, b) => a.name.localeCompare(b.name)))).catch(() => setCustomers([]));
        jfetch<{ items: Option[] }>("/api/ticket-queues").then((r) => setQueues(r.items.map((q) => ({ id: q.id, name: q.name })))).catch(() => setQueues([]));
    }, []);

    if (!policies) return <div className="p-4 text-sm text-muted-foreground">Loading…</div>;

    async function run<T>(fn: () => Promise<T>, ok: string, failed: string) {
        setBusy(true);
        try {
            await fn();
            push({ title: ok, kind: "success" });
            await load();
        } catch (e) {
            push({ title: failed, desc: errorText(e), kind: "destructive" });
        } finally {
            setBusy(false);
        }
    }

    const targetsText = (t: Targets) => PRIORITIES.map((p) => `${p[0].toUpperCase()}${p.slice(1)}: ${minutesLabel(t[p].response)} / ${minutesLabel(t[p].resolution)}`).join("  ·  ");

    return (
        <div className="grid w-full min-w-0 gap-6">
            <div>
                <h2 className="flex items-center gap-2 text-xl font-semibold tracking-tight"><CalendarClock className="h-5 w-5" aria-hidden /> SLAs</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                    A policy sets how soon a ticket should get its first reply and how soon it should be resolved, for each priority. Each ticket gets the policy of its customer if the customer has one of its own,
                    otherwise the policy of its queue, otherwise the default policy. The clocks run in the policy&apos;s working hours, stop while a ticket is waiting on the customer, and show on the ticket list and the ticket page.
                    A warning and a breach are recorded once each and can tell people, raise the priority, reassign the ticket or move it to another queue. The client portal never shows any of this.
                </p>
            </div>

            <section className="grid gap-3 rounded-xl border border-border/70 bg-card p-5 shadow-sm" aria-labelledby="sla-policies">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 id="sla-policies" className="text-base font-semibold">Policies</h3>
                    <div className="flex gap-2">
                        <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(async () => { const r = await jfetch<{ warnings: number; breaches: number }>("/api/sla/run", { method: "POST" }); push({ title: `Checked now: ${r.warnings} warning${r.warnings === 1 ? "" : "s"}, ${r.breaches} breach${r.breaches === 1 ? "" : "es"}`, kind: "default" }); }, "SLA check done", "The check failed")}>Check now</Button>
                        <Button size="sm" onClick={() => setEditingPolicy("new")}><Plus className="mr-1.5 h-4 w-4" aria-hidden /> New policy</Button>
                    </div>
                </div>
                {policies.length === 0 ? (
                    <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">No SLA policies yet. Tickets have no clocks until there is a default policy.</p>
                ) : (
                    <div className="overflow-x-auto rounded-lg border">
                        <table className="w-full min-w-[720px] text-sm">
                            <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                                <tr><th className="p-2 font-medium">Policy</th><th className="p-2 font-medium">First reply / resolution by priority</th><th className="p-2 font-medium">Hours</th><th className="p-2 font-medium">Warn at</th><th className="p-2" /></tr>
                            </thead>
                            <tbody className="divide-y">
                                {policies.map((p) => (
                                    <tr key={p.id} className={p.enabled ? "" : "opacity-60"}>
                                        <td className="p-2 align-top">
                                            <div className="font-medium">{p.name} {p.isDefault ? <span className="ml-1 rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-medium text-primary">Default</span> : null}{!p.enabled ? <span className="ml-1 rounded-full bg-muted px-2 py-0.5 text-[11px]">Off</span> : null}</div>
                                            {p.description ? <div className="text-xs text-muted-foreground">{p.description}</div> : null}
                                            {p.customers > 0 ? <div className="text-xs text-muted-foreground">{p.customers} customer{p.customers === 1 ? "" : "s"} with this policy</div> : null}
                                        </td>
                                        <td className="p-2 align-top text-xs text-muted-foreground">{targetsText(p.targets)}</td>
                                        <td className="p-2 align-top">{p.calendarName ?? "Around the clock"}</td>
                                        <td className="p-2 align-top">{p.warnPercent}%</td>
                                        <td className="p-2 align-top">
                                            <div className="flex justify-end gap-1">
                                                {!p.isDefault && p.enabled ? <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(() => jfetch(`/api/sla/policies/${p.id}`, { method: "PATCH", body: { isDefault: true } }), "Default policy changed", "Could not change the default")}>Make default</Button> : null}
                                                <Button size="icon" variant="ghost" aria-label={`Edit ${p.name}`} onClick={() => setEditingPolicy(p)}><Pencil className="h-4 w-4" /></Button>
                                                <Button size="icon" variant="ghost" aria-label={`Delete ${p.name}`} disabled={busy} onClick={() => { if (window.confirm(`Delete the policy "${p.name}"? Customers and queues that use it fall back to the default policy.`)) void run(() => jfetch(`/api/sla/policies/${p.id}`, { method: "DELETE" }), "Policy deleted", "Could not delete the policy"); }}><Trash2 className="h-4 w-4" /></Button>
                                            </div>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </section>

            <section className="grid gap-3 rounded-xl border border-border/70 bg-card p-5 shadow-sm" aria-labelledby="sla-calendars">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 id="sla-calendars" className="text-base font-semibold">Working hours</h3>
                    <Button size="sm" variant="outline" onClick={() => setEditingCal("new")}><Plus className="mr-1.5 h-4 w-4" aria-hidden /> New calendar</Button>
                </div>
                <p className="text-sm text-muted-foreground">Time only counts toward a target inside these hours. A policy with no calendar counts every hour of every day.</p>
                {calendars.length === 0 ? (
                    <p className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">No calendars yet.</p>
                ) : (
                    <ul className="divide-y rounded-lg border text-sm">
                        {calendars.map((c) => (
                            <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
                                <div>
                                    <div className="font-medium">{c.name}</div>
                                    <div className="text-xs text-muted-foreground">{dayNames(c.days)}, {c.start} to {c.end}, {c.timezone}{c.holidays.length ? `, ${c.holidays.length} holiday${c.holidays.length === 1 ? "" : "s"}` : ""} · used by {c.policies} {c.policies === 1 ? "policy" : "policies"}</div>
                                </div>
                                <div className="flex gap-1">
                                    <Button size="icon" variant="ghost" aria-label={`Edit ${c.name}`} onClick={() => setEditingCal(c)}><Pencil className="h-4 w-4" /></Button>
                                    <Button size="icon" variant="ghost" aria-label={`Delete ${c.name}`} disabled={busy || c.policies > 0} title={c.policies > 0 ? "Policies use this calendar" : undefined} onClick={() => { if (window.confirm(`Delete the calendar "${c.name}"?`)) void run(() => jfetch(`/api/sla/calendars/${c.id}`, { method: "DELETE" }), "Calendar deleted", "Could not delete the calendar"); }}><Trash2 className="h-4 w-4" /></Button>
                                </div>
                            </li>
                        ))}
                    </ul>
                )}
            </section>

            <section className="grid gap-3 rounded-xl border border-border/70 bg-card p-5 shadow-sm" aria-labelledby="sla-customers">
                <h3 id="sla-customers" className="text-base font-semibold">Customers with their own policy</h3>
                <p className="text-sm text-muted-foreground">A customer listed here is held to this policy instead of the queue&apos;s or the default one. Contract-based policies are not available yet: there are no contracts in RemoteIQ to attach them to.</p>
                <div className="flex flex-wrap items-end gap-2">
                    <div className="grid gap-1">
                        <Label htmlFor="sla-client" className="text-xs">Customer</Label>
                        <select id="sla-client" value={pickClient} onChange={(e) => setPickClient(e.target.value)} className="h-10 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                            <option value="">Choose a customer…</option>
                            {customers.filter((c) => !mine.some((m) => m.clientId === c.id)).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                        </select>
                    </div>
                    <div className="grid gap-1">
                        <Label htmlFor="sla-client-policy" className="text-xs">Policy</Label>
                        <select id="sla-client-policy" value={pickPolicy} onChange={(e) => setPickPolicy(e.target.value)} className="h-10 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                            <option value="">Choose a policy…</option>
                            {policies.filter((p) => p.enabled).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                        </select>
                    </div>
                    <Button size="sm" disabled={busy || !pickClient || !pickPolicy} onClick={() => void run(async () => { await jfetch(`/api/sla/clients/${pickClient}`, { method: "PUT", body: { policyId: pickPolicy } }); setPickClient(""); }, "Customer policy saved", "Could not save")}>Assign</Button>
                </div>
                {mine.length > 0 ? (
                    <ul className="divide-y rounded-lg border text-sm">
                        {mine.map((m) => (
                            <li key={m.clientId} className="flex items-center justify-between gap-2 p-2.5">
                                <span><span className="font-medium">{m.clientName}</span> <span className="text-muted-foreground">uses</span> {m.policyName}</span>
                                <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(() => jfetch(`/api/sla/clients/${m.clientId}`, { method: "PUT", body: { policyId: null } }), "Back on the default policy", "Could not remove")}>Use the default</Button>
                            </li>
                        ))}
                    </ul>
                ) : null}
            </section>

            <PolicyDialog editing={editingPolicy} calendars={calendars} people={people} groups={groups} queues={queues} onClose={() => setEditingPolicy(null)} onSaved={async () => { setEditingPolicy(null); await load(); }} push={push} />
            <CalendarDialog editing={editingCal} onClose={() => setEditingCal(null)} onSaved={async () => { setEditingCal(null); await load(); }} push={push} />
        </div>
    );
}

function SideFields({ title, side, onChange, people, groups, breach }: { title: string; side: Side; onChange: (s: Side) => void; people: Option[]; groups: Option[]; breach?: React.ReactNode }) {
    return (
        <fieldset className="grid gap-2 rounded-lg border p-3">
            <legend className="px-1 text-sm font-medium">{title}</legend>
            <Picker label="Tell these people" options={people} value={side.users} onChange={(users) => onChange({ ...side, users })} empty="No people to add" />
            <Picker label="Tell these groups" options={groups} value={side.groups} onChange={(g) => onChange({ ...side, groups: g })} empty="No groups to add" />
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4 shrink-0 rounded border-input accent-primary" checked={side.notifyAssignee} onChange={(e) => onChange({ ...side, notifyAssignee: e.target.checked })} /> Tell the person the ticket is assigned to</label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4 shrink-0 rounded border-input accent-primary" checked={side.email} onChange={(e) => onChange({ ...side, email: e.target.checked })} /> Also send an email (they always get a notice on the Tickets screen)</label>
            {breach}
        </fieldset>
    );
}

function PolicyDialog({ editing, calendars, people, groups, queues, onClose, onSaved, push }: { editing: Policy | "new" | null; calendars: Calendar[]; people: Option[]; groups: Option[]; queues: Option[]; onClose: () => void; onSaved: () => Promise<void>; push: ToastFn }) {
    const isNew = editing === "new";
    const [name, setName] = React.useState("");
    const [description, setDescription] = React.useState("");
    const [calendarId, setCalendarId] = React.useState("");
    const [enabled, setEnabled] = React.useState(true);
    const [isDefault, setIsDefault] = React.useState(false);
    const [targets, setTargets] = React.useState<Targets>(emptyTargets());
    const [pausePending, setPausePending] = React.useState(true);
    const [pauseInProgress, setPauseInProgress] = React.useState(false);
    const [warn, setWarn] = React.useState("80");
    const [esc, setEsc] = React.useState<Escalation>(emptyEscalation());
    const [saving, setSaving] = React.useState(false);
    const [tried, setTried] = React.useState(false);

    React.useEffect(() => {
        if (!editing) return;
        setTried(false);
        if (editing === "new") {
            setName(""); setDescription(""); setCalendarId(""); setEnabled(true); setIsDefault(false); setTargets(emptyTargets()); setPausePending(true); setPauseInProgress(false); setWarn("80"); setEsc(emptyEscalation());
        } else {
            setName(editing.name); setDescription(editing.description); setCalendarId(editing.calendarId ?? ""); setEnabled(editing.enabled); setIsDefault(editing.isDefault);
            setTargets(JSON.parse(JSON.stringify(editing.targets))); setPausePending(editing.pauseStatuses.includes("pending")); setPauseInProgress(editing.pauseStatuses.includes("in_progress"));
            setWarn(String(editing.warnPercent)); setEsc(JSON.parse(JSON.stringify(editing.escalation)));
        }
    }, [editing]);

    const nameOk = name.trim().length > 0;
    const warnNum = Number(warn);
    const warnOk = Number.isInteger(warnNum) && warnNum >= 1 && warnNum <= 99;
    const anyTarget = PRIORITIES.some((p) => targets[p].response || targets[p].resolution);
    const orderProblem = PRIORITIES.find((p) => targets[p].response && targets[p].resolution && (targets[p].response as number) > (targets[p].resolution as number));

    async function save() {
        setTried(true);
        if (!nameOk || !warnOk || !anyTarget || orderProblem) return;
        setSaving(true);
        try {
            const body = {
                name, description, calendarId: calendarId || null, enabled, isDefault, targets, warnPercent: warnNum,
                pauseStatuses: [...(pausePending ? ["pending"] : []), ...(pauseInProgress ? ["in_progress"] : [])],
                escalation: esc,
            };
            if (isNew) await jfetch("/api/sla/policies", { method: "POST", body });
            else await jfetch(`/api/sla/policies/${(editing as Policy).id}`, { method: "PATCH", body });
            push({ title: isNew ? "Policy added" : "Policy saved", kind: "success" });
            await onSaved();
        } catch (e) {
            push({ title: "Could not save the policy", desc: errorText(e), kind: "destructive" });
        } finally {
            setSaving(false);
        }
    }

    return (
        <Dialog open={!!editing} onOpenChange={(o) => { if (!o) onClose(); }}>
            <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
                <DialogHeader>
                    <DialogTitle>{isNew ? "New SLA policy" : "Edit SLA policy"}</DialogTitle>
                    <DialogDescription>Changing a policy re-aims the clocks of the tickets still open.</DialogDescription>
                </DialogHeader>
                <div className="grid gap-4">
                    <div className="grid gap-3 sm:grid-cols-2">
                        <div className="grid gap-1">
                            <Label htmlFor="slp-name" className={tried && !nameOk ? "text-destructive" : ""}>Name</Label>
                            <Input id="slp-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} aria-invalid={tried && !nameOk} placeholder="For example: Standard support" autoFocus />
                        </div>
                        <div className="grid gap-1">
                            <Label htmlFor="slp-cal">Working hours</Label>
                            <select id="slp-cal" value={calendarId} onChange={(e) => setCalendarId(e.target.value)} className="h-10 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                                <option value="">Around the clock (24 hours, 7 days)</option>
                                {calendars.map((c) => <option key={c.id} value={c.id}>{c.name} ({dayNames(c.days)}, {c.start} to {c.end}, {c.timezone})</option>)}
                            </select>
                        </div>
                    </div>
                    <div className="grid gap-1">
                        <Label htmlFor="slp-desc">Description <span className="font-normal text-muted-foreground">(optional)</span></Label>
                        <Textarea id="slp-desc" rows={2} value={description} maxLength={300} onChange={(e) => setDescription(e.target.value)} />
                    </div>

                    <fieldset className="grid gap-2 rounded-lg border p-3">
                        <legend className="px-1 text-sm font-medium">Targets by priority</legend>
                        <p className="text-xs text-muted-foreground">How long, in working time, a ticket may wait for its first reply and for its resolution. Leave a box empty for no target.</p>
                        <div className="overflow-x-auto">
                            <table className="w-full min-w-[420px] text-sm">
                                <thead><tr className="text-left text-xs text-muted-foreground"><th className="py-1 pr-2 font-medium">Priority</th><th className="py-1 pr-2 font-medium">First reply within</th><th className="py-1 font-medium">Resolved within</th></tr></thead>
                                <tbody>
                                    {PRIORITIES.map((p) => (
                                        <tr key={p}>
                                            <td className="py-1 pr-2 capitalize">{p}</td>
                                            <td className="py-1 pr-2"><DurationInput id={`slp-${p}-r`} label={`${p} first reply`} value={targets[p].response} onChange={(v) => setTargets((t) => ({ ...t, [p]: { ...t[p], response: v } }))} /></td>
                                            <td className="py-1"><DurationInput id={`slp-${p}-s`} label={`${p} resolution`} value={targets[p].resolution} onChange={(v) => setTargets((t) => ({ ...t, [p]: { ...t[p], resolution: v } }))} /></td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                        {tried && !anyTarget ? <p role="alert" className="text-xs text-destructive">Set at least one target.</p> : null}
                        {tried && orderProblem ? <p role="alert" className="text-xs text-destructive">For {orderProblem} priority the first reply cannot take longer than the resolution.</p> : null}
                    </fieldset>

                    <div className="grid gap-3 sm:grid-cols-2">
                        <fieldset className="grid gap-1.5 rounded-lg border p-3">
                            <legend className="px-1 text-sm font-medium">Stop the clocks while the ticket is</legend>
                            <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4 shrink-0 rounded border-input accent-primary" checked={pausePending} onChange={(e) => setPausePending(e.target.checked)} /> Waiting on the customer</label>
                            <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4 shrink-0 rounded border-input accent-primary" checked={pauseInProgress} onChange={(e) => setPauseInProgress(e.target.checked)} /> In progress</label>
                        </fieldset>
                        <div className="grid content-start gap-1">
                            <Label htmlFor="slp-warn" className={tried && !warnOk ? "text-destructive" : ""}>Warn when this share of the time has passed</Label>
                            <div className="flex items-center gap-2"><Input id="slp-warn" className="w-20" inputMode="numeric" value={warn} onChange={(e) => setWarn(e.target.value)} aria-invalid={tried && !warnOk} /> <span className="text-sm">percent</span></div>
                            {tried && !warnOk ? <p role="alert" className="text-xs text-destructive">A whole number from 1 to 99.</p> : null}
                            <label className="mt-2 flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4 shrink-0 rounded border-input accent-primary" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> This policy is on</label>
                            <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4 shrink-0 rounded border-input accent-primary" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} /> The default policy (for tickets whose customer and queue have none)</label>
                        </div>
                    </div>

                    <SideFields title="When a ticket reaches the warning point" side={esc.warning} people={people} groups={groups} onChange={(s) => setEsc((e) => ({ ...e, warning: s }))} />
                    <SideFields
                        title="When a ticket breaches its time"
                        side={esc.breach}
                        people={people}
                        groups={groups}
                        onChange={(s) => setEsc((e) => ({ ...e, breach: { ...e.breach, ...s } }))}
                        breach={
                            <>
                                <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4 shrink-0 rounded border-input accent-primary" checked={esc.breach.raisePriority} onChange={(e) => setEsc((x) => ({ ...x, breach: { ...x.breach, raisePriority: e.target.checked } }))} /> Raise the priority one level</label>
                                <div className="grid gap-3 sm:grid-cols-2">
                                    <div className="grid gap-1">
                                        <Label htmlFor="slp-reassign" className="text-xs">Reassign to</Label>
                                        <select id="slp-reassign" value={esc.breach.reassignUserId ?? ""} onChange={(e) => setEsc((x) => ({ ...x, breach: { ...x.breach, reassignUserId: e.target.value || null } }))} className="h-10 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                                            <option value="">Leave with the same person</option>
                                            {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                                        </select>
                                    </div>
                                    <div className="grid gap-1">
                                        <Label htmlFor="slp-move" className="text-xs">Move to queue</Label>
                                        <select id="slp-move" value={esc.breach.moveToQueueId ?? ""} onChange={(e) => setEsc((x) => ({ ...x, breach: { ...x.breach, moveToQueueId: e.target.value || null } }))} className="h-10 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                                            <option value="">Leave in the same queue</option>
                                            {queues.map((q) => <option key={q.id} value={q.id}>{q.name}</option>)}
                                        </select>
                                    </div>
                                </div>
                            </>
                        }
                    />
                    <p className="text-xs text-muted-foreground">Webhooks can also be sent for these: turn on <b>Ticket SLA warning</b> and <b>Ticket SLA breached</b> under Integrations.</p>
                </div>
                <DialogFooter>
                    <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
                    <Button onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function CalendarDialog({ editing, onClose, onSaved, push }: { editing: Calendar | "new" | null; onClose: () => void; onSaved: () => Promise<void>; push: ToastFn }) {
    const isNew = editing === "new";
    const [name, setName] = React.useState("");
    const [timezone, setTimezone] = React.useState("UTC");
    const [days, setDays] = React.useState<number[]>([1, 2, 3, 4, 5]);
    const [start, setStart] = React.useState("09:00");
    const [end, setEnd] = React.useState("17:00");
    const [holidays, setHolidays] = React.useState<{ date: string; name: string }[]>([]);
    const [hDate, setHDate] = React.useState("");
    const [hName, setHName] = React.useState("");
    const [saving, setSaving] = React.useState(false);
    const [tried, setTried] = React.useState(false);
    const zones = React.useMemo(() => {
        try {
            return (Intl as any).supportedValuesOf("timeZone") as string[];
        } catch {
            return ["UTC", "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "Europe/London", "Europe/Berlin", "Asia/Tokyo", "Australia/Sydney"];
        }
    }, []);

    React.useEffect(() => {
        if (!editing) return;
        setTried(false); setHDate(""); setHName("");
        if (editing === "new") {
            setName(""); setDays([1, 2, 3, 4, 5]); setStart("09:00"); setEnd("17:00"); setHolidays([]);
            setTimezone((() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; } })());
        } else {
            setName(editing.name); setTimezone(editing.timezone); setDays(editing.days); setStart(editing.start); setEnd(editing.end); setHolidays(editing.holidays);
        }
    }, [editing]);

    const nameOk = name.trim().length > 0;
    const timesOk = start < end || (end === "24:00" && start !== "24:00");
    const daysOk = days.length > 0;

    async function fromReports() {
        try {
            const d = await jfetch<{ timezone: string; days: number[]; start: string; end: string }>("/api/sla/calendars/defaults");
            setTimezone(d.timezone); setDays(d.days); setStart(d.start); setEnd(d.end);
            push({ title: "Filled in from the business hours under Reports", kind: "default" });
        } catch (e) {
            push({ title: "Could not read the business hours", desc: errorText(e), kind: "destructive" });
        }
    }

    async function save() {
        setTried(true);
        if (!nameOk || !timesOk || !daysOk) return;
        setSaving(true);
        try {
            const body = { name, timezone, days, start, end, holidays };
            if (isNew) await jfetch("/api/sla/calendars", { method: "POST", body });
            else await jfetch(`/api/sla/calendars/${(editing as Calendar).id}`, { method: "PATCH", body });
            push({ title: isNew ? "Calendar added" : "Calendar saved", kind: "success" });
            await onSaved();
        } catch (e) {
            push({ title: "Could not save the calendar", desc: errorText(e), kind: "destructive" });
        } finally {
            setSaving(false);
        }
    }

    return (
        <Dialog open={!!editing} onOpenChange={(o) => { if (!o) onClose(); }}>
            <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
                <DialogHeader>
                    <DialogTitle>{isNew ? "New working hours calendar" : "Edit working hours calendar"}</DialogTitle>
                    <DialogDescription>Hours outside these, weekends and holidays do not count toward a target.</DialogDescription>
                </DialogHeader>
                <div className="grid gap-3">
                    <div className="grid gap-1">
                        <Label htmlFor="slc-name" className={tried && !nameOk ? "text-destructive" : ""}>Name</Label>
                        <Input id="slc-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} aria-invalid={tried && !nameOk} placeholder="For example: Office hours" autoFocus />
                    </div>
                    <div className="grid gap-1">
                        <Label htmlFor="slc-tz">Time zone</Label>
                        <Input id="slc-tz" list="slc-zones" value={timezone} onChange={(e) => setTimezone(e.target.value)} />
                        <datalist id="slc-zones">{zones.map((z) => <option key={z} value={z} />)}</datalist>
                    </div>
                    <fieldset className="grid gap-1">
                        <legend className="mb-1 text-sm font-medium">Working days</legend>
                        <div className="flex flex-wrap gap-3">
                            {DAYS.map(([n, label]) => (
                                <label key={n} className="flex items-center gap-1.5 text-sm"><input type="checkbox" className="h-4 w-4 shrink-0 rounded border-input accent-primary" checked={days.includes(n)} onChange={(e) => setDays((d) => (e.target.checked ? [...d, n] : d.filter((x) => x !== n)))} /> {label}</label>
                            ))}
                        </div>
                        {tried && !daysOk ? <p role="alert" className="text-xs text-destructive">Choose at least one day.</p> : null}
                    </fieldset>
                    <div className="grid grid-cols-2 gap-3">
                        <div className="grid gap-1">
                            <Label htmlFor="slc-start">From</Label>
                            <Input id="slc-start" type="time" value={start} onChange={(e) => setStart(e.target.value)} />
                        </div>
                        <div className="grid gap-1">
                            <Label htmlFor="slc-end">Until</Label>
                            <Input id="slc-end" type="time" value={end === "24:00" ? "23:59" : end} onChange={(e) => setEnd(e.target.value === "23:59" ? "24:00" : e.target.value)} />
                        </div>
                    </div>
                    {tried && !timesOk ? <p role="alert" className="text-xs text-destructive">The working day has to end after it starts.</p> : null}
                    <div>
                        <Button type="button" size="sm" variant="outline" onClick={() => void fromReports()}>Start from the business hours under Reports</Button>
                    </div>
                    <fieldset className="grid gap-2 rounded-lg border p-3">
                        <legend className="px-1 text-sm font-medium">Holidays</legend>
                        {holidays.length > 0 ? (
                            <ul className="grid gap-1 text-sm">
                                {holidays.map((h) => (
                                    <li key={h.date} className="flex items-center justify-between gap-2">
                                        <span>{h.date}{h.name ? ` · ${h.name}` : ""}</span>
                                        <Button type="button" size="icon" variant="ghost" className="h-6 w-6" aria-label={`Remove ${h.date}`} onClick={() => setHolidays((x) => x.filter((y) => y.date !== h.date))}><X className="h-3.5 w-3.5" /></Button>
                                    </li>
                                ))}
                            </ul>
                        ) : <p className="text-xs text-muted-foreground">No holidays.</p>}
                        <div className="flex flex-wrap items-end gap-2">
                            <div className="grid gap-1"><Label htmlFor="slc-hd" className="text-xs">Date</Label><Input id="slc-hd" type="date" value={hDate} onChange={(e) => setHDate(e.target.value)} className="h-9" /></div>
                            <div className="grid min-w-[8rem] flex-1 gap-1"><Label htmlFor="slc-hn" className="text-xs">Name (optional)</Label><Input id="slc-hn" value={hName} onChange={(e) => setHName(e.target.value)} className="h-9" /></div>
                            <Button type="button" size="sm" variant="outline" disabled={!hDate || holidays.some((h) => h.date === hDate)} onClick={() => { setHolidays((x) => [...x, { date: hDate, name: hName }].sort((a, b) => a.date.localeCompare(b.date))); setHDate(""); setHName(""); }}>Add</Button>
                        </div>
                    </fieldset>
                </div>
                <DialogFooter>
                    <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
                    <Button onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
