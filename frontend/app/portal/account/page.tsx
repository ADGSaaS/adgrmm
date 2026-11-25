"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { portal } from "@/lib/portal-api";
import { PageTitle, Panel } from "../parts";
import { usePortalMe } from "../portal-shell";

export default function PortalAccount() {
    const { me } = usePortalMe();
    const [current, setCurrent] = React.useState("");
    const [password, setPassword] = React.useState("");
    const [again, setAgain] = React.useState("");
    const [error, setError] = React.useState<string | null>(null);
    const [done, setDone] = React.useState(false);
    const [busy, setBusy] = React.useState(false);

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError(null);
        setDone(false);
        if (password !== again) { setError("The two new passwords are not the same."); return; }
        setBusy(true);
        try {
            await portal("/auth/change-password", { method: "POST", body: { current, password } });
            setCurrent(""); setPassword(""); setAgain("");
            setDone(true);
        } catch (err: any) {
            setError(err?.message || "Could not change the password.");
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="mx-auto max-w-xl space-y-6">
            <PageTitle title="Your account" />
            <Panel className="p-5">
                <dl className="grid grid-cols-[8rem_1fr] gap-y-2 text-sm">
                    <dt className="text-muted-foreground">Name</dt><dd>{me.name}</dd>
                    <dt className="text-muted-foreground">Email</dt><dd className="break-all">{me.email}</dd>
                    <dt className="text-muted-foreground">Company</dt><dd>{me.customer}</dd>
                    <dt className="text-muted-foreground">Access</dt><dd>{me.role === "manager" ? "Manager: tickets, devices and invoices for the whole company" : "Your own tickets"}</dd>
                </dl>
            </Panel>
            <Panel className="p-5">
                <h2 className="mb-3 font-medium">Change your password</h2>
                <form onSubmit={submit} className="space-y-4" noValidate>
                    <div className="space-y-2"><Label htmlFor="cur">Current password</Label><Input id="cur" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} /></div>
                    <div className="space-y-2"><Label htmlFor="new">New password</Label><Input id="new" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} aria-describedby="newhelp" /><p id="newhelp" className="text-xs text-muted-foreground">At least 10 characters. You stay signed in here; other browsers are signed out.</p></div>
                    <div className="space-y-2"><Label htmlFor="again">Type the new password again</Label><Input id="again" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} /></div>
                    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
                    {done ? <p role="status" className="text-sm text-emerald-600 dark:text-emerald-400">Your password was changed.</p> : null}
                    <Button type="submit" disabled={busy || !current || password.length < 10 || !again}>{busy ? "Saving…" : "Change password"}</Button>
                </form>
            </Panel>
        </div>
    );
}
