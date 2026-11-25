"use client";

// Customer > Portal access: who from this customer can sign in to the client portal.
import * as React from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { useCustomers } from "@/app/(dashboard)/customers/customers-context";
import { fetchCustomers, jfetch } from "@/lib/api";
import { PortalAccountsPanel } from "./portal-accounts-panel";

export function PortalAccessDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
    const { selection } = useCustomers();
    const selectedName = selection[0]?.org ?? "";
    const [customers, setCustomers] = React.useState<{ id: string; name: string }[]>([]);
    const [clientId, setClientId] = React.useState("");
    const [portalOn, setPortalOn] = React.useState<boolean | null>(null);

    React.useEffect(() => {
        if (!open) return;
        void fetchCustomers().then((list) => {
            const mapped = list.map((c) => ({ id: c.id, name: c.name })).sort((a, b) => a.name.localeCompare(b.name));
            setCustomers(mapped);
            setClientId((cur) => cur || mapped.find((c) => c.name === selectedName)?.id || mapped[0]?.id || "");
        }).catch(() => setCustomers([]));
        jfetch<{ enabled: boolean; domain: string | null }>("/api/portal-admin/settings").then((s) => setPortalOn(s.enabled && !!s.domain)).catch(() => setPortalOn(null));
    }, [open, selectedName]);

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[820px]">
                <DialogHeader>
                    <DialogTitle>Portal access</DialogTitle>
                    <DialogDescription>
                        People you add here can sign in to the client portal with their own email and password and see this customer&apos;s tickets, and (as managers) its devices and invoices. They never see other customers.
                    </DialogDescription>
                </DialogHeader>
                {portalOn === false ? (
                    <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-sm">The portal is not turned on yet. Set its address and switch it on in Administration &gt; Client Portal; people you add now will be able to sign in once it is.</p>
                ) : null}
                <div className="grid gap-1">
                    <Label htmlFor="pa-customer" className="text-xs text-muted-foreground">Customer</Label>
                    <select id="pa-customer" className="h-10 rounded-md border border-input bg-background px-3 text-sm" value={clientId} onChange={(e) => setClientId(e.target.value)}>
                        {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                </div>
                {clientId ? <PortalAccountsPanel clientId={clientId} /> : <p className="text-sm text-muted-foreground">No customers yet.</p>}
            </DialogContent>
        </Dialog>
    );
}
