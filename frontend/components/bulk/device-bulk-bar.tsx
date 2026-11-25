"use client";

// The bar above the device list when devices are ticked: how many, "select all N matching", and the actions. Each action
// opens a confirmation that says how many devices and names the first few; the ones that cannot be undone (restart,
// install updates, run a script, ask for removal) also ask for the count to be typed. The answer is a per-device result
// (done, queued, skipped, failed, and why), kept as a batch under Automation > Bulk actions.
import * as React from "react";
import Link from "next/link";
import { ChevronDown, ListChecks, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { fetchCustomers, fetchCustomerSites, jfetch, type CustomerClient, type CustomerSite } from "@/lib/api";
import { BULK_LABEL, MAX_BULK, namesText, runBulk, type BulkKind, type BulkResult } from "@/lib/bulk-api";
import { useMe } from "@/lib/use-me";
import { hasPerm } from "@/lib/permissions";
import { errorText } from "@/components/policies/shared";
import BatchDetail from "@/components/bulk/batch-detail";
import RunScriptModal from "@/components/run-script-modal";

export type Picked = { id: string; name: string };

type Action =
    | { kind: Exclude<BulkKind, "run-script" | "tags"> }
    | { kind: "tags"; remove: boolean }
    | { kind: "software" };

type UpdateRingChoice = "pilot" | "stable" | "inherit";

const DESTRUCTIVE: Array<Action["kind"]> = ["reboot", "patch-install", "delete-request", "rotate-laps-password"];
const selectClass = "h-9 w-full rounded-md border bg-background px-2 text-sm";

function Summary({ items, destructive, typed, setTyped }: { items: Picked[]; destructive: boolean; typed: string; setTyped: (v: string) => void }) {
    return (
        <div className="space-y-2 text-sm">
            <p><strong>{items.length}</strong> {items.length === 1 ? "device" : "devices"}: {namesText(items)}.</p>
            {destructive ? (
                <div className="space-y-1">
                    <label htmlFor="bulk-confirm" className="text-xs text-muted-foreground">This cannot be taken back. Type {items.length} to confirm.</label>
                    <Input id="bulk-confirm" inputMode="numeric" autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} className="w-32" />
                </div>
            ) : null}
        </div>
    );
}

