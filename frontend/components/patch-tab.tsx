"use client";

import React from "react";
import { ColumnDef, SortingState, ColumnFiltersState, VisibilityState } from "@tanstack/react-table";
import { RefreshCw, ShieldCheck, Download } from "lucide-react";

import { DataTable } from "@/components/data-table";
import { SortHeader } from "@/components/sort-header";
import { EmptyState } from "@/components/list-controls";
import { Pager, usePaged } from "@/components/pager";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { apiUrl } from "@/lib/api";
import { deviceFamily } from "@/lib/device-os";

type PatchStatus = "Required" | "Installed" | "Pending";

export type PatchRow = {
    id: string;
    title: string;
    severity: string | null;
    requiresReboot: boolean;
    kbIds: string[];
    status: PatchStatus;
    /** Linux: flagged as a security update by the distribution. */
    security?: boolean;
    current?: string | null;
    available?: string | null;
};

const POLL_MS = 5000;
const SCAN_WATCH_MS = 10 * 60_000;
const INSTALL_WATCH_MS = 60 * 60_000;

type LatestResp = {
    ok: boolean;
    lastScanAt: string | null;
    lastScan?: { status: string; error: string | null } | null;
    scanPending?: boolean;
    installPending?: boolean;
    os?: "windows" | "linux" | null;
    supported?: boolean;
    unsupportedReason?: string | null;
    packageManager?: string | null;
    skipped?: Array<{ id: string; reason: string }>;
    rebootRequired?: boolean | null;
    rebootReason?: string | null;
    patches: Array<{
        id: string;
        title: string;
        severity: string | null;
        requiresReboot: boolean;
        kbIds: string[];
        status?: string; // backend may send
        security?: boolean;
        current?: string | null;
        available?: string | null;
    }>;
};

type PatchHistoryItem = {
    taskId: string;
    runId: string;
    agentId: string;
    deviceId: string;
    status: string; // running|succeeded|failed|cancelled...
    startedAt: string;
    finishedAt: string | null;
    error?: string | null;
    installed: string[];
    requiresReboot: boolean | null;
    createdBy: string | null;
    createdByName: string | null;
};

type HistoryResp = {
    ok: boolean;
    items: PatchHistoryItem[];
};

function normalizeStatus(raw: unknown): PatchStatus {
    const s = String(raw ?? "").trim().toLowerCase();
    if (!s) return "Pending";
    if (s === "required" || s === "available" || s === "missing" || s === "needs_install") return "Required";
    if (s === "installed" || s === "applied") return "Installed";
    if (s === "pending" || s === "queued" || s === "unknown") return "Pending";
    return "Pending";
}

function fmtDt(input: string | null): string {
    if (!input) return "—";
    const d = new Date(input);
    const t = d.getTime();
    if (!Number.isFinite(t)) return "—";
    try {
        return new Intl.DateTimeFormat("en-US", {
            month: "2-digit",
            day: "2-digit",
            year: "numeric",
            hour: "numeric",
            minute: "2-digit",
            hour12: true,
        }).format(d).replace(",", " -");
    } catch {
        return input;
    }
}

function shortId(id: string): string {
    const s = String(id || "");
    if (s.length <= 12) return s;
    return `${s.slice(0, 8)}…${s.slice(-4)}`;
}

function whoLabel(h: PatchHistoryItem): string {
    if (h.createdByName && h.createdByName.trim()) return h.createdByName.trim();
    if (h.createdBy && h.createdBy.trim()) return shortId(h.createdBy.trim());
    return "System";
}

async function safeJson(res: Response): Promise<any> {
    try {
        return await res.json();
    } catch {
        return null;
    }
}

async function api<T>(url: string, init?: RequestInit): Promise<{ res: Response; data: T | null }> {
    const res = await fetch(apiUrl(url), {
        credentials: "include",
        headers: {
            "Content-Type": "application/json",
            ...(init?.headers ?? {}),
        },
        ...init,
    });
    const data = (await safeJson(res)) as T | null;
    return { res, data };
}

