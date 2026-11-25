"use client";

// Who from a customer can sign in to the client portal: add people, send invitations, change their access, switch them off.
// With no customer given it lists everyone, across customers (read and manage, but adding is done from a customer).
import * as React from "react";
import { Mail, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { jfetch } from "@/lib/api";

export type PortalAccount = {
    id: string;
    clientId: string;
    clientName: string;
    contactId: string | null;
    email: string;
    name: string;
    role: "user" | "manager";
    status: "invited" | "active" | "disabled";
    lastLoginAt: string | null;
};

type Contact = { id: string; name: string; email: string };
type Invite = { sent: boolean; message?: string } | null;

const messageOf = (e: unknown) => {
    const raw = e instanceof Error ? e.message : "Something went wrong.";
    try { const j = JSON.parse(raw) as { message?: string | string[] }; return Array.isArray(j.message) ? j.message.join(" ") : j.message ?? raw; } catch { return raw; }
};

const STATUS: Record<PortalAccount["status"], { label: string; cls: string }> = {
    invited: { label: "Invited", cls: "bg-amber-500/15 text-amber-700 dark:text-amber-300" },
    active: { label: "Active", cls: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" },
    disabled: { label: "Disabled", cls: "bg-muted text-muted-foreground" },
};

export function PortalAccountsPanel({ clientId }: { clientId?: string }) {
    const [accounts, setAccounts] = React.useState<PortalAccount[] | null>(null);
    const [contacts, setContacts] = React.useState<Contact[]>([]);
    const [note, setNote] = React.useState<{ ok: boolean; text: string } | null>(null);
    const [busy, setBusy] = React.useState<string | null>(null);
    const [form, setForm] = React.useState({ contactId: "", name: "", email: "", role: "user" as "user" | "manager", sendInvite: true });

    const load = React.useCallback(async () => {
        try {
            setAccounts(await jfetch<PortalAccount[]>(`/api/portal-admin/accounts${clientId ? `?clientId=${encodeURIComponent(clientId)}` : ""}`));
        } catch (e) {
            setAccounts([]);
            setNote({ ok: false, text: messageOf(e) });
        }
    }, [clientId]);
    React.useEffect(() => { setAccounts(null); setNote(null); void load(); }, [load]);

    // The people already listed on the customer, so access can be given in one click.
    React.useEffect(() => {
        setContacts([]);
        if (!clientId) return;
        jfetch<{ contacts?: { id: string; name?: string; email?: string }[] }>(`/api/customers/${encodeURIComponent(clientId)}`)
            .then((p) => setContacts((p.contacts ?? []).filter((c) => c.email && c.name).map((c) => ({ id: c.id, name: String(c.name), email: String(c.email) }))))
            .catch(() => setContacts([]));
    }, [clientId]);

    const taken = new Set((accounts ?? []).map((a) => a.email.toLowerCase()));
    const available = contacts.filter((c) => !taken.has(c.email.toLowerCase()));

    const run = async (key: string, fn: () => Promise<string | void>) => {
        setBusy(key);
        setNote(null);
        try {
            const text = await fn();
            if (text) setNote({ ok: true, text });
            await load();
        } catch (e) {
            setNote({ ok: false, text: messageOf(e) });
        } finally {
            setBusy(null);
        }
    };

    const inviteText = (inv: Invite, who: string) =>
        !inv ? `${who} added. No email was sent.` : inv.sent ? `${who} added and an invitation was emailed.` : `${who} added, but the invitation email could not be sent: ${inv.message ?? "unknown reason"} You can send it again once email is set up.`;

    const add = (e: React.FormEvent) => {
        e.preventDefault();
        void run("add", async () => {
            const r = await jfetch<{ account: PortalAccount; invite: Invite }>("/api/portal-admin/accounts", {
                method: "POST",
                body: { clientId, contactId: form.contactId || undefined, name: form.name.trim(), email: form.email.trim(), role: form.role, sendInvite: form.sendInvite },
            });
            setForm({ contactId: "", name: "", email: "", role: "user", sendInvite: true });
            return inviteText(r.invite, r.account.name);
        });
    };

    const patch = (a: PortalAccount, body: Record<string, unknown>, done: string) => run(a.id, async () => { await jfetch(`/api/portal-admin/accounts/${a.id}`, { method: "PATCH", body }); return done; });
    const send = (a: PortalAccount) => run(a.id, async () => {
        const r = await jfetch<{ sent: boolean; message?: string }>(`/api/portal-admin/accounts/${a.id}/send`, { method: "POST" });
        if (!r.sent) throw new Error(`The email could not be sent: ${r.message ?? "unknown reason"}`);
        return a.status === "active" ? `A password reset link was emailed to ${a.email}.` : `The invitation was emailed to ${a.email}.`;
    });
    const remove = (a: PortalAccount) => {
        if (!window.confirm(`Remove portal access for ${a.name}? They are signed out at once and their tickets stay.`)) return;
        void run(a.id, async () => { await jfetch(`/api/portal-admin/accounts/${a.id}`, { method: "DELETE" }); return `${a.name} no longer has portal access.`; });
    };

    return (
        <div className="grid gap-4">
            {clientId ? (
                <form onSubmit={add} className="grid gap-3 rounded-lg border p-3">
                    <div className="text-sm font-medium">Give someone portal access</div>
                    {available.length > 0 ? (
                        <div className="grid gap-1">
                            <Label htmlFor="pa-contact" className="text-xs text-muted-foreground">Pick from this customer&apos;s people</Label>
                            <select
                                id="pa-contact"
                                className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                                value={form.contactId}
                                onChange={(e) => {
                                    const c = available.find((x) => x.id === e.target.value);
                                    setForm((f) => ({ ...f, contactId: e.target.value, name: c?.name ?? f.name, email: c?.email ?? f.email }));
                                }}
                            >
                                <option value="">Someone else (type below)</option>
                                {available.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.email})</option>)}
                            </select>
                        </div>
                    ) : null}
                    <div className="grid gap-3 sm:grid-cols-2">
                        <div className="grid gap-1"><Label htmlFor="pa-name" className="text-xs text-muted-foreground">Name</Label><Input id="pa-name" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value, contactId: "" }))} autoComplete="off" /></div>
                        <div className="grid gap-1"><Label htmlFor="pa-email" className="text-xs text-muted-foreground">Email</Label><Input id="pa-email" type="email" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value, contactId: "" }))} autoComplete="off" /></div>
                    </div>
                    <div className="flex flex-wrap items-end gap-4">
                        <div className="grid gap-1">
                            <Label htmlFor="pa-role" className="text-xs text-muted-foreground">Access</Label>
                            <select id="pa-role" className="h-10 rounded-md border border-input bg-background px-3 text-sm" value={form.role} onChange={(e) => setForm((f) => ({ ...f, role: e.target.value as "user" | "manager" }))}>
                                <option value="user">User: sees the tickets they opened</option>
                                <option value="manager">Manager: sees everything for the company</option>
                            </select>
                        </div>
                        <label className="flex items-center gap-2 pb-2 text-sm"><input type="checkbox" checked={form.sendInvite} onChange={(e) => setForm((f) => ({ ...f, sendInvite: e.target.checked }))} />Email an invitation now</label>
                        <Button type="submit" disabled={busy === "add" || !form.name.trim() || !form.email.trim()}>{busy === "add" ? "Adding…" : "Add"}</Button>
                    </div>
                </form>
            ) : null}

            {note ? <p role={note.ok ? "status" : "alert"} className={`rounded-md border p-2 text-sm ${note.ok ? "" : "border-destructive/50 text-destructive"}`}>{note.text}</p> : null}

            {accounts === null ? <p className="text-sm text-muted-foreground">Loading…</p> : accounts.length === 0 ? (
                <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">{clientId ? "Nobody from this customer has portal access yet." : "Nobody has portal access yet. Give it to people from a customer's page (Customer > Portal access)."}</p>
            ) : (
                <div className="overflow-x-auto rounded-lg border">
                    <table className="w-full min-w-[640px] text-sm">
                        <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                            <tr>
                                <th scope="col" className="px-3 py-2 font-medium">Person</th>
                                {!clientId ? <th scope="col" className="px-3 py-2 font-medium">Customer</th> : null}
                                <th scope="col" className="px-3 py-2 font-medium">Access</th>
                                <th scope="col" className="px-3 py-2 font-medium">Status</th>
                                <th scope="col" className="px-3 py-2 font-medium">Last sign-in</th>
                                <th scope="col" className="px-3 py-2 text-right font-medium">Actions</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y">
                            {accounts.map((a) => (
                                <tr key={a.id}>
                                    <td className="px-3 py-2"><div className="font-medium">{a.name}</div><div className="text-xs text-muted-foreground">{a.email}</div></td>
                                    {!clientId ? <td className="px-3 py-2 text-muted-foreground">{a.clientName}</td> : null}
                                    <td className="px-3 py-2">
                                        <select aria-label={`Access for ${a.name}`} className="h-8 rounded-md border border-input bg-background px-2 text-xs" value={a.role} disabled={busy === a.id}
                                            onChange={(e) => void patch(a, { role: e.target.value }, `${a.name} is now a ${e.target.value}.`)}>
                                            <option value="user">User</option>
                                            <option value="manager">Manager</option>
                                        </select>
                                    </td>
                                    <td className="px-3 py-2"><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS[a.status].cls}`}>{STATUS[a.status].label}</span></td>
                                    <td className="px-3 py-2 text-muted-foreground">{a.lastLoginAt ? new Date(a.lastLoginAt).toLocaleString() : "Never"}</td>
                                    <td className="px-3 py-2">
                                        <div className="flex justify-end gap-1">
                                            {a.status !== "disabled" ? (
                                                <Button size="sm" variant="outline" className="gap-1" disabled={busy === a.id} onClick={() => void send(a)} title={a.status === "active" ? "Email a password reset link" : "Email the invitation again"}>
                                                    <Mail className="h-3.5 w-3.5" aria-hidden />{a.status === "active" ? "Reset link" : "Send invite"}
                                                </Button>
                                            ) : null}
                                            <Button size="sm" variant="outline" disabled={busy === a.id} onClick={() => void patch(a, { status: a.status === "disabled" ? "active" : "disabled" }, a.status === "disabled" ? `${a.name} can sign in again.` : `${a.name} was signed out and cannot sign in.`)}>
                                                {a.status === "disabled" ? "Enable" : "Disable"}
                                            </Button>
                                            <Button size="sm" variant="ghost" aria-label={`Remove ${a.name}`} disabled={busy === a.id} onClick={() => remove(a)}><Trash2 className="h-4 w-4" aria-hidden /></Button>
                                        </div>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}
