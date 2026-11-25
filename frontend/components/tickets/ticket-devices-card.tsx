"use client";

// The devices on a ticket: which ones, whether they are online, when they last checked in, with a link to each and a
// server-searched picker to add more. A ticket's devices all belong to its customer, which the server enforces.
import * as React from "react";
import Link from "next/link";
import { Monitor, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { jfetch } from "@/lib/api";
import { formatUsDateTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import DeviceSearchPicker from "./device-search-picker";

type TicketDevice = {
    id: string;
    name: string;
    hostname: string;
    os: string | null;
    status: string;
    lastSeenAt: string | null;
    siteName: string | null;
    clientName: string | null;
    isMain: boolean;
};

const messageOf = (e: unknown) => {
    const raw = e instanceof Error ? e.message : "Something went wrong.";
    try {
        const j = JSON.parse(raw) as { message?: string | string[] };
        return Array.isArray(j.message) ? j.message.join(" ") : j.message ?? raw;
    } catch {
        return raw;
    }
};

export function TicketDevicesCard({
    ticketId,
    clientId,
    canEdit,
    className,
    onChanged,
}: {
    ticketId: string;
    /** The ticket's customer: the picker only offers its devices. */
    clientId?: string | null;
    canEdit: boolean;
    className?: string;
    /** Told after a device was added or removed (the ticket may have taken its customer from the first device). */
    onChanged?: () => void | Promise<void>;
}) {
    const [items, setItems] = React.useState<TicketDevice[] | null>(null);
    const [adding, setAdding] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const [busyId, setBusyId] = React.useState<string | null>(null);

    const load = React.useCallback(async () => {
        try {
            setItems((await jfetch<{ items: TicketDevice[] }>(`/api/tickets/${ticketId}/devices`)).items);
        } catch (e) {
            setItems([]);
            setError(messageOf(e));
        }
    }, [ticketId]);
    React.useEffect(() => {
        void load();
    }, [load]);

    async function add(deviceId: string) {
        setError(null);
        setBusyId(deviceId);
        try {
            await jfetch(`/api/tickets/${ticketId}/devices`, { method: "POST", body: { deviceId } });
            setAdding(false);
            await load();
            await onChanged?.();
        } catch (e) {
            setError(messageOf(e));
        } finally {
            setBusyId(null);
        }
    }

    async function remove(d: TicketDevice) {
        if (!window.confirm(`Take ${d.name} off this ticket? The device itself is not changed.`)) return;
        setError(null);
        setBusyId(d.id);
        try {
            await jfetch(`/api/tickets/${ticketId}/devices/${d.id}`, { method: "DELETE" });
            await load();
            await onChanged?.();
        } catch (e) {
            setError(messageOf(e));
        } finally {
            setBusyId(null);
        }
    }

    return (
        <div className={cn("rounded-xl border border-border/70 bg-card p-5 shadow-[0_1px_2px_rgba(0,0,0,0.06),0_8px_24px_-12px_rgba(0,0,0,0.25)]", className)}>
            <div className="mb-3 flex items-center justify-between gap-2">
                <h3 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                    <Monitor className="h-4 w-4" aria-hidden /> Devices{items && items.length ? ` (${items.length})` : ""}
                </h3>
                {canEdit && !adding ? (
                    <Button type="button" variant="outline" size="sm" className="gap-1" onClick={() => setAdding(true)}>
                        <Plus className="h-3.5 w-3.5" aria-hidden /> Add device
                    </Button>
                ) : null}
            </div>

            {items === null ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
            {items && items.length === 0 && !adding ? <p className="text-sm text-muted-foreground">No device is linked to this ticket.</p> : null}
            {items && items.length > 0 ? (
                <ul className="divide-y text-sm">
                    {items.map((d) => (
                        <li key={d.id} className="flex items-start justify-between gap-2 py-2 first:pt-0 last:pb-0">
                            <div className="min-w-0">
                                <Link href={`/devices/${d.id}`} className="font-medium text-foreground hover:text-primary hover:underline">
                                    {d.name}
                                </Link>
                                {d.isMain && items.length > 1 ? <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">Main</span> : null}
                                <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                                    <span className={d.status === "online" ? "text-emerald-600 dark:text-emerald-400" : ""}>{d.status === "online" ? "Online" : "Offline"}</span>
                                    {d.os ? <span>{d.os}</span> : null}
                                    <span>{d.lastSeenAt ? `Last seen ${formatUsDateTime(d.lastSeenAt)}` : "Never seen"}</span>
                                    {d.siteName ? <span>{d.siteName}</span> : null}
                                </div>
                            </div>
                            {canEdit ? (
                                <button type="button" aria-label={`Remove ${d.name} from this ticket`} title="Remove from this ticket" disabled={busyId === d.id} onClick={() => void remove(d)} className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50">
                                    <X className="h-4 w-4" aria-hidden />
                                </button>
                            ) : null}
                        </li>
                    ))}
                </ul>
            ) : null}

            {adding ? (
                <div className="mt-3 grid gap-2 rounded-md border bg-muted/30 p-3">
                    <p className="text-xs text-muted-foreground">{clientId ? "Only this customer's devices are listed." : "Pick a device. The ticket takes its customer from the first one."}</p>
                    <DeviceSearchPicker clientId={clientId} excludeIds={(items ?? []).map((d) => d.id)} onPick={(d) => void add(d.id)} autoFocus idPrefix="ticket-device" />
                    <div className="flex justify-end">
                        <Button type="button" variant="ghost" size="sm" onClick={() => setAdding(false)}>
                            Cancel
                        </Button>
                    </div>
                </div>
            ) : null}
            {error ? (
                <p role="alert" className="mt-2 text-sm text-destructive">
                    {error}
                </p>
            ) : null}
        </div>
    );
}
