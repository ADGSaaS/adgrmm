"use client";

// Time worked on a ticket: a stopwatch you start and stop on purpose, every entry with who and what, and a way to add time by hand.
// The stopwatch lives on the server (see lib/use-ticket-timer.ts); entries are the ordinary time entries billing approves and invoices.
import * as React from "react";
import { Pause, Play, Square, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/use-toast";
import { Pill } from "@/components/policies/shared";
import { billing, today, type TimeEntry } from "@/lib/billing-api";
import { jfetch } from "@/lib/api";
import { clock, formatMinutes, parseDuration } from "@/lib/duration";
import type { TicketTimer } from "@/lib/use-ticket-timer";
import { useMe } from "@/lib/use-me";
import { hasPerm } from "@/lib/permissions";
import { cn } from "@/lib/utils";

const messageOf = (e: unknown) => {
    const raw = e instanceof Error ? e.message : "Something went wrong.";
    try { const j = JSON.parse(raw) as { message?: string | string[] }; return Array.isArray(j.message) ? j.message.join(" ") : j.message ?? raw; } catch { return raw; }
};

export function TicketTimeCard({ ticketId, timer, closed, refreshKey = 0, onChanged }: { ticketId: string; timer: TicketTimer; closed: boolean; refreshKey?: number; onChanged?: () => void }) {
    const { user, permissions } = useMe();
    // Typing time in, or changing a logged entry, is its own right. The timer needs only the right to work tickets.
    const canManual = hasPerm(permissions, "tickets.time.manual");
    const [entries, setEntries] = React.useState<TimeEntry[] | null>(null);
    const [stopping, setStopping] = React.useState(false);
    const [stopMinutes, setStopMinutes] = React.useState("");
    const [stopNote, setStopNote] = React.useState("");
    const [stopBillable, setStopBillable] = React.useState(true);
    const [duration, setDuration] = React.useState("");
    const [workDate, setWorkDate] = React.useState(today());
    const [note, setNote] = React.useState("");
    const [billable, setBillable] = React.useState(true);
    const [tried, setTried] = React.useState(false);
    const [saving, setSaving] = React.useState(false);
    const [manualError, setManualError] = React.useState<string | null>(null);

    const load = React.useCallback(() => {
        billing.time({ ticketId }).then((r) => setEntries(r.items)).catch(() => setEntries([]));
    }, [ticketId]);
    React.useEffect(load, [load, refreshKey]);

    const list = React.useMemo(() => entries ?? [], [entries]);
    const total = list.reduce((n, e) => n + e.minutes, 0);
    const billableTotal = list.filter((e) => e.billable).reduce((n, e) => n + e.minutes, 0);
    const byPerson = React.useMemo(() => {
        const m = new Map<string, number>();
        for (const e of list) m.set(e.user.name, (m.get(e.user.name) ?? 0) + e.minutes);
        return [...m.entries()].sort((a, b) => b[1] - a[1]);
    }, [list]);

    const timerMinutes = Math.max(1, Math.ceil(timer.seconds / 60));
    const longRun = timer.seconds > 8 * 3600;

    const openStop = () => { setStopMinutes(String(timerMinutes)); setStopNote(""); setStopBillable(true); setStopping(true); };
    const confirmStop = async () => {
        const minutes = parseDuration(stopMinutes);
        if (canManual && minutes === null) return toast({ title: "Enter the time to log", description: "For example 25, 1:30 or 1h 30m.", variant: "destructive" });
        const r = await timer.stop({ ...(canManual ? { minutes: minutes ?? undefined } : {}), billable: stopBillable, ...(stopNote.trim() ? { note: stopNote.trim() } : {}) });
        if (r) {
            toast({ title: `Logged ${formatMinutes(r.minutes)}` });
            setStopping(false);
            load();
            onChanged?.();
        }
    };

    const minutesTyped = parseDuration(duration);
    const addByHand = async (event: React.FormEvent) => {
        event.preventDefault();
        setTried(true);
        setManualError(null);
        if (minutesTyped === null || !/^\d{4}-\d{2}-\d{2}$/.test(workDate)) return;
        setSaving(true);
        try {
            await billing.createTime({ ticketId, workDate, minutes: minutesTyped, billable, ...(note.trim() ? { note: note.trim() } : {}) });
            setDuration(""); setNote(""); setTried(false);
            load();
            onChanged?.();
        } catch (e) {
            setManualError(messageOf(e));
        } finally {
            setSaving(false);
        }
    };

    const remove = async (e: TimeEntry) => {
        if (!window.confirm(`Delete ${formatMinutes(e.minutes)} logged by ${e.user.name}?`)) return;
        try { await billing.deleteTime(e.id); load(); onChanged?.(); } catch (err) { toast({ title: "Could not delete that", description: messageOf(err), variant: "destructive" }); }
    };
    const toggleBillable = async (e: TimeEntry) => {
        try {
            await jfetch(`/api/billing/time/${e.id}`, { method: "PUT", body: { workDate: e.workDate, minutes: e.minutes, billable: !e.billable, note: e.note ?? undefined, ...(e.client ? { clientId: e.client.id } : {}) } });
            load();
        } catch (err) { toast({ title: "Could not change that", description: messageOf(err), variant: "destructive" }); }
    };

    const mine = (e: TimeEntry) => !user?.id || e.user.id === user.id;

    return (
        <div className="grid gap-3 text-sm">
            {/* The stopwatch */}
            <div className={cn("rounded-lg border p-3", timer.running ? "border-emerald-500/50 bg-emerald-500/10" : "border-border/70 bg-card/40")}>
                <div className="flex items-center justify-between gap-2">
                    <div>
                        <div className="text-2xl font-semibold tabular-nums tracking-tight" aria-live="off">{clock(timer.seconds)}</div>
                        <div className="text-xs text-muted-foreground">
                            {!timer.available ? "Timing is not available to you" : timer.running ? "Running, on the server, so it keeps going if you close this page" : timer.started ? "Paused" : "Not started"}
                        </div>
                    </div>
                    {timer.available && (
                        <div className="flex flex-wrap justify-end gap-1.5">
                            {timer.running ? (
                                <Button type="button" size="sm" variant="outline" disabled={timer.busy} onClick={() => void timer.pause()}><Pause className="mr-1 h-4 w-4" aria-hidden /> Pause</Button>
                            ) : (
                                <Button type="button" size="sm" variant="success" disabled={timer.busy || closed} title={closed ? "This ticket is closed" : undefined} onClick={() => void timer.start()}><Play className="mr-1 h-4 w-4" aria-hidden /> {timer.started ? "Resume" : "Start"}</Button>
                            )}
                            {timer.started && <Button type="button" size="sm" disabled={timer.busy} onClick={openStop}><Square className="mr-1 h-4 w-4" aria-hidden /> Stop and log</Button>}
                        </div>
                    )}
                </div>
                {timer.error && <p role="alert" className="mt-2 text-xs text-destructive">{timer.error}</p>}
                {longRun && <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">This has been running for over 8 hours. If that is not right, change the minutes when you stop.</p>}
                <p className="mt-1 text-xs text-muted-foreground">Starting a timer on another ticket pauses this one.</p>

                {stopping && (
                    <div className="mt-3 grid gap-2 border-t border-border/60 pt-3">
                        <div className="flex flex-wrap gap-2">
                            <Input aria-label="Time to log" className="w-28" value={canManual ? stopMinutes : formatMinutes(timerMinutes)} readOnly={!canManual} disabled={!canManual} title={canManual ? undefined : "The timer's time is logged as it is. Changing it needs permission."} onChange={(e) => setStopMinutes(e.target.value)} placeholder="25, 1:30, 1h" />
                            <Input aria-label="What was done" className="min-w-0 flex-1" value={stopNote} maxLength={500} onChange={(e) => setStopNote(e.target.value)} placeholder="What was done" />
                        </div>
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <label className="flex items-center gap-1.5 text-xs"><Checkbox checked={stopBillable} onCheckedChange={(v) => setStopBillable(v === true)} /> Billable</label>
                            <div className="flex gap-1.5">
                                <Button type="button" size="sm" variant="ghost" disabled={timer.busy} onClick={() => { if (window.confirm("Throw this timer away without logging anything?")) { void timer.discard(); setStopping(false); } }}><Trash2 className="mr-1 h-4 w-4" aria-hidden /> Discard</Button>
                                <Button type="button" size="sm" variant="outline" disabled={timer.busy} onClick={() => setStopping(false)}>Keep timing</Button>
                                <Button type="button" size="sm" variant="success" disabled={timer.busy} onClick={() => void confirmStop()}>Log {canManual ? (parseDuration(stopMinutes) ? formatMinutes(parseDuration(stopMinutes)!) : "time") : formatMinutes(timerMinutes)}</Button>
                            </div>
                        </div>
                    </div>
                )}
            </div>

            {/* What has been logged */}
            <div>
                <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-3 text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">{total ? `${formatMinutes(total)} logged` : "Nothing logged yet"}</span>
                    {total > 0 && <span>{formatMinutes(billableTotal)} billable · {formatMinutes(total - billableTotal)} not</span>}
                </div>
                {byPerson.length > 1 && <div className="mb-1 text-xs text-muted-foreground">{byPerson.map(([n, m]) => `${n} ${formatMinutes(m)}`).join(" · ")}</div>}
                {entries === null && <p className="text-xs text-muted-foreground">Loading…</p>}
                {list.length > 0 && (
                    <ul className="max-h-56 divide-y divide-border/60 overflow-y-auto rounded-md border border-border/60 text-xs">
                        {list.map((e) => (
                            <li key={e.id} className="grid gap-0.5 px-2.5 py-2">
                                <div className="flex flex-wrap items-center justify-between gap-1">
                                    <span className="font-medium tabular-nums">{formatMinutes(e.minutes)} <span className="font-normal text-muted-foreground">· {e.workDate}</span></span>
                                    <span className="flex flex-wrap items-center gap-1">
                                        <button type="button" disabled={e.invoiced || !mine(e)} onClick={() => void toggleBillable(e)} title={e.invoiced ? "Already on an invoice" : mine(e) ? "Click to change" : "Only the person who logged it can change it"}>
                                            <Pill tone={e.billable ? "good" : "muted"}>{e.billable ? "Billable" : "Not billable"}</Pill>
                                        </button>
                                        {e.invoiced ? <Pill>Invoiced</Pill> : e.status === "approved" ? <Pill tone="good">Approved</Pill> : <Pill tone="warn">To approve</Pill>}
                                        {!e.invoiced && mine(e) && (
                                            <button type="button" aria-label={`Delete ${formatMinutes(e.minutes)}`} className="text-muted-foreground hover:text-destructive" onClick={() => void remove(e)}><Trash2 className="h-3.5 w-3.5" aria-hidden /></button>
                                        )}
                                    </span>
                                </div>
                                <div className="text-muted-foreground">{e.user.name}{e.note ? ` — ${e.note}` : ""}</div>
                            </li>
                        ))}
                    </ul>
                )}
            </div>

            {/* Adding time by hand: needs its own right */}
            {!canManual ? (
                <p className="border-t border-border pt-3 text-xs text-muted-foreground">Adding time by hand needs permission. Use the timer above, or ask an administrator.</p>
            ) : (
            <form onSubmit={addByHand} className="grid gap-2 border-t border-border pt-3" noValidate>
                <div className="text-xs font-medium text-foreground">Add time by hand</div>
                <div className="flex flex-wrap gap-2">
                    <div className="grid gap-0.5">
                        <Input aria-label="Time spent" aria-invalid={tried && minutesTyped === null} className={cn("w-28", tried && minutesTyped === null && "border-destructive")} value={duration} onChange={(e) => setDuration(e.target.value)} placeholder="25, 1:30, 1h 30m" />
                        <p className={cn("min-h-4 text-[11px]", tried && minutesTyped === null ? "text-destructive" : "text-muted-foreground")}>{tried && minutesTyped === null ? "Enter a time up to 24 h" : minutesTyped ? formatMinutes(minutesTyped) : ""}</p>
                    </div>
                    <Input aria-label="Date worked" type="date" className="w-40" value={workDate} max={today()} onChange={(e) => setWorkDate(e.target.value)} />
                    <Input aria-label="What was done" className="min-w-0 flex-1" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="What was done" />
                </div>
                <div className="flex items-center justify-between gap-2">
                    <label className="flex items-center gap-1.5 text-xs"><Checkbox checked={billable} onCheckedChange={(v) => setBillable(v === true)} /> Billable</label>
                    <Button type="submit" size="sm" disabled={saving}>{saving ? "Logging…" : "Log time"}</Button>
                </div>
                {manualError && <p role="alert" className="text-xs text-destructive">{manualError}</p>}
            </form>
            )}
        </div>
    );
}
