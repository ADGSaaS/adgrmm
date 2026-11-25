// backend/src/data-exchange/import.service.ts
//
// CSV import of customers, sites and contacts, in two steps: a preview that writes nothing and says what each row
// would do, and an apply that does it. Both run the same code with the same checks, and every record is written by
// the customers service, so a row is accepted or refused exactly as it would be on the customer screen.
//
// Each row stands alone: a row with a problem is reported and skipped, and the others are still applied.
// An empty cell never erases what is stored; the import can add and change details, not blank them.
import { BadRequestException, ConflictException, HttpException, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { CustomFieldsService } from "../customers/custom-fields.service";
import { cleanProfile, cleanSite, type ContactInput } from "../customers/customer-profile";
import { CustomersService } from "../customers/customers.service";
import { PrismaService } from "../storage/prisma.service";
import { parseCsv, undefuse } from "./csv";

export const IMPORT_KINDS = ["customers", "sites", "contacts"] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];
export type OnExisting = "skip" | "update";

export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 5000;
const RESPONSE_ROWS = 1000;

export type RowAction = "create" | "update" | "skip" | "error";
export type RowResult = { row: number; action: RowAction; label: string; message?: string };
export type ImportReport = {
    kind: ImportKind;
    mode: "preview" | "apply";
    onExisting: OnExisting;
    summary: { rows: number; create: number; update: number; skip: number; error: number };
    warnings: string[];
    rows: RowResult[];
    /** True when there were more rows than are listed. The summary always counts every row. */
    truncated: boolean;
};

type Cells = Record<string, string>;
type Row = { n: number; cells: Cells };

const ADDRESS_COLUMNS = ["address_line1", "address_line2", "address_city", "address_region", "address_postal_code", "address_country"] as const;
const ADDRESS_KEYS: Record<(typeof ADDRESS_COLUMNS)[number], string> = { address_line1: "line1", address_line2: "line2", address_city: "city", address_region: "region", address_postal_code: "postalCode", address_country: "country" };

const CUSTOMER_FIELDS: Record<string, string> = { status: "status", account_number: "accountNumber", legal_name: "legalName", industry: "industry", website: "website", phone: "phone", email: "email", billing_email: "billingEmail", tax_id: "taxId", time_zone: "timeZone", currency: "currency", payment_terms: "paymentTerms", employee_count: "employeeCount", customer_since: "customerSince", notes: "notes" };
const SITE_FIELDS: Record<string, string> = { phone: "phone", email: "email", contact_name: "contactName", contact_email: "contactEmail", contact_phone: "contactPhone", time_zone: "timeZone", notes: "notes" };
const CONTACT_FIELDS: Record<string, string> = { job_title: "jobTitle", email: "email", phone: "phone", mobile: "mobile", role: "role", notes: "notes" };

const COLUMNS: Record<ImportKind, { required: string[]; known: string[]; ignored: string[] }> = {
    customers: { required: ["name"], known: ["name", "tags", ...Object.keys(CUSTOMER_FIELDS), ...ADDRESS_COLUMNS], ignored: ["id", "archived", "created_at"] },
    sites: { required: ["customer", "name"], known: ["customer", "name", ...Object.keys(SITE_FIELDS), ...ADDRESS_COLUMNS], ignored: ["customer_id", "id"] },
    contacts: { required: ["customer", "name"], known: ["customer", "name", "is_primary", ...Object.keys(CONTACT_FIELDS)], ignored: ["customer_id"] },
};

