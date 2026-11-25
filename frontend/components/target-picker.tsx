// components/target-picker.tsx
"use client";

import * as React from "react";
import { fetchCustomers, fetchCustomerSites, fetchDevices, type CustomerClient, type CustomerSite, type Device } from "@/lib/api";
import { useDashboard } from "@/app/(dashboard)/dashboard-context";

export type TargetType = "organization" | "client" | "site" | "device";
export type Target = { type: TargetType; id?: string | null; label?: string };

const selectClass = "h-9 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm";

/** How many matching devices the chooser lists at once; typing narrows them, so none is out of reach. */
const DEVICE_CHOICES = 50;

/** Chooses one device by searching the server, which holds them all (the browser never has the whole list). */
function DevicePicker({ value, onChange }: { value: Target; onChange: (target: Target) => void }) {
    const { aliases } = useDashboard();
    const [text, setText] = React.useState("");
    const [q, setQ] = React.useState("");
    const [found, setFound] = React.useState<Device[]>([]);
    const [more, setMore] = React.useState(false);
    const [failed, setFailed] = React.useState(false);
    // The chosen device stays in the list even when a later search no longer matches it.
    const [chosen, setChosen] = React.useState<{ id: string; label: string } | null>(null);

    React.useEffect(() => {
        const id = setTimeout(() => setQ(text.trim()), 250);
        return () => clearTimeout(id);
    }, [text]);

    React.useEffect(() => {
        const ac = new AbortController();
        setFailed(false);
        fetchDevices(DEVICE_CHOICES, null, q ? { q } : undefined, undefined, { signal: ac.signal })
            .then((r) => {
                if (ac.signal.aborted) return;
                setFound(r.items);
                setMore(!!r.nextCursor);
            })
            .catch((e) => {
                if (ac.signal.aborted || e?.name === "AbortError") return;
                setFound([]);
                setMore(false);
                setFailed(true);
            });
        return () => ac.abort();
    }, [q]);

    const label = (d: Device) => aliases[d.id] || d.hostname;
    const options = found.map((d) => ({ id: d.id, label: label(d) }));
    if (value.id && !options.some((o) => o.id === value.id)) options.unshift({ id: value.id, label: chosen?.id === value.id ? chosen.label : value.label ?? value.id });

    return (
        <>
            <input
                type="search"
                aria-label="Search devices"
                placeholder="Search devices"
                value={text}
                onChange={(e) => setText(e.target.value)}
                className={selectClass}
            />
            <select
                aria-label="Device"
                value={value.id ?? ""}
                onChange={(e) => {
                    const o = options.find((x) => x.id === e.target.value);
                    setChosen(o ?? null);
                    onChange({ type: "device", id: e.target.value || null, label: o?.label });
                }}
                className={selectClass}
            >
                <option value="">{failed ? "Could not load devices" : "Choose a device"}</option>
                {options.map((o) => (
                    <option key={o.id} value={o.id}>{o.label}</option>
                ))}
            </select>
            {more ? <p className="w-full text-xs text-muted-foreground">Showing the first {DEVICE_CHOICES} matches. Type to narrow the list.</p> : null}
        </>
    );
}

/** Chooses all devices, a customer, a site or one device. */
export default function TargetPicker({ value, onChange, idPrefix = "target" }: { value: Target; onChange: (target: Target) => void; idPrefix?: string }) {
    const [clients, setClients] = React.useState<CustomerClient[]>([]);
    const [sites, setSites] = React.useState<CustomerSite[]>([]);
    const [clientId, setClientId] = React.useState("");

    React.useEffect(() => {
        fetchCustomers().then((list) => setClients(list ?? [])).catch(() => setClients([]));
    }, []);

    React.useEffect(() => {
        if (value.type !== "site" || !clientId) {
            setSites([]);
            return;
        }
        fetchCustomerSites(clientId).then((list) => setSites(list ?? [])).catch(() => setSites([]));
    }, [clientId, value.type]);

    return (
        <div className="flex flex-wrap gap-2">
            <select
                id={`${idPrefix}-type`}
                aria-label="Run on"
                value={value.type}
                onChange={(e) => {
                    setClientId("");
                    onChange({ type: e.target.value as TargetType, id: null });
                }}
                className={selectClass}
            >
                <option value="organization">All devices</option>
                <option value="client">A customer</option>
                <option value="site">A site</option>
                <option value="device">One device</option>
            </select>

            {value.type === "client" ? (
                <select
                    aria-label="Customer"
                    value={value.id ?? ""}
                    onChange={(e) => onChange({ type: "client", id: e.target.value || null, label: e.target.selectedOptions[0]?.text })}
                    className={selectClass}
                >
                    <option value="">Choose a customer</option>
                    {clients.map((c) => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                </select>
            ) : null}

            {value.type === "site" ? (
                <>
                    <select aria-label="Customer" value={clientId} onChange={(e) => { setClientId(e.target.value); onChange({ type: "site", id: null }); }} className={selectClass}>
                        <option value="">Choose a customer</option>
                        {clients.map((c) => (
                            <option key={c.id} value={c.id}>{c.name}</option>
                        ))}
                    </select>
                    <select
                        aria-label="Site"
                        disabled={!clientId}
                        value={value.id ?? ""}
                        onChange={(e) => onChange({ type: "site", id: e.target.value || null, label: e.target.selectedOptions[0]?.text })}
                        className={selectClass}
                    >
                        <option value="">Choose a site</option>
                        {sites.map((s) => (
                            <option key={s.id} value={s.id}>{s.name}</option>
                        ))}
                    </select>
                </>
            ) : null}

            {value.type === "device" ? <DevicePicker value={value} onChange={onChange} /> : null}
        </div>
    );
}

export const targetIsComplete = (target: Target) => target.type === "organization" || !!target.id;
