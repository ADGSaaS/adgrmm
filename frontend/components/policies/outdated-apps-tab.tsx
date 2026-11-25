"use client";

// Outdated apps: every program with a newer version across the devices (winget and Chocolatey), who has which version,
// updating some of them, and the lists that say what may update on its own and what never may.
import * as React from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/use-toast";
import { EmptyState, ListToolbar, SearchField } from "@/components/list-controls";
import { Pager, usePaged } from "@/components/pager";
import { jfetch } from "@/lib/api";
import { errorText, Pill, selectClass } from "@/components/policies/shared";

export type FleetApp = {
    source: "winget" | "chocolatey";
    appId: string;
    name: string;
    devices: number;
    versions: { installed: string | null; available: string; devices: number }[];
    availableVersions: string[];
    approximate: boolean;
    since: string;
    rule: "allow" | "block" | null;
    customerRules: number;
    customerBlocks: number;
};
type Fleet = { items: FleetApp[]; coverage: { windowsDevices: number; scanned: number; neverScanned: number; oldestScan: string | null; failing: number }; minVersion: string };
type FleetDevice = { deviceId: string; device: string; customer: string; site: string; installedVersion: string | null; availableVersion: string; approximate: boolean; scannedAt: string; updating: boolean; blocked: boolean };
type RuleRow = { id: string; source: string; appId: string; name: string | null; rule: "allow" | "block"; clientId: string | null; customer: string | null };
type Skipped = { deviceId: string; device: string; reason: string };

const MAX_DEVICES = 200;
const SOURCE_LABEL = { winget: "winget", chocolatey: "Chocolatey" } as const;

function versionsText(a: FleetApp): string {
    const v = a.versions.slice(0, 3).map((x) => `${x.installed ?? "unknown"} (${x.devices})`).join(", ");
    return a.versions.length > 3 ? `${v}, +${a.versions.length - 3} more` : v;
}

