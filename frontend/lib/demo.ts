"use client";
// Tells the web app whether it is the public demo (the server answers /api/demo/mode). A normal install answers { demo: false },
// so none of the demo changes show anywhere else.
import * as React from "react";
import { apiUrl } from "@/lib/api";

export type DemoInfo = { demo: boolean; idleSeconds?: number; backUrl?: string };

let cached: Promise<DemoInfo> | null = null;

export function loadDemoInfo(): Promise<DemoInfo> {
    if (!cached) {
        cached = fetch(apiUrl("/api/demo/mode"), { cache: "no-store", credentials: "include" })
            .then((r) => (r.ok ? (r.json() as Promise<DemoInfo>) : { demo: false }))
            .catch(() => {
                cached = null; // the server may be restarting: ask again next time
                return { demo: false };
            });
    }
    return cached;
}

/** Everything the server says about the demo (null until it has answered). */
export function useDemoInfo(): DemoInfo | null {
    const [info, setInfo] = React.useState<DemoInfo | null>(null);
    React.useEffect(() => {
        let live = true;
        void loadDemoInfo().then((i) => { if (live) setInfo(i); });
        return () => { live = false; };
    }, []);
    return info;
}

/** True when this is the public demo. False until the server has answered, and in every normal install. */
export function useDemoMode(): boolean {
    const [demo, setDemo] = React.useState(false);
    React.useEffect(() => {
        let live = true;
        void loadDemoInfo().then((i) => { if (live) setDemo(!!i.demo); });
        return () => { live = false; };
    }, []);
    return demo;
}
