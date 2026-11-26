"use client";

// The client portal: a separate website, on its own address, where a customer's people follow their tickets, devices and invoices.
import * as React from "react";
import { ExternalLink, Globe } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { PortalAccountsPanel } from "@/components/customers/portal-accounts-panel";
import { jfetch } from "@/lib/api";
import { CheckToggle } from "../helpers";
import type { ToastFn } from "../types";

type Settings = {
    enabled: boolean;
    domain: string | null;
    modules: string[];
    allowTicketCreate: boolean;
    welcomeTitle: string;
    welcomeText: string;
    supportEmail: string;
    supportPhone: string;
};

const AREAS: { id: string; label: string; note: string }[] = [
    { id: "dashboard", label: "Home", note: "A summary: open tickets, devices and unpaid invoices." },
    { id: "tickets", label: "Tickets", note: "Follow their tickets and reply. Private notes are never shown." },
    { id: "devices", label: "Devices", note: "Managers see the company's devices and whether they are online. Read only." },
    { id: "invoices", label: "Invoices", note: "Managers see sent invoices, download the PDF, and pay by card when online payment is set up." },
    { id: "reports", label: "Reports", note: "Managers download a quarterly review and a health summary for their company as PDFs." },
    { id: "knowledge", label: "Help articles", note: "Knowledge base articles you mark as visible to customers, with search. Everyone with a portal account can read them." },
];

const messageOf = (e: unknown) => {
    const raw = e instanceof Error ? e.message : "Something went wrong.";
    try { const j = JSON.parse(raw) as { message?: string | string[] }; return Array.isArray(j.message) ? j.message.join(" ") : j.message ?? raw; } catch { return raw; }
};

