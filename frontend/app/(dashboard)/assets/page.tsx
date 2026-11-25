"use client";

// Assets: the things a customer owns, one record each. Computers and servers with an agent are filled in from the agent every hour (what the
// agent reports is overwritten, what a person typed is not); everything else (printers, switches, licences, domains, certificates) is entered by
// hand or recorded from Network discovery and SNMP monitoring. Warranty and licence end dates feed the expiry emails and the renewals report.
// When another system owns assets (Administration > Integrations > Assets) this page says so and shows nothing: the built-in list is off.
import * as React from "react";
import Link from "next/link";
import { Boxes, Loader2, RefreshCw } from "lucide-react";
import { PageHeader, PageShell } from "@/components/page-shell";
import PermGate from "@/components/perm-gate";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState } from "@/components/list-controls";
import { errorText } from "@/components/policies/shared";
import { fetchCustomers, type CustomerClient } from "@/lib/api";
import { assetProvider, type AssetProviderInfo } from "@/lib/assets-provider-api";
import { itdocs, type Asset, type AssetKind } from "@/lib/itdocs-api";
import { useMe } from "@/lib/use-me";
import { hasPerm } from "@/lib/permissions";

const KINDS: Array<{ value: AssetKind; label: string; ends: string }> = [
    { value: "computer", label: "Computer", ends: "Warranty ends" }, { value: "server", label: "Server", ends: "Warranty ends" }, { value: "network", label: "Network device", ends: "Warranty ends" },
    { value: "printer", label: "Printer", ends: "Warranty ends" }, { value: "mobile", label: "Phone or tablet", ends: "Warranty ends" }, { value: "licence", label: "Licence", ends: "Licence ends" },
    { value: "domain", label: "Domain", ends: "Renews on" }, { value: "certificate", label: "Certificate", ends: "Expires on" }, { value: "other", label: "Other", ends: "Warranty or licence ends" },
];
const KIND_TEXT = Object.fromEntries(KINDS.map((k) => [k.value, k.label])) as Record<string, string>;
const SOURCE_TEXT: Record<string, string> = { agent: "From an agent", manual: "Entered by hand", discovery: "Network discovery", snmp: "SNMP monitoring" };
const DAY = 86_400_000;

/** A date-only value ("2027-05-31") as a local date, so it does not slip a day with the time zone. */
const dayOf = (d: string | null): Date | null => (d ? new Date(`${d.slice(0, 10)}T00:00:00`) : null);
const dateText = (d: string | null) => { const x = dayOf(d); return x && Number.isFinite(x.getTime()) ? x.toLocaleDateString() : ""; };
const daysLeft = (d: string | null) => { const x = dayOf(d); return x ? Math.ceil((x.getTime() - Date.now()) / DAY) : null; };

type Form = { id: string | null; clientId: string; name: string; kind: AssetKind; manufacturer: string; model: string; serialNumber: string; location: string; purchaseDate: string; expiresAt: string; notes: string };
const blank = (clientId = ""): Form => ({ id: null, clientId, name: "", kind: "computer", manufacturer: "", model: "", serialNumber: "", location: "", purchaseDate: "", expiresAt: "", notes: "" });

