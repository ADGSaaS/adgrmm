"use client";

// Import / Export. Export downloads customers, sites, contacts, devices, users or tickets as a CSV file, limited to
// what the signed-in person may see. Import reads customers, sites or contacts from a CSV file in two steps: a
// preview that writes nothing and says what every row would do, then an apply. Everything is recorded in the audit log.
import * as React from "react";
import { ArrowRightLeft, Download, FileUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiUrl } from "@/lib/api";
import { useMe } from "@/lib/use-me";
import { hasPerm } from "@/lib/permissions";
import { Header, Panel, Pill, messageOf, saveBlob } from "../platform-common";
import type { ToastFn } from "../types";

const EXPORTS = [
    { kind: "customers", label: "Customers", perm: "customers.read", note: "Details, address, tags and notes." },
    { kind: "sites", label: "Sites", perm: "customers.read", note: "Every site with its customer." },
    { kind: "contacts", label: "Contacts", perm: "customers.read", note: "People at each customer." },
    { kind: "devices", label: "Devices", perm: "devices.read", note: "Name, customer, site, system and last seen." },
    { kind: "users", label: "Users", perm: "users.read", note: "Name, email, roles and whether two-factor is on. No passwords or secrets." },
    { kind: "tickets", label: "Tickets", perm: "tickets.read", note: "Subject, status, priority, customer and dates, for the dates chosen below. Not the conversation." },
] as const;

const IMPORTS = [
    { kind: "customers", label: "Customers", note: "Needs a name column. A customer already in the system is matched by name." },
    { kind: "sites", label: "Sites", note: "Needs customer and name columns. The customer must already exist." },
    { kind: "contacts", label: "Contacts", note: "Needs customer and name columns. Matched by email, or by name when there is none." },
] as const;
type ImportKind = (typeof IMPORTS)[number]["kind"];

type Row = { row: number; action: "create" | "update" | "skip" | "error"; label: string; message?: string };
type Report = { kind: ImportKind; mode: "preview" | "apply"; onExisting: "skip" | "update"; summary: { rows: number; create: number; update: number; skip: number; error: number }; warnings: string[]; rows: Row[]; truncated: boolean };

const TONE = { create: "good", update: "good", skip: "neutral", error: "bad" } as const;
const WORD = { create: "Add", update: "Change", skip: "Skip", error: "Problem" } as const;
const WORD_DONE = { create: "Added", update: "Changed", skip: "Skipped", error: "Problem" } as const;