export default function ClientPortalTab({ push }: { push: ToastFn }) {
    const [saved, setSaved] = React.useState<Settings | null>(null);
    const [form, setForm] = React.useState<Settings | null>(null);
    const [busy, setBusy] = React.useState<"save" | "check" | null>(null);
    const [check, setCheck] = React.useState<{ ok: boolean; message: string } | null>(null);

    React.useEffect(() => {
        jfetch<Settings>("/api/portal-admin/settings")
            .then((s) => { setSaved(s); setForm(s); })
            .catch((e) => push({ title: "Could not load the portal settings", desc: messageOf(e), kind: "destructive" }));
    }, [push]);

    if (!form || !saved) return <div className="p-4 text-sm text-muted-foreground">Loading…</div>;

    const set = <K extends keyof Settings>(k: K, v: Settings[K]) => { setForm((f) => (f ? { ...f, [k]: v } : f)); if (k === "domain") setCheck(null); };
    const dirty = JSON.stringify(form) !== JSON.stringify(saved);
    const toggleArea = (id: string) => set("modules", form.modules.includes(id) ? form.modules.filter((m) => m !== id) : [...form.modules, id]);
    const shown = (form.domain ?? "").trim() || "portal.example.com";

    async function save() {
        if (!form) return;
        setBusy("save");
        try {
            const s = await jfetch<Settings>("/api/portal-admin/settings", { method: "PUT", body: form });
            setSaved(s);
            setForm(s);
            push({ title: "Client portal saved", kind: "success" });
        } catch (e) {
            push({ title: "Could not save", desc: messageOf(e), kind: "destructive" });
        } finally {
            setBusy(null);
        }
    }

    async function checkAddress() {
        if (!form) return;
        setBusy("check");
        setCheck(null);
        try {
            setCheck(await jfetch<{ ok: boolean; message: string }>("/api/portal-admin/settings/check", { method: "POST", body: { domain: form.domain ?? "" } }));
        } catch (e) {
            setCheck({ ok: false, message: messageOf(e) });
        } finally {
            setBusy(null);
        }
    }

    return (
        <div className="grid w-full min-w-0 gap-6">
            <div>
                <h2 className="flex items-center gap-2 text-xl font-semibold tracking-tight"><Globe className="h-5 w-5" aria-hidden /> Client portal</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                    A separate website on its own address where your customers&apos; people sign in with their own email and password to follow their tickets, devices and invoices.
                    Staff sign-ins never work there, and each person sees only their own company.
                </p>
            </div>

            <section aria-labelledby="portal-address" className="grid gap-3 rounded-xl border border-border/70 bg-card p-5 shadow-sm">
                <h3 id="portal-address" className="text-sm font-medium">Address</h3>
                <div className="grid gap-1">
                    <Label htmlFor="portal-domain" className="text-sm">Portal domain</Label>
                    <div className="flex flex-wrap gap-2">
                        <Input id="portal-domain" className="max-w-sm" value={form.domain ?? ""} onChange={(e) => set("domain", e.target.value || null)} placeholder="portal.example.com" autoComplete="off" spellCheck={false} />
                        <Button type="button" variant="outline" onClick={() => void checkAddress()} disabled={busy === "check" || !(form.domain ?? "").trim()}>{busy === "check" ? "Checking…" : "Check address"}</Button>
                    </div>
                    <p className="text-xs text-muted-foreground">Just the name, without https:// or a path. Save first, then check: the check opens the address over the internet and looks for the portal.</p>
                    {check ? <p role="status" className={`text-sm ${check.ok ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"}`}>{check.message}</p> : null}
                </div>

                <div className="rounded-md bg-muted/40 p-3 text-xs text-muted-foreground">
                    <div className="mb-1 font-medium text-foreground">Point the domain at ADG RMM (Nginx Proxy Manager)</div>
                    <ol className="list-decimal space-y-1 pl-5">
                        <li>In DNS, create a record for <code className="rounded bg-muted px-1">{shown}</code> that goes to the same place as your ADG RMM web address.</li>
                        <li>In Nginx Proxy Manager, add a <b>Proxy Host</b> with that domain name. Forward it to the <b>same address and port as your ADG RMM web app</b> (the front end, not the API).</li>
                        <li>On the SSL tab, request a Let&apos;s Encrypt certificate for it and turn on <b>Force SSL</b>. Leave <b>Websockets Support</b> off; the portal does not need it.</li>
                        <li>Do not add any custom path rules: the web app already shows only the portal on this domain and nothing else.</li>
                        <li>Save the address here, press <b>Check address</b>, then turn the portal on.</li>
                    </ol>
                </div>

                <div className="flex flex-wrap items-center gap-4 pt-1">
                    <CheckToggle label="Portal is on" checked={form.enabled} onChange={(v) => set("enabled", v)} />
                    {saved.enabled && saved.domain ? (
                        <a className="inline-flex items-center gap-1 text-sm underline" href={`https://${saved.domain}`} target="_blank" rel="noreferrer">Open the portal <ExternalLink className="h-3.5 w-3.5" aria-hidden /></a>
                    ) : null}
                </div>
                {form.enabled && !(form.domain ?? "").trim() ? <p className="text-xs text-destructive">Set the address before turning the portal on.</p> : null}
            </section>

            <section aria-labelledby="portal-areas" className="grid gap-3 rounded-xl border border-border/70 bg-card p-5 shadow-sm">
                <h3 id="portal-areas" className="text-sm font-medium">What customers can open</h3>
                <div className="grid gap-3 sm:grid-cols-2">
                    {AREAS.map((a) => (
                        <div key={a.id} className="grid gap-0.5">
                            <CheckToggle label={a.label} checked={form.modules.includes(a.id)} onChange={() => toggleArea(a.id)} />
                            <p className="pl-12 text-xs text-muted-foreground">{a.note}</p>
                        </div>
                    ))}
                </div>
                <div className="grid gap-0.5 border-t pt-3">
                    <CheckToggle label="Customers can open new tickets" checked={form.allowTicketCreate} onChange={(v) => set("allowTicketCreate", v)} />
                    <p className="pl-12 text-xs text-muted-foreground">Their replies on existing tickets always work.</p>
                </div>
            </section>

            <section aria-labelledby="portal-words" className="grid gap-3 rounded-xl border border-border/70 bg-card p-5 shadow-sm">
                <h3 id="portal-words" className="text-sm font-medium">Wording</h3>
                <div className="grid gap-1"><Label htmlFor="portal-title" className="text-sm">Welcome title</Label><Input id="portal-title" maxLength={120} value={form.welcomeTitle} onChange={(e) => set("welcomeTitle", e.target.value)} placeholder="Customer portal" /></div>
                <div className="grid gap-1"><Label htmlFor="portal-text" className="text-sm">Welcome message</Label><Textarea id="portal-text" rows={3} maxLength={2000} value={form.welcomeText} onChange={(e) => set("welcomeText", e.target.value)} placeholder="Shown on the sign-in page and the home page." /></div>
                <div className="grid gap-3 sm:grid-cols-2">
                    <div className="grid gap-1"><Label htmlFor="portal-mail" className="text-sm">Support email</Label><Input id="portal-mail" type="email" value={form.supportEmail} onChange={(e) => set("supportEmail", e.target.value)} placeholder="support@example.com" /></div>
                    <div className="grid gap-1"><Label htmlFor="portal-phone" className="text-sm">Support phone</Label><Input id="portal-phone" value={form.supportPhone} onChange={(e) => set("supportPhone", e.target.value)} placeholder="555-0100" /></div>
                </div>
                <p className="text-xs text-muted-foreground">The portal uses your logo and colours from Branding. Invitations and password links are sent through the &quot;Invites&quot; and &quot;Password resets&quot; mailboxes under Email.</p>
            </section>

            <div className="flex items-center justify-end gap-2">
                {dirty ? <span className="text-xs text-muted-foreground">Unsaved changes</span> : null}
                <Button variant="outline" disabled={!dirty || busy === "save"} onClick={() => { setForm(saved); setCheck(null); }}>Discard</Button>
                <Button onClick={() => void save()} disabled={!dirty || busy === "save"}>{busy === "save" ? "Saving…" : "Save"}</Button>
            </div>

            <section aria-labelledby="portal-people" className="grid gap-3 rounded-xl border border-border/70 bg-card p-5 shadow-sm">
                <div>
                    <h3 id="portal-people" className="text-sm font-medium">People with portal access</h3>
                    <p className="text-xs text-muted-foreground">Add people from a customer&apos;s page: Customers &gt; Customer &gt; Portal access. Everyone is listed here.</p>
                </div>
                <PortalAccountsPanel />
            </section>
        </div>
    );
}
