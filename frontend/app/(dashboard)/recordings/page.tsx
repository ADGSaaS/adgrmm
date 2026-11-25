"use client";

// Recorded Remote Console sessions: filter, watch in the browser, download, delete, and set how long they are kept.
import * as React from "react";
import { Download, Play, Trash2, Video } from "lucide-react";
import { PageHeader, PageShell } from "@/components/page-shell";
import PermGate from "@/components/perm-gate";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/use-toast";
import { EmptyState } from "@/components/list-controls";
import { recordings, type RecordingFacets, type RecordingList, type RecordingRow, type RecordingSettings } from "@/lib/recordings-api";
import { fmtBytes } from "@/lib/file-paths";
import { useMe } from "@/lib/use-me";
import { hasPerm } from "@/lib/permissions";

const PAGE = 25;
const selectClass = "h-9 rounded-md border bg-background px-2 text-sm";

function fmtDuration(ms: number) {
    const s = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}
const fmtWhen = (iso: string) => new Date(iso).toLocaleString();
const STATUS_TEXT: Record<string, string> = { recording: "Recording now", complete: "Complete", interrupted: "Cut short", failed: "Failed" };

function SettingsCard({ canEdit, onChanged }: { canEdit: boolean; onChanged: () => void }) {
    const [s, setS] = React.useState<RecordingSettings | null>(null);
    const [days, setDays] = React.useState("");
    const [mb, setMb] = React.useState("");
    const [gb, setGb] = React.useState("");
    const [busy, setBusy] = React.useState(false);

    const load = React.useCallback(async () => {
        try {
            const r = await recordings.settings();
            setS(r);
            setDays(String(r.retentionDays));
            setMb(String(r.maxRecordingMb));
            setGb(String(r.quotaGb));
        } catch (e: any) {
            toast({ title: "Could not load the recording settings", description: e?.message, variant: "destructive" });
        }
    }, []);
    React.useEffect(() => {
        void load();
    }, [load]);

    async function save() {
        setBusy(true);
        try {
            const r = await recordings.saveSettings({ retentionDays: Number(days), maxRecordingMb: Number(mb), quotaGb: Number(gb) });
            setS(r);
            toast({ title: "Saved" });
            onChanged();
        } catch (e: any) {
            toast({ title: "That did not save", description: e?.message, variant: "destructive" });
        } finally {
            setBusy(false);
        }
    }

    if (!s) return null;
    const pct = Math.min(100, Math.round((s.usedBytes / (s.quotaGb * 1024 ** 3)) * 100));
    return (
        <section className="rounded-lg border p-4" aria-label="Retention and storage">
            <div className="flex flex-wrap items-end gap-4">
                <label className="grid gap-1 text-sm">
                    <span className="font-medium">Keep recordings for (days)</span>
                    <Input className="w-32" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} disabled={!canEdit} />
                </label>
                <label className="grid gap-1 text-sm">
                    <span className="font-medium">Largest recording (MB)</span>
                    <Input className="w-32" inputMode="numeric" value={mb} onChange={(e) => setMb(e.target.value)} disabled={!canEdit} />
                </label>
                <label className="grid gap-1 text-sm">
                    <span className="font-medium">Storage limit (GB)</span>
                    <Input className="w-32" inputMode="numeric" value={gb} onChange={(e) => setGb(e.target.value)} disabled={!canEdit} />
                </label>
                {canEdit ? (
                    <Button onClick={save} disabled={busy}>{busy ? "Saving…" : "Save"}</Button>
                ) : (
                    <span className="text-xs text-muted-foreground">Changing these needs the right to delete recordings.</span>
                )}
            </div>
            <p className="mt-3 text-sm text-muted-foreground">
                {s.recordings} recording{s.recordings === 1 ? "" : "s"}, {fmtBytes(s.usedBytes)} of {s.quotaGb} GB used ({pct}%). Recordings are encrypted on the server and removed automatically when they pass the retention period.
                Recording is switched on per customer, in Customers &gt; Remote access notice, or by a policy.
            </p>
        </section>
    );
}

