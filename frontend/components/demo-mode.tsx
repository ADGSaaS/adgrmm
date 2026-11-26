"use client";
// In the public demo only: a small notice at the bottom of the page, and the "still here" signal. The server counts a minute without
// that signal as "the visitor closed the demo" and starts a fresh copy of the sample data.
import * as React from "react";
import { apiUrl } from "@/lib/api";
import { loadDemoInfo } from "@/lib/demo";

const PING_MS = 10_000;

function visitorId(): string {
    try {
        let id = sessionStorage.getItem("adg-demo-visitor");
        if (!id) { id = Math.random().toString(36).slice(2) + Date.now().toString(36); sessionStorage.setItem("adg-demo-visitor", id); }
        return id;
    } catch {
        return "anonymous";
    }
}

export default function DemoMode() {
    const [demo, setDemo] = React.useState(false);
    const [offline, setOffline] = React.useState(false);

    React.useEffect(() => {
        let live = true;
        void loadDemoInfo().then((i) => { if (live) setDemo(!!i.demo); });
        return () => { live = false; };
    }, []);

    React.useEffect(() => {
        if (!demo) return;
        const id = visitorId();
        const ping = () => {
            fetch(apiUrl("/api/demo/ping"), {
                method: "POST", credentials: "include", keepalive: true,
                headers: { "content-type": "application/json" }, body: JSON.stringify({ id }),
            }).then((r) => setOffline(!r.ok && r.status >= 500)).catch(() => setOffline(true));
        };
        ping();
        const timer = window.setInterval(ping, PING_MS);
        const onVisible = () => { if (document.visibilityState === "visible") ping(); };
        document.addEventListener("visibilitychange", onVisible);
        return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
    }, [demo]);

    if (!demo) return null;
    return (
        <div
            role="status"
            className="pointer-events-none fixed bottom-3 left-1/2 z-[70] w-[min(92vw,720px)] -translate-x-1/2 rounded-full border border-amber-500/50 bg-background/95 px-4 py-2 text-center text-xs shadow-lg backdrop-blur"
        >
            <span className="pointer-events-auto">
                {offline
                    ? "The demo is getting a fresh start. This page will work again in a moment."
                    : <><strong>ADG RMM demo.</strong> Sample data only. You can look around and try things, but devices cannot be added. Your changes are discarded about a minute after you leave.</>}
            </span>
        </div>
    );
}
