"use client";

// The customer's own contacts (the contact list on the customer record) as the person who asked on a ticket:
// searchable, with a way to add a new one without leaving the ticket. Portal accounts are a separate thing.
import * as React from "react";
import { UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { jfetch } from "@/lib/api";

export type TicketContact = { id: string; clientId: string; name: string; jobTitle: string | null; email: string | null; phone: string | null; mobile: string | null; role: string; isPrimary: boolean };

const messageOf = (e: unknown) => {
    const raw = e instanceof Error ? e.message : "Something went wrong.";
    try {
        const j = JSON.parse(raw) as { message?: string | string[] };
        return Array.isArray(j.message) ? j.message.join(" ") : j.message ?? raw;
    } catch {
        return raw;
    }
};

export default function ContactPicker({
    clientId,
    onPick,
    canAdd = true,
    autoFocus = false,
    idPrefix = "contact",
}: {
    clientId: string | null | undefined;
    onPick: (contact: TicketContact) => void;
    /** Whether the person may add a contact (tickets.write). */
    canAdd?: boolean;
    autoFocus?: boolean;
    idPrefix?: string;
}) {
    const [text, setText] = React.useState("");
    const [q, setQ] = React.useState("");
    const [items, setItems] = React.useState<TicketContact[]>([]);
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const [adding, setAdding] = React.useState(false);
    const [draft, setDraft] = React.useState({ name: "", email: "", phone: "" });
    const [saving, setSaving] = React.useState(false);

    React.useEffect(() => {
        const id = setTimeout(() => setQ(text.trim()), 250);
        return () => clearTimeout(id);
    }, [text]);

    React.useEffect(() => {
        if (!clientId) {
            setItems([]);
            return;
        }
        const ac = new AbortController();
        setBusy(true);
        setError(null);
        jfetch<{ items: TicketContact[] }>(`/api/ticket-contacts?clientId=${encodeURIComponent(clientId)}${q ? `&q=${encodeURIComponent(q)}` : ""}`, { signal: ac.signal })
            .then((r) => {
                if (!ac.signal.aborted) setItems(r.items);
            })
            .catch((e) => {
                if (ac.signal.aborted || e?.name === "AbortError") return;
                setItems([]);
                setError(messageOf(e));
            })
            .finally(() => {
                if (!ac.signal.aborted) setBusy(false);
            });
        return () => ac.abort();
    }, [clientId, q]);

    if (!clientId) return <p className="text-sm text-muted-foreground">Choose the customer first: their contacts are listed here.</p>;

    async function create() {
        setError(null);
        if (!draft.name.trim()) {
            setError("Give the contact a name.");
            return;
        }
        setSaving(true);
        try {
            const made = await jfetch<TicketContact>("/api/ticket-contacts", { method: "POST", body: { clientId, name: draft.name, email: draft.email, phone: draft.phone } });
            setAdding(false);
            setDraft({ name: "", email: "", phone: "" });
            onPick(made);
        } catch (e) {
            setError(messageOf(e));
        } finally {
            setSaving(false);
        }
    }

    return (
        <div className="grid gap-2">
            {!adding ? (
                <>
                    <Input id={`${idPrefix}-q`} type="search" aria-label="Search this customer's contacts" placeholder="Search by name, email or phone" value={text} onChange={(e) => setText(e.target.value)} autoFocus={autoFocus} autoComplete="off" />
                    <ul aria-label="Contacts" aria-busy={busy || undefined} className="max-h-56 divide-y overflow-y-auto rounded-md border text-sm">
                        {items.map((c) => (
                            <li key={c.id}>
                                <button type="button" onClick={() => onPick(c)} className="flex w-full flex-col px-3 py-2 text-left hover:bg-accent focus:bg-accent focus:outline-none">
                                    <span className="font-medium">
                                        {c.name}
                                        {c.isPrimary ? <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">Main contact</span> : null}
                                    </span>
                                    <span className="text-xs text-muted-foreground">{[c.jobTitle, c.email, c.phone || c.mobile].filter(Boolean).join(" · ") || "No email or phone"}</span>
                                </button>
                            </li>
                        ))}
                        {!busy && items.length === 0 ? <li className="px-3 py-3 text-muted-foreground">{q ? "No contact matches." : "This customer has no contacts yet."}</li> : null}
                        {busy && items.length === 0 ? <li className="px-3 py-3 text-muted-foreground">Searching…</li> : null}
                    </ul>
                    {canAdd ? (
                        <div>
                            <Button type="button" variant="outline" size="sm" className="gap-1" onClick={() => { setAdding(true); setDraft({ name: text.trim(), email: "", phone: "" }); }}>
                                <UserPlus className="h-3.5 w-3.5" aria-hidden /> Add a new contact
                            </Button>
                        </div>
                    ) : null}
                </>
            ) : (
                <div className="grid gap-2 rounded-md border bg-muted/30 p-3">
                    <p className="text-xs text-muted-foreground">The contact is added to this customer&apos;s contact list.</p>
                    <Input aria-label="Contact name" placeholder="Name" value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} autoFocus />
                    <Input aria-label="Contact email" type="email" placeholder="Email (replies are sent here)" value={draft.email} onChange={(e) => setDraft((d) => ({ ...d, email: e.target.value }))} />
                    <Input aria-label="Contact phone" placeholder="Phone (optional)" value={draft.phone} onChange={(e) => setDraft((d) => ({ ...d, phone: e.target.value }))} />
                    <div className="flex justify-end gap-2">
                        <Button type="button" variant="ghost" size="sm" onClick={() => { setAdding(false); setError(null); }}>
                            Back
                        </Button>
                        <Button type="button" size="sm" disabled={saving} onClick={() => void create()}>
                            {saving ? "Adding…" : "Add and choose"}
                        </Button>
                    </div>
                </div>
            )}
            {error ? (
                <p role="alert" className="text-sm text-destructive">
                    {error}
                </p>
            ) : null}
        </div>
    );
}
