"use client";

// The dialogs behind the Tools menu. Each one asks WHERE (a scope: every device, one customer or one site, optionally one system and only
// the devices that are online), shows how many devices that reaches before anything happens, and then hands the work to the server, which
// checks every device on its own. The result is the same batch view as "Recent actions", with each device's own answer.
import * as React from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import BatchDetail from "@/components/bulk/batch-detail";
import { fetchCustomers, fetchCustomerSites, jfetch, type CustomerClient, type CustomerSite } from "@/lib/api";
import {
    DEFAULT_SCOPE, fetchScripts, scopeReady, toolError, tools,
    type MaintenanceTask, type SavedScript, type ScopePreview, type ToolRun, type ToolScope,
} from "@/lib/tools-api";

const scriptPlatform = (x: SavedScript) => x.platform ?? (x.language === "powershell" ? "windows" : "linux");
const selectClass = "h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
/** From this many devices on, the person has to tick that they checked what they are about to do. */
const CONFIRM_FROM = 20;

export type ToolKey = "command" | "script" | "patches" | "recover" | "maintenance" | "cache";

/* ------------------------------ where: the scope ------------------------------ */

/** The devices a choice reaches, each ticked: untick the ones to leave out. */
function DeviceList({ preview, excluded, onChange }: { preview: ScopePreview; excluded: string[]; onChange: (ids: string[]) => void }) {
    const [q, setQ] = React.useState("");
    const devices = preview.devices ?? [];
    const out = new Set(excluded);
    const shown = devices.filter((d) => d.name.toLowerCase().includes(q.toLowerCase()));
    const toggle = (id: string) => onChange(out.has(id) ? excluded.filter((x) => x !== id) : [...excluded, id]);
    return (
        <details className="rounded-md border" data-testid="device-list" open={excluded.length > 0}>
            <summary className="cursor-pointer px-3 py-2 text-sm">
                Choose which devices: {devices.length - out.size} of {devices.length} ticked{excluded.length ? ` (${excluded.length} left out)` : ""}
            </summary>
            <div className="grid gap-2 border-t p-3">
                <div className="flex flex-wrap items-center gap-2">
                    <Input aria-label="Search the devices" placeholder="Search the devices" className="h-8 max-w-60" value={q} onChange={(e) => setQ(e.target.value)} />
                    <Button type="button" size="sm" variant="outline" className="h-8" onClick={() => onChange([])}>Tick all</Button>
                    <Button type="button" size="sm" variant="outline" className="h-8" onClick={() => onChange(devices.map((d) => d.id))}>Untick all</Button>
                </div>
                <ul className="max-h-56 overflow-y-auto rounded-md border text-sm">
                    {shown.map((d) => (
                        <li key={d.id}>
                            <label className="flex cursor-pointer items-center gap-2 px-2 py-1 hover:bg-muted/50">
                                <input type="checkbox" className="h-4 w-4 accent-primary" checked={!out.has(d.id)} onChange={() => toggle(d.id)} aria-label={d.name} />
                                <span className="min-w-0 flex-1 truncate">{d.name}</span>
                                <span className="text-xs text-muted-foreground">{d.os === "windows" ? "Windows" : d.os === "linux" ? "Linux" : "Other"}, {d.online ? "online" : "offline"}</span>
                            </label>
                        </li>
                    ))}
                    {shown.length === 0 ? <li className="px-2 py-2 text-muted-foreground">No device by that name.</li> : null}
                </ul>
                {preview.devicesCapped ? <p className="text-xs text-muted-foreground">Only the first {devices.length} devices are listed. Narrow the choice to pick among the rest.</p> : null}
            </div>
        </details>
    );
}

