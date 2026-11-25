// The schedule's calls (technician visits, working hours, time off) and the time zone helpers the board and the
// visit dialog share.
import { jfetch } from "@/lib/api";

export type VisitStatus = "scheduled" | "en_route" | "on_site" | "done" | "cancelled";
export const STATUS_LABEL: Record<VisitStatus, string> = { scheduled: "Scheduled", en_route: "En route", on_site: "On site", done: "Done", cancelled: "Cancelled" };

export type Visit = {
    id: string;
    ticketId: string;
    ticketNumber: string | null;
    ticketSubject: string | null;
    ticketStatus: string | null;
    clientId: string | null;
    clientName: string | null;
    title: string;
    notes: string | null;
    location: string | null;
    status: VisitStatus;
    startsAt: string;
    endsAt: string;
    timeZone: string;
    customerNotifiedAt: string | null;
    timeEntryId: string | null;
    techs: { id: string; name: string }[];
};

export type WorkDay = { on: boolean; start: string; end: string };
export type Tech = { id: string; name: string; email: string; timeZone: string; hours: WorkDay[]; configured: boolean };
export type TimeOff = { id: string; userId: string; startsAt: string; endsAt: string; reason: string | null };
export type Unscheduled = { id: string; number: string; subject: string; priority: string; status: string; dueAt: string | null; clientName: string | null; assigneeId: string | null };
export type Conflict = { kind: "visit" | "time_off" | "outside_hours"; userId: string; message: string };
export type Notified = { techs: number; customer: boolean; note: string };

export type VisitInput = {
    ticketId?: string;
    startsAt?: string;
    endsAt?: string;
    techIds?: string[];
    title?: string;
    notes?: string;
    location?: string;
    timeZone?: string;
    status?: VisitStatus;
    notifyTechs?: boolean;
    notifyCustomer?: boolean;
    force?: boolean;
    logTime?: { minutes?: number; billable?: boolean };
};

const qs = (params: Record<string, string | undefined | null>) => {
    const s = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) s.set(k, v);
    const t = s.toString();
    return t ? `?${t}` : "";
};

export const schedule = {
    visits: (p: { from?: string; to?: string; techId?: string; ticketId?: string; status?: string }) => jfetch<{ items: Visit[] }>(`/api/schedule/visits${qs(p)}`),
    unscheduled: (q?: string) => jfetch<{ items: Unscheduled[] }>(`/api/schedule/unscheduled${qs({ q })}`),
    techs: () => jfetch<{ items: Tech[] }>("/api/schedule/techs"),
    timeOff: (from: string, to: string) => jfetch<{ items: TimeOff[] }>(`/api/schedule/time-off${qs({ from, to })}`),
    addTimeOff: (b: { userId: string; startsAt: string; endsAt: string; reason?: string }) => jfetch<{ id: string }>("/api/schedule/time-off", { method: "POST", body: b }),
    removeTimeOff: (id: string) => jfetch<{ ok: true }>(`/api/schedule/time-off/${id}`, { method: "DELETE" }),
    setAvailability: (userId: string, b: { timeZone: string; hours: WorkDay[] }) => jfetch<{ ok: true }>(`/api/schedule/availability/${userId}`, { method: "PUT", body: b }),
    conflicts: (b: VisitInput & { ignoreVisitId?: string }) => jfetch<{ conflicts: Conflict[] }>("/api/schedule/visits/conflicts", { method: "POST", body: b }),
    create: (b: VisitInput) => jfetch<Visit & { conflicts: Conflict[]; notified: Notified }>("/api/schedule/visits", { method: "POST", body: b }),
    update: (id: string, b: VisitInput) => jfetch<Visit & { conflicts: Conflict[]; notified: Notified; timeLogged: number }>(`/api/schedule/visits/${id}`, { method: "PATCH", body: b }),
    remove: (id: string) => jfetch<{ ok: true }>(`/api/schedule/visits/${id}`, { method: "DELETE" }),
    icsUrl: (id: string) => `${(process.env.NEXT_PUBLIC_API_BASE || "").replace(/\/+$/, "")}/api/schedule/visits/${id}/ics`,
};

/** What was sent, in a sentence for a toast. */
export function notifiedText(n: Notified | undefined): string {
    if (!n) return "";
    const parts: string[] = [];
    if (n.techs) parts.push(`${n.techs} technician${n.techs === 1 ? "" : "s"} emailed`);
    if (n.customer) parts.push("customer emailed");
    if (!parts.length && n.note) return n.note;
    return parts.join(", ");
}

/* ------------------------------ time zones ------------------------------ */

export const browserZone = (): string => {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
        return "UTC";
    }
};

export function allZones(): string[] {
    try {
        const f = (Intl as any).supportedValuesOf?.("timeZone") as string[] | undefined;
        if (f?.length) return f.includes("UTC") ? f : ["UTC", ...f];
    } catch { /* older browser */ }
    return ["UTC", "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "Europe/London", "Europe/Berlin", "Asia/Tokyo", "Australia/Sydney"];
}

function wall(d: Date, tz: string) {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(d);
    const g = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
    return { y: g("year"), m: g("month"), d: g("day"), h: g("hour"), min: g("minute") };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** An instant as "YYYY-MM-DDTHH:mm" on the wall clock of a time zone, for a datetime-local box. */
export function toZonedInput(iso: string | Date, tz: string): string {
    const w = wall(typeof iso === "string" ? new Date(iso) : iso, tz);
    return `${w.y}-${pad(w.m)}-${pad(w.d)}T${pad(w.h)}:${pad(w.min)}`;
}

/** What a time on a time zone's wall clock is as an instant. Right across daylight saving changes except in the hour that does not exist. */
export function fromZonedInput(local: string, tz: string): Date {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(local);
    if (!m) return new Date(NaN);
    const target = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
    let guess = target;
    for (let i = 0; i < 3; i++) {
        const w = wall(new Date(guess), tz);
        guess += target - Date.UTC(w.y, w.m - 1, w.d, w.h, w.min);
    }
    return new Date(guess);
}

/** Is this instant inside the technician's working hours (in their own zone)? Unconfigured people are always "working". */
export function isWorking(at: Date, tech: Tech | undefined): boolean {
    if (!tech || !tech.configured) return true;
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tech.timeZone, hourCycle: "h23", hour: "2-digit", minute: "2-digit", weekday: "short" }).formatToParts(at);
    const wd = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(parts.find((p) => p.type === "weekday")?.value ?? "");
    const mins = Number(parts.find((p) => p.type === "hour")?.value) * 60 + Number(parts.find((p) => p.type === "minute")?.value);
    const day = tech.hours[wd];
    if (!day?.on) return false;
    const [sh, sm] = day.start.split(":").map(Number);
    const [eh, em] = day.end.split(":").map(Number);
    return mins >= sh * 60 + sm && mins < eh * 60 + em;
}
