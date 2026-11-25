"use client";

// Custom fields for customers and for tickets: the extra things your team wants to record (an account manager and a
// contract number on a customer; a purchase order or a vendor case on a ticket). Customer fields appear on the
// customer's record under "Custom fields"; ticket fields on the new-ticket form and the ticket page.
import * as React from "react";
import { ArrowDown, ArrowUp, ListPlus, Pencil, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { jfetch } from "@/lib/api";
import type { ToastFn } from "../types";

type FieldType = "text" | "longtext" | "number" | "date" | "dropdown" | "checkbox" | "url";
type Def = { id: string; key: string; label: string; type: FieldType; options: string[]; required: boolean; help: string; active: boolean; visibleToCustomer?: boolean };
type Entity = "customer" | "ticket";
const BASE: Record<Entity, string> = { customer: "/api/custom-fields", ticket: "/api/ticket-custom-fields" };

const TYPES: [FieldType, string, string][] = [
    ["text", "Text", "A short line, such as a name or a number with letters"],
    ["longtext", "Long text", "Several lines"],
    ["number", "Number", "Seats, a budget, a count"],
    ["date", "Date", "A renewal or contract date"],
    ["dropdown", "Dropdown", "One of a list you choose"],
    ["checkbox", "Yes / no", "A box that is checked or not"],
    ["url", "Web address", "A link, such as a customer portal"],
];
const TYPE_NAME = Object.fromEntries(TYPES.map(([k, n]) => [k, n])) as Record<FieldType, string>;

const messageOf = (e: unknown) => {
    const raw = e instanceof Error ? e.message : "Something went wrong.";
    try { const j = JSON.parse(raw) as { message?: string | string[] }; return Array.isArray(j.message) ? j.message.join(" ") : j.message ?? raw; } catch { return raw; }
};

export default function CustomFieldsTab({ push }: { push: ToastFn }) {
    const [entity, setEntity] = React.useState<Entity>("customer");
    return (
        <div className="grid w-full min-w-0 gap-6">
            <div role="tablist" aria-label="What the fields are for" className="inline-flex w-fit rounded-lg border p-0.5 text-sm">
                {([["customer", "Customers"], ["ticket", "Tickets"]] as [Entity, string][]).map(([k, n]) => (
                    <button
                        key={k}
                        role="tab"
                        aria-selected={entity === k}
                        onClick={() => setEntity(k)}
                        className={`rounded-md px-4 py-1.5 font-medium ${entity === k ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
                    >
                        {n}
                    </button>
                ))}
            </div>
            <FieldsPanel key={entity} entity={entity} push={push} />
        </div>
    );
}

function FieldsPanel({ entity, push }: { entity: Entity; push: ToastFn }) {
    const base = BASE[entity];
    const noun = entity === "ticket" ? "ticket" : "customer";
    const [items, setItems] = React.useState<Def[] | null>(null);
    const [showArchived, setShowArchived] = React.useState(false);
    const [editing, setEditing] = React.useState<Def | "new" | null>(null);
    const [busy, setBusy] = React.useState(false);

    const load = React.useCallback(async () => {
        try {
            setItems((await jfetch<{ items: Def[] }>(`${base}?archived=true`)).items);
        } catch (e) {
            setItems([]);
            push({ title: "Could not load custom fields", desc: messageOf(e), kind: "destructive" });
        }
    }, [push, base]);

    React.useEffect(() => { void load(); }, [load]);

    if (!items) return <div className="p-4 text-sm text-muted-foreground">Loading…</div>;

    const active = items.filter((f) => f.active);
    const archived = items.filter((f) => !f.active);

    async function move(index: number, by: -1 | 1) {
        const ids = active.map((f) => f.id);
        const j = index + by;
        if (j < 0 || j >= ids.length) return;
        [ids[index], ids[j]] = [ids[j], ids[index]];
        setBusy(true);
        try {
            await jfetch(`${base}/reorder`, { method: "POST", body: { ids } });
            await load();
        } catch (e) {
            push({ title: "Could not reorder", desc: messageOf(e), kind: "destructive" });
        } finally {
            setBusy(false);
        }
    }

    async function setActive(f: Def, on: boolean) {
        if (!on && !window.confirm(`Archive "${f.label}"? It disappears from ${noun === "ticket" ? "tickets" : "customer records"}. What people saved in it is kept, and comes back if you restore the field.`)) return;
        setBusy(true);
        try {
            if (on) await jfetch(`${base}/${f.id}`, { method: "PATCH", body: { active: true } });
            else await jfetch(`${base}/${f.id}`, { method: "DELETE" });
            await load();
        } catch (e) {
            push({ title: on ? "Could not restore" : "Could not archive", desc: messageOf(e), kind: "destructive" });
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="grid gap-4">
            <div>
                <h2 className="flex items-center gap-2 text-xl font-semibold tracking-tight"><ListPlus className="h-5 w-5" aria-hidden /> Custom fields for {noun === "ticket" ? "tickets" : "customers"}</h2>
                {entity === "customer" ? (
                    <p className="mt-1 text-sm text-muted-foreground">
                        Extra things your team wants to record about each customer, such as an account manager, a contract number or a renewal date. They appear on a customer&apos;s record under <b>Custom fields</b>.
                        People who can edit customers fill them in; you decide which are required.
                    </p>
                ) : (
                    <p className="mt-1 text-sm text-muted-foreground">
                        Extra things your team wants to record on each ticket, such as a purchase order, a vendor case or a warranty date. They are filled in on the new-ticket form and on the ticket page,
                        can be searched and used to filter the ticket list, are included in the ticket export and the <b>Tickets with custom fields</b> report, and changes are written to the ticket&apos;s history.
                        A required field must be filled in when a ticket is created from the form; tickets opened by the system (alerts) and by customers are not blocked by it.
                        A field marked <b>Visible to the customer</b> is shown, read only, on the ticket in the client portal.
                    </p>
                )}
            </div>

            <div className="flex flex-wrap items-center gap-3">
                <Button size="sm" onClick={() => setEditing("new")}><Plus className="mr-1.5 h-4 w-4" aria-hidden /> New field</Button>
                {archived.length > 0 ? (
                    <label className="flex items-center gap-2 text-sm">
                        <input type="checkbox" className="h-4 w-4 shrink-0 rounded border-input accent-primary" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show archived ({archived.length})
                    </label>
                ) : null}
            </div>

            {active.length === 0 ? (
                <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">No custom fields yet. Add one, for example {entity === "ticket" ? <>&ldquo;Purchase order&rdquo; or &ldquo;Warranty ends&rdquo;</> : <>&ldquo;Account manager&rdquo; or &ldquo;Contract renewal date&rdquo;</>}.</p>
            ) : (
                <div className="overflow-x-auto rounded-lg border">
                    <table className="w-full min-w-[640px] text-sm">
                        <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                            <tr><th className="p-2 font-medium">Field</th><th className="p-2 font-medium">Type</th><th className="p-2 font-medium">Required</th>{entity === "ticket" ? <th className="p-2 font-medium">Customer sees it</th> : null}<th className="p-2" /></tr>
                        </thead>
                        <tbody className="divide-y">
                            {active.map((f, i) => (
                                <tr key={f.id}>
                                    <td className="p-2">
                                        <div className="font-medium">{f.label}</div>
                                        {f.help ? <div className="text-xs text-muted-foreground">{f.help}</div> : null}
                                    </td>
                                    <td className="p-2">
                                        {TYPE_NAME[f.type]}
                                        {f.type === "dropdown" ? <div className="max-w-[18rem] truncate text-xs text-muted-foreground" title={f.options.join(", ")}>{f.options.join(", ")}</div> : null}
                                    </td>
                                    <td className="p-2">{f.required ? "Yes" : "No"}</td>
                                    {entity === "ticket" ? <td className="p-2">{f.visibleToCustomer ? "Yes" : "No"}</td> : null}
                                    <td className="p-2">
                                        <div className="flex justify-end gap-1">
                                            <Button size="icon" variant="ghost" aria-label={`Move ${f.label} up`} disabled={busy || i === 0} onClick={() => void move(i, -1)}><ArrowUp className="h-4 w-4" /></Button>
                                            <Button size="icon" variant="ghost" aria-label={`Move ${f.label} down`} disabled={busy || i === active.length - 1} onClick={() => void move(i, 1)}><ArrowDown className="h-4 w-4" /></Button>
                                            <Button size="icon" variant="ghost" aria-label={`Edit ${f.label}`} onClick={() => setEditing(f)}><Pencil className="h-4 w-4" /></Button>
                                            <Button size="sm" variant="outline" disabled={busy} onClick={() => void setActive(f, false)}>Archive</Button>
                                        </div>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {showArchived && archived.length > 0 ? (
                <div className="rounded-xl border border-border/70 bg-card p-5 shadow-sm">
                    <div className="mb-1 text-sm font-medium">Archived</div>
                    <ul className="divide-y text-sm">
                        {archived.map((f) => (
                            <li key={f.id} className="flex items-center justify-between gap-2 py-1.5">
                                <span>{f.label} <span className="text-xs text-muted-foreground">({TYPE_NAME[f.type]})</span></span>
                                <Button size="sm" variant="outline" disabled={busy} onClick={() => void setActive(f, true)}>Restore</Button>
                            </li>
                        ))}
                    </ul>
                </div>
            ) : null}

            <FieldDialog
                entity={entity}
                editing={editing}
                onClose={() => setEditing(null)}
                onSaved={async () => { setEditing(null); await load(); }}
                push={push}
            />
        </div>
    );
}

function FieldDialog({ entity, editing, onClose, onSaved, push }: { entity: Entity; editing: Def | "new" | null; onClose: () => void; onSaved: () => Promise<void>; push: ToastFn }) {
    const isNew = editing === "new";
    const base = BASE[entity];
    const [visible, setVisible] = React.useState(false);
    const [label, setLabel] = React.useState("");
    const [type, setType] = React.useState<FieldType>("text");
    const [options, setOptions] = React.useState("");
    const [required, setRequired] = React.useState(false);
    const [help, setHelp] = React.useState("");
    const [saving, setSaving] = React.useState(false);
    const [tried, setTried] = React.useState(false);

    React.useEffect(() => {
        if (!editing) return;
        setTried(false);
        if (editing === "new") {
            setLabel(""); setType("text"); setOptions(""); setRequired(false); setHelp(""); setVisible(false);
        } else {
            setLabel(editing.label); setType(editing.type); setOptions(editing.options.join("\n")); setRequired(editing.required); setHelp(editing.help); setVisible(editing.visibleToCustomer === true);
        }
    }, [editing]);

    const labelOk = label.trim().length > 0;
    const optionsOk = type !== "dropdown" || options.split(/\r?\n/).some((o) => o.trim());

    async function save() {
        setTried(true);
        if (!labelOk || !optionsOk) return;
        setSaving(true);
        try {
            const body = { label, options, required, help, ...(entity === "ticket" ? { visibleToCustomer: visible } : {}) };
            if (isNew) await jfetch(base, { method: "POST", body: { ...body, type } });
            else await jfetch(`${base}/${(editing as Def).id}`, { method: "PATCH", body });
            push({ title: isNew ? "Field added" : "Field saved", kind: "success" });
            await onSaved();
        } catch (e) {
            push({ title: "Could not save the field", desc: messageOf(e), kind: "destructive" });
        } finally {
            setSaving(false);
        }
    }

    return (
        <Dialog open={!!editing} onOpenChange={(o) => { if (!o) onClose(); }}>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle>{isNew ? "New custom field" : "Edit custom field"}</DialogTitle>
                    <DialogDescription>Shown on every {entity === "ticket" ? "ticket" : "customer's record"}. {isNew ? "" : "The type cannot be changed once a field is made, because values are already saved in it. Archive it and make a new one instead."}</DialogDescription>
                </DialogHeader>
                <div className="grid gap-3">
                    <div className="grid gap-1">
                        <Label htmlFor="cfd-label" className={tried && !labelOk ? "text-destructive" : ""}>Name</Label>
                        <Input id="cfd-label" value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} aria-invalid={tried && !labelOk} placeholder={entity === "ticket" ? "For example: Purchase order" : "For example: Account manager"} autoFocus />
                    </div>
                    <div className="grid gap-1">
                        <Label htmlFor="cfd-type">Type</Label>
                        <select id="cfd-type" value={type} disabled={!isNew} onChange={(e) => setType(e.target.value as FieldType)} className="h-10 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                            {TYPES.map(([k, n, d]) => <option key={k} value={k}>{n} - {d}</option>)}
                        </select>
                    </div>
                    {type === "dropdown" ? (
                        <div className="grid gap-1">
                            <Label htmlFor="cfd-options" className={tried && !optionsOk ? "text-destructive" : ""}>Choices (one per line)</Label>
                            <Textarea id="cfd-options" rows={5} value={options} onChange={(e) => setOptions(e.target.value)} aria-invalid={tried && !optionsOk} placeholder={"Gold\nSilver\nBronze"} />
                            {!isNew ? <p className="text-xs text-muted-foreground">A choice you remove stays on customers that already have it, but can no longer be picked.</p> : null}
                        </div>
                    ) : null}
                    <div className="grid gap-1">
                        <Label htmlFor="cfd-help">Help text <span className="font-normal text-muted-foreground">(optional)</span></Label>
                        <Input id="cfd-help" value={help} maxLength={200} onChange={(e) => setHelp(e.target.value)} placeholder="Shown under the box" />
                    </div>
                    <label className="flex items-start gap-2 text-sm">
                        <input type="checkbox" className="h-4 w-4 shrink-0 rounded border-input accent-primary" checked={required} onChange={(e) => setRequired(e.target.checked)} />
                        <span>Required <span className="text-xs text-muted-foreground">({entity === "ticket" ? "a ticket cannot be created from the form without it" : "a customer cannot be saved without it"}{type === "checkbox" ? ", and the box must be checked" : ""})</span></span>
                    </label>
                    {entity === "ticket" ? (
                        <label className="flex items-start gap-2 text-sm">
                            <input type="checkbox" className="h-4 w-4 shrink-0 rounded border-input accent-primary" checked={visible} onChange={(e) => setVisible(e.target.checked)} />
                            <span>Visible to the customer <span className="text-xs text-muted-foreground">(shown, read only, on the ticket in the client portal when it has a value)</span></span>
                        </label>
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
