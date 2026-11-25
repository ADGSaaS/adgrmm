"use client";

import * as React from "react";
import { Pager, usePaged } from "@/components/pager";
import { EmptyState } from "@/components/list-controls";
import { Pencil, Play, Plus, Trash2 } from "lucide-react";
import { useRunChecks } from "@/components/use-run-checks";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { toast } from "@/components/ui/use-toast";
import { jfetch } from "@/lib/api";
import { useMe } from "@/lib/use-me";
import { hasPerm } from "@/lib/permissions";
import { errorText, Pill } from "@/components/policies/shared";
import { CheckDialog, blankCheck, describeCheck, type Check } from "@/components/checks-panel";

type Source = "device" | "site" | "customer" | "everyone";
type Row = Check & { source: Source; own: boolean };

const SOURCE_LABEL: Record<Source, string> = { device: "This device", site: "Its site", customer: "Its customer", everyone: "All devices" };

/**
 * The checks set up for one device: the ones made for this device alone (change them here) and the ones that reach it
 * from its site, its customer or all devices (change those under Automation, where it is clear who else they affect).
 * Every agent also runs built-in disk, CPU and memory checks, which are not listed here.
 */
export default function DeviceCheckSettings({ deviceId, onChanged }: { deviceId: string; onChanged?: () => void }) {
    const { permissions } = useMe();
    const canWrite = hasPerm(permissions, "checks.write");
    const canDelete = hasPerm(permissions, "checks.delete");
    const canRun = hasPerm(permissions, "checks.run");
    const [rows, setRows] = React.useState<Row[] | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [editing, setEditing] = React.useState<Check | null>(null);
    const [removing, setRemoving] = React.useState<Row | null>(null);

    const paged = usePaged(rows ?? [], "device-checks", 25);

    const load = React.useCallback(async () => {
        try {
            const { items } = await jfetch<{ items: Row[] }>(`/api/devices/${encodeURIComponent(deviceId)}/check-definitions`);
            setRows(items);
            setError(null);
        } catch (e) {
            setError(errorText(e));
        }
    }, [deviceId]);
    React.useEffect(() => void load(), [load]);
    const { run, busy } = useRunChecks(deviceId, onChanged);

    const remove = async () => {
        if (!removing) return;
        try {
            await jfetch(`/api/devices/${encodeURIComponent(deviceId)}/check-definitions/${removing.id}`, { method: "DELETE" });
            toast({ title: "Check deleted" });
            setRemoving(null);
            void load();
            onChanged?.();
        } catch (e) {
            toast({ title: "It was not deleted", description: errorText(e), variant: "destructive", duration: 10_000 });
            setRemoving(null);
        }
    };

    return (
        <Card>
            <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0">
                <div>
                    <CardTitle>Checks for this device</CardTitle>
                    <CardDescription>Add checks for this device alone. Built-in disk, CPU and memory checks run on every device as well.</CardDescription>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    {canRun && (
                        <Button size="sm" variant="outline" className="gap-1.5" disabled={busy !== null} onClick={() => void run([])} title="Run every check on this device now">
                            <Play className="h-4 w-4" aria-hidden="true" />
                            Run all now
                        </Button>
                    )}
                    {canWrite && (
                        <Button size="sm" className="gap-1.5" onClick={() => setEditing(blankCheck())}>
                            <Plus className="h-4 w-4" aria-hidden="true" />
                            Add check
                        </Button>
                    )}
                </div>
            </CardHeader>
            <CardContent className="space-y-2">
                {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
                {!rows && !error && <p className="text-sm text-muted-foreground">Loading…</p>}
                {rows && rows.length === 0 && <EmptyState>No extra checks yet. Add one to watch a service, a program, a drive, or whether an address can be reached.</EmptyState>}
                {rows && rows.length > 0 && (
                    <div className="overflow-x-auto rounded-xl border border-border/70 bg-card">
                        <table className="w-full min-w-[640px] text-sm">
                            <thead className="border-b border-border/70">
                                <tr>
                                    <th className="px-5 py-3 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Check</th>
                                    <th className="px-5 py-3 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">What it checks</th>
                                    <th className="px-5 py-3 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Every</th>
                                    <th className="px-5 py-3 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground" />
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-border/60">
                                {paged.rows.map((c) => (
                                    <tr key={c.id} className="hover:bg-accent">
                                        <td className="px-5 py-4 text-sm">
                                            <div className="flex flex-wrap items-center gap-2">
                                                <span className="font-medium">{c.name}</span>
                                                <Pill tone={c.own ? "good" : "muted"}>{SOURCE_LABEL[c.source]}</Pill>
                                                {!c.enabled && <Pill>Off</Pill>}
                                            </div>
                                        </td>
                                        <td className="px-5 py-4 text-sm text-muted-foreground">{describeCheck(c)}</td>
                                        <td className="px-5 py-4 text-sm tabular-nums">{c.intervalMinutes} min</td>
                                        <td className="whitespace-nowrap px-5 py-2 text-right text-sm">
                                            {canRun && (
                                                <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Run ${c.name} now`} title="Run now" disabled={busy !== null} onClick={() => void run([`check:${c.id}`], `"${c.name}"`)}>
                                                    <Play className="h-4 w-4" aria-hidden="true" />
                                                </Button>
                                            )}
                                            {c.own && canWrite && (
                                                <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Edit ${c.name}`} title="Edit" onClick={() => setEditing(c)}>
                                                    <Pencil className="h-4 w-4" aria-hidden="true" />
                                                </Button>
                                            )}
                                            {c.own && canDelete && (
                                                <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Delete ${c.name}`} title="Delete" onClick={() => setRemoving(c)}>
                                                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                                                </Button>
                                            )}
                                            {!c.own && <span className="text-xs text-muted-foreground">Change it under Automation</span>}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
                {rows && rows.length > 0 && <Pager paged={paged} className="pt-3" noun="checks" />}
            </CardContent>

            {editing && (
                <CheckDialog
                    initial={editing}
                    deviceId={deviceId}
                    onClose={() => setEditing(null)}
                    onSaved={() => { setEditing(null); void load(); onChanged?.(); }}
                />
            )}

            <AlertDialog open={!!removing} onOpenChange={(o) => !o && setRemoving(null)}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Delete {removing?.name}?</AlertDialogTitle>
                        <AlertDialogDescription>The device stops running it, and alerts it raised are resolved.</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Keep it</AlertDialogCancel>
                        <AlertDialogAction onClick={() => void remove()}>Delete check</AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </Card>
    );
}