export function OutdatedAppsTab({ canWrite, canInstall }: { canWrite: boolean; canInstall: boolean }) {
    const [customers, setCustomers] = React.useState<{ key: string; name: string }[]>([]);
    const [clientId, setClientId] = React.useState("");
    const [q, setQ] = React.useState("");
    const [source, setSource] = React.useState("");
    const [data, setData] = React.useState<Fleet | null>(null);
    const [rules, setRules] = React.useState<RuleRow[] | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [pick, setPick] = React.useState<FleetApp | null>(null);

    React.useEffect(() => { jfetch<{ key: string; name: string }[]>("/api/customers").then(setCustomers).catch(() => setCustomers([])); }, []);

    const load = React.useCallback(async () => {
        try {
            const qs = new URLSearchParams();
            if (clientId) qs.set("clientId", clientId);
            if (q.trim()) qs.set("q", q.trim());
            if (source) qs.set("source", source);
            const [f, r] = await Promise.all([
                jfetch<Fleet>(`/api/software-updates/fleet?${qs}`),
                jfetch<{ items: RuleRow[] }>("/api/software-updates/rules").catch(() => ({ items: [] as RuleRow[] })),
            ]);
            setData(f);
            setRules(r.items);
            setError(null);
        } catch (e) {
            setError(errorText(e));
        }
    }, [clientId, q, source]);
    React.useEffect(() => { const t = setTimeout(() => void load(), q ? 250 : 0); return () => clearTimeout(t); }, [load, q]);

    const paged = usePaged(data?.items ?? [], "outdated-apps", 25);
    const setRule = async (a: FleetApp, rule: "allow" | "block") => {
        try {
            await jfetch("/api/software-updates/rules", { method: "POST", body: { rule, source: a.source, appId: a.appId, name: a.name } });
            toast({ title: rule === "block" ? `${a.name} will never be updated automatically` : `${a.name} may update on its own` });
            void load();
        } catch (e) { toast({ title: "Could not save", description: errorText(e), variant: "destructive" }); }
    };

    return (
        <div className="grid gap-6">
            <section aria-label="Outdated apps" className="grid gap-3">
                <p className="text-sm text-muted-foreground">
                    Programs with a newer version, from the last scan of each Windows device (winget and Chocolatey). Scans run from a device&apos;s Software tab, from the device list, or on a schedule a policy sets (Policies, Patching section). Linux and macOS devices are not scanned.
                </p>
                {data && (
                    <p className="text-sm" role="status">
                        {data.coverage.scanned} of {data.coverage.windowsDevices} Windows devices scanned
                        {data.coverage.neverScanned > 0 ? `, ${data.coverage.neverScanned} never` : ""}
                        {data.coverage.oldestScan ? `. Oldest scan ${new Date(data.coverage.oldestScan).toLocaleString()}` : ""}
                        {data.coverage.failing > 0 ? `. ${data.coverage.failing} last scan${data.coverage.failing === 1 ? "" : "s"} failed.` : "."}
                    </p>
                )}
                <ListToolbar
                    left={
                        <>
                            <SearchField value={q} onChange={setQ} placeholder="Search programs" label="Search outdated programs" />
                            <select aria-label="Customer" className={`${selectClass} sm:w-56`} value={clientId} onChange={(e) => setClientId(e.target.value)}>
                                <option value="">All customers</option>
                                {customers.map((c) => <option key={c.key} value={c.key}>{c.name}</option>)}
                            </select>
                            <select aria-label="Source" className={`${selectClass} sm:w-40`} value={source} onChange={(e) => setSource(e.target.value)}>
                                <option value="">winget and Chocolatey</option>
                                <option value="winget">winget</option>
                                <option value="chocolatey">Chocolatey</option>
                            </select>
                        </>
                    }
                />
                {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
                {data && data.items.length === 0 && <EmptyState>{data.coverage.scanned === 0 ? "No device has been scanned yet. Open a Windows device, Software tab, and choose Scan now, or set a scan schedule in a policy." : "Nothing is outdated on the scanned devices."}</EmptyState>}
                {data && data.items.length > 0 && (
                    <div className="overflow-x-auto rounded-md border">
                        <table className="w-full text-sm">
                            <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                                <tr><th className="px-3 py-2">Program</th><th className="px-3 py-2">Devices</th><th className="px-3 py-2">Installed versions (devices)</th><th className="px-3 py-2">Newest</th><th className="px-3 py-2">Updates</th><th className="px-3 py-2 text-right">Actions</th></tr>
                            </thead>
                            <tbody>
                                {paged.rows.map((a) => (
                                    <tr key={`${a.source}:${a.appId}`} className="border-t align-top">
                                        <td className="px-3 py-2">
                                            <div className="font-medium">{a.name}</div>
                                            <div className="text-xs text-muted-foreground">{a.appId} · {SOURCE_LABEL[a.source]}{a.approximate ? " · some versions only known roughly" : ""}</div>
                                        </td>
                                        <td className="px-3 py-2 tabular-nums">{a.devices}</td>
                                        <td className="px-3 py-2">{versionsText(a)}</td>
                                        <td className="px-3 py-2">{a.availableVersions.join(", ")}</td>
                                        <td className="px-3 py-2">
                                            {a.rule === "block" ? <Pill tone="bad">Never</Pill> : a.rule === "allow" ? <Pill tone="good">Allowed</Pill> : <Pill>By hand</Pill>}
                                            {a.customerRules > 0 && <span className="ml-1 text-xs text-muted-foreground">+{a.customerRules} customer rule{a.customerRules === 1 ? "" : "s"}</span>}
                                        </td>
                                        <td className="px-3 py-2 text-right">
                                            <div className="flex flex-wrap justify-end gap-1">
                                                <Button size="sm" variant="outline" disabled={!canInstall} title={canInstall ? "Choose devices and update" : "You need the right to install software."} onClick={() => setPick(a)}>Update…</Button>
                                                {canWrite && a.rule !== "allow" && <Button size="sm" variant="ghost" onClick={() => void setRule(a, "allow")}>Allow auto</Button>}
                                                {canWrite && a.rule !== "block" && <Button size="sm" variant="ghost" onClick={() => void setRule(a, "block")}>Never</Button>}
                                            </div>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
                {data && data.items.length > 0 && <Pager paged={paged} noun="programs" />}
            </section>

            <RulesSection rules={rules} customers={customers} canWrite={canWrite} reload={load} />
            {pick && <UpdateDialog app={pick} clientId={clientId} onClose={() => { setPick(null); void load(); }} />}
        </div>
    );
}

function RulesSection({ rules, customers, canWrite, reload }: { rules: RuleRow[] | null; customers: { key: string; name: string }[]; canWrite: boolean; reload: () => void }) {
    const [appId, setAppId] = React.useState("");
    const [src, setSrc] = React.useState("winget");
    const [kind, setKind] = React.useState<"allow" | "block">("allow");
    const [cust, setCust] = React.useState("");
    const [busy, setBusy] = React.useState(false);
    const add = async () => {
        setBusy(true);
        try {
            await jfetch("/api/software-updates/rules", { method: "POST", body: { rule: kind, source: src, appId: appId.trim(), ...(cust ? { clientId: cust } : {}) } });
            setAppId("");
            reload();
        } catch (e) { toast({ title: "Could not save", description: errorText(e), variant: "destructive" }); } finally { setBusy(false); }
    };
    const remove = async (r: RuleRow) => {
        try { await jfetch(`/api/software-updates/rules/${r.id}`, { method: "DELETE" }); reload(); } catch (e) { toast({ title: "Could not remove", description: errorText(e), variant: "destructive" }); }
    };
    const list = (rule: "allow" | "block") => (rules ?? []).filter((r) => r.rule === rule);
    return (
        <section aria-label="Update lists" className="grid gap-3">
            <h3 className="text-sm font-semibold">Allowed and never-update lists</h3>
            <p className="text-sm text-muted-foreground">A policy set to &quot;only programs on the allowed list&quot; updates these on its own. A program on the never-update list is never updated by a policy and is refused when asked for by hand. Never-update always wins. An entry applies to the whole organisation or to one customer.</p>
            {canWrite && (
                <div className="flex flex-wrap items-end gap-2">
                    <label className="grid gap-1 text-xs">Package id<Input aria-label="Package id" value={appId} onChange={(e) => setAppId(e.target.value)} placeholder="e.g. 7zip.7zip" className="w-60" /></label>
                    <label className="grid gap-1 text-xs">Source<select className={`${selectClass} w-36`} value={src} onChange={(e) => setSrc(e.target.value)}><option value="winget">winget</option><option value="chocolatey">Chocolatey</option></select></label>
                    <label className="grid gap-1 text-xs">List<select className={`${selectClass} w-44`} value={kind} onChange={(e) => setKind(e.target.value as "allow" | "block")}><option value="allow">Allowed to update</option><option value="block">Never update</option></select></label>
                    <label className="grid gap-1 text-xs">Applies to<select className={`${selectClass} w-48`} value={cust} onChange={(e) => setCust(e.target.value)}><option value="">Whole organisation</option>{customers.map((c) => <option key={c.key} value={c.key}>{c.name}</option>)}</select></label>
                    <Button disabled={busy || !appId.trim()} onClick={() => void add()}>Add</Button>
                </div>
            )}
            <div className="grid gap-4 md:grid-cols-2">
                {(["allow", "block"] as const).map((k) => (
                    <div key={k} className="rounded-md border">
                        <div className="border-b bg-muted/50 px-3 py-2 text-xs font-medium">{k === "allow" ? "Allowed to update on its own" : "Never update"} ({list(k).length})</div>
                        {list(k).length === 0 ? <p className="px-3 py-3 text-xs text-muted-foreground">Nothing on this list.</p> : (
                            <ul>
                                {list(k).map((r) => (
                                    <li key={r.id} className="flex items-center justify-between gap-2 border-t px-3 py-2 text-sm first:border-t-0">
                                        <span><span className="font-medium">{r.name || r.appId}</span><span className="block text-xs text-muted-foreground">{r.appId} · {r.source === "chocolatey" ? "Chocolatey" : "winget"} · {r.customer ?? "Whole organisation"}</span></span>
                                        {canWrite && <Button size="icon" variant="ghost" aria-label={`Remove ${r.appId}`} onClick={() => void remove(r)}><Trash2 className="h-4 w-4" /></Button>}
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                ))}
            </div>
        </section>
    );
}

function UpdateDialog({ app, clientId, onClose }: { app: FleetApp; clientId: string; onClose: () => void }) {
    const [devices, setDevices] = React.useState<FleetDevice[] | null>(null);
    const [sel, setSel] = React.useState<Set<string>>(new Set());
    const [error, setError] = React.useState<string | null>(null);
    const [busy, setBusy] = React.useState(false);
    const [result, setResult] = React.useState<{ queued: number; skipped: Skipped[] } | null>(null);

    React.useEffect(() => {
        const qs = new URLSearchParams({ source: app.source, appId: app.appId });
        if (clientId) qs.set("clientId", clientId);
        jfetch<{ items: FleetDevice[] }>(`/api/software-updates/fleet/devices?${qs}`).then((r) => setDevices(r.items)).catch((e) => setError(errorText(e)));
    }, [app, clientId]);

    const eligible = (devices ?? []).filter((d) => !d.blocked && !d.updating);
    const toggle = (id: string) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
    const go = async () => {
        setBusy(true); setError(null);
        try {
            const r = await jfetch<{ queued: number; skipped: Skipped[] }>("/api/software-updates/update", { method: "POST", body: { deviceIds: [...sel], apps: [{ source: app.source, appId: app.appId }] } });
            setResult(r);
        } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
    };
    return (
        <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
            <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
                <DialogHeader>
                    <DialogTitle>Update {app.name}</DialogTitle>
                    <DialogDescription>Choose the devices to update ({MAX_DEVICES} at most at a time). The device must be online; the update runs in the background and never forces a restart. Results are in each device&apos;s install log.</DialogDescription>
                </DialogHeader>
                {!devices && !error && <p className="text-sm text-muted-foreground">Loading…</p>}
                {devices && !result && (
                    <>
                        <div className="flex items-center justify-between text-sm">
                            <span>{sel.size} selected of {devices.length}</span>
                            <span className="flex gap-2">
                                <Button size="sm" variant="outline" onClick={() => setSel(new Set(eligible.slice(0, MAX_DEVICES).map((d) => d.deviceId)))}>Select all{eligible.length > MAX_DEVICES ? ` (first ${MAX_DEVICES})` : ""}</Button>
                                <Button size="sm" variant="ghost" onClick={() => setSel(new Set())}>None</Button>
                            </span>
                        </div>
                        <div className="max-h-72 overflow-y-auto rounded-md border text-sm">
                            {devices.map((d) => (
                                <label key={d.deviceId} className="flex items-center gap-2 border-t px-3 py-2 first:border-t-0">
                                    <input type="checkbox" disabled={d.blocked || d.updating} checked={sel.has(d.deviceId)} onChange={() => toggle(d.deviceId)} aria-label={`Select ${d.device}`} />
                                    <span className="flex-1"><span className="font-medium">{d.device}</span><span className="block text-xs text-muted-foreground">{d.customer} · {d.installedVersion ?? "unknown"} to {d.availableVersion}{d.approximate ? " (installed version is rough)" : ""}</span></span>
                                    {d.blocked && <Pill tone="bad">Never update</Pill>}
                                    {d.updating && <Pill tone="warn">Updating</Pill>}
                                </label>
                            ))}
                        </div>
                    </>
                )}
                {result && (
                    <div className="grid gap-2 text-sm" role="status">
                        <p>{result.queued} update{result.queued === 1 ? "" : "s"} queued.{result.skipped.length ? ` ${result.skipped.length} skipped:` : ""}</p>
                        {result.skipped.length > 0 && <ul className="list-disc pl-5 text-xs text-muted-foreground">{result.skipped.slice(0, 20).map((s, i) => <li key={i}>{s.device}: {s.reason}</li>)}</ul>}
                    </div>
                )}
                <DialogFooter className="items-center gap-2 sm:justify-between">
                    <p role="alert" className="min-h-5 text-sm text-destructive">{error ?? ""}</p>
                    <div className="flex gap-2">
                        <Button variant="outline" disabled={busy} onClick={onClose}>{result ? "Close" : "Cancel"}</Button>
                        {!result && <Button disabled={busy || sel.size === 0 || sel.size > MAX_DEVICES} onClick={() => void go()}>{busy ? "Queuing…" : `Update ${sel.size} device${sel.size === 1 ? "" : "s"}`}</Button>}
                    </div>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
