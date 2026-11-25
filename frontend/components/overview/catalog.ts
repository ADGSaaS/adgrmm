// components/overview/catalog.ts
//
// Everything the Customize menu can show or hide on the Overview page. The keys of the first and the last group are the ones
// saved layouts and views have always used, so what people hid or arranged before keeps working. New cards are visible by default
// (only keys that were hidden on purpose are saved as hidden).

export type CardGroup = "status" | "summary" | "breakdown";
export type CardDef = { key: string; label: string; group: CardGroup };

export const CARD_CATALOG: CardDef[] = [
    // The status strip (the old KPI cards; "Healthy" is the Online tile).
    { key: "kpi-healthy", label: "Status tile: Online", group: "status" },
    { key: "kpi-offline", label: "Status tile: Offline", group: "status" },
    { key: "kpi-critical", label: "Status tile: Critical", group: "status" },
    { key: "kpi-warning", label: "Status tile: Warning", group: "status" },
    { key: "kpi-total", label: "Status tile: Total", group: "status" },
    // Summary cards.
    { key: "sum-security", label: "Security", group: "summary" },
    { key: "sum-patching", label: "Patching", group: "summary" },
    { key: "sum-tickets", label: "Service desk", group: "summary" },
    { key: "sum-schedule", label: "Today’s schedule", group: "summary" },
    { key: "sum-agents", label: "Agent versions", group: "summary" },
    { key: "sum-activity", label: "Recent activity", group: "summary" },
    // The charts of the fleet breakdown.
    { key: "donut-os", label: "OS Distribution", group: "breakdown" },
    { key: "heat-status-os", label: "Status × OS Heatmap", group: "breakdown" },
    { key: "stack-client-sites", label: "Clients → Sites (Stacked)", group: "breakdown" },
    { key: "donut-client", label: "Endpoints by Client", group: "breakdown" },
    { key: "table-offline", label: "Offline devices", group: "breakdown" },
    { key: "donut-status", label: "Status Distribution", group: "breakdown" },
];

export const GROUP_LABEL: Record<CardGroup, string> = {
    status: "Status tiles",
    summary: "Summary cards",
    breakdown: "Fleet breakdown charts",
};

export const keysOf = (g: CardGroup) => CARD_CATALOG.filter((c) => c.group === g).map((c) => c.key);
export const SUMMARY_KEYS = keysOf("summary");
export const BREAKDOWN_KEYS = keysOf("breakdown");
export const STATUS_KEYS = keysOf("status");
