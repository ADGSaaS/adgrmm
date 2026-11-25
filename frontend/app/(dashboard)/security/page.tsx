"use client";

// Security across the fleet: every Windows and Linux device with its score and grade from the last security scan, summary tiles, the checks
// that fail on the most devices, and a table paged, filtered and sorted on the server (a fleet can be thousands of devices).
// A click on a device opens its Security tab. Scans are run from a device, from the device list (bulk action), or on a schedule
// a policy sets (Policies > Security).
import * as React from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { PageHeader, PageShell } from "@/components/page-shell";
import PermGate from "@/components/perm-gate";
import { Button } from "@/components/ui/button";
import { EmptyState, FilterSelect, SearchField, SegmentedTabs } from "@/components/list-controls";
import SecretAccessLog from "@/components/security/secret-access-log";
import { useMe } from "@/lib/use-me";
import { hasPerm } from "@/lib/permissions";
import { GradeBadge, TonePill } from "@/components/security/security-parts";
import { fetchCustomers, type CustomerClient } from "@/lib/api";
import { ago, gradeClass, SEVERITY_TEXT, security, type FleetPage, type FleetSort, type FleetSummary, type Grade } from "@/lib/security-api";
import { cn } from "@/lib/utils";
import { errorText } from "@/components/policies/shared";
import { readIdParam, readParam } from "@/lib/url-params";

const PAGE_SIZES = [25, 50, 100];
const GRADES: Grade[] = ["A", "B", "C", "D", "F"];
const GRADE_HELP: Record<Grade, string> = { A: "90 to 100", B: "80 to 89", C: "70 to 79", D: "60 to 69", F: "under 60" };

function Tile({ label, value, sub, active, onClick, tone }: { label: string; value: React.ReactNode; sub?: string; active?: boolean; onClick?: () => void; tone?: string }) {
    const body = (
        <>
            <span className="text-xs font-medium text-muted-foreground">{label}</span>
            <span className={cn("block text-2xl font-semibold tabular-nums", tone)}>{value}</span>
            {sub ? <span className="block text-xs text-muted-foreground">{sub}</span> : null}
        </>
    );
    const cls = cn("rounded-lg border p-3 text-left", active && "ring-2 ring-primary");
    return onClick ? <button type="button" className={cn(cls, "hover:bg-accent/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring")} onClick={onClick} aria-pressed={!!active}>{body}</button> : <div className={cls}>{body}</div>;
}

