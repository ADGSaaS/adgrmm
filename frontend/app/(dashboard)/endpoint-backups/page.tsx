"use client";

// Endpoint backups: what protects each customer's computers and when it last worked, read from the computers themselves. A computer that is
// not protected, or whose backup is failing, is an alert. This page also gives the customer's backup report as a spreadsheet.
import * as React from "react";
import Link from "next/link";
import { Download, HardDrive, Loader2, RefreshCw, Settings2 } from "lucide-react";
import { PageHeader, PageShell } from "@/components/page-shell";
import PermGate from "@/components/perm-gate";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EmptyState, SearchField, SegmentedTabs } from "@/components/list-controls";
import { errorText } from "@/components/policies/shared";
import { fetchCustomers, type CustomerClient } from "@/lib/api";
import { endpointBackups, type BackupItem, type BackupList, type BackupSettings, type Overall } from "@/lib/endpoint-backups-api";
import { hasPerm } from "@/lib/permissions";
import { ago } from "@/lib/security-api";
import { useMe } from "@/lib/use-me";

const BADGE: Record<Overall | "unchecked", { label: string; cls: string }> = {
    ok: { label: "Protected", cls: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" },
    warning: { label: "Warning", cls: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400" },
    failed: { label: "Failing", cls: "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-400" },
    none: { label: "No backup", cls: "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-400" },
    unknown: { label: "Can't tell", cls: "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-400" },
    unchecked: { label: "Not checked", cls: "border-muted-foreground/30 bg-muted text-muted-foreground" },
};

const PRODUCT_STATE: Record<string, string> = { ok: "worked", warning: "needs attention", failed: "failed", unknown: "results not visible" };

function SettingsDialog({ settings, onClose, onSaved }: { settings: BackupSettings; onClose: () => void; onSaved: () => void }) {
    const [s, setS] = React.useState(settings);
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const num = (v: string) => Number(v) || 0;
    const save = async () => {
        setBusy(true); setError(null);
        try { await endpointBackups.saveSettings(s); onSaved(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
    };
    return (
        <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
            <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle>Backup checks</DialogTitle>
                    <DialogDescription>A short, read-only script on each online Windows or Linux computer looks at what protects it: restore points, the backup Windows makes, and backup software that is installed. It changes nothing.</DialogDescription>
                </DialogHeader>
                <div className="grid gap-4">
                    <label className="flex items-start gap-2 text-sm">
                        <input type="checkbox" className="mt-0.5 h-4 w-4 accent-primary" checked={s.enabled} onChange={(e) => setS({ ...s, enabled: e.target.checked })} />
                        <span><span className="font-medium">Check backups on computers</span><span className="block text-xs text-muted-foreground">Off by default. Turn it on and every online computer is looked at within a few minutes.</span></span>
                    </label>
                    <div className="grid gap-3 sm:grid-cols-3">
                        <div className="grid gap-1"><Label htmlFor="bk-warn">Warn after (hours)</Label><Input id="bk-warn" type="number" min={1} value={s.warnHours} onChange={(e) => setS({ ...s, warnHours: num(e.target.value) })} /></div>
                        <div className="grid gap-1"><Label htmlFor="bk-fail">Failing after (hours)</Label><Input id="bk-fail" type="number" min={1} value={s.failHours} onChange={(e) => setS({ ...s, failHours: num(e.target.value) })} /></div>
                        <div className="grid gap-1"><Label htmlFor="bk-check">Look every (hours)</Label><Input id="bk-check" type="number" min={1} max={168} value={s.checkHours} onChange={(e) => setS({ ...s, checkHours: num(e.target.value) })} /></div>
                    </div>
                    <p className="text-xs text-muted-foreground">The ages are how long ago the last successful backup was. A computer with no successful backup inside the warning age is flagged; past the failing age it is a problem.</p>
                    <label className="flex items-start gap-2 text-sm">
                        <input type="checkbox" className="mt-0.5 h-4 w-4 accent-primary" checked={s.alerts} onChange={(e) => setS({ ...s, alerts: e.target.checked })} />
                        <span><span className="font-medium">Raise an alert</span><span className="block text-xs text-muted-foreground">For a computer whose backup is failing or that has no backup at all. It clears itself when that is fixed.</span></span>
                    </label>
                    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
                </div>
                <DialogFooter>
                    <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
                    <Button onClick={() => void save()} disabled={busy} className="gap-2">{busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}Save</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function Row({ it, canCheck, busy, onCheck }: { it: BackupItem; canCheck: boolean; busy: boolean; onCheck: () => void }) {
    const b = BADGE[it.overall ?? "unchecked"];
    return (
        <tr className="align-top hover:bg-accent/30" data-testid="backup-row" data-status={it.overall ?? "unchecked"}>
            <td className="px-3 py-2.5"><span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${b.cls}`}>{it.checking ? "Checking…" : b.label}</span></td>
            <td className="px-3 py-2.5">
                <Link href={`/devices/${encodeURIComponent(it.deviceId)}`} className="font-medium hover:underline">{it.name}</Link>
                <span className="block text-xs text-muted-foreground">{it.customer ?? "No customer"}{it.site ? ` · ${it.site}` : ""} · {it.os === "windows" ? "Windows" : "Linux"}{it.online ? "" : " · offline"}</span>
            </td>
            <td className="hidden px-3 py-2.5 md:table-cell">
                {it.products.length === 0 ? <span className="text-muted-foreground">{it.overall ? "Nothing found" : "—"}</span> : (
                    <ul className="grid gap-0.5 text-xs">
                        {it.products.map((p) => <li key={p.product}><span className="font-medium">{p.product}</span> <span className="text-muted-foreground">{PRODUCT_STATE[p.state] ?? p.state}{p.lastSuccessAt ? `, ${ago(p.lastSuccessAt)}` : ""}</span></li>)}
                    </ul>
                )}
            </td>
            <td className="px-3 py-2.5">
                <span className="block text-sm">{it.lastSuccessAt ? ago(it.lastSuccessAt) : <span className="text-muted-foreground">No successful backup seen</span>}</span>
                <span className="block text-xs text-muted-foreground">{it.detail ?? (it.overall ? "" : "Waiting for the first check.")}</span>
                {it.problem ? <span className="block text-xs text-amber-700 dark:text-amber-400">The last check did not work: {it.problem}</span> : null}
                {it.checkedAt ? <span className="block text-xs text-muted-foreground">Checked {ago(it.checkedAt)}</span> : null}
            </td>
            <td className="px-3 py-2.5 text-right">
                {canCheck ? <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Check ${it.name} now`} title="Check now" disabled={busy || it.checking || !it.online} onClick={onCheck}><RefreshCw className="h-4 w-4" aria-hidden="true" /></Button> : null}
            </td>
        </tr>
    );
}

function BackupsBody() {
    const { permissions } = useMe();
    const canCheck = hasPerm(permissions, "devices.actions");
    const canSettings = hasPerm(permissions, "settings.write");
    const [data, setData] = React.useState<BackupList | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [note, setNote] = React.useState<string | null>(null);
    const [tab, setTab] = React.useState("all");
    const [term, setTerm] = React.useState("");
    const [clients, setClients] = React.useState<CustomerClient[]>([]);
    const [clientId, setClientId] = React.useState("");
    const [busy, setBusy] = React.useState<string | null>(null);
    const [settingsOpen, setSettingsOpen] = React.useState(false);

    const load = React.useCallback(async () => {
        try { setData(await endpointBackups.list(clientId ? `?clientId=${encodeURIComponent(clientId)}` : "")); setError(null); } catch (e) { setError(errorText(e)); }
    }, [clientId]);
    React.useEffect(() => { void load(); }, [load]);
    // while something is being checked the page looks again soon; otherwise now and then
    const anyChecking = data?.items.some((i) => i.checking) ?? false;
    React.useEffect(() => { const t = setInterval(() => void load(), anyChecking ? 3000 : 30_000); return () => clearInterval(t); }, [load, anyChecking]);
    React.useEffect(() => { void fetchCustomers().then(setClients).catch(() => setClients([])); }, []);

    const checkDevice = async (id: string) => {
        setBusy(id); setNote(null);
        try { await endpointBackups.check({ deviceId: id }); await load(); } catch (e) { setError(errorText(e)); } finally { setBusy(null); }
    };
    const checkCustomer = async () => {
        if (!clientId) return;
        setBusy("customer"); setNote(null);
        try {
            const r = await endpointBackups.check({ clientId });
            setNote(`${r.started} ${r.started === 1 ? "computer is" : "computers are"} being checked${r.offline ? `; ${r.offline} offline ${r.offline === 1 ? "was" : "were"} skipped` : ""}.`);
            await load();
        } catch (e) { setError(errorText(e)); } finally { setBusy(null); }
    };

    const s = data?.summary;
    const shown = (data?.items ?? []).filter((i) => {
        if (term && !`${i.name} ${i.customer ?? ""} ${i.site ?? ""} ${i.products.map((p) => p.product).join(" ")}`.toLowerCase().includes(term.toLowerCase())) return false;
        if (tab === "problems") return i.overall === "failed" || i.overall === "none";
        if (tab === "warning") return i.overall === "warning";
        if (tab === "ok") return i.overall === "ok";
        if (tab === "unknown") return i.overall === "unknown" || !i.overall;
        return true;
    });
    const enabled = data?.settings.enabled ?? false;

    return (
        <PageShell>
            <PageHeader
                title="Endpoint backups"
                description="What protects each customer's computers and when it last worked. A computer with no backup, or whose backup is failing, raises an alert."
                actions={
                    <>
                        {canSettings ? <Button variant="outline" className="gap-2" onClick={() => setSettingsOpen(true)}><Settings2 className="h-4 w-4" aria-hidden="true" />Settings</Button> : null}
                        <Button asChild variant="outline"><a href={endpointBackups.reportCsv(clientId || undefined)} className="gap-2"><Download className="mr-1 h-4 w-4" aria-hidden="true" />Backup report (CSV)</a></Button>
                    </>
                }
            />
            {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
            {note ? <p role="status" className="text-sm text-muted-foreground">{note}</p> : null}
            {data && !enabled ? (
                <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm" data-testid="backups-off">
                    <p className="font-medium">Backup checks are off.</p>
                    <p className="mt-1 text-muted-foreground">Nothing is read from any computer until they are turned on.{canSettings ? "" : " Ask an administrator to turn them on."}</p>
                    {canSettings ? <Button className="mt-3" onClick={() => setSettingsOpen(true)}>Turn on backup checks</Button> : null}
                </div>
            ) : null}
            <div className="flex flex-wrap items-center gap-3">
                <SegmentedTabs
                    label="Show"
                    value={tab}
                    onChange={setTab}
                    items={[
                        { key: "all", label: "All", count: s?.total },
                        { key: "problems", label: "Problems", count: s ? s.failed + s.none : undefined },
                        { key: "warning", label: "Warnings", count: s?.warning },
                        { key: "ok", label: "Protected", count: s?.ok },
                        { key: "unknown", label: "Can't tell", count: s ? s.unknown + s.unchecked : undefined },
                    ]}
                />
                {clients.length > 1 ? (
                    <select aria-label="Customer" className="h-9 max-w-56 rounded-md border border-input bg-background px-2 text-sm" value={clientId} onChange={(e) => setClientId(e.target.value)}>
                        <option value="">All customers</option>
                        {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                ) : null}
                <SearchField value={term} onChange={setTerm} placeholder="Search computers" className="max-w-56" />
                {canCheck && enabled && clientId ? <Button variant="outline" className="gap-2" disabled={busy === "customer"} onClick={() => void checkCustomer()}>{busy === "customer" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-4 w-4" aria-hidden="true" />}Check this customer now</Button> : null}
            </div>

            {!data ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />Loading…</div>
            ) : shown.length === 0 ? (
                <EmptyState>
                    <HardDrive className="mx-auto mb-2 h-6 w-6 text-muted-foreground" aria-hidden="true" />
                    {data.items.length === 0 ? "No computers with an agent yet." : "Nothing matches that filter."}
                </EmptyState>
            ) : (
                <div className="overflow-x-auto rounded-lg border">
                    <table className="w-full text-left text-sm">
                        <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                            <tr><th className="px-3 py-2">Status</th><th className="px-3 py-2">Computer</th><th className="hidden px-3 py-2 md:table-cell">What protects it</th><th className="px-3 py-2">Last backup</th><th className="px-3 py-2"><span className="sr-only">Actions</span></th></tr>
                        </thead>
                        <tbody className="divide-y">
                            {shown.map((it) => <Row key={it.deviceId} it={it} canCheck={canCheck && enabled} busy={busy === it.deviceId} onCheck={() => void checkDevice(it.deviceId)} />)}
                        </tbody>
                    </table>
                </div>
            )}
            <p className="text-xs text-muted-foreground">
                What is read: restore points on the computer, the backup that Windows itself makes, and backup software that is installed. Backup software keeps its results in its own console, so it is shown as present, not as protected: a computer is &quot;Protected&quot; only when a backup that Windows or a known source reports has worked within {data?.settings.warnHours ?? 48} hours. Restore points alone are a warning, because they sit on the same disk.
            </p>
            {settingsOpen && data ? <SettingsDialog settings={data.settings} onClose={() => setSettingsOpen(false)} onSaved={() => { setSettingsOpen(false); void load(); }} /> : null}
        </PageShell>
    );
}

export default function EndpointBackupsPage() {
    return (
        <PermGate require="devices.read" title="Endpoint backups" message="You need permission to view devices to see their backups.">
            <BackupsBody />
        </PermGate>
    );
}