function ActionDialog({ action, items, onClose }: { action: Action; items: Picked[]; onClose: () => void }) {
    const [typed, setTyped] = React.useState("");
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const [result, setResult] = React.useState<BulkResult | null>(null);
    const [softwareResult, setSoftwareResult] = React.useState<{ queued: number; skipped: Array<{ deviceId: string; reason?: string }> } | null>(null);

    // options
    const [includeOptional, setIncludeOptional] = React.useState(false);
    const [level, setLevel] = React.useState<"critical" | "all">("critical");
    const [reason, setReason] = React.useState("");
    const [clients, setClients] = React.useState<CustomerClient[]>([]);
    const [clientId, setClientId] = React.useState("");
    const [sites, setSites] = React.useState<CustomerSite[]>([]);
    const [siteId, setSiteId] = React.useState("");
    const [tags, setTags] = React.useState<Array<{ id: string; name: string }>>([]);
    const [tagId, setTagId] = React.useState("");
    const [library, setLibrary] = React.useState<Array<{ id: string; name: string }>>([]);
    const [libraryId, setLibraryId] = React.useState("");
    const [softwareAction, setSoftwareAction] = React.useState<"install" | "uninstall">("install");
    const [ring, setRing] = React.useState<UpdateRingChoice>("pilot");

    const kind = action.kind;
    React.useEffect(() => {
        if (kind === "move-site") void fetchCustomers().then(setClients).catch(() => setClients([]));
        if (kind === "tags") void jfetch<{ items: Array<{ id: string; name: string }> }>("/api/tags").then((r) => setTags(r.items)).catch(() => setTags([]));
        if (kind === "software") void jfetch<{ items: Array<{ id: string; name: string }> }>("/api/software-library").then((r) => setLibrary(r.items)).catch(() => setLibrary([]));
    }, [kind]);
    React.useEffect(() => {
        setSiteId("");
        setSites([]);
        if (kind === "move-site" && clientId) void fetchCustomerSites(clientId).then(setSites).catch(() => setSites([]));
    }, [kind, clientId]);

    const destructive = DESTRUCTIVE.includes(kind);
    const confirmed = !destructive || typed.trim() === String(items.length);
    const ready =
        confirmed &&
        (kind !== "move-site" || !!siteId) &&
        (kind !== "tags" || !!tagId) &&
        (kind !== "delete-request" || reason.trim().length >= 3) &&
        (kind !== "software" || !!libraryId);

    const title =
        kind === "tags" ? `${action.kind === "tags" && action.remove ? "Remove a tag from" : "Add a tag to"} ${items.length} devices`
            : kind === "software" ? `Install or remove software on ${items.length} devices`
                : `${BULK_LABEL[kind as BulkKind]}: ${items.length} ${items.length === 1 ? "device" : "devices"}`;

    const submit = async () => {
        setBusy(true);
        setError(null);
        const deviceIds = items.map((i) => i.id);
        try {
            if (kind === "software") {
                let queued = 0;
                const skipped: Array<{ deviceId: string; reason?: string }> = [];
                for (let i = 0; i < deviceIds.length; i += 200) {
                    const r = await jfetch<{ queued: number; skipped: Array<{ deviceId: string; reason?: string }> }>(`/api/software-library/${libraryId}/install`, { method: "POST", body: { action: softwareAction, deviceIds: deviceIds.slice(i, i + 200) } });
                    queued += r.queued;
                    skipped.push(...(r.skipped ?? []));
                }
                setSoftwareResult({ queued, skipped });
                return;
            }
            const body: Record<string, unknown> = { deviceIds };
            if (kind === "patch-scan") body.includeOptional = includeOptional;
            if (kind === "patch-install") Object.assign(body, { level, includeOptional });
            if (kind === "move-site") body.siteId = siteId;
            if (kind === "tags") Object.assign(body, { tagId, remove: action.kind === "tags" && action.remove });
            if (kind === "delete-request") body.reason = reason.trim();
            if (kind === "set-ring") body.ring = ring;
            setResult(await runBulk(kind as BulkKind, body));
        } catch (e) {
            setError(errorText(e));
        } finally {
            setBusy(false);
        }
    };

    const done = !!result || !!softwareResult;

    return (
        <Dialog open onOpenChange={(o) => !o && onClose()}>
            <DialogContent className="max-h-[90dvh] max-w-2xl overflow-y-auto">
                <DialogHeader>
                    <DialogTitle>{title}</DialogTitle>
                    <DialogDescription>
                        {done ? (kind === "delete-request" ? <>Here is how each device answered. Waiting requests are listed on the <Link href="/removal-requests" className="underline">Removal requests</Link> page, where someone with the right to delete devices approves or declines them.</> : "Here is how each device answered.") : kind === "delete-request" ? "Nothing is deleted yet: each device waits for someone with the right to approve its removal." : "Each device is checked on its own. Devices the action does not fit are skipped with a reason, and the rest go ahead."}
                    </DialogDescription>
                </DialogHeader>

                {!done ? (
                    <div className="space-y-4">
                        <Summary items={items} destructive={destructive} typed={typed} setTyped={setTyped} />

                        {kind === "patch-scan" ? (
                            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={includeOptional} onChange={(e) => setIncludeOptional(e.target.checked)} /> Include optional updates</label>
                        ) : null}
                        {kind === "patch-install" ? (
                            <div className="space-y-2 text-sm">
                                <label className="grid gap-1">What to install
                                    <select className={selectClass} value={level} onChange={(e) => setLevel(e.target.value as "critical" | "all")}>
                                        <option value="critical">Critical and important updates found by the last scan</option>
                                        <option value="all">Every update found by the last scan</option>
                                    </select>
                                </label>
                                <label className="flex items-center gap-2"><input type="checkbox" checked={includeOptional} onChange={(e) => setIncludeOptional(e.target.checked)} /> Include optional updates</label>
                                <p className="text-xs text-muted-foreground">Devices that have not been scanned, or that are already installing, are skipped. Updates can restart a device.</p>
                            </div>
                        ) : null}
                        {kind === "move-site" ? (
                            <div className="grid gap-2 text-sm">
                                <label className="grid gap-1">Customer
                                    <select className={selectClass} value={clientId} onChange={(e) => setClientId(e.target.value)}>
                                        <option value="">Choose a customer</option>
                                        {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                                    </select>
                                </label>
                                <label className="grid gap-1">Site
                                    <select className={selectClass} value={siteId} onChange={(e) => setSiteId(e.target.value)} disabled={!clientId}>
                                        <option value="">Choose a site</option>
                                        {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                                    </select>
                                </label>
                                <p className="text-xs text-muted-foreground">Tickets, alerts and policies follow each device to its new site.</p>
                            </div>
                        ) : null}
                        {kind === "tags" ? (
                            <label className="grid gap-1 text-sm">Tag
                                <select className={selectClass} value={tagId} onChange={(e) => setTagId(e.target.value)}>
                                    <option value="">Choose a tag</option>
                                    {tags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                                </select>
                            </label>
                        ) : null}
                        {kind === "delete-request" ? (
                            <label className="grid gap-1 text-sm">Why should they be removed?
                                <Textarea rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Shown to whoever approves each removal" />
                            </label>
                        ) : null}
                        {kind === "security-scan" ? (
                            <p className="text-sm text-muted-foreground">Asks each Windows or Linux device that is online to check its antivirus, disk encryption, firewall, accounts and other settings against the security baseline. It only reads: nothing on the device is changed. The scores appear on the Security page within a minute or two. Devices that are not Windows or Linux, are offline, or already have a scan waiting are skipped.</p>
                        ) : null}
                        {kind === "escrow-bitlocker" ? (
                            <p className="text-sm text-muted-foreground">Asks each Windows or Linux device that is online to store its disk recovery keys on this server, encrypted: a Windows device sends the keys of its BitLocker volumes, and on Linux a new recovery key slot is added to each LUKS2 disk that unlocks with the TPM or a key file. Devices on other systems are skipped, and nothing else on the device is changed. Only people with the right to view device secrets can see the keys. Devices that are offline, have no agent, have escrow switched off by their policy (Policies, Device secrets) or already have a request waiting are skipped.</p>
                        ) : null}
                        {kind === "rotate-laps-password" ? (
                            <p className="text-sm text-muted-foreground">The local administrator password changes on every selected device: each one generates a new password for the RemoteIQ-managed account and sends it here, stored encrypted, and the old password stops working. Devices that are offline, have no agent, are not Windows, or are not set to manage the password in their policy (Policies, Device secrets) are skipped.</p>
                        ) : null}
                        {kind === "set-ring" ? (
                            <div className="grid gap-2 text-sm">
                                <label className="grid gap-1">Update ring
                                    <select className={selectClass} value={ring} onChange={(e) => setRing(e.target.value as UpdateRingChoice)}>
                                        <option value="pilot">Pilot (test group)</option>
                                        <option value="stable">Everyone</option>
                                        <option value="inherit">Follow each customer&apos;s default</option>
                                    </select>
                                </label>
                                <p className="text-xs text-muted-foreground">Pilot devices are offered a new agent build first, as a test. Everyone gets it only when it is promoted under Administration, Agents &amp; endpoints, Releases. Devices that already have this ring are skipped.</p>
                            </div>
                        ) : null}
                        {kind === "software" ? (
                            <div className="grid gap-2 text-sm">
                                <label className="grid gap-1">Program from the software library
                                    <select className={selectClass} value={libraryId} onChange={(e) => setLibraryId(e.target.value)}>
                                        <option value="">Choose a program</option>
                                        {library.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                                    </select>
                                </label>
                                <label className="grid gap-1">Action
                                    <select className={selectClass} value={softwareAction} onChange={(e) => setSoftwareAction(e.target.value as "install" | "uninstall")}>
                                        <option value="install">Install</option>
                                        <option value="uninstall">Uninstall</option>
                                    </select>
                                </label>
                                <p className="text-xs text-muted-foreground">This uses the software library&apos;s own install, so its rules and its install log apply. <Link className="underline" href="/policies?tab=software">Open the software library</Link></p>
                            </div>
                        ) : null}

                        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
                    </div>
                ) : null}

                {result ? (
                    <div className="space-y-2">
                        <BatchDetail batchId={result.batchId} />
                        <p className="text-xs text-muted-foreground">Kept under <Link className="underline" href={`/automation?tab=bulk&batch=${result.batchId}`}>Automation, Bulk actions</Link>.</p>
                    </div>
                ) : null}
                {softwareResult ? (
                    <div className="space-y-2 text-sm">
                        <p><strong>{softwareResult.queued}</strong> queued{softwareResult.skipped.length ? `, ${softwareResult.skipped.length} could not be queued` : ""}. Each device does it the next time it checks in.</p>
                        {softwareResult.skipped.length ? (
                            <ul className="max-h-40 overflow-auto rounded border p-2 text-xs">
                                {softwareResult.skipped.slice(0, 50).map((s) => <li key={s.deviceId}>{items.find((i) => i.id === s.deviceId)?.name ?? s.deviceId}: {s.reason ?? "skipped"}</li>)}
                            </ul>
                        ) : null}
                    </div>
                ) : null}

                <DialogFooter>
                    {done ? (
                        <Button onClick={onClose}>Close</Button>
                    ) : (
                        <>
                            <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
                            <Button variant={destructive ? "destructive" : "default"} onClick={() => void submit()} disabled={!ready || busy} className="gap-2">
                                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                                {busy ? "Working…" : kind === "delete-request" ? `Ask for ${items.length} to be removed` : kind === "reboot" ? `Restart ${items.length}` : kind === "rotate-laps-password" ? `Rotate on ${items.length}` : kind === "software" ? (softwareAction === "install" ? "Install" : "Uninstall") : "Go"}
                            </Button>
                        </>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

type Props = {
    selected: Picked[];
    /** Devices the current filters match in all. */
    total: number;
    onSelectAllMatching: () => Promise<void>;
    onClear: () => void;
    note?: string | null;
};

export default function DeviceBulkBar({ selected, total, onSelectAllMatching, onClear, note }: Props) {
    const { permissions } = useMe();
    const [action, setAction] = React.useState<Action | null>(null);
    const [scriptOpen, setScriptOpen] = React.useState(false);
    const [selecting, setSelecting] = React.useState(false);
    const [selectError, setSelectError] = React.useState<string | null>(null);
    const can = (p: string | string[]) => hasPerm(permissions, p);

    if (selected.length === 0) return null;

    const selectAll = async () => {
        setSelecting(true);
        setSelectError(null);
        try {
            await onSelectAllMatching();
        } catch (e) {
            setSelectError(errorText(e));
        } finally {
            setSelecting(false);
        }
    };

    const items: Array<{ label: string; action?: Action; run?: () => void; show: boolean; danger?: boolean; sep?: boolean }> = [
        { label: "Run script…", run: () => setScriptOpen(true), show: can("automation.run") },
        { label: "Restart…", action: { kind: "reboot" }, show: can("devices.actions"), danger: true },
        { label: "Scan for updates", action: { kind: "patch-scan" }, show: can("devices.actions") },
        { label: "Install updates…", action: { kind: "patch-install" }, show: can("devices.actions"), danger: true },
        { label: "Update agent", action: { kind: "update-agent" }, show: can("devices.actions") },
        { label: "Run security scan", action: { kind: "security-scan" }, show: can(["devices.read", "devices.actions"]) },
        { label: "Escrow disk recovery keys", action: { kind: "escrow-bitlocker" }, show: can(["devices.read", "devices.secrets.manage"]) },
        { label: "Rotate local admin password…", action: { kind: "rotate-laps-password" }, show: can(["devices.read", "devices.secrets.manage"]), danger: true },
        { label: "Install or remove software…", action: { kind: "software" }, show: can("software.install"), sep: true },
        { label: "Set update ring…", action: { kind: "set-ring" }, show: can(["devices.write", "agents.release.manage"]), sep: true },
        { label: "Move to site…", action: { kind: "move-site" }, show: can("devices.write") },
        { label: "Add tag…", action: { kind: "tags", remove: false }, show: can("devices.write") },
        { label: "Remove tag…", action: { kind: "tags", remove: true }, show: can("devices.write") },
        { label: "Request removal…", action: { kind: "delete-request" }, show: can("devices.write"), danger: true, sep: true },
    ];
    const visible = items.filter((i) => i.show);
    const tooMany = selected.length > MAX_BULK;

    return (
        <div role="region" aria-label="Actions for the selected devices" data-testid="bulk-bar" className="mb-3 flex flex-wrap items-center gap-3 rounded-md border bg-muted/40 px-3 py-2 text-sm">
            <ListChecks className="h-4 w-4 text-muted-foreground" aria-hidden />
            <span className="font-medium">{selected.length} selected</span>
            {total > selected.length ? (
                <Button type="button" variant="link" size="sm" className="h-auto p-0" disabled={selecting} onClick={() => void selectAll()}>
                    {selecting ? "Selecting…" : `Select all ${total} matching the filters${total > MAX_BULK ? ` (the first ${MAX_BULK})` : ""}`}
                </Button>
            ) : null}
            <Button type="button" variant="ghost" size="sm" className="h-7" onClick={onClear}>Clear</Button>
            {note ? <span className="text-xs text-amber-700 dark:text-amber-400">{note}</span> : null}
            {selectError ? <span role="alert" className="text-xs text-destructive">{selectError}</span> : null}
            <div className="ml-auto">
                {visible.length === 0 ? (
                    <span className="text-xs text-muted-foreground">You do not have the rights for any bulk action.</span>
                ) : (
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button size="sm" className="gap-1" disabled={tooMany}>Actions <ChevronDown className="h-4 w-4" /></Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-64">
                            {visible.map((i, idx) => (
                                <React.Fragment key={i.label}>
                                    {i.sep && idx > 0 ? <DropdownMenuSeparator /> : null}
                                    <DropdownMenuItem className={i.danger ? "text-destructive focus:text-destructive" : undefined} onSelect={() => (i.run ? i.run() : setAction(i.action!))}>
                                        {i.label}
                                    </DropdownMenuItem>
                                </React.Fragment>
                            ))}
                            <DropdownMenuSeparator />
                            <DropdownMenuItem asChild><Link href="/automation?tab=bulk">Results of earlier bulk actions</Link></DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                )}
            </div>
            {action ? <ActionDialog action={action} items={selected} onClose={() => setAction(null)} /> : null}
            <RunScriptModal open={scriptOpen} onOpenChange={setScriptOpen} preselectDeviceIds={selected.map((s) => s.id)} preselectNames={selected.map((s) => s.name)} />
        </div>
    );
}
