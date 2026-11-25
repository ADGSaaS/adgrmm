"use client";

// Small inline SVG charts for one device's history: a line chart on a 0 to 100 percent scale (or, with `series`, several
// lines on an automatic scale in bits or bytes per second), and a strip of days.
// No chart library: the data is a few hundred points, and the colours come from the app's own theme variables.
import * as React from "react";

export type ChartPoint = { t: number; avg: number; max?: number };

const W = 640;
const H = 150;
const PAD = { l: 34, r: 8, t: 8, b: 20 };

function timeLabel(t: number, spanMs: number): string {
    const d = new Date(t);
    return spanMs <= 36 * 3_600_000
        ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
        : d.toLocaleDateString([], { month: "short", day: "numeric" });
}

/** One line of a multi-line chart. */
export type ChartSeries = { key: string; label: string; color: string; points: ChartPoint[] };

export type RateKind = "bits" | "bytes";
const RATE_UNITS: Record<RateKind, Array<[number, string]>> = {
    bits: [[1e9, "Gbps"], [1e6, "Mbps"], [1e3, "Kbps"], [1, "bps"]],
    bytes: [[1073741824, "GB/s"], [1048576, "MB/s"], [1024, "KB/s"], [1, "B/s"]],
};
const trim = (n: number) => String(Math.round(n * 100) / 100);

/** A rate with a human unit: bits give bps / Kbps / Mbps / Gbps (steps of 1000), bytes give B/s / KB/s / MB/s / GB/s (steps of 1024). */
export function formatRate(v: number, kind: RateKind): string {
    const units = RATE_UNITS[kind];
    const [div, name] = units.find(([d]) => Math.abs(v) >= d) ?? units[units.length - 1];
    const x = v / div;
    return `${Math.abs(x) >= 100 || div === 1 ? Math.round(x) : Math.round(x * 10) / 10} ${name}`;
}

/** The unit and axis ticks (0, half, top) that suit a largest value: a top such as 2, 5 or 8 in the unit, never 3.7. */
export function rateScale(max: number, kind: RateKind): { div: number; unit: string; top: number; ticks: number[] } {
    const units = RATE_UNITS[kind];
    const [div, unit] = max > 0 ? (units.find(([d]) => max >= d) ?? units[units.length - 1]) : units[units.length - 2];
    const inUnit = max / div;
    const e = inUnit > 0 ? Math.floor(Math.log10(inUnit)) : 0;
    const f = inUnit > 0 ? inUnit / 10 ** e : 1;
    const nice = [1, 2, 4, 5, 6, 8, 10].find((n) => f <= n * 1.0000001) ?? 10;
    const top = nice * 10 ** e * div;
    return { div, unit, top, ticks: [0, top / 2, top] };
}

/**
 * A line of averages with a faint line of peaks, from `from` to `to`. Where results are missing for longer than
 * `gapMs` (the device was off or offline) the line is broken instead of joined across the gap.
 *
 * With `series` it draws several lines in one chart (for example received and sent) on an automatic scale in
 * bits or bytes per second (`rate`), with a legend and a tooltip that lists every series at the hovered time.
 */
export type LineChartProps = {
    points: ChartPoint[];
    from: number;
    to: number;
    gapMs: number;
    color?: string;
    label: string;
    unit?: string;
    yMax?: number;
    showMax?: boolean;
    format?: (v: number) => string;
    series?: ChartSeries[];
    rate?: RateKind;
};

export function LineChart(props: LineChartProps) {
    return props.series ? <MultiLineChart {...props} series={props.series} /> : <SingleLineChart {...props} />;
}

