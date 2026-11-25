// components/checks-panel.tsx
"use client";

import * as React from "react";
import { Pager, usePaged } from "@/components/pager";
import { EmptyState } from "@/components/list-controls";
import { Pencil, Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/use-toast";
import TargetPicker, { targetIsComplete, type Target } from "@/components/target-picker";
import { jfetch } from "@/lib/api";
import { errorText } from "@/components/policies/shared";

type CheckKind = "disk" | "cpu" | "memory" | "service" | "process" | "ping" | "port";

export type Check = {
    id: string;
    name: string;
    kind: CheckKind;
    enabled: boolean;
    intervalMinutes: number;
    severity: "WARN" | "CRIT";
    warn: number | null;
    crit: number | null;
    path: string | null;
    service: string | null;
    process: string | null;
    host: string | null;
    port: number | null;
    targets: Target[];
};

const KINDS: Array<{ value: CheckKind; label: string; hint: string }> = [
    { value: "disk", label: "Disk space", hint: "Used space, as a percentage. Leave the drive empty to watch all of them." },
    { value: "cpu", label: "CPU", hint: "CPU use, as a percentage." },
    { value: "memory", label: "Memory", hint: "Memory use, as a percentage." },
    { value: "service", label: "Service", hint: "Alerts when a service is not running." },
    { value: "process", label: "Process", hint: "Alerts when a program is not running." },
    { value: "ping", label: "Ping", hint: "Alerts when the device cannot reach an address." },
    { value: "port", label: "Port", hint: "Alerts when the device cannot connect to a port." },
];

const usesLimits = (kind: CheckKind) => kind === "disk" || kind === "cpu" || kind === "memory";
export const blankCheck = (): Check => ({
    id: "",
    name: "",
    kind: "disk",
    enabled: true,
    intervalMinutes: 5,
    severity: "CRIT",
    warn: 85,
    crit: 95,
    path: "",
    service: "",
    process: "",
    host: "",
    port: null,
    targets: [],
});

export function describeCheck(check: Check) {
    if (usesLimits(check.kind)) {
        const limits = [check.warn != null ? `warn at ${check.warn}%` : null, check.crit != null ? `critical at ${check.crit}%` : null].filter(Boolean).join(", ");
        return `${KINDS.find((k) => k.value === check.kind)?.label}${check.path ? ` (${check.path})` : ""}: ${limits}`;
    }
    if (check.kind === "service") return `Service ${check.service} is running`;
    if (check.kind === "process") return `Process ${check.process} is running`;
    if (check.kind === "port") return `Can connect to ${check.host}:${check.port}`;
    return `Can reach ${check.host}`;
}

/** Make or change a check. With a device id it is that device's own check and the "Runs on" choice is hidden. */
export function CheckDialog({ initial, onClose, onSaved, deviceId }: { initial: Check; onClose: () => void; onSaved: () => void; deviceId?: string }) {
    const [form, setForm] = React.useState<Check>(initial);
    const [adding, setAdding] = React.useState<Target>({ type: "organization" });
    const [saving, setSaving] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);

    const set = <K extends keyof Check>(key: K, value: Check[K]) => setForm((f) => ({ ...f, [key]: value }));
    const kind = KINDS.find((k) => k.value === form.kind)!;

    const addTarget = () => {
        if (!targetIsComplete(adding)) return;
        const exists = form.targets.some((t) => t.type === adding.type && (t.id ?? null) === (adding.id ?? null));
        if (!exists) {
            set("targets", [...form.targets, { ...adding, label: adding.type === "organization" ? "All devices" : adding.label }]);
        }
    };

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        setSaving(true);
        setError(null);

        const { id, targets, ...rest } = form;
        const limits = usesLimits(form.kind);
        const body = {
            name: rest.name,
            kind: rest.kind,
            enabled: rest.enabled,
            intervalMinutes: rest.intervalMinutes,
            severity: rest.severity,
            ...(limits ? { warn: rest.warn ?? undefined, crit: rest.crit ?? undefined } : {}),
            ...(form.kind === "disk" && rest.path ? { path: rest.path } : {}),
            ...(form.kind === "service" ? { service: rest.service } : {}),
            ...(form.kind === "process" ? { process: rest.process } : {}),
            ...(form.kind === "ping" || form.kind === "port" ? { host: rest.host } : {}),
            ...(form.kind === "port" ? { port: rest.port ?? undefined } : {}),
            ...(deviceId ? {} : { targets: targets.map((t) => ({ type: t.type, ...(t.type === "organization" ? {} : { id: t.id }) })) }),
        };
        const base = deviceId ? `/api/devices/${encodeURIComponent(deviceId)}/check-definitions` : "/api/checks";

        try {
            await jfetch(id ? `${base}/${id}` : base, { method: id ? "PUT" : "POST", body });
            toast({ title: id ? "Check updated" : "Check created", description: "Agents pick up changes within a few minutes.", variant: "success" });
            onSaved();
        } catch (err) {
            setError(errorText(err));
        } finally {
            setSaving(false);
        }
    };

    const numberField = (key: "warn" | "crit", label: string) => (
        <div className="grid gap-2">
            <Label htmlFor={`check-${key}`}>{label} (%)</Label>
            <Input
                id={`check-${key}`}
                type="number"
                min={0}
                max={100}
                value={form[key] ?? ""}
                onChange={(e) => set(key, e.target.value === "" ? null : Number(e.target.value))}
            />
        </div>
    );

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-h-[90dvh] overflow-y-auto">
                <form onSubmit={submit} className="space-y-4">
                    <DialogHeader>
                        <DialogTitle>{form.id ? "Edit check" : "New check"}</DialogTitle>
                        <DialogDescription>{kind.hint}</DialogDescription>
                    </DialogHeader>

                    <div className="grid gap-2">
                        <Label htmlFor="check-name">Name</Label>
                        <Input id="check-name" required maxLength={200} value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g., Print spooler running" />
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                        <div className="grid gap-2">
                            <Label htmlFor="check-kind">Type</Label>
                            <select id="check-kind" value={form.kind} onChange={(e) => set("kind", e.target.value as CheckKind)} className="h-9 rounded-md border bg-background px-2 text-sm">
                                {KINDS.map((k) => (
                                    <option key={k.value} value={k.value}>{k.label}</option>
                                ))}
                            </select>
                        </div>
                        <div className="grid gap-2">
                            <Label htmlFor="check-interval">Every (minutes)</Label>
                            <Input id="check-interval" type="number" min={1} max={1440} required value={form.intervalMinutes} onChange={(e) => set("intervalMinutes", Number(e.target.value))} />
                        </div>
                    </div>

                    {usesLimits(form.kind) ? (
                        <div className="grid grid-cols-2 gap-3">
                            {numberField("warn", "Warn at")}
                            {numberField("crit", "Critical at")}
                        </div>
                    ) : (
                        <div className="grid gap-2">
                            <Label htmlFor="check-severity">Severity when it fails</Label>
                            <select id="check-severity" value={form.severity} onChange={(e) => set("severity", e.target.value as "WARN" | "CRIT")} className="h-9 rounded-md border bg-background px-2 text-sm">
                                <option value="WARN">Warning</option>
                                <option value="CRIT">Critical</option>
                            </select>
                        </div>
                    )}

                    {form.kind === "disk" ? (
                        <div className="grid gap-2">
                            <Label htmlFor="check-path">Drive (optional)</Label>
                            <Input id="check-path" value={form.path ?? ""} onChange={(e) => set("path", e.target.value)} placeholder="C:\ or /var" />
                        </div>
                    ) : null}
                    {form.kind === "service" ? (
                        <div className="grid gap-2">
                            <Label htmlFor="check-service">Service name</Label>
                            <Input id="check-service" required value={form.service ?? ""} onChange={(e) => set("service", e.target.value)} placeholder="Spooler or nginx" />
                        </div>
                    ) : null}
                    {form.kind === "process" ? (
                        <div className="grid gap-2">
                            <Label htmlFor="check-process">Process name</Label>
                            <Input id="check-process" required value={form.process ?? ""} onChange={(e) => set("process", e.target.value)} placeholder="sqlservr" />
                        </div>
                    ) : null}
                    {form.kind === "ping" || form.kind === "port" ? (
                        <div className="grid grid-cols-3 gap-3">
                            <div className={`grid gap-2 ${form.kind === "port" ? "col-span-2" : "col-span-3"}`}>
                                <Label htmlFor="check-host">Address</Label>
                                <Input id="check-host" required value={form.host ?? ""} onChange={(e) => set("host", e.target.value)} placeholder="192.168.1.1 or example.com" />
                            </div>
                            {form.kind === "port" ? (
                                <div className="grid gap-2">
                                    <Label htmlFor="check-port">Port</Label>
                                    <Input id="check-port" type="number" required min={1} max={65535} value={form.port ?? ""} onChange={(e) => set("port", e.target.value === "" ? null : Number(e.target.value))} />
                                </div>
                            ) : null}
                        </div>
                    ) : null}

                    {!deviceId && <div className="grid gap-2">
                        <Label>Runs on</Label>
                        {form.targets.length ? (
                            <div className="flex flex-wrap gap-1.5">
                                {form.targets.map((t, i) => (
                                    <span key={`${t.type}:${t.id}`} className="inline-flex items-center gap-1 rounded-full border bg-muted/50 py-0.5 pl-2.5 pr-1 text-xs">
                                        {t.label ?? t.type}
                                        <button
                                            type="button"
                                            aria-label={`Remove ${t.label ?? t.type}`}
                                            onClick={() => set("targets", form.targets.filter((_, index) => index !== i))}
                                            className="flex h-4 w-4 items-center justify-center rounded-full hover:bg-accent"
                                        >
                                            <X className="h-3 w-3" aria-hidden="true" />
                                        </button>
                                    </span>
                                ))}
                            </div>
                        ) : (
                            <p className="text-xs text-muted-foreground">Choose at least one, then add it.</p>
                        )}
                        <TargetPicker value={adding} onChange={setAdding} idPrefix="check-target" />
                        <Button type="button" variant="outline" size="sm" className="w-fit gap-1.5" disabled={!targetIsComplete(adding)} onClick={addTarget}>
                            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                            Add
                        </Button>
                    </div>}

                    <div className="flex items-center justify-between gap-3">
                        <Label htmlFor="check-enabled">Turned on</Label>
                        <Switch id="check-enabled" checked={form.enabled} onCheckedChange={(v) => set("enabled", v)} />
                    </div>

                    {error ? <p className="text-sm text-destructive">{error}</p> : null}

                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
                        <Button type="submit" disabled={saving || (!deviceId && form.targets.length === 0)}>{saving ? "Saving…" : "Save"}</Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

