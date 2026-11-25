"use client";

// components/overview/nav.tsx
//
// Where the Overview's links go. Most pages are opened with their filters in the address. The device list keeps its Status filter
// in the app (not in the address), so a link to it sets that filter first, then goes there.
import * as React from "react";
import { useRouter } from "next/navigation";
import type { ActiveFilters } from "@/app/(dashboard)/dashboard-context";

export type Query = Record<string, string>;

export type Nav = {
    /** The address of a page with its filters (also used for "open in a new tab"). */
    href: (route: string, query?: Query) => string;
    /** A click on a link: keeps the browser's own behaviour for new-tab clicks, otherwise goes there with the filters set. */
    click: (e: React.MouseEvent, route: string, query?: Query) => void;
    /** Opens the device list (all customers or the chosen one) with the given status. */
    openDevices: (status?: "online" | "offline") => void;
};

const NavContext = React.createContext<Nav | null>(null);

export function useNav(): Nav {
    const nav = React.useContext(NavContext);
    if (!nav) throw new Error("useNav must be used inside <NavProvider>");
    return nav;
}

/** True for clicks that mean "open somewhere else" (new tab, new window, download). */
const wantsNewTab = (e: React.MouseEvent) => e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0;

export function NavProvider({
    clientId, clientName, setActiveFilters, children,
}: {
    clientId: string;
    clientName: string | null;
    setActiveFilters: React.Dispatch<React.SetStateAction<ActiveFilters>>;
    children: React.ReactNode;
}) {
    const router = useRouter();
    const value = React.useMemo<Nav>(() => {
        const href = (route: string, query: Query = {}) => {
            const sp = new URLSearchParams();
            if (route === "/customers") {
                // The list is narrowed to a customer by its name; the Status filter is not part of the address.
                if (clientName) sp.set("org", clientName);
            } else {
                for (const [k, v] of Object.entries(query)) sp.set(k, v);
                if (clientId && route === "/security") sp.set("clientId", clientId);
            }
            const qs = sp.toString();
            return qs ? `${route}?${qs}` : route;
        };
        const openDevices = (status?: "online" | "offline") => {
            setActiveFilters({ status: status === "online" ? ["Healthy"] : status === "offline" ? ["Offline"] : [], os: [], tags: [] });
            router.push(href("/customers"));
        };
        const click = (e: React.MouseEvent, route: string, query: Query = {}) => {
            if (route !== "/customers" || wantsNewTab(e)) return;
            e.preventDefault();
            openDevices(query.status === "online" ? "online" : query.status === "offline" ? "offline" : undefined);
        };
        return { href, click, openDevices };
    }, [clientId, clientName, router, setActiveFilters]);
    return <NavContext.Provider value={value}>{children}</NavContext.Provider>;
}
