// The rules for turning an email into a ticket or a ticket reply. Kept free of the database and the network so
// they can be tested on their own.

/** The tag put in a subject so a customer's reply finds its ticket: "[#123]". */
export function ticketTag(ticketNumber: number | string): string {
    return `[#${ticketNumber}]`;
}

/** The ticket number named in a subject, in the form "[#123]" (the older "[TICKET:#123]" works too). */
export function ticketNumberFromSubject(subject: string | null | undefined): number | null {
    const m = /\[(?:TICKET:)?#(\d{1,12})\]/i.exec(String(subject ?? ""));
    if (!m) return null;
    const n = Number(m[1]);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** The subject without "Re:", "Fwd:" prefixes and without the ticket tag. */
export function cleanSubject(subject: string | null | undefined): string {
    let s = String(subject ?? "").replace(/\[(?:TICKET:)?#\d{1,12}\]/gi, " ");
    for (;;) {
        const next = s.replace(/^\s*(re|fw|fwd|aw|wg|sv|vs)\s*:\s*/i, "");
        if (next === s) break;
        s = next;
    }
    s = s.replace(/\s+/g, " ").trim();
    return s.slice(0, 300) || "(no subject)";
}

/** Message ids from In-Reply-To and References, without the angle brackets, newest reference first. */
export function referencedMessageIds(inReplyTo: unknown, references: unknown): string[] {
    const out: string[] = [];
    const add = (v: unknown) => {
        const text = Array.isArray(v) ? v.join(" ") : String(v ?? "");
        for (const m of text.matchAll(/<([^<>\s]+)>/g)) out.push(m[1]);
    };
    add(inReplyTo);
    const refs: string[] = [];
    const before = out.length;
    add(references);
    refs.push(...out.splice(before).reverse());
    return [...new Set([...out, ...refs])];
}

export type SkipReason = "own-mail" | "bounce" | "automatic" | "mailing-list" | "no-sender";

/**
 * Mail a person did not write, or that must never become a ticket: the mailbox's own mail, bounces, automatic
 * replies (out-of-office) and mailing lists. Ignoring these is what keeps two mailboxes from answering each
 * other forever.
 */
export function skipReason(msg: {
    fromAddress: string | null;
    mailboxAddress: string;
    subject: string | null;
    headers: Record<string, string | undefined>;
}): SkipReason | null {
    const from = (msg.fromAddress ?? "").trim().toLowerCase();
    if (!from) return "no-sender";
    if (from === msg.mailboxAddress.trim().toLowerCase()) return "own-mail";

    const h = (name: string) => (msg.headers[name.toLowerCase()] ?? "").toString().trim().toLowerCase();
    if (/^(mailer-daemon|postmaster)@/.test(from) || h("content-type").includes("report-type=delivery-status")) return "bounce";
    if (/^(undeliverable|delivery (status|failure)|mail delivery (failed|subsystem)|returned mail)/i.test(String(msg.subject ?? "").trim())) return "bounce";

    const auto = h("auto-submitted");
    if (auto && auto !== "no") return "automatic";
    if (["bulk", "junk", "list", "auto_reply"].includes(h("precedence"))) return "automatic";
    if (h("x-auto-response-suppress")) return "automatic";
    if (/^(automatic reply|out of office|autoreply|auto-reply|automatische antwort)\b/i.test(String(msg.subject ?? "").trim())) return "automatic";
    if (h("list-id") || h("list-unsubscribe")) return "mailing-list";
    return null;
}

/**
 * The new text of a reply, without the quoted conversation under it. Looks for the usual markers ("On ... wrote:",
 * "-----Original Message-----", a block of header lines, quoted lines). When nothing is found, or cutting would
 * leave nothing, the whole text is kept: losing someone's words is worse than keeping a quote.
 */
export function newTextOnly(text: string): string {
    const body = String(text ?? "").replace(/\r\n?/g, "\n");
    const lines = body.split("\n");
    let cut = lines.length;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        const next = (lines[i + 1] ?? "").trim();
        const joined = `${line} ${next}`;
        if (
            /^-{2,}\s*(original message|forwarded message|reply above this line)\s*-{2,}$/i.test(line) ||
            /^_{5,}$/.test(line) ||
            /^on .{5,200}wrote:?$/i.test(line) ||
            (/^on .{5,200}$/i.test(line) && /^.{0,200}wrote:$/i.test(next) && /wrote:\s*$/i.test(joined)) ||
            /^le .{5,200}a écrit\s*:?$/i.test(line) ||
            (/^from:\s.+/i.test(line) && /^(sent|date):\s/i.test(next)) ||
            /^>+\s?/.test(line) && lines.slice(i, i + 3).every((l) => /^>/.test(l.trim()) || l.trim() === "")
        ) {
            cut = i;
            break;
        }
    }
    const kept = lines.slice(0, cut).join("\n").trim();
    return kept.length > 0 ? kept : body.trim();
}

/** How many tickets or replies one sender may start in an hour before the rest are held back. */
export const MAX_PER_SENDER_PER_HOUR = 20;

/** A reply to the customer: the ticket tag goes in the subject so their answer finds the ticket again. */
export function replySubject(ticketNumber: number | string, subject: string): string {
    const base = cleanSubject(subject);
    return `Re: ${base} ${ticketTag(ticketNumber)}`;
}
