// backend/src/device-tray/device-tray.core.ts
//
// The tray app on a device (request help, chat, see status): what may be saved and what a person at a device may send. Pure, so it can be
// tested alone. Everything that comes from a device is typed by whoever sits at it, so it is cleaned before it is stored.
import { BadRequestException } from "@nestjs/common";

export const MAX_MESSAGE_CHARS = 2000;
/** A help request makes a ticket, so one device may not make many of them. */
export const HELP_PER_HOUR = 5;
/** A chat message from a device is a line of text; this many in ten minutes is a person typing, more is a script. */
export const CHAT_PER_10_MIN = 30;
export const KEEP_DAYS = 180;
/** Replies from a device to its tickets: this many in ten minutes is a person typing. */
export const TICKET_REPLIES_PER_10_MIN = 20;
/** The tickets of a device the tray lists: open ones, and ones solved in the last days (a reply reopens them). */
export const SOLVED_SHOWN_DAYS = 3;
/** The first message of a ticket is its description; the line the tray added at the end of it is not part of what the person wrote. */
export function stripTrayFooter(description: string): string {
    return description.replace(/\n*-- Sent from the tray app on [^\n]*$/, "").trim();
}
/** What one chat reply from the server holds at most. */
export const PAGE = 50;

export type TraySettings = {
    enabled: boolean; helpEnabled: boolean; chatEnabled: boolean; supportPhone: string | null; supportEmail: string | null; greeting: string | null;
    providerName: string | null; officeHours: string | null; website: string | null; contactName: string | null; afterHoursPhone: string | null; notice: string | null;
};

export const DEFAULT_SETTINGS: TraySettings = { enabled: false, helpEnabled: true, chatEnabled: true, supportPhone: null, supportEmail: null, greeting: null, providerName: null, officeHours: null, website: null, contactName: null, afterHoursPhone: null, notice: null };

