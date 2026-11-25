"use client";

import * as React from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { ArrowLeft, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { money } from "@/lib/billing-api";
import { day, portal, type PortalInvoice } from "@/lib/portal-api";
import { Panel, Pill, useLoad } from "../../parts";
import { useHref } from "../../portal-shell";

function Invoice() {
    const { id } = useParams<{ id: string }>();
    const href = useHref();
    const justPaid = useSearchParams().get("paid") === "1";
    const { data: inv, error } = useLoad(() => portal<PortalInvoice>(`/invoices/${id}`), [id]);
    const [busy, setBusy] = React.useState(false);
    const [payError, setPayError] = React.useState<string | null>(null);

    const pay = async () => {
        setBusy(true);
        setPayError(null);
        try {
            const { url } = await portal<{ url: string }>(`/invoices/${id}/checkout`, { method: "POST" });
            window.location.href = url;
        } catch (e: any) {
            setPayError(e?.message || "Online payment is not available right now.");
            setBusy(false);
        }
    };

    const due = inv ? inv.totalCents - inv.paidCents : 0;

    return (
        <div className="mx-auto max-w-3xl space-y-4">
            <Link href={href("/invoices")} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" aria-hidden />All invoices</Link>
            {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
            {!inv && !error ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
            {justPaid ? <p role="status" className="rounded-lg border bg-emerald-500/10 p-3 text-sm">Thank you. Your payment is being confirmed and will show here shortly.</p> : null}
            {inv ? (
                <Panel className="p-5">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                            <h1 className="text-xl font-semibold">Invoice {inv.number}</h1>
                            <p className="mt-1 text-sm text-muted-foreground">Issued {day(inv.issueDate)} · Due {day(inv.dueDate)}</p>
                        </div>
                        <Pill tone={inv.status}>{inv.status === "paid" ? "Paid" : inv.status === "partial" ? "Part paid" : "Unpaid"}</Pill>
                    </div>

                    <div className="mt-4 overflow-x-auto">
                        <table className="w-full min-w-[420px] text-sm">
                            <thead className="border-b text-left text-xs text-muted-foreground">
                                <tr><th scope="col" className="py-2 font-medium">Description</th><th scope="col" className="py-2 text-right font-medium">Qty</th><th scope="col" className="py-2 text-right font-medium">Price</th><th scope="col" className="py-2 text-right font-medium">Amount</th></tr>
                            </thead>
                            <tbody className="divide-y">
                                {inv.lines.map((l, i) => (
                                    <tr key={i}>
                                        <td className="py-2">{l.description}</td>
                                        <td className="py-2 text-right tabular-nums">{l.quantity}</td>
                                        <td className="py-2 text-right tabular-nums">{money(l.unitPriceCents, inv.currency)}</td>
                                        <td className="py-2 text-right tabular-nums">{money(l.amountCents, inv.currency)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>

                    <dl className="mt-4 ml-auto w-full max-w-xs space-y-1 text-sm">
                        <div className="flex justify-between"><dt className="text-muted-foreground">Subtotal</dt><dd className="tabular-nums">{money(inv.subtotalCents, inv.currency)}</dd></div>
                        {inv.taxCents ? <div className="flex justify-between"><dt className="text-muted-foreground">Tax</dt><dd className="tabular-nums">{money(inv.taxCents, inv.currency)}</dd></div> : null}
                        <div className="flex justify-between font-medium"><dt>Total</dt><dd className="tabular-nums">{money(inv.totalCents, inv.currency)}</dd></div>
                        {inv.paidCents ? <div className="flex justify-between"><dt className="text-muted-foreground">Paid</dt><dd className="tabular-nums">{money(inv.paidCents, inv.currency)}</dd></div> : null}
                        {due > 0 ? <div className="flex justify-between border-t pt-1 text-base font-semibold"><dt>Balance due</dt><dd className="tabular-nums">{money(due, inv.currency)}</dd></div> : null}
                    </dl>

                    {inv.notes ? <p className="mt-4 whitespace-pre-wrap text-sm text-muted-foreground">{inv.notes}</p> : null}
                    {payError ? <p role="alert" className="mt-3 text-sm text-destructive">{payError}</p> : null}
                    <div className="mt-5 flex flex-wrap justify-end gap-2">
                        <Button asChild variant="outline" className="gap-1.5"><a href={`/api/portal/invoices/${id}/pdf`}><Download className="h-4 w-4" aria-hidden />Download PDF</a></Button>
                        {inv.canPay && due > 0 ? <Button onClick={pay} disabled={busy}>{busy ? "Opening…" : `Pay ${money(due, inv.currency)}`}</Button> : null}
                    </div>
                </Panel>
            ) : null}
        </div>
    );
}

export default function PortalInvoicePage() {
    return (
        <React.Suspense fallback={null}>
            <Invoice />
        </React.Suspense>
    );
}
