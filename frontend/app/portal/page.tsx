"use client";

import * as React from "react";
import Link from "next/link";
import { Monitor, Plus, Receipt, LifeBuoy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { money } from "@/lib/billing-api";
import { portal, when, type PortalDashboard } from "@/lib/portal-api";
import { Empty, Panel, Pill, useLoad } from "./parts";
import { useHref, usePortalMe } from "./portal-shell";

function Tile({ href, icon: Icon, label, value, note, tone }: { href: string; icon: React.ElementType; label: string; value: React.ReactNode; note?: string; tone?: string }) {
    return (
        <Link href={href} className="rounded-xl border bg-card p-4 transition-colors hover:bg-accent/40">
            <div className="flex items-center gap-2 text-sm text-muted-foreground"><Icon className="h-4 w-4" aria-hidden />{label}</div>
            <div className={`mt-2 text-3xl font-semibold tabular-nums ${tone ?? ""}`}>{value}</div>
            {note ? <div className="mt-1 text-xs text-muted-foreground">{note}</div> : null}
        </Link>
    );
}

export default function PortalHome() {
    const { me } = usePortalMe();
    const href = useHref();
    const { data: d, error } = useLoad(() => portal<PortalDashboard>("/dashboard"));

    return (
        <div className="space-y-6">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <h1 className="text-xl font-semibold">Welcome, {me.name}</h1>
                    <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{me.welcomeText || `Here is what is happening for ${me.customer}.`}</p>
                </div>
                {me.modules.includes("tickets") && me.allowTicketCreate ? (
                    <Button asChild className="gap-1.5"><Link href={href("/tickets/new")}><Plus className="h-4 w-4" aria-hidden />New ticket</Link></Button>
                ) : null}
            </div>

            {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
            {!d && !error ? <p className="text-sm text-muted-foreground">Loading…</p> : null}

            {d ? (
                <>
                    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                        {me.modules.includes("tickets") ? <Tile href={href("/tickets")} icon={LifeBuoy} label="Open tickets" value={d.openTickets} note={d.unreadReplies ? `${d.unreadReplies} with a new reply` : d.waitingTickets ? `${d.waitingTickets} waiting` : undefined} tone={d.unreadReplies ? "text-primary" : undefined} /> : null}
                        {d.devices ? <Tile href={href("/devices")} icon={Monitor} label="Devices" value={d.devices.total} note={`${d.devices.online} online, ${d.devices.offline} offline`} /> : null}
                        {d.invoices ? <Tile href={href("/invoices")} icon={Receipt} label="Unpaid invoices" value={d.invoices.unpaid} note={d.invoices.unpaid ? `${money(d.invoices.balanceCents)} due${d.invoices.overdue ? `, ${d.invoices.overdue} overdue` : ""}` : "All paid up"} tone={d.invoices.overdue ? "text-red-600 dark:text-red-400" : undefined} /> : null}
                    </div>

                    {me.modules.includes("tickets") ? (
                        <section aria-labelledby="recent">
                            <h2 id="recent" className="mb-2 text-sm font-medium">Recent tickets</h2>
                            {d.recentTickets.length === 0 ? (
                                <Empty>No tickets yet.</Empty>
                            ) : (
                                <Panel className="divide-y">
                                    {d.recentTickets.map((t) => (
                                        <Link key={t.id} href={href(`/tickets/${t.id}`)} className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-accent/40">
                                            <span className="min-w-0"><span className="text-muted-foreground">#{t.number}</span> <span className="font-medium">{t.subject}</span></span>
                                            <span className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground"><span className="hidden sm:inline">{when(t.updatedAt)}</span><Pill tone={t.status}>{t.statusLabel}</Pill></span>
                                        </Link>
                                    ))}
                                </Panel>
                            )}
                        </section>
                    ) : null}
                </>
            ) : null}
        </div>
    );
}
