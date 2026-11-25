// components/reports/report-settings-panels.tsx
//
// The settings the reports use: software policies for each customer, business hours, a customer's own look for the
// reports sent to them, and the log of what was sent.
"use client";

import { EmptyState } from "@/components/list-controls";
import * as React from "react";
import { Pager, usePaged } from "@/components/pager";
import { Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/use-toast";
import { apiUrl, fetchCustomers, jfetch, type CustomerClient } from "@/lib/api";

const selectClass = "h-10 rounded-md border border-input bg-background px-2 text-sm";
const INVALID = "border-destructive ring-1 ring-destructive focus-visible:ring-destructive";

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

function useCustomers() {
    const [customers, setCustomers] = React.useState<CustomerClient[]>([]);
    React.useEffect(() => { fetchCustomers().then(setCustomers).catch(() => setCustomers([])); }, []);
    return customers;
}

/* ------------------------------ software policies ------------------------------ */

type Policy = { id: string; clientId: string | null; customer: string | null; kind: "required" | "banned"; pattern: string; note: string | null };

export function SoftwarePoliciesPanel() {
    const customers = useCustomers();
    const [clientId, setClientId] = React.useState("");
    const [items, setItems] = React.useState<Policy[] | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [kind, setKind] = React.useState<"required" | "banned">("required");
    const [pattern, setPattern] = React.useState("");
    const [note, setNote] = React.useState("");
    const [attempted, setAttempted] = React.useState(false);
    const [forEveryone, setForEveryone] = React.useState(false);

    const load = React.useCallback(() => {
        jfetch<{ items: Policy[] }>(`/api/reports/software-policies${clientId ? `?clientId=${clientId}` : ""}`).then((r) => { setItems(r.items); setError(null); }).catch((e) => setError(errorText(e)));
    }, [clientId]);
    React.useEffect(load, [load]);
    const paged = usePaged(items ?? [], "report-software-policies", 25);

    const missingPattern = attempted && !pattern.trim();
    const missingCustomer = attempted && !forEveryone && !clientId;

    const add = async (event: React.FormEvent) => {
        event.preventDefault();
        setAttempted(true);
        if (!pattern.trim() || (!forEveryone && !clientId)) return;
        try {
            await jfetch("/api/reports/software-policies", { method: "POST", body: { clientId: forEveryone ? undefined : clientId, kind, pattern: pattern.trim(), note: note.trim() || undefined } });
            setPattern("");
            setNote("");
            setAttempted(false);
            load();
        } catch (e) {
            toast({ title: "Could not add that", description: errorText(e), variant: "destructive" });
        }
    };

    const remove = (p: Policy) => jfetch(`/api/reports/software-policies/${p.id}`, { method: "DELETE" }).then(load).catch((e) => toast({ title: "Could not remove that", description: errorText(e), variant: "destructive" }));

    return (
        <div className="grid gap-4">
            <div>
                <h2 className="text-base font-semibold">Software policies</h2>
                <p className="max-w-3xl text-sm text-muted-foreground">The software each customer must have and must not have. A policy is part of a program&apos;s name, so &ldquo;Defender&rdquo; matches Windows Defender. The Software compliance report checks every device against its customer&apos;s policies, plus the ones set for everyone.</p>
            </div>
            <div className="flex flex-wrap items-end gap-2">
                <div className="grid gap-1">
                    <Label htmlFor="pol-view">Show policies for</Label>
                    <select id="pol-view" className={cn(selectClass, "w-56")} value={clientId} onChange={(e) => setClientId(e.target.value)}>
                        <option value="">All customers</option>
                        {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                </div>
            </div>
            <form onSubmit={add} className="grid gap-3 rounded-md border border-border p-3">
                <p className="text-sm font-medium">Add a policy</p>
                <div className="flex flex-wrap items-end gap-2 pb-4">
                    <div className="relative grid gap-1">
                        <Label htmlFor="pol-customer">Applies to</Label>
                        <select id="pol-customer" aria-invalid={missingCustomer || undefined} className={cn(selectClass, "w-56", missingCustomer && INVALID)} value={forEveryone ? "*" : clientId} onChange={(e) => { if (e.target.value === "*") { setForEveryone(true); } else { setForEveryone(false); setClientId(e.target.value); } }}>
                            <option value="">Choose a customer</option>
                            <option value="*">Every customer</option>
                            {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                        </select>
                        {missingCustomer && <p className="absolute left-0 top-full whitespace-nowrap pt-0.5 text-xs text-destructive">Choose who it applies to</p>}
                    </div>
                    <div className="grid gap-1">
                        <Label htmlFor="pol-kind">Software</Label>
                        <select id="pol-kind" className={cn(selectClass, "w-40")} value={kind} onChange={(e) => setKind(e.target.value as "required" | "banned")}>
                            <option value="required">Must be installed</option>
                            <option value="banned">Must not be installed</option>
                        </select>
                    </div>
                    <div className="relative grid min-w-56 gap-1">
                        <Label htmlFor="pol-pattern">Name, or part of it</Label>
                        <Input id="pol-pattern" aria-invalid={missingPattern || undefined} className={cn(missingPattern && INVALID)} value={pattern} maxLength={100} onChange={(e) => setPattern(e.target.value)} placeholder="Microsoft 365" />
                        {missingPattern && <p className="absolute left-0 top-full whitespace-nowrap pt-0.5 text-xs text-destructive">Enter the software&apos;s name</p>}
                    </div>
                    <div className="grid min-w-56 flex-1 gap-1">
                        <Label htmlFor="pol-note">Note (optional)</Label>
                        <Input id="pol-note" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder="Why" />
                    </div>
                    <Button type="submit"><Plus className="mr-1 h-4 w-4" /> Add</Button>
                </div>
            </form>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            {items?.length === 0 && <EmptyState>No policies yet.</EmptyState>}
            {!!items?.length && (
                <div className="overflow-x-auto rounded-xl border border-border/70 bg-card">
                    <table className="w-full min-w-[640px] text-sm">
                        <thead className="border-b border-border/60">
                            <tr><th className="px-5 py-3 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Applies to</th><th className="px-5 py-3 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Rule</th><th className="px-5 py-3 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Software</th><th className="px-5 py-3 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Note</th><th className="px-5 py-3" /></tr>
                        </thead>
                        <tbody className="divide-y divide-border/60">
                            {paged.rows.map((p) => (
                                <tr key={p.id} className="hover:bg-accent">
                                    <td className="px-5 py-4 text-sm">{p.customer ?? "Every customer"}</td>
                                    <td className={cn("px-5 py-4 text-sm", p.kind === "banned" ? "text-red-500" : "text-emerald-500")}>{p.kind === "required" ? "Must be installed" : "Must not be installed"}</td>
                                    <td className="px-5 py-4 text-sm font-medium">{p.pattern}</td>
                                    <td className="px-5 py-4 text-sm text-muted-foreground">{p.note}</td>
                                    <td className="px-5 py-2 text-right"><Button variant="ghost" size="icon" aria-label={`Remove ${p.pattern}`} onClick={() => void remove(p)}><Trash2 className="h-4 w-4" /></Button></td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
            {!!items?.length && <Pager paged={paged} noun="policies" />}
        </div>
    );
}

/* ------------------------------ business hours ------------------------------ */

type Hours = { days: number[]; start: string; end: string; timezone: string };
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function BusinessHoursPanel() {
    const [hours, setHours] = React.useState<Hours | null>(null);
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);

    React.useEffect(() => {
        jfetch<Hours>("/api/reports/business-hours").then(setHours).catch((e) => setError(errorText(e)));
    }, []);

    const save = async (event: React.FormEvent) => {
        event.preventDefault();
        if (!hours) return;
        setBusy(true);
        setError(null);
        try {
            setHours(await jfetch<Hours>("/api/reports/business-hours", { method: "PUT", body: hours }));
            toast({ title: "Business hours saved", description: "Availability measured in business hours uses them from now on." });
        } catch (e) {
            setError(errorText(e));
        } finally {
            setBusy(false);
        }
    };

    return (
        <form onSubmit={save} className="grid max-w-2xl gap-4">
            <div>
                <h2 className="text-base font-semibold">Business hours</h2>
                <p className="text-sm text-muted-foreground">When the working day is. The Availability report can count only these hours, so a computer switched off overnight or at the weekend is not marked down. History in business hours starts from when this was first switched on.</p>
            </div>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            {hours && (
                <>
                    <fieldset className="grid gap-1">
                        <legend className="mb-1 text-sm font-medium">Working days</legend>
                        <div className="flex flex-wrap gap-1.5">
                            {DAYS.map((d, i) => {
                                const on = hours.days.includes(i);
                                return (
                                    <button key={d} type="button" aria-pressed={on} onClick={() => setHours({ ...hours, days: on ? hours.days.filter((x) => x !== i) : [...hours.days, i].sort() })} className={cn("h-9 w-14 rounded-md border text-sm", on ? "border-primary bg-primary text-primary-foreground" : "border-input bg-background text-muted-foreground hover:bg-muted/50")}>{d}</button>
                                );
                            })}
                        </div>
                    </fieldset>
                    <div className="flex flex-wrap items-end gap-3">
                        <div className="grid gap-1"><Label htmlFor="bh-start">From</Label><Input id="bh-start" type="time" className="w-32" value={hours.start} onChange={(e) => setHours({ ...hours, start: e.target.value })} /></div>
                        <div className="grid gap-1"><Label htmlFor="bh-end">To</Label><Input id="bh-end" type="time" className="w-32" value={hours.end} onChange={(e) => setHours({ ...hours, end: e.target.value })} /></div>
                        <div className="grid gap-1"><Label htmlFor="bh-zone">Time zone</Label><Input id="bh-zone" className="w-56" value={hours.timezone} onChange={(e) => setHours({ ...hours, timezone: e.target.value })} placeholder="America/New_York" /></div>
                        <Button type="submit" disabled={busy}>{busy ? "Saving…" : "Save"}</Button>
                    </div>
                </>
            )}
        </form>
    );
}

/* ------------------------------ what was sent ------------------------------ */

type Delivery = { id: string; at: string; trigger: "scheduled" | "test"; ok: boolean; recipients: string; subject: string | null; attachments: string | null; result: string | null; error: string | null };

export function DeliveryLog({ scheduleId }: { scheduleId: string }) {
    const [items, setItems] = React.useState<Delivery[] | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    React.useEffect(() => {
        jfetch<{ items: Delivery[] }>(`/api/reports/schedules/${scheduleId}/deliveries`).then((r) => setItems(r.items)).catch((e) => setError(errorText(e)));
    }, [scheduleId]);
    if (error) return <p role="alert" className="text-sm text-destructive">{error}</p>;
    if (!items) return <p className="text-sm text-muted-foreground">Loading…</p>;
    if (!items.length) return <p className="text-sm text-muted-foreground">Nothing has been sent for this schedule yet.</p>;
    return <DeliveryRows items={items} />;
}

function DeliveryRows({ items }: { items: Delivery[] }) {
    const paged = usePaged(items, "report-deliveries", 10);
    return (
        <>
        <ul className="grid gap-1 text-xs">
            {paged.rows.map((d) => (
                <li key={d.id} className="flex flex-wrap gap-x-3 gap-y-0.5">
                    <span className="tabular-nums text-muted-foreground">{new Date(d.at).toLocaleString()}</span>
                    <span className={cn("font-medium", d.ok ? "text-emerald-500" : "text-red-500")}>{d.ok ? (d.subject ? "Sent" : d.result ?? "Skipped") : "Failed"}</span>
                    <span className="text-muted-foreground">{d.trigger === "test" ? "send now" : "scheduled"}</span>
                    {d.subject && <span>{d.subject}</span>}
                    {d.attachments && <span className="text-muted-foreground">({d.attachments})</span>}
                    <span className="text-muted-foreground">to {d.recipients}</span>
                    {d.error && <span className="text-red-500">{d.error}</span>}
                </li>
            ))}
        </ul>
        <Pager paged={paged} className="pt-2" noun="deliveries" />
        </>
    );
}
