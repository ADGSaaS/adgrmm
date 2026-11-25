"use client";

import * as React from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { portal } from "@/lib/portal-api";
import { useHref } from "../portal-shell";

export default function PortalForgot() {
    const href = useHref();
    const [email, setEmail] = React.useState("");
    const [sent, setSent] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const [busy, setBusy] = React.useState(false);

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
            await portal("/auth/forgot", { method: "POST", body: { email } });
            setSent(true);
        } catch (err: any) {
            setError(err?.message || "Could not send the email.");
        } finally {
            setBusy(false);
        }
    };

    return (
        <Card>
            <CardHeader>
                <CardTitle>Reset your password</CardTitle>
                <CardDescription>Enter your email and we will send you a link to choose a new password.</CardDescription>
            </CardHeader>
            <CardContent>
                {sent ? (
                    <div className="space-y-4 text-sm">
                        <p role="status">If that email has portal access, a link is on its way. It works for two hours.</p>
                        <Link href={href("/login")} className="underline">Back to sign in</Link>
                    </div>
                ) : (
                    <form onSubmit={submit} className="space-y-4" noValidate>
                        <div className="space-y-2">
                            <Label htmlFor="email">Email</Label>
                            <Input id="email" type="email" autoComplete="username" autoFocus required value={email} onChange={(e) => setEmail(e.target.value)} />
                        </div>
                        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
                        <Button type="submit" className="w-full" disabled={busy || !email}>{busy ? "Sending…" : "Send the link"}</Button>
                        <p className="text-center text-sm"><Link href={href("/login")} className="text-muted-foreground underline">Back to sign in</Link></p>
                    </form>
                )}
            </CardContent>
        </Card>
    );
}
