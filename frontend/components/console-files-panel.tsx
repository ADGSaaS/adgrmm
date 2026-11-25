// components/console-files-panel.tsx
"use client";

// The Files side panel of the Remote Console: browse the device, drop files from this computer onto the console to
// upload them to the folder that is open, click a file to download it. It uses the same device file calls, the same
// 50 MB limit and the same permissions as the Files tab, and works only while a session is connected.
import * as React from "react";
import { ArrowUp, ChevronRight, Download, File as FileIcon, Folder, FolderPlus, RefreshCw, Upload, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
    DriveItem,
    FsItem,
    fileMkdir,
    fileWriteWithProgress,
    listDirectory,
    listDrives,
    readFileBase64,
    waitForJob,
} from "@/lib/device-files-api";
import { MAX_TRANSFER_BYTES, baseName, downloadBase64AsFile, fmtBytes, joinPath, sortFs } from "@/lib/file-paths";
import { hasPerm } from "@/lib/permissions";
import { useMe } from "@/lib/use-me";

export type ConsoleFilesHandle = {
    /** Starts uploading these files to the folder that is open. */
    uploadFiles: (files: File[]) => void;
};

type Transfer = {
    id: number;
    kind: "upload" | "download";
    name: string;
    size: number | null;
    state: "reading" | "sending" | "device" | "done" | "error" | "stopped";
    /** 0..1 while the size is known, null when only "working" can be said. */
    progress: number | null;
    message?: string;
    startedAt: number;
};

const LIMIT_TEXT = `Files up to ${Math.round(MAX_TRANSFER_BYTES / (1024 * 1024))} MB each, in either direction. Larger files are not supported yet.`;

function readAsBase64(file: File, onProgress: (loaded: number, total: number) => void, signal: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onprogress = (e) => {
            if (e.lengthComputable) onProgress(e.loaded, e.total);
        };
        reader.onerror = () => reject(new Error("This computer could not read the file."));
        reader.onload = () => {
            const text = String(reader.result ?? "");
            resolve(text.slice(text.indexOf(",") + 1));
        };
        const stop = () => {
            reader.abort();
            reject(new DOMException("Stopped.", "AbortError"));
        };
        if (signal.aborted) return stop();
        signal.addEventListener("abort", stop, { once: true });
        reader.readAsDataURL(file);
    });
}

const isAbort = (e: any) => e?.name === "AbortError";

