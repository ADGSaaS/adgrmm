"use client";

// Automatic repair of problems reported from the tray app: off until it is switched on here. A person who submits a ticket from the tray picks a category
// (and, for Software Issue, the program). The computer is then checked, a known problem is repaired by a fixed script, the check runs again to make sure,
// and the person is asked to test. Anything else goes to a technician with a note of what was seen. A repair that worked also writes the KB article
// for that problem (one per problem, never a second).
import * as React from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { jfetch } from "@/lib/api";
import { ago } from "@/lib/security-api";
import type { ToastFn } from "../types";
import { AdminNote, AdminSection, AdminToggle } from "../tab-layout";

type Settings = { enabled: boolean; autoRepair: boolean; createKb: boolean; selfHealing: boolean; fromText: boolean };
type Info = Settings & { categories: string[]; problems: Array<{ id: string; kind: "repair" | "advice" | "escalate"; title: string }> };
type ScriptInfo = { name: string; title: string; language: string; purpose: string; takes: string; text: string };
type Run = { id: string; source: "ticket" | "alert"; ticketNumber: number | null; subject: string | null; device: string; customer: string | null; category: string | null; app: string | null; state: string; repaired: string[]; outcome: string | null; startedAt: string };

const STATE: Record<string, string> = {
    diagnosing: "Checking", repairing: "Repairing", verifying: "Checking the repair", awaiting_user: "Waiting for the person to test", confirmed_fixed: "Fixed (confirmed)", healed: "Healed: the alert was resolved",
    not_fixed: "Still not working: a technician", needs_technician: "Needs a technician", no_issue_found: "Nothing found: a technician",
};
const KIND: Record<string, string> = { repair: "repaired by a script", advice: "the person is told what to do", escalate: "a technician is told" };

const messageOf = (e: unknown) => {
    const raw = e instanceof Error ? e.message : "Something went wrong.";
    try { const j = JSON.parse(raw) as { message?: string | string[] }; return Array.isArray(j.message) ? j.message.join(" ") : j.message ?? raw; } catch { return raw; }
};

