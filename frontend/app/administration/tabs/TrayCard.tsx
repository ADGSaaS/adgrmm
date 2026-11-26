"use client";

// The tray app on Windows devices: off until it is switched on here. It gives the person at the computer a small icon to ask for help (a ticket),
// chat with support and see the computer's status. Nothing shows on any device until this is on.
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { jfetch } from "@/lib/api";
import type { ToastFn } from "../types";
import { AdminNote, AdminSection, AdminToggle } from "../tab-layout";

type Tray = { enabled: boolean; helpEnabled: boolean; chatEnabled: boolean; supportPhone: string | null; supportEmail: string | null; greeting: string | null;
    providerName: string | null; officeHours: string | null; website: string | null; contactName: string | null; afterHoursPhone: string | null; notice: string | null };

const messageOf = (e: unknown) => {
    const raw = e instanceof Error ? e.message : "Something went wrong.";
    try { const j = JSON.parse(raw) as { message?: string | string[] }; return Array.isArray(j.message) ? j.message.join(" ") : j.message ?? raw; } catch { return raw; }
};

export default function TrayCard({ push }: { push: ToastFn }) {
    const [saved, setSaved] = React.useState<Tray | null>(null);
    const [t, setT] = React.useState<Tray | null>(null);
    const [busy, setBusy] = React.useState(false);

    React.useEffect(() => {
        void jfetch<Tray>("/api/admin/tray").then((s) => { setSaved(s); setT(s); }).catch((e) => push({ title: "Could not load the tray app settings", desc: messageOf(e), kind: "destructive" }));
    }, [push]);
    if (!saved || !t) return null;

    const dirty = JSON.stringify(saved) !== JSON.stringify(t);
    const save = async () => {
        setBusy(true);
        try {
            const s = await jfetch<Tray>("/api/admin/tray", { method: "PUT", body: { ...t, supportPhone: t.supportPhone ?? "", supportEmail: t.supportEmail ?? "", greeting: t.greeting ?? "", providerName: t.providerName ?? "", officeHours: t.officeHours ?? "", website: t.website ?? "", contactName: t.contactName ?? "", afterHoursPhone: t.afterHoursPhone ?? "", notice: t.notice ?? "" } });
            setSaved(s); setT(s);
            push({ title: "Tray app settings saved", kind: "success" });
        } catch (e) {
            push({ title: "Could not save", desc: messageOf(e), kind: "destructive" });
        } finally { setBusy(false); }
    };

    return (
        <AdminSection
            title="Tray app (Windows)"
            description="A small icon next to the clock on each Windows computer, for the person using it: ask for help, chat with support, see the computer's status."
            footer={
                <div className="flex gap-2">
                    <Button onClick={() => void save()} disabled={!dirty || busy}>{busy ? "Saving…" : "Save"}</Button>
                    {dirty ? <Button variant="outline" onClick={() => setT(saved)} disabled={busy}>Discard</Button> : null}
                </div>
            }
        >
            <AdminToggle id="tray-on" checked={t.enabled} onCheckedChange={(v) => setT({ ...t, enabled: v })} label="Show the tray app on devices">
                Off by default. Until it is on, the tray app on a computer shows nothing and learns nothing about your company. Computers need an agent version that includes the tray app.
            </AdminToggle>
            <AdminToggle id="tray-help" checked={t.helpEnabled} onCheckedChange={(v) => setT({ ...t, helpEnabled: v })} label="Let people ask for help">
                A request becomes a ticket for that computer&apos;s customer, with the computer on it. One computer can send five an hour.
            </AdminToggle>
            <AdminToggle id="tray-chat" checked={t.chatEnabled} onCheckedChange={(v) => setT({ ...t, chatEnabled: v })} label="Let people chat with support">
                Technicians answer on the Device chat page. New messages from a computer also go to webhooks (Slack, Teams) that listen for them.
            </AdminToggle>
            <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-1"><Label htmlFor="tray-phone">Support phone (shown in the tray)</Label><Input id="tray-phone" value={t.supportPhone ?? ""} maxLength={40} onChange={(e) => setT({ ...t, supportPhone: e.target.value })} /></div>
                <div className="grid gap-1"><Label htmlFor="tray-email">Support email (shown in the tray)</Label><Input id="tray-email" type="email" value={t.supportEmail ?? ""} maxLength={200} onChange={(e) => setT({ ...t, supportEmail: e.target.value })} /></div>
            </div>
            <div className="grid gap-1"><Label htmlFor="tray-greeting">A line to greet people with (optional)</Label><Input id="tray-greeting" value={t.greeting ?? ""} maxLength={300} onChange={(e) => setT({ ...t, greeting: e.target.value })} /></div>
            <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-1"><Label htmlFor="tray-provider">IT provider name</Label><Input id="tray-provider" value={t.providerName ?? ""} maxLength={120} placeholder="Your company name" onChange={(e) => setT({ ...t, providerName: e.target.value })} /></div>
                <div className="grid gap-1"><Label htmlFor="tray-contact">Point of contact</Label><Input id="tray-contact" value={t.contactName ?? ""} maxLength={120} placeholder="Name of the person to ask for" onChange={(e) => setT({ ...t, contactName: e.target.value })} /></div>
                <div className="grid gap-1"><Label htmlFor="tray-website">Website (shown as a link)</Label><Input id="tray-website" value={t.website ?? ""} maxLength={300} placeholder="https://www.example.com" onChange={(e) => setT({ ...t, website: e.target.value })} /></div>
                <div className="grid gap-1"><Label htmlFor="tray-after">After-hours or emergency phone</Label><Input id="tray-after" value={t.afterHoursPhone ?? ""} maxLength={40} onChange={(e) => setT({ ...t, afterHoursPhone: e.target.value })} /></div>
            </div>
            <div className="grid gap-1"><Label htmlFor="tray-hours">Office hours</Label><Input id="tray-hours" value={t.officeHours ?? ""} maxLength={300} placeholder="Mon to Fri, 8:00 to 17:00 Eastern" onChange={(e) => setT({ ...t, officeHours: e.target.value })} /></div>
            <div className="grid gap-1"><Label htmlFor="tray-notice">Notice (shown at the top of the window, optional)</Label><Input id="tray-notice" value={t.notice ?? ""} maxLength={400} placeholder="For example: our phones are down today, please use chat or email" onChange={(e) => setT({ ...t, notice: e.target.value })} /></div>
            <AdminNote>People at a computer are not signed in to ADG RMM: the tray works through the computer&apos;s own agent, so a request or message says which computer it came from and the Windows name of whoever typed it, nothing more.</AdminNote>
        </AdminSection>
    );
}
