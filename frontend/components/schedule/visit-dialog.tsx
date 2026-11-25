"use client";

// Book, change, finish or cancel a visit. The times are typed on the wall clock of the visit's own time zone, so
// "9:00 in London" stays 9:00 in London whoever is looking. Clashes (a technician already booked, time off, outside
// working hours) are shown before anything is saved and can be overridden on purpose.
import * as React from "react";
import Link from "next/link";
import { AlertTriangle, Download, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/use-toast";
import {
    STATUS_LABEL, allZones, browserZone, fromZonedInput, notifiedText, schedule, toZonedInput,
    type Conflict, type Tech, type Unscheduled, type Visit, type VisitInput, type VisitStatus,
} from "@/lib/schedule-api";

export type VisitDraft = { ticketId?: string; ticketLabel?: string; startsAt?: Date; techId?: string; durationMin?: number };

const DURATIONS = [30, 45, 60, 90, 120, 180, 240, 480];

function TicketPicker({ onPick }: { onPick: (t: Unscheduled) => void }) {
    const [q, setQ] = React.useState("");
    const [rows, setRows] = React.useState<Unscheduled[]>([]);
    React.useEffect(() => {
        let stale = false;
        const t = setTimeout(() => {
            schedule.unscheduled(q.trim()).then((r) => { if (!stale) setRows(r.items.slice(0, 8)); }).catch(() => { if (!stale) setRows([]); });
        }, 200);
        return () => { stale = true; clearTimeout(t); };
    }, [q]);
    return (
        <div className="space-y-2">
            <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" aria-hidden />
                <Input aria-label="Search tickets without a visit" placeholder="Find a ticket by number or subject" className="pl-9" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <ul className="max-h-44 space-y-1 overflow-y-auto">
                {rows.map((t) => (
                    <li key={t.id}>
                        <button type="button" className="w-full rounded-md border p-2 text-left text-sm hover:bg-accent" onClick={() => onPick(t)}>
                            <span className="font-medium">#{t.number}</span> {t.subject}
                            {t.clientName ? <span className="ml-2 text-xs text-muted-foreground">{t.clientName}</span> : null}
                        </button>
                    </li>
                ))}
                {rows.length === 0 ? <li className="py-3 text-center text-sm text-muted-foreground">No open tickets without a visit match.</li> : null}
            </ul>
        </div>
    );
}

export function VisitDialog({
    open, onClose, onSaved, visit, draft, techs, canWrite, canLogTime,
}: {
    open: boolean;
    onClose: () => void;
    onSaved: () => void;
    visit?: Visit | null;
    draft?: VisitDraft | null;
    techs: Tech[];
    canWrite: boolean;
    canLogTime: boolean;
}) {
    const editing = !!visit;
    const [ticket, setTicket] = React.useState<{ id: string; label: string } | null>(null);
    const [zone, setZone] = React.useState(browserZone());
    const [start, setStart] = React.useState("");
    const [duration, setDuration] = React.useState(60);
    const [techIds, setTechIds] = React.useState<string[]>([]);
    const [location, setLocation] = React.useState("");
    const [notes, setNotes] = React.useState("");
    const [status, setStatus] = React.useState<VisitStatus>("scheduled");
    const [notifyTechs, setNotifyTechs] = React.useState(true);
    const [notifyCustomer, setNotifyCustomer] = React.useState(false);
    const [logTime, setLogTime] = React.useState(true);
    const [minutes, setMinutes] = React.useState("");
    const [busy, setBusy] = React.useState(false);
    const [conflicts, setConflicts] = React.useState<Conflict[] | null>(null);
    const zones = React.useMemo(() => allZones(), []);

    // Fill the form whenever the dialog opens.
    React.useEffect(() => {
        if (!open) return;
        setConflicts(null);
        setBusy(false);
        if (visit) {
            const tz = visit.timeZone || browserZone();
            setTicket({ id: visit.ticketId, label: `#${visit.ticketNumber ?? ""} ${visit.ticketSubject ?? ""}`.trim() });
            setZone(tz);
            setStart(toZonedInput(visit.startsAt, tz));
            setDuration(Math.max(5, Math.round((new Date(visit.endsAt).getTime() - new Date(visit.startsAt).getTime()) / 60000)));
            setTechIds(visit.techs.map((t) => t.id));
            setLocation(visit.location ?? "");
            setNotes(visit.notes ?? "");
            setStatus(visit.status);
            setNotifyTechs(true);
            setNotifyCustomer(visit.customerNotifiedAt !== null);
        } else {
            const tz = browserZone();
            const at = draft?.startsAt ?? (() => { const d = new Date(); d.setMinutes(0, 0, 0); d.setHours(d.getHours() + 1); return d; })();
            setTicket(draft?.ticketId ? { id: draft.ticketId, label: draft.ticketLabel ?? "" } : null);
            setZone(tz);
            setStart(toZonedInput(at, tz));
            setDuration(draft?.durationMin ?? 60);
            setTechIds(draft?.techId ? [draft.techId] : []);
            setLocation("");
            setNotes("");
            setStatus("scheduled");
            setNotifyTechs(true);
            setNotifyCustomer(false);
        }
        setLogTime(true);
        setMinutes("");
    }, [open, visit, draft]);

    const startDate = start ? fromZonedInput(start, zone) : new Date(NaN);
    const endDate = new Date(startDate.getTime() + duration * 60000);
    const valid = !!ticket && !Number.isNaN(startDate.getTime()) && techIds.length > 0 && duration > 0;

    function body(force: boolean): VisitInput {
        if (!editing) {
            return { ticketId: ticket!.id, startsAt: startDate.toISOString(), endsAt: endDate.toISOString(), techIds, location, notes, timeZone: zone, notifyTechs, notifyCustomer, force };
        }
        // Only what was changed is sent, so editing a note does not move the visit or send a new invite.
        const v = visit!;
        const b: VisitInput = { notifyTechs, notifyCustomer, force };
        if (startDate.toISOString() !== v.startsAt || endDate.toISOString() !== v.endsAt) { b.startsAt = startDate.toISOString(); b.endsAt = endDate.toISOString(); }
        if ([...techIds].sort().join() !== v.techs.map((t) => t.id).sort().join()) b.techIds = techIds;
        if (location !== (v.location ?? "")) b.location = location;
        if (notes !== (v.notes ?? "")) b.notes = notes;
        if (zone !== v.timeZone) b.timeZone = zone;
        if (status !== v.status) {
            b.status = status;
            if (status === "done" && logTime && canLogTime && !v.timeEntryId) b.logTime = minutes.trim() ? { minutes: Number(minutes) } : {};
        }
        return b;
    }

    async function save(force = false) {
        if (!valid || busy) return;
        setBusy(true);
        try {
            const res = editing ? await schedule.update(visit!.id, body(force)) : await schedule.create(body(force));
            const sent = notifiedText(res.notified);
            toast({ title: editing ? "Visit updated" : "Visit booked", description: [sent, "timeLogged" in res && res.timeLogged ? `${res.timeLogged} minutes logged on the ticket` : ""].filter(Boolean).join(". ") || undefined });
            onSaved();
            onClose();
        } catch (e: any) {
            if (e?.status === 409 && !force) {
                try {
                    const c = await schedule.conflicts({ startsAt: startDate.toISOString(), endsAt: endDate.toISOString(), techIds, ignoreVisitId: visit?.id });
                    setConflicts(c.conflicts.length ? c.conflicts : [{ kind: "visit", userId: "", message: e?.message || "That time clashes with something else." }]);
                } catch {
                    setConflicts([{ kind: "visit", userId: "", message: e?.message || "That time clashes with something else." }]);
                }
            } else {
                toast({ title: "That did not work", description: e?.message, variant: "destructive" });
            }
        } finally {
            setBusy(false);
        }
    }

    async function quick(next: VisitStatus) {
        if (!visit) return;
        setBusy(true);
        try {
            const res = await schedule.update(visit.id, { status: next, notifyTechs: next === "cancelled", force: true });
            toast({ title: STATUS_LABEL[next], description: notifiedText(res.notified) || undefined });
            onSaved();
            onClose();
        } catch (e: any) {
            toast({ title: "That did not work", description: e?.message, variant: "destructive" });
        } finally {
            setBusy(false);
        }
    }

    async function remove() {
        if (!visit || !confirm("Delete this visit? The technicians are told it is cancelled.")) return;
        setBusy(true);
        try {
            await schedule.remove(visit.id);
            toast({ title: "Visit deleted" });
            onSaved();
            onClose();
        } catch (e: any) {
            toast({ title: "That did not work", description: e?.message, variant: "destructive" });
        } finally {
            setBusy(false);
        }
    }

    const readOnly = !canWrite;
    const toggleTech = (id: string) => setTechIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

    return (
        <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
            <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
                <DialogHeader>
                    <DialogTitle>{editing ? "Visit" : "Schedule a visit"}</DialogTitle>
                    <DialogDescription>
                        {editing && ticket ? <Link href={`/tickets/${ticket.id}`} className="underline underline-offset-2">{ticket.label}</Link> : "Pick a ticket, who goes, and when."}
                    </DialogDescription>
                </DialogHeader>

                {!editing && !ticket ? (
                    <TicketPicker onPick={(t) => setTicket({ id: t.id, label: `#${t.number} ${t.subject}` })} />
                ) : (
                    <div className="space-y-4">
                        {!editing && ticket ? (
                            <div className="flex items-center justify-between rounded-md border p-2 text-sm">
                                <span className="truncate">{ticket.label}</span>
                                {!draft?.ticketId ? <Button variant="ghost" size="sm" onClick={() => setTicket(null)}>Change</Button> : null}
                            </div>
                        ) : null}

                        <div className="grid gap-3 sm:grid-cols-3">
                            <div className="sm:col-span-2">
                                <Label htmlFor="visit-start">Starts ({zone})</Label>
                                <Input id="visit-start" type="datetime-local" value={start} disabled={readOnly} onChange={(e) => { setStart(e.target.value); setConflicts(null); }} />
                            </div>
                            <div>
                                <Label htmlFor="visit-duration">Length</Label>
                                <select id="visit-duration" className="h-10 w-full rounded-md border bg-background px-2 text-sm" disabled={readOnly} value={duration} onChange={(e) => { setDuration(Number(e.target.value)); setConflicts(null); }}>
                                    {[...new Set([...DURATIONS, duration])].sort((a, b) => a - b).map((m) => <option key={m} value={m}>{m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}` : `${m} min`}</option>)}
                                </select>
                            </div>
                        </div>
                        <div>
                            <Label htmlFor="visit-zone">Time zone of the visit</Label>
                            <Input id="visit-zone" list="visit-zones" value={zone} disabled={readOnly} onChange={(e) => {
                                const next = e.target.value;
                                // Keep the same instant when the zone is changed to a real one.
                                if (zones.includes(next) && !Number.isNaN(startDate.getTime())) setStart(toZonedInput(startDate, next));
                                setZone(next);
                            }} />
                            <datalist id="visit-zones">{zones.map((z) => <option key={z} value={z} />)}</datalist>
                            <p className="mt-1 text-xs text-muted-foreground">Invites and the customer&apos;s email show the time in this zone. Ends {Number.isNaN(endDate.getTime()) ? "" : endDate.toLocaleString()} your time.</p>
                        </div>

                        <fieldset>
                            <legend className="mb-1 text-sm font-medium">Technicians</legend>
                            <div className="grid max-h-36 gap-1 overflow-y-auto sm:grid-cols-2">
                                {techs.map((t) => (
                                    <label key={t.id} className="flex items-center gap-2 text-sm">
                                        <input type="checkbox" checked={techIds.includes(t.id)} disabled={readOnly} onChange={() => { toggleTech(t.id); setConflicts(null); }} />
                                        {t.name}
                                    </label>
                                ))}
                            </div>
                        </fieldset>

                        <div>
                            <Label htmlFor="visit-location">Where</Label>
                            <Input id="visit-location" value={location} maxLength={300} disabled={readOnly} placeholder="Address or room" onChange={(e) => setLocation(e.target.value)} />
                        </div>
                        <div>
                            <Label htmlFor="visit-notes">Notes for the technician</Label>
                            <Textarea id="visit-notes" rows={3} maxLength={2000} value={notes} disabled={readOnly} onChange={(e) => setNotes(e.target.value)} />
                        </div>

                        {editing ? (
                            <div>
                                <Label htmlFor="visit-status">Status</Label>
                                <select id="visit-status" className="h-10 w-full rounded-md border bg-background px-2 text-sm" disabled={readOnly} value={status} onChange={(e) => setStatus(e.target.value as VisitStatus)}>
                                    {(Object.keys(STATUS_LABEL) as VisitStatus[]).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
                                </select>
                                {status === "done" && visit!.status !== "done" && !visit!.timeEntryId ? (
                                    canLogTime ? (
                                        <div className="mt-2 space-y-2 rounded-md border p-2 text-sm">
                                            <label className="flex items-center gap-2"><input type="checkbox" checked={logTime} onChange={(e) => setLogTime(e.target.checked)} />Log the time on the ticket</label>
                                            {logTime ? (
                                                <div className="flex items-center gap-2">
                                                    <Input aria-label="Minutes to log" inputMode="numeric" className="w-28" placeholder={String(duration)} value={minutes} onChange={(e) => setMinutes(e.target.value.replace(/\D/g, ""))} />
                                                    <span className="text-muted-foreground">minutes (blank: the length of the visit)</span>
                                                </div>
                                            ) : null}
                                        </div>
                                    ) : <p className="mt-1 text-xs text-muted-foreground">You can mark it done, but adding time needs another right.</p>
                                ) : null}
                                {visit!.timeEntryId ? <p className="mt-1 text-xs text-muted-foreground">Its time is already logged on the ticket.</p> : null}
                            </div>
                        ) : null}

                        {!readOnly ? (
                            <div className="space-y-1 text-sm">
                                <label className="flex items-center gap-2"><input type="checkbox" checked={notifyTechs} onChange={(e) => setNotifyTechs(e.target.checked)} />Email the technicians an invite with a calendar file</label>
                                <label className="flex items-center gap-2"><input type="checkbox" checked={notifyCustomer} onChange={(e) => setNotifyCustomer(e.target.checked)} />Email the customer&apos;s contact</label>
                            </div>
                        ) : null}

                        {conflicts ? (
                            <div role="alert" className="rounded-md border border-amber-600/40 bg-amber-500/10 p-3 text-sm">
                                <p className="mb-1 flex items-center gap-1.5 font-medium"><AlertTriangle className="h-4 w-4" aria-hidden />This clashes</p>
                                <ul className="list-disc space-y-0.5 pl-5">{conflicts.map((c, i) => <li key={i}>{c.message}</li>)}</ul>
                            </div>
                        ) : null}
                    </div>
                )}

                <DialogFooter className="flex-wrap gap-2 sm:justify-between">
                    <div className="flex flex-wrap gap-2">
                        {editing && !readOnly ? (
                            <>
                                {visit!.status === "scheduled" ? <Button variant="outline" size="sm" disabled={busy} onClick={() => void quick("en_route")}>En route</Button> : null}
                                {visit!.status === "scheduled" || visit!.status === "en_route" ? <Button variant="outline" size="sm" disabled={busy} onClick={() => void quick("on_site")}>On site</Button> : null}
                                {visit!.status !== "cancelled" && visit!.status !== "done" ? <Button variant="outline" size="sm" disabled={busy} onClick={() => void quick("cancelled")}>Cancel visit</Button> : null}
                                <Button variant="ghost" size="sm" disabled={busy} onClick={() => void remove()}>Delete</Button>
                            </>
                        ) : null}
                        {editing ? <Button asChild variant="ghost" size="sm"><a href={schedule.icsUrl(visit!.id)} className="gap-1"><Download className="h-3.5 w-3.5" aria-hidden />Calendar file</a></Button> : null}
                    </div>
                    <div className="flex gap-2">
                        <Button variant="outline" onClick={onClose}>{readOnly ? "Close" : "Cancel"}</Button>
                        {!readOnly && (editing || ticket) ? (
                            conflicts ? <Button disabled={busy || !valid} onClick={() => void save(true)}>{editing ? "Save anyway" : "Book anyway"}</Button>
                                : <Button disabled={busy || !valid} onClick={() => void save(false)}>{editing ? "Save" : "Book visit"}</Button>
                        ) : null}
                    </div>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
