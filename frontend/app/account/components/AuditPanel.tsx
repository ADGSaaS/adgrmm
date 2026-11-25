"use client";
import * as React from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Pager, usePaged } from "@/components/pager";
import { EmptyState } from "@/components/list-controls";
import { getAuditEvents, type AuditEvent } from "@/lib/account-api";

export function AuditPanel({ section }: { section: string }) {
    const [events, setEvents] = React.useState<AuditEvent[] | null>(null);
    const [err, setErr] = React.useState<string | null>(null);
    const paged = usePaged(events ?? [], "account-activity", 10);

    React.useEffect(() => {
        getAuditEvents(section).then(setEvents).catch(() => setErr("Failed to load activity"));
    }, [section]);

    return (
        <Card className="md:col-span-1">
            <CardHeader>
                <CardTitle>Recent activity</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
                {err && <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs">{err}</div>}
                {!events && !err && <div className="h-20 animate-pulse rounded bg-muted" />}
                {events?.length === 0 && <EmptyState>No recent changes.</EmptyState>}
                {events && paged.rows.map((e) => (
                    <div key={e.id} className="rounded-xl border border-border/70 bg-card p-3 text-xs">
                        <div className="font-medium">{e.action}</div>
                        <div className="opacity-70">{new Date(e.at).toLocaleString()}</div>
                        <div className="mt-1 break-words">{e.details}</div>
                    </div>
                ))}
                {events && events.length > 0 && <Pager paged={paged} noun="events" />}
            </CardContent>
        </Card>
    );
}
