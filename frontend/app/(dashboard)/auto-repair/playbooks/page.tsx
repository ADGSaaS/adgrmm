"use client";

// Your own repairs for the automatic repair: a problem you describe, a script that detects it (read only) and a script that repairs it. A repair runs by itself
// only after the Owner approves the exact scripts, once they have been tried on a computer; editing the scripts takes the approval away.
import * as React from "react";
import Link from "next/link";
import { Loader2, Plus, ShieldCheck } from "lucide-react";
import { PageHeader, PageShell } from "@/components/page-shell";
import PermGate from "@/components/perm-gate";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EmptyState } from "@/components/list-controls";
import { errorText } from "@/components/policies/shared";
import { fetchDevices, type Device } from "@/lib/api";
import { playbooks, type Playbook, type PlaybookInput, type TestState } from "@/lib/auto-repair-api";
import { hasPerm } from "@/lib/permissions";
import { ago } from "@/lib/security-api";
import { useMe } from "@/lib/use-me";

const CATEGORIES = ["Software Issue", "Printing", "Internet or network", "Email", "Slow computer", "Sign-in or password", "Hardware", "Security concern", "Other"];
const selectClass = "h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const areaClass = "min-h-40 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const RISK: Record<string, string> = { low: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400", medium: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400", high: "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-400" };

const DETECT_EXAMPLE = `# Print DETECTED| followed by what you found, when the problem is there. Print nothing like that when it is not.
# This script only reads: it must not change anything.
$svc = Get-Service -Name 'Fax' -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -ne 'Running') { Write-Output ('DETECTED|The Fax service is ' + $svc.Status) }`;
const FIX_EXAMPLE = `# Print FIXED| and what you did, or FAILED| and why. When RIQ_DRYRUN is 1 (a trial), change nothing and say what you would do.
if ($env:RIQ_DRYRUN -eq '1') { Write-Output 'FIXED|DRY RUN: would start the Fax service'; return }
Start-Service -Name 'Fax'
if ((Get-Service -Name 'Fax').Status -eq 'Running') { Write-Output 'FIXED|Started the Fax service' } else { Write-Output 'FAILED|The Fax service would not start' }`;

const blank = (): PlaybookInput => ({ title: "", plain: "", signs: "", fixText: "", ifItReturns: "", categories: [], appWords: [], checkService: null, checkMetric: null, detectScript: DETECT_EXAMPLE, fixScript: FIX_EXAMPLE, risk: "low" });

function TestPill({ t, label }: { t: TestState; label: string }) {
    if (!t) return null;
    const cls = t.state === "passed" ? "text-emerald-600 dark:text-emerald-400" : t.state === "failed" ? "text-red-600 dark:text-red-400" : "text-muted-foreground";
    const text = t.state === "passed" ? "passed" : t.state === "failed" ? "failed" : t.state === "old" ? "tested before the last edit" : "not tried yet";
    return <span className={`text-xs ${cls}`}>{label}: {text}</span>;
}

