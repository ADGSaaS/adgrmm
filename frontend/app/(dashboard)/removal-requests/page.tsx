"use client";

// Removal requests: the devices someone asked to have removed, in one list, oldest first. A person with the right to delete devices
// approves (the device is deleted) or declines (the device stays) one request or many at once. Everyone who can see devices can see
// the list, so the person who asked can see it is waiting. A person limited to some customers sees only their own.
import * as React from "react";
import Link from "next/link";
import { Loader2, Trash2 } from "lucide-react";
import { PageHeader, PageShell } from "@/components/page-shell";
import PermGate from "@/components/perm-gate";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState } from "@/components/list-controls";
import { errorText } from "@/components/policies/shared";
import { useMe } from "@/lib/use-me";
import { hasPerm } from "@/lib/permissions";
import { ago } from "@/lib/security-api";
import { removals, type RemovalAnswer, type RemovalRequest } from "@/lib/device-removals-api";

const STATUS_TEXT: Record<RemovalAnswer["items"][number]["status"], string> = {
    deleted: "Deleted",
    declined: "Declined, the device stays",
    skipped: "Skipped",
    failed: "Failed",
};

function RemovalBody() {
    const { permissions } = useMe();
    const canAnswer = hasPerm(permissions, ["devices.read", "devices.delete"]);
    const [items, setItems] = React.useState<RemovalRequest[] | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [picked, setPicked] = React.useState<Set<string>>(new Set());
    const [confirm, setConfirm] = React.useState<"approve" | "decline" | null>(null);
    const [busy, setBusy] = React.useState(false);
    const [answer, setAnswer] = React.useState<RemovalAnswer | null>(null);

    const load = React.useCallback(async () => {
        try {
            const r = await removals.list();
            setItems(r.items);
            setError(null);
            // keep only the ticks of requests that are still waiting
            setPicked((p) => new Set([...p].filter((id) => r.items.some((i) => i.deviceId === id))));
        } catch (e) {
            setError(errorText(e));
            setItems((x) => x ?? []);
        }
    }, []);
    React.useEffect(() => { void load(); }, [load]);

    const all = items ?? [];
    const chosen = all.filter((i) => picked.has(i.deviceId));
    const allTicked = all.length > 0 && chosen.length === all.length;
    const toggle = (id: string) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });

    const send = async () => {
        if (!confirm) return;
        setBusy(true);
        setError(null);
        try {
            const ids = chosen.map((c) => c.deviceId);
            const r = confirm === "approve" ? await removals.approve(ids) : await removals.decline(ids);
            setAnswer(r);
            setConfirm(null);
            await load();
        } catch (e) {
            setError(errorText(e));
        } finally {
            setBusy(false);
        }
    };

    return (
        <PageShell>
            <PageHeader
                title="Removal requests"
                description="Devices someone asked to have removed. Approving deletes the device and its history; declining keeps it. A request stays here until someone with the right to delete devices answers it."
                actions={canAnswer ? (
                    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Answer the selected requests">
                        <Button variant="outline" size="sm" disabled={!chosen.length || busy} onClick={() => setConfirm("decline")}>Decline{chosen.length ? ` (${chosen.length})` : ""}</Button>
                        <Button variant="destructive" size="sm" className="gap-2" disabled={!chosen.length || busy} onClick={() => setConfirm("approve")}>
                            <Trash2 className="h-4 w-4" aria-hidden="true" />Approve and delete{chosen.length ? ` (${chosen.length})` : ""}
                        </Button>
                    </div>
                ) : undefined}
            />

            {!canAnswer ? <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">You can see what is waiting. Answering a request needs the right to delete devices.</p> : null}
            {error ? <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">{error}</p> : null}

            {answer ? (
                <section role="status" aria-label="Result" className="rounded-lg border p-3 text-sm">
                    <p className="font-medium">{answer.decision === "approve" ? `${answer.done} deleted.` : `${answer.done} declined.`}</p>
                    {answer.items.some((i) => i.status === "skipped" || i.status === "failed") ? (
                        <ul className="mt-1 list-disc pl-5 text-muted-foreground">
                            {answer.items.filter((i) => i.status === "skipped" || i.status === "failed").map((i) => (
                                <li key={i.deviceId}>{i.name}: {STATUS_TEXT[i.status]}{i.reason ? `. ${i.reason}` : ""}</li>
                            ))}
                        </ul>
                    ) : null}
                    <Button variant="ghost" size="sm" className="mt-1" onClick={() => setAnswer(null)}>Close</Button>
                </section>
            ) : null}

            {items === null ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />Loading the requests…</div>
            ) : all.length === 0 ? (
                <EmptyState>
                    <div className="font-medium text-foreground">Nothing is waiting</div>
                    <div>When someone asks for a device to be removed (from a device&apos;s menu or from the device list), it appears here.</div>
                </EmptyState>
            ) : (
                <div className="overflow-x-auto rounded-lg border">
                    <table className="w-full text-sm" data-testid="removal-table">
                        <caption className="sr-only">Device removal requests waiting for approval</caption>
                        <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
                            <tr>
                                {canAnswer ? (
                                    <th scope="col" className="w-10 px-3 py-2">
                                        <input type="checkbox" aria-label="Select all requests" checked={allTicked} onChange={() => setPicked(allTicked ? new Set() : new Set(all.map((i) => i.deviceId)))} />
                                    </th>
                                ) : null}
                                <th scope="col" className="px-3 py-2">Device</th>
                                <th scope="col" className="hidden px-3 py-2 md:table-cell">Customer</th>
                                <th scope="col" className="px-3 py-2">Why</th>
                                <th scope="col" className="hidden px-3 py-2 sm:table-cell">Asked by</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y">
                            {all.map((r) => (
                                <tr key={r.deviceId} className="align-top hover:bg-accent/30" data-testid="removal-row">
                                    {canAnswer ? (
                                        <td className="px-3 py-2.5">
                                            <input type="checkbox" aria-label={`Select ${r.name}`} checked={picked.has(r.deviceId)} onChange={() => toggle(r.deviceId)} />
                                        </td>
                                    ) : null}
                                    <td className="px-3 py-2.5">
                                        <Link href={`/devices/${encodeURIComponent(r.deviceId)}`} className="font-medium hover:underline">{r.name}</Link>
                                        <span className="block text-xs text-muted-foreground">{r.online ? "Online now" : "Offline"}{r.os ? `, ${r.os}` : ""}</span>
                                    </td>
                                    <td className="hidden px-3 py-2.5 md:table-cell">{r.customer ?? "No customer"}{r.site ? <span className="block text-xs text-muted-foreground">{r.site}</span> : null}</td>
                                    <td className="max-w-md px-3 py-2.5">{r.reason ?? <span className="text-muted-foreground">No reason given</span>}</td>
                                    <td className="hidden px-3 py-2.5 sm:table-cell">{r.requestedBy ?? "Unknown"}<span className="block text-xs text-muted-foreground">{ago(r.requestedAt)}</span></td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            <Dialog open={!!confirm} onOpenChange={(o) => !o && !busy && setConfirm(null)}>
                <DialogContent>
                    {confirm ? (
                        <>
                            <DialogHeader>
                                <DialogTitle>{confirm === "approve" ? `Delete ${chosen.length} ${chosen.length === 1 ? "device" : "devices"}?` : `Decline ${chosen.length} ${chosen.length === 1 ? "request" : "requests"}?`}</DialogTitle>
                                <DialogDescription>
                                    {confirm === "approve"
                                        ? "Each device is deleted with its history: software, jobs, checks and scans. This cannot be undone. Remove the agent from the machine too, or it keeps trying to connect."
                                        : "The devices stay as they are and the requests are closed. Someone can ask again later."}
                                </DialogDescription>
                            </DialogHeader>
                            <ul className="max-h-40 list-disc space-y-0.5 overflow-auto pl-5 text-sm">
                                {chosen.slice(0, 10).map((c) => <li key={c.deviceId}>{c.name}{c.customer ? <span className="text-muted-foreground"> ({c.customer})</span> : null}</li>)}
                                {chosen.length > 10 ? <li className="list-none text-muted-foreground">and {chosen.length - 10} more</li> : null}
                            </ul>
                            <DialogFooter>
                                <Button variant="outline" onClick={() => setConfirm(null)} disabled={busy}>Cancel</Button>
                                <Button variant={confirm === "approve" ? "destructive" : "default"} onClick={() => void send()} disabled={busy} className="gap-2">
                                    {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
                                    {busy ? "Working…" : confirm === "approve" ? "Delete" : "Decline"}
                                </Button>
                            </DialogFooter>
                        </>
                    ) : null}
                </DialogContent>
            </Dialog>
        </PageShell>
    );
}

export default function RemovalRequestsPage() {
    return (
        <PermGate require="devices.read" title="Removal requests" message="You need permission to view devices to see their removal requests.">
            <RemovalBody />
        </PermGate>
    );
}