export const TEMPLATES: Record<ImportKind, string[][]> = {
    customers: [
        ["name", "status", "account_number", "phone", "email", "website", "address_line1", "address_city", "address_region", "address_postal_code", "address_country", "tags", "notes"],
        ["Example Dental", "active", "A-1001", "+1 555 0100", "office@example-dental.test", "example-dental.test", "12 Main St", "Springfield", "IL", "62701", "USA", "dental; priority", "Prefers email"],
    ],
    sites: [
        ["customer", "name", "address_line1", "address_city", "address_region", "address_postal_code", "address_country", "phone", "contact_name", "contact_email", "time_zone"],
        ["Example Dental", "Main office", "12 Main St", "Springfield", "IL", "62701", "USA", "+1 555 0100", "Pat Lee", "pat@example-dental.test", "America/Chicago"],
    ],
    contacts: [
        ["customer", "name", "job_title", "email", "phone", "mobile", "role", "is_primary", "notes"],
        ["Example Dental", "Pat Lee", "Office manager", "pat@example-dental.test", "+1 555 0100", "+1 555 0101", "primary", "yes", ""],
    ],
};

const yes = (s: string) => /^(yes|true|1|y)$/i.test(s.trim());
const lower = (s: string) => s.trim().toLowerCase();
const failure = (e: unknown): string => {
    if (e instanceof HttpException) {
        const r: any = e.getResponse();
        const m = typeof r === "string" ? r : Array.isArray(r?.message) ? r.message.join(" ") : r?.message;
        return String(m ?? e.message);
    }
    return "Something went wrong saving this row.";
};

type Ctx = { orgId: string; apply: boolean; onExisting: OnExisting; /** Customers a limited person may touch, or null for all. */ allowed: string[] | null };

@Injectable()
export class ImportService {
    private readonly busy = new Set<string>();

    constructor(private readonly prisma: PrismaService, private readonly customers: CustomersService, private readonly customFields: CustomFieldsService) { }

    /** Runs a preview or an apply. Nothing is written unless apply is true. */
    async run(kind: ImportKind, text: string, ctx: Ctx): Promise<ImportReport> {
        const { rows, warnings } = this.read(kind, text);
        if (ctx.apply) {
            if (this.busy.has(ctx.orgId)) throw new ConflictException("Another import is running. Wait for it to finish.");
            this.busy.add(ctx.orgId);
        }
        try {
            const results = kind === "customers" ? await this.customersRows(rows, ctx) : kind === "sites" ? await this.sitesRows(rows, ctx) : await this.contactsRows(rows, ctx);
            const summary = { rows: results.length, create: 0, update: 0, skip: 0, error: 0 };
            for (const r of results) summary[r.action]++;
            return {
                kind,
                mode: ctx.apply ? "apply" : "preview",
                onExisting: ctx.onExisting,
                summary,
                warnings,
                // Problems first, so they are never lost below the cut.
                rows: [...results.filter((r) => r.action === "error"), ...results.filter((r) => r.action !== "error")].slice(0, RESPONSE_ROWS),
                truncated: results.length > RESPONSE_ROWS,
            };
        } finally {
            if (ctx.apply) this.busy.delete(ctx.orgId);
        }
    }

    private read(kind: ImportKind, text: string): { rows: Row[]; warnings: string[] } {
        const spec = COLUMNS[kind];
        const csv = parseCsv(text, { maxRows: MAX_IMPORT_ROWS });
        const missing = spec.required.filter((c) => !csv.header.includes(c));
        if (missing.length) throw new BadRequestException(`The file needs a column named ${missing.map((m) => `"${m}"`).join(" and ")}. Found: ${csv.header.filter(Boolean).join(", ") || "no named columns"}.`);
        const unknown = csv.header.filter((h) => h && !spec.known.includes(h) && !spec.ignored.includes(h));
        const warnings = unknown.length ? [`These columns are not used and were ignored: ${unknown.join(", ")}.`] : [];
        const rows = csv.rows.map((r, i): Row => {
            const cells: Cells = {};
            csv.header.forEach((h, c) => {
                if (h) cells[h] = undefuse((r[c] ?? "").trim());
            });
            return { n: csv.lines[i], cells };
        });
        return { rows, warnings };
    }

