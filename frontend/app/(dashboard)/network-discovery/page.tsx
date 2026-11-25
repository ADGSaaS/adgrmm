"use client";

// Network discovery: a managed Windows or Linux device scans its own network and this page lists what it saw. The point is the list
// of hosts that are NOT managed devices: printers, switches, computers nobody installed the agent on. A scan only looks (it pings, reads
// the neighbour table and tries a few fixed ports); it never logs in and never changes anything. Ignoring only hides a row.
import * as React from "react";
import Link from "next/link";
import { Loader2, Radar } from "lucide-react";
import { PageHeader, PageShell } from "@/components/page-shell";
import PermGate from "@/components/perm-gate";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState } from "@/components/list-controls";
import { errorText } from "@/components/policies/shared";
import { useMe } from "@/lib/use-me";
import { hasPerm } from "@/lib/permissions";
import { ago } from "@/lib/security-api";
import { assetProvider, type AssetProviderInfo } from "@/lib/assets-provider-api";
import { discovery, MAX_SCAN_DEVICES, PORT_NAMES, SCHEDULE_INTERVALS, type DiscoveredHost, type DiscoveryRun, type DiscoverySchedule, type HostPage, type HostStatus, type Scanner } from "@/lib/network-discovery-api";

const TABS: Array<{ key: HostStatus; label: string; count: (c: HostPage["counts"]) => number }> = [
    { key: "unmanaged", label: "Not managed", count: (c) => c.unmanaged },
    { key: "managed", label: "Managed", count: (c) => c.managed },
    { key: "ignored", label: "Ignored", count: (c) => c.ignored },
    { key: "all", label: "All", count: (c) => c.all },
];

function runText(r: DiscoveryRun): string {
    if (r.status === "pending") return `Scanning from ${r.scanner ?? "a device"}…`;
    if (r.status === "failed") return `The last scan from ${r.scanner ?? "a device"} did not work: ${r.message ?? "no reason given"}`;
    return `Last scan ${ago(r.finishedAt)} from ${r.scanner ?? "a device"}: ${r.hostsFound} ${r.hostsFound === 1 ? "host" : "hosts"} seen${r.newHosts ? `, ${r.newHosts} new` : ""}${r.seconds !== null ? `, took ${r.seconds} s` : ""}.${r.message ? ` ${r.message}` : ""}`;
}

