"use client";

// The software install log: what each install or removal did, who asked for it, and what the device said.
// With a deviceId it shows that device; without one it shows everything the person may see.
import * as React from "react";
import { Button } from "@/components/ui/button";
import { EmptyState, SegmentedTabs } from "@/components/list-controls";
import { Pager, usePaged } from "@/components/pager";
import { jfetch } from "@/lib/api";
import { errorText, Pill } from "@/components/policies/shared";

type InstallStatus = "waiting" | "running" | "succeeded" | "failed" | "cancelled";
export type InstallLogItem = {
    id: string;
    deviceId: string;
    device: string;
    customer: string;
    site: string;
    action: "install" | "uninstall" | "upgrade";
    name: string;
    method: "chocolatey" | "direct" | "winget";
    runAs?: string | null;
    status: InstallStatus;
    stale: boolean;
    requestedBy: string | null;
    requestedAt: string;
    startedAt: string | null;
    finishedAt: string | null;
    ok: boolean | null;
    exitCode: number | null;
    message: string | null;
    stdout: string | null;
    stderr: string | null;
};

const STATUS_LABEL: Record<InstallStatus, string> = { waiting: "Waiting", running: "Running", succeeded: "Succeeded", failed: "Failed", cancelled: "Cancelled" };
const STATUS_TONE: Record<InstallStatus, "muted" | "good" | "warn" | "bad"> = { waiting: "muted", running: "warn", succeeded: "good", failed: "bad", cancelled: "muted" };

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "");

