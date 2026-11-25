"use client";

// Who asked, on the ticket page: the customer's contact with email and phone, a way to change or clear them, and
// a link to their tickets. When there is no contact it shows what the ticket does have (the person on the mailbox
// address book, or the portal person who opened it).
import * as React from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { jfetch } from "@/lib/api";
import ContactPicker, { type TicketContact } from "./contact-picker";

export type RequesterContact = { id: string; name: string; email: string | null; phone: string | null; mobile: string | null; jobTitle: string | null };

export function RequesterRow({
    ticketId,
    clientId,
    contact,
    fallbackName,
    fallbackEmail,
    canEdit,
    onChanged,
}: {
    ticketId: string;
    clientId?: string | null;
    contact?: RequesterContact | null;
    fallbackName?: string | null;
    fallbackEmail?: string | null;
    canEdit: boolean;
    onChanged: () => void | Promise<void>;
}) {
    const [open, setOpen] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const [saving, setSaving] = React.useState(false);

    async function save(contactId: string | null) {
        setSaving(true);
        setError(null);
        try {
            await jfetch(`/api/tickets/${ticketId}`, { method: "PATCH", body: { requesterCustomerContactId: contactId } });
            setOpen(false);
            await onChanged();
        } catch (e) {
            const raw = e instanceof Error ? e.message : "Could not save.";
            try {
                const j = JSON.parse(raw) as { message?: string | string[] };
                setError(Array.isArray(j.message) ? j.message.join(" ") : j.message ?? raw);
            } catch {
                setError(raw);
            }
        } finally {
            setSaving(false);
        }
    }

    const phone = contact?.phone || contact?.mobile;
    return (
        <div>
            <dt className="text-muted-foreground">Requester</dt>
            <dd className="min-w-0 font-medium text-foreground">
                {contact ? (
                    <div>
                        <div>{contact.name}</div>
                        {contact.jobTitle ? <div className="text-xs font-normal text-muted-foreground">{contact.jobTitle}</div> : null}
                        {contact.email ? (
                            <div className="truncate text-xs font-normal">
                                <a href={`mailto:${contact.email}`} className="text-primary hover:underline">
                                    {contact.email}
                                </a>
                            </div>
                        ) : (
                            <div className="text-xs text-amber-600 dark:text-amber-400">No email: replies cannot be sent</div>
                        )}
                        {phone ? (
                            <div className="text-xs font-normal">
                                <a href={`tel:${phone}`} className="text-primary hover:underline">
                                    {phone}
                                </a>
                            </div>
                        ) : null}
                        <div className="mt-0.5 text-xs font-normal">
                            <Link href={`/tickets?contactId=${contact.id}&contactName=${encodeURIComponent(contact.name)}`} className="text-muted-foreground hover:text-foreground hover:underline">
                                Their tickets
                            </Link>
                        </div>
                    </div>
                ) : (
                    <span>{fallbackName ?? fallbackEmail ?? "-"}</span>
                )}
                {canEdit ? (
                    <div className="mt-0.5 flex gap-3 text-xs font-normal">
                        <button type="button" className="text-primary hover:underline disabled:text-muted-foreground disabled:no-underline" disabled={!clientId} title={clientId ? undefined : "Choose the ticket's customer first"} onClick={() => setOpen(true)}>
                            {contact ? "Change" : "Choose contact"}
                        </button>
                        {contact ? (
                            <button type="button" className="text-muted-foreground hover:text-foreground hover:underline" disabled={saving} onClick={() => void save(null)}>
                                Clear
                            </button>
                        ) : null}
                    </div>
                ) : null}
                {error && !open ? (
                    <p role="alert" className="mt-1 text-xs text-destructive">
                        {error}
                    </p>
                ) : null}
            </dd>

            <Dialog open={open} onOpenChange={setOpen}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Who asked</DialogTitle>
                        <DialogDescription>Choose one of this customer&apos;s contacts, or add a new one. Replies by email go to them.</DialogDescription>
                    </DialogHeader>
                    <ContactPicker clientId={clientId} autoFocus idPrefix="requester" onPick={(c: TicketContact) => void save(c.id)} />
                    {error ? (
                        <p role="alert" className="text-sm text-destructive">
                            {error}
                        </p>
                    ) : null}
                    <div className="flex justify-end">
                        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                            Cancel
                        </Button>
                    </div>
                </DialogContent>
            </Dialog>
        </div>
    );
}