function MultiLineChart({ series, from, to, gapMs, label, rate = "bytes", showMax = false }: LineChartProps & { series: ChartSeries[] }) {
    const [hover, setHover] = React.useState<number | null>(null);
    const L = 58; // room for labels such as "2.5 Mbps"
    const span = Math.max(1, to - from);
    const x = (t: number) => L + ((t - from) / span) * (W - L - PAD.r);

    const peak = Math.max(0, ...series.flatMap((s) => s.points.map((p) => Math.max(p.avg, showMax ? (p.max ?? p.avg) : p.avg))));
    const sc = rateScale(peak, rate);
    const y = (v: number) => PAD.t + (1 - Math.min(Math.max(v, 0), sc.top) / sc.top) * (H - PAD.t - PAD.b);

    const segmentsOf = (pts: ChartPoint[]) => {
        const out: ChartPoint[][] = [];
        let cur: ChartPoint[] = [];
        for (const p of pts) {
            if (cur.length && p.t - cur[cur.length - 1].t > gapMs) { out.push(cur); cur = []; }
            cur.push(p);
        }
        if (cur.length) out.push(cur);
        return out;
    };
    const segs = React.useMemo(() => series.map((s) => segmentsOf(s.points)), [series, gapMs]); // eslint-disable-line react-hooks/exhaustive-deps
    const line = (seg: ChartPoint[], pick: (p: ChartPoint) => number) => seg.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(pick(p)).toFixed(1)}`).join(" ");

    const times = React.useMemo(() => [...new Set(series.flatMap((s) => s.points.map((p) => p.t)))].sort((a, b) => a - b), [series]);
    const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
        if (!times.length) return;
        const r = e.currentTarget.getBoundingClientRect();
        const px = ((e.clientX - r.left) / r.width) * W;
        const t = from + ((px - L) / (W - L - PAD.r)) * span;
        let best = 0;
        for (let i = 1; i < times.length; i++) if (Math.abs(times[i] - t) < Math.abs(times[best] - t)) best = i;
        setHover(best);
    };
    const ht = hover != null ? times[hover] : null;
    const at = (s: ChartSeries, t: number) => s.points.find((p) => p.t === t) ?? null;
    const xTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => from + f * span);
    const latest = series.map((s) => (s.points.length ? `${s.label} ${formatRate(s.points[s.points.length - 1].avg, rate)}` : null)).filter(Boolean).join(", ");
    const summary = times.length ? `${label}. ${times.length} readings, latest: ${latest}.` : `${label}. No readings.`;
    const tickText = (v: number) => (v === 0 ? "0" : `${trim(v / sc.div)} ${sc.unit}`);

    return (
        <div className="relative">
            <div className="mb-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs" data-testid="chart-legend">
                {series.map((s) => (
                    <span key={s.key} className="inline-flex items-center gap-1.5"><span aria-hidden="true" className="inline-block h-0.5 w-3.5 rounded" style={{ background: s.color }} />{s.label}</span>
                ))}
            </div>
            <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={summary} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
                {sc.ticks.map((v) => (
                    <g key={v}>
                        <line x1={L} x2={W - PAD.r} y1={y(v)} y2={y(v)} stroke="hsl(var(--border))" strokeWidth={1} />
                        <text x={L - 4} y={y(v) + 3} textAnchor="end" fontSize={9} fill="hsl(var(--muted-foreground))">{tickText(v)}</text>
                    </g>
                ))}
                {xTicks.map((t, i) => (
                    <text key={i} x={Math.min(Math.max(x(t), L + 14), W - PAD.r - 14)} y={H - 5} textAnchor="middle" fontSize={9} fill="hsl(var(--muted-foreground))">{timeLabel(t, span)}</text>
                ))}
                {series.map((s, si) =>
                    segs[si].map((seg, i) =>
                        seg.length === 1 ? (
                            <circle key={`${s.key}${i}`} cx={x(seg[0].t)} cy={y(seg[0].avg)} r={2} fill={s.color} />
                        ) : (
                            <g key={`${s.key}${i}`}>
                                {showMax ? <path d={line(seg, (p) => p.max ?? p.avg)} fill="none" stroke={s.color} strokeOpacity={0.3} strokeWidth={1} strokeDasharray="2 2" /> : null}
                                <path d={line(seg, (p) => p.avg)} fill="none" stroke={s.color} strokeWidth={1.6} strokeLinejoin="round" />
                            </g>
                        ),
                    ),
                )}
                {ht != null ? (
                    <g>
                        <line x1={x(ht)} x2={x(ht)} y1={PAD.t} y2={H - PAD.b} stroke="hsl(var(--muted-foreground))" strokeWidth={1} strokeDasharray="3 3" />
                        {series.map((s) => { const p = at(s, ht); return p ? <circle key={s.key} cx={x(ht)} cy={y(p.avg)} r={3} fill={s.color} /> : null; })}
                    </g>
                ) : null}
                {times.length === 0 ? <text x={W / 2} y={H / 2} textAnchor="middle" fontSize={11} fill="hsl(var(--muted-foreground))">No readings in this period</text> : null}
            </svg>
            {ht != null ? (
                <div className="pointer-events-none absolute right-2 top-6 rounded border bg-popover px-2 py-1 text-xs shadow" data-testid="chart-tooltip">
                    <div className="text-muted-foreground">{new Date(ht).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</div>
                    {series.map((s) => {
                        const p = at(s, ht);
                        return p ? (
                            <div key={s.key} className="flex items-center gap-1.5">
                                <span aria-hidden="true" className="inline-block h-0.5 w-3 rounded" style={{ background: s.color }} />
                                {s.label}: <strong>{formatRate(p.avg, rate)}</strong>
                                {p.max != null && p.max > p.avg ? <span className="text-muted-foreground">(peak {formatRate(p.max, rate)})</span> : null}
                            </div>
                        ) : null;
                    })}
                </div>
            ) : null}
        </div>
    );
}

function SingleLineChart({ points, from, to, gapMs, color = "hsl(var(--primary))", label, unit = "%", yMax = 100, showMax = true, format }: LineChartProps) {
    const [hover, setHover] = React.useState<number | null>(null);
    const span = Math.max(1, to - from);
    const x = (t: number) => PAD.l + ((t - from) / span) * (W - PAD.l - PAD.r);
    const y = (v: number) => PAD.t + (1 - Math.min(Math.max(v, 0), yMax) / yMax) * (H - PAD.t - PAD.b);
    const fmt = format ?? ((v: number) => `${v}${unit}`);

    const segments = React.useMemo(() => {
        const out: ChartPoint[][] = [];
        let cur: ChartPoint[] = [];
        for (const p of points) {
            if (cur.length && p.t - cur[cur.length - 1].t > gapMs) {
                out.push(cur);
                cur = [];
            }
            cur.push(p);
        }
        if (cur.length) out.push(cur);
        return out;
    }, [points, gapMs]);

    const line = (seg: ChartPoint[], pick: (p: ChartPoint) => number) => seg.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(pick(p)).toFixed(1)}`).join(" ");
    const area = (seg: ChartPoint[]) => `${line(seg, (p) => p.avg)} L${x(seg[seg.length - 1].t).toFixed(1)},${y(0)} L${x(seg[0].t).toFixed(1)},${y(0)} Z`;

    const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
        if (!points.length) return;
        const r = e.currentTarget.getBoundingClientRect();
        const px = ((e.clientX - r.left) / r.width) * W;
        const t = from + ((px - PAD.l) / (W - PAD.l - PAD.r)) * span;
        let best = 0;
        for (let i = 1; i < points.length; i++) if (Math.abs(points[i].t - t) < Math.abs(points[best].t - t)) best = i;
        setHover(best);
    };
    const hp = hover != null ? points[hover] : null;
    const ticks = [0, 25, 50, 75, 100].filter((v) => v <= yMax);
    const xTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => from + f * span);
    const summary = points.length ? `${label}. ${points.length} readings, latest ${fmt(points[points.length - 1].avg)}.` : `${label}. No readings.`;

    return (
        <div className="relative">
            <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={summary} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
                {ticks.map((v) => (
                    <g key={v}>
                        <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} stroke="hsl(var(--border))" strokeWidth={1} />
                        <text x={PAD.l - 4} y={y(v) + 3} textAnchor="end" fontSize={9} fill="hsl(var(--muted-foreground))">{v}</text>
                    </g>
                ))}
                {xTicks.map((t, i) => (
                    <text key={i} x={Math.min(Math.max(x(t), PAD.l + 14), W - PAD.r - 14)} y={H - 5} textAnchor="middle" fontSize={9} fill="hsl(var(--muted-foreground))">{timeLabel(t, span)}</text>
                ))}
                {segments.map((seg, i) =>
                    seg.length === 1 ? (
                        <circle key={i} cx={x(seg[0].t)} cy={y(seg[0].avg)} r={2} fill={color} />
                    ) : (
                        <g key={i}>
                            <path d={area(seg)} fill={color} opacity={0.12} />
                            {showMax ? <path d={line(seg, (p) => p.max ?? p.avg)} fill="none" stroke={color} strokeOpacity={0.35} strokeWidth={1} strokeDasharray="2 2" /> : null}
                            <path d={line(seg, (p) => p.avg)} fill="none" stroke={color} strokeWidth={1.6} strokeLinejoin="round" />
                        </g>
                    ),
                )}
                {hp ? (
                    <g>
                        <line x1={x(hp.t)} x2={x(hp.t)} y1={PAD.t} y2={H - PAD.b} stroke="hsl(var(--muted-foreground))" strokeWidth={1} strokeDasharray="3 3" />
                        <circle cx={x(hp.t)} cy={y(hp.avg)} r={3} fill={color} />
                    </g>
                ) : null}
                {points.length === 0 ? <text x={W / 2} y={H / 2} textAnchor="middle" fontSize={11} fill="hsl(var(--muted-foreground))">No readings in this period</text> : null}
            </svg>
            {hp ? (
                <div className="pointer-events-none absolute right-2 top-1 rounded border bg-popover px-2 py-1 text-xs shadow" data-testid="chart-tooltip">
                    {new Date(hp.t).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}: <strong>{fmt(hp.avg)}</strong>
                    {hp.max != null && hp.max !== hp.avg ? <span className="text-muted-foreground"> (peak {fmt(hp.max)})</span> : null}
                </div>
            ) : null}
        </div>
    );
}

