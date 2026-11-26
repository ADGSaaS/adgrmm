"use client";

// Diagnostics: what this server is running and what to look at first, with a file to attach to a support request.
// The report holds no secrets, passwords, tokens, customer data or ticket text.
import * as React from "react";
import { Activity, Download, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiUrl, jfetch } from "@/lib/api";
import type { ToastFn } from "../types";

type Finding = { level: "problem" | "warning" | "info"; area: string; message: string };
type Part<T> = T | { error: string };
type Report = {
    generatedAt: string;
    findings: Finding[];
    app: Part<{ packageVersion: string; commit: string | null; node: string; platform: string; nodeEnv: string | null; uptimeSeconds: number; memoryMb: { rss: number }; systemMemoryMb: { total: number; free: number }; cpus: number; loadAverage: number[] }>;
    database: Part<{ version: string; sizeMb: number; connections: number; migrations: { applied: number; unfinished: string[] } }>;
    disk: Part<{ label: string; totalGb?: number; freeGb?: number; freePercent?: number | null; error?: string }[]>;
    agents: Part<{ total: number; online: number; notSeenForADay: number; byVersion: { version: string; agents: number; online: number }[] }>;
    tasks: Part<{ byStatus: Record<string, number>; oldestPendingMinutes: number | null }>;
    mailbox: Part<{ configured: boolean; enabled?: boolean; source?: string; connected?: boolean; lastPolledAt?: string | null; lastError?: string | null }>;
    sso: Part<{ configured: boolean; enabled?: boolean; providerHost?: string | null }>;
};

const isError = (x: unknown): x is { error: string } => !!x && typeof x === "object" && !Array.isArray(x) && "error" in (x as object) && Object.keys(x as object).length === 1;

