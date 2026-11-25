// A readable list of what changed between two saved versions of something, for the audit log: one line per changed
// value, such as "targets.high.response: 60 -> 30". Pure, so it can be tested alone.

function walk(value: unknown, path: string, out: Map<string, string>): void {
    if (value && typeof value === "object" && !Array.isArray(value)) {
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) walk(v, path ? `${path}.${k}` : k, out);
        return;
    }
    out.set(path, Array.isArray(value) ? `[${value.map(String).join(", ")}]` : value === null || value === undefined ? "none" : String(value));
}

export function describeChanges(before: unknown, after: unknown, ignore: string[] = [], max = 40): string[] {
    const a = new Map<string, string>();
    const b = new Map<string, string>();
    walk(before ?? {}, "", a);
    walk(after ?? {}, "", b);
    const skip = (p: string) => ignore.some((i) => p === i || p.startsWith(`${i}.`));
    const lines: string[] = [];
    for (const key of new Set([...a.keys(), ...b.keys()])) {
        if (!key || skip(key)) continue;
        const was = a.get(key) ?? "none";
        const now = b.get(key) ?? "none";
        if (was !== now) lines.push(`${key}: ${was} -> ${now}`);
    }
    return lines.length > max ? [...lines.slice(0, max), `and ${lines.length - max} more`] : lines;
}
