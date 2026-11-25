// backend/src/customers/customer-profile.ts
// What we keep about a customer, and the rules for cleaning what a person typed.
import { BadRequestException } from "@nestjs/common";

export const STATUSES = ["active", "prospect", "inactive"] as const;
export const CONTACT_ROLES = ["primary", "billing", "technical", "owner", "other"] as const;

export type Address = { line1: string; line2: string; city: string; region: string; postalCode: string; country: string };
export type ContactInput = { id?: string; name: string; jobTitle: string | null; email: string | null; phone: string | null; mobile: string | null; role: string; isPrimary: boolean; notes: string | null };

/** Only the fields that were sent. A field that was not sent is left alone when editing. */
export type ProfileInput = {
    name?: string;
    status?: string;
    accountNumber?: string | null;
    legalName?: string | null;
    industry?: string | null;
    website?: string | null;
    phone?: string | null;
    email?: string | null;
    billingEmail?: string | null;
    taxId?: string | null;
    timeZone?: string | null;
    currency?: string | null;
    paymentTerms?: string | null;
    employeeCount?: number | null;
    customerSince?: string | null;
    address?: Address;
    billingAddress?: Address;
    billingSameAsAddress?: boolean;
    notes?: string | null;
    tags?: string[];
    contacts?: ContactInput[];
    /** Values of the organization's custom fields, by field key. Checked against the fields by the caller, since that needs the database. */
    customFields?: Record<string, unknown>;
    /** The updatedAt the person was looking at. If it has moved on, someone else saved first. */
    version?: string;
};

export type SiteInput = {
    name?: string;
    address?: Address;
    phone?: string | null;
    email?: string | null;
    contactName?: string | null;
    contactEmail?: string | null;
    contactPhone?: string | null;
    timeZone?: string | null;
    notes?: string | null;
    version?: string;
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const EMPTY_ADDRESS: Address = { line1: "", line2: "", city: "", region: "", postalCode: "", country: "" };

const has = (o: unknown, k: string) => !!o && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k);
const text = (v: unknown) => String(v ?? "").trim().replace(/[ \t]+/g, " ");

function optional(v: unknown, label: string, max: number): string | null {
    const s = text(v);
    if (!s) return null;
    if (s.length > max) throw new BadRequestException(`${label} is too long (${max} characters at most).`);
    return s;
}

function email(v: unknown, label: string): string | null {
    const s = optional(v, label, 200);
    if (s === null) return null;
    if (!EMAIL.test(s)) throw new BadRequestException(`${label} is not a valid email address.`);
    return s.toLowerCase();
}

function website(v: unknown): string | null {
    let s = optional(v, "Website", 200);
    if (s === null) return null;
    if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
    try {
        const u = new URL(s);
        if (!u.hostname.includes(".")) throw new Error("no dot");
        return u.toString().replace(/\/$/, "");
    } catch {
        throw new BadRequestException("Website is not a valid address.");
    }
}

function timeZone(v: unknown): string | null {
    const s = optional(v, "Time zone", 64);
    if (s === null) return null;
    try {
        new Intl.DateTimeFormat("en", { timeZone: s });
    } catch {
        throw new BadRequestException("Time zone is not one we recognise (for example America/New_York).");
    }
    return s;
}

function currency(v: unknown): string | null {
    const s = optional(v, "Currency", 3);
    if (s === null) return null;
    if (!/^[A-Za-z]{3}$/.test(s)) throw new BadRequestException("Currency must be a three-letter code such as USD.");
    return s.toUpperCase();
}

function date(v: unknown): string | null {
    const s = optional(v, "Customer since", 10);
    if (s === null) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) throw new BadRequestException("Customer since must be a date.");
    return s;
}

