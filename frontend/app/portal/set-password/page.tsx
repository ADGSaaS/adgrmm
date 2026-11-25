"use client";

// Where an invitation or a password-reset email leads.
import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { portal } from "@/lib/portal-api";
import { useHref } from "../portal-shell";

type LinkInfo = { kind: "invite" | "reset"; name: string; email: string };

function SetPassword() {
    const router = useRouter();
    const href = useHref();
    const token = useSearchParams().get("token") ?? "";
    const [info, setInfo] = React.useState<LinkInfo | null>(null);
    const [bad, setBad] = React.useState(false);
    const [password, setPassword] = React.useState("");
    const [again, setAgain] = React.useState("");
    const [error, setError] = React.useState<string | null>(null);
    const [busy, setBusy] = React.useState(false);

    React.useEffect(() => {
        if (!token) { setBad(true); return; }
        portal<LinkInfo>(`/auth/link/${encodeURIComponent(token)}`).then(setInfo).catch(() => setBad(true));
    }, [token]);

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError(null);
        if (password !== again) { setError("The two passwords are not the same."); return; }
        setBusy(true);
        try {
            await portal("/auth/set-password", { method: "POST", body: { token, password } });
            router.replace(href("/"));
        } catch (err: any) {
            setError(err?.message || "Could not save the password.");
            setBusy(false);
        }
    };

    if (bad) {
        return (
            <Card>
                <CardHeader>
                    <CardTitle>This link has expired</CardTitle>
                    <CardDescription>Links work once, and only for a limited time.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                    <p>Ask for a new one from the sign-in page.</p>
                    <Link href={href("/forgot")} className="underline">Send me a new link</Link>
                </CardContent>
            </Card>
        );
    }
    if (!info) return <p className="text-center text-sm text-muted-foreground">Checking your link…</p>;

    return (
        <Card>
            <CardHeader>
                <CardTitle>{info.kind === "invite" ? `Welcome, ${info.name}` : "Choose a new password"}</CardTitle>
                <CardDescription>{info.kind === "invite" ? "Choose a password to finish setting up your portal access." : `For ${info.email}.`}</CardDescription>
            </CardHeader>
            <CardContent>
                <form onSubmit={submit} className="space-y-4" noValidate>
                    <div className="space-y-2">
                        <Label htmlFor="pw">New password</Label>
                        <Input id="pw" type="password" autoComplete="new-password" autoFocus required value={password} onChange={(e) => setPassword(e.target.value)} aria-describedby="pwhelp" />
                        <p id="pwhelp" className="text-xs text-muted-foreground">At least 10 characters.</p>
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="pw2">Type it again</Label>
                        <Input id="pw2" type="password" autoComplete="new-password" required value={again} onChange={(e) => setAgain(e.target.value)} />
                    </div>
                    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
                    <Button type="submit" className="w-full" disabled={busy || password.length < 10 || !again}>{busy ? "Saving…" : "Save and continue"}</Button>
                </form>
            </CardContent>
        </Card>
    );
}

export default function PortalSetPassword() {
    return (
        <React.Suspense fallback={null}>
            <SetPassword />
        </React.Suspense>
    );
}
