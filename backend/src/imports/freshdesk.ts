// Talking to Freshdesk's API (v2), and turning what it sends into what this system stores. No database here.

export class FreshdeskError extends Error {
    constructor(message: string, readonly status?: number) {
        super(message);
    }
    /** The key was refused or lacks the right: nothing more can be read with it. */
    get fatal(): boolean {
        return this.status === 401 || this.status === 403;
    }
}

/** "acme", "acme.freshdesk.com" and "https://acme.freshdesk.com/helpdesk" all mean the same account. */
export function freshdeskHost(input: string): string {
    let s = String(input ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").split(/[/?#]/)[0].replace(/\.+$/, "");
    if (!s) throw new FreshdeskError("Enter your Freshdesk address, like yourcompany.freshdesk.com.");
    if (!s.includes(".")) s = `${s}.freshdesk.com`;
    // Only Freshdesk's own addresses: this server fetches from it, so it must not be pointed anywhere else.
    if (!/^[a-z0-9][a-z0-9-]*\.freshdesk\.com$/.test(s)) throw new FreshdeskError("That is not a Freshdesk address. It looks like yourcompany.freshdesk.com.");
    return s;
}

type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class FreshdeskClient {
    constructor(
        private readonly baseUrl: string,
        private readonly apiKey: string,
        private readonly opts: { sleep?: Sleep; minDelayMs?: number; maxPages?: number } = {}
    ) { }

    private get sleep(): Sleep {
        return this.opts.sleep ?? realSleep;
    }

    /** One call, waiting out rate limits and retrying brief failures. */
    async get<T = any>(path: string, params: Record<string, string | number> = {}): Promise<T> {
        const url = new URL(`${this.baseUrl}${path}`);
        for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
        const auth = `Basic ${Buffer.from(`${this.apiKey}:X`).toString("base64")}`;

        let lastError = "";
        for (let attempt = 0; attempt < 7; attempt++) {
            if (this.opts.minDelayMs) await this.sleep(this.opts.minDelayMs);
            let res: Response;
            try {
                res = await fetch(url, { headers: { authorization: auth, accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
            } catch (e: any) {
                lastError = String(e?.message ?? e);
                await this.sleep(1000 * 2 ** Math.min(attempt, 3));
                continue;
            }
            if (res.status === 429) {
                const wait = Math.min(Math.max(Number(res.headers.get("retry-after")) || 30, 1), 120);
                lastError = "Freshdesk is limiting requests";
                await this.sleep(wait * 1000);
                continue;
            }
            if (res.status >= 500) {
                lastError = `Freshdesk returned HTTP ${res.status}`;
                await this.sleep(1000 * 2 ** Math.min(attempt, 3));
                continue;
            }
            if (res.status === 401) throw new FreshdeskError("Freshdesk refused the API key. Check the key and the address.", 401);
            if (res.status === 403) throw new FreshdeskError("This API key is not allowed to read that. Use the key of an administrator.", 403);
            if (res.status === 404) throw new FreshdeskError("Not found.", 404);
            if (!res.ok) throw new FreshdeskError(`Freshdesk returned HTTP ${res.status}.`, res.status);
            return (await res.json()) as T;
        }
        throw new FreshdeskError(`${lastError || "Freshdesk could not be reached"}.`);
    }

    /** A list, a page at a time (100 each), until there are no more. */
    async *pages<T = any>(path: string, params: Record<string, string | number> = {}, maxPages = this.opts.maxPages ?? 300): AsyncGenerator<T[]> {
        for (let page = 1; page <= maxPages; page++) {
            const items = await this.get<T[]>(path, { ...params, per_page: 100, page });
            if (!Array.isArray(items) || items.length === 0) return;
            yield items;
            if (items.length < 100) return;
        }
    }

    /**
     * Every ticket, oldest change first. Freshdesk stops a list after 300 pages, so a long list is read in windows:
     * the next one starts at the last change seen. A ticket seen twice at the edge of a window is returned once.
     */
    async *tickets(extra: Record<string, string | number> = {}): AsyncGenerator<any[]> {
        const seen = new Set<string>();
        let since = "2000-01-01T00:00:00Z";
        for (;;) {
            let last: any = null;
            let count = 0;
            let full = false;
            const cap = this.opts.maxPages ?? 300;
            for (let page = 1; page <= cap; page++) {
                const items = await this.get<any[]>("/tickets", { ...extra, updated_since: since, order_by: "updated_at", order_type: "asc", per_page: 100, page });
                if (!Array.isArray(items) || items.length === 0) break;
                count += items.length;
                last = items[items.length - 1];
                const fresh = items.filter((t) => !seen.has(String(t.id)));
                fresh.forEach((t) => seen.add(String(t.id)));
                if (fresh.length) yield fresh;
                if (items.length < 100) break;
                if (page === cap) full = true;
            }
            if (!full || !last?.updated_at || last.updated_at === since) return;
            since = last.updated_at;
            void count;
        }
    }
}

// ---- Mapping ---------------------------------------------------------------------------------------------------

export const STATUS_MAP: Record<number, "open" | "pending" | "resolved" | "closed"> = { 2: "open", 3: "pending", 4: "resolved", 5: "closed" };
export const STATUS_NAMES: Record<number, string> = { 2: "Open", 3: "Pending", 4: "Resolved", 5: "Closed" };
const PRIORITY_MAP: Record<number, "low" | "normal" | "high" | "urgent"> = { 1: "low", 2: "normal", 3: "high", 4: "urgent" };

/** Custom statuses (6 and up) have no equivalent here: they become open, and the preview says how many. */
export function mapStatus(n: unknown): { status: "open" | "pending" | "resolved" | "closed"; known: boolean } {
    const s = STATUS_MAP[Number(n)];
    return s ? { status: s, known: true } : { status: "open", known: false };
}

export function mapPriority(n: unknown): "low" | "normal" | "high" | "urgent" {
    return PRIORITY_MAP[Number(n)] ?? "normal";
}

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'", "&nbsp;": " " };

/** Plain text from HTML, for the (few) places Freshdesk only sends HTML. */
export function htmlToText(html: unknown): string {
    return String(html ?? "")
        .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => ENTITIES[m] ?? m)
        .replace(/\r\n?/g, "\n")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

export const MAX_TEXT = 50_000;

/** The text of a ticket or reply: Freshdesk's plain version when it sent one. */
export function textOf(o: { body_text?: unknown; description_text?: unknown; body?: unknown; description?: unknown }): string {
    const plain = String(o.body_text ?? o.description_text ?? "").trim();
    const text = plain || htmlToText(o.body ?? o.description);
    return text.slice(0, MAX_TEXT);
}

/** "1:30", "01:30" and 90 (seconds are ignored) to minutes. */
export function minutesOf(spent: unknown): number {
    if (typeof spent === "number") return Math.max(0, Math.round(spent));
    const m = /^(\d+):(\d{1,2})(?::\d+)?$/.exec(String(spent ?? "").trim());
    return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
}

/** A file name that is safe to show and to use as an extension source. */
export function safeName(name: unknown): string {
    return String(name ?? "").replace(/[\\/\0\r\n]/g, "_").trim().slice(0, 200) || "file";
}
