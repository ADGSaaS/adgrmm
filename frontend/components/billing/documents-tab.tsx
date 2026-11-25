// components/billing/documents-tab.tsx
"use client";

import * as React from "react";
import { ArrowRightLeft, Clock, Download, Plus, Send, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/use-toast";
import { fetchCustomers, type CustomerClient } from "@/lib/api";
import { billing, billingUrl, fromCents, money, toCents, type BillingDocument, type CatalogItem } from "@/lib/billing-api";
import { LOAD_CAP, Pager, usePaged, useAutoLoadMore } from "@/components/pager";
import { EmptyState, ListToolbar, SegmentedTabs } from "@/components/list-controls";
import { errorText, NativeSelect, StatusPill } from "./shared";

type DraftLine = { key: number; description: string; quantity: string; price: string; taxable: boolean };

let nextKey = 1;
const blankLine = (): DraftLine => ({ key: nextKey++, description: "", quantity: "1", price: "", taxable: true });

function Editor({
    kind,
    initial,
    onClose,
    onSaved,
}: {
    kind: "invoice" | "quote";
    initial: BillingDocument | null;
    onClose: () => void;
    onSaved: () => void;
}) {
    const [clients, setClients] = React.useState<CustomerClient[]>([]);
    const [catalog, setCatalog] = React.useState<CatalogItem[]>([]);
    const [clientId, setClientId] = React.useState(initial?.client.id ?? "");
    const [email, setEmail] = React.useState(initial?.recipientEmail ?? "");
    const [notes, setNotes] = React.useState(initial?.notes ?? "");
    const [lines, setLines] = React.useState<DraftLine[]>(() =>
        initial?.lines?.length
            ? initial.lines.map((l) => ({ key: nextKey++, description: l.description, quantity: String(l.quantity), price: fromCents(l.unitPriceCents), taxable: l.taxable }))
            : [blankLine()]
    );
    const [saving, setSaving] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);

    React.useEffect(() => {
        fetchCustomers().then(setClients).catch(() => setClients([]));
        billing.catalog().then((r) => setCatalog(r.items.filter((i) => i.active))).catch(() => setCatalog([]));
    }, []);

    const patch = (key: number, change: Partial<DraftLine>) => setLines((all) => all.map((l) => (l.key === key ? { ...l, ...change } : l)));

    const subtotal = lines.reduce((sum, l) => sum + Math.round((Number(l.quantity) || 0) * (toCents(l.price) ?? 0)), 0);

    const save = async (event: React.FormEvent) => {
        event.preventDefault();
        setError(null);
        const prepared = [];
        for (const [i, l] of lines.entries()) {
            const cents = toCents(l.price);
            const quantity = Number(l.quantity);
            if (!l.description.trim()) return setError(`Line ${i + 1} needs a description.`);
            if (!(quantity > 0)) return setError(`Line ${i + 1} needs a quantity above zero.`);
            if (cents === null) return setError(`Line ${i + 1} needs a price, like 125.00.`);
            prepared.push({ description: l.description, quantity, unitPriceCents: cents, taxable: l.taxable });
        }
        if (!clientId) return setError("Choose a customer.");

        const body: Record<string, unknown> = { kind, clientId, lines: prepared, ...(email.trim() ? { recipientEmail: email.trim() } : {}), ...(notes.trim() ? { notes } : {}) };
        setSaving(true);
        try {
            if (initial) await billing.updateDocument(initial.id, body);
            else await billing.createDocument(body);
            onSaved();
        } catch (e) {
            setError(errorText(e));
        } finally {
            setSaving(false);
        }
    };

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-h-[90dvh] max-w-3xl overflow-y-auto">
                <DialogHeader>
                    <DialogTitle>{initial ? "Edit draft" : kind === "quote" ? "New quote" : "New invoice"}</DialogTitle>
                    <DialogDescription>It stays a draft until you send it. Tax is added using the rate in billing settings.</DialogDescription>
                </DialogHeader>
                <form onSubmit={save} className="grid gap-4">
                    <div className="grid gap-3 sm:grid-cols-2">
                        <div className="grid gap-2">
                            <Label htmlFor="doc-client">Customer</Label>
                            <NativeSelect id="doc-client" value={clientId} onChange={(e) => setClientId(e.target.value)}>
                                <option value="">Choose a customer</option>
                                {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                            </NativeSelect>
                        </div>
                        <div className="grid gap-2">
                            <Label htmlFor="doc-email">Send to</Label>
                            <Input id="doc-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="billing@customer.com" />
                        </div>
                    </div>

                    <div className="grid gap-2">
                        <div className="flex items-center justify-between gap-2">
                            <Label>Lines</Label>
                            {catalog.length > 0 && (
                                <NativeSelect
                                    aria-label="Add from catalog"
                                    className="max-w-56"
                                    value=""
                                    onChange={(e) => {
                                        const item = catalog.find((i) => i.id === e.target.value);
                                        if (item) setLines((all) => [...all.filter((l) => l.description || l.price), { ...blankLine(), description: item.name, price: fromCents(item.unitPriceCents), taxable: item.taxable }]);
                                    }}
                                >
                                    <option value="">Add from catalog</option>
                                    {catalog.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
                                </NativeSelect>
                            )}
                        </div>
                        {lines.map((line) => (
                            <div key={line.key} className="grid grid-cols-[1fr_4.5rem_6.5rem_auto_auto] items-center gap-2">
                                <Input aria-label="Description" value={line.description} onChange={(e) => patch(line.key, { description: e.target.value })} placeholder="Description" />
                                <Input aria-label="Quantity" inputMode="decimal" value={line.quantity} onChange={(e) => patch(line.key, { quantity: e.target.value })} />
                                <Input aria-label="Price" inputMode="decimal" value={line.price} onChange={(e) => patch(line.key, { price: e.target.value })} placeholder="0.00" />
                                <label className="flex items-center gap-1 text-xs text-muted-foreground">
                                    <Checkbox checked={line.taxable} onCheckedChange={(v) => patch(line.key, { taxable: v === true })} /> Tax
                                </label>
                                <Button type="button" variant="ghost" size="icon" aria-label="Remove line" disabled={lines.length === 1} onClick={() => setLines((all) => all.filter((l) => l.key !== line.key))}>
                                    <X className="h-4 w-4" />
                                </Button>
                            </div>
                        ))}
                        <div className="flex items-center justify-between">
                            <Button type="button" variant="outline" size="sm" onClick={() => setLines((all) => [...all, blankLine()])}><Plus className="mr-1 h-4 w-4" /> Add line</Button>
                            <span className="text-sm tabular-nums text-muted-foreground">Before tax: {money(subtotal)}</span>
                        </div>
                    </div>

                    <div className="grid gap-2">
                        <Label htmlFor="doc-notes">Notes for the customer</Label>
                        <Textarea id="doc-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
                    </div>

                    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
                        <Button type="submit" disabled={saving}>{saving ? "Saving..." : "Save draft"}</Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

function Details({ id, onClose, onChanged, onEdit }: { id: string; onClose: () => void; onChanged: () => void; onEdit: (doc: BillingDocument) => void }) {
    const [doc, setDoc] = React.useState<BillingDocument | null>(null);
    const [to, setTo] = React.useState("");
    const [amount, setAmount] = React.useState("");
    const [method, setMethod] = React.useState("check");
    const [reference, setReference] = React.useState("");
    const [busy, setBusy] = React.useState(false);

    const load = React.useCallback(() => {
        billing.document(id).then((d) => {
            setDoc(d);
            setTo((current) => current || d.recipientEmail || "");
            setAmount(fromCents(d.totalCents - d.paidCents));
        }).catch((e) => toast({ title: "Could not open it", description: errorText(e), variant: "destructive" }));
    }, [id]);
    React.useEffect(load, [load]);

    const act = async (fn: () => Promise<unknown>, done?: string) => {
        setBusy(true);
        try {
            await fn();
            if (done) toast({ title: done });
            load();
            onChanged();
        } catch (e) {
            toast({ title: "That did not work", description: errorText(e), variant: "destructive" });
        } finally {
            setBusy(false);
        }
    };

    if (!doc) return null;
    const noun = doc.kind === "quote" ? "quote" : "invoice";
    const balance = doc.totalCents - doc.paidCents;
    const canPay = doc.kind === "invoice" && (doc.status === "sent" || doc.status === "partial");

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-h-[90dvh] max-w-2xl overflow-y-auto">
                <DialogHeader>
                    <DialogTitle className="flex flex-wrap items-center gap-2">
                        {doc.number ?? `Draft ${noun}`} <StatusPill status={doc.overdue ? "overdue" : doc.status} />
                    </DialogTitle>
                    <DialogDescription>
                        {doc.client.name}
                        {doc.dueDate && doc.kind === "invoice" ? `, due ${doc.dueDate}` : ""}
                        {doc.periodStart ? `, for ${doc.periodStart} to ${doc.periodEnd}` : ""}
                    </DialogDescription>
                </DialogHeader>

                <table className="w-full text-sm">
                    <thead className="text-left text-xs text-muted-foreground">
                        <tr><th className="py-1 font-medium">Description</th><th className="py-1 text-right font-medium">Qty</th><th className="py-1 text-right font-medium">Price</th><th className="py-1 text-right font-medium">Amount</th></tr>
                    </thead>
                    <tbody>
                        {doc.lines?.map((l) => (
                            <tr key={l.id} className="border-t border-border">
                                <td className="py-1.5 pr-2">{l.description}</td>
                                <td className="py-1.5 text-right tabular-nums">{l.quantity}</td>
                                <td className="py-1.5 text-right tabular-nums">{money(l.unitPriceCents, doc.currency)}</td>
                                <td className="py-1.5 text-right tabular-nums">{money(l.amountCents ?? 0, doc.currency)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
                <dl className="ml-auto grid w-56 grid-cols-2 gap-1 text-sm tabular-nums">
                    <dt className="text-muted-foreground">Subtotal</dt><dd className="text-right">{money(doc.subtotalCents, doc.currency)}</dd>
                    <dt className="text-muted-foreground">Tax</dt><dd className="text-right">{money(doc.taxCents, doc.currency)}</dd>
                    <dt className="font-medium">Total</dt><dd className="text-right font-medium">{money(doc.totalCents, doc.currency)}</dd>
                    {doc.paidCents > 0 && <><dt className="text-muted-foreground">Paid</dt><dd className="text-right">{money(doc.paidCents, doc.currency)}</dd></>}
                </dl>

                {doc.status !== "void" && doc.status !== "paid" && doc.status !== "declined" && (
                    <div className="flex flex-wrap items-end gap-2 border-t border-border pt-3">
                        <div className="grid min-w-52 flex-1 gap-1">
                            <Label htmlFor="send-to">{doc.status === "draft" ? "Send to" : "Send again to"}</Label>
                            <Input id="send-to" type="email" value={to} onChange={(e) => setTo(e.target.value)} placeholder="billing@customer.com" />
                        </div>
                        <Button
                            disabled={busy || !to.trim()}
                            onClick={() =>
                                act(async () => {
                                    const result = await billing.send(doc.id, to.trim());
                                    if (result.emailed) toast({ title: `Sent ${result.number}` });
                                    else toast({ title: `${result.number} is numbered, but the email failed`, description: result.emailError ?? undefined, variant: "destructive" });
                                })
                            }
                        >
                            <Send className="mr-1 h-4 w-4" /> Send
                        </Button>
                    </div>
                )}

                {canPay && (
                    <div className="grid gap-2 border-t border-border pt-3">
                        <h3 className="text-sm font-medium">Record a payment (balance {money(balance, doc.currency)})</h3>
                        <div className="flex flex-wrap items-center gap-2">
                            <Input aria-label="Amount" className="w-28" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
                            <NativeSelect aria-label="Method" className="w-32" value={method} onChange={(e) => setMethod(e.target.value)}>
                                <option value="check">Check</option>
                                <option value="transfer">Transfer</option>
                                <option value="card">Card</option>
                                <option value="cash">Cash</option>
                                <option value="other">Other</option>
                            </NativeSelect>
                            <Input aria-label="Reference" className="min-w-32 flex-1" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Check number" />
                            <Button
                                variant="outline"
                                disabled={busy}
                                onClick={() => {
                                    const cents = toCents(amount);
                                    if (cents === null || cents <= 0) return toast({ title: "Enter an amount above zero", variant: "destructive" });
                                    void act(() => billing.pay(doc.id, { amountCents: cents, method, ...(reference.trim() ? { reference: reference.trim() } : {}) }), "Payment recorded");
                                    setReference("");
                                }}
                            >
                                Record
                            </Button>
                        </div>
                    </div>
                )}

                {!!doc.payments?.length && (
                    <ul className="grid gap-1 border-t border-border pt-3 text-sm">
                        {doc.payments.map((p) => (
                            <li key={p.id} className="flex items-center justify-between gap-2">
                                <span>{new Date(p.paidAt).toLocaleDateString()}: {money(p.amountCents, doc.currency)} by {p.method}{p.reference ? ` (${p.reference})` : ""}</span>
                                {p.method !== "stripe" && (
                                    <Button variant="ghost" size="icon" aria-label="Remove payment" disabled={busy} onClick={() => act(() => billing.removePayment(doc.id, p.id))}>
                                        <Trash2 className="h-4 w-4" />
                                    </Button>
                                )}
                            </li>
                        ))}
                    </ul>
                )}

                <DialogFooter className="flex-wrap gap-2 sm:justify-between">
                    <div className="flex flex-wrap gap-2">
                        <Button asChild variant="outline" size="sm">
                            <a href={billingUrl(`/api/billing/invoices/${doc.id}/pdf`)}><Download className="mr-1 h-4 w-4" /> PDF</a>
                        </Button>
                        {doc.status === "draft" && <Button variant="outline" size="sm" onClick={() => onEdit(doc)}>Edit</Button>}
                        {doc.status === "draft" && doc.kind === "invoice" && (
                            <Button
                                variant="outline"
                                size="sm"
                                disabled={busy}
                                onClick={() =>
                                    act(async () => {
                                        const r = await billing.addTime(doc.id);
                                        toast({ title: r.added ? `Added ${r.hours} hours` : "No approved time is waiting to be billed" });
                                    })
                                }
                            >
                                <Clock className="mr-1 h-4 w-4" /> Add unbilled time
                            </Button>
                        )}
                        {doc.kind === "quote" && (doc.status === "sent" || doc.status === "accepted") && (
                            <Button variant="outline" size="sm" disabled={busy} onClick={() => act(() => billing.convert(doc.id), "Draft invoice created")}>
                                <ArrowRightLeft className="mr-1 h-4 w-4" /> Make invoice
                            </Button>
                        )}
                    </div>
                    <div className="flex flex-wrap gap-2">
                        {doc.status === "draft" && (
                            <Button
                                variant="ghost"
                                size="sm"
                                className="text-destructive"
                                disabled={busy}
                                onClick={async () => {
                                    if (!window.confirm(`Delete this draft ${noun}?`)) return;
                                    await act(() => billing.deleteDocument(doc.id), "Draft deleted");
                                    onClose();
                                }}
                            >
                                Delete
                            </Button>
                        )}
                        {doc.status !== "draft" && doc.status !== "void" && doc.paidCents === 0 && (
                            <Button
                                variant="ghost"
                                size="sm"
                                className="text-destructive"
                                disabled={busy}
                                onClick={() => {
                                    if (window.confirm(`Void ${doc.number}? The customer's link stops working and its time goes back to unbilled.`)) void act(() => billing.voidDocument(doc.id), "Voided");
                                }}
                            >
                                Void
                            </Button>
                        )}
                    </div>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

export default function DocumentsTab({ kind }: { kind: "invoice" | "quote" }) {
    const [items, setItems] = React.useState<BillingDocument[] | null>(null);
    const [cursor, setCursor] = React.useState<string | null>(null);
    const [loadingMore, setLoadingMore] = React.useState(false);
    const [status, setStatus] = React.useState("");
    const [error, setError] = React.useState<string | null>(null);
    const [openId, setOpenId] = React.useState<string | null>(null);
    const [editing, setEditing] = React.useState<BillingDocument | "new" | null>(null);
    // Each fresh load bumps this, so a "next piece" that was still on its way for an older filter is dropped.
    const generation = React.useRef(0);

    const load = React.useCallback(() => {
        const mine = ++generation.current;
        setLoadingMore(false);
        billing.documents(kind, { status: status || undefined, limit: 200 }).then((r) => {
            if (mine !== generation.current) return;
            setItems(r.items);
            setCursor(r.nextCursor);
            setError(null);
        }).catch((e) => { if (mine === generation.current) setError(errorText(e)); });
    }, [kind, status]);
    React.useEffect(load, [load]);

    const loadMore = () => {
        if (!cursor) return;
        const mine = generation.current;
        setLoadingMore(true);
        billing.documents(kind, { status: status || undefined, cursor, limit: 200 }).then((r) => {
            if (mine !== generation.current) return;
            setItems((all) => [...(all ?? []), ...r.items]);
            setCursor(r.nextCursor);
            setLoadingMore(false);
        }).catch((e) => {
            if (mine !== generation.current) return;
            setCursor(null);
            setLoadingMore(false);
            setError(errorText(e));
        });
    };
    useAutoLoadMore(cursor, loadingMore, items?.length ?? 0, loadMore);

    const paged = usePaged(items ?? [], `billing-${kind}`);
    const statuses = kind === "quote" ? ["draft", "sent", "accepted", "declined", "void"] : ["draft", "sent", "partial", "paid", "void"];

    return (
        <div className="grid gap-3">
            <ListToolbar
                left={
                    <SegmentedTabs
                        label="Filter by status"
                        items={[{ key: "", label: "All" }, ...statuses.map((s) => ({ key: s, label: s[0].toUpperCase() + s.slice(1) }))]}
                        value={status}
                        onChange={setStatus}
                    />
                }
                right={<Button onClick={() => setEditing("new")}><Plus className="mr-1 h-4 w-4" /> New {kind}</Button>}
            />

            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            {items === null && !error && <p className="text-sm text-muted-foreground">Loading…</p>}
            {items?.length === 0 && !error && (
                <EmptyState>
                    {status ? `Nothing here with that status.` : kind === "quote" ? "No quotes yet." : "No invoices yet. Create one, or add a contract and drafts will appear here on its billing date."}
                </EmptyState>
            )}

            {!!items?.length && (
                <div className="overflow-x-auto rounded-xl border border-border/70 bg-card">
                    <table className="w-full min-w-[640px] text-sm">
                        <thead className="border-b border-border/70">
                            <tr className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                                <th className="px-5 py-3 text-left font-medium">Number</th>
                                <th className="px-5 py-3 text-left font-medium">Customer</th>
                                <th className="px-5 py-3 text-left font-medium">Status</th>
                                <th className="px-5 py-3 text-left font-medium">{kind === "quote" ? "Issued" : "Due"}</th>
                                <th className="px-5 py-3 text-right font-medium">Total</th>
                                {kind === "invoice" && <th className="px-5 py-3 text-right font-medium">Balance</th>}
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-border/60">
                            {paged.rows.map((d) => (
                                <tr key={d.id} className="hover:bg-accent">
                                    <td className="px-5 py-4 text-sm">
                                        <button type="button" className="font-medium underline-offset-2 hover:underline" onClick={() => setOpenId(d.id)}>
                                            {d.number ?? "Draft"}
                                        </button>
                                    </td>
                                    <td className="px-5 py-4 text-sm">{d.client.name}</td>
                                    <td className="px-5 py-4 text-sm"><StatusPill status={d.overdue ? "overdue" : d.status} /></td>
                                    <td className="px-5 py-4 text-sm tabular-nums">{(kind === "quote" ? d.issueDate : d.dueDate) ?? ""}</td>
                                    <td className="px-5 py-4 text-right text-sm tabular-nums">{money(d.totalCents, d.currency)}</td>
                                    {kind === "invoice" && <td className="px-5 py-4 text-right text-sm tabular-nums">{d.status === "void" ? "" : money(d.totalCents - d.paidCents, d.currency)}</td>}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {!!items?.length && <Pager paged={paged} noun={kind === "quote" ? "quotes" : "invoices"} />}
            {!!items?.length && !!cursor && items.length >= LOAD_CAP && <p className="text-xs text-muted-foreground">Showing the newest {LOAD_CAP}.</p>}

            {openId && <Details id={openId} onClose={() => setOpenId(null)} onChanged={load} onEdit={(d) => { setOpenId(null); setEditing(d); }} />}
            {editing && (
                <Editor
                    kind={kind}
                    initial={editing === "new" ? null : editing}
                    onClose={() => setEditing(null)}
                    onSaved={() => {
                        setEditing(null);
                        load();
                    }}
                />
            )}
        </div>
    );
}
