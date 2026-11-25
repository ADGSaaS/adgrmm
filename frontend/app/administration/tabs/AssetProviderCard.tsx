"use client";

// Administration > Integrations > Assets: who owns assets. RemoteIQ has a built-in asset manager. When another system (the owner's Killian
// software) takes over assets, the built-in one is switched off: its list, the agent fill-in and the expiry emails stop, reports fall back
// to what agents report, and NOTHING is deleted, so switching back brings everything back. Only a person with the right to manage
// integrations (the Owner) can switch; everyone else sees who owns assets.
import * as React from "react";
import { Boxes, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { assetProvider, type AssetPreflight, type AssetProviderInfo } from "@/lib/assets-provider-api";
import type { ToastFn } from "../types";

const messageOf = (e: unknown) => {
    const raw = e instanceof Error ? e.message : "Something went wrong.";
    try { const j = JSON.parse(raw) as { message?: string | string[] | { message?: string } }; const m = j.message; return Array.isArray(m) ? m.join(" ") : typeof m === "object" && m ? m.message ?? raw : m ?? raw; } catch { return raw; }
};

export default function AssetProviderCard({ push }: { push: ToastFn }) {
    const [info, setInfo] = React.useState<AssetProviderInfo | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [open, setOpen] = React.useState(false);
    const [target, setTarget] = React.useState<"builtin" | "external">("external");
    const [pre, setPre] = React.useState<AssetPreflight | null>(null);
    const [name, setName] = React.useState("");
    const [url, setUrl] = React.useState("");
    const [ack, setAck] = React.useState(false);
    const [busy, setBusy] = React.useState(false);
    const [formError, setFormError] = React.useState<string | null>(null);

    const load = React.useCallback(async () => {
        try { setInfo(await assetProvider.get()); setError(null); } catch (e) { setError(messageOf(e)); }
    }, []);
    React.useEffect(() => { void load(); }, [load]);

    const begin = async (to: "builtin" | "external") => {
        setTarget(to); setAck(false); setFormError(null); setPre(null);
        setName(info?.externalName ?? ""); setUrl(info?.externalUrl ?? "");
        setOpen(true);
        try { setPre(await assetProvider.preflight()); } catch (e) { setFormError(messageOf(e)); }
    };
    const exportAs = async (format: "json" | "csv") => {
        try { await assetProvider.download(format); } catch (e) { push({ title: "Could not export the assets", desc: messageOf(e), kind: "destructive" }); }
    };
    const confirm = async () => {
        setBusy(true); setFormError(null);
        try {
            const next = await assetProvider.switchTo({ provider: target, confirm: true, ...(target === "external" ? { externalName: name.trim(), externalUrl: url.trim() || undefined } : {}) });
            setInfo(next); setOpen(false);
            push({ title: target === "external" ? `Assets are now managed in ${next.externalName}` : "The built-in asset manager is back on", desc: target === "external" ? "The built-in asset list, the agent fill-in and the expiry emails are off. Nothing was deleted." : "The agent fill-in runs again within the hour.", kind: "success" });
        } catch (e) { setFormError(messageOf(e)); } finally { setBusy(false); }
    };

    const external = info?.provider === "external";
    return (
        <section id="assets" aria-labelledby="assets-h" className="grid scroll-mt-4 gap-3 rounded-xl border border-border/70 bg-card p-5 shadow-sm" data-testid="asset-provider-card">
            <div>
                <h2 id="assets-h" className="flex items-center gap-2 text-xl font-semibold tracking-tight"><Boxes className="h-5 w-5" aria-hidden /> Assets</h2>
                <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
                    RemoteIQ has a built-in asset manager. If another system, such as Killian, manages your assets, switch the built-in one off so only one is in use. Switching deletes nothing and can be undone.
                </p>
            </div>
            {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
            {!info ? <div className="p-2 text-sm text-muted-foreground">Loading…</div> : (
                <div className="rounded-lg border bg-card p-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                            <p className="font-medium">{external ? `Managed in ${info.externalName}` : "Managed by the built-in asset manager"}</p>
                            <p className="text-sm text-muted-foreground">
                                {external
                                    ? <>The built-in asset list, the fill-in from agents and the expiry emails are off.{info.externalUrl ? <> <a className="text-primary underline-offset-2 hover:underline" href={info.externalUrl} target="_blank" rel="noreferrer noopener">Open {info.externalName}</a>.</> : null}{info.changedAt ? ` Switched ${new Date(info.changedAt).toLocaleString()}.` : ""}</>
                                    : "Assets are filled in from agents every hour, entered by hand, and checked for expiring warranties and licences."}
                            </p>
                        </div>
                        {info.canSwitch ? (
                            <div className="flex flex-wrap gap-2">
                                <Button variant="outline" size="sm" className="gap-1" onClick={() => void exportAs("csv")}><Download className="h-4 w-4" aria-hidden />Export CSV</Button>
                                <Button variant="outline" size="sm" className="gap-1" onClick={() => void exportAs("json")}><Download className="h-4 w-4" aria-hidden />Export JSON</Button>
                                {external ? <Button size="sm" onClick={() => void begin("builtin")}>Switch back to the built-in asset manager</Button> : <Button size="sm" onClick={() => void begin("external")}>Manage assets somewhere else</Button>}
                            </div>
                        ) : <p className="text-xs text-muted-foreground">Only a person with the right to manage integrations can change this.</p>}
                    </div>
                </div>
            )}

            <Dialog open={open} onOpenChange={(o) => !busy && setOpen(o)}>
                <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
                    <DialogHeader>
                        <DialogTitle>{target === "external" ? "Manage assets somewhere else?" : "Switch back to the built-in asset manager?"}</DialogTitle>
                        <DialogDescription>
                            {target === "external"
                                ? "Do this when another system is now the one place your assets live. Export the assets first if you want to import them there."
                                : "The built-in asset manager takes over again, with the records it already has. Anything that changed in the other system in the meantime is not copied back."}
                        </DialogDescription>
                    </DialogHeader>
                    {pre ? (
                        <div className="grid gap-2 text-sm">
                            <p><strong>{pre.assets}</strong> built-in {pre.assets === 1 ? "asset" : "assets"} ({pre.fromAgents} from agents, {pre.enteredByHand} entered by hand), {pre.withWarrantyDate} with a warranty or licence date, {pre.expiringWithin30Days} ending within 30 days. {pre.linkedHosts + pre.linkedSnmpDevices} found hosts and SNMP devices point at an asset.</p>
                            {target === "external" ? (
                                <>
                                    <div><p className="font-medium">This stops</p><ul className="list-disc pl-5 text-muted-foreground">{pre.willStop.map((t) => <li key={t}>{t}</li>)}</ul></div>
                                    <div><p className="font-medium">This keeps</p><ul className="list-disc pl-5 text-muted-foreground">{pre.staysTheSame.map((t) => <li key={t}>{t}</li>)}</ul></div>
                                </>
                            ) : null}
                        </div>
                    ) : !formError ? <p className="text-sm text-muted-foreground">Counting what this changes…</p> : null}
                    {target === "external" ? (
                        <div className="grid gap-3">
                            <div className="grid gap-1"><Label htmlFor="ap-name">What is the other system called?</Label><Input id="ap-name" value={name} maxLength={60} placeholder="Killian" onChange={(e) => setName(e.target.value)} /></div>
                            <div className="grid gap-1"><Label htmlFor="ap-url">Where is it? (optional web address, used for links)</Label><Input id="ap-url" value={url} placeholder="https://" onChange={(e) => setUrl(e.target.value)} /></div>
                        </div>
                    ) : null}
                    <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="h-4 w-4 shrink-0 rounded border-input accent-primary" checked={ack} onChange={(e) => setAck(e.target.checked)} />I understand what this changes. It is recorded in the audit log with my name.</label>
                    {formError ? <p role="alert" className="text-sm text-destructive">{formError}</p> : null}
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
                        <Button onClick={() => void confirm()} disabled={busy || !ack || !pre || (target === "external" && !name.trim())}>{busy ? "Switching…" : target === "external" ? "Switch assets off here" : "Switch back"}</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </section>
    );
}