function took(item: InstallLogItem): string {
    if (!item.startedAt || !item.finishedAt) return "";
    const s = Math.max(0, Math.round((new Date(item.finishedAt).getTime() - new Date(item.startedAt).getTime()) / 1000));
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** One sentence that says how it went, in plain words. */
function summary(item: InstallLogItem): string {
    const verb = item.action === "install" ? "install" : item.action === "upgrade" ? "update" : "removal";
    if (item.status === "waiting") return item.stale ? `The device has not picked this up yet. It may be offline, or its agent may be too old for ${verb}s.` : "Waiting for the device to pick it up. This usually takes about ten seconds.";
    if (item.status === "running") return item.stale ? "Still running after a very long time. It may be stuck." : "Running on the device now.";
    if (item.message) return item.message;
    if (item.status === "succeeded") return `The ${verb} finished.`;
    if (item.status === "failed") return `The ${verb} failed.`;
    return "Cancelled.";
}

export function SoftwareInstallLog({ deviceId, refreshKey = 0, title = "Install log" }: { deviceId?: string; refreshKey?: number; title?: string }) {
    const [items, setItems] = React.useState<InstallLogItem[] | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [filter, setFilter] = React.useState<"all" | "waiting" | "running" | "succeeded" | "failed">("all");
    const [open, setOpen] = React.useState<Set<string>>(new Set());
    const [loading, setLoading] = React.useState(false);

    const url = deviceId ? `/api/devices/${encodeURIComponent(deviceId)}/software/installs?limit=100` : "/api/software-library/installs?limit=200";
    const load = React.useCallback(async () => {
        setLoading(true);
        try {
            const r = await jfetch<{ items: InstallLogItem[] }>(url);
            setItems(r.items);
            setError(null);
        } catch (e) {
            setError(errorText(e));
        } finally {
            setLoading(false);
        }
    }, [url]);

    React.useEffect(() => { void load(); }, [load, refreshKey]);

    // While something is waiting or running, look again every few seconds so the result appears by itself.
    const active = !!items?.some((i) => i.status === "waiting" || i.status === "running");
    React.useEffect(() => {
        if (!active) return;
        const t = window.setInterval(() => void load(), 5000);
        return () => window.clearInterval(t);
    }, [active, load]);

    const counts = React.useMemo(() => {
        const c = { all: items?.length ?? 0, waiting: 0, running: 0, succeeded: 0, failed: 0 };
        for (const i of items ?? []) if (i.status in c) (c as Record<string, number>)[i.status]++;
        return c;
    }, [items]);
    const shown = React.useMemo(() => (items ?? []).filter((i) => filter === "all" || i.status === filter), [items, filter]);
    const paged = usePaged(shown, deviceId ? "software-install-log-device" : "software-install-log", 10);

    const toggle = (id: string) => setOpen((cur) => { const n = new Set(cur); if (n.has(id)) n.delete(id); else n.add(id); return n; });

    return (
        <section aria-label={title} className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                    <h2 className="text-sm font-semibold">{title}</h2>
                    <p className="max-w-2xl text-xs text-muted-foreground">
                        {deviceId ? "Installs and removals started on this device, newest first." : "Installs and removals on every device you can see, newest first."} Open Details to see what the device reported.
                    </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <SegmentedTabs
                        label="Install status"
                        items={[
                            { key: "all", label: "All", count: counts.all },
                            { key: "waiting", label: "Waiting", count: counts.waiting },
                            { key: "running", label: "Running", count: counts.running },
                            { key: "succeeded", label: "Succeeded", count: counts.succeeded },
                            { key: "failed", label: "Failed", count: counts.failed },
                        ]}
                        value={filter}
                        onChange={(k) => setFilter(k as typeof filter)}
                    />
                    <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>{loading ? "Loading…" : "Refresh"}</Button>
                </div>
            </div>

            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            {items === null && !error && <p className="text-sm text-muted-foreground">Loading…</p>}
            {items?.length === 0 && <EmptyState>Nothing has been installed or removed from here yet.</EmptyState>}
            {items && items.length > 0 && shown.length === 0 && <EmptyState>No {filter === "all" ? "" : `${STATUS_LABEL[filter].toLowerCase()} `}installs.</EmptyState>}

            {shown.length > 0 && (
                <>
                    <div className="overflow-hidden rounded-xl border border-border/70 bg-card">
                        <ul className="divide-y divide-border/60">
                            {paged.rows.map((i) => {
                                const isOpen = open.has(i.id);
                                const hasDetails = !!(i.stdout || i.stderr || i.exitCode !== null);
                                return (
                                    <li key={i.id} className="px-5 py-3 text-sm hover:bg-accent">
                                        <div className="flex flex-wrap items-start justify-between gap-2">
                                            <div className="min-w-0">
                                                <div className="flex flex-wrap items-center gap-2">
                                                    <Pill tone={i.stale && (i.status === "waiting" || i.status === "running") ? "warn" : STATUS_TONE[i.status]}>
                                                        {i.stale && i.status === "waiting" ? "No answer yet" : STATUS_LABEL[i.status]}
                                                    </Pill>
                                                    <span className="font-medium">{i.action === "install" ? "Install" : i.action === "upgrade" ? "Update" : "Uninstall"} {i.name}{i.runAs ? ` for ${i.runAs}` : ""}</span>
                                                    {!deviceId && <span className="text-muted-foreground">on {i.device}{i.customer ? ` (${i.customer})` : ""}</span>}
                                                </div>
                                                <div className="mt-0.5 text-xs text-muted-foreground">
                                                    {[i.requestedBy ? `Asked by ${i.requestedBy}` : null, when(i.requestedAt), took(i) ? `took ${took(i)}` : null, i.method === "chocolatey" ? "Chocolatey" : i.method === "winget" ? "winget" : "Direct installer"].filter(Boolean).join(" · ")}
                                                </div>
                                                <div className={`mt-1 break-words text-sm ${i.status === "failed" ? "text-destructive" : ""}`}>{summary(i)}</div>
                                            </div>
                                            {hasDetails && (
                                                <Button variant="ghost" size="sm" aria-expanded={isOpen} onClick={() => toggle(i.id)}>{isOpen ? "Hide details" : "Details"}</Button>
                                            )}
                                        </div>
                                        {isOpen && (
                                            <div className="mt-2 grid gap-2">
                                                {i.exitCode !== null && <div className="text-xs text-muted-foreground">Exit code {i.exitCode}</div>}
                                                {i.stdout && (
                                                    <div>
                                                        <div className="mb-1 text-xs font-medium text-muted-foreground">Output</div>
                                                        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-2 text-xs">{i.stdout}</pre>
                                                    </div>
                                                )}
                                                {i.stderr && (
                                                    <div>
                                                        <div className="mb-1 text-xs font-medium text-muted-foreground">Errors</div>
                                                        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-2 text-xs">{i.stderr}</pre>
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                    </li>
                                );
                            })}
                        </ul>
                    </div>
                    <Pager paged={paged} noun="installs" />
                </>
            )}
        </section>
    );
}
