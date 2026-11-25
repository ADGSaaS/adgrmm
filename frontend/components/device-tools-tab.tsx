"use client";

// Services / Processes / Event log of one device. Everything here is a signed script job the device runs and answers
// (nothing is installed on the device for it), so it only works while the device is online. Looking needs the right to run
// device actions; changing a service or ending a process needs devices.tools.write too.
import * as React from "react";
import { apiUrl, jfetch } from "@/lib/api";
import { useMe } from "@/lib/use-me";
import { hasPerm } from "@/lib/permissions";
import { deviceFamily } from "@/lib/device-os";
import { errorText, Pill } from "@/components/policies/shared";
import { SegmentedTabs } from "@/components/list-controls";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type Section = "services" | "processes" | "events";
type ServiceRow = { name: string; display: string; state: string; startType: string; account: string | null; pid: number | null };
type ProcessRow = { name: string; pid: number; cpuSeconds: number | null; memoryMb: number | null; user: string | null };
type EventRow = { time: string; id: number | null; level: string; levelNumber: number | null; provider: string; message: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const selectClass = "h-9 rounded-md border bg-background px-2 text-sm";

/** Runs a tool request; a device that is slow answers "pending" with a job, which is asked about until it ends. */
async function tool<T>(deviceId: string, path: string, init?: { method?: string; body?: unknown }): Promise<T & { pending?: boolean }> {
    const base = `/api/devices/${encodeURIComponent(deviceId)}/tools`;
    let r = await jfetch<any>(`${base}/${path}`, init as any);
    for (let i = 0; i < 100 && r?.pending; i++) {
        await sleep(1500);
        r = await jfetch<any>(`${base}/jobs/${encodeURIComponent(r.jobId)}`);
    }
    if (r?.pending) throw new Error("The device has not answered yet. Try again in a moment.");
    return r;
}

const seconds = (s: number | null) => (s == null ? "—" : s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}m ${Math.floor(s % 60)}s` : `${s}s`);

type Pending = { title: string; body: string; confirm: string; force?: boolean; run: (force: boolean) => Promise<string> };

function Confirm({ pending, onClose, family }: { pending: Pending; onClose: (done?: string) => void; family: "windows" | "linux" }) {
    const [force, setForce] = React.useState(false);
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    return (
        <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{pending.title}</DialogTitle>
                    <DialogDescription>{pending.body}</DialogDescription>
                </DialogHeader>
                {pending.force ? (
                    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} /> {family === "windows" ? "Force it (also stops services that depend on it, or ends the process even if it does not answer)" : "Force it (kill instead of ask)"}</label>
                ) : null}
                {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
                <DialogFooter>
                    <Button variant="outline" onClick={() => onClose()} disabled={busy}>Cancel</Button>
                    <Button
                        variant="destructive"
                        disabled={busy}
                        onClick={async () => {
                            setBusy(true);
                            setError(null);
                            try {
                                onClose(await pending.run(force));
                            } catch (e) {
                                setError(errorText(e));
                                setBusy(false);
                            }
                        }}
                    >
                        {busy ? "Working…" : pending.confirm}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function Services({ deviceId, family, canWrite, deviceName, say }: { deviceId: string; family: "windows" | "linux"; canWrite: boolean; deviceName: string; say: (s: string) => void }) {
    const [rows, setRows] = React.useState<ServiceRow[] | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [loading, setLoading] = React.useState(false);
    const [q, setQ] = React.useState("");
    const [state, setState] = React.useState("");
    const [pending, setPending] = React.useState<Pending | null>(null);
    const load = React.useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            setRows((await tool<{ items: ServiceRow[] }>(deviceId, "services")).items);
        } catch (e) {
            setError(errorText(e));
        } finally {
            setLoading(false);
        }
    }, [deviceId]);
    React.useEffect(() => { void load(); }, [load]);

    const act = (s: ServiceRow, action: "start" | "stop" | "restart" | "startup", startType?: string): Pending => ({
        title: action === "startup" ? `Set ${s.display || s.name} to start ${startType}` : `${action[0].toUpperCase()}${action.slice(1)} ${s.display || s.name}`,
        body: action === "startup" ? `This changes how ${s.name} starts on ${deviceName}.${family === "linux" && startType === "disabled" ? " On Linux disabled means masked: it cannot be started at all until it is unmasked." : ""}` : `This ${action}s the service ${s.name} on ${deviceName}. Anything that uses it is interrupted.`,
        confirm: action === "startup" ? "Change" : `${action[0].toUpperCase()}${action.slice(1)}`,
        force: action === "stop" || action === "restart",
        run: async (force) => {
            const r = await tool<{ state: string; startType: string }>(deviceId, "services/action", { method: "POST", body: { name: s.name, action, ...(startType ? { startType } : {}), ...(force ? { force: true } : {}) } });
            await load();
            return `${s.display || s.name}: now ${r.state || "changed"}${r.startType ? `, starts ${r.startType}` : ""}.`;
        },
    });

    const list = (rows ?? []).filter((r) => (!q || `${r.name} ${r.display}`.toLowerCase().includes(q.toLowerCase())) && (!state || r.state === state));
    const startTypes = family === "windows" ? ["automatic", "delayed", "manual", "disabled"] : ["automatic", "manual", "disabled"];

    return (
        <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
                <Input aria-label="Filter services" placeholder="Filter services" value={q} onChange={(e) => setQ(e.target.value)} className="w-64" />
                <select aria-label="State" className={selectClass} value={state} onChange={(e) => setState(e.target.value)}>
                    <option value="">Any state</option>
                    <option value="running">Running</option>
                    <option value="stopped">Stopped</option>
                    <option value="failed">Failed</option>
                </select>
                <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>{loading ? "Loading…" : "Refresh"}</Button>
                {rows ? <span className="text-xs text-muted-foreground">{list.length} of {rows.length}</span> : null}
            </div>
            {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
            {!rows && loading ? <p className="text-sm text-muted-foreground">Asking the device…</p> : null}
            {rows ? (
                <div className="max-h-[60vh] overflow-auto rounded-md border">
                    <table className="w-full text-sm">
                        <thead className="sticky top-0 bg-card text-left text-xs text-muted-foreground"><tr><th className="px-3 py-2">Name</th><th className="px-3 py-2">Service</th><th className="px-3 py-2">State</th><th className="px-3 py-2">Starts</th><th className="px-3 py-2"><span className="sr-only">Actions</span></th></tr></thead>
                        <tbody className="divide-y divide-border/60">
                            {list.slice(0, 500).map((s) => (
                                <tr key={s.name} className="hover:bg-accent/40">
                                    <td className="max-w-[18rem] truncate px-3 py-1.5 font-medium" title={s.display}>{s.display || s.name}</td>
                                    <td className="max-w-[14rem] truncate px-3 py-1.5 text-xs text-muted-foreground" title={s.name}>{s.name}</td>
                                    <td className="px-3 py-1.5"><Pill tone={s.state === "running" ? "good" : s.state === "failed" ? "bad" : "muted"}>{s.state}</Pill></td>
                                    <td className="px-3 py-1.5 text-xs">{s.startType}</td>
                                    <td className="px-3 py-1.5 text-right">
                                        {canWrite ? (
                                            <span className="inline-flex flex-wrap justify-end gap-1">
                                                {s.state !== "running" ? <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => setPending(act(s, "start"))}>Start</Button> : null}
                                                {s.state === "running" ? <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => setPending(act(s, "stop"))}>Stop</Button> : null}
                                                {s.state === "running" ? <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => setPending(act(s, "restart"))}>Restart</Button> : null}
                                                <select aria-label={`Start type for ${s.name}`} className="h-7 rounded-md border bg-background px-1 text-xs" value="" onChange={(e) => e.target.value && setPending(act(s, "startup", e.target.value))}>
                                                    <option value="">Start type…</option>
                                                    {startTypes.map((t) => <option key={t} value={t}>{t}</option>)}
                                                </select>
                                            </span>
                                        ) : null}
                                    </td>
                                </tr>
                            ))}
                            {list.length === 0 ? <tr><td colSpan={5} className="px-3 py-4 text-center text-xs text-muted-foreground">No services match.</td></tr> : null}
                        </tbody>
                    </table>
                </div>
            ) : null}
            {!canWrite && rows ? <p className="text-xs text-muted-foreground">Starting, stopping and changing services needs the right to change services and processes.</p> : null}
            {list.length > 500 ? <p className="text-xs text-muted-foreground">Showing the first 500. Filter to narrow the list.</p> : null}
            {pending ? <Confirm pending={pending} family={family} onClose={(done) => { setPending(null); if (done) say(done); }} /> : null}
        </div>
    );
}

function Processes({ deviceId, family, canWrite, deviceName, say }: { deviceId: string; family: "windows" | "linux"; canWrite: boolean; deviceName: string; say: (s: string) => void }) {
    const [rows, setRows] = React.useState<ProcessRow[] | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [loading, setLoading] = React.useState(false);
    const [q, setQ] = React.useState("");
    const [sort, setSort] = React.useState<"memory" | "cpu" | "name" | "pid">("memory");
    const [pending, setPending] = React.useState<Pending | null>(null);
    const load = React.useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            setRows((await tool<{ items: ProcessRow[] }>(deviceId, "processes")).items);
        } catch (e) {
            setError(errorText(e));
        } finally {
            setLoading(false);
        }
    }, [deviceId]);
    React.useEffect(() => { void load(); }, [load]);

    const list = (rows ?? [])
        .filter((r) => !q || `${r.name} ${r.pid} ${r.user ?? ""}`.toLowerCase().includes(q.toLowerCase()))
        .sort((a, b) => (sort === "name" ? a.name.localeCompare(b.name) : sort === "pid" ? a.pid - b.pid : sort === "cpu" ? (b.cpuSeconds ?? -1) - (a.cpuSeconds ?? -1) : (b.memoryMb ?? -1) - (a.memoryMb ?? -1)));
    const end = (p: ProcessRow): Pending => ({
        title: `End ${p.name} (${p.pid})`,
        body: `This ends the process ${p.name} with id ${p.pid} on ${deviceName}. Unsaved work in it is lost.`,
        confirm: "End process",
        force: true,
        run: async (force) => {
            await tool(deviceId, "processes/end", { method: "POST", body: { pid: p.pid, ...(force ? { force: true } : {}) } });
            await load();
            return `Ended ${p.name} (${p.pid}).`;
        },
    });

    return (
        <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
                <Input aria-label="Filter processes" placeholder="Filter by name, id or user" value={q} onChange={(e) => setQ(e.target.value)} className="w-64" />
                <select aria-label="Sort by" className={selectClass} value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
                    <option value="memory">Most memory</option>
                    <option value="cpu">Most CPU time</option>
                    <option value="name">Name</option>
                    <option value="pid">Process id</option>
                </select>
                <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>{loading ? "Loading…" : "Refresh"}</Button>
                {rows ? <span className="text-xs text-muted-foreground">{list.length} of {rows.length}</span> : null}
            </div>
            {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
            {!rows && loading ? <p className="text-sm text-muted-foreground">Asking the device…</p> : null}
            {rows ? (
                <div className="max-h-[60vh] overflow-auto rounded-md border">
                    <table className="w-full text-sm">
                        <thead className="sticky top-0 bg-card text-left text-xs text-muted-foreground"><tr><th className="px-3 py-2">Name</th><th className="px-3 py-2">Id</th><th className="px-3 py-2">CPU time</th><th className="px-3 py-2">Memory</th><th className="px-3 py-2">User</th><th className="px-3 py-2"><span className="sr-only">Actions</span></th></tr></thead>
                        <tbody className="divide-y divide-border/60">
                            {list.slice(0, 500).map((p) => (
                                <tr key={p.pid} className="hover:bg-accent/40">
                                    <td className="max-w-[16rem] truncate px-3 py-1.5 font-medium" title={p.name}>{p.name}</td>
                                    <td className="px-3 py-1.5 text-xs">{p.pid}</td>
                                    <td className="px-3 py-1.5 text-xs">{seconds(p.cpuSeconds)}</td>
                                    <td className="px-3 py-1.5 text-xs">{p.memoryMb == null ? "—" : `${p.memoryMb} MB`}</td>
                                    <td className="max-w-[12rem] truncate px-3 py-1.5 text-xs text-muted-foreground" title={p.user ?? ""}>{p.user ?? "—"}</td>
                                    <td className="px-3 py-1.5 text-right">{canWrite ? <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => setPending(end(p))}>End</Button> : null}</td>
                                </tr>
                            ))}
                            {list.length === 0 ? <tr><td colSpan={6} className="px-3 py-4 text-center text-xs text-muted-foreground">No processes match.</td></tr> : null}
                        </tbody>
                    </table>
                </div>
            ) : null}
            {!canWrite && rows ? <p className="text-xs text-muted-foreground">Ending a process needs the right to change services and processes.</p> : null}
            {pending ? <Confirm pending={pending} family={family} onClose={(done) => { setPending(null); if (done) say(done); }} /> : null}
        </div>
    );
}

const LEVEL_OPTIONS = ["critical", "error", "warning", "information", "verbose"] as const;

function EventLog({ deviceId, family, canSecurity }: { deviceId: string; family: "windows" | "linux"; canSecurity: boolean }) {
    const logs = family === "windows"
        ? [["Application", "Application"], ["System", "System"], ["Setup", "Setup"], ...(canSecurity ? [["Security", "Security"]] : [])]
        : [["system", "System journal"], ["kernel", "Kernel"], ...(canSecurity ? [["security", "Security (sign-ins)"]] : [])];
    const [log, setLog] = React.useState(logs[0][0]);
    const [hours, setHours] = React.useState("24");
    const [max, setMax] = React.useState("200");
    const [levels, setLevels] = React.useState<string[]>(["critical", "error", "warning"]);
    const [text, setText] = React.useState("");
    const [res, setRes] = React.useState<{ items: EventRow[]; truncated: boolean; scanned: number } | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [loading, setLoading] = React.useState(false);
    const [open, setOpen] = React.useState<number | null>(null);

    const query = () => {
        const sp = new URLSearchParams({ log, hours, max });
        if (levels.length && !/^security$/i.test(log)) sp.set("levels", levels.join(","));
        if (text.trim()) sp.set("q", text.trim());
        return sp;
    };
    const load = async () => {
        setLoading(true);
        setError(null);
        setOpen(null);
        try {
            setRes(await tool(deviceId, `eventlog?${query().toString()}`));
        } catch (e) {
            setError(errorText(e));
            setRes(null);
        } finally {
            setLoading(false);
        }
    };
    const exportCsv = async () => {
        const sp = query();
        sp.set("format", "csv");
        try {
            const r = await fetch(apiUrl(`/api/devices/${encodeURIComponent(deviceId)}/tools/eventlog?${sp.toString()}`), { credentials: "include" });
            if (!r.ok) throw new Error((await r.json().catch(() => null))?.message ?? `Export failed (${r.status})`);
            const body = await r.text();
            // The server answers pending (JSON) when the device is slow; asking again through the normal path waits for it.
            if (r.headers.get("content-type")?.includes("json")) throw new Error("The device is slow to answer. Load the log first, then export again.");
            const url = URL.createObjectURL(new Blob([body], { type: "text/csv;charset=utf-8" }));
            const a = document.createElement("a");
            a.href = url;
            a.download = `event-log-${log}.csv`;
            a.click();
            URL.revokeObjectURL(url);
        } catch (e) {
            setError(errorText(e));
        }
    };
    const toggle = (l: string) => setLevels((cur) => (cur.includes(l) ? cur.filter((x) => x !== l) : [...cur, l]));

    return (
        <div className="space-y-3">
            <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); void load(); }}>
                <label className="grid gap-1 text-xs text-muted-foreground">Log
                    <select className={selectClass} value={log} onChange={(e) => setLog(e.target.value)}>{logs.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
                </label>
                <label className="grid gap-1 text-xs text-muted-foreground">Period
                    <select className={selectClass} value={hours} onChange={(e) => setHours(e.target.value)}>
                        {[["1", "Last hour"], ["6", "Last 6 hours"], ["24", "Last 24 hours"], ["72", "Last 3 days"], ["168", "Last 7 days"], ["720", "Last 30 days"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                </label>
                <label className="grid gap-1 text-xs text-muted-foreground">Most
                    <select className={selectClass} value={max} onChange={(e) => setMax(e.target.value)}>{["50", "100", "200", "500"].map((v) => <option key={v} value={v}>{v} events</option>)}</select>
                </label>
                <label className="grid gap-1 text-xs text-muted-foreground">Contains
                    <Input value={text} maxLength={200} onChange={(e) => setText(e.target.value)} placeholder="Text in the message or source" className="w-64" />
                </label>
                <fieldset className="flex flex-wrap items-center gap-3 text-sm" disabled={/^security$/i.test(log)}>
                    <legend className="sr-only">Levels</legend>
                    {LEVEL_OPTIONS.filter((l) => family === "windows" || l !== "verbose").map((l) => (
                        <label key={l} className="flex items-center gap-1 capitalize"><input type="checkbox" checked={levels.includes(l)} onChange={() => toggle(l)} /> {l}</label>
                    ))}
                </fieldset>
                <Button type="submit" size="sm" disabled={loading}>{loading ? "Reading…" : "Read the log"}</Button>
                <Button type="button" size="sm" variant="outline" onClick={() => void exportCsv()} disabled={loading}>Export CSV</Button>
            </form>
            {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
            {res ? (
                <>
                    <p className="text-xs text-muted-foreground">{res.items.length} {res.items.length === 1 ? "event" : "events"}{res.truncated ? ", more exist than are shown: narrow the period or add a filter" : ""}.</p>
                    <div className="max-h-[60vh] overflow-auto rounded-md border">
                        <table className="w-full text-sm">
                            <thead className="sticky top-0 bg-card text-left text-xs text-muted-foreground"><tr><th className="px-3 py-2">Time</th><th className="px-3 py-2">Level</th><th className="px-3 py-2">Source</th>{family === "windows" ? <th className="px-3 py-2">Id</th> : null}<th className="px-3 py-2">Message</th></tr></thead>
                            <tbody className="divide-y divide-border/60">
                                {res.items.map((e, i) => (
                                    <tr key={i} className="cursor-pointer align-top hover:bg-accent/40" onClick={() => setOpen(open === i ? null : i)}>
                                        <td className="whitespace-nowrap px-3 py-1.5 text-xs">{e.time ? new Date(e.time).toLocaleString() : "—"}</td>
                                        <td className="px-3 py-1.5"><Pill tone={e.levelNumber != null && e.levelNumber <= 2 ? "bad" : e.levelNumber === 3 ? "warn" : "muted"}>{e.level || "—"}</Pill></td>
                                        <td className="max-w-[14rem] truncate px-3 py-1.5 text-xs" title={e.provider}>{e.provider}</td>
                                        {family === "windows" ? <td className="px-3 py-1.5 text-xs">{e.id ?? ""}</td> : null}
                                        <td className={`px-3 py-1.5 text-xs ${open === i ? "whitespace-pre-wrap break-words" : "max-w-[40rem] truncate"}`}>{e.message}</td>
                                    </tr>
                                ))}
                                {res.items.length === 0 ? <tr><td colSpan={5} className="px-3 py-4 text-center text-xs text-muted-foreground">No events match.</td></tr> : null}
                            </tbody>
                        </table>
                    </div>
                </>
            ) : null}
        </div>
    );
}

export default function DeviceToolsTab({ deviceId, os, deviceName }: { deviceId: string; os: string; deviceName: string }) {
    const { permissions } = useMe();
    const family = deviceFamily(os);
    const [section, setSection] = React.useState<Section>("services");
    const [note, setNote] = React.useState<string | null>(null);
    const canLook = hasPerm(permissions, ["devices.read", "devices.actions"]);
    const canWrite = hasPerm(permissions, ["devices.actions", "devices.tools.write"]);

    if (family !== "windows" && family !== "linux") return <p className="text-sm text-muted-foreground">These tools are available for Windows and Linux devices.</p>;
    if (!canLook) return <p className="text-sm text-muted-foreground">Looking at services, processes and the event log needs the right to run device actions.</p>;

    return (
        <div className="space-y-4" data-testid="device-tools">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <SegmentedTabs label="Tools" items={[{ key: "services", label: "Services" }, { key: "processes", label: "Processes" }, { key: "events", label: "Event log" }]} value={section} onChange={(k) => { setSection(k as Section); setNote(null); }} />
                <p className="text-xs text-muted-foreground">Asked of the device when you open or refresh a list; it must be online. Every look and change is recorded in the audit log.</p>
            </div>
            {note ? <p role="status" className="rounded-md border bg-muted/40 px-3 py-2 text-sm">{note}</p> : null}
            {section === "services" ? <Services deviceId={deviceId} family={family} canWrite={canWrite} deviceName={deviceName} say={setNote} /> : null}
            {section === "processes" ? <Processes deviceId={deviceId} family={family} canWrite={canWrite} deviceName={deviceName} say={setNote} /> : null}
            {section === "events" ? <EventLog deviceId={deviceId} family={family} canSecurity={hasPerm(permissions, "devices.tools.write")} /> : null}
        </div>
    );
}