export default function AutoRepairCard({ push }: { push: ToastFn }) {
    const [saved, setSaved] = React.useState<Info | null>(null);
    const [s, setS] = React.useState<Settings | null>(null);
    const [runs, setRuns] = React.useState<Run[]>([]);
    const [busy, setBusy] = React.useState(false);
    const [showProblems, setShowProblems] = React.useState(false);
    const [scripts, setScripts] = React.useState<ScriptInfo[] | null>(null);
    const [showScripts, setShowScripts] = React.useState(false);

    React.useEffect(() => {
        void jfetch<Info>("/api/admin/auto-repair").then((i) => { setSaved(i); setS({ enabled: i.enabled, autoRepair: i.autoRepair, createKb: i.createKb, selfHealing: i.selfHealing, fromText: i.fromText }); }).catch((e) => push({ title: "Could not load the automatic repair settings", desc: messageOf(e), kind: "destructive" }));
        void jfetch<{ items: Run[] }>("/api/admin/auto-repair/runs?limit=15").then((r) => setRuns(r.items)).catch(() => { });
    }, [push]);
    const toggleScripts = () => {
        setShowScripts((v) => !v);
        if (!scripts) void jfetch<{ scripts: ScriptInfo[] }>("/api/admin/auto-repair/scripts").then((r) => setScripts(r.scripts)).catch((e) => push({ title: "Could not load the scripts", desc: messageOf(e), kind: "destructive" }));
    };
    if (!saved || !s) return null;

    const dirty = saved.enabled !== s.enabled || saved.autoRepair !== s.autoRepair || saved.createKb !== s.createKb || saved.selfHealing !== s.selfHealing || saved.fromText !== s.fromText;
    const save = async () => {
        setBusy(true);
        try {
            const r = await jfetch<Settings>("/api/admin/auto-repair", { method: "PUT", body: s });
            setSaved({ ...saved, ...r }); setS(r);
            push({ title: "Automatic repair settings saved", kind: "success" });
        } catch (e) {
            push({ title: "Could not save", desc: messageOf(e), kind: "destructive" });
        } finally { setBusy(false); }
    };

    return (
        <AdminSection
            title="Automatic repair (Windows)"
            description="When someone submits a ticket from the tray app, check their computer for the problems that kind of ticket can have, repair the ones that have a safe repair, confirm it worked, and ask them to test. Anything else goes to a technician with a note of what was seen."
            footer={
                <div className="flex gap-2">
                    <Button onClick={() => void save()} disabled={!dirty || busy}>{busy ? "Saving…" : "Save"}</Button>
                    {dirty ? <Button variant="outline" onClick={() => setS({ enabled: saved.enabled, autoRepair: saved.autoRepair, createKb: saved.createKb, selfHealing: saved.selfHealing, fromText: saved.fromText })} disabled={busy}>Discard</Button> : null}
                </div>
            }
        >
            <AdminToggle id="ar-on" checked={s.enabled} onCheckedChange={(v) => setS({ ...s, enabled: v })} label="Check computers automatically when a ticket comes from the tray app">
                Off by default. When on, a ticket with a category starts read-only checks on that computer. The tray app must be on, and the computer needs an agent that includes the tray app.
            </AdminToggle>
            <AdminToggle id="ar-fix" checked={s.autoRepair} onCheckedChange={(v) => setS({ ...s, autoRepair: v })} label="Repair the problems that have a safe repair" disabled={!s.enabled}>
                When off, the checks still run and a technician gets what was found, but nothing is changed on the computer. A computer is repaired for the same problem only once a day and at most three times a day.
            </AdminToggle>
            <AdminToggle id="ar-kb" checked={s.createKb} onCheckedChange={(v) => setS({ ...s, createKb: v })} label="Write a knowledge base article when a repair works" disabled={!s.enabled}>
                One article per kind of problem, published for technicians and customers, in the category &quot;Automatic repairs&quot;. A problem that already has an article is never written twice; the ticket is linked to the existing one.
            </AdminToggle>
            <AdminToggle id="ar-heal" checked={s.selfHealing} onCheckedChange={(v) => setS({ ...s, selfHealing: v })} label="Self-healing: repair a failed monitoring check without waiting for a ticket" disabled={!s.enabled}>
                When a check on a Windows computer fails (the Print Spooler, DNS Client or Time service, disk space, a ping or port), the same find, repair and confirm steps run on that computer. If the check is clean again the alert is resolved, and a ticket the alert opened is closed (when that is switched on under Alerts). Anything it cannot fix stays an alert for a technician, with the full log. Uses the repair switch above.
            </AdminToggle>
            <AdminToggle id="ar-text" checked={s.fromText} onCheckedChange={(v) => setS({ ...s, fromText: v })} label="Also check tickets that are not from the tray app (email, customer portal, technicians)" disabled={!s.enabled}>
                The words of the ticket choose the category (printing, email, internet, slow computer, sign-in, and so on) and the checks run on the computer linked to the ticket. A ticket with no computer linked, with wording that points at nothing in particular, or that sounds like a security problem is left to a person. Works on Windows and Linux computers.
            </AdminToggle>
            <AdminNote>
                Problems the checks recognise are listed below; each category has its own checks. A security or hardware ticket always stays open for a technician, however well the repair went.{" "}
                <button type="button" className="underline" onClick={() => setShowProblems((v) => !v)} aria-expanded={showProblems}>{showProblems ? "Hide the list" : `Show the ${saved.problems.length} problems`}</button>
            </AdminNote>
            <AdminNote>
                Every step, script and result is also written as a private note on the ticket it ran for (the Private notes tab). <Link className="underline" href="/auto-repair">Open the results report</Link>.{" "}
                <button type="button" className="underline" onClick={toggleScripts} aria-expanded={showScripts}>{showScripts ? "Hide the scripts" : "Show the scripts"}</button>
            </AdminNote>
            {showScripts ? (
                <div className="space-y-3" data-testid="auto-repair-scripts">
                    {!scripts ? <p className="text-sm text-muted-foreground">Loading…</p> : scripts.map((x) => (
                        <div key={x.name} className="rounded-md border">
                            <div className="border-b px-3 py-2 text-sm"><span className="font-medium">{x.title}</span> <span className="text-xs text-muted-foreground">({x.name}, {x.language})</span>
                                <p className="text-xs text-muted-foreground">{x.purpose} Given: {x.takes}.</p></div>
                            <pre className="max-h-96 overflow-auto whitespace-pre p-3 text-xs">{x.text}</pre>
                        </div>
                    ))}
                </div>
            ) : null}
            {showProblems ? (
                <ul className="grid gap-1 text-sm sm:grid-cols-2" data-testid="auto-repair-problems">
                    {saved.problems.map((p) => <li key={p.id} className="rounded-md border px-3 py-1.5"><span className="font-medium">{p.title}</span><span className="block text-xs text-muted-foreground">{KIND[p.kind]}</span></li>)}
                </ul>
            ) : null}
            <div>
                <h4 className="mb-1 text-sm font-medium">Recent runs</h4>
                {runs.length === 0 ? <p className="text-sm text-muted-foreground">Nothing has run yet.</p> : (
                    <div className="overflow-x-auto rounded-md border">
                        <table className="w-full text-left text-sm" data-testid="auto-repair-runs">
                            <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground"><tr><th className="px-3 py-1.5">Ticket</th><th className="px-3 py-1.5">Computer</th><th className="px-3 py-1.5">What they picked</th><th className="px-3 py-1.5">Where it stands</th><th className="px-3 py-1.5">When</th></tr></thead>
                            <tbody className="divide-y">
                                {runs.map((r) => (
                                    <tr key={r.id}>
                                        <td className="px-3 py-1.5">{r.ticketNumber ? <Link className="text-primary hover:underline" href={`/tickets?q=${r.ticketNumber}`}>#{r.ticketNumber}</Link> : <span className="text-xs text-muted-foreground">Alert</span>}{r.source === "alert" && r.subject ? <span className="block max-w-[14rem] truncate text-xs text-muted-foreground" title={r.subject}>{r.subject}</span> : null}</td>
                                        <td className="px-3 py-1.5">{r.device}{r.customer ? <span className="block text-xs text-muted-foreground">{r.customer}</span> : null}</td>
                                        <td className="px-3 py-1.5">{[r.category, r.app].filter(Boolean).join(", ")}</td>
                                        <td className="px-3 py-1.5">{STATE[r.state] ?? r.state}{r.repaired.length ? <span className="block text-xs text-muted-foreground">Repaired: {r.repaired.join(", ")}</span> : null}{r.outcome ? <span className="block text-xs text-muted-foreground">{r.outcome}</span> : null}</td>
                                        <td className="px-3 py-1.5 whitespace-nowrap">{ago(r.startedAt)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>
        </AdminSection>
    );
}