function AssetsBody() {
    const { permissions } = useMe();
    const canWrite = hasPerm(permissions, ["assets.read", "assets.write"]);
    const [owner, setOwner] = React.useState<AssetProviderInfo | null>(null);
    const [items, setItems] = React.useState<Asset[] | null>(null);
    const [customers, setCustomers] = React.useState<CustomerClient[]>([]);
    const [clientId, setClientId] = React.useState("");
    const [kind, setKind] = React.useState("");
    const [term, setTerm] = React.useState("");
    const [soonOnly, setSoonOnly] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const [note, setNote] = React.useState<string | null>(null);
    const [busy, setBusy] = React.useState<string | null>(null);
    const [form, setForm] = React.useState<Form | null>(null);
    const [formError, setFormError] = React.useState<string | null>(null);
    const alive = React.useRef(true);
    const focused = React.useRef(false);
    React.useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

    React.useEffect(() => {
        void assetProvider.get().then((o) => alive.current && setOwner(o)).catch(() => alive.current && setOwner({ provider: "builtin", externalName: null, externalUrl: null, changedAt: null, canSwitch: false }));
        void fetchCustomers().then((c) => alive.current && setCustomers(c)).catch(() => { });
    }, []);

    const load = React.useCallback(async () => {
        if (owner?.provider !== "builtin") return;
        try { const r = await itdocs.assets({ clientId: clientId || undefined, kind: kind || undefined, q: term || undefined }); if (alive.current) { setItems(r.items); setError(null); } }
        catch (e) { if (alive.current) { setError(errorText(e)); setItems((x) => x ?? []); } }
    }, [owner?.provider, clientId, kind, term]);
    React.useEffect(() => { const t = setTimeout(() => void load(), term ? 300 : 0); return () => clearTimeout(t); }, [load, term]);

    const edit = React.useCallback((a: Asset) => {
        setFormError(null);
        setForm({ id: a.id, clientId: a.client.id, name: a.name, kind: a.kind, manufacturer: a.manufacturer ?? "", model: a.model ?? "", serialNumber: a.serialNumber ?? "", location: a.location ?? "", purchaseDate: a.purchaseDate?.slice(0, 10) ?? "", expiresAt: a.expiresAt?.slice(0, 10) ?? "", notes: a.notes ?? "" });
    }, []);
    // a link from Network discovery or SNMP opens the asset it points at
    React.useEffect(() => {
        if (focused.current || !items) return;
        const id = new URLSearchParams(window.location.search).get("asset");
        const hit = id ? items.find((a) => a.id === id) : null;
        if (hit) { focused.current = true; edit(hit); }
    }, [items, edit]);

    const save = async () => {
        if (!form) return;
        setBusy("save"); setFormError(null);
        try {
            const body = { clientId: form.clientId, name: form.name.trim(), kind: form.kind, manufacturer: form.manufacturer.trim() || undefined, model: form.model.trim() || undefined, serialNumber: form.serialNumber.trim() || undefined, location: form.location.trim() || undefined, purchaseDate: form.purchaseDate || undefined, expiresAt: form.expiresAt || undefined, notes: form.notes.trim() || undefined };
            await itdocs.saveAsset(form.id, body);
            setForm(null); await load();
        } catch (e) { setFormError(errorText(e)); } finally { setBusy(null); }
    };
    const remove = async (a: Asset) => {
        if (!window.confirm(`Delete ${a.name}? Links to it are removed too. This cannot be undone.`)) return;
        setBusy(a.id);
        try { await itdocs.deleteAsset(a.id); setForm(null); await load(); } catch (e) { setError(errorText(e)); } finally { setBusy(null); }
    };
    const sync = async () => {
        setBusy("sync"); setNote(null);
        try { const r = await itdocs.syncAssets(); setNote(`Updated from agents: ${r.created} new, ${r.updated} refreshed.`); await load(); } catch (e) { setError(errorText(e)); } finally { setBusy(null); }
    };

    if (owner && owner.provider === "external") {
        return (
            <PageShell>
                <PageHeader title="Assets" description="The things your customers own." />
                <EmptyState>
                    <div className="font-medium text-foreground">Assets are managed in {owner.externalName}</div>
                    <div>The built-in asset manager is switched off.{owner.externalUrl ? <> <a className="text-primary hover:underline" href={owner.externalUrl} target="_blank" rel="noreferrer noopener">Open {owner.externalName}</a>.</> : null}{owner.canSwitch ? <> You can switch back under <Link className="text-primary hover:underline" href="/administration?tab=integrations">Administration &gt; Integrations</Link>.</> : null}</div>
                </EmptyState>
            </PageShell>
        );
    }

    const all = items ?? [];
    const shown = soonOnly ? all.filter((a) => { const d = daysLeft(a.expiresAt); return d !== null && d <= 90; }) : all;
    const soon = all.filter((a) => { const d = daysLeft(a.expiresAt); return d !== null && d <= 90; }).length;
    const fromAgents = all.filter((a) => a.source === "agent").length;
    const endsLabel = KINDS.find((k) => k.value === form?.kind)?.ends ?? "Ends";

    return (
        <PageShell>
            <PageHeader
                title="Assets"
                description="The things your customers own. Computers and servers with an agent fill in by themselves every hour; printers, switches, licences, domains and certificates are entered here or recorded from Network discovery and SNMP monitoring. Warranty and licence end dates feed the expiry emails and the renewals report."
                actions={canWrite ? (
                    <div className="flex flex-wrap items-center gap-2">
                        <Button variant="outline" size="sm" className="gap-2" disabled={busy === "sync"} onClick={() => void sync()}>{busy === "sync" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-4 w-4" aria-hidden="true" />}Update from agents now</Button>
                        <Button size="sm" onClick={() => { setFormError(null); setForm(blank(clientId)); }}>Add an asset</Button>
                    </div>
                ) : undefined}
            />
            {error ? <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">{error}</p> : null}
            {note ? <p role="status" className="rounded-md border bg-muted/40 px-3 py-2 text-sm">{note}</p> : null}

            <div className="flex flex-wrap items-center gap-2">
                <select aria-label="Customer" className="h-9 rounded-md border bg-background px-2 text-sm" value={clientId} onChange={(e) => setClientId(e.target.value)}>
                    <option value="">All customers</option>{customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
                <select aria-label="Type" className="h-9 rounded-md border bg-background px-2 text-sm" value={kind} onChange={(e) => setKind(e.target.value)}>
                    <option value="">All types</option>{KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
                </select>
                <input aria-label="Search assets" placeholder="Name, serial number or model" className="h-9 w-64 rounded-md border bg-background px-3 text-sm" value={term} onChange={(e) => setTerm(e.target.value)} />
                <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={soonOnly} onChange={(e) => setSoonOnly(e.target.checked)} />Ending within 90 days{items ? ` (${soon})` : ""}</label>
                {items ? <span className="ml-auto text-xs text-muted-foreground" data-testid="asset-summary">{all.length} {all.length === 1 ? "asset" : "assets"}, {fromAgents} from agents, {all.length - fromAgents} from other sources</span> : null}
            </div>

            {items === null ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />Loading…</div>
            ) : shown.length === 0 ? (
                <EmptyState>
                    <div className="font-medium text-foreground">{soonOnly ? "Nothing ends within 90 days" : term || clientId || kind ? "No asset matches" : "No assets yet"}</div>
                    <div>{all.length === 0 && !term && !clientId && !kind ? "Computers and servers with an agent appear within the hour (or press Update from agents now). Add everything else with Add an asset." : "Change the filters to see more."}</div>
                </EmptyState>
            ) : (
                <div className="overflow-x-auto rounded-lg border">
                    <table className="w-full text-sm" data-testid="asset-table">
                        <caption className="sr-only">Assets</caption>
                        <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
                            <tr><th scope="col" className="px-3 py-2">Asset</th><th scope="col" className="px-3 py-2">Type</th><th scope="col" className="hidden px-3 py-2 md:table-cell">Customer</th><th scope="col" className="hidden px-3 py-2 lg:table-cell">Where / what</th><th scope="col" className="hidden px-3 py-2 sm:table-cell">Purchased</th><th scope="col" className="px-3 py-2">Ends</th><th scope="col" className="hidden px-3 py-2 lg:table-cell">Source</th>{canWrite ? <th scope="col" className="px-3 py-2"><span className="sr-only">Actions</span></th> : null}</tr>
                        </thead>
                        <tbody className="divide-y">
                            {shown.map((a) => {
                                const left = daysLeft(a.expiresAt);
                                const tone = left === null ? "" : left < 0 ? "font-medium text-destructive" : left <= 30 ? "font-medium text-amber-700 dark:text-amber-400" : "";
                                const detail = [a.location, a.details?.os, (a.details as any)?.ip].filter(Boolean).join(" · ");
                                return (
                                    <tr key={a.id} className="align-top hover:bg-accent/30" data-testid="asset-row">
                                        <td className="px-3 py-2.5">
                                            <button className="flex items-start gap-2 text-left font-medium hover:underline" onClick={() => edit(a)}><Boxes className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />{a.name}</button>
                                            <span className="block pl-6 text-xs text-muted-foreground">{[a.manufacturer, a.model, a.serialNumber ? `S/N ${a.serialNumber}` : null].filter(Boolean).join(" · ") || "No details"}</span>
                                            {a.deviceId ? <Link href={`/devices/${encodeURIComponent(a.deviceId)}`} className="block pl-6 text-xs text-primary hover:underline">Open the device</Link> : null}
                                        </td>
                                        <td className="px-3 py-2.5">{KIND_TEXT[a.kind] ?? a.kind}</td>
                                        <td className="hidden px-3 py-2.5 md:table-cell">{a.client.name}</td>
                                        <td className="hidden px-3 py-2.5 text-xs text-muted-foreground lg:table-cell">{detail || "—"}</td>
                                        <td className="hidden px-3 py-2.5 sm:table-cell">{dateText(a.purchaseDate) || <span className="text-muted-foreground">—</span>}</td>
                                        <td className={`px-3 py-2.5 ${tone}`}>{a.expiresAt ? <>{dateText(a.expiresAt)}<span className="block text-xs font-normal">{left! < 0 ? `ended ${-left!} days ago` : left === 0 ? "today" : `in ${left} days`}</span></> : <span className="text-muted-foreground">—</span>}</td>
                                        <td className="hidden px-3 py-2.5 text-xs text-muted-foreground lg:table-cell">{SOURCE_TEXT[a.source] ?? a.source}</td>
                                        {canWrite ? <td className="px-3 py-2.5"><Button variant="outline" size="sm" onClick={() => edit(a)}>Edit</Button></td> : null}
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}

            <Dialog open={!!form} onOpenChange={(o) => busy !== "save" && !o && setForm(null)}>
                <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
                    {form ? (
                        <>
                            <DialogHeader>
                                <DialogTitle>{form.id ? "Change this asset" : "Add an asset"}</DialogTitle>
                                <DialogDescription>{form.id && items?.find((a) => a.id === form.id)?.source === "agent" ? "This asset comes from a device with an agent. The name, model, serial number and details are refreshed from the agent every hour; what you type here for location, dates and notes is kept." : "Fill in what you know. Only the customer, the name and the type are needed."}</DialogDescription>
                            </DialogHeader>
                            <div className="grid gap-3">
                                <label className="grid min-w-0 gap-1 text-sm"><span className="font-medium">Customer</span>
                                    <select className="h-10 w-full min-w-0 rounded-md border bg-background px-2 text-sm" value={form.clientId} onChange={(e) => setForm({ ...form, clientId: e.target.value })}>
                                        <option value="">Choose a customer</option>{customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                                    </select></label>
                                <div className="grid grid-cols-2 gap-3">
                                    <label className="grid min-w-0 gap-1 text-sm"><span className="font-medium">Name</span><input className="h-10 w-full min-w-0 rounded-md border bg-background px-3 text-sm" maxLength={200} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
                                    <label className="grid min-w-0 gap-1 text-sm"><span className="font-medium">Type</span>
                                        <select className="h-10 w-full min-w-0 rounded-md border bg-background px-2 text-sm" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as AssetKind })}>{KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}</select></label>
                                </div>
                                <div className="grid grid-cols-3 gap-3">
                                    <label className="grid min-w-0 gap-1 text-sm"><span className="font-medium">Maker</span><input className="h-10 w-full min-w-0 rounded-md border bg-background px-3 text-sm" maxLength={200} value={form.manufacturer} onChange={(e) => setForm({ ...form, manufacturer: e.target.value })} /></label>
                                    <label className="grid min-w-0 gap-1 text-sm"><span className="font-medium">Model</span><input className="h-10 w-full min-w-0 rounded-md border bg-background px-3 text-sm" maxLength={200} value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} /></label>
                                    <label className="grid min-w-0 gap-1 text-sm"><span className="font-medium">Serial number</span><input className="h-10 w-full min-w-0 rounded-md border bg-background px-3 text-sm" maxLength={200} value={form.serialNumber} onChange={(e) => setForm({ ...form, serialNumber: e.target.value })} /></label>
                                </div>
                                <label className="grid min-w-0 gap-1 text-sm"><span className="font-medium">Location</span><input className="h-10 w-full min-w-0 rounded-md border bg-background px-3 text-sm" maxLength={200} placeholder="Front desk, rack 2, John's office" value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} /></label>
                                <div className="grid grid-cols-2 gap-3">
                                    <label className="grid min-w-0 gap-1 text-sm"><span className="font-medium">Purchased</span><input type="date" className="h-10 w-full min-w-0 rounded-md border bg-background px-3 text-sm" value={form.purchaseDate} onChange={(e) => setForm({ ...form, purchaseDate: e.target.value })} /></label>
                                    <label className="grid min-w-0 gap-1 text-sm"><span className="font-medium">{endsLabel}</span><input type="date" className="h-10 w-full min-w-0 rounded-md border bg-background px-3 text-sm" value={form.expiresAt} onChange={(e) => setForm({ ...form, expiresAt: e.target.value })} /></label>
                                </div>
                                <p className="-mt-1 text-xs text-muted-foreground">An end date gets an email 30, 7 and 1 days before it, and shows in the renewals report.</p>
                                <label className="grid min-w-0 gap-1 text-sm"><span className="font-medium">Notes</span><textarea className="min-h-20 rounded-md border bg-background px-3 py-2 text-sm" maxLength={10000} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></label>
                            </div>
                            {formError ? <p role="alert" className="text-sm text-destructive">{formError}</p> : null}
                            <DialogFooter>
                                {form.id && canWrite ? (() => { const a = items?.find((x) => x.id === form.id); return a?.deviceId
                                    ? <span className="mr-auto self-center text-xs text-muted-foreground">To remove this, remove the device.</span>
                                    : <Button variant="ghost" className="mr-auto" disabled={busy !== null} onClick={() => a && void remove(a)}>Delete</Button>; })() : null}
                                <Button variant="outline" onClick={() => setForm(null)} disabled={busy === "save"}>Cancel</Button>
                                {canWrite ? <Button onClick={() => void save()} disabled={busy === "save" || !form.clientId || !form.name.trim()} className="gap-2">{busy === "save" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}{busy === "save" ? "Saving…" : "Save"}</Button> : null}
                            </DialogFooter>
                        </>
                    ) : null}
                </DialogContent>
            </Dialog>
        </PageShell>
    );
}

export default function AssetsPage() {
    return (
        <PermGate require="assets.read" title="Assets" message="You need permission to view assets.">
            <AssetsBody />
        </PermGate>
    );
}
