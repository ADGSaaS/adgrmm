"use client";

// One customer: each of its sites as a section, with that site's devices underneath.
// The numbers come from the server's device counts and each open site fetches its own devices a page at a time,
// so a customer is complete however many devices it, or the system, holds.
import * as React from "react";
import { ChevronDown, ChevronRight, MapPin } from "lucide-react";
import { useDashboard } from "@/app/(dashboard)/dashboard-context";
import SiteDeviceTable from "@/components/customers/site-device-table";
import { fetchCustomerSites, fetchCustomers } from "@/lib/api";
import { useDeviceCounts } from "@/lib/use-devices";

type SiteBlock = { name: string; total: number; offline: number; place: { client: string; site: string } };

const NO_SITE = "No site";
/** What the server calls a device with no site (an em dash). */
const NONE = "—";

/** The customer's sites (empty ones too, from the customer record) with the devices counted at each. */
export function CustomerSitesView({ org, filtered, onSummary }: { org: string; /** Receives the "N devices in M sites" line for the page header (null while loading). */ onSummary?: (text: string | null) => void; /** Whether the page's status and OS filters are narrowing what is shown. */ filtered: boolean }) {
    const { deviceFilters, devicesVersion } = useDashboard();
    const [siteNames, setSiteNames] = React.useState<string[] | null>(null);
    const [siteError, setSiteError] = React.useState<string | null>(null);
    const [open, setOpen] = React.useState<Record<string, boolean>>({});
    const [tick, setTick] = React.useState(0);

    // A customer or site was added or renamed elsewhere.
    React.useEffect(() => {
        const again = () => setTick((n) => n + 1);
        window.addEventListener("remoteiq:customers-changed", again);
        return () => window.removeEventListener("remoteiq:customers-changed", again);
    }, []);

    React.useEffect(() => {
        let stale = false;
        setSiteError(null);
        (async () => {
            try {
                const customers = await fetchCustomers();
                const me = customers.find((c) => c.name === org);
                if (!me) {
                    if (!stale) setSiteNames([]);
                    return;
                }
                const sites = await fetchCustomerSites(me.key ?? me.id);
                if (!stale) setSiteNames(sites.map((s) => s.name));
            } catch (e: any) {
                if (!stale) {
                    setSiteError(e?.message || "Could not load this customer's sites.");
                    setSiteNames((n) => n ?? []);
                }
            }
        })();
        return () => { stale = true; };
    }, [org, tick]);

    const countFilters = React.useMemo(() => ({ ...deviceFilters, places: [{ client: org }] }), [deviceFilters, org]);
    const { counts, error: countError } = useDeviceCounts(countFilters, devicesVersion);

    const blocks = React.useMemo<SiteBlock[]>(() => {
        const bySite = new Map<string, { total: number; offline: number }>();
        for (const c of counts?.clients ?? []) {
            for (const s of c.sites) {
                const key = s.name === null || !s.name.trim() ? NO_SITE : s.name.trim();
                const cur = bySite.get(key) ?? { total: 0, offline: 0 };
                cur.total += s.total;
                cur.offline += s.offline;
                bySite.set(key, cur);
            }
        }
        const names = [...new Set([...(siteNames ?? []), ...bySite.keys()])].filter((n) => n !== NO_SITE).sort((a, b) => a.localeCompare(b));
        if (bySite.has(NO_SITE)) names.push(NO_SITE);
        return names.map((name) => ({ name, total: bySite.get(name)?.total ?? 0, offline: bySite.get(name)?.offline ?? 0, place: { client: org, site: name === NO_SITE ? NONE : name } }));
    }, [counts, siteNames, org]);

    const loaded = counts !== null && siteNames !== null;
    const shownTotal = blocks.reduce((n, b) => n + b.total, 0);
    const summary = loaded ? `${shownTotal} ${shownTotal === 1 ? "device" : "devices"} in ${blocks.length} ${blocks.length === 1 ? "site" : "sites"}${filtered ? " (filters applied)" : ""}` : null;
    React.useEffect(() => {
        onSummary?.(summary);
        return () => onSummary?.(null);
    }, [summary, onSummary]);

    const error = countError || siteError;
    if (!loaded) return error ? <p role="alert" className="p-4 text-sm text-destructive">{error}</p> : <p className="p-4 text-sm text-muted-foreground">Loading {org}…</p>;
    if (blocks.length === 0) return <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">{org} has no sites yet. Use New &gt; New site to add one.</p>;

    // Few devices: every site starts open. Many: the first one with devices, so the page is not a wall of tables.
    const startsOpen = (_b: SiteBlock, i: number) => (shownTotal <= 40 ? true : i === blocks.findIndex((x) => x.total > 0));
    const isOpen = (b: SiteBlock, i: number) => open[b.name] ?? startsOpen(b, i);

    return (
        <div className="space-y-4">
            {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
            {blocks.map((b, i) => {
                const expanded = isOpen(b, i);
                return (
                    <section key={b.name} aria-label={`Site ${b.name}`} className="rounded-xl border border-border/70 bg-card">
                        <button
                            type="button"
                            className="flex w-full items-center gap-2 px-4 py-3 text-left"
                            aria-expanded={expanded}
                            onClick={() => setOpen((o) => ({ ...o, [b.name]: !expanded }))}
                        >
                            {expanded ? <ChevronDown className="h-4 w-4 shrink-0" aria-hidden /> : <ChevronRight className="h-4 w-4 shrink-0" aria-hidden />}
                            <MapPin className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                            <span className="font-medium">{b.name}</span>
                            <span className="text-sm text-muted-foreground">
                                {b.total} {b.total === 1 ? "device" : "devices"}
                                {b.offline > 0 ? `, ${b.offline} offline` : ""}
                            </span>
                        </button>
                        {expanded ? (
                            <div className="border-t px-2 pb-2 pt-2">
                                {b.total > 0 ? (
                                    <SiteDeviceTable place={b.place} />
                                ) : (
                                    <p className="px-2 py-3 text-sm text-muted-foreground">
                                        {filtered ? "No devices here match the filters." : "No devices at this site yet. They appear when endpoints check in."}
                                    </p>
                                )}
                            </div>
                        ) : null}
                    </section>
                );
            })}
        </div>
    );
}