function StatusPill({ status }: { status: PatchStatus }) {
    if (status === "Installed") {
        return (
            <Badge className="bg-emerald-600 text-white hover:bg-emerald-600/90" variant="secondary">
                Installed
            </Badge>
        );
    }
    if (status === "Pending") {
        return (
            <Badge className="bg-muted text-foreground/80 border border-border hover:bg-muted" variant="outline">
                Pending
            </Badge>
        );
    }
    return <Badge variant="destructive">Required</Badge>;
}

function HistoryStatusPill({ status }: { status: string }) {
    const s = String(status ?? "").trim().toLowerCase();
    if (s === "succeeded") {
        return (
            <Badge className="bg-emerald-600 text-white hover:bg-emerald-600/90" variant="secondary">
                Succeeded
            </Badge>
        );
    }
    if (s === "failed") return <Badge variant="destructive">Failed</Badge>;
    if (s === "cancelled") {
        return (
            <Badge className="bg-muted text-foreground/80 border border-border hover:bg-muted" variant="outline">
                Cancelled
            </Badge>
        );
    }
    if (s === "running") {
        return (
            <Badge className="bg-sky-600 text-white hover:bg-sky-600/90" variant="secondary">
                Running
            </Badge>
        );
    }
    if (s === "queued" || s === "pending") {
        return (
            <Badge className="bg-muted text-foreground/80 border border-border hover:bg-muted" variant="outline">
                Queued
            </Badge>
        );
    }
    return (
        <Badge className="bg-muted text-foreground/80 border border-border hover:bg-muted" variant="outline">
            {status || "Unknown"}
        </Badge>
    );
}

function normalizeKb(kb: string) {
    const raw = String(kb ?? "").trim();
    const digits = raw.replace(/[^0-9]/g, "");
    return digits ? `KB${digits}` : raw.toUpperCase();
}

function kbToMicrosoftSupportUrl(kb: string) {
    const norm = normalizeKb(kb);
    // Reliable: Microsoft Support KB search (works even when topic URLs differ)
    return `https://www.google.com/search?q=${encodeURIComponent(norm)}`;
}

function extractBuildFromTitle(title: string): string | null {
    // Looks for things like "(26200.7623)" or "(26100.7623)"
    const t = String(title ?? "");
    const matches = [...t.matchAll(/\((\d{4,6}\.\d{1,6})\)/g)].map((m) => m[1]);
    if (!matches.length) return null;
    return matches[matches.length - 1] ?? null; // usually the last paren is the build/version
}

