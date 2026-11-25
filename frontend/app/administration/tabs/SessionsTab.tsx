"use client";

// Everyone's signed-in sessions: who, from where, on what, since when. An administrator can end one session or all of a
// person's sessions. People manage their own under Account.
import * as React from "react";
import { Loader2, LogOut, MonitorSmartphone, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { jfetch } from "@/lib/api";
import type { ToastFn } from "../types";

type SessionRow = {
    id: string;
    userId: string;
    email: string;
    name: string | null;
    roles: string[];
    userAgent: string;
    ip: string | null;
    createdAt: string;
    lastSeenAt: string;
    trusted: boolean;
    current: boolean;
};
type Page = { total: number; items: SessionRow[] };

const PAGE = 50;

const messageOf = (e: unknown) => {
    const raw = e instanceof Error ? e.message : "Something went wrong.";
    try { const j = JSON.parse(raw) as { message?: string | string[] }; return Array.isArray(j.message) ? j.message.join(" ") : j.message ?? raw; } catch { return raw; }
};

/** "Chrome on Windows" from a user agent string, close enough to recognise a device. */
export function describeAgent(ua: string): string {
    if (!ua) return "Unknown device";
    const os = /Windows/i.test(ua) ? "Windows" : /iPhone|iPad|iOS/i.test(ua) ? "iOS" : /Android/i.test(ua) ? "Android" : /Mac OS X|Macintosh/i.test(ua) ? "macOS" : /CrOS/i.test(ua) ? "ChromeOS" : /Linux/i.test(ua) ? "Linux" : "";
    const browser = /Edg\//i.test(ua) ? "Edge" : /OPR\/|Opera/i.test(ua) ? "Opera" : /Firefox\//i.test(ua) ? "Firefox" : /Chrome\//i.test(ua) ? "Chrome" : /Safari\//i.test(ua) ? "Safari" : /curl|node|python|axios|PowerShell/i.test(ua) ? "Script or tool" : "";
    if (browser && os) return `${browser} on ${os}`;
    return browser || os || ua.slice(0, 40);
}

function ago(iso: string): string {
    const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (min < 1) return "just now";
    if (min < 60) return `${min} min ago`;
    const h = Math.round(min / 60);
    if (h < 24) return `${h} h ago`;
    return `${Math.round(h / 24)} d ago`;
}

export default function SessionsTab({ push }: { push: ToastFn }) {
    const [data, setData] = React.useState<Page | null>(null);
    const [search, setSearch] = React.useState("");
    const [query, setQuery] = React.useState("");
    const [offset, setOffset] = React.useState(0);
    const [loading, setLoading] = React.useState(true);
    const [busy, setBusy] = React.useState<string | null>(null);

    const load = React.useCallback(async () => {
        setLoading(true);
        try {
            const qs = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
            if (query) qs.set("search", query);
            setData(await jfetch<Page>(`/api/admin/sessions?${qs}`));
        } catch (e) {
            push({ title: "Could not load sessions", desc: messageOf(e), kind: "destructive" });
        } finally {
            setLoading(false);
        }
    }, [offset, query, push]);
    React.useEffect(() => { void load(); }, [load]);

    async function endOne(s: SessionRow) {
        if (!confirm(`End this session of ${s.email}? That browser is signed out at once.`)) return;
        setBusy(s.id);
        try {
            await jfetch(`/api/admin/sessions/${s.id}`, { method: "DELETE" });
            push({ title: "Session ended", kind: "success" });
            await load();
        } catch (e) {
            push({ title: "Could not end the session", desc: messageOf(e), kind: "destructive" });
        } finally {
            setBusy(null);
        }
    }

    async function endAll(s: SessionRow) {
        if (!confirm(`End every session of ${s.email}? They are signed out everywhere.`)) return;
        setBusy(`user:${s.userId}`);
        try {
            const r = await jfetch<{ revoked: number }>(`/api/admin/sessions/user/${s.userId}/revoke`, { method: "POST" });
            push({ title: `Ended ${r?.revoked ?? 0} session${r?.revoked === 1 ? "" : "s"} of ${s.email}`, kind: "success" });
            await load();
        } catch (e) {
            push({ title: "Could not end the sessions", desc: messageOf(e), kind: "destructive" });
        } finally {
            setBusy(null);
        }
    }

    const items = data?.items ?? [];
    const total = data?.total ?? 0;

    return (
        <div className="grid gap-4">
            <div>
                <h2 className="flex items-center gap-2 text-xl font-semibold tracking-tight"><MonitorSmartphone className="h-5 w-5" aria-hidden /> Sessions</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                    Everyone who is signed in to this console. Ending a session signs that browser out on its next request. Each action is written to the audit log.
                    How long sessions last is set under Security Policies.
                </p>
            </div>

            <form
                className="flex flex-wrap items-center gap-2"
                onSubmit={(e) => { e.preventDefault(); setOffset(0); setQuery(search.trim()); }}
            >
                <Input className="max-w-xs" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search person, address or browser" aria-label="Search sessions" />
                <Button type="submit" size="sm" variant="outline">Search</Button>
                {query ? <Button type="button" size="sm" variant="ghost" onClick={() => { setSearch(""); setQuery(""); setOffset(0); }}>Clear</Button> : null}
                <Button type="button" size="sm" variant="outline" onClick={() => void load()} disabled={loading} title="Refresh">
                    {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                </Button>
                <span className="text-xs text-muted-foreground">{total} signed in</span>
            </form>

            <div className="overflow-x-auto rounded-md border">
                <table className="w-full min-w-[720px] text-left text-sm">
                    <thead className="bg-muted/40 text-xs text-muted-foreground">
                        <tr>
                            <th className="p-2 font-medium">Person</th>
                            <th className="p-2 font-medium">Device</th>
                            <th className="p-2 font-medium">Address</th>
                            <th className="p-2 font-medium">Signed in</th>
                            <th className="p-2 font-medium">Last active</th>
                            <th className="p-2 text-right font-medium">Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        {items.map((s) => (
                            <tr key={s.id} className="border-t align-top">
                                <td className="p-2">
                                    <div className="font-medium">{s.name ?? s.email}</div>
                                    <div className="text-xs text-muted-foreground">{s.name ? s.email : ""}{s.roles.length ? `${s.name ? " · " : ""}${s.roles.join(", ")}` : ""}</div>
                                </td>
                                <td className="p-2" title={s.userAgent}>
                                    {describeAgent(s.userAgent)}
                                    {s.current ? <span className="ml-2 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-xs">This session</span> : null}
                                    {s.trusted ? <span className="ml-2 rounded-full border px-2 py-0.5 text-xs text-muted-foreground">Trusted</span> : null}
                                </td>
                                <td className="p-2 font-mono text-xs">{s.ip ?? "unknown"}</td>
                                <td className="p-2 text-muted-foreground" title={new Date(s.createdAt).toLocaleString()}>{ago(s.createdAt)}</td>
                                <td className="p-2 text-muted-foreground" title={new Date(s.lastSeenAt).toLocaleString()}>{ago(s.lastSeenAt)}</td>
                                <td className="p-2 text-right">
                                    <div className="flex flex-wrap justify-end gap-1">
                                        <Button size="sm" variant="outline" disabled={s.current || busy === s.id} onClick={() => endOne(s)} title={s.current ? "This is your own session. Sign out instead." : "Sign this browser out"}>
                                            {busy === s.id ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <LogOut className="mr-1 h-3 w-3" />}End
                                        </Button>
                                        <Button size="sm" variant="ghost" disabled={busy === `user:${s.userId}`} onClick={() => endAll(s)} title={`End every session of ${s.email}`}>
                                            End all of theirs
                                        </Button>
                                    </div>
                                </td>
                            </tr>
                        ))}
                        {!items.length ? (
                            <tr><td colSpan={6} className="p-6 text-center text-sm text-muted-foreground">{loading ? "Loading…" : query ? "No session matches that search." : "Nobody is signed in."}</td></tr>
                        ) : null}
                    </tbody>
                </table>
            </div>

            {total > PAGE ? (
                <div className="flex items-center gap-2 text-sm">
                    <Button size="sm" variant="outline" disabled={offset === 0 || loading} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Previous</Button>
                    <span className="text-xs text-muted-foreground">{offset + 1}–{Math.min(offset + PAGE, total)} of {total}</span>
                    <Button size="sm" variant="outline" disabled={offset + PAGE >= total || loading} onClick={() => setOffset(offset + PAGE)}>Next</Button>
                </div>
            ) : null}
        </div>
    );
}
