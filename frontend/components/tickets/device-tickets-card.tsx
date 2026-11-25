"use client";

// A device's tickets on its page: the open ones first, then the most recent, with a way to open a new one for it.
import * as React from "react";
import Link from "next/link";
import { Ticket } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusPill } from "@/components/pills";
import { jfetch } from "@/lib/api";
import { hasPerm } from "@/lib/permissions";
import { useMe } from "@/lib/use-me";
import { formatUsDateTime } from "@/lib/time";
import { newTicketHref, type TicketFromDevice, ticketsForDeviceHref } from "@/lib/ticket-from-device";

type Row = { id: string; number: number; title: string; status: string; priority: string; createdAt: string; updatedAt: string; closedAt: string | null };

export function DeviceTicketsCard({ device, className }: { device: TicketFromDevice; className?: string }) {
    const perms = useMe().permissions;
    const canRead = hasPerm(perms, "tickets.read");
    const canWrite = hasPerm(perms, "tickets.write");
    const [data, setData] = React.useState<{ openCount: number; items: Row[] } | null>(null);
    const [failed, setFailed] = React.useState(false);

    React.useEffect(() => {
        if (!canRead) return;
        let cancelled = false;
        jfetch<{ openCount: number; items: Row[] }>(`/api/devices/${device.id}/tickets?limit=10`)
            .then((r) => {
                if (!cancelled) setData(r);
            })
            .catch(() => {
                if (!cancelled) setFailed(true);
            });
        return () => {
            cancelled = true;
        };
    }, [device.id, canRead]);

    if (!canRead && !canWrite) return null;

    return (
        <Card className={className}>
            <CardHeader>
                <div className="flex items-start justify-between gap-3">
                    <div>
                        <CardTitle className="flex items-center gap-2 text-base">
                            <Ticket className="h-4 w-4" aria-hidden /> Tickets
                        </CardTitle>
                        <CardDescription>{data ? (data.openCount ? `${data.openCount} open` : "None open") : failed ? "Could not load tickets." : canRead ? "Loading…" : ""}</CardDescription>
                    </div>
                    <div className="flex shrink-0 gap-2">
                        {canRead ? (
                            <Button asChild variant="outline" size="sm">
                                <Link href={ticketsForDeviceHref(device)}>All tickets</Link>
                            </Button>
                        ) : null}
                        {canWrite ? (
                            <Button asChild size="sm">
                                <Link href={newTicketHref(device)}>Create ticket</Link>
                            </Button>
                        ) : null}
                    </div>
                </div>
            </CardHeader>
            {data && data.items.length > 0 ? (
                <CardContent>
                    <ul className="divide-y text-sm">
                        {data.items.map((t) => (
                            <li key={t.id} className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0">
                                <div className="min-w-0">
                                    <Link href={`/tickets/${t.id}`} className="block truncate font-medium hover:text-primary hover:underline">
                                        <span className="mr-2 font-mono text-xs text-muted-foreground">#{t.number}</span>
                                        {t.title}
                                    </Link>
                                    <span className="text-xs text-muted-foreground">{t.closedAt ? `Closed ${formatUsDateTime(t.closedAt)}` : `Opened ${formatUsDateTime(t.createdAt)}`}</span>
                                </div>
                                <StatusPill value={t.status} />
                            </li>
                        ))}
                    </ul>
                </CardContent>
            ) : null}
            {data && data.items.length === 0 ? (
                <CardContent>
                    <p className="text-sm text-muted-foreground">No ticket has been opened for this device.</p>
                </CardContent>
            ) : null}
        </Card>
    );
}
