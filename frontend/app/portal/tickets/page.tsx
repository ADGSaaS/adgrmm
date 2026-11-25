"use client";

import * as React from "react";
import Link from "next/link";
import { Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { portal, when, type PortalTicketRow } from "@/lib/portal-api";
import { cn } from "@/lib/utils";
import { Empty, PageTitle, Panel, Pill, useLoad } from "../parts";
import { useHref, usePortalMe } from "../portal-shell";

const TABS = [
    { id: "open", label: "Open" },
    { id: "closed", label: "Closed" },
    { id: "all", label: "All" },
];

export default function PortalTickets() {
    const { me } = usePortalMe();
    const href = useHref();
    const [tab, setTab] = React.useState("open");
    const [q, setQ] = React.useState("");
    const [typed, setTyped] = React.useState("");
    React.useEffect(() => {
        const t = setTimeout(() => setQ(typed.trim()), 300);
        return () => clearTimeout(t);
    }, [typed]);
    const { data, error, setData } = useLoad(() => portal<PortalTicketRow[]>(`/tickets?status=${tab}${q ? `&q=${encodeURIComponent(q)}` : ""}`), [tab, q]);
    // New replies from support show up without reloading.
    React.useEffect(() => {
        const t = setInterval(() => {
            if (document.visibilityState === "visible") portal<PortalTicketRow[]>(`/tickets?status=${tab}${q ? `&q=${encodeURIComponent(q)}` : ""}`).then(setData).catch(() => undefined);
        }, 30_000);
        return () => clearInterval(t);
    }, [tab, q, setData]);

    return (
        <div>
            <PageTitle title="Tickets">
                {me.allowTicketCreate ? <Button asChild className="gap-1.5"><Link href={href("/tickets/new")}><Plus className="h-4 w-4" aria-hidden />New ticket</Link></Button> : null}
            </PageTitle>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div role="tablist" aria-label="Which tickets" className="flex rounded-lg border bg-card p-0.5">
                    {TABS.map((t) => (
                        <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}
                            className={cn("rounded-md px-3 py-1 text-sm", tab === t.id ? "bg-accent font-medium" : "text-muted-foreground hover:text-foreground")}>
                            {t.label}
                        </button>
                    ))}
                </div>
                <div className="relative w-full sm:w-64">
                    <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden />
                    <Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Search tickets…" aria-label="Search tickets" className="pl-8" />
                </div>
            </div>
            {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
            {!data && !error ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
            {data && data.length === 0 ? <Empty>{q ? "No ticket matches your search." : tab === "closed" ? "No closed tickets." : "You have no open tickets."}</Empty> : null}
            {data && data.length > 0 ? (
                <Panel className="overflow-x-auto">
                    <table className="w-full min-w-[560px] text-sm">
                        <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                            <tr><th scope="col" className="px-4 py-2 font-medium">Ticket</th><th scope="col" className="px-4 py-2 font-medium">Status</th><th scope="col" className="px-4 py-2 font-medium">Opened</th><th scope="col" className="px-4 py-2 font-medium">Last update</th></tr>
                        </thead>
                        <tbody className="divide-y">
                            {data.map((t) => (
                                <tr key={t.id} className="hover:bg-accent/40">
                                    <td className="px-4 py-3"><Link href={href(`/tickets/${t.id}`)} className={t.unread ? "font-semibold hover:underline" : "font-medium hover:underline"}><span className="text-muted-foreground">#{t.number}</span> {t.subject}</Link>{t.unread ? <span className="ml-2 rounded-full bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground">New reply</span> : null}{t.device ? <div className="text-xs text-muted-foreground">{t.device}</div> : null}</td>
                                    <td className="px-4 py-3"><Pill tone={t.status}>{t.statusLabel}</Pill></td>
                                    <td className="px-4 py-3 text-muted-foreground">{when(t.createdAt)}</td>
                                    <td className="px-4 py-3 text-muted-foreground">{when(t.updatedAt)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </Panel>
            ) : null}
        </div>
    );
}