function DiscoveryBody() {
    const { permissions } = useMe();
    const canScan = hasPerm(permissions, ["devices.read", "devices.actions"]);
    const [status, setStatus] = React.useState<HostStatus>("unmanaged");
    const [term, setTerm] = React.useState("");
    const [page, setPage] = React.useState<HostPage | null>(null);
    const [runs, setRuns] = React.useState<DiscoveryRun[]>([]);
    const [error, setError] = React.useState<string | null>(null);
    const [picked, setPicked] = React.useState<Set<string>>(new Set());
    const [busy, setBusy] = React.useState(false);
    const [scanOpen, setScanOpen] = React.useState(false);
    const [scanners, setScanners] = React.useState<Scanner[] | null>(null);
    const [clientSel, setClientSel] = React.useState("");
    const [siteSel, setSiteSel] = React.useState("all");
    const [devSel, setDevSel] = React.useState("all");
    const [scanNote, setScanNote] = React.useState<string | null>(null);
    const [ranges, setRanges] = React.useState("");
    const [scanError, setScanError] = React.useState<string | null>(null);
    const canAsset = hasPerm(permissions, ["devices.read", "assets.write"]);
    const [assets, setAssets] = React.useState<AssetProviderInfo | null>(null);
    const [assetBusy, setAssetBusy] = React.useState<string | null>(null);
    React.useEffect(() => { void assetProvider.get().then(setAssets).catch(() => { }); }, []);
    const addAsset = async (id: string) => {
        setAssetBusy(id);
        try { await assetProvider.addHost(id); await load(); } catch (e) { setError(errorText(e)); } finally { setAssetBusy(null); }
    };
    const alive = React.useRef(true);
    const [schedules, setSchedules] = React.useState<DiscoverySchedule[]>([]);
    const [schedOpen, setSchedOpen] = React.useState(false);
    const [schedSite, setSchedSite] = React.useState("");
    const [schedHours, setSchedHours] = React.useState(24);
    const [schedRanges, setSchedRanges] = React.useState("");
    const [schedScanner, setSchedScanner] = React.useState("");
    const [schedAlert, setSchedAlert] = React.useState(true);
    const [schedError, setSchedError] = React.useState<string | null>(null);

    React.useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

    const loadSchedules = React.useCallback(async () => {
        try { const r = await discovery.schedules(); if (alive.current) setSchedules(r.items); } catch { /* the hosts list shows its own error */ }
    }, []);
    React.useEffect(() => { void loadSchedules(); }, [loadSchedules]);

    const openSchedule = async (existing?: DiscoverySchedule) => {
        setSchedError(null);
        if (scanners === null) { try { setScanners((await discovery.scanners()).items); } catch { setScanners([]); } }
        setSchedSite(existing?.siteId ?? ""); setSchedHours(existing?.intervalHours ?? 24); setSchedRanges((existing?.ranges ?? []).join(", "));
        setSchedScanner(existing?.scannerDeviceId ?? ""); setSchedAlert(existing?.alertNew ?? true);
        setSchedOpen(true);
    };
    const saveSchedule = async (enabled = true) => {
        setBusy(true); setSchedError(null);
        try {
            await discovery.saveSchedule(schedSite, { enabled, intervalHours: schedHours, ranges: schedRanges.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean), scannerDeviceId: schedScanner || null, alertNew: schedAlert });
            setSchedOpen(false); await loadSchedules();
        } catch (e) { setSchedError(errorText(e)); } finally { setBusy(false); }
    };
    const toggleSchedule = async (s: DiscoverySchedule) => {
        setBusy(true);
        try { await discovery.saveSchedule(s.siteId, { enabled: !s.enabled, intervalHours: s.intervalHours, ranges: s.ranges, scannerDeviceId: s.scannerDeviceId, alertNew: s.alertNew }); await loadSchedules(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
    };
    const removeSchedule = async (s: DiscoverySchedule) => {
        setBusy(true);
        try { await discovery.deleteSchedule(s.siteId); await loadSchedules(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
    };

    const load = React.useCallback(async () => {
        try {
            const [h, r] = await Promise.all([discovery.hosts({ status, q: term }), discovery.runs()]);
            if (!alive.current) return;
            setPage(h); setRuns(r.items); setError(null);
            setPicked((p) => new Set([...p].filter((id) => h.items.some((i) => i.id === id))));
        } catch (e) {
            if (alive.current) { setError(errorText(e)); setPage((x) => x ?? { counts: { unmanaged: 0, managed: 0, ignored: 0, all: 0 }, total: 0, items: [] }); }
        }
    }, [status, term]);
    React.useEffect(() => { const t = setTimeout(() => void load(), term ? 300 : 0); return () => clearTimeout(t); }, [load, term]);

    // while a scan is running, look again every few seconds
    const running = runs.find((r) => r.status === "pending") ?? null;
    const pendingCount = runs.filter((r) => r.status === "pending").length;
    React.useEffect(() => {
        if (!running) return;
        const t = setInterval(() => { void discovery.run(running.id).then(() => load()).catch(() => { }); }, 4000);
        return () => clearInterval(t);
    }, [running?.id, load]); // eslint-disable-line react-hooks/exhaustive-deps

    const openScan = async () => {
        setScanError(null); setScanOpen(true);
        if (scanners === null) {
            try { const s = await discovery.scanners(); setScanners(s.items); if (s.items.length && !clientSel) { setClientSel(s.items[0].clientId ?? ""); setSiteSel(s.items[0].siteId); setDevSel("all"); } } catch (e) { setScanError(errorText(e)); setScanners([]); }
        }
    };
    const startScan = async () => {
        setBusy(true); setScanError(null);
        try {
            const list = ranges.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);
            const r = await discovery.scanMany(chosenDevices.map((s) => s.deviceId), list);
            const skipped = r.results.filter((x) => x.status === "skipped");
            setScanNote(`Started ${r.started} ${r.started === 1 ? "scan" : "scans"}${r.alreadyRunning ? `, ${r.alreadyRunning} already running` : ""}.${skipped.length ? ` Skipped ${skipped.length}: ${skipped.slice(0, 4).map((x) => `${x.name} (${x.reason})`).join("; ")}${skipped.length > 4 ? " and more" : ""}.` : ""} Hosts that more than one device finds are listed once.`);
            setScanOpen(false);
            await load();
        } catch (e) {
            setScanError(errorText(e));
        } finally {
            setBusy(false);
        }
    };

    const items = page?.items ?? [];
    const pickable = items.filter((i) => !i.deviceId);
    const chosen = pickable.filter((i) => picked.has(i.id));
    const toggle = (id: string) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
    const ignore = async (ignored: boolean) => {
        setBusy(true);
        try { await discovery.ignore(chosen.map((c) => c.id), ignored); setPicked(new Set()); await load(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
    };
    // the devices a scan will start from: one device, every online device of a site, or every online device of every site of a customer
    const customerList = Array.from(new Map((scanners ?? []).map((s) => [s.clientId ?? "", s.customer ?? "No customer"])).entries());
    const ofCustomer = (scanners ?? []).filter((s) => (s.clientId ?? "") === clientSel);
    const siteList = Array.from(new Map(ofCustomer.map((s) => [s.siteId, s.site ?? "No site"])).entries());
    const ofSite = ofCustomer.filter((s) => s.siteId === siteSel);
    const chosenDevices: Scanner[] = siteSel === "all" ? ofCustomer : devSel === "all" ? ofSite : ofSite.filter((s) => s.deviceId === devSel);
    const tooMany = chosenDevices.length > MAX_SCAN_DEVICES;
    const last = runs[0] ?? null;

    return (
        <PageShell>
            <PageHeader
                title="Network discovery"
                description="What a managed device can see on its own network: printers, switches, and computers that have no agent. Pick a device to scan from. A scan only looks; it never logs in to anything or changes anything."
                actions={(
                    <div className="flex flex-wrap items-center gap-2">
                        <Button asChild variant="outline" size="sm"><Link href="/snmp">SNMP devices</Link></Button>
                        {canScan ? (
                            <Button size="sm" className="gap-2" onClick={() => void openScan()}>
                                {running ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Radar className="h-4 w-4" aria-hidden="true" />}Scan network
                            </Button>
                        ) : null}
                    </div>
                )}
            />

            {!canScan ? <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">You can see what was found. Starting a scan needs the right to run device actions.</p> : null}
            {error ? <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">{error}</p> : null}
            {scanNote ? <p role="status" className="rounded-md border bg-muted/40 px-3 py-2 text-sm" data-testid="discovery-scan-note">{scanNote}</p> : null}
            {last ? <p role="status" className="text-sm text-muted-foreground" data-testid="discovery-last-run">{pendingCount > 1 ? `Scanning from ${pendingCount} devices…` : runText(running ?? last)}</p> : null}

            <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap gap-1" role="group" aria-label="Show">
                    {TABS.map((t) => (
                        <Button key={t.key} size="sm" variant={status === t.key ? "default" : "outline"} onClick={() => { setStatus(t.key); setPicked(new Set()); }}>
                            {t.label}{page ? ` ${t.count(page.counts)}` : ""}
                        </Button>
                    ))}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <input aria-label="Search the hosts" placeholder="Address, name, vendor or type" className="h-9 w-64 rounded-md border bg-background px-3 text-sm" value={term} onChange={(e) => setTerm(e.target.value)} />
                    {canScan && status !== "managed" ? (
                        status === "ignored"
                            ? <Button variant="outline" size="sm" disabled={!chosen.length || busy} onClick={() => void ignore(false)}>Stop ignoring{chosen.length ? ` (${chosen.length})` : ""}</Button>
                            : <Button variant="outline" size="sm" disabled={!chosen.length || busy} onClick={() => void ignore(true)}>Ignore{chosen.length ? ` (${chosen.length})` : ""}</Button>
                    ) : null}
                </div>
            </div>

            <section aria-label="Scheduled scans" className="rounded-lg border p-3" data-testid="discovery-schedules">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                        <h2 className="text-sm font-semibold">Scheduled scans</h2>
                        <p className="text-xs text-muted-foreground">Scan a site on its own, and be alerted when a new device that is not managed appears. The first scan of a site only sets the baseline, so it raises no alerts.</p>
                    </div>
                    {canScan ? <Button variant="outline" size="sm" onClick={() => void openSchedule()}>Add a schedule</Button> : null}
                </div>
                {schedules.length === 0 ? <p className="mt-2 text-sm text-muted-foreground">No site is scanned on a schedule yet.</p> : (
                    <ul className="mt-2 divide-y text-sm">
                        {schedules.map((s) => (
                            <li key={s.siteId} className="flex flex-wrap items-center justify-between gap-2 py-2">
                                <div className="min-w-0">
                                    <span className="font-medium">{s.customer ?? "No customer"} / {s.site ?? "No site"}</span>
                                    <span className="block text-xs text-muted-foreground">
                                        {SCHEDULE_INTERVALS.find((i) => i.hours === s.intervalHours)?.label ?? `Every ${s.intervalHours} hours`}
                                        {s.ranges.length ? `, ${s.ranges.join(", ")}` : ", the scanner's own subnet"}
                                        {s.scannerName ? `, from ${s.scannerName} when it is online` : ", from any online Windows or Linux device"}
                                        {s.alertNew ? ", alerts for new devices" : ", no alerts"}
                                        {s.enabled ? (s.nextDueAt ? (s.nextDueAt === "due now" ? ", due now" : `, next ${new Date(s.nextDueAt).toLocaleString()}`) : "") : ", paused"}
                                    </span>
                                    {s.message ? <span className="block text-xs text-amber-700 dark:text-amber-400">{s.message}</span> : null}
                                </div>
                                {canScan ? (
                                    <div className="flex gap-1">
                                        <Button variant="outline" size="sm" disabled={busy} onClick={() => void openSchedule(s)}>Edit</Button>
                                        <Button variant="outline" size="sm" disabled={busy} onClick={() => void toggleSchedule(s)}>{s.enabled ? "Pause" : "Resume"}</Button>
                                        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void removeSchedule(s)}>Remove</Button>
                                    </div>
                                ) : null}
                            </li>
                        ))}
                    </ul>
                )}
            </section>

            {page === null ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />Loading…</div>
            ) : items.length === 0 ? (
                <EmptyState>
                    <div className="font-medium text-foreground">{page.counts.all === 0 ? "Nothing has been scanned yet" : term ? "No host matches" : status === "unmanaged" ? "Every host that was found is managed or ignored" : "Nothing here"}</div>
                    <div>{page.counts.all === 0 ? "Press Scan network and choose a device that is online. It looks at its own subnet unless you give a range." : "Run a scan again to refresh this list."}</div>
                </EmptyState>
            ) : (
                <>
                    <div className="overflow-x-auto rounded-lg border">
                        <table className="w-full text-sm" data-testid="discovery-table">
                            <caption className="sr-only">Hosts found on the network</caption>
                            <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
                                <tr>
                                    {canScan && status !== "managed" ? (
                                        <th scope="col" className="w-10 px-3 py-2"><input type="checkbox" aria-label="Select all hosts" checked={pickable.length > 0 && chosen.length === pickable.length} onChange={() => setPicked(chosen.length === pickable.length ? new Set() : new Set(pickable.map((i) => i.id)))} /></th>
                                    ) : null}
                                    <th scope="col" className="px-3 py-2">Host</th>
                                    <th scope="col" className="hidden px-3 py-2 sm:table-cell">Looks like</th>
                                    <th scope="col" className="hidden px-3 py-2 lg:table-cell">Open ports</th>
                                    <th scope="col" className="hidden px-3 py-2 md:table-cell">Customer</th>
                                    <th scope="col" className="px-3 py-2">Seen</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y">
                                {items.map((h) => <HostRow key={h.id} h={h} selectable={canScan && status !== "managed" && !h.deviceId} picked={picked.has(h.id)} onToggle={() => toggle(h.id)} showBox={canScan && status !== "managed"} assets={assets} canAsset={canAsset} assetBusy={assetBusy === h.id} onAddAsset={() => void addAsset(h.id)} />)}
                            </tbody>
                        </table>
                    </div>
                    {page.total > items.length ? <p className="text-xs text-muted-foreground">Showing the first {items.length} of {page.total}. Search to narrow the list.</p> : null}
                </>
            )}

            <Dialog open={schedOpen} onOpenChange={(o) => !busy && setSchedOpen(o)}>
                <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
                    <DialogHeader>
                        <DialogTitle>Scan a site on a schedule</DialogTitle>
                        <DialogDescription>The server starts a scan from an online Windows or Linux device of the site, as often as you choose. Nothing is installed or changed on the network.</DialogDescription>
                    </DialogHeader>
                    <div className="grid gap-3">
                        <label className="grid min-w-0 gap-1 text-sm">
                            <span className="font-medium">Site</span>
                            <select className="h-10 w-full min-w-0 rounded-md border bg-background px-2 text-sm" value={schedSite} onChange={(e) => { setSchedSite(e.target.value); setSchedScanner(""); }}>
                                <option value="">Choose a site</option>
                                {Array.from(new Map((scanners ?? []).map((s) => [s.siteId, `${s.customer ?? "No customer"} / ${s.site ?? "No site"}`])).entries()).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
                            </select>
                            <span className="text-xs text-muted-foreground">Sites with a Windows or Linux device that is online now are listed.</span>
                        </label>
                        <label className="grid min-w-0 gap-1 text-sm">
                            <span className="font-medium">How often</span>
                            <select className="h-10 w-full min-w-0 rounded-md border bg-background px-2 text-sm" value={schedHours} onChange={(e) => setSchedHours(Number(e.target.value))}>
                                {SCHEDULE_INTERVALS.map((i) => <option key={i.hours} value={i.hours}>{i.label}</option>)}
                            </select>
                        </label>
                        <label className="grid min-w-0 gap-1 text-sm">
                            <span className="font-medium">Scan from</span>
                            <select className="h-10 w-full min-w-0 rounded-md border bg-background px-2 text-sm" value={schedScanner} onChange={(e) => setSchedScanner(e.target.value)} disabled={!schedSite}>
                                <option value="">Any online Windows or Linux device of the site</option>
                                {(scanners ?? []).filter((s) => s.siteId === schedSite).map((s) => <option key={s.deviceId} value={s.deviceId}>{s.name}</option>)}
                            </select>
                        </label>
                        <label className="grid min-w-0 gap-1 text-sm">
                            <span className="font-medium">Range (optional)</span>
                            <input className="h-10 w-full min-w-0 rounded-md border bg-background px-3 text-sm" placeholder="Empty: the subnet of the scanner's own network card" value={schedRanges} onChange={(e) => setSchedRanges(e.target.value)} />
                        </label>
                        <label className="flex items-center gap-2 text-sm">
                            <input type="checkbox" checked={schedAlert} onChange={(e) => setSchedAlert(e.target.checked)} />
                            Raise an alert when a new device that is not managed appears
                        </label>
                    </div>
                    {schedError ? <p role="alert" className="text-sm text-destructive">{schedError}</p> : null}
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setSchedOpen(false)} disabled={busy}>Cancel</Button>
                        <Button onClick={() => void saveSchedule()} disabled={busy || !schedSite} className="gap-2">{busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}{busy ? "Saving…" : "Save schedule"}</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog open={scanOpen} onOpenChange={(o) => !busy && setScanOpen(o)}>
                <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
                    <DialogHeader>
                        <DialogTitle>Scan the network</DialogTitle>
                        <DialogDescription>The device you choose pings the addresses of a range, reads what its network knows about their MAC addresses and names, and checks 16 common ports on the ones that answer. It sends no logins and changes nothing. Only private addresses (10.x, 172.16 to 31.x, 192.168.x) are scanned, and a scan takes a few minutes.</DialogDescription>
                    </DialogHeader>
                    {scanners === null ? (
                        <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />Looking for devices that are online…</div>
                    ) : scanners.length === 0 ? (
                        <p className="text-sm text-muted-foreground">No Windows or Linux device is online right now. A scan runs from one.</p>
                    ) : (
                        <div className="grid gap-3">
                            <div className="grid gap-3 sm:grid-cols-3">
                                <label className="grid min-w-0 gap-1 text-sm">
                                    <span className="font-medium">Customer</span>
                                    <select className="h-10 w-full min-w-0 rounded-md border bg-background px-2 text-sm" value={clientSel} onChange={(e) => { setClientSel(e.target.value); const first = (scanners ?? []).find((s) => (s.clientId ?? "") === e.target.value); setSiteSel(first?.siteId ?? "all"); setDevSel("all"); }}>
                                        {customerList.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
                                    </select>
                                </label>
                                <label className="grid min-w-0 gap-1 text-sm">
                                    <span className="font-medium">Site</span>
                                    <select className="h-10 w-full min-w-0 rounded-md border bg-background px-2 text-sm" value={siteSel} onChange={(e) => { setSiteSel(e.target.value); setDevSel("all"); }}>
                                        {siteList.length > 1 ? <option value="all">All sites of this customer</option> : null}
                                        {siteList.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
                                    </select>
                                </label>
                                <label className="grid min-w-0 gap-1 text-sm">
                                    <span className="font-medium">Device</span>
                                    <select className="h-10 w-full min-w-0 rounded-md border bg-background px-2 text-sm" value={siteSel === "all" ? "all" : devSel} disabled={siteSel === "all"} onChange={(e) => setDevSel(e.target.value)}>
                                        <option value="all">{siteSel === "all" ? "All online devices" : "All online devices of this site"}</option>
                                        {siteSel !== "all" ? ofSite.map((s) => <option key={s.deviceId} value={s.deviceId}>{s.name}</option>) : null}
                                    </select>
                                </label>
                            </div>
                            <p className="text-sm" data-testid="scan-from-summary">
                                {chosenDevices.length === 0 ? "No device is online here." : <>Scans from <strong>{chosenDevices.length}</strong> online {chosenDevices.length === 1 ? "device" : "devices"}: {chosenDevices.slice(0, 5).map((s) => s.name).join(", ")}{chosenDevices.length > 5 ? ` and ${chosenDevices.length - 5} more` : ""}.</>}
                                {chosenDevices.length > 1 ? <span className="block text-xs text-muted-foreground">Each device looks at its own network, so together they cover the whole site. A host that more than one of them finds is listed once. Only devices that are online now are used.</span> : null}
                            </p>
                            {tooMany ? <p role="alert" className="text-sm text-destructive">That is more than {MAX_SCAN_DEVICES} devices. Choose one site, or one device.</p> : null}
                            <label className="grid min-w-0 gap-1 text-sm">
                                <span className="font-medium">Range (optional)</span>
                                <input className="h-10 w-full min-w-0 rounded-md border bg-background px-3 text-sm" placeholder="Empty: the subnet of each device's own network card" value={ranges} onChange={(e) => setRanges(e.target.value)} />
                                <span className="text-xs text-muted-foreground">For example 192.168.1.0/24. Several ranges can be separated by commas, up to 4. The widest range is /22 (1024 addresses).</span>
                            </label>
                        </div>
                    )}
                    {scanError ? <p role="alert" className="text-sm text-destructive">{scanError}</p> : null}
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setScanOpen(false)} disabled={busy}>Cancel</Button>
                        <Button onClick={() => void startScan()} disabled={busy || !chosenDevices.length || tooMany || !scanners?.length} className="gap-2">
                            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}{busy ? "Starting…" : "Start scan"}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </PageShell>
    );
}

function HostRow({ h, selectable, picked, onToggle, showBox, assets, canAsset, assetBusy, onAddAsset }: { h: DiscoveredHost; selectable: boolean; picked: boolean; onToggle: () => void; showBox: boolean; assets: AssetProviderInfo | null; canAsset: boolean; assetBusy: boolean; onAddAsset: () => void }) {
    return (
        <tr className="align-top hover:bg-accent/30" data-testid="discovery-row" data-managed={h.deviceId ? "yes" : "no"}>
            {showBox ? <td className="px-3 py-2.5">{selectable ? <input type="checkbox" aria-label={`Select ${h.hostname ?? h.ip}`} checked={picked} onChange={onToggle} /> : null}</td> : null}
            <td className="px-3 py-2.5">
                <span className="font-medium">{h.hostname ?? h.ip}</span>
                <span className="block text-xs text-muted-foreground">{h.hostname ? `${h.ip}${h.nameSourceText ? ` · name from ${h.nameSourceText}` : ""}` : "No name"}{h.mac ? ` · ${h.mac}` : ""}{h.vendor ? ` · ${h.vendor}` : ""}</span>
                {h.deviceId ? <Link href={`/devices/${encodeURIComponent(h.deviceId)}`} className="text-xs text-primary hover:underline">Managed device: {h.deviceName ?? "open"}</Link> : h.ignored ? <span className="text-xs text-muted-foreground">Ignored</span> : null}
                {!h.deviceId && assets ? (
                    assets.provider === "external"
                        ? <span className="block text-xs text-muted-foreground">Assets are managed in {assets.externalName}{assets.externalUrl ? <> · <a className="text-primary hover:underline" href={assets.externalUrl} target="_blank" rel="noreferrer noopener">open</a></> : null}</span>
                        : h.assetRef ? <Link href={`/assets?asset=${encodeURIComponent(h.assetRef)}`} className="block text-xs text-primary hover:underline">Recorded as an asset</Link>
                        : canAsset ? <button className="block text-xs text-primary hover:underline disabled:opacity-60" disabled={assetBusy} onClick={onAddAsset}>{assetBusy ? "Adding…" : "Add as asset"}</button> : null
                ) : null}
                {!h.deviceId && ["printer", "network", "nas", "unknown", "web"].includes(h.kind) ? <Link href={`/snmp?add=1&siteId=${encodeURIComponent(h.siteId)}&ip=${encodeURIComponent(h.ip)}&name=${encodeURIComponent(h.hostname ?? "")}`} className="block text-xs text-primary hover:underline">Monitor with SNMP</Link> : null}
            </td>
            <td className="hidden px-3 py-2.5 sm:table-cell">{h.kindText}</td>
            <td className="hidden px-3 py-2.5 lg:table-cell">{h.ports.length ? h.ports.map((p) => PORT_NAMES[p] ?? String(p)).join(", ") : <span className="text-muted-foreground">None of the 16 checked</span>}</td>
            <td className="hidden px-3 py-2.5 md:table-cell">{h.customer ?? "No customer"}{h.site ? <span className="block text-xs text-muted-foreground">{h.site}</span> : null}</td>
            <td className="px-3 py-2.5">{ago(h.lastSeen)}<span className="block text-xs text-muted-foreground">first {ago(h.firstSeen)}</span></td>
        </tr>
    );
}

export default function NetworkDiscoveryPage() {
    return (
        <PermGate require="devices.read" title="Network discovery" message="You need permission to view devices to see what was found on the network.">
            <DiscoveryBody />
        </PermGate>
    );
}