export default function ImportExportTab({ push }: { push: ToastFn }) {
    const { permissions } = useMe();
    const canImport = hasPerm(permissions, "customers.write");

    /* ------------------------------ export ------------------------------ */
    const [from, setFrom] = React.useState("");
    const [to, setTo] = React.useState("");
    const [exporting, setExporting] = React.useState<string | null>(null);

    async function download(kind: string) {
        setExporting(kind);
        try {
            const qs = kind === "tickets" ? `?${new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}) }).toString()}` : "";
            const res = await fetch(apiUrl(`/api/admin/data/export/${kind}${qs}`), { credentials: "include" });
            if (!res.ok) throw new Error(await res.text().catch(() => `Download failed (${res.status})`));
            await saveBlob(res, `${kind}-${new Date().toISOString().slice(0, 10)}.csv`);
        } catch (e) {
            push({ title: "Could not export", desc: messageOf(e), kind: "destructive" });
        } finally {
            setExporting(null);
        }
    }

    /* ------------------------------ import ------------------------------ */
    const [kind, setKind] = React.useState<ImportKind>("customers");
    const [file, setFile] = React.useState<File | null>(null);
    const [existing, setExisting] = React.useState<"skip" | "update">("skip");
    const [report, setReport] = React.useState<Report | null>(null);
    const [busy, setBusy] = React.useState<"preview" | "apply" | null>(null);
    const inputRef = React.useRef<HTMLInputElement>(null);

    const reset = () => setReport(null);

    async function send(mode: "preview" | "apply") {
        if (!file) return;
        setBusy(mode);
        try {
            const res = await fetch(apiUrl(`/api/admin/data/import/${kind}?mode=${mode}&existing=${existing}`), {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "text/csv" },
                body: file,
            });
            const text = await res.text();
            if (!res.ok) throw new Error(text || `Request failed (${res.status})`);
            const r = JSON.parse(text) as Report;
            setReport(r);
            if (mode === "apply") push({ title: "Import finished", desc: `${r.summary.create} added, ${r.summary.update} changed, ${r.summary.skip} skipped, ${r.summary.error} with problems.`, kind: r.summary.error ? "warning" : "success" });
        } catch (e) {
            if (mode === "preview") setReport(null);
            push({ title: mode === "preview" ? "Could not read that file" : "The import failed", desc: messageOf(e), kind: "destructive" });
        } finally {
            setBusy(null);
        }
    }

    async function template() {
        try {
            const res = await fetch(apiUrl(`/api/admin/data/import/${kind}/template`), { credentials: "include" });
            if (!res.ok) throw new Error(await res.text());
            await saveBlob(res, `${kind}-import-template.csv`);
        } catch (e) {
            push({ title: "Could not get the template", desc: messageOf(e), kind: "destructive" });
        }
    }

    const changes = report ? report.summary.create + report.summary.update : 0;
    const words = report?.mode === "apply" ? WORD_DONE : WORD;

    return (
        <div className="grid w-full min-w-0 gap-6">
            <Header icon={<ArrowRightLeft className="h-5 w-5" aria-hidden />} title="Import / Export">
                Download your records as CSV files, or bring customers, sites and contacts in from one. You only get, and can only change, what you are allowed to see. Every export and import is recorded in the audit log.
            </Header>

            <Panel title="Export">
                <div className="grid gap-2 sm:grid-cols-2">
                    {EXPORTS.map((x) => {
                        const allowed = hasPerm(permissions, x.perm);
                        return (
                            <div key={x.kind} className="flex items-start justify-between gap-3 rounded-md border p-2.5">
                                <div className="min-w-0">
                                    <div className="text-sm font-medium">{x.label}</div>
                                    <p className="text-xs text-muted-foreground">{allowed ? x.note : `You need permission to view ${x.label.toLowerCase()} to export them.`}</p>
                                </div>
                                <Button size="sm" variant="outline" disabled={!allowed || exporting !== null} onClick={() => void download(x.kind)}>
                                    <Download className="mr-1.5 h-3.5 w-3.5" aria-hidden /> {exporting === x.kind ? "Preparing…" : "CSV"}
                                </Button>
                            </div>
                        );
                    })}
                </div>
                <div className="mt-3 flex flex-wrap items-end gap-3">
                    <div className="grid gap-1">
                        <Label htmlFor="ticket-from" className="text-xs">Tickets created from</Label>
                        <Input id="ticket-from" type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className="w-44" />
                    </div>
                    <div className="grid gap-1">
                        <Label htmlFor="ticket-to" className="text-xs">to (included)</Label>
                        <Input id="ticket-to" type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className="w-44" />
                    </div>
                    <p className="pb-2 text-xs text-muted-foreground">Leave both empty for every ticket. Spreadsheets treat a cell that starts with = + - or @ as a formula, so the file marks those as text.</p>
                </div>
            </Panel>

            <Panel title="Import from a CSV file">
                {!canImport ? <p className="text-sm text-muted-foreground">You need permission to create and edit customers to import.</p> : (
                    <div className="grid gap-3">
                        <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="What to import">
                            {IMPORTS.map((x) => (
                                <button
                                    key={x.kind}
                                    type="button"
                                    role="radio"
                                    aria-checked={kind === x.kind}
                                    onClick={() => { setKind(x.kind); reset(); }}
                                    className={`rounded-md border px-3 py-1.5 text-sm ${kind === x.kind ? "bg-accent font-medium" : "text-muted-foreground hover:bg-accent/50"}`}
                                >
                                    {x.label}
                                </button>
                            ))}
                        </div>
                        <p className="text-sm text-muted-foreground">
                            {IMPORTS.find((x) => x.kind === kind)?.note} Up to 5,000 rows and 5 MB per file. An empty cell never erases what is stored.{" "}
                            <button type="button" className="underline" onClick={() => void template()}>Download a template</button>, or export first and edit that file.
                        </p>

                        <div className="flex flex-wrap items-center gap-3">
                            <input
                                ref={inputRef}
                                type="file"
                                accept=".csv,text/csv"
                                aria-label="CSV file to import"
                                className="text-sm"
                                onChange={(e) => { setFile(e.target.files?.[0] ?? null); reset(); }}
                            />
                            <fieldset className="flex items-center gap-3 text-sm">
                                <legend className="sr-only">When a row matches something already there</legend>
                                <label className="flex items-center gap-1.5"><input type="radio" name="existing" checked={existing === "skip"} onChange={() => { setExisting("skip"); reset(); }} /> Skip what already exists</label>
                                <label className="flex items-center gap-1.5"><input type="radio" name="existing" checked={existing === "update"} onChange={() => { setExisting("update"); reset(); }} /> Update what already exists</label>
                            </fieldset>
                        </div>
                        {file && file.size > 5 * 1024 * 1024 ? <p className="text-sm text-destructive">That file is larger than 5 MB. Split it into smaller files.</p> : null}

                        <div className="flex flex-wrap items-center gap-2">
                            <Button size="sm" variant="outline" disabled={!file || busy !== null || (file?.size ?? 0) > 5 * 1024 * 1024} onClick={() => void send("preview")}>
                                <FileUp className="mr-1.5 h-3.5 w-3.5" aria-hidden /> {busy === "preview" ? "Checking…" : "Preview (changes nothing)"}
                            </Button>
                            {report?.mode === "preview" ? (
                                <Button size="sm" disabled={busy !== null || changes === 0} onClick={() => void send("apply")}>
                                    {busy === "apply" ? "Importing…" : `Apply ${changes} change${changes === 1 ? "" : "s"}`}
                                </Button>
                            ) : null}
                            {report?.mode === "preview" && report.summary.error ? <span className="text-xs text-muted-foreground">Rows with a problem are left out; the rest are applied.</span> : null}
                        </div>

                        {report ? (
                            <div className="grid gap-2" aria-live="polite">
                                <div className="flex flex-wrap items-center gap-2 text-sm">
                                    <strong>{report.mode === "preview" ? "Preview" : "Done"}:</strong>
                                    <span>{report.summary.rows} rows.</span>
                                    <Pill tone="good">{words.create} {report.summary.create}</Pill>
                                    <Pill tone="good">{words.update} {report.summary.update}</Pill>
                                    <Pill tone="neutral">{words.skip} {report.summary.skip}</Pill>
                                    <Pill tone={report.summary.error ? "bad" : "neutral"}>{words.error} {report.summary.error}</Pill>
                                </div>
                                {report.warnings.map((w) => <p key={w} className="text-xs text-amber-700 dark:text-amber-300">{w}</p>)}
                                <div className="max-h-96 overflow-auto rounded-md border">
                                    <table className="w-full text-sm">
                                        <thead className="sticky top-0 bg-card">
                                            <tr className="border-b text-left text-xs text-muted-foreground">
                                                <th className="px-2 py-1.5 font-medium">Line</th>
                                                <th className="px-2 py-1.5 font-medium">Record</th>
                                                <th className="px-2 py-1.5 font-medium">{report.mode === "preview" ? "Would" : "Result"}</th>
                                                <th className="px-2 py-1.5 font-medium">Note</th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y">
                                            {report.rows.map((r) => (
                                                <tr key={`${r.row}-${r.label}`}>
                                                    <td className="px-2 py-1.5 tabular-nums">{r.row}</td>
                                                    <td className="px-2 py-1.5">{r.label}</td>
                                                    <td className="px-2 py-1.5"><Pill tone={TONE[r.action]}>{words[r.action]}</Pill></td>
                                                    <td className="px-2 py-1.5 text-muted-foreground">{r.message ?? ""}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                                {report.truncated ? <p className="text-xs text-muted-foreground">Only the first 1,000 rows are listed, problems first. The counts above include every row.</p> : null}
                            </div>
                        ) : null}
                    </div>
                )}
            </Panel>
        </div>
    );
}