    /** Only the fields this row actually filled in. */
    private fields(cells: Cells, map: Record<string, string>): Record<string, unknown> {
        const out: Record<string, unknown> = {};
        for (const [col, key] of Object.entries(map)) {
            const v = cells[col];
            if (v === undefined || v === "") continue;
            out[key] = key === "status" || key === "role" ? v.toLowerCase() : v;
        }
        return out;
    }

    /** The row's address cells merged over what is stored, so filling in one part keeps the others. */
    private address(cells: Cells, stored: unknown): Record<string, string> | undefined {
        const given = ADDRESS_COLUMNS.filter((c) => (cells[c] ?? "") !== "");
        if (!given.length) return undefined;
        const base: Record<string, string> = stored && typeof stored === "object" && !Array.isArray(stored) ? { ...(stored as Record<string, string>) } : {};
        for (const c of given) base[ADDRESS_KEYS[c]] = cells[c];
        return base;
    }

    /* ------------------------------ customers ------------------------------ */

    private async customersRows(rows: Row[], ctx: Ctx): Promise<RowResult[]> {
        if (ctx.allowed) throw new BadRequestException("People who are limited to some customers cannot import customers. They can import sites and contacts for their own customers.");
        const names = [...new Set(rows.map((r) => lower(r.cells.name ?? "")).filter(Boolean))];
        const existing = new Map<string, { id: string; address: unknown }>();
        if (names.length) {
            const found = await this.prisma.$queryRaw<{ id: string; lname: string; address: unknown }[]>`
              SELECT c.id::text AS id, lower(c.name) AS lname, c.address FROM public.clients c
               WHERE c.organization_id = ${ctx.orgId}::uuid AND lower(c.name) = ANY(${names}::text[])`;
            for (const f of found) existing.set(f.lname, { id: f.id, address: f.address });
        }
        const seen = new Map<string, number>();
        const out: RowResult[] = [];
        // Whether a new customer can be made without values for required custom fields. Asked once, not for every row.
        let requiredFields: string | null | undefined;
        for (const r of rows) {
            const name = (r.cells.name ?? "").trim();
            const label = name || `row ${r.n}`;
            const done = (action: RowAction, message?: string) => out.push({ row: r.n, action, label, ...(message ? { message } : {}) });
            if (!name) { done("error", "The name is empty."); continue; }
            const key = lower(name);
            if (seen.has(key)) { done("error", `This customer is already in the file on line ${seen.get(key)}.`); continue; }
            seen.set(key, r.n);
            const found = existing.get(key);
            try {
                if (found) {
                    if (ctx.onExisting === "skip") { done("skip", "A customer with this name already exists."); continue; }
                    const body: Record<string, unknown> = this.fields(r.cells, CUSTOMER_FIELDS);
                    const addr = this.address(r.cells, found.address);
                    if (addr) body.address = addr;
                    if (r.cells.tags) body.tags = r.cells.tags.split(/[;|]/).map((t) => t.trim()).filter(Boolean);
                    if (!Object.keys(body).length) { done("skip", "Nothing in this row differs from what is stored."); continue; }
                    cleanProfile(body, { requireName: false });
                    if (ctx.apply) await this.customers.updateClient(found.id, body, ctx.orgId);
                    done("update");
                } else {
                    const body: Record<string, unknown> = { name, ...this.fields(r.cells, CUSTOMER_FIELDS) };
                    const addr = this.address(r.cells, undefined);
                    if (addr) body.address = addr;
                    if (r.cells.tags) body.tags = r.cells.tags.split(/[;|]/).map((t) => t.trim()).filter(Boolean);
                    cleanProfile(body, { requireName: true });
                    // A new customer has to have a value for every required custom field, which a file of this shape cannot hold.
                    if (requiredFields === undefined) requiredFields = await this.customFields.valuesToSave(ctx.orgId, undefined, {}, true).then(() => null, (e) => failure(e));
                    if (requiredFields) throw new BadRequestException(requiredFields);
                    if (ctx.apply) await this.customers.createClient(body, ctx.orgId);
                    done("create");
                    existing.set(key, { id: "", address: body.address });
                }
            } catch (e) {
                done("error", failure(e));
            }
        }
        return out;
    }

