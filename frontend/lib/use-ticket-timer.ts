"use client";

// The person's stopwatch on one ticket. The server keeps the time, so it survives closing the browser and follows
// the person to another computer; this hook only shows it ticking and sends start / pause / stop / discard.
import * as React from "react";
import { jfetch } from "@/lib/api";

type Snapshot = { running: boolean; seconds: number; startedAt: string | null; receivedAt: number };

export function useTicketTimer(ticketId: string | undefined) {
    const [snap, setSnap] = React.useState<Snapshot | null>(null);
    const [now, setNow] = React.useState(() => Date.now());
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);

    const take = React.useCallback((r: { running: boolean; seconds: number; startedAt: string | null }) => {
        setSnap({ running: r.running, seconds: r.seconds, startedAt: r.startedAt, receivedAt: Date.now() });
    }, []);

    const refresh = React.useCallback(async () => {
        if (!ticketId) return;
        try {
            take(await jfetch(`/api/ticket-timers/${encodeURIComponent(ticketId)}`));
            setError(null);
        } catch {
            // Not allowed to time tickets, or offline: the card just shows no timer.
            setSnap(null);
        }
    }, [ticketId, take]);

    React.useEffect(() => { void refresh(); }, [refresh]);

    // Look again when the tab comes back, in case it was started or stopped elsewhere.
    React.useEffect(() => {
        const onVisible = () => { if (document.visibilityState === "visible") void refresh(); };
        document.addEventListener("visibilitychange", onVisible);
        return () => document.removeEventListener("visibilitychange", onVisible);
    }, [refresh]);

    React.useEffect(() => {
        if (!snap?.running) return;
        const t = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(t);
    }, [snap?.running]);

    const seconds = snap ? snap.seconds + (snap.running ? Math.max(0, Math.floor((now - snap.receivedAt) / 1000)) : 0) : 0;

    const act = React.useCallback(
        async <T,>(action: "start" | "pause" | "discard" | "stop", body?: Record<string, unknown>): Promise<T | null> => {
            if (!ticketId) return null;
            setBusy(true);
            setError(null);
            try {
                const r = await jfetch<any>(`/api/ticket-timers/${encodeURIComponent(ticketId)}/${action}`, { method: "POST", body: body ?? {} });
                if (action === "stop") setSnap({ running: false, seconds: 0, startedAt: null, receivedAt: Date.now() });
                else take(r);
                // The header badge looks again at once.
                window.dispatchEvent(new Event("adg:timer-changed"));
                return r as T;
            } catch (e) {
                let message = e instanceof Error ? e.message : "Something went wrong.";
                try { const j = JSON.parse(message) as { message?: string | string[] }; message = Array.isArray(j.message) ? j.message.join(" ") : j.message ?? message; } catch { /* already words */ }
                setError(message);
                return null;
            } finally {
                setBusy(false);
            }
        },
        [ticketId, take]
    );

    return {
        seconds,
        running: !!snap?.running,
        started: !!snap && (snap.running || snap.seconds > 0),
        available: snap !== null,
        busy,
        error,
        refresh,
        start: () => act<unknown>("start"),
        pause: () => act<unknown>("pause"),
        discard: () => act<unknown>("discard"),
        stop: (body: { minutes?: number; billable?: boolean; note?: string }) => act<{ id: string; minutes: number }>("stop", body),
    };
}

export type TicketTimer = ReturnType<typeof useTicketTimer>;
