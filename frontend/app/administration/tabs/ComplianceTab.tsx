"use client";

// Compliance: a security posture check worked out from what this system really holds (users, settings, backups, and
// what the agents report about each device). It is a health check and not a certification; it makes no claim about
// SOC 2, HIPAA, ISO 27001 or any other framework.
import * as React from "react";
import Link from "next/link";
import { CheckCircle2, Gavel, Info, RefreshCw, TriangleAlert, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { jfetch } from "@/lib/api";
import { Header, Panel, Pill, messageOf } from "../platform-common";
import type { ToastFn } from "../types";

type Status = "pass" | "warn" | "fail" | "info";
type Item = { key: string; title: string; status: Status; detail: string; link?: { label: string; href: string } };
type Report = { generatedAt: string; notice: string; summary: Record<Status, number>; sections: { key: string; title: string; items: Item[] }[] };

const ICON: Record<Status, React.ReactNode> = {
    pass: <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden />,
    warn: <TriangleAlert className="h-4 w-4 text-amber-600" aria-hidden />,
    fail: <XCircle className="h-4 w-4 text-destructive" aria-hidden />,
    info: <Info className="h-4 w-4 text-muted-foreground" aria-hidden />,
};
const WORD: Record<Status, string> = { pass: "Pass", warn: "Warning", fail: "Fail", info: "For information" };

export default function ComplianceTab({ push }: { push: ToastFn }) {
    const [report, setReport] = React.useState<Report | null>(null);
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);

    const load = React.useCallback(async () => {
        setBusy(true);
        try {
            setReport(await jfetch<Report>("/api/admin/compliance"));
            setError(null);
        } catch (e) {
            setError(messageOf(e));
            push({ title: "Could not run the check", desc: messageOf(e), kind: "destructive" });
        } finally {
            setBusy(false);
        }
    }, [push]);
    React.useEffect(() => { void load(); }, [load]);

    return (
        <div className="grid w-full min-w-0 gap-6">
            <Header icon={<Gavel className="h-5 w-5" aria-hidden />} title="Compliance">
                A security check worked out from what this system really holds: people, settings, backups and what each device reports.
            </Header>
            {report ? <p className="rounded-md border bg-muted/30 p-2 text-xs text-muted-foreground">{report.notice}</p> : null}
            <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="outline" onClick={() => void load()} disabled={busy}>
                    <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} aria-hidden /> Check again
                </Button>
                {report ? (
                    <>
                        <Pill tone="good">{report.summary.pass} pass</Pill>
                        <Pill tone={report.summary.warn ? "warn" : "neutral"}>{report.summary.warn} warning{report.summary.warn === 1 ? "" : "s"}</Pill>
                        <Pill tone={report.summary.fail ? "bad" : "neutral"}>{report.summary.fail} fail</Pill>
                        <span className="text-xs text-muted-foreground">Checked {new Date(report.generatedAt).toLocaleString()}. Opening this page is recorded in the audit log.</span>
                    </>
                ) : null}
            </div>
            {error ? <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</div> : null}
            {!report && !error ? <div className="p-4 text-sm text-muted-foreground">Checking…</div> : null}
            {report?.sections.map((s) => (
                <Panel key={s.key} title={s.title}>
                    <ul className="divide-y">
                        {s.items.map((i) => (
                            <li key={i.key} className="flex items-start gap-2.5 py-2">
                                <span className="mt-0.5" title={WORD[i.status]}>{ICON[i.status]}</span>
                                <div className="min-w-0 flex-1">
                                    <div className="flex flex-wrap items-baseline gap-x-2">
                                        <span className="text-sm font-medium">{i.title}</span>
                                        <span className="text-xs text-muted-foreground">{WORD[i.status]}</span>
                                    </div>
                                    <p className="text-sm text-muted-foreground">{i.detail}</p>
                                </div>
                                {i.link ? <Link href={i.link.href} className="shrink-0 text-xs underline">{i.link.label}</Link> : null}
                            </li>
                        ))}
                    </ul>
                </Panel>
            ))}
        </div>
    );
}