function address(v: unknown, label: string): Address {
    if (v === null || v === undefined) return { ...EMPTY_ADDRESS };
    if (typeof v !== "object" || Array.isArray(v)) throw new BadRequestException(`${label} is not valid.`);
    const a = v as Record<string, unknown>;
    return {
        line1: optional(a.line1, `${label} line 1`, 160) ?? "",
        line2: optional(a.line2, `${label} line 2`, 160) ?? "",
        city: optional(a.city, `${label} city`, 100) ?? "",
        region: optional(a.region, `${label} state or region`, 100) ?? "",
        postalCode: optional(a.postalCode, `${label} postal code`, 20) ?? "",
        country: optional(a.country, `${label} country`, 100) ?? "",
    };
}

function contacts(v: unknown): ContactInput[] {
    if (!Array.isArray(v)) throw new BadRequestException("Contacts must be a list.");
    if (v.length > 50) throw new BadRequestException("A customer can have 50 contacts at most.");
    const out: ContactInput[] = v.map((raw, i) => {
        const c = (raw ?? {}) as Record<string, unknown>;
        const label = `Contact ${i + 1}`;
        const name = optional(c.name, `${label} name`, 120);
        if (!name) throw new BadRequestException(`${label} needs a name.`);
        const role = text(c.role) || "other";
        if (!(CONTACT_ROLES as readonly string[]).includes(role)) throw new BadRequestException(`${label} has a role we do not know.`);
        const id = text(c.id);
        return {
            ...(id ? { id } : {}),
            name,
            jobTitle: optional(c.jobTitle, `${label} job title`, 120),
            email: email(c.email, `${label} email`),
            phone: optional(c.phone, `${label} phone`, 40),
            mobile: optional(c.mobile, `${label} mobile`, 40),
            role,
            isPrimary: c.isPrimary === true,
            notes: optional(c.notes, `${label} notes`, 500),
        };
    });
    // One main contact at most: the first one marked wins.
    let seen = false;
    for (const c of out) {
        if (c.isPrimary && seen) c.isPrimary = false;
        if (c.isPrimary) seen = true;
    }
    return out;
}

function tags(v: unknown): string[] {
    if (!Array.isArray(v)) throw new BadRequestException("Tags must be a list.");
    const seen = new Set<string>();
    const out: string[] = [];
    for (const t of v) {
        const s = optional(t, "A tag", 40);
        if (!s || seen.has(s.toLowerCase())) continue;
        seen.add(s.toLowerCase());
        out.push(s);
    }
    if (out.length > 20) throw new BadRequestException("A customer can have 20 tags at most.");
    return out;
}

/** Clean what was sent. Names are checked by the caller, since they need the database. */
export function cleanProfile(body: unknown, opts: { requireName: boolean }): ProfileInput {
    if (!body || typeof body !== "object") throw new BadRequestException("Nothing was sent.");
    const b = body as Record<string, unknown>;
    const out: ProfileInput = {};

    if (has(b, "name") || opts.requireName) {
        const name = text(b.name);
        if (!name) throw new BadRequestException("Customer name is required.");
        if (name.length > 120) throw new BadRequestException("Customer name is too long (120 characters at most).");
        out.name = name;
    }
    if (has(b, "status")) {
        const s = text(b.status);
        if (!(STATUSES as readonly string[]).includes(s)) throw new BadRequestException("Status must be active, prospect or inactive.");
        out.status = s;
    }
    if (has(b, "accountNumber")) out.accountNumber = optional(b.accountNumber, "Account number", 60);
    if (has(b, "legalName")) out.legalName = optional(b.legalName, "Legal name", 160);
    if (has(b, "industry")) out.industry = optional(b.industry, "Industry", 80);
    if (has(b, "website")) out.website = website(b.website);
    if (has(b, "phone")) out.phone = optional(b.phone, "Phone", 40);
    if (has(b, "email")) out.email = email(b.email, "Email");
    if (has(b, "billingEmail")) out.billingEmail = email(b.billingEmail, "Billing email");
    if (has(b, "taxId")) out.taxId = optional(b.taxId, "Tax number", 60);
    if (has(b, "timeZone")) out.timeZone = timeZone(b.timeZone);
    if (has(b, "currency")) out.currency = currency(b.currency);
    if (has(b, "paymentTerms")) out.paymentTerms = optional(b.paymentTerms, "Payment terms", 60);
    if (has(b, "employeeCount")) {
        const raw = b.employeeCount;
        if (raw === null || raw === undefined || raw === "") out.employeeCount = null;
        else {
            const n = Number(raw);
            if (!Number.isInteger(n) || n < 0 || n > 10_000_000) throw new BadRequestException("Number of employees must be a whole number.");
            out.employeeCount = n;
        }
    }
    if (has(b, "customerSince")) out.customerSince = date(b.customerSince);
    if (has(b, "address")) out.address = address(b.address, "Address");
    if (has(b, "billingAddress")) out.billingAddress = address(b.billingAddress, "Billing address");
    if (has(b, "billingSameAsAddress")) out.billingSameAsAddress = b.billingSameAsAddress !== false;
    if (has(b, "notes")) out.notes = optional(b.notes, "Notes", 4000);
    if (has(b, "tags")) out.tags = tags(b.tags);
    if (has(b, "contacts")) out.contacts = contacts(b.contacts);
    if (has(b, "customFields")) {
        const cf = b.customFields;
        if (!cf || typeof cf !== "object" || Array.isArray(cf)) throw new BadRequestException("Custom fields must be sent as a set of values.");
        out.customFields = cf as Record<string, unknown>;
    }
    if (has(b, "version")) out.version = version(b.version);
    return out;
}

