// components/reports/filter-builder.tsx
"use client";

import * as React from "react";
import { Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
    OPERATORS_BY_TYPE,
    OPERATOR_LABEL,
    displayValue,
    isGroup,
    needsNoValue,
    needsTwoValues,
    newCondition,
    takesList,
    typeOf,
    type Condition,
    type FilterGroup,
    type Operator,
    type ReportColumn,
    type Row,
} from "./report-types";

const selectClass = "h-9 rounded-md border border-input bg-background px-2 text-sm";
const MAX_DEPTH = 3;

type Props = {
    columns: ReportColumn[];
    rows: Row[];
    value: FilterGroup;
    onChange: (next: FilterGroup) => void;
};

/** The values a column already has, so a person can pick "Offline" instead of typing it. */
function suggestions(rows: Row[], key: string): string[] {
    const seen = new Set<string>();
    for (const r of rows) {
        const v = r[key];
        if (v === null || v === undefined || v === "") continue;
        seen.add(displayValue(v));
        if (seen.size >= 60) break;
    }
    return Array.from(seen).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function ValueInputs({ column, condition, rows, onChange }: { column: ReportColumn; condition: Condition; rows: Row[]; onChange: (value: unknown) => void }) {
    const type = typeOf(column);
    const id = React.useId();
    const op = condition.op;
    if (needsNoValue(op)) return null;

    if (needsTwoValues(op)) {
        const pair = Array.isArray(condition.value) ? (condition.value as unknown[]) : ["", ""];
        const inputType = type === "date" ? "date" : "number";
        return (
            <div className="flex items-center gap-1">
                <Input aria-label={`${column.label} from`} className="h-9 w-32" type={inputType} value={String(pair[0] ?? "")} onChange={(e) => onChange([e.target.value, pair[1] ?? ""])} />
                <span className="text-xs text-muted-foreground">and</span>
                <Input aria-label={`${column.label} to`} className="h-9 w-32" type={inputType} value={String(pair[1] ?? "")} onChange={(e) => onChange([pair[0] ?? "", e.target.value])} />
            </div>
        );
    }

    if (takesList(op)) {
        const list = Array.isArray(condition.value) ? (condition.value as unknown[]).map(String) : [];
        return (
            <>
                <Input
                    aria-label={`${column.label} values`}
                    className="h-9 w-64"
                    list={id}
                    placeholder="Values, separated by commas"
                    defaultValue={list.join(", ")}
                    onChange={(e) => onChange(e.target.value.split(",").map((s) => s.trim()))}
                />
                <datalist id={id}>{suggestions(rows, column.key).map((s) => <option key={s} value={s} />)}</datalist>
            </>
        );
    }

    if (op === "withinDays" || op === "olderThanDays") {
        return <Input aria-label={`${column.label} days`} className="h-9 w-24" type="number" min={0} value={String(condition.value ?? "")} onChange={(e) => onChange(e.target.value)} />;
    }
    if (op === "before" || op === "after") {
        return <Input aria-label={`${column.label} date`} className="h-9 w-40" type="date" value={String(condition.value ?? "")} onChange={(e) => onChange(e.target.value)} />;
    }
    if (type === "number" || type === "percent") {
        return <Input aria-label={`${column.label} value`} className="h-9 w-28" type="number" value={String(condition.value ?? "")} onChange={(e) => onChange(e.target.value)} />;
    }
    return (
        <>
            <Input aria-label={`${column.label} value`} className="h-9 w-56" list={id} value={String(condition.value ?? "")} onChange={(e) => onChange(e.target.value)} />
            <datalist id={id}>{suggestions(rows, column.key).map((s) => <option key={s} value={s} />)}</datalist>
        </>
    );
}

function ConditionRow({ columns, rows, condition, onChange, onRemove }: { columns: ReportColumn[]; rows: Row[]; condition: Condition; onChange: (next: Condition) => void; onRemove: () => void }) {
    const column = columns.find((c) => c.key === condition.field) ?? columns[0];
    const operators = OPERATORS_BY_TYPE[typeOf(column)];
    return (
        <div className="flex flex-wrap items-center gap-2">
            <select
                aria-label="Column"
                className={cn(selectClass, "w-44")}
                value={column.key}
                onChange={(e) => {
                    const next = columns.find((c) => c.key === e.target.value)!;
                    onChange(newCondition(next));
                }}
            >
                {columns.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
            </select>
            <select
                aria-label="Condition"
                className={cn(selectClass, "w-52")}
                value={condition.op}
                onChange={(e) => onChange({ field: condition.field, op: e.target.value as Operator })}
            >
                {operators.map((op) => <option key={op} value={op}>{OPERATOR_LABEL[op]}</option>)}
            </select>
            <ValueInputs key={`${condition.field}:${condition.op}`} column={column} condition={condition} rows={rows} onChange={(value) => onChange({ ...condition, value })} />
            <Button type="button" variant="ghost" size="icon" aria-label="Remove this condition" onClick={onRemove}>
                <Trash2 className="h-4 w-4" />
            </Button>
        </div>
    );
}

function GroupEditor({ columns, rows, group, depth, onChange, onRemove }: { columns: ReportColumn[]; rows: Row[]; group: FilterGroup; depth: number; onChange: (next: FilterGroup) => void; onRemove?: () => void }) {
    const setItem = (i: number, next: Condition | FilterGroup) => onChange({ ...group, conditions: group.conditions.map((c, j) => (j === i ? next : c)) });
    const removeItem = (i: number) => onChange({ ...group, conditions: group.conditions.filter((_, j) => j !== i) });
    return (
        <div className={cn("grid gap-2", depth > 1 && "rounded-md border border-dashed border-border p-3")}>
            <div className="flex flex-wrap items-center gap-2 text-sm">
                <span>Show rows that match</span>
                <select aria-label="Match all or any" className={cn(selectClass, "w-24")} value={group.match} onChange={(e) => onChange({ ...group, match: e.target.value as "all" | "any" })}>
                    <option value="all">all</option>
                    <option value="any">any</option>
                </select>
                <span>of these</span>
                {onRemove && (
                    <Button type="button" variant="ghost" size="sm" onClick={onRemove}>
                        <Trash2 className="mr-1 h-4 w-4" /> Remove group
                    </Button>
                )}
            </div>
            {group.conditions.map((item, i) =>
                isGroup(item) ? (
                    <GroupEditor key={i} columns={columns} rows={rows} group={item} depth={depth + 1} onChange={(next) => setItem(i, next)} onRemove={() => removeItem(i)} />
                ) : (
                    <ConditionRow key={i} columns={columns} rows={rows} condition={item} onChange={(next) => setItem(i, next)} onRemove={() => removeItem(i)} />
                ),
            )}
            <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => onChange({ ...group, conditions: [...group.conditions, newCondition(columns[0])] })}>
                    <Plus className="mr-1 h-4 w-4" /> Add condition
                </Button>
                {depth < MAX_DEPTH && (
                    <Button type="button" variant="outline" size="sm" onClick={() => onChange({ ...group, conditions: [...group.conditions, { match: group.match === "all" ? "any" : "all", conditions: [newCondition(columns[0])] }] })}>
                        <Plus className="mr-1 h-4 w-4" /> Add group
                    </Button>
                )}
            </div>
        </div>
    );
}

export function FilterBuilder({ columns, rows, value, onChange }: Props) {
    const usable = columns.filter((c) => !c.internal);
    if (!usable.length) return null;
    return <GroupEditor columns={usable} rows={rows} group={value} depth={1} onChange={onChange} />;
}
