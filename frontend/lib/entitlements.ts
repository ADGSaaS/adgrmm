"use client";
// Seat limits of a hosted plan (GET /api/entitlements). A self-hosted install, and the public demo, answer { limits: null }:
// nothing in the web app shows anything then.
import * as React from "react";
import { jfetch } from "@/lib/api";

export type Entitlements = {
    limits: { maxEndpoints: number | null; maxTechnicians: number | null } | null;
    usage: { endpoints: number; technicians: number } | null;
    status: "active" | "past_due" | "suspended" | null;
    upgradeUrl: string | null;
    banner: { level: "info" | "warn" | "error"; text: string } | null;
};

const REFRESH_MS = 5 * 60_000;
const PUBLIC_PAGE = /^\/(login|forgot-password|pay|portal|survey|invite)(\/|$)/;

let current: Entitlements | null = null;
let loadedAt = 0;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

async function load(force = false): Promise<void> {
    if (typeof window === "undefined" || PUBLIC_PAGE.test(window.location.pathname)) return;
    if (!force && current && Date.now() - loadedAt < REFRESH_MS) return;
    if (inflight) return inflight;
    inflight = jfetch<Entitlements>("/api/entitlements")
        .then((e) => {
            current = e && typeof e === "object" ? e : null;
            loadedAt = Date.now();
        })
        .catch(() => {
            // Not signed in, or the server is busy: show nothing, and ask again later.
            loadedAt = Date.now() - REFRESH_MS + 30_000;
        })
        .finally(() => {
            inflight = null;
            listeners.forEach((l) => l());
        });
    return inflight;
}

/** The plan's limits and usage, or null when there are none (or not known yet). Shared by everything that shows them. */
export function useEntitlements(): Entitlements | null {
    const [, bump] = React.useReducer((n: number) => n + 1, 0);
    React.useEffect(() => {
        listeners.add(bump);
        void load();
        const t = window.setInterval(() => void load(), REFRESH_MS);
        return () => {
            listeners.delete(bump);
            window.clearInterval(t);
        };
    }, []);
    return current && current.limits ? current : null;
}

/** Ask again now, for example after adding a person or an endpoint. */
export function refreshEntitlements(): void {
    void load(true);
}
