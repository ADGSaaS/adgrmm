"use client";

// System: what this server is running and how it is doing, read live. Read-only; Diagnostics adds a list of what to look at first.
import * as React from "react";
import Link from "next/link";
import { RefreshCw, ServerCog } from "lucide-react";
import { Button } from "@/components/ui/button";
import { jfetch } from "@/lib/api";
import { Header, Panel, Pill, Row, isFailedPart, messageOf, uptime } from "../platform-common";
import type { ToastFn } from "../types";
import ServerHealthCard from "./ServerHealthCard";

type Part<T> = T | { error: string };
type Info = {
    generatedAt: string;
    install: { mode: "docker" | "systemd" | "manual"; description: string };
    app: Part<{ packageVersion: string; commit: string | null; node: string; platform: string; arch: string; nodeEnv: string | null; uptimeSeconds: number; serverTime: string; timezone: string; memoryMb: { rss: number }; systemMemoryMb: { total: number; free: number }; cpus: number; loadAverage: number[] }>;
    database: Part<{ version: string; sizeMb: number; connections: number; migrations: { applied: number; unfinished: string[]; rolledBack: string[]; latest: { name: string; finishedAt: string | null }[] }; approximateRows: Record<string, number> }>;
    disk: Part<{ label: string; totalGb?: number; freeGb?: number; freePercent?: number | null; error?: string }[]>;
    agents: Part<{ total: number; online: number; notSeenForADay: number; packagesOnServer: Record<string, { version: string | null } | null> }>;
};

export default function SystemTab({ push }: { push: ToastFn }) {
    const [info, setInfo] = React.useState<Info | null>(null);
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);

    const load = React.useCallback(async () => {
        setBusy(true);
        try {
            setInfo(await jfetch<Info>("/api/admin/system"));
            setError(null);
        } catch (e) {
            setError(messageOf(e));
            push({ title: "Could not load system details", desc: messageOf(e), kind: "destructive" });
        } finally {
            setBusy(false);
        }
    }, [push]);
    React.useEffect(() => { void load(); }, [load]);

    return (
        <div className="grid w-full min-w-0 gap-6">
            <Header icon={<ServerCog className="h-5 w-5" aria-hidden />} title="System">
                What this server is running, read live. Nothing here can be changed. <Link className="underline" href="/administration?tab=diagnostics">Diagnostics</Link> adds a list of what to look at first and a report to attach to a support request.
            </Header>
            <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" onClick={() => void load()} disabled={busy}>
                    <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} aria-hidden /> Refresh
                </Button>
                {info ? <span className="text-xs text-muted-foreground">Read {new Date(info.generatedAt).toLocaleString()}</span> : null}
            </div>
            <ServerHealthCard push={push} />
            {error ? <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</div> : null}
            {!info && !error ? <div className="p-4 text-sm text-muted-foreground">Loading…</div> : null}
            {info ? (
                <div className="grid gap-3 sm:grid-cols-2">
                    <Panel title="Server">
                        {isFailedPart(info.app) ? <p className="text-sm text-muted-foreground">{info.app.error}</p> : (
                            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm">
                                <Row k="Version" v={`${info.app.packageVersion}${info.app.commit ? ` (build ${info.app.commit})` : ""}`} />
                                <Row k="Running as" v={info.install.description} />
                                <Row k="Mode" v={info.app.nodeEnv ?? "not set"} />
                                <Row k="Up for" v={uptime(info.app.uptimeSeconds)} />
                                <Row k="Node" v={info.app.node} />
                                <Row k="System" v={`${info.app.platform} (${info.app.arch}), ${info.app.cpus} CPU`} />
                                <Row k="Time zone" v={info.app.timezone} />
                                <Row k="Memory" v={`${info.app.memoryMb.rss} MB used by the app; ${info.app.systemMemoryMb.free} of ${info.app.systemMemoryMb.total} MB free on the machine`} />
                                <Row k="Load" v={info.app.loadAverage.join(" / ")} />
                            </dl>
                        )}
                    </Panel>
                    <Panel title="Database">
                        {isFailedPart(info.database) ? <p className="text-sm text-muted-foreground">{info.database.error}</p> : (
                            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm">
                                <Row k="Server" v={info.database.version} />
                                <Row k="Size" v={`${info.database.sizeMb} MB`} />
                                <Row k="Connections" v={String(info.database.connections)} />
                                <Row
                                    k="Migrations"
                                    v={
                                        <span className="flex flex-wrap items-center gap-1.5">
                                            {info.database.migrations.applied} applied
                                            {info.database.migrations.unfinished.length ? <Pill tone="bad">{info.database.migrations.unfinished.length} unfinished</Pill> : null}
                                            <Link className="text-xs underline" href="/administration?tab=migrations">See the list</Link>
                                        </span>
                                    }
                                />
                            </dl>
                        )}
                    </Panel>
                    <Panel title="Disk">
                        {isFailedPart(info.disk) ? <p className="text-sm text-muted-foreground">{info.disk.error}</p> : (
                            <ul className="grid gap-1 text-sm">
                                {info.disk.map((d) => (
                                    <li key={d.label} className="flex flex-wrap items-center gap-2">
                                        <span className="capitalize">{d.label}:</span>
                                        {d.error ? <span className="text-muted-foreground">{d.error}</span> : (
                                            <>
                                                {d.freeGb} of {d.totalGb} GB free
                                                {typeof d.freePercent === "number" ? <Pill tone={d.freePercent < 5 ? "bad" : d.freePercent < 10 ? "warn" : "good"}>{d.freePercent}%</Pill> : null}
                                            </>
                                        )}
                                    </li>
                                ))}
                            </ul>
                        )}
                    </Panel>
                    <Panel title="Agents">
                        {isFailedPart(info.agents) ? <p className="text-sm text-muted-foreground">{info.agents.error}</p> : (
                            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm">
                                <Row k="Online" v={`${info.agents.online} of ${info.agents.total}`} />
                                <Row k="Not seen for a day" v={String(info.agents.notSeenForADay)} />
                                {Object.entries(info.agents.packagesOnServer).map(([os, p]) => (
                                    <Row key={os} k={`${os[0].toUpperCase()}${os.slice(1)} package`} v={p?.version ? `version ${p.version} on this server` : "none on this server"} />
                                ))}
                            </dl>
                        )}
                    </Panel>
                </div>
            ) : null}
        </div>
    );
}
