// backend/src/reports/report-view.ts
//
// What a person can do with a report's rows: filter them, sort them, group them, pick columns, and see them as charts.
// It works on plain rows and a column list, so it can be tested without a database, and the screen, the CSV, the PDF
// and (later) scheduled emails all go through the same code.
import { BadRequestException } from "@nestjs/common";

export type ColumnType = "text" | "number" | "percent" | "date" | "status";
export type ReportColumn = {
    key: string;
    label: string;
    type?: ColumnType;
    /** In the PDF's default columns. */
    pdf?: boolean;
    weight?: number;
    /** Shown by default. Columns that are not stay available in the column chooser and for filtering. */
    visible?: boolean;
    /** Carried on the rows for the screen (a link to the device, say) but never shown, exported or filtered. */
    internal?: boolean;
};

export type Operator =
    | "eq" | "neq" | "contains" | "notContains" | "startsWith" | "in" | "notIn"
    | "gt" | "gte" | "lt" | "lte" | "between"
    | "before" | "after" | "withinDays" | "olderThanDays"
    | "empty" | "notEmpty";

export type Condition = { field: string; op: Operator; value?: unknown };
export type FilterGroup = { match: "all" | "any"; conditions: Array<Condition | FilterGroup> };
export type SortKey = { key: string; dir: "asc" | "desc" };
export type ViewSpec = { filter?: FilterGroup; sort?: SortKey[]; groupBy?: string | null; columns?: string[] };

export type Row = Record<string, unknown>;

export const OPERATORS_BY_TYPE: Record<ColumnType, Operator[]> = {
    text: ["contains", "notContains", "eq", "neq", "startsWith", "in", "notIn", "empty", "notEmpty"],
    status: ["eq", "neq", "in", "notIn", "contains", "empty", "notEmpty"],
    number: ["gt", "gte", "lt", "lte", "eq", "neq", "between", "empty", "notEmpty"],
    percent: ["gt", "gte", "lt", "lte", "eq", "neq", "between", "empty", "notEmpty"],
    date: ["withinDays", "olderThanDays", "before", "after", "between", "empty", "notEmpty"],
};

const MAX_DEPTH = 3;
const MAX_CONDITIONS = 30;
const MAX_TEXT = 200;
const MAX_LIST = 100;
const MAX_SORT = 3;
const MAX_VIEW_BYTES = 8_000;
const DAY_MS = 86_400_000;

const isGroup = (x: unknown): x is FilterGroup => !!x && typeof x === "object" && Array.isArray((x as FilterGroup).conditions);
const typeOf = (c: ReportColumn): ColumnType => c.type ?? "text";
const isEmpty = (v: unknown) => v === null || v === undefined || v === "";

/* ------------------------------ checking a view someone sent ------------------------------ */

function fail(message: string): never {
    throw new BadRequestException(message);
}

function parseDate(value: unknown, what: string): Date {
    const d = new Date(String(value));
    if (!/^\d{4}-\d{2}-\d{2}/.test(String(value)) || Number.isNaN(d.getTime())) fail(`${what} needs a date like 2026-03-01.`);
    return d;
}

