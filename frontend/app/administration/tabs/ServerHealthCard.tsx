"use client";

// Health of the ADG RMM servers themselves: database, disk, memory, the job queue, backups and the monthly restore test.
// It is checked every minute on the server and the Owner is told (email / Slack / webhook as set for backups) when something changes state.
import * as React from "react";
import { DatabaseBackup } from "lucide-react";
import { Button } from "@/components/ui/button";
import { jfetch } from "@/lib/api";
import { Panel, Pill, messageOf } from "../platform-common";
import type { ToastFn } from "../types";

type Status = "ok" | "warn" | "critical";
type Health = {
    overall: Status; checkedAt: string;
    checks: Array<{ key: string; title: string; status: Status; detail: string; since: string | null }>;
    events: Array<{ check: string; from: Status | null; to: Status; detail: string; at: string }>;
    remoteSessions?: { days: number; sessions: number; relayed: number; relayGigabytes: number; freeAllowanceGigabytes: number };
    restores: Array<{ id: string; status: string; requestedAt: string; finishedAt: string | null; error: string | null; verification: Record<string, unknown> }>;
};

const tone = (s: Status) => (s === "ok" ? "good" : s === "warn" ? "warn" : "bad") as "good" | "warn" | "bad";
const word = (s: Status) => (s === "ok" ? "OK" : s === "warn" ? "Warning" : "Critical");

export default function ServerHealthCard({ push }: { push: ToastFn }) {
    const [h, setH] = React.useState<Health | null>(null);
    const [busy, setBusy] = React.useState(false);

    const load = React.useCallback(async () => {
        try { setH(await jfetch<Health>("/api/admin/system-health")); }
        catch (e) { push({ title: "Could not read the server health", desc: messageOf(e), kind: "destructive" }); }
    }, [push]);
    React.useEffect(() => { void load(); const t = setInterval(() => void load(), 60_000); return () => clearInterval(t); }, [load]);

    const testRestore = async () => {
        setBusy(true);
        try {
            const r = await jfetch<{ started: boolean; reason: string }>("/api/admin/system-health/restore-test", { method: "POST", body: {} });
            push(r.started ? { title: "Restore test started", desc: "The newest backup is being restored into a scratch database. Production is not touched.", kind: "success" } : { title: "No restore test started", desc: r.reason, kind: "destructive" });
            await load();
        } catch (e) { push({ title: "Could not start the restore test", desc: messageOf(e), kind: "destructive" }); }
        finally { setBusy(false); }
    };

    if (!h) return null;
    return (
        <Panel title="Server health">
            <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
                <Pill tone={tone(h.overall)}>{h.overall === "ok" ? "All fine" : h.overall === "warn" ? "Needs a look" : "Needs attention now"}</Pill>
                <span className="text-xs text-muted-foreground">Checked every minute. Last {new Date(h.checkedAt).toLocaleTimeString()}.</span>
                <Button size="sm" variant="outline" className="ml-auto" onClick={() => void testRestore()} disabled={busy}>
                    <DatabaseBackup className="mr-1.5 h-3.5 w-3.5" aria-hidden /> Test restoring the newest backup now
                </Button>
            </div>
            <ul className="grid gap-1.5 text-sm">
                {h.checks.map((c) => (
                    <li key={c.key} className="flex flex-wrap items-baseline gap-2">
                        <Pill tone={tone(c.status)}>{word(c.status)}</Pill>
                        <span className="font-medium">{c.title}</span>
                        <span className="text-muted-foreground">{c.detail}</span>
                    </li>
                ))}
            </ul>
            {h.remoteSessions ? (
                <p className="mt-3 text-sm text-muted-foreground">
                    Remote sessions, last {h.remoteSessions.days} days: {h.remoteSessions.sessions}
                    {h.remoteSessions.sessions ? `, ${Math.round((h.remoteSessions.relayed / h.remoteSessions.sessions) * 100)}% through the relay (${h.remoteSessions.relayGigabytes} GB of the ${h.remoteSessions.freeAllowanceGigabytes} GB a month the relay provider gives free)` : ""}.
                </p>
            ) : null}
            {h.restores.length ? (
                <details className="mt-3 text-sm">
                    <summary className="cursor-pointer text-muted-foreground">Restore tests ({h.restores.length})</summary>
                    <ul className="mt-2 grid gap-1">
                        {h.restores.map((r) => (
                            <li key={r.id} className="flex flex-wrap gap-2">
                                <Pill tone={r.status === "completed" ? "good" : r.status === "failed" ? "bad" : "warn"}>{r.status}</Pill>
                                <span>{new Date(r.requestedAt).toLocaleString()}</span>
                                {r.error ? <span className="text-destructive">{r.error}</span> : null}
                            </li>
                        ))}
                    </ul>
                </details>
            ) : null}
            {h.events.length ? (
                <details className="mt-2 text-sm">
                    <summary className="cursor-pointer text-muted-foreground">Recent changes ({h.events.length})</summary>
                    <ul className="mt-2 grid gap-1">
                        {h.events.map((e, i) => (
                            <li key={i} className="flex flex-wrap gap-2">
                                <span className="text-xs text-muted-foreground">{new Date(e.at).toLocaleString()}</span>
                                <Pill tone={tone(e.to)}>{word(e.to)}</Pill>
                                <span>{e.check}: {e.detail}</span>
                            </li>
                        ))}
                    </ul>
                </details>
            ) : null}
        </Panel>
    );
}
