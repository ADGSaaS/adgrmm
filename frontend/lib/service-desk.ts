// What the API says about a ticket's SLA, queue and routing, and the words the screens use for it.

export type SlaLevel = "none" | "ok" | "warning" | "breached" | "paused" | "met";
export type SlaClockState = "none" | "running" | "paused" | "met" | "missed";

export type SlaClock = {
    state: SlaClockState;
    level: SlaLevel;
    targetMinutes: number | null;
    dueAt: string | null;
    doneAt: string | null;
    met: boolean | null;
    warnedAt: string | null;
    breachedAt: string | null;
    /** Milliseconds to the due time (negative when late), or the working time left while paused. */
    remainingMs: number | null;
};

export type TicketSla = { policy: string; paused: boolean; level: SlaLevel; response: SlaClock; resolution: SlaClock };

export type Priority = "low" | "medium" | "high" | "urgent";
export const PRIORITIES: Priority[] = ["low", "medium", "high", "urgent"];

/** "3 h 20 min", "45 min", "2 d 4 h", "under a minute". */
export function duration(ms: number): string {
    const total = Math.abs(ms);
    const min = Math.floor(total / 60_000);
    if (min < 1) return "under a minute";
    if (min < 60) return `${min} min`;
    const h = Math.floor(min / 60);
    if (h < 24) return `${h} h${min % 60 ? ` ${min % 60} min` : ""}`;
    const d = Math.floor(h / 24);
    return `${d} d${h % 24 ? ` ${h % 24} h` : ""}`;
}

/** A target in minutes written the way a person says it: "8 h", "1 d 4 h", "90 min". */
export function minutesLabel(min: number | null | undefined): string {
    return min ? duration(min * 60_000) : "none";
}

/** Milliseconds left on a clock now: from its due time while running, from what was left when it paused. */
export function msLeft(c: SlaClock, now = Date.now()): number | null {
    if (c.state === "running" && c.dueAt) return new Date(c.dueAt).getTime() - now;
    if (c.state === "paused") return c.remainingMs;
    return null;
}

const RANK: Record<SlaLevel, number> = { none: 0, met: 1, ok: 2, paused: 3, warning: 4, breached: 5 };

/** Running clocks recompute their level as time passes, so a list left open turns amber and then red by itself. */
export function liveLevel(c: SlaClock, now = Date.now()): SlaLevel {
    if (c.state === "running" && c.level !== "breached" && c.dueAt && now >= new Date(c.dueAt).getTime()) return "breached";
    return c.level;
}

/** The clock worth showing in one badge: the worst one, the soonest due on a tie. */
export function primaryClock(sla: TicketSla, now = Date.now()): { name: "First response" | "Resolution"; clock: SlaClock; level: SlaLevel } | null {
    const all = [
        { name: "First response" as const, clock: sla.response },
        { name: "Resolution" as const, clock: sla.resolution },
    ]
        .filter((x) => x.clock.state !== "none")
        .map((x) => ({ ...x, level: liveLevel(x.clock, now) }));
    if (!all.length) return null;
    all.sort((a, b) => RANK[b.level] - RANK[a.level] || (msLeft(a.clock, now) ?? Infinity) - (msLeft(b.clock, now) ?? Infinity));
    return all[0];
}

/** Soonest due time among clocks still running, for sorting. Tickets with nothing running sort after everything. */
export function dueSortValue(sla: TicketSla | null | undefined): number {
    if (!sla) return Number.POSITIVE_INFINITY;
    const times = [sla.response, sla.resolution].filter((c) => c.state === "running" && c.dueAt).map((c) => new Date(c.dueAt as string).getTime());
    return times.length ? Math.min(...times) : Number.POSITIVE_INFINITY;
}

export const LEVEL_STYLES: Record<SlaLevel, string> = {
    none: "bg-zinc-500/10 text-muted-foreground ring-zinc-500/20",
    met: "bg-emerald-500/15 text-emerald-700 ring-emerald-600/20 dark:text-emerald-300",
    ok: "bg-emerald-500/15 text-emerald-700 ring-emerald-600/20 dark:text-emerald-300",
    paused: "bg-blue-500/15 text-blue-700 ring-blue-600/20 dark:text-blue-300",
    warning: "bg-amber-500/20 text-amber-800 ring-amber-600/30 dark:text-amber-300",
    breached: "bg-red-500/15 text-red-700 ring-red-600/25 dark:text-red-300",
};

/** One line saying what a clock is doing: "due in 3 h", "overdue by 40 min", "on hold, 7 h left", "met". */
export function clockText(c: SlaClock, now = Date.now()): string {
    if (c.state === "none") return "no target";
    if (c.state === "met") return "met";
    if (c.state === "missed") return "missed";
    const left = msLeft(c, now);
    if (c.state === "paused") return left === null ? "on hold" : `on hold, ${duration(left)} left`;
    if (left === null) return "running";
    return left >= 0 ? `due in ${duration(left)}` : `overdue by ${duration(left)}`;
}

export type Queue = { id: string; name: string; description?: string; enabled: boolean; assignment: "none" | "user" | "round_robin"; defaultAssigneeUserId: string | null; poolUserIds: string[]; poolGroupId: string | null; defaultSlaPolicyId: string | null; open: number; unassigned: number };

export function errorText(e: unknown): string {
    const raw = e instanceof Error ? e.message : "Something went wrong.";
    try {
        const j = JSON.parse(raw) as { message?: string | string[] };
        return Array.isArray(j.message) ? j.message.join(" ") : j.message ?? raw;
    } catch {
        return raw;
    }
}
