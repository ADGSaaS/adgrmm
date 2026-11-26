// components/alert-settings.tsx
"use client";

import * as React from "react";
import { Mail, Plus, Trash2, Webhook } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/use-toast";
import {
    createChannel,
    deleteChannel,
    fetchAlertSettings,
    fetchChannels,
    saveAlertSettings,
    testChannel,
    WEBHOOK_FORMAT_LABEL,
    type WebhookFormat,
    type WebhookFormatChoice,
    updateChannel,
    type AlertSettings,
    type ChannelWrite,
    type AlertSeverity,
    type NotificationChannel,
} from "@/lib/alerts-api";

const errorText = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong.");

function SeveritySelect({ id, value, onChange }: { id?: string; value: AlertSeverity; onChange: (v: AlertSeverity) => void }) {
    return (
        <select id={id} value={value} onChange={(e) => onChange(e.target.value as AlertSeverity)} className="h-9 rounded-md border bg-background px-2 text-sm">
            <option value="WARN">Warnings and critical</option>
            <option value="CRIT">Critical only</option>
        </select>
    );
}

/** The message format of a webhook: Automatic (from the address) or one chosen by hand. */
function FormatSelect({ id, value, address, onChange }: { id?: string; value: WebhookFormatChoice; address: string | null; onChange: (v: WebhookFormatChoice) => void }) {
    const detected = address ? webhookFormatGuess(address) : null;
    return (
        <select id={id} value={value} onChange={(e) => onChange(e.target.value as WebhookFormatChoice)} className="h-9 rounded-md border bg-background px-2 text-sm" aria-label="Message format">
            <option value="auto">Automatic{detected ? ` (${WEBHOOK_FORMAT_LABEL[detected]})` : ""}</option>
            {(Object.keys(WEBHOOK_FORMAT_LABEL) as WebhookFormat[]).map((f) => <option key={f} value={f}>{WEBHOOK_FORMAT_LABEL[f]}</option>)}
        </select>
    );
}