function version(v: unknown): string | undefined {
    if (v === null || v === undefined || v === "") return undefined;
    const s = String(v);
    if (Number.isNaN(Date.parse(s))) throw new BadRequestException("The version is not valid. Reload and try again.");
    return s;
}

/** Clean a site's details. Names are checked by the caller. */
export function cleanSite(body: unknown, opts: { requireName: boolean }): SiteInput {
    if (!body || typeof body !== "object") throw new BadRequestException("Nothing was sent.");
    const b = body as Record<string, unknown>;
    const out: SiteInput = {};
    if (has(b, "name") || opts.requireName) {
        const name = text(b.name);
        if (!name) throw new BadRequestException("Site name is required.");
        if (name.length > 120) throw new BadRequestException("Site name is too long (120 characters at most).");
        out.name = name;
    }
    if (has(b, "address")) out.address = address(b.address, "Address");
    if (has(b, "phone")) out.phone = optional(b.phone, "Phone", 40);
    if (has(b, "email")) out.email = email(b.email, "Email");
    if (has(b, "contactName")) out.contactName = optional(b.contactName, "Contact name", 120);
    if (has(b, "contactEmail")) out.contactEmail = email(b.contactEmail, "Contact email");
    if (has(b, "contactPhone")) out.contactPhone = optional(b.contactPhone, "Contact phone", 40);
    if (has(b, "timeZone")) out.timeZone = timeZone(b.timeZone);
    if (has(b, "notes")) out.notes = optional(b.notes, "Notes", 2000);
    if (has(b, "version")) out.version = version(b.version);
    return out;
}

export function siteColumns(s: SiteInput): Record<string, unknown> {
    const c: Record<string, unknown> = {};
    if (s.name !== undefined) c.name = s.name;
    if (s.address !== undefined) c.address = s.address;
    if (s.phone !== undefined) c.phone = s.phone;
    if (s.email !== undefined) c.email = s.email;
    if (s.contactName !== undefined) c.contact_name = s.contactName;
    if (s.contactEmail !== undefined) c.contact_email = s.contactEmail;
    if (s.contactPhone !== undefined) c.contact_phone = s.contactPhone;
    if (s.timeZone !== undefined) c.time_zone = s.timeZone;
    if (s.notes !== undefined) c.notes = s.notes;
    return c;
}

export function siteView(row: any) {
    const a = row.address && typeof row.address === "object" && !Array.isArray(row.address) ? row.address : {};
    return {
        id: String(row.id),
        clientId: String(row.client_id),
        name: String(row.name),
        address: { ...EMPTY_ADDRESS, ...a } as Address,
        phone: row.phone ?? null,
        email: row.email ?? null,
        contactName: row.contact_name ?? null,
        contactEmail: row.contact_email ?? null,
        contactPhone: row.contact_phone ?? null,
        timeZone: row.time_zone ?? null,
        notes: row.notes ?? null,
        updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    };
}

