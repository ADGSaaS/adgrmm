// Searching and filtering tickets by what people saved in their custom fields.
import { Prisma } from "@prisma/client";

/** True when a ticket has a value, in a custom field still in use, that contains the (already escaped) LIKE pattern. */
export function customValueMatch(pattern: string): Prisma.Sql {
    return Prisma.sql`EXISTS (
        SELECT 1 FROM jsonb_each_text(CASE WHEN jsonb_typeof(t.custom_fields) = 'object' THEN t.custom_fields ELSE '{}'::jsonb END) cv
        JOIN public.custom_field_defs cd ON cd.organization_id = t.organization_id AND cd.entity = 'ticket' AND cd.key = cv.key AND cd.active
        WHERE cv.value ILIKE ${pattern} ESCAPE '\\')`;
}

/** The filter "this custom field has exactly this value" (no case), or null when none was asked for. A field that cannot exist matches nothing. */
export function customFieldFilter(key: unknown, value: unknown): Prisma.Sql | null {
    const k = String(key ?? "").trim();
    if (!k) return null;
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(k)) return Prisma.sql`false`;
    return Prisma.sql`lower(t.custom_fields ->> ${k}) = lower(${String(value ?? "").trim()})`;
}
