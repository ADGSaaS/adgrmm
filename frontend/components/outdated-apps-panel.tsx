"use client";

// A device's outdated programs (winget and Chocolatey) with an Update button for each, Scan now, and what the policies do.
import * as React from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/use-toast";
import { jfetch } from "@/lib/api";
import { errorText, Pill } from "@/components/policies/shared";

type Item = {
    source: "winget" | "chocolatey"; appId: string; name: string; installedVersion: string | null; availableVersion: string; approximate: boolean;
    blocked: boolean; allowed: boolean; updating: "waiting" | "running" | null;
    lastAttempt: { status: string; at: string; message: string | null } | null;
};
type View =
    | { supported: false; reason: string }
    | {
        supported: true; canScan: boolean; reason: string | null; scanning: boolean; items: Item[];
        automation: { scanEveryHours: number; mode: string; when: string; policy: string | null; minVersion: string };
        scan: { scannedAt: string | null; attemptedAt: string; ok: boolean; winget: string | null; chocolatey: string | null; message: string | null } | null;
    };

const STATE_TEXT: Record<string, string> = { ok: "answered", missing: "not installed", failed: "failed", timeout: "timed out", skipped: "skipped" };
const ago = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "never");

export function OutdatedAppsPanel({ deviceId, canInstall, onQueued }: { deviceId: string; canInstall: boolean; onQueued?: () => void }) {
    const [view, setView] = React.useState<View | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [busy, setBusy] = React.useState(false);

    const load = React.useCallback(async () => {
        try { setView(await jfetch<View>(`/api/devices/${encodeURIComponent(deviceId)}/software/updates`)); setError(null); } catch (e) { setError(errorText(e)); }
    }, [deviceId]);
    React.useEffect(() => { void load(); }, [load]);
    // while something is waiting, look again now and then
    const waiting = view?.supported && (view.scanning || view.items.some((i) => i.updating));
    React.useEffect(() => { if (!waiting) return; const t = setInterval(() => void load(), 8000); return () => clearInterval(t); }, [waiting, load]);

    const scan = async () => {
        setBusy(true);
        try {
            const r = await jfetch<{ queued: number; skipped: { reason: string }[] }>("/api/software-updates/scan", { method: "POST", body: { deviceIds: [deviceId] } });
            toast({ title: r.queued ? "Scan queued" : "Nothing queued", description: r.queued ? "The device looks for outdated programs within about ten seconds." : r.skipped[0]?.reason });
            await load();
        } catch (e) { toast({ title: "Could not start the scan", description: errorText(e), variant: "destructive" }); } finally { setBusy(false); }
    };
    const update = async (apps: { source: string; appId: string }[] | "all") => {
        setBusy(true);
        try {
            const r = await jfetch<{ queued: number; skipped: { reason: string; name?: string | null }[] }>("/api/software-updates/update", { method: "POST", body: { deviceIds: [deviceId], ...(apps === "all" ? { all: true } : { apps }) } });
            toast({ title: r.queued ? `${r.queued} update${r.queued === 1 ? "" : "s"} queued` : "Nothing queued", description: r.skipped.length ? r.skipped.slice(0, 3).map((s) => `${s.name ? s.name + ": " : ""}${s.reason}`).join(" ") : "Results appear in the install log below." });
            onQueued?.();
            await load();
        } catch (e) { toast({ title: "Could not start the update", description: errorText(e), variant: "destructive" }); } finally { setBusy(false); }
    };

    if (error) return <p role="alert" className="mb-4 text-sm text-destructive">{error}</p>;
    if (!view) return null;
    if (!view.supported) return <section aria-label="Outdated programs" className="mb-4 rounded-md border p-3 text-sm text-muted-foreground">{view.reason}</section>;

    const updatable = view.items.filter((i) => !i.blocked && !i.updating);
    const a = view.automation;
    return (
        <section aria-label="Outdated programs" className="mb-6 rounded-md border">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/40 px-3 py-2">
                <div>
                    <h3 className="text-sm font-semibold">Outdated programs{view.items.length ? ` (${view.items.length})` : ""}</h3>
                    <p className="text-xs text-muted-foreground">
                        {view.scan ? `Last scan ${ago(view.scan.scannedAt)}${view.scan.winget ? ` · winget ${STATE_TEXT[view.scan.winget] ?? view.scan.winget}` : ""}${view.scan.chocolatey ? ` · Chocolatey ${STATE_TEXT[view.scan.chocolatey] ?? view.scan.chocolatey}` : ""}` : "Not scanned yet"}
                        {view.scanning ? " · scan waiting" : ""}
                    </p>
                </div>
                <div className="flex gap-2">
                    <Button size="sm" variant="outline" disabled={!canInstall || busy || !view.canScan || view.scanning} title={!canInstall ? "You need the right to install software." : view.reason ?? "Look for programs with a newer version"} onClick={() => void scan()}>
                        <RefreshCw className="mr-1 h-3.5 w-3.5" aria-hidden /> Scan now
                    </Button>
                    <Button size="sm" disabled={!canInstall || busy || updatable.length === 0} onClick={() => void update("all")}>Update all ({updatable.length})</Button>
                </div>
            </div>
            {view.reason && <p className="px-3 pt-2 text-xs text-amber-600 dark:text-amber-400">{view.reason}</p>}
            {view.scan && !view.scan.ok && view.scan.message && <p className="px-3 pt-2 text-xs text-destructive">The last scan did not work: {view.scan.message}</p>}
            {view.items.length === 0 ? (
                <p className="px-3 py-3 text-sm text-muted-foreground">{view.scan?.scannedAt ? "Everything winget and Chocolatey know about is up to date." : "Choose Scan now to look for programs with a newer version."}</p>
            ) : (
                <ul>
                    {view.items.map((i) => (
                        <li key={`${i.source}:${i.appId}`} className="flex flex-wrap items-center justify-between gap-2 border-t px-3 py-2 text-sm first:border-t-0">
                            <span>
                                <span className="font-medium">{i.name}</span>
                                <span className="block text-xs text-muted-foreground">
                                    {i.installedVersion ?? "unknown"} to {i.availableVersion}{i.approximate ? " (installed version is only roughly known)" : ""} · {i.appId} · {i.source === "chocolatey" ? "Chocolatey" : "winget"}
                                </span>
                                {i.lastAttempt && <span className={`block text-xs ${i.lastAttempt.status === "failed" ? "text-destructive" : "text-muted-foreground"}`}>Last try {ago(i.lastAttempt.at)}: {i.lastAttempt.message ?? i.lastAttempt.status}</span>}
                            </span>
                            <span className="flex items-center gap-2">
                                {i.blocked && <Pill tone="bad">Never update</Pill>}
                                {i.allowed && !i.blocked && <Pill tone="good">Auto allowed</Pill>}
                                {i.updating && <Pill tone="warn">{i.updating === "running" ? "Updating" : "Waiting"}</Pill>}
                                <Button size="sm" variant="outline" disabled={!canInstall || busy || i.blocked || !!i.updating} title={i.blocked ? "On the never-update list" : undefined} onClick={() => void update([{ source: i.source, appId: i.appId }])}>Update</Button>
                            </span>
                        </li>
                    ))}
                </ul>
            )}
            <p className="border-t px-3 py-2 text-xs text-muted-foreground">
                {a.scanEveryHours > 0 ? `Scanned every ${a.scanEveryHours} hours` : "No scheduled scan"} · {a.mode === "all" ? "Updates itself, except never-update programs" : a.mode === "listed" ? "Updates allowed programs by itself" : "Updates by hand"}{a.mode !== "none" ? (a.when === "maintenance" ? " in a maintenance window" : " at any time") : ""}{a.policy ? ` (policy: ${a.policy})` : ""}. No restart is forced.
            </p>
        </section>
    );
}