/** The window an updated_at falls in once the database's microseconds are cut to milliseconds. */
export function versionWindow(v: string): { gte: Date; lt: Date } {
    const t = new Date(v).getTime();
    return { gte: new Date(t), lt: new Date(t + 1) };
}

/** The columns to write for what was sent. */
export function profileColumns(p: ProfileInput): Record<string, unknown> {
    const c: Record<string, unknown> = {};
    if (p.name !== undefined) c.name = p.name;
    if (p.status !== undefined) c.status = p.status;
    if (p.accountNumber !== undefined) c.external_ref = p.accountNumber;
    if (p.legalName !== undefined) c.legal_name = p.legalName;
    if (p.industry !== undefined) c.industry = p.industry;
    if (p.website !== undefined) c.website = p.website;
    if (p.phone !== undefined) c.phone = p.phone;
    if (p.email !== undefined) c.email = p.email;
    if (p.billingEmail !== undefined) c.billing_email = p.billingEmail;
    if (p.taxId !== undefined) c.tax_id = p.taxId;
    if (p.timeZone !== undefined) c.time_zone = p.timeZone;
    if (p.currency !== undefined) c.currency = p.currency;
    if (p.paymentTerms !== undefined) c.payment_terms = p.paymentTerms;
    if (p.employeeCount !== undefined) c.employee_count = p.employeeCount;
    if (p.customerSince !== undefined) c.customer_since = p.customerSince ? new Date(`${p.customerSince}T00:00:00Z`) : null;
    if (p.address !== undefined) c.address = p.address;
    if (p.billingAddress !== undefined) c.billing_address = p.billingAddress;
    if (p.billingSameAsAddress !== undefined) c.billing_same_as_address = p.billingSameAsAddress;
    if (p.notes !== undefined) c.notes = p.notes;
    if (p.tags !== undefined) c.tags = p.tags;
    return c;
}

/** One customer as the screen wants it. */
export function profileView(row: any, contactRows: any[]) {
    const addr = (v: unknown): Address => ({ ...EMPTY_ADDRESS, ...(v && typeof v === "object" && !Array.isArray(v) ? (v as Partial<Address>) : {}) });
    return {
        id: String(row.id),
        name: String(row.name),
        status: String(row.status ?? "active"),
        accountNumber: row.external_ref ?? null,
        legalName: row.legal_name ?? null,
        industry: row.industry ?? null,
        website: row.website ?? null,
        phone: row.phone ?? null,
        email: row.email ?? null,
        billingEmail: row.billing_email ?? null,
        taxId: row.tax_id ?? null,
        timeZone: row.time_zone ?? null,
        currency: row.currency ?? null,
        paymentTerms: row.payment_terms ?? null,
        employeeCount: row.employee_count ?? null,
        customerSince: row.customer_since ? new Date(row.customer_since).toISOString().slice(0, 10) : null,
        address: addr(row.address),
        billingAddress: addr(row.billing_address),
        billingSameAsAddress: row.billing_same_as_address !== false,
        notes: row.notes ?? null,
        tags: Array.isArray(row.tags) ? row.tags : [],
        customFields: row.custom_fields && typeof row.custom_fields === "object" && !Array.isArray(row.custom_fields) ? (row.custom_fields as Record<string, unknown>) : {},
        archived: !!row.archived_at,
        archivedAt: row.archived_at ? new Date(row.archived_at).toISOString() : null,
        createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
        updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
        contacts: contactRows.map((c) => ({
            id: String(c.id),
            name: String(c.name),
            jobTitle: c.job_title ?? null,
            email: c.email ?? null,
            phone: c.phone ?? null,
            mobile: c.mobile ?? null,
            role: String(c.role ?? "other"),
            isPrimary: c.is_primary === true,
            notes: c.notes ?? null,
        })),
    };
}
