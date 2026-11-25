"use client";

// The dispatch board: who is going where, by day or by week, with the tickets that still need a visit beside it.
// Drag a visit to move it (the same person at another time, or to someone else's column); drag a ticket onto the grid
// to book it. Every action also has a button, so it works without dragging.
import * as React from "react";
import { AlertTriangle, CalendarClock, ChevronLeft, ChevronRight, Clock, Plus, Search } from "lucide-react";
import { PageHeader, PageShell } from "@/components/page-shell";
import PermGate from "@/components/perm-gate";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/use-toast";
import { SegmentedTabs } from "@/components/list-controls";
import { VisitDialog, type VisitDraft } from "@/components/schedule/visit-dialog";
import { AvailabilityDialog } from "@/components/schedule/availability-dialog";
import { statusClass } from "@/components/schedule/ticket-visits";
import { STATUS_LABEL, browserZone, isWorking, notifiedText, schedule, type Tech, type TimeOff, type Unscheduled, type Visit } from "@/lib/schedule-api";
import { useMe } from "@/lib/use-me";
import { hasPerm } from "@/lib/permissions";

const HOUR_PX = 48;
const START_H = 6;
const END_H = 21;
const SNAP_MIN = 15;
const DAY_MS = 86400_000;

const startOfDay = (d: Date) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const startOfWeek = (d: Date) => { const x = startOfDay(d); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };
const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
const hm = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const dayLabel = (d: Date) => d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });

type DragData = { type: "visit"; id: string; techId: string; offsetMin: number } | { type: "ticket"; id: string; label: string };

function readDrag(e: React.DragEvent): DragData | null {
    try {
        return JSON.parse(e.dataTransfer.getData("text/plain")) as DragData;
    } catch {
        return null;
    }
}