function SecurityInner({ tabs }: { tabs?: React.ReactNode }) {
    const [clients, setClients] = React.useState<CustomerClient[]>([]);
    const [clientId, setClientId] = React.useState(() => readIdParam("clientId") ?? "");
    const [q, setQ] = React.useState("");
    const [debouncedQ, setDebouncedQ] = React.useState("");
    const [grade, setGrade] = React.useState(() => readParam("grade", ["A", "B", "C", "D", "F", "none"] as const) ?? "");
    const [sort, setSort] = React.useState<FleetSort>(() => readParam<FleetSort>("sort", ["worst", "best", "name", "customer", "scanned", "critical"]) ?? "worst");
    const [limit, setLimit] = React.useState(25);
    const [offset, setOffset] = React.useState(0);
    const [page, setPage] = React.useState<FleetPage | null>(null);
    const [summary, setSummary] = React.useState<FleetSummary | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [loading, setLoading] = React.useState(false);

    React.useEffect(() => { void fetchCustomers().then(setClients).catch(() => setClients([])); }, []);
    React.useEffect(() => { const t = setTimeout(() => { setDebouncedQ(q); setOffset(0); }, 300); return () => clearTimeout(t); }, [q]);

    React.useEffect(() => {
        let cancelled = false;
        security.summary(clientId || undefined).then((s) => !cancelled && setSummary(s)).catch((e) => !cancelled && setError(errorText(e)));
        return () => { cancelled = true; };
    }, [clientId]);

    React.useEffect(() => {
        let cancelled = false;
        setLoading(true);
        setError(null);
        security.fleet({ clientId: clientId || undefined, q: debouncedQ, grade: grade || undefined, sort, limit, offset })
            .then((p) => !cancelled && setPage(p))
            .catch((e) => !cancelled && setError(errorText(e)))
            .finally(() => !cancelled && setLoading(false));
        return () => { cancelled = true; };
    }, [clientId, debouncedQ, grade, sort, limit, offset]);

    const pick = (set: (v: string) => void) => (v: string) => { set(v); setOffset(0); };
    const g = summary?.grades;

    return (
        <PageShell>
            <PageHeader
                title="Security"
                description={HEADER_TEXT}
            />
            {tabs}

            {summary ? (
                <section aria-label="Summary" className="space-y-4">
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
                        {GRADES.map((x) => (
                            <Tile key={x} label={`Grade ${x}`} value={g?.[x] ?? 0} sub={GRADE_HELP[x]} tone={gradeClass(x)} active={grade === x} onClick={() => pick(setGrade)(grade === x ? "" : x)} />
                        ))}
                        <Tile label="Not scanned" value={summary.neverScanned} sub={summary.noAgent ? `${summary.noAgent} with no agent` : "devices with an agent"} active={grade === "none"} onClick={() => pick(setGrade)(grade === "none" ? "" : "none")} />
                        <Tile label="Average score" value={summary.averageScore ?? "—"} sub={`${summary.scanned} of ${summary.withAgent} scanned`} />
                        <Tile label="Critical failures" value={summary.devicesWithCriticalFailures} sub={summary.stale ? `${summary.stale} scans out of date` : "devices"} />
                    </div>
                    {summary.topFailingRules.length ? (
                        <div className="rounded-lg border p-3">
                            <h2 className="text-sm font-semibold">Checks failing on the most devices</h2>
                            <ol className="mt-2 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                                {summary.topFailingRules.slice(0, 8).map((r) => (
                                    <li key={r.id} className="flex items-baseline justify-between gap-3" data-testid="top-rule">
                                        <span className="min-w-0">{r.title} <span className="text-xs text-muted-foreground">({SEVERITY_TEXT[r.severity]})</span></span>
                                        <span className="shrink-0 tabular-nums text-muted-foreground">{r.devices} {r.devices === 1 ? "device" : "devices"}</span>
                                    </li>
                                ))}
                            </ol>
                        </div>
                    ) : null}
                </section>
            ) : null}

            <div className="flex flex-wrap items-center gap-2">
                <FilterSelect label="Customer" value={clientId} onChange={pick(setClientId)} options={[{ value: "", label: "All customers" }, ...clients.map((c) => ({ value: c.id, label: c.name }))]} />
                <FilterSelect label="Grade" value={grade} onChange={pick(setGrade)} options={[{ value: "", label: "Any grade" }, ...GRADES.map((x) => ({ value: x, label: `Grade ${x}` })), { value: "none", label: "Not scanned" }]} />
                <FilterSelect label="Sort" value={sort} onChange={(v) => { setSort(v as FleetSort); setOffset(0); }} options={[
                    { value: "worst", label: "Worst first" }, { value: "best", label: "Best first" }, { value: "critical", label: "Most critical failures" },
                    { value: "scanned", label: "Longest since scanned" }, { value: "name", label: "Device name" }, { value: "customer", label: "Customer" },
                ]} />
                <SearchField value={q} onChange={setQ} placeholder="Search devices or customers" label="Search devices or customers" />
                {loading ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-label="Loading" /> : null}
            </div>

            {error ? <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">{error}</p> : null}

            {page && page.items.length === 0 ? (
                <EmptyState>{page.total === 0 && !grade && !debouncedQ && !clientId ? "No devices yet. Security scans work on Windows and Linux devices that have an agent." : "No devices match."}</EmptyState>
            ) : (
                <div className="overflow-x-auto rounded-lg border">
                    <table className="w-full text-sm" data-testid="fleet-table">
                        <caption className="sr-only">Devices with their security score</caption>
                        <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
                            <tr>
                                <th scope="col" className="px-3 py-2">Device</th>
                                <th scope="col" className="hidden px-3 py-2 md:table-cell">Customer</th>
                                <th scope="col" className="px-3 py-2">Score</th>
                                <th scope="col" className="hidden px-3 py-2 sm:table-cell">Failed critical / high</th>
                                <th scope="col" className="hidden px-3 py-2 lg:table-cell">Antivirus</th>
                                <th scope="col" className="hidden px-3 py-2 xl:table-cell">Disk encryption</th>
                                <th scope="col" className="hidden px-3 py-2 xl:table-cell">Firewall</th>
                                <th scope="col" className="px-3 py-2">Last scan</th>
                            </tr>
                        </thead>
                        <tbody>
                            {(page?.items ?? []).map((r) => (
                                <tr key={r.deviceId} className="border-t align-top" data-testid="fleet-row">
                                    <td className="px-3 py-2">
                                        <Link href={`/devices/${r.deviceId}?tab=security`} className="font-medium underline-offset-2 hover:underline">{r.name}</Link>
                                        <span className="block text-xs text-muted-foreground md:hidden">{r.customer}</span>
                                        {!r.hasAgent ? <span className="block text-xs text-muted-foreground">No agent</span> : !r.online ? <span className="block text-xs text-muted-foreground">Offline</span> : null}
                                    </td>
                                    <td className="hidden px-3 py-2 md:table-cell">{r.customer}</td>
                                    <td className="px-3 py-2"><GradeBadge score={r.score} grade={r.grade} />{r.unknown ? <span className="block text-xs text-muted-foreground">{r.unknown} not read</span> : null}</td>
                                    <td className="hidden px-3 py-2 tabular-nums sm:table-cell">{r.score === null ? "—" : `${r.criticalFailed} / ${r.highFailed}`}</td>
                                    <td className="hidden px-3 py-2 lg:table-cell"><TonePill label={r.defender} /></td>
                                    <td className="hidden px-3 py-2 xl:table-cell"><TonePill label={r.bitlocker} /></td>
                                    <td className="hidden px-3 py-2 xl:table-cell"><TonePill label={r.firewall} /></td>
                                    <td className="px-3 py-2 whitespace-nowrap">
                                        {r.scannedAt ? <span className={cn(r.stale && "text-amber-700 dark:text-amber-400")}>{ago(r.scannedAt)}{r.stale ? " (out of date)" : ""}</span> : <span className="text-muted-foreground">{r.pending ? "Waiting" : "Never"}</span>}
                                        {r.lastAttemptFailed ? <span className="block text-xs text-destructive" title={r.message ?? undefined}>Last try failed</span> : null}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {page && page.total > 0 ? (
                <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                    <span className="text-muted-foreground">{offset + 1} to {Math.min(offset + limit, page.total)} of {page.total}</span>
                    <div className="flex items-center gap-2">
                        <label className="flex items-center gap-1 text-xs text-muted-foreground">Rows
                            <select className="h-8 rounded-md border bg-background px-1 text-sm" value={limit} onChange={(e) => { setLimit(Number(e.target.value)); setOffset(0); }} aria-label="Rows per page">
                                {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
                            </select>
                        </label>
                        <Button size="sm" variant="outline" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))}>Previous</Button>
                        <Button size="sm" variant="outline" disabled={offset + limit >= page.total} onClick={() => setOffset(offset + limit)}>Next</Button>
                    </div>
                </div>
            ) : null}
        </PageShell>
    );
}

const HEADER_TEXT = "How well each Windows and Linux device meets the security baseline: antivirus, firewall, disk encryption, accounts and more. Scores come from the last scan of each device. A critical failure, such as no antivirus, caps the grade.";

/** The fleet view, plus the secret access log for people with the right to view device secrets (nobody else sees the tab). */
function SecurityBody() {
    const { permissions } = useMe();
    const canLog = hasPerm(permissions, "devices.secrets.reveal");
    const [view, setView] = React.useState<"fleet" | "log">(() => (readParam("view", ["fleet", "log"] as const) === "log" ? "log" : "fleet"));
    const tabs = canLog ? (
        <SegmentedTabs label="Security views" value={view} onChange={(k) => setView(k === "log" ? "log" : "fleet")} items={[{ key: "fleet", label: "Devices" }, { key: "log", label: "Secret access log" }]} />
    ) : null;
    if (canLog && view === "log") {
        return (
            <PageShell>
                <PageHeader title="Security" description={HEADER_TEXT} />
                {tabs}
                <SecretAccessLog />
            </PageShell>
        );
    }
    return <SecurityInner tabs={tabs} />;
}

export default function SecurityPage() {
    return (
        <PermGate require="devices.read" title="Security" message="You need permission to view devices to see their security.">
            <SecurityBody />
        </PermGate>
    );
}
