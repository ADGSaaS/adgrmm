"use client";

import * as React from "react";
import { X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { jfetch } from "@/lib/api";
import { Field } from "@/components/policies/shared";

type Lib = { id: string; name: string; category: string; matchText: string; devices: number };
type Seen = { name: string; publisher: string | null; devices: number };

// The three pickers in one editor share what they know about endpoint counts, so it is asked for once a minute at most.
let countsCache: { at: number; promise: Promise<Map<string, number>> } | null = null;
function loadCounts(): Promise<Map<string, number>> {
    if (countsCache && Date.now() - countsCache.at < 60_000) return countsCache.promise;
    const promise = Promise.all([
        jfetch<{ items: Lib[] }>("/api/software-library").then((r) => r.items).catch(() => [] as Lib[]),
        jfetch<{ items: Seen[] }>("/api/software-library/seen").then((r) => r.items).catch(() => [] as Seen[]),
    ]).then(([lib, seen]) => {
        const m = new Map<string, number>();
        seen.forEach((s) => m.set(s.name.toLowerCase(), s.devices));
        lib.forEach((l) => m.set(l.matchText.toLowerCase(), l.devices));
        return m;
    });
    countsCache = { at: Date.now(), promise };
    return promise;
}

/**
 * Picks programs for a policy list: library entries first, then names seen on endpoints, then anything typed.
 * Chosen items are plain strings (the match text or typed name), shown as chips with their endpoint count where known.
 */
export function SoftwarePicker({ id, label, hint, value, onChange }: { id: string; label: string; hint?: string; value: string[]; onChange: (next: string[]) => void }) {
    const [text, setText] = React.useState("");
    const [lib, setLib] = React.useState<Lib[]>([]);
    const [seen, setSeen] = React.useState<Seen[]>([]);
    const [counts, setCounts] = React.useState<Map<string, number>>(new Map());
    const [loading, setLoading] = React.useState(false);

    React.useEffect(() => {
        let stale = false;
        loadCounts().then((m) => { if (!stale) setCounts(m); });
        return () => { stale = true; };
    }, []);

    React.useEffect(() => {
        let stale = false;
        setLoading(true);
        const q = encodeURIComponent(text.trim());
        const t = setTimeout(() => {
            Promise.all([
                jfetch<{ items: Lib[] }>(`/api/software-library?q=${q}`).then((r) => r.items).catch(() => [] as Lib[]),
                jfetch<{ items: Seen[] }>(`/api/software-library/seen?q=${q}`).then((r) => r.items).catch(() => [] as Seen[]),
            ]).then(([l, s]) => { if (!stale) { setLib(l.slice(0, 50)); setSeen(s.slice(0, 50)); setLoading(false); } });
        }, text ? 200 : 0);
        return () => { stale = true; clearTimeout(t); };
    }, [text]);

    const has = (s: string) => value.some((v) => v.toLowerCase() === s.toLowerCase());
    const add = (s: string) => {
        const v = s.trim();
        if (!v || has(v)) return;
        onChange([...value, v]);
        setText("");
    };
    const typed = text.trim();
    const libShown = lib.filter((l) => !has(l.matchText));
    const seenShown = seen.filter((s) => !has(s.name));
    const countText = (n: number | undefined) => (n === undefined ? "" : `${n} endpoint${n === 1 ? "" : "s"}`);

    return (
        <Field label={label} htmlFor={id} hint={hint}>
            <div className="flex min-h-9 flex-wrap gap-1" aria-label={`${label}, chosen`}>
                {value.length === 0 && <span className="py-1 text-xs text-muted-foreground">None chosen</span>}
                {value.map((v) => {
                    const n = counts.get(v.toLowerCase());
                    return (
                        <span key={v} className="inline-flex max-w-full items-center gap-1 rounded-md border bg-muted px-2 py-0.5 text-xs">
                            <span className="break-all font-medium">{v}</span>
                            {n !== undefined && <span className="whitespace-nowrap text-muted-foreground">{countText(n)}</span>}
                            <button type="button" aria-label={`Remove ${v}`} className="text-muted-foreground hover:text-foreground" onClick={() => onChange(value.filter((x) => x !== v))}><X className="h-3 w-3" aria-hidden /></button>
                        </span>
                    );
                })}
            </div>
            <Input
                id={id}
                value={text}
                placeholder="Search, or type a name and press Enter"
                autoComplete="off"
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(text); } }}
            />
            <div className="h-44 overflow-y-auto rounded-md border bg-card text-sm" role="listbox" aria-label={`${label}, suggestions`}>
                {typed && !has(typed) && (
                    <button type="button" className="block w-full border-b px-2 py-1.5 text-left hover:bg-accent" onClick={() => add(typed)}>
                        Add &quot;{typed}&quot; as typed
                    </button>
                )}
                {libShown.length > 0 && <div className="px-2 pt-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Library</div>}
                {libShown.map((l) => (
                    <button key={l.id} type="button" role="option" aria-selected={false} className="flex w-full items-baseline justify-between gap-2 px-2 py-1.5 text-left hover:bg-accent" onClick={() => add(l.matchText)}>
                        <span className="min-w-0 break-words"><span className="font-medium">{l.name}</span> <span className="text-xs text-muted-foreground">{l.category}</span></span>
                        <span className="whitespace-nowrap text-xs text-muted-foreground">{countText(l.devices)}</span>
                    </button>
                ))}
                {seenShown.length > 0 && <div className="px-2 pt-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Seen on endpoints</div>}
                {seenShown.map((s) => (
                    <button key={s.name} type="button" role="option" aria-selected={false} className="flex w-full items-baseline justify-between gap-2 px-2 py-1.5 text-left hover:bg-accent" onClick={() => add(s.name)}>
                        <span className="min-w-0 break-words">{s.name}</span>
                        <span className="whitespace-nowrap text-xs text-muted-foreground">{countText(s.devices)}</span>
                    </button>
                ))}
                {!loading && !typed && libShown.length === 0 && seenShown.length === 0 && <p className="px-2 py-2 text-xs text-muted-foreground">Nothing to suggest. Type a name and press Enter.</p>}
                {!loading && typed && libShown.length === 0 && seenShown.length === 0 && <p className="px-2 py-2 text-xs text-muted-foreground">No match in the library or on your endpoints.</p>}
            </div>
        </Field>
    );
}