export default function PatchTab({ deviceId, os }: { deviceId: string; os?: string | null }) {
    const isLinux = deviceFamily(os) === "linux";
    const [info, setInfo] = React.useState<{ supported: boolean; reason: string | null; packageManager: string | null; skipped: Array<{ id: string; reason: string }>; rebootRequired: boolean | null; rebootReason: string | null } | null>(null);
    const [busyBulk, setBusyBulk] = React.useState<"security" | "all" | null>(null);

    const [sorting, setSorting] = React.useState<SortingState>([]);
    const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>([]);
    const [columnVisibility, setColumnVisibility] = React.useState<VisibilityState>({});

    const [rows, setRows] = React.useState<PatchRow[]>([]);
    const [lastScanAt, setLastScanAt] = React.useState<string | null>(null);
    const [loading, setLoading] = React.useState(false);
    const [busyScan, setBusyScan] = React.useState(false);
    const [busyInstallId, setBusyInstallId] = React.useState<string | null>(null);

    const [history, setHistory] = React.useState<PatchHistoryItem[]>([]);
    const [historyLoading, setHistoryLoading] = React.useState(false);
    const paged = usePaged(history, "patch-history");

    const [loadError, setLoadError] = React.useState<string | null>(null);
    const [lastScanError, setLastScanError] = React.useState<string | null>(null);
    const [watching, setWatching] = React.useState<"scan" | "install" | null>(null);

    const aliveRef = React.useRef(true);
    React.useEffect(() => {
        aliveRef.current = true;
        return () => {
            aliveRef.current = false;
        };
    }, []);

    const [msg, setMsg] = React.useState<{ kind: "success" | "error" | "info"; text: string } | null>(null);

    const loadLatest = React.useCallback(async () => {
        setLoading(true);

        const { res, data } = await api<LatestResp>(`/api/patches/latest?deviceId=${encodeURIComponent(deviceId)}`, {
            method: "GET",
        });

        if (!res.ok) {
            setRows([]);
            setLastScanAt(null);
            setLoadError((data as any)?.message ? String((data as any).message) : `Patches could not be loaded (${res.status}).`);
            setLoading(false);
            return null;
        }

        setLoadError(null);
        setLastScanError(data?.lastScan?.status === "failed" ? data.lastScan.error || "The scan failed." : null);

        const patches = Array.isArray(data?.patches) ? data!.patches : [];
        setLastScanAt(data?.lastScanAt ?? null);
        setInfo({
            supported: data?.supported !== false,
            reason: data?.unsupportedReason ?? null,
            packageManager: data?.packageManager ?? null,
            skipped: Array.isArray(data?.skipped) ? data!.skipped! : [],
            rebootRequired: data?.rebootRequired ?? null,
            rebootReason: data?.rebootReason ?? null,
        });

        const mapped: PatchRow[] = patches
            .map((p) => ({
                id: String(p.id ?? ""),
                title: String(p.title ?? ""),
                severity: p.severity != null ? String(p.severity) : null,
                requiresReboot: !!p.requiresReboot,
                kbIds: Array.isArray(p.kbIds) ? p.kbIds.map((x) => String(x)) : [],
                status: normalizeStatus((p as any).status),
                ...(typeof p.security === "boolean" ? { security: p.security } : {}),
                current: p.current ?? null,
                available: p.available ?? null,
            }))
            .filter((p) => !!p.id);

        setRows(mapped);
        setLoading(false);
        return data;
    }, [deviceId]);

    const loadHistory = React.useCallback(async () => {
        setHistoryLoading(true);

        const { res, data } = await api<HistoryResp>(
            `/api/patches/history?deviceId=${encodeURIComponent(deviceId)}&limit=200`,
            { method: "GET" }
        );

        if (!res.ok) {
            setHistory([]);
            setHistoryLoading(false);
            return;
        }

        const items = Array.isArray(data?.items) ? data!.items : [];
        setHistory(items);
        setHistoryLoading(false);
    }, [deviceId]);

    const refreshAll = React.useCallback(async () => {
        await Promise.all([loadLatest(), loadHistory()]);
    }, [loadLatest, loadHistory]);

    React.useEffect(() => {
        void refreshAll();
    }, [refreshAll]);

    // Scans take minutes and installs can take much longer, so the page follows them to the end.
    const follow = React.useCallback(
        async (kind: "scan" | "install") => {
            setWatching(kind);
            const deadline = Date.now() + (kind === "scan" ? SCAN_WATCH_MS : INSTALL_WATCH_MS);

            while (aliveRef.current && Date.now() < deadline) {
                await new Promise((r) => setTimeout(r, POLL_MS));
                if (!aliveRef.current) return;

                const [latest] = await Promise.all([loadLatest(), loadHistory()]);
                if (!latest) continue;

                const pending = kind === "scan" ? latest.scanPending : latest.installPending;
                if (pending) continue;

                setWatching(null);
                if (kind === "scan") {
                    if (latest.lastScan?.status !== "failed") setMsg({ kind: "success", text: "Scan finished." });
                    else setMsg(null);
                } else {
                    setMsg({ kind: "info", text: "Install finished. Patch History below shows the result." });
                }
                return;
            }

            setWatching(null);
            if (aliveRef.current) {
                setMsg({
                    kind: "info",
                    text: "This has not finished yet. The device may be offline, or the update tool may still be working. Use Refresh to check again later.",
                });
            }
        },
        [loadHistory, loadLatest]
    );

    const scan = React.useCallback(async () => {
        setBusyScan(true);
        setMsg(null);

        const { res, data } = await api<any>(`/api/patches/scan`, {
            method: "POST",
            body: JSON.stringify({ deviceId, includeOptional: false }),
        });

        if (!res.ok) {
            setMsg({ kind: "error", text: data?.message ? String(data.message) : `The scan could not be started (${res.status}).` });
            setBusyScan(false);
            return;
        }

        setMsg({ kind: "info", text: "Scanning. This usually takes a few minutes." });
        setBusyScan(false);
        void follow("scan");
    }, [deviceId, follow]);

    const installOne = React.useCallback(
        async (id: string) => {
            setBusyInstallId(id);
            setMsg(null);

            const { res, data } = await api<any>(`/api/patches/install`, {
                method: "POST",
                body: JSON.stringify({ deviceId, includeOptional: false, ids: [id] }),
            });

            if (!res.ok) {
                setMsg({ kind: "error", text: data?.message ? String(data.message) : `The install could not be started (${res.status}).` });
                setBusyInstallId(null);
                return;
            }

            setMsg({ kind: "info", text: "Installing. This can take a long time, and you can leave this page while it runs." });
            setBusyInstallId(null);
            void follow("install");
        },
        [deviceId, follow]
    );

    // Linux: install every security update, or every update, whatever the device offers when the task runs.
    const installBulk = React.useCallback(
        async (mode: "security" | "all") => {
            setBusyBulk(mode);
            setMsg(null);
            const { res, data } = await api<any>(`/api/patches/install`, {
                method: "POST",
                body: JSON.stringify({ deviceId, includeOptional: false, mode }),
            });
            setBusyBulk(null);
            if (!res.ok) {
                setMsg({ kind: "error", text: data?.message ? String(data.message) : `The install could not be started (${res.status}).` });
                return;
            }
            setMsg({ kind: "info", text: "Installing. This can take a long time, and you can leave this page while it runs." });
            void follow("install");
        },
        [deviceId, follow]
    );

    // Build a lookup from latest scan results: KB -> { version/build, title }
    const kbVersionMap = React.useMemo(() => {
        const map = new Map<string, { version: string | null; title: string }>();

        for (const p of rows ?? []) {
            const version = extractBuildFromTitle(p.title);
            for (const kb of p.kbIds ?? []) {
                const k = normalizeKb(kb);
                if (!map.has(k)) map.set(k, { version, title: p.title });
            }
        }

        return map;
    }, [rows]);

    const columns: ColumnDef<PatchRow>[] = React.useMemo(() => {
        return [
            {
                accessorKey: "title",
                header: ({ column }) => <SortHeader column={column} label="Update" />,
                cell: ({ row }) => {
                    const r = row.original;
                    return (
                        <div className="min-w-0">
                            <div className="truncate font-medium">{r.title}</div>
                            {r.available ? (
                                <div className="truncate text-xs text-muted-foreground">
                                    {r.id}: {r.current ? `${r.current} → ` : "new "}{r.available}
                                </div>
                            ) : null}
                            {r.kbIds?.length ? (
                                <div className="truncate text-xs text-muted-foreground">{r.kbIds.join(", ")}</div>
                            ) : null}
                        </div>
                    );
                },
            },
            {
                accessorKey: "severity",
                header: ({ column }) => <SortHeader column={column} label="Severity" />,
                cell: ({ row }) => {
                    const s = row.original.severity;
                    if (row.original.security === true) {
                        return <span className="text-sm font-medium text-foreground">Security{s && s !== "Important" ? ` (${s})` : ""}</span>;
                    }
                    if (row.original.security === false) return <span className="text-sm text-muted-foreground">Other</span>;
                    return <span className="text-sm text-muted-foreground">{s ? String(s) : "—"}</span>;
                },
                meta: { headerClassName: "w-[140px]", cellClassName: "w-[140px]" },
            },
            {
                accessorKey: "requiresReboot",
                header: ({ column }) => <SortHeader column={column} label="Reboot" />,
                cell: ({ row }) => (
                    <span className="text-sm text-muted-foreground">{row.original.requiresReboot ? "Yes" : "No"}</span>
                ),
                meta: { headerClassName: "w-[110px]", cellClassName: "w-[110px]" },
            },
            {
                accessorKey: "status",
                header: ({ column }) => <SortHeader column={column} label="Status" />,
                cell: ({ row }) => <StatusPill status={row.original.status} />,
                meta: { headerClassName: "w-[140px]", cellClassName: "w-[140px]" },
            },
            {
                id: "actions",
                header: () => <span className="sr-only">Actions</span>,
                cell: ({ row }) => {
                    const r = row.original;
                    const canInstall = r.status === "Required";
                    return (
                        <div className="flex justify-end">
                            <Button
                                size="sm"
                                variant={canInstall ? "default" : "outline"}
                                disabled={!canInstall || busyInstallId === r.id}
                                onClick={() => installOne(r.id)}
                                className="gap-2"
                                title={canInstall ? "Install this update" : "Nothing to install"}
                            >
                                <Download className="h-4 w-4" />
                                {busyInstallId === r.id ? "Installing…" : "Install"}
                            </Button>
                        </div>
                    );
                },
                meta: { headerClassName: "w-[140px]", cellClassName: "w-[140px]" },
            },
        ];
    }, [busyInstallId, installOne]);

    if (info && !info.supported) {
        return (
            <Card>
                <CardHeader>
                    <CardTitle>Patch Management</CardTitle>
                </CardHeader>
                <CardContent className="text-sm text-muted-foreground">{info.reason}</CardContent>
            </Card>
        );
    }

    return (
        <div className="space-y-4">
            <Card>
                <CardHeader className="pb-3">
                    <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                            <CardTitle className="truncate">Patch Management</CardTitle>
                            <div className="text-sm text-muted-foreground">
                                Last scan: <span className="text-foreground">{fmtDt(lastScanAt)}</span>
                            </div>
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={refreshAll}
                                className="gap-2"
                                disabled={loading || historyLoading}
                            >
                                <RefreshCw className="h-4 w-4" />
                                Refresh
                            </Button>
                            <Button variant="default" size="sm" onClick={scan} className="gap-2" disabled={busyScan || watching === "scan"}>
                                <ShieldCheck className="h-4 w-4" />
                                {busyScan || watching === "scan" ? "Scanning…" : "Scan Now"}
                            </Button>
                            {isLinux ? (
                                <>
                                    <Button variant="outline" size="sm" onClick={() => installBulk("security")} className="gap-2" disabled={busyBulk !== null || watching === "install"}>
                                        <Download className="h-4 w-4" />
                                        Install security updates
                                    </Button>
                                    <Button variant="outline" size="sm" onClick={() => installBulk("all")} className="gap-2" disabled={busyBulk !== null || watching === "install"}>
                                        <Download className="h-4 w-4" />
                                        Install all
                                    </Button>
                                </>
                            ) : null}
                        </div>
                    </div>

                    {msg ? (
                        <div
                            className={[
                                "mt-3 rounded-md border px-3 py-2 text-sm",
                                msg.kind === "success"
                                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                                    : msg.kind === "error"
                                        ? "border-destructive/40 bg-destructive/10 text-destructive"
                                        : "border-border bg-muted/40 text-foreground",
                            ].join(" ")}
                            role="status"
                        >
                            {msg.text}
                        </div>
                    ) : null}

                    {info?.rebootRequired ? (
                        <div className="mt-3 rounded-md border bg-muted/40 px-3 py-2 text-sm text-foreground">
                            This device needs a restart to finish installing updates{info.rebootReason ? ` (${info.rebootReason})` : ""}.
                        </div>
                    ) : null}

                    {info?.packageManager || (info?.skipped?.length ?? 0) > 0 ? (
                        <div className="mt-3 text-sm text-muted-foreground">
                            {info?.packageManager ? <>Package manager: <span className="text-foreground">{info.packageManager}</span>. </> : null}
                            {(info?.skipped?.length ?? 0) > 0 ? (
                                <>Not offered right now: {info!.skipped.slice(0, 12).map((k) => `${k.id} (${k.reason})`).join(", ")}{info!.skipped.length > 12 ? `, and ${info!.skipped.length - 12} more` : ""}.</>
                            ) : null}
                        </div>
                    ) : null}

                    {loadError ? (
                        <div className="mt-3 rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">{loadError}</div>
                    ) : null}

                    {lastScanError && watching !== "scan" ? (
                        <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                            The last scan failed, so this list may be out of date: {lastScanError}
                        </div>
                    ) : null}
                </CardHeader>

                <CardContent className="pt-0">
                    <DataTable
                        columns={columns}
                        data={rows}
                        sorting={sorting}
                        setSorting={setSorting}
                        columnFilters={columnFilters}
                        setColumnFilters={setColumnFilters}
                        columnVisibility={columnVisibility}
                        setColumnVisibility={setColumnVisibility}
                        filterColumn="title"
                        filterInputPlaceholder="Filter updates…"
                        compact
                    />
                </CardContent>
            </Card>

            <Card>
                <CardHeader className="pb-3">
                    <div className="flex items-center justify-between gap-3">
                        <CardTitle className="truncate">Patch History</CardTitle>
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={loadHistory}
                            className="gap-2"
                            disabled={historyLoading}
                        >
                            <RefreshCw className="h-4 w-4" />
                            Refresh
                        </Button>
                    </div>
                    <div className="text-sm text-muted-foreground">
                        What was installed on this device, when, and by whom.
                    </div>
                </CardHeader>

                <CardContent className="pt-0">
                    {historyLoading ? (
                        <div className="py-6 text-sm text-muted-foreground">Loading…</div>
                    ) : history.length === 0 ? (
                        <EmptyState>No patch install history yet.</EmptyState>
                    ) : (
                        <>
                            <div className="overflow-x-auto rounded-xl border border-border/70 bg-card">
                                <table className="w-full min-w-[640px] text-sm">
                                    <thead className="border-b border-border/70">
                                        <tr>
                                            <th className="px-5 py-3 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">When</th>
                                            <th className="px-5 py-3 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Status</th>
                                            <th className="px-5 py-3 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">By</th>
                                            <th className="px-5 py-3 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Installed</th>
                                            <th className="px-5 py-3 text-right text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Reboot</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-border/60">
                                        {paged.rows.map((h) => {
                                    const when = h.finishedAt ?? h.startedAt;
                                    const installed = Array.isArray(h.installed) ? h.installed : [];
                                    const succeeded = String(h.status ?? "").trim().toLowerCase() === "succeeded";

                                    return (
                                        <tr key={h.runId} className="hover:bg-accent">
                                            <td className="px-5 py-4 text-sm text-muted-foreground">{fmtDt(when)}</td>
                                            <td className="px-5 py-4 text-sm">
                                                <HistoryStatusPill status={h.status} />
                                            </td>
                                            <td className="px-5 py-4 text-sm text-muted-foreground">
                                                <span title={h.createdByName ?? h.createdBy ?? "System"}>{whoLabel(h)}</span>
                                            </td>

                                            <td className="px-5 py-4 text-sm">
                                                {installed.length ? (
                                                    succeeded ? (
                                                        <div className="space-y-1">
                                                            {installed.map((kbRaw, idx) => {
                                                                const kb = normalizeKb(kbRaw);
                                                                const meta = kbVersionMap.get(kb);
                                                                const version = meta?.version ?? null;

                                                                return (
                                                                    <div key={`${kb}-${idx}`} className="truncate" title={kb}>
                                                                        <a
                                                                            href={kbToMicrosoftSupportUrl(kb)}
                                                                            target="_blank"
                                                                            rel="noopener noreferrer"
                                                                            className="underline underline-offset-2 hover:opacity-80"
                                                                            title="Open Microsoft Support"
                                                                        >
                                                                            {kb}
                                                                        </a>
                                                                        {version ? (
                                                                            <span className="text-muted-foreground">{" — "}{version}</span>
                                                                        ) : null}
                                                                    </div>
                                                                );
                                                            })}
                                                        </div>
                                                    ) : (
                                                        <div className="truncate" title={installed.join(", ")}>
                                                            {installed.join(", ")}
                                                        </div>
                                                    )
                                                ) : (
                                                    <span className="text-muted-foreground" title={h.error ?? undefined}>{h.error || "—"}</span>
                                                )}
                                            </td>

                                            <td className="px-5 py-4 text-right text-sm text-muted-foreground">
                                                {h.requiresReboot === null ? "—" : h.requiresReboot ? "Yes" : "No"}
                                            </td>
                                        </tr>
                                    );
                                })}
                                    </tbody>
                                </table>
                            </div>
                            <Pager paged={paged} noun="installs" className="pt-3" />
                        </>
                    )}
                </CardContent>
            </Card>
        </div>
    );
}
