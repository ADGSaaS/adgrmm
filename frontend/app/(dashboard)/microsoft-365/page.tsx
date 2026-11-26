"use client";

// Microsoft 365: the tenants of customers, read through Microsoft Graph (read-only): who has no multi-factor sign-in, administrators, licences paid
// for and not used, people who left but still hold a licence, and Microsoft's own Secure Score. The client secret is stored encrypted and never shown.
import * as React from "react";
import { Cloud, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { PageHeader, PageShell } from "@/components/page-shell";
import PermGate from "@/components/perm-gate";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EmptyState } from "@/components/list-controls";
import { errorText } from "@/components/policies/shared";
import { fetchCustomers, type CustomerClient } from "@/lib/api";
import { m365, type Finding, type M365Tenant } from "@/lib/m365-api";
import { hasPerm } from "@/lib/permissions";
import { ago } from "@/lib/security-api";
import { useMe } from "@/lib/use-me";

const selectClass = "h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const SEV: Record<Finding["severity"], { label: string; cls: string }> = {
    critical: { label: "Critical", cls: "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-400" },
    warning: { label: "Warning", cls: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400" },
    info: { label: "Good to know", cls: "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-400" },
};
const PERMISSIONS = ["User.Read.All", "Directory.Read.All", "Organization.Read.All", "Reports.Read.All", "Policy.Read.All", "SecurityEvents.Read.All", "AuditLog.Read.All"];

function healthClass(h: number | null) {
    if (h === null) return "text-muted-foreground";
    return h >= 85 ? "text-emerald-600 dark:text-emerald-400" : h >= 60 ? "text-amber-600 dark:text-amber-400" : "text-red-600 dark:text-red-400";
}