/** The same guess the server makes from the address, only to label "Automatic". */
function webhookFormatGuess(raw: string): WebhookFormat {
    let u: URL;
    try { u = new URL(raw); } catch { return "adgrmm"; }
    const h = u.hostname.toLowerCase();
    if (h === "hooks.slack.com" || h.endsWith(".slack.com")) return "slack";
    if ((h === "discord.com" || h === "discordapp.com" || h.endsWith(".discord.com")) && /^\/api\/webhooks\//i.test(u.pathname)) return "discord";
    if (h.endsWith(".webhook.office.com") || h === "outlook.office.com" || h.endsWith(".logic.azure.com") || h.endsWith(".powerplatform.com")) return "teams";
    return "adgrmm";
}

function AddChannelDialog({ open, onOpenChange, onAdded }: { open: boolean; onOpenChange: (v: boolean) => void; onAdded: () => void }) {
    const [kind, setKind] = React.useState<"email" | "webhook">("email");
    const [name, setName] = React.useState("");
    const [target, setTarget] = React.useState("");
    const [minSeverity, setMinSeverity] = React.useState<AlertSeverity>("WARN");
    const [format, setFormat] = React.useState<WebhookFormatChoice>("auto");
    const [saving, setSaving] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const [secret, setSecret] = React.useState<string | null>(null);

    const close = () => {
        setName("");
        setTarget("");
        setFormat("auto");
        setError(null);
        setSecret(null);
        onOpenChange(false);
    };

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        setSaving(true);
        setError(null);
        try {
            const created = await createChannel({
                name,
                kind,
                minSeverity,
                ...(kind === "email" ? { recipients: target.split(/[,;\s]+/).filter(Boolean) } : { url: target, ...(format !== "auto" ? { format } : {}) }),
            });
            onAdded();
            if (created.signingSecret) setSecret(created.signingSecret);
            else close();
        } catch (err) {
            setError(errorText(err));
        } finally {
            setSaving(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={(v) => (v ? onOpenChange(true) : close())}>
            <DialogContent>
                {secret ? (
                    <>
                        <DialogHeader>
                            <DialogTitle>Save this signing secret</DialogTitle>
                            <DialogDescription>
                                It will not be shown again. Use it to check the <code>X-ADG-Signature</code> header, an HMAC-SHA256 of the timestamp header, a dot, and the body.
                            </DialogDescription>
                        </DialogHeader>
                        <code className="block break-all rounded bg-muted p-2 text-xs">{secret}</code>
                        <DialogFooter>
                            <Button onClick={close}>Done</Button>
                        </DialogFooter>
                    </>
                ) : (
                    <form onSubmit={submit} className="space-y-4">
                        <DialogHeader>
                            <DialogTitle>Add a notification channel</DialogTitle>
                            <DialogDescription>Choose where alerts should go.</DialogDescription>
                        </DialogHeader>
                        <div className="grid gap-2">
                            <Label htmlFor="channel-kind">Type</Label>
                            <select
                                id="channel-kind"
                                value={kind}
                                onChange={(e) => {
                                    setKind(e.target.value as "email" | "webhook");
                                    setTarget("");
                                }}
                                className="h-9 rounded-md border bg-background px-2 text-sm"
                            >
                                <option value="email">Email</option>
                                <option value="webhook">Webhook</option>
                            </select>
                        </div>
                        <div className="grid gap-2">
                            <Label htmlFor="channel-name">Name</Label>
                            <Input id="channel-name" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === "email" ? "On-call team" : "Operations webhook"} />
                        </div>
                        <div className="grid gap-2">
                            <Label htmlFor="channel-target">{kind === "email" ? "Email addresses" : "Address"}</Label>
                            <Input
                                id="channel-target"
                                required
                                value={target}
                                onChange={(e) => setTarget(e.target.value)}
                                placeholder={kind === "email" ? "alerts@example.com, oncall@example.com" : "https://example.com/hooks/adgrmm"}
                            />
                        </div>
                        {kind === "webhook" ? (
                            <div className="grid gap-2">
                                <Label htmlFor="channel-format">Message format</Label>
                                <FormatSelect id="channel-format" value={format} address={target} onChange={setFormat} />
                                <p className="text-xs text-muted-foreground">Chat services only accept their own format. Automatic picks Slack, Discord or Teams from the address, and anything else gets ADG RMM&apos;s own signed JSON.</p>
                            </div>
                        ) : null}
                        <div className="grid gap-2">
                            <Label htmlFor="channel-severity">Send</Label>
                            <SeveritySelect id="channel-severity" value={minSeverity} onChange={setMinSeverity} />
                        </div>
                        {error ? <p className="text-sm text-destructive">{error}</p> : null}
                        <DialogFooter>
                            <Button type="button" variant="outline" onClick={close}>Cancel</Button>
                            <Button type="submit" disabled={saving}>{saving ? "Adding…" : "Add channel"}</Button>
                        </DialogFooter>
                    </form>
                )}
            </DialogContent>
        </Dialog>
    );
}

export default function AlertSettingsPanel() {
    const [settings, setSettings] = React.useState<AlertSettings | null>(null);
    const [channels, setChannels] = React.useState<NotificationChannel[]>([]);
    const [adding, setAdding] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);

    const loadChannels = React.useCallback(async () => {
        const { items } = await fetchChannels();
        setChannels(items);
    }, []);

    React.useEffect(() => {
        Promise.all([fetchAlertSettings().then(setSettings), loadChannels()]).catch((e) => setError(errorText(e)));
    }, [loadChannels]);

    const saveSetting = async (patch: Partial<AlertSettings>) => {
        const previous = settings;
        setSettings((s) => (s ? { ...s, ...patch } : s));
        try {
            setSettings(await saveAlertSettings(patch));
            toast({ title: "Saved", variant: "success" });
        } catch (e) {
            setSettings(previous);
            toast({ title: "That was not saved", description: errorText(e), variant: "destructive", duration: 10_000 });
        }
    };

    const changeChannel = async (channel: NotificationChannel, patch: ChannelWrite) => {
        try {
            await updateChannel(channel.id, patch);
            await loadChannels();
        } catch (e) {
            toast({ title: "That was not saved", description: errorText(e), variant: "destructive", duration: 10_000 });
        }
    };

    const test = async (channel: NotificationChannel) => {
        try {
            const result = await testChannel(channel.id);
            toast({
                title: result.ok ? `Test sent to ${channel.name}` : `Test to ${channel.name} failed`,
                description: result.ok ? undefined : result.message,
                variant: result.ok ? "success" : "destructive",
                duration: result.ok ? undefined : 10_000,
            });
        } catch (e) {
            toast({ title: "The test did not run", description: errorText(e), variant: "destructive", duration: 10_000 });
        }
    };

    const remove = async (channel: NotificationChannel) => {
        if (!window.confirm(`Delete "${channel.name}"? It will stop receiving alerts.`)) return;
        try {
            await deleteChannel(channel.id);
            await loadChannels();
            toast({ title: "Channel deleted" });
        } catch (e) {
            toast({ title: "It was not deleted", description: errorText(e), variant: "destructive", duration: 10_000 });
        }
    };

    if (error) return <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm">{error}</div>;

    return (
        <div className="grid gap-4 lg:grid-cols-2">
            <Card>
                <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0">
                    <div>
                        <CardTitle className="text-base">Notification channels</CardTitle>
                        <CardDescription>Where alerts go. Email uses the Alerts mailbox set up under Administration.</CardDescription>
                    </div>
                    <Button size="sm" className="shrink-0 gap-1.5" onClick={() => setAdding(true)}>
                        <Plus className="h-4 w-4" aria-hidden="true" />
                        Add
                    </Button>
                </CardHeader>
                <CardContent className="space-y-3">
                    {channels.length === 0 ? (
                        <p className="rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
                            No channels yet, so alerts only show on this page.
                        </p>
                    ) : null}
                    {channels.map((channel) => {
                        const Icon = channel.kind === "email" ? Mail : Webhook;
                        return (
                            <div key={channel.id} className="space-y-2 rounded-md border p-3">
                                <div className="flex items-center gap-2">
                                    <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{channel.name}</span>
                                    <Switch
                                        checked={channel.enabled}
                                        onCheckedChange={(enabled) => void changeChannel(channel, { enabled })}
                                        aria-label={`Turn ${channel.name} ${channel.enabled ? "off" : "on"}`}
                                    />
                                </div>
                                <p className="truncate text-xs text-muted-foreground">{channel.kind === "email" ? channel.recipients.join(", ") : channel.url}</p>
                                {channel.kind === "webhook" ? (
                                    <div className="flex flex-wrap items-center gap-2 text-xs">
                                        <label htmlFor={`format-${channel.id}`} className="text-muted-foreground">Message format</label>
                                        <FormatSelect id={`format-${channel.id}`} value={channel.formatChosen ?? "auto"} address={channel.url} onChange={(format) => void changeChannel(channel, { format })} />
                                    </div>
                                ) : null}
                                <div className="flex flex-wrap items-center gap-2">
                                    <SeveritySelect value={channel.minSeverity} onChange={(minSeverity) => void changeChannel(channel, { minSeverity })} />
                                    <label className="flex items-center gap-1.5 text-xs">
                                        <Checkbox checked={channel.notifyOnResolve} onCheckedChange={(v) => void changeChannel(channel, { notifyOnResolve: !!v })} />
                                        Also when resolved
                                    </label>
                                    <span className="ml-auto flex gap-1">
                                        <Button variant="outline" size="sm" className="h-8" onClick={() => void test(channel)}>Test</Button>
                                        <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Delete ${channel.name}`} title="Delete" onClick={() => void remove(channel)}>
                                            <Trash2 className="h-4 w-4" aria-hidden="true" />
                                        </Button>
                                    </span>
                                </div>
                            </div>
                        );
                    })}
                </CardContent>
            </Card>

            {settings ? (
                <Card>
                    <CardHeader>
                        <CardTitle className="text-base">Behaviour</CardTitle>
                        <CardDescription>When alerts open, and what they do.</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-5">
                        <NumberSetting
                            id="offline-minutes"
                            label="Call a device offline after"
                            unit="minutes"
                            min={5}
                            max={10080}
                            value={settings.offlineAfterMinutes}
                            onSave={(offlineAfterMinutes) => void saveSetting({ offlineAfterMinutes })}
                        />
                        <NumberSetting
                            id="renotify-hours"
                            label="Remind about open alerts every"
                            unit="hours (0 for never)"
                            min={0}
                            max={720}
                            value={settings.renotifyAfterHours}
                            onSave={(renotifyAfterHours) => void saveSetting({ renotifyAfterHours })}
                        />
                        <div className="flex items-center justify-between gap-3">
                            <Label htmlFor="auto-ticket">Open a ticket for new alerts</Label>
                            <Switch id="auto-ticket" checked={settings.autoTicket} onCheckedChange={(autoTicket) => void saveSetting({ autoTicket })} />
                        </div>
                        {settings.autoTicket ? (
                            <>
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                    <Label htmlFor="ticket-severity">For</Label>
                                    <SeveritySelect id="ticket-severity" value={settings.autoTicketMinSeverity} onChange={(autoTicketMinSeverity) => void saveSetting({ autoTicketMinSeverity })} />
                                </div>
                                <div className="flex items-center justify-between gap-3">
                                    <Label htmlFor="auto-resolve">Resolve the ticket when the alert clears, if nobody has started on it</Label>
                                    <Switch id="auto-resolve" checked={settings.autoResolveTicket} onCheckedChange={(autoResolveTicket) => void saveSetting({ autoResolveTicket })} />
                                </div>
                            </>
                        ) : null}
                    </CardContent>
                </Card>
            ) : null}

            <AddChannelDialog open={adding} onOpenChange={setAdding} onAdded={() => void loadChannels()} />
        </div>
    );
}

function NumberSetting({ id, label, unit, min, max, value, onSave }: { id: string; label: string; unit: string; min: number; max: number; value: number; onSave: (v: number) => void }) {
    const [text, setText] = React.useState(String(value));
    React.useEffect(() => setText(String(value)), [value]);

    const commit = () => {
        const parsed = Number(text);
        if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
            setText(String(value));
            toast({ title: `Enter a whole number from ${min} to ${max}`, variant: "destructive" });
            return;
        }
        if (parsed !== value) onSave(parsed);
    };

    return (
        <div className="grid gap-2">
            <Label htmlFor={id}>{label}</Label>
            <div className="flex items-center gap-2">
                <Input
                    id={id}
                    type="number"
                    min={min}
                    max={max}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    onBlur={commit}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") commit();
                    }}
                    className="h-9 w-24"
                />
                <span className="text-sm text-muted-foreground">{unit}</span>
            </div>
        </div>
    );
}
