"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { jfetch } from "@/lib/api";
import { AddressFields, Field } from "@/components/customers/customer-form";

type Address = { line1: string; line2: string; city: string; region: string; postalCode: string; country: string };
type SiteForm = { name: string; address: Address; phone: string; email: string; contactName: string; contactEmail: string; contactPhone: string; timeZone: string; notes: string };

const blank = (): SiteForm => ({ name: "", address: { line1: "", line2: "", city: "", region: "", postalCode: "", country: "" }, phone: "", email: "", contactName: "", contactEmail: "", contactPhone: "", timeZone: "", notes: "" });
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const selectClass = "h-10 w-full rounded-md border border-input bg-background px-2 text-sm";
const bad = "border-destructive focus-visible:ring-destructive";

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

const timeZones = (): string[] => {
    try {
        return (Intl as any).supportedValuesOf("timeZone") as string[];
    } catch {
        return ["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "Europe/London", "UTC"];
    }
};

export function SiteFormDialog({ open, onOpenChange, onSaved }: { open: boolean; onOpenChange: (open: boolean) => void; onSaved: (site: { id: string; name: string }) => void }) {
    const [customers, setCustomers] = React.useState<{ key: string; name: string }[]>([]);
    const [clientId, setClientId] = React.useState("");
    const [sites, setSites] = React.useState<{ key: string; name: string }[]>([]);
    const [siteId, setSiteId] = React.useState("");
    const [form, setForm] = React.useState<SiteForm>(blank);
    const [version, setVersion] = React.useState("");
    const [loading, setLoading] = React.useState(false);
    const [saving, setSaving] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const [tried, setTried] = React.useState(false);
    const zones = React.useMemo(timeZones, []);

    React.useEffect(() => {
        if (!open) return;
        setError(null);
        setTried(false);
        setForm(blank());
        setSiteId("");
        jfetch<{ key: string; name: string }[]>("/api/customers")
            .then((rows) => {
                setCustomers(rows);
                setClientId((cur) => cur || rows[0]?.key || "");
            })
            .catch((e) => setError(message(e)));
    }, [open]);

    React.useEffect(() => {
        if (!open || !clientId) { setSites([]); setSiteId(""); return; }
        let stale = false;
        jfetch<{ key: string; name: string }[]>(`/api/customers/${encodeURIComponent(clientId)}/sites`)
            .then((rows) => { if (!stale) { setSites(rows); setSiteId(rows[0]?.key ?? ""); } })
            .catch((e) => !stale && setError(message(e)));
        return () => { stale = true; };
    }, [open, clientId]);

    React.useEffect(() => {
        if (!open || !clientId || !siteId) { setForm(blank()); return; }
        let stale = false;
        setLoading(true);
        setError(null);
        jfetch<any>(`/api/customers/${encodeURIComponent(clientId)}/sites/${encodeURIComponent(siteId)}`)
            .then((s) => {
                if (stale) return;
                const t = (v: unknown) => (v === null || v === undefined ? "" : String(v));
                setForm({ name: t(s.name), address: { ...blank().address, ...(s.address ?? {}) }, phone: t(s.phone), email: t(s.email), contactName: t(s.contactName), contactEmail: t(s.contactEmail), contactPhone: t(s.contactPhone), timeZone: t(s.timeZone), notes: t(s.notes) });
                setVersion(t(s.updatedAt));
            })
            .catch((e) => !stale && setError(message(e)))
            .finally(() => !stale && setLoading(false));
        return () => { stale = true; };
    }, [open, clientId, siteId]);

    const set = <K extends keyof SiteForm>(k: K, v: SiteForm[K]) => setForm((f) => ({ ...f, [k]: v }));
    const problems = {
        name: !form.name.trim() ? "Required" : undefined,
        email: form.email.trim() && !EMAIL.test(form.email.trim()) ? "Not a valid email" : undefined,
        contactEmail: form.contactEmail.trim() && !EMAIL.test(form.contactEmail.trim()) ? "Not a valid email" : undefined,
    };
    const shown = (k: keyof typeof problems) => (tried ? problems[k] : undefined);

    const submit = async (event: React.FormEvent) => {
        event.preventDefault();
        setTried(true);
        if (problems.name || problems.email || problems.contactEmail) {
            setError("Some details need fixing. They are marked in red.");
            return;
        }
        setSaving(true);
        setError(null);
        try {
            const saved = await jfetch<{ id: string; name: string }>(`/api/customers/${encodeURIComponent(clientId)}/sites/${encodeURIComponent(siteId)}`, { method: "PATCH", body: { ...form, name: form.name.trim(), version } });
            onSaved(saved);
            onOpenChange(false);
        } catch (e) {
            setError(message(e));
        } finally {
            setSaving(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={(o) => !saving && onOpenChange(o)}>
            <DialogContent className="flex max-h-[90vh] flex-col gap-0 p-0 sm:max-w-3xl">
                <form onSubmit={submit} noValidate className="flex min-h-0 flex-1 flex-col">
                    <DialogHeader className="border-b px-6 py-4">
                        <DialogTitle>Edit site</DialogTitle>
                        <DialogDescription>A site&apos;s address, phone and who to contact there.</DialogDescription>
                        <div className="grid gap-3 pt-2 sm:grid-cols-2">
                            <div className="grid gap-1">
                                <Label htmlFor="sf-customer">Customer</Label>
                                <select id="sf-customer" className={selectClass} value={clientId} disabled={saving} onChange={(e) => setClientId(e.target.value)}>
                                    {customers.map((c) => <option key={c.key} value={c.key}>{c.name}</option>)}
                                </select>
                            </div>
                            <div className="grid gap-1">
                                <Label htmlFor="sf-site">Site</Label>
                                <select id="sf-site" className={selectClass} value={siteId} disabled={saving || sites.length === 0} onChange={(e) => setSiteId(e.target.value)}>
                                    {sites.length === 0 && <option value="">This customer has no sites</option>}
                                    {sites.map((s) => <option key={s.key} value={s.key}>{s.name}</option>)}
                                </select>
                            </div>
                        </div>
                    </DialogHeader>

                    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4" aria-busy={loading}>
                        {!siteId ? (
                            <p className="text-sm text-muted-foreground">Choose a customer with at least one site.</p>
                        ) : loading ? (
                            <p className="text-sm text-muted-foreground">Loading...</p>
                        ) : (
                            <div className="grid gap-x-4 sm:grid-cols-2">
                                <Field label="Site name *" htmlFor="sf-name" error={shown("name")} className="sm:col-span-2">
                                    <Input id="sf-name" aria-invalid={!!shown("name")} className={shown("name") ? bad : ""} value={form.name} maxLength={120} onChange={(e) => set("name", e.target.value)} />
                                </Field>
                                <Field label="Phone" htmlFor="sf-phone">
                                    <Input id="sf-phone" type="tel" value={form.phone} maxLength={40} onChange={(e) => set("phone", e.target.value)} />
                                </Field>
                                <Field label="Email" htmlFor="sf-email" error={shown("email")}>
                                    <Input id="sf-email" type="email" aria-invalid={!!shown("email")} className={shown("email") ? bad : ""} value={form.email} onChange={(e) => set("email", e.target.value)} />
                                </Field>
                                <h3 className="pb-2 text-sm font-semibold sm:col-span-2">Address</h3>
                                <AddressFields prefix="sf-addr" value={form.address} onChange={(k, v) => setForm((f) => ({ ...f, address: { ...f.address, [k]: v } }))} />
                                <h3 className="pb-2 text-sm font-semibold sm:col-span-2">Who to contact at this site</h3>
                                <Field label="Name" htmlFor="sf-cname">
                                    <Input id="sf-cname" value={form.contactName} maxLength={120} onChange={(e) => set("contactName", e.target.value)} />
                                </Field>
                                <Field label="Phone" htmlFor="sf-cphone">
                                    <Input id="sf-cphone" type="tel" value={form.contactPhone} maxLength={40} onChange={(e) => set("contactPhone", e.target.value)} />
                                </Field>
                                <Field label="Email" htmlFor="sf-cemail" error={shown("contactEmail")}>
                                    <Input id="sf-cemail" type="email" aria-invalid={!!shown("contactEmail")} className={shown("contactEmail") ? bad : ""} value={form.contactEmail} onChange={(e) => set("contactEmail", e.target.value)} />
                                </Field>
                                <Field label="Time zone" htmlFor="sf-tz" hint="If different from the customer's">
                                    <select id="sf-tz" className={selectClass} value={form.timeZone} onChange={(e) => set("timeZone", e.target.value)}>
                                        <option value="">Not set</option>
                                        {form.timeZone && !zones.includes(form.timeZone) && <option value={form.timeZone}>{form.timeZone}</option>}
                                        {zones.map((z) => <option key={z} value={z}>{z}</option>)}
                                    </select>
                                </Field>
                                <Field label="Notes" htmlFor="sf-notes" className="sm:col-span-2" hint="Parking, access, anything worth remembering">
                                    <Textarea id="sf-notes" rows={3} maxLength={2000} value={form.notes} onChange={(e) => set("notes", e.target.value)} />
                                </Field>
                            </div>
                        )}
                    </div>

                    <DialogFooter className="items-center gap-2 border-t px-6 py-3 sm:justify-between">
                        <p role="alert" className="min-h-5 text-sm text-destructive">{error ?? ""}</p>
                        <div className="flex gap-2">
                            <Button type="button" variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>Cancel</Button>
                            <Button type="submit" variant="success" disabled={saving || loading || !siteId}>{saving ? "Saving..." : "Save changes"}</Button>
                        </div>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
