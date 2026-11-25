// app/(dashboard)/page.tsx
//
// The Overview. This file only loads things and keeps the saved layout (hidden cards and their order, which Saved Views capture);
// everything on screen is drawn by components/overview.
"use client";

import * as React from "react";
import { useDashboard } from "@/app/(dashboard)/dashboard-context";
import { useMe } from "@/lib/use-me";
import { hasPerm } from "@/lib/permissions";
import { OverviewView } from "@/components/overview/overview-view";
import { NavProvider } from "@/components/overview/nav";
import { BREAKDOWN_KEYS, CARD_CATALOG, SUMMARY_KEYS } from "@/components/overview/catalog";
import { CHART_ROWS, SUMMARY_ROWS, orderFromLayout, pack } from "@/components/overview/card-grid";
import { useBreakdownData, useBreakdownOpen, useCustomerFilter, useSummary } from "@/components/overview/use-overview-data";

const BPS = ["lg", "md", "sm", "xs", "xxs"] as const;

export default function DashboardPage() {
  const {
    dashboardHidden, setDashboardHidden, dashboardLayouts, setDashboardLayouts, setDashboardOrder, registerSnapshotGetter, setActiveFilters,
  } = useDashboard();
  const { permissions } = useMe();
  const canAdmin = hasPerm(permissions, "admin.access");

  const { customers, clientId, setClientId, clientName } = useCustomerFilter();
  const summary = useSummary(clientId);
  const breakdown = useBreakdownOpen();
  const hasDevices = (summary.data?.devices?.total ?? 0) > 0;
  const data = useBreakdownData(breakdown.open && hasDevices, clientId, summary.updatedAt);

  // The saved layout is read as an order (older layouts held positions; sorted by row and column they still give the order).
  const lg = dashboardLayouts?.lg;
  const summaryOrder = React.useMemo(() => orderFromLayout(lg, SUMMARY_KEYS), [lg]);
  const breakdownOrder = React.useMemo(() => orderFromLayout(lg, BREAKDOWN_KEYS), [lg]);

  const onReorder = React.useCallback(
    (group: "summary" | "breakdown", order: string[]) => {
      const mine = group === "summary" ? SUMMARY_KEYS : BREAKDOWN_KEYS;
      const placed = group === "summary" ? pack(order, 4, SUMMARY_ROWS) : pack(order, 6, CHART_ROWS);
      setDashboardLayouts((prev) => {
        const next: NonNullable<typeof prev> = {};
        for (const bp of BPS) next[bp] = [...(prev?.[bp] ?? []).filter((l) => !mine.includes(l.i)), ...placed];
        return next;
      });
      const other = group === "summary" ? breakdownOrder : summaryOrder;
      setDashboardOrder(group === "summary" ? [...order, ...other] : [...other, ...order]);
    },
    [setDashboardLayouts, setDashboardOrder, summaryOrder, breakdownOrder]
  );

  // Saved Views capture what is hidden and how the cards are ordered.
  React.useEffect(() => {
    registerSnapshotGetter?.(() => ({
      columnVisibility: {},
      sorting: [],
      columnFilters: [],
      dashboardOrder: [...summaryOrder, ...breakdownOrder],
      dashboardLayouts,
      dashboardHidden,
    }));
    return () => registerSnapshotGetter?.(null);
  }, [registerSnapshotGetter, dashboardHidden, dashboardLayouts, summaryOrder, breakdownOrder]);

  // Only keys the page knows are kept, so an old saved list never grows without end.
  const known = React.useMemo(() => new Set(CARD_CATALOG.map((c) => c.key)), []);
  const hidden = React.useMemo(() => dashboardHidden.filter((k) => known.has(k)), [dashboardHidden, known]);

  // A new install looks again for its first device by itself.
  const empty = !!summary.data?.setup && !summary.data.setup.hasDevices;
  const refreshRef = React.useRef(summary.refresh);
  refreshRef.current = summary.refresh;
  React.useEffect(() => {
    if (!empty) return;
    const t = window.setInterval(() => { if (document.visibilityState === "visible") refreshRef.current(); }, 15_000);
    return () => window.clearInterval(t);
  }, [empty]);

  return (
    <NavProvider clientId={clientId} clientName={clientName} setActiveFilters={setActiveFilters}>
      <OverviewView
        state={summary}
        onRefresh={summary.refresh}
        customers={customers}
        clientId={clientId}
        clientName={clientName}
        onClientChange={setClientId}
        canAdmin={canAdmin}
        breakdown={{ ...data, open: breakdown.open, onToggle: breakdown.toggle }}
        hidden={hidden}
        onHiddenChange={setDashboardHidden}
        summaryOrder={summaryOrder}
        breakdownOrder={breakdownOrder}
        onReorder={onReorder}
      />
    </NavProvider>
  );
}