function checkValue(column: ReportColumn, op: Operator, value: unknown): unknown {
    const label = column.label;
    const text = (v: unknown) => {
        const s = String(v ?? "");
        if (s.length > MAX_TEXT) fail(`The value for ${label} is too long.`);
        return s;
    };
    switch (op) {
        case "empty":
        case "notEmpty":
            return undefined;
        case "in":
        case "notIn": {
            if (!Array.isArray(value) || !value.length) fail(`Choose at least one value for ${label}.`);
            if (value.length > MAX_LIST) fail(`Too many values for ${label}.`);
            return value.map(text);
        }
        case "contains":
        case "notContains":
        case "startsWith":
        case "eq":
        case "neq": {
            if (typeOf(column) === "number" || typeOf(column) === "percent") {
                const n = Number(value);
                if (value === "" || value === null || value === undefined || !Number.isFinite(n)) fail(`${label} needs a number.`);
                return n;
            }
            const s = text(value);
            if (!s && op !== "eq" && op !== "neq") fail(`Type something to look for in ${label}.`);
            return s;
        }
        case "gt":
        case "gte":
        case "lt":
        case "lte": {
            const n = Number(value);
            if (value === "" || value === null || value === undefined || !Number.isFinite(n)) fail(`${label} needs a number.`);
            return n;
        }
        case "withinDays":
        case "olderThanDays": {
            const n = Number(value);
            if (!Number.isFinite(n) || n < 0 || n > 36_500) fail(`${label} needs a number of days.`);
            return n;
        }
        case "before":
        case "after":
            return parseDate(value, label).toISOString();
        case "between": {
            if (!Array.isArray(value) || value.length !== 2) fail(`${label} needs a start and an end.`);
            if (typeOf(column) === "date") return [parseDate(value[0], label).toISOString(), parseDate(value[1], label).toISOString()];
            const [a, b] = value.map(Number);
            if (!Number.isFinite(a) || !Number.isFinite(b)) fail(`${label} needs two numbers.`);
            return [Math.min(a, b), Math.max(a, b)];
        }
    }
    return fail(`Unknown condition on ${label}.`);
}

/** Turns what came over the wire into a view that is safe to run, or says plainly what is wrong with it. */
export function checkView(raw: unknown, columns: ReportColumn[]): ViewSpec {
    if (raw === undefined || raw === null || raw === "") return {};
    let input: any = raw;
    if (typeof raw === "string") {
        if (raw.length > MAX_VIEW_BYTES) fail("That view is too large.");
        try {
            input = JSON.parse(raw);
        } catch {
            fail("The view could not be read.");
        }
    }
    if (!input || typeof input !== "object" || Array.isArray(input)) fail("The view could not be read.");
    if (JSON.stringify(input).length > MAX_VIEW_BYTES) fail("That view is too large.");

    const usable = columns.filter((c) => !c.internal);
    const byKey = new Map(usable.map((c) => [c.key, c]));
    const column = (key: unknown, what: string) => {
        const c = byKey.get(String(key));
        if (!c) fail(`${what} refers to a column that does not exist.`);
        return c;
    };

    let count = 0;
    const checkGroup = (group: any, depth: number): FilterGroup => {
        if (depth > MAX_DEPTH) fail("Filters are nested too deeply.");
        if (!group || typeof group !== "object" || !Array.isArray(group.conditions)) fail("A filter group is malformed.");
        const match = group.match === "any" ? "any" : "all";
        const conditions = group.conditions.map((item: any): Condition | FilterGroup => {
            if (isGroup(item)) return checkGroup(item, depth + 1);
            if (++count > MAX_CONDITIONS) fail("Too many conditions.");
            const c = column(item?.field, "A condition");
            const op = String(item?.op) as Operator;
            if (!OPERATORS_BY_TYPE[typeOf(c)].includes(op)) fail(`${c.label} cannot be filtered that way.`);
            const value = checkValue(c, op, item?.value);
            return { field: c.key, op, ...(value !== undefined ? { value } : {}) };
        });
        return { match, conditions };
    };

    const out: ViewSpec = {};
    if (input.filter && input.filter.conditions?.length) out.filter = checkGroup(input.filter, 1);

    if (input.sort !== undefined) {
        if (!Array.isArray(input.sort) || input.sort.length > MAX_SORT) fail(`Sort by at most ${MAX_SORT} columns.`);
        out.sort = input.sort.map((s: any) => ({ key: column(s?.key, "A sort").key, dir: s?.dir === "desc" ? "desc" : "asc" }));
    }
    if (input.groupBy) out.groupBy = column(input.groupBy, "Grouping").key;
    if (input.columns !== undefined) {
        if (!Array.isArray(input.columns) || !input.columns.length) fail("Choose at least one column.");
        const seen = new Set<string>();
        out.columns = input.columns.map((k: unknown) => column(k, "The column list").key).filter((k: string) => (seen.has(k) ? false : (seen.add(k), true)));
    }
    return out;
}

/* ------------------------------ filtering ------------------------------ */

