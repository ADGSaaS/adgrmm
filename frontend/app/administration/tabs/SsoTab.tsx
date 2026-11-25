"use client";

// Single sign-on through an OpenID Connect provider (Microsoft Entra ID, Google, Okta and others).
// People sign in at the provider and come back signed in; passwords can stay or be turned off (Owners keep one as a way back in).
import * as React from "react";
import { KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { jfetch, getAdminRoles } from "@/lib/api";
import type { ToastFn } from "../types";

type Sso = {
    enabled: boolean;
    displayName: string;
    passwordLogin: boolean;
    issuer: string;
    clientId: string;
    hasClientSecret: boolean;
    scopes: string;
    jitEnabled: boolean;
    defaultRoleId: string | null;
    allowedDomains: string;
    redirectUri: string;
};

const PRESETS: { name: string; issuer: string; hint: string }[] = [
    { name: "Microsoft Entra ID", issuer: "https://login.microsoftonline.com/TENANT-ID/v2.0", hint: "Replace TENANT-ID with your directory (tenant) ID." },
    { name: "Google Workspace", issuer: "https://accounts.google.com", hint: "" },
    { name: "Okta", issuer: "https://YOUR-ORG.okta.com", hint: "Replace YOUR-ORG with your Okta domain." },
];

const messageOf = (e: unknown) => {
    const raw = e instanceof Error ? e.message : "Something went wrong.";
    try { const j = JSON.parse(raw) as { message?: string | string[] }; return Array.isArray(j.message) ? j.message.join(" ") : j.message ?? raw; } catch { return raw; }
};

export default function SsoTab({ push }: { push: ToastFn }) {
    const [saved, setSaved] = React.useState<Sso | null>(null);
    const [form, setForm] = React.useState<Sso | null>(null);
    const [secret, setSecret] = React.useState("");
    const [roles, setRoles] = React.useState<{ id: string; name: string }[]>([]);
    const [busy, setBusy] = React.useState<"save" | "test" | null>(null);
    const [testResult, setTestResult] = React.useState<{ ok: boolean; message: string } | null>(null);

    const load = React.useCallback(async () => {
        try {
            const [s, r] = await Promise.all([jfetch<Sso>("/api/admin/sso"), getAdminRoles().catch(() => ({ items: [] }))]);
            setSaved(s);
            setForm(s);
            setRoles(r.items);
        } catch (e) {
            push({ title: "Could not load single sign-on", desc: messageOf(e), kind: "destructive" });
        }
    }, [push]);

    React.useEffect(() => { void load(); }, [load]);

    if (!form || !saved) return <div className="p-4 text-sm text-muted-foreground">Loading…</div>;

    const set = <K extends keyof Sso>(k: K, v: Sso[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));
    const dirty = JSON.stringify(form) !== JSON.stringify(saved) || secret !== "";

    async function save() {
        if (!form) return;
        setBusy("save");
        try {
            const s = await jfetch<Sso>("/api/admin/sso", {
                method: "PUT",
                body: {
                    enabled: form.enabled,
                    displayName: form.displayName,
                    issuer: form.issuer,
                    clientId: form.clientId,
                    ...(secret ? { clientSecret: secret } : {}),
                    scopes: form.scopes,
                    jitEnabled: form.jitEnabled,
                    defaultRoleId: form.defaultRoleId,
                    allowedDomains: form.allowedDomains,
                    passwordLogin: form.passwordLogin,
                },
            });
            setSaved(s);
            setForm(s);
            setSecret("");
            push({ title: "Single sign-on saved", kind: "success" });
        } catch (e) {
            push({ title: "Could not save", desc: messageOf(e), kind: "destructive" });
        } finally {
            setBusy(null);
        }
    }

    async function test() {
        setBusy("test");
        setTestResult(null);
        try {
            setTestResult(await jfetch<{ ok: boolean; message: string }>("/api/admin/sso/test", { method: "POST" }));
        } catch (e) {
            setTestResult({ ok: false, message: messageOf(e) });
        } finally {
            setBusy(null);
        }
    }

    return (
        <div className="grid w-full min-w-0 gap-6">
            <div>
                <h2 className="flex items-center gap-2 text-xl font-semibold tracking-tight"><KeyRound className="h-5 w-5" aria-hidden /> Single sign-on</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                    Let people sign in with your company account (OpenID Connect: Microsoft Entra ID, Google Workspace, Okta and others). Whatever second step the provider asks for applies, so there is no separate code prompt here.
                    SAML is not supported yet.
                </p>
            </div>

            <div className="grid gap-2 rounded-xl border border-border/70 bg-card p-5 shadow-sm">
                <div className="text-sm font-medium">Set up at your provider</div>
                <ol className="list-decimal space-y-1 pl-5 text-xs text-muted-foreground">
                    <li>Create an application (Entra: App registrations &gt; New registration, single tenant) of type <b>Web</b>.</li>
                    <li>Add this redirect URI: <code className="select-all break-all rounded bg-muted px-1">{saved.redirectUri}</code></li>
                    <li>Create a client secret and copy its value. Keep the scopes <b>openid email profile</b>. In Entra, add the optional <b>email</b> claim to the ID token if people have no email shown.</li>
                    <li>Fill in the issuer, client ID and secret below, save, press <b>Test provider</b>, then turn it on.</li>
                </ol>
                <div className="flex flex-wrap gap-2 pt-1">
                    {PRESETS.map((p) => (
                        <button key={p.name} type="button" className="rounded border px-2 py-0.5 text-xs hover:bg-accent" title={p.hint} onClick={() => set("issuer", p.issuer)}>
                            Use {p.name}
                        </button>
                    ))}
                </div>
            </div>

            <div className="grid gap-3 rounded-xl border border-border/70 bg-card p-5 shadow-sm sm:grid-cols-2">
                <div className="grid gap-1 sm:col-span-2">
                    <Label htmlFor="sso-issuer" className="text-sm">Issuer URL</Label>
                    <Input id="sso-issuer" value={form.issuer} onChange={(e) => set("issuer", e.target.value)} placeholder="https://login.microsoftonline.com/TENANT-ID/v2.0" autoComplete="off" />
                </div>
                <div className="grid gap-1">
                    <Label htmlFor="sso-client" className="text-sm">Client (application) ID</Label>
                    <Input id="sso-client" value={form.clientId} onChange={(e) => set("clientId", e.target.value)} autoComplete="off" />
                </div>
                <div className="grid gap-1">
                    <Label htmlFor="sso-secret" className="text-sm">Client secret</Label>
                    <Input id="sso-secret" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={saved.hasClientSecret ? "Saved. Type a new one to replace it." : "Paste the secret value"} autoComplete="new-password" />
                </div>
                <div className="grid gap-1">
                    <Label htmlFor="sso-name" className="text-sm">Button text</Label>
                    <Input id="sso-name" value={form.displayName} maxLength={60} onChange={(e) => set("displayName", e.target.value)} placeholder="Sign in with Microsoft" />
                </div>
                <div className="grid gap-1">
                    <Label htmlFor="sso-scopes" className="text-sm">Scopes</Label>
                    <Input id="sso-scopes" value={form.scopes} onChange={(e) => set("scopes", e.target.value)} autoComplete="off" />
                </div>
            </div>

            <div className="grid gap-3 rounded-xl border border-border/70 bg-card p-5 shadow-sm">
                <div className="text-sm font-medium">Who can sign in</div>
                <div className="grid gap-1">
                    <Label htmlFor="sso-domains" className="text-sm">Allowed email domains <span className="font-normal text-muted-foreground">(optional, separated by commas)</span></Label>
                    <Input id="sso-domains" value={form.allowedDomains} onChange={(e) => set("allowedDomains", e.target.value)} placeholder="example.com, example.org" autoComplete="off" />
                </div>
                <p className="text-xs text-muted-foreground">
                    People are matched to an existing account by email the first time, and after that by their provider account, so a changed address cannot take over someone else&apos;s account.
                </p>
                <label className="flex items-start gap-2 text-sm">
                    <input type="checkbox" className="h-4 w-4 shrink-0 rounded border-input accent-primary" checked={form.jitEnabled} onChange={(e) => set("jitEnabled", e.target.checked)} />
                    <span>Create an account automatically at a person&apos;s first sign-in <span className="text-xs text-muted-foreground">(otherwise they must be added first)</span></span>
                </label>
                {form.jitEnabled ? (
                    <div className="grid max-w-sm gap-1 pl-6">
                        <Label htmlFor="sso-role" className="text-sm">Role new people get</Label>
                        <select id="sso-role" value={form.defaultRoleId ?? ""} onChange={(e) => set("defaultRoleId", e.target.value || null)} className="h-10 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                            <option value="">Choose a role…</option>
                            {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                        </select>
                    </div>
                ) : null}
                <label className="flex items-start gap-2 text-sm">
                    <input type="checkbox" className="h-4 w-4 shrink-0 rounded border-input accent-primary" checked={!form.passwordLogin} onChange={(e) => set("passwordLogin", !e.target.checked)} />
                    <span>Turn passwords off once single sign-on is on <span className="text-xs text-muted-foreground">(Owners can still use a password, so a broken provider never locks everyone out)</span></span>
                </label>
            </div>

            <div className="rounded-xl border border-border/70 bg-card p-5 shadow-sm">
                <label className="flex items-center gap-2 text-sm font-medium">
                    <input type="checkbox" className="h-4 w-4 shrink-0 rounded border-input accent-primary" checked={form.enabled} onChange={(e) => set("enabled", e.target.checked)} />
                    Single sign-on is on
                </label>
                <p className="mt-1 text-xs text-muted-foreground">When on, the sign-in page shows a button for it.</p>
            </div>

            {testResult ? (
                <p role="status" className={`rounded-md border p-2 text-sm ${testResult.ok ? "border-emerald-500/40 bg-emerald-500/10" : "border-destructive/40 bg-destructive/10 text-destructive"}`}>{testResult.message}</p>
            ) : null}

            <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={save} disabled={!!busy || !dirty}>{busy === "save" ? "Saving…" : "Save"}</Button>
                <Button size="sm" variant="outline" onClick={test} disabled={!!busy || dirty || !saved.issuer} title={dirty ? "Save first, then test what is saved" : undefined}>
                    {busy === "test" ? "Testing…" : "Test provider"}
                </Button>
                {dirty ? <Button size="sm" variant="ghost" onClick={() => { setForm(saved); setSecret(""); }} disabled={!!busy}>Discard changes</Button> : null}
            </div>
        </div>
    );
}
