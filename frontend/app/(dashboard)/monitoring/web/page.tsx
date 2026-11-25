"use client";

// Domains and certificates: the things on the internet a customer depends on, watched for them. A certificate that is about to run out, a
// domain that is about to lapse, DNS records that changed without anyone saying so. Each is checked on a schedule; this page is the list,
// and a change of state also goes out as an email and as a webhook (Slack and Teams included).
import * as React from "react";
import { Globe, Loader2, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { PageHeader, PageShell } from "@/components/page-shell";
import PermGate from "@/components/perm-gate";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EmptyState, SegmentedTabs } from "@/components/list-controls";
import { errorText } from "@/components/policies/shared";
import { fetchCustomers, type CustomerClient } from "@/lib/api";
import { hasPerm } from "@/lib/permissions";
import { ago } from "@/lib/security-api";
import { useMe } from "@/lib/use-me";
import { DNS_TYPES, KIND_LABEL, webMonitors, type DnsType, type MonitorConfig, type MonitorKind, type MonitorList, type MonitorStatus, type WebMonitor } from "@/lib/web-monitors-api";

const selectClass = "h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

const STATUS: Record<MonitorStatus, { label: string; cls: string }> = {
    ok: { label: "OK", cls: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" },
    warning: { label: "Warning", cls: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400" },
    failed: { label: "Problem", cls: "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-400" },
    error: { label: "Can't check", cls: "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-400" },
    pending: { label: "Not checked yet", cls: "border-muted-foreground/30 bg-muted text-muted-foreground" },
};

function Badge({ status }: { status: MonitorStatus }) {
    const s = STATUS[status];
    return <span className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs font-medium ${s.cls}`} data-testid="monitor-status">{s.label}</span>;
}

function when(m: WebMonitor): string {
    if (m.daysLeft === null || !m.expiresAt) return "";
    const date = m.expiresAt.slice(0, 10);
    if (m.daysLeft < 0) return `Ran out ${-m.daysLeft} ${-m.daysLeft === 1 ? "day" : "days"} ago (${date})`;
    if (m.daysLeft === 0) return `Runs out today (${date})`;
    return `${m.daysLeft} ${m.daysLeft === 1 ? "day" : "days"} left (${date})`;
}

/* ------------------------------ add and edit ------------------------------ */

type Draft = {
    kind: MonitorKind; name: string; host: string; port: string; clientId: string; warnDays: string; failDays: string;
    types: Record<DnsType, boolean>; expected: Record<DnsType, string>; enabled: boolean;
};

const DEFAULT_LIMITS: Record<"certificate" | "domain", { warn: number; fail: number }> = { certificate: { warn: 30, fail: 7 }, domain: { warn: 60, fail: 14 } };

function draftOf(m: WebMonitor | null, clientId: string): Draft {
    const types = { A: false, AAAA: false, MX: false, NS: false, TXT: false, CNAME: false } as Record<DnsType, boolean>;
    const expected = { A: "", AAAA: "", MX: "", NS: "", TXT: "", CNAME: "" } as Record<DnsType, string>;
    if (m?.kind === "dns") for (const r of m.config.records ?? []) { types[r.type] = true; expected[r.type] = (r.expected ?? []).join("\n"); }
    else { types.A = true; types.MX = true; types.NS = true; }
    const kind = m?.kind ?? "certificate";
    const lim = kind === "dns" ? DEFAULT_LIMITS.certificate : DEFAULT_LIMITS[kind];
    return {
        kind, name: m?.name ?? "", host: m?.host ?? "", port: String(m?.port ?? 443), clientId: m?.clientId ?? clientId,
        warnDays: String(m?.config.warnDays ?? lim.warn), failDays: String(m?.config.failDays ?? lim.fail), types, expected, enabled: m?.enabled ?? true,
    };
}

function MonitorDialog({ monitor, clients, defaultClient, mustPickClient, onClose, onSaved }: { monitor: WebMonitor | null; clients: CustomerClient[]; defaultClient: string; mustPickClient: boolean; onClose: () => void; onSaved: () => void }) {
    const [d, setD] = React.useState<Draft>(() => draftOf(monitor, defaultClient));
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }));
    const editing = !!monitor;

    const save = async () => {
        setBusy(true); setError(null);
        try {
            let config: MonitorConfig;
            if (d.kind === "dns") {
                config = {
                    records: DNS_TYPES.filter((t) => d.types[t]).map((t) => {
                        const values = d.expected[t].split("\n").map((s) => s.trim()).filter(Boolean);
                        return values.length ? { type: t, expected: values } : { type: t };
                    }),
                };
                if (!config.records?.length) throw new Error("Choose at least one record type to watch.");
            } else {
                config = { warnDays: Number(d.warnDays), failDays: Number(d.failDays) };
            }
            const body = { name: d.name.trim() || undefined, host: d.host.trim(), port: d.kind === "certificate" ? Number(d.port) || 443 : undefined, clientId: d.clientId || null, config, enabled: d.enabled };
            if (monitor) await webMonitors.update(monitor.id, body); else await webMonitors.create({ ...body, kind: d.kind });
            onSaved();
        } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
    };

    return (
        <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
            <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
                <DialogHeader>
                    <DialogTitle>{editing ? "Edit monitor" : "Add a monitor"}</DialogTitle>
                    <DialogDescription>Checked automatically. When something needs attention an email goes to the alert recipients, and a webhook goes out if one is set up for it.</DialogDescription>
                </DialogHeader>
                <div className="grid gap-4">
                    {!editing ? (
                        <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="What to monitor">
                            {([["certificate", "A website's certificate", "Days left, trusted, right name"], ["domain", "A domain's registration", "When it needs renewing"], ["dns", "DNS records", "Tell me when they change"]] as const).map(([k, t, s]) => (
                                <label key={k} className={`flex cursor-pointer flex-col gap-0.5 rounded-md border px-3 py-2 text-sm ${d.kind === k ? "border-primary bg-primary/10" : ""}`}>
                                    <span className="flex items-center gap-2 font-medium"><input type="radio" name="monitor-kind" className="accent-primary" checked={d.kind === k} onChange={() => set({ kind: k, warnDays: String(DEFAULT_LIMITS[k === "dns" ? "certificate" : k].warn), failDays: String(DEFAULT_LIMITS[k === "dns" ? "certificate" : k].fail) })} />{t}</span>
                                    <span className="pl-6 text-xs text-muted-foreground">{s}</span>
                                </label>
                            ))}
                        </div>
                    ) : null}
                    <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_7rem]">
                        <div className="grid gap-1">
                            <Label htmlFor="wm-host">{d.kind === "domain" ? "Domain" : "Host name"}</Label>
                            <Input id="wm-host" value={d.host} onChange={(e) => set({ host: e.target.value })} placeholder={d.kind === "domain" ? "example.com" : "www.example.com"} autoFocus />
                            <span className="text-xs text-muted-foreground">{d.kind === "domain" ? "The registered domain, without www." : "Only the name: no https:// and no path."}</span>
                        </div>
                        {d.kind === "certificate" ? (
                            <div className="grid gap-1"><Label htmlFor="wm-port">Port</Label><Input id="wm-port" type="number" min={1} max={65535} value={d.port} onChange={(e) => set({ port: e.target.value })} /></div>
                        ) : null}
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                        <div className="grid gap-1"><Label htmlFor="wm-name">Name (optional)</Label><Input id="wm-name" value={d.name} onChange={(e) => set({ name: e.target.value })} placeholder="Shown in the list" /></div>
                        <div className="grid gap-1">
                            <Label htmlFor="wm-client">Customer{mustPickClient ? "" : " (optional)"}</Label>
                            <select id="wm-client" className={selectClass} value={d.clientId} onChange={(e) => set({ clientId: e.target.value })}>
                                <option value="">{mustPickClient ? "Choose a customer" : "No customer"}</option>
                                {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                            </select>
                        </div>
                    </div>
                    {d.kind !== "dns" ? (
                        <div className="grid gap-3 sm:grid-cols-2">
                            <div className="grid gap-1"><Label htmlFor="wm-warn">Warn when fewer days are left than</Label><Input id="wm-warn" type="number" min={1} max={730} value={d.warnDays} onChange={(e) => set({ warnDays: e.target.value })} /></div>
                            <div className="grid gap-1"><Label htmlFor="wm-fail">Call it a problem below</Label><Input id="wm-fail" type="number" min={1} max={730} value={d.failDays} onChange={(e) => set({ failDays: e.target.value })} /></div>
                        </div>
                    ) : (
                        <fieldset className="grid gap-2 rounded-md border p-3">
                            <legend className="px-1 text-sm font-medium">Records to watch</legend>
                            <p className="text-xs text-muted-foreground">Leave &quot;should be&quot; empty to be told when a record changes from what it is now. Fill it in (one value per line) to be told when it is not that. For MX write the priority and the host, such as <code>10 mail.example.com</code>.</p>
                            {DNS_TYPES.map((t) => (
                                <div key={t} className="grid gap-1 sm:grid-cols-[6rem_minmax(0,1fr)] sm:items-start">
                                    <label className="flex items-center gap-2 pt-2 text-sm font-medium"><input type="checkbox" className="h-4 w-4 accent-primary" checked={d.types[t]} onChange={(e) => set({ types: { ...d.types, [t]: e.target.checked } })} />{t}</label>
                                    {d.types[t] ? (
                                        <textarea aria-label={`${t} should be`} rows={d.expected[t] ? Math.min(4, d.expected[t].split("\n").length + 1) : 1} className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs" placeholder="Should be (optional)" value={d.expected[t]} onChange={(e) => set({ expected: { ...d.expected, [t]: e.target.value } })} />
                                    ) : <span />}
                                </div>
                            ))}
                        </fieldset>
                    )}
                    {editing ? (
                        <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4 accent-primary" checked={d.enabled} onChange={(e) => set({ enabled: e.target.checked })} />Checking is on</label>
                    ) : null}
                    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
                </div>
                <DialogFooter>
                    <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
                    <Button onClick={() => void save()} disabled={busy || !d.host.trim() || (mustPickClient && !d.clientId)} className="gap-2">
                        {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}{busy ? "Saving…" : editing ? "Save" : "Add"}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

/* ------------------------------ the page ------------------------------ */

function WebMonitorsBody() {
    const { permissions } = useMe();
    const canWrite = hasPerm(permissions, "checks.write");
    const canDelete = hasPerm(permissions, "checks.delete");
    const canRun = hasPerm(permissions, "checks.run");
    const [data, setData] = React.useState<MonitorList | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [tab, setTab] = React.useState("all");
    const [kind, setKind] = React.useState("all");
    const [clients, setClients] = React.useState<CustomerClient[]>([]);
    const [clientSel, setClientSel] = React.useState("");
    const [editing, setEditing] = React.useState<WebMonitor | "new" | null>(null);
    const [busyId, setBusyId] = React.useState<string | null>(null);
    const [note, setNote] = React.useState<string | null>(null);

    const load = React.useCallback(async () => {
        try {
            setData(await webMonitors.list(clientSel ? `?clientId=${encodeURIComponent(clientSel)}` : ""));
            setError(null);
        } catch (e) { setError(errorText(e)); }
    }, [clientSel]);
    React.useEffect(() => { void load(); const t = setInterval(() => void load(), 30_000); return () => clearInterval(t); }, [load]);
    React.useEffect(() => { void fetchCustomers().then(setClients).catch(() => setClients([])); }, []);

    const act = async (id: string, fn: () => Promise<unknown>, done?: string) => {
        setBusyId(id); setNote(null);
        try { await fn(); if (done) setNote(done); await load(); } catch (e) { setError(errorText(e)); } finally { setBusyId(null); }
    };

    const items = (data?.items ?? []).filter((m) => {
        if (kind !== "all" && m.kind !== kind) return false;
        if (tab === "problems") return m.status === "failed" || m.status === "error";
        if (tab === "warning") return m.status === "warning";
        if (tab === "ok") return m.status === "ok";
        return true;
    });
    const s = data?.summary;

    return (
        <PageShell>
            <PageHeader
                title="Domains and certificates"
                description="Certificates that run out, domains that lapse and DNS records that change: checked for you, with a message when something needs attention."
                actions={canWrite ? <Button onClick={() => setEditing("new")} className="gap-2"><Plus className="h-4 w-4" aria-hidden="true" />Add a monitor</Button> : undefined}
            />
            {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
            {note ? <p role="status" className="text-sm text-muted-foreground">{note}</p> : null}
            <div className="flex flex-wrap items-center gap-3">
                <SegmentedTabs
                    label="Show"
                    value={tab}
                    onChange={setTab}
                    items={[
                        { key: "all", label: "All", count: s?.total },
                        { key: "problems", label: "Problems", count: s?.failed },
                        { key: "warning", label: "Warnings", count: s?.warning },
                        { key: "ok", label: "OK", count: s?.ok },
                    ]}
                />
                <select aria-label="What" className="h-9 rounded-md border border-input bg-background px-2 text-sm" value={kind} onChange={(e) => setKind(e.target.value)}>
                    <option value="all">Everything</option>
                    <option value="certificate">Certificates</option>
                    <option value="domain">Domains</option>
                    <option value="dns">DNS records</option>
                </select>
                {clients.length > 1 ? (
                    <select aria-label="Customer" className="h-9 max-w-56 rounded-md border border-input bg-background px-2 text-sm" value={clientSel} onChange={(e) => setClientSel(e.target.value)}>
                        <option value="">All customers</option>
                        {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                ) : null}
            </div>

            {!data ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />Loading…</div>
            ) : items.length === 0 ? (
                <EmptyState>
                    <Globe className="mx-auto mb-2 h-6 w-6 text-muted-foreground" aria-hidden="true" />
                    {data.items.length === 0 ? "Nothing is monitored yet. Add a customer's website to be told before its certificate runs out, or its domain to be told before it lapses." : "Nothing here matches that filter."}
                </EmptyState>
            ) : (
                <div className="overflow-x-auto rounded-lg border">
                    <table className="w-full text-left text-sm">
                        <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                            <tr><th className="px-3 py-2">Status</th><th className="px-3 py-2">Monitor</th><th className="hidden px-3 py-2 md:table-cell">Customer</th><th className="px-3 py-2">What it says</th><th className="hidden px-3 py-2 lg:table-cell">Checked</th><th className="px-3 py-2"><span className="sr-only">Actions</span></th></tr>
                        </thead>
                        <tbody className="divide-y">
                            {items.map((m) => (
                                <tr key={m.id} className="align-top hover:bg-accent/30" data-testid="monitor-row" data-status={m.status}>
                                    <td className="px-3 py-2.5"><Badge status={m.status} />{!m.enabled ? <span className="mt-1 block text-xs text-muted-foreground">Off</span> : null}</td>
                                    <td className="px-3 py-2.5">
                                        <span className="font-medium">{m.name}</span>
                                        <span className="block text-xs text-muted-foreground">{KIND_LABEL[m.kind]} · {m.host}{m.kind === "certificate" && m.port !== 443 ? `:${m.port}` : ""}</span>
                                    </td>
                                    <td className="hidden px-3 py-2.5 md:table-cell">{m.customer ?? <span className="text-muted-foreground">None</span>}</td>
                                    <td className="px-3 py-2.5">
                                        {when(m) ? <span className="block font-medium">{when(m)}</span> : null}
                                        <span className="block text-xs text-muted-foreground">{m.detail ?? "Waiting for the first check."}</span>
                                        {m.kind === "dns" ? (() => {
                                            const recs = (m.result as { records?: Record<string, string[]> } | null)?.records;
                                            if (!recs) return null;
                                            const types = (m.config.records ?? []).map((r) => r.type).filter((t) => t in recs);
                                            if (!types.length) return null;
                                            return (
                                                <dl className="mt-1.5 space-y-0.5 text-xs" data-testid="dns-records" aria-label={`Records that exist now for ${m.host}`}>
                                                    {types.map((t) => (
                                                        <div key={t} className="flex gap-2">
                                                            <dt className="w-12 shrink-0 font-medium">{t}</dt>
                                                            <dd className="min-w-0 break-all text-muted-foreground">{recs[t].length ? recs[t].join("  ·  ") : "none exist"}</dd>
                                                        </div>
                                                    ))}
                                                </dl>
                                            );
                                        })() : null}
                                        {m.kind === "dns" && m.status === "warning" && canWrite ? (
                                            <button className="mt-1 text-xs text-primary hover:underline disabled:opacity-60" disabled={busyId === m.id} onClick={() => void act(m.id, () => webMonitors.accept(m.id), "The new records are now the ones this monitor expects.")}>Accept the new records</button>
                                        ) : null}
                                    </td>
                                    <td className="hidden px-3 py-2.5 lg:table-cell">{ago(m.lastCheckedAt)}<span className="block text-xs text-muted-foreground">{m.status !== "pending" ? `${STATUS[m.status].label.toLowerCase()} since ${ago(m.statusSince)}` : ""}</span></td>
                                    <td className="px-3 py-2.5">
                                        <div className="flex justify-end gap-1">
                                            {canRun ? <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Check ${m.name} now`} title="Check now" disabled={busyId === m.id} onClick={() => void act(m.id, () => webMonitors.run(m.id))}>{busyId === m.id ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-4 w-4" aria-hidden="true" />}</Button> : null}
                                            {canWrite ? <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Edit ${m.name}`} title="Edit" onClick={() => setEditing(m)}><Pencil className="h-4 w-4" aria-hidden="true" /></Button> : null}
                                            {canDelete ? <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Delete ${m.name}`} title="Delete" disabled={busyId === m.id} onClick={() => { if (window.confirm(`Stop monitoring ${m.name}? Its history goes with it.`)) void act(m.id, () => webMonitors.remove(m.id)); }}><Trash2 className="h-4 w-4" aria-hidden="true" /></Button> : null}
                                        </div>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
            <p className="text-xs text-muted-foreground">Certificates are checked every 6 hours, domains every day and DNS records every 15 minutes. A monitor that cannot be reached is reported after three tries in a row. Servers on private networks are not checked from here.</p>

            {editing ? (
                <MonitorDialog
                    monitor={editing === "new" ? null : editing}
                    clients={clients}
                    defaultClient={clientSel}
                    mustPickClient={false}
                    onClose={() => setEditing(null)}
                    onSaved={() => { setEditing(null); void load(); }}
                />
            ) : null}
        </PageShell>
    );
}

export default function WebMonitorsPage() {
    return (
        <PermGate require="checks.read" title="Domains and certificates" message="You need permission to view checks to see the domain and certificate monitors.">
            <WebMonitorsBody />
        </PermGate>
    );
}