/** Text a person typed: control characters become spaces (a newline stays one), the ends are trimmed, and it has to have something in it. */
export function cleanMessage(v: unknown, what = "message"): string {
    const s = String(v ?? "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    if (!s) throw new BadRequestException(`Write your ${what} first.`);
    if (s.length > MAX_MESSAGE_CHARS) throw new BadRequestException(`The ${what} is too long (${MAX_MESSAGE_CHARS} characters at most).`);
    return s;
}

/** The subject a person typed for a ticket: one line, 120 characters at most, empty when none was given. */
export function cleanSubject(v: unknown): string {
    const s = String(v ?? "").replace(/[\x00-\x1F\x7F]/g, " ").replace(/\s+/g, " ").trim();
    if (s.length > 120) throw new BadRequestException("The subject is too long (120 characters at most).");
    return s;
}

/** The email address a person typed for a ticket: lower case, a plain address, empty when none was given. */
export function cleanEmail(v: unknown): string {
    const s = String(v ?? "").replace(/[\u0000-\u001F\u007F]/g, " ").trim().toLowerCase();
    if (!s) return "";
    if (s.length > 200 || !/^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(s)) throw new BadRequestException("That is not a valid email address.");
    return s;
}

/** The name a person typed for themselves: one line, 120 characters at most, empty when none was given. */
export function cleanName(v: unknown): string {
    const s = String(v ?? "").replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
    if (s.length > 120) throw new BadRequestException("The name is too long (120 characters at most).");
    return s;
}

/** A phone number a person typed: digits and the usual signs only, empty when none was given. */
export function cleanPhone(v: unknown): string {
    const s = String(v ?? "").replace(/\s+/g, " ").trim();
    if (!s) return "";
    if (s.length > 40 || !/^[0-9+().\-x#* ]+$/.test(s) || (s.match(/[0-9]/g) ?? []).length < 5) throw new BadRequestException("That is not a valid phone number.");
    return s;
}

/** A chat with nothing said for this long is ended by itself (and its transcript emailed). */
export const CHAT_IDLE_MINUTES = Math.min(24 * 60, Math.max(5, Number(process.env.CHAT_IDLE_MINUTES) || 30));

/** A reason typed when a ticket is marked solved from the tray: it has to say something. */
export function cleanReason(v: unknown): string {
    const s = String(v ?? "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ").trim();
    if (s.length < 3) throw new BadRequestException("Please say why this is solved.");
    if (s.length > MAX_MESSAGE_CHARS) throw new BadRequestException(`The reason is too long (${MAX_MESSAGE_CHARS} characters at most).`);
    return s;
}

/** One chat as plain text, for the email and the copy kept with the ended chat. */
export function transcriptText(opts: { device: string; customer: string | null; started: Date; ended: Date; endedBy: string; contact: string; messages: Array<{ at: Date; sender: string; from: string; text: string }> }): string {
    const stamp = (d: Date) => d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
    const who = opts.endedBy === "user" ? "the person at the computer" : opts.endedBy === "technician" ? "support" : "inactivity (nothing was said for a while)";
    const lines = [
        "Chat transcript",
        `Computer: ${opts.device}${opts.customer ? ` (${opts.customer})` : ""}`,
        opts.contact ? `With: ${opts.contact}` : "",
        `Started: ${stamp(opts.started)}`,
        `Ended: ${stamp(opts.ended)}, by ${who}`,
        "",
        ...opts.messages.map((m) => `[${stamp(m.at)}] ${m.sender}${m.from === "support" ? " (support)" : ""}: ${m.text.replace(/\n/g, "\n    ")}`),
    ];
    return lines.filter((l, i) => l !== "" || i >= 5 || false).join("\n");
}

/** The name of the person at the device, as Windows gives it: for show only, never for who they are. */
export function cleanUser(v: unknown): string {
    const s = String(v ?? "").replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
    return s || "Someone at the device";
}

function cleanOptional(v: unknown, max: number, label: string): string | null {
    if (v === undefined || v === null) return null;
    const s = String(v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ").trim();
    if (!s) return null;
    if (s.length > max) throw new BadRequestException(`${label} is too long (${max} characters at most).`);
    return s;
}

/** A website people may click: http or https only, no credentials; a bare address such as example.com gets https. */
export function cleanWebsite(v: unknown): string | null {
    const raw = cleanOptional(v, 300, "The website");
    if (!raw) return null;
    const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
    let u: URL;
    try { u = new URL(withScheme); } catch { throw new BadRequestException("That is not a valid website address."); }
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new BadRequestException("The website must start with http:// or https://.");
    if (u.username || u.password) throw new BadRequestException("The website address must not contain a user name or password.");
    if (!u.hostname.includes(".")) throw new BadRequestException("That is not a valid website address.");
    return u.toString().slice(0, 300);
}

export function cleanSettings(input: Partial<Record<keyof TraySettings, unknown>>, before: TraySettings): TraySettings {
    const out = { ...before };
    for (const k of ["enabled", "helpEnabled", "chatEnabled"] as const) {
        if (input[k] === undefined) continue;
        if (typeof input[k] !== "boolean") throw new BadRequestException(`${k} must be true or false.`);
        out[k] = input[k] as boolean;
    }
    if (input.supportPhone !== undefined) out.supportPhone = cleanOptional(input.supportPhone, 40, "The phone number");
    if (input.supportEmail !== undefined) {
        const e = cleanOptional(input.supportEmail, 200, "The email address");
        if (e && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(e)) throw new BadRequestException("That is not a valid email address.");
        out.supportEmail = e;
    }
    if (input.greeting !== undefined) out.greeting = cleanOptional(input.greeting, 300, "The greeting");
    if (input.providerName !== undefined) out.providerName = cleanOptional(input.providerName, 120, "The provider name");
    if (input.officeHours !== undefined) out.officeHours = cleanOptional(input.officeHours, 300, "The office hours");
    if (input.contactName !== undefined) out.contactName = cleanOptional(input.contactName, 120, "The point of contact");
    if (input.afterHoursPhone !== undefined) out.afterHoursPhone = cleanOptional(input.afterHoursPhone, 40, "The after-hours phone number");
    if (input.notice !== undefined) out.notice = cleanOptional(input.notice, 400, "The notice");
    if (input.website !== undefined) out.website = cleanWebsite(input.website);
    return out;
}

/** The title of the ticket a help request makes. */
export function helpSubject(user: string, device: string, urgent: boolean): string {
    return `${urgent ? "URGENT help request" : "Help request"} from ${user} on ${device}`.slice(0, 200);
}

/** The words a technician sees in a notification about a chat line. */
export function preview(body: string, max = 140): string {
    const one = body.replace(/\s+/g, " ").trim();
    return one.length > max ? `${one.slice(0, max - 1)}...` : one;
}