function matches(row: Row, c: Condition, column: ReportColumn, now: number): boolean {
    const raw = row[c.field];
    const type = typeOf(column);
    const empty = isEmpty(raw);
    switch (c.op) {
        case "empty": return empty;
        case "notEmpty": return !empty;
    }

    if (type === "date") {
        const t = raw instanceof Date ? raw.getTime() : empty ? NaN : new Date(String(raw)).getTime();
        const known = Number.isFinite(t);
        switch (c.op) {
            // Never seen counts as older than any number of days.
            case "olderThanDays": return !known || t < now - Number(c.value) * DAY_MS;
            case "withinDays": return known && t >= now - Number(c.value) * DAY_MS;
            case "before": return known && t < new Date(String(c.value)).getTime();
            // After the whole of that day.
            case "after": return known && t >= new Date(String(c.value)).getTime() + DAY_MS;
            case "between": {
                const [a, b] = (c.value as string[]).map((x) => new Date(x).getTime());
                return known && t >= a && t < b + DAY_MS;
            }
        }
        return false;
    }

    if (type === "number" || type === "percent") {
        const n = typeof raw === "number" ? raw : Number(raw);
        const known = !empty && Number.isFinite(n);
        const v = c.value as number;
        switch (c.op) {
            case "gt": return known && n > v;
            case "gte": return known && n >= v;
            case "lt": return known && n < v;
            case "lte": return known && n <= v;
            case "eq": return known && n === v;
            case "neq": return !known || n !== v;
            case "between": return known && n >= (c.value as number[])[0] && n <= (c.value as number[])[1];
        }
        return false;
    }

    const s = empty ? "" : String(raw).toLowerCase();
    const one = String(c.value ?? "").toLowerCase();
    switch (c.op) {
        case "contains": return s.includes(one);
        case "notContains": return !s.includes(one);
        case "startsWith": return s.startsWith(one);
        case "eq": return s === one;
        case "neq": return s !== one;
        case "in": return (c.value as string[]).some((x) => x.toLowerCase() === s);
        case "notIn": return !(c.value as string[]).some((x) => x.toLowerCase() === s);
    }
    return false;
}

export function applyFilter(rows: Row[], group: FilterGroup | undefined, columns: ReportColumn[], now = Date.now()): Row[] {
    if (!group || !group.conditions.length) return rows;
    const byKey = new Map(columns.map((c) => [c.key, c]));
    const test = (row: Row, g: FilterGroup): boolean => {
        const results = g.conditions.map((item) => (isGroup(item) ? test(row, item) : matches(row, item, byKey.get(item.field)!, now)));
        return g.match === "any" ? results.some(Boolean) : results.every(Boolean);
    };
    return rows.filter((r) => test(r, group));
}

/* ------------------------------ sorting and grouping ------------------------------ */

export function compareValues(a: unknown, b: unknown): number {
    if (a instanceof Date) a = a.getTime();
    if (b instanceof Date) b = b.getTime();
    if (typeof a === "number" && typeof b === "number") return a - b;
    return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}

/** Rows with nothing in the column always go last, whichever way it is sorted. */
export function applySort(rows: Row[], sort: SortKey[] | undefined, groupBy?: string | null): Row[] {
    const keys: SortKey[] = [...(groupBy ? [{ key: groupBy, dir: "asc" as const }] : []), ...(sort ?? [])];
    if (!keys.length) return rows;
    return [...rows].sort((x, y) => {
        for (const k of keys) {
            const a = x[k.key];
            const b = y[k.key];
            const ae = isEmpty(a);
            const be = isEmpty(b);
            if (ae || be) {
                if (ae && be) continue;
                return ae ? 1 : -1;
            }
            const d = compareValues(a, b);
            if (d) return k.dir === "desc" ? -d : d;
        }
        return 0;
    });
}

export const displayValue = (v: unknown) => (isEmpty(v) ? "(none)" : v instanceof Date ? v.toISOString().slice(0, 10) : String(v));

