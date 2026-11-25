// components/overview/format.ts
// One way to write numbers and times on the Overview page.

const int = new Intl.NumberFormat("en-US");
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

/** 1234 becomes "1,234". */
export const fmt = (n: number | null | undefined): string => (n === null || n === undefined || !Number.isFinite(n) ? "—" : int.format(n));

/** 12500 becomes "12.5K"; small numbers stay whole. For tight places (chart axes, long lists). */
export const fmtCompact = (n: number): string => (Math.abs(n) < 10_000 ? int.format(n) : compact.format(n));

/** A share as a whole percent: "62%". */
export const pct = (part: number, whole: number): string => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : "0%");

/** "5 min ago", "3 hours ago", "yesterday", "12 days ago". */
export function ago(iso: string | null | undefined, now = Date.now()): string {
    if (!iso) return "never";
    const ms = now - Date.parse(iso);
    if (!Number.isFinite(ms)) return "never";
    const m = Math.round(ms / 60_000);
    if (m < 1) return "just now";
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h} ${h === 1 ? "hour" : "hours"} ago`;
    const d = Math.round(h / 24);
    return d === 1 ? "yesterday" : `${d} days ago`;
}

/** "14:05" in the person's own time zone and style. */
export const clock = (iso: string | number | Date): string => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** "Today 14:05", "Tomorrow 09:00", or "Tue 09:00". */
export function when(iso: string, now = new Date()): string {
    const d = new Date(iso);
    const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const days = Math.round((start(d) - start(now)) / 86_400_000);
    const t = clock(d);
    if (days === 0) return `Today ${t}`;
    if (days === 1) return `Tomorrow ${t}`;
    return `${d.toLocaleDateString([], { weekday: "short" })} ${t}`;
}
