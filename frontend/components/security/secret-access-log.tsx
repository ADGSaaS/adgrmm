"use client";

// The secret access log: who revealed a BitLocker recovery key or a local administrator password, who escrowed keys or rotated a
// password, on which device, when, and the reason they gave. Read only. Shown to people with the right to view device secrets.
// Paged and filtered on the server. A table on a wide screen and cards on a phone.
import * as React from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState, FilterSelect } from "@/components/list-controls";
import { Pill, errorText } from "@/components/policies/shared";
import { fetchCustomers, type CustomerClient } from "@/lib/api";
import { ACTION_TEXT, KIND_TEXT, vault, type AccessPage, type AccessRow } from "@/lib/vault-api";

const PAGE_SIZES = [25, 50, 100, 200];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const stamp = (iso: string) => new Date(iso).toLocaleString();

function Outcome({ r }: { r: AccessRow }) {
    const ok = r.outcome === "ok" || r.outcome === "success";
    return (
        <span className="inline-flex flex-wrap items-center gap-1">
            <Pill tone={ok ? "good" : "bad"}>{r.outcome}</Pill>
            {r.error ? <span className="text-xs text-destructive">{r.error}</span> : null}
        </span>
    );
}

function What({ r }: { r: AccessRow }) {
    return (
        <>
            <span className="font-medium">{ACTION_TEXT[r.action] ?? r.action}</span>
            {r.secretKind || r.label ? <span className="block text-xs text-muted-foreground">{[r.secretKind ? KIND_TEXT[r.secretKind] : null, r.label].filter(Boolean).join(", ")}</span> : null}
        </>
    );
}

export default function SecretAccessLog() {
    const [clients, setClients] = React.useState<CustomerClient[]>([]);
    const [clientId, setClientId] = React.useState("");
    const [device, setDevice] = React.useState("");
    const [user, setUser] = React.useState("");
    const [debounced, setDebounced] = React.useState({ device: "", user: "" });
    const [limit, setLimit] = React.useState(50);
    const [offset, setOffset] = React.useState(0);
    const [page, setPage] = React.useState<AccessPage | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [loading, setLoading] = React.useState(false);

    React.useEffect(() => { void fetchCustomers().then(setClients).catch(() => setClients([])); }, []);
    React.useEffect(() => {
        const t = setTimeout(() => { setDebounced({ device: device.trim(), user: user.trim() }); setOffset(0); }, 300);
        return () => clearTimeout(t);
    }, [device, user]);

    const deviceOk = debounced.device === "" || UUID.test(debounced.device);
    React.useEffect(() => {
        if (!deviceOk) return;
        let cancelled = false;
        setLoading(true);
        setError(null);
        vault.access({ clientId: clientId || undefined, deviceId: debounced.device || undefined, user: debounced.user || undefined, limit, offset })
            .then((p) => !cancelled && setPage(p))
            .catch((e) => !cancelled && setError(errorText(e)))
            .finally(() => !cancelled && setLoading(false));
        return () => { cancelled = true; };
    }, [clientId, debounced, deviceOk, limit, offset]);

    const filtered = !!clientId || !!debounced.device || !!debounced.user;
    const items = page?.items ?? [];

    return (
        <section className="space-y-4" aria-label="Secret access log" data-testid="secret-access-log">
            <p className="text-sm text-muted-foreground">Every time someone revealed a BitLocker recovery key or a local administrator password, or keys were escrowed or a password rotated, with who did it, on which device and the reason given. The secrets themselves are never shown here. Newest first.</p>

            <div className="flex flex-wrap items-start gap-2">
                <FilterSelect label="Customer" value={clientId} onChange={(v) => { setClientId(v); setOffset(0); }} options={[{ value: "", label: "All customers" }, ...clients.map((c) => ({ value: c.id, label: c.name }))]} />
                <div className="grid gap-0.5">
                    <Input value={device} onChange={(e) => setDevice(e.target.value)} placeholder="Device id" aria-label="Device id" autoComplete="off" className="w-full sm:w-72" aria-invalid={!deviceOk ? true : undefined} />
                    {!deviceOk ? <span className="text-xs text-destructive" role="alert">That is not a device id. Paste the id from the device&apos;s page address.</span> : null}
                </div>
                <Input value={user} onChange={(e) => setUser(e.target.value)} placeholder="Person (name or email)" aria-label="Person" autoComplete="off" className="w-full sm:w-64" />
                {loading ? <Loader2 className="mt-3 h-4 w-4 animate-spin text-muted-foreground" aria-label="Loading" /> : null}
            </div>

            {error ? <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">{error}</p> : null}

            {page && items.length === 0 ? (
                <EmptyState>{filtered ? "Nothing matches these filters." : "Nothing has been revealed, escrowed or rotated yet."}</EmptyState>
            ) : page ? (
                <>
                    <div className="hidden overflow-x-auto rounded-lg border md:block">
                        <table className="w-full text-sm" data-testid="access-table">
                            <caption className="sr-only">Access to device secrets, newest first</caption>
                            <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
                                <tr>
                                    <th scope="col" className="px-3 py-2">When</th>
                                    <th scope="col" className="px-3 py-2">Person</th>
                                    <th scope="col" className="px-3 py-2">What</th>
                                    <th scope="col" className="px-3 py-2">Device</th>
                                    <th scope="col" className="hidden px-3 py-2 xl:table-cell">Customer</th>
                                    <th scope="col" className="px-3 py-2">Reason</th>
                                    <th scope="col" className="px-3 py-2">Outcome</th>
                                </tr>
                            </thead>
                            <tbody>
                                {items.map((r) => (
                                    <tr key={r.id} className="border-t align-top" data-testid="access-row">
                                        <td className="whitespace-nowrap px-3 py-2">{stamp(r.at)}</td>
                                        <td className="px-3 py-2">{r.userName ?? <span className="text-muted-foreground">The system</span>}</td>
                                        <td className="px-3 py-2"><What r={r} /></td>
                                        <td className="px-3 py-2"><Link href={`/devices/${r.deviceId}?tab=security`} className="font-medium underline-offset-2 hover:underline">{r.deviceName}</Link></td>
                                        <td className="hidden px-3 py-2 xl:table-cell">{r.customer ?? "—"}</td>
                                        <td className="max-w-xs break-words px-3 py-2">{r.reason ?? <span className="text-muted-foreground">—</span>}</td>
                                        <td className="px-3 py-2"><Outcome r={r} /></td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>

                    <ul className="m-0 grid list-none gap-2 p-0 md:hidden" data-testid="access-cards">
                        {items.map((r) => (
                            <li key={r.id} className="space-y-1 rounded-lg border p-3 text-sm">
                                <div className="flex flex-wrap items-start justify-between gap-2">
                                    <div className="min-w-0"><What r={r} /></div>
                                    <Outcome r={r} />
                                </div>
                                <p className="text-xs text-muted-foreground">{stamp(r.at)}</p>
                                <p><span className="text-muted-foreground">By </span>{r.userName ?? "the system"}<span className="text-muted-foreground"> on </span><Link href={`/devices/${r.deviceId}?tab=security`} className="break-all font-medium underline-offset-2 hover:underline">{r.deviceName}</Link>{r.customer ? <span className="text-muted-foreground"> ({r.customer})</span> : null}</p>
                                {r.reason ? <p className="break-words"><span className="text-muted-foreground">Reason: </span>{r.reason}</p> : null}
                            </li>
                        ))}
                    </ul>
                </>
            ) : null}

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
        </section>
    );
}
