"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { LEVEL_STYLES, clockText, primaryClock, type TicketSla } from "@/lib/service-desk";

const pill = "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset";

/** A ticket's SLA in one badge: the clock that matters most, in words, with both clocks in the tooltip. Staff only. */
export default function SlaBadge({ sla, className }: { sla?: TicketSla | null; className?: string }) {
    // Re-evaluate once a minute so "due in 3 min" turns into "overdue" without a refresh.
    const [now, setNow] = React.useState(() => Date.now());
    React.useEffect(() => {
        const t = window.setInterval(() => setNow(Date.now()), 60_000);
        return () => window.clearInterval(t);
    }, []);

    if (!sla) return <span className="text-muted-foreground">-</span>;
    const p = primaryClock(sla, now);
    if (!p) return <span className="text-muted-foreground" title={`Policy: ${sla.policy}`}>No target</span>;

    const text =
        p.level === "breached" && p.clock.state === "missed"
            ? `${p.name === "Resolution" ? "Resolved" : "Answered"} late`
            : p.level === "met"
              ? "Met"
              : p.level === "breached" && p.clock.state !== "running"
                ? "Breached"
                : p.level === "paused"
                  ? "On hold"
                  : clockText(p.clock, now).replace(/^./, (c) => c.toUpperCase());
    const tip = [`Policy: ${sla.policy}`, `First response: ${clockText(sla.response, now)}`, `Resolution: ${clockText(sla.resolution, now)}`].join("\n");
    return (
        <span className={cn(pill, LEVEL_STYLES[p.level], className)} title={tip} aria-label={`SLA: ${p.name} ${text}`}>
            {text}
        </span>
    );
}