function ScopePicker({ scope, onChange, preview, previewError, excluded, onExcludedChange }: { scope: ToolScope; onChange: (s: ToolScope) => void; preview: ScopePreview | null; previewError: string | null; excluded: string[]; onExcludedChange: (ids: string[]) => void }) {
    const [tags, setTags] = React.useState<Array<{ id: string; name: string }>>([]);
    React.useEffect(() => { void jfetch<{ items: Array<{ id: string; name: string }> }>("/api/tags").then((r) => setTags(r.items)).catch(() => setTags([])); }, []);
    const [clients, setClients] = React.useState<CustomerClient[]>([]);
    const [sites, setSites] = React.useState<CustomerSite[]>([]);
    const [siteClient, setSiteClient] = React.useState("");

    React.useEffect(() => { void fetchCustomers().then(setClients).catch(() => setClients([])); }, []);
    React.useEffect(() => {
        setSites([]);
        if (scope.kind === "site" && siteClient) void fetchCustomerSites(siteClient).then(setSites).catch(() => setSites([]));
    }, [scope.kind, siteClient]);

    const set = (patch: Partial<ToolScope>) => onChange({ ...scope, ...patch });
    return (
        <fieldset className="grid gap-3 rounded-lg border p-3">
            <legend className="px-1 text-sm font-medium">Where</legend>
            <div className="grid gap-2 sm:grid-cols-4">
                {([["all", "Every device"], ["client", "One customer"], ["site", "One site"], ["tag", "A tag"]] as const).map(([k, label]) => (
                    <label key={k} className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm ${scope.kind === k ? "border-primary bg-primary/10" : ""}`}>
                        <input type="radio" name="tool-scope" className="accent-primary" checked={scope.kind === k} onChange={() => onChange({ ...scope, kind: k, clientId: undefined, siteId: undefined, tagId: undefined })} />
                        {label}
                    </label>
                ))}
            </div>
            {scope.kind === "client" ? (
                <div className="grid gap-1">
                    <Label htmlFor="tool-client">Customer</Label>
                    <select id="tool-client" className={selectClass} value={scope.clientId ?? ""} onChange={(e) => set({ clientId: e.target.value || undefined })}>
                        <option value="">Choose a customer</option>
                        {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                </div>
            ) : null}
            {scope.kind === "tag" ? (
                <div className="grid gap-1">
                    <Label htmlFor="tool-tag">Tag</Label>
                    <select id="tool-tag" className={selectClass} value={scope.tagId ?? ""} onChange={(e) => set({ tagId: e.target.value || undefined })}>
                        <option value="">Choose a tag</option>
                        {tags.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                    </select>
                </div>
            ) : null}
            {scope.kind === "site" ? (
                <div className="grid gap-2 sm:grid-cols-2">
                    <div className="grid gap-1">
                        <Label htmlFor="tool-site-client">Customer</Label>
                        <select id="tool-site-client" className={selectClass} value={siteClient} onChange={(e) => { setSiteClient(e.target.value); set({ siteId: undefined }); }}>
                            <option value="">Choose a customer</option>
                            {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                        </select>
                    </div>
                    <div className="grid gap-1">
                        <Label htmlFor="tool-site">Site</Label>
                        <select id="tool-site" className={selectClass} value={scope.siteId ?? ""} disabled={!siteClient} onChange={(e) => set({ siteId: e.target.value || undefined })}>
                            <option value="">Choose a site</option>
                            {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                        </select>
                    </div>
                </div>
            ) : null}
            <div className="grid gap-2 sm:grid-cols-2">
                <div className="grid gap-1">
                    <Label htmlFor="tool-os">System</Label>
                    <select id="tool-os" className={selectClass} value={scope.os} onChange={(e) => set({ os: e.target.value as ToolScope["os"] })}>
                        <option value="any">Windows and Linux</option>
                        <option value="windows">Windows only</option>
                        <option value="linux">Linux only</option>
                    </select>
                </div>
                <label className="flex items-end gap-2 pb-2 text-sm">
                    <input type="checkbox" className="h-4 w-4 accent-primary" checked={scope.onlineOnly} onChange={(e) => set({ onlineOnly: e.target.checked })} />
                    Only devices that are online now
                </label>
            </div>
            <div className="text-sm" aria-live="polite" data-testid="scope-preview">
                {previewError ? <span className="text-destructive">{previewError}</span>
                    : !scopeReady(scope) ? <span className="text-muted-foreground">Choose where first.</span>
                        : !preview ? <span className="inline-flex items-center gap-1 text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Counting devices…</span>
                            : preview.total === 0 ? <span className="text-amber-700 dark:text-amber-400">No device matches this choice.</span>
                                : (
                                    <span>
                                        <strong>{preview.total}</strong> {preview.total === 1 ? "device" : "devices"}: {preview.windows} Windows, {preview.linux} Linux{preview.other ? `, ${preview.other} other` : ""}. {preview.online} online, {preview.offline} offline.
                                        {preview.sample.length ? <span className="text-muted-foreground"> For example {preview.sample.join(", ")}.</span> : null}
                                        {preview.capped ? <span className="block text-destructive">That is more than {preview.max} devices. Choose a customer, a site or a tag.</span> : null}
                                    </span>
                                )}
            </div>
            {preview && preview.total > 0 && !preview.capped && preview.devices?.length ? (
                <>
                    <DeviceList preview={preview} excluded={excluded} onChange={onExcludedChange} />
                    {excluded.length ? <p className="text-sm" data-testid="left-out">{excluded.length} left out, so it runs on {Math.max(0, preview.total - excluded.length)}.</p> : null}
                </>
            ) : null}
        </fieldset>
    );
}

/** The scope, its live count, and what the run button needs to know. */
function useScope() {
    const [scope, setScope] = React.useState<ToolScope>(DEFAULT_SCOPE);
    const [preview, setPreview] = React.useState<ScopePreview | null>(null);
    const [previewError, setPreviewError] = React.useState<string | null>(null);
    const [excluded, setExcluded] = React.useState<string[]>([]);
    React.useEffect(() => {
        setPreview(null); setPreviewError(null); setExcluded([]);
        if (!scopeReady(scope)) return;
        let alive = true;
        const t = setTimeout(() => {
            tools.preview(scope).then((p) => { if (alive) setPreview(p); }).catch((e) => { if (alive) setPreviewError(toolError(e)); });
        }, 250);
        return () => { alive = false; clearTimeout(t); };
    }, [scope]);
    const reach = Math.max(0, (preview?.total ?? 0) - excluded.length);
    const reachable = scopeReady(scope) && !!preview && reach > 0 && !preview.capped;
    const runScope: ToolScope = { ...scope, exclude: excluded };
    return { scope, setScope, preview, previewError, reach, reachable, excluded, setExcluded, runScope };
}

/* ------------------------------ the answer ------------------------------ */

function Result({ run }: { run: ToolRun }) {
    return (
        <div className="grid gap-3" data-testid="tool-result">
            <p className="text-sm" role="status">
                <strong>{run.succeeded}</strong> started, <strong>{run.skipped}</strong> skipped, <strong>{run.failed}</strong> failed, of {run.requested} {run.requested === 1 ? "device" : "devices"}.
                {run.batches.length > 1 ? ` It was done in ${run.batches.length} groups.` : ""} Skipped devices say why below. The same results are under Recent actions on the Devices page.
            </p>
            {run.batches.map((b) => (
                <div key={b.batchId} className="grid gap-1">
                    {run.batches.length > 1 ? <div className="text-xs font-medium text-muted-foreground">{b.summary}</div> : null}
                    <BatchDetail batchId={b.batchId} />
                </div>
            ))}
        </div>
    );
}

function Confirm({ n, checked, onChange, what }: { n: number; checked: boolean; onChange: (v: boolean) => void; what: string }) {
    if (n < CONFIRM_FROM) return null;
    return (
        <label className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-sm">
            <input type="checkbox" className="mt-0.5 h-4 w-4 accent-primary" checked={checked} onChange={(e) => onChange(e.target.checked)} />
            <span>I have checked {what} and that these {n} devices are the ones I mean.</span>
        </label>
    );
}

function Shell({ open, onClose, title, description, children, footer, wide }: { open: boolean; onClose: () => void; title: string; description: string; children: React.ReactNode; footer?: React.ReactNode; wide?: boolean }) {
    return (
        <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
            <DialogContent className={`max-h-[90dvh] overflow-y-auto ${wide ? "sm:max-w-3xl" : "sm:max-w-2xl"}`}>
                <DialogHeader>
                    <DialogTitle>{title}</DialogTitle>
                    <DialogDescription>{description}</DialogDescription>
                </DialogHeader>
                <div className="grid gap-4">{children}</div>
                {footer ? <DialogFooter>{footer}</DialogFooter> : null}
            </DialogContent>
        </Dialog>
    );
}

/** Runs one tool and keeps its state: busy, error and the answer. */
function useRunner() {
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const [run, setRun] = React.useState<ToolRun | null>(null);
    const go = async (fn: () => Promise<ToolRun>) => {
        setBusy(true); setError(null);
        try { setRun(await fn()); } catch (e) { setError(toolError(e)); } finally { setBusy(false); }
    };
    return { busy, error, run, go };
}

const Problem = ({ text }: { text: string | null }) => (text ? <p role="alert" className="text-sm text-destructive">{text}</p> : null);

/* ------------------------------ bulk command ------------------------------ */

function CommandDialog({ onClose }: { onClose: () => void }) {
    const s = useScope();
    const r = useRunner();
    const [shell, setShell] = React.useState<"auto" | "powershell" | "cmd" | "bash">("auto");
    const [script, setScript] = React.useState("");
    const [timeout, setTimeoutSec] = React.useState(300);
    const [sure, setSure] = React.useState(false);
    // a shell that does not belong to the chosen system falls back to the system's own
    React.useEffect(() => {
        if ((s.scope.os === "linux" && (shell === "powershell" || shell === "cmd")) || (s.scope.os === "windows" && shell === "bash")) setShell("auto");
    }, [s.scope.os, shell]);
    const ok = s.reachable && script.trim().length > 0 && (s.reach < CONFIRM_FROM || sure);
    return (
        <Shell open onClose={onClose} wide title="Bulk command" description="Run one command on many devices at once. Each device runs it as the agent's own account, and the output comes back per device."
            footer={r.run ? <Button onClick={onClose}>Close</Button> : (
                <>
                    <Button variant="outline" onClick={onClose} disabled={r.busy}>Cancel</Button>
                    <Button disabled={!ok || r.busy} onClick={() => void r.go(() => tools.command(s.runScope, { script, shell: shell === "auto" ? undefined : shell, timeoutSec: timeout }))}>
                        {r.busy ? "Starting…" : `Run on ${s.reach || "…"} ${s.reach === 1 ? "device" : "devices"}`}
                    </Button>
                </>
            )}>
            {r.run ? <Result run={r.run} /> : (
                <>
                    <ScopePicker scope={s.scope} onChange={s.setScope} preview={s.preview} previewError={s.previewError} excluded={s.excluded} onExcludedChange={s.setExcluded} />
                    <div className="grid gap-3 sm:grid-cols-3">
                        <div className="grid gap-1">
                            <Label htmlFor="cmd-shell">Shell</Label>
                            <select id="cmd-shell" className={selectClass} value={shell} onChange={(e) => setShell(e.target.value as typeof shell)}>
                                <option value="auto">{s.scope.os === "windows" ? "PowerShell" : s.scope.os === "linux" ? "bash" : "Each device’s own (PowerShell or bash)"}</option>
                                {s.scope.os !== "linux" ? <option value="powershell">PowerShell (Windows)</option> : null}
                                {s.scope.os !== "linux" ? <option value="cmd">Command Prompt (Windows)</option> : null}
                                {s.scope.os !== "windows" ? <option value="bash">bash (Linux)</option> : null}
                            </select>
                        </div>
                        <div className="grid gap-1">
                            <Label htmlFor="cmd-timeout">Give up after (seconds)</Label>
                            <Input id="cmd-timeout" type="number" min={1} max={3600} value={timeout} onChange={(e) => setTimeoutSec(Math.min(3600, Math.max(1, Number(e.target.value) || 300)))} />
                        </div>
                    </div>
                    <div className="grid gap-1">
                        <Label htmlFor="cmd-text">Command</Label>
                        <Textarea id="cmd-text" rows={6} className="font-mono text-sm" value={script} onChange={(e) => setScript(e.target.value)} placeholder={"hostname\nGet-Date"} />
                        <p className="text-xs text-muted-foreground">The text of the command is not kept in the audit log, only that it ran and how long it was.</p>
                    </div>
                    <Confirm n={s.reach} checked={sure} onChange={setSure} what="the command" />
                    <Problem text={r.error} />
                </>
            )}
        </Shell>
    );
}

/* ------------------------------ bulk script ------------------------------ */

function ScriptDialog({ onClose }: { onClose: () => void }) {
    const s = useScope();
    const r = useRunner();
    const [scripts, setScripts] = React.useState<SavedScript[] | null>(null);
    const [loadError, setLoadError] = React.useState<string | null>(null);
    const [scriptId, setScriptId] = React.useState("");
    const [values, setValues] = React.useState<Record<string, string>>({});
    const [filter, setFilter] = React.useState("");
    const [sure, setSure] = React.useState(false);
    React.useEffect(() => { void fetchScripts().then((x) => setScripts(x.items)).catch((e) => setLoadError(toolError(e))); }, []);
    // Windows: scripts for Windows (and for both); Linux: scripts for Linux (and for both); Windows and Linux: only scripts for both
    const fits = React.useCallback((x: SavedScript) => {
        const p = scriptPlatform(x);
        const several = p === "both" || p === "all";
        return s.scope.os === "any" ? several : several || p === s.scope.os;
    }, [s.scope.os]);
    const chosen = scripts?.find((x) => x.id === scriptId && fits(x)) ?? null;
    React.useEffect(() => { setValues(Object.fromEntries((chosen?.parameters ?? []).map((p) => [p.name, p.defaultValue ?? ""]))); }, [chosen?.id]); // eslint-disable-line react-hooks/exhaustive-deps
    const missing = (chosen?.parameters ?? []).some((p) => p.required && !(values[p.name] ?? "").trim());
    const ok = s.reachable && !!chosen && !missing && (s.reach < CONFIRM_FROM || sure);
    const shown = (scripts ?? []).filter(fits).filter((x) => `${x.name} ${x.description ?? ""} ${x.category ?? ""}`.toLowerCase().includes(filter.toLowerCase()));
    return (
        <Shell open onClose={onClose} wide title="Bulk script" description="Run a script from the scripts manager on many devices at once. A PowerShell script runs on Windows devices and a bash script on Linux devices; the others are skipped."
            footer={r.run ? <Button onClick={onClose}>Close</Button> : (
                <>
                    <Button variant="outline" onClick={onClose} disabled={r.busy}>Cancel</Button>
                    <Button disabled={!ok || r.busy} onClick={() => void r.go(() => tools.script(s.runScope, scriptId, values))}>{r.busy ? "Starting…" : `Run on ${s.reach || "…"} ${s.reach === 1 ? "device" : "devices"}`}</Button>
                </>
            )}>
            {r.run ? <Result run={r.run} /> : (
                <>
                    <ScopePicker scope={s.scope} onChange={s.setScope} preview={s.preview} previewError={s.previewError} excluded={s.excluded} onExcludedChange={s.setExcluded} />
                    <div className="grid gap-2">
                        <Label htmlFor="bs-filter">Script</Label>
                        <Input id="bs-filter" placeholder="Search the scripts" value={filter} onChange={(e) => setFilter(e.target.value)} />
                        <select id="bs-script" aria-label="Script" size={6} className="w-full rounded-md border border-input bg-background p-1 text-sm" value={scriptId} onChange={(e) => setScriptId(e.target.value)}>
                            {shown.map((x) => <option key={x.id} value={x.id}>{x.name} ({{ windows: "Windows", linux: "Linux", both: "Windows and Linux", all: "Windows, Linux and macOS" }[scriptPlatform(x)]}{x.category ? `, ${x.category}` : ""})</option>)}
                        </select>
                        {loadError ? <Problem text={loadError} /> : null}
                        {scripts && scripts.length > 0 && shown.length === 0 && !filter ? (
                            <p className="text-sm text-muted-foreground" data-testid="no-fitting-scripts">
                                {s.scope.os === "any" ? "No script is made for both Windows and Linux. Choose Windows only or Linux only above to see the others." : `No script is made for ${s.scope.os === "windows" ? "Windows" : "Linux"} yet.`}
                            </p>
                        ) : null}
                        {scripts && scripts.length === 0 ? <p className="text-sm text-muted-foreground">There are no scripts yet. Add some under Automation.</p> : null}
                        {chosen?.description ? <p className="text-xs text-muted-foreground">{chosen.description}</p> : null}
                    </div>
                    {chosen && chosen.parameters.length ? (
                        <div className="grid gap-2 sm:grid-cols-2">
                            {chosen.parameters.map((p) => (
                                <div key={p.name} className="grid gap-1">
                                    <Label htmlFor={`bs-p-${p.name}`}>{p.label || p.name}{p.required ? " *" : ""}</Label>
                                    <Input id={`bs-p-${p.name}`} value={values[p.name] ?? ""} onChange={(e) => setValues((v) => ({ ...v, [p.name]: e.target.value }))} />
                                </div>
                            ))}
                        </div>
                    ) : null}
                    <Confirm n={s.reach} checked={sure} onChange={setSure} what="the script and its settings" />
                    <Problem text={r.error} />
                </>
            )}
        </Shell>
    );
}

/* ------------------------------ bulk patch management ------------------------------ */

function PatchesDialog({ onClose }: { onClose: () => void }) {
    const s = useScope();
    const r = useRunner();
    const [action, setAction] = React.useState<"scan" | "install-critical" | "install-all">("scan");
    const [optional, setOptional] = React.useState(false);
    const [sure, setSure] = React.useState(false);
    const installing = action !== "scan";
    const ok = s.reachable && (!installing || s.reach < CONFIRM_FROM || sure);
    return (
        <Shell open onClose={onClose} title="Bulk patch management" description="Scan many devices for updates, or install the updates each device's last scan found. Windows and Linux devices are both handled."
            footer={r.run ? <Button onClick={onClose}>Close</Button> : (
                <>
                    <Button variant="outline" onClick={onClose} disabled={r.busy}>Cancel</Button>
                    <Button variant={installing ? "destructive" : "default"} disabled={!ok || r.busy} onClick={() => void r.go(() => tools.patches(s.runScope, action, optional))}>
                        {r.busy ? "Starting…" : action === "scan" ? `Scan ${s.reach || "…"} ${s.reach === 1 ? "device" : "devices"}` : `Install on ${s.reach || "…"} ${s.reach === 1 ? "device" : "devices"}`}
                    </Button>
                </>
            )}>
            {r.run ? <Result run={r.run} /> : (
                <>
                    <ScopePicker scope={s.scope} onChange={s.setScope} preview={s.preview} previewError={s.previewError} excluded={s.excluded} onExcludedChange={s.setExcluded} />
                    <fieldset className="grid gap-2 rounded-lg border p-3">
                        <legend className="px-1 text-sm font-medium">What to do</legend>
                        {([
                            ["scan", "Scan for updates", "Looks for what is missing. Nothing is installed."],
                            ["install-critical", "Install critical and important updates", "Installs what each device's last scan found at that level. A device that has not been scanned is skipped."],
                            ["install-all", "Install all updates", "Installs everything each device's last scan found. Devices may restart if the updates need it."],
                        ] as const).map(([k, label, hint]) => (
                            <label key={k} className="flex cursor-pointer items-start gap-2 text-sm">
                                <input type="radio" name="patch-action" className="mt-1 accent-primary" checked={action === k} onChange={() => setAction(k)} />
                                <span><span className="font-medium">{label}</span><span className="block text-xs text-muted-foreground">{hint}</span></span>
                            </label>
                        ))}
                        <label className="mt-1 flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4 accent-primary" checked={optional} onChange={(e) => setOptional(e.target.checked)} /> Include optional updates</label>
                    </fieldset>
                    {installing ? <Confirm n={s.reach} checked={sure} onChange={setSure} what="what will be installed" /> : null}
                    <Problem text={r.error} />
                </>
            )}
        </Shell>
    );
}

/* ------------------------------ recover agents ------------------------------ */

function RecoverDialog({ onClose }: { onClose: () => void }) {
    const s = useScope();
    const r = useRunner();
    const [sure, setSure] = React.useState(false);
    const ok = s.reachable && (s.reach < CONFIRM_FROM || sure);
    return (
        <Shell open onClose={onClose} title="Recover all agents" description="Asks every online device in the choice to restart its own RemoteIQ agent. Use it when agents have stopped answering jobs or look stuck. Devices that are offline cannot be reached from here: they are listed with that reason."
            footer={r.run ? <Button onClick={onClose}>Close</Button> : (
                <>
                    <Button variant="outline" onClick={onClose} disabled={r.busy}>Cancel</Button>
                    <Button disabled={!ok || r.busy} onClick={() => void r.go(() => tools.recover(s.runScope))}>{r.busy ? "Starting…" : `Restart the agent on ${s.reach || "…"} ${s.reach === 1 ? "device" : "devices"}`}</Button>
                </>
            )}>
            {r.run ? <Result run={r.run} /> : (
                <>
                    <ScopePicker scope={s.scope} onChange={s.setScope} preview={s.preview} previewError={s.previewError} excluded={s.excluded} onExcludedChange={s.setExcluded} />
                    <p className="text-xs text-muted-foreground">The agent is back within about half a minute. Nothing else on the device is restarted, and remote sessions on it end.</p>
                    <Confirm n={s.reach} checked={sure} onChange={setSure} what="the choice" />
                    <Problem text={r.error} />
                </>
            )}
        </Shell>
    );
}

/* ------------------------------ server maintenance ------------------------------ */

function MaintenanceDialog({ onClose }: { onClose: () => void }) {
    const [tasks, setTasks] = React.useState<MaintenanceTask[] | null>(null);
    const [bounds, setBounds] = React.useState({ min: 7, max: 3650 });
    const [picked, setPicked] = React.useState<Record<string, boolean>>({});
    const [days, setDays] = React.useState<Record<string, number>>({});
    const [counts, setCounts] = React.useState<Record<string, number> | null>(null);
    const [optimize, setOptimize] = React.useState(false);
    const [sure, setSure] = React.useState(false);
    const [busy, setBusy] = React.useState<"preview" | "run" | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [done, setDone] = React.useState<Array<{ key: string; title: string; removed: number; more: boolean }> | null>(null);
    const [optimized, setOptimized] = React.useState(false);

    React.useEffect(() => {
        void tools.maintenanceList().then((l) => {
            setTasks(l.tasks); setBounds({ min: l.min, max: l.max });
            setDays(Object.fromEntries(l.tasks.map((t) => [t.key, t.defaultDays])));
        }).catch((e) => setError(toolError(e)));
    }, []);
    const chosen = (tasks ?? []).filter((t) => picked[t.key]).map((t) => ({ key: t.key, days: days[t.key] ?? t.defaultDays }));
    const daysOk = chosen.every((c) => c.days >= bounds.min && c.days <= bounds.max);
    React.useEffect(() => { setCounts(null); setSure(false); }, [picked, days]);

    const preview = async () => {
        setBusy("preview"); setError(null);
        try { const p = await tools.maintenancePreview(chosen); setCounts(Object.fromEntries(p.items.map((i) => [i.key, i.count]))); } catch (e) { setError(toolError(e)); } finally { setBusy(null); }
    };
    const run = async () => {
        setBusy("run"); setError(null);
        try { const r = await tools.maintenanceRun(chosen, optimize); setDone(r.items); setOptimized(r.optimized); } catch (e) { setError(toolError(e)); } finally { setBusy(null); }
    };
    const any = chosen.length > 0 || optimize;
    return (
        <Shell open onClose={onClose} wide title="Server maintenance" description="Clear out old history so the database stays small and fast. Only history that is read as 'what happened a while ago' is touched: never tickets, devices, customers, settings or the audit log. Open alerts are never removed."
            footer={done ? <Button onClick={onClose}>Close</Button> : (
                <>
                    <Button variant="outline" onClick={onClose} disabled={!!busy}>Cancel</Button>
                    <Button variant="outline" onClick={() => void preview()} disabled={!chosen.length || !daysOk || !!busy}>{busy === "preview" ? "Counting…" : "Count what would go"}</Button>
                    <Button variant="destructive" onClick={() => void run()} disabled={!any || !daysOk || !sure || !!busy}>{busy === "run" ? "Clearing…" : "Clear it"}</Button>
                </>
            )}>
            {done ? (
                <div className="grid gap-2" data-testid="maintenance-done" role="status">
                    <p className="text-sm font-medium">Done.</p>
                    <ul className="grid gap-1 text-sm">
                        {done.map((d) => <li key={d.key}>{d.title}: <strong>{d.removed}</strong> removed{d.more ? " (there is more: run it again)" : ""}</li>)}
                    </ul>
                    {optimized ? <p className="text-sm">The database was optimised afterwards.</p> : null}
                </div>
            ) : (
                <>
                    {!tasks && !error ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
                    <div className="grid gap-2">
                        {(tasks ?? []).map((t) => (
                            <div key={t.key} className="grid gap-2 rounded-md border p-3 sm:grid-cols-[1fr_auto] sm:items-center">
                                <label className="flex cursor-pointer items-start gap-2 text-sm">
                                    <input type="checkbox" className="mt-1 h-4 w-4 accent-primary" checked={!!picked[t.key]} onChange={(e) => setPicked((p) => ({ ...p, [t.key]: e.target.checked }))} />
                                    <span><span className="font-medium">{t.title}</span><span className="block text-xs text-muted-foreground">{t.description}</span></span>
                                </label>
                                <div className="flex items-center gap-2 text-sm">
                                    <span className="text-muted-foreground">older than</span>
                                    <Input aria-label={`Days to keep for ${t.title}`} className="h-9 w-20" type="number" min={bounds.min} max={bounds.max} value={days[t.key] ?? t.defaultDays} onChange={(e) => setDays((d) => ({ ...d, [t.key]: Number(e.target.value) }))} />
                                    <span className="text-muted-foreground">days</span>
                                    {counts && picked[t.key] ? <span className="ml-2 whitespace-nowrap font-medium">{counts[t.key] ?? 0} to remove</span> : null}
                                </div>
                            </div>
                        ))}
                    </div>
                    <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1 h-4 w-4 accent-primary" checked={optimize} onChange={(e) => setOptimize(e.target.checked)} /><span>Optimise the database afterwards<span className="block text-xs text-muted-foreground">Reclaims the space and refreshes the statistics. It can take a few minutes on a big database and is safe to run at any time.</span></span></label>
                    {!daysOk ? <p role="alert" className="text-sm text-destructive">Keep history for {bounds.min} to {bounds.max} days.</p> : null}
                    <label className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-sm">
                        <input type="checkbox" className="mt-0.5 h-4 w-4 accent-primary" checked={sure} onChange={(e) => setSure(e.target.checked)} />
                        <span>I understand that what is cleared cannot be brought back. Run the backups first if in doubt.</span>
                    </label>
                    <Problem text={error} />
                </>
            )}
        </Shell>
    );
}

/* ------------------------------ clear cache ------------------------------ */

function CacheDialog({ onClose }: { onClose: () => void }) {
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const [cleared, setCleared] = React.useState<string[] | null>(null);
    const go = async () => {
        setBusy(true); setError(null);
        try { setCleared((await tools.clearCache()).cleared); } catch (e) { setError(toolError(e)); } finally { setBusy(false); }
    };
    return (
        <Shell open onClose={onClose} title="Clear cache" description="Makes the server forget what it keeps in memory for speed: the results of policy rules, the dashboard numbers and the sign-in policy. They are rebuilt the next time they are needed, so the next few pages may be a little slower. Nothing stored is changed."
            footer={cleared ? <Button onClick={onClose}>Close</Button> : (
                <>
                    <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
                    <Button onClick={() => void go()} disabled={busy}>{busy ? "Clearing…" : "Clear the cache"}</Button>
                </>
            )}>
            {cleared ? <p role="status" className="text-sm">Cleared: {cleared.join(", ")}.</p> : <Problem text={error} />}
        </Shell>
    );
}

/* ------------------------------ the host ------------------------------ */

export default function ToolDialogs({ tool, onClose }: { tool: ToolKey | null; onClose: () => void }) {
    if (!tool) return null;
    if (tool === "command") return <CommandDialog onClose={onClose} />;
    if (tool === "script") return <ScriptDialog onClose={onClose} />;
    if (tool === "patches") return <PatchesDialog onClose={onClose} />;
    if (tool === "recover") return <RecoverDialog onClose={onClose} />;
    if (tool === "maintenance") return <MaintenanceDialog onClose={onClose} />;
    return <CacheDialog onClose={onClose} />;
}
