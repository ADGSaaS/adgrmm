"use client";

// Performance history on a device's Overview: CPU, memory and disk over 24 hours, 7 days or 30 days (from the checks the
// agent already runs), network traffic and disk activity (from agent 1.3.36), and the daily availability strip and
// disk-free trend (from the daily history, up to 800 days).
import * as React from "react";
import { jfetch } from "@/lib/api";
import { useMe } from "@/lib/use-me";
import { hasPerm } from "@/lib/permissions";
import { errorText } from "@/components/policies/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AvailabilityStrip, LineChart, formatRate, type ChartPoint, type ChartSeries, type RateKind } from "@/components/device-charts";

type Pt = { t: string; avg: number; max: number; min: number };
type Stats = { latest: number; average: number; peak: number; low: number } | null;
type Metrics = {
    range: "1h" | "12h" | "24h" | "7d" | "30d";
    from: string;
    to: string;
    bucketMinutes: number;
    retentionDays: number;
    coveredFrom: string | null;
    monitoring: { state: "ok" | "no-agent" | "never-reported" | "stopped"; problem: string | null; agentVersion: string | null; lastResultAt: string | null };
    cpu: { points: Pt[]; stats: Stats };
    memory: { totalGb: number | null; points: Pt[]; stats: Stats };
    disks: Array<{ mount: string; totalGb: number | null; points: Pt[]; stats: Stats }>;
    // missing when the server is older than this page
    network?: IoSeries;
    diskIo?: IoSeries;
};
/** Network traffic or disk activity, in bytes per second: two lines in one graph. */
type IoPt = { t: string } & Record<string, number | string>;
type IoStats = Record<string, { latest: number; average: number; peak: number } | null> | null;
type IoSeries = {
    unit: "bytes/s";
    state: "ok" | "no-agent" | "needs-agent" | "waiting" | "unavailable" | "stopped";
    reason: string | null;
    linkMbps?: number | null;
    points: IoPt[];
    stats: IoStats;
};
type Daily = {
    days: number;
    items: Array<{ day: string; samples: number; availability: number | null; businessAvailability: number | null; diskFreePctMin: number | null; diskFreeGb: number | null; diskTotalGb: number | null }>;
};

const RANGES: Array<{ value: Metrics["range"]; label: string }> = [{ value: "1h", label: "1 hour" }, { value: "12h", label: "12 hours" }, { value: "24h", label: "24 hours" }, { value: "7d", label: "7 days" }, { value: "30d", label: "30 days" }];
const DAY_RANGES = [30, 90, 365, 800];
const toChart = (pts: Pt[]): ChartPoint[] => pts.map((p) => ({ t: Date.parse(p.t), avg: p.avg, max: p.max }));

function Seg<T extends string | number>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: Array<{ value: T; label: string }>; label: string }) {
    return (
        <div role="group" aria-label={label} className="inline-flex rounded-md border p-0.5 text-xs">
            {options.map((o) => (
                <button key={String(o.value)} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)} className={`rounded px-2 py-1 ${o.value === value ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`}>{o.label}</button>
            ))}
        </div>
    );
}

/** A two-line series as chart lines. `scale` turns bytes per second into the unit drawn (8 for bits per second). */
function ioLines(io: IoSeries, keys: [string, string], labels: [string, string], colors: [string, string], scale: number): ChartSeries[] {
    return keys.map((k, i) => ({
        key: k,
        label: labels[i],
        color: colors[i],
        points: io.points.map((p) => ({ t: Date.parse(p.t), avg: Number(p[k]) * scale, max: Number(p[`${k}Max`]) * scale })),
    }));
}

function IoStatLine({ stats, keys, labels, kind, scale }: { stats: IoStats; keys: [string, string]; labels: [string, string]; kind: RateKind; scale: number }) {
    if (!stats) return null;
    return (
        <span className="text-xs text-muted-foreground">
            {keys.map((k, i) => {
                const s = stats[k];
                return s ? <span key={k} className="mr-3 inline-block">{labels[i]}: now {formatRate(s.latest * scale, kind)}, average {formatRate(s.average * scale, kind)}, highest {formatRate(s.peak * scale, kind)}</span> : null;
            })}
        </span>
    );
}

