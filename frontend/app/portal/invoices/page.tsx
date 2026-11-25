"use client";

import * as React from "react";
import Link from "next/link";
import { money } from "@/lib/billing-api";
import { day, portal, type PortalInvoiceRow } from "@/lib/portal-api";
import { Empty, PageTitle, Panel, Pill, useLoad } from "../parts";
import { useHref, usePortalMe } from "../portal-shell";

const isOverdue = (i: { status: string; dueDate: string | null; dueCents: number }) =>
    i.dueCents > 0 && !!i.dueDate && new Date(`${String(i.dueDate).slice(0, 10)}T23:59:59`).getTime() < Date.now();

export default function PortalInvoices() {
    const { me } = usePortalMe();
    const href = useHref();
    const { data, error } = useLoad(() => portal<PortalInvoiceRow[]>("/invoices"));
    if (!me.modules.includes("invoices")) return <Empty>This area is not available to you.</Empty>;

    return (
        <div>
            <PageTitle title="Invoices" />
            {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
            {!data && !error ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
            {data && data.length === 0 ? <Empty>No invoices yet.</Empty> : null}
            {data && data.length > 0 ? (
                <Panel className="overflow-x-auto">
                    <table className="w-full min-w-[560px] text-sm">
                        <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                            <tr><th scope="col" className="px-4 py-2 font-medium">Invoice</th><th scope="col" className="px-4 py-2 font-medium">Status</th><th scope="col" className="px-4 py-2 font-medium">Issued</th><th scope="col" className="px-4 py-2 font-medium">Due</th><th scope="col" className="px-4 py-2 text-right font-medium">Total</th><th scope="col" className="px-4 py-2 text-right font-medium">Balance</th></tr>
                        </thead>
                        <tbody className="divide-y">
                            {data.map((i) => {
                                const late = isOverdue(i);
                                return (
                                    <tr key={i.id} className="hover:bg-accent/40">
                                        <td className="px-4 py-3"><Link href={href(`/invoices/${i.id}`)} className="font-medium hover:underline">{i.number ?? "Invoice"}</Link></td>
                                        <td className="px-4 py-3"><Pill tone={late ? "overdue" : i.status}>{late ? "Overdue" : i.status === "partial" ? "Part paid" : i.status === "paid" ? "Paid" : "Unpaid"}</Pill></td>
                                        <td className="px-4 py-3 text-muted-foreground">{day(i.issueDate)}</td>
                                        <td className="px-4 py-3 text-muted-foreground">{day(i.dueDate)}</td>
                                        <td className="px-4 py-3 text-right tabular-nums">{money(i.totalCents, i.currency)}</td>
                                        <td className="px-4 py-3 text-right tabular-nums">{i.dueCents > 0 ? money(i.dueCents, i.currency) : "—"}</td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </Panel>
            ) : null}
        </div>
    );
}