function ConnectDialog({ clients, tenant, onClose, onSaved }: { clients: CustomerClient[]; tenant: M365Tenant | null; onClose: () => void; onSaved: () => void }) {
    const [clientId, setClientId] = React.useState("");
    const [tenantName, setTenantName] = React.useState("");
    const [appId, setAppId] = React.useState(tenant?.appId ?? "");
    const [secret, setSecret] = React.useState("");
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const editing = !!tenant;
    const save = async () => {
        setBusy(true); setError(null);
        try {
            if (tenant) await m365.update(tenant.id, { appId: appId.trim(), ...(secret ? { secret } : {}) });
            else await m365.create({ clientId, tenant: tenantName.trim(), appId: appId.trim(), secret });
            onSaved();
        } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
    };
    return (
        <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
            <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
                <DialogHeader>
                    <DialogTitle>{editing ? `Change the app for ${tenant?.name}` : "Connect a Microsoft 365 tenant"}</DialogTitle>
                    <DialogDescription>ADG RMM reads the tenant through an app registered in the customer&apos;s Microsoft Entra ID. It only reads: it never changes users, licences or settings.</DialogDescription>
                </DialogHeader>
                <div className="grid gap-4">
                    {!editing ? (
                        <details className="rounded-md border p-3 text-sm">
                            <summary className="cursor-pointer font-medium">How to set it up in Microsoft Entra (once per customer)</summary>
                            <ol className="mt-2 list-decimal space-y-1 pl-5 text-muted-foreground">
                                <li>In the Entra admin center: App registrations &gt; New registration. Any name, this directory only.</li>
                                <li>API permissions &gt; Add &gt; Microsoft Graph &gt; <strong>Application permissions</strong>: {PERMISSIONS.map((p, i) => <code key={p}>{p}{i < PERMISSIONS.length - 1 ? ", " : ""}</code>)}. Then <strong>Grant admin consent</strong>.</li>
                                <li>Certificates &amp; secrets &gt; New client secret. Copy its <strong>Value</strong> now (it is shown once).</li>
                                <li>On the app&apos;s Overview page copy the Application (client) ID and the Directory (tenant) ID, and enter them here.</li>
                            </ol>
                            <p className="mt-2 text-xs text-muted-foreground">Without AuditLog.Read.All and an Entra ID P1 licence, sign-in times are not available and inactive people are not listed. Everything else still works.</p>
                        </details>
                    ) : null}
                    {!editing ? (
                        <>
                            <div className="grid gap-1"><Label htmlFor="m3-client">Customer</Label>
                                <select id="m3-client" className={selectClass} value={clientId} onChange={(e) => setClientId(e.target.value)}>
                                    <option value="">Choose a customer</option>
                                    {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                                </select>
                            </div>
                            <div className="grid gap-1"><Label htmlFor="m3-tenant">Tenant ID or domain</Label><Input id="m3-tenant" value={tenantName} onChange={(e) => setTenantName(e.target.value)} placeholder="contoso.onmicrosoft.com or a GUID" /></div>
                        </>
                    ) : null}
                    <div className="grid gap-1"><Label htmlFor="m3-app">Application (client) ID</Label><Input id="m3-app" value={appId} onChange={(e) => setAppId(e.target.value)} placeholder="11111111-2222-3333-4444-555555555555" /></div>
                    <div className="grid gap-1"><Label htmlFor="m3-secret">{editing ? "New client secret (leave empty to keep the current one)" : "Client secret (value)"}</Label><Input id="m3-secret" type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} /></div>
                    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
                </div>
                <DialogFooter>
                    <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
                    <Button onClick={() => void save()} disabled={busy || !appId.trim() || (!editing && (!clientId || !tenantName.trim() || !secret))} className="gap-2">{busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}{editing ? "Save" : "Connect and read"}</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function Detail({ id, canWrite, onChanged, onEdit, onClose }: { id: string; canWrite: boolean; onChanged: () => void; onEdit: (t: M365Tenant) => void; onClose: () => void }) {
    const [t, setT] = React.useState<M365Tenant | null>(null);
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const load = React.useCallback(async () => { try { setT(await m365.get(id)); } catch (e) { setError(errorText(e)); } }, [id]);
    React.useEffect(() => { void load(); }, [load]);
    React.useEffect(() => { if (!t?.syncing) return; const x = setInterval(() => void load(), 2000); return () => clearInterval(x); }, [t?.syncing, load]);
    const sync = async () => { setBusy(true); setError(null); try { setT(await m365.sync(id)); onChanged(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); } };
    const remove = async () => {
        if (!t || !window.confirm(`Disconnect ${t.name}? What was read from it is deleted. The tenant itself is not touched.`)) return;
        setBusy(true);
        try { await m365.remove(id); onChanged(); onClose(); } catch (e) { setError(errorText(e)); setBusy(false); }
    };
    const s = t?.summary;
    return (
        <Dialog open onOpenChange={(o) => !o && onClose()}>
            <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-3xl" data-testid="m365-detail">
                <DialogHeader>
                    <DialogTitle>{t?.name ?? "Microsoft 365"}</DialogTitle>
                    <DialogDescription>{t ? `${t.customer ?? ""} · ${t.tenant} · read ${ago(t.lastSyncedAt)}` : "Loading…"}</DialogDescription>
                </DialogHeader>
                {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
                {t?.status === "error" ? <p role="alert" className="rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm">The last reading did not work: {t.error}{s ? " The numbers below are from the last reading that worked." : ""}</p> : null}
                {!t ? <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" /> : !s ? <p className="text-sm text-muted-foreground">{t.syncing ? "Reading the tenant…" : "Nothing has been read yet."}</p> : (
                    <div className="grid gap-5">
                        <div className="flex flex-wrap gap-6">
                            <div><div className={`text-3xl font-semibold ${healthClass(s.health)}`}>{s.health ?? "—"}</div><div className="text-xs text-muted-foreground">Health out of 100</div></div>
                            {s.counts ? <div><div className="text-3xl font-semibold">{s.counts.members}</div><div className="text-xs text-muted-foreground">people ({s.counts.licensed} licensed{s.counts.guests ? `, ${s.counts.guests} guests` : ""})</div></div> : null}
                            {s.mfa ? <div><div className="text-3xl font-semibold">{s.mfa.registered}/{s.mfa.checked}</div><div className="text-xs text-muted-foreground">with multi-factor sign-in</div></div> : null}
                            {s.score ? <div><div className="text-3xl font-semibold">{s.score.percent}%</div><div className="text-xs text-muted-foreground">Microsoft Secure Score</div></div> : null}
                        </div>
                        <section aria-label="Findings">
                            <h3 className="mb-2 text-sm font-semibold">What needs a look</h3>
                            {s.findings.length === 0 ? <p className="text-sm text-emerald-700 dark:text-emerald-400">Nothing found in what could be read.</p> : (
                                <ul className="grid gap-2">
                                    {s.findings.map((f) => (
                                        <li key={f.id} className="rounded-md border p-3 text-sm" data-testid="m365-finding">
                                            <span className={`mr-2 inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${SEV[f.severity].cls}`}>{SEV[f.severity].label}</span>
                                            <span className="font-medium">{f.title}</span>
                                            <p className="mt-1 text-xs text-muted-foreground">{f.detail}</p>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </section>
                        {s.licenses.length ? (
                            <section aria-label="Licences">
                                <h3 className="mb-2 text-sm font-semibold">Licences</h3>
                                <table className="w-full text-left text-sm"><thead className="text-xs text-muted-foreground"><tr><th className="py-1">Licence</th><th>Bought</th><th>Given out</th><th>Free</th></tr></thead>
                                    <tbody className="divide-y">{s.licenses.map((l) => <tr key={l.sku}><td className="py-1.5">{l.name}</td><td>{l.enabled}</td><td>{l.consumed}</td><td className={!l.free && l.available > 0 ? "text-amber-700 dark:text-amber-400" : ""}>{l.available}</td></tr>)}</tbody>
                                </table>
                            </section>
                        ) : null}
                        {s.mfa && s.mfa.missingList.length ? (
                            <section aria-label="Without multi-factor sign-in">
                                <h3 className="mb-2 text-sm font-semibold">Without multi-factor sign-in ({s.mfa.missing})</h3>
                                <ul className="grid gap-0.5 text-sm sm:grid-cols-2">{s.mfa.missingList.map((m) => <li key={m.upn} className="truncate" title={m.upn}>{m.name} <span className="text-xs text-muted-foreground">{m.upn}</span></li>)}</ul>
                            </section>
                        ) : null}
                        {s.admins.length ? (
                            <section aria-label="Administrators">
                                <h3 className="mb-2 text-sm font-semibold">Administrators</h3>
                                <ul className="grid gap-2 text-sm">{s.admins.map((a) => (
                                    <li key={a.role}><span className="font-medium">{a.role}</span>
                                        <span className="block text-xs text-muted-foreground">{a.members.map((m) => `${m.name}${m.mfa === false ? " (no multi-factor sign-in)" : ""}`).join(", ")}</span>
                                    </li>
                                ))}</ul>
                            </section>
                        ) : null}
                        {Object.keys(s.notRead).length ? (
                            <section aria-label="Not read">
                                <h3 className="mb-2 text-sm font-semibold">What could not be read</h3>
                                <ul className="grid gap-1 text-xs text-muted-foreground">{Object.entries(s.notRead).map(([k, v]) => <li key={k}><span className="font-medium text-foreground">{k}</span>: {v}</li>)}</ul>
                            </section>
                        ) : null}
                    </div>
                )}
                <DialogFooter className="flex-wrap gap-2 sm:justify-between">
                    {canWrite && t ? <Button variant="ghost" className="gap-2 text-destructive" onClick={() => void remove()} disabled={busy}><Trash2 className="h-4 w-4" aria-hidden="true" />Disconnect</Button> : <span />}
                    <div className="flex gap-2">
                        {canWrite && t ? <Button variant="outline" onClick={() => onEdit(t)} disabled={busy}>Change the app or secret</Button> : null}
                        {canWrite ? <Button onClick={() => void sync()} disabled={busy || !t} className="gap-2">{busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-4 w-4" aria-hidden="true" />}Read again now</Button> : null}
                    </div>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function M365Body() {
    const { permissions } = useMe();
    const canWrite = hasPerm(permissions, "customers.write");
    const [items, setItems] = React.useState<M365Tenant[] | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [clients, setClients] = React.useState<CustomerClient[]>([]);
    const [connect, setConnect] = React.useState<M365Tenant | "new" | null>(null);
    const [open, setOpen] = React.useState<string | null>(null);

    const load = React.useCallback(async () => { try { setItems((await m365.list()).items); setError(null); } catch (e) { setError(errorText(e)); } }, []);
    React.useEffect(() => { void load(); }, [load]);
    const anySyncing = items?.some((i) => i.syncing) ?? false;
    React.useEffect(() => { const t = setInterval(() => void load(), anySyncing ? 2500 : 60_000); return () => clearInterval(t); }, [load, anySyncing]);
    React.useEffect(() => { void fetchCustomers().then(setClients).catch(() => setClients([])); }, []);

    return (
        <PageShell>
            <PageHeader
                title="Microsoft 365"
                description="Your customers' Microsoft 365 tenants: who has no multi-factor sign-in, administrators, licences paid for and not used. Read once a day, and never changed."
                actions={canWrite ? <Button className="gap-2" onClick={() => setConnect("new")}><Plus className="h-4 w-4" aria-hidden="true" />Connect a tenant</Button> : undefined}
            />
            {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
            {!items ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />Loading…</div>
            ) : items.length === 0 ? (
                <EmptyState><Cloud className="mx-auto mb-2 h-6 w-6 text-muted-foreground" aria-hidden="true" />No tenant is connected yet. Connect a customer&apos;s Microsoft 365 to see where it is open to attack.</EmptyState>
            ) : (
                <div className="overflow-x-auto rounded-lg border">
                    <table className="w-full text-left text-sm">
                        <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground"><tr><th className="px-3 py-2">Health</th><th className="px-3 py-2">Tenant</th><th className="hidden px-3 py-2 md:table-cell">Customer</th><th className="px-3 py-2">What needs a look</th><th className="hidden px-3 py-2 lg:table-cell">Read</th></tr></thead>
                        <tbody className="divide-y">
                            {items.map((t) => (
                                <tr key={t.id} className="cursor-pointer align-top hover:bg-accent/30" data-testid="m365-row" data-status={t.status} onClick={() => setOpen(t.id)}>
                                    <td className="px-3 py-2.5"><span className={`text-xl font-semibold ${healthClass(t.health)}`}>{t.syncing ? "…" : t.health ?? "—"}</span></td>
                                    <td className="px-3 py-2.5"><button className="font-medium hover:underline" onClick={(e) => { e.stopPropagation(); setOpen(t.id); }}>{t.name}</button><span className="block text-xs text-muted-foreground">{t.tenant}{t.users !== null ? ` · ${t.users} accounts` : ""}</span></td>
                                    <td className="hidden px-3 py-2.5 md:table-cell">{t.customer}</td>
                                    <td className="px-3 py-2.5">
                                        {t.status === "error" ? <span className="text-red-700 dark:text-red-400">{t.error}</span>
                                            : t.syncing || t.status === "pending" ? <span className="text-muted-foreground">Reading…</span>
                                                : t.critical + t.warnings === 0 ? <span className="text-emerald-700 dark:text-emerald-400">Nothing found</span>
                                                    : <span>{t.critical ? <strong className="text-red-700 dark:text-red-400">{t.critical} critical</strong> : null}{t.critical && t.warnings ? ", " : ""}{t.warnings ? `${t.warnings} ${t.warnings === 1 ? "warning" : "warnings"}` : ""}</span>}
                                        {t.status === "partial" ? <span className="block text-xs text-muted-foreground">Some parts could not be read.</span> : null}
                                    </td>
                                    <td className="hidden px-3 py-2.5 lg:table-cell">{ago(t.lastSyncedAt)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
            {connect ? <ConnectDialog clients={clients} tenant={connect === "new" ? null : connect} onClose={() => setConnect(null)} onSaved={() => { const was = connect !== "new" ? connect.id : null; setConnect(null); void load(); if (was) setOpen(was); }} /> : null}
            {open ? <Detail id={open} canWrite={canWrite} onChanged={() => void load()} onEdit={(t) => { setOpen(null); setConnect(t); }} onClose={() => setOpen(null)} /> : null}
        </PageShell>
    );
}

export default function Microsoft365Page() {
    return (
        <PermGate require="customers.read" title="Microsoft 365" message="You need permission to view customers to see their Microsoft 365 tenants.">
            <M365Body />
        </PermGate>
    );
}