function VisitChip({ v, compact, onOpen, draggable, techId }: { v: Visit; compact?: boolean; onOpen: (v: Visit) => void; draggable: boolean; techId: string }) {
    return (
        <button
            type="button"
            draggable={draggable && v.status !== "done" && v.status !== "cancelled"}
            onDragStart={(e) => {
                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                const offsetMin = compact ? 0 : Math.max(0, ((e.clientY - rect.top) / HOUR_PX) * 60);
                e.dataTransfer.setData("text/plain", JSON.stringify({ type: "visit", id: v.id, techId, offsetMin } satisfies DragData));
                e.dataTransfer.effectAllowed = "move";
            }}
            onClick={() => onOpen(v)}
            title={`${v.ticketNumber ? `#${v.ticketNumber} ` : ""}${v.ticketSubject ?? v.title}\n${hm(v.startsAt)} to ${hm(v.endsAt)}\n${v.techs.map((t) => t.name).join(", ")}${v.location ? `\n${v.location}` : ""}`}
            className={`w-full overflow-hidden rounded-md border border-border/60 px-1.5 py-0.5 text-left text-xs leading-tight shadow-sm ${statusClass(v.status)} ${compact ? "" : "h-full"}`}
        >
            <span className="block font-medium">{hm(v.startsAt)} {v.ticketNumber ? `#${v.ticketNumber}` : ""}</span>
            <span className="block truncate">{v.ticketSubject ?? v.title}</span>
            {v.clientName ? <span className="block truncate opacity-80">{v.clientName}</span> : null}
            {!compact ? <span className="block opacity-80">{STATUS_LABEL[v.status]}</span> : null}
        </button>
    );
}

function Board() {
    const { permissions } = useMe();
    const canWrite = hasPerm(permissions, "schedule.write");
    const canLogTime = hasPerm(permissions, "tickets.time.manual");
    const [view, setView] = React.useState<"day" | "week">("day");
    const [anchor, setAnchor] = React.useState(() => startOfDay(new Date()));
    const [techs, setTechs] = React.useState<Tech[]>([]);
    const [shown, setShown] = React.useState<string[]>([]);
    const [visits, setVisits] = React.useState<Visit[]>([]);
    const [off, setOff] = React.useState<TimeOff[]>([]);
    const [side, setSide] = React.useState<Unscheduled[]>([]);
    const [sideQ, setSideQ] = React.useState("");
    const [error, setError] = React.useState<string | null>(null);
    const [tick, setTick] = React.useState(0);
    const [dlg, setDlg] = React.useState<{ visit: Visit | null; draft: VisitDraft | null } | null>(null);
    const [avail, setAvail] = React.useState(false);
    const [now, setNow] = React.useState(() => new Date());

    const from = view === "day" ? startOfDay(anchor) : startOfWeek(anchor);
    const to = addDays(from, view === "day" ? 1 : 7);
    const days = Array.from({ length: view === "day" ? 1 : 7 }, (_, i) => addDays(from, i));
    const refresh = React.useCallback(() => setTick((n) => n + 1), []);

    React.useEffect(() => { schedule.techs().then((r) => setTechs(r.items)).catch((e) => setError(e?.message || "Could not load the technicians.")); }, [tick]);
    React.useEffect(() => {
        let stale = false;
        Promise.all([schedule.visits({ from: from.toISOString(), to: to.toISOString() }), schedule.timeOff(from.toISOString(), to.toISOString())])
            .then(([v, o]) => { if (!stale) { setVisits(v.items); setOff(o.items); setError(null); } })
            .catch((e) => { if (!stale) setError(e?.message || "Could not load the schedule."); });
        return () => { stale = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [from.getTime(), to.getTime(), tick]);
    React.useEffect(() => {
        let stale = false;
        const t = setTimeout(() => { schedule.unscheduled(sideQ.trim()).then((r) => { if (!stale) setSide(r.items); }).catch(() => null); }, 200);
        return () => { stale = true; clearTimeout(t); };
    }, [sideQ, tick]);
    React.useEffect(() => { const t = setInterval(() => setNow(new Date()), 60_000); return () => clearInterval(t); }, []);

    // By default only people on the schedule: with working hours set, or with a visit or time off in view. "Everyone" shows all.
    const [everyone, setEveryone] = React.useState(false);
    const busyIds = new Set([...visits.flatMap((v) => v.techs.map((t) => t.id)), ...off.map((o) => o.userId)]);
    const scheduled = techs.filter((t) => t.configured || busyIds.has(t.id));
    const columns = shown.length ? techs.filter((t) => shown.includes(t.id)) : everyone || scheduled.length === 0 ? techs : scheduled;
    const techOf = (id: string) => techs.find((t) => t.id === id);

    async function move(visit: Visit, patch: { startsAt: Date; techIds?: string[] }) {
        const len = new Date(visit.endsAt).getTime() - new Date(visit.startsAt).getTime();
        const body = { startsAt: patch.startsAt.toISOString(), endsAt: new Date(patch.startsAt.getTime() + len).toISOString(), ...(patch.techIds ? { techIds: patch.techIds } : {}) };
        try {
            const r = await schedule.update(visit.id, body);
            toast({ title: "Visit moved", description: notifiedText(r.notified) || undefined });
        } catch (e: any) {
            if (e?.status === 409) {
                let msg = "That clashes with something else.";
                try {
                    const c = await schedule.conflicts({ startsAt: body.startsAt, endsAt: body.endsAt, techIds: body.techIds ?? visit.techs.map((t) => t.id), ignoreVisitId: visit.id });
                    if (c.conflicts.length) msg = c.conflicts.map((x) => x.message).join("\n");
                } catch { /* keep the general message */ }
                if (confirm(`${msg}\n\nMove it anyway?`)) {
                    try {
                        const r = await schedule.update(visit.id, { ...body, force: true });
                        toast({ title: "Visit moved", description: notifiedText(r.notified) || undefined });
                    } catch (e2: any) {
                        toast({ title: "That did not work", description: e2?.message, variant: "destructive" });
                    }
                }
            } else {
                toast({ title: "That did not work", description: e?.message, variant: "destructive" });
            }
        }
        refresh();
    }

    function swapTech(visit: Visit, fromTech: string, toTech: string): string[] | undefined {
        if (fromTech === toTech) return undefined;
        const ids = visit.techs.map((t) => t.id).filter((id) => id !== fromTech);
        return ids.includes(toTech) ? ids : [...ids, toTech];
    }

    function dropOnColumn(e: React.DragEvent<HTMLDivElement>, tech: Tech, day: Date) {
        e.preventDefault();
        if (!canWrite) return;
        const data = readDrag(e);
        if (!data) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const rawMin = START_H * 60 + ((e.clientY - rect.top) / HOUR_PX) * 60 - (data.type === "visit" ? data.offsetMin : 0);
        const snapped = Math.min(END_H * 60 - SNAP_MIN, Math.max(START_H * 60, Math.round(rawMin / SNAP_MIN) * SNAP_MIN));
        const at = new Date(day);
        at.setHours(0, snapped, 0, 0);
        if (data.type === "ticket") setDlg({ visit: null, draft: { ticketId: data.id, ticketLabel: data.label, startsAt: at, techId: tech.id } });
        else {
            const v = visits.find((x) => x.id === data.id);
            if (v) void move(v, { startsAt: at, techIds: swapTech(v, data.techId, tech.id) });
        }
    }

    function dropOnCell(e: React.DragEvent<HTMLDivElement>, tech: Tech, day: Date) {
        e.preventDefault();
        if (!canWrite) return;
        const data = readDrag(e);
        if (!data) return;
        if (data.type === "ticket") {
            const at = new Date(day);
            at.setHours(9, 0, 0, 0);
            setDlg({ visit: null, draft: { ticketId: data.id, ticketLabel: data.label, startsAt: at, techId: tech.id } });
        } else {
            const v = visits.find((x) => x.id === data.id);
            if (!v) return;
            const old = new Date(v.startsAt);
            const at = new Date(day);
            at.setHours(old.getHours(), old.getMinutes(), 0, 0);
            void move(v, { startsAt: at, techIds: swapTech(v, data.techId, tech.id) });
        }
    }

    const hours = Array.from({ length: END_H - START_H }, (_, i) => START_H + i);
    const gridH = (END_H - START_H) * HOUR_PX;
    const rangeLabel = view === "day" ? from.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long", year: "numeric" }) : `${dayLabel(from)} to ${dayLabel(addDays(from, 6))}`;

    function dayColumn(tech: Tech, day: Date) {
        const dayStart = new Date(day); dayStart.setHours(START_H, 0, 0, 0);
        const dayEnd = new Date(day); dayEnd.setHours(END_H, 0, 0, 0);
        const mine = visits.filter((v) => v.techs.some((t) => t.id === tech.id) && v.status !== "cancelled" && new Date(v.endsAt) > dayStart && new Date(v.startsAt) < dayEnd);
        const myOff = off.filter((o) => o.userId === tech.id && new Date(o.endsAt) > dayStart && new Date(o.startsAt) < dayEnd);
        const slots = Array.from({ length: (END_H - START_H) * 2 }, (_, i) => new Date(dayStart.getTime() + i * 1800_000));
        const px = (d: Date) => Math.min(gridH, Math.max(0, ((d.getTime() - dayStart.getTime()) / 3600_000) * HOUR_PX));
        return (
            <div
                key={`${tech.id}-${day.toDateString()}`}
                className="relative border-l"
                style={{ height: gridH }}
                onDragOver={(e) => { if (canWrite) e.preventDefault(); }}
                onDrop={(e) => dropOnColumn(e, tech, day)}
                data-testid={`col-${tech.id}`}
            >
                {slots.map((s, i) => (!isWorking(s, tech) ? <div key={i} className="pointer-events-none absolute inset-x-0 bg-muted/60" style={{ top: i * HOUR_PX / 2, height: HOUR_PX / 2 }} /> : null))}
                {hours.map((h, i) => <div key={h} className="pointer-events-none absolute inset-x-0 border-t border-border/50" style={{ top: i * HOUR_PX }} />)}
                {myOff.map((o) => {
                    const top = px(new Date(o.startsAt)), bottom = px(new Date(o.endsAt));
                    return <div key={o.id} className="pointer-events-none absolute inset-x-0 flex items-start justify-center bg-[repeating-linear-gradient(45deg,transparent,transparent_6px,hsl(var(--muted-foreground)/0.18)_6px,hsl(var(--muted-foreground)/0.18)_12px)] text-[11px] text-muted-foreground" style={{ top, height: Math.max(8, bottom - top) }}>Time off{o.reason ? `: ${o.reason}` : ""}</div>;
                })}
                {sameDay(day, now) && now >= dayStart && now <= dayEnd ? <div className="pointer-events-none absolute inset-x-0 z-10 border-t-2 border-red-500" style={{ top: px(now) }} /> : null}
                {mine.map((v) => {
                    const top = px(new Date(v.startsAt)), bottom = px(new Date(v.endsAt));
                    return (
                        <div key={v.id} className="absolute inset-x-0.5 z-[5]" style={{ top, height: Math.max(22, bottom - top - 1) }}>
                            <VisitChip v={v} onOpen={(x) => setDlg({ visit: x, draft: null })} draggable={canWrite} techId={tech.id} />
                        </div>
                    );
                })}
            </div>
        );
    }

    return (
        <PageShell>
            <PageHeader
                title="Dispatch board"
                description="Who is going where. Drag a visit to move it, or drag a ticket from the list onto a technician to book it."
                actions={
                    <>
                        <Button variant="outline" className="gap-1.5" onClick={() => setAvail(true)}><Clock className="h-4 w-4" aria-hidden />Hours and time off</Button>
                        {canWrite ? <Button className="gap-1.5" onClick={() => setDlg({ visit: null, draft: { startsAt: (() => { const d = new Date(from); d.setHours(9, 0, 0, 0); return d; })() } })}><Plus className="h-4 w-4" aria-hidden />New visit</Button> : null}
                    </>
                }
            />

            <div className="flex flex-wrap items-center gap-2">
                <div className="flex items-center gap-1">
                    <Button variant="outline" size="icon" aria-label="Previous" onClick={() => setAnchor((a) => addDays(a, view === "day" ? -1 : -7))}><ChevronLeft className="h-4 w-4" /></Button>
                    <Button variant="outline" onClick={() => setAnchor(startOfDay(new Date()))}>Today</Button>
                    <Button variant="outline" size="icon" aria-label="Next" onClick={() => setAnchor((a) => addDays(a, view === "day" ? 1 : 7))}><ChevronRight className="h-4 w-4" /></Button>
                </div>
                <Input aria-label="Go to date" type="date" className="w-40" value={`${anchor.getFullYear()}-${String(anchor.getMonth() + 1).padStart(2, "0")}-${String(anchor.getDate()).padStart(2, "0")}`} onChange={(e) => { if (e.target.value) setAnchor(startOfDay(new Date(`${e.target.value}T12:00:00`))); }} />
                <SegmentedTabs label="View" items={[{ key: "day", label: "Day" }, { key: "week", label: "Week" }]} value={view} onChange={(k) => setView(k as "day" | "week")} />
                <p className="text-sm font-medium" aria-live="polite">{rangeLabel}</p>
                <p className="ml-auto text-xs text-muted-foreground">Shown in your time zone ({browserZone()})</p>
            </div>

            {techs.length > 1 ? (
                <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Technicians shown">
                    <span className="text-xs text-muted-foreground">Show:</span>
                    <button type="button" className={`rounded-full border px-2.5 py-0.5 text-xs ${shown.length === 0 && !everyone ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`} onClick={() => { setShown([]); setEveryone(false); }}>Scheduled people</button>
                    <button type="button" className={`rounded-full border px-2.5 py-0.5 text-xs ${shown.length === 0 && everyone ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`} onClick={() => { setShown([]); setEveryone(true); }}>Everyone</button>
                    {techs.map((t) => (
                        <button key={t.id} type="button" aria-pressed={shown.includes(t.id)} className={`rounded-full border px-2.5 py-0.5 text-xs ${shown.includes(t.id) ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`} onClick={() => setShown((cur) => (cur.includes(t.id) ? cur.filter((x) => x !== t.id) : [...cur, t.id]))}>{t.name}</button>
                    ))}
                </div>
            ) : null}

            {error ? <div role="alert" className="flex items-center gap-2 rounded-md border border-red-600/40 bg-red-500/10 p-3 text-sm"><AlertTriangle className="h-4 w-4" aria-hidden />{error}</div> : null}

            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
                <div className="min-w-0 overflow-x-auto rounded-lg border bg-card">
                    {columns.length === 0 ? <p className="p-6 text-sm text-muted-foreground">No technicians to show.</p> : view === "day" ? (
                        <div className="grid min-w-[40rem]" style={{ gridTemplateColumns: `3.5rem repeat(${columns.length}, minmax(10rem, 1fr))` }}>
                            <div className="sticky top-0 z-10 border-b bg-card" />
                            {columns.map((t) => <div key={t.id} className="sticky top-0 z-10 truncate border-b border-l bg-card px-2 py-1.5 text-sm font-medium">{t.name}<span className="block text-[11px] font-normal text-muted-foreground">{t.configured ? t.timeZone : "no hours set"}</span></div>)}
                            <div className="relative" style={{ height: gridH }}>
                                {hours.map((h, i) => <div key={h} className="absolute right-1 -translate-y-2 text-[11px] text-muted-foreground" style={{ top: i * HOUR_PX }}>{i === 0 ? "" : `${String(h).padStart(2, "0")}:00`}</div>)}
                            </div>
                            {columns.map((t) => dayColumn(t, days[0]))}
                        </div>
                    ) : (
                        <div className="grid min-w-[52rem]" style={{ gridTemplateColumns: `9rem repeat(7, minmax(6rem, 1fr))` }}>
                            <div className="border-b bg-card" />
                            {days.map((d) => <div key={d.toDateString()} className={`border-b border-l px-2 py-1.5 text-center text-sm font-medium ${sameDay(d, now) ? "bg-primary/10" : ""}`}>{dayLabel(d)}</div>)}
                            {columns.map((t) => (
                                <React.Fragment key={t.id}>
                                    <div className="border-b px-2 py-2 text-sm font-medium">{t.name}</div>
                                    {days.map((d) => {
                                        const ds = startOfDay(d), de = addDays(ds, 1);
                                        const mine = visits.filter((v) => v.techs.some((x) => x.id === t.id) && v.status !== "cancelled" && new Date(v.endsAt) > ds && new Date(v.startsAt) < de);
                                        const myOff = off.filter((o) => o.userId === t.id && new Date(o.endsAt) > ds && new Date(o.startsAt) < de);
                                        const worksNoon = isWorking(new Date(ds.getTime() + 12 * 3600_000), t);
                                        return (
                                            <div
                                                key={d.toDateString()}
                                                className={`min-h-[5.5rem] space-y-1 border-b border-l p-1 ${worksNoon ? "" : "bg-muted/60"}`}
                                                onDragOver={(e) => { if (canWrite) e.preventDefault(); }}
                                                onDrop={(e) => dropOnCell(e, t, d)}
                                                data-testid={`cell-${t.id}-${d.getDate()}`}
                                            >
                                                {myOff.map((o) => <div key={o.id} className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">Time off{o.reason ? `: ${o.reason}` : ""}</div>)}
                                                {mine.map((v) => <VisitChip key={v.id} v={v} compact onOpen={(x) => setDlg({ visit: x, draft: null })} draggable={canWrite} techId={t.id} />)}
                                            </div>
                                        );
                                    })}
                                </React.Fragment>
                            ))}
                        </div>
                    )}
                </div>

                <aside className="min-w-0 rounded-lg border bg-card p-3" aria-label="Tickets without a visit">
                    <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold"><CalendarClock className="h-4 w-4" aria-hidden />Needs a visit</h2>
                    <div className="relative mb-2">
                        <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden />
                        <Input aria-label="Search tickets without a visit" placeholder="Search" className="pl-8" value={sideQ} onChange={(e) => setSideQ(e.target.value)} />
                    </div>
                    <ul className="max-h-[32rem] space-y-1.5 overflow-y-auto">
                        {side.map((t) => (
                            <li
                                key={t.id}
                                draggable={canWrite}
                                onDragStart={(e) => { e.dataTransfer.setData("text/plain", JSON.stringify({ type: "ticket", id: t.id, label: `#${t.number} ${t.subject}` } satisfies DragData)); e.dataTransfer.effectAllowed = "copyMove"; }}
                                className="rounded-md border p-2 text-sm"
                            >
                                <p className="font-medium">#{t.number} <span className="font-normal">{t.subject}</span></p>
                                <p className="text-xs text-muted-foreground">{[t.clientName, t.priority, t.dueAt ? `due ${new Date(t.dueAt).toLocaleDateString()}` : ""].filter(Boolean).join(" - ")}</p>
                                {canWrite ? <Button variant="outline" size="sm" className="mt-1.5" onClick={() => setDlg({ visit: null, draft: { ticketId: t.id, ticketLabel: `#${t.number} ${t.subject}`, startsAt: (() => { const d = new Date(from); d.setHours(9, 0, 0, 0); return d; })() } })}>Schedule</Button> : null}
                            </li>
                        ))}
                        {side.length === 0 ? <li className="py-4 text-center text-sm text-muted-foreground">Every open ticket has a visit, or none need one.</li> : null}
                    </ul>
                </aside>
            </div>

            <VisitDialog
                open={dlg !== null}
                onClose={() => setDlg(null)}
                onSaved={refresh}
                visit={dlg?.visit ?? null}
                draft={dlg?.draft ?? null}
                techs={techs}
                canWrite={canWrite}
                canLogTime={canLogTime}
            />
            <AvailabilityDialog open={avail} onClose={() => setAvail(false)} techs={techs} canWrite={canWrite} onChanged={refresh} />
        </PageShell>
    );
}

export default function CalendarPage() {
    return (
        <PermGate require="schedule.read" title="Calendar" message="You do not have permission to see the schedule.">
            <Board />
        </PermGate>
    );
}
