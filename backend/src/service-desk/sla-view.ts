// How a ticket's SLA row (the saved clocks) looks to the screens and reports. Pure, no database.
import { clockState, levelOf, overallLevel, type Clock, type ClockState, type Level, type SlaPriority, type SlaState } from "./sla-engine";

const MIN = 60_000;
const ms = (d: Date | null | undefined) => (d ? d.getTime() : null);
export const priorityFromDb = (p: string): SlaPriority => (p === "normal" ? "medium" : p) as SlaPriority;

export type SlaClockView = {
    state: ClockState;
    level: Level;
    targetMinutes: number | null;
    dueAt: string | null;
    doneAt: string | null;
    met: boolean | null;
    warnedAt: string | null;
    breachedAt: string | null;
    /** Milliseconds to the due time (negative when late), or the working time left while paused. Null with no target or when done. */
    remainingMs: number | null;
};
export type SlaView = { policy: string; paused: boolean; level: Level; response: SlaClockView; resolution: SlaClockView };

export type SlaRow = {
    ticket_id: string;
    policy_id: string | null;
    policy_name: string;
    priority: string;
    status: string;
    paused: boolean;
    warn_percent: number;
    response_target_min: number | null;
    response_used_ms: bigint;
    response_running_since: Date | null;
    response_due_at: Date | null;
    response_warn_at: Date | null;
    response_done_at: Date | null;
    response_met: boolean | null;
    response_warned_at: Date | null;
    response_breached_at: Date | null;
    resolution_target_min: number | null;
    resolution_used_ms: bigint;
    resolution_running_since: Date | null;
    resolution_due_at: Date | null;
    resolution_warn_at: Date | null;
    resolution_done_at: Date | null;
    resolution_met: boolean | null;
    resolution_warned_at: Date | null;
    resolution_breached_at: Date | null;
};

function clockOf(r: SlaRow, k: "response" | "resolution"): Clock {
    return {
        targetMin: r[`${k}_target_min`],
        usedMs: Number(r[`${k}_used_ms`]),
        runningSince: ms(r[`${k}_running_since`]),
        dueAt: ms(r[`${k}_due_at`]),
        warnAt: ms(r[`${k}_warn_at`]),
        doneAt: ms(r[`${k}_done_at`]),
        met: r[`${k}_met`],
        warnedAt: ms(r[`${k}_warned_at`]),
        breachedAt: ms(r[`${k}_breached_at`]),
    };
}

export function rowToState(r: SlaRow): SlaState {
    return {
        policyId: r.policy_id ?? "",
        policyName: r.policy_name,
        priority: priorityFromDb(r.priority),
        status: r.status,
        paused: r.paused,
        warnPercent: r.warn_percent,
        response: clockOf(r, "response"),
        resolution: clockOf(r, "resolution"),
    };
}

function clockView(c: Clock, paused: boolean, now: number): SlaClockView {
    const state = clockState(c, paused);
    const remaining = state === "running" ? (c.dueAt ?? now) - now : state === "paused" && c.targetMin !== null ? c.targetMin * MIN - c.usedMs : null;
    return {
        state,
        level: levelOf(c, paused, now),
        targetMinutes: c.targetMin,
        dueAt: c.dueAt === null ? null : new Date(c.dueAt).toISOString(),
        doneAt: c.doneAt === null ? null : new Date(c.doneAt).toISOString(),
        met: c.met,
        warnedAt: c.warnedAt === null ? null : new Date(c.warnedAt).toISOString(),
        breachedAt: c.breachedAt === null ? null : new Date(c.breachedAt).toISOString(),
        remainingMs: remaining,
    };
}

/** What the screens show of a ticket's SLA. Staff only: the client portal never gets this. */
export function viewOf(r: SlaRow, now = Date.now()): SlaView {
    const s = rowToState(r);
    const response = clockView(s.response, s.paused, now);
    const resolution = clockView(s.resolution, s.paused, now);
    return { policy: s.policyName, paused: s.paused, level: overallLevel(response.level, resolution.level), response, resolution };
}

