"use client";

// components/overview/use-overview-data.ts
//
// What the Overview page loads and remembers: the one summary call (kept fresh while the tab is open), the customer chosen in the
// filter (remembered in this browser), the charts' data (only when the breakdown is open) and whether the breakdown is open.
import * as React from "react";
import { fetchCustomers, fetchDeviceCounts, fetchDevices, type CustomerClient, type Device as ApiDevice, type DeviceCounts } from "@/lib/api";
import { fetchDashboardSummary, type DashboardSummary } from "@/lib/dashboard-api";

const CUSTOMER_KEY = "remoteiq.overview.customer.v1";
const BREAKDOWN_KEY = "remoteiq.overview.breakdown.v1";
const REFRESH_MS = 60_000;
const OFFLINE_LIST_LIMIT = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readStore(key: string): string | null {
    try { return window.localStorage.getItem(key); } catch { return null; }
}
function writeStore(key: string, value: string | null) {
    try { if (value === null) window.localStorage.removeItem(key); else window.localStorage.setItem(key, value); } catch { /* not saved: private window or blocked storage */ }
}

const errorText = (e: unknown) => String((e as { message?: string })?.message ?? e ?? "Something went wrong").slice(0, 200);

/** The customer filter: the list of customers, the remembered choice, and a reset when the remembered customer is gone. */
export function useCustomerFilter() {
    const [customers, setCustomers] = React.useState<Array<{ id: string; name: string }>>([]);
    const [loaded, setLoaded] = React.useState(false);
    const [clientId, setClientIdState] = React.useState<string>(() => {
        const v = typeof window === "undefined" ? null : readStore(CUSTOMER_KEY);
        return v && UUID.test(v) ? v : "";
    });
    React.useEffect(() => {
        let off = false;
        fetchCustomers()
            .then((list: CustomerClient[]) => { if (!off) setCustomers(list.map((c) => ({ id: c.id, name: c.name })).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))); })
            .catch(() => { if (!off) setCustomers([]); })
            .finally(() => { if (!off) setLoaded(true); });
        return () => { off = true; };
    }, []);
    // A customer that no longer exists (or that this person may not see) is dropped instead of showing an empty page.
    React.useEffect(() => {
        if (loaded && clientId && customers.length && !customers.some((c) => c.id === clientId)) {
            setClientIdState("");
            writeStore(CUSTOMER_KEY, null);
        }
    }, [loaded, customers, clientId]);
    const setClientId = React.useCallback((id: string) => {
        setClientIdState(id);
        writeStore(CUSTOMER_KEY, id || null);
    }, []);
    return { customers, clientId, setClientId, clientName: customers.find((c) => c.id === clientId)?.name ?? null };
}

export type SummaryState = { data: DashboardSummary | null; error: string | null; loading: boolean; refreshing: boolean; updatedAt: number | null };

/** The summary, loaded again when the customer changes, on request, and every minute while the tab is visible. */
export function useSummary(clientId: string, enabled = true) {
    const [state, setState] = React.useState<SummaryState>({ data: null, error: null, loading: true, refreshing: false, updatedAt: null });
    const abort = React.useRef<AbortController | null>(null);
    const lastClient = React.useRef(clientId);

    const load = React.useCallback((background: boolean) => {
        abort.current?.abort();
        const ac = new AbortController();
        abort.current = ac;
        setState((s) => ({ ...s, refreshing: true, loading: s.data === null }));
        fetchDashboardSummary(clientId || null, { signal: ac.signal })
            .then((data) => { if (!ac.signal.aborted) setState({ data, error: null, loading: false, refreshing: false, updatedAt: Date.now() }); })
            .catch((e) => {
                if (ac.signal.aborted) return;
                // A failed background refresh keeps what is on screen; a failed first load shows the error.
                setState((s) => ({ ...s, loading: false, refreshing: false, error: errorText(e) }));
            });
        void background;
    }, [clientId]);

    React.useEffect(() => {
        if (!enabled) return;
        if (lastClient.current !== clientId) {
            lastClient.current = clientId;
            // Another customer: the old numbers would be wrong, so show the placeholders until the new ones arrive.
            setState({ data: null, error: null, loading: true, refreshing: true, updatedAt: null });
        }
        load(false);
        const tick = window.setInterval(() => { if (document.visibilityState === "visible") load(true); }, REFRESH_MS);
        const onVisible = () => { if (document.visibilityState === "visible") load(true); };
        document.addEventListener("visibilitychange", onVisible);
        return () => { window.clearInterval(tick); document.removeEventListener("visibilitychange", onVisible); abort.current?.abort(); };
    }, [load, clientId, enabled]);

    return { ...state, refresh: () => load(false) };
}

/** Whether the fleet breakdown is open, remembered in this browser. */
export function useBreakdownOpen() {
    const [open, setOpen] = React.useState<boolean>(() => (typeof window === "undefined" ? true : readStore(BREAKDOWN_KEY) !== "closed"));
    const toggle = React.useCallback(() => setOpen((o) => { writeStore(BREAKDOWN_KEY, o ? "closed" : "open"); return !o; }), []);
    return { open, toggle };
}

/** The charts' data: device counts and the offline list. Fetched only while the breakdown is open and there are devices. */
export function useBreakdownData(active: boolean, clientId: string, refreshKey: number | null) {
    const [counts, setCounts] = React.useState<DeviceCounts | null>(null);
    const [offline, setOffline] = React.useState<ApiDevice[]>([]);
    const [error, setError] = React.useState<string | null>(null);
    const [loading, setLoading] = React.useState(true);
    React.useEffect(() => {
        if (!active) return;
        const ac = new AbortController();
        const filters = clientId ? { clientId } : {};
        Promise.all([
            fetchDeviceCounts(filters, { signal: ac.signal }),
            fetchDevices(OFFLINE_LIST_LIMIT, null, { ...filters, status: "offline" }, { sort: "lastSeen", dir: "desc" }, { signal: ac.signal }).then((r) => r.items).catch(() => null),
        ])
            .then(([c, list]) => { if (ac.signal.aborted) return; setCounts(c); setOffline(list ?? []); setError(list === null ? "The list could not be loaded." : null); setLoading(false); })
            .catch((e) => { if (!ac.signal.aborted) { setError(errorText(e)); setLoading(false); } });
        return () => ac.abort();
    }, [active, clientId, refreshKey]);
    return { counts, offline, error, loading: active && loading && counts === null };
}
