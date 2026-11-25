"use client";

// The support mailbox: mail sent to it becomes tickets, and replies to customers are sent from it.
// Mail can be read through a Microsoft 365 sign-in (OAuth2) or through the IMAP login saved under "Tickets" in SMTP.
import * as React from "react";
import { Inbox, Plug, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { jfetch } from "@/lib/api";
import type { ToastFn } from "../types";

type Source = "microsoft" | "imap";
type Status = {
    enabled: boolean;
    source: Source;
    imapReady: boolean;
    tenantId: string;
    clientId: string;
    hasClientSecret: boolean;
    connected: boolean;
    mailboxAddress: string;
    connectedAt: string | null;
    lastPolledAt: string | null;
    lastError: string | null;
    lastErrorAt: string | null;
    redirectUri: string;
};

const when = (s: string | null) => (s ? new Date(s).toLocaleString() : "never");

export default function MailboxTab({ push }: { push: ToastFn }) {
    const [st, setSt] = React.useState<Status | null>(null);
    const [busy, setBusy] = React.useState<string | null>(null);
    const [tenant, setTenant] = React.useState("");
    const [clientId, setClientId] = React.useState("");
    const [secret, setSecret] = React.useState("");

    const apply = React.useCallback((s: Status) => {
        setSt(s);
        setTenant(s.tenantId);
        setClientId(s.clientId);
    }, []);

    const load = React.useCallback(async () => {
        try {
            apply(await jfetch<Status>("/api/support-mailbox"));
        } catch (e: any) {
            push({ title: "Could not load the support mailbox", desc: e?.message, kind: "destructive" });
        }
    }, [apply, push]);

    React.useEffect(() => {
        void load();
        // Back from Microsoft's sign-in page.
        const p = new URLSearchParams(window.location.search);
        const result = p.get("mailbox");
        if (result) {
            push({ title: result === "connected" ? "Mailbox connected" : "Could not connect the mailbox", desc: p.get("message") ?? undefined, kind: result === "connected" ? "success" : "destructive" });
            p.delete("mailbox");
            p.delete("message");
            window.history.replaceState(null, "", `${window.location.pathname}?${p.toString()}`);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    async function run<T>(key: string, fn: () => Promise<T>, done?: (r: T) => { title: string; desc?: string } | null) {
        setBusy(key);
        try {
            const r = await fn();
            const t = done?.(r);
            if (t) push({ ...t, kind: "success" });
        } catch (e: any) {
            push({ title: "That did not work", desc: e?.message ?? String(e), kind: "destructive" });
        } finally {
            setBusy(null);
        }
    }

    const save = (body: Record<string, unknown>, ok: string) =>
        run("save", async () => { apply(await jfetch<Status>("/api/support-mailbox", { method: "PUT", body })); setSecret(""); }, () => ({ title: ok }));

    const connect = () =>
        run("connect", async () => {
            const returnTo = `${window.location.origin}${window.location.pathname}?tab=mailbox`;
            const r = await jfetch<{ url: string }>("/api/support-mailbox/connect", { method: "POST", body: { returnTo } });
            window.location.href = r.url;
        });

    const checkNow = () =>
        run("check", async () => {
            const r = await jfetch<{ result: { read: number; tickets: number; replies: number; skipped: number }; status: Status }>("/api/support-mailbox/check-now", { method: "POST" });
            apply(r.status);
            return r.result;
        }, (r) => ({ title: "Checked the mailbox", desc: `${r.read} new message${r.read === 1 ? "" : "s"}: ${r.tickets} new ticket${r.tickets === 1 ? "" : "s"}, ${r.replies} repl${r.replies === 1 ? "y" : "ies"}, ${r.skipped} set aside.` }));

    if (!st) return <div className="p-4 text-sm text-muted-foreground">Loading…</div>;

    const ms = st.source === "microsoft";
    const microsoftSaved = !!(st.tenantId && st.clientId && st.hasClientSecret);

    return (
        <div className="grid w-full min-w-0 gap-6">
            <div>
                <h2 className="flex items-center gap-2 text-xl font-semibold tracking-tight"><Inbox className="h-5 w-5" aria-hidden /> Support mailbox</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                    Email sent to this mailbox becomes a ticket. A customer&apos;s answer to a reply is added to the same ticket, and replies you mark &ldquo;email the customer&rdquo; are sent from it.
                    Automatic replies, bounces and mailing lists are ignored, and mail already waiting when you turn it on is left alone.
                </p>
            </div>

            <div className="rounded-xl border border-border/70 bg-card p-5 shadow-sm">
                <div className="flex flex-wrap items-center gap-3 text-sm">
                    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${st.enabled && st.connected ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "text-muted-foreground"}`}>
                        {st.enabled && st.connected ? "On" : st.connected ? "Connected, off" : "Not connected"}
                    </span>
                    {st.mailboxAddress ? <span className="font-medium">{st.mailboxAddress}</span> : null}
                    <span className="text-xs text-muted-foreground">Last checked: {when(st.lastPolledAt)} (checks every minute)</span>
                </div>
                {st.lastError ? (
                    <p role="alert" className="mt-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-sm text-destructive">
                        {st.lastError} <span className="text-xs opacity-80">({when(st.lastErrorAt)})</span>
                    </p>
                ) : null}
                <div className="mt-3 flex flex-wrap gap-2">
                    {st.connected ? (
                        <Button size="sm" variant="outline" disabled={!!busy} onClick={() => save({ enabled: !st.enabled }, st.enabled ? "Mailbox turned off" : "Mailbox turned on")}>
                            {st.enabled ? "Turn off" : "Turn on"}
                        </Button>
                    ) : null}
                    {st.enabled && st.connected ? (
                        <Button size="sm" variant="outline" disabled={!!busy} onClick={checkNow}>
                            <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${busy === "check" ? "animate-spin" : ""}`} aria-hidden /> Check now
                        </Button>
                    ) : null}
                    {ms && st.connected ? (
                        <Button size="sm" variant="outline" disabled={!!busy} onClick={() => run("disconnect", async () => apply(await jfetch<Status>("/api/support-mailbox/disconnect", { method: "POST" })), () => ({ title: "Mailbox disconnected" }))}>
                            Disconnect
                        </Button>
                    ) : null}
                </div>
            </div>

            <div className="rounded-xl border border-border/70 bg-card p-5 shadow-sm">
                <div className="mb-2 text-sm font-medium">How should mail be read?</div>
                <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="How mail is read">
                    {([
                        ["microsoft", "Microsoft 365 sign-in", "Sign in with OAuth2. For Microsoft 365 mailboxes that no longer allow a password."],
                        ["imap", "IMAP login", "Use the IMAP and SMTP login saved for Tickets in the SMTP tab."],
                    ] as [Source, string, string][]).map(([v, title, desc]) => (
                        <label key={v} className={`cursor-pointer rounded-md border p-2.5 text-sm ${st.source === v ? "border-primary bg-primary/5" : ""}`}>
                            <input
                                type="radio"
                                name="mailbox-source"
                                className="mr-2"
                                checked={st.source === v}
                                disabled={!!busy}
                                onChange={() => save({ source: v }, "Saved")}
                            />
                            <span className="font-medium">{title}</span>
                            <span className="mt-0.5 block text-xs text-muted-foreground">{desc}</span>
                        </label>
                    ))}
                </div>
            </div>

            {ms ? (
                <div className="grid gap-3 rounded-xl border border-border/70 bg-card p-5 shadow-sm">
                    <div className="text-sm font-medium">Microsoft 365</div>
                    <ol className="list-decimal space-y-1 pl-5 text-xs text-muted-foreground">
                        <li>In the Microsoft Entra admin center, create an app registration (App registrations &gt; New registration), single tenant.</li>
                        <li>Add a <b>Web</b> redirect URI: <code className="select-all break-all rounded bg-muted px-1">{st.redirectUri}</code></li>
                        <li>Under API permissions add these delegated permissions and grant admin consent: <b>IMAP.AccessAsUser.All</b> (Office 365 Exchange Online), <b>Mail.Send</b> (Microsoft Graph), <b>offline_access</b>.</li>
                        <li>Under Certificates &amp; secrets create a client secret. Copy its <b>value</b>.</li>
                        <li>Make sure IMAP is allowed for the mailbox (Exchange admin center &gt; Mailboxes &gt; Manage email apps).</li>
                        <li>Fill in the three values below, save, then press Connect and sign in as the mailbox.</li>
                    </ol>
                    <div className="grid gap-3 sm:grid-cols-2">
                        <div className="grid gap-1">
                            <Label htmlFor="mb-tenant" className="text-sm">Directory (tenant) ID</Label>
                            <Input id="mb-tenant" value={tenant} onChange={(e) => setTenant(e.target.value)} placeholder="contoso.onmicrosoft.com or a GUID" autoComplete="off" />
                        </div>
                        <div className="grid gap-1">
                            <Label htmlFor="mb-client" className="text-sm">Application (client) ID</Label>
                            <Input id="mb-client" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="00000000-0000-0000-0000-000000000000" autoComplete="off" />
                        </div>
                        <div className="grid gap-1 sm:col-span-2">
                            <Label htmlFor="mb-secret" className="text-sm">Client secret</Label>
                            <Input id="mb-secret" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={st.hasClientSecret ? "Saved. Type a new one to replace it." : "Paste the secret value"} autoComplete="new-password" />
                        </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                        <Button size="sm" disabled={!!busy} onClick={() => save({ tenantId: tenant, clientId, ...(secret ? { clientSecret: secret } : {}) }, "Saved")}>Save</Button>
                        <Button size="sm" variant="outline" disabled={!!busy || !microsoftSaved} onClick={connect}>
                            <Plug className="mr-1.5 h-3.5 w-3.5" aria-hidden /> {st.connected ? "Connect again" : "Connect"}
                        </Button>
                    </div>
                    {st.connected && !st.enabled ? <p className="text-xs text-muted-foreground">Connected. Turn the mailbox on above to start reading mail.</p> : null}
                </div>
            ) : (
                <div className="grid gap-2 rounded-xl border border-border/70 bg-card p-5 shadow-sm text-sm">
                    <div className="font-medium">IMAP login</div>
                    {st.imapReady ? (
                        <p className="text-xs text-muted-foreground">
                            The IMAP login saved for <b>Tickets (support mailbox)</b> in the SMTP tab will be used to read mail, and its SMTP login to send replies. Turn the mailbox on to start.
                        </p>
                    ) : (
                        <p className="text-xs text-muted-foreground">
                            Open the <b>SMTP</b> tab, choose <b>Tickets (support mailbox)</b>, and fill in the IMAP server, username and password (and the SMTP login if replies should be emailed). Then come back here and turn the mailbox on.
                        </p>
                    )}
                    {!st.enabled && st.imapReady ? (
                        <div><Button size="sm" disabled={!!busy} onClick={() => save({ source: "imap", enabled: true }, "Mailbox turned on")}>Turn on</Button></div>
                    ) : null}
                </div>
            )}
        </div>
    );
}
