"use client";

// A Windows or Linux device's Network tab: use this device as the eyes on its own network. Scan the network it sits on (what else is
// there, including things with no agent), and watch printers, switches and other devices through SNMP from it. A scan only looks and
// a poll only reads; nothing on the network is changed. The results live on the Network discovery and Network devices (SNMP) pages;
// this tab starts them from here, with this device as the one that does the work, and shows what it found.
import * as React from "react";
import Link from "next/link";
import { Loader2, Radar } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { errorText } from "@/components/policies/shared";
import { useMe } from "@/lib/use-me";
import { hasPerm } from "@/lib/permissions";
import { ago } from "@/lib/security-api";
import { discovery, PORT_NAMES, type DiscoveredHost, type DiscoveryRun } from "@/lib/network-discovery-api";
import { KIND_TEXT, snmp, type SnmpDevice } from "@/lib/snmp-api";

const STATUS_CLASS = { ok: "text-emerald-700 dark:text-emerald-400", unreachable: "text-destructive", unknown: "text-muted-foreground" } as const;
const STATUS_TEXT = { ok: "Answering", unreachable: "Not answering", unknown: "Not polled yet" } as const;

function runText(r: DiscoveryRun): string {
    if (r.status === "pending") return "Scanning…";
    if (r.status === "failed") return `The last scan did not work: ${r.message ?? "no reason given"}`;
    return `Last scan ${ago(r.finishedAt)}: ${r.hostsFound} ${r.hostsFound === 1 ? "host" : "hosts"} seen${r.newHosts ? `, ${r.newHosts} new` : ""}${r.seconds !== null ? `, took ${r.seconds} s` : ""}.${r.message ? ` ${r.message}` : ""}`;
}

