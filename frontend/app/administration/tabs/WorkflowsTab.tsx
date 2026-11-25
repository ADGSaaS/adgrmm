"use client";

// Workflows: "when this happens, do that". A rule has one trigger (an alert is raised, a computer enrolls, a ticket is created), conditions that
// must all hold, and up to four actions. Rules are off until switched on, can be tried on the newest real event without running anything,
// and every run is logged with what each step did.
import * as React from "react";
import { Plus, Play, Pause, Trash2, FlaskConical, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TabsContent } from "@/components/ui/tabs";
import { jfetch } from "@/lib/api";
import { workflows, type Action, type Condition, type Meta, type Preview, type Rule, type RuleInput, type Run } from "@/lib/workflows-api";
import { AdminNote, AdminSection, ADMIN_SELECT } from "../tab-layout";
import { Pill, messageOf } from "../platform-common";
import type { ToastFn } from "../types";

const blank = (trigger: string): RuleInput => ({ name: "", trigger, enabled: false, conditions: [], actions: [{ type: "create_ticket", subject: "{{title}}", description: "", priority: "medium" }], cooldownMinutes: 60 });

export default function WorkflowsTab({ push }: { push: ToastFn }) {
    const [meta, setMeta] = React.useState<Meta | null>(null);
    const [rules, setRules] = React.useState<Rule[]>([]);
    const [runs, setRuns] = React.useState<Run[]>([]);
    const [scripts, setScripts] = React.useState<Array<{ id: string; name: string }>>([]);
    const [editing, setEditing] = React.useState<{ id: string | null; draft: RuleInput } | null>(null);
    const [preview, setPreview] = React.useState<{ id: string; p: Preview } | null>(null);
    const [busy, setBusy] = React.useState(false);
    const [people, setPeople] = React.useState<Array<{ id: string; name: string }>>([]);

    const load = React.useCallback(async () => {
        try {
            const [r, l] = await Promise.all([workflows.list(), workflows.runs()]);
            setRules(r.items); setRuns(l.items);
        } catch (e) { push({ title: "Could not load workflows", desc: messageOf(e), kind: "destructive" }); }
    }, [push]);

    React.useEffect(() => {
        void load();
        void workflows.meta().then(setMeta).catch(() => { /* shown by load */ });
        void jfetch<{ items: Array<{ id: string; name: string }> }>("/api/scripts").then((s) => setScripts(s.items)).catch(() => setScripts([]));
        void jfetch<any>("/api/users").then((u) => {
            const list: any[] = Array.isArray(u) ? u : Array.isArray(u?.items) ? u.items : [];
            setPeople(list.filter((x) => x?.id).map((x) => ({ id: String(x.id), name: String(x.name ?? x.displayName ?? x.fullName ?? x.email ?? x.id) })));
        }).catch(() => setPeople([]));
    }, [load]);

    const act = async (fn: () => Promise<unknown>, ok?: string) => {
        setBusy(true);
        try { await fn(); if (ok) push({ title: ok, kind: "success" }); await load(); }
        catch (e) { push({ title: "That did not work", desc: messageOf(e), kind: "destructive" }); }
        finally { setBusy(false); }
    };

    const triggerOf = (id: string) => meta?.triggers.find((t) => t.id === id);
    const fieldsOf = (id: string) => triggerOf(id)?.fields ?? [];

    const save = () => editing && act(async () => {
        const body = editing.draft;
        if (editing.id) await workflows.update(editing.id, body); else await workflows.create(body);
        setEditing(null);
    }, "Workflow saved");

    const setDraft = (patch: Partial<RuleInput>) => setEditing((e) => (e ? { ...e, draft: { ...e.draft, ...patch } } : e));
    const setCond = (i: number, patch: Partial<Condition>) => editing && setDraft({ conditions: editing.draft.conditions.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
    const setAct = (i: number, a: Action) => editing && setDraft({ actions: editing.draft.actions.map((x, j) => (j === i ? a : x)) });

    const newAction = (type: Action["type"]): Action =>
        type === "create_ticket" ? { type, subject: "{{title}}", description: "", priority: "medium" } : type === "notify" ? { type, subject: "", message: "" }
            : type === "set_priority" ? { type, priority: "high" } : type === "assign" ? { type, userId: people[0]?.id ?? "" } : { type: "run_script", scriptId: scripts[0]?.id ?? "" };

    const describe = (a: Action) => a.type === "create_ticket" ? `Create ticket "${a.subject}"` : a.type === "notify" ? `Send notice "${a.subject}"` : a.type === "set_priority" ? `Set priority to ${a.priority}` : a.type === "assign" ? `Assign to ${people.find((p) => p.id === a.userId)?.name ?? "?"}` : `Run script "${scripts.find((s) => s.id === a.scriptId)?.name ?? "?"}"`;

    return (
        <TabsContent value="workflows">
            <AdminSection
                title="Workflows"
                description="When this happens, do that. A rule starts on an event, checks its conditions, and runs its actions. Rules are off until you switch them on."
                actions={<Button size="sm" disabled={!meta} onClick={() => meta && setEditing({ id: null, draft: blank(meta.triggers[0].id) })}><Plus className="mr-1.5 h-4 w-4" aria-hidden /> New workflow</Button>}
            >
                <div className="grid gap-4 p-5 pt-0">
                    <AdminNote tone="info">
                        A workflow never runs twice for the same computer or ticket inside its cool-down, stops after 30 runs in an hour, and a ticket made by a workflow never starts another workflow.
                        Use {"{{title}}"}, {"{{device}}"}, {"{{client}}"} and the other names shown for the trigger to put details into a ticket or notice.
                    </AdminNote>

                    {!editing && meta ? (
                        <div className="flex flex-wrap items-center gap-2 text-sm">
                            <span className="text-muted-foreground">Start from a ready-made rule (nothing is switched on until you save it on):</span>
                            {meta.templates.map((t) => (
                                <Button key={t.id} size="sm" variant="outline" title={t.plain} onClick={() => setEditing({ id: null, draft: { ...t.rule, enabled: false } })}>{t.title}</Button>
                            ))}
                        </div>
                    ) : null}

                    {editing && meta ? (
                        <div className="grid gap-3 rounded-lg border p-4">
                            <div className="grid gap-3 sm:grid-cols-2">
                                <label className="grid gap-1 text-sm">Name
                                    <Input value={editing.draft.name} onChange={(e) => setDraft({ name: e.target.value })} placeholder="Critical alert on a server opens a ticket" />
                                </label>
                                <label className="grid gap-1 text-sm">When
                                    <select className={ADMIN_SELECT} value={editing.draft.trigger} onChange={(e) => {
                                        const t = meta.triggers.find((x) => x.id === e.target.value);
                                        // Conditions and actions that the new trigger cannot offer are dropped.
                                        setDraft({ trigger: e.target.value, conditions: editing.draft.conditions.filter((c) => t?.fields.some((f) => f.key === c.field)), actions: editing.draft.actions.filter((a) => a.type !== "run_script" || t?.hasDevice) });
                                    }}>
                                        {meta.triggers.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
                                    </select>
                                </label>
                            </div>
                            <p className="text-xs text-muted-foreground">
                                {triggerOf(editing.draft.trigger)?.plain} Names you can use: {fieldsOf(editing.draft.trigger).map((f) => `{{${f.key}}}`).join(" ")}
                            </p>

                            <div className="grid gap-2">
                                <div className="text-sm font-medium">Only if (all of these)</div>
                                {editing.draft.conditions.length === 0 ? <p className="text-xs text-muted-foreground">No conditions: every “{triggerOf(editing.draft.trigger)?.title.toLowerCase()}” runs it.</p> : null}
                                {editing.draft.conditions.map((c, i) => (
                                    <div key={i} className="flex flex-wrap items-center gap-2">
                                        <select className={ADMIN_SELECT} value={c.field} onChange={(e) => setCond(i, { field: e.target.value })}>
                                            {fieldsOf(editing.draft.trigger).map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                                        </select>
                                        <select className={ADMIN_SELECT} value={c.op} onChange={(e) => setCond(i, { op: e.target.value })}>
                                            {meta.ops.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                                        </select>
                                        <Input className="w-56" value={c.value} onChange={(e) => setCond(i, { value: e.target.value })} placeholder="value" />
                                        <Button size="sm" variant="ghost" aria-label="Remove condition" onClick={() => setDraft({ conditions: editing.draft.conditions.filter((_, j) => j !== i) })}><Trash2 className="h-4 w-4" /></Button>
                                    </div>
                                ))}
                                {editing.draft.conditions.length < 5 ? (
                                    <div><Button size="sm" variant="outline" onClick={() => setDraft({ conditions: [...editing.draft.conditions, { field: fieldsOf(editing.draft.trigger)[0]?.key ?? "", op: "is", value: "" }] })}><Plus className="mr-1 h-3.5 w-3.5" /> Add condition</Button></div>
                                ) : null}
                            </div>

                            <div className="grid gap-2">
                                <div className="text-sm font-medium">Then do (in this order)</div>
                                {editing.draft.actions.map((a, i) => (
                                    <div key={i} className="grid gap-2 rounded-md border p-3">
                                        <div className="flex items-center gap-2">
                                            <select className={ADMIN_SELECT} value={a.type} onChange={(e) => setAct(i, newAction(e.target.value as Action["type"]))}>
                                                {meta.actions.filter((x) => (!x.needsDevice || triggerOf(editing.draft.trigger)?.hasDevice) && (!x.needsTicket || editing.draft.trigger === "ticket.created" || editing.draft.actions.slice(0, i).some((p) => p.type === "create_ticket"))).map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}
                                            </select>
                                            <Button size="sm" variant="ghost" className="ml-auto" aria-label="Remove action" onClick={() => setDraft({ actions: editing.draft.actions.filter((_, j) => j !== i) })}><Trash2 className="h-4 w-4" /></Button>
                                        </div>
                                        {a.type === "create_ticket" ? (
                                            <div className="grid gap-2 sm:grid-cols-[1fr_9rem]">
                                                <Input value={a.subject} onChange={(e) => setAct(i, { ...a, subject: e.target.value })} placeholder="Ticket subject" />
                                                <select className={ADMIN_SELECT} value={a.priority} onChange={(e) => setAct(i, { ...a, priority: e.target.value as typeof a.priority })}>
                                                    {["low", "medium", "high", "urgent"].map((p) => <option key={p} value={p}>{p}</option>)}
                                                </select>
                                                <Input className="sm:col-span-2" value={a.description} onChange={(e) => setAct(i, { ...a, description: e.target.value })} placeholder="Ticket description (optional)" />
                                            </div>
                                        ) : a.type === "notify" ? (
                                            <div className="grid gap-2">
                                                <Input value={a.subject} onChange={(e) => setAct(i, { ...a, subject: e.target.value })} placeholder="Subject" />
                                                <Input value={a.message} onChange={(e) => setAct(i, { ...a, message: e.target.value })} placeholder="Message" />
                                            </div>
                                        ) : a.type === "set_priority" ? (
                                            <select className={ADMIN_SELECT} value={a.priority} onChange={(e) => setAct(i, { ...a, priority: e.target.value as typeof a.priority })}>
                                                {["low", "medium", "high", "urgent"].map((p) => <option key={p} value={p}>{p}</option>)}
                                            </select>
                                        ) : a.type === "assign" ? (
                                            <select className={ADMIN_SELECT} value={a.userId} onChange={(e) => setAct(i, { ...a, userId: e.target.value })}>
                                                {people.length === 0 ? <option value="">No technicians found</option> : null}
                                                {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                                            </select>
                                        ) : (
                                            <select className={ADMIN_SELECT} value={a.scriptId} onChange={(e) => setAct(i, { ...a, scriptId: e.target.value })}>
                                                {scripts.length === 0 ? <option value="">No scripts in the library</option> : null}
                                                {scripts.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                                            </select>
                                        )}
                                    </div>
                                ))}
                                {editing.draft.actions.length < 4 ? (
                                    <div><Button size="sm" variant="outline" onClick={() => setDraft({ actions: [...editing.draft.actions, newAction("notify")] })}><Plus className="mr-1 h-3.5 w-3.5" /> Add action</Button></div>
                                ) : null}
                            </div>

                            <div className="flex flex-wrap items-center gap-3">
                                <label className="flex items-center gap-2 text-sm">Not again for the same computer or ticket within
                                    <Input className="w-24" type="number" min={1} max={10080} value={editing.draft.cooldownMinutes} onChange={(e) => setDraft({ cooldownMinutes: Number(e.target.value) })} /> minutes
                                </label>
                                <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={editing.draft.enabled} onChange={(e) => setDraft({ enabled: e.target.checked })} /> On</label>
                                <div className="ml-auto flex gap-2">
                                    <Button size="sm" variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
                                    <Button size="sm" disabled={busy} onClick={() => void save()}>Save</Button>
                                </div>
                            </div>
                        </div>
                    ) : null}

                    {rules.length === 0 && !editing ? <p className="text-sm text-muted-foreground">No workflows yet.</p> : null}
                    <ul className="grid gap-2">
                        {rules.map((r) => (
                            <li key={r.id} className="grid gap-1 rounded-lg border p-3 text-sm">
                                <div className="flex flex-wrap items-center gap-2">
                                    <span className="font-medium">{r.name}</span>
                                    <Pill tone={r.enabled ? "good" : "neutral"}>{r.enabled ? "On" : "Off"}</Pill>
                                    <span className="text-xs text-muted-foreground">{triggerOf(r.trigger)?.title ?? r.trigger} · ran {r.runCount} times{r.lastRunAt ? `, last ${new Date(r.lastRunAt).toLocaleString()}` : ""}</span>
                                    <div className="ml-auto flex flex-wrap gap-1.5">
                                        <Button size="sm" variant="outline" disabled={busy} onClick={() => void act(() => workflows.preview(r.id).then((p) => setPreview({ id: r.id, p })))}><FlaskConical className="mr-1 h-3.5 w-3.5" /> Try</Button>
                                        <Button size="sm" variant="outline" onClick={() => setEditing({ id: r.id, draft: { name: r.name, trigger: r.trigger, enabled: r.enabled, conditions: r.conditions, actions: r.actions, cooldownMinutes: r.cooldownMinutes } })}><Pencil className="mr-1 h-3.5 w-3.5" /> Edit</Button>
                                        <Button size="sm" variant="outline" disabled={busy} onClick={() => void act(() => (r.enabled ? workflows.disable(r.id) : workflows.enable(r.id)))}>
                                            {r.enabled ? <><Pause className="mr-1 h-3.5 w-3.5" /> Turn off</> : <><Play className="mr-1 h-3.5 w-3.5" /> Turn on</>}
                                        </Button>
                                        <Button size="sm" variant="destructive" disabled={busy} aria-label="Delete workflow" onClick={() => { if (window.confirm(`Delete "${r.name}" and its log?`)) void act(() => workflows.remove(r.id), "Workflow deleted"); }}><Trash2 className="h-3.5 w-3.5" /></Button>
                                    </div>
                                </div>
                                <div className="text-xs text-muted-foreground">
                                    {r.conditions.length ? `If ${r.conditions.map((c) => `${fieldsOf(r.trigger).find((f) => f.key === c.field)?.label ?? c.field} ${meta?.ops.find((o) => o.id === c.op)?.label ?? c.op} "${c.value}"`).join(" and ")}. ` : "Always. "}
                                    Then {r.actions.map(describe).join(", then ")}.
                                </div>
                                {preview?.id === r.id ? (
                                    <div className="mt-1 rounded-md bg-muted/40 p-2 text-xs">
                                        <div>{preview.p.note}</div>
                                        {preview.p.actions.map((a, i) => <div key={i}>Would: {a}</div>)}
                                        {preview.p.sample ? <div className="mt-1 text-muted-foreground">Newest event: {Object.entries(preview.p.sample).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join(" · ")}</div> : null}
                                    </div>
                                ) : null}
                            </li>
                        ))}
                    </ul>

                    {runs.length ? (
                        <details className="text-sm">
                            <summary className="cursor-pointer text-muted-foreground">What workflows did recently ({runs.length})</summary>
                            <ul className="mt-2 grid gap-1.5">
                                {runs.map((r) => (
                                    <li key={r.id} className="flex flex-wrap items-baseline gap-2">
                                        <span className="text-xs text-muted-foreground">{new Date(r.at).toLocaleString()}</span>
                                        <Pill tone={r.outcome === "done" ? "good" : r.outcome === "skipped" ? "neutral" : "bad"}>{r.outcome}</Pill>
                                        <span className="font-medium">{r.rule}</span>
                                        <span className="text-muted-foreground">{r.detail}{r.steps.length ? ` · ${r.steps.map((s) => `${s.ok ? "✓" : "✗"} ${s.text}`).join(" · ")}` : ""}</span>
                                    </li>
                                ))}
                            </ul>
                        </details>
                    ) : null}
                </div>
            </AdminSection>
        </TabsContent>
    );
}
