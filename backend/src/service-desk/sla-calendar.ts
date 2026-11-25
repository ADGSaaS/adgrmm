// Working time for SLA clocks: how much of a stretch of time falls inside the working week of a time zone, and what
// instant is reached after a given amount of working time. Pure date arithmetic (no database), so it can be tested
// thoroughly, including daylight saving changes, holidays and weekends.
//
// A calendar of null means around the clock, so working time is just elapsed time.
import { localParts, zonedTimeToUtc } from "../reports/schedule-time";

export type Calendar = {
    timezone: string;
    /** 0 is Sunday. */
    days: number[];
    /** "HH:MM" in the time zone; the day runs from start to end. */
    start: string;
    /** "HH:MM", or "24:00" for the end of the day. Always after start. */
    end: string;
    /** yyyy-mm-dd dates when nobody works. */
    holidays: string[];
} | null;

const DAY_MS = 86_400_000;
/** About ten years: a calendar that is closed longer than that is a mistake, not a schedule. */
const MAX_DAYS = 3660;

const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/;

export function isClockTime(v: unknown): v is string {
    return typeof v === "string" && TIME.test(v);
}

export function minutesOf(t: string): number {
    return Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
}

export function pad(n: number): string {
    return String(n).padStart(2, "0");
}

export function dateKey(y: number, m: number, d: number): string {
    return `${y}-${pad(m)}-${pad(d)}`;
}

/** The next calendar date after y-m-d (month is 1 to 12). */
function nextDate(y: number, m: number, d: number): { y: number; m: number; d: number } {
    const t = new Date(Date.UTC(y, m - 1, d + 1));
    return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/** The wall clock instant for a time of day on a date; "24:00" is midnight at the end of the date. */
function at(y: number, m: number, d: number, time: string, tz: string): number {
    if (time === "24:00") {
        const n = nextDate(y, m, d);
        return zonedTimeToUtc(n.y, n.m, n.d, 0, 0, tz);
    }
    return zonedTimeToUtc(y, m, d, Number(time.slice(0, 2)), Number(time.slice(3)), tz);
}

/** The working window of one date, or null when it is not a working day. */
function windowOf(cal: NonNullable<Calendar>, y: number, m: number, d: number): [number, number] | null {
    const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    if (!cal.days.includes(weekday)) return null;
    if (cal.holidays.includes(dateKey(y, m, d))) return null;
    const start = at(y, m, d, cal.start, cal.timezone);
    const end = at(y, m, d, cal.end, cal.timezone);
    return end > start ? [start, end] : null;
}

/** Working milliseconds between two instants. */
export function workingMsBetween(fromMs: number, toMs: number, cal: Calendar): number {
    if (!(toMs > fromMs)) return 0;
    if (!cal) return toMs - fromMs;
    const p = localParts(fromMs, cal.timezone);
    let { y, m, d } = { y: p.year, m: p.month, d: p.day };
    let total = 0;
    for (let i = 0; i < MAX_DAYS; i++) {
        const w = windowOf(cal, y, m, d);
        if (w) {
            if (w[0] >= toMs) break;
            const a = Math.max(w[0], fromMs);
            const b = Math.min(w[1], toMs);
            if (b > a) total += b - a;
        } else {
            // A closed day still ends the loop once it is past the end of the span.
            if (at(y, m, d, "00:00", cal.timezone) >= toMs) break;
        }
        const n = nextDate(y, m, d);
        y = n.y; m = n.m; d = n.d;
    }
    return total;
}

/** The instant reached after `ms` of working time starting at `fromMs`. With no working time left to give, it is `fromMs`. */
export function addWorkingMs(fromMs: number, ms: number, cal: Calendar): number {
    if (!(ms > 0)) return fromMs;
    if (!cal) return fromMs + ms;
    const p = localParts(fromMs, cal.timezone);
    let { y, m, d } = { y: p.year, m: p.month, d: p.day };
    let remaining = ms;
    for (let i = 0; i < MAX_DAYS; i++) {
        const w = windowOf(cal, y, m, d);
        if (w) {
            const start = Math.max(w[0], fromMs);
            if (start < w[1]) {
                const room = w[1] - start;
                if (remaining <= room) return start + remaining;
                remaining -= room;
            }
        }
        const n = nextDate(y, m, d);
        y = n.y; m = n.m; d = n.d;
    }
    // Never reached for a calendar that is open at least one day in ten years.
    return fromMs + ms + MAX_DAYS * DAY_MS;
}

/** Checks the pieces a person can type for a calendar and returns a clean version, or a message saying what is wrong. */
export function cleanCalendarInput(input: { timezone?: unknown; days?: unknown; start?: unknown; end?: unknown; holidays?: unknown }, isValidTimezone: (tz: string) => boolean): { ok: true; value: { timezone: string; days: number[]; start: string; end: string; holidays: { date: string; name: string }[] } } | { ok: false; error: string } {
    const timezone = String(input.timezone ?? "").trim();
    if (!isValidTimezone(timezone)) return { ok: false, error: "That time zone is not one we know." };
    const days = Array.isArray(input.days) ? [...new Set(input.days.map(Number))].sort() : [];
    if (!days.length || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) return { ok: false, error: "Choose at least one working day." };
    if (!isClockTime(input.start) || input.start === "24:00" || !isClockTime(input.end)) return { ok: false, error: "Times must look like 09:00 (use 24:00 for the end of the day)." };
    if (minutesOf(input.end) <= minutesOf(input.start)) return { ok: false, error: "The working day has to end after it starts. For a round-the-clock day use 00:00 to 24:00." };
    const holidays: { date: string; name: string }[] = [];
    if (input.holidays !== undefined && !Array.isArray(input.holidays)) return { ok: false, error: "Holidays must be a list of dates." };
    for (const h of (input.holidays as unknown[]) ?? []) {
        const date = String((h as any)?.date ?? "").trim();
        const probe = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
        const real = probe && new Date(Date.UTC(+probe[1], +probe[2] - 1, +probe[3])).toISOString().slice(0, 10) === date;
        if (!real) return { ok: false, error: `"${date}" is not a date (use yyyy-mm-dd).` };
        if (!holidays.some((x) => x.date === date)) holidays.push({ date, name: String((h as any)?.name ?? "").trim().slice(0, 80) });
    }
    if (holidays.length > 400) return { ok: false, error: "That is more holidays than a calendar can hold (400)." };
    holidays.sort((a, b) => a.date.localeCompare(b.date));
    return { ok: true, value: { timezone, days, start: input.start, end: input.end, holidays } };
}
