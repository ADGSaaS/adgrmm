"use client";

// Import from another helpdesk (Freshdesk): connect, preview what is there, choose what to bring in, watch it run.
import * as React from "react";
import { DownloadCloud, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { jfetch } from "@/lib/api";
import type { ToastFn } from "../types";

type Options = { contacts: boolean; tickets: boolean; attachments: boolean; time: boolean };
type Preview = {
    agents: { total: number; matched: number; unmatched: string[] };
    companies: { total: number; matched: number; unmatched: string[] };
    contacts: { total: number };
    tickets: { total: number; alreadyImported: number; byStatus: Record<string, number>; unknownStatus: number; firstCreatedAt: string | null; lastCreatedAt: string | null };
};
type Progress = {
    phase?: string;
    contacts?: { done: number; skipped: number; failed: number };
    tickets?: { total: number | null; done: number; skipped: number; failed: number };
    replies?: number;
    notes?: number;
    attachments?: { saved: number; failed: number };
    time?: { done: number; skipped: number };
};
type Job = {
    id: string;
    status: "previewing" | "previewed" | "running" | "completed" | "failed" | "cancelled" | "interrupted";
    host: string;
    options: Partial<Options>;
    preview: Preview | null;
    progress: Progress;
    errors: { kind: string; id: string; message: string }[];
    message: string | null;
    createdAt: string;
    finishedAt: string | null;
};

const messageOf = (e: unknown) => {
    const raw = e instanceof Error ? e.message : "Something went wrong.";
    try { const j = JSON.parse(raw) as { message?: string | string[] }; return Array.isArray(j.message) ? j.message.join(" ") : j.message ?? raw; } catch { return raw; }
};
const day = (s: string | null) => (s ? new Date(s).toLocaleDateString() : "");
const STATUS_TEXT: Record<Job["status"], string> = {
    previewing: "Reading Freshdesk…",
    previewed: "Ready to import",
    running: "Importing…",
    completed: "Finished",
    failed: "Failed",
    cancelled: "Cancelled",
    interrupted: "Interrupted",
};

export default function ImportTab({ push }: { push: ToastFn }) {
    const [jobs, setJobs] = React.useState<Job[] | null>(null);
    const [current, setCurrent] = React.useState<Job | null>(null);
    const [domain, setDomain] = React.useState("");
    const [apiKey, setApiKey] = React.useState("");
    const [opts, setOpts] = React.useState<Options>({ contacts: true, tickets: true, attachments: true, time: true });
    const [busy, setBusy] = React.useState(false);

    const refresh = React.useCallback(async () => {
        try {
            const r = await jfetch<{ items: Job[] }>("/api/admin/import/jobs");
            setJobs(r.items);
            setCurrent((c) => {
                if (c) return r.items.find((j) => j.id === c.id) ?? c;
                // Pick up a job that is still going (for example after a page reload).
                return r.items.find((j) => ["previewing", "previewed", "running"].includes(j.status)) ?? null;
            });
        } catch (e) {
            push({ title: "Could not load imports", desc: messageOf(e), kind: "destructive" });
            setJobs([]);
        }
    }, [push]);

    React.useEffect(() => { void refresh(); }, [refresh]);

    const active = current && (current.status === "previewing" || current.status === "running");
    React.useEffect(() => {
        if (!active) return;
        const t = window.setInterval(() => void refresh(), 2000);
        return () => window.clearInterval(t);
    }, [active, refresh]);

    async function startPreview() {
        setBusy(true);
        try {
            const r = await jfetch<{ id: string }>("/api/admin/import/freshdesk/preview", { method: "POST", body: { domain, apiKey } });
            setApiKey("");
            setCurrent(null);
            await refresh();
            setCurrent((await jfetch<Job>(`/api/admin/import/jobs/${r.id}`)));
        } catch (e) {
            push({ title: "Could not start", desc: messageOf(e), kind: "destructive" });
        } finally {
            setBusy(false);
        }
    }

    async function startRun(job: Job) {
        const p = job.preview;
        const what = [opts.contacts && "contacts", "tickets", opts.attachments && "attachments", opts.time && "time"].filter(Boolean).join(", ");
        if (!window.confirm(`Import ${p ? `${p.tickets.total - p.tickets.alreadyImported} tickets` : "tickets"} (${what}) from ${job.host}? Nothing in Freshdesk is changed. What is already imported is skipped.`)) return;
        setBusy(true);
        try {
            setCurrent(await jfetch<Job>(`/api/admin/import/jobs/${job.id}/run`, { method: "POST", body: opts }));
        } catch (e) {
            push({ title: "Could not start the import", desc: messageOf(e), kind: "destructive" });
        } finally {
            setBusy(false);
        }
    }

    async function cancel(job: Job) {
        try {
            setCurrent(await jfetch<Job>(`/api/admin/import/jobs/${job.id}/cancel`, { method: "POST" }));
        } catch (e) {
            push({ title: "Could not cancel", desc: messageOf(e), kind: "destructive" });
        }
    }

    if (!jobs) return <div className="p-4 text-sm text-muted-foreground">Loading…</div>;

    const canPreview = domain.trim().length > 0 && apiKey.trim().length > 0 && !busy;
    const pr = current?.progress ?? {};
    const processed = (pr.tickets?.done ?? 0) + (pr.tickets?.skipped ?? 0) + (pr.tickets?.failed ?? 0);
    const total = pr.tickets?.total ?? current?.preview?.tickets.total ?? 0;
    const pct = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
    const ended = current && ["completed", "failed", "cancelled", "interrupted"].includes(current.status);

    return (
        <div className="grid w-full min-w-0 gap-6">
            <div>
                <h2 className="flex items-center gap-2 text-xl font-semibold tracking-tight"><DownloadCloud className="h-5 w-5" aria-hidden /> Import from Freshdesk</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                    Bring over your tickets with every reply and private note, contacts and companies, attachments and logged time. You see a preview first, nothing in Freshdesk is changed,
                    and running it again skips what is already in.
                </p>
            </div>

            {!current || ended ? (
                <div className="grid gap-3 rounded-xl border border-border/70 bg-card p-5 shadow-sm">
                    <div className="text-sm font-medium">{ended ? "Start another import" : "Connect to Freshdesk"}</div>
                    <div className="grid gap-3 sm:grid-cols-2">
                        <div className="grid gap-1">
                            <Label htmlFor="imp-domain" className="text-sm">Freshdesk address</Label>
                            <Input id="imp-domain" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="yourcompany.freshdesk.com" autoComplete="off" />
                        </div>
                        <div className="grid gap-1">
                            <Label htmlFor="imp-key" className="text-sm">API key</Label>
                            <Input id="imp-key" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="From your Freshdesk profile settings" autoComplete="new-password" />
                        </div>
                    </div>
                    <p className="text-xs text-muted-foreground">Use the key of an administrator, so every ticket can be read. The key is stored encrypted only while the import runs, then removed.</p>
                    <div><Button size="sm" onClick={startPreview} disabled={!canPreview}>{busy ? "Starting…" : "Read Freshdesk and preview"}</Button></div>
                </div>
            ) : null}

            {current ? (
                <div className="grid gap-3 rounded-xl border border-border/70 bg-card p-5 shadow-sm">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                        <span className="font-medium">{current.host}</span>
                        <span className={`rounded-full border px-2 py-0.5 text-xs ${current.status === "completed" ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : current.status === "failed" || current.status === "interrupted" ? "border-destructive/40 bg-destructive/10 text-destructive" : "text-muted-foreground"}`}>
                            {STATUS_TEXT[current.status]}
                        </span>
                        {active ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden /> : null}
                        {current.status === "previewing" && current.progress.tickets?.total ? <span className="text-xs text-muted-foreground">{current.progress.tickets.total} tickets found so far</span> : null}
                    </div>
                    {current.message ? <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-sm text-destructive">{current.message}</p> : null}

                    {current.preview && ["previewed", "running", "completed", "cancelled", "failed", "interrupted"].includes(current.status) ? (
                        <PreviewSummary p={current.preview} />
                    ) : null}

                    {current.status === "previewed" && current.preview ? (
                        <div className="grid gap-2 border-t pt-3">
                            <div className="text-sm font-medium">What to import</div>
                            <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="h-4 w-4 shrink-0 rounded border-input accent-primary" checked readOnly disabled /> <span>Tickets with every reply and private note, tags and dates</span></label>
                            <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="h-4 w-4 shrink-0 rounded border-input accent-primary" checked={opts.contacts} onChange={(e) => setOpts({ ...opts, contacts: e.target.checked })} /> <span>Contacts and companies <span className="text-xs text-muted-foreground">(a company that matches one of your customers by name also lists its people there)</span></span></label>
                            <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="h-4 w-4 shrink-0 rounded border-input accent-primary" checked={opts.attachments} onChange={(e) => setOpts({ ...opts, attachments: e.target.checked })} /> <span>Attachments <span className="text-xs text-muted-foreground">(files up to 25 MB each; slower)</span></span></label>
                            <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="h-4 w-4 shrink-0 rounded border-input accent-primary" checked={opts.time} onChange={(e) => setOpts({ ...opts, time: e.target.checked })} /> <span>Logged time <span className="text-xs text-muted-foreground">(kept on the ticket for the record. It is never put on an invoice.)</span></span></label>
                            <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
                                <li>Imported tickets get new numbers here. Each says &ldquo;Imported from Freshdesk (ticket #…)&rdquo; in its history.</li>
                                <li>Nobody is emailed about anything that is imported.</li>
                                <li>Agents are matched to your users by email. Tickets of other agents are left unassigned.</li>
                            </ul>
                            <div className="flex gap-2 pt-1">
                                <Button size="sm" onClick={() => startRun(current)} disabled={busy || current.preview.tickets.total - current.preview.tickets.alreadyImported <= 0 && !opts.contacts}>
                                    Start import
                                </Button>
                                <Button size="sm" variant="outline" onClick={() => setCurrent(null)} disabled={busy}>Discard preview</Button>
                            </div>
                        </div>
                    ) : null}

                    {current.status === "running" || ended ? (
                        <div className="grid gap-2 border-t pt-3">
                            {total > 0 ? (
                                <div>
                                    <div className="h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Import progress">
                                        <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
                                    </div>
                                    <div className="mt-1 text-xs text-muted-foreground">{processed} of {total} tickets ({pct}%){pr.phase && current.status === "running" ? `, now: ${pr.phase}` : ""}</div>
                                </div>
                            ) : null}
                            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
                                <Stat label="Tickets imported" value={pr.tickets?.done} />
                                <Stat label="Already imported (skipped)" value={pr.tickets?.skipped} />
                                <Stat label="Tickets that failed" value={pr.tickets?.failed} bad />
                                <Stat label="Replies" value={pr.replies} />
                                <Stat label="Private notes" value={pr.notes} />
                                <Stat label="Contacts imported" value={pr.contacts?.done} />
                                <Stat label="Files saved" value={pr.attachments?.saved} />
                                <Stat label="Files that failed" value={pr.attachments?.failed} bad />
                                <Stat label="Time entries" value={pr.time?.done} />
                            </dl>
                            {current.status === "running" ? <div><Button size="sm" variant="outline" onClick={() => cancel(current)}>Cancel</Button></div> : null}
                            {ended && (current.progress.tickets?.failed ?? 0) + (current.progress.attachments?.failed ?? 0) > 0 ? (
                                <p className="text-xs text-muted-foreground">Some items failed. Start another import: what is already in is skipped, so only the missing ones are tried again.</p>
                            ) : null}
                            {current.errors.length > 0 ? (
                                <details className="text-xs">
                                    <summary className="cursor-pointer text-sm">{current.errors.length} problem{current.errors.length === 1 ? "" : "s"}</summary>
                                    <ul className="mt-1 max-h-48 space-y-1 overflow-auto">
                                        {current.errors.map((e, i) => <li key={i} className="font-mono"><b>{e.kind} {e.id}</b>: {e.message}</li>)}
                                    </ul>
                                </details>
                            ) : null}
                        </div>
                    ) : null}
                </div>
            ) : null}

            {jobs.length > 0 ? (
                <div className="rounded-xl border border-border/70 bg-card p-5 shadow-sm">
                    <div className="mb-1 text-sm font-medium">Earlier imports</div>
                    <ul className="divide-y text-sm">
                        {jobs.map((j) => (
                            <li key={j.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                                <span>{j.host} <span className="text-xs text-muted-foreground">{day(j.createdAt)}</span></span>
                                <span className="text-xs text-muted-foreground">
                                    {STATUS_TEXT[j.status]}{j.progress.tickets ? ` · ${j.progress.tickets.done} tickets` : ""}
                                </span>
                                <Button size="sm" variant="ghost" onClick={() => setCurrent(j)}>Details</Button>
                            </li>
                        ))}
                    </ul>
                </div>
            ) : null}
        </div>
    );
}

function Stat({ label, value, bad }: { label: string; value: number | undefined; bad?: boolean }) {
    return (
        <div>
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className={`tabular-nums ${bad && (value ?? 0) > 0 ? "font-medium text-destructive" : ""}`}>{value ?? 0}</dd>
        </div>
    );
}

function PreviewSummary({ p }: { p: Preview }) {
    return (
        <div className="grid gap-2 text-sm">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div><div className="text-2xl font-semibold tabular-nums">{p.tickets.total}</div><div className="text-xs text-muted-foreground">tickets{p.tickets.firstCreatedAt ? ` (${day(p.tickets.firstCreatedAt)} to ${day(p.tickets.lastCreatedAt)})` : ""}</div></div>
                <div><div className="text-2xl font-semibold tabular-nums">{p.tickets.alreadyImported}</div><div className="text-xs text-muted-foreground">already imported</div></div>
                <div><div className="text-2xl font-semibold tabular-nums">{p.contacts.total}</div><div className="text-xs text-muted-foreground">contacts</div></div>
                <div><div className="text-2xl font-semibold tabular-nums">{p.companies.total}</div><div className="text-xs text-muted-foreground">companies ({p.companies.matched} match your customers)</div></div>
            </div>
            <div className="flex flex-wrap gap-2 text-xs">
                {Object.entries(p.tickets.byStatus).map(([k, v]) => <span key={k} className="rounded-full border px-2 py-0.5">{k}: {v}</span>)}
            </div>
            {p.tickets.unknownStatus > 0 ? (
                <p className="text-xs text-amber-700 dark:text-amber-300">{p.tickets.unknownStatus} tickets have a custom status that has no match here. They will be imported as Open.</p>
            ) : null}
            <p className="text-xs text-muted-foreground">
                Agents: {p.agents.matched} of {p.agents.total} match a user here by email.
                {p.agents.unmatched.length > 0 ? ` Not matched (their tickets are left unassigned): ${p.agents.unmatched.slice(0, 8).join(", ")}${p.agents.unmatched.length > 8 ? "…" : ""}.` : ""}
            </p>
            {p.companies.unmatched.length > 0 ? (
                <p className="text-xs text-muted-foreground">
                    Companies with no customer of the same name here: {p.companies.unmatched.slice(0, 8).join(", ")}{p.companies.unmatched.length > 8 ? "…" : ""}. They are not created. Their people are still imported as contacts, with the company noted.
                </p>
            ) : null}
        </div>
    );
}
