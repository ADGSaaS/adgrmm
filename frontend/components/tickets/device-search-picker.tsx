"use client";

// Chooses a device by searching the server, which holds them all (the browser never has the whole list). Typing narrows
// the matches, so no device is out of reach however many there are; it is the same search the Run dialog uses.
import * as React from "react";
import { Input } from "@/components/ui/input";
import { fetchDevices, type Device } from "@/lib/api";

/** How many matching devices are listed at once. */
const CHOICES = 25;

export type PickedDevice = { id: string; hostname: string; os: string; client: string | null; site: string | null; clientId: string | null; status?: string };

const asPicked = (d: Device): PickedDevice => ({ id: d.id, hostname: d.hostname, os: d.os, client: d.client ?? null, site: d.site ?? null, clientId: d.clientId ?? null, status: d.status });

export default function DeviceSearchPicker({
    onPick,
    clientId,
    excludeIds = [],
    autoFocus = false,
    placeholder = "Search devices by name, customer or site",
    idPrefix = "device-search",
}: {
    onPick: (device: PickedDevice) => void;
    /** Only this customer's devices (a ticket's devices have to be its customer's). */
    clientId?: string | null;
    excludeIds?: string[];
    autoFocus?: boolean;
    placeholder?: string;
    idPrefix?: string;
}) {
    const [text, setText] = React.useState("");
    const [q, setQ] = React.useState("");
    const [found, setFound] = React.useState<Device[]>([]);
    const [more, setMore] = React.useState(false);
    const [total, setTotal] = React.useState<number | null>(null);
    const [busy, setBusy] = React.useState(true);
    const [failed, setFailed] = React.useState(false);

    React.useEffect(() => {
        const id = setTimeout(() => setQ(text.trim()), 250);
        return () => clearTimeout(id);
    }, [text]);

    React.useEffect(() => {
        const ac = new AbortController();
        setBusy(true);
        setFailed(false);
        fetchDevices(CHOICES, null, { ...(q ? { q } : {}), ...(clientId ? { clientId } : {}) }, { sort: "hostname", dir: "asc", total: true }, { signal: ac.signal })
            .then((r) => {
                if (ac.signal.aborted) return;
                setFound(r.items);
                setMore(!!r.nextCursor);
                setTotal(typeof r.total === "number" ? r.total : null);
                setBusy(false);
            })
            .catch((e) => {
                if (ac.signal.aborted || e?.name === "AbortError") return;
                setFound([]);
                setMore(false);
                setFailed(true);
                setBusy(false);
            });
        return () => ac.abort();
    }, [q, clientId]);

    const skip = new Set(excludeIds);
    const shown = found.filter((d) => !skip.has(d.id));

    return (
        <div className="grid gap-2">
            <Input
                id={`${idPrefix}-q`}
                type="search"
                aria-label="Search devices"
                placeholder={placeholder}
                value={text}
                onChange={(e) => setText(e.target.value)}
                autoFocus={autoFocus}
                autoComplete="off"
            />
            <ul aria-label="Matching devices" aria-busy={busy || undefined} className="max-h-60 divide-y overflow-y-auto rounded-md border text-sm">
                {shown.map((d) => (
                    <li key={d.id}>
                        <button type="button" onClick={() => onPick(asPicked(d))} className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-accent focus:bg-accent focus:outline-none">
                            <span className="min-w-0">
                                <span className="block truncate font-medium">{d.hostname}</span>
                                <span className="block truncate text-xs text-muted-foreground">{[d.client, d.site, d.os].filter(Boolean).join(" / ")}</span>
                            </span>
                            <span className={`shrink-0 text-xs ${d.status === "online" ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"}`}>{d.status}</span>
                        </button>
                    </li>
                ))}
                {!busy && shown.length === 0 ? <li className="px-3 py-3 text-muted-foreground">{failed ? "Could not load devices." : q ? "No device matches." : "No devices to choose from."}</li> : null}
                {busy && shown.length === 0 ? <li className="px-3 py-3 text-muted-foreground">Searching…</li> : null}
            </ul>
            {more ? <p className="text-xs text-muted-foreground">Showing the first {CHOICES}{total ? ` of ${total.toLocaleString()}` : ""} matches. Type to narrow the list.</p> : null}
        </div>
    );
}