export function groupCounts(rows: Row[], groupBy: string | null | undefined): Array<{ value: string; count: number }> {
    if (!groupBy) return [];
    const counts = new Map<string, number>();
    for (const r of rows) {
        const key = displayValue(r[groupBy]);
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return Array.from(counts, ([value, count]) => ({ value, count }));
}

/* ------------------------------ charts ------------------------------ */

export type ChartSpec =
    | { key: string; title: string; kind: "bar" | "donut"; field: string; top?: number; weight?: string }
    | { key: string; title: string; kind: "bar"; field: string; buckets: Array<{ label: string; min?: number; max?: number }> }
    | { key: string; title: string; kind: "line"; field: string; days: number }
    | { key: string; title: string; kind: "bar"; flags: Array<{ field: string; label: string }> };

export type Chart = { key: string; title: string; kind: "bar" | "donut" | "line"; data: Array<{ label: string; value: number }> };

export function buildCharts(rows: Row[], specs: ChartSpec[]): Chart[] {
    return specs.map((spec): Chart => {
        if ("flags" in spec) {
            return { key: spec.key, title: spec.title, kind: "bar", data: spec.flags.map((f) => ({ label: f.label, value: rows.filter((r) => r[f.field] === true).length })).filter((d) => d.value > 0) };
        }
        if ("buckets" in spec) {
            const data = spec.buckets.map((b) => ({ label: b.label, value: 0 }));
            let unknown = 0;
            for (const r of rows) {
                const raw = r[spec.field];
                const n = typeof raw === "number" ? raw : Number(raw);
                if (isEmpty(raw) || !Number.isFinite(n)) {
                    unknown++;
                    continue;
                }
                const i = spec.buckets.findIndex((b) => (b.min === undefined || n >= b.min) && (b.max === undefined || n < b.max));
                if (i >= 0) data[i].value++;
            }
            if (unknown) data.push({ label: "Not reported", value: unknown });
            return { key: spec.key, title: spec.title, kind: "bar", data: data.filter((d) => d.value > 0) };
        }
        if (spec.kind === "line") {
            const perDay = new Map<string, number>();
            for (const r of rows) {
                const raw = r[spec.field];
                const t = raw instanceof Date ? raw : isEmpty(raw) ? null : new Date(String(raw));
                if (!t || Number.isNaN(t.getTime())) continue;
                const day = t.toISOString().slice(0, 10);
                perDay.set(day, (perDay.get(day) ?? 0) + 1);
            }
            // Every day in the range, so quiet days show as zero and not as a gap.
            const days = Array.from(perDay.keys()).sort();
            const data: Chart["data"] = [];
            if (days.length) {
                const end = new Date(days[days.length - 1]).getTime();
                const start = Math.max(new Date(days[0]).getTime(), end - (spec.days - 1) * DAY_MS);
                for (let t = start; t <= end; t += DAY_MS) {
                    const d = new Date(t).toISOString().slice(0, 10);
                    data.push({ label: d, value: perDay.get(d) ?? 0 });
                }
            }
            return { key: spec.key, title: spec.title, kind: "line", data };
        }
        const counts = new Map<string, number>();
        for (const r of rows) {
            const label = displayValue(r[spec.field]);
            const add = spec.weight ? Number(r[spec.weight]) || 0 : 1;
            counts.set(label, (counts.get(label) ?? 0) + add);
        }
        const sorted = Array.from(counts, ([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
        const top = spec.top ?? 8;
        const data = sorted.slice(0, top);
        const rest = sorted.slice(top).reduce((s, d) => s + d.value, 0);
        if (rest) data.push({ label: "Other", value: rest });
        return { key: spec.key, title: spec.title, kind: spec.kind, data };
    });
}

/* ------------------------------ choosing columns ------------------------------ */

/** The columns to export: the ones asked for, in that order, otherwise the ones shown by default. */
export function exportColumns(columns: ReportColumn[], chosen?: string[]): ReportColumn[] {
    const usable = columns.filter((c) => !c.internal);
    if (chosen?.length) {
        const byKey = new Map(usable.map((c) => [c.key, c]));
        return chosen.map((k) => byKey.get(k)).filter((c): c is ReportColumn => !!c);
    }
    return usable.filter((c) => c.visible !== false);
}
