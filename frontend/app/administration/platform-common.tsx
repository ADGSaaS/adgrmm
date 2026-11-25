"use client";

// Small pieces shared by the platform screens: Secrets, System, Migrations, Feature Flags, Compliance, Roles Matrix, Import / Export.
import * as React from "react";
import { ADMIN_BOX, ADMIN_HEADING } from "./tab-layout";

export const messageOf = (e: unknown) => {
    const raw = e instanceof Error ? e.message : "Something went wrong.";
    try {
        const j = JSON.parse(raw) as { message?: string | string[] };
        return Array.isArray(j.message) ? j.message.join(" ") : j.message ?? raw;
    } catch {
        return raw;
    }
};

export function Header({ icon, title, children }: { icon: React.ReactNode; title: string; children?: React.ReactNode }) {
    return (
        <div>
            <h2 className={ADMIN_HEADING}>{icon} {title}</h2>
            {children ? <p className="mt-1 text-sm text-muted-foreground">{children}</p> : null}
        </div>
    );
}

export function Panel({ title, children, className = "" }: { title?: string; children: React.ReactNode; className?: string }) {
    return (
        <section className={`${ADMIN_BOX} ${className}`}>
            {title ? <h3 className="mb-3 text-base font-semibold">{title}</h3> : null}
            {children}
        </section>
    );
}

export function Row({ k, v }: { k: string; v: React.ReactNode }) {
    return (
        <>
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="break-words">{v}</dd>
        </>
    );
}

export function Pill({ tone, children }: { tone: "good" | "warn" | "bad" | "neutral"; children: React.ReactNode }) {
    const cls =
        tone === "good" ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200"
            : tone === "warn" ? "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-200"
                : tone === "bad" ? "border-destructive/40 bg-destructive/10 text-destructive"
                    : "text-muted-foreground";
    return <span className={`inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium ${cls}`}>{children}</span>;
}

export const isFailedPart = (x: unknown): x is { error: string } =>
    !!x && typeof x === "object" && !Array.isArray(x) && "error" in (x as object) && Object.keys(x as object).length === 1;

export const uptime = (s: number) =>
    s >= 86400 ? `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h` : s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(s / 60)}m`;

/** Saves a response as a file. The name is chosen here, since a browser hides response headers from another origin. */
export async function saveBlob(res: Response, filename: string) {
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}
