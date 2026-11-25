// The SLA clocks of a ticket, as pure functions: a clock has a target, the working time already used and the instant it
// runs from. It stops while the ticket waits on the customer, is finished by the first reply (response) or by resolving
// the ticket (resolution), starts again if the ticket is reopened, and is re-aimed when the priority or policy changes.
// No database here: the service reads a row into a state, calls reconcile, and writes the result back.
import { addWorkingMs, workingMsBetween, type Calendar } from "./sla-calendar";

export const PRIORITIES = ["low", "medium", "high", "urgent"] as const;
export type SlaPriority = (typeof PRIORITIES)[number];
export const FINISHED_STATUSES = ["resolved", "closed"];

export type Targets = Partial<Record<SlaPriority, { response?: number | null; resolution?: number | null }>>;

export type PolicySpec = {
    id: string;
    name: string;
    targets: Targets;
    /** Ticket statuses that stop the clocks. */
    pauseStatuses: string[];
    warnPercent: number;
    /** When the policy was made: older tickets start their clocks no earlier than this. */
    createdAt: number;
};

/** One clock. Times are epoch milliseconds. */
export type Clock = {
    targetMin: number | null;
    usedMs: number;
    runningSince: number | null;
    dueAt: number | null;
    warnAt: number | null;
    doneAt: number | null;
    met: boolean | null;
    warnedAt: number | null;
    breachedAt: number | null;
};

export type SlaState = {
    policyId: string;
    policyName: string;
    priority: SlaPriority;
    status: string;
    paused: boolean;
    warnPercent: number;
    response: Clock;
    resolution: Clock;
};

export function emptyClock(targetMin: number | null): Clock {
    return { targetMin, usedMs: 0, runningSince: null, dueAt: null, warnAt: null, doneAt: null, met: null, warnedAt: null, breachedAt: null };
}

const MIN = 60_000;

/** The working time a clock has used at an instant. */
export function usedAt(c: Clock, now: number, cal: Calendar): number {
    return c.usedMs + (c.runningSince !== null ? workingMsBetween(c.runningSince, now, cal) : 0);
}

/** Working milliseconds left before the due time (negative once it is past), or null for a clock with no target. */
export function remainingMs(c: Clock, now: number, cal: Calendar): number | null {
    if (c.targetMin === null) return null;
    return c.targetMin * MIN - usedAt(c, now, cal);
}

function aim(c: Clock, cal: Calendar, warnPercent: number): Clock {
    if (c.targetMin === null || c.runningSince === null) return { ...c, dueAt: null, warnAt: null };
    const target = c.targetMin * MIN;
    return {
        ...c,
        dueAt: addWorkingMs(c.runningSince, target - c.usedMs, cal),
        warnAt: addWorkingMs(c.runningSince, Math.max(0, (target * warnPercent) / 100 - c.usedMs), cal),
    };
}

/** Same target: only the warning point can have moved. */
function aimIfWarnChanged(c: Clock, cal: Calendar, warnPercent: number): Clock {
    return c.runningSince === null ? c : aim(c, cal, warnPercent);
}

function start(c: Clock, now: number, cal: Calendar, warnPercent: number): Clock {
    if (c.targetMin === null || c.doneAt !== null) return c;
    return aim({ ...c, runningSince: now }, cal, warnPercent);
}

function stop(c: Clock, now: number, cal: Calendar): Clock {
    if (c.runningSince === null) return c;
    return { ...c, usedMs: usedAt(c, now, cal), runningSince: null, dueAt: null, warnAt: null };
}

/** The clock is over: the thing it measured happened at `at`. */
function finish(c: Clock, at: number, cal: Calendar): Clock {
    if (c.targetMin === null || c.doneAt !== null) return c;
    // Use what was spent up to that moment (never before the clock started running).
    const when = c.runningSince !== null ? Math.max(at, c.runningSince) : at;
    const used = usedAt(c, when, cal);
    return { ...c, usedMs: used, runningSince: null, doneAt: when, met: used <= c.targetMin * MIN, dueAt: c.dueAt, warnAt: null, breachedAt: c.breachedAt ?? (used > c.targetMin * MIN ? when : null) };
}

/** Takes a new target while keeping what has already been used. A clock that had no target counts from `from`. */
function retarget(c: Clock, now: number, cal: Calendar, targetMin: number | null, warnPercent: number, from: number, force: boolean): Clock {
    if (c.doneAt !== null) return c;
    if (c.targetMin === null) return targetMin === null ? c : { ...emptyClock(targetMin), usedMs: workingMsBetween(from, now, cal), warnedAt: c.warnedAt, breachedAt: c.breachedAt };
    if (!force && c.targetMin === targetMin) return aimIfWarnChanged(c, cal, warnPercent);
    const base = c.runningSince !== null ? { ...c, usedMs: usedAt(c, now, cal), runningSince: now } : c;
    if (targetMin === null) return { ...emptyClock(null), usedMs: base.usedMs, warnedAt: c.warnedAt, breachedAt: c.breachedAt };
    return aim({ ...base, targetMin }, cal, warnPercent);
}

