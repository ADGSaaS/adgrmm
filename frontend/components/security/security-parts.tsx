"use client";

// Small pieces shared by the device's Security tab and the fleet page: the score ring, the grade badge and the tone pill.
import * as React from "react";
import { cn } from "@/lib/utils";
import { gradeClass, type Grade, type Label } from "@/lib/security-api";

/** The score as a ring with the number in the middle and the grade under it. Read out as one sentence. */
export function ScoreRing({ score, grade, size = 112 }: { score: number | null; grade: Grade | null; size?: number }) {
    const r = 42;
    const c = 2 * Math.PI * r;
    const pct = score === null ? 0 : Math.max(0, Math.min(100, score));
    return (
        <div
            role="img"
            aria-label={score === null || grade === null ? "No security score yet" : `Security score ${score} out of 100, grade ${grade}`}
            className={cn("relative shrink-0", gradeClass(grade))}
            style={{ width: size, height: size }}
            data-testid="score-ring"
        >
            <svg viewBox="0 0 100 100" width={size} height={size} aria-hidden="true">
                <circle cx="50" cy="50" r={r} fill="none" strokeWidth="9" className="stroke-muted" />
                <circle cx="50" cy="50" r={r} fill="none" strokeWidth="9" strokeLinecap="round" stroke="currentColor" strokeDasharray={`${(c * pct) / 100} ${c}`} transform="rotate(-90 50 50)" />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center leading-tight" aria-hidden="true">
                <span className="text-2xl font-semibold tabular-nums">{score === null ? "—" : score}</span>
                <span className="text-xs font-medium text-muted-foreground">{grade ? `Grade ${grade}` : "Not scored"}</span>
            </div>
        </div>
    );
}

/** A letter and a score in one badge, for a table cell. */
export function GradeBadge({ score, grade }: { score: number | null; grade: Grade | null }) {
    if (score === null || grade === null) return <span className="text-xs text-muted-foreground">Not scanned</span>;
    return (
        <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border px-2 py-0.5 text-sm font-semibold tabular-nums", gradeClass(grade))} aria-label={`Grade ${grade}, score ${score}`}>
            {grade}<span className="text-xs font-normal text-muted-foreground">{score}</span>
        </span>
    );
}

const TONE: Record<Label["tone"], string> = {
    good: "bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300",
    warn: "bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-300",
    bad: "bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-300",
    unknown: "bg-muted text-muted-foreground",
};
const TONE_WORD: Record<Label["tone"], string> = { good: "OK", warn: "Needs attention", bad: "Problem", unknown: "Unknown" };

/** A short state ("Defender on, definitions today") with a colour and, for people who cannot see the colour, a word. */
export function TonePill({ label }: { label: Label | null }) {
    if (!label) return <span className="text-xs text-muted-foreground">—</span>;
    return (
        <span className={cn("inline-block max-w-[16rem] rounded-md px-2 py-0.5 text-xs", TONE[label.tone])} title={`${TONE_WORD[label.tone]}: ${label.text}`}>
            <span className="sr-only">{TONE_WORD[label.tone]}: </span>{label.text}
        </span>
    );
}
