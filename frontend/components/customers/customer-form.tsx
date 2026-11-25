"use client";

import * as React from "react";
import { Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { apiUrl, jfetch } from "@/lib/api";

/* ------------------------------ what a customer is ------------------------------ */

type Address = { line1: string; line2: string; city: string; region: string; postalCode: string; country: string };
type Contact = { id?: string; name: string; jobTitle: string; email: string; phone: string; mobile: string; role: string; isPrimary: boolean; notes: string };
type Form = {
    name: string; status: string; accountNumber: string; legalName: string; industry: string; website: string; phone: string; email: string;
    billingEmail: string; taxId: string; timeZone: string; currency: string; paymentTerms: string; employeeCount: string; customerSince: string;
    address: Address; billingAddress: Address; billingSameAsAddress: boolean; notes: string; tags: string; contacts: Contact[];
};
/** A field the organization defines for its customers (Administration > Custom Fields). */
export type CustomFieldDef = { id: string; key: string; label: string; type: "text" | "longtext" | "number" | "date" | "dropdown" | "checkbox" | "url"; options: string[]; required: boolean; help: string; active: boolean };
type CustomValues = Record<string, string | boolean>;
type Look = { primaryColor: string | null; logoFile: string | null; logoUrl: string | null; coverText: string | null; footerText: string | null };
type Branding = { color: string; cover: string; footer: string; logoUrl: string | null; hadLogo: boolean; newLogo: File | null; removeLogo: boolean };

const blankAddress = (): Address => ({ line1: "", line2: "", city: "", region: "", postalCode: "", country: "" });
const blankContact = (primary = false): Contact => ({ name: "", jobTitle: "", email: "", phone: "", mobile: "", role: primary ? "primary" : "other", isPrimary: primary, notes: "" });
const blankForm = (): Form => ({
    name: "", status: "active", accountNumber: "", legalName: "", industry: "", website: "", phone: "", email: "", billingEmail: "", taxId: "",
    timeZone: "", currency: "", paymentTerms: "", employeeCount: "", customerSince: "", address: blankAddress(), billingAddress: blankAddress(),
    billingSameAsAddress: true, notes: "", tags: "", contacts: [],
});
const blankBranding = (): Branding => ({ color: "", cover: "", footer: "", logoUrl: null, hadLogo: false, newLogo: null, removeLogo: false });

const STATUS = [["active", "Active"], ["prospect", "Prospect"], ["inactive", "Inactive"]] as const;
const ROLES = [["primary", "Main contact"], ["billing", "Billing"], ["technical", "Technical"], ["owner", "Owner"], ["other", "Other"]] as const;
const TERMS = ["Due on receipt", "Net 15", "Net 30", "Net 45", "Net 60"];
const CURRENCIES = ["USD", "CAD", "EUR", "GBP", "AUD", "NZD", "CHF", "JPY", "MXN", "INR"];
const INDUSTRIES = ["Accounting", "Construction", "Dental", "Education", "Finance", "Government", "Healthcare", "Hospitality", "Legal", "Manufacturing", "Non-profit", "Real estate", "Retail", "Technology", "Transportation", "Other"];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const selectClass = "h-10 w-full rounded-md border border-input bg-background px-2 text-sm";
const sections = [["general", "General"], ["contact", "Contact and addresses"], ["people", "People"], ["billing", "Billing"], ["custom", "Custom fields"], ["branding", "Branding"], ["notes", "Notes"]] as const;
type Section = (typeof sections)[number][0];

const timeZones = (): string[] => {
    try {
        return (Intl as any).supportedValuesOf("timeZone") as string[];
    } catch {
        return ["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "Europe/London", "Europe/Paris", "Asia/Tokyo", "Australia/Sydney", "UTC"];
    }
};

const message = (e: unknown) => {
    if (!(e instanceof Error)) return "Something went wrong.";
    try {
        const body = JSON.parse(e.message) as { message?: string | string[] };
        const m = Array.isArray(body.message) ? body.message.join(" ") : body.message;
        if (m) return m;
    } catch {
        /* already words */
    }
    return e.message;
};

function fromProfile(p: any): Form {
    const s = (v: unknown) => (v === null || v === undefined ? "" : String(v));
    const addr = (a: any): Address => ({ ...blankAddress(), ...(a ?? {}) });
    return {
        name: s(p.name), status: s(p.status) || "active", accountNumber: s(p.accountNumber), legalName: s(p.legalName), industry: s(p.industry),
        website: s(p.website), phone: s(p.phone), email: s(p.email), billingEmail: s(p.billingEmail), taxId: s(p.taxId), timeZone: s(p.timeZone),
        currency: s(p.currency), paymentTerms: s(p.paymentTerms), employeeCount: s(p.employeeCount), customerSince: s(p.customerSince),
        address: addr(p.address), billingAddress: addr(p.billingAddress), billingSameAsAddress: p.billingSameAsAddress !== false, notes: s(p.notes),
        tags: Array.isArray(p.tags) ? p.tags.join(", ") : "",
        contacts: (p.contacts ?? []).map((c: any) => ({ id: c.id, name: s(c.name), jobTitle: s(c.jobTitle), email: s(c.email), phone: s(c.phone), mobile: s(c.mobile), role: s(c.role) || "other", isPrimary: c.isPrimary === true, notes: s(c.notes) })),
    };
}

/** What was saved, as the form holds it: text for every kind of box, true or false for a checkbox. */
function customFromProfile(saved: unknown, defs: CustomFieldDef[]): CustomValues {
    const src = saved && typeof saved === "object" && !Array.isArray(saved) ? (saved as Record<string, unknown>) : {};
    const out: CustomValues = {};
    for (const d of defs) {
        const v = src[d.key];
        out[d.key] = d.type === "checkbox" ? v === true : v === undefined || v === null ? "" : String(v);
    }
    return out;
}

function toBody(f: Form, defs: CustomFieldDef[], custom: CustomValues) {
    return {
        // An empty box clears the field. Only fields that are in use are sent.
        customFields: Object.fromEntries(defs.map((d) => [d.key, d.type === "checkbox" ? custom[d.key] === true : typeof custom[d.key] === "string" ? (custom[d.key] as string).trim() : ""])),
        name: f.name.trim(), status: f.status, accountNumber: f.accountNumber, legalName: f.legalName, industry: f.industry, website: f.website, phone: f.phone,
        email: f.email, billingEmail: f.billingEmail, taxId: f.taxId, timeZone: f.timeZone, currency: f.currency, paymentTerms: f.paymentTerms,
        employeeCount: f.employeeCount.trim() === "" ? null : Number(f.employeeCount), customerSince: f.customerSince,
        address: f.address, billingAddress: f.billingSameAsAddress ? blankAddress() : f.billingAddress, billingSameAsAddress: f.billingSameAsAddress,
        notes: f.notes, tags: f.tags.split(",").map((t) => t.trim()).filter(Boolean),
        contacts: f.contacts.map((c) => ({ ...c, name: c.name.trim() })),
    };
}

/** Which fields are wrong, by name, so they can be marked in red. The key is the field; the section says where to look. */
function problems(f: Form, defs: CustomFieldDef[], custom: CustomValues): Record<string, { section: Section; text: string }> {
    const p: Record<string, { section: Section; text: string }> = {};
    for (const d of defs) {
        const v = custom[d.key];
        if (d.required && (d.type === "checkbox" ? v !== true : typeof v !== "string" || !v.trim())) p[`cf.${d.key}`] = { section: "custom", text: d.type === "checkbox" ? "Must be checked" : "Required" };
        else if (d.type === "number" && typeof v === "string" && v.trim() && !Number.isFinite(Number(v.trim().replace(/,/g, "")))) p[`cf.${d.key}`] = { section: "custom", text: "Must be a number" };
    }
    if (!f.name.trim()) p.name = { section: "general", text: "Required" };
    if (f.email.trim() && !EMAIL.test(f.email.trim())) p.email = { section: "contact", text: "Not a valid email" };
    if (f.billingEmail.trim() && !EMAIL.test(f.billingEmail.trim())) p.billingEmail = { section: "billing", text: "Not a valid email" };
    if (f.employeeCount.trim() && (!/^\d+$/.test(f.employeeCount.trim()))) p.employeeCount = { section: "general", text: "Whole number" };
    if (f.currency.trim() && !/^[A-Za-z]{3}$/.test(f.currency.trim())) p.currency = { section: "billing", text: "Three letters" };
    f.contacts.forEach((c, i) => {
        if (!c.name.trim()) p[`contact.${i}.name`] = { section: "people", text: "Required" };
        if (c.email.trim() && !EMAIL.test(c.email.trim())) p[`contact.${i}.email`] = { section: "people", text: "Not a valid email" };
    });
    return p;
}

/* A label, a field, and a line under it that is always there, so a message never pushes the next field down. */
export function Field({ label, htmlFor, error, hint, className, children }: { label: string; htmlFor: string; error?: string; hint?: string; className?: string; children: React.ReactNode }) {
    return (
        <div className={cn("grid gap-1", className)}>
            <Label htmlFor={htmlFor} className={error ? "text-destructive" : undefined}>{label}</Label>
            {children}
            <p className={cn("min-h-4 text-xs", error ? "text-destructive" : "text-muted-foreground")}>{error ?? hint ?? ""}</p>
        </div>
    );
}

const bad = (error?: string) => (error ? "border-destructive focus-visible:ring-destructive" : "");

/* ------------------------------ the form ------------------------------ */

export type CustomerFormProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    mode: "create" | "edit";
    /** The customers that can be edited, and the one to start on. */
    customers?: { id: string; name: string }[];
    customerId?: string;
    onSaved: (saved: { id: string; name: string; /** People on a new customer who were invited to the client portal. */ portalInvites?: { invited: number; failed: number } }, created: boolean) => void;
};

export function CustomerForm({ open, onOpenChange, mode, customers = [], customerId, onSaved }: CustomerFormProps) {
    const [id, setId] = React.useState(customerId ?? "");
    // The version of the record that was opened. Saving sends it back, so a save over someone else's is refused.
    const [version, setVersion] = React.useState("");
    const [archived, setArchived] = React.useState(false);
    const [list, setList] = React.useState<{ id: string; name: string; archived?: boolean }[]>(customers);
    const [form, setForm] = React.useState<Form>(blankForm);
    const [defs, setDefs] = React.useState<CustomFieldDef[]>([]);
    const [custom, setCustom] = React.useState<CustomValues>({});
    // What the customer has saved, kept until the fields have loaded and the boxes can be filled.
    const [savedCustom, setSavedCustom] = React.useState<unknown>({});
    React.useEffect(() => {
        setCustom(customFromProfile(savedCustom, defs));
    }, [savedCustom, defs]);
    const [branding, setBranding] = React.useState<Branding>(blankBranding);
    const [section, setSection] = React.useState<Section>("general");
    const [loading, setLoading] = React.useState(false);
    const [saving, setSaving] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const [tried, setTried] = React.useState(false);
    const zones = React.useMemo(timeZones, []);

    // The custom fields in use.
    React.useEffect(() => {
        if (!open) return;
        let stale = false;
        jfetch<{ items: CustomFieldDef[] }>("/api/custom-fields")
            .then((r) => !stale && setDefs(r.items.filter((d) => d.active)))
            .catch(() => !stale && setDefs([]));
        return () => { stale = true; };
    }, [open]);

    // Start fresh each time the dialog opens.
    React.useEffect(() => {
        if (!open) return;
        setSection("general");
        setCustom({});
        setSavedCustom({});
        setError(null);
        setTried(false);
        setForm(blankForm());
        setBranding(blankBranding());
        setVersion("");
        setArchived(false);
        if (mode !== "edit") {
            setId("");
            return;
        }
        // Archived customers are in this list too, so they can be found and restored.
        let stale = false;
        jfetch<{ key: string; name: string; archived?: boolean }[]>("/api/customers?archived=true")
            .then((rows) => {
                if (stale) return;
                const mapped = rows.map((r) => ({ id: r.key, name: r.name, archived: r.archived }));
                setList(mapped);
                setId(customerId || mapped.find((m) => !m.archived)?.id || mapped[0]?.id || "");
            })
            .catch(() => {
                if (stale) return;
                setList(customers);
                setId(customerId || customers[0]?.id || "");
            });
        return () => { stale = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, mode, customerId]);

    // Load the chosen customer.
    React.useEffect(() => {
        if (!open || mode !== "edit" || !id) return;
        let stale = false;
        setLoading(true);
        setError(null);
        Promise.all([
            jfetch<any>(`/api/customers/${encodeURIComponent(id)}`),
            jfetch<Look>(`/api/reports/branding/${encodeURIComponent(id)}`).catch(() => null),
        ])
            .then(([profile, look]) => {
                if (stale) return;
                setForm(fromProfile(profile));
                setSavedCustom(profile.customFields ?? {});
                setVersion(String(profile.updatedAt ?? ""));
                setArchived(profile.archived === true);
                setBranding({ color: look?.primaryColor ?? "", cover: look?.coverText ?? "", footer: look?.footerText ?? "", logoUrl: look?.logoUrl ?? null, hadLogo: !!look?.logoFile, newLogo: null, removeLogo: false });
            })
            .catch((e) => !stale && setError(message(e)))
            .finally(() => !stale && setLoading(false));
        return () => { stale = true; };
    }, [open, mode, id]);

    const errors = React.useMemo(() => (tried ? problems(form, defs, custom) : {}), [form, defs, custom, tried]);
    const sectionHasError = (s: Section) => Object.values(errors).some((e) => e.section === s);
    const colorBad = branding.color.trim() !== "" && !/^#[0-9a-f]{6}$/i.test(branding.color.trim());
    const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value }));
    const setAddr = (which: "address" | "billingAddress", key: keyof Address, value: string) => setForm((f) => ({ ...f, [which]: { ...f[which], [key]: value } }));
    const setContact = (i: number, patch: Partial<Contact>) =>
        setForm((f) => ({ ...f, contacts: f.contacts.map((c, j) => (j === i ? { ...c, ...patch } : patch.isPrimary ? { ...c, isPrimary: false } : c)) }));

    const submit = async (event: React.FormEvent) => {
        event.preventDefault();
        setTried(true);
        const found = problems(form, defs, custom);
        const keys = Object.keys(found);
        if (keys.length || colorBad) {
            const first = keys[0] ? found[keys[0]].section : "branding";
            setSection(first);
            setError("Some details need fixing. They are marked in red.");
            return;
        }
        setSaving(true);
        setError(null);
        let saved: { id: string; name: string; portalInvites?: { invited: number; failed: number } };
        try {
            saved = mode === "create"
                ? await jfetch<{ id: string; name: string; portalInvites?: { invited: number; failed: number } }>("/api/customers", { method: "POST", body: toBody(form, defs, custom) })
                : await jfetch<{ id: string; name: string }>(`/api/customers/${encodeURIComponent(id)}`, { method: "PATCH", body: { ...toBody(form, defs, custom), version } });
        } catch (e) {
            setSaving(false);
            setError(message(e));
            return;
        }

        // The customer is saved. Branding is a separate record, so a failure here is reported without losing the rest.
        try {
            const changed = branding.color !== "" || branding.cover !== "" || branding.footer !== "" || mode === "edit";
            if (changed) {
                await jfetch(`/api/reports/branding/${saved.id}`, { method: "PUT", body: { primaryColor: branding.color.trim(), coverText: branding.cover.trim(), footerText: branding.footer.trim() } });
            }
            if (branding.removeLogo && branding.hadLogo && !branding.newLogo) {
                await jfetch(`/api/reports/branding/${saved.id}/logo`, { method: "DELETE" });
            }
            if (branding.newLogo) {
                const data = new FormData();
                data.append("file", branding.newLogo);
                const res = await fetch(apiUrl(`/api/reports/branding/${saved.id}/logo`), { method: "POST", body: data, credentials: "include" });
                if (!res.ok) throw new Error(await res.text());
            }
        } catch (e) {
            setSaving(false);
            onSaved(saved, mode === "create");
            setError(`The customer was saved, but the branding was not: ${message(e)}`);
            setSection("branding");
            return;
        }
        setSaving(false);
        onSaved(saved, mode === "create");
        onOpenChange(false);
    };

    const e = (k: string) => errors[k]?.text;

    const setArchive = async (archive: boolean) => {
        const label = form.name.trim() || "this customer";
        if (archive && !window.confirm(`Archive ${label}? It disappears from the customer lists and pickers. Its devices, tickets and history are kept, and you can restore it here at any time.`)) return;
        setSaving(true);
        setError(null);
        try {
            const done = await jfetch<{ id: string; name: string }>(`/api/customers/${encodeURIComponent(id)}/${archive ? "archive" : "restore"}`, { method: "POST" });
            onSaved(done, false);
            onOpenChange(false);
        } catch (err) {
            setError(message(err));
        } finally {
            setSaving(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={(o) => !saving && onOpenChange(o)}>
            <DialogContent className="flex max-h-[90vh] flex-col gap-0 p-0 sm:max-w-4xl">
                <form onSubmit={submit} noValidate className="flex min-h-0 flex-1 flex-col">
                    <DialogHeader className="border-b px-6 py-4">
                        <DialogTitle>{mode === "create" ? "New customer" : "Edit customer"}</DialogTitle>
                        <DialogDescription>
                            {mode === "create" ? "Everything you know about the customer. Only the name is required; you can fill in the rest later." : "Change anything about this customer."}
                        </DialogDescription>
                        {mode === "edit" && (
                            <div className="grid gap-1 pt-2 sm:max-w-sm">
                                <Label htmlFor="cf-pick">Customer</Label>
                                <select id="cf-pick" className={selectClass} value={id} disabled={saving} onChange={(ev) => setId(ev.target.value)}>
                                    {list.map((c) => <option key={c.id} value={c.id}>{c.archived ? `${c.name} (archived)` : c.name}</option>)}
                                </select>
                            </div>
                        )}
                    </DialogHeader>

                    <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
                        <nav aria-label="Customer details" className="flex shrink-0 gap-1 overflow-x-auto border-b p-2 sm:w-52 sm:flex-col sm:border-b-0 sm:border-r">
                            {sections.filter(([key]) => key !== "custom" || defs.length > 0).map(([key, label]) => (
                                <button
                                    key={key}
                                    type="button"
                                    aria-current={section === key ? "page" : undefined}
                                    onClick={() => setSection(key)}
                                    className={cn("flex items-center justify-between gap-2 whitespace-nowrap rounded-md px-3 py-2 text-left text-sm", section === key ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted/50")}
                                >
                                    {label}
                                    {(sectionHasError(key) || (key === "branding" && tried && colorBad)) && <span aria-label="Needs attention" className="h-2 w-2 rounded-full bg-destructive" />}
                                </button>
                            ))}
                        </nav>

                        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4" aria-busy={loading}>
                            {loading ? (
                                <p className="text-sm text-muted-foreground">Loading...</p>
                            ) : (
                                <>
                                    {section === "general" && (
                                        <div className="grid gap-x-4 sm:grid-cols-2">
                                            <Field label="Customer name *" htmlFor="cf-name" error={e("name")} className="sm:col-span-2">
                                                <Input id="cf-name" aria-invalid={!!e("name")} className={bad(e("name"))} value={form.name} maxLength={120} autoFocus={mode === "create"} onChange={(ev) => set("name", ev.target.value)} placeholder="Harbor Dental" />
                                            </Field>
                                            <Field label="Legal name" htmlFor="cf-legal" hint="As on contracts and invoices">
                                                <Input id="cf-legal" value={form.legalName} maxLength={160} onChange={(ev) => set("legalName", ev.target.value)} placeholder="Harbor Dental Group LLC" />
                                            </Field>
                                            <Field label="Account number" htmlFor="cf-acct" hint="Your own reference">
                                                <Input id="cf-acct" value={form.accountNumber} maxLength={60} onChange={(ev) => set("accountNumber", ev.target.value)} />
                                            </Field>
                                            <Field label="Status" htmlFor="cf-status">
                                                <select id="cf-status" className={selectClass} value={form.status} onChange={(ev) => set("status", ev.target.value)}>
                                                    {STATUS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                                                </select>
                                            </Field>
                                            <Field label="Industry" htmlFor="cf-industry">
                                                <Input id="cf-industry" list="cf-industries" value={form.industry} maxLength={80} onChange={(ev) => set("industry", ev.target.value)} />
                                                <datalist id="cf-industries">{INDUSTRIES.map((i) => <option key={i} value={i} />)}</datalist>
                                            </Field>
                                            <Field label="Number of employees" htmlFor="cf-emps" error={e("employeeCount")}>
                                                <Input id="cf-emps" inputMode="numeric" aria-invalid={!!e("employeeCount")} className={bad(e("employeeCount"))} value={form.employeeCount} onChange={(ev) => set("employeeCount", ev.target.value)} />
                                            </Field>
                                            <Field label="Customer since" htmlFor="cf-since">
                                                <Input id="cf-since" type="date" value={form.customerSince} onChange={(ev) => set("customerSince", ev.target.value)} />
                                            </Field>
                                            <Field label="Time zone" htmlFor="cf-tz" hint="Used for their reports and business hours" className="sm:col-span-2">
                                                <select id="cf-tz" className={selectClass} value={form.timeZone} onChange={(ev) => set("timeZone", ev.target.value)}>
                                                    <option value="">Not set</option>
                                                    {form.timeZone && !zones.includes(form.timeZone) && <option value={form.timeZone}>{form.timeZone}</option>}
                                                    {zones.map((z) => <option key={z} value={z}>{z}</option>)}
                                                </select>
                                            </Field>
                                            <Field label="Tags" htmlFor="cf-tags" hint="Separate with commas, for example VIP, managed services" className="sm:col-span-2">
                                                <Input id="cf-tags" value={form.tags} onChange={(ev) => set("tags", ev.target.value)} />
                                            </Field>
                                        </div>
                                    )}

                                    {section === "contact" && (
                                        <div className="grid gap-x-4 sm:grid-cols-2">
                                            <Field label="Main phone" htmlFor="cf-phone">
                                                <Input id="cf-phone" type="tel" value={form.phone} maxLength={40} onChange={(ev) => set("phone", ev.target.value)} />
                                            </Field>
                                            <Field label="Main email" htmlFor="cf-email" error={e("email")}>
                                                <Input id="cf-email" type="email" aria-invalid={!!e("email")} className={bad(e("email"))} value={form.email} onChange={(ev) => set("email", ev.target.value)} />
                                            </Field>
                                            <Field label="Website" htmlFor="cf-web" className="sm:col-span-2">
                                                <Input id="cf-web" value={form.website} maxLength={200} onChange={(ev) => set("website", ev.target.value)} placeholder="harbordental.com" />
                                            </Field>
                                            <h3 className="pb-2 text-sm font-semibold sm:col-span-2">Main address</h3>
                                            <AddressFields prefix="addr" value={form.address} onChange={(k, v) => setAddr("address", k, v)} />
                                        </div>
                                    )}

                                    {section === "people" && (
                                        <div className="grid gap-4">
                                            <p className="text-sm text-muted-foreground">The people to call, who gets the invoice and who looks after the technology. Mark one as the main contact.</p>
                                            {form.contacts.length === 0 && <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">No people added yet.</p>}
                                            {form.contacts.map((c, i) => (
                                                <fieldset key={c.id ?? `new-${i}`} className="grid gap-x-4 rounded-md border p-3 sm:grid-cols-3">
                                                    <legend className="px-1 text-sm font-medium">{c.name.trim() || `Person ${i + 1}`}</legend>
                                                    <Field label="Name *" htmlFor={`cf-c${i}-name`} error={e(`contact.${i}.name`)}>
                                                        <Input id={`cf-c${i}-name`} aria-invalid={!!e(`contact.${i}.name`)} className={bad(e(`contact.${i}.name`))} value={c.name} maxLength={120} onChange={(ev) => setContact(i, { name: ev.target.value })} />
                                                    </Field>
                                                    <Field label="Job title" htmlFor={`cf-c${i}-title`}>
                                                        <Input id={`cf-c${i}-title`} value={c.jobTitle} maxLength={120} onChange={(ev) => setContact(i, { jobTitle: ev.target.value })} />
                                                    </Field>
                                                    <Field label="Role" htmlFor={`cf-c${i}-role`}>
                                                        <select id={`cf-c${i}-role`} className={selectClass} value={c.role} onChange={(ev) => setContact(i, { role: ev.target.value })}>
                                                            {ROLES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                                                        </select>
                                                    </Field>
                                                    <Field label="Email" htmlFor={`cf-c${i}-email`} error={e(`contact.${i}.email`)}>
                                                        <Input id={`cf-c${i}-email`} type="email" aria-invalid={!!e(`contact.${i}.email`)} className={bad(e(`contact.${i}.email`))} value={c.email} onChange={(ev) => setContact(i, { email: ev.target.value })} />
                                                    </Field>
                                                    <Field label="Phone" htmlFor={`cf-c${i}-phone`}>
                                                        <Input id={`cf-c${i}-phone`} type="tel" value={c.phone} maxLength={40} onChange={(ev) => setContact(i, { phone: ev.target.value })} />
                                                    </Field>
                                                    <Field label="Mobile" htmlFor={`cf-c${i}-mobile`}>
                                                        <Input id={`cf-c${i}-mobile`} type="tel" value={c.mobile} maxLength={40} onChange={(ev) => setContact(i, { mobile: ev.target.value })} />
                                                    </Field>
                                                    <div className="flex items-center justify-between gap-2 sm:col-span-3">
                                                        <label className="flex items-center gap-2 text-sm">
                                                            <input type="checkbox" checked={c.isPrimary} onChange={(ev) => setContact(i, { isPrimary: ev.target.checked })} />
                                                            Main contact
                                                        </label>
                                                        {c.id ? (
                                                            <a href={`/tickets?contactId=${encodeURIComponent(c.id)}&contactName=${encodeURIComponent(c.name.trim() || "this contact")}`} className="text-sm text-primary hover:underline" title="Every ticket this person asked for">
                                                                Their tickets
                                                            </a>
                                                        ) : null}
                                                        <Button type="button" variant="ghost" size="sm" onClick={() => setForm((f) => ({ ...f, contacts: f.contacts.filter((_, j) => j !== i) }))}>
                                                            <Trash2 className="mr-1 h-4 w-4" aria-hidden /> Remove
                                                        </Button>
                                                    </div>
                                                </fieldset>
                                            ))}
                                            <div>
                                                <Button type="button" variant="outline" size="sm" onClick={() => setForm((f) => ({ ...f, contacts: [...f.contacts, blankContact(f.contacts.length === 0)] }))}>
                                                    <Plus className="mr-1 h-4 w-4" aria-hidden /> Add a person
                                                </Button>
                                            </div>
                                        </div>
                                    )}

                                    {section === "billing" && (
                                        <div className="grid gap-x-4 sm:grid-cols-2">
                                            <Field label="Billing email" htmlFor="cf-bemail" error={e("billingEmail")} hint="Invoices are sent here">
                                                <Input id="cf-bemail" type="email" aria-invalid={!!e("billingEmail")} className={bad(e("billingEmail"))} value={form.billingEmail} onChange={(ev) => set("billingEmail", ev.target.value)} />
                                            </Field>
                                            <Field label="Tax or VAT number" htmlFor="cf-tax">
                                                <Input id="cf-tax" value={form.taxId} maxLength={60} onChange={(ev) => set("taxId", ev.target.value)} />
                                            </Field>
                                            <Field label="Payment terms" htmlFor="cf-terms">
                                                <select id="cf-terms" className={selectClass} value={form.paymentTerms} onChange={(ev) => set("paymentTerms", ev.target.value)}>
                                                    <option value="">Not set</option>
                                                    {form.paymentTerms && !TERMS.includes(form.paymentTerms) && <option value={form.paymentTerms}>{form.paymentTerms}</option>}
                                                    {TERMS.map((t) => <option key={t} value={t}>{t}</option>)}
                                                </select>
                                            </Field>
                                            <Field label="Currency" htmlFor="cf-cur" error={e("currency")}>
                                                <Input id="cf-cur" list="cf-currencies" aria-invalid={!!e("currency")} className={bad(e("currency"))} value={form.currency} maxLength={3} onChange={(ev) => set("currency", ev.target.value.toUpperCase())} placeholder="USD" />
                                                <datalist id="cf-currencies">{CURRENCIES.map((c) => <option key={c} value={c} />)}</datalist>
                                            </Field>
                                            <h3 className="pb-2 text-sm font-semibold sm:col-span-2">Billing address</h3>
                                            <label className="flex items-center gap-2 pb-3 text-sm sm:col-span-2">
                                                <input type="checkbox" checked={form.billingSameAsAddress} onChange={(ev) => set("billingSameAsAddress", ev.target.checked)} />
                                                Same as the main address
                                            </label>
                                            {!form.billingSameAsAddress && <AddressFields prefix="baddr" value={form.billingAddress} onChange={(k, v) => setAddr("billingAddress", k, v)} />}
                                        </div>
                                    )}

                                    {section === "branding" && (
                                        <div className="grid gap-x-4 sm:grid-cols-2">
                                            <p className="pb-3 text-sm text-muted-foreground sm:col-span-2">How this customer&apos;s reports look: their colour and logo on the cover, a note from you, and a footer on every page. Anything left empty uses your own company&apos;s branding.</p>
                                            <Field label="Colour" htmlFor="cf-color" error={tried && colorBad ? "Use a colour like #1a73e8" : undefined}>
                                                <div className="flex items-center gap-2">
                                                    <input aria-label="Pick a colour" type="color" className="h-10 w-12 rounded border border-input bg-background" value={/^#[0-9a-f]{6}$/i.test(branding.color) ? branding.color : "#1a73e8"} onChange={(ev) => setBranding((b) => ({ ...b, color: ev.target.value }))} />
                                                    <Input id="cf-color" className={cn("w-32", bad(tried && colorBad ? "x" : undefined))} value={branding.color} maxLength={7} onChange={(ev) => setBranding((b) => ({ ...b, color: ev.target.value }))} placeholder="#1a73e8" />
                                                    {branding.color && <Button type="button" variant="ghost" size="sm" onClick={() => setBranding((b) => ({ ...b, color: "" }))}>Clear</Button>}
                                                </div>
                                            </Field>
                                            <Field label="Logo (PNG or JPEG, up to 2 MB)" htmlFor="cf-logo" hint={branding.newLogo ? `${branding.newLogo.name} will be uploaded when you save.` : undefined}>
                                                <div className="flex items-center gap-2">
                                                    {/* eslint-disable-next-line @next/next/no-img-element */}
                                                    {branding.logoUrl && !branding.removeLogo && !branding.newLogo && <img src={apiUrl(branding.logoUrl)} alt="" className="h-10 max-w-32 rounded border border-border bg-white object-contain p-1" />}
                                                    <Input id="cf-logo" type="file" accept="image/png,image/jpeg" className="min-w-0" onChange={(ev) => setBranding((b) => ({ ...b, newLogo: ev.target.files?.[0] ?? null, removeLogo: false }))} />
                                                    {branding.hadLogo && !branding.removeLogo && !branding.newLogo && <Button type="button" variant="ghost" size="sm" onClick={() => setBranding((b) => ({ ...b, removeLogo: true }))}>Remove</Button>}
                                                </div>
                                            </Field>
                                            <Field label="Note on the cover" htmlFor="cf-cover" className="sm:col-span-2">
                                                <Textarea id="cf-cover" rows={3} maxLength={1500} value={branding.cover} onChange={(ev) => setBranding((b) => ({ ...b, cover: ev.target.value }))} placeholder="Thank you for choosing us. Here is how your technology is doing." />
                                            </Field>
                                            <Field label="Footer on every page" htmlFor="cf-footer" className="sm:col-span-2">
                                                <Input id="cf-footer" maxLength={160} value={branding.footer} onChange={(ev) => setBranding((b) => ({ ...b, footer: ev.target.value }))} placeholder={`${form.name.trim() || "Customer"}, confidential`} />
                                            </Field>
                                        </div>
                                    )}

                                    {section === "custom" && (
                                        <div className="grid gap-x-4 sm:grid-cols-2">
                                            {defs.map((d) => {
                                                const id = `cfd-${d.key}`;
                                                const v = custom[d.key];
                                                const text = typeof v === "string" ? v : "";
                                                const err = e(`cf.${d.key}`);
                                                const setV = (next: string | boolean) => setCustom((c) => ({ ...c, [d.key]: next }));
                                                const wide = d.type === "longtext" ? "sm:col-span-2" : undefined;
                                                if (d.type === "checkbox") {
                                                    return (
                                                        <Field key={d.key} label={`${d.label}${d.required ? " *" : ""}`} htmlFor={id} error={err} hint={d.help} className={wide}>
                                                            <label className="flex h-10 items-center gap-2 text-sm">
                                                                <input id={id} type="checkbox" checked={v === true} onChange={(ev) => setV(ev.target.checked)} /> Yes
                                                            </label>
                                                        </Field>
                                                    );
                                                }
                                                return (
                                                    <Field key={d.key} label={`${d.label}${d.required ? " *" : ""}`} htmlFor={id} error={err} hint={d.help} className={wide}>
                                                        {d.type === "longtext" ? (
                                                            <Textarea id={id} rows={4} maxLength={4000} aria-invalid={!!err} className={bad(err)} value={text} onChange={(ev) => setV(ev.target.value)} />
                                                        ) : d.type === "dropdown" ? (
                                                            <select id={id} className={cn(selectClass, bad(err))} aria-invalid={!!err} value={text} onChange={(ev) => setV(ev.target.value)}>
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
                                                                aria-invalid={!!err}
                                                                className={bad(err)}
                                                                value={text}
                                                                placeholder={d.type === "url" ? "https://" : undefined}
                                                                onChange={(ev) => setV(ev.target.value)}
                                                            />
                                                        )}
                                                    </Field>
                                                );
                                            })}
                                        </div>
                                    )}

                                    {section === "notes" && (
                                        <Field label="Notes" htmlFor="cf-notes" hint="Only your team sees these: gate codes, history, anything worth remembering">
                                            <Textarea id="cf-notes" rows={10} maxLength={4000} value={form.notes} onChange={(ev) => set("notes", ev.target.value)} />
                                        </Field>
                                    )}
                                </>
                            )}
                        </div>
                    </div>

                    {mode === "edit" && archived && (
                        <p className="border-t bg-muted/40 px-6 py-2 text-sm">This customer is archived, so it is hidden from the lists. Restore it to bring it back.</p>
                    )}
                    <DialogFooter className="items-center gap-2 border-t px-6 py-3 sm:justify-between">
                        <p role="alert" className="min-h-5 text-sm text-destructive">{error ?? ""}</p>
                        <div className="flex gap-2">
                            {mode === "edit" && id && (
                                <Button type="button" variant="outline" disabled={saving || loading} onClick={() => void setArchive(!archived)}>
                                    {archived ? "Restore customer" : "Archive customer"}
                                </Button>
                            )}
                            <Button type="button" variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>Cancel</Button>
                            <Button type="submit" variant="success" disabled={saving || loading || (mode === "edit" && !id)}>
                                {saving ? "Saving..." : mode === "create" ? "Create customer" : "Save changes"}
                            </Button>
                        </div>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

export function AddressFields({ prefix, value, onChange }: { prefix: string; value: Address; onChange: (key: keyof Address, v: string) => void }) {
    return (
        <>
            <Field label="Street address" htmlFor={`${prefix}-1`} className="sm:col-span-2">
                <Input id={`${prefix}-1`} value={value.line1} maxLength={160} onChange={(ev) => onChange("line1", ev.target.value)} />
            </Field>
            <Field label="Suite, floor or building" htmlFor={`${prefix}-2`} className="sm:col-span-2">
                <Input id={`${prefix}-2`} value={value.line2} maxLength={160} onChange={(ev) => onChange("line2", ev.target.value)} />
            </Field>
            <Field label="City" htmlFor={`${prefix}-city`}>
                <Input id={`${prefix}-city`} value={value.city} maxLength={100} onChange={(ev) => onChange("city", ev.target.value)} />
            </Field>
            <Field label="State or region" htmlFor={`${prefix}-region`}>
                <Input id={`${prefix}-region`} value={value.region} maxLength={100} onChange={(ev) => onChange("region", ev.target.value)} />
            </Field>
            <Field label="Postal code" htmlFor={`${prefix}-zip`}>
                <Input id={`${prefix}-zip`} value={value.postalCode} maxLength={20} onChange={(ev) => onChange("postalCode", ev.target.value)} />
            </Field>
            <Field label="Country" htmlFor={`${prefix}-country`}>
                <Input id={`${prefix}-country`} value={value.country} maxLength={100} onChange={(ev) => onChange("country", ev.target.value)} />
            </Field>
        </>
    );
}
