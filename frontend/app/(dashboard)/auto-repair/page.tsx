"use client";

// Automatic repair: the results. How many tickets and failed checks were fixed without a technician, how many were handed over and why, which problems
// are common, what to teach it next, and the knowledge base articles it wrote. Every run can be opened to read its full log (scripts and results).
import * as React from "react";
import Link from "next/link";
import { Loader2, Wrench } from "lucide-react";
import { PageHeader, PageShell } from "@/components/page-shell";
import PermGate from "@/components/perm-gate";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState, SegmentedTabs } from "@/components/list-controls";
import { errorText } from "@/components/policies/shared";
import { jfetch } from "@/lib/api";
import { autoRepair, type Report, type RunDetail } from "@/lib/auto-repair-api";
import { ago } from "@/lib/security-api";

type Run = { id: string; source: "ticket" | "alert"; ticketNumber: number | null; subject: string | null; device: string; customer: string | null; category: string | null; app: string | null; state: string; repaired: string[]; outcome: string | null; startedAt: string };

const STATE: Record<string, { label: string; cls: string }> = {
    diagnosing: { label: "Checking", cls: "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-400" },
    repairing: { label: "Repairing", cls: "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-400" },
    verifying: { label: "Confirming", cls: "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-400" },
    awaiting_user: { label: "Waiting for the person to test", cls: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400" },
    confirmed_fixed: { label: "Fixed", cls: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" },
    healed: { label: "Healed", cls: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" },
    not_fixed: { label: "Not fixed", cls: "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-400" },
    needs_technician: { label: "Handed to a technician", cls: "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-400" },
    no_issue_found: { label: "Nothing found", cls: "border-muted-foreground/40 bg-muted text-muted-foreground" },
};
const KIND: Record<string, string> = { repair: "has a repair", advice: "person is told what to do", escalate: "needs a technician" };

function Tile({ title, value, note, tone }: { title: string; value: string; note?: string; tone?: "good" | "warn" | "bad" }) {
    const color = tone === "good" ? "text-emerald-600 dark:text-emerald-400" : tone === "warn" ? "text-amber-600 dark:text-amber-400" : tone === "bad" ? "text-red-600 dark:text-red-400" : "";
    return (
        <div className="rounded-lg border p-4">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">{title}</p>
            <p className={`mt-1 text-2xl font-semibold ${color}`}>{value}</p>
            {note ? <p className="mt-0.5 text-xs text-muted-foreground">{note}</p> : null}
        </div>
    );
}

function Bar({ label, value, max, extra }: { label: string; value: number; max: number; extra?: string }) {
    return (
        <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 text-sm">
            <span className="truncate" title={label}>{label}</span><span className="tabular-nums text-muted-foreground">{value}{extra ? ` ${extra}` : ""}</span>
            <span className="col-span-2 h-2 overflow-hidden rounded-full bg-muted" aria-hidden="true"><span className="block h-full rounded-full bg-primary/70" style={{ width: `${max ? Math.max(3, (value / max) * 100) : 0}%` }} /></span>
        </li>
    );
}

function Body() {
    const [days, setDays] = React.useState(30);
    const [report, setReport] = React.useState<Report | null>(null);
    const [runs, setRuns] = React.useState<Run[]>([]);
    const [error, setError] = React.useState<string | null>(null);
    const [open, setOpen] = React.useState<RunDetail | null | "loading">(null);

    React.useEffect(() => {
        let alive = true;
        setReport(null);
        void autoRepair.report(days).then((r) => { if (alive) { setReport(r); setError(null); } }).catch((e) => { if (alive) setError(errorText(e)); });
        void jfetch<{ items: Run[] }>("/api/admin/auto-repair/runs?limit=40").then((r) => { if (alive) setRuns(r.items); }).catch(() => { });
        return () => { alive = false; };
    }, [days]);

    const show = async (id: string) => {
        setOpen("loading");
        try { setOpen(await autoRepair.run(id)); } catch (e) { setError(errorText(e)); setOpen(null); }
    };

    const maxDay = Math.max(1, ...(report?.trend ?? []).map((t) => t.fixed + t.handed + t.other));
    const hours = report ? Math.round((report.minutesSaved / 60) * 10) / 10 : 0;

    return (
        <PageShell>
            <PageHeader
                title="Automatic repair"
                description="What the automatic repair and self-healing did: how much was fixed without a technician, what was handed over and why, which problems come up most, and the knowledge base articles it wrote."
                actions={<div className="flex items-center gap-3"><Link href="/auto-repair/playbooks" className="text-sm text-primary hover:underline">Your own repairs</Link><Link href="/administration?tab=agents" className="text-sm text-primary hover:underline">Settings</Link></div>}
            />
            {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
            <SegmentedTabs
                value={String(days)}
                onChange={(v) => setDays(Number(v))}
                items={[{ key: "7", label: "7 days" }, { key: "30", label: "30 days" }, { key: "90", label: "90 days" }]}
                label="Period"
            />
            {!report ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />Loading…</div>
            ) : report.total === 0 ? (
                <EmptyState>
                    <Wrench className="mx-auto mb-2 h-6 w-6 text-muted-foreground" aria-hidden="true" />
                    Nothing has run in this period. Switch on automatic repair (and self-healing) under Administration &gt; Agents &amp; Endpoints, then submit a ticket from the tray or let a check fail.
                </EmptyState>
            ) : (
                <>
                    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" data-testid="repair-tiles">
                        <Tile title="Fixed without a technician" value={String(report.fixed)} tone="good" note={report.fixedPercent === null ? undefined : `${report.fixedPercent}% of the ${report.fixed + report.handed} that reached an answer`} />
                        <Tile title="Waiting for the person to test" value={String(report.waiting)} tone="warn" note="Repaired; the person has not answered yet" />
                        <Tile title="Handed to a technician" value={String(report.handed)} tone={report.handed ? "bad" : undefined} note={`${report.inProgress} still running`} />
                        <Tile title="Technician time saved" value={`${hours} h`} note={`An estimate: ${report.assumptionMinutesPerFix} minutes for each fix${report.averageMinutesToFix !== null ? `. A fix takes ${report.averageMinutesToFix} minutes on average.` : "."}`} />
                    </div>
                    <p className="text-xs text-muted-foreground">{report.tickets} from tickets, {report.alerts} from failed checks (self-healing), in the last {report.days} days.</p>

                    <section aria-label="Each day" className="rounded-lg border p-4">
                        <h3 className="mb-3 text-sm font-semibold">Each day</h3>
                        <div className="flex h-28 items-end gap-1" data-testid="repair-trend">
                            {report.trend.map((t) => (
                                <div key={t.day} className="flex min-w-0 flex-1 flex-col justify-end" title={`${t.day}: ${t.fixed} fixed, ${t.handed} handed over, ${t.other} other`}>
                                    <div className="w-full bg-red-500/70" style={{ height: `${(t.handed / maxDay) * 100}%` }} />
                                    <div className="w-full bg-amber-500/60" style={{ height: `${(t.other / maxDay) * 100}%` }} />
                                    <div className="w-full bg-emerald-500/70" style={{ height: `${(t.fixed / maxDay) * 100}%` }} />
                                </div>
                            ))}
                        </div>
                        <p className="mt-2 flex flex-wrap gap-3 text-xs text-muted-foreground"><span><span className="mr-1 inline-block h-2 w-2 rounded-sm bg-emerald-500/70" />Fixed</span><span><span className="mr-1 inline-block h-2 w-2 rounded-sm bg-amber-500/60" />Waiting or running</span><span><span className="mr-1 inline-block h-2 w-2 rounded-sm bg-red-500/70" />Handed over</span></p>
                    </section>

                    <div className="grid gap-4 lg:grid-cols-2">
                        <section aria-label="Why runs were handed over" className="rounded-lg border p-4">
                            <h3 className="mb-3 text-sm font-semibold">Why they were handed to a technician</h3>
                            {report.reasons.length === 0 ? <p className="text-sm text-muted-foreground">Nothing was handed over.</p> : <ul className="space-y-3" data-testid="repair-reasons">{report.reasons.map((r) => <Bar key={r.code} label={r.text} value={r.count} max={report.reasons[0].count} />)}</ul>}
                        </section>
                        <section aria-label="What to teach it next" className="rounded-lg border p-4">
                            <h3 className="mb-1 text-sm font-semibold">What to add next</h3>
                            <p className="mb-3 text-xs text-muted-foreground">Problems and programs that keep coming back to technicians with nothing automatic to do about them.</p>
                            {report.addNext.length === 0 ? <p className="text-sm text-muted-foreground">Nothing stands out yet.</p> : <ul className="space-y-3" data-testid="repair-add-next">{report.addNext.map((a) => <Bar key={a.what} label={a.what} value={a.count} max={report.addNext[0].count} />)}</ul>}
                        </section>
                    </div>

                    <section aria-label="By category" className="rounded-lg border">
                        <h3 className="border-b px-4 py-2 text-sm font-semibold">By category</h3>
                        <table className="w-full text-left text-sm">
                            <thead className="text-xs uppercase tracking-wide text-muted-foreground"><tr><th className="px-4 py-1.5">Category</th><th className="px-4 py-1.5">Runs</th><th className="px-4 py-1.5">Fixed</th><th className="px-4 py-1.5">Handed over</th></tr></thead>
                            <tbody className="divide-y">{report.byCategory.map((c) => <tr key={c.category}><td className="px-4 py-1.5">{c.category}</td><td className="px-4 py-1.5 tabular-nums">{c.total}</td><td className="px-4 py-1.5 tabular-nums">{c.fixed}</td><td className="px-4 py-1.5 tabular-nums">{c.handed}</td></tr>)}</tbody>
                        </table>
                    </section>

                    <section aria-label="Problems found" className="rounded-lg border">
                        <h3 className="border-b px-4 py-2 text-sm font-semibold">Problems found</h3>
                        {report.problemsFound.length === 0 ? <p className="px-4 py-3 text-sm text-muted-foreground">No known problem was found.</p> : (
                            <table className="w-full text-left text-sm" data-testid="repair-problems">
                                <thead className="text-xs uppercase tracking-wide text-muted-foreground"><tr><th className="px-4 py-1.5">Problem</th><th className="px-4 py-1.5">Found</th><th className="px-4 py-1.5">Repaired</th><th className="px-4 py-1.5">Repair did not hold</th></tr></thead>
                                <tbody className="divide-y">{report.problemsFound.map((p) => <tr key={p.id}><td className="px-4 py-1.5">{p.title}<span className="block text-xs text-muted-foreground">{KIND[p.kind] ?? p.kind}</span></td><td className="px-4 py-1.5 tabular-nums">{p.count}</td><td className="px-4 py-1.5 tabular-nums">{p.fixed}</td><td className="px-4 py-1.5 tabular-nums">{p.notFixed}</td></tr>)}</tbody>
                            </table>
                        )}
                    </section>

                    <section aria-label="Knowledge base articles" className="rounded-lg border">
                        <h3 className="border-b px-4 py-2 text-sm font-semibold">Knowledge base articles it wrote</h3>
                        {report.articles.length === 0 ? <p className="px-4 py-3 text-sm text-muted-foreground">None yet. An article is written the first time a repair of a kind of problem works, and never twice.</p> : (
                            <ul className="divide-y" data-testid="repair-articles">
                                {report.articles.map((a) => (
                                    <li key={a.issue} className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-2 text-sm">
                                        {a.articleId ? <Link className="font-medium text-primary hover:underline" href={`/knowledge-base/${a.articleId}`}>{a.title}</Link> : <span className="font-medium">{a.title}</span>}
                                        <span className="text-xs text-muted-foreground">written {ago(a.writtenAt)} · the problem came back {a.seen - 1} {a.seen - 1 === 1 ? "time" : "times"}</span>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </section>
                </>
            )}

            <section aria-label="Recent runs" className="rounded-lg border">
                <h3 className="border-b px-4 py-2 text-sm font-semibold">Recent runs <span className="font-normal text-muted-foreground">(open one to read everything it did, scripts included)</span></h3>
                {runs.length === 0 ? <p className="px-4 py-3 text-sm text-muted-foreground">Nothing has run yet.</p> : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-left text-sm" data-testid="repair-runs">
                            <tbody className="divide-y">
                                {runs.map((r) => (
                                    <tr key={r.id} className="cursor-pointer hover:bg-accent/30" onClick={() => void show(r.id)}>
                                        <td className="px-4 py-2"><span className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${(STATE[r.state] ?? STATE.diagnosing).cls}`}>{(STATE[r.state] ?? { label: r.state }).label}</span></td>
                                        <td className="px-4 py-2">{r.ticketNumber ? `Ticket #${r.ticketNumber}` : "Failed check"}<span className="block max-w-[22rem] truncate text-xs text-muted-foreground" title={r.subject ?? ""}>{r.subject}</span></td>
                                        <td className="px-4 py-2">{r.device}{r.customer ? <span className="block text-xs text-muted-foreground">{r.customer}</span> : null}</td>
                                        <td className="px-4 py-2 text-xs text-muted-foreground">{r.repaired.length ? `Repaired: ${r.repaired.join(", ")}` : r.outcome ?? ""}</td>
                                        <td className="whitespace-nowrap px-4 py-2 text-xs text-muted-foreground">{ago(r.startedAt)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </section>

            <Dialog open={open !== null} onOpenChange={(v) => { if (!v) setOpen(null); }}>
                <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
                    <DialogHeader>
                        <DialogTitle>{open && open !== "loading" ? `${open.source === "alert" ? "Failed check" : `Ticket #${open.ticketNumber}`} on ${open.device}` : "Loading…"}</DialogTitle>
                        <DialogDescription>{open && open !== "loading" ? `${(STATE[open.state] ?? { label: open.state }).label}${open.handoff ? `. ${open.handoff}.` : ""}${open.outcome ? ` ${open.outcome}` : ""}` : ""}</DialogDescription>
                    </DialogHeader>
                    {open === "loading" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : open ? (
                        <div className="space-y-2" data-testid="repair-log">
                            {open.ticketNumber ? <p className="text-xs"><Link className="text-primary hover:underline" href={`/tickets?q=${open.ticketNumber}`}>Open the ticket</Link></p> : null}
                            {open.events.map((e) => (
                                <div key={e.id} className={`rounded-md border p-2 text-xs ${e.internal ? "" : "border-primary/40 bg-primary/5"}`}>
                                    <p className="mb-1 text-muted-foreground">{new Date(e.at).toLocaleString()}{e.internal ? "" : " · reply to the person"}</p>
                                    <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words">{e.text}</pre>
                                </div>
                            ))}
                            <Button variant="outline" size="sm" onClick={() => setOpen(null)}>Close</Button>
                        </div>
                    ) : null}
                </DialogContent>
            </Dialog>
        </PageShell>
    );
}

export default function AutoRepairPage() {
    return (
        <PermGate require="settings.read" title="Automatic repair" message="You need permission to view settings to see the automatic repair results.">
            <Body />
        </PermGate>
    );
}
