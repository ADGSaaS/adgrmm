"use client";

import * as React from "react";
import { Pager, usePaged } from "@/components/pager";
import { EmptyState } from "@/components/list-controls";
import { Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/use-toast";
import { jfetch } from "@/lib/api";
import { useDeviceChoices } from "@/components/reports/full-report";
import { badClass, errorText, Field, Pill, selectClass } from "@/components/policies/shared";

export type Tag = { id: string; name: string; color: string | null; devices: number; policies: string[] };

/* ------------------------------ tags ------------------------------ */

export function TagsTab({ canWrite, canTag }: { canWrite: boolean; canTag: boolean }) {
    const [tags, setTags] = React.useState<Tag[] | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [editing, setEditing] = React.useState<{ tag: Tag | null } | null>(null);
    const [devicesOf, setDevicesOf] = React.useState<Tag | null>(null);
    const load = React.useCallback(() => {
        jfetch<{ items: Tag[] }>("/api/tags").then((r) => { setTags(r.items); setError(null); }).catch((e) => setError(errorText(e)));
    }, []);
    React.useEffect(load, [load]);
    const paged = usePaged(tags ?? [], "policy-tags", 25);

    return (
        <section aria-label="Tags" className="space-y-3">
            <div className="flex items-center justify-between gap-2">
                <p className="max-w-2xl text-sm text-muted-foreground">A tag is a label you put on devices, such as &quot;Servers&quot; or &quot;Point of sale&quot;. A policy can apply to a tag, so it reaches those devices in every customer. A tag is more specific than a site, and a device is more specific than a tag.</p>
                {canWrite && <Button variant="success" onClick={() => setEditing({ tag: null })}><Plus className="mr-1 h-4 w-4" aria-hidden /> New tag</Button>}
            </div>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            {tags?.length === 0 && <EmptyState>No tags yet.</EmptyState>}
            {tags && tags.length > 0 && (
            <div className="overflow-hidden rounded-xl border border-border/70 bg-card">
            <ul className="divide-y divide-border/60">
                {paged.rows.map((t) => (
                    <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-4 text-sm hover:bg-accent">
                        <div className="flex flex-wrap items-center gap-2">
                            <span className="inline-block h-3 w-3 rounded-full border" style={t.color ? { backgroundColor: t.color } : undefined} aria-hidden />
                            <span className="font-medium">{t.name}</span>
                            <button type="button" className="text-xs underline-offset-2 hover:underline" onClick={() => setDevicesOf(t)}>{t.devices} device{t.devices === 1 ? "" : "s"}</button>
                            {t.policies.length > 0 && <span className="text-xs text-muted-foreground">Used by {t.policies.join(", ")}</span>}
                        </div>
                        <div className="flex gap-1">
                            <Button variant="ghost" size="sm" onClick={() => setDevicesOf(t)}>{canTag ? "Devices" : "View"}</Button>
                            {canWrite && <Button variant="ghost" size="sm" onClick={() => setEditing({ tag: t })}>Edit</Button>}
                            {canWrite && (
                                <Button variant="ghost" size="sm" onClick={async () => {
                                    const used = t.policies.length ? ` It is also taken out of ${t.policies.join(", ")}.` : "";
                                    if (!window.confirm(`Delete the tag "${t.name}"? It comes off ${t.devices} device${t.devices === 1 ? "" : "s"}.${used}`)) return;
                                    try { await jfetch(`/api/tags/${t.id}`, { method: "DELETE" }); toast({ title: "Deleted" }); load(); } catch (e) { toast({ title: "Could not delete", description: errorText(e), variant: "destructive" }); }
                                }}>Delete</Button>
                            )}
                        </div>
                    </li>
                ))}
            </ul>
            </div>
            )}
            {tags && tags.length > 0 && <Pager paged={paged} noun="tags" />}
            <TagDialog state={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />
            <TagDevices tag={devicesOf} canTag={canTag} onClose={() => { setDevicesOf(null); load(); }} />
        </section>
    );
}

function TagDialog({ state, onClose, onSaved }: { state: { tag: Tag | null } | null; onClose: () => void; onSaved: () => void }) {
    const tag = state?.tag ?? null;
    const [name, setName] = React.useState("");
    const [color, setColor] = React.useState("");
    const [tried, setTried] = React.useState(false);
    const [saving, setSaving] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    React.useEffect(() => {
        if (!state) return;
        setName(tag?.name ?? "");
        setColor(tag?.color ?? "");
        setTried(false);
        setError(null);
    }, [state, tag]);
    const colorBad = color.trim() !== "" && !/^#[0-9a-f]{6}$/i.test(color.trim());
    const submit = async (event: React.FormEvent) => {
        event.preventDefault();
        setTried(true);
        if (!name.trim() || colorBad) { setError("Some details need fixing. They are marked in red."); return; }
        setSaving(true);
        setError(null);
        try {
            await jfetch(tag ? `/api/tags/${tag.id}` : "/api/tags", { method: tag ? "PATCH" : "POST", body: { name: name.trim(), color: color.trim() } });
            toast({ title: "Saved" });
            onSaved();
        } catch (e) {
            setError(errorText(e));
        } finally {
            setSaving(false);
        }
    };
    return (
        <Dialog open={!!state} onOpenChange={(o) => !saving && !o && onClose()}>
            <DialogContent className="sm:max-w-md">
                <form onSubmit={submit} noValidate>
                    <DialogHeader>
                        <DialogTitle>{tag ? "Edit tag" : "New tag"}</DialogTitle>
                        <DialogDescription>A short name, and a colour if you like.</DialogDescription>
                    </DialogHeader>
                    <div className="grid gap-1 py-3">
                        <Field label="Name *" htmlFor="tg-name" error={tried && !name.trim() ? "Required" : undefined}>
                            <Input id="tg-name" value={name} maxLength={40} aria-invalid={tried && !name.trim()} className={tried && !name.trim() ? badClass : ""} onChange={(e) => setName(e.target.value)} placeholder="Servers" autoFocus />
                        </Field>
                        <Field label="Colour" htmlFor="tg-color" error={tried && colorBad ? "Like #1a73e8" : undefined}>
                            <div className="flex items-center gap-2">
                                <input aria-label="Pick a colour" type="color" className="h-10 w-12 rounded border border-input bg-background" value={/^#[0-9a-f]{6}$/i.test(color) ? color : "#1a73e8"} onChange={(e) => setColor(e.target.value)} />
                                <Input id="tg-color" className={cn("w-32", tried && colorBad ? badClass : "")} value={color} maxLength={7} onChange={(e) => setColor(e.target.value)} placeholder="#1a73e8" />
                                {color && <Button type="button" variant="ghost" size="sm" onClick={() => setColor("")}>Clear</Button>}
                            </div>
                        </Field>
                    </div>
                    <DialogFooter className="items-center gap-2 sm:justify-between">
                        <p role="alert" className="min-h-5 text-sm text-destructive">{error ?? ""}</p>
                        <div className="flex gap-2">
                            <Button type="button" variant="outline" disabled={saving} onClick={onClose}>Cancel</Button>
                            <Button type="submit" variant="success" disabled={saving}>{saving ? "Saving..." : "Save"}</Button>
                        </div>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

type TagDeviceRow = { deviceId: string; device: string; customer: string | null; site: string | null };

function TagDevices({ tag, canTag, onClose }: { tag: Tag | null; canTag: boolean; onClose: () => void }) {
    const [items, setItems] = React.useState<TagDeviceRow[] | null>(null);
    const paged = usePaged(items ?? [], "tag-devices", 25);
    const [error, setError] = React.useState<string | null>(null);
    const [customers, setCustomers] = React.useState<{ key: string; name: string }[]>([]);
    const [clientId, setClientId] = React.useState("");
    const [picked, setPicked] = React.useState<string[]>([]);
    const choices = useDeviceChoices(clientId, "");

    const load = React.useCallback(() => {
        if (!tag) return;
        jfetch<{ items: TagDeviceRow[] }>(`/api/tags/${tag.id}/devices`).then((r) => { setItems(r.items); setError(null); }).catch((e) => setError(errorText(e)));
    }, [tag]);
    React.useEffect(() => {
        if (!tag) return;
        setItems(null);
        setPicked([]);
        setClientId("");
        load();
        jfetch<{ key: string; name: string }[]>("/api/customers").then(setCustomers).catch(() => setCustomers([]));
    }, [tag, load]);

    const change = async (deviceIds: string[], remove: boolean) => {
        if (!tag || !deviceIds.length) return;
        try {
            await jfetch(`/api/tags/${tag.id}/devices`, { method: "POST", body: { deviceIds, remove } });
            setPicked([]);
            load();
        } catch (e) {
            toast({ title: "Could not change that", description: errorText(e), variant: "destructive" });
        }
    };
    const have = new Set((items ?? []).map((i) => i.deviceId));

    return (
        <Dialog open={!!tag} onOpenChange={(o) => !o && onClose()}>
            <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-2xl">
                <DialogHeader>
                    <DialogTitle>Devices tagged {tag?.name}</DialogTitle>
                    <DialogDescription>Policies that apply to this tag reach these devices.</DialogDescription>
                </DialogHeader>
                {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
                {!items && !error && <p className="text-sm text-muted-foreground">Loading…</p>}
                {items?.length === 0 && <EmptyState>No device has this tag yet.</EmptyState>}
                <div className="overflow-hidden rounded-xl border border-border/70 bg-card">
                <ul className="divide-y divide-border/60">
                    {paged.rows.map((d) => (
                        <li key={d.deviceId} className="flex items-center justify-between gap-2 px-5 py-3 text-sm hover:bg-accent">
                            <span><span className="font-medium">{d.device}</span> <span className="text-muted-foreground">{[d.customer, d.site].filter(Boolean).join(" / ")}</span></span>
                            {canTag && <Button variant="ghost" size="sm" onClick={() => void change([d.deviceId], true)}>Remove</Button>}
                        </li>
                    ))}
                </ul>
                </div>
                {items && items.length > 0 && <Pager paged={paged} noun="devices" />}
                {canTag && (
                    <div className="grid gap-2 rounded-md border p-3">
                        <span className="text-sm font-medium">Add devices</span>
                        <select aria-label="Customer" className={selectClass} value={clientId} onChange={(e) => { setClientId(e.target.value); setPicked([]); }}>
                            <option value="">Choose a customer</option>
                            {customers.map((c) => <option key={c.key} value={c.key}>{c.name}</option>)}
                        </select>
                        {clientId && (
                            <div className="grid max-h-48 gap-1 overflow-y-auto">
                                {choices.filter((c) => !have.has(c.id)).map((c) => (
                                    <label key={c.id} className="flex items-center gap-2 text-sm">
                                        <input type="checkbox" checked={picked.includes(c.id)} onChange={() => setPicked((cur) => cur.includes(c.id) ? cur.filter((x) => x !== c.id) : [...cur, c.id])} />
                                        {c.name}
                                    </label>
                                ))}
                                {choices.filter((c) => !have.has(c.id)).length === 0 && <p className="text-xs text-muted-foreground">Every device of this customer has the tag, or it has no devices.</p>}
                            </div>
                        )}
                        <div><Button size="sm" variant="outline" disabled={!picked.length} onClick={() => void change(picked, false)}>Add {picked.length || ""} selected</Button></div>
                    </div>
                )}
                <DialogFooter><Button variant="outline" onClick={onClose}>Close</Button></DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

/* ------------------------------ baseline ------------------------------ */

type Baseline = {
    policies: { id: string; name: string; enabled: boolean }[];
    items: { customerId: string; customer: string; missing: { id: string; name: string }[]; switchedOff: { id: string; name: string }[]; onBaseline: boolean }[];
    customers: number;
    drifted: number;
};

export function BaselineTab({ canWrite }: { canWrite: boolean }) {
    const [data, setData] = React.useState<Baseline | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [busy, setBusy] = React.useState(false);
    const load = React.useCallback(() => {
        jfetch<Baseline>("/api/policies/baseline").then((r) => { setData(r); setError(null); }).catch((e) => setError(errorText(e)));
    }, []);
    React.useEffect(load, [load]);
    const paged = usePaged(data?.items ?? [], "baseline-customers", 25);

    const apply = async () => {
        if (!window.confirm("Give every customer that is missing a baseline policy that policy? A customer that switched one off keeps it off.")) return;
        setBusy(true);
        try {
            const r = await jfetch<{ added: number }>("/api/policies/baseline/apply", { method: "POST" });
            toast({ title: r.added ? `Added ${r.added} assignment${r.added === 1 ? "" : "s"}` : "Nothing to add" });
            load();
        } catch (e) {
            toast({ title: "Could not apply it", description: errorText(e), variant: "destructive" });
        } finally {
            setBusy(false);
        }
    };

    return (
        <section aria-label="Baseline" className="space-y-3">
            <p className="max-w-3xl text-sm text-muted-foreground">The baseline is the set of policies every customer should have. Tick &quot;Add to every new customer&quot; on a policy and it is assigned to each new customer the moment it is created. This page shows which customers are missing a baseline policy or have switched one off.</p>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            {data && data.policies.length === 0 && <EmptyState>No policy is part of the baseline yet. Open a policy and tick &quot;Add to every new customer automatically&quot;.</EmptyState>}
            {data && data.policies.length > 0 && (
                <>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-2 text-sm">
                            <span className="text-muted-foreground">Baseline policies:</span>
                            {data.policies.map((p) => <Pill key={p.id} tone={p.enabled ? "good" : "muted"}>{p.name}{p.enabled ? "" : " (off)"}</Pill>)}
                            <span className="text-muted-foreground">{data.customers - data.drifted} of {data.customers} customers are on it.</span>
                        </div>
                        {canWrite && <Button variant="outline" disabled={busy || data.items.every((i) => i.missing.length === 0)} onClick={() => void apply()}>{busy ? "Applying…" : "Apply to customers missing it"}</Button>}
                    </div>
                    <div className="overflow-x-auto rounded-xl border border-border/70 bg-card">
                        <table className="w-full min-w-[560px] text-sm">
                            <thead className="border-b border-border/60"><tr><th className="px-5 py-3 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Customer</th><th className="px-5 py-3 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">State</th><th className="px-5 py-3 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Detail</th></tr></thead>
                            <tbody className="divide-y divide-border/60">
                                {paged.rows.map((i) => (
                                    <tr key={i.customerId} className="align-top hover:bg-accent">
                                        <td className="px-5 py-4 text-sm font-medium">{i.customer}</td>
                                        <td className="px-5 py-4 text-sm">{i.onBaseline ? <Pill tone="good">On the baseline</Pill> : i.missing.length ? <Pill tone="bad">Missing</Pill> : <Pill tone="warn">Switched off</Pill>}</td>
                                        <td className="px-5 py-4 text-xs text-muted-foreground">
                                            {i.missing.length > 0 && <div>Missing: {i.missing.map((m) => m.name).join(", ")}</div>}
                                            {i.switchedOff.length > 0 && <div>Switched off: {i.switchedOff.map((m) => m.name).join(", ")}</div>}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    <Pager paged={paged} noun="customers" />
                </>
            )}
        </section>
    );
}