export type DayCell = { day: string; availability: number | null };

const tone = (a: number | null) =>
    a == null ? "bg-muted" : a >= 99 ? "bg-emerald-500" : a >= 95 ? "bg-emerald-400/80" : a >= 80 ? "bg-amber-400" : a >= 50 ? "bg-orange-500" : "bg-red-500";

/** One cell per day, oldest first, coloured by how much of the day the device was online. */
export function AvailabilityStrip({ cells, from, to }: { cells: DayCell[]; from: string; to: string }) {
    const byDay = new Map(cells.map((c) => [c.day, c.availability]));
    const days: DayCell[] = [];
    for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) {
        const day = new Date(t).toISOString().slice(0, 10);
        days.push({ day, availability: byDay.get(day) ?? null });
    }
    return (
        <div>
            <div className="flex h-8 w-full gap-px overflow-hidden rounded" role="img" aria-label={`Availability for each of ${days.length} days, from ${from} to ${to}`} data-testid="availability-strip">
                {days.map((d) => (
                    <div key={d.day} className={`min-w-px flex-1 ${tone(d.availability)}`} title={`${d.day}: ${d.availability == null ? "no data" : `${d.availability}% online`}`} />
                ))}
            </div>
            <div className="mt-1 flex justify-between text-[10px] text-muted-foreground"><span>{from}</span><span>{to}</span></div>
        </div>
    );
}
