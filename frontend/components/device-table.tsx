// components/device-table.tsx
"use client";

import * as React from "react";

import { useDashboard } from "@/app/(dashboard)/dashboard-context";
import ServerDeviceTable from "@/components/server-device-table";
import type { DeviceFilters, DevicePlace } from "@/lib/api";

type Props = {
    /** Only devices in these customers or sites (by name), besides the rail's Status, OS and tag choices. */
    places?: DevicePlace[];
    filterColumnId?: string;
    filterPlaceholder?: string;
    compact?: boolean;
    /** Leave the filter box out (the page puts one elsewhere) and keep the Columns menu in the table's own heading. */
    toolbarElsewhere?: boolean;
    /** Told how many devices match, in all. */
    onTotal?: (total: number) => void;
};

/** The device list: the rail's filters and the chosen customers apply on the server, which also sorts and pages it. */
export default function DeviceTable({
    places,
    filterColumnId = "hostname",
    filterPlaceholder = "Filter devices…",
    compact = false,
    toolbarElsewhere = false,
    onTotal,
}: Props) {
    const { deviceFilters } = useDashboard();
    const filters = React.useMemo<DeviceFilters>(() => ({ ...deviceFilters, ...(places?.length ? { places } : {}) }), [deviceFilters, places]);

    return (
        <ServerDeviceTable
            filters={filters}
            filterColumnId={filterColumnId}
            filterPlaceholder={filterPlaceholder}
            compact={compact}
            toolbarElsewhere={toolbarElsewhere}
            registerSnapshot
            onTotal={onTotal}
        />
    );
}
