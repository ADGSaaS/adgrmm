"use client";

// "Fix now" on the software compliance report: install what is missing and, if asked, remove what is banned, for the
// devices the report is showing. The server says what each program maps to in the software library and who can be
// given it now and who is skipped, nothing is queued until the person confirms, and the results land in the Install log.
import * as React from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/use-toast";
import { EmptyState } from "@/components/list-controls";
import { jfetch } from "@/lib/api";
import { errorText, Pill } from "@/components/policies/shared";

type Fix = { deviceId: string; action: "install" | "uninstall"; item: string };
type Person = { deviceId: string; device: string; customer: string; site: string };
type Group = {
    item: string;
    action: "install" | "uninstall";
    devices: number;
    notPlanned?: number;
    entry: { id: string; name: string; method: "chocolatey" | "direct" } | null;
    problem: string | null;
    eligible: Person[];
    skipped: Array<Person & { reason: string }>;
};

const MAX_FIXES = 5000;
const list = (v: unknown): string[] => {
    if (typeof v !== "string" || !v) return [];
    try { const a = JSON.parse(v); return Array.isArray(a) ? a.filter((x): x is string => typeof x === "string" && !!x.trim()) : []; } catch { return []; }
};

/** What the report's rows ask for: install each missing program, remove each banned one. */
export function fixesFromRows(rows: Array<Record<string, unknown>>): { fixes: Fix[]; devices: number; cut: boolean } {
    const fixes: Fix[] = [];
    const devices = new Set<string>();
    for (const r of rows) {
        const deviceId = typeof r.deviceId === "string" ? r.deviceId : "";
        if (!deviceId) continue;
        for (const item of list(r.missingJson)) { fixes.push({ deviceId, action: "install", item }); devices.add(deviceId); }
        for (const item of list(r.bannedJson)) { fixes.push({ deviceId, action: "uninstall", item }); devices.add(deviceId); }
    }
    return { fixes: fixes.slice(0, MAX_FIXES), devices: devices.size, cut: fixes.length > MAX_FIXES };
}

const key = (g: Group) => `${g.action}:${g.item.toLowerCase()}`;

