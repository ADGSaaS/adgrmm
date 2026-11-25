// When a recurring ticket is opened: every day, on chosen days of the week, on a day of the month (or the last day), or
// once a year, at a time of day in a time zone, between an optional start date and end date. Pure date arithmetic that
// reuses the time zone handling of the report schedules (daylight saving changes included).
import { BadRequestException } from "@nestjs/common";
import { isValidTimezone, localParts, zonedTimeToUtc } from "../reports/schedule-time";

export const FREQUENCIES = ["daily", "weekly", "monthly", "yearly"] as const;
export type Frequency = (typeof FREQUENCIES)[number];

export type RecurringRule = {
    frequency: Frequency;
    /** 24 hour "HH:MM" in the time zone below. */
    time: string;
    /** An IANA zone such as "America/New_York". */
    timezone: string;
    /** 0 is Sunday. Weekly. */
    daysOfWeek: number[];
    /** 1 to 31, or -1 for the last day of the month. Monthly and yearly. */
    dayOfMonth: number | null;
    /** 1 to 12. Yearly. */
    monthOfYear: number | null;
    /** yyyy-mm-dd, in the time zone: nothing is opened before this date. */
    startDate: string | null;
    /** yyyy-mm-dd, in the time zone: nothing is opened after this date. */
    endDate: string | null;
};

const MAX_LOOKAHEAD_DAYS = 1500;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const daysInMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();
const dateKey = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

function parseDate(label: string, v: unknown): string | null {
    if (v === undefined || v === null || v === "") return null;
    const s = String(v).slice(0, 10);
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) throw new BadRequestException(`${label} must look like 2026-12-31.`);
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) throw new BadRequestException(`${label} is not a real date.`);
    return s;
}

export function checkRecurringRule(input: Record<string, unknown>): RecurringRule {
    const frequency = String(input.frequency ?? "");
    if (!(FREQUENCIES as readonly string[]).includes(frequency)) throw new BadRequestException("Choose daily, weekly, monthly or yearly.");
    const timezone = String(input.timezone ?? "UTC");
    if (!isValidTimezone(timezone)) throw new BadRequestException("That time zone is not recognised.");
    const time = String(input.time ?? "08:00");
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new BadRequestException("The time must look like 09:30.");

    const rule: RecurringRule = { frequency: frequency as Frequency, time, timezone, daysOfWeek: [], dayOfMonth: null, monthOfYear: null, startDate: parseDate("The start date", input.startDate), endDate: parseDate("The end date", input.endDate) };
    if (rule.startDate && rule.endDate && rule.endDate < rule.startDate) throw new BadRequestException("The end date is before the start date.");

    if (frequency === "weekly") {
        const raw = Array.isArray(input.daysOfWeek) ? input.daysOfWeek : [];
        const days = [...new Set(raw.map((d) => Number(d)))];
        if (!days.length || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw new BadRequestException("Choose at least one day of the week.");
        rule.daysOfWeek = days.sort((a, b) => a - b);
    }
    if (frequency === "monthly" || frequency === "yearly") {
        const day = Number(input.dayOfMonth ?? 1);
        if (!Number.isInteger(day) || (day !== -1 && (day < 1 || day > 31))) throw new BadRequestException("Choose a day of the month from 1 to 31, or the last day.");
        rule.dayOfMonth = day;
    }
    if (frequency === "yearly") {
        const month = Number(input.monthOfYear ?? 1);
        if (!Number.isInteger(month) || month < 1 || month > 12) throw new BadRequestException("Choose a month.");
        rule.monthOfYear = month;
        // Feb 31 never exists: say so instead of quietly using the 28th.
        if (rule.dayOfMonth !== -1 && rule.dayOfMonth! > daysInMonth(2024, month)) throw new BadRequestException(`${MONTHS[month - 1]} has no day ${rule.dayOfMonth}.`);
    }
    return rule;
}

function matches(rule: RecurringRule, y: number, m: number, d: number): boolean {
    const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    const dim = daysInMonth(y, m);
    switch (rule.frequency) {
        case "daily":
            return true;
        case "weekly":
            return rule.daysOfWeek.includes(weekday);
        case "monthly": {
            const want = rule.dayOfMonth ?? 1;
            // The 31st in a month with 30 days is the 30th, so "the 31st" never silently skips a month.
            return want === -1 ? d === dim : d === Math.min(want, dim);
        }
        case "yearly": {
            if (m !== (rule.monthOfYear ?? 1)) return false;
            const want = rule.dayOfMonth ?? 1;
            return want === -1 ? d === dim : d === Math.min(want, dim);
        }
    }
}

/** The first time after `after` the rule opens a ticket, or null when it never will (past its end date). */
export function nextRecurringRun(rule: RecurringRule, after: Date): Date | null {
    const [hour, minute] = rule.time.split(":").map(Number);
    const start = localParts(after.getTime(), rule.timezone);
    for (let i = 0; i <= MAX_LOOKAHEAD_DAYS; i++) {
        const base = new Date(Date.UTC(start.year, start.month - 1, start.day + i));
        const y = base.getUTCFullYear();
        const m = base.getUTCMonth() + 1;
        const d = base.getUTCDate();
        const key = dateKey(y, m, d);
        if (rule.endDate && key > rule.endDate) return null;
        if (rule.startDate && key < rule.startDate) continue;
        if (!matches(rule, y, m, d)) continue;
        const at = zonedTimeToUtc(y, m, d, hour, minute, rule.timezone);
        if (at > after.getTime()) return new Date(at);
    }
    return null;
}

/** The next few times, so a person sees exactly what they set up before saving. */
export function previewRecurringRuns(rule: RecurringRule, count = 5, after = new Date()): Date[] {
    const out: Date[] = [];
    let cursor = after;
    while (out.length < count) {
        const next = nextRecurringRun(rule, cursor);
        if (!next) break;
        out.push(next);
        cursor = next;
    }
    return out;
}

const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"}`;

export function describeRecurringRule(rule: RecurringRule): string {
    const [h, mi] = rule.time.split(":").map(Number);
    const where = `${((h + 11) % 12) + 1}:${String(mi).padStart(2, "0")} ${h < 12 ? "AM" : "PM"} (${rule.timezone})`;
    switch (rule.frequency) {
        case "daily":
            return `Every day at ${where}`;
        case "weekly": {
            const days = rule.daysOfWeek;
            if (days.length === 7) return `Every day at ${where}`;
            if (days.join() === "1,2,3,4,5") return `Every weekday at ${where}`;
            const names = days.map((d) => WEEKDAYS[d]);
            return `Every ${names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0]} at ${where}`;
        }
        case "monthly":
            return rule.dayOfMonth === -1 ? `The last day of every month at ${where}` : `The ${ordinal(rule.dayOfMonth ?? 1)} of every month at ${where}`;
        case "yearly":
            return rule.dayOfMonth === -1 ? `The last day of ${MONTHS[(rule.monthOfYear ?? 1) - 1]} every year at ${where}` : `Every year on ${MONTHS[(rule.monthOfYear ?? 1) - 1]} ${rule.dayOfMonth ?? 1} at ${where}`;
    }
}
