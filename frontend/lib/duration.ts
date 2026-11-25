// Typing time the way people say it. "90", "1:30", "1h 30m", "45 min", "1.5h" and "1.5" all work.

export const MAX_MINUTES = 24 * 60;

/** Minutes for what a person typed, or null when it is not a time. A bare whole number is minutes; a bare decimal is hours. */
export function parseDuration(input: string): number | null {
    const s = String(input ?? "").trim().toLowerCase();
    if (!s) return null;
    let minutes: number | null = null;

    const clock = /^(\d{1,2}):([0-5]?\d)$/.exec(s);
    if (clock) minutes = Number(clock[1]) * 60 + Number(clock[2]);
    else if (/^\d+$/.test(s)) minutes = Number(s);
    else if (/^\d*\.\d+$/.test(s)) minutes = Math.round(Number(s) * 60);
    else {
        // Pieces such as "1h", "30m", "1.5h", "1 hr 30 min", in either order.
        const re = /(\d*\.?\d+)\s*(hours?|hrs?|h|minutes?|mins?|m)(?![a-z])/g;
        let rest = s;
        let total = 0;
        let found = false;
        for (const m of s.matchAll(re)) {
            found = true;
            total += Number(m[1]) * (m[2].startsWith("h") ? 60 : 1);
            rest = rest.replace(m[0], " ");
        }
        if (found && !rest.replace(/[\s,]|and/g, "")) minutes = Math.round(total);
    }

    if (minutes === null || !Number.isFinite(minutes) || minutes < 1 || minutes > MAX_MINUTES) return null;
    return minutes;
}

/** "45 min", "2 h", "1 h 30 min". */
export function formatMinutes(minutes: number): string {
    const m = Math.max(0, Math.round(minutes));
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60);
    const rest = m % 60;
    return rest ? `${h} h ${rest} min` : `${h} h`;
}

/** 00:12:30 */
export function clock(totalSeconds: number): string {
    const s = Math.max(0, Math.floor(totalSeconds));
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}
