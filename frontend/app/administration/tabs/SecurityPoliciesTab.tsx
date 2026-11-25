"use client";

// Security policies: staff password rules, how long a sign-in lasts, which addresses staff may sign in from, and the
// CAPTCHA on the sign-in page. Everything here is enforced by the server.
import * as React from "react";
import { ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { jfetch } from "@/lib/api";
import type { ToastFn } from "../types";

type Policy = {
    passwordMinLength: number;
    passwordRequireNumbers: boolean;
    passwordRequireSpecial: boolean;
    passwordRequireUppercase: boolean;
    passwordHistory: number;
    sessionTimeoutMins: number;
    idleTimeoutMins: number;
    ipAllowlist: string;
    captchaEnabled: boolean;
    turnstileSiteKey: string;
    hasTurnstileSecret: boolean;
    yourIp: string | null;
    passwordRules: string;
    env: { allowlistIgnored: boolean; captchaDisabled: boolean };
};

const messageOf = (e: unknown) => {
    const raw = e instanceof Error ? e.message : "Something went wrong.";
    try { const j = JSON.parse(raw) as { message?: string | string[] }; return Array.isArray(j.message) ? j.message.join(" ") : j.message ?? raw; } catch { return raw; }
};

const editable = (p: Policy) => ({
    passwordMinLength: p.passwordMinLength,
    passwordRequireNumbers: p.passwordRequireNumbers,
    passwordRequireSpecial: p.passwordRequireSpecial,
    passwordRequireUppercase: p.passwordRequireUppercase,
    passwordHistory: p.passwordHistory,
    sessionTimeoutMins: p.sessionTimeoutMins,
    idleTimeoutMins: p.idleTimeoutMins,
    ipAllowlist: p.ipAllowlist,
    captchaEnabled: p.captchaEnabled,
    turnstileSiteKey: p.turnstileSiteKey,
});

/** A number of minutes (or passwords) where blank means off. */
function CountField({ id, label, hint, value, onChange }: { id: string; label: string; hint: string; value: number; onChange: (n: number) => void }) {
    return (
        <div className="grid gap-1">
            <Label htmlFor={id} className="text-sm">{label}</Label>
            <Input
                id={id}
                inputMode="numeric"
                value={value === 0 ? "" : String(value)}
                placeholder="Off"
                onChange={(e) => {
                    const digits = e.target.value.replace(/\D/g, "").slice(0, 6);
                    onChange(digits === "" ? 0 : Number(digits));
                }}
            />
            <p className="text-xs text-muted-foreground">{hint}</p>
        </div>
    );
}

export default function SecurityPoliciesTab({ push }: { push: ToastFn }) {
    const [saved, setSaved] = React.useState<Policy | null>(null);
    const [form, setForm] = React.useState<Policy | null>(null);
    const [secret, setSecret] = React.useState("");
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);

    const load = React.useCallback(async () => {
        try {
            const p = await jfetch<Policy>("/api/admin/security-policies");
            setSaved(p);
            setForm(p);
        } catch (e) {
            push({ title: "Could not load security policies", desc: messageOf(e), kind: "destructive" });
        }
    }, [push]);
    React.useEffect(() => { void load(); }, [load]);

    if (!form || !saved) return <div className="p-4 text-sm text-muted-foreground">Loading…</div>;

    const set = <K extends keyof Policy>(k: K, v: Policy[K]) => { setError(null); setForm((f) => (f ? { ...f, [k]: v } : f)); };
    const dirty = JSON.stringify(editable(form)) !== JSON.stringify(editable(saved)) || secret !== "";
    const myIp = saved.yourIp;
    const listHasMyIp = !!myIp && form.ipAllowlist.split(/\r?\n/).some((l) => l.replace(/#.*$/, "").trim().split("/")[0] === myIp);

    async function save() {
        if (!form) return;
        setBusy(true);
        setError(null);
        try {
            const p = await jfetch<Policy>("/api/admin/security-policies", {
                method: "PUT",
                body: { ...editable(form), ...(secret ? { turnstileSecret: secret } : {}) },
            });
            setSaved(p);
            setForm(p);
            setSecret("");
            push({ title: "Security policies saved", kind: "success" });
        } catch (e) {
            const m = messageOf(e);
            setError(m);
            push({ title: "Could not save", desc: m, kind: "destructive" });
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="grid w-full min-w-0 gap-6">
            <div>
                <h2 className="flex items-center gap-2 text-xl font-semibold tracking-tight"><ShieldCheck className="h-5 w-5" aria-hidden /> Security policies</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                    Rules for staff accounts. They apply to everyone who signs in to this console, and every change is written to the audit log.
                    The customer portal has its own sign-in and is not covered here.
                </p>
            </div>

            <section className="grid gap-3 rounded-xl border border-border/70 bg-card p-5 shadow-sm">
                <div className="text-sm font-medium">Passwords</div>
                <p className="text-xs text-muted-foreground">
                    Checked whenever a staff password is set: when an administrator creates an account or sets a password, and when someone changes their own.
                    Existing passwords are not checked until they change. People who sign in with single sign-on are not affected.
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                    <div className="grid gap-1">
                        <Label htmlFor="pw-min" className="text-sm">Minimum length</Label>
                        <Input id="pw-min" inputMode="numeric" value={String(form.passwordMinLength)} onChange={(e) => set("passwordMinLength", Number(e.target.value.replace(/\D/g, "").slice(0, 3)) || 0)} />
                        <p className="text-xs text-muted-foreground">8 to 128 characters.</p>
                    </div>
                    <CountField id="pw-history" label="Do not allow reuse of the last … passwords" hint="Blank means a password can be reused. At most 10." value={form.passwordHistory} onChange={(n) => set("passwordHistory", n)} />
                </div>
                <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
                    <label className="flex items-center gap-2"><input type="checkbox" className="h-4 w-4 shrink-0 rounded border-input accent-primary" checked={form.passwordRequireUppercase} onChange={(e) => set("passwordRequireUppercase", e.target.checked)} /> Require an uppercase letter</label>
                    <label className="flex items-center gap-2"><input type="checkbox" className="h-4 w-4 shrink-0 rounded border-input accent-primary" checked={form.passwordRequireNumbers} onChange={(e) => set("passwordRequireNumbers", e.target.checked)} /> Require a number</label>
                    <label className="flex items-center gap-2"><input type="checkbox" className="h-4 w-4 shrink-0 rounded border-input accent-primary" checked={form.passwordRequireSpecial} onChange={(e) => set("passwordRequireSpecial", e.target.checked)} /> Require a special character</label>
                </div>
            </section>

            <section className="grid gap-3 rounded-xl border border-border/70 bg-card p-5 shadow-sm">
                <div className="text-sm font-medium">Sessions</div>
                <p className="text-xs text-muted-foreground">
                    Enforced on the server, so closing the browser or copying the sign-in cookie does not get around them. The console also signs a person out
                    on its own once they have been idle for the idle time.
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                    <CountField id="sess-timeout" label="Sign out after (minutes signed in)" hint="Blank, or 15 to 10080 (7 days). Counted from sign-in, however busy the person is." value={form.sessionTimeoutMins} onChange={(n) => set("sessionTimeoutMins", n)} />
                    <CountField id="sess-idle" label="Sign out when idle for (minutes)" hint="Blank, or 5 to 10080. Counted from the person's last activity in the console." value={form.idleTimeoutMins} onChange={(n) => set("idleTimeoutMins", n)} />
                </div>
            </section>

            <section className="grid gap-3 rounded-xl border border-border/70 bg-card p-5 shadow-sm">
                <div className="text-sm font-medium">Where staff may sign in from</div>
                <p className="text-xs text-muted-foreground">
                    One address or range per line, such as <code className="rounded bg-muted px-1">203.0.113.7</code> or <code className="rounded bg-muted px-1">203.0.113.0/24</code> (IPv6 works too, and <code className="rounded bg-muted px-1">#</code> starts a comment).
                    Leave it empty to allow every address. Only signing in is limited; people who are already signed in carry on.
                    <b> Owners can always sign in</b>, whatever the list says.
                </p>
                <Textarea id="ip-list" rows={5} value={form.ipAllowlist} onChange={(e) => set("ipAllowlist", e.target.value)} placeholder="Empty: every address may sign in" spellCheck={false} className="font-mono text-xs" />
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span>Your address now: <code className="select-all rounded bg-muted px-1">{myIp ?? "unknown"}</code></span>
                    {myIp && form.ipAllowlist.trim() && !listHasMyIp ? (
                        <Button type="button" size="sm" variant="outline" onClick={() => set("ipAllowlist", `${form.ipAllowlist.replace(/\s+$/, "")}\n${myIp}`)}>Add my address</Button>
                    ) : null}
                </div>
                <p className="text-xs text-muted-foreground">
                    The list cannot be saved if it leaves out your own address. If something goes wrong anyway, a server administrator can set
                    <code className="mx-1 rounded bg-muted px-1">RIQ_IGNORE_IP_ALLOWLIST=1</code> in the server&apos;s environment and restart it.
                    The address used is the one the server&apos;s proxy reports (Cloudflare or Nginx).
                </p>
                {saved.env.allowlistIgnored ? (
                    <p role="status" className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-sm">RIQ_IGNORE_IP_ALLOWLIST is set on the server, so this list is not being applied.</p>
                ) : null}
            </section>

            <section className="grid gap-3 rounded-xl border border-border/70 bg-card p-5 shadow-sm">
                <div className="text-sm font-medium">CAPTCHA on the sign-in page</div>
                <p className="text-xs text-muted-foreground">
                    Uses <a className="underline" href="https://dash.cloudflare.com/?to=/:account/turnstile" target="_blank" rel="noreferrer">Cloudflare Turnstile</a> (free).
                    Create a widget for this console&apos;s address, then paste its site key and secret key here. The secret is stored encrypted and never shown again.
                    For a trial without a real widget, Cloudflare publishes test keys: site key <code className="select-all rounded bg-muted px-1">1x00000000000000000000AA</code> with secret <code className="select-all break-all rounded bg-muted px-1">1x0000000000000000000000000000000AA</code> always passes.
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                    <div className="grid gap-1">
                        <Label htmlFor="ts-site" className="text-sm">Site key</Label>
                        <Input id="ts-site" value={form.turnstileSiteKey} onChange={(e) => set("turnstileSiteKey", e.target.value)} autoComplete="off" spellCheck={false} />
                    </div>
                    <div className="grid gap-1">
                        <Label htmlFor="ts-secret" className="text-sm">Secret key</Label>
                        <Input id="ts-secret" type="password" value={secret} onChange={(e) => { setError(null); setSecret(e.target.value); }} placeholder={saved.hasTurnstileSecret ? "Saved. Type a new one to replace it." : "Paste the secret key"} autoComplete="new-password" />
                    </div>
                </div>
                <label className="flex items-start gap-2 text-sm">
                    <input type="checkbox" className="h-4 w-4 shrink-0 rounded border-input accent-primary" checked={form.captchaEnabled} onChange={(e) => set("captchaEnabled", e.target.checked)} />
                    <span>Require the CAPTCHA to sign in <span className="text-xs text-muted-foreground">(the keys are checked with Cloudflare when you save, so a typo cannot lock everyone out)</span></span>
                </label>
                <p className="text-xs text-muted-foreground">
                    If the CAPTCHA ever blocks everyone (for example the secret was rotated at Cloudflare), a server administrator can set
                    <code className="mx-1 rounded bg-muted px-1">RIQ_DISABLE_CAPTCHA=1</code> in the server&apos;s environment and restart it.
                    While it is on, the server needs to reach Cloudflare to sign people in.
                </p>
                {saved.env.captchaDisabled ? (
                    <p role="status" className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-sm">RIQ_DISABLE_CAPTCHA is set on the server, so the sign-in page is not showing the CAPTCHA.</p>
                ) : null}
            </section>

            {error ? <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-sm text-destructive">{error}</p> : null}

            <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={save} disabled={busy || !dirty}>{busy ? "Saving…" : "Save policies"}</Button>
                <Button size="sm" variant="outline" onClick={() => { setForm(saved); setSecret(""); setError(null); }} disabled={busy || !dirty}>Discard changes</Button>
            </div>
        </div>
    );
}
