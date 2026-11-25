"use client";

// Database migrations: the changes to the database's structure that have been applied, and whether any is waiting or failed.
// Read-only. Migrations are applied when the server is installed or upgraded, not from here.
import * as React from "react";
import { DatabaseZap, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { jfetch } from "@/lib/api";
import { Header, Panel, Pill, messageOf } from "../platform-common";
import type { ToastFn } from "../types";

type Row = { name: string; startedAt: string; appliedAt: string | null; appliedSteps: number; state: "applied" | "failed" | "rolled_back"; error?: string };
type Migrations = {
    generatedAt: string;
    folderFound: boolean;
    summary: { applied: number; pending: number | null; failed: number; latest: string | null };
    pending: string[] | null;
    failed: string[];
    items: Row[];
};

const label = (name: string) => name.replace(/^\d{14}_/, "").replace(/_/g, " ");
const when = (name: string) => {
    const m = name.match(/^(\d{4})(\d{2})(\d{2})/);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : "";
};

export default function MigrationsTab({ push }: { push: ToastFn }) {
    const [data, setData] = React.useState<Migrations | null>(null);
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);

    const load = React.useCallback(async () => {
        setBusy(true);
        try {
            setData(await jfetch<Migrations>("/api/admin/migrations"));
            setError(null);
        } catch (e) {
            setError(messageOf(e));
            push({ title: "Could not load the migrations", desc: messageOf(e), kind: "destructive" });
        } finally {
            setBusy(false);
        }
    }, [push]);
    React.useEffect(() => { void load(); }, [load]);

    return (
        <div className="grid w-full min-w-0 gap-6">
            <Header icon={<DatabaseZap className="h-5 w-5" aria-hidden />} title="Database migrations">
                The changes to the database&apos;s structure that have been applied, read from the database&apos;s own record. They are applied when the server is installed or upgraded; nothing can be run from here.
            </Header>
            <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" onClick={() => void load()} disabled={busy}>
                    <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} aria-hidden /> Refresh
                </Button>
            </div>
            {error ? <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</div> : null}
            {!data && !error ? <div className="p-4 text-sm text-muted-foreground">Loading…</div> : null}
            {data ? (
                <>
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                        <Pill tone="good">{data.summary.applied} applied</Pill>
                        {data.summary.pending === null ? <Pill tone="neutral">Waiting migrations unknown: this install has no migration folder to compare with</Pill> : data.summary.pending > 0 ? <Pill tone="warn">{data.summary.pending} waiting to be applied</Pill> : <Pill tone="good">None waiting</Pill>}
                        {data.summary.failed > 0 ? <Pill tone="bad">{data.summary.failed} failed</Pill> : <Pill tone="good">None failed</Pill>}
                        {data.summary.latest ? <span className="text-xs text-muted-foreground">Latest: {label(data.summary.latest)} ({when(data.summary.latest)})</span> : null}
                    </div>

                    {data.failed.length ? (
                        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                            <p className="font-medium">A migration did not finish. The server may not work correctly until it is resolved.</p>
                            <ul className="mt-1 list-disc pl-5">
                                {data.failed.map((n) => {
                                    const err = data.items.find((i) => i.name === n && i.error)?.error;
                                    return <li key={n}><code>{n}</code>{err ? <span>: {err}</span> : null}</li>;
                                })}
                            </ul>
                            <p className="mt-1">Contact whoever installed the server. Running <code>prisma migrate status</code> on it gives the details.</p>
                        </div>
                    ) : null}
                    {data.pending && data.pending.length ? (
                        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
                            <p className="font-medium">These are in the server&apos;s files but not yet applied to the database:</p>
                            <ul className="mt-1 list-disc pl-5">{data.pending.map((n) => <li key={n}><code>{n}</code></li>)}</ul>
                            <p className="mt-1">They are applied by the next upgrade or by running the migration step of the install.</p>
                        </div>
                    ) : null}

                    <Panel title="Newest first">
                        <div className="max-h-[32rem] overflow-auto">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="border-b text-left text-xs text-muted-foreground">
                                        <th className="py-1.5 pr-3 font-medium">Name</th>
                                        <th className="py-1.5 pr-3 font-medium">Applied</th>
                                        <th className="py-1.5 font-medium">State</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y">
                                    {data.items.map((m) => (
                                        <tr key={`${m.name}-${m.startedAt}`}>
                                            <td className="py-1.5 pr-3 font-mono text-xs">{m.name}</td>
                                            <td className="py-1.5 pr-3 whitespace-nowrap">{m.appliedAt ? new Date(m.appliedAt).toLocaleString() : "not finished"}</td>
                                            <td className="py-1.5"><Pill tone={m.state === "applied" ? "good" : m.state === "failed" ? "bad" : "warn"}>{m.state === "applied" ? "Applied" : m.state === "failed" ? "Failed" : "Rolled back"}</Pill></td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </Panel>
                </>
            ) : null}
        </div>
    );
}
