"use client";

// Install keys: the reusable keys installers use to enroll devices into a site. See which are in use, rename them,
// and stop one working (for example when a Group Policy script has leaked, or the project is finished).
import * as React from "react";
import Link from "next/link";
import { KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { jfetch } from "@/lib/api";
import { EndpointLimitNote } from "@/components/entitlements-bar";
import type { ToastFn } from "../types";

type InstallKey = {
    id: string;
    name: string;
    clientName: string;
    siteName: string;
    createdAt: string;
    createdBy: string;
    expiresAt: string;
    revokedAt: string | null;
    lastUsedAt: string | null;
    useCount: number;
    status: "active" | "expired" | "revoked";
};

const messageOf = (e: unknown) => {
    const raw = e instanceof Error ? e.message : "Something went wrong.";
    try { const j = JSON.parse(raw) as { message?: string | string[] }; return Array.isArray(j.message) ? j.message.join(" ") : j.message ?? raw; } catch { return raw; }
};
const day = (s: string | null) => (s ? new Date(s).toLocaleDateString() : "never");
const when = (s: string | null) => (s ? new Date(s).toLocaleString() : "never");
const years = (s: string) => (new Date(s).getTime() - Date.now()) / (365 * 86_400_000);
const expiryText = (k: InstallKey) => (k.status === "expired" ? `Expired ${day(k.expiresAt)}` : years(k.expiresAt) > 9 ? "In about 10 years" : day(k.expiresAt));

const BADGE: Record<InstallKey["status"], string> = {
    active: "border-emerald-500/50 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    expired: "text-muted-foreground",
    revoked: "border-destructive/40 bg-destructive/10 text-destructive",
};

export default function InstallKeysTab({ push }: { push: ToastFn }) {
    const [items, setItems] = React.useState<InstallKey[] | null>(null);
    const [filter, setFilter] = React.useState<"active" | "all">("active");
    const [editing, setEditing] = React.useState<string | null>(null);
    const [draft, setDraft] = React.useState("");
    const [busy, setBusy] = React.useState<string | null>(null);

    const load = React.useCallback(async () => {
        try {
            setItems((await jfetch<{ items: InstallKey[] }>("/api/provisioning/enrollment-keys")).items);
        } catch (e) {
            setItems([]);
            push({ title: "Could not load install keys", desc: messageOf(e), kind: "destructive" });
        }
    }, [push]);

    React.useEffect(() => { void load(); }, [load]);

    async function revoke(k: InstallKey) {
        if (!window.confirm(`Stop the key "${k.name || "unnamed"}" for ${k.clientName} / ${k.siteName} working?\n\nNew devices can no longer enroll with it, and installer scripts made from it stop working. Devices that already enrolled keep working. This cannot be undone.`)) return;
        setBusy(k.id);
        try {
            await jfetch(`/api/provisioning/enrollment-keys/${k.id}/revoke`, { method: "POST" });
            push({ title: "Key revoked", kind: "success" });
            await load();
        } catch (e) {
            push({ title: "Could not revoke", desc: messageOf(e), kind: "destructive" });
        } finally {
            setBusy(null);
        }
    }

    async function saveName(k: InstallKey) {
        setBusy(k.id);
        try {
            await jfetch(`/api/provisioning/enrollment-keys/${k.id}`, { method: "PATCH", body: { name: draft } });
            setEditing(null);
            await load();
        } catch (e) {
            push({ title: "Could not rename", desc: messageOf(e), kind: "destructive" });
        } finally {
            setBusy(null);
        }
    }

    if (!items) return <div className="p-4 text-sm text-muted-foreground">Loading…</div>;

    const shown = filter === "all" ? items : items.filter((k) => k.status === "active");
    const hidden = items.length - shown.length;

    return (
        <div className="grid w-full min-w-0 gap-6">
            <div>
                <h2 className="flex items-center gap-2 text-xl font-semibold tracking-tight"><KeyRound className="h-5 w-5" aria-hidden /> Install keys</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                    An install key lets installers enroll any number of devices into one site. Make one under{" "}
                    <Link href="/customers" className="underline underline-offset-2">Customers &gt; Reusable installer</Link>,
                    including long-lived ones for Group Policy. Here you can see which are still in use and stop any of them. The key itself is shown only once, when it is made.
                </p>
            </div>

            <EndpointLimitNote />

            <div className="flex flex-wrap items-center gap-3 text-sm">
                <label className="flex items-center gap-2">
                    <input type="checkbox" className="h-4 w-4 shrink-0 rounded border-input accent-primary" checked={filter === "all"} onChange={(e) => setFilter(e.target.checked ? "all" : "active")} />
                    Show expired and revoked keys{hidden > 0 && filter === "active" ? ` (${hidden})` : ""}
                </label>
                <Button size="sm" variant="outline" onClick={() => void load()}>Refresh</Button>
            </div>

            {shown.length === 0 ? (
                <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                    {items.length === 0 ? "No install keys yet." : "No active install keys."}
                </p>
            ) : (
                <div className="overflow-x-auto rounded-lg border">
                    <table className="w-full min-w-[820px] text-sm">
                        <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                            <tr>
                                <th className="p-2 font-medium">Name</th>
                                <th className="p-2 font-medium">Customer / site</th>
                                <th className="p-2 font-medium">Made</th>
                                <th className="p-2 font-medium">Expires</th>
                                <th className="p-2 font-medium">Last used</th>
                                <th className="p-2 text-right font-medium">Devices enrolled</th>
                                <th className="p-2 font-medium">Status</th>
                                <th className="p-2" />
                            </tr>
                        </thead>
                        <tbody className="divide-y">
                            {shown.map((k) => (
                                <tr key={k.id}>
                                    <td className="p-2">
                                        {editing === k.id ? (
                                            <form className="flex items-center gap-1" onSubmit={(e) => { e.preventDefault(); void saveName(k); }}>
                                                <Input value={draft} maxLength={120} onChange={(e) => setDraft(e.target.value)} className="h-8" aria-label="Key name" autoFocus />
                                                <Button size="sm" type="submit" disabled={busy === k.id}>Save</Button>
                                                <Button size="sm" type="button" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
                                            </form>
                                        ) : (
                                            <button type="button" className="text-left hover:underline" title="Rename" onClick={() => { setEditing(k.id); setDraft(k.name); }}>
                                                {k.name || <span className="text-muted-foreground">(no name)</span>}
                                            </button>
                                        )}
                                    </td>
                                    <td className="p-2">{k.clientName} <span className="text-muted-foreground">/ {k.siteName}</span></td>
                                    <td className="p-2 whitespace-nowrap" title={k.createdBy ? `By ${k.createdBy}` : undefined}>{day(k.createdAt)}{k.createdBy ? <span className="text-xs text-muted-foreground"> by {k.createdBy}</span> : null}</td>
                                    <td className="p-2 whitespace-nowrap">{expiryText(k)}</td>
                                    <td className="p-2 whitespace-nowrap" title={when(k.lastUsedAt)}>{day(k.lastUsedAt)}</td>
                                    <td className="p-2 text-right tabular-nums">{k.useCount}</td>
                                    <td className="p-2"><span className={`rounded-full border px-2 py-0.5 text-xs ${BADGE[k.status]}`}>{k.status === "active" ? "Active" : k.status === "revoked" ? "Revoked" : "Expired"}</span></td>
                                    <td className="p-2 text-right">
                                        {k.status === "active" ? <Button size="sm" variant="outline" disabled={busy === k.id} onClick={() => void revoke(k)}>Revoke</Button> : null}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
            <p className="text-xs text-muted-foreground">
                A key that was used long ago, or never, and is still active is worth revoking. Revoking stops new enrollments only: devices already enrolled keep working.
            </p>
        </div>
    );
}
