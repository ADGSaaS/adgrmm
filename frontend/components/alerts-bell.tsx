// components/alerts-bell.tsx
"use client";

import * as React from "react";
import Link from "next/link";
import { Bell } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { fetchAlertSummary, type AlertSummary } from "@/lib/alerts-api";

const REFRESH_MS = 30_000;

/** Open alerts at a glance from anywhere. Someone without access to alerts simply sees no count. */
export default function AlertsBell() {
    const [summary, setSummary] = React.useState<AlertSummary | null>(null);

    React.useEffect(() => {
        let stopped = false;
        const refresh = () => {
            if (document.hidden) return;
            fetchAlertSummary()
                .then((s) => {
                    if (!stopped) setSummary(s);
                })
                .catch(() => { });
        };
        refresh();
        const timer = window.setInterval(refresh, REFRESH_MS);
        document.addEventListener("visibilitychange", refresh);
        return () => {
            stopped = true;
            window.clearInterval(timer);
            document.removeEventListener("visibilitychange", refresh);
        };
    }, []);

    const open = summary?.open ?? 0;
    const label = open === 0 ? "Alerts: none open" : `Alerts: ${open} open`;

    return (
        <Button asChild variant="ghost" size="icon" className="relative text-muted-foreground" title={label} aria-label={label}>
            <Link href="/alerts">
                <Bell className="h-5 w-5" aria-hidden="true" />
                {open > 0 ? (
                    <span
                        className={cn(
                            "absolute right-0.5 top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold text-white",
                            (summary?.openCritical ?? 0) > 0 ? "bg-red-600" : "bg-amber-600"
                        )}
                    >
                        {open > 99 ? "99+" : open}
                    </span>
                ) : null}
            </Link>
        </Button>
    );
}
