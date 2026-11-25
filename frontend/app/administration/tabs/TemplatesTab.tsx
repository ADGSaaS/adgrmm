"use client";

// Templates: starting points for new tickets, and the wording of the emails the system sends on its own (portal
// invitation and reset, alert notifications, invoices), with variables, a live preview and a test send.
// Canned responses and snippets (reply text typed into a ticket) are not repeated here: they live in the Ticketing tab.
import * as React from "react";
import { FileSignature, Pencil, Plus, Repeat, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { jfetch } from "@/lib/api";
import { TicketFieldInputs, useTicketFieldDefs, valuesFromSaved, valuesToBody, type FieldValues } from "@/components/tickets/ticket-custom-fields";
import type { ToastFn } from "../types";

const messageOf = (e: unknown) => {
    const raw = e instanceof Error ? e.message : "Something went wrong.";
    try { const j = JSON.parse(raw) as { message?: string | string[] }; return Array.isArray(j.message) ? j.message.join(" ") : j.message ?? raw; } catch { return raw; }
};

type Section = "tickets" | "emails";

export default function TemplatesTab({ push }: { push: ToastFn }) {
    const [section, setSection] = React.useState<Section>("tickets");
    return (
        <div className="grid w-full min-w-0 gap-6">
            <div>
                <h2 className="flex items-center gap-2 text-xl font-semibold tracking-tight"><FileSignature className="h-5 w-5" aria-hidden /> Templates</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                    Ticket templates save typing when the same kind of ticket comes up again and again. Email templates change the wording of what the system sends by itself.
                    Reply text that technicians insert into a ticket (canned responses and snippets) is managed in the{" "}
                    <a className="underline underline-offset-2" href="/administration?tab=ticketing">Ticketing tab</a>.
                </p>
            </div>
            <div role="tablist" aria-label="Kind of template" className="inline-flex w-fit rounded-lg border p-0.5 text-sm">
                {([["tickets", "Ticket templates"], ["emails", "Email templates"]] as [Section, string][]).map(([k, n]) => (
                    <button key={k} role="tab" aria-selected={section === k} onClick={() => setSection(k)} className={`rounded-md px-4 py-1.5 font-medium ${section === k ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>{n}</button>
                ))}
            </div>
            {section === "tickets" ? <TicketTemplates push={push} /> : <EmailTemplates push={push} />}
        </div>
    );
}

/* ------------------------------ ticket templates ------------------------------ */

type TicketTemplate = { id: string; name: string; hint: string; subject: string; body: string; priority: string; customFields: Record<string, unknown> };
const PRIORITIES = ["low", "medium", "high", "urgent"];

function TicketTemplates({ push }: { push: ToastFn }) {
    const [items, setItems] = React.useState<TicketTemplate[] | null>(null);
    const [editing, setEditing] = React.useState<TicketTemplate | "new" | null>(null);
    const defs = useTicketFieldDefs();

    const load = React.useCallback(async () => {
        try {
            setItems((await jfetch<{ items: TicketTemplate[] }>("/api/ticket-templates")).items);
        } catch (e) {
            setItems([]);
            push({ title: "Could not load ticket templates", desc: messageOf(e), kind: "destructive" });
        }
    }, [push]);
    React.useEffect(() => { void load(); }, [load]);

    async function remove(t: TicketTemplate) {
        if (!window.confirm(`Delete the template "${t.name}"? Tickets already made from it are not changed.`)) return;
        try {
            await jfetch(`/api/ticket-templates/${t.id}`, { method: "DELETE" });
            await load();
        } catch (e) {
            push({ title: "Could not delete", desc: messageOf(e), kind: "destructive" });
        }
    }

    if (!items) return <div className="p-4 text-sm text-muted-foreground">Loading…</div>;
    const fieldLabel = (key: string) => defs.find((d) => d.key === key)?.label ?? key;

    return (
        <div className="grid gap-3">
            <p className="text-sm text-muted-foreground">
                On the new-ticket form, people pick a template to fill in the subject, the description and the custom fields. They can change anything before creating the ticket.
            </p>
            <div><Button size="sm" onClick={() => setEditing("new")}><Plus className="mr-1.5 h-4 w-4" aria-hidden /> New ticket template</Button></div>
            {items.length === 0 ? (
                <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">No ticket templates yet. Add one, for example &ldquo;New starter&rdquo; or &ldquo;Password reset request&rdquo;.</p>
            ) : (
                <div className="overflow-x-auto rounded-lg border">
                    <table className="w-full min-w-[640px] text-sm">
                        <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                            <tr><th className="p-2 font-medium">Template</th><th className="p-2 font-medium">Subject</th><th className="p-2 font-medium">Priority</th><th className="p-2 font-medium">Custom fields</th><th className="p-2" /></tr>
                        </thead>
                        <tbody className="divide-y">
                            {items.map((t) => (
                                <tr key={t.id}>
                                    <td className="p-2"><div className="font-medium">{t.name}</div>{t.hint ? <div className="text-xs text-muted-foreground">{t.hint}</div> : null}</td>
                                    <td className="max-w-[18rem] truncate p-2" title={t.subject}>{t.subject || <span className="text-muted-foreground">(none)</span>}</td>
                                    <td className="p-2 capitalize">{t.priority}</td>
                                    <td className="p-2 text-xs">{Object.keys(t.customFields).map(fieldLabel).join(", ") || <span className="text-muted-foreground">none</span>}</td>
                                    <td className="p-2">
                                        <div className="flex justify-end gap-1">
                                            <Button size="icon" variant="ghost" asChild aria-label={`Make ${t.name} recurring`} title="Make recurring: open a ticket from this template on a schedule"><a href={`/administration?tab=recurring_tickets&template=${t.id}`}><Repeat className="h-4 w-4" /></a></Button>
                                            <Button size="icon" variant="ghost" aria-label={`Edit ${t.name}`} onClick={() => setEditing(t)}><Pencil className="h-4 w-4" /></Button>
                                            <Button size="icon" variant="ghost" aria-label={`Delete ${t.name}`} onClick={() => void remove(t)}><Trash2 className="h-4 w-4" /></Button>
                                        </div>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
            <TicketTemplateDialog editing={editing} defs={defs} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await load(); }} push={push} />
        </div>
    );
}

function TicketTemplateDialog({ editing, defs, onClose, onSaved, push }: { editing: TicketTemplate | "new" | null; defs: ReturnType<typeof useTicketFieldDefs>; onClose: () => void; onSaved: () => Promise<void>; push: ToastFn }) {
    const isNew = editing === "new";
    const [name, setName] = React.useState("");
    const [hint, setHint] = React.useState("");
    const [subject, setSubject] = React.useState("");
    const [body, setBody] = React.useState("");
    const [priority, setPriority] = React.useState("medium");
    const [values, setValues] = React.useState<FieldValues>({});
    const [saving, setSaving] = React.useState(false);
    const [tried, setTried] = React.useState(false);

    React.useEffect(() => {
        if (!editing) return;
        setTried(false);
        const t = editing === "new" ? null : editing;
        setName(t?.name ?? ""); setHint(t?.hint ?? ""); setSubject(t?.subject ?? ""); setBody(t?.body ?? ""); setPriority(t?.priority ?? "medium");
        setValues(valuesFromSaved(t?.customFields ?? {}, defs));
    }, [editing, defs]);

    const nameOk = name.trim().length > 0;

    async function save() {
        setTried(true);
        if (!nameOk) return;
        setSaving(true);
        try {
            const payload = { name, hint, subject, body, priority, customFields: valuesToBody(defs, values) };
            if (isNew) await jfetch("/api/ticket-templates", { method: "POST", body: payload });
            else await jfetch(`/api/ticket-templates/${(editing as TicketTemplate).id}`, { method: "PATCH", body: payload });
            push({ title: isNew ? "Template added" : "Template saved", kind: "success" });
            await onSaved();
        } catch (e) {
            push({ title: "Could not save the template", desc: messageOf(e), kind: "destructive" });
        } finally {
            setSaving(false);
        }
    }

    return (
        <Dialog open={!!editing} onOpenChange={(o) => { if (!o) onClose(); }}>
            <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
                <DialogHeader>
                    <DialogTitle>{isNew ? "New ticket template" : "Edit ticket template"}</DialogTitle>
                    <DialogDescription>What a new ticket starts with when someone picks this template.</DialogDescription>
                </DialogHeader>
                <div className="grid gap-3">
                    <div className="grid gap-1">
                        <Label htmlFor="tt-name" className={tried && !nameOk ? "text-destructive" : ""}>Name</Label>
                        <Input id="tt-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} aria-invalid={tried && !nameOk} placeholder="For example: New starter" autoFocus />
                    </div>
                    <div className="grid gap-1">
                        <Label htmlFor="tt-hint">Description <span className="font-normal text-muted-foreground">(optional, shown next to the name when picking)</span></Label>
                        <Input id="tt-hint" value={hint} maxLength={200} onChange={(e) => setHint(e.target.value)} />
                    </div>
                    <div className="grid gap-1">
                        <Label htmlFor="tt-subject">Subject</Label>
                        <Input id="tt-subject" value={subject} maxLength={300} onChange={(e) => setSubject(e.target.value)} placeholder="The ticket title" />
                    </div>
                    <div className="grid gap-1">
                        <Label htmlFor="tt-body">Description of the ticket</Label>
                        <Textarea id="tt-body" rows={6} value={body} onChange={(e) => setBody(e.target.value)} placeholder={"What the ticket should say, for example a checklist"} />
                    </div>
                    <div className="grid gap-1">
                        <Label htmlFor="tt-priority">Priority</Label>
                        <select id="tt-priority" value={priority} onChange={(e) => setPriority(e.target.value)} className="h-10 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                            {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
                        </select>
                    </div>
                    {defs.length > 0 ? (
                        <div className="grid gap-1">
                            <div className="text-sm font-medium">Custom fields <span className="font-normal text-muted-foreground">(leave empty to not fill in)</span></div>
                            <div className="rounded-md border p-3">
                                <TicketFieldInputs defs={defs.map((d) => ({ ...d, required: false }))} values={values} idPrefix="tt-cf" onChange={(k, v) => setValues((cur) => ({ ...cur, [k]: v }))} />
                            </div>
                        </div>
                    ) : null}
                </div>
                <DialogFooter>
                    <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
                    <Button onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

/* ------------------------------ email templates ------------------------------ */

type Variable = { name: string; description: string; sample: string };
type EmailTemplate = {
    key: string; label: string; description: string; purpose: string; variables: Variable[]; required: string[];
    subject: string; body: string; defaultSubject: string; defaultBody: string; customized: boolean;
};

function EmailTemplates({ push }: { push: ToastFn }) {
    const [items, setItems] = React.useState<EmailTemplate[] | null>(null);
    const [key, setKey] = React.useState<string>("");

    const load = React.useCallback(async () => {
        try {
            const r = (await jfetch<{ items: EmailTemplate[] }>("/api/admin/email-templates")).items;
            setItems(r);
            setKey((k) => k || r[0]?.key || "");
        } catch (e) {
            setItems([]);
            push({ title: "Could not load email templates", desc: messageOf(e), kind: "destructive" });
        }
    }, [push]);
    React.useEffect(() => { void load(); }, [load]);

    if (!items) return <div className="p-4 text-sm text-muted-foreground">Loading…</div>;
    const current = items.find((i) => i.key === key);

    return (
        <div className="grid gap-4 md:grid-cols-[14rem_1fr]">
            <ul className="grid content-start gap-1" aria-label="Emails">
                {items.map((i) => (
                    <li key={i.key}>
                        <button onClick={() => setKey(i.key)} aria-current={i.key === key} className={`w-full rounded-md border px-3 py-2 text-left text-sm ${i.key === key ? "border-primary bg-primary/5" : "hover:bg-muted/50"}`}>
                            <div className="font-medium">{i.label}</div>
                            <div className="text-xs text-muted-foreground">{i.customized ? "Edited" : "Built-in wording"}</div>
                        </button>
                    </li>
                ))}
            </ul>
            {current ? <EmailEditor key={current.key + current.customized} t={current} push={push} onChanged={load} /> : null}
        </div>
    );
}

function EmailEditor({ t, push, onChanged }: { t: EmailTemplate; push: ToastFn; onChanged: () => Promise<void> }) {
    const [subject, setSubject] = React.useState(t.subject);
    const [body, setBody] = React.useState(t.body);
    const [preview, setPreview] = React.useState<{ subject: string; body: string } | null>(null);
    const [problem, setProblem] = React.useState<string | null>(null);
    const [busy, setBusy] = React.useState(false);
    const [to, setTo] = React.useState("");
    const [testResult, setTestResult] = React.useState<{ ok: boolean; message: string } | null>(null);
    const subjectRef = React.useRef<HTMLInputElement>(null);
    const bodyRef = React.useRef<HTMLTextAreaElement>(null);
    const lastField = React.useRef<"subject" | "body">("body");

    const changed = subject !== t.subject || body !== t.body;

    // The preview follows what is typed, filled in with sample values by the server.
    React.useEffect(() => {
        let cancelled = false;
        const timer = window.setTimeout(async () => {
            try {
                const r = await jfetch<{ subject: string; body: string }>(`/api/admin/email-templates/${t.key}/preview`, { method: "POST", body: { subject, body } });
                if (cancelled) return;
                setPreview(r);
                setProblem(null);
            } catch (e) {
                if (!cancelled) setProblem(messageOf(e));
            }
        }, 250);
        return () => { cancelled = true; window.clearTimeout(timer); };
    }, [t.key, subject, body]);

    function insert(name: string) {
        const token = `{{${name}}}`;
        const useSubject = lastField.current === "subject";
        const el = useSubject ? subjectRef.current : bodyRef.current;
        const text = useSubject ? subject : body;
        const at = el?.selectionStart ?? text.length;
        const end = el?.selectionEnd ?? at;
        const next = text.slice(0, at) + token + text.slice(end);
        if (useSubject) setSubject(next); else setBody(next);
        requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(at + token.length, at + token.length); });
    }

    async function save() {
        setBusy(true);
        try {
            await jfetch(`/api/admin/email-templates/${t.key}`, { method: "PUT", body: { subject, body } });
            push({ title: `${t.label} saved`, kind: "success" });
            await onChanged();
        } catch (e) {
            push({ title: "Could not save", desc: messageOf(e), kind: "destructive" });
        } finally {
            setBusy(false);
        }
    }

    async function reset() {
        if (!window.confirm("Go back to the built-in wording? Your edits to this email are lost.")) return;
        setBusy(true);
        try {
            if (t.customized) await jfetch(`/api/admin/email-templates/${t.key}`, { method: "DELETE" });
            setSubject(t.defaultSubject);
            setBody(t.defaultBody);
            push({ title: "Built-in wording restored", kind: "success" });
            await onChanged();
        } catch (e) {
            push({ title: "Could not reset", desc: messageOf(e), kind: "destructive" });
        } finally {
            setBusy(false);
        }
    }

    async function sendTest() {
        setBusy(true);
        setTestResult(null);
        try {
            // What is on screen is sent, saved or not.
            setTestResult(await jfetch<{ ok: boolean; message: string }>(`/api/admin/email-templates/${t.key}/test`, { method: "POST", body: { to, subject, body } }));
        } catch (e) {
            setTestResult({ ok: false, message: messageOf(e) });
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="grid min-w-0 gap-4">
            <div>
                <h3 className="text-base font-semibold">{t.label}</h3>
                <p className="text-sm text-muted-foreground">{t.description} It goes out through the <b>{t.purpose.replace("_", " ")}</b> mailbox set up under Email.</p>
            </div>

            <div className="grid gap-1">
                <Label htmlFor="et-subject">Subject</Label>
                <Input id="et-subject" ref={subjectRef} value={subject} maxLength={200} onFocus={() => { lastField.current = "subject"; }} onChange={(e) => setSubject(e.target.value)} />
            </div>
            <div className="grid gap-1">
                <Label htmlFor="et-body">Text</Label>
                <Textarea id="et-body" ref={bodyRef} rows={11} value={body} className="font-mono text-sm" onFocus={() => { lastField.current = "body"; }} onChange={(e) => setBody(e.target.value)} />
            </div>

            <div>
                <div className="mb-1 text-sm font-medium">Variables <span className="font-normal text-muted-foreground">(click to put one where the cursor is)</span></div>
                <div className="flex flex-wrap gap-1.5">
                    {t.variables.map((v) => (
                        <button key={v.name} type="button" onClick={() => insert(v.name)} title={`${v.description}. For example: ${v.sample}`} className="rounded-full border px-2.5 py-0.5 font-mono text-xs hover:bg-muted">
                            {`{{${v.name}}}`}
                        </button>
                    ))}
                </div>
                {t.required.length > 0 ? <p className="mt-1 text-xs text-muted-foreground">Must include {t.required.map((r) => `{{${r}}}`).join(", ")}.</p> : null}
            </div>

            <div className="rounded-lg border bg-muted/20 p-3">
                <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Preview with sample values</div>
                {problem ? (
                    <p role="alert" className="text-sm text-destructive">{problem}</p>
                ) : preview ? (
                    <div className="grid gap-2 text-sm">
                        <div><span className="text-muted-foreground">Subject: </span><b>{preview.subject}</b></div>
                        <pre className="whitespace-pre-wrap break-words font-sans">{preview.body}</pre>
                    </div>
                ) : <p className="text-sm text-muted-foreground">Loading…</p>}
            </div>

            <div className="flex flex-wrap items-end gap-2">
                <div className="grid gap-1">
                    <Label htmlFor="et-to">Send a test to</Label>
                    <Input id="et-to" type="email" value={to} onChange={(e) => setTo(e.target.value)} placeholder="you@example.com" className="w-64" />
                </div>
                <Button variant="outline" onClick={() => void sendTest()} disabled={busy || !to.trim() || !!problem}>Send test</Button>
                <div className="ml-auto flex gap-2">
                    {t.customized || changed ? <Button variant="outline" onClick={() => void reset()} disabled={busy}>Use built-in wording</Button> : null}
                    <Button onClick={() => void save()} disabled={busy || !changed || !!problem}>{busy ? "Working…" : "Save"}</Button>
                </div>
            </div>
            {testResult ? <p role="status" className={`text-sm ${testResult.ok ? "text-green-600" : "text-destructive"}`}>{testResult.message}</p> : null}
        </div>
    );
}
