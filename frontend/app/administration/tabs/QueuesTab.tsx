"use client";

// Queues, and the routing rules that put every new ticket, from any source, in a queue, with a person and a priority.
import * as React from "react";
import { ArrowDown, ArrowUp, Inbox, Pencil, Plus, Trash2, Workflow, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { jfetch } from "@/lib/api";
import { errorText, type Queue } from "@/lib/service-desk";
import type { ToastFn } from "../types";

type Option = { id: string; name: string };
type Condition = { field: string; values: string[] };
type Actions = { queueId: string | null; assignee: string; priority: string | null };
type Rule = { id: string; name: string; enabled: boolean; position: number; match: "all" | "any"; conditions: Condition[]; actions: Actions; stopOnMatch: boolean; queueName: string | null; assigneeName: string | null };
type FieldDef = { key: string; label: string; kind: "ids" | "list" | "text" };
type PolicyOption = { id: string; name: string };

const SOURCES: [string, string][] = [["ui", "Entered by staff"], ["email", "Email"], ["portal", "Client portal"], ["alert", "Alert"], ["api", "Created automatically"]];
const PRIORITIES: [string, string][] = [["low", "Low"], ["medium", "Medium"], ["high", "High"], ["urgent", "Urgent"]];
const ASSIGNMENT_TEXT: Record<Queue["assignment"], string> = { none: "Tickets wait unassigned", user: "One person gets them", round_robin: "Takes turns" };

export default function QueuesTab({ push }: { push: ToastFn }) {
    const [queues, setQueues] = React.useState<Queue[] | null>(null);
    const [rules, setRules] = React.useState<Rule[] | null>(null);
    const [fields, setFields] = React.useState<FieldDef[]>([]);
    const [people, setPeople] = React.useState<Option[]>([]);
    const [groups, setGroups] = React.useState<Option[]>([]);
    const [customers, setCustomers] = React.useState<Option[]>([]);
    const [policies, setPolicies] = React.useState<PolicyOption[]>([]);
    const [editingQueue, setEditingQueue] = React.useState<Queue | "new" | null>(null);
    const [editingRule, setEditingRule] = React.useState<Rule | "new" | null>(null);
    const [busy, setBusy] = React.useState(false);

    const load = React.useCallback(async () => {
        try {
            const [q, r] = await Promise.all([jfetch<{ items: Queue[] }>("/api/ticket-queues"), jfetch<{ items: Rule[]; fields: FieldDef[] }>("/api/ticket-routing-rules")]);
            setQueues(q.items);
            setRules(r.items);
            setFields(r.fields);
        } catch (e) {
            setQueues([]);
            setRules([]);
            push({ title: "Could not load queues and rules", desc: errorText(e), kind: "destructive" });
        }
    }, [push]);

    React.useEffect(() => { void load(); }, [load]);
    React.useEffect(() => {
        jfetch<any>("/api/users").then((r) => setPeople((Array.isArray(r) ? r : r?.items ?? []).map((u: any) => ({ id: String(u.id), name: String(u.name || u.email || u.id) })))).catch(() => setPeople([]));
        jfetch<any[]>("/api/admin/groups").then((r) => setGroups((r ?? []).map((g: any) => ({ id: String(g.id), name: String(g.name) })))).catch(() => setGroups([]));
        jfetch<any[]>("/api/customers").then((r) => setCustomers((Array.isArray(r) ? r : []).filter((c) => c?.key && c?.name).map((c) => ({ id: String(c.key), name: String(c.name) })).sort((a, b) => a.name.localeCompare(b.name)))).catch(() => setCustomers([]));
        jfetch<{ items: PolicyOption[] }>("/api/sla/policies").then((r) => setPolicies(r.items.map((p) => ({ id: p.id, name: p.name })))).catch(() => setPolicies([]));
    }, []);

    if (!queues || !rules) return <div className="p-4 text-sm text-muted-foreground">Loading…</div>;

    async function run<T>(fn: () => Promise<T>, ok: string, failed: string) {
        setBusy(true);
        try {
            await fn();
            if (ok) push({ title: ok, kind: "success" });
            await load();
        } catch (e) {
            push({ title: failed, desc: errorText(e), kind: "destructive" });
        } finally {
            setBusy(false);
        }
    }

    async function move(i: number, by: -1 | 1) {
        const ids = (rules ?? []).map((r) => r.id);
        const j = i + by;
        if (j < 0 || j >= ids.length) return;
        [ids[i], ids[j]] = [ids[j], ids[i]];
        await run(() => jfetch("/api/ticket-routing-rules/reorder", { method: "POST", body: { ids } }), "", "Could not reorder");
    }

    const personName = (id: string | null) => people.find((p) => p.id === id)?.name ?? "someone";
    const describeCondition = (c: Condition) => {
        const def = fields.find((f) => f.key === c.field);
        const vals = c.field === "customer" ? c.values.map((v) => customers.find((x) => x.id === v)?.name ?? "a customer") : c.field === "source" ? c.values.map((v) => SOURCES.find((s) => s[0] === v)?.[1] ?? v) : c.values;
        return `${def?.label ?? c.field} ${vals.map((v) => `"${v}"`).join(" or ")}`;
    };
    const describeActions = (r: Rule) => {
        const out: string[] = [];
        if (r.actions.queueId) out.push(`queue ${r.queueName ?? "?"}`);
        if (r.actions.assignee === "none") out.push("leave unassigned");
        else if (r.actions.assignee === "round_robin") out.push("next person in turn");
        else if (r.actions.assignee !== "queue") out.push(`assign to ${r.assigneeName ?? personName(r.actions.assignee)}`);
        if (r.actions.priority) out.push(`priority ${r.actions.priority}`);
        return out.join(", ");
    };

    return (
        <div className="grid w-full min-w-0 gap-6">
            <div>
                <h2 className="flex items-center gap-2 text-xl font-semibold tracking-tight"><Inbox className="h-5 w-5" aria-hidden /> Queues and routing</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                    A queue is where tickets wait for someone to take them. It can hand each new ticket to one person, or take turns between a list of people or the members of a group, and it can have an SLA policy of its own.
                    Routing rules look at every new ticket, whether it was typed in, emailed, opened in the client portal or raised by an alert, and put it in a queue with a person and a priority. Rules are tried in order.
                </p>
            </div>

            <section className="grid gap-3 rounded-xl border border-border/70 bg-card p-5 shadow-sm" aria-labelledby="q-queues">
                <div className="flex items-center justify-between gap-2">
                    <h3 id="q-queues" className="text-base font-semibold">Queues</h3>
                    <Button size="sm" onClick={() => setEditingQueue("new")}><Plus className="mr-1.5 h-4 w-4" aria-hidden /> New queue</Button>
                </div>
                {queues.length === 0 ? (
                    <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">No queues yet. Add one, for example &ldquo;Support&rdquo; or &ldquo;Projects&rdquo;.</p>
                ) : (
                    <div className="overflow-x-auto rounded-lg border">
                        <table className="w-full min-w-[640px] text-sm">
                            <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                                <tr><th className="p-2 font-medium">Queue</th><th className="p-2 font-medium">New tickets</th><th className="p-2 font-medium">Open now</th><th className="p-2" /></tr>
                            </thead>
                            <tbody className="divide-y">
                                {queues.map((q) => (
                                    <tr key={q.id} className={q.enabled ? "" : "opacity-60"}>
                                        <td className="p-2 align-top">
                                            <div className="font-medium">{q.name}{!q.enabled ? <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-[11px]">Off</span> : null}</div>
                                            {q.description ? <div className="text-xs text-muted-foreground">{q.description}</div> : null}
                                            {q.defaultSlaPolicyId ? <div className="text-xs text-muted-foreground">SLA: {policies.find((p) => p.id === q.defaultSlaPolicyId)?.name ?? "a policy"}</div> : null}
                                        </td>
                                        <td className="p-2 align-top">
                                            {ASSIGNMENT_TEXT[q.assignment]}
                                            {q.assignment === "user" ? <div className="text-xs text-muted-foreground">{personName(q.defaultAssigneeUserId)}</div> : null}
                                            {q.assignment === "round_robin" ? <div className="text-xs text-muted-foreground">{q.poolUserIds.length} {q.poolUserIds.length === 1 ? "person" : "people"}{q.poolGroupId ? ` and the group ${groups.find((g) => g.id === q.poolGroupId)?.name ?? ""}` : ""}</div> : null}
                                        </td>
                                        <td className="p-2 align-top tabular-nums">{q.open}{q.unassigned ? <span className="text-xs text-muted-foreground"> ({q.unassigned} unassigned)</span> : null}</td>
                                        <td className="p-2 align-top">
                                            <div className="flex justify-end gap-1">
                                                <Button size="icon" variant="ghost" aria-label={`Edit ${q.name}`} onClick={() => setEditingQueue(q)}><Pencil className="h-4 w-4" /></Button>
                                                <Button size="icon" variant="ghost" aria-label={`Delete ${q.name}`} disabled={busy} onClick={() => { if (window.confirm(`Delete the queue "${q.name}"? Its tickets stay, in no queue.`)) void run(() => jfetch(`/api/ticket-queues/${q.id}`, { method: "DELETE" }), "Queue deleted", "Could not delete the queue"); }}><Trash2 className="h-4 w-4" /></Button>
                                            </div>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </section>

            <section className="grid gap-3 rounded-xl border border-border/70 bg-card p-5 shadow-sm" aria-labelledby="q-rules">
                <div className="flex items-center justify-between gap-2">
                    <h3 id="q-rules" className="flex items-center gap-2 text-base font-semibold"><Workflow className="h-4 w-4" aria-hidden /> Routing rules</h3>
                    <Button size="sm" onClick={() => setEditingRule("new")}><Plus className="mr-1.5 h-4 w-4" aria-hidden /> New rule</Button>
                </div>
                <p className="text-sm text-muted-foreground">The first rule that matches a ticket decides its queue, person and priority. A rule that does not stop the search lets the rules after it fill in whatever is still undecided. A person who picks a queue, a person or a priority on the new ticket form is not overruled.</p>
                {rules.length === 0 ? (
                    <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">No rules yet. Tickets stay where they are put.</p>
                ) : (
                    <ol className="divide-y rounded-lg border text-sm">
                        {rules.map((r, i) => (
                            <li key={r.id} className={`flex flex-wrap items-start gap-3 p-3 ${r.enabled ? "" : "opacity-60"}`}>
                                <span className="mt-0.5 w-6 shrink-0 text-center text-xs tabular-nums text-muted-foreground">{i + 1}</span>
                                <div className="min-w-0 flex-1">
                                    <div className="font-medium">{r.name}{!r.stopOnMatch ? <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-[11px] font-normal">keeps looking</span> : null}</div>
                                    <div className="text-xs text-muted-foreground">If {r.match === "any" ? "any of" : "all of"}: {r.conditions.map(describeCondition).join("; ")}</div>
                                    <div className="text-xs text-muted-foreground">Then: {describeActions(r) || "nothing"}</div>
                                </div>
                                <div className="flex items-center gap-1">
                                    <label className="mr-1 flex items-center gap-1.5 text-xs"><input type="checkbox" className="h-4 w-4 shrink-0 rounded border-input accent-primary" checked={r.enabled} disabled={busy} onChange={(e) => void run(() => jfetch(`/api/ticket-routing-rules/${r.id}`, { method: "PATCH", body: { enabled: e.target.checked } }), "", "Could not change the rule")} aria-label={`${r.name} is on`} /> On</label>
                                    <Button size="icon" variant="ghost" aria-label={`Move ${r.name} up`} disabled={busy || i === 0} onClick={() => void move(i, -1)}><ArrowUp className="h-4 w-4" /></Button>
                                    <Button size="icon" variant="ghost" aria-label={`Move ${r.name} down`} disabled={busy || i === rules.length - 1} onClick={() => void move(i, 1)}><ArrowDown className="h-4 w-4" /></Button>
                                    <Button size="icon" variant="ghost" aria-label={`Edit ${r.name}`} onClick={() => setEditingRule(r)}><Pencil className="h-4 w-4" /></Button>
                                    <Button size="icon" variant="ghost" aria-label={`Delete ${r.name}`} disabled={busy} onClick={() => { if (window.confirm(`Delete the rule "${r.name}"?`)) void run(() => jfetch(`/api/ticket-routing-rules/${r.id}`, { method: "DELETE" }), "Rule deleted", "Could not delete the rule"); }}><Trash2 className="h-4 w-4" /></Button>
                                </div>
                            </li>
                        ))}
                    </ol>
                )}
            </section>

            <RuleTester customers={customers} />

            <QueueDialog editing={editingQueue} people={people} groups={groups} policies={policies} onClose={() => setEditingQueue(null)} onSaved={async () => { setEditingQueue(null); await load(); }} push={push} />
            <RuleDialog editing={editingRule} fields={fields} queues={queues} people={people} customers={customers} onClose={() => setEditingRule(null)} onSaved={async () => { setEditingRule(null); await load(); }} push={push} />
        </div>
    );
}

/** Try a made-up ticket against the rules as they are now. Nothing is created. */
function RuleTester({ customers }: { customers: Option[] }) {
    const [subject, setSubject] = React.useState("");
    const [body, setBody] = React.useState("");
    const [source, setSource] = React.useState("email");
    const [priority, setPriority] = React.useState("medium");
    const [customerId, setCustomerId] = React.useState("");
    const [sender, setSender] = React.useState("");
    const [tags, setTags] = React.useState("");
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const [result, setResult] = React.useState<any | null>(null);

    async function test() {
        setBusy(true);
        setError(null);
        try {
            setResult(await jfetch("/api/ticket-routing-rules/test", { method: "POST", body: { subject, body, source, priority, customerId: customerId || null, senderEmail: sender || null, deviceTags: tags } }));
        } catch (e) {
            setResult(null);
            setError(errorText(e));
        } finally {
            setBusy(false);
        }
    }

    return (
        <section className="grid gap-3 rounded-xl border border-border/70 bg-card p-5 shadow-sm" aria-labelledby="q-test">
            <h3 id="q-test" className="text-base font-semibold">Try a ticket</h3>
            <p className="text-sm text-muted-foreground">Describe a ticket to see which rules would catch it and where it would go. Nothing is created.</p>
            <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-1"><Label htmlFor="qt-subject">Subject</Label><Input id="qt-subject" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Printer on the second floor is jammed" /></div>
                <div className="grid gap-1"><Label htmlFor="qt-customer">Customer</Label>
                    <select id="qt-customer" value={customerId} onChange={(e) => setCustomerId(e.target.value)} className="h-10 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><option value="">No customer</option>{customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
                </div>
                <div className="grid gap-1 sm:col-span-2"><Label htmlFor="qt-body">Description</Label><Textarea id="qt-body" rows={2} value={body} onChange={(e) => setBody(e.target.value)} /></div>
                <div className="grid gap-1"><Label htmlFor="qt-source">Comes from</Label>
                    <select id="qt-source" value={source} onChange={(e) => setSource(e.target.value)} className="h-10 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{SOURCES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
                </div>
                <div className="grid gap-1"><Label htmlFor="qt-priority">Priority</Label>
                    <select id="qt-priority" value={priority} onChange={(e) => setPriority(e.target.value)} className="h-10 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{PRIORITIES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
                </div>
                <div className="grid gap-1"><Label htmlFor="qt-sender">Sender&apos;s email</Label><Input id="qt-sender" value={sender} onChange={(e) => setSender(e.target.value)} placeholder="name@customer.com" /></div>
                <div className="grid gap-1"><Label htmlFor="qt-tags">Device tags <span className="font-normal text-muted-foreground">(comma separated)</span></Label><Input id="qt-tags" value={tags} onChange={(e) => setTags(e.target.value)} /></div>
            </div>
            <div><Button size="sm" onClick={() => void test()} disabled={busy}>{busy ? "Checking…" : "Test"}</Button></div>
            {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
            {result ? (
                <div role="status" className="rounded-md bg-muted/50 p-3 text-sm">
                    {result.noRuleMatched ? (
                        <p>No rule matches, so the ticket would be left as it is.</p>
                    ) : (
                        <ul className="grid gap-1">
                            <li><b>Rules that match:</b> {result.matched.map((m: any) => m.name).join(", ")}</li>
                            <li><b>Queue:</b> {result.queue ? result.queue.name + (result.queue.enabled ? "" : " (switched off, so it would not be used)") : "none"}</li>
                            <li><b>Assigned to:</b> {result.assignee ? `${result.assignee.name} (${result.assignee.how})` : result.assigneeNote ?? "nobody"}</li>
                            <li><b>Priority:</b> {result.priority ?? "unchanged"}</li>
                        </ul>
                    )}
                </div>
            ) : null}
        </section>
    );
}

function QueueDialog({ editing, people, groups, policies, onClose, onSaved, push }: { editing: Queue | "new" | null; people: Option[]; groups: Option[]; policies: PolicyOption[]; onClose: () => void; onSaved: () => Promise<void>; push: ToastFn }) {
    const isNew = editing === "new";
    const [name, setName] = React.useState("");
    const [description, setDescription] = React.useState("");
    const [enabled, setEnabled] = React.useState(true);
    const [assignment, setAssignment] = React.useState<Queue["assignment"]>("none");
    const [assignee, setAssignee] = React.useState("");
    const [pool, setPool] = React.useState<string[]>([]);
    const [group, setGroup] = React.useState("");
    const [policy, setPolicy] = React.useState("");
    const [saving, setSaving] = React.useState(false);
    const [tried, setTried] = React.useState(false);

    React.useEffect(() => {
        if (!editing) return;
        setTried(false);
        if (editing === "new") {
            setName(""); setDescription(""); setEnabled(true); setAssignment("none"); setAssignee(""); setPool([]); setGroup(""); setPolicy("");
        } else {
            setName(editing.name); setDescription(editing.description ?? ""); setEnabled(editing.enabled); setAssignment(editing.assignment); setAssignee(editing.defaultAssigneeUserId ?? ""); setPool(editing.poolUserIds); setGroup(editing.poolGroupId ?? ""); setPolicy(editing.defaultSlaPolicyId ?? "");
        }
    }, [editing]);

    const nameOk = name.trim().length > 0;
    const assigneeOk = assignment !== "user" || !!assignee;
    const poolOk = assignment !== "round_robin" || pool.length > 0 || !!group;

    async function save() {
        setTried(true);
        if (!nameOk || !assigneeOk || !poolOk) return;
        setSaving(true);
        try {
            const body = { name, description, enabled, assignment, defaultAssigneeUserId: assignment === "user" ? assignee : null, poolUserIds: assignment === "round_robin" ? pool : [], poolGroupId: assignment === "round_robin" && group ? group : null, defaultSlaPolicyId: policy || null };
            if (isNew) await jfetch("/api/ticket-queues", { method: "POST", body });
            else await jfetch(`/api/ticket-queues/${(editing as Queue).id}`, { method: "PATCH", body });
            push({ title: isNew ? "Queue added" : "Queue saved", kind: "success" });
            await onSaved();
        } catch (e) {
            push({ title: "Could not save the queue", desc: errorText(e), kind: "destructive" });
        } finally {
            setSaving(false);
        }
    }

    const left = people.filter((p) => !pool.includes(p.id));
    return (
        <Dialog open={!!editing} onOpenChange={(o) => { if (!o) onClose(); }}>
            <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
                <DialogHeader>
                    <DialogTitle>{isNew ? "New queue" : "Edit queue"}</DialogTitle>
                    <DialogDescription>A ticket put in the queue by hand, or by a rule, goes to the person this queue says, unless it already has one.</DialogDescription>
                </DialogHeader>
                <div className="grid gap-3">
                    <div className="grid gap-1">
                        <Label htmlFor="qd-name" className={tried && !nameOk ? "text-destructive" : ""}>Name</Label>
                        <Input id="qd-name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} aria-invalid={tried && !nameOk} autoFocus />
                    </div>
                    <div className="grid gap-1">
                        <Label htmlFor="qd-desc">Description <span className="font-normal text-muted-foreground">(optional)</span></Label>
                        <Input id="qd-desc" value={description} maxLength={300} onChange={(e) => setDescription(e.target.value)} />
                    </div>
                    <fieldset className="grid gap-1.5 rounded-lg border p-3">
                        <legend className="px-1 text-sm font-medium">New tickets in this queue</legend>
                        {(["none", "user", "round_robin"] as const).map((k) => (
                            <label key={k} className="flex items-center gap-2 text-sm"><input type="radio" name="qd-assignment" checked={assignment === k} onChange={() => setAssignment(k)} /> {k === "none" ? "Wait unassigned until someone takes them" : k === "user" ? "Go to one person" : "Go to a list of people in turn (round robin)"}</label>
                        ))}
                        {assignment === "user" ? (
                            <div className="grid gap-1">
                                <Label htmlFor="qd-person" className={tried && !assigneeOk ? "text-destructive" : "text-xs"}>Person</Label>
                                <select id="qd-person" value={assignee} onChange={(e) => setAssignee(e.target.value)} className="h-10 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><option value="">Choose…</option>{people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
                            </div>
                        ) : null}
                        {assignment === "round_robin" ? (
                            <div className="grid gap-2">
                                <div className="grid gap-1">
                                    <Label className={tried && !poolOk ? "text-destructive text-xs" : "text-xs"}>People who take turns</Label>
                                    <div className="flex flex-wrap items-center gap-1.5">
                                        {pool.map((id) => (
                                            <span key={id} className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs">{people.find((p) => p.id === id)?.name ?? "Unknown"}<button type="button" aria-label="Remove" onClick={() => setPool((x) => x.filter((y) => y !== id))}><X className="h-3 w-3" /></button></span>
                                        ))}
                                        <select aria-label="Add a person to the turns" value="" onChange={(e) => e.target.value && setPool((x) => [...x, e.target.value])} className="h-10 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><option value="">{left.length ? "Add a person…" : "No more people"}</option>{left.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
                                    </div>
                                </div>
                                <div className="grid gap-1">
                                    <Label htmlFor="qd-group" className="text-xs">And the members of this group</Label>
                                    <select id="qd-group" value={group} onChange={(e) => setGroup(e.target.value)} className="h-10 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><option value="">No group</option>{groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</select>
                                </div>
                                {tried && !poolOk ? <p role="alert" className="text-xs text-destructive">Choose at least one person or a group.</p> : <p className="text-xs text-muted-foreground">People who are switched off are skipped.</p>}
                            </div>
                        ) : null}
                    </fieldset>
                    <div className="grid gap-1">
                        <Label htmlFor="qd-policy">SLA policy for tickets in this queue <span className="font-normal text-muted-foreground">(a customer&apos;s own policy comes first)</span></Label>
                        <select id="qd-policy" value={policy} onChange={(e) => setPolicy(e.target.value)} className="h-10 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><option value="">Use the default policy</option>{policies.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
                    </div>
                    <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4 shrink-0 rounded border-input accent-primary" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> This queue is on (a switched-off queue cannot be picked or used by rules)</label>
                </div>
                <DialogFooter>
                    <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
                    <Button onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function RuleDialog({ editing, fields, queues, people, customers, onClose, onSaved, push }: { editing: Rule | "new" | null; fields: FieldDef[]; queues: Queue[]; people: Option[]; customers: Option[]; onClose: () => void; onSaved: () => Promise<void>; push: ToastFn }) {
    const isNew = editing === "new";
    // The site condition needs a site list this screen does not have; it can still be set through the API.
    const usable = fields.filter((f) => f.key !== "site");
    const [name, setName] = React.useState("");
    const [match, setMatch] = React.useState<"all" | "any">("all");
    const [conditions, setConditions] = React.useState<Condition[]>([]);
    const [actions, setActions] = React.useState<Actions>({ queueId: null, assignee: "queue", priority: null });
    const [stop, setStop] = React.useState(true);
    const [enabled, setEnabled] = React.useState(true);
    const [saving, setSaving] = React.useState(false);
    const [tried, setTried] = React.useState(false);

    React.useEffect(() => {
        if (!editing) return;
        setTried(false);
        if (editing === "new") {
            setName(""); setMatch("all"); setConditions([{ field: "subject_contains", values: [] }]); setActions({ queueId: null, assignee: "queue", priority: null }); setStop(true); setEnabled(true);
        } else {
            setName(editing.name); setMatch(editing.match); setConditions(JSON.parse(JSON.stringify(editing.conditions))); setActions({ ...editing.actions }); setStop(editing.stopOnMatch); setEnabled(editing.enabled);
        }
    }, [editing]);

    const nameOk = name.trim().length > 0;
    const condOk = conditions.length > 0 && conditions.every((c) => c.values.length > 0);
    const actionOk = !!actions.queueId || actions.assignee !== "queue" || !!actions.priority;
    const rrOk = actions.assignee !== "round_robin" || !!actions.queueId;

    async function save() {
        setTried(true);
        if (!nameOk || !condOk || !actionOk || !rrOk) return;
        setSaving(true);
        try {
            const body = { name, match, conditions, actions, stopOnMatch: stop, enabled };
            if (isNew) await jfetch("/api/ticket-routing-rules", { method: "POST", body });
            else await jfetch(`/api/ticket-routing-rules/${(editing as Rule).id}`, { method: "PATCH", body });
            push({ title: isNew ? "Rule added" : "Rule saved", kind: "success" });
            await onSaved();
        } catch (e) {
            push({ title: "Could not save the rule", desc: errorText(e), kind: "destructive" });
        } finally {
            setSaving(false);
        }
    }

    const setCond = (i: number, c: Condition) => setConditions((all) => all.map((x, j) => (j === i ? c : x)));

    return (
        <Dialog open={!!editing} onOpenChange={(o) => { if (!o) onClose(); }}>
            <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
                <DialogHeader>
                    <DialogTitle>{isNew ? "New routing rule" : "Edit routing rule"}</DialogTitle>
                    <DialogDescription>Applies to tickets made after it is saved, from every source.</DialogDescription>
                </DialogHeader>
                <div className="grid gap-4">
                    <div className="grid gap-1">
                        <Label htmlFor="rd-name" className={tried && !nameOk ? "text-destructive" : ""}>Name</Label>
                        <Input id="rd-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} aria-invalid={tried && !nameOk} placeholder="For example: Printer problems" autoFocus />
                    </div>
                    <fieldset className="grid gap-2 rounded-lg border p-3">
                        <legend className="px-1 text-sm font-medium">If</legend>
                        <div className="flex gap-3 text-sm">
                            <label className="flex items-center gap-1.5"><input type="radio" name="rd-match" checked={match === "all"} onChange={() => setMatch("all")} /> all of these are true</label>
                            <label className="flex items-center gap-1.5"><input type="radio" name="rd-match" checked={match === "any"} onChange={() => setMatch("any")} /> any of these is true</label>
                        </div>
                        {conditions.map((c, i) => {
                            const def = usable.find((f) => f.key === c.field) ?? fields.find((f) => f.key === c.field);
                            return (
                                <div key={i} className="flex flex-wrap items-start gap-2 rounded-md bg-muted/40 p-2">
                                    <select aria-label="What to test" value={c.field} onChange={(e) => setCond(i, { field: e.target.value, values: [] })} className="h-10 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                                        {usable.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                                    </select>
                                    <div className="min-w-[12rem] flex-1">
                                        {def?.kind === "list" ? (
                                            <div className="flex flex-wrap gap-x-3 gap-y-1 py-1.5 text-sm">
                                                {(c.field === "source" ? SOURCES : PRIORITIES).map(([k, l]) => (
                                                    <label key={k} className="flex items-center gap-1.5"><input type="checkbox" className="h-4 w-4 shrink-0 rounded border-input accent-primary" checked={c.values.includes(k)} onChange={(e) => setCond(i, { ...c, values: e.target.checked ? [...c.values, k] : c.values.filter((v) => v !== k) })} /> {l}</label>
                                                ))}
                                            </div>
                                        ) : def?.kind === "ids" ? (
                                            <div className="flex flex-wrap items-center gap-1.5">
                                                {c.values.map((v) => <span key={v} className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs">{customers.find((x) => x.id === v)?.name ?? "A customer"}<button type="button" aria-label="Remove" onClick={() => setCond(i, { ...c, values: c.values.filter((x) => x !== v) })}><X className="h-3 w-3" /></button></span>)}
                                                <select aria-label="Add a customer" value="" onChange={(e) => e.target.value && setCond(i, { ...c, values: [...c.values, e.target.value] })} className="h-10 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><option value="">Add a customer…</option>{customers.filter((x) => !c.values.includes(x.id)).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
                                            </div>
                                        ) : (
                                            <Input aria-label="Words to look for" value={c.values.join(", ")} onChange={(e) => setCond(i, { ...c, values: e.target.value.split(",").map((s) => s.trimStart()).filter((s, k, a) => s.trim() || k < a.length - 1) })} onBlur={() => setCond(i, { ...c, values: c.values.map((s) => s.trim()).filter(Boolean) })} placeholder={c.field === "sender_domain" ? "customer.com, other.com" : c.field === "device_tag" ? "server, vip" : "printer, scanner (any of these words)"} className="h-9" />
                                        )}
                                        {tried && c.values.length === 0 ? <p role="alert" className="mt-1 text-xs text-destructive">Give a value.</p> : null}
                                    </div>
                                    <Button type="button" size="icon" variant="ghost" aria-label="Remove this condition" disabled={conditions.length === 1} onClick={() => setConditions((all) => all.filter((_, j) => j !== i))}><X className="h-4 w-4" /></Button>
                                </div>
                            );
                        })}
                        <div><Button type="button" size="sm" variant="outline" onClick={() => setConditions((all) => [...all, { field: "subject_contains", values: [] }])}><Plus className="mr-1 h-3.5 w-3.5" aria-hidden /> Add a condition</Button></div>
                    </fieldset>
                    <fieldset className="grid gap-3 rounded-lg border p-3">
                        <legend className="px-1 text-sm font-medium">Then</legend>
                        <div className="grid gap-3 sm:grid-cols-3">
                            <div className="grid gap-1">
                                <Label htmlFor="rd-queue" className="text-xs">Put it in the queue</Label>
                                <select id="rd-queue" value={actions.queueId ?? ""} onChange={(e) => setActions((a) => ({ ...a, queueId: e.target.value || null }))} className="h-10 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><option value="">Leave the queue alone</option>{queues.filter((q) => q.enabled || q.id === actions.queueId).map((q) => <option key={q.id} value={q.id}>{q.name}</option>)}</select>
                            </div>
                            <div className="grid gap-1">
                                <Label htmlFor="rd-assignee" className="text-xs">Assign it to</Label>
                                <select id="rd-assignee" value={actions.assignee} onChange={(e) => setActions((a) => ({ ...a, assignee: e.target.value }))} className="h-10 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                                    <option value="queue">Whatever the queue does</option>
                                    <option value="none">Nobody (leave unassigned)</option>
                                    <option value="round_robin">The next person in turn in the queue</option>
                                    {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                                </select>
                            </div>
                            <div className="grid gap-1">
                                <Label htmlFor="rd-priority" className="text-xs">Set the priority</Label>
                                <select id="rd-priority" value={actions.priority ?? ""} onChange={(e) => setActions((a) => ({ ...a, priority: e.target.value || null }))} className="h-10 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><option value="">Leave it</option>{PRIORITIES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
                            </div>
                        </div>
                        {tried && !actionOk ? <p role="alert" className="text-xs text-destructive">A rule has to do something: choose a queue, a person or a priority.</p> : null}
                        {tried && !rrOk ? <p role="alert" className="text-xs text-destructive">Taking turns needs a queue, whose people take the tickets.</p> : null}
                    </fieldset>
                    <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="h-4 w-4 shrink-0 rounded border-input accent-primary" checked={stop} onChange={(e) => setStop(e.target.checked)} /> <span>Stop here when this rule matches <span className="text-xs text-muted-foreground">(otherwise the rules after it can still fill in what is undecided)</span></span></label>
                    <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4 shrink-0 rounded border-input accent-primary" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> This rule is on</label>
                    {tried && !condOk ? <p role="alert" className="text-xs text-destructive">Every condition needs a value.</p> : null}
                </div>
                <DialogFooter>
                    <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
                    <Button onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
