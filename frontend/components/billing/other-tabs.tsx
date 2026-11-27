// components/billing/other-tabs.tsx
"use client";

import * as React from "react";
import { Pager, usePaged } from "@/components/pager";
import { EmptyState, SegmentedTabs } from "@/components/list-controls";
import { Download, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/use-toast";
import { fetchCustomers, type CustomerClient } from "@/lib/api";
import {
    billing,
    billingUrl,
    fromCents,
    money,
    toCents,
    today,
    type BillingSettings,
    type CatalogItem,
    type Contract,
    type ContractKind,
    type ProfitRow,
    type TimeEntry,
} from "@/lib/billing-api";
import { errorText, NativeSelect, StatusPill } from "./shared";

const KIND_LABEL: Record<ContractKind, string> = {
    flat: "Flat fee",
    per_device: "Per device",
    per_user: "Per user",
    block_hours: "Block of hours",
    hourly: "Hourly",
};

const INTERVAL_LABEL: Record<number, string> = { 1: "Monthly", 3: "Quarterly", 6: "Twice a year", 12: "Yearly" };

function useCustomers() {
    const [clients, setClients] = React.useState<CustomerClient[]>([]);
    React.useEffect(() => {
        fetchCustomers().then(setClients).catch(() => setClients([]));
    }, []);
    return clients;
}

/* ---------------------------- contracts ---------------------------- */

function ContractEditor({ initial, onClose, onSaved }: { initial: Contract | null; onClose: () => void; onSaved: () => void }) {
    const clients = useCustomers();
    const [clientId, setClientId] = React.useState(initial?.client.id ?? "");
    const [name, setName] = React.useState(initial?.name ?? "");
    const [kind, setKind] = React.useState<ContractKind>(initial?.kind ?? "flat");
    const [status, setStatus] = React.useState<Contract["status"]>(initial?.status ?? "active");
    const [interval, setIntervalMonths] = React.useState(initial?.billingIntervalMonths ?? 1);
    const [startDate, setStartDate] = React.useState(initial?.startDate ?? today());
    const [endDate, setEndDate] = React.useState(initial?.endDate ?? "");
    const [nextDate, setNextDate] = React.useState(initial?.nextInvoiceDate ?? "");
    const [price, setPrice] = React.useState(fromCents(initial?.priceCents));
    const [quantity, setQuantity] = React.useState(initial?.quantity?.toString() ?? "");
    const [blockHours, setBlockHours] = React.useState(initial?.blockHours?.toString() ?? "");
    const [hourly, setHourly] = React.useState(fromCents(initial?.hourlyRateCents));
    const [overage, setOverage] = React.useState(fromCents(initial?.overageRateCents));
    const [taxable, setTaxable] = React.useState(initial?.taxable ?? true);
    const [error, setError] = React.useState<string | null>(null);
    const [saving, setSaving] = React.useState(false);

    const save = async (event: React.FormEvent) => {
        event.preventDefault();
        setError(null);
        if (!clientId) return setError("Choose a customer.");
        const priceCents = kind === "hourly" ? 0 : toCents(price);
        if (priceCents === null) return setError("Enter a price, like 75.00.");
        const hourlyCents = kind === "hourly" ? toCents(hourly) : null;
        if (kind === "hourly" && hourlyCents === null) return setError("Enter an hourly rate.");

        setSaving(true);
        try {
            await billing.saveContract(initial?.id ?? null, {
                clientId,
                name,
                kind,
                status,
                billingIntervalMonths: interval,
                startDate,
                ...(endDate ? { endDate } : {}),
                ...(nextDate ? { nextInvoiceDate: nextDate } : {}),
                priceCents,
                ...(kind === "per_user" ? { quantity: Number(quantity) } : {}),
                ...(kind === "block_hours" ? { blockHours: Number(blockHours), ...(overage ? { overageRateCents: toCents(overage) ?? 0 } : {}) } : {}),
                ...(kind === "hourly" ? { hourlyRateCents: hourlyCents } : {}),
                taxable,
            });
            onSaved();
        } catch (e) {
            setError(errorText(e));
        } finally {
            setSaving(false);
        }
    };

    const priceLabel = kind === "per_device" ? "Price per device" : kind === "per_user" ? "Price per user" : kind === "block_hours" ? "Price of the block" : "Price per period";

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-h-[90dvh] max-w-xl overflow-y-auto">
                <DialogHeader>
                    <DialogTitle>{initial ? "Edit contract" : "New contract"}</DialogTitle>
                    <DialogDescription>A draft invoice is created on each billing date, for you to check and send.</DialogDescription>
                </DialogHeader>
                <form onSubmit={save} className="grid gap-3">
                    <div className="grid gap-3 sm:grid-cols-2">
                        <div className="grid gap-1.5">
                            <Label htmlFor="c-client">Customer</Label>
                            <NativeSelect id="c-client" value={clientId} onChange={(e) => setClientId(e.target.value)}>
                                <option value="">Choose a customer</option>
                                {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                            </NativeSelect>
                        </div>
                        <div className="grid gap-1.5">
                            <Label htmlFor="c-name">Name</Label>
                            <Input id="c-name" required value={name} onChange={(e) => setName(e.target.value)} placeholder="Managed services" />
                        </div>
                        <div className="grid gap-1.5">
                            <Label htmlFor="c-kind">Type</Label>
                            <NativeSelect id="c-kind" value={kind} onChange={(e) => setKind(e.target.value as ContractKind)}>
                                {Object.entries(KIND_LABEL).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                            </NativeSelect>
                        </div>
                        <div className="grid gap-1.5">
                            <Label htmlFor="c-interval">Billed</Label>
                            <NativeSelect id="c-interval" value={interval} onChange={(e) => setIntervalMonths(Number(e.target.value))}>
                                {Object.entries(INTERVAL_LABEL).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                            </NativeSelect>
                        </div>
                        {kind !== "hourly" && (
                            <div className="grid gap-1.5">
                                <Label htmlFor="c-price">{priceLabel}</Label>
                                <Input id="c-price" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0.00" />
                            </div>
                        )}
                        {kind === "per_user" && (
                            <div className="grid gap-1.5">
                                <Label htmlFor="c-qty">Users covered</Label>
                                <Input id="c-qty" inputMode="decimal" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
                            </div>
                        )}
                        {kind === "block_hours" && (
                            <>
                                <div className="grid gap-1.5">
                                    <Label htmlFor="c-block">Hours included</Label>
                                    <Input id="c-block" inputMode="decimal" value={blockHours} onChange={(e) => setBlockHours(e.target.value)} />
                                </div>
                                <div className="grid gap-1.5">
                                    <Label htmlFor="c-over">Rate for extra hours</Label>
                                    <Input id="c-over" inputMode="decimal" value={overage} onChange={(e) => setOverage(e.target.value)} placeholder="0.00" />
                                </div>
                            </>
                        )}
                        {kind === "hourly" && (
                            <div className="grid gap-1.5">
                                <Label htmlFor="c-hourly">Hourly rate</Label>
                                <Input id="c-hourly" inputMode="decimal" value={hourly} onChange={(e) => setHourly(e.target.value)} placeholder="0.00" />
                            </div>
                        )}
                        <div className="grid gap-1.5">
                            <Label htmlFor="c-start">Starts</Label>
                            <Input id="c-start" type="date" required value={startDate} onChange={(e) => setStartDate(e.target.value)} />
                        </div>
                        <div className="grid gap-1.5">
                            <Label htmlFor="c-end">Ends (optional)</Label>
                            <Input id="c-end" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
                        </div>
                        <div className="grid gap-1.5">
                            <Label htmlFor="c-next">Next invoice</Label>
                            <Input id="c-next" type="date" value={nextDate} onChange={(e) => setNextDate(e.target.value)} />
                            <span className="text-xs text-muted-foreground">Blank means the start date. A date in the past creates one draft for each missed period.</span>
                        </div>
                        {initial && (
                            <div className="grid gap-1.5">
                                <Label htmlFor="c-status">Status</Label>
                                <NativeSelect id="c-status" value={status} onChange={(e) => setStatus(e.target.value as Contract["status"])}>
                                    <option value="active">Active</option>
                                    <option value="paused">Paused</option>
                                    <option value="ended">Ended</option>
                                </NativeSelect>
                            </div>
                        )}
                    </div>
                    <label className="flex items-center gap-2 text-sm">
                        <Checkbox checked={taxable} onCheckedChange={(v) => setTaxable(v === true)} /> Charge tax
                    </label>
                    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
                        <Button type="submit" disabled={saving}>{saving ? "Saving..." : "Save contract"}</Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

export function ContractsTab() {
    const [items, setItems] = React.useState<Contract[] | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [editing, setEditing] = React.useState<Contract | "new" | null>(null);
    const [busy, setBusy] = React.useState(false);

    const load = React.useCallback(() => {
        billing.contracts().then((r) => { setItems(r.items); setError(null); }).catch((e) => setError(errorText(e)));
    }, []);
    React.useEffect(load, [load]);
    const paged = usePaged(items ?? [], "billing-contracts", 25);

    return (
        <div className="grid gap-3">
            <div className="flex flex-wrap justify-end gap-2">
                <Button
                    variant="outline"
                    disabled={busy}
                    onClick={async () => {
                        setBusy(true);
                        try {
                            const r = await billing.runContracts();
                            toast({ title: r.created ? `Created ${r.created} draft invoice${r.created === 1 ? "" : "s"}` : "No contract is due today", ...(r.failed ? { description: `${r.failed} could not be billed. Check the server log.`, variant: "destructive" as const } : {}) });
                            load();
                        } catch (e) {
                            toast({ title: "That did not work", description: errorText(e), variant: "destructive" });
                        } finally {
                            setBusy(false);
                        }
                    }}
                >
                    <Play className="mr-1 h-4 w-4" /> Bill what is due now
                </Button>
                <Button onClick={() => setEditing("new")}><Plus className="mr-1 h-4 w-4" /> New contract</Button>
            </div>

            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            {items?.length === 0 && !error && <EmptyState>No contracts yet. Add one to bill a customer on a schedule.</EmptyState>}

            {!!items?.length && (
                <div className="overflow-x-auto rounded-xl border border-border/70 bg-card">
                    <table className="w-full min-w-[720px] text-sm">
                        <thead className="border-b border-border/70">
                            <tr>
                                <th className="px-5 py-3 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Contract</th>
                                <th className="px-5 py-3 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Customer</th>
                                <th className="px-5 py-3 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Type</th>
                                <th className="px-5 py-3 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Billed</th>
                                <th className="px-5 py-3 text-right text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Price</th>
                                <th className="px-5 py-3 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Next invoice</th>
                                <th className="px-5 py-3 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Status</th>
                                <th className="px-5 py-3 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground" />
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-border/60">
                            {paged.rows.map((c) => (
                                <tr key={c.id} className="hover:bg-accent">
                                    <td className="px-5 py-3 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{c.name}</td>
                                    <td className="px-5 py-4 text-sm">{c.client.name}</td>
                                    <td className="px-5 py-4 text-sm">{KIND_LABEL[c.kind]}</td>
                                    <td className="px-5 py-4 text-sm">{INTERVAL_LABEL[c.billingIntervalMonths] ?? `${c.billingIntervalMonths} months`}</td>
                                    <td className="px-5 py-4 text-sm text-right tabular-nums">{c.kind === "hourly" ? `${money(c.hourlyRateCents ?? 0)}/h` : money(c.priceCents)}</td>
                                    <td className="px-5 py-4 text-sm tabular-nums">{c.status === "active" ? c.nextInvoiceDate : ""}</td>
                                    <td className="px-5 py-4 text-sm"><StatusPill status={c.status} /></td>
                                    <td className="whitespace-nowrap px-5 py-2 text-right">
                                        <Button variant="ghost" size="icon" aria-label={`Edit ${c.name}`} onClick={() => setEditing(c)}><Pencil className="h-4 w-4" /></Button>
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            aria-label={`Delete ${c.name}`}
                                            onClick={() => {
                                                if (window.confirm(`Delete ${c.name}?`)) billing.deleteContract(c.id).then(load).catch((e) => toast({ title: "Could not delete it", description: errorText(e), variant: "destructive" }));
                                            }}
                                        >
                                            <Trash2 className="h-4 w-4" />
                                        </Button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
            {!!items?.length && <Pager paged={paged} noun="contracts" />}
            {editing && <ContractEditor initial={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
        </div>
    );
}

/* ---------------------------- time ---------------------------- */

function formatHours(minutes: number) {
    return `${(minutes / 60).toFixed(2)} h`;
}

export function TimeTab() {
    const clients = useCustomers();
    const [items, setItems] = React.useState<TimeEntry[] | null>(null);
    const [status, setStatus] = React.useState("pending");
    const [selected, setSelected] = React.useState<Set<string>>(new Set());
    const [error, setError] = React.useState<string | null>(null);

    const [date, setDate] = React.useState(today());
    const [clientId, setClientId] = React.useState("");
    const [hours, setHours] = React.useState("");
    const [note, setNote] = React.useState("");
    const [billable, setBillable] = React.useState(true);

    const load = React.useCallback(() => {
        billing.time({ status: status || undefined }).then((r) => { setItems(r.items); setSelected(new Set()); setError(null); }).catch((e) => setError(errorText(e)));
    }, [status]);
    React.useEffect(load, [load]);
    const paged = usePaged(items ?? [], "billing-time", 25);

    const add = async (event: React.FormEvent) => {
        event.preventDefault();
        const minutes = Math.round(Number(hours) * 60);
        if (!(minutes > 0)) return toast({ title: "Enter the hours worked, like 1.5", variant: "destructive" });
        try {
            await billing.createTime({ workDate: date, minutes, billable, ...(clientId ? { clientId } : {}), ...(note.trim() ? { note: note.trim() } : {}) });
            setHours("");
            setNote("");
            load();
        } catch (e) {
            toast({ title: "Could not log that", description: errorText(e), variant: "destructive" });
        }
    };

    const approve = (approved: boolean) =>
        billing.approveTime(Array.from(selected), approved).then(load).catch((e) => toast({ title: "That did not work", description: errorText(e), variant: "destructive" }));

    return (
        <div className="grid gap-4">
            <form onSubmit={add} className="grid items-end gap-2 rounded-xl border border-border/70 bg-card p-3 sm:grid-cols-[9rem_1fr_6rem_1.5fr_auto_auto]">
                <div className="grid gap-1"><Label htmlFor="t-date">Date</Label><Input id="t-date" type="date" required value={date} onChange={(e) => setDate(e.target.value)} /></div>
                <div className="grid gap-1">
                    <Label htmlFor="t-client">Customer</Label>
                    <NativeSelect id="t-client" value={clientId} onChange={(e) => setClientId(e.target.value)}>
                        <option value="">None</option>
                        {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </NativeSelect>
                </div>
                <div className="grid gap-1"><Label htmlFor="t-hours">Hours</Label><Input id="t-hours" inputMode="decimal" value={hours} onChange={(e) => setHours(e.target.value)} placeholder="1.5" /></div>
                <div className="grid gap-1"><Label htmlFor="t-note">Note</Label><Input id="t-note" value={note} onChange={(e) => setNote(e.target.value)} /></div>
                <label className="flex h-9 items-center gap-2 text-sm"><Checkbox checked={billable} onCheckedChange={(v) => setBillable(v === true)} /> Billable</label>
                <Button type="submit">Log time</Button>
            </form>

            <div className="flex flex-wrap items-center justify-between gap-2">
                <SegmentedTabs
                    label="Filter by status"
                    items={[{ key: "pending", label: "Waiting for approval" }, { key: "approved", label: "Approved" }, { key: "", label: "All" }]}
                    value={status}
                    onChange={setStatus}
                />
                {selected.size > 0 && (
                    <div className="flex gap-2">
                        <Button size="sm" onClick={() => approve(true)}>Approve {selected.size}</Button>
                        <Button size="sm" variant="outline" onClick={() => approve(false)}>Send back</Button>
                    </div>
                )}
            </div>

            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            {items?.length === 0 && !error && <EmptyState>No time here.</EmptyState>}

            {!!items?.length && (
                <div className="overflow-x-auto rounded-xl border border-border/70 bg-card">
                    <table className="w-full min-w-[720px] text-sm">
                        <thead className="border-b border-border/70">
                            <tr>
                                <th className="w-8 px-5 py-3">
                                    <Checkbox
                                        aria-label="Select all"
                                        checked={selected.size > 0 && selected.size === items.filter((t) => !t.invoiced).length}
                                        onCheckedChange={(v) => setSelected(v === true ? new Set(items.filter((t) => !t.invoiced).map((t) => t.id)) : new Set())}
                                    />
                                </th>
                                <th className="px-5 py-3 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Date</th>
                                <th className="px-5 py-3 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Technician</th>
                                <th className="px-5 py-3 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Customer</th>
                                <th className="px-5 py-3 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Work</th>
                                <th className="px-5 py-3 text-right text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Hours</th>
                                <th className="px-5 py-3 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Status</th>
                                <th className="px-5 py-3 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground" />
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-border/60">
                            {paged.rows.map((t) => (
                                <tr key={t.id} className="hover:bg-accent">
                                    <td className="px-5 py-4 text-sm">
                                        <Checkbox
                                            aria-label="Select"
                                            disabled={t.invoiced}
                                            checked={selected.has(t.id)}
                                            onCheckedChange={(v) => setSelected((all) => { const next = new Set(all); if (v === true) next.add(t.id); else next.delete(t.id); return next; })}
                                        />
                                    </td>
                                    <td className="px-5 py-4 text-sm tabular-nums">{t.workDate}</td>
                                    <td className="px-5 py-4 text-sm">{t.user.name}</td>
                                    <td className="px-5 py-4 text-sm">{t.client?.name ?? ""}</td>
                                    <td className="px-5 py-4 text-sm">{t.ticket ? `#${t.ticket.number} ${t.ticket.subject}` : ""}{t.ticket && t.note ? ": " : ""}{t.note ?? ""}</td>
                                    <td className="px-5 py-4 text-sm text-right tabular-nums">{formatHours(t.minutes)}{t.billable ? "" : " (not billable)"}</td>
                                    <td className="px-5 py-4 text-sm"><StatusPill status={t.invoiced ? "paid" : t.status} /></td>
                                    <td className="px-5 py-2 text-right">
                                        {!t.invoiced && (
                                            <Button variant="ghost" size="icon" aria-label="Delete entry" onClick={() => billing.deleteTime(t.id).then(load).catch((e) => toast({ title: "Could not delete it", description: errorText(e), variant: "destructive" }))}>
                                                <Trash2 className="h-4 w-4" />
                                            </Button>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
            {!!items?.length && <Pager paged={paged} noun="time entries" />}
        </div>
    );
}

/* ---------------------------- catalog ---------------------------- */

export function CatalogTab() {
    const [items, setItems] = React.useState<CatalogItem[] | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [name, setName] = React.useState("");
    const [price, setPrice] = React.useState("");

    const load = React.useCallback(() => {
        billing.catalog().then((r) => { setItems(r.items); setError(null); }).catch((e) => setError(errorText(e)));
    }, []);
    React.useEffect(load, [load]);
    const paged = usePaged(items ?? [], "billing-catalog", 25);

    const add = async (event: React.FormEvent) => {
        event.preventDefault();
        const cents = toCents(price);
        if (!name.trim() || cents === null) return toast({ title: "Enter a name and a price", variant: "destructive" });
        try {
            await billing.saveCatalogItem(null, { name, unitPriceCents: cents });
            setName("");
            setPrice("");
            load();
        } catch (e) {
            toast({ title: "Could not add it", description: errorText(e), variant: "destructive" });
        }
    };

    return (
        <div className="grid max-w-3xl gap-3">
            <form onSubmit={add} className="flex flex-wrap items-end gap-2 rounded-xl border border-border/70 bg-card p-3">
                <div className="grid min-w-52 flex-1 gap-1"><Label htmlFor="i-name">Item or service</Label><Input id="i-name" value={name} onChange={(e) => setName(e.target.value)} /></div>
                <div className="grid w-28 gap-1"><Label htmlFor="i-price">Price</Label><Input id="i-price" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0.00" /></div>
                <Button type="submit">Add</Button>
            </form>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            {items?.length === 0 && <EmptyState>Nothing in the catalog yet. Items here can be added to an invoice in one click.</EmptyState>}
            {!!items?.length && (
                <div className="overflow-x-auto rounded-xl border border-border/70 bg-card">
                    <table className="w-full text-sm">
                        <thead className="border-b border-border/70">
                            <tr>
                                <th className="px-5 py-3 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Item or service</th>
                                <th className="px-5 py-3 text-right text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Price</th>
                                <th className="px-5 py-3 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Available</th>
                                <th className="px-5 py-3 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground" />
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-border/60">
                            {paged.rows.map((i) => (
                                <tr key={i.id} className="hover:bg-accent">
                                    <td className={`px-5 py-4 text-sm ${i.active ? "" : "text-muted-foreground line-through"}`}>{i.name}</td>
                                    <td className="px-5 py-4 text-right text-sm tabular-nums">{money(i.unitPriceCents)}</td>
                                    <td className="px-5 py-4 text-sm">
                                        <Switch
                                            aria-label={`${i.name} available`}
                                            checked={i.active}
                                            onCheckedChange={(active) => billing.saveCatalogItem(i.id, { name: i.name, description: i.description ?? undefined, unitPriceCents: i.unitPriceCents, taxable: i.taxable, active }).then(load)}
                                        />
                                    </td>
                                    <td className="px-5 py-2 text-right text-sm">
                                        <Button variant="ghost" size="icon" aria-label={`Delete ${i.name}`} onClick={() => billing.deleteCatalogItem(i.id).then(load).catch((e) => toast({ title: "Could not delete it", description: errorText(e), variant: "destructive" }))}>
                                            <Trash2 className="h-4 w-4" />
                                        </Button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
            {!!items?.length && <Pager paged={paged} noun="items" />}
        </div>
    );
}

/* ---------------------------- reports ---------------------------- */

export function ReportsTab() {
    const year = new Date().getUTCFullYear();
    const [from, setFrom] = React.useState(`${year}-01-01`);
    const [to, setTo] = React.useState(today());
    const [rows, setRows] = React.useState<ProfitRow[] | null>(null);
    const [currency, setCurrency] = React.useState("USD");
    const [configured, setConfigured] = React.useState(true);
    const [error, setError] = React.useState<string | null>(null);

    React.useEffect(() => {
        billing.profitability(from, to).then((r) => {
            setRows(r.items);
            setCurrency(r.currency);
            setConfigured(r.laborCostConfigured);
            setError(null);
        }).catch((e) => setError(errorText(e)));
    }, [from, to]);

    const paged = usePaged(rows ?? [], "billing-profitability", 25);
    const sum = (key: keyof ProfitRow) => (rows ?? []).reduce((s, r) => s + Number(r[key]), 0);

    return (
        <div className="grid gap-3">
            <div className="flex flex-wrap items-end justify-between gap-2">
                <div className="flex flex-wrap gap-2">
                    <div className="grid gap-1"><Label htmlFor="r-from">From</Label><Input id="r-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
                    <div className="grid gap-1"><Label htmlFor="r-to">To</Label><Input id="r-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
                </div>
                <Button asChild variant="outline">
                    <a href={billingUrl(`/api/billing/reports/invoices.csv?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)}><Download className="mr-1 h-4 w-4" /> Export for accounting (CSV)</a>
                </Button>
            </div>

            {!configured && <p className="rounded-xl border border-border/70 bg-muted/40 p-3 text-sm">Margin leaves out labor until you set a labor cost per hour in Settings.</p>}
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            {rows?.length === 0 && !error && <EmptyState>No invoices or time in these dates.</EmptyState>}

            {!!rows?.length && (
                <div className="overflow-x-auto rounded-xl border border-border/70 bg-card">
                    <table className="w-full min-w-[720px] text-sm">
                        <thead className="border-b border-border/70">
                            <tr>
                                <th className="px-5 py-3 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Customer</th>
                                <th className="px-5 py-3 text-right text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Invoiced (before tax)</th>
                                <th className="px-5 py-3 text-right text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Outstanding</th>
                                <th className="px-5 py-3 text-right text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Hours</th>
                                <th className="px-5 py-3 text-right text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Labor cost</th>
                                <th className="px-5 py-3 text-right text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Margin</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-border/60 tabular-nums">
                            {paged.rows.map((r) => (
                                <tr key={r.clientId} className="hover:bg-accent">
                                    <td className="px-5 py-4 text-sm">{r.clientName}</td>
                                    <td className="px-5 py-4 text-sm text-right">{money(r.revenueCents, currency)}</td>
                                    <td className="px-5 py-4 text-sm text-right">{money(r.outstandingCents, currency)}</td>
                                    <td className="px-5 py-4 text-sm text-right">{r.hours.toFixed(2)}</td>
                                    <td className="px-5 py-4 text-sm text-right">{money(r.laborCostCents, currency)}</td>
                                    <td className={`px-5 py-4 text-sm text-right ${r.marginCents < 0 ? "text-destructive" : ""}`}>{money(r.marginCents, currency)}</td>
                                </tr>
                            ))}
                            <tr className="bg-muted/30 font-medium">
                                <td className="px-5 py-4 text-sm">Total</td>
                                <td className="px-5 py-4 text-sm text-right">{money(sum("revenueCents"), currency)}</td>
                                <td className="px-5 py-4 text-sm text-right">{money(sum("outstandingCents"), currency)}</td>
                                <td className="px-5 py-4 text-sm text-right">{sum("hours").toFixed(2)}</td>
                                <td className="px-5 py-4 text-sm text-right">{money(sum("laborCostCents"), currency)}</td>
                                <td className="px-5 py-4 text-sm text-right">{money(sum("marginCents"), currency)}</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            )}
            {!!rows?.length && <Pager paged={paged} noun="customers" />}
        </div>
    );
}

/* ---------------------------- settings ---------------------------- */

export function SettingsTab() {
    const [s, setS] = React.useState<BillingSettings | null>(null);
    const [taxPercent, setTaxPercent] = React.useState("");
    const [labor, setLabor] = React.useState("");
    const [hourly, setHourly] = React.useState("");
    const [stripeKey, setStripeKey] = React.useState("");
    const [stripeHook, setStripeHook] = React.useState("");
    const [saving, setSaving] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);

    React.useEffect(() => {
        billing.settings().then((v) => {
            setS(v);
            setTaxPercent((v.taxRateBps / 100).toString());
            setLabor(fromCents(v.laborCostCents));
            setHourly(fromCents(v.defaultHourlyRateCents));
        }).catch((e) => setError(errorText(e)));
    }, []);

    if (!s) return error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null;

    const set = <K extends keyof BillingSettings>(key: K, value: BillingSettings[K]) => setS({ ...s, [key]: value });

    const save = async (event: React.FormEvent) => {
        event.preventDefault();
        setError(null);
        const tax = Number(taxPercent);
        if (!(tax >= 0 && tax <= 100)) return setError("Tax must be between 0 and 100 percent.");
        setSaving(true);
        try {
            const saved = await billing.saveSettings({
                currency: s.currency,
                taxRateBps: Math.round(tax * 100),
                paymentTermsDays: s.paymentTermsDays,
                invoicePrefix: s.invoicePrefix,
                nextInvoiceNumber: s.nextInvoiceNumber,
                quotePrefix: s.quotePrefix,
                nextQuoteNumber: s.nextQuoteNumber,
                laborCostCents: toCents(labor) ?? 0,
                defaultHourlyRateCents: toCents(hourly) ?? 0,
                ...(s.footer ? { footer: s.footer } : {}),
                ...(s.publicBaseUrl ? { publicBaseUrl: s.publicBaseUrl } : {}),
                ...(stripeKey.trim() ? { stripeSecretKey: stripeKey.trim() } : {}),
                ...(stripeHook.trim() ? { stripeWebhookSecret: stripeHook.trim() } : {}),
            });
            setS(saved);
            setStripeKey("");
            setStripeHook("");
            toast({ title: "Billing settings saved" });
        } catch (e) {
            setError(errorText(e));
        } finally {
            setSaving(false);
        }
    };

    return (
        <form onSubmit={save} className="grid max-w-2xl gap-5">
            <section className="grid gap-3 sm:grid-cols-3">
                <div className="grid gap-1.5"><Label htmlFor="s-currency">Currency</Label><Input id="s-currency" maxLength={3} value={s.currency} onChange={(e) => set("currency", e.target.value.toUpperCase())} /></div>
                <div className="grid gap-1.5"><Label htmlFor="s-tax">Tax rate (%)</Label><Input id="s-tax" inputMode="decimal" value={taxPercent} onChange={(e) => setTaxPercent(e.target.value)} /></div>
                <div className="grid gap-1.5"><Label htmlFor="s-terms">Payment terms (days)</Label><Input id="s-terms" type="number" min={0} max={365} value={s.paymentTermsDays} onChange={(e) => set("paymentTermsDays", Number(e.target.value))} /></div>
                <div className="grid gap-1.5"><Label htmlFor="s-ip">Invoice prefix</Label><Input id="s-ip" value={s.invoicePrefix} onChange={(e) => set("invoicePrefix", e.target.value)} /></div>
                <div className="grid gap-1.5"><Label htmlFor="s-in">Next invoice number</Label><Input id="s-in" type="number" min={1} value={s.nextInvoiceNumber} onChange={(e) => set("nextInvoiceNumber", Number(e.target.value))} /></div>
                <div className="hidden sm:block" />
                <div className="grid gap-1.5"><Label htmlFor="s-qp">Quote prefix</Label><Input id="s-qp" value={s.quotePrefix} onChange={(e) => set("quotePrefix", e.target.value)} /></div>
                <div className="grid gap-1.5"><Label htmlFor="s-qn">Next quote number</Label><Input id="s-qn" type="number" min={1} value={s.nextQuoteNumber} onChange={(e) => set("nextQuoteNumber", Number(e.target.value))} /></div>
                <div className="hidden sm:block" />
                <div className="grid gap-1.5"><Label htmlFor="s-hourly">Default hourly rate</Label><Input id="s-hourly" inputMode="decimal" value={hourly} onChange={(e) => setHourly(e.target.value)} /></div>
                <div className="grid gap-1.5"><Label htmlFor="s-labor">Labor cost per hour</Label><Input id="s-labor" inputMode="decimal" value={labor} onChange={(e) => setLabor(e.target.value)} /></div>
            </section>

            <div className="grid gap-1.5">
                <Label htmlFor="s-footer">Footer on invoices</Label>
                <Textarea id="s-footer" rows={2} value={s.footer ?? ""} onChange={(e) => set("footer", e.target.value)} placeholder="Payment instructions, thank you note" />
            </div>
            <div className="grid gap-1.5">
                <Label htmlFor="s-url">Console address for customer links</Label>
                <Input id="s-url" value={s.publicBaseUrl ?? ""} onChange={(e) => set("publicBaseUrl", e.target.value)} placeholder="https://console.example.com" />
                <span className="text-xs text-muted-foreground">Emails include a link to view and pay only when this is set.</span>
            </div>

            <section className="grid gap-3 rounded-xl border border-border/70 bg-card p-3">
                <div>
                    <h2 className="text-base font-semibold">Online payments with Stripe</h2>
                    <p className="text-xs text-muted-foreground">
                        {s.stripeConfigured ? "Set up. Leave these blank to keep the saved keys." : "Not set up. Add a webhook in Stripe pointing to /api/public/billing/stripe-webhook on your API address, for checkout.session.completed."}
                    </p>
                </div>
                <div className="grid gap-1.5"><Label htmlFor="s-sk">Secret key</Label><Input id="s-sk" type="password" autoComplete="off" value={stripeKey} onChange={(e) => setStripeKey(e.target.value)} /></div>
                <div className="grid gap-1.5"><Label htmlFor="s-wh">Webhook signing secret</Label><Input id="s-wh" type="password" autoComplete="off" value={stripeHook} onChange={(e) => setStripeHook(e.target.value)} /></div>
            </section>

            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <Button type="submit" className="justify-self-start" disabled={saving}>{saving ? "Saving..." : "Save settings"}</Button>
        </form>
    );
}
