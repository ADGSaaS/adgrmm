"use client";

// A technician's weekly working hours, their time zone, and blocks of time off.
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/use-toast";
import { allZones, browserZone, fromZonedInput, schedule, type Tech, type TimeOff, type WorkDay } from "@/lib/schedule-api";

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export function AvailabilityDialog({
    open, onClose, techs, initialTechId, canWrite, onChanged,
}: {
    open: boolean;
    onClose: () => void;
    techs: Tech[];
    initialTechId?: string;
    canWrite: boolean;
    onChanged: () => void;
}) {
    const [techId, setTechId] = React.useState("");
    const [zone, setZone] = React.useState("UTC");
    const [hours, setHours] = React.useState<WorkDay[]>([]);
    const [off, setOff] = React.useState<TimeOff[]>([]);
    const [from, setFrom] = React.useState("");
    const [to, setTo] = React.useState("");
    const [reason, setReason] = React.useState("");
    const [busy, setBusy] = React.useState(false);
    const zones = React.useMemo(() => allZones(), []);

    React.useEffect(() => {
        if (open) setTechId((cur) => cur || initialTechId || techs[0]?.id || "");
    }, [open, initialTechId, techs]);

    const tech = techs.find((t) => t.id === techId);
    React.useEffect(() => {
        if (!tech) return;
        setZone(tech.timeZone || browserZone());
        setHours(tech.hours.map((h) => ({ ...h })));
    }, [tech]);

    const loadOff = React.useCallback(() => {
        const now = new Date();
        const a = new Date(now.getTime() - 7 * 86400_000).toISOString();
        const b = new Date(now.getTime() + 365 * 86400_000).toISOString();
        schedule.timeOff(a, b).then((r) => setOff(r.items)).catch(() => setOff([]));
    }, []);
    React.useEffect(() => { if (open) loadOff(); }, [open, loadOff]);

    async function run(fn: () => Promise<unknown>, ok: string) {
        setBusy(true);
        try {
            await fn();
            toast({ title: ok });
            onChanged();
        } catch (e: any) {
            toast({ title: "That did not work", description: e?.message, variant: "destructive" });
        } finally {
            setBusy(false);
        }
    }

    const mine = off.filter((o) => o.userId === techId);
    const setDay = (i: number, patch: Partial<WorkDay>) => setHours((cur) => cur.map((d, j) => (j === i ? { ...d, ...patch } : d)));

    return (
        <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
            <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
                <DialogHeader>
                    <DialogTitle>Working hours and time off</DialogTitle>
                    <DialogDescription>The board shades the hours outside work and warns when a visit is booked there, or over time off.</DialogDescription>
                </DialogHeader>
                <div>
                    <Label htmlFor="av-tech">Technician</Label>
                    <select id="av-tech" className="h-10 w-full rounded-md border bg-background px-2 text-sm" value={techId} onChange={(e) => setTechId(e.target.value)}>
                        {techs.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                    </select>
                </div>
                <div>
                    <Label htmlFor="av-zone">Their time zone</Label>
                    <Input id="av-zone" list="av-zones" value={zone} disabled={!canWrite} onChange={(e) => setZone(e.target.value)} />
                    <datalist id="av-zones">{zones.map((z) => <option key={z} value={z} />)}</datalist>
                </div>
                <div className="space-y-1.5">
                    {hours.map((d, i) => (
                        <div key={DAYS[i]} className="flex items-center gap-2 text-sm">
                            <label className="flex w-32 items-center gap-2"><input type="checkbox" checked={d.on} disabled={!canWrite} onChange={(e) => setDay(i, { on: e.target.checked })} />{DAYS[i]}</label>
                            <Input aria-label={`${DAYS[i]} start`} type="time" className="w-28" value={d.start} disabled={!canWrite || !d.on} onChange={(e) => setDay(i, { start: e.target.value })} />
                            <span>to</span>
                            <Input aria-label={`${DAYS[i]} end`} type="time" className="w-28" value={d.end} disabled={!canWrite || !d.on} onChange={(e) => setDay(i, { end: e.target.value })} />
                        </div>
                    ))}
                </div>
                {canWrite ? <div><Button disabled={busy || !techId} onClick={() => void run(() => schedule.setAvailability(techId, { timeZone: zone, hours }), "Working hours saved")}>Save working hours</Button></div> : null}

                <div className="border-t pt-3">
                    <h4 className="mb-2 text-sm font-semibold">Time off</h4>
                    <ul className="mb-3 space-y-1">
                        {mine.map((o) => (
                            <li key={o.id} className="flex items-center justify-between gap-2 rounded-md border p-2 text-sm">
                                <span>{new Date(o.startsAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })} to {new Date(o.endsAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}{o.reason ? ` (${o.reason})` : ""}</span>
                                {canWrite ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(async () => { await schedule.removeTimeOff(o.id); loadOff(); }, "Time off removed")}>Remove</Button> : null}
                            </li>
                        ))}
                        {mine.length === 0 ? <li className="text-sm text-muted-foreground">No time off booked.</li> : null}
                    </ul>
                    {canWrite ? (
                        <form
                            className="grid gap-2 sm:grid-cols-2"
                            onSubmit={(e) => {
                                e.preventDefault();
                                const a = fromZonedInput(from, zone);
                                const b = fromZonedInput(to, zone);
                                void run(async () => {
                                    await schedule.addTimeOff({ userId: techId, startsAt: a.toISOString(), endsAt: b.toISOString(), reason: reason.trim() || undefined });
                                    setFrom(""); setTo(""); setReason("");
                                    loadOff();
                                }, "Time off added");
                            }}
                        >
                            <div><Label htmlFor="off-from">From ({zone})</Label><Input id="off-from" type="datetime-local" required value={from} onChange={(e) => setFrom(e.target.value)} /></div>
                            <div><Label htmlFor="off-to">To</Label><Input id="off-to" type="datetime-local" required value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} /></div>
                            <div className="sm:col-span-2"><Label htmlFor="off-reason">Reason (optional)</Label><Input id="off-reason" maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Holiday, training..." /></div>
                            <div className="sm:col-span-2"><Button type="submit" variant="outline" disabled={busy || !techId || !from || !to}>Add time off</Button></div>
                        </form>
                    ) : null}
                </div>
                <DialogFooter><Button variant="outline" onClick={onClose}>Done</Button></DialogFooter>
            </DialogContent>
        </Dialog>
    );
}


