"use client";

// The devices at one site, in the same table (columns, sorting, column choice and row menu) as the rest of the app.
// The rows come from the server a page at a time, and unlike <DeviceTable> it does not take over the saved-view
// snapshot, so a page can show many of them at once.
import * as React from "react";
import { useDashboard } from "@/app/(dashboard)/dashboard-context";
import ServerDeviceTable from "@/components/server-device-table";
import { columns } from "@/components/device-table-columns";
import type { DeviceFilters, DevicePlace } from "@/lib/api";

// Inside a site section the customer and site are the section's own heading, so those two columns are left out here
// (rather than hidden, which would change the choice every other device table shares).
const siteColumns = columns.filter((c) => !["client", "site"].includes(String((c as { accessorKey?: string }).accessorKey ?? "")));

/** `place` is the customer and site (an em dash for no site) whose devices are listed. */
export default function SiteDeviceTable({ place }: { place: DevicePlace }) {
    const { deviceFilters } = useDashboard();
    const filters = React.useMemo<DeviceFilters>(() => ({ ...deviceFilters, places: [place] }), [deviceFilters, place]);
    return <ServerDeviceTable filters={filters} columns={siteColumns} compact toolbarElsewhere />;
}
