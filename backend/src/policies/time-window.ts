// backend/src/policies/time-window.ts
//
// Working days and maintenance windows: whether a moment falls inside one, and when the next one starts.
import { localParts } from "../reports/schedule-time";

export type TimeWindow = { name?: string; days: number[]; start: string; end: string; timezone: string };

const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));

/** Whether an instant falls inside the window. Start equal to end means the whole day; an end before the start runs overnight. */
export function inWindow(at: number, w: TimeWindow): boolean {
    const p = localParts(at, w.timezone);
    const now = p.hour * 60 + p.minute;
    const start = minutes(w.start);
    const end = minutes(w.end);
    if (start === end) return w.days.includes(p.weekday);
    if (start < end) return w.days.includes(p.weekday) && now >= start && now < end;
    return (now >= start && w.days.includes(p.weekday)) || (now < end && w.days.includes((p.weekday + 6) % 7));
}

export function activeWindow<T extends TimeWindow>(windows: T[] | undefined, at: number): T | null {
    for (const w of windows ?? []) if (inWindow(at, w)) return w;
    return null;
}

/** The next time any window opens, within a week. Found to the minute. */
export function nextWindowStart<T extends TimeWindow>(windows: T[] | undefined, from: number, horizonDays = 8): { at: number; window: T } | null {
    if (!windows?.length || activeWindow(windows, from)) return null;
    const STEP = 15 * 60_000;
    for (let t = from + STEP; t <= from + horizonDays * 86_400_000; t += STEP) {
        const hit = activeWindow(windows, t);
        if (!hit) continue;
        // It opened somewhere in the last step: walk back to the minute.
        let open = t;
        for (let back = t - 60_000; back > t - STEP && inWindow(back, hit); back -= 60_000) open = back;
        return { at: open, window: hit };
    }
    return null;
}
