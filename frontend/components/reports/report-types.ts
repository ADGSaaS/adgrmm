// components/reports/report-types.ts
//
// What the reports API sends and accepts. The operators and limits mirror the backend (report-view.ts), which is the
// authority: it checks every view it is sent. This file only decides what to offer and what to send.

export type ColumnType = "text" | "number" | "percent" | "date" | "status";
export type ReportColumn = { key: string; label: string; type?: ColumnType; pdf?: boolean; weight?: number; visible?: boolean; internal?: boolean };

export type Operator =
    | "eq" | "neq" | "contains" | "notContains" | "startsWith" | "in" | "notIn"
    | "gt" | "gte" | "lt" | "lte" | "between"
    | "before" | "after" | "withinDays" | "olderThanDays"
    | "empty" | "notEmpty";

export type Condition = { field: string; op: Operator; value?: unknown };
export type FilterGroup = { match: "all" | "any"; conditions: Array<Condition | FilterGroup> };
export type SortKey = { key: string; dir: "asc" | "desc" };
export type ViewSpec = { filter?: FilterGroup; sort?: SortKey[]; groupBy?: string | null; columns?: string[] };

export type Chart = { key: string; title: string; kind: "bar" | "donut" | "line"; data: Array<{ label: string; value: number }> };
export type Row = Record<string, unknown>;

export type ReportKey =
    | "hardware-inventory" | "software-inventory" | "software-summary"
    | "device-health" | "security-status"
    | "patch-compliance" | "patch-missing" | "patch-activity"
    | "alert-history" | "remote-sessions"
    | "hardware-age" | "windows-support" | "stale-devices" | "network-map" | "security-score"
    | "software-compliance" | "renewals" | "script-results" | "alert-noise" | "ticket-sla" | "technician-activity"
    | "availability" | "disk-trend" | "change-log" | "patch-speed" | "risky-configuration" | "antivirus-threats" | "automatic-patching";
export type ReportParam = { key: string; label: string; type: "number" | "text" | "date"; default?: number | string; min?: number; max?: number; help?: string };
export type ReportDef = { key: ReportKey; title: string; group: "Inventory" | "Health" | "Security" | "Patching" | "Activity" | "Lifecycle" | "Service"; description: string; scoped: boolean; dated: boolean; params: ReportParam[]; permission: string };

export type ReportResult = {
    key: ReportKey;
    title: string;
    generatedAt: string;
    scope: { customer: string | null; site: string | null; device?: string | null };
    period: { from: string; to: string } | null;
    params: Record<string, string | number>;
    columns: ReportColumn[];
    rows: Row[];
    totalRows: number;
    matchedRows: number;
    summary: Array<{ label: string; value: string | number }>;
    charts: Chart[];
    groups: Array<{ value: string; count: number }>;
    view: ViewSpec;
    notes: string[];
    truncated: boolean;
};

export type ViewConfig = {
    scope?: { clientId?: string; siteId?: string };
    params?: Record<string, string | number>;
    days?: number;
    view?: ViewSpec;
};
export type SavedView = { id: string; reportKey: ReportKey; name: string; config: ViewConfig; mine: boolean; updatedAt: string };

export const OPERATORS_BY_TYPE: Record<ColumnType, Operator[]> = {
    text: ["contains", "notContains", "eq", "neq", "startsWith", "in", "notIn", "empty", "notEmpty"],
    status: ["eq", "neq", "in", "notIn", "contains", "empty", "notEmpty"],
    number: ["gt", "gte", "lt", "lte", "eq", "neq", "between", "empty", "notEmpty"],
    percent: ["gt", "gte", "lt", "lte", "eq", "neq", "between", "empty", "notEmpty"],
    date: ["withinDays", "olderThanDays", "before", "after", "between", "empty", "notEmpty"],
};

export const OPERATOR_LABEL: Record<Operator, string> = {
    contains: "contains",
    notContains: "does not contain",
    eq: "is",
    neq: "is not",
    startsWith: "starts with",
    in: "is one of",
    notIn: "is not one of",
    gt: "is more than",
    gte: "is at least",
    lt: "is less than",
    lte: "is at most",
    between: "is between",
    before: "is before",
    after: "is after",
    withinDays: "was within the last (days)",
    olderThanDays: "was more than (days) ago",
    empty: "is empty",
    notEmpty: "is not empty",
};

export const typeOf = (c: ReportColumn): ColumnType => c.type ?? "text";
export const isGroup = (x: Condition | FilterGroup): x is FilterGroup => Array.isArray((x as FilterGroup).conditions);
export const emptyFilter = (): FilterGroup => ({ match: "all", conditions: [] });

/** A new condition for a column, with the most useful operator for its type. */
export function newCondition(column: ReportColumn): Condition {
    const t = typeOf(column);
    const op: Operator = t === "date" ? "withinDays" : t === "number" || t === "percent" ? "lt" : t === "status" ? "eq" : "contains";
    return { field: column.key, op };
}

/** The operators that need no value, and the ones that need two. */
export const needsNoValue = (op: Operator) => op === "empty" || op === "notEmpty";
export const needsTwoValues = (op: Operator) => op === "between";
export const takesList = (op: Operator) => op === "in" || op === "notIn";

/**
 * What can be sent: conditions that are still being typed (no value yet) are left out, so a half-built filter
 * never produces an error or a surprising result.
 */
export function cleanFilter(group: FilterGroup, columns: ReportColumn[]): FilterGroup | undefined {
    const byKey = new Map(columns.map((c) => [c.key, c]));
    const walk = (g: FilterGroup): FilterGroup | undefined => {
        const conditions: Array<Condition | FilterGroup> = [];
        for (const item of g.conditions) {
            if (isGroup(item)) {
                const inner = walk(item);
                if (inner) conditions.push(inner);
                continue;
            }
            const column = byKey.get(item.field);
            if (!column) continue;
            if (!OPERATORS_BY_TYPE[typeOf(column)].includes(item.op)) continue;
            if (needsNoValue(item.op)) {
                conditions.push({ field: item.field, op: item.op });
                continue;
            }
            const v = item.value;
            if (needsTwoValues(item.op)) {
                if (!Array.isArray(v) || v.length !== 2 || v.some((x) => x === "" || x === null || x === undefined)) continue;
                conditions.push({ field: item.field, op: item.op, value: v });
            } else if (takesList(item.op)) {
                const list = Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [];
                if (!list.length) continue;
                conditions.push({ field: item.field, op: item.op, value: list });
            } else {
                if (v === "" || v === null || v === undefined) continue;
                conditions.push({ field: item.field, op: item.op, value: v });
            }
        }
        return conditions.length ? { match: g.match, conditions } : undefined;
    };
    return walk(group);
}

export const countConditions = (g: FilterGroup): number => g.conditions.reduce((n, c) => n + (isGroup(c) ? countConditions(c) : 1), 0);

export const displayValue = (v: unknown) => (v === null || v === undefined || v === "" ? "(none)" : String(v));
