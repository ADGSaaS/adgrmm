"use client";

// A ticket timer that is running shows in the header on every page, and in the browser tab's title, so it is hard to forget.
// The time lives on the server (see lib/use-ticket-timer.ts), so it keeps counting in other tabs and on other computers.
import * as React from "react";
import Link from "next/link";
import { Timer } from "lucide-react";
import { jfetch } from "@/lib/api";
import { clock } from "@/lib/duration";
import { hasPerm } from "@/lib/permissions";
import { useMe } from "@/lib/use-me";

type Item = { ticketId: string; running: boolean; seconds: number; number: string; subject: string };

const LOOK_EVERY_MS = 30_000;

export default function RunningTimerBadge() {
    const { permissions } = useMe();
    const allowed = hasPerm(permissions, "tickets.write");
    const [item, setItem] = React.useState<(Item & { receivedAt: number }) | null>(null);
    const [now, setNow] = React.useState(() => Date.now());
    const baseTitle = React.useRef<string | null>(null);

    const look = React.useCallback(async () => {
        try {
            const r = await jfetch<{ items: Item[] }>("/api/ticket-timers");
            const running = r.items.find((i) => i.running);
            setItem(running ? { ...running, receivedAt: Date.now() } : null);
        } catch {
            setItem(null);
        }
    }, []);

    React.useEffect(() => {
        if (!allowed) return;
        void look();
        const poll = window.setInterval(() => void look(), LOOK_EVERY_MS);
        const onVisible = () => { if (document.visibilityState === "visible") void look(); };
        document.addEventListener("visibilitychange", onVisible);
        // Starting or stopping a timer on this page tells the badge at once.
        const onChanged = () => void look();
        window.addEventListener("riq:timer-changed", onChanged);
        return () => {
            window.clearInterval(poll);
            document.removeEventListener("visibilitychange", onVisible);
            window.removeEventListener("riq:timer-changed", onChanged);
        };
    }, [allowed, look]);

    React.useEffect(() => {
        if (!item) return;
        const t = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(t);
    }, [item]);

    const seconds = item ? item.seconds + Math.max(0, Math.floor((now - item.receivedAt) / 1000)) : 0;

    // The tab title carries the time as minutes and seconds (hours too once it passes an hour), so it visibly moves.
    React.useEffect(() => {
        if (!item) {
            if (baseTitle.current !== null) { document.title = baseTitle.current; baseTitle.current = null; }
            return;
        }
        if (baseTitle.current === null) baseTitle.current = document.title.replace(/^⏱ [\d:]+ · /, "");
        const pad = (n: number) => String(n).padStart(2, "0");
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const sec = seconds % 60;
        document.title = `⏱ ${h > 0 ? `${h}:${pad(m)}` : pad(m)}:${pad(sec)} · ${baseTitle.current}`;
    }, [item, seconds]);

    React.useEffect(() => () => { if (baseTitle.current !== null) document.title = baseTitle.current; }, []);

    if (!allowed || !item) return null;
    return (
        <Link
            href={`/tickets/${item.ticketId}`}
            title={`Timer running on #${item.number}: ${item.subject}`}
            className="hidden items-center gap-1.5 rounded-lg border border-emerald-500/50 bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-500/20 dark:text-emerald-300 md:inline-flex"
        >
            <Timer className="h-3.5 w-3.5" aria-hidden />
            <span className="tabular-nums">{clock(seconds)}</span>
            <span className="max-w-[10rem] truncate text-muted-foreground">#{item.number}</span>
        </Link>
    );
}