export default function DeviceNetworkTab({ deviceId, deviceName }: { deviceId: string; deviceName: string }) {
    const { permissions } = useMe();
    const canScan = hasPerm(permissions, ["devices.read", "devices.actions"]);
    const [siteId, setSiteId] = React.useState<string | null>(null);
    const [run, setRun] = React.useState<DiscoveryRun | null>(null);
    const [hosts, setHosts] = React.useState<DiscoveredHost[] | null>(null);
    const [devices, setDevices] = React.useState<SnmpDevice[] | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [open, setOpen] = React.useState(false);
    const [ranges, setRanges] = React.useState("");
    const [busy, setBusy] = React.useState(false);
    const [scanError, setScanError] = React.useState<string | null>(null);
    const alive = React.useRef(true);
    React.useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

    const load = React.useCallback(async () => {
        try {
            const [runs, scanners] = await Promise.all([discovery.runs(), discovery.scanners().catch(() => ({ items: [] }))]);
            const mine = runs.items.find((r) => r.scannerDeviceId === deviceId) ?? null;
            const sid = scanners.items.find((s) => s.deviceId === deviceId)?.siteId ?? mine?.siteId ?? null;
            if (!alive.current) return;
            setRun(mine); setSiteId(sid);
            if (sid) {
                const [h, d] = await Promise.all([discovery.hosts({ status: "unmanaged", siteId: sid, limit: 8 }), snmp.list({ siteId: sid })]);
                if (!alive.current) return;
                setHosts(h.items); setDevices(d.items);
            } else { setHosts([]); setDevices([]); }
            setError(null);
        } catch (e) { if (alive.current) { setError(errorText(e)); setHosts((x) => x ?? []); setDevices((x) => x ?? []); } }
    }, [deviceId]);
    React.useEffect(() => { void load(); }, [load]);

    // while the scan runs on the device, look again every few seconds
    const pending = run?.status === "pending";
    React.useEffect(() => {
        if (!pending || !run) return;
        const t = setInterval(() => { void discovery.run(run.id).then(() => load()).catch(() => { }); }, 4000);
        return () => clearInterval(t);
    }, [pending, run?.id, load]); // eslint-disable-line react-hooks/exhaustive-deps

    const start = async () => {
        setBusy(true); setScanError(null);
        try {
            await discovery.scan(deviceId, ranges.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean));
            setOpen(false); await load();
        } catch (e) { setScanError(errorText(e)); } finally { setBusy(false); }
    };

    const addHref = `/snmp?add=1&poller=${encodeURIComponent(deviceId)}${siteId ? `&siteId=${encodeURIComponent(siteId)}` : ""}`;
    return (
        <div className="space-y-6" data-testid="device-network-tab">
            {error ? <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">{error}</p> : null}

            <section aria-label="Scan this network" className="rounded-lg border p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                        <h3 className="text-sm font-semibold">What is on {deviceName}&apos;s network</h3>
                        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">This device looks at the network it is on: printers, switches, and computers that have no agent. It only looks; it never logs in to anything or changes anything.</p>
                        {run ? <p className="mt-2 text-sm" data-testid="device-network-last">{runText(run)}</p> : <p className="mt-2 text-sm text-muted-foreground">This device has not scanned its network yet.</p>}
                    </div>
                    {canScan ? (
                        <Button size="sm" className="gap-2" disabled={pending} onClick={() => { setScanError(null); setOpen(true); }}>
                            {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Radar className="h-4 w-4" aria-hidden="true" />}Scan this network
                        </Button>
                    ) : null}
                </div>
                {hosts === null ? <p className="mt-3 text-sm text-muted-foreground">Loading…</p> : hosts.length ? (
                    <div className="mt-3 overflow-x-auto rounded border">
                        <table className="w-full text-sm">
                            <caption className="sr-only">Hosts on this site that are not managed devices</caption>
                            <thead className="bg-muted/40 text-left text-xs text-muted-foreground"><tr><th scope="col" className="px-3 py-2">Not managed</th><th scope="col" className="hidden px-3 py-2 sm:table-cell">Looks like</th><th scope="col" className="hidden px-3 py-2 md:table-cell">Open ports</th><th scope="col" className="px-3 py-2">Seen</th></tr></thead>
                            <tbody className="divide-y">
                                {hosts.map((h) => (
                                    <tr key={h.id}>
                                        <td className="px-3 py-2"><span className="font-medium">{h.hostname ?? h.ip}</span><span className="block text-xs text-muted-foreground">{h.hostname ? `${h.ip}${h.nameSourceText ? ` · name from ${h.nameSourceText}` : ""}` : "No name"}{h.mac ? ` · ${h.mac}` : ""}{h.vendor ? ` · ${h.vendor}` : ""}</span></td>
                                        <td className="hidden px-3 py-2 sm:table-cell">{h.kindText}</td>
                                        <td className="hidden px-3 py-2 md:table-cell">{h.ports.length ? h.ports.map((p) => PORT_NAMES[p] ?? String(p)).join(", ") : <span className="text-muted-foreground">none of the 16 checked</span>}</td>
                                        <td className="px-3 py-2">{ago(h.lastSeen)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                ) : run?.status === "succeeded" ? <p className="mt-3 text-sm text-muted-foreground">Every host that was found is a managed device or has been ignored.</p> : null}
                <p className="mt-3 text-sm"><Link href="/network-discovery" className="text-primary hover:underline">Open Network discovery</Link> to see every host, ignore some, or scan on a schedule.</p>
            </section>

            <section aria-label="SNMP devices" className="rounded-lg border p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                        <h3 className="text-sm font-semibold">Network devices watched through SNMP</h3>
                        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">Printers, switches and other devices on this site, asked about their supplies, ports and state. A managed Windows or Linux device of the site does the asking; add one here and this device is the one that asks.</p>
                    </div>
                    {canScan ? <Button asChild variant="outline" size="sm"><Link href={addHref}>Monitor a device from here</Link></Button> : null}
                </div>
                {devices === null ? <p className="mt-3 text-sm text-muted-foreground">Loading…</p> : devices.length ? (
                    <ul className="mt-3 divide-y text-sm">
                        {devices.map((d) => (
                            <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                                <span><span className="font-medium">{d.name}</span> <span className="text-xs text-muted-foreground">{KIND_TEXT[d.kind]} · {d.ip}</span></span>
                                <span className={`text-xs ${STATUS_CLASS[d.status]}`}>{STATUS_TEXT[d.status]}{d.pollerDeviceId === deviceId ? " · polled from here" : d.pollerName ? ` · via ${d.pollerName}` : ""}</span>
                            </li>
                        ))}
                    </ul>
                ) : <p className="mt-3 text-sm text-muted-foreground">No device of this site is watched through SNMP yet.</p>}
                {devices?.length ? <p className="mt-3 text-sm"><Link href="/snmp" className="text-primary hover:underline">Open Network devices (SNMP)</Link> for supplies, ports and alerts.</p> : null}
            </section>

            <Dialog open={open} onOpenChange={(o) => !busy && setOpen(o)}>
                <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
                    <DialogHeader>
                        <DialogTitle>Scan the network of {deviceName}</DialogTitle>
                        <DialogDescription>This device pings the addresses of its network, reads what it knows about their MAC addresses and names, and checks 16 common ports on the ones that answer. It sends no logins and changes nothing. Only private addresses are scanned, and a scan takes a few minutes. The device must be online.</DialogDescription>
                    </DialogHeader>
                    <label className="grid min-w-0 gap-1 text-sm">
                        <span className="font-medium">Range (optional)</span>
                        <input className="h-10 w-full min-w-0 rounded-md border bg-background px-3 text-sm" placeholder="Empty: the subnet of this device's own network card" value={ranges} onChange={(e) => setRanges(e.target.value)} />
                        <span className="text-xs text-muted-foreground">For example 192.168.1.0/24. Several ranges can be separated by commas, up to 4. The widest range is /22 (1024 addresses).</span>
                    </label>
                    {scanError ? <p role="alert" className="text-sm text-destructive">{scanError}</p> : null}
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
                        <Button onClick={() => void start()} disabled={busy} className="gap-2">{busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}{busy ? "Starting…" : "Start scan"}</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