function RecordingsInner() {
    const { permissions } = useMe();
    const canDelete = hasPerm(permissions, "recordings.delete");
    const [facets, setFacets] = React.useState<RecordingFacets>({ clients: [], technicians: [] });
    const [clientId, setClientId] = React.useState("");
    const [technicianId, setTechnicianId] = React.useState("");
    const [status, setStatus] = React.useState("");
    const [from, setFrom] = React.useState("");
    const [to, setTo] = React.useState("");
    const [offset, setOffset] = React.useState(0);
    const [data, setData] = React.useState<RecordingList | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [playing, setPlaying] = React.useState<RecordingRow | null>(null);
    const [deleting, setDeleting] = React.useState<RecordingRow | null>(null);
    const [busy, setBusy] = React.useState(false);
    const [reload, setReload] = React.useState(0);

    React.useEffect(() => {
        recordings.facets().then(setFacets).catch(() => { });
    }, [reload]);

    React.useEffect(() => {
        let cancelled = false;
        setError(null);
        recordings
            .list({
                clientId,
                technicianId,
                status,
                from: from ? new Date(`${from}T00:00:00`).toISOString() : undefined,
                to: to ? new Date(new Date(`${to}T00:00:00`).getTime() + 86_400_000).toISOString() : undefined,
                limit: PAGE,
                offset,
            })
            .then((r) => !cancelled && setData(r))
            .catch((e: any) => !cancelled && setError(e?.message || "Could not load the recordings."));
        return () => {
            cancelled = true;
        };
    }, [clientId, technicianId, status, from, to, offset, reload]);

    const filter = (set: (v: string) => void) => (e: React.ChangeEvent<HTMLSelectElement | HTMLInputElement>) => {
        set(e.target.value);
        setOffset(0);
    };

    async function confirmDelete() {
        if (!deleting) return;
        setBusy(true);
        try {
            await recordings.remove(deleting.id);
            toast({ title: "Recording deleted" });
            setDeleting(null);
            setReload((n) => n + 1);
        } catch (e: any) {
            toast({ title: "Could not delete it", description: e?.message, variant: "destructive" });
        } finally {
            setBusy(false);
        }
    }

    return (
        <PageShell>
            <PageHeader title="Session recordings" description="Remote Console sessions that were recorded. Every view, download and deletion is written to the audit log." />
            <SettingsCard canEdit={canDelete} onChanged={() => setReload((n) => n + 1)} />

            <div className="flex flex-wrap items-end gap-3">
                <label className="grid gap-1 text-xs font-medium">Customer
                    <select className={selectClass} value={clientId} onChange={filter(setClientId)}>
                        <option value="">All customers</option>
                        {facets.clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                </label>
                <label className="grid gap-1 text-xs font-medium">Technician
                    <select className={selectClass} value={technicianId} onChange={filter(setTechnicianId)}>
                        <option value="">Everyone</option>
                        {facets.technicians.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                </label>
                <label className="grid gap-1 text-xs font-medium">Status
                    <select className={selectClass} value={status} onChange={filter(setStatus)}>
                        <option value="">Any</option>
                        <option value="complete">Complete</option>
                        <option value="interrupted">Cut short</option>
                        <option value="recording">Recording now</option>
                    </select>
                </label>
                <label className="grid gap-1 text-xs font-medium">From
                    <Input type="date" className="h-9" value={from} onChange={filter(setFrom)} />
                </label>
                <label className="grid gap-1 text-xs font-medium">To
                    <Input type="date" className="h-9" value={to} onChange={filter(setTo)} />
                </label>
            </div>

            {error ? <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900" role="alert">{error}</div> : null}

            {data && data.items.length === 0 ? (
                <EmptyState>Nothing matches. Recordings appear after a Remote Console session on a customer that has Record remote sessions turned on.</EmptyState>
            ) : (
                <div className="overflow-x-auto rounded-lg border">
                    <table className="w-full text-sm">
                        <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
                            <tr>
                                <th className="px-3 py-2">Started</th>
                                <th className="px-3 py-2">Customer</th>
                                <th className="px-3 py-2">Device</th>
                                <th className="px-3 py-2">Technician</th>
                                <th className="px-3 py-2">Length</th>
                                <th className="px-3 py-2">Size</th>
                                <th className="px-3 py-2">Status</th>
                                <th className="px-3 py-2">Deleted on</th>
                                <th className="px-3 py-2" />
                            </tr>
                        </thead>
                        <tbody>
                            {(data?.items ?? []).map((r) => (
                                <tr key={r.id} className="border-t" data-testid="recording-row">
                                    <td className="px-3 py-2 whitespace-nowrap">{fmtWhen(r.startedAt)}</td>
                                    <td className="px-3 py-2">{r.clientName ?? "-"}</td>
                                    <td className="px-3 py-2">{r.deviceName ?? "(deleted device)"}</td>
                                    <td className="px-3 py-2">{r.technicianName ?? "-"}</td>
                                    <td className="px-3 py-2 whitespace-nowrap">{fmtDuration(r.durationMs)}</td>
                                    <td className="px-3 py-2 whitespace-nowrap">{fmtBytes(r.sizeBytes)}</td>
                                    <td className="px-3 py-2 whitespace-nowrap">{STATUS_TEXT[r.status] ?? r.status}</td>
                                    <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">{new Date(r.expiresAt).toLocaleDateString()}</td>
                                    <td className="px-3 py-2">
                                        <div className="flex justify-end gap-1">
                                            <Button size="sm" variant="outline" className="gap-1" onClick={() => setPlaying(r)} disabled={r.sizeBytes === 0}><Play className="h-3.5 w-3.5" />Watch</Button>
                                            <Button size="sm" variant="outline" asChild disabled={r.sizeBytes === 0}>
                                                <a href={recordings.streamUrl(r.id, true)} aria-label="Download" title="Download (WebM)"><Download className="h-3.5 w-3.5" /></a>
                                            </Button>
                                            {canDelete ? <Button size="sm" variant="outline" onClick={() => setDeleting(r)} aria-label="Delete" title="Delete"><Trash2 className="h-3.5 w-3.5" /></Button> : null}
                                        </div>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {data && data.total > PAGE ? (
                <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">{offset + 1} to {Math.min(offset + PAGE, data.total)} of {data.total} ({fmtBytes(data.sizeBytes)})</span>
                    <div className="flex gap-2">
                        <Button size="sm" variant="outline" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Previous</Button>
                        <Button size="sm" variant="outline" disabled={offset + PAGE >= data.total} onClick={() => setOffset(offset + PAGE)}>Next</Button>
                    </div>
                </div>
            ) : null}

            <Dialog open={!!playing} onOpenChange={(o) => !o && setPlaying(null)}>
                <DialogContent className="max-w-4xl">
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2"><Video className="h-4 w-4" />{playing?.deviceName ?? "Recording"}</DialogTitle>
                        <DialogDescription>
                            {playing ? `${playing.clientName ?? ""} - ${playing.technicianName ?? ""} - ${fmtWhen(playing.startedAt)}` : ""}
                        </DialogDescription>
                    </DialogHeader>
                    {playing ? (
                        // eslint-disable-next-line jsx-a11y/media-has-caption
                        <video key={playing.id} src={recordings.streamUrl(playing.id)} controls autoPlay className="max-h-[70vh] w-full rounded-md bg-black" data-testid="recording-player" />
                    ) : null}
                </DialogContent>
            </Dialog>

            <Dialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle>Delete this recording?</DialogTitle>
                        <DialogDescription>
                            {deleting ? `${deleting.deviceName ?? "Device"} on ${fmtWhen(deleting.startedAt)}` : ""}. This removes the video from the server and cannot be undone. The deletion is written to the audit log.
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setDeleting(null)} disabled={busy}>Cancel</Button>
                        <Button variant="destructive" onClick={confirmDelete} disabled={busy}>{busy ? "Deleting…" : "Delete"}</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </PageShell>
    );
}

export default function RecordingsPage() {
    return (
        <PermGate require="recordings.read" title="Session recordings" message="You need permission to view session recordings.">
            <RecordingsInner />
        </PermGate>
    );
}
