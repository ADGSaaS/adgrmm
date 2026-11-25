"use client";

// "All customers": every customer as a row with its sites and how its devices are doing. Click one to open it.
// All the numbers come from the server, counted in the database, so they are right however many devices there are.
import * as React from "react";
import { ArrowDown, ArrowUp, Building2 } from "lucide-react";
import { EmptyState } from "@/components/list-controls";
import { fetchCustomers, type CustomerClient } from "@/lib/api";
import { cn } from "@/lib/utils";

type Row = { key: string; name: string; sites: number; devices: number; online: number; offline: number; alerts: number };
type SortKey = "name" | "sites" | "devices" | "offline" | "alerts";

export function customerRows(customers: CustomerClient[]): Row[] {
    return customers.map((c) => {
        const devices = c.counts?.devices ?? c.devicesCount ?? 0;
        const online = c.counts?.online ?? 0;
        return {
            key: c.key ?? c.id,
            name: c.name,
            sites: c.counts?.sites ?? c.sitesCount ?? 0,
            devices,
            online,
            offline: c.counts?.offline ?? Math.max(0, devices - online),
            alerts: c.counts?.alerts ?? 0,
        };
    });
}

export function CustomersOverview({ onOpen, onCount }: { onOpen: (name: string) => void; onCount?: (n: number) => void }) {
    const [customers, setCustomers] = React.useState<CustomerClient[] | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [sort, setSort] = React.useState<{ key: SortKey; dir: 1 | -1 }>({ key: "name", dir: 1 });

    const load = React.useCallback(async () => {
        try {
            setCustomers(await fetchCustomers());
            setError(null);
        } catch (e: any) {
            setCustomers([]);
            setError(e?.message || "Could not load the customers.");
        }
    }, []);
    React.useEffect(() => { void load(); }, [load]);
    // A customer or device was added, moved or removed elsewhere on the page.
    React.useEffect(() => {
        const refresh = () => void load();
        window.addEventListener("remoteiq:customers-changed", refresh);
        window.addEventListener("remoteiq:devices-changed", refresh);
        return () => {
            window.removeEventListener("remoteiq:customers-changed", refresh);
            window.removeEventListener("remoteiq:devices-changed", refresh);
        };
    }, [load]);

    const rows = React.useMemo(() => {
        const all = customerRows(customers ?? []);
        return all.sort((a, b) => {
            const x = sort.key === "name" ? a.name.toLowerCase() : a[sort.key];
            const y = sort.key === "name" ? b.name.toLowerCase() : b[sort.key];
            return (x < y ? -1 : x > y ? 1 : a.name.localeCompare(b.name)) * sort.dir;
        });
    }, [customers, sort]);

    const head = (key: SortKey, label: string, right = false) => (
        <th scope="col" className={cn("px-3 py-2 font-medium", right && "text-right")} aria-sort={sort.key === key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
            <button type="button" className="inline-flex items-center gap-1 hover:text-foreground" onClick={() => setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: 1 }))}>
                {label}
                {sort.key === key ? (sort.dir === 1 ? <ArrowUp className="h-3 w-3" aria-hidden /> : <ArrowDown className="h-3 w-3" aria-hidden />) : null}
            </button>
        </th>
    );

    React.useEffect(() => { if (customers !== null) onCount?.(customers.length); }, [customers, onCount]);

    if (customers === null) return <p className="p-4 text-sm text-muted-foreground">Loading customers…</p>;

    return (
        <div className="space-y-3">
            {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
            {rows.length === 0 ? (
                <EmptyState>
                    <Building2 className="mx-auto mb-2 h-6 w-6" aria-hidden />
                    <div className="font-medium text-foreground">No customers yet</div>
                    <div>{"Use New > New customer to add the first one."}</div>
                </EmptyState>
            ) : (
                <div className="overflow-x-auto rounded-xl border border-border/70 bg-card">
                    <table className="w-full min-w-[640px] text-sm">
                        <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                            <tr>
                                {head("name", "Customer")}
                                {head("sites", "Sites", true)}
                                {head("devices", "Devices", true)}
                                <th scope="col" className="px-3 py-2 text-right font-medium">Online</th>
                                {head("offline", "Offline", true)}
                                {head("alerts", "With open alerts", true)}
                            </tr>
                        </thead>
                        <tbody className="divide-y">
                            {rows.map((r) => (
                                <tr key={r.key} className="cursor-pointer hover:bg-accent/40" onClick={() => onOpen(r.name)}>
                                    <td className="px-3 py-2.5">
                                        <button type="button" className="font-medium text-foreground hover:text-primary hover:underline" onClick={(e) => { e.stopPropagation(); onOpen(r.name); }}>
                                            {r.name}
                                        </button>
                                    </td>
                                    <td className="px-3 py-2.5 text-right tabular-nums">{r.sites}</td>
                                    <td className="px-3 py-2.5 text-right tabular-nums">{r.devices}</td>
                                    <td className="px-3 py-2.5 text-right tabular-nums">{r.online}</td>
                                    <td className={cn("px-3 py-2.5 text-right tabular-nums", r.offline > 0 && "text-muted-foreground")}>{r.offline}</td>
                                    <td className={cn("px-3 py-2.5 text-right tabular-nums", r.alerts > 0 && "font-medium text-amber-600 dark:text-amber-400")}>{r.alerts}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}