/** What to say instead of a graph when a series is empty. */
function ioMessage(io: IoSeries): string {
    if (io.state === "needs-agent") return "No data yet \u2014 needs agent 1.3.36 or newer, which updates itself.";
    if (io.state === "waiting") return "Waiting for the first measurement \u2014 a rate needs two samples, so it appears a few minutes after the agent starts.";
    return io.reason ?? "No readings in this period.";
}

function IoSection({ title, io, keys, labels, colors, kind, scale, from, to, gapMs, ariaLabel, extra }: {
    title: string; io: IoSeries; keys: [string, string]; labels: [string, string]; colors: [string, string]; kind: RateKind; scale: number;
    from: number; to: number; gapMs: number; ariaLabel: string; extra?: string | null;
}) {
    return (
        <section aria-label={title} className="min-w-0" data-testid={`io-${keys[0]}`}>
            <div className="mb-1 flex flex-wrap items-baseline gap-x-3">
                <h3 className="text-sm font-medium">{title}</h3>
                {io.points.length ? <IoStatLine stats={io.stats} keys={keys} labels={labels} kind={kind} scale={scale} /> : null}
            </div>
            {io.points.length ? (
                <>
                    <LineChart points={[]} series={ioLines(io, keys, labels, colors, scale)} rate={kind} from={from} to={to} gapMs={gapMs} label={ariaLabel} />
                    {extra ? <p className="mt-1 text-xs text-muted-foreground">{extra}</p> : null}
                </>
            ) : (
                <p role="status" className="rounded-md border border-dashed px-3 py-6 text-sm text-muted-foreground" data-testid={`io-empty-${keys[0]}`}>{ioMessage(io)}</p>
            )}
        </section>
    );
}

function StatLine({ stats, unit = "%" }: { stats: Stats; unit?: string }) {
    if (!stats) return null;
    return <span className="text-xs text-muted-foreground">now {stats.latest}{unit}, average {stats.average}{unit}, highest {stats.peak}{unit}, lowest {stats.low}{unit}</span>;
}