    /* ------------------------------ sites ------------------------------ */

    /** The customers named in the file, by lower-cased name, and whether this person may touch each. */
    private async customersByName(rows: Row[], ctx: Ctx): Promise<Map<string, string>> {
        const names = [...new Set(rows.map((r) => lower(r.cells.customer ?? "")).filter(Boolean))];
        const map = new Map<string, string>();
        if (!names.length) return map;
        const found = await this.prisma.$queryRaw<{ id: string; lname: string }[]>`
          SELECT c.id::text AS id, lower(c.name) AS lname FROM public.clients c
           WHERE c.organization_id = ${ctx.orgId}::uuid AND lower(c.name) = ANY(${names}::text[])`;
        for (const f of found) map.set(f.lname, f.id);
        return map;
    }

    private customerProblem(name: string, id: string | undefined, ctx: Ctx): string | null {
        if (!name) return "The customer column is empty.";
        if (!id || (ctx.allowed && !ctx.allowed.includes(id))) return `There is no customer called "${name}"${ctx.allowed ? " that you may change" : ""}. Import customers first.`;
        return null;
    }

    private async sitesRows(rows: Row[], ctx: Ctx): Promise<RowResult[]> {
        const clients = await this.customersByName(rows, ctx);
        const stored = new Map<string, { id: string; address: unknown }>();
        const ids = [...new Set(clients.values())];
        if (ids.length) {
            const found = await this.prisma.sites.findMany({ where: { client_id: { in: ids } }, select: { id: true, client_id: true, name: true, address: true } });
            for (const s of found) stored.set(`${s.client_id}|${lower(s.name)}`, { id: s.id, address: s.address });
        }
        const seen = new Map<string, number>();
        const out: RowResult[] = [];
        for (const r of rows) {
            const customer = (r.cells.customer ?? "").trim();
            const name = (r.cells.name ?? "").trim();
            const label = `${customer || "?"} / ${name || "?"}`;
            const done = (action: RowAction, message?: string) => out.push({ row: r.n, action, label, ...(message ? { message } : {}) });
            const clientId = clients.get(lower(customer));
            const bad = this.customerProblem(customer, clientId, ctx);
            if (bad) { done("error", bad); continue; }
            if (!name) { done("error", "The site name is empty."); continue; }
            const key = `${clientId}|${lower(name)}`;
            if (seen.has(key)) { done("error", `This site is already in the file on line ${seen.get(key)}.`); continue; }
            seen.set(key, r.n);
            const found = stored.get(key);
            try {
                if (found) {
                    if (ctx.onExisting === "skip") { done("skip", "This customer already has a site with this name."); continue; }
                    const body: Record<string, unknown> = this.fields(r.cells, SITE_FIELDS);
                    const addr = this.address(r.cells, found.address);
                    if (addr) body.address = addr;
                    if (!Object.keys(body).length) { done("skip", "Nothing in this row differs from what is stored."); continue; }
                    cleanSite(body, { requireName: false });
                    if (ctx.apply) await this.customers.updateSite(clientId!, found.id, body, ctx.orgId);
                    done("update");
                } else {
                    const body: Record<string, unknown> = { name, ...this.fields(r.cells, SITE_FIELDS) };
                    const addr = this.address(r.cells, undefined);
                    if (addr) body.address = addr;
                    cleanSite(body, { requireName: true });
                    if (ctx.apply) await this.customers.createSiteForClient(clientId!, body, ctx.orgId);
                    done("create");
                    stored.set(key, { id: "", address: body.address });
                }
            } catch (e) {
                done("error", failure(e));
            }
        }
        return out;
    }

    /* ------------------------------ contacts ------------------------------ */

