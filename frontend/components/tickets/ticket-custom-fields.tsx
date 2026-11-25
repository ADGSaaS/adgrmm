"use client";

// The custom fields tickets can have (Administration > Custom Fields): the boxes for the new-ticket form and the
// ticket page, and the helpers to fill them from what a ticket has saved, check them and build what is sent.
import * as React from "react";
import { cn } from "@/lib/utils";
import { jfetch } from "@/lib/api";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

export type TicketFieldDef = {
    id: string;
    key: string;
    label: string;
    type: "text" | "longtext" | "number" | "date" | "dropdown" | "checkbox" | "url";
    options: string[];
    required: boolean;
    help: string;
    active: boolean;
    visibleToCustomer?: boolean;
};

export type FieldValues = Record<string, string | boolean>;

/** The fields in use. A person who cannot read them (or an old server) just gets none. */
export function useTicketFieldDefs(enabled = true): TicketFieldDef[] {
    const [defs, setDefs] = React.useState<TicketFieldDef[]>([]);
    React.useEffect(() => {
        if (!enabled) return;
        let cancel = false;
        jfetch<{ items: TicketFieldDef[] }>("/api/ticket-custom-fields")
            .then((r) => { if (!cancel) setDefs(Array.isArray(r?.items) ? r.items : []); })
            .catch(() => { if (!cancel) setDefs([]); });
        return () => { cancel = true; };
    }, [enabled]);
    return defs;
}

/** What was saved, as the boxes hold it: text for every kind of box, true or false for a checkbox. */
export function valuesFromSaved(saved: unknown, defs: TicketFieldDef[]): FieldValues {
    const src = saved && typeof saved === "object" && !Array.isArray(saved) ? (saved as Record<string, unknown>) : {};
    const out: FieldValues = {};
    for (const d of defs) {
        const v = src[d.key];
        out[d.key] = d.type === "checkbox" ? v === true : v === undefined || v === null ? "" : String(v);
    }
    return out;
}

/** What to send: an empty box clears its field. Only the keys asked for (all when none are given). */
export function valuesToBody(defs: TicketFieldDef[], values: FieldValues, only?: string[]): Record<string, string | boolean> {
    const out: Record<string, string | boolean> = {};
    for (const d of defs) {
        if (only && !only.includes(d.key)) continue;
        const v = values[d.key];
        out[d.key] = d.type === "checkbox" ? v === true : typeof v === "string" ? v.trim() : "";
    }
    return out;
}

/** Which fields are wrong, by key. */
export function fieldProblems(defs: TicketFieldDef[], values: FieldValues): Record<string, string> {
    const p: Record<string, string> = {};
    for (const d of defs) {
        const v = values[d.key];
        if (d.required && (d.type === "checkbox" ? v !== true : typeof v !== "string" || !v.trim())) p[d.key] = d.type === "checkbox" ? "Must be checked" : "Required";
        else if (d.type === "number" && typeof v === "string" && v.trim() && !Number.isFinite(Number(v.trim().replace(/,/g, "")))) p[d.key] = "Must be a number";
    }
    return p;
}

const selectClass = "h-10 w-full rounded-md border border-input bg-background px-3 text-sm";

export function TicketFieldInputs({ defs, values, onChange, errors = {}, idPrefix = "tcf" }: {
    defs: TicketFieldDef[];
    values: FieldValues;
    onChange: (key: string, value: string | boolean) => void;
    errors?: Record<string, string>;
    idPrefix?: string;
}) {
    return (
        <div className="grid gap-3">
            {defs.map((d) => {
                const id = `${idPrefix}-${d.key}`;
                const v = values[d.key];
                const text = typeof v === "string" ? v : "";
                const err = errors[d.key];
                const bad = err ? "border-destructive focus-visible:ring-destructive" : "";
                return (
                    <div key={d.key} className="grid gap-1">
                        <label htmlFor={id} className={cn("text-xs text-muted-foreground", err && "text-destructive")}>
                            {d.label}{d.required ? " *" : ""}
                        </label>
                        {d.type === "checkbox" ? (
                            <label className="flex h-10 items-center gap-2 text-sm">
                                <input id={id} type="checkbox" checked={v === true} onChange={(e) => onChange(d.key, e.target.checked)} /> Yes
                            </label>
                        ) : d.type === "longtext" ? (
                            <Textarea id={id} rows={3} maxLength={4000} aria-invalid={!!err} className={bad} value={text} onChange={(e) => onChange(d.key, e.target.value)} />
                        ) : d.type === "dropdown" ? (
                            <select id={id} className={cn(selectClass, bad)} aria-invalid={!!err} value={text} onChange={(e) => onChange(d.key, e.target.value)}>
                                <option value="">{d.required ? "Choose…" : "None"}</option>
                                {/* A choice that was removed later stays selectable while it is the saved value. */}
                                {text && !d.options.includes(text) ? <option value={text}>{text}</option> : null}
                                {d.options.map((o) => <option key={o} value={o}>{o}</option>)}
                            </select>
                        ) : (
                            <Input
                                id={id}
                                type={d.type === "date" ? "date" : "text"}
                                inputMode={d.type === "number" ? "decimal" : undefined}
                                maxLength={d.type === "text" || d.type === "url" ? 500 : undefined}
                                placeholder={d.type === "url" ? "https://" : undefined}
                                aria-invalid={!!err}
                                className={bad}
                                value={text}
                                onChange={(e) => onChange(d.key, e.target.value)}
                            />
                        )}
                        {err ? <p className="text-xs text-destructive">{err}</p> : d.help ? <p className="text-xs text-muted-foreground">{d.help}</p> : null}
                    </div>
                );
            })}
        </div>
    );
}

