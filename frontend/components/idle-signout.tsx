"use client";

// Signs the person out of the console when they have been idle for as long as Security Policies allows, and sends them to the
// sign-in page when the server has ended their session (too long signed in, or ended by an administrator).
// The server enforces both limits whatever this does; this only makes the console follow at once instead of at the next request.
import * as React from "react";

const API_BASE = (process.env.NEXT_PUBLIC_API_BASE || "http://localhost:3001").replace(/\/+$/, "");
const ACTIVITY_EVENTS = ["mousemove", "mousedown", "keydown", "scroll", "touchstart", "wheel"] as const;

type Rules = { idleTimeoutMins: number; sessionTimeoutMins: number };

export default function IdleSignOut() {
    const lastActivity = React.useRef(Date.now());
    const activeSincePing = React.useRef(false);
    const rules = React.useRef<Rules | null>(null);
    const leaving = React.useRef(false);

    React.useEffect(() => {
        // The sign-in page and public pages have nobody to sign out.
        const onPublicPage = () => /^\/(login|forgot-password|pay|portal)(\/|$)/.test(window.location.pathname);

        const goToLogin = (reason: "idle" | "expired") => {
            if (leaving.current || onPublicPage()) return;
            leaving.current = true;
            const next = encodeURIComponent(window.location.pathname + window.location.search);
            window.location.assign(`/login?next=${next}&reason=${reason}`);
        };

        const signOutIdle = async () => {
            try {
                await fetch(`${API_BASE}/api/auth/logout`, { method: "POST", credentials: "include" });
            } catch { /* the server ends the session on its own too */ }
            goToLogin("idle");
        };

        /** Asks who is signed in. Doing it only while the person is active keeps their session alive exactly as long as they are. */
        const ping = async () => {
            if (onPublicPage() || leaving.current) return;
            try {
                const res = await fetch(`${API_BASE}/api/auth/me`, { credentials: "include", cache: "no-store" });
                if (res.status === 401) {
                    const body = await res.json().catch(() => null);
                    goToLogin(body?.code === "idle_timeout" ? "idle" : "expired");
                    return;
                }
                if (!res.ok) return;
                const data = await res.json().catch(() => null);
                if (!data?.user) { rules.current = null; return; }
                rules.current = data.sessionRules ?? null;
            } catch { /* offline: try again next time */ }
        };

        const onActivity = () => {
            lastActivity.current = Date.now();
            activeSincePing.current = true;
        };
        ACTIVITY_EVENTS.forEach((ev) => window.addEventListener(ev, onActivity, { passive: true }));

        void ping();
        let lastPing = Date.now();
        const timer = window.setInterval(() => {
            const r = rules.current;
            const idleMs = (r?.idleTimeoutMins ?? 0) * 60_000;
            if (idleMs > 0 && Date.now() - lastActivity.current >= idleMs) {
                void signOutIdle();
                return;
            }
            // Active people ping about once a minute (or more often for very short limits); idle people do not, so their session can run out.
            const every = idleMs > 0 ? Math.max(20_000, Math.min(60_000, idleMs / 4)) : 5 * 60_000;
            if (Date.now() - lastPing >= every && (activeSincePing.current || !r)) {
                lastPing = Date.now();
                activeSincePing.current = false;
                void ping();
            }
        }, 5_000);

        const onVisible = () => {
            if (document.visibilityState === "visible") void ping();
        };
        document.addEventListener("visibilitychange", onVisible);

        return () => {
            window.clearInterval(timer);
            ACTIVITY_EVENTS.forEach((ev) => window.removeEventListener(ev, onActivity));
            document.removeEventListener("visibilitychange", onVisible);
        };
    }, []);

    return null;
}
