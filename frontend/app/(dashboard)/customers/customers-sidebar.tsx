// app/customers/customers-sidebar.tsx
"use client";

import * as React from "react";
import CustomersTree, { treeClientsOf } from "@/components/customers-tree";
import { useDashboard } from "@/app/(dashboard)/dashboard-context";
import { useCustomers } from "./customers-context";

/** The customers tree for this area, where choosing something filters the device list. */
export default function CustomersSidebar({
    embedded = false,
    onChoose,
}: {
    embedded?: boolean;
    /** Called after a choice, so a drawer can close and show the result. */
    onChoose?: () => void;
}) {
    const { selection, select } = useCustomers();
    const { deviceCounts } = useDashboard();
    const counted = React.useMemo(() => treeClientsOf(deviceCounts), [deviceCounts]);

    const tree = (
        <CustomersTree
            counted={counted}
            selection={selection}
            embedded={embedded}
            onSelect={(item, additive) => {
                select(item, additive);
                if (!additive) onChoose?.();
            }}
        />
    );

    if (embedded) return tree;

    return (
        <aside aria-label="Customers" className="sticky top-14 shrink-0 self-start" style={{ height: "calc(100dvh - 56px)" }}>
            {tree}
        </aside>
    );
}
