"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { portal, type PortalDevice } from "@/lib/portal-api";
import { PageTitle, Panel, useLoad } from "../../parts";
import { useHref, usePortalMe } from "../../portal-shell";

export default function NewPortalTicket() {
    const { me } = usePortalMe();
    const router = useRouter();
    const href = useHref();
    const [subject, setSubject] = React.useState("");
    const [description, setDescription] = React.useState("");
    const [deviceId, setDeviceId] = React.useState("");
    const [error, setError] = React.useState<string | null>(null);
    const [busy, setBusy] = React.useState(false);
    // Only managers can say which device it is about, and only when the devices area is open to them.
    const canPickDevice = me.role === "manager" && me.modules.includes("devices");
    const { data: devices } = useLoad(() => (canPickDevice ? portal<PortalDevice[]>("/devices") : Promise.resolve([] as PortalDevice[])), [canPickDevice]);

    if (!me.allowTicketCreate) {
        return <p className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">Opening tickets here is turned off. Please contact {me.supportEmail || "your IT provider"}.</p>;
    }

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
            const t = await portal<{ id: string }>("/tickets", { method: "POST", body: { subject, description, deviceId: deviceId || undefined } });
            router.push(href(`/tickets/${t.id}`));
        } catch (err: any) {
            setError(err?.message || "Could not open the ticket.");
            setBusy(false);
        }
    };

    return (
        <div className="mx-auto max-w-2xl">
            <PageTitle title="New ticket" />
            <Panel className="p-5">
                <form onSubmit={submit} className="space-y-4" noValidate>
                    <div className="space-y-2">
                        <Label htmlFor="subject">What do you need help with?</Label>
                        <Input id="subject" value={subject} maxLength={200} onChange={(e) => setSubject(e.target.value)} placeholder="A short summary" autoFocus required />
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="desc">Details</Label>
                        <Textarea id="desc" rows={8} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What happened, what you expected, and anything you have tried." required />
                    </div>
                    {canPickDevice && devices && devices.length > 0 ? (
                        <div className="space-y-2">
                            <Label htmlFor="device">Which device is it about? (optional)</Label>
                            <select id="device" value={deviceId} onChange={(e) => setDeviceId(e.target.value)} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
                                <option value="">Not about one device</option>
                                {devices.map((d) => <option key={d.id} value={d.id}>{d.name}{d.user ? ` (${d.user})` : ""} · {d.site}</option>)}
                            </select>
                        </div>
                    ) : null}
                    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
                    <div className="flex items-center justify-end gap-2">
                        <Button asChild variant="ghost"><Link href={href("/tickets")}>Cancel</Link></Button>
                        <Button type="submit" disabled={busy || !subject.trim() || !description.trim()}>{busy ? "Sending…" : "Send"}</Button>
                    </div>
                </form>
            </Panel>
        </div>
    );
}