export default function DevicePerformance({ deviceId, deviceName }: { deviceId: string; deviceName: string }) {
    const { permissions } = useMe();
    const [range, setRange] = React.useState<Metrics["range"]>("24h");
    const [m, setM] = React.useState<Metrics | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [days, setDays] = React.useState(90);
    const [daily, setDaily] = React.useState<Daily | null>(null);
    const [dailyError, setDailyError] = React.useState<string | null>(null);
    const [adding, setAdding] = React.useState(false);
    const [addNote, setAddNote] = React.useState<string | null>(null);
    const [version, setVersion] = React.useState(0);

    React.useEffect(() => {
        let alive = true;
        const load = () => jfetch<Metrics>(`/api/devices/${encodeURIComponent(deviceId)}/metrics?range=${range}`).then((r) => { if (alive) { setM(r); setError(null); } }).catch((e) => alive && setError(errorText(e)));
        void load();
        const t = setInterval(load, 60_000);
        return () => { alive = false; clearInterval(t); };
    }, [deviceId, range, version]);

    React.useEffect(() => {
        let alive = true;
        jfetch<Daily>(`/api/devices/${encodeURIComponent(deviceId)}/daily-history?days=${days}`).then((r) => { if (alive) { setDaily(r); setDailyError(null); } }).catch((e) => alive && setDailyError(errorText(e)));
        return () => { alive = false; };
    }, [deviceId, days]);

    const canAdd = hasPerm(permissions, "checks.write");
    const addChecks = async () => {
        setAdding(true);
        setAddNote(null);
        try {
            for (const [kind, name] of [["cpu", "CPU usage"], ["memory", "Memory usage"], ["disk", "Disk free"]] as const) {
                await jfetch(`/api/devices/${encodeURIComponent(deviceId)}/check-definitions`, {
                    method: "POST",
                    body: { name: `${name} (${deviceName})`, kind, intervalMinutes: 5, ...(kind === "disk" ? { warn: 10, crit: 5 } : kind === "memory" ? { warn: 90, crit: 97 } : { warn: 90, crit: 98 }) },
                });
            }
            setAddNote("Added. The agent picks the checks up the next time it checks in, and the graphs fill in from the first results.");
            setVersion((v) => v + 1);
        } catch (e) {
            setAddNote(errorText(e));
        } finally {
            setAdding(false);
        }
    };

    const from = m ? Date.parse(m.from) : 0;
    const to = m ? Date.parse(m.to) : 0;
    const gapMs = m ? m.bucketMinutes * 60_000 * 3 : 0;
    const problem = m && m.monitoring.state !== "ok" ? m : null;
    const dailyItems = daily?.items ?? [];
    const firstDay = dailyItems[0]?.day;
    const lastDay = dailyItems[dailyItems.length - 1]?.day;
    const avgAvail = dailyItems.filter((d) => d.availability != null);
    const average = avgAvail.length ? Math.round((avgAvail.reduce((s, d) => s + (d.availability ?? 0), 0) / avgAvail.length) * 10) / 10 : null;
    const diskTrend: ChartPoint[] = dailyItems.filter((d) => d.diskFreePctMin != null).map((d) => ({ t: Date.parse(`${d.day}T12:00:00Z`), avg: d.diskFreePctMin as number }));
    const lastDisk = [...dailyItems].reverse().find((d) => d.diskFreeGb != null);

    return (
        <Card className="min-w-0 lg:col-span-3" data-testid="device-performance">
            <CardHeader>
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                        <CardTitle>Performance history</CardTitle>
                        <CardDescription>CPU, memory, disk, network traffic and disk activity as the agent measured them{m ? `, averaged every ${m.bucketMinutes} minutes` : ""}.</CardDescription>
                    </div>
                    <Seg value={range} onChange={setRange} options={RANGES} label="Period" />
                </div>
            </CardHeader>
            <CardContent className="space-y-6">
                {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
                {!m && !error ? <p className="text-sm text-muted-foreground">Loading…</p> : null}

                {problem ? (
                    <div role="status" className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm" data-testid="performance-problem">
                        <p>{problem.monitoring.problem}</p>
                        {problem.monitoring.state !== "no-agent" && canAdd ? (
                            <div className="mt-2 flex flex-wrap items-center gap-2">
                                <Button type="button" size="sm" variant="outline" disabled={adding} onClick={() => void addChecks()}>{adding ? "Adding…" : "Add CPU, memory and disk checks to this device"}</Button>
                                <span className="text-xs text-muted-foreground">They run every 5 minutes, with the usual warning levels.</span>
                            </div>
                        ) : null}
                        {addNote ? <p className="mt-2 text-xs">{addNote}</p> : null}
                    </div>
                ) : null}

                {m && !problem ? (
                    <>
                        {/* Side by side on wide screens, so each graph stays a readable size */}
                        <div className="grid gap-x-8 gap-y-6 md:grid-cols-2 xl:grid-cols-3">
                        <section aria-label="CPU" className="min-w-0">
                            <div className="mb-1 flex flex-wrap items-baseline gap-x-3"><h3 className="text-sm font-medium">CPU busy</h3><StatLine stats={m.cpu.stats} /></div>
                            <LineChart points={toChart(m.cpu.points)} from={from} to={to} gapMs={gapMs} label="CPU busy percent" />
                        </section>
                        <section aria-label="Memory" className="min-w-0">
                            <div className="mb-1 flex flex-wrap items-baseline gap-x-3"><h3 className="text-sm font-medium">Memory in use{m.memory.totalGb ? ` (of ${m.memory.totalGb} GB)` : ""}</h3><StatLine stats={m.memory.stats} /></div>
                            <LineChart points={toChart(m.memory.points)} from={from} to={to} gapMs={gapMs} label="Memory in use percent" color="hsl(262 70% 55%)" />
                        </section>
                        {m.disks.map((d) => (
                            <section key={d.mount} aria-label={`Disk ${d.mount}`} className="min-w-0">
                                <div className="mb-1 flex flex-wrap items-baseline gap-x-3"><h3 className="text-sm font-medium">Disk {d.mount} free{d.totalGb ? ` (of ${d.totalGb} GB)` : ""}</h3><StatLine stats={d.stats} /></div>
                                <LineChart points={toChart(d.points)} from={from} to={to} gapMs={gapMs} label={`Disk ${d.mount} free percent`} color="hsl(152 60% 38%)" showMax={false} />
                            </section>
                        ))}
                        {m.network ? (
                            <IoSection title="Network traffic (bits per second)" io={m.network} keys={["rx", "tx"]} labels={["Received", "Sent"]} colors={["hsl(205 80% 45%)", "hsl(28 90% 50%)"]}
                                kind="bits" scale={8} from={from} to={to} gapMs={gapMs} ariaLabel="Network traffic, received and sent, in bits per second"
                                extra={m.network.linkMbps ? `Link speed ${formatRate(m.network.linkMbps * 1e6, "bits")} in total across the adapters measured.` : null} />
                        ) : null}
                        {m.diskIo ? (
                            <IoSection title="Disk activity (bytes per second)" io={m.diskIo} keys={["read", "write"]} labels={["Read", "Write"]} colors={["hsl(172 70% 32%)", "hsl(330 70% 48%)"]}
                                kind="bytes" scale={1} from={from} to={to} gapMs={gapMs} ariaLabel="Disk activity, read and write speed, in bytes per second" />
                        ) : null}
                        </div>
                        <p className="text-xs text-muted-foreground">
                            Solid line: the average of each {m.bucketMinutes} minutes; dotted: the highest reading. Breaks in a line mean the device sent nothing then.
                            {range === "30d" && m.coveredFrom && Date.parse(m.coveredFrom) - from > 86_400_000 ? ` Detailed readings are kept for ${m.retentionDays} days, so this graph starts ${new Date(m.coveredFrom).toLocaleDateString()}; the daily history below goes back further.` : ""}
                            {" "}The agent measures every few minutes (every 5 by default); finer sampling needs a future agent update.
                        </p>
                    </>
                ) : null}

                <section aria-label="Availability and disk free history" className="space-y-3 border-t pt-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                            <h3 className="text-sm font-medium">Availability{average != null ? ` ${average}% over ${dailyItems.length} days` : ""}</h3>
                            <p className="text-xs text-muted-foreground">One cell per day: green is online all day, red is mostly offline, grey is no data.</p>
                        </div>
                        <Seg value={days} onChange={setDays} options={DAY_RANGES.map((n) => ({ value: n, label: n === 365 ? "1 year" : n === 800 ? "All (800)" : `${n} days` }))} label="Days" />
                    </div>
                    {dailyError ? <p role="alert" className="text-sm text-destructive">{dailyError}</p> : null}
                    {daily && dailyItems.length === 0 ? <p className="text-sm text-muted-foreground">No daily history yet. It is noted every 15 minutes for devices with an agent.</p> : null}
                    {firstDay && lastDay ? <AvailabilityStrip cells={dailyItems.map((d) => ({ day: d.day, availability: d.availability }))} from={firstDay} to={lastDay} /> : null}
                    {diskTrend.length > 0 ? (
                        <div className="max-w-2xl">
                            <div className="mb-1 flex flex-wrap items-baseline gap-x-3"><h3 className="text-sm font-medium">Disk free, lowest each day</h3>{lastDisk ? <span className="text-xs text-muted-foreground">last: {lastDisk.diskFreeGb} GB free of {lastDisk.diskTotalGb} GB</span> : null}</div>
                            <LineChart points={diskTrend} from={Date.parse(`${firstDay}T00:00:00Z`)} to={Date.parse(`${lastDay}T23:59:59Z`)} gapMs={4 * 86_400_000} label="Lowest free disk percent per day" color="hsl(152 60% 38%)" showMax={false} />
                        </div>
                    ) : null}
                </section>
            </CardContent>
        </Card>
    );
}