    private async contactsRows(rows: Row[], ctx: Ctx): Promise<RowResult[]> {
        const clients = await this.customersByName(rows, ctx);
        const lists = new Map<string, ContactInput[]>();
        const ids = [...new Set(clients.values())];
        if (ids.length) {
            const found = await this.prisma.customer_contacts.findMany({ where: { client_id: { in: ids } }, orderBy: [{ is_primary: "desc" }, { created_at: "asc" }] });
            for (const c of found) {
                const list = lists.get(c.client_id) ?? [];
                list.push({ id: c.id, name: c.name, jobTitle: c.job_title, email: c.email, phone: c.phone, mobile: c.mobile, role: c.role, isPrimary: c.is_primary, notes: c.notes });
                lists.set(c.client_id, list);
            }
        }
        const fromFile = new Map<string, number>();
        const touched = new Map<string, number[]>();
        const out: RowResult[] = [];
        const index = new Map<number, RowResult>();
        for (const r of rows) {
            const customer = (r.cells.customer ?? "").trim();
            const name = (r.cells.name ?? "").trim();
            const label = `${customer || "?"} / ${name || "?"}`;
            const done = (action: RowAction, message?: string) => {
                const res: RowResult = { row: r.n, action, label, ...(message ? { message } : {}) };
                out.push(res);
                index.set(r.n, res);
            };
            const clientId = clients.get(lower(customer));
            const bad = this.customerProblem(customer, clientId, ctx);
            if (bad) { done("error", bad); continue; }
            if (!name) { done("error", "The contact name is empty."); continue; }
            const list = lists.get(clientId!) ?? [];
            const email = lower(r.cells.email ?? "");
            const key = `${clientId}|${email || `name:${lower(name)}`}`;
            if (fromFile.has(key)) { done("error", `This contact is already in the file on line ${fromFile.get(key)}.`); continue; }
            fromFile.set(key, r.n);
            const match = list.find((c) => (email ? lower(c.email ?? "") === email : lower(c.name) === lower(name)));
            try {
                const fields = this.fields(r.cells, CONTACT_FIELDS);
                const primary = r.cells.is_primary ? yes(r.cells.is_primary) : undefined;
                if (match) {
                    if (ctx.onExisting === "skip") { done("skip", "This customer already has this contact."); continue; }
                    const next = { ...match, ...(name !== match.name && !email ? {} : { name }), ...fields, ...(primary !== undefined ? { isPrimary: primary } : {}) } as ContactInput;
                    this.checkContact(next);
                    Object.assign(match, next);
                    if (match.isPrimary) for (const o of list) if (o !== match) o.isPrimary = false;
                    done("update");
                } else {
                    if (list.length >= 50) { done("error", "A customer can have 50 contacts at most."); continue; }
                    const fresh = { name, jobTitle: null, email: null, phone: null, mobile: null, role: "other", isPrimary: primary === true, notes: null, ...fields } as ContactInput;
                    this.checkContact(fresh);
                    if (fresh.isPrimary) for (const o of list) o.isPrimary = false;
                    list.push(fresh);
                    lists.set(clientId!, list);
                    done("create");
                }
                touched.set(clientId!, [...(touched.get(clientId!) ?? []), r.n]);
            } catch (e) {
                done("error", failure(e).replace(/^Contact 1 /, "The contact "));
            }
        }
        if (ctx.apply) {
            // One save per customer, since saving contacts replaces the whole list.
            for (const [clientId, lines] of touched) {
                try {
                    await this.customers.updateClient(clientId, { contacts: lists.get(clientId) }, ctx.orgId);
                } catch (e) {
                    for (const n of lines) {
                        const res = index.get(n);
                        if (res) { res.action = "error"; res.message = failure(e); }
                    }
                }
            }
        }
        return out;
    }

    /** The same check the customer screen applies to one contact. */
    private checkContact(c: ContactInput) {
        cleanProfile({ contacts: [{ ...c }] }, { requireName: false });
    }
}