function Editor({ pb, onClose, onSaved }: { pb: Playbook | null; onClose: () => void; onSaved: () => void }) {
    const [f, setF] = React.useState<PlaybookInput>(pb ? { title: pb.title, plain: pb.plain, signs: pb.signs, fixText: pb.fixText, ifItReturns: pb.ifItReturns, categories: pb.categories, appWords: pb.appWords, checkService: pb.checkService, checkMetric: pb.checkMetric, detectScript: pb.detectScript, fixScript: pb.fixScript, risk: pb.risk } : blank());
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const set = <K extends keyof PlaybookInput>(k: K, v: PlaybookInput[K]) => setF((x) => ({ ...x, [k]: v }));
    const toggle = (c: string) => set("categories", f.categories.includes(c) ? f.categories.filter((x) => x !== c) : [...f.categories, c]);
    const save = async () => {
        setBusy(true); setError(null);
        try { if (pb) await playbooks.update(pb.id, f); else await playbooks.create(f); onSaved(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
    };
    return (
        <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
            <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
                <DialogHeader>
                    <DialogTitle>{pb ? `Edit: ${pb.title}` : "A new repair"}</DialogTitle>
                    <DialogDescription>{pb ? "Saving a change to the scripts or to when it runs takes the approval away: it has to be tried and approved again." : "It is saved as a draft. It runs by itself only after it has been tried on a computer and the Owner has approved it."}</DialogDescription>
                </DialogHeader>
                <div className="space-y-3">
                    <div className="grid gap-1"><Label htmlFor="pb-title">What is the problem called?</Label><Input id="pb-title" value={f.title} maxLength={120} onChange={(e) => set("title", e.target.value)} placeholder="The Fax service is stuck" /></div>
                    <div className="grid gap-1"><Label htmlFor="pb-plain">What it means for the person, in one sentence (it follows &quot;we found that&quot; in the reply)</Label><Input id="pb-plain" value={f.plain} maxLength={300} onChange={(e) => set("plain", e.target.value)} placeholder="the fax service had stopped, so faxes could not leave" /></div>
                    <fieldset className="grid gap-1.5"><legend className="text-sm font-medium">When should it be looked for? (a ticket in any of these categories)</legend>
                        <div className="flex flex-wrap gap-x-4 gap-y-1">{CATEGORIES.map((c) => <label key={c} className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={f.categories.includes(c)} onChange={() => toggle(c)} />{c}</label>)}</div>
                    </fieldset>
                    {f.categories.includes("Software Issue") ? <div className="grid gap-1"><Label htmlFor="pb-words">Only for these programs (words in the program&apos;s name, separated by commas; leave empty for any)</Label><Input id="pb-words" value={f.appWords.join(", ")} onChange={(e) => set("appWords", e.target.value.split(",").map((x) => x.trim()).filter(Boolean))} placeholder="quickbooks, intuit" /></div> : null}
                    <div className="grid gap-3 sm:grid-cols-2">
                        <div className="grid gap-1"><Label htmlFor="pb-svc">…or when a monitoring check on this Windows service fails</Label><Input id="pb-svc" value={f.checkService ?? ""} maxLength={80} onChange={(e) => set("checkService", e.target.value || null)} placeholder="Fax" /></div>
                        <div className="grid gap-1"><Label htmlFor="pb-metric">…or when a disk or processor check fails</Label>
                            <select id="pb-metric" className={selectClass} value={f.checkMetric ?? ""} onChange={(e) => set("checkMetric", (e.target.value || null) as PlaybookInput["checkMetric"])}><option value="">No</option><option value="disk">Disk space</option><option value="cpu">Processor</option></select></div>
                    </div>
                    <div className="grid gap-1"><Label htmlFor="pb-detect">Detection script (PowerShell, read only)</Label><textarea id="pb-detect" className={areaClass} spellCheck={false} value={f.detectScript} onChange={(e) => set("detectScript", e.target.value)} /></div>
                    <div className="grid gap-1"><Label htmlFor="pb-fix">Repair script (PowerShell). Leave empty to only detect: a technician is then told.</Label><textarea id="pb-fix" className={areaClass} spellCheck={false} value={f.fixScript} onChange={(e) => set("fixScript", e.target.value)} /></div>
                    <div className="grid gap-1"><Label htmlFor="pb-fixtext">What the repair does, in plain words (shown to the person and in the knowledge base)</Label><Input id="pb-fixtext" value={f.fixText} maxLength={600} onChange={(e) => set("fixText", e.target.value)} placeholder="Started the Fax service." /></div>
                    <div className="grid gap-1"><Label htmlFor="pb-signs">The signs, for the knowledge base article</Label><Input id="pb-signs" value={f.signs} maxLength={1000} onChange={(e) => set("signs", e.target.value)} /></div>
                    <div className="grid gap-1"><Label htmlFor="pb-ret">If it comes back</Label><Input id="pb-ret" value={f.ifItReturns} maxLength={600} onChange={(e) => set("ifItReturns", e.target.value)} /></div>
                    <div className="grid gap-1 sm:w-1/2"><Label htmlFor="pb-risk">How risky is the repair?</Label>
                        <select id="pb-risk" className={selectClass} value={f.risk} onChange={(e) => set("risk", e.target.value as PlaybookInput["risk"])}><option value="low">Low: harmless if it goes wrong</option><option value="medium">Medium: could disturb the person or a program</option><option value="high">High: could lose data or stop something important</option></select></div>
                    <p className="text-xs text-muted-foreground">Scripts that restart or shut down the computer, or format or wipe a disk, are refused. Both scripts run on the computer as the system account.</p>
                    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
                </div>
                <DialogFooter><Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button><Button onClick={() => void save()} disabled={busy}>{busy ? "Saving…" : pb ? "Save" : "Create as a draft"}</Button></DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function TestDialog({ pb, onClose, onDone }: { pb: Playbook; onClose: () => void; onDone: () => void }) {
    const [q, setQ] = React.useState("");
    const [found, setFound] = React.useState<Device[]>([]);
    const [deviceId, setDeviceId] = React.useState("");
    const [mode, setMode] = React.useState<"detect" | "dryrun">("detect");
    const [run, setRun] = React.useState<{ state: "idle" | "running" | "passed" | "failed"; summary?: string; output?: string }>({ state: "idle" });
    const [error, setError] = React.useState<string | null>(null);
    React.useEffect(() => {
        const t = setTimeout(() => { void fetchDevices(30, null, q.trim() ? { q: q.trim() } : undefined).then((r) => setFound(r.items.filter((d) => /windows/i.test(String((d as { os?: string; operating_system?: string }).os ?? (d as { operating_system?: string }).operating_system ?? "windows"))))).catch(() => { }); }, 250);
        return () => clearTimeout(t);
    }, [q]);
    const go = async () => {
        setError(null); setRun({ state: "running" });
        try {
            const { jobId } = await playbooks.startTest(pb.id, deviceId, mode);
            for (let i = 0; i < 120; i++) {
                await new Promise((r) => setTimeout(r, 2500));
                const r = await playbooks.testResult(pb.id, jobId, mode);
                if (r.state !== "running") { setRun(r); onDone(); return; }
            }
            setRun({ state: "failed", summary: "The computer did not answer in time." });
        } catch (e) { setError(errorText(e)); setRun({ state: "idle" }); }
    };
    return (
        <Dialog open onOpenChange={(v) => { if (!v && run.state !== "running") onClose(); }}>
            <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
                <DialogHeader><DialogTitle>Try it on a computer: {pb.title}</DialogTitle><DialogDescription>The detection only reads. The dry run runs the repair with RIQ_DRYRUN=1: a repair written to honour it changes nothing. Pick a Windows computer that is online.</DialogDescription></DialogHeader>
                <div className="space-y-3">
                    <div className="grid gap-1"><Label htmlFor="t-q">Find a computer</Label><Input id="t-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name" /></div>
                    <select aria-label="Computer" className={selectClass} value={deviceId} onChange={(e) => setDeviceId(e.target.value)}><option value="">Choose a computer…</option>{found.map((d) => <option key={d.id} value={d.id}>{(d as { alias?: string; hostname?: string }).alias || (d as { hostname?: string }).hostname}</option>)}</select>
                    <div className="flex gap-4 text-sm"><label className="flex items-center gap-1.5"><input type="radio" checked={mode === "detect"} onChange={() => setMode("detect")} />Detection (read only)</label>{pb.fixScript ? <label className="flex items-center gap-1.5"><input type="radio" checked={mode === "dryrun"} onChange={() => setMode("dryrun")} />Repair as a dry run</label> : null}</div>
                    <Button onClick={() => void go()} disabled={!deviceId || run.state === "running"} className="gap-2">{run.state === "running" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}{run.state === "running" ? "Running…" : "Run it"}</Button>
                    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
                    {run.state === "passed" || run.state === "failed" ? (
                        <div data-testid="playbook-test-result" className="space-y-1">
                            <p className={`text-sm font-medium ${run.state === "passed" ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>{run.state === "passed" ? "Passed" : "Failed"}: {run.summary}</p>
                            <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border p-2 text-xs">{run.output}</pre>
                        </div>
                    ) : null}
                </div>
                <DialogFooter><Button variant="outline" onClick={onClose} disabled={run.state === "running"}>Close</Button></DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function Body() {
    const { permissions } = useMe();
    const canWrite = hasPerm(permissions, "settings.write");
    const isOwner = hasPerm(permissions, "agents.release.manage");
    const [items, setItems] = React.useState<Playbook[] | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [editing, setEditing] = React.useState<Playbook | "new" | null>(null);
    const [testing, setTesting] = React.useState<Playbook | null>(null);
    const [busy, setBusy] = React.useState<string | null>(null);

    const load = React.useCallback(async () => { try { setItems((await playbooks.list()).items); setError(null); } catch (e) { setError(errorText(e)); setItems((x) => x ?? []); } }, []);
    React.useEffect(() => { void load(); }, [load]);
    const act = async (id: string, fn: () => Promise<unknown>, confirm?: string) => {
        if (confirm && !window.confirm(confirm)) return;
        setBusy(id); setError(null);
        try { await fn(); await load(); } catch (e) { setError(errorText(e)); } finally { setBusy(null); }
    };

    return (
        <PageShell>
            <PageHeader
                title="Your own repairs"
                description="Teach the automatic repair a problem of your own: a script that detects it and a script that repairs it. It runs by itself only after you have tried it on a computer and the Owner has approved the exact scripts. Editing them takes the approval away."
                actions={<div className="flex items-center gap-3"><Link href="/auto-repair" className="text-sm text-primary hover:underline">Results</Link>{canWrite ? <Button size="sm" className="gap-2" onClick={() => setEditing("new")}><Plus className="h-4 w-4" aria-hidden="true" />New repair</Button> : null}</div>}
            />
            {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
            {!items ? <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />Loading…</div> : items.length === 0 ? (
                <EmptyState><ShieldCheck className="mx-auto mb-2 h-6 w-6 text-muted-foreground" aria-hidden="true" />You have not added a repair yet. The built-in ones cover printing, the network, the clock, security settings, disk space and Teams. Add your own for what keeps coming back to technicians.</EmptyState>
            ) : (
                <ul className="space-y-3" data-testid="playbook-list">
                    {items.map((p) => (
                        <li key={p.id} className="rounded-lg border p-4">
                            <div className="flex flex-wrap items-start justify-between gap-2">
                                <div className="min-w-0">
                                    <p className="font-medium">{p.title} <span className="text-xs font-normal text-muted-foreground">({p.key}, version {p.version})</span></p>
                                    <p className="text-sm text-muted-foreground">{p.plain}</p>
                                    <p className="mt-1 text-xs text-muted-foreground">Runs for: {[...p.categories, p.checkService ? `a failed check on the ${p.checkService} service` : "", p.checkMetric ? `a failed ${p.checkMetric} check` : ""].filter(Boolean).join(", ")}{p.appWords.length ? ` (programs: ${p.appWords.join(", ")})` : ""}. {p.fixScript ? "Detects and repairs." : "Detects only: a technician is told."}</p>
                                </div>
                                <div className="flex items-center gap-2">
                                    <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${RISK[p.risk]}`}>{p.risk} risk</span>
                                    <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${p.status === "approved" ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" : p.status === "disabled" ? "border-muted-foreground/40 bg-muted text-muted-foreground" : "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400"}`}>{p.status === "approved" ? "Approved: runs by itself" : p.status === "disabled" ? "Switched off" : "Draft: does not run"}</span>
                                </div>
                            </div>
                            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1"><TestPill t={p.tests.detect} label="Detection" /><TestPill t={p.tests.dryrun} label="Dry run" />{p.approvedBy ? <span className="text-xs text-muted-foreground">Approved by {p.approvedBy}{p.approvedAt ? ` ${ago(p.approvedAt)}` : ""}</span> : null}</div>
                            {p.warnings.length ? <p className="mt-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-800 dark:text-amber-300" data-testid="playbook-warnings">Look closely before approving: the scripts {p.warnings.join("; ")}.</p> : null}
                            <div className="mt-3 flex flex-wrap gap-2">
                                {canWrite ? <Button variant="outline" size="sm" onClick={() => setEditing(p)}>Edit</Button> : null}
                                {canWrite ? <Button variant="outline" size="sm" onClick={() => setTesting(p)}>Try it on a computer</Button> : null}
                                {isOwner && p.status !== "approved" && p.status !== "disabled" ? <Button size="sm" disabled={busy === p.id} onClick={() => void act(p.id, () => playbooks.approve(p.id), `Approve these exact scripts to run by themselves on customers' computers (${p.risk} risk)?`)}>Approve</Button> : null}
                                {isOwner && p.status === "disabled" ? <Button size="sm" disabled={busy === p.id} onClick={() => void act(p.id, () => playbooks.enable(p.id))}>Switch on</Button> : null}
                                {canWrite && p.status === "approved" ? <Button variant="outline" size="sm" disabled={busy === p.id} onClick={() => void act(p.id, () => playbooks.disable(p.id))}>Switch off</Button> : null}
                                {canWrite ? <Button variant="ghost" size="sm" disabled={busy === p.id} onClick={() => void act(p.id, () => playbooks.remove(p.id), `Delete "${p.title}"?`)}>Delete</Button> : null}
                            </div>
                            {!isOwner && p.status !== "approved" && p.status !== "disabled" ? <p className="mt-2 text-xs text-muted-foreground">The Owner approves repairs after they have been tried on a computer.</p> : null}
                        </li>
                    ))}
                </ul>
            )}
            {editing ? <Editor pb={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} /> : null}
            {testing ? <TestDialog pb={testing} onClose={() => setTesting(null)} onDone={() => void load()} /> : null}
        </PageShell>
    );
}

export default function PlaybooksPage() {
    return (
        <PermGate require="settings.read" title="Your own repairs" message="You need permission to view settings to see the automatic repairs.">
            <Body />
        </PermGate>
    );
}
