"use client";

// Network devices (SNMP): printers, switches and other devices that have no agent, watched through SNMP by a managed Windows or Linux
// device of the same site. Shows whether each one answers, printer supplies and faults, switch ports, and raises alerts (a device that
// stops answering, a supply running low, a printer fault). The community string is only ever sent to the server, never shown again.
import * as React from "react";
import Link from "next/link";
import { Loader2, Printer, Router, Server } from "lucide-react";
import { PageHeader, PageShell } from "@/components/page-shell";
import PermGate from "@/components/perm-gate";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState } from "@/components/list-controls";
import { errorText } from "@/components/policies/shared";
import { useMe } from "@/lib/use-me";
import { hasPerm } from "@/lib/permissions";
import { ago } from "@/lib/security-api";
import { discovery, type Scanner } from "@/lib/network-discovery-api";
import { assetProvider, type AssetProviderInfo } from "@/lib/assets-provider-api";
import { KIND_CHOICES, KIND_TEXT, POLL_CHOICES, snmp, speedText, uptimeText, type SnmpDetail, type SnmpDevice, type SnmpList } from "@/lib/snmp-api";

const STATUS_TEXT = { ok: "Answering", unreachable: "Not answering", unknown: "Not polled yet" } as const;
const STATUS_CLASS = { ok: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200", unreachable: "bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200", unknown: "bg-muted text-muted-foreground" } as const;
const KIND_ICON = { printer: Printer, switch: Router, other: Server } as const;

function Bar({ percent }: { percent: number | null }) {
    if (percent === null) return <span className="text-xs text-muted-foreground">level not reported</span>;
    const tone = percent <= 3 ? "bg-red-500" : percent <= 10 ? "bg-amber-500" : "bg-emerald-500";
    return (
        <span className="inline-flex items-center gap-2">
            <span className="h-2 w-24 overflow-hidden rounded bg-muted" role="img" aria-label={`${percent}% left`}><span className={`block h-full ${tone}`} style={{ width: `${percent}%` }} /></span>
            <span className="text-xs tabular-nums">{percent}%</span>
        </span>
    );
}

function SnmpBody() {
    const { permissions } = useMe();
    const canEdit = hasPerm(permissions, ["devices.read", "devices.actions"]);
    const [data, setData] = React.useState<SnmpList | null>(null);
    const [status, setStatus] = React.useState("");
    const [term, setTerm] = React.useState("");
    const [error, setError] = React.useState<string | null>(null);
    const [busy, setBusy] = React.useState<string | null>(null);
    const [detail, setDetail] = React.useState<SnmpDetail | null>(null);
    const [edit, setEdit] = React.useState<{ device: SnmpDevice | null } | null>(null);
    const [scanners, setScanners] = React.useState<Scanner[] | null>(null);
    const [form, setForm] = React.useState({ siteId: "", ip: "", port: "161", community: "", name: "", kind: "auto", pollMinutes: 15, alertEnabled: true, pollerDeviceId: "" });
    const [formError, setFormError] = React.useState<string | null>(null);
    const canAsset = hasPerm(permissions, ["devices.read", "assets.write"]);
    const [assets, setAssets] = React.useState<AssetProviderInfo | null>(null);
    React.useEffect(() => { void assetProvider.get().then(setAssets).catch(() => { }); }, []);
    const addAsset = async (d: SnmpDevice) => {
        setBusy(d.id);
        try { await assetProvider.addSnmpDevice(d.id); setDetail(await snmp.get(d.id)); await load(); } catch (e) { setError(errorText(e)); } finally { setBusy(null); }
    };
    const alive = React.useRef(true);
    React.useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

    const load = React.useCallback(async () => {
        try { const r = await snmp.list({ status, q: term }); if (alive.current) { setData(r); setError(null); } } catch (e) { if (alive.current) { setError(errorText(e)); setData((x) => x ?? { total: 0, counts: { ok: 0, unreachable: 0, unknown: 0 }, items: [] }); } }
    }, [status, term]);
    React.useEffect(() => { const t = setTimeout(() => void load(), term ? 300 : 0); return () => clearTimeout(t); }, [load, term]);
    // while a poll is waiting for its answer, look again every few seconds
    const polling = !!data?.items.some((d) => d.polling);
    React.useEffect(() => { if (!polling) return; const t = setInterval(() => void load(), 4000); return () => clearInterval(t); }, [polling, load]);

    const openEdit = React.useCallback(async (device: SnmpDevice | null, prefill?: { siteId?: string; ip?: string; name?: string; pollerDeviceId?: string }) => {
        setFormError(null);
        if (scanners === null) { try { setScanners((await discovery.scanners()).items); } catch { setScanners([]); } }
        setForm(device
            ? { siteId: device.siteId, ip: device.ip, port: String(device.port), community: "", name: device.label ?? "", kind: device.kindChosen, pollMinutes: device.pollMinutes, alertEnabled: device.alertEnabled, pollerDeviceId: device.pollerDeviceId ?? "" }
            : { siteId: prefill?.siteId ?? "", ip: prefill?.ip ?? "", port: "161", community: "", name: prefill?.name ?? "", kind: "auto", pollMinutes: 15, alertEnabled: true, pollerDeviceId: prefill?.pollerDeviceId ?? "" });
        setEdit({ device });
    }, [scanners]);
    // a link from Network discovery opens the add dialog with the host filled in
    React.useEffect(() => {
        const sp = new URLSearchParams(window.location.search);
        if (sp.get("add") === "1") void openEdit(null, { siteId: sp.get("siteId") ?? undefined, ip: sp.get("ip") ?? undefined, name: sp.get("name") ?? undefined, pollerDeviceId: sp.get("poller") ?? undefined });
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const save = async () => {
        setBusy("save"); setFormError(null);
        try {
            const common = { name: form.name.trim() || null, kind: form.kind, pollMinutes: form.pollMinutes, alertEnabled: form.alertEnabled, pollerDeviceId: form.pollerDeviceId || null, port: Number(form.port) || 161, ...(form.community.trim() ? { community: form.community.trim() } : {}) };
            if (edit?.device) await snmp.update(edit.device.id, common);
            else await snmp.create({ ...common, siteId: form.siteId, ip: form.ip.trim(), name: form.name.trim() || undefined, pollerDeviceId: form.pollerDeviceId || undefined });
            setEdit(null); await load();
        } catch (e) { setFormError(errorText(e)); } finally { setBusy(null); }
    };
    const act = async (d: SnmpDevice, what: "poll" | "remove" | "toggle") => {
        setBusy(d.id);
        try {
            if (what === "poll") await snmp.poll(d.id); else if (what === "remove") { await snmp.remove(d.id); setDetail(null); } else await snmp.update(d.id, { enabled: !d.enabled });
            await load();
        } catch (e) { setError(errorText(e)); } finally { setBusy(null); }
    };
    const open = async (d: SnmpDevice) => { try { setDetail(await snmp.get(d.id)); } catch (e) { setError(errorText(e)); } };
    const sites = Array.from(new Map((scanners ?? []).map((s) => [s.siteId, `${s.customer ?? "No customer"} / ${s.site ?? "No site"}`])).entries());
    const items = data?.items ?? [];

    return (
        <PageShell>
            <PageHeader
                title="Network devices (SNMP)"
                description="Printers, switches and other devices without an agent, watched through SNMP by a managed Windows or Linux device of the same site. You get an alert when one stops answering, a printer supply runs low, or a printer reports a fault. Reading only: nothing on the device is ever changed."
                actions={canEdit ? <Button size="sm" onClick={() => void openEdit(null)}>Add a device</Button> : undefined}
            />
            {error ? <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">{error}</p> : null}

            <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap gap-1" role="group" aria-label="Show">
                    {([["", "All", data ? data.counts.ok + data.counts.unreachable + data.counts.unknown : 0], ["ok", "Answering", data?.counts.ok ?? 0], ["unreachable", "Not answering", data?.counts.unreachable ?? 0]] as const).map(([key, label, n]) => (
                        <Button key={key} size="sm" variant={status === key ? "default" : "outline"} onClick={() => setStatus(key)}>{label}{data ? ` ${n}` : ""}</Button>
                    ))}
                </div>
                <input aria-label="Search the devices" placeholder="Name, address or description" className="h-9 w-64 rounded-md border bg-background px-3 text-sm" value={term} onChange={(e) => setTerm(e.target.value)} />
            </div>

            {data === null ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />Loading…</div>
            ) : items.length === 0 ? (
                <EmptyState>
                    <div className="font-medium text-foreground">{term || status ? "No device matches" : "No device is monitored yet"}</div>
                    <div>Add a printer or switch with its address and SNMP community (often &quot;public&quot;). SNMP must be switched on in the device. You can also start from a host found on the Network discovery page.</div>
                </EmptyState>
            ) : (
                <div className="overflow-x-auto rounded-lg border">
                    <table className="w-full text-sm" data-testid="snmp-table">
                        <caption className="sr-only">Monitored network devices</caption>
                        <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
                            <tr><th scope="col" className="px-3 py-2">Device</th><th scope="col" className="px-3 py-2">Status</th><th scope="col" className="hidden px-3 py-2 md:table-cell">What it says</th><th scope="col" className="hidden px-3 py-2 lg:table-cell">Customer</th><th scope="col" className="px-3 py-2">Polled</th>{canEdit ? <th scope="col" className="px-3 py-2"><span className="sr-only">Actions</span></th> : null}</tr>
                        </thead>
                        <tbody className="divide-y">
                            {items.map((d) => {
                                const Icon = KIND_ICON[d.kind];
                                return (
                                    <tr key={d.id} className="align-top hover:bg-accent/30" data-testid="snmp-row" data-status={d.status}>
                                        <td className="px-3 py-2.5">
                                            <button className="flex items-start gap-2 text-left font-medium hover:underline" onClick={() => void open(d)}><Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />{d.name}</button>
                                            <span className="block pl-6 text-xs text-muted-foreground">{KIND_TEXT[d.kind]} · {d.ip}{d.port !== 161 ? `:${d.port}` : ""}{!d.enabled ? " · paused" : ""}</span>
                                        </td>
                                        <td className="px-3 py-2.5">
                                            <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_CLASS[d.status]}`}>{d.polling ? "Polling…" : STATUS_TEXT[d.status]}</span>
                                            {d.status === "unreachable" ? <span className="block text-xs text-muted-foreground">{d.failures} polls in a row</span> : null}
                                            {d.message && d.status !== "unreachable" ? <span className="block max-w-[16rem] text-xs text-amber-700 dark:text-amber-400">{d.message}</span> : null}
                                        </td>
                                        <td className="hidden px-3 py-2.5 md:table-cell">
                                            {d.status === "unknown" ? <span className="text-muted-foreground">Nothing yet</span> : d.kind === "printer" ? (
                                                <div className="space-y-0.5">
                                                    {d.summary.lowestSupplyPercent !== null ? <div className="flex items-center gap-2"><span className="text-xs text-muted-foreground">Lowest supply</span><Bar percent={d.summary.lowestSupplyPercent} /></div> : null}
                                                    <div className="text-xs text-muted-foreground">{[d.summary.printerStatus, d.summary.pages !== null ? `${d.summary.pages.toLocaleString()} pages` : null].filter(Boolean).join(" · ")}</div>
                                                    {d.summary.faults.length ? <div className="text-xs font-medium text-destructive">{d.summary.faults.join(", ")}</div> : null}
                                                </div>
                                            ) : d.kind === "switch" ? <span>{d.summary.portsUp} ports up{d.summary.portsDown ? <span className="text-destructive">, {d.summary.portsDown} down</span> : ""}</span> : <span className="text-xs text-muted-foreground">{d.description ?? "Up " + uptimeText(d.uptimeSeconds)}</span>}
                                        </td>
                                        <td className="hidden px-3 py-2.5 lg:table-cell">{d.customer ?? "No customer"}{d.site ? <span className="block text-xs text-muted-foreground">{d.site}</span> : null}</td>
                                        <td className="px-3 py-2.5">{ago(d.lastPolledAt)}<span className="block text-xs text-muted-foreground">via {d.pollerName ?? "an online device of the site"}</span></td>
                                        {canEdit ? (
                                            <td className="px-3 py-2.5"><div className="flex flex-wrap gap-1">
                                                <Button variant="outline" size="sm" disabled={busy === d.id || d.polling} onClick={() => void act(d, "poll")}>Poll now</Button>
                                                <Button variant="outline" size="sm" onClick={() => void openEdit(d)}>Edit</Button>
                                            </div></td>
                                        ) : null}
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}

            <Dialog open={!!detail} onOpenChange={(o) => !o && setDetail(null)}>
                <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
                    {detail ? (
                        <>
                            <DialogHeader>
                                <DialogTitle>{detail.name}</DialogTitle>
                                <DialogDescription>{KIND_TEXT[detail.kind]} at {detail.ip}{detail.location ? `, ${detail.location}` : ""}. {detail.description ?? ""}</DialogDescription>
                            </DialogHeader>
                            <p className="text-xs text-muted-foreground" data-testid="snmp-asset">
                                {assets?.provider === "external" ? `Assets are managed in ${assets.externalName}.` : detail.assetRef ? <Link href={`/assets?asset=${encodeURIComponent(detail.assetRef)}`} className="text-primary hover:underline">Recorded as an asset. Open it.</Link> : "Not recorded as an asset."}
                            </p>
                            <p className="text-sm">{STATUS_TEXT[detail.status]}{detail.uptimeSeconds !== null ? `. Up for ${uptimeText(detail.uptimeSeconds)}.` : "."} Last answered {ago(detail.lastOkAt)}.</p>
                            {detail.printer?.faults.length ? <p className="text-sm font-medium text-destructive">{detail.printer.faults.map((f) => f.text).join(", ")}</p> : null}
                            {detail.supplies.length ? (
                                <section aria-label="Supplies"><h3 className="mb-1 text-sm font-semibold">Supplies</h3>
                                    <ul className="space-y-1 text-sm">{detail.supplies.map((s) => <li key={s.index} className="flex items-center justify-between gap-3"><span>{s.description || `Supply ${s.index}`}</span><Bar percent={s.percent} /></li>)}</ul>
                                </section>
                            ) : null}
                            {detail.interfaces.length ? (
                                <section aria-label="Ports"><h3 className="mb-1 text-sm font-semibold">Ports ({detail.interfaces.filter((i) => i.oper === 1).length} up of {detail.interfaces.length})</h3>
                                    <div className="max-h-60 overflow-auto rounded border"><table className="w-full text-xs"><thead className="bg-muted/40 text-left"><tr><th className="px-2 py-1">Port</th><th className="px-2 py-1">State</th><th className="px-2 py-1">Speed</th></tr></thead>
                                        <tbody className="divide-y">{detail.interfaces.map((i) => <tr key={i.index}><td className="px-2 py-1">{i.name}</td><td className={`px-2 py-1 ${i.oper === 1 ? "" : "text-destructive"}`}>{i.oper === 1 ? "Up" : "Down"}</td><td className="px-2 py-1">{speedText(i.speed)}</td></tr>)}</tbody></table></div>
                                </section>
                            ) : null}
                            <section aria-label="History"><h3 className="mb-1 text-sm font-semibold">Last polls</h3>
                                <p className="text-xs text-muted-foreground">{detail.samples.slice(0, 12).map((s) => `${new Date(s.at).toLocaleTimeString()} ${s.ok ? "answered" : "no answer"}`).join(" · ") || "No poll yet."}</p>
                            </section>
                            <DialogFooter>
                                {canAsset && assets?.provider === "builtin" && !detail.assetRef ? <Button variant="outline" disabled={busy === detail.id} onClick={() => void addAsset(detail)}>Add as asset</Button> : null}
                                {canEdit ? <Button variant="outline" disabled={busy === detail.id} onClick={() => void act(detail, "toggle").then(() => setDetail(null))}>{detail.enabled ? "Pause monitoring" : "Resume monitoring"}</Button> : null}
                                {canEdit ? <Button variant="destructive" disabled={busy === detail.id} onClick={() => void act(detail, "remove")}>Stop monitoring</Button> : null}
                                <Button onClick={() => setDetail(null)}>Close</Button>
                            </DialogFooter>
                        </>
                    ) : null}
                </DialogContent>
            </Dialog>

            <Dialog open={!!edit} onOpenChange={(o) => !busy && !o && setEdit(null)}>
                <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
                    <DialogHeader>
                        <DialogTitle>{edit?.device ? `Change ${edit.device.name}` : "Monitor a network device"}</DialogTitle>
                        <DialogDescription>A managed Windows or Linux device of the same site asks the device over SNMP (version 1 or 2c) and only reads. The community string is stored encrypted and is never shown again. A Linux poller needs the snmp package (the Software tab can install it).</DialogDescription>
                    </DialogHeader>
                    <div className="grid gap-3">
                        {!edit?.device ? (
                            <>
                                <label className="grid min-w-0 gap-1 text-sm"><span className="font-medium">Site</span>
                                    <select className="h-10 w-full min-w-0 rounded-md border bg-background px-2 text-sm" value={form.siteId} onChange={(e) => setForm({ ...form, siteId: e.target.value, pollerDeviceId: "" })}>
                                        <option value="">Choose a site</option>{sites.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
                                    </select>
                                    <span className="text-xs text-muted-foreground">Sites with a Windows or Linux device that is online now are listed.</span></label>
                                <label className="grid min-w-0 gap-1 text-sm"><span className="font-medium">Address</span>
                                    <input className="h-10 w-full min-w-0 rounded-md border bg-background px-3 text-sm" placeholder="192.168.1.50" value={form.ip} onChange={(e) => setForm({ ...form, ip: e.target.value })} /></label>
                            </>
                        ) : null}
                        <label className="grid min-w-0 gap-1 text-sm"><span className="font-medium">Community string{edit?.device ? " (leave empty to keep the current one)" : ""}</span>
                            <input className="h-10 w-full min-w-0 rounded-md border bg-background px-3 text-sm" type="password" autoComplete="off" placeholder={edit?.device ? "Unchanged" : "public"} value={form.community} onChange={(e) => setForm({ ...form, community: e.target.value })} /></label>
                        <label className="grid min-w-0 gap-1 text-sm"><span className="font-medium">Name (optional)</span>
                            <input className="h-10 w-full min-w-0 rounded-md border bg-background px-3 text-sm" placeholder="What the device calls itself" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
                        <div className="grid grid-cols-2 gap-3">
                            <label className="grid min-w-0 gap-1 text-sm"><span className="font-medium">Type</span>
                                <select className="h-10 w-full min-w-0 rounded-md border bg-background px-2 text-sm" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>{KIND_CHOICES.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}</select></label>
                            <label className="grid min-w-0 gap-1 text-sm"><span className="font-medium">How often</span>
                                <select className="h-10 w-full min-w-0 rounded-md border bg-background px-2 text-sm" value={form.pollMinutes} onChange={(e) => setForm({ ...form, pollMinutes: Number(e.target.value) })}>{POLL_CHOICES.map((p) => <option key={p.minutes} value={p.minutes}>{p.label}</option>)}</select></label>
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                            <label className="grid min-w-0 gap-1 text-sm"><span className="font-medium">Port</span>
                                <input className="h-10 w-full min-w-0 rounded-md border bg-background px-3 text-sm" inputMode="numeric" value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value })} /></label>
                            <label className="grid min-w-0 gap-1 text-sm"><span className="font-medium">Poll from</span>
                                <select className="h-10 w-full min-w-0 rounded-md border bg-background px-2 text-sm" value={form.pollerDeviceId} onChange={(e) => setForm({ ...form, pollerDeviceId: e.target.value })} disabled={!form.siteId}>
                                    <option value="">Any online device of the site</option>{(scanners ?? []).filter((s) => s.siteId === form.siteId).map((s) => <option key={s.deviceId} value={s.deviceId}>{s.name}</option>)}</select></label>
                        </div>
                        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.alertEnabled} onChange={(e) => setForm({ ...form, alertEnabled: e.target.checked })} />Raise alerts (not answering, supply low, printer fault)</label>
                    </div>
                    {formError ? <p role="alert" className="text-sm text-destructive">{formError}</p> : null}
                    <DialogFooter>
                        {edit?.device ? <Button variant="ghost" className="mr-auto" disabled={busy === "save"} onClick={() => void act(edit.device!, "remove").then(() => setEdit(null))}>Stop monitoring</Button> : null}
                        <Button variant="outline" onClick={() => setEdit(null)} disabled={busy === "save"}>Cancel</Button>
                        <Button onClick={() => void save()} disabled={busy === "save" || (!edit?.device && (!form.siteId || !form.ip.trim()))} className="gap-2">{busy === "save" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}{busy === "save" ? "Saving…" : edit?.device ? "Save" : "Start monitoring"}</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </PageShell>
    );
}

export default function SnmpPage() {
    return (
        <PermGate require="devices.read" title="Network devices (SNMP)" message="You need permission to view devices to see the network devices that are monitored.">
            <SnmpBody />
        </PermGate>
    );
}
