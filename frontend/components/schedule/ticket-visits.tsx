"use client";

// Visits on a ticket: the ones booked, a button to schedule another, and a way to open or change one.
import * as React from "react";
import Link from "next/link";
import { CalendarClock, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { VisitDialog } from "@/components/schedule/visit-dialog";
import { STATUS_LABEL, schedule, type Tech, type Visit } from "@/lib/schedule-api";
import { useMe } from "@/lib/use-me";
import { hasPerm } from "@/lib/permissions";

export const statusClass = (s: string) =>
    s === "done" ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
        : s === "cancelled" ? "bg-muted text-muted-foreground line-through"
            : s === "on_site" ? "bg-violet-500/15 text-violet-700 dark:text-violet-300"
                : s === "en_route" ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
                    : "bg-sky-500/15 text-sky-700 dark:text-sky-300";

export function TicketVisitsCard({ ticketId, ticketLabel, closed }: { ticketId: string; ticketLabel: string; closed?: boolean }) {
    const { permissions } = useMe();
    const canRead = hasPerm(permissions, "schedule.read");
    const canWrite = hasPerm(permissions, "schedule.write");
    const canLogTime = hasPerm(permissions, "tickets.time.manual");
    const [visits, setVisits] = React.useState<Visit[] | null>(null);
    const [techs, setTechs] = React.useState<Tech[]>([]);
    const [open, setOpen] = React.useState(false);
    const [current, setCurrent] = React.useState<Visit | null>(null);
    const draft = React.useMemo(() => ({ ticketId, ticketLabel }), [ticketId, ticketLabel]);

    const load = React.useCallback(() => {
        schedule.visits({ ticketId }).then((r) => setVisits(r.items)).catch(() => setVisits([]));
    }, [ticketId]);
    React.useEffect(() => {
        if (!canRead) return;
        load();
        schedule.techs().then((r) => setTechs(r.items)).catch(() => null);
    }, [canRead, load]);

    if (!canRead) return null;
    return (
        <div>
            <div className="mb-2 flex items-center justify-between">
                <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Visits</h3>
                {canWrite && !closed ? (
                    <Button size="sm" variant="outline" className="gap-1" onClick={() => { setCurrent(null); setOpen(true); }}><Plus className="h-3.5 w-3.5" aria-hidden />Schedule visit</Button>
                ) : null}
            </div>
            {visits === null ? <p className="text-sm text-muted-foreground">Loading...</p> : visits.length === 0 ? (
                <p className="text-sm text-muted-foreground">No visits booked for this ticket.</p>
            ) : (
                <ul className="space-y-1.5">
                    {visits.map((v) => (
                        <li key={v.id}>
                            <button type="button" className="w-full rounded-md border p-2 text-left text-sm hover:bg-accent" onClick={() => { setCurrent(v); setOpen(true); }}>
                                <span className="flex items-center justify-between gap-2">
                                    <span className="flex items-center gap-1.5 font-medium"><CalendarClock className="h-3.5 w-3.5" aria-hidden />{new Date(v.startsAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</span>
                                    <span className={`rounded-full px-2 py-0.5 text-xs ${statusClass(v.status)}`}>{STATUS_LABEL[v.status]}</span>
                                </span>
                                <span className="block text-xs text-muted-foreground">{v.techs.map((t) => t.name).join(", ")}{v.location ? ` at ${v.location}` : ""}</span>
                            </button>
                        </li>
                    ))}
                </ul>
            )}
            <p className="mt-2 text-xs text-muted-foreground"><Link href="/calendar" className="underline underline-offset-2">Open the dispatch board</Link></p>
            <VisitDialog
                open={open}
                onClose={() => setOpen(false)}
                onSaved={load}
                visit={current}
                draft={current ? null : draft}
                techs={techs}
                canWrite={canWrite}
                canLogTime={canLogTime}
            />
        </div>
    );
}
