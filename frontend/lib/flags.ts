// lib/flags.ts
//
// Feature flags, as the screens read them. An administrator switches each flag per organization under
// Administration > Feature Flags, and the server answers with the effective on/off for the signed-in person.
// While the answer is on its way, or if it cannot be had, a flag reads as `whenUnknown` (on by default), which is
// how the product behaved before the flag existed. The server checks the same flag again for anything it guards.
"use client";

import * as React from "react";
import { jfetch } from "@/lib/api";

export type Flags = Record<string, boolean>;

let cache: { flags: Flags; at: number } | null = null;
let inflight: Promise<Flags | null> | null = null;
const listeners = new Set<() => void>();
const FRESH_MS = 30_000;

async function load(force = false): Promise<Flags | null> {
    if (!force && cache && Date.now() - cache.at < FRESH_MS) return cache.flags;
    if (inflight) return inflight;
    inflight = jfetch<{ flags: Flags }>("/api/flags")
        .then((r) => {
            cache = { flags: r.flags ?? {}, at: Date.now() };
            listeners.forEach((l) => l());
            return cache.flags;
        })
        .catch(() => null)
        .finally(() => {
            inflight = null;
        });
    return inflight;
}

/** Fetch the flags again now, for instance after one was changed. Every screen that reads flags updates. */
export function refreshFlags(): Promise<Flags | null> {
    return load(true);
}

export function useFlags(): { flags: Flags | null; loading: boolean; refresh: () => Promise<Flags | null> } {
    const [flags, setFlags] = React.useState<Flags | null>(() => cache?.flags ?? null);
    React.useEffect(() => {
        let alive = true;
        const sync = () => {
            if (alive && cache) setFlags(cache.flags);
        };
        listeners.add(sync);
        void load().then(sync);
        return () => {
            alive = false;
            listeners.delete(sync);
        };
    }, []);
    return { flags, loading: flags === null, refresh: refreshFlags };
}

/** True when the flag is on. Until it is known, `whenUnknown` is returned. */
export function useFlag(key: string, whenUnknown = true): boolean {
    const { flags } = useFlags();
    return flags && key in flags ? flags[key] : whenUnknown;
}
