"use client";

// The satisfaction survey a customer answers: a rating (stars, or thumbs) and an optional comment. Used on the page the
// emailed link opens (no sign-in) and inside the client portal on the ticket. The comment is plain text everywhere.
import * as React from "react";
import { Star, ThumbsDown, ThumbsUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

export type SurveyScale = "stars" | "thumbs";
export const STAR_LABELS: Record<number, string> = { 1: "Very unhappy", 2: "Unhappy", 3: "Okay", 4: "Happy", 5: "Very happy" };
const COMMENT_MAX = 2000;

export function RatingInput({ scale, value, onChange, disabled }: { scale: SurveyScale; value: number | null; onChange: (n: number) => void; disabled?: boolean }) {
    if (scale === "thumbs") {
        return (
            <div role="radiogroup" aria-label="How did we do?" className="flex gap-3">
                {([[5, "Good", ThumbsUp], [1, "Not good", ThumbsDown]] as const).map(([n, label, Icon]) => (
                    <button
                        key={n}
                        type="button"
                        role="radio"
                        aria-checked={value === n}
                        aria-label={label}
                        disabled={disabled}
                        onClick={() => onChange(n)}
                        className={cn("flex h-16 w-24 flex-col items-center justify-center gap-1 rounded-xl border text-sm transition-colors", value === n ? "border-primary bg-primary/10 text-primary" : "hover:bg-accent")}
                    >
                        <Icon className="h-6 w-6" aria-hidden />
                        {label}
                    </button>
                ))}
            </div>
        );
    }
    return (
        <div role="radiogroup" aria-label="How did we do?" className="flex flex-wrap gap-2">
            {[1, 2, 3, 4, 5].map((n) => (
                <button
                    key={n}
                    type="button"
                    role="radio"
                    aria-checked={value === n}
                    aria-label={`${n} of 5: ${STAR_LABELS[n]}`}
                    disabled={disabled}
                    onClick={() => onChange(n)}
                    className={cn("flex h-16 w-[4.5rem] flex-col items-center justify-center gap-1 rounded-xl border text-xs transition-colors", value === n ? "border-primary bg-primary/10 text-primary" : "hover:bg-accent")}
                >
                    <span className="flex items-center gap-0.5 text-base font-semibold"><Star className={cn("h-4 w-4", value !== null && n <= value ? "fill-current" : "")} aria-hidden />{n}</span>
                    <span className="px-1 text-center leading-tight text-muted-foreground">{STAR_LABELS[n]}</span>
                </button>
            ))}
        </div>
    );
}

/** The rating and comment, with the send button. `send` does the real request and throws a readable message on failure. */
export function SurveyAnswerForm({ scale, initialScore, send }: { scale: SurveyScale; initialScore?: number | null; send: (score: number, comment: string) => Promise<void> }) {
    const [score, setScore] = React.useState<number | null>(initialScore && (scale === "stars" || initialScore === 1 || initialScore === 5) ? initialScore : null);
    const [comment, setComment] = React.useState("");
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (score === null) {
            setError("Choose a rating first.");
            return;
        }
        setBusy(true);
        setError(null);
        try {
            await send(score, comment.trim());
        } catch (err: any) {
            setError(err?.message || "Could not send your answer.");
            setBusy(false);
        }
    };

    return (
        <form onSubmit={submit} className="space-y-4">
            <RatingInput scale={scale} value={score} onChange={(n) => { setScore(n); setError(null); }} disabled={busy} />
            <div>
                <label htmlFor="survey-comment" className="mb-1 block text-sm font-medium">Anything you would like to add? <span className="font-normal text-muted-foreground">(optional)</span></label>
                <Textarea id="survey-comment" rows={4} maxLength={COMMENT_MAX} value={comment} onChange={(e) => setComment(e.target.value)} disabled={busy} />
            </div>
            {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
            <Button type="submit" disabled={busy}>{busy ? "Sending…" : "Send"}</Button>
        </form>
    );
}

type View = { state: "open" | "answered" | "expired"; company: string; scale: SurveyScale; ticketNumber: number | null; subject: string };

/** The page behind the emailed link. The rating in the link only pre-selects: nothing is recorded until Send. */
export function SurveyPage({ token, preselect, embedded }: { token: string; preselect: number | null; embedded?: boolean }) {
    const [view, setView] = React.useState<View | null>(null);
    const [problem, setProblem] = React.useState<string | null>(null);
    const [done, setDone] = React.useState(false);

    React.useEffect(() => {
        if (!token) { setProblem("This survey link is not valid."); return; }
        let stale = false;
        // /api/portal/survey is served on both the main address and the portal's own domain.
        fetch(`/api/portal/survey/${encodeURIComponent(token)}`, { cache: "no-store", credentials: "omit" })
            .then(async (res) => {
                const body = await res.json().catch(() => null);
                if (stale) return;
                if (!res.ok) setProblem(res.status === 429 ? "Too many tries. Please wait a few minutes." : "This survey link is not valid.");
                else setView(body as View);
            })
            .catch(() => { if (!stale) setProblem("Could not reach the server. Try again in a moment."); });
        return () => { stale = true; };
    }, [token]);

    const send = async (score: number, comment: string) => {
        const res = await fetch(`/api/portal/survey/${encodeURIComponent(token)}`, {
            method: "POST",
            credentials: "omit",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ score, comment: comment || undefined }),
        });
        const body = await res.json().catch(() => null);
        if (res.status === 409) { setView((v) => (v ? { ...v, state: "answered" } : v)); return; }
        if (res.status === 410) { setView((v) => (v ? { ...v, state: "expired" } : v)); return; }
        if (!res.ok) throw new Error(Array.isArray(body?.message) ? body.message.join(" ") : body?.message || "Could not send your answer.");
        setDone(true);
    };

    const shell = (children: React.ReactNode) => embedded ? <div className="rounded-2xl border bg-card p-6 shadow-sm">{children}</div> : (
        <main className="mx-auto max-w-xl p-6 sm:p-10">
            <div className="rounded-2xl border bg-card p-6 shadow-sm">{children}</div>
        </main>
    );

    if (problem) return shell(<p role="alert" className="text-sm text-muted-foreground">{problem}</p>);
    if (!view) return shell(<p className="text-sm text-muted-foreground">Loading…</p>);
    if (done || view.state === "answered") return shell(<><h1 className="text-lg font-semibold">Thank you</h1><p className="mt-2 text-sm text-muted-foreground">{done ? "Your answer has been sent." : "This survey has already been answered."}{view.company ? ` — ${view.company}` : ""}</p></>);
    if (view.state === "expired") return shell(<><h1 className="text-lg font-semibold">This survey has closed</h1><p className="mt-2 text-sm text-muted-foreground">The link has expired. If you would still like to tell us how it went, reply to the email from support.</p></>);
    return shell(
        <>
            <h1 className="text-lg font-semibold">How did we do?</h1>
            <p className="mb-5 mt-1 text-sm text-muted-foreground">
                {view.company ? `${view.company}: ` : ""}ticket{view.ticketNumber ? ` #${view.ticketNumber}` : ""}{view.subject ? ` — ${view.subject}` : ""}
            </p>
            <SurveyAnswerForm scale={view.scale} initialScore={preselect} send={send} />
        </>,
    );
}
