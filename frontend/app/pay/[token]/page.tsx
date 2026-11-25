// app/pay/[token]/page.tsx
"use client";

import * as React from "react";
import { useParams, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { billingUrl, money } from "@/lib/billing-api";

type PublicDocument = {
    kind: "invoice" | "quote";
    number: string;
    status: string;
    currency: string;
    issueDate: string | null;
    dueDate: string | null;
    subtotalCents: number;
    taxCents: number;
    totalCents: number;
    paidCents: number;
    notes: string | null;
    clientName: string;
    company: { name: string; lines: string[] };
    footer: string | null;
    canPay: boolean;
    lines: Array<{ description: string; quantity: number; unitPriceCents: number; amountCents: number }>;
};

async function call<T>(path: string, method = "GET"): Promise<T> {
    const res = await fetch(billingUrl(`/api/public/billing/documents/${path}`), { method, cache: "no-store" });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(body?.message || "This link is not valid.");
    return body as T;
}

export default function PayPage() {
    const { token } = useParams<{ token: string }>();
    const justPaid = useSearchParams().get("paid") === "1";
    const [doc, setDoc] = React.useState<PublicDocument | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [busy, setBusy] = React.useState(false);

    const load = React.useCallback(() => {
        call<PublicDocument>(encodeURIComponent(token)).then(setDoc).catch((e) => setError(e.message));
    }, [token]);
    React.useEffect(load, [load]);

    if (error && !doc) {
        return <main className="mx-auto max-w-xl p-8 text-center text-sm text-muted-foreground">{error}</main>;
    }
    if (!doc) return <main className="mx-auto max-w-xl p-8 text-center text-sm text-muted-foreground">Loading...</main>;

    const balance = doc.totalCents - doc.paidCents;
    const quote = doc.kind === "quote";

    const pay = async () => {
        setBusy(true);
        setError(null);
        try {
            const { url } = await call<{ url: string }>(`${encodeURIComponent(token)}/checkout`, "POST");
            window.location.assign(url);
        } catch (e) {
            setError((e as Error).message);
            setBusy(false);
        }
    };

    const answer = async (accept: boolean) => {
        setBusy(true);
        setError(null);
        try {
            await call(`${encodeURIComponent(token)}/${accept ? "accept" : "decline"}`, "POST");
            load();
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setBusy(false);
        }
    };

    return (
        <main className="mx-auto grid max-w-3xl gap-6 p-4 sm:p-8">
            <header className="flex flex-wrap items-start justify-between gap-4">
                <div>
                    <h1 className="text-lg font-semibold">{doc.company.name}</h1>
                    {doc.company.lines.map((line) => <p key={line} className="text-xs text-muted-foreground">{line}</p>)}
                </div>
                <div className="text-right">
                    <p className="text-lg font-semibold">{quote ? "Quote" : "Invoice"} {doc.number}</p>
                    {doc.issueDate && <p className="text-xs text-muted-foreground">Date: {doc.issueDate}</p>}
                    {doc.dueDate && !quote && <p className="text-xs text-muted-foreground">Due: {doc.dueDate}</p>}
                </div>
            </header>

            <p className="text-sm">For {doc.clientName}</p>

            {justPaid && doc.status !== "paid" && (
                <p role="status" className="rounded-md border border-border bg-muted/40 p-3 text-sm">Thank you. Your payment is being confirmed, which can take a minute.</p>
            )}
            {doc.status === "paid" && <p role="status" className="rounded-md border border-border bg-muted/40 p-3 text-sm font-medium">Paid in full. Thank you.</p>}
            {doc.status === "accepted" && <p role="status" className="rounded-md border border-border bg-muted/40 p-3 text-sm font-medium">You accepted this quote. Thank you.</p>}
            {doc.status === "declined" && <p role="status" className="rounded-md border border-border bg-muted/40 p-3 text-sm">You declined this quote.</p>}

            <div className="overflow-x-auto">
                <table className="w-full min-w-[480px] text-sm">
                    <thead className="text-left text-xs text-muted-foreground">
                        <tr><th className="py-2 font-medium">Description</th><th className="py-2 text-right font-medium">Qty</th><th className="py-2 text-right font-medium">Price</th><th className="py-2 text-right font-medium">Amount</th></tr>
                    </thead>
                    <tbody className="tabular-nums">
                        {doc.lines.map((l, i) => (
                            <tr key={i} className="border-t border-border">
                                <td className="py-2 pr-2">{l.description}</td>
                                <td className="py-2 text-right">{l.quantity}</td>
                                <td className="py-2 text-right">{money(l.unitPriceCents, doc.currency)}</td>
                                <td className="py-2 text-right">{money(l.amountCents, doc.currency)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            <dl className="ml-auto grid w-60 grid-cols-2 gap-1 text-sm tabular-nums">
                <dt className="text-muted-foreground">Subtotal</dt><dd className="text-right">{money(doc.subtotalCents, doc.currency)}</dd>
                {doc.taxCents > 0 && <><dt className="text-muted-foreground">Tax</dt><dd className="text-right">{money(doc.taxCents, doc.currency)}</dd></>}
                <dt className="font-semibold">Total</dt><dd className="text-right font-semibold">{money(doc.totalCents, doc.currency)}</dd>
                {doc.paidCents > 0 && (
                    <>
                        <dt className="text-muted-foreground">Paid</dt><dd className="text-right">{money(doc.paidCents, doc.currency)}</dd>
                        <dt className="font-semibold">Balance</dt><dd className="text-right font-semibold">{money(balance, doc.currency)}</dd>
                    </>
                )}
            </dl>

            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

            <div className="flex flex-wrap justify-end gap-2">
                <Button asChild variant="outline"><a href={billingUrl(`/api/public/billing/documents/${encodeURIComponent(token)}/pdf`)}>Download PDF</a></Button>
                {doc.canPay && <Button disabled={busy} onClick={pay}>Pay {money(balance, doc.currency)}</Button>}
                {quote && doc.status === "sent" && (
                    <>
                        <Button variant="outline" disabled={busy} onClick={() => answer(false)}>Decline</Button>
                        <Button disabled={busy} onClick={() => answer(true)}>Accept quote</Button>
                    </>
                )}
            </div>

            {doc.notes && <p className="whitespace-pre-wrap text-sm text-muted-foreground">{doc.notes}</p>}
            {doc.footer && <p className="whitespace-pre-wrap text-xs text-muted-foreground">{doc.footer}</p>}
        </main>
    );
}
