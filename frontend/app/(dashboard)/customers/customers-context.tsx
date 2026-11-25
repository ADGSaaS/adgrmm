// app/customers/customers-context.tsx
"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
    useDashboard,
    type Device,
    type DeviceStatus,
    type EncodedViewPayload,
} from "@/app/(dashboard)/dashboard-context";
import { sameSelection, type TreeSelection } from "@/components/customers-tree";
import type { DevicePlace } from "@/lib/api";

/**
 * Customers page–scoped context
 * - Owns: which customers and sites the device list is showing. Nothing selected means all of them.
 * - Reads filters from DashboardProvider (single source of truth).
 * - Applies Saved View payloads (initial + subsequent loads).
 */

type OS = Device["os"];

export type CustomersContextType = {
    selection: TreeSelection[];
    select: (item: TreeSelection | null, additive?: boolean) => void;
    /** The selection as the server's customer and site filter (empty when nothing is selected, which means everything). */
    places: DevicePlace[];
    /** The selection in words, such as "Acme / Head office". */
    scopeLabel: string;

    // Filters (Status / OS) — mirrored from Dashboard context
    activeFilters: { status: DeviceStatus[]; os: OS[]; tags?: string[] };
    setActiveFilters: React.Dispatch<
        React.SetStateAction<{ status: DeviceStatus[]; os: OS[]; tags?: string[] }>
    >;
};

const CustomersContext = React.createContext<CustomersContextType | null>(null);

export function useCustomers() {
    const ctx = React.useContext(CustomersContext);
    if (!ctx) throw new Error("useCustomers must be used within CustomersProvider");
    return ctx;
}

const clean = (value: unknown) => String(value ?? "").trim();

/** Saved views keep the names they always did, so existing views still load. */
function selectionFromPayload(orgs: string[], sites: string[]): TreeSelection[] {
    if (sites.length === 0) return orgs.map((org) => ({ org }));
    return orgs.flatMap((org) => sites.map((site) => ({ org, site })));
}

export function CustomersProvider({ children }: { children: React.ReactNode }) {
    // Global (single source of truth)
    const {
        activeFilters,
        setActiveFilters,
        getDecodedViewPayload,
        onViewPayload,
    } = useDashboard();

    const router = useRouter();
    const pathname = usePathname();
    const search = useSearchParams();

    const [selection, setSelection] = React.useState<TreeSelection[]>([]);

    // What the address bar last said, so this page's own changes are not read back as new ones.
    const urlKeyRef = React.useRef("");
    const urlOrg = search?.get("org") ?? "";
    const urlSite = search?.get("site") ?? "";

    React.useEffect(() => {
        const key = `${urlOrg}\n${urlSite}`;
        if (key === urlKeyRef.current || key === "\n" && urlKeyRef.current === "") return;
        urlKeyRef.current = key;
        setSelection(urlOrg ? [{ org: urlOrg, ...(urlSite ? { site: urlSite } : {}) }] : []);
    }, [urlOrg, urlSite]);

    // One selection can be linked to. Several cannot, so the address then shows none of them.
    const writeUrl = React.useCallback(
        (next: TreeSelection[]) => {
            const params = new URLSearchParams(window.location.search);
            params.delete("org");
            params.delete("site");
            if (next.length === 1) {
                params.set("org", next[0].org);
                if (next[0].site) params.set("site", next[0].site);
            }
            const single = next.length === 1 ? next[0] : null;
            urlKeyRef.current = `${single?.org ?? ""}\n${single?.site ?? ""}`;
            const query = params.toString();
            router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
        },
        [pathname, router]
    );

    const select = React.useCallback(
        (item: TreeSelection | null, additive = false) => {
            let next: TreeSelection[];
            if (!item) {
                next = [];
            } else if (additive) {
                const exists = selection.some((s) => sameSelection(s, item));
                next = exists ? selection.filter((s) => !sameSelection(s, item)) : [...selection, item];
            } else {
                next = [item];
            }
            setSelection(next);
            writeUrl(next);
        },
        [selection, writeUrl]
    );

    const places = React.useMemo<DevicePlace[]>(
        () => selection.map((s) => ({ client: s.org, ...(s.site ? { site: s.site } : {}) })),
        [selection]
    );

    const scopeLabel = React.useMemo(() => {
        if (selection.length === 0) return "All customers";
        if (selection.length > 1) return `${selection.length} selected`;
        return selection[0].site ? `${selection[0].org} / ${selection[0].site}` : selection[0].org;
    }, [selection]);

    // --- Apply payloads (initial + subsequent loads) ---
    const applyPayload = React.useCallback(
        (p: EncodedViewPayload | null | undefined) => {
            if (!p) return;

            if (Array.isArray(p.expandedOrganizations) || Array.isArray(p.expandedSites)) {
                setSelection(selectionFromPayload(p.expandedOrganizations ?? [], p.expandedSites ?? []));
            }

            // Filters (use global setter so FiltersRail reflects it)
            if (p.activeFilters) {
                const status = Array.isArray(p.activeFilters.status)
                    ? (p.activeFilters.status as DeviceStatus[])
                    : [];
                const os = Array.isArray(p.activeFilters.os)
                    ? (p.activeFilters.os as OS[])
                    : [];
                // The tag filter is part of a saved view too: it is restored with the rest, not dropped.
                const tags = Array.isArray(p.activeFilters.tags) ? p.activeFilters.tags.map(String).filter(Boolean) : [];
                setActiveFilters({ status, os, tags });
            }
        },
        [setActiveFilters]
    );

    // 1) Apply any decoded payload already present (e.g., from URL on first paint)
    React.useEffect(() => {
        applyPayload(getDecodedViewPayload?.());
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // 2) Subscribe to future payloads (Saved View loads / share link apply)
    React.useEffect(() => {
        const off = onViewPayload?.((p) => applyPayload(p));
        return () => {
            off && off();
        };
    }, [onViewPayload, applyPayload]);

    // Memoize the context value to limit downstream renders
    const value = React.useMemo<CustomersContextType>(
        () => ({
            selection,
            select,
            places,
            scopeLabel,
            activeFilters,
            setActiveFilters,
        }),
        [selection, select, places, scopeLabel, activeFilters, setActiveFilters]
    );

    return (
        <CustomersContext.Provider value={value}>
            {children}
        </CustomersContext.Provider>
    );
}
