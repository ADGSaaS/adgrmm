"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { portal, when, type PortalTicket } from "@/lib/portal-api";
import { cn } from "@/lib/utils";
import { PortalTicketSurvey } from "@/components/surveys/ticket-survey-cards";
import { Pill, useLoad } from "../../parts";
import { useHref } from "../../portal-shell";

function Message({ who, at, body, mine, isNew }: { who: string; at: string; body: string; mine: boolean; isNew?: boolean }) {
    return (
        <div className={cn("rounded-xl border p-4", mine ? "bg-card" : "bg-primary/5", isNew && "border-primary ring-1 ring-primary/40")}>
            <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{who}{isNew ? <span className="ml-2 rounded-full bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground">New</span> : null}</span>
                <span>{when(at)}</span>
            </div>
            <p className="whitespace-pre-wrap break-words text-sm">{body}</p>
        </div>
    );
}

export default function PortalTicketPage() {
    const { id } = useParams<{ id: string }>();
    const href = useHref();
    const { data: t, error, setData } = useLoad(() => portal<PortalTicket>(`/tickets/${id}`), [id]);
    const [body, setBody] = React.useState("");
    const [busy, setBusy] = React.useState(false);
    const [sendError, setSendError] = React.useState<string | null>(null);
    // New replies from support show up while the ticket is open. Each check also counts as having seen them.
    const [fresh, setFresh] = React.useState<Set<string>>(new Set());
    React.useEffect(() => {
        const t = setInterval(() => {
            if (document.visibilityState !== "visible") return;
            portal<PortalTicket>(`/tickets/${id}`).then((next) => {
                setData(next);
                const ids = next.replies.filter((r) => r.isNew).map((r) => r.id);
                if (ids.length) setFresh((f) => new Set([...f, ...ids]));
            }).catch(() => undefined);
        }, 20_000);
        return () => clearInterval(t);
    }, [id, setData]);

    const send = async (e: React.FormEvent) => {
        e.preventDefault();
        setBusy(true);
        setSendError(null);
        try {
            await portal(`/tickets/${id}/replies`, { method: "POST", body: { body } });
            setBody("");
            setData(await portal<PortalTicket>(`/tickets/${id}`));
        } catch (err: any) {
            setSendError(err?.message || "Could not send your message.");
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="mx-auto max-w-3xl space-y-4">
            <Link href={href("/tickets")} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" aria-hidden />All tickets</Link>
            {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
            {!t && !error ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
            {t ? (
                <>
                    <div>
                        <div className="flex flex-wrap items-center gap-2">
                            <h1 className="text-xl font-semibold"><span className="text-muted-foreground">#{t.number}</span> {t.subject}</h1>
                            <Pill tone={t.status}>{t.statusLabel}</Pill>
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                            Opened {when(t.createdAt)}{t.openedBy ? ` by ${t.openedBy}` : ""}{t.device ? ` · ${t.device}` : ""}
                        </p>
                    </div>

                    {t.customFields && t.customFields.length > 0 ? (
                        <dl aria-label="Ticket details" className="grid gap-x-6 gap-y-2 rounded-xl border bg-card p-4 text-sm sm:grid-cols-2">
                            {t.customFields.map((f) => (
                                <div key={f.label}>
                                    <dt className="text-xs text-muted-foreground">{f.label}</dt>
                                    <dd className="break-words font-medium">
                                        {f.type === "url" ? <a href={f.value} target="_blank" rel="noreferrer" className="underline underline-offset-2">{f.value}</a> : f.value}
                                    </dd>
                                </div>
                            ))}
                        </dl>
                    ) : null}

                    <section aria-label="Conversation" className="space-y-3">
                        {t.description ? <Message who="Original request" at={t.createdAt} body={t.description} mine /> : null}
                        {t.replies.map((r) => <Message key={r.id} who={r.author} at={r.createdAt} body={r.body} mine={!r.fromSupport} isNew={r.isNew || fresh.has(r.id)} />)}
                    </section>

                    <PortalTicketSurvey ticketId={t.id} />

                    {t.canReply ? (
                        <form onSubmit={send} className="space-y-2">
                            <label htmlFor="reply" className="text-sm font-medium">Add a reply</label>
                            <Textarea id="reply" rows={5} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write your message…" />
                            {sendError ? <p role="alert" className="text-sm text-destructive">{sendError}</p> : null}
                            <div className="flex justify-end"><Button type="submit" disabled={busy || !body.trim()}>{busy ? "Sending…" : "Send reply"}</Button></div>
                        </form>
                    ) : (
                        <p className="rounded-xl border border-dashed p-4 text-center text-sm text-muted-foreground">This ticket is closed. If you still need help, open a new ticket.</p>
                    )}
                </>
            ) : null}
        </div>
    );
}
