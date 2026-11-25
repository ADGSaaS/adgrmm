// The rules of the schedule that need no database: statuses, time zones, working hours, overlaps and the ICS invite.
// Pure, so it can be tested alone.
import { BadRequestException } from "@nestjs/common";

export const VISIT_STATUSES = ["scheduled", "en_route", "on_site", "done", "cancelled"] as const;
export type VisitStatus = (typeof VISIT_STATUSES)[number];
/** Statuses that hold a technician's time. A finished or cancelled visit does not block anyone. */
export const ACTIVE_STATUSES: VisitStatus[] = ["scheduled", "en_route", "on_site"];
export const MAX_VISIT_HOURS = 24;
export const MAX_TECHS_PER_VISIT = 10;

export type WorkDay = { on: boolean; start: string; end: string };
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function defaultHours(): WorkDay[] {
    return Array.from({ length: 7 }, (_, i) => ({ on: i < 5, start: "08:00", end: "17:00" }));
}

export function isValidTimeZone(tz: unknown): tz is string {
    if (typeof tz !== "string" || !tz || tz.length > 64) return false;
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: tz });
        return true;
    } catch {
        return false;
    }
}

export function parseHours(input: unknown): WorkDay[] {
    if (!Array.isArray(input) || input.length !== 7) throw new BadRequestException("Working hours need an entry for each of the seven days, Monday first.");
    return input.map((d: any, i) => {
        const on = d?.on === true;
        const start = String(d?.start ?? "08:00");
        const end = String(d?.end ?? "17:00");
        if (!HHMM.test(start) || !HHMM.test(end)) throw new BadRequestException(`Day ${i + 1}: use times like 08:30.`);
        if (on && toMinutes(end) <= toMinutes(start)) throw new BadRequestException(`Day ${i + 1}: the end must be after the start.`);
        return { on, start, end };
    });
}

export const toMinutes = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** The weekday (0 = Monday) and minutes since midnight of an instant in a time zone, plus its local date. */
export function localParts(d: Date, tz: string): { weekday: number; minutes: number; date: string } {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" }).formatToParts(d);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    const wd = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(get("weekday"));
    return { weekday: wd, minutes: Number(get("hour")) * 60 + Number(get("minute")), date: `${get("year")}-${get("month")}-${get("day")}` };
}

/** True when the whole span lies inside the person's working hours for one local day. */
export function withinWorkingHours(start: Date, end: Date, tz: string, hours: WorkDay[]): boolean {
    const s = localParts(start, tz);
    const e = localParts(new Date(end.getTime() - 1000), tz);
    if (s.date !== e.date) return false;
    const day = hours[s.weekday];
    if (!day || !day.on) return false;
    return s.minutes >= toMinutes(day.start) && e.minutes + 1 <= toMinutes(day.end);
}

export const overlaps = (aStart: Date, aEnd: Date, bStart: Date, bEnd: Date) => aStart < bEnd && bStart < aEnd;

export type Conflict = { kind: "visit" | "time_off" | "outside_hours"; userId: string; message: string; visitId?: string; ticketNumber?: string };

export function parseRange(startsAt: unknown, endsAt: unknown): { start: Date; end: Date } {
    const start = new Date(String(startsAt ?? ""));
    const end = new Date(String(endsAt ?? ""));
    if (typeof startsAt !== "string" || typeof endsAt !== "string" || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw new BadRequestException("Give a start and an end time.");
    if (end <= start) throw new BadRequestException("The visit must end after it starts.");
    if (end.getTime() - start.getTime() > MAX_VISIT_HOURS * 3600_000) throw new BadRequestException("A visit can be at most 24 hours long. Book more than one for longer jobs.");
    if (start.getUTCFullYear() < 2000 || start.getUTCFullYear() > 2100) throw new BadRequestException("The date is not valid.");
    return { start, end };
}

/* ----------------------------------- ICS ---------------------------------- */

const icsText = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const icsStamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/** Folds a content line at 75 octets, as RFC 5545 asks. */
export function foldLine(line: string): string {
    const out: string[] = [];
    let cur = "";
    let bytes = 0;
    for (const ch of line) {
        const n = new TextEncoder().encode(ch).length;
        if (bytes + n > (out.length === 0 ? 75 : 74)) {
            out.push(cur);
            cur = "";
            bytes = 0;
        }
        cur += ch;
        bytes += n;
    }
    out.push(cur);
    return out.join("\r\n ");
}

export function buildIcs(v: { id: string; title: string; description?: string | null; location?: string | null; startsAt: Date; endsAt: Date; sequence: number; cancelled: boolean; updatedAt?: Date }): string {
    const lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//RemoteIQ//Dispatch//EN",
        "CALSCALE:GREGORIAN",
        `METHOD:${v.cancelled ? "CANCEL" : "PUBLISH"}`,
        "BEGIN:VEVENT",
        `UID:${v.id}@remoteiq`,
        `DTSTAMP:${icsStamp(v.updatedAt ?? new Date())}`,
        `SEQUENCE:${v.sequence}`,
        `DTSTART:${icsStamp(v.startsAt)}`,
        `DTEND:${icsStamp(v.endsAt)}`,
        `SUMMARY:${icsText(v.title)}`,
        ...(v.description ? [`DESCRIPTION:${icsText(v.description)}`] : []),
        ...(v.location ? [`LOCATION:${icsText(v.location)}`] : []),
        `STATUS:${v.cancelled ? "CANCELLED" : "CONFIRMED"}`,
        "END:VEVENT",
        "END:VCALENDAR",
    ];
    return lines.map(foldLine).join("\r\n") + "\r\n";
}

/** "Tue 17 Nov 2026, 09:00 to 10:30 (Europe/London)" for emails. */
export function describeSpan(start: Date, end: Date, tz: string): string {
    const day = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short", year: "numeric" }).format(start);
    const t = (d: Date) => new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
    return `${day}, ${t(start)} to ${t(end)} (${tz})`;
}
