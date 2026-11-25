"use client";

// Service desk performance: how the team and each technician are doing over a period. Tickets, how many are resolved, how often the SLA was met,
// average response and resolution time (working hours, from each ticket's SLA clock) and time logged.
import * as React from "react";
import Link from "next/link";
import { Gauge, Loader2 } from "lucide-react";
import { PageHeader, PageShell } from "@/components/page-shell";
import PermGate from "@/components/perm-gate";
import { EmptyState, SegmentedTabs } from "@/components/list-controls";
import { errorText } from "@/components/policies/shared";
import { jfetch } from "@/lib/api";

type Row = {
    userId: string | null; name: string; assigned: number; resolved: number; open: number;
    responseMetPercent: number | null; resolutionMetPercent: number | null; avgResponseMinutes: number | null; avgResolutionMinutes: number | null; minutesLogged: number;
};
type Performance = { days: number; team: Row; technicians: Row[]; byPriority: Array<{ priority: string; tickets: number; responseMetPercent: number | null; resolutionMetPercent: number | null }>; note: string };

const pct = (n: number | null) => (n === null ? "–" : `${n}%`);
const tone = (n: number | null) => (n === null ? "" : n >= 90 ? "text-emerald-600 dark:text-emerald-400" : n >= 70 ? "text-amber-600 dark:text-amber-400" : "text-red-600 dark:text-red-400");
const dur = (m: number | null) => (m === null ? "–" : m < 90 ? `${m} min` : m < 60 * 36 ? `${(m / 60).toFixed(1)} h` : `${(m / 60 / 8).toFixed(1)} working days`);
const hours = (m: number) => (m === 0 ? "–" : `${(m / 60).toFixed(1)} h`);

function Tile({ title, value, note, cls }: { title: string; value: string; note?: string; cls?: string }) {
    return (
        <div className="rounded-lg border p-4">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">{title}</p>
            <p className={`mt-1 text-2xl font-semibold ${cls ?? ""}`}>{value}</p>
            {note ? <p className="mt-0.5 text-xs text-muted-foreground">{note}</p> : null}
        </div>
    );
}

function Body() {
    const [days, setDays] = React.useState(30);
    const [data, setData] = React.useState<Performance | null>(null);
    const [error, setError] = React.useState<string | null>(null);

    React.useEffect(() => {
        let alive = true;
        setData(null);
        jfetch<Performance>(`/api/sla/performance?days=${days}`).then((d) => { if (alive) { setData(d); setError(null); } }).catch((e) => { if (alive) setError(errorText(e)); });
        return () => { alive = false; };
    }, [days]);

    return (
        <PageShell>
            <PageHeader
                title="Service desk performance"
                description="How the team and each technician are doing: tickets, how many are resolved, how often the SLA was met, average times and time logged."
                actions={<Link href="/administration?tab=sla" className="text-sm text-primary hover:underline">SLA settings</Link>}
            />
            {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
            <SegmentedTabs value={String(days)} onChange={(v) => setDays(Number(v))} items={[{ key: "7", label: "7 days" }, { key: "30", label: "30 days" }, { key: "90", label: "90 days" }]} label="Period" />
            {!data ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />Loading…</div>
            ) : data.team.assigned === 0 && data.team.minutesLogged === 0 ? (
                <EmptyState><Gauge className="mx-auto mb-2 h-6 w-6 text-muted-foreground" aria-hidden="true" />No tickets were created in this period.</EmptyState>
            ) : (
                <>
                    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                        <Tile title="Tickets" value={String(data.team.assigned)} note={`${data.team.resolved} resolved, ${data.team.open} still open`} />
                        <Tile title="Response SLA met" value={pct(data.team.responseMetPercent)} cls={tone(data.team.responseMetPercent)} note={`Average first response ${dur(data.team.avgResponseMinutes)}`} />
                        <Tile title="Resolution SLA met" value={pct(data.team.resolutionMetPercent)} cls={tone(data.team.resolutionMetPercent)} note={`Average time to resolve ${dur(data.team.avgResolutionMinutes)}`} />
                        <Tile title="Time logged" value={hours(data.team.minutesLogged)} />
                    </div>

                    <div className="overflow-x-auto rounded-lg border">
                        <table className="w-full text-sm">
                            <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                                <tr><th className="p-2">Technician</th><th className="p-2 text-right">Tickets</th><th className="p-2 text-right">Resolved</th><th className="p-2 text-right">Open</th><th className="p-2 text-right">Response met</th><th className="p-2 text-right">Resolution met</th><th className="p-2 text-right">Avg response</th><th className="p-2 text-right">Avg resolve</th><th className="p-2 text-right">Logged</th></tr>
                            </thead>
                            <tbody>
                                {data.technicians.map((t) => (
                                    <tr key={t.userId ?? "none"} className="border-t">
                                        <td className="p-2 font-medium">{t.name}</td>
                                        <td className="p-2 text-right tabular-nums">{t.assigned}</td>
                                        <td className="p-2 text-right tabular-nums">{t.resolved}</td>
                                        <td className="p-2 text-right tabular-nums">{t.open}</td>
                                        <td className={`p-2 text-right tabular-nums ${tone(t.responseMetPercent)}`}>{pct(t.responseMetPercent)}</td>
                                        <td className={`p-2 text-right tabular-nums ${tone(t.resolutionMetPercent)}`}>{pct(t.resolutionMetPercent)}</td>
                                        <td className="p-2 text-right tabular-nums">{dur(t.avgResponseMinutes)}</td>
                                        <td className="p-2 text-right tabular-nums">{dur(t.avgResolutionMinutes)}</td>
                                        <td className="p-2 text-right tabular-nums">{hours(t.minutesLogged)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>

                    {data.byPriority.length ? (
                        <div>
                            <h2 className="mb-2 text-base font-semibold">By priority</h2>
                            <ul className="grid gap-1 text-sm">
                                {data.byPriority.map((p) => (
                                    <li key={p.priority} className="flex flex-wrap gap-3">
                                        <span className="w-24 capitalize">{p.priority}</span><span className="w-24 tabular-nums text-muted-foreground">{p.tickets} tickets</span>
                                        <span className={tone(p.responseMetPercent)}>response {pct(p.responseMetPercent)}</span><span className={tone(p.resolutionMetPercent)}>resolution {pct(p.resolutionMetPercent)}</span>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    ) : null}
                    <p className="text-xs text-muted-foreground">{data.note}</p>
                </>
            )}
        </PageShell>
    );
}

export default function ServiceDeskPerformancePage() {
    return (
        <PermGate require="settings.read" title="Service desk performance" message="You need permission to view settings to see how each technician is doing.">
            <Body />
        </PermGate>
    );
}
