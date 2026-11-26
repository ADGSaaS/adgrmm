"use client";

// EDR and antivirus: which computers a security console (Defender for Endpoint, SentinelOne, Huntress, CrowdStrike) protects and how well, read from
// the console (read-only) and matched to the computers ADG RMM manages. The point is the gaps: a computer no console knows, a protection that is
// unhealthy, and a console endpoint that is not managed here.
import * as React from "react";
import Link from "next/link";
import { Loader2, Pencil, Plus, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import { PageHeader, PageShell } from "@/components/page-shell";
import PermGate from "@/components/perm-gate";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EmptyState, SearchField, SegmentedTabs } from "@/components/list-controls";
import { errorText } from "@/components/policies/shared";
import { fetchCustomers, type CustomerClient } from "@/lib/api";
import { edr, type EdrConnection, type EdrCoverage, type Health, type VendorDef, type Verdict } from "@/lib/edr-api";
import { hasPerm } from "@/lib/permissions";
import { ago } from "@/lib/security-api";
import { useMe } from "@/lib/use-me";

const selectClass = "h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const BADGE: Record<Verdict, { label: string; cls: string }> = {
    healthy: { label: "Protected", cls: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" },
    warning: { label: "Warning", cls: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400" },
    unhealthy: { label: "Unhealthy", cls: "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-400" },
    unknown: { label: "Can't tell", cls: "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-400" },
    none: { label: "Not in any console", cls: "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-400" },
};
const dot = (h: Health) => (h === "healthy" ? "bg-emerald-500" : h === "warning" ? "bg-amber-500" : h === "unhealthy" ? "bg-red-500" : "bg-muted-foreground/40");

function ConnectionDialog({ vendors, clients, connection, onClose, onSaved }: { vendors: VendorDef[]; clients: CustomerClient[]; connection: EdrConnection | null; onClose: () => void; onSaved: () => void }) {
    const editing = !!connection;
    const [vendor, setVendor] = React.useState(connection?.vendor ?? vendors[0]?.key ?? "mde");
    const [name, setName] = React.useState(connection?.name ?? "");
    const [clientId, setClientId] = React.useState(connection?.clientId ?? "");
    const [values, setValues] = React.useState<Record<string, string>>({ ...(connection?.config ?? {}) });
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const def = vendors.find((v) => v.key === vendor);
    const save = async () => {
        setBusy(true); setError(null);
        try {
            const body = { ...values, name: name.trim() || undefined, clientId: clientId || null };
            if (connection) await edr.update(connection.id, body); else await edr.create({ ...body, vendor });
            onSaved();
        } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
    };
    return (
        <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
            <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
                <DialogHeader>
                    <DialogTitle>{editing ? `Change ${connection?.name}` : "Connect a security console"}</DialogTitle>
                    <DialogDescription>ADG RMM only reads the list of protected computers. It never changes anything in the console. Credentials are stored encrypted and are not shown again.</DialogDescription>
                </DialogHeader>
                <div className="grid gap-4">
                    {!editing ? (
                        <div className="grid gap-1"><Label htmlFor="edr-vendor">Product</Label>
                            <select id="edr-vendor" className={selectClass} value={vendor} onChange={(e) => { setVendor(e.target.value as typeof vendor); setValues({}); }}>
                                {vendors.map((v) => <option key={v.key} value={v.key}>{v.label}</option>)}
                            </select>
                        </div>
                    ) : null}
                    {def?.fields.map((f) => (
                        <div key={f.name} className="grid gap-1">
                            <Label htmlFor={`edr-${f.name}`}>{f.label}{editing && f.secret ? " (leave empty to keep the current one)" : ""}</Label>
                            {f.options ? (
                                <select id={`edr-${f.name}`} className={selectClass} value={values[f.name] ?? ""} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}>
                                    <option value="">Choose</option>{f.options.map((o) => <option key={o} value={o}>{o}</option>)}
                                </select>
                            ) : <Input id={`edr-${f.name}`} type={f.secret ? "password" : "text"} autoComplete="off" value={values[f.name] ?? ""} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })} />}
                            <span className="text-xs text-muted-foreground">{f.help}</span>
                        </div>
                    ))}
                    <div className="grid gap-1"><Label htmlFor="edr-name">Name (optional)</Label><Input id="edr-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={def?.label} /></div>
                    <div className="grid gap-1">
                        <Label htmlFor="edr-client">Which customer is this console for?</Label>
                        <select id="edr-client" className={selectClass} value={clientId} onChange={(e) => setClientId(e.target.value)}>
                            <option value="">All customers (one console for everyone)</option>
                            {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                        </select>
                        <span className="text-xs text-muted-foreground">For one customer, computers are matched only inside that customer. For all customers, a computer name used by two customers is not matched (it cannot be told apart); a serial number still is.</span>
                    </div>
                    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
                </div>
                <DialogFooter>
                    <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
                    <Button onClick={() => void save()} disabled={busy} className="gap-2">{busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}{editing ? "Save" : "Connect and read"}</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function EdrBody() {
    const { permissions } = useMe();
    const canWrite = hasPerm(permissions, "settings.write");
    const [data, setData] = React.useState<EdrCoverage | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [vendors, setVendors] = React.useState<VendorDef[]>([]);
    const [clients, setClients] = React.useState<CustomerClient[]>([]);
    const [clientId, setClientId] = React.useState("");
    const [tab, setTab] = React.useState("all");
    const [term, setTerm] = React.useState("");
    const [dialog, setDialog] = React.useState<EdrConnection | "new" | null>(null);
    const [busy, setBusy] = React.useState<string | null>(null);

    const load = React.useCallback(async () => {
        try { setData(await edr.coverage(clientId ? `?clientId=${encodeURIComponent(clientId)}` : "")); setError(null); } catch (e) { setError(errorText(e)); }
    }, [clientId]);
    React.useEffect(() => { void load(); }, [load]);
    const syncing = data?.connections.some((c) => c.syncing) ?? false;
    React.useEffect(() => { const t = setInterval(() => void load(), syncing ? 2500 : 60_000); return () => clearInterval(t); }, [load, syncing]);
    React.useEffect(() => { void edr.vendors().then((v) => setVendors(v.vendors)).catch(() => setVendors([])); void fetchCustomers().then(setClients).catch(() => setClients([])); }, []);

    const act = async (id: string, fn: () => Promise<unknown>) => { setBusy(id); try { await fn(); await load(); } catch (e) { setError(errorText(e)); } finally { setBusy(null); } };

    const s = data?.summary;
    const shown = (data?.items ?? []).filter((i) => {
        if (term && !`${i.name} ${i.customer ?? ""} ${i.products.map((p) => p.vendorName).join(" ")}`.toLowerCase().includes(term.toLowerCase())) return false;
        if (tab === "gaps") return i.verdict === "none";
        if (tab === "problems") return i.verdict === "unhealthy" || i.verdict === "warning";
        if (tab === "ok") return i.verdict === "healthy";
        return true;
    });

    return (
        <PageShell>
            <PageHeader
                title="EDR and antivirus"
                description="Which computers a security console protects, and how well. Read from the console (read-only) and matched to the computers managed here, so the gaps show."
                actions={canWrite && vendors.length ? <Button className="gap-2" onClick={() => setDialog("new")}><Plus className="h-4 w-4" aria-hidden="true" />Connect a console</Button> : undefined}
            />
            {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}

            <section aria-label="Connected consoles" className="grid gap-2">
                {!data ? null : data.connections.length === 0 ? (
                    <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground" data-testid="no-consoles">No console is connected yet. Connect Microsoft Defender for Endpoint, SentinelOne, Huntress or CrowdStrike to see which computers are protected.</div>
                ) : (
                    <ul className="grid gap-2">
                        {data.connections.map((c) => (
                            <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm" data-testid="edr-connection">
                                <div className="min-w-0">
                                    <span className="font-medium">{c.name}</span> <span className="text-muted-foreground">{c.vendorName} · {c.customer ?? "all customers"}</span>
                                    <span className="block text-xs text-muted-foreground">
                                        {c.syncing ? "Reading…" : c.status === "error" ? <span className="text-red-700 dark:text-red-400">{c.error}</span> : `${c.endpoints} endpoints, read ${ago(c.lastSyncedAt)}`}
                                    </span>
                                </div>
                                {canWrite ? (
                                    <div className="flex gap-1">
                                        <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Read ${c.name} now`} title="Read now" disabled={busy === c.id} onClick={() => void act(c.id, () => edr.sync(c.id))}>{busy === c.id ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-4 w-4" aria-hidden="true" />}</Button>
                                        <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Change ${c.name}`} title="Change" onClick={() => setDialog(c)}><Pencil className="h-4 w-4" aria-hidden="true" /></Button>
                                        <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Disconnect ${c.name}`} title="Disconnect" disabled={busy === c.id} onClick={() => { if (window.confirm(`Disconnect ${c.name}? What was read from it is deleted. The console itself is not touched.`)) void act(c.id, () => edr.remove(c.id)); }}><Trash2 className="h-4 w-4" aria-hidden="true" /></Button>
                                    </div>
                                ) : null}
                            </li>
                        ))}
                    </ul>
                )}
            </section>

            <div className="flex flex-wrap items-center gap-3">
                <SegmentedTabs label="Show" value={tab} onChange={setTab} items={[
                    { key: "all", label: "All", count: s?.total }, { key: "gaps", label: "Not in any console", count: s?.none }, { key: "problems", label: "Warnings and problems", count: s ? s.warning + s.unhealthy : undefined }, { key: "ok", label: "Protected", count: s?.healthy },
                ]} />
                {clients.length > 1 ? (
                    <select aria-label="Customer" className="h-9 max-w-56 rounded-md border border-input bg-background px-2 text-sm" value={clientId} onChange={(e) => setClientId(e.target.value)}>
                        <option value="">All customers</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                ) : null}
                <SearchField value={term} onChange={setTerm} placeholder="Search computers" className="max-w-56" />
                {s?.coveredPercent !== null && s ? <span className="text-sm text-muted-foreground" data-testid="covered">{s.coveredPercent}% of computers are in a console</span> : null}
            </div>

            {!data ? <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />Loading…</div>
                : shown.length === 0 ? <EmptyState><ShieldCheck className="mx-auto mb-2 h-6 w-6 text-muted-foreground" aria-hidden="true" />{data.items.length === 0 ? "No computers with an agent yet." : "Nothing matches that filter."}</EmptyState>
                    : (
                        <div className="overflow-x-auto rounded-lg border">
                            <table className="w-full text-left text-sm">
                                <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground"><tr><th className="px-3 py-2">Status</th><th className="px-3 py-2">Computer</th><th className="px-3 py-2">What the consoles say</th></tr></thead>
                                <tbody className="divide-y">
                                    {shown.map((i) => (
                                        <tr key={i.deviceId} className="align-top hover:bg-accent/30" data-testid="edr-row" data-verdict={i.verdict}>
                                            <td className="px-3 py-2.5"><span className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${BADGE[i.verdict].cls}`}>{BADGE[i.verdict].label}</span></td>
                                            <td className="px-3 py-2.5"><Link href={`/devices/${encodeURIComponent(i.deviceId)}`} className="font-medium hover:underline">{i.name}</Link><span className="block text-xs text-muted-foreground">{i.customer ?? "No customer"}{i.site ? ` · ${i.site}` : ""} · {i.os === "windows" ? "Windows" : "Linux"}{i.online ? "" : " · offline"}</span></td>
                                            <td className="px-3 py-2.5">
                                                {i.products.length === 0 ? <span className="text-muted-foreground">No console lists this computer.</span> : (
                                                    <ul className="grid gap-1">{i.products.map((p) => (
                                                        <li key={`${p.connection}`} className="text-xs"><span className={`mr-1.5 inline-block h-2 w-2 rounded-full ${dot(p.health)}`} /><span className="font-medium">{p.vendorName}</span> <span className="text-muted-foreground">{p.detail}{p.lastSeenAt ? ` · seen ${ago(p.lastSeenAt)}` : ""}{p.agentVersion ? ` · version ${p.agentVersion}` : ""}</span></li>
                                                    ))}</ul>
                                                )}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}

            {data && data.unmatched.length > 0 ? (
                <details className="rounded-lg border p-3 text-sm">
                    <summary className="cursor-pointer font-medium">{data.unmatched.length}{data.unmatched.length >= 200 ? "+" : ""} endpoints in a console that are not computers managed here</summary>
                    <p className="mt-2 text-xs text-muted-foreground">These may be computers that have no ADG RMM agent, computers of customers you do not manage, or names that could not be matched (a name used by two customers).</p>
                    <ul className="mt-2 grid gap-0.5 text-xs sm:grid-cols-2">{data.unmatched.map((u, n) => <li key={`${u.hostname}-${n}`} className="truncate"><span className={`mr-1.5 inline-block h-2 w-2 rounded-full ${dot(u.health)}`} />{u.hostname} <span className="text-muted-foreground">({u.connection})</span></li>)}</ul>
                </details>
            ) : null}
            <p className="text-xs text-muted-foreground">Read every 30 minutes. A computer is matched by its serial number, or by its name when only one managed computer has that name. A protection that is unhealthy raises an alert on the computer.</p>
            {dialog && vendors.length ? <ConnectionDialog vendors={vendors} clients={clients} connection={dialog === "new" ? null : dialog} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); void load(); }} /> : null}
        </PageShell>
    );
}

export default function EdrPage() {
    return (
        <PermGate require="devices.read" title="EDR and antivirus" message="You need permission to view devices to see their protection.">
            <EdrBody />
        </PermGate>
    );
}
