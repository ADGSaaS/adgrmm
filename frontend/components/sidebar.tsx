// components/sidebar.tsx
"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import CustomersTree, { treeClientsOf, type TreeSelection } from "@/components/customers-tree";
import { useDashboard } from "@/app/(dashboard)/dashboard-context";
import { fetchDevice } from "@/lib/api";

/** The customers tree beside a device's page: it shows where the device belongs and leads to the list. */
export default function Sidebar() {
    const router = useRouter();
    const pathname = usePathname();
    const { deviceCounts } = useDashboard();
    const counted = React.useMemo(() => treeClientsOf(deviceCounts), [deviceCounts]);

    // Where the open device belongs: asked of the server for just that device, since the list is never held whole.
    const id = pathname.startsWith("/devices/") ? decodeURIComponent(pathname.split("/")[2] ?? "") : "";
    const [place, setPlace] = React.useState<{ id: string; client: string | null; site: string | null } | null>(null);
    React.useEffect(() => {
        if (!id) return;
        let stale = false;
        fetchDevice(id)
            .then((d) => {
                if (!stale) setPlace({ id, client: d.client ?? null, site: d.site ?? null });
            })
            .catch(() => {
                if (!stale) setPlace(null);
            });
        return () => {
            stale = true;
        };
    }, [id]);

    const selection = React.useMemo<TreeSelection[]>(() => {
        if (!place || place.id !== id || !place.client) return [];
        return [{ org: place.client, ...(place.site ? { site: place.site } : {}) }];
    }, [place, id]);

    return (
        <CustomersTree
            counted={counted}
            selection={selection}
            onSelect={(item) => {
                if (!item) {
                    router.push("/customers");
                    return;
                }
                const params = new URLSearchParams({ org: item.org });
                if (item.site) params.set("site", item.site);
                router.push(`/customers?${params.toString()}`);
            }}
        />
    );
}