export function targetsFor(policy: Pick<PolicySpec, "targets">, priority: SlaPriority): { response: number | null; resolution: number | null } {
    const t = policy.targets[priority] ?? {};
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : null);
    return { response: num(t.response), resolution: num(t.resolution) };
}

export type Context = {
    now: number;
    createdAt: number;
    status: string;
    priority: SlaPriority;
    policy: PolicySpec;
    calendar: Calendar;
    /** When a technician first answered the customer (or acknowledged the ticket), if they did. */
    respondedAt: number | null;
    /** Aim the running clocks again from now even if nothing about the ticket changed (the policy or its calendar was edited). */
    reaim?: boolean;
};

/**
 * Brings the clocks up to date with the ticket: its policy, priority and status. Pass the saved state, or null for a
 * ticket that has none yet. Running it again with nothing changed gives back the same state.
 */
export function reconcile(prev: SlaState | null, ctx: Context): SlaState {
    const { now, policy, calendar: cal } = ctx;
    const warn = policy.warnPercent;
    const t = targetsFor(policy, ctx.priority);
    let response: Clock;
    let resolution: Clock;

    if (!prev) {
        // Clocks start when the ticket was opened, but not before the policy existed.
        const from = Math.min(now, Math.max(ctx.createdAt, policy.createdAt));
        response = start(emptyClock(t.response), from, cal, warn);
        resolution = start(emptyClock(t.resolution), from, cal, warn);
    } else {
        response = prev.response;
        resolution = prev.resolution;
        const from = Math.min(now, Math.max(ctx.createdAt, policy.createdAt));
        const force = ctx.reaim === true || prev.policyId !== policy.id;
        response = retarget(response, now, cal, t.response, warn, from, force);
        resolution = retarget(resolution, now, cal, t.resolution, warn, from, force);
    }

    const finished = FINISHED_STATUSES.includes(ctx.status);
    const paused = !finished && policy.pauseStatuses.includes(ctx.status);

    // Response: finished by a first reply, or by the ticket being closed out.
    if (response.doneAt === null && response.targetMin !== null) {
        if (ctx.respondedAt !== null) response = finish(response, ctx.respondedAt, cal);
        else if (finished) response = finish(response, now, cal);
    }

    // Resolution: reopening a finished ticket puts the clock back to work.
    if (resolution.doneAt !== null && !finished) {
        resolution = { ...resolution, doneAt: null, met: null };
    }
    if (resolution.doneAt === null && resolution.targetMin !== null && finished) resolution = finish(resolution, now, cal);

    const shouldRun = !finished && !paused;
    const settle = (c: Clock): Clock => {
        if (c.targetMin === null || c.doneAt !== null) return c;
        if (shouldRun && c.runningSince === null) return start(c, now, cal, warn);
        if (!shouldRun && c.runningSince !== null) return stop(c, now, cal);
        return c;
    };
    response = settle(response);
    resolution = settle(resolution);

    return { policyId: policy.id, policyName: policy.name, priority: ctx.priority, status: ctx.status, paused, warnPercent: warn, response, resolution };
}

export type ClockState = "none" | "running" | "paused" | "met" | "missed";
export type Level = "none" | "ok" | "warning" | "breached" | "paused" | "met";

/** What a clock is doing, in words the screens use. */
export function clockState(c: Clock, paused: boolean): ClockState {
    if (c.targetMin === null) return "none";
    if (c.doneAt !== null) return c.met ? "met" : "missed";
    return paused || c.runningSince === null ? "paused" : "running";
}

/** How worrying a running clock is at an instant: ok, past its warning point, or past its due time. */
export function levelOf(c: Clock, paused: boolean, now: number): Level {
    const s = clockState(c, paused);
    if (s === "none") return "none";
    if (s === "met") return "met";
    if (s === "missed") return "breached";
    if (c.breachedAt !== null) return "breached";
    if (s === "paused") return "paused";
    if (c.dueAt !== null && now >= c.dueAt) return "breached";
    if (c.warnAt !== null && now >= c.warnAt) return "warning";
    return "ok";
}

const ORDER: Level[] = ["none", "met", "ok", "paused", "warning", "breached"];

/** The worse of the two clocks, for one badge on a ticket. */
export function overallLevel(a: Level, b: Level): Level {
    return ORDER.indexOf(a) >= ORDER.indexOf(b) ? a : b;
}

export const PRIORITY_UP: Record<string, SlaPriority> = { low: "medium", medium: "high", high: "urgent", urgent: "urgent" };
