"use client";

// How every device in one bulk batch is going: what the server decided for it (queued, done, skipped, failed, and why),
// and, for devices that were given a job or task, how that is going now. Refreshes itself until nothing is waiting or running.
import * as React from "react";
import Link from "next/link";
import { fetchBatch, fetchBatchOutput, type BatchDetailData } from "@/lib/bulk-api";
import { errorText, Pill } from "@/components/policies/shared";
import { Button } from "@/components/ui/button";

const REFRESH_MS = 3000;

function itemTone(i: BatchDetailData["items"][number]): "good" | "bad" | "warn" | "muted" {
    if (i.status === "failed") return "bad";
    if (i.status === "skipped") return "muted";
    if (i.live) return i.live.state === "done" ? "good" : i.live.state === "failed" || i.live.state === "timeout" ? "bad" : i.live.state === "cancelled" ? "muted" : "warn";
    return "good";
}

function itemText(i: BatchDetailData["items"][number]): string {
    if (i.status === "failed") return "Failed";
    if (i.status === "skipped") return "Skipped";
    if (i.live) return i.live.text;
    return "Done";
}

function Output({ batchId, itemId }: { batchId: string; itemId: string }) {
    const [out, setOut] = React.useState<{ exitCode: number | null; stdout: string; stderr: string } | null>(null);
    const [err, setErr] = React.useState<string | null>(null);
    React.useEffect(() => {
        let alive = true;
        fetchBatchOutput(batchId, itemId).then((r) => alive && setOut(r)).catch((e) => alive && setErr(errorText(e)));
        return () => { alive = false; };
    }, [batchId, itemId]);
    if (err) return <p className="text-xs text-destructive">{err}</p>;
    if (!out) return <p className="text-xs text-muted-foreground">Loading…</p>;
    const text = [out.stdout, out.stderr ? `[errors]\n${out.stderr}` : ""].filter(Boolean).join("\n");
    return (
        <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded border bg-muted/30 p-2 font-mono text-xs" data-testid="batch-output">
            {text || "(no output)"}
            {out.exitCode != null && out.exitCode !== 0 ? `\n[exit code ${out.exitCode}]` : ""}
        </pre>
    );
}

export default function BatchDetail({ batchId, onLoaded }: { batchId: string; onLoaded?: (b: BatchDetailData) => void }) {
    const [data, setData] = React.useState<BatchDetailData | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [open, setOpen] = React.useState<string | null>(null);
    const [filter, setFilter] = React.useState<"all" | "problems">("all");
    const cb = React.useRef(onLoaded);
    cb.current = onLoaded;

    React.useEffect(() => {
        let alive = true;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const tick = async () => {
            try {
                const b = await fetchBatch(batchId);
                if (!alive) return;
                setData(b);
                setError(null);
                cb.current?.(b);
                if (b.progress.waiting + b.progress.running > 0) timer = setTimeout(tick, REFRESH_MS);
            } catch (e) {
                if (!alive) return;
                setError(errorText(e));
            }
        };
        setData(null);
        void tick();
        return () => { alive = false; if (timer) clearTimeout(timer); };
    }, [batchId]);

    if (error && !data) return <p role="alert" className="text-sm text-destructive">{error}</p>;
    if (!data) return <p className="text-sm text-muted-foreground">Loading…</p>;

    const problems = data.items.filter((i) => i.status === "failed" || i.status === "skipped" || i.live?.state === "failed" || i.live?.state === "timeout");
    const rows = filter === "problems" ? problems : data.items;
    const active = data.progress.waiting + data.progress.running;

    return (
        <div className="space-y-3" data-testid="batch-detail">
            <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium">{data.summary}</span>
                <span className="text-xs text-muted-foreground">{new Date(data.createdAt).toLocaleString()}{data.by ? ` by ${data.by}` : ""}</span>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-sm">
                <Pill tone="good">{data.succeeded} accepted</Pill>
                <Pill tone={data.skipped ? "warn" : "muted"}>{data.skipped} skipped</Pill>
                <Pill tone={data.failed ? "bad" : "muted"}>{data.failed} failed</Pill>
                {active > 0 ? <span className="text-xs text-muted-foreground">{data.progress.waiting} waiting for the device, {data.progress.running} running, {data.progress.done} finished{data.progress.failed ? `, ${data.progress.failed} did not finish well` : ""}</span> : data.progress.done + data.progress.failed > 0 ? <span className="text-xs text-muted-foreground">{data.progress.done} finished{data.progress.failed ? `, ${data.progress.failed} did not finish well` : ""}</span> : null}
                {problems.length > 0 ? (
                    <Button type="button" variant="ghost" size="sm" className="ml-auto h-7 text-xs" onClick={() => setFilter(filter === "all" ? "problems" : "all")}>
                        {filter === "all" ? `Show only the ${problems.length} with problems` : "Show all"}
                    </Button>
                ) : null}
            </div>
            {error ? <p role="alert" className="text-xs text-destructive">Could not refresh: {error}</p> : null}
            <div className="max-h-[50vh] overflow-auto rounded-md border">
                <ul className="divide-y divide-border/60">
                    {rows.map((i) => (
                        <li key={i.id} className="px-3 py-2 text-sm">
                            <div className="flex flex-wrap items-center gap-2">
                                <Pill tone={itemTone(i)}>{itemText(i)}</Pill>
                                {i.status === "failed" && i.reason === "Device not found." ? <span className="font-medium text-muted-foreground">{i.name}</span> : <Link href={`/devices/${i.deviceId}`} className="font-medium hover:underline">{i.name}</Link>}
                                {i.reason ? <span className="text-xs text-muted-foreground">{i.reason}</span> : null}
                                {i.hasOutput && i.live && ["done", "failed", "timeout"].includes(i.live.state) ? (
                                    <Button type="button" variant="ghost" size="sm" className="ml-auto h-6 px-2 text-xs" onClick={() => setOpen(open === i.id ? null : i.id)}>
                                        {open === i.id ? "Hide output" : "Output"}
                                    </Button>
                                ) : null}
                            </div>
                            {open === i.id ? <div className="mt-2"><Output batchId={data.id} itemId={i.id} /></div> : null}
                        </li>
                    ))}
                    {rows.length === 0 ? <li className="px-3 py-4 text-center text-xs text-muted-foreground">Nothing to show.</li> : null}
                </ul>
            </div>
        </div>
    );
}
