"use client";

// Customer satisfaction surveys: when a ticket is resolved or closed the person who asked gets a one-question survey by
// email. Here: when and to whom it is sent, who is told about a low score, and the results.
import * as React from "react";
import Link from "next/link";
import { SmilePlus, Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { jfetch } from "@/lib/api";
import type { ToastFn } from "../types";

const messageOf = (e: unknown) => {
    const raw = e instanceof Error ? e.message : "Something went wrong.";
    try { const j = JSON.parse(raw) as { message?: string | string[] }; return Array.isArray(j.message) ? j.message.join(" ") : j.message ?? raw; } catch { return raw; }
};

type Settings = {
    enabled: boolean;
    triggerStatuses: string[];
    delayMinutes: number;
    scope: "all" | "selected";
    clientIds: string[];
    throttleDays: number;
    reminderEnabled: boolean;
    reminderAfterDays: number;
    expiryDays: number;
    scale: "stars" | "thumbs";
    lowThreshold: number;
    alertUserIds: string[];
    alertGroupIds: string[];
};
type Options = { clients: { id: string; name: string }[]; users: { id: string; name: string; email: string }[]; groups: { id: string; name: string }[] };
type Group = { id: string | null; name: string; sent: number; answered: number; responseRate: number | null; average: number | null; low: number };
type Recent = { id: string; ticketId: string; number: number; subject: string; score: number; comment: string | null; answeredAt: string; requester: string; customer: string | null; technician: string | null };
type Summary = {
    days: number; scale: "stars" | "thumbs"; lowThreshold: number; sent: number; answered: number; responseRate: number | null; average: number | null; satisfied: number | null; low: number;
    distribution: { score: number; count: number }[]; waiting: number; failed: number; throttled: number;
    byTechnician: Group[]; byCustomer: Group[]; comments: Recent[]; lowScores: Recent[];
};

const pct = (v: number | null) => (v === null ? "-" : `${Math.round(v * 100)}%`);
const avg = (v: number | null) => (v === null ? "-" : v.toFixed(2));
const DELAYS: [number, string][] = [[0, "Right away"], [60, "1 hour"], [240, "4 hours"], [1440, "1 day"], [4320, "3 days"]];

export default function SurveysTab({ push }: { push: ToastFn }) {
    const [section, setSection] = React.useState<"results" | "settings">("results");
    return (
        <div className="grid w-full min-w-0 gap-6">
            <div>
                <h2 className="flex items-center gap-2 text-xl font-semibold tracking-tight"><SmilePlus className="h-5 w-5" aria-hidden /> Surveys</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                    When a ticket is resolved or closed, the person who asked gets an email with a one-question survey. They answer with one click, without signing in
                    (or in the client portal). The wording of the email is in the <a className="underline underline-offset-2" href="/administration?tab=templates">Templates tab</a>.
                </p>
            </div>
            <div role="tablist" aria-label="Surveys" className="inline-flex w-fit rounded-lg border p-0.5 text-sm">
                {([["results", "Results"], ["settings", "Settings"]] as const).map(([k, n]) => (
                    <button key={k} role="tab" aria-selected={section === k} onClick={() => setSection(k)} className={`rounded-md px-4 py-1.5 font-medium ${section === k ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>{n}</button>
                ))}
            </div>
            {section === "results" ? <Results /> : <SettingsForm push={push} />}
        </div>
    );
}

/* --------------------------------- results --------------------------------- */

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
    return (
        <div className="rounded-lg border bg-card p-3">
            <div className="text-xs text-muted-foreground">{label}</div>
            <div className="text-2xl font-semibold">{value}</div>
            {hint ? <div className="text-xs text-muted-foreground">{hint}</div> : null}
        </div>
    );
}

function Stars({ n }: { n: number }) {
    return <span className="inline-flex items-center gap-0.5" aria-label={`${n} of 5`}>{[1, 2, 3, 4, 5].map((i) => <Star key={i} className={i <= n ? "h-3.5 w-3.5 fill-current text-amber-500" : "h-3.5 w-3.5 text-muted-foreground/40"} aria-hidden />)}</span>;
}

function GroupTable({ title, rows, empty }: { title: string; rows: Group[]; empty: string }) {
    return (
        <div>
            <h3 className="mb-2 text-sm font-semibold">{title}</h3>
            <div className="overflow-x-auto rounded-lg border">
                <table className="w-full text-sm">
                    <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
                        <tr><th className="p-2 font-medium">Name</th><th className="p-2 text-right font-medium">Asked</th><th className="p-2 text-right font-medium">Answered</th><th className="p-2 text-right font-medium">Response</th><th className="p-2 text-right font-medium">Average</th><th className="p-2 text-right font-medium">Low</th></tr>
                    </thead>
                    <tbody>
                        {rows.map((r) => (
                            <tr key={`${r.id}-${r.name}`} className="border-t">
                                <td className="p-2">{r.name}</td><td className="p-2 text-right">{r.sent}</td><td className="p-2 text-right">{r.answered}</td>
                                <td className="p-2 text-right">{pct(r.responseRate)}</td><td className="p-2 text-right font-medium">{avg(r.average)}</td>
                                <td className={`p-2 text-right ${r.low ? "font-medium text-destructive" : ""}`}>{r.low}</td>
                            </tr>
                        ))}
                        {rows.length === 0 ? <tr><td colSpan={6} className="p-3 text-center text-muted-foreground">{empty}</td></tr> : null}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

function RecentList({ title, rows, empty }: { title: string; rows: Recent[]; empty: string }) {
    return (
        <div>
            <h3 className="mb-2 text-sm font-semibold">{title}</h3>
            <ul className="space-y-2">
                {rows.map((r) => (
                    <li key={r.id} className="rounded-lg border p-3 text-sm">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="flex items-center gap-2"><Stars n={r.score} /><Link href={`/tickets/${r.ticketId}`} className="underline underline-offset-2">#{r.number} {r.subject}</Link></span>
                            <span className="text-xs text-muted-foreground">{new Date(r.answeredAt).toLocaleDateString()}</span>
                        </div>
                        {r.comment ? <p className="mt-1 whitespace-pre-wrap break-words">{r.comment}</p> : null}
                        <p className="mt-1 text-xs text-muted-foreground">{r.requester}{r.customer ? ` · ${r.customer}` : ""}{r.technician ? ` · handled by ${r.technician}` : ""}</p>
                    </li>
                ))}
                {rows.length === 0 ? <li className="rounded-lg border p-3 text-sm text-muted-foreground">{empty}</li> : null}
            </ul>
        </div>
    );
}

function Results() {
    const [days, setDays] = React.useState(90);
    const [s, setS] = React.useState<Summary | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    React.useEffect(() => {
        let stale = false;
        setError(null);
        jfetch<Summary>(`/api/admin/surveys/summary?days=${days}`).then((r) => { if (!stale) setS(r); }).catch((e) => { if (!stale) setError(messageOf(e)); });
        return () => { stale = true; };
    }, [days]);

    if (error) return <p role="alert" className="text-sm text-destructive">{error}</p>;
    if (!s) return <p className="text-sm text-muted-foreground">Loading…</p>;
    const max = Math.max(1, ...s.distribution.map((d) => d.count));
    return (
        <div className="grid gap-5">
            <div className="flex items-center gap-2 text-sm">
                <Label htmlFor="sv-days">Period</Label>
                <select id="sv-days" value={days} onChange={(e) => setDays(Number(e.target.value))} className="h-10 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    {[[30, "Last 30 days"], [90, "Last 90 days"], [365, "Last year"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
            </div>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
                <Stat label="Surveys sent" value={String(s.sent)} hint={s.waiting ? `${s.waiting} waiting to go out` : undefined} />
                <Stat label="Response rate" value={pct(s.responseRate)} hint={`${s.answered} answered`} />
                <Stat label="Average score" value={s.average === null ? "-" : `${avg(s.average)} / 5`} />
                <Stat label="Satisfied (4-5)" value={pct(s.satisfied)} />
                <Stat label="Low scores" value={String(s.low)} hint={`${s.lowThreshold} or less`} />
            </div>
            {s.failed || s.throttled ? (
                <p className="text-xs text-muted-foreground">
                    {s.failed ? `${s.failed} survey email${s.failed === 1 ? "" : "s"} could not be sent (check Administration > SMTP, the Tickets mailbox). ` : ""}
                    {s.throttled ? `${s.throttled} ticket${s.throttled === 1 ? " was" : "s were"} not surveyed because the person was asked recently.` : ""}
                </p>
            ) : null}
            <div>
                <h3 className="mb-2 text-sm font-semibold">Scores</h3>
                <div className="space-y-1">
                    {s.distribution.slice().reverse().map((d) => (
                        <div key={d.score} className="flex items-center gap-2 text-sm">
                            <span className="w-14 shrink-0 text-muted-foreground">{s.scale === "thumbs" ? (d.score === 5 ? "Up" : d.score === 1 ? "Down" : `${d.score}`) : `${d.score} star${d.score === 1 ? "" : "s"}`}</span>
                            <div className="h-3 flex-1 overflow-hidden rounded bg-muted"><div className={`h-full ${d.score <= s.lowThreshold ? "bg-destructive/70" : "bg-primary/70"}`} style={{ width: `${(d.count / max) * 100}%` }} /></div>
                            <span className="w-8 text-right tabular-nums">{d.count}</span>
                        </div>
                    ))}
                </div>
            </div>
            <div className="grid gap-5 lg:grid-cols-2">
                <GroupTable title="By technician" rows={s.byTechnician} empty="Nothing yet." />
                <GroupTable title="By customer" rows={s.byCustomer} empty="Nothing yet." />
            </div>
            <div className="grid gap-5 lg:grid-cols-2">
                <RecentList title="Low scores" rows={s.lowScores} empty="No low scores in this period." />
                <RecentList title="Recent comments" rows={s.comments} empty="No comments in this period." />
            </div>
        </div>
    );
}

/* --------------------------------- settings --------------------------------- */

function Check({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: React.ReactNode }) {
    return <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 shrink-0 rounded border-input accent-primary" />{children}</label>;
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
    return <div className="grid gap-1"><Label>{label}</Label>{children}{hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}</div>;
}

function SettingsForm({ push }: { push: ToastFn }) {
    const [s, setS] = React.useState<Settings | null>(null);
    const [opts, setOpts] = React.useState<Options | null>(null);
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    React.useEffect(() => {
        jfetch<Settings>("/api/admin/surveys/settings").then(setS).catch((e) => setError(messageOf(e)));
        jfetch<Options>("/api/admin/surveys/options").then(setOpts).catch(() => setOpts({ clients: [], users: [], groups: [] }));
    }, []);
    if (error && !s) return <p role="alert" className="text-sm text-destructive">{error}</p>;
    if (!s || !opts) return <p className="text-sm text-muted-foreground">Loading…</p>;

    const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS({ ...s, [k]: v });
    const toggle = (k: "triggerStatuses" | "clientIds" | "alertUserIds" | "alertGroupIds", id: string, on: boolean) => set(k, on ? [...new Set([...s[k], id])] : s[k].filter((x) => x !== id));
    const delayKnown = DELAYS.some(([v]) => v === s.delayMinutes);

    const save = async () => {
        setBusy(true);
        setError(null);
        try {
            setS(await jfetch<Settings>("/api/admin/surveys/settings", { method: "PUT", body: s }));
            push({ title: "Saved", desc: s.enabled ? "Surveys are on." : "Surveys are off.", kind: "success" });
        } catch (e) {
            setError(messageOf(e));
        } finally {
            setBusy(false);
        }
    };

    return (
        <form onSubmit={(e) => { e.preventDefault(); void save(); }} className="grid gap-5 rounded-xl border p-5">
            <div className="flex items-center justify-between gap-4">
                <div>
                    <div className="font-medium">Send surveys</div>
                    <p className="text-xs text-muted-foreground">Tickets finished before this is turned on are never asked about.</p>
                </div>
                <Switch checked={s.enabled} onCheckedChange={(v) => set("enabled", v)} aria-label="Send surveys" />
            </div>

            <div className="grid gap-4 md:grid-cols-2">
                <Field label="Ask when a ticket is">
                    <div className="flex gap-4"><Check checked={s.triggerStatuses.includes("resolved")} onChange={(v) => toggle("triggerStatuses", "resolved", v)}>Resolved</Check><Check checked={s.triggerStatuses.includes("closed")} onChange={(v) => toggle("triggerStatuses", "closed", v)}>Closed</Check></div>
                </Field>
                <Field label="Send after" hint="A ticket that is reopened before then is not sent a survey.">
                    <select value={s.delayMinutes} onChange={(e) => set("delayMinutes", Number(e.target.value))} className="h-10 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                        {!delayKnown ? <option value={s.delayMinutes}>{s.delayMinutes} minutes</option> : null}
                        {DELAYS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                </Field>
                <Field label="Rating" hint="Stars give 1 to 5. Thumbs are counted as 5 (up) and 1 (down).">
                    <select value={s.scale} onChange={(e) => set("scale", e.target.value as Settings["scale"])} className="h-10 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                        <option value="stars">Five stars</option><option value="thumbs">Thumbs up or down</option>
                    </select>
                </Field>
                <Field label="Ask each person at most once every (days)" hint="0 means no limit. The same person is never asked twice about one ticket.">
                    <Input type="number" min={0} max={365} value={s.throttleDays} onChange={(e) => set("throttleDays", Number(e.target.value))} />
                </Field>
                <Field label="The link works for (days)">
                    <Input type="number" min={1} max={90} value={s.expiryDays} onChange={(e) => set("expiryDays", Number(e.target.value))} />
                </Field>
                <Field label="Reminder" hint="One reminder, to people who have not answered.">
                    <div className="flex items-center gap-2 text-sm">
                        <Switch checked={s.reminderEnabled} onCheckedChange={(v) => set("reminderEnabled", v)} aria-label="Send a reminder" />
                        <span>after</span>
                        <Input type="number" min={1} max={60} className="w-20" value={s.reminderAfterDays} disabled={!s.reminderEnabled} onChange={(e) => set("reminderAfterDays", Number(e.target.value))} aria-label="Days until the reminder" />
                        <span>days</span>
                    </div>
                </Field>
            </div>

            <Field label="Which customers">
                <div className="flex gap-4">
                    <label className="flex items-center gap-2 text-sm"><input type="radio" name="sv-scope" checked={s.scope === "all"} onChange={() => set("scope", "all")} />All customers</label>
                    <label className="flex items-center gap-2 text-sm"><input type="radio" name="sv-scope" checked={s.scope === "selected"} onChange={() => set("scope", "selected")} />Only these</label>
                </div>
                {s.scope === "selected" ? (
                    <div className="mt-1 grid max-h-48 gap-1 overflow-y-auto rounded-md border p-2 sm:grid-cols-2">
                        {opts.clients.map((c) => <Check key={c.id} checked={s.clientIds.includes(c.id)} onChange={(v) => toggle("clientIds", c.id, v)}>{c.name}</Check>)}
                        {opts.clients.length === 0 ? <span className="text-sm text-muted-foreground">There are no customers yet.</span> : null}
                    </div>
                ) : null}
            </Field>

            <div className="grid gap-4 md:grid-cols-2">
                <Field label="A low score is" hint="These and lower tell the people below, and send the ticket.survey_low webhook (set up in Integrations).">
                    <select value={s.lowThreshold} onChange={(e) => set("lowThreshold", Number(e.target.value))} className="h-10 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                        {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n} or less</option>)}
                    </select>
                </Field>
                <div />
                <Field label="Tell these people">
                    <div className="grid max-h-40 gap-1 overflow-y-auto rounded-md border p-2">
                        {opts.users.map((u) => <Check key={u.id} checked={s.alertUserIds.includes(u.id)} onChange={(v) => toggle("alertUserIds", u.id, v)}>{u.name}</Check>)}
                    </div>
                </Field>
                <Field label="Tell these groups">
                    <div className="grid max-h-40 gap-1 overflow-y-auto rounded-md border p-2">
                        {opts.groups.map((g) => <Check key={g.id} checked={s.alertGroupIds.includes(g.id)} onChange={(v) => toggle("alertGroupIds", g.id, v)}>{g.name}</Check>)}
                        {opts.groups.length === 0 ? <span className="text-sm text-muted-foreground">There are no groups yet.</span> : null}
                    </div>
                </Field>
            </div>

            {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
            <div><Button type="submit" disabled={busy}>{busy ? "Saving…" : "Save"}</Button></div>
        </form>
    );
}