const messageOf = (e: unknown) => {
    const raw = e instanceof Error ? e.message : "Something went wrong.";
    try { const j = JSON.parse(raw) as { message?: string | string[] }; return Array.isArray(j.message) ? j.message.join(" ") : j.message ?? raw; } catch { return raw; }
};
const uptime = (s: number) => (s >= 86400 ? `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h` : s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(s / 60)}m`);

const LEVEL: Record<Finding["level"], { label: string; cls: string }> = {
    problem: { label: "Problem", cls: "border-destructive/40 bg-destructive/10 text-destructive" },
    warning: { label: "Warning", cls: "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-200" },
    info: { label: "For your information", cls: "text-muted-foreground" },
};

export default function DiagnosticsTab({ push }: { push: ToastFn }) {
    const [report, setReport] = React.useState<Report | null>(null);
    const [busy, setBusy] = React.useState(false);
    const [downloading, setDownloading] = React.useState(false);

    const run = React.useCallback(async () => {
        setBusy(true);
        try {
            setReport(await jfetch<Report>("/api/admin/diagnostics"));
        } catch (e) {
            push({ title: "Could not run diagnostics", desc: messageOf(e), kind: "destructive" });
        } finally {
            setBusy(false);
        }
    }, [push]);

    React.useEffect(() => { void run(); }, [run]);

    async function download() {
        setDownloading(true);
        try {
            const res = await fetch(apiUrl("/api/admin/diagnostics?download=1"), { credentials: "include" });
            if (!res.ok) throw new Error(`Download failed (${res.status})`);
            const blob = await res.blob();
            // Named here, since a browser hides response headers from another origin.
            const name = `adgrmm-diagnostics-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`;
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = name;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
        } catch (e) {
            push({ title: "Could not download the report", desc: messageOf(e), kind: "destructive" });
        } finally {
            setDownloading(false);
        }
    }

    return (
        <div className="grid w-full min-w-0 gap-6">
            <div>
                <h2 className="flex items-center gap-2 text-xl font-semibold tracking-tight"><Activity className="h-5 w-5" aria-hidden /> Diagnostics</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                    What this server is running, whether its parts are healthy, and what to look at first. The report holds no secrets, passwords, tokens, customer data or ticket text, so it is safe to attach to a support request.
                </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="outline" onClick={() => void run()} disabled={busy}>
                    <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} aria-hidden /> Run again
                </Button>
                <Button size="sm" onClick={() => void download()} disabled={downloading}>
                    <Download className="mr-1.5 h-3.5 w-3.5" aria-hidden /> {downloading ? "Preparing…" : "Download report"}
                </Button>
                {report ? <span className="text-xs text-muted-foreground">Taken {new Date(report.generatedAt).toLocaleString()}</span> : null}
            </div>

            {!report ? (
                <div className="p-4 text-sm text-muted-foreground">{busy ? "Collecting…" : "No report yet."}</div>
            ) : (
                <>
                    <section aria-label="What to look at" className="grid gap-2">
                        {report.findings.map((f, i) => (
                            <div key={i} className={`flex flex-wrap items-baseline gap-2 rounded-md border p-2 text-sm ${LEVEL[f.level].cls}`}>
                                <span className="text-xs font-semibold uppercase tracking-wide">{LEVEL[f.level].label}</span>
                                <span className="text-xs opacity-80">{f.area}</span>
                                <span>{f.message}</span>
                            </div>
                        ))}
                    </section>

                    <div className="grid gap-3 sm:grid-cols-2">
                        <Card title="Server">
                            {isError(report.app) ? <Failed e={report.app.error} /> : (
                                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm">
                                    <Row k="Version" v={`${report.app.packageVersion}${report.app.commit ? ` (${report.app.commit})` : ""}`} />
                                    <Row k="Node" v={report.app.node} />
                                    <Row k="System" v={`${report.app.platform}, ${report.app.cpus} CPU`} />
                                    <Row k="Up for" v={uptime(report.app.uptimeSeconds)} />
                                    <Row k="Memory" v={`${report.app.memoryMb.rss} MB used by the app, ${report.app.systemMemoryMb.free} of ${report.app.systemMemoryMb.total} MB free`} />
                                    <Row k="Load" v={report.app.loadAverage.join(" / ")} />
                                </dl>
                            )}
                        </Card>
                        <Card title="Database">
                            {isError(report.database) ? <Failed e={report.database.error} /> : (
                                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm">
                                    <Row k="Server" v={report.database.version} />
                                    <Row k="Size" v={`${report.database.sizeMb} MB`} />
                                    <Row k="Connections" v={String(report.database.connections)} />
                                    <Row k="Migrations" v={`${report.database.migrations.applied} applied${report.database.migrations.unfinished.length ? `, ${report.database.migrations.unfinished.length} unfinished` : ""}`} />
                                </dl>
                            )}
                        </Card>
                        <Card title="Disk">
                            {isError(report.disk) ? <Failed e={report.disk.error} /> : (
                                <ul className="grid gap-0.5 text-sm">
                                    {report.disk.map((d) => (
                                        <li key={d.label}>{d.label}: {d.error ? <span className="text-muted-foreground">{d.error}</span> : `${d.freeGb} of ${d.totalGb} GB free (${d.freePercent}%)`}</li>
                                    ))}
                                </ul>
                            )}
                        </Card>
                        <Card title="Agents">
                            {isError(report.agents) ? <Failed e={report.agents.error} /> : (
                                <div className="text-sm">
                                    <div>{report.agents.online} online of {report.agents.total}{report.agents.notSeenForADay ? `, ${report.agents.notSeenForADay} not seen for a day` : ""}</div>
                                    <div className="mt-1 flex flex-wrap gap-1.5 text-xs">
                                        {report.agents.byVersion.map((v) => <span key={v.version} className="rounded-full border px-2 py-0.5">{v.version}: {v.agents}</span>)}
                                    </div>
                                </div>
                            )}
                        </Card>
                        <Card title="Agent tasks">
                            {isError(report.tasks) ? <Failed e={report.tasks.error} /> : (
                                <div className="text-sm">
                                    <div className="flex flex-wrap gap-1.5 text-xs">
                                        {Object.entries(report.tasks.byStatus).map(([k, v]) => <span key={k} className="rounded-full border px-2 py-0.5">{k}: {v}</span>)}
                                    </div>
                                    {report.tasks.oldestPendingMinutes !== null ? <div className="mt-1 text-xs text-muted-foreground">Oldest waiting task: {report.tasks.oldestPendingMinutes} min</div> : null}
                                </div>
                            )}
                        </Card>
                        <Card title="Support mailbox and sign-on">
                            <div className="grid gap-1 text-sm">
                                {isError(report.mailbox) ? <Failed e={report.mailbox.error} /> : !report.mailbox.configured ? <div className="text-muted-foreground">Support mailbox: not set up</div> : (
                                    <div>Support mailbox: {report.mailbox.enabled ? "on" : "off"} ({report.mailbox.source}){report.mailbox.lastError ? <span className="text-destructive"> — {report.mailbox.lastError}</span> : null}</div>
                                )}
                                {isError(report.sso) ? <Failed e={report.sso.error} /> : !report.sso.configured ? <div className="text-muted-foreground">Single sign-on: not set up</div> : (
                                    <div>Single sign-on: {report.sso.enabled ? "on" : "off"}{report.sso.providerHost ? ` (${report.sso.providerHost})` : ""}</div>
                                )}
                            </div>
                        </Card>
                    </div>
                    <p className="text-xs text-muted-foreground">The downloaded file has more: the settings that are set (secrets only as set or not set), recent failed actions, email setup, recent imports and approximate table sizes.</p>
                </>
            )}
        </div>
    );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <div className="rounded-xl border border-border/70 bg-card p-5 shadow-sm">
            <div className="mb-1.5 text-sm font-medium">{title}</div>
            {children}
        </div>
    );
}
function Row({ k, v }: { k: string; v: string }) {
    return (<><dt className="text-muted-foreground">{k}</dt><dd className="break-words">{v}</dd></>);
}
function Failed({ e }: { e: string }) {
    return <p className="text-sm text-destructive">Could not be collected: {e}</p>;
}
