// Helpers for searching tickets, including the words inside replies and private notes.

/** The text turned into a LIKE pattern, so a % or _ typed by someone is just a character. */
export function likePattern(text: string): string {
    return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** The part of a long text around the first place a search term appears, with ... where it was cut. */
export function snippetAround(text: string, term: string, radius = 60): string {
    const flat = String(text ?? "").replace(/\s+/g, " ").trim();
    const at = flat.toLowerCase().indexOf(term.toLowerCase());
    if (at < 0) return flat.slice(0, radius * 2) + (flat.length > radius * 2 ? "…" : "");
    const from = Math.max(0, at - radius);
    const to = Math.min(flat.length, at + term.length + radius);
    return `${from > 0 ? "…" : ""}${flat.slice(from, to)}${to < flat.length ? "…" : ""}`;
}

/** Where in a ticket the words were found, when it was not in its subject. */
export type TicketMatch = {
    in: "reply" | "customer reply" | "private note" | "description" | "custom field" | "device" | "requester";
    author: string;
    snippet: string;
};
