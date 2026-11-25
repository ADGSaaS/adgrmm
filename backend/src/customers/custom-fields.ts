// Custom fields for customers: what a field is, and the rules for the values people type into them.
import { BadRequestException } from "@nestjs/common";

export const FIELD_TYPES = ["text", "longtext", "number", "date", "dropdown", "checkbox", "url"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export type FieldDef = {
    id: string;
    key: string;
    label: string;
    type: FieldType;
    options: string[];
    required: boolean;
    help: string;
    sortOrder: number;
    active: boolean;
    /** Ticket fields: the customer sees it on their ticket in the client portal. */
    visibleToCustomer: boolean;
};

export const MAX_FIELDS = 40;
const TEXT_MAX = 500;
const LONGTEXT_MAX = 4000;

const clean = (v: unknown) => String(v ?? "").trim().replace(/[ \t]+/g, " ");

/** "Account manager" becomes account_manager. Always a valid key: starts with a letter, lower case, at most 40 characters. */
export function keyFromLabel(label: string): string {
    let k = label.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    if (!/^[a-z]/.test(k)) k = `f_${k}`;
    k = k.slice(0, 40).replace(/_+$/g, "");
    return k || "field";
}

export function cleanLabel(v: unknown): string {
    const s = clean(v);
    if (!s) throw new BadRequestException("Give the field a name.");
    if (s.length > 80) throw new BadRequestException("The field name is too long (80 characters at most).");
    return s;
}

export function cleanOptions(type: FieldType, v: unknown): string[] {
    if (type !== "dropdown") return [];
    const raw = Array.isArray(v) ? v : typeof v === "string" ? v.split(/\r?\n/) : [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const o of raw) {
        const s = clean(o);
        if (!s || seen.has(s.toLowerCase())) continue;
        if (s.length > 80) throw new BadRequestException("A choice is too long (80 characters at most).");
        seen.add(s.toLowerCase());
        out.push(s);
    }
    if (out.length === 0) throw new BadRequestException("A dropdown needs at least one choice.");
    if (out.length > 50) throw new BadRequestException("A dropdown can have 50 choices at most.");
    return out;
}

export function cleanHelp(v: unknown): string {
    const s = clean(v);
    if (s.length > 200) throw new BadRequestException("The help text is too long (200 characters at most).");
    return s;
}

/**
 * One value, checked against its field. An empty value (empty text, null) clears the field and is returned as
 * undefined. `existing` is what is saved now: a choice that has since been removed from a dropdown may stay as it is.
 */
export function cleanValue(def: FieldDef, raw: unknown, existing: unknown): string | number | boolean | undefined {
    const label = def.label;
    if (raw === null || raw === undefined) return undefined;
    switch (def.type) {
        case "text":
        case "longtext": {
            const s = def.type === "text" ? clean(raw) : String(raw).replace(/\r\n?/g, "\n").trim();
            if (!s) return undefined;
            const max = def.type === "text" ? TEXT_MAX : LONGTEXT_MAX;
            if (s.length > max) throw new BadRequestException(`${label} is too long (${max} characters at most).`);
            return s;
        }
        case "number": {
            if (typeof raw === "string" && !raw.trim()) return undefined;
            const n = typeof raw === "number" ? raw : Number(String(raw).trim().replace(/,/g, ""));
            if (!Number.isFinite(n) || Math.abs(n) > 1e15) throw new BadRequestException(`${label} must be a number.`);
            return n;
        }
        case "date": {
            const s = clean(raw);
            if (!s) return undefined;
            if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`)) || new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) !== s) {
                throw new BadRequestException(`${label} must be a date.`);
            }
            return s;
        }
        case "dropdown": {
            const s = clean(raw);
            if (!s) return undefined;
            const hit = def.options.find((o) => o.toLowerCase() === s.toLowerCase());
            if (hit) return hit;
            if (typeof existing === "string" && existing === s) return s;
            throw new BadRequestException(`${label} must be one of its choices.`);
        }
        case "checkbox": {
            if (typeof raw === "boolean") return raw;
            if (raw === "true" || raw === "false") return raw === "true";
            if (typeof raw === "string" && !raw.trim()) return undefined;
            throw new BadRequestException(`${label} must be checked or not.`);
        }
        case "url": {
            let s = clean(raw);
            if (!s) return undefined;
            if (s.length > TEXT_MAX) throw new BadRequestException(`${label} is too long (${TEXT_MAX} characters at most).`);
            if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
            try {
                const u = new URL(s);
                if (!u.hostname.includes(".")) throw new Error("no dot");
                return u.toString().replace(/\/$/, "");
            } catch {
                throw new BadRequestException(`${label} must be a web address.`);
            }
        }
    }
}

const isEmpty = (v: unknown) => v === undefined || v === null || v === "" || v === false;

/**
 * The values to save for a customer: what is saved now, with the changes sent applied. Only fields that exist and are
 * active may be changed. A required field must have a value (a required checkbox must be checked) when `check` says to.
 */
export function mergeValues(defs: FieldDef[], changes: Record<string, unknown> | undefined, existing: Record<string, unknown>, check: boolean): Record<string, unknown> {
    const active = new Map(defs.filter((d) => d.active).map((d) => [d.key, d]));
    const merged: Record<string, unknown> = { ...existing };
    for (const [key, raw] of Object.entries(changes ?? {})) {
        const def = active.get(key);
        if (!def) throw new BadRequestException(`There is no custom field "${key}".`);
        const v = cleanValue(def, raw, existing[key]);
        if (v === undefined) delete merged[key];
        else merged[key] = v;
    }
    if (check) {
        for (const def of active.values()) {
            if (def.required && isEmpty(merged[def.key])) {
                throw new BadRequestException(def.type === "checkbox" ? `${def.label} must be checked.` : `${def.label} is required.`);
            }
        }
    }
    return merged;
}

/** A saved value as people read it, or null when there is none: yes/no for a checkbox. Used in history and the portal. */
export function displayValue(type: string, v: unknown): string | null {
    if (v === undefined || v === null || v === "") return type === "checkbox" ? "No" : null;
    if (type === "checkbox") return v === true ? "Yes" : "No";
    return String(v);
}
