// components/run-script-modal.tsx
"use client";

import * as React from "react";
import { Play, Loader2, Info } from "lucide-react";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
    Select,
    SelectTrigger,
    SelectValue,
    SelectContent,
    SelectItem,
} from "@/components/ui/select";
import { useJobRun } from "@/lib/use-job-run";
import { fetchDevice } from "@/lib/api";
import { ScriptPropertiesHint } from "@/components/script-properties-hint";
import { ScriptSnippetsDialog, insertAtCursor } from "@/components/script-snippets-dialog";
import { deviceFamily, type DeviceFamily } from "@/lib/device-os";
import { namesText, runBulk } from "@/lib/bulk-api";
import BatchDetail from "@/components/bulk/batch-detail";


type Props = {
    open: boolean;
    onOpenChange: (v: boolean) => void;
    /** Explicit single target device */
    deviceId?: string;
    /** Devices chosen in the device list. One runs like a single device; several run through a bulk batch, one job per device. */
    preselectDeviceIds?: string[];
    /** Their names, in the same order, for the list shown above the script. */
    preselectNames?: string[];
};

export default function RunScriptModal({
    open,
    onOpenChange,
    deviceId,
    preselectDeviceIds,
    preselectNames,
}: Props) {
    const [script, setScript] = React.useState<string>("");
    const [snippetsOpen, setSnippetsOpen] = React.useState(false);
    const [shell, setShell] = React.useState<"powershell" | "bash" | "cmd">("powershell");
    const [timeoutSec, setTimeoutSec] = React.useState<number>(120);

    // Choose a target device: explicit deviceId wins, else first preselected.
    const targetDeviceId = React.useMemo(
        () => deviceId ?? preselectDeviceIds?.[0],
        [deviceId, preselectDeviceIds]
    );

    const { jobId, status, log, progress, error, subscribed, start, reset } = useJobRun();

    // Several devices: one bulk batch, one job per device, followed in the batch view.
    const multiIds = React.useMemo(() => (deviceId ? [] : [...new Set(preselectDeviceIds ?? [])]), [deviceId, preselectDeviceIds]);
    const multi = multiIds.length > 1;
    const [batchId, setBatchId] = React.useState<string | null>(null);
    const [bulkBusy, setBulkBusy] = React.useState(false);
    const [bulkError, setBulkError] = React.useState<string | null>(null);

    // Each agent only runs its own shells, so only those are offered.
    const [family, setFamily] = React.useState<DeviceFamily>(null);
    React.useEffect(() => {
        if (!open || !targetDeviceId || multi) {
            setFamily(null);
            return;
        }
        let alive = true;
        fetchDevice(targetDeviceId)
            .then((d) => {
                if (!alive) return;
                const found = deviceFamily(d.os);
                setFamily(found);
                setShell(found === "linux" ? "bash" : "powershell");
            })
            .catch(() => { /* every shell stays available, and the server rejects a wrong one with a reason */ });
        return () => {
            alive = false;
        };
    }, [open, targetDeviceId, multi]);
    const busy = status === "queued" || status === "running" || bulkBusy;
    const canSubmit = Boolean(targetDeviceId && script.trim().length > 0 && shell) && !batchId;

    async function onSubmit() {
        if (!canSubmit) return;
        if (multi) {
            setBulkBusy(true);
            setBulkError(null);
            try {
                const r = await runBulk("run-script", { deviceIds: multiIds, script, shell, timeoutSec });
                setBatchId(r.batchId);
            } catch (e: any) {
                setBulkError(e?.message || "The script could not be started.");
            } finally {
                setBulkBusy(false);
            }
            return;
        }
        await start({ deviceId: targetDeviceId!, script, shell, timeoutSec });
    }

    // Clear form when modal fully closes
    React.useEffect(() => {
        if (!open) {
            setScript("");
            setShell("powershell");
            setTimeoutSec(120);
            setBatchId(null);
            setBulkError(null);
            reset();
        }
    }, [open, reset]);


    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-2xl">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <Play className="h-4 w-4" />
                        Run Script
                    </DialogTitle>
                    <DialogDescription>
                        {multi ? `Send a one-off script to ${multiIds.length} devices. Each device runs it on its own and answers here; devices it does not fit are skipped with a reason.` : "Send a one-off script to a device. Its output appears here when it finishes. You can close this window while it runs."}
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-3">
                    {multi && !batchId && (
                        <div className="flex items-start gap-2 rounded border p-2 text-xs bg-muted/30">
                            <Info className="mt-0.5 h-4 w-4 shrink-0" />
                            <div>
                                <div className="font-medium">{multiIds.length} devices selected</div>
                                <div>{preselectNames?.length ? namesText(preselectNames.map((n, i) => ({ id: String(i), name: n }))) : ""}. A script is arbitrary code: check it before running it on this many devices.</div>
                            </div>
                        </div>
                    )}

                    <div className="grid grid-cols-3 gap-3">
                        <div className="col-span-1">
                            <label className="text-xs text-muted-foreground">Shell</label>
                            <Select value={shell} onValueChange={(v) => setShell(v as any)}>
                                <SelectTrigger>
                                    <SelectValue placeholder="Select shell" />
                                </SelectTrigger>
                                <SelectContent>
                                    {family !== "linux" ? <SelectItem value="powershell">PowerShell</SelectItem> : null}
                                    {family !== "windows" ? <SelectItem value="bash">Bash</SelectItem> : null}
                                    {family !== "linux" ? <SelectItem value="cmd">CMD</SelectItem> : null}
                                </SelectContent>
                            </Select>
                        </div>
                        <div className="col-span-2">
                            <label className="text-xs text-muted-foreground">Timeout (seconds)</label>
                            <input
                                type="number"
                                min={10}
                                max={3600}
                                value={timeoutSec}
                                onChange={(e) =>
                                    setTimeoutSec(Math.max(10, Math.min(3600, Number(e.target.value || 0))))
                                }
                                className="w-full border rounded px-2 py-1 text-sm"
                            />
                        </div>
                    </div>

                    <div>
                        <label className="text-xs text-muted-foreground">Target device</label>
                        <div className="text-xs rounded border bg-muted/30 px-2 py-1">
                            {multi ? `${multiIds.length} devices` : targetDeviceId ?? "— none selected —"}
                        </div>
                    </div>

                    <div>
                        <div className="flex items-center justify-between">
                            <label htmlFor="run-script-body" className="text-xs text-muted-foreground">Script</label>
                            <button type="button" className="rounded border px-2 py-0.5 text-xs hover:bg-accent" onClick={() => setSnippetsOpen(true)}>Snippets</button>
                        </div>
                        <ScriptSnippetsDialog
                            open={snippetsOpen}
                            onOpenChange={setSnippetsOpen}
                            language={shell}
                            draft={script}
                            onInsert={(code) => setScript((cur) => insertAtCursor("run-script-body", cur, code))}
                        />
                        <Textarea
                            id="run-script-body"
                            value={script}
                            onChange={(e) => setScript(e.target.value)}
                            rows={8}
                            placeholder={
                                shell === "powershell"
                                    ? "Write PowerShell here..."
                                    : shell === "bash"
                                        ? "Write Bash here..."
                                        : "Write CMD here..."
                            }
                        />
                        <div className="mt-2"><ScriptPropertiesHint /></div>
                    </div>

                    <div className="flex items-center justify-between">
                        <div className="text-xs text-muted-foreground">
                            {multi ? (batchId ? "Sent" : "Ready") : jobId ? `Job: ${jobId}` : subscribed ? "Ready" : "Connecting…"}
                        </div>
                        <div className="flex items-center gap-2">
                            <Button variant="outline" onClick={() => onOpenChange(false)}>
                                Close
                            </Button>
                            <Button onClick={onSubmit} disabled={!canSubmit || busy} className="gap-2">
                                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                                {busy ? (bulkBusy ? "Sending…" : status === "queued" ? "Queued…" : `Running… ${progress}%`) : multi ? `Run on ${multiIds.length} devices` : "Run"}
                            </Button>
                        </div>
                    </div>

                    {multi ? (
                        <>
                            {bulkError ? <p role="alert" className="text-sm text-destructive">{bulkError}</p> : null}
                            {batchId ? <BatchDetail batchId={batchId} /> : <p className="text-xs text-muted-foreground">Each device&apos;s result appears here after you run it.</p>}
                        </>
                    ) : (
                    <div className="border rounded p-2 bg-muted/30 h-48 overflow-auto font-mono text-xs whitespace-pre-wrap">
                        {[log, error ? `Error: ${error}` : ""].filter(Boolean).join("\n\n") ||
                            (status === "queued"
                                ? "Waiting for the device to pick this up. If it is offline, the script runs when it reconnects within the next hour."
                                : "Output will appear here…")}
                    </div>
                    )}
                </div>
            </DialogContent>
        </Dialog>
    );
}