/** The checks agents run, on top of the disk, CPU and memory checks built into every agent. */
export default function ChecksPanel() {
    const [checks, setChecks] = React.useState<Check[] | null>(null);
    const [editing, setEditing] = React.useState<Check | null>(null);
    const [error, setError] = React.useState<string | null>(null);

    const paged = usePaged(checks ?? [], "checks", 25);

    const load = React.useCallback(async () => {
        try {
            const { items } = await jfetch<{ items: Check[] }>("/api/checks");
            setChecks(items);
            setError(null);
        } catch (e) {
            setError(errorText(e));
        }
    }, []);

    React.useEffect(() => void load(), [load]);

    const remove = async (check: Check) => {
        if (!window.confirm(`Delete "${check.name}"? Alerts it raised will be resolved.`)) return;
        try {
            await jfetch(`/api/checks/${check.id}`, { method: "DELETE" });
            toast({ title: "Check deleted" });
            void load();
        } catch (e) {
            toast({ title: "It was not deleted", description: errorText(e), variant: "destructive", duration: 10_000 });
        }
    };

    return (
        <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="max-w-2xl text-sm text-muted-foreground">Every agent already runs built-in disk, CPU and memory checks. These run as well.</p>
                <Button size="sm" className="gap-1.5" onClick={() => setEditing(blankCheck())}>
                    <Plus className="h-4 w-4" aria-hidden="true" />
                    New check
                </Button>
            </div>

            {error ? <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm">{error}</div> : null}

            {checks && checks.length === 0 ? <EmptyState>No checks added yet.</EmptyState> : null}
            {!checks && !error ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
            {checks && checks.length > 0 ? (
                <div className="overflow-x-auto rounded-xl border border-border/70 bg-card">
                    <table className="w-full min-w-[640px] text-sm">
                        <thead className="border-b border-border/70">
                            <tr>
                                <th className="px-5 py-3 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Check</th>
                                <th className="px-5 py-3 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">What it checks</th>
                                <th className="px-5 py-3 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Every</th>
                                <th className="px-5 py-3 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Runs on</th>
                                <th className="px-5 py-3 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground" />
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-border/60">
                            {paged.rows.map((check) => (
                                <tr key={check.id} className="hover:bg-accent">
                                    <td className="px-5 py-4 text-sm">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <span className="font-medium">{check.name}</span>
                                            {check.enabled ? null : <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">Off</span>}
                                        </div>
                                    </td>
                                    <td className="px-5 py-4 text-sm text-muted-foreground">{describeCheck(check)}</td>
                                    <td className="px-5 py-4 text-sm tabular-nums">{check.intervalMinutes} min</td>
                                    <td className="px-5 py-4 text-sm text-muted-foreground">{check.targets.map((t) => t.label).join(", ")}</td>
                                    <td className="whitespace-nowrap px-5 py-2 text-right text-sm">
                                        <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Edit ${check.name}`} title="Edit" onClick={() => setEditing(check)}>
                                            <Pencil className="h-4 w-4" aria-hidden="true" />
                                        </Button>
                                        <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Delete ${check.name}`} title="Delete" onClick={() => void remove(check)}>
                                            <Trash2 className="h-4 w-4" aria-hidden="true" />
                                        </Button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            ) : null}
            {checks && checks.length > 0 ? <Pager paged={paged} noun="checks" /> : null}

            {editing ? (
                <CheckDialog
                    initial={editing}
                    onClose={() => setEditing(null)}
                    onSaved={() => {
                        setEditing(null);
                        void load();
                    }}
                />
            ) : null}
        </div>
    );
}
