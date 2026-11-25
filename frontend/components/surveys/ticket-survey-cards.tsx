"use client";

// The survey on a ticket: for the customer in the portal (answer it there), and for technicians on the ticket page
// (what was asked and answered).
import * as React from "react";
import { Star } from "lucide-react";
import { jfetch } from "@/lib/api";
import { portal } from "@/lib/portal-api";
import { STAR_LABELS, SurveyAnswerForm, type SurveyScale } from "@/components/surveys/survey-form";

type PortalSurvey = { available: false } | { available: true; state: "open" | "answered" | "expired"; scale: SurveyScale; score: number | null };

/** In the portal, on a closed ticket the customer was asked about. Shows nothing when there is no survey to answer. */
export function PortalTicketSurvey({ ticketId }: { ticketId: string }) {
    const [s, setS] = React.useState<PortalSurvey | null>(null);
    const [thanks, setThanks] = React.useState(false);
    React.useEffect(() => {
        let stale = false;
        portal<PortalSurvey>(`/tickets/${ticketId}/survey`).then((r) => { if (!stale) setS(r); }).catch(() => { if (!stale) setS({ available: false }); });
        return () => { stale = true; };
    }, [ticketId]);

    if (!s || !s.available || s.state === "expired") return null;
    if (thanks || s.state === "answered") {
        return (
            <section aria-label="Survey" className="rounded-xl border bg-card p-4 text-sm">
                <p className="font-medium">Thank you for your feedback.</p>
                {!thanks && s.score ? <p className="mt-1 text-muted-foreground">You rated this {s.scale === "thumbs" ? (s.score >= 4 ? "thumbs up" : "thumbs down") : `${s.score} of 5 (${STAR_LABELS[s.score]})`}.</p> : null}
            </section>
        );
    }
    return (
        <section aria-label="Survey" className="rounded-xl border bg-card p-4">
            <h2 className="text-sm font-semibold">How did we do?</h2>
            <p className="mb-4 mt-1 text-sm text-muted-foreground">Tell us how this ticket was handled. It takes a few seconds.</p>
            <SurveyAnswerForm
                scale={s.scale}
                send={async (score, comment) => {
                    await portal(`/tickets/${ticketId}/survey`, { method: "POST", body: { score, comment: comment || undefined } });
                    setThanks(true);
                }}
            />
        </section>
    );
}

type StaffSurvey = {
    status: "pending" | "sent" | "answered" | "expired" | "skipped" | "failed";
    skipReason: string | null;
    recipient: string | null;
    sentAt: string | null;
    remindedAt: string | null;
    expiresAt: string | null;
    answeredAt: string | null;
    answeredVia: string | null;
    score: number | null;
    comment: string | null;
    lastError: string | null;
};

const SKIP_TEXT: Record<string, string> = {
    no_recipient: "Not sent: nobody with an email address asked for this ticket.",
    customer_not_included: "Not sent: this customer is not included in the surveys.",
    throttled: "Not sent: this person was asked about another ticket recently.",
    turned_off: "Not sent: surveys were turned off before it went out.",
    ticket_reopened: "Not sent: the ticket was reopened first.",
};

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "");

/** On the technician's ticket page. Renders nothing until the ticket has had a survey, so tickets before surveys are unaffected. */
export function TicketSurveyCard({ ticketId, refreshKey }: { ticketId: string; refreshKey?: unknown }) {
    const [s, setS] = React.useState<StaffSurvey | null>(null);
    React.useEffect(() => {
        let stale = false;
        jfetch<{ survey: StaffSurvey | null }>(`/api/tickets/${ticketId}/survey`).then((r) => { if (!stale) setS(r?.survey ?? null); }).catch(() => { if (!stale) setS(null); });
        return () => { stale = true; };
    }, [ticketId, refreshKey]);
    if (!s) return null;

    return (
        <div className="shrink-0 rounded-xl border border-border/70 bg-card p-5 shadow-[0_1px_2px_rgba(0,0,0,0.06),0_8px_24px_-12px_rgba(0,0,0,0.25)] backdrop-blur-sm">
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">Customer survey</h3>
            {s.status === "answered" ? (
                <div className="space-y-2 text-sm">
                    <p className="flex items-center gap-1 font-medium">
                        {s.score !== null && s.score <= 2 ? <span className="rounded-full bg-destructive/15 px-2 py-0.5 text-xs text-destructive">Low</span> : null}
                        {[1, 2, 3, 4, 5].map((n) => <Star key={n} className={n <= (s.score ?? 0) ? "h-4 w-4 fill-current text-amber-500" : "h-4 w-4 text-muted-foreground/40"} aria-hidden />)}
                        <span className="ml-1">{s.score} of 5</span>
                    </p>
                    {s.comment ? <p className="whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-2">{s.comment}</p> : <p className="text-muted-foreground">No comment.</p>}
                    <p className="text-xs text-muted-foreground">{s.recipient} · {when(s.answeredAt)}{s.answeredVia === "portal" ? " · in the portal" : ""}</p>
                </div>
            ) : s.status === "sent" ? (
                <p className="text-sm text-muted-foreground">Asked {s.recipient} on {when(s.sentAt)}{s.remindedAt ? `, reminded ${when(s.remindedAt)}` : ""}. No answer yet{s.expiresAt ? ` (the link works until ${when(s.expiresAt)})` : ""}.</p>
            ) : s.status === "expired" ? (
                <p className="text-sm text-muted-foreground">Asked {s.recipient} on {when(s.sentAt)}. They did not answer in time.</p>
            ) : s.status === "skipped" ? (
                <p className="text-sm text-muted-foreground">{SKIP_TEXT[s.skipReason ?? ""] ?? "Not sent."}</p>
            ) : s.status === "failed" ? (
                <p className="text-sm text-destructive">The survey email could not be sent{s.lastError ? `: ${s.lastError}` : "."}</p>
            ) : (
                <p className="text-sm text-muted-foreground">The survey is waiting to be sent{s.lastError ? ` (last try failed: ${s.lastError})` : ""}.</p>
            )}
        </div>
    );
}