export function SoftwareFixDialog({ open, onOpenChange, rows }: { open: boolean; onOpenChange: (o: boolean) => void; rows: Array<Record<string, unknown>> }) {
    const { fixes, devices, cut } = React.useMemo(() => fixesFromRows(rows), [rows]);
    const [groups, setGroups] = React.useState<Group[] | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [picked, setPicked] = React.useState<Set<string>>(new Set());
    const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
    const [busy, setBusy] = React.useState(false);

    React.useEffect(() => {
        if (!open) return;
        setGroups(null); setError(null); setExpanded(new Set()); setBusy(false);
        if (!fixes.length) { setGroups([]); return; }
        let stale = false;
        jfetch<{ groups: Group[] }>("/api/software-library/fix-plan", { method: "POST", body: { fixes } })
            .then((r) => {
                if (stale) return;
                setGroups(r.groups);
                // Installs start ticked; removals start unticked, because taking software off a PC should be a decision.
                setPicked(new Set(r.groups.filter((g) => g.action === "install" && g.eligible.length > 0).map(key)));
            })
            .catch((e) => { if (!stale) setError(errorText(e)); });
        return () => { stale = true; };
    }, [open, fixes]);

    const toggle = (set: Set<string>, k: string) => { const n = new Set(set); if (n.has(k)) n.delete(k); else n.add(k); return n; };
    const chosen = (groups ?? []).filter((g) => picked.has(key(g)) && g.entry && g.eligible.length > 0);
    const total = chosen.reduce((n, g) => n + g.eligible.length, 0);

    const confirm = async () => {
        setBusy(true); setError(null);
        let queued = 0;
        let skipped = 0;
        try {
            for (const g of chosen) {
                const ids = g.eligible.map((p) => p.deviceId);
                for (let i = 0; i < ids.length; i += 200) {
                    const r = await jfetch<{ queued: number; skipped: unknown[] }>(`/api/software-library/${g.entry!.id}/install`, { method: "POST", body: { action: g.action, deviceIds: ids.slice(i, i + 200) } });
                    queued += r.queued;
                    skipped += r.skipped?.length ?? 0;
                }
            }
            toast({
                title: `Queued ${queued} ${queued === 1 ? "action" : "actions"}`,
                description: skipped ? `${skipped} could not be queued after all. Open the report again to see what is left.` : "Each device does its part the next time it checks in, one program at a time. Follow the results in the Install log under Policies, Software.",
            });
            onOpenChange(false);
        } catch (e) {
            if (queued) toast({ title: `Queued ${queued} before it stopped`, description: errorText(e), variant: "destructive" });
            setError(errorText(e));
        } finally {
            setBusy(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
            <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
                <DialogHeader>
                    <DialogTitle>Fix now</DialogTitle>
                    <DialogDescription>
                        {devices} {devices === 1 ? "device" : "devices"} in this report {devices === 1 ? "needs" : "need"} software fixed. Check what will be done, then confirm. Nothing is queued until you do.
                        {cut ? ` Only the first ${MAX_FIXES.toLocaleString()} items are planned; narrow the report to see the rest.` : ""}
                    </DialogDescription>
                </DialogHeader>

                {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
                {groups === null && !error && <p className="text-sm text-muted-foreground">Working out what can be fixed…</p>}
                {groups && groups.length === 0 && <EmptyState>Nothing in this report needs fixing.</EmptyState>}

                <div className="grid gap-3">
                    {groups?.map((g) => {
                        const k = key(g);
                        const fixable = !!g.entry && !g.problem && g.eligible.length > 0;
                        const verb = g.action === "install" ? "Install" : "Remove";
                        return (
                            <section key={k} className="rounded-md border p-3 text-sm">
                                <div className="flex flex-wrap items-start justify-between gap-2">
                                    <label className="flex items-start gap-2">
                                        <input type="checkbox" className="mt-1" disabled={!fixable} checked={picked.has(k) && fixable} onChange={() => setPicked((cur) => toggle(cur, k))} />
                                        <span>
                                            <span className="font-medium">{verb} {g.entry?.name ?? g.item}</span>{" "}
                                            <Pill tone={g.action === "install" ? "good" : "warn"}>{g.action === "install" ? "Missing required" : "Banned"}</Pill>
                                            <span className="block text-xs text-muted-foreground">
                                                {g.problem
                                                    ? "Cannot be fixed from here."
                                                    : `${g.eligible.length} of ${g.devices} ${g.devices === 1 ? "device" : "devices"} can be done now${g.entry?.method === "chocolatey" ? " with Chocolatey" : g.entry ? " with its direct installer" : ""}.`}
                                                {g.action === "uninstall" && fixable ? " Removals are off until you tick them." : ""}
                                                {g.notPlanned ? ` ${g.notPlanned.toLocaleString()} more ${g.notPlanned === 1 ? "device was" : "devices were"} not planned (the limit is 2,000 per program). Narrow the report to the rest.` : ""}
                                            </span>
                                        </span>
                                    </label>
                                    {g.skipped.length > 0 && (
                                        <Button type="button" variant="ghost" size="sm" aria-expanded={expanded.has(k)} onClick={() => setExpanded((cur) => toggle(cur, k))}>
                                            {expanded.has(k) ? "Hide" : "Why"} {g.skipped.length} skipped
                                        </Button>
                                    )}
                                </div>
                                {g.problem && <p className="mt-1 text-sm text-destructive">{g.problem}</p>}
                                {expanded.has(k) && (
                                    <ul className="mt-2 max-h-48 divide-y divide-border/60 overflow-y-auto rounded-md border text-xs">
                                        {g.skipped.slice(0, 100).map((s) => (
                                            <li key={s.deviceId} className="flex flex-wrap justify-between gap-2 px-3 py-1.5">
                                                <span><span className="font-medium">{s.device}</span> <span className="text-muted-foreground">{[s.customer, s.site].filter(Boolean).join(" / ")}</span></span>
                                                <span className="text-muted-foreground">{s.reason}</span>
                                            </li>
                                        ))}
                                        {g.skipped.length > 100 && <li className="px-3 py-1.5 text-muted-foreground">And {g.skipped.length - 100} more.</li>}
                                    </ul>
                                )}
                            </section>
                        );
                    })}
                </div>

                <DialogFooter className="items-center gap-2 sm:justify-between">
                    <p className="text-xs text-muted-foreground">Needs the right to install software. <Link href="/policies" className="underline">Add a program to the library</Link> if one cannot be fixed.</p>
                    <div className="flex gap-2">
                        <Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>Cancel</Button>
                        <Button type="button" variant="success" disabled={busy || total === 0} onClick={() => void confirm()}>
                            {busy ? "Queuing…" : total ? `Queue ${total} ${total === 1 ? "action" : "actions"}` : "Nothing selected"}
                        </Button>
                    </div>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
