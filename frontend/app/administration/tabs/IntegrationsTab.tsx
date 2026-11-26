"use client";

// Integrations: the connections this product really has to things outside it, each with its true state read from the
// real settings (nothing here is a switch) and a link to where it is set up; and outbound webhooks, which are managed
// right here because that is the only place they exist.
import * as React from "react";
import { CheckCircle2, CircleSlash, ExternalLink, History, KeyRound, Pencil, Plug, Plus, RefreshCw, Send, Trash2, TriangleAlert, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { jfetch } from "@/lib/api";
import type { ToastFn } from "../types";
import AssetProviderCard from "./AssetProviderCard";

const messageOf = (e: unknown) => {
    const raw = e instanceof Error ? e.message : "Something went wrong.";
    try { const j = JSON.parse(raw) as { message?: string | string[] }; return Array.isArray(j.message) ? j.message.join(" ") : j.message ?? raw; } catch { return raw; }
};

const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : "");

/* ------------------------------ the cards ------------------------------ */

type Status = "ok" | "attention" | "error" | "off";
type Card = {
    key: string; name: string; description: string; status: Status; statusLabel: string; detail: string | null;
    last: { at: string | null; ok: boolean; message: string } | null;
    link: { label: string; tab?: string; href?: string };
};

const TONE: Record<Status, { icon: React.ReactNode; cls: string }> = {
    ok: { icon: <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />, cls: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" },
    attention: { icon: <TriangleAlert className="h-3.5 w-3.5" aria-hidden />, cls: "bg-amber-500/10 text-amber-600 dark:text-amber-400" },
    error: { icon: <XCircle className="h-3.5 w-3.5" aria-hidden />, cls: "bg-red-500/10 text-red-600 dark:text-red-400" },
    off: { icon: <CircleSlash className="h-3.5 w-3.5" aria-hidden />, cls: "bg-muted text-muted-foreground" },
};

function CardView({ c }: { c: Card }) {
    const tone = TONE[c.status];
    const href = c.link.tab ? `/administration?tab=${encodeURIComponent(c.link.tab)}` : c.link.href ?? "#";
    const inPage = href.startsWith("#");
    return (
        <li className="flex flex-col rounded-lg border bg-card p-4">
            <div className="flex items-start justify-between gap-2">
                <h3 className="font-medium">{c.name}</h3>
                <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${tone.cls}`}>{tone.icon}{c.statusLabel}</span>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">{c.description}</p>
            {c.detail ? <p className="mt-2 text-sm">{c.detail}</p> : null}
            {c.last ? (
                <p className={`mt-1 text-xs ${c.last.ok ? "text-muted-foreground" : "text-red-600 dark:text-red-400"}`}>
                    {c.last.ok ? "Last result: " : "Last problem: "}{c.last.message}{c.last.at ? ` (${when(c.last.at)})` : ""}
                </p>
            ) : null}
            <div className="mt-auto pt-3">
                <a
                    href={href}
                    onClick={inPage ? (e) => { e.preventDefault(); document.getElementById(href.slice(1))?.scrollIntoView({ behavior: "smooth", block: "start" }); } : undefined}
                    className="inline-flex items-center gap-1 text-sm font-medium text-primary underline-offset-2 hover:underline"
                >
                    {c.link.label} <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                </a>
            </div>
        </li>
    );
}

export default function IntegrationsTab({ push }: { push: ToastFn }) {
    const [cards, setCards] = React.useState<Card[] | null>(null);
    const [checkedAt, setCheckedAt] = React.useState<string | null>(null);
    const [loading, setLoading] = React.useState(false);

    const load = React.useCallback(async () => {
        setLoading(true);
        try {
            const r = await jfetch<{ items: Card[]; checkedAt: string }>("/api/admin/integrations");
            setCards(r.items);
            setCheckedAt(r.checkedAt);
        } catch (e) {
            setCards((c) => c ?? []);
            push({ title: "Could not load the integrations", desc: messageOf(e), kind: "destructive" });
        } finally {
            setLoading(false);
        }
    }, [push]);
    React.useEffect(() => { void load(); }, [load]);

    return (
        <div className="grid w-full min-w-0 gap-6">
            <section aria-labelledby="int-h" className="grid gap-3 rounded-xl border border-border/70 bg-card p-5 shadow-sm">
                <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                        <h2 id="int-h" className="flex items-center gap-2 text-xl font-semibold tracking-tight"><Plug className="h-5 w-5" aria-hidden /> Integrations</h2>
                        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
                            What this product is connected to, and how each connection is doing right now, read from your real settings. Each one is changed where it is set up: use its link.
                        </p>
                    </div>
                    <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}><RefreshCw className={`mr-1.5 h-4 w-4 ${loading ? "animate-spin" : ""}`} aria-hidden /> Check again</Button>
                </div>
                {!cards ? <div className="p-4 text-sm text-muted-foreground">Loading…</div> : (
                    <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{cards.map((c) => <CardView key={c.key} c={c} />)}</ul>
                )}
                {checkedAt ? <p className="text-xs text-muted-foreground">Checked {when(checkedAt)}. Connections to other tools, such as a CRM or a documentation and password app, are not built yet; webhooks and personal tokens are how they will connect.</p> : null}
            </section>

            <AssetProviderCard push={push} />

            <Webhooks push={push} onChanged={load} />
        </div>
    );
}

/* ------------------------------ webhooks ------------------------------ */

const FORMAT_NAME: Record<string, string> = { adgrmm: "ADG RMM signed JSON", slack: "Slack message", discord: "Discord message", teams: "Microsoft Teams card" };

type EventDef = { key: string; label: string; description: string };
type Hook = {
    id: string; name: string; url: string; events: string[]; enabled: boolean; format: string; sends: "adgrmm" | "slack" | "discord" | "teams";
    last: { status: string; event: string; at: string; responseStatus: number | null; error: string | null } | null;
    pending: number; failedLast24h: number; deliveredLast24h: number;
};
type Delivery = { id: string; event: string; status: string; attempts: number; responseStatus: number | null; error: string | null; createdAt: string; deliveredAt: string | null; nextAttemptAt: string | null };

function Webhooks({ push, onChanged }: { push: ToastFn; onChanged: () => Promise<void> }) {
    const [hooks, setHooks] = React.useState<Hook[] | null>(null);
    const [events, setEvents] = React.useState<EventDef[]>([]);
    const [editing, setEditing] = React.useState<Hook | "new" | null>(null);
    const [secret, setSecret] = React.useState<{ name: string; value: string } | null>(null);
    const [logFor, setLogFor] = React.useState<Hook | null>(null);
    const [busy, setBusy] = React.useState<string | null>(null);

    const load = React.useCallback(async () => {
        try {
            const r = await jfetch<{ items: Hook[]; events: EventDef[] }>("/api/admin/webhooks");
            setHooks(r.items);
            setEvents(r.events);
        } catch (e) {
            setHooks((h) => h ?? []);
            push({ title: "Could not load webhooks", desc: messageOf(e), kind: "destructive" });
        }
    }, [push]);
    React.useEffect(() => { void load(); }, [load]);

    const changed = async () => { await load(); await onChanged(); };

    async function toggle(h: Hook) {
        setBusy(h.id);
        try {
            await jfetch(`/api/admin/webhooks/${h.id}`, { method: "PATCH", body: { enabled: !h.enabled } });
            await changed();
        } catch (e) {
            push({ title: "Could not change the webhook", desc: messageOf(e), kind: "destructive" });
        } finally {
            setBusy(null);
        }
    }

    async function test(h: Hook) {
        setBusy(h.id);
        try {
            const r = await jfetch<{ ok: boolean; message: string }>(`/api/admin/webhooks/${h.id}/test`, { method: "POST" });
            push({ title: r.ok ? "Test delivered" : "Test failed", desc: r.message, kind: r.ok ? "success" : "destructive" });
            await changed();
        } catch (e) {
            push({ title: "Could not send the test", desc: messageOf(e), kind: "destructive" });
        } finally {
            setBusy(null);
        }
    }

    async function remove(h: Hook) {
        if (!window.confirm(`Delete the webhook "${h.name}" and its delivery log? Events that were waiting to be sent to it are dropped.`)) return;
        setBusy(h.id);
        try {
            await jfetch(`/api/admin/webhooks/${h.id}`, { method: "DELETE" });
            await changed();
        } catch (e) {
            push({ title: "Could not delete", desc: messageOf(e), kind: "destructive" });
        } finally {
            setBusy(null);
        }
    }

    const eventLabel = (k: string) => events.find((e) => e.key === k)?.label ?? k;

    return (
        <section id="webhooks" aria-labelledby="wh-h" className="grid scroll-mt-4 gap-3 rounded-xl border border-border/70 bg-card p-5 shadow-sm">
            <div>
                <h2 id="wh-h" className="text-lg font-semibold">Outbound webhooks</h2>
                <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
                    Send an event to Slack, Microsoft Teams or Discord as a message people can read, or a signed copy to an address you control, such as an automation service or your own system. A failed delivery is tried again for about a day, and every attempt is kept in a log.
                </p>
                <details className="mt-2 max-w-3xl text-sm">
                    <summary className="cursor-pointer font-medium">How to check a delivery is genuine</summary>
                    <div className="mt-2 grid gap-1 text-muted-foreground">
                        <p>Each delivery is an HTTP POST with a JSON body and these headers: <code>X-ADG-Event</code>, <code>X-ADG-Delivery</code> (a unique id), <code>X-ADG-Timestamp</code> (seconds) and <code>X-ADG-Signature</code>.</p>
                        <p>The signature is <code>sha256=</code> followed by the HMAC-SHA256, in hex, of <code>{"<timestamp>.<raw body>"}</code>, keyed with the webhook&apos;s signing secret. Compute it yourself, compare, and refuse a timestamp more than five minutes old. Answer with any 2xx status to say it arrived.</p>
                    </div>
                </details>
            </div>
            <div><Button size="sm" onClick={() => setEditing("new")}><Plus className="mr-1.5 h-4 w-4" aria-hidden /> New webhook</Button></div>

            {!hooks ? <div className="p-4 text-sm text-muted-foreground">Loading…</div> : hooks.length === 0 ? (
                <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">No webhooks yet.</p>
            ) : (
                <ul className="grid gap-2">
                    {hooks.map((h) => (
                        <li key={h.id} className="rounded-lg border bg-card p-3">
                            <div className="flex flex-wrap items-start justify-between gap-2">
                                <div className="min-w-0">
                                    <div className="flex flex-wrap items-center gap-2">
                                        <span className="font-medium">{h.name}</span>
                                        <span className={`rounded-full px-2 py-0.5 text-xs ${h.enabled ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "bg-muted text-muted-foreground"}`}>{h.enabled ? "On" : "Off"}</span>
                                    </div>
                                    <div className="truncate text-sm text-muted-foreground" title={h.url}>{h.url}</div>
                                    <div className="text-xs text-muted-foreground">Sends: {FORMAT_NAME[h.sends] ?? h.sends}{h.format === "auto" ? " (from the address)" : ""}</div>
                                    <div className="mt-1 flex flex-wrap gap-1">
                                        {h.events.map((e) => <span key={e} className="rounded-full border px-2 py-0.5 text-xs">{eventLabel(e)}</span>)}
                                    </div>
                                    <div className="mt-1 text-xs text-muted-foreground">
                                        {h.last ? (
                                            <span className={h.last.status === "failed" ? "text-red-600 dark:text-red-400" : ""}>
                                                Last delivery: {h.last.status === "delivered" ? "delivered" : `failed (${h.last.error ?? "no answer"})`} {when(h.last.at)}.
                                            </span>
                                        ) : "Nothing has been sent yet."}
                                        {" "}{h.deliveredLast24h} delivered and {h.failedLast24h} failed in the last 24 hours{h.pending ? `; ${h.pending} waiting` : ""}.
                                    </div>
                                </div>
                                <div className="flex flex-wrap items-center gap-1">
                                    <Button size="sm" variant="outline" disabled={busy === h.id} onClick={() => void test(h)}><Send className="mr-1.5 h-3.5 w-3.5" aria-hidden /> Test</Button>
                                    <Button size="sm" variant="outline" onClick={() => setLogFor(h)}><History className="mr-1.5 h-3.5 w-3.5" aria-hidden /> Log</Button>
                                    <Button size="sm" variant="outline" disabled={busy === h.id} onClick={() => void toggle(h)}>{h.enabled ? "Turn off" : "Turn on"}</Button>
                                    <Button size="icon" variant="ghost" aria-label={`Edit ${h.name}`} onClick={() => setEditing(h)}><Pencil className="h-4 w-4" /></Button>
                                    <Button size="icon" variant="ghost" aria-label={`Delete ${h.name}`} disabled={busy === h.id} onClick={() => void remove(h)}><Trash2 className="h-4 w-4" /></Button>
                                </div>
                            </div>
                        </li>
                    ))}
                </ul>
            )}

            <HookDialog
                editing={editing}
                events={events}
                onClose={() => setEditing(null)}
                onSaved={async (revealed) => { setEditing(null); if (revealed) setSecret(revealed); await changed(); }}
                push={push}
            />
            <SecretDialog secret={secret} onClose={() => setSecret(null)} />
            <LogDialog hook={logFor} onClose={() => setLogFor(null)} />
        </section>
    );
}

function HookDialog({ editing, events, onClose, onSaved, push }: { editing: Hook | "new" | null; events: EventDef[]; onClose: () => void; onSaved: (revealed?: { name: string; value: string }) => Promise<void>; push: ToastFn }) {
    const isNew = editing === "new";
    const [name, setName] = React.useState("");
    const [url, setUrl] = React.useState("");
    const [chosen, setChosen] = React.useState<string[]>([]);
    const [format, setFormat] = React.useState("auto");
    const [saving, setSaving] = React.useState(false);
    const [tried, setTried] = React.useState(false);

    React.useEffect(() => {
        if (!editing) return;
        setTried(false);
        const h = editing === "new" ? null : editing;
        setName(h?.name ?? ""); setUrl(h?.url ?? ""); setChosen(h?.events ?? ["ticket.created", "alert.opened"]); setFormat(h?.format ?? "auto");
    }, [editing]);

    const nameOk = name.trim().length > 0;
    const urlOk = /^https?:\/\/\S+$/i.test(url.trim());
    const eventsOk = chosen.length > 0;

    async function save() {
        setTried(true);
        if (!nameOk || !urlOk || !eventsOk) return;
        setSaving(true);
        try {
            const body = { name, url: url.trim(), events: chosen, format };
            if (isNew) {
                const r = await jfetch<{ signingSecret: string }>("/api/admin/webhooks", { method: "POST", body });
                push({ title: "Webhook added", kind: "success" });
                await onSaved({ name, value: r.signingSecret });
            } else {
                await jfetch(`/api/admin/webhooks/${(editing as Hook).id}`, { method: "PATCH", body });
                push({ title: "Webhook saved", kind: "success" });
                await onSaved();
            }
        } catch (e) {
            push({ title: "Could not save the webhook", desc: messageOf(e), kind: "destructive" });
        } finally {
            setSaving(false);
        }
    }

    async function rotate() {
        if (editing === "new" || !editing) return;
        if (!window.confirm("Replace the signing secret? The old one stops working at once, so update whatever checks the signature.")) return;
        setSaving(true);
        try {
            const r = await jfetch<{ signingSecret: string }>(`/api/admin/webhooks/${editing.id}`, { method: "PATCH", body: { rotateSecret: true } });
            await onSaved({ name: editing.name, value: r.signingSecret });
        } catch (e) {
            push({ title: "Could not replace the secret", desc: messageOf(e), kind: "destructive" });
        } finally {
            setSaving(false);
        }
    }

    return (
        <Dialog open={!!editing} onOpenChange={(o) => { if (!o) onClose(); }}>
            <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
                <DialogHeader>
                    <DialogTitle>{isNew ? "New webhook" : "Edit webhook"}</DialogTitle>
                    <DialogDescription>{isNew ? "You will be shown the signing secret once, after you save." : "The signing secret is not shown again; replace it below if you need a new one."}</DialogDescription>
                </DialogHeader>
                <div className="grid gap-3">
                    <div className="grid gap-1">
                        <Label htmlFor="wh-name" className={tried && !nameOk ? "text-destructive" : ""}>Name</Label>
                        <Input id="wh-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} aria-invalid={tried && !nameOk} placeholder="For example: Ops chat" autoFocus />
                    </div>
                    <div className="grid gap-1">
                        <Label htmlFor="wh-url" className={tried && !urlOk ? "text-destructive" : ""}>Address</Label>
                        <Input id="wh-url" value={url} onChange={(e) => setUrl(e.target.value)} aria-invalid={tried && !urlOk} placeholder="https://example.com/hooks/adgrmm" />
                        <p className="text-xs text-muted-foreground">Must be https, and cannot point at a private network address (unless the server allows it).</p>
                    </div>
                    <div className="grid gap-1">
                        <Label htmlFor="wh-format">Message</Label>
                        <select id="wh-format" className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={format} onChange={(e) => setFormat(e.target.value)}>
                            <option value="auto">Decide from the address (Slack, Discord and Teams addresses get a chat message)</option>
                            <option value="slack">A Slack message</option>
                            <option value="teams">A Microsoft Teams card</option>
                            <option value="discord">A Discord message</option>
                            <option value="adgrmm">ADG RMM&apos;s signed JSON (for your own system or an automation service)</option>
                        </select>
                        <p className="text-xs text-muted-foreground">Chat services only accept their own kind of message, so use the Slack, Teams or Discord choice for their incoming-webhook addresses.</p>
                    </div>
                    <fieldset className="grid gap-2">
                        <legend className={`text-sm font-medium ${tried && !eventsOk ? "text-destructive" : ""}`}>Events to send</legend>
                        {events.map((ev) => (
                            <label key={ev.key} className="flex items-start gap-2 text-sm">
                                <input type="checkbox" className="h-4 w-4 shrink-0 rounded border-input accent-primary" checked={chosen.includes(ev.key)} onChange={(e) => setChosen((c) => (e.target.checked ? [...c, ev.key] : c.filter((k) => k !== ev.key)))} />
                                <span>{ev.label}<span className="block text-xs text-muted-foreground">{ev.description}</span></span>
                            </label>
                        ))}
                    </fieldset>
                    {!isNew ? <div><Button type="button" variant="outline" size="sm" onClick={() => void rotate()} disabled={saving}><KeyRound className="mr-1.5 h-3.5 w-3.5" aria-hidden /> Replace the signing secret</Button></div> : null}
                </div>
                <DialogFooter>
                    <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
                    <Button onClick={() => void save()} disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function SecretDialog({ secret, onClose }: { secret: { name: string; value: string } | null; onClose: () => void }) {
    const [copied, setCopied] = React.useState(false);
    React.useEffect(() => { if (secret) setCopied(false); }, [secret]);
    return (
        <Dialog open={!!secret} onOpenChange={(o) => { if (!o) onClose(); }}>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle>Signing secret for {secret?.name}</DialogTitle>
                    <DialogDescription>Copy it now. For safety it is not shown again; if you lose it, replace it with a new one.</DialogDescription>
                </DialogHeader>
                <code className="block break-all rounded-md border bg-muted/40 p-3 text-sm" data-testid="signing-secret">{secret?.value}</code>
                <DialogFooter>
                    <Button variant="outline" onClick={async () => { try { await navigator.clipboard.writeText(secret?.value ?? ""); setCopied(true); } catch { setCopied(false); } }}>{copied ? "Copied" : "Copy"}</Button>
                    <Button onClick={onClose}>I have saved it</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function LogDialog({ hook, onClose }: { hook: Hook | null; onClose: () => void }) {
    const [rows, setRows] = React.useState<Delivery[] | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    React.useEffect(() => {
        if (!hook) return;
        setRows(null);
        setError(null);
        jfetch<{ items: Delivery[] }>(`/api/admin/webhooks/${hook.id}/deliveries`).then((r) => setRows(r.items)).catch((e) => setError(messageOf(e)));
    }, [hook]);
    return (
        <Dialog open={!!hook} onOpenChange={(o) => { if (!o) onClose(); }}>
            <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
                <DialogHeader>
                    <DialogTitle>Deliveries to {hook?.name}</DialogTitle>
                    <DialogDescription>The latest 50. Deliveries older than 30 days are removed.</DialogDescription>
                </DialogHeader>
                {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : !rows ? <p className="text-sm text-muted-foreground">Loading…</p> : rows.length === 0 ? <p className="text-sm text-muted-foreground">Nothing has been sent yet.</p> : (
                    <div className="overflow-x-auto rounded-lg border">
                        <table className="w-full min-w-[560px] text-sm">
                            <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                                <tr><th className="p-2 font-medium">When</th><th className="p-2 font-medium">Event</th><th className="p-2 font-medium">Result</th><th className="p-2 font-medium">Attempts</th></tr>
                            </thead>
                            <tbody className="divide-y">
                                {rows.map((d) => (
                                    <tr key={d.id}>
                                        <td className="p-2 whitespace-nowrap">{when(d.createdAt)}</td>
                                        <td className="p-2 font-mono text-xs">{d.event}</td>
                                        <td className="p-2">
                                            {d.status === "delivered" ? <span className="text-emerald-600 dark:text-emerald-400">Delivered{d.responseStatus ? ` (${d.responseStatus})` : ""}</span>
                                                : d.status === "pending" ? <span className="text-amber-600 dark:text-amber-400">Waiting, next try {when(d.nextAttemptAt)}{d.error ? ` - ${d.error}` : ""}</span>
                                                    : <span className="text-red-600 dark:text-red-400">Failed{d.error ? ` - ${d.error}` : ""}</span>}
                                        </td>
                                        <td className="p-2">{d.attempts}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
                <DialogFooter><Button onClick={onClose}>Close</Button></DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
