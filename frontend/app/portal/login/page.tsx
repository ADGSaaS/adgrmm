"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { portal, type PortalConfig } from "@/lib/portal-api";
import { useHref } from "../portal-shell";

export default function PortalLogin() {
    const router = useRouter();
    const href = useHref();
    const [cfg, setCfg] = React.useState<PortalConfig | null>(null);
    const [email, setEmail] = React.useState("");
    const [password, setPassword] = React.useState("");
    const [error, setError] = React.useState<string | null>(null);
    const [busy, setBusy] = React.useState(false);

    React.useEffect(() => {
        portal<PortalConfig>("/config").then(setCfg).catch(() => setCfg(null));
    }, []);

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
            await portal("/auth/login", { method: "POST", body: { email, password } });
            router.replace(href("/"));
        } catch (err: any) {
            setError(err?.message || "Could not sign in.");
            setBusy(false);
        }
    };

    if (cfg && !cfg.enabled) {
        return (
            <Card>
                <CardHeader>
                    <CardTitle>Portal not available</CardTitle>
                    <CardDescription>The customer portal is not turned on yet. Please contact your IT provider.</CardDescription>
                </CardHeader>
            </Card>
        );
    }

    return (
        <Card>
            <CardHeader>
                <CardTitle>{cfg?.welcomeTitle || "Sign in"}</CardTitle>
                <CardDescription>{cfg?.welcomeText || "Sign in to follow your support tickets, devices and invoices."}</CardDescription>
            </CardHeader>
            <CardContent>
                <form onSubmit={submit} className="space-y-4" noValidate>
                    <div className="space-y-2">
                        <Label htmlFor="email">Email</Label>
                        <Input id="email" type="email" autoComplete="username" autoFocus required value={email} onChange={(e) => setEmail(e.target.value)} />
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="password">Password</Label>
                        <Input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
                    </div>
                    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
                    <Button type="submit" className="w-full" disabled={busy || !email || !password}>{busy ? "Signing in…" : "Sign in"}</Button>
                    <p className="text-center text-sm">
                        <Link href={href("/forgot")} className="text-muted-foreground underline">Forgot your password?</Link>
                    </p>
                </form>
            </CardContent>
        </Card>
    );
}
