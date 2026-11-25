"use client";

// On the ticket page: the queue, whether the ticket is waiting on the customer, and the response and resolution
// countdowns of its SLA. The clocks are for staff; the client portal never shows them.
import * as React from "react";
import { PauseCircle, PlayCircle, Timer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { jfetch } from "@/lib/api";
import { LEVEL_STYLES, clockText, liveLevel, minutesLabel, type SlaClock, type SlaLevel, type TicketSla } from "@/lib/service-desk";

type TicketLike = {
    id: string;
    status?: string | null;
    queueId?: string | null;
    queueName?: string | null;
    sla?: TicketSla | null;
    createdVia?: string | null;
    [k: string]: any;
};

const VIA: Record<string, string> = { ui: "Entered by staff", email: "Email", portal: "Client portal", alert: "Alert", api: "Created automatically" };

function Clock({ label, clock, paused, now }: { label: string; clock: SlaClock; paused: boolean; now: number }) {
    if (clock.state === "none") return null;
    const level: SlaLevel = paused && clock.state === "paused" ? "paused" : liveLevel(clock, now);
    return (
        <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
                <div className="text-sm">{label}</div>
                <div className="text-xs text-muted-foreground">
                    Target {minutesLabel(clock.targetMinutes)}
                    {clock.dueAt && clock.state === "running" ? ` · due ${new Date(clock.dueAt).toLocaleString()}` : ""}
                    {clock.doneAt ? ` · ${clock.met ? "done" : "done late"} ${new Date(clock.doneAt).toLocaleString()}` : ""}
                </div>
            </div>
            <span className={cn("shrink-0 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset", LEVEL_STYLES[level])}>{clockText(clock, now).replace(/^./, (c) => c.toUpperCase())}</span>
        </div>
    );
}

export function ServiceDeskCard({
    ticket,
    canEdit,
    onPatch,
    onChanged,
    className,
}: {
    ticket: TicketLike;
    canEdit: boolean;
    onPatch: (body: any, field?: string) => Promise<unknown> | void;
    onChanged?: () => void;
    className?: string;
}) {
    const [queues, setQueues] = React.useState<{ id: string; name: string; enabled: boolean }[]>([]);
    const [now, setNow] = React.useState(() => Date.now());
    const [busy, setBusy] = React.useState(false);

    React.useEffect(() => {
        jfetch<{ items: { id: string; name: string; enabled: boolean }[] }>("/api/ticket-queues").then((r) => setQueues(r.items)).catch(() => setQueues([]));
    }, []);
    React.useEffect(() => {
        const t = window.setInterval(() => setNow(Date.now()), 30_000);
        return () => window.clearInterval(t);
    }, []);

    const sla = ticket.sla ?? null;
    const finished = ticket.status === "resolved" || ticket.status === "closed";
    const onHold = ticket.status === "pending";
    // Nothing to show on a ticket with no queues set up, no SLA and no hold button.
    if (!queues.length && !sla && finished) return null;

    async function act(body: any, field: string) {
        setBusy(true);
        try {
            await onPatch(body, field);
            onChanged?.();
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className={cn("rounded-xl border border-border/70 bg-card p-5 shadow-[0_1px_2px_rgba(0,0,0,0.06),0_8px_24px_-12px_rgba(0,0,0,0.25)] backdrop-blur-sm", className)}>
            <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground"><Timer className="h-4 w-4" aria-hidden /> Service desk</h3>
            <div className="grid gap-3 text-sm">
                {queues.length > 0 || ticket.queueId ? (
                    <div className="flex items-center justify-between gap-3">
                        <label htmlFor="sd-queue" className="text-muted-foreground">Queue</label>
                        <select
                            id="sd-queue"
                            value={ticket.queueId ?? ""}
                            disabled={!canEdit || busy}
                            onChange={(e) => void act({ queueId: e.target.value || null }, "queueId")}
                            className="h-8 min-w-0 max-w-[12rem] rounded-md border border-input bg-background px-2 text-sm disabled:opacity-60"
                        >
                            <option value="">No queue</option>
                            {queues.filter((q) => q.enabled || q.id === ticket.queueId).map((q) => (
                                <option key={q.id} value={q.id}>{q.name}{q.enabled ? "" : " (off)"}</option>
                            ))}
                            {ticket.queueId && !queues.some((q) => q.id === ticket.queueId) ? <option value={ticket.queueId}>{ticket.queueName ?? "Queue"}</option> : null}
                        </select>
                    </div>
                ) : null}
                {ticket.createdVia ? (
                    <div className="flex items-center justify-between gap-3">
                        <span className="text-muted-foreground">Came from</span>
                        <span>{VIA[ticket.createdVia] ?? ticket.createdVia}</span>
                    </div>
                ) : null}

                {sla ? (
                    <div className="grid gap-2.5 rounded-lg border border-border/60 p-3">
                        <div className="text-xs text-muted-foreground">SLA policy: <span className="font-medium text-foreground">{sla.policy}</span>{sla.paused ? " · clocks stopped while waiting on the customer" : ""}</div>
                        <Clock label="First response" clock={sla.response} paused={sla.paused} now={now} />
                        <Clock label="Resolution" clock={sla.resolution} paused={sla.paused} now={now} />
                    </div>
                ) : null}

                {canEdit && !finished ? (
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => void act({ status: onHold ? "open" : "pending" }, "status")} className="justify-center gap-2">
                        {onHold ? <PlayCircle className="h-4 w-4" aria-hidden /> : <PauseCircle className="h-4 w-4" aria-hidden />}
                        {onHold ? "Customer answered: reopen" : "Waiting on the customer"}
                    </Button>
                ) : null}
                {onHold ? <p className="text-xs text-muted-foreground">The ticket is on hold. The SLA clocks are stopped, and start again when it is reopened or the customer writes back.</p> : null}
            </div>
        </div>
    );
}
