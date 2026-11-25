"use client";

// components/overview/summary-cards.tsx
//
// The summary cards. Each has a title, one headline number, two or three supporting lines and a link. A card is drawn only when
// the person may see the area and the area has something in it (hasData), so there are never empty or dead cards.
import * as React from "react";
import { Activity, CalendarDays, Cpu, LifeBuoy, PackageOpen, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import type { DashboardSummary, Grade } from "@/lib/dashboard-api";
import { ago, fmt, pct, when } from "./format";
import { Line, SummaryShell } from "./parts";
import { useNav } from "./nav";

type S = DashboardSummary;

/** Which summary cards have something to show. The key is the card's key in the Customize menu. */
export function availableSummary(s: S): string[] {
    const keys: string[] = [];
    if (s.security && s.security.windowsDevices > 0) keys.push("sum-security");
    if (s.patching && (s.patching.scanned > 0 || s.patching.outdatedSoftwareDevices > 0)) keys.push("sum-patching");
    if (s.tickets && s.tickets.hasTickets) keys.push("sum-tickets");
    if (s.schedule && (s.schedule.today > 0 || s.schedule.nextSevenDays > 0 || s.schedule.next)) keys.push("sum-schedule");
    if (s.agents && s.agents.devicesWithAgent > 0) keys.push("sum-agents");
    if (s.activity && s.activity.items.length > 0) keys.push("sum-activity");
    return keys;
}

/** "2 min", "3 hours", "yesterday": how long ago the newest event was, without the word "ago". */
const sinceLast = (iso: string | undefined) => { const t = ago(iso); return t === "just now" ? "Just now" : t.replace(/ ago$/, ""); };

const GRADES: Grade[] = ["A", "B", "C", "D", "F"];
const GRADE_BG: Record<Grade, string> = { A: "bg-emerald-500", B: "bg-emerald-400/70", C: "bg-slate-400", D: "bg-amber-500", F: "bg-red-500", none: "bg-muted" };

function GradeBar({ grades }: { grades: Record<Grade, number> }) {
    const scored = GRADES.reduce((n, g) => n + (grades[g] ?? 0), 0);
    return (
        <div>
            <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted" role="img" aria-label={`Devices by grade: ${GRADES.map((g) => `${grades[g] ?? 0} ${g}`).join(", ")}`}>
                {scored > 0 ? GRADES.map((g) => (grades[g] ?? 0) > 0 ? <span key={g} className={GRADE_BG[g]} style={{ width: `${((grades[g] ?? 0) / scored) * 100}%` }} /> : null) : null}
            </div>
            <p className="mt-1.5 flex justify-between text-xs tabular-nums text-muted-foreground" aria-hidden>
                {GRADES.map((g) => <span key={g}>{g} {fmt(grades[g] ?? 0)}</span>)}
            </p>
        </div>
    );
}

function SecurityCard({ d }: { d: NonNullable<S["security"]> }) {
    const nav = useNav();
    return (
        <SummaryShell title="Security" icon={ShieldCheck} headline={d.averageScore ?? "—"} headlineHint="average score" href={nav.href("/security")} linkLabel="View security">
            <GradeBar grades={d.grades} />
            <div className="pt-1.5">
                <Line tone={d.devicesWithCriticalFailures ? "bad" : "muted"} value={fmt(d.devicesWithCriticalFailures)}>Devices with a critical failure</Line>
                <Line tone="muted" value={fmt(d.neverScanned)}>Not scanned yet</Line>
            </div>
        </SummaryShell>
    );
}

function PatchingCard({ d }: { d: NonNullable<S["patching"]> }) {
    const nav = useNav();
    return (
        <SummaryShell title="Patching" icon={PackageOpen} headline={fmt(d.withPendingUpdates)} headlineHint={d.withPendingUpdates === 1 ? "device has updates waiting" : "devices have updates waiting"} href={nav.href("/reports", { report: "patch-compliance" })} linkLabel="View patch report">
            <Line tone="muted" value={fmt(d.needRestart)}>Need a restart</Line>
            <Line tone={d.installFailed ? "warn" : "muted"} value={fmt(d.installFailed)}>Last update install failed</Line>
            <Line tone="muted" value={fmt(d.outdatedSoftwareDevices)}>Devices with outdated software</Line>
        </SummaryShell>
    );
}

function TicketsCard({ d }: { d: NonNullable<S["tickets"]> }) {
    const nav = useNav();
    return (
        <SummaryShell title="Service desk" icon={LifeBuoy} headline={fmt(d.open)} headlineHint={d.open === 1 ? "open ticket" : "open tickets"} href={nav.href("/tickets")} linkLabel="View tickets">
            <Line tone="muted" value={fmt(d.unassigned)}>Unassigned</Line>
            <Line tone={d.breached ? "bad" : "muted"} value={fmt(d.breached)}>Breached their SLA</Line>
            <Line tone={d.warning ? "warn" : "muted"} value={fmt(d.warning)}>Close to breaching</Line>
        </SummaryShell>
    );
}

function ScheduleCard({ d }: { d: NonNullable<S["schedule"]> }) {
    const nav = useNav();
    return (
        <SummaryShell title="Today’s schedule" icon={CalendarDays} headline={fmt(d.today)} headlineHint={d.today === 1 ? "visit today" : "visits today"} href={nav.href("/calendar")} linkLabel="Open calendar">
            {d.today > 0 ? (
                <>
                    <Line tone="muted" value={fmt(d.remainingToday)}>Still to come</Line>
                    <Line tone="muted" value={fmt(d.doneToday)}>Done</Line>
                </>
            ) : (
                <Line tone="muted" value={fmt(d.nextSevenDays)}>In the next 7 days</Line>
            )}
            {d.next ? (
                <p className="truncate pt-1 text-muted-foreground" title={d.next.title}>
                    <span className="font-medium text-foreground">Next:</span> {when(d.next.startsAt)}{d.next.customer ? ` · ${d.next.customer}` : ""}
                </p>
            ) : null}
        </SummaryShell>
    );
}

function AgentsCard({ d, canAdmin }: { d: NonNullable<S["agents"]>; canAdmin: boolean }) {
    const nav = useNav();
    const top = d.versions.slice(0, 3);
    const max = Math.max(1, ...top.map((v) => v.devices));
    const waiting = d.release?.[0] ?? null;
    return (
        <SummaryShell
            title="Agent versions" icon={Cpu} headline={pct(d.onLatest, d.devicesWithAgent)} headlineHint={d.latestVersion ? `on ${d.latestVersion}` : "up to date"}
            href={canAdmin ? nav.href("/administration", { tab: "agents" }) : undefined} linkLabel="Manage agents"
        >
            <ul className="space-y-1" aria-label="Devices per agent version">
                {top.map((v) => (
                    <li key={v.version} className="grid grid-cols-[4.5rem_1fr_auto] items-center gap-2">
                        <span className="truncate tabular-nums text-muted-foreground">{v.version}</span>
                        <span className="h-1.5 overflow-hidden rounded-full bg-muted"><span className="block h-full rounded-full bg-primary/70" style={{ width: `${(v.devices / max) * 100}%` }} /></span>
                        <span className="w-10 text-right font-medium tabular-nums">{fmt(v.devices)}</span>
                    </li>
                ))}
            </ul>
            {d.otherVersions || d.distinctVersions > top.length ? <p className="text-xs text-muted-foreground">and {d.distinctVersions - top.length} other {d.distinctVersions - top.length === 1 ? "version" : "versions"}</p> : null}
            <Line tone="muted" value={fmt(d.pilotDevices)}>In the Pilot ring</Line>
            {waiting ? <p className="truncate text-primary">Build {waiting.version} is waiting to be promoted</p> : null}
        </SummaryShell>
    );
}

function ActivityCard({ d, canAdmin }: { d: NonNullable<S["activity"]>; canAdmin: boolean }) {
    const nav = useNav();
    const rows = d.items.slice(0, 6);
    return (
        <SummaryShell
            title="Recent activity" icon={Activity} headline={sinceLast(d.items[0]?.at)} headlineHint={sinceLast(d.items[0]?.at) === "Just now" ? "latest change" : "since the last change"}
            href={canAdmin ? nav.href("/administration", { tab: "audit" }) : undefined} linkLabel="View audit log"
        >
            <ul className="space-y-1" aria-label="Recent activity">
                {rows.map((e) => (
                    <li key={e.id} className="flex items-baseline justify-between gap-3">
                        <span className={cn("min-w-0 truncate", e.failed && "text-muted-foreground")} title={`${e.actor} ${e.text}`}>
                            <span className="font-medium">{e.actor}</span> {e.text}
                        </span>
                        <span className="shrink-0 text-xs text-muted-foreground">{ago(e.at)}</span>
                    </li>
                ))}
            </ul>
            {d.allCustomers ? <p className="text-xs text-muted-foreground">Shows all customers.</p> : null}
        </SummaryShell>
    );
}

/** One summary card by its key, or null when there is nothing for it. */
export function SummaryCard({ cardKey, s, canAdmin }: { cardKey: string; s: S; canAdmin: boolean }) {
    switch (cardKey) {
        case "sum-security": return s.security ? <SecurityCard d={s.security} /> : null;
        case "sum-patching": return s.patching ? <PatchingCard d={s.patching} /> : null;
        case "sum-tickets": return s.tickets ? <TicketsCard d={s.tickets} /> : null;
        case "sum-schedule": return s.schedule ? <ScheduleCard d={s.schedule} /> : null;
        case "sum-agents": return s.agents ? <AgentsCard d={s.agents} canAdmin={canAdmin} /> : null;
        case "sum-activity": return s.activity ? <ActivityCard d={s.activity} canAdmin={canAdmin} /> : null;
        default: return null;
    }
}