const ConsoleFilesPanel = React.forwardRef<ConsoleFilesHandle, { deviceId: string; connected: boolean; open: boolean; onClose: () => void }>(function ConsoleFilesPanel(
    { deviceId, connected, open, onClose },
    ref
) {
    const { permissions, loading: meLoading } = useMe();
    const canList = hasPerm(permissions, "devices.read");
    const canTransfer = hasPerm(permissions, ["devices.read", "devices.actions"]);

    const [drives, setDrives] = React.useState<DriveItem[]>([]);
    const [dir, setDir] = React.useState("");
    const [items, setItems] = React.useState<FsItem[]>([]);
    const [loading, setLoading] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const [transfers, setTransfers] = React.useState<Transfer[]>([]);
    const [mkdirOpen, setMkdirOpen] = React.useState(false);
    const [mkdirName, setMkdirName] = React.useState("");
    const fileInput = React.useRef<HTMLInputElement | null>(null);
    const aborts = React.useRef(new Map<number, AbortController>());
    const nextId = React.useRef(1);
    const dirRef = React.useRef("");
    dirRef.current = dir;
    const loadedFor = React.useRef<string | null>(null);
    const pending = React.useRef<File[]>([]);

    const patch = React.useCallback((id: number, p: Partial<Transfer>) => setTransfers((t) => t.map((x) => (x.id === id ? { ...x, ...p } : x))), []);

    const list = React.useCallback(
        async (path: string) => {
            setLoading(true);
            setError(null);
            try {
                const res = await listDirectory(deviceId, path, false);
                setItems(sortFs(res.items ?? []));
                setDir(String(res.path || path));
            } catch (e: any) {
                setError(String(e?.message || "Could not list this folder."));
            } finally {
                setLoading(false);
            }
        },
        [deviceId]
    );

    // Roots are read once the panel is opened with a live session, and again for another device or a new session.
    React.useEffect(() => {
        if (!open || !connected || !canList) return;
        if (loadedFor.current === deviceId && dirRef.current) return;
        loadedFor.current = deviceId;
        let cancelled = false;
        (async () => {
            setLoading(true);
            setError(null);
            try {
                const d = await listDrives(deviceId);
                if (cancelled) return;
                setDrives(d);
                if (!d.length) {
                    setError("The device did not list any drives.");
                    setLoading(false);
                    return;
                }
                await list(d[0].path);
            } catch (e: any) {
                if (!cancelled) {
                    loadedFor.current = null;
                    setError(String(e?.message || "Could not read the device's drives."));
                    setLoading(false);
                }
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [open, connected, canList, deviceId, list]);

    // The session ended: what was in flight is stopped, and the next session starts from the drives again.
    React.useEffect(() => {
        if (connected) return;
        aborts.current.forEach((a) => a.abort());
        pending.current = [];
        loadedFor.current = null;
        setDir("");
        setItems([]);
        setDrives([]);
        setError(null);
    }, [connected]);

    React.useEffect(
        () => () => {
            aborts.current.forEach((a) => a.abort());
        },
        []
    );

    const begin = (t: Omit<Transfer, "id" | "startedAt">) => {
        const id = nextId.current++;
        const ctl = new AbortController();
        aborts.current.set(id, ctl);
        setTransfers((all) => [{ ...t, id, startedAt: Date.now() }, ...all].slice(0, 12));
        return { id, signal: ctl.signal };
    };
    const finishTransfer = (id: number) => aborts.current.delete(id);

    const upload = React.useCallback(
        async (file: File, destDir: string) => {
            if (file.size > MAX_TRANSFER_BYTES) {
                setTransfers((all) => [
                    { id: nextId.current++, kind: "upload" as const, name: file.name, size: file.size, state: "error" as const, progress: null, startedAt: Date.now(), message: `${file.name} is ${fmtBytes(file.size)}, over the ${fmtBytes(MAX_TRANSFER_BYTES)} limit. Nothing was sent.` },
                    ...all,
                ].slice(0, 12));
                return;
            }
            const { id, signal } = begin({ kind: "upload", name: file.name, size: file.size, state: "reading", progress: 0 });
            try {
                const b64 = await readAsBase64(file, (l, t) => patch(id, { progress: (l / t) * 0.2 }), signal);
                patch(id, { state: "sending", progress: 0.2 });
                const job = await fileWriteWithProgress(deviceId, joinPath(destDir, file.name), b64, {
                    signal,
                    onProgress: (sent, total) => patch(id, { progress: 0.2 + (sent / total) * 0.7 }),
                });
                patch(id, { state: "device", progress: 0.9 });
                const done = await waitForJob(job.id, { timeoutMs: 180_000, pollMs: 800, signal });
                if (String(done.status || "").toLowerCase() !== "succeeded") {
                    throw new Error(String(done.stderr || done.stdout || "The device could not save the file.").trim());
                }
                patch(id, { state: "done", progress: 1, message: `Saved to ${destDir}` });
                if (dirRef.current && dirRef.current.toLowerCase() === destDir.toLowerCase()) void list(destDir);
            } catch (e: any) {
                if (isAbort(e)) patch(id, { state: "stopped", message: "Stopped. If the file had reached the device it may still have been saved." });
                else patch(id, { state: "error", message: String(e?.message || "The upload failed.") });
            } finally {
                finishTransfer(id);
            }
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [deviceId, list, patch]
    );

    const uploadFiles = React.useCallback(
        (files: File[]) => {
            if (!connected) return;
            const d = dirRef.current;
            if (!d) {
                // The panel has not opened a folder yet (it was just opened by the drop): they go as soon as one is open.
                pending.current.push(...files);
                setError("Opening the device's folders first. Your files will upload to the first folder that opens.");
                return;
            }
            for (const f of files) void upload(f, d);
        },
        [connected, upload]
    );
    React.useEffect(() => {
        if (!dir || !pending.current.length) return;
        const files = pending.current.splice(0);
        setError(null);
        for (const f of files) void upload(f, dir);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [dir]);
    React.useImperativeHandle(ref, () => ({ uploadFiles }), [uploadFiles]);

    const download = React.useCallback(
        async (item: FsItem) => {
            if (item.size != null && item.size > MAX_TRANSFER_BYTES) {
                setTransfers((all) => [
                    { id: nextId.current++, kind: "download" as const, name: item.name, size: item.size ?? null, state: "error" as const, progress: null, startedAt: Date.now(), message: `${item.name} is ${fmtBytes(item.size)}, over the ${fmtBytes(MAX_TRANSFER_BYTES)} limit.` },
                    ...all,
                ].slice(0, 12));
                return;
            }
            const { id, signal } = begin({ kind: "download", name: item.name, size: item.size ?? null, state: "device", progress: null });
            try {
                const { contentBase64 } = await readFileBase64(deviceId, item.path, MAX_TRANSFER_BYTES, signal);
                if (signal.aborted) throw new DOMException("Stopped.", "AbortError");
                downloadBase64AsFile(contentBase64, item.name || baseName(item.path));
                patch(id, { state: "done", progress: 1, message: "Saved to your downloads." });
            } catch (e: any) {
                if (isAbort(e)) patch(id, { state: "stopped", message: "Stopped." });
                else patch(id, { state: "error", message: String(e?.message || "The download failed.") });
            } finally {
                finishTransfer(id);
            }
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [deviceId, patch]
    );

    const up = () => {
        if (!dir) return;
        const win = dir.includes("\\");
        const sep = win ? "\\" : "/";
        const trimmed = dir.length > 1 ? dir.replace(/[\\/]+$/, "") : dir;
        const idx = trimmed.lastIndexOf(sep);
        if (win) {
            if (idx <= 2) return void (/^[A-Za-z]:\\?$/.test(trimmed) ? null : list(trimmed.slice(0, 2) + "\\"));
            return void list(trimmed.slice(0, idx));
        }
        void list(idx <= 0 ? "/" : trimmed.slice(0, idx));
    };

    const makeFolder = async () => {
        const name = mkdirName.trim();
        if (!name || !dir) return;
        setMkdirOpen(false);
        setMkdirName("");
        try {
            const j = await fileMkdir(deviceId, joinPath(dir, name));
            const done = await waitForJob(j.id, { timeoutMs: 60_000, pollMs: 700 });
            if (String(done.status || "").toLowerCase() !== "succeeded") throw new Error(String(done.stderr || done.stdout || "Could not create the folder."));
            await list(dir);
        } catch (e: any) {
            setError(String(e?.message || "Could not create the folder."));
        }
    };

    const stateText = (t: Transfer) =>
        t.state === "reading" ? "Reading the file…" : t.state === "sending" ? "Sending to the server…" : t.state === "device" ? (t.kind === "upload" ? "Waiting for the device to save it…" : "Waiting for the device to send it…") : t.state === "done" ? "Done" : t.state === "stopped" ? "Stopped" : "Failed";

    const working = (t: Transfer) => t.state === "reading" || t.state === "sending" || t.state === "device";

    if (!open) return null;

    const disabledReason = meLoading
        ? "Checking your permissions…"
        : !connected
        ? "Connect to the device first. Files can be moved only while a session is running."
        : !canList
            ? "You do not have permission to browse this device's files."
            : !canTransfer
                ? "You can browse files but not upload or download them: that needs the right to run device actions."
                : null;

    return (
        <div className="flex h-full min-h-0 flex-col" data-testid="console-files-panel">
            <div className="flex items-center justify-between px-3 py-2">
                <div className="flex items-center gap-2 font-medium">
                    <Folder className="h-4 w-4" />
                    Files
                </div>
                <div className="flex items-center gap-1">
                    <Button type="button" variant="ghost" size="icon" className="h-7 w-7" title="Refresh" disabled={!connected || !dir || loading} onClick={() => dir && void list(dir)}>
                        <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
                    </Button>
                    <Button type="button" variant="ghost" size="icon" className="h-7 w-7" title="Hide files" onClick={onClose}>
                        <X className="h-4 w-4" />
                    </Button>
                </div>
            </div>
            <Separator />

            {disabledReason ? (
                <div className="p-3 text-sm text-muted-foreground" data-testid="files-disabled">{disabledReason}</div>
            ) : (
                <>
                    <div className="space-y-2 p-3">
                        {drives.length > 1 ? (
                            <select
                                className="h-8 w-full rounded-md border bg-background px-2 text-sm"
                                aria-label="Drive"
                                value={drives.find((d) => dir.toLowerCase().startsWith(d.path.replace(/[\\/]+$/, "").toLowerCase()))?.path ?? drives[0].path}
                                onChange={(e) => void list(e.target.value)}
                            >
                                {drives.map((d) => (
                                    <option key={d.path} value={d.path}>{d.name}</option>
                                ))}
                            </select>
                        ) : null}
                        <div className="flex items-center gap-1">
                            <Button type="button" variant="outline" size="icon" className="h-8 w-8 shrink-0" title="Up one folder" onClick={up} disabled={!dir || loading}>
                                <ArrowUp className="h-4 w-4" />
                            </Button>
                            <div className="min-w-0 flex-1 truncate rounded-md border bg-muted/30 px-2 py-1 font-mono text-xs" title={dir}>{dir || "…"}</div>
                        </div>
                        <div className="flex gap-2">
                            <input
                                ref={fileInput}
                                type="file"
                                multiple
                                className="hidden"
                                onChange={(e) => {
                                    const fl = Array.from(e.target.files ?? []);
                                    e.target.value = "";
                                    if (fl.length) uploadFiles(fl);
                                }}
                            />
                            <Button type="button" size="sm" className="flex-1 gap-2" disabled={!dir || !canTransfer} onClick={() => fileInput.current?.click()}>
                                <Upload className="h-4 w-4" />
                                Upload here
                            </Button>
                            <Button type="button" size="sm" variant="outline" className="gap-2" disabled={!dir || !canTransfer} onClick={() => setMkdirOpen((v) => !v)}>
                                <FolderPlus className="h-4 w-4" />
                                New folder
                            </Button>
                        </div>
                        {mkdirOpen ? (
                            <div className="flex gap-2">
                                <Input autoFocus value={mkdirName} onChange={(e) => setMkdirName(e.target.value)} placeholder="Folder name" onKeyDown={(e) => e.key === "Enter" && void makeFolder()} />
                                <Button size="sm" onClick={() => void makeFolder()} disabled={!mkdirName.trim()}>Create</Button>
                            </div>
                        ) : null}
                        <p className="text-[11px] text-muted-foreground">Drop files on the console, or on this panel, to upload them to this folder. {LIMIT_TEXT}</p>
                    </div>
                    {error ? (
                        <div className="mx-3 mb-2 rounded-md border border-red-200 bg-red-50 px-2 py-1.5 text-xs text-red-900" role="alert">{error}</div>
                    ) : null}
                    <Separator />
                    <div className="min-h-[96px] flex-1 overflow-auto" data-testid="files-list">
                        {loading && !items.length ? <div className="p-3 text-sm text-muted-foreground">Loading…</div> : null}
                        {!loading && dir && !items.length && !error ? <div className="p-3 text-sm text-muted-foreground">This folder is empty.</div> : null}
                        <ul>
                            {items.map((it) => (
                                <li key={it.path}>
                                    <button
                                        type="button"
                                        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-muted/50"
                                        onClick={() => (it.isDir ? void list(it.path) : void download(it))}
                                        title={it.isDir ? `Open ${it.name}` : `Download ${it.name}`}
                                        disabled={!it.isDir && !canTransfer}
                                    >
                                        {it.isDir ? <Folder className="h-4 w-4 shrink-0 text-amber-600" /> : <FileIcon className="h-4 w-4 shrink-0 text-muted-foreground" />}
                                        <span className="min-w-0 flex-1 truncate">{it.name}</span>
                                        {it.isDir ? <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" /> : (
                                            <>
                                                <span className="shrink-0 text-xs text-muted-foreground">{fmtBytes(it.size)}</span>
                                                <Download className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                                            </>
                                        )}
                                    </button>
                                </li>
                            ))}
                        </ul>
                    </div>
                </>
            )}

            {transfers.length ? (
                <>
                    <Separator />
                    <div className="max-h-48 shrink-0 space-y-2 overflow-auto p-3" data-testid="files-transfers">
                        <div className="flex items-center justify-between text-xs font-medium">
                            <span>Transfers</span>
                            {transfers.some((t) => !working(t)) ? (
                                <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => setTransfers((all) => all.filter(working))}>Clear finished</button>
                            ) : null}
                        </div>
                        {transfers.map((t) => (
                            <div key={t.id} className="rounded-md border p-2 text-xs" data-state={t.state}>
                                <div className="flex items-center gap-2">
                                    {t.kind === "upload" ? <Upload className="h-3.5 w-3.5 shrink-0" /> : <Download className="h-3.5 w-3.5 shrink-0" />}
                                    <span className="min-w-0 flex-1 truncate font-medium" title={t.name}>{t.name}</span>
                                    {t.size != null ? <span className="shrink-0 text-muted-foreground">{fmtBytes(t.size)}</span> : null}
                                    {working(t) ? (
                                        <button type="button" className="shrink-0 rounded px-1 text-muted-foreground hover:bg-muted hover:text-foreground" onClick={() => aborts.current.get(t.id)?.abort()} title="Cancel" aria-label={`Cancel ${t.name}`}>
                                            <X className="h-3.5 w-3.5" />
                                        </button>
                                    ) : null}
                                </div>
                                {working(t) ? (
                                    <div className="mt-1.5 h-1.5 overflow-hidden rounded bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={t.progress == null ? undefined : Math.round(t.progress * 100)}>
                                        <div className={`h-full rounded bg-primary ${t.progress == null ? "w-1/3 animate-pulse" : ""}`} style={t.progress == null ? undefined : { width: `${Math.max(3, t.progress * 100)}%` }} />
                                    </div>
                                ) : null}
                                <div className={t.state === "error" ? "mt-1 text-red-700" : "mt-1 text-muted-foreground"}>
                                    {t.state === "error" || t.state === "stopped" || t.state === "done" ? t.message ?? stateText(t) : stateText(t)}
                                </div>
                            </div>
                        ))}
                    </div>
                </>
            ) : null}
        </div>
    );
});

export default ConsoleFilesPanel;