/**
 * The custom fields on the ticket page: the boxes with what is saved, and a Save button for what was changed.
 * `onSaved` is told so the page can reload the ticket and its history.
 */
export function TicketCustomFieldsCard({ ticketId, saved, canEdit, onSaved, className }: {
    ticketId: string;
    saved: Record<string, unknown> | undefined;
    canEdit: boolean;
    onSaved: () => void | Promise<void>;
    className?: string;
}) {
    const defs = useTicketFieldDefs();
    const uid = React.useId().replace(/:/g, "");
    const [values, setValues] = React.useState<FieldValues>({});
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const [tried, setTried] = React.useState(false);
    const savedKey = JSON.stringify(saved ?? {});

    // The boxes follow what the server has, except while someone is in the middle of editing them.
    const dirty = React.useRef(false);
    React.useEffect(() => {
        if (dirty.current) return;
        setValues(valuesFromSaved(saved, defs));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [savedKey, defs]);

    if (defs.length === 0) return null;

    const original = valuesFromSaved(saved, defs);
    const changed = defs.filter((d) => values[d.key] !== original[d.key]).map((d) => d.key);
    const problems = tried ? fieldProblems(defs, values) : {};

    async function save() {
        setTried(true);
        setError(null);
        if (Object.keys(fieldProblems(defs, values)).length > 0) return;
        setBusy(true);
        try {
            await jfetch(`/api/tickets/${encodeURIComponent(ticketId)}`, { method: "PATCH", body: { customFields: valuesToBody(defs, values, changed) } });
            dirty.current = false;
            setTried(false);
            await onSaved();
        } catch (e) {
            const raw = e instanceof Error ? e.message : "Could not save.";
            let text = raw;
            try { const j = JSON.parse(raw) as { message?: string | string[] }; text = Array.isArray(j.message) ? j.message.join(" ") : j.message ?? raw; } catch { /* plain text */ }
            setError(text);
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className={cn("rounded-xl border border-border/70 bg-card p-5", className)}>
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">Custom fields</h3>
            {canEdit ? (
                <>
                    <TicketFieldInputs
                        defs={defs}
                        values={values}
                        errors={problems}
                        idPrefix={`tkcf${uid}`}
                        onChange={(k, v) => { dirty.current = true; setValues((cur) => ({ ...cur, [k]: v })); }}
                    />
                    {error ? <p role="alert" className="mt-2 text-sm text-destructive">{error}</p> : null}
                    <div className="mt-3 flex justify-end gap-2">
                        {changed.length > 0 ? (
                            <button type="button" className="h-8 rounded-md px-3 text-xs hover:bg-accent" onClick={() => { dirty.current = false; setValues(original); setTried(false); setError(null); }} disabled={busy}>
                                Discard
                            </button>
                        ) : null}
                        <button
                            type="button"
                            className="h-8 rounded-md bg-primary px-3 text-xs font-semibold text-primary-foreground disabled:opacity-50"
                            disabled={busy || changed.length === 0}
                            onClick={() => void save()}
                        >
                            {busy ? "Saving…" : "Save fields"}
                        </button>
                    </div>
                </>
            ) : (
                <dl className="space-y-3 text-sm">
                    {defs.map((d) => {
                        const v = original[d.key];
                        const shown = d.type === "checkbox" ? (v === true ? "Yes" : "No") : typeof v === "string" && v ? v : "-";
                        return (
                            <div key={d.key}>
                                <dt className="text-muted-foreground">{d.label}</dt>
                                <dd className="break-words font-medium text-foreground">
                                    {d.type === "url" && typeof v === "string" && v ? <a href={v} target="_blank" rel="noreferrer" className="underline underline-offset-2">{v}</a> : shown}
                                </dd>
                            </div>
                        );
                    })}
                </dl>
            )}
        </div>
    );
}
