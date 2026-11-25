// backend/src/reports/schedule-time.ts
//
// When a scheduled report is sent: any days of the week, a day of the month (or the last day, or "the second Tuesday"),
// or once on a date, at a time of day in a time zone the customer cares about. Pure date arithmetic with no
// dependencies, so it can be tested thoroughly, including daylight saving changes and months of different lengths.
import { BadRequestException } from "@nestjs/common";

export type ScheduleKind = "daily" | "weekly" | "monthly" | "once";

export type ScheduleRule = {
    kind: ScheduleKind;
    /** 24 hour "HH:MM", in the time zone below. */
    time: string;
    /** An IANA zone such as "America/New_York". */
    timezone: string;
    /** 0 is Sunday. Used by weekly schedules. */
    daysOfWeek?: number[];
    /** 1 to 31, or -1 for the last day of the month. Used by monthly schedules. */
    dayOfMonth?: number;
    /** An alternative for monthly schedules: the first, second, third, fourth or (-1) last weekday of the month. */
    nth?: { week: 1 | 2 | 3 | 4 | -1; weekday: number };
    /** yyyy-mm-dd. Used by one-off schedules. */
    onceDate?: string;
};

const DAY_MS = 86_400_000;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const ORDINAL: Record<string, string> = { "1": "first", "2": "second", "3": "third", "4": "fourth", "-1": "last" };
const MAX_LOOKAHEAD_DAYS = 800;

/* ------------------------------ time zones ------------------------------ */

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timezone: string): Intl.DateTimeFormat {
    let f = formatters.get(timezone);
    if (!f) {
        f = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
        formatters.set(timezone, f);
    }
    return f;
}

export function isValidTimezone(timezone: string): boolean {
    if (typeof timezone !== "string" || !timezone || timezone.length > 64) return false;
    try {
        formatter(timezone);
        return true;
    } catch {
        return false;
    }
}

type Parts = { year: number; month: number; day: number; hour: number; minute: number; weekday: number };

/** The wall clock in a zone at an instant. */
export function localParts(utcMs: number, timezone: string): Parts {
    const parts = formatter(timezone).formatToParts(new Date(utcMs));
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    const year = get("year");
    const month = get("month");
    const day = get("day");
    return { year, month, day, hour: get("hour") % 24, minute: get("minute"), weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay() };
}

/** How far the zone's clock is ahead of UTC at an instant, in milliseconds. */
function offsetMs(utcMs: number, timezone: string): number {
    const p = localParts(utcMs, timezone);
    const second = Math.floor(utcMs / 1000) % 60;
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, second) - Math.floor(utcMs / 1000) * 1000;
}

/**
 * The instant a wall clock time happens in a zone. When the clocks go back, the time happens twice and the first one is
 * used. When they go forward, the time does not exist and the moment just after the gap is used.
 */
export function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, timezone: string): number {
    const guess = Date.UTC(year, month - 1, day, hour, minute);
    const offsets = Array.from(new Set([offsetMs(guess - DAY_MS, timezone), offsetMs(guess + DAY_MS, timezone)]));
    // A candidate is right only if the zone's clock really reads the requested time at that instant.
    const valid = offsets.map((o) => guess - o).filter((candidate) => {
        const back = localParts(candidate, timezone);
        return back.year === year && back.month === month && back.day === day && back.hour === hour && back.minute === minute;
    });
    if (valid.length) return Math.min(...valid);
    // The time falls in the gap when clocks go forward: use the offset from before the change.
    return guess - Math.min(...offsets);
}

/* ------------------------------ calendar ------------------------------ */

const daysInMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();
const dateKey = (year: number, month: number, day: number) => `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

function addDays(year: number, month: number, day: number, n: number) {
    const d = new Date(Date.UTC(year, month - 1, day + n));
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function dateMatches(rule: ScheduleRule, year: number, month: number, day: number): boolean {
    const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    const dim = daysInMonth(year, month);
    switch (rule.kind) {
        case "daily":
            return true;
        case "weekly":
            return (rule.daysOfWeek ?? []).includes(weekday);
        case "once":
            return dateKey(year, month, day) === rule.onceDate;
        case "monthly": {
            if (rule.nth) {
                if (weekday !== rule.nth.weekday) return false;
                return rule.nth.week === -1 ? day + 7 > dim : Math.ceil(day / 7) === rule.nth.week;
            }
            const want = rule.dayOfMonth ?? 1;
            // The 31st in a month with 30 days is the 30th, so "the 31st" never silently skips a month.
            return want === -1 ? day === dim : day === Math.min(want, dim);
        }
    }
}

function parseTime(time: string): { hour: number; minute: number } {
    const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
    if (!m) throw new BadRequestException("Time must look like 09:30.");
    return { hour: Number(m[1]), minute: Number(m[2]) };
}

/* ------------------------------ checking a rule someone sent ------------------------------ */

export function checkRule(input: Partial<ScheduleRule> & { kind?: string }): ScheduleRule {
    const kind = input.kind;
    if (kind !== "daily" && kind !== "weekly" && kind !== "monthly" && kind !== "once") throw new BadRequestException("Send daily, weekly, monthly or once.");
    const timezone = input.timezone ?? "UTC";
    if (!isValidTimezone(timezone)) throw new BadRequestException("That time zone is not recognised.");
    const time = input.time ?? "07:00";
    parseTime(time);

    const rule: ScheduleRule = { kind, time, timezone };
    if (kind === "weekly") {
        const days = Array.from(new Set(input.daysOfWeek ?? [1]));
        if (!days.length || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw new BadRequestException("Choose at least one day of the week.");
        rule.daysOfWeek = days.sort((a, b) => a - b);
    }
    if (kind === "monthly") {
        if (input.nth) {
            const { week, weekday } = input.nth;
            if (![1, 2, 3, 4, -1].includes(week) || !Number.isInteger(weekday) || weekday < 0 || weekday > 6) throw new BadRequestException("Choose which weekday of the month.");
            rule.nth = { week, weekday };
        } else {
            const day = input.dayOfMonth ?? 1;
            if (!Number.isInteger(day) || (day !== -1 && (day < 1 || day > 31))) throw new BadRequestException("Choose a day of the month from 1 to 31, or the last day.");
            rule.dayOfMonth = day;
        }
    }
    if (kind === "once") {
        if (!input.onceDate || !/^\d{4}-\d{2}-\d{2}$/.test(input.onceDate)) throw new BadRequestException("Choose the date to send on.");
        const [y, m, d] = input.onceDate.split("-").map(Number);
        if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) throw new BadRequestException("That date does not exist.");
        rule.onceDate = input.onceDate;
    }
    return rule;
}

/* ------------------------------ when it next runs ------------------------------ */

/** The first time after `after` that the rule sends, or null if it never will (a one-off date already past). */
export function nextRun(rule: ScheduleRule, after: Date): Date | null {
    const { hour, minute } = parseTime(rule.time);
    const start = localParts(after.getTime(), rule.timezone);
    for (let i = 0; i <= MAX_LOOKAHEAD_DAYS; i++) {
        const day = addDays(start.year, start.month, start.day, i);
        if (!dateMatches(rule, day.year, day.month, day.day)) continue;
        const at = zonedTimeToUtc(day.year, day.month, day.day, hour, minute, rule.timezone);
        if (at > after.getTime()) return new Date(at);
        if (rule.kind === "once") return null;
    }
    return null;
}

/** The next few send times, so a person can see exactly what they have set up before saving it. */
export function previewRuns(rule: ScheduleRule, count = 5, after = new Date()): Date[] {
    const out: Date[] = [];
    let cursor = after;
    while (out.length < count) {
        const next = nextRun(rule, cursor);
        if (!next) break;
        out.push(next);
        cursor = next;
    }
    return out;
}

/** The calendar date, in the rule's zone, of an instant. */
export function localDate(at: Date, timezone: string): string {
    const p = localParts(at.getTime(), timezone);
    return dateKey(p.year, p.month, p.day);
}

/** Plain words for a rule. */
export function describeRule(rule: ScheduleRule): string {
    const [h, m] = rule.time.split(":").map(Number);
    const clock = `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
    const where = `${clock} (${rule.timezone})`;
    switch (rule.kind) {
        case "daily":
            return `Every day at ${where}`;
        case "once":
            return `Once, on ${rule.onceDate} at ${where}`;
        case "weekly": {
            const days = rule.daysOfWeek ?? [];
            if (days.length === 7) return `Every day at ${where}`;
            if (days.join() === "1,2,3,4,5") return `Every weekday at ${where}`;
            const names = days.map((d) => WEEKDAYS[d]);
            const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0];
            return `Every ${list} at ${where}`;
        }
        case "monthly": {
            if (rule.nth) return `The ${ORDINAL[String(rule.nth.week)]} ${WEEKDAYS[rule.nth.weekday]} of every month at ${where}`;
            const d = rule.dayOfMonth ?? 1;
            if (d === -1) return `The last day of every month at ${where}`;
            const suffix = d % 10 === 1 && d !== 11 ? "st" : d % 10 === 2 && d !== 12 ? "nd" : d % 10 === 3 && d !== 13 ? "rd" : "th";
            return `The ${d}${suffix} of every month at ${where}`;
        }
    }
}
