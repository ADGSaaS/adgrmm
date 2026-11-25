// components/reports/charts.tsx
//
// Small charts drawn as SVG and text, so they follow the theme, need no library, and every number is also readable as text.
"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import type { Chart } from "./report-types";

const PALETTE = ["#6366f1", "#22c55e", "#f59e0b", "#0ea5e9", "#06b6d4", "#a855f7", "#84cc16", "#14b8a6", "#94a3b8"];
const WARM = ["#ef4444", "#f97316", "#eab308", "#dc2626", "#fb7185", "#b45309"];
const COOL_GOOD = ["#22c55e", "#16a34a", "#4ade80"];
const colourFor = (label: string, i: number) => (label === "Other" || label === "(none)" || label === "Not reported" ? PALETTE[8] : /^(online|healthy|success|resolved|on|encrypted|protected|compliant)$/i.test(label) ? COOL_GOOD[i % COOL_GOOD.length] : /^(offline|off|needs attention|crit|denied|failed|open|out of date|not encrypted|missing patches|scan overdue|not scanned|scan failed|critical)$/i.test(label) ? WARM[i % WARM.length] : PALETTE[i % 8]);

function BarChart({ chart }: { chart: Chart }) {
    const max = Math.max(1, ...chart.data.map((d) => d.value));
    return (
        <ul className="grid gap-1.5">
            {chart.data.map((d, i) => (
                <li key={d.label} className="grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-2 text-xs">
                    <span className="truncate" title={d.label}>{d.label}</span>
                    <span className="h-2.5 rounded-sm bg-muted" aria-hidden>
                        <span className="block h-full rounded-sm" style={{ width: `${Math.max(2, (d.value / max) * 100)}%`, background: colourFor(d.label, i) }} />
                    </span>
                    <span className="tabular-nums text-muted-foreground">{d.value.toLocaleString()}</span>
                </li>
            ))}
        </ul>
    );
}

function DonutChart({ chart }: { chart: Chart }) {
    const total = chart.data.reduce((s, d) => s + d.value, 0) || 1;
    const radius = 38;
    const circumference = 2 * Math.PI * radius;
    let offset = 0;
    return (
        <div className="flex items-center gap-4">
            <svg viewBox="0 0 100 100" className="h-24 w-24 shrink-0 -rotate-90" role="img" aria-label={`${chart.title}: ${chart.data.map((d) => `${d.label} ${d.value}`).join(", ")}`}>
                <circle cx="50" cy="50" r={radius} fill="none" stroke="currentColor" strokeOpacity={0.1} strokeWidth="14" />
                {chart.data.map((d, i) => {
                    const length = (d.value / total) * circumference;
                    const segment = <circle key={d.label} cx="50" cy="50" r={radius} fill="none" stroke={colourFor(d.label, i)} strokeWidth="14" strokeDasharray={`${length} ${circumference - length}`} strokeDashoffset={-offset} />;
                    offset += length;
                    return segment;
                })}
            </svg>
            <ul className="grid gap-1 text-xs">
                {chart.data.map((d, i) => (
                    <li key={d.label} className="flex items-center gap-2">
                        <span className="h-2.5 w-2.5 rounded-sm" style={{ background: colourFor(d.label, i) }} aria-hidden />
                        <span className="truncate">{d.label}</span>
                        <span className="tabular-nums text-muted-foreground">{d.value.toLocaleString()} ({Math.round((d.value / total) * 100)}%)</span>
                    </li>
                ))}
            </ul>
        </div>
    );
}

function LineChart({ chart }: { chart: Chart }) {
    const data = chart.data;
    const max = Math.max(1, ...data.map((d) => d.value));
    const w = 300;
    const h = 80;
    const step = data.length > 1 ? w / (data.length - 1) : 0;
    const points = data.map((d, i) => `${data.length > 1 ? i * step : w / 2},${h - (d.value / max) * (h - 8) - 4}`).join(" ");
    const total = data.reduce((s, d) => s + d.value, 0);
    return (
        <div className="grid gap-1">
            <svg viewBox={`0 0 ${w} ${h}`} className="h-20 w-full" preserveAspectRatio="none" role="img" aria-label={`${chart.title}: ${total} in ${data.length} days, busiest day ${max}`}>
                <polyline points={points} fill="none" stroke="#6366f1" strokeWidth="2" vectorEffect="non-scaling-stroke" />
                {data.length === 1 && <circle cx={w / 2} cy={h - (data[0].value / max) * (h - 8) - 4} r="3" fill="#6366f1" />}
            </svg>
            <div className="flex justify-between text-[11px] text-muted-foreground">
                <span>{data[0]?.label}</span>
                <span>busiest day: {max.toLocaleString()}</span>
                <span>{data[data.length - 1]?.label}</span>
            </div>
        </div>
    );
}

export function ChartsPanel({ charts }: { charts: Chart[] }) {
    const shown = charts.filter((c) => c.data.length > 0);
    if (!shown.length) return <p className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">There is nothing to chart for this selection.</p>;
    return (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {shown.map((c) => (
                <section key={c.key} className={cn("rounded-md border border-border p-3", c.kind === "line" && "md:col-span-2 xl:col-span-1")} aria-label={c.title}>
                    <h3 className="mb-2 text-sm font-medium">{c.title}</h3>
                    {c.kind === "donut" ? <DonutChart chart={c} /> : c.kind === "line" ? <LineChart chart={c} /> : <BarChart chart={c} />}
                </section>
            ))}
        </div>
    );
}
