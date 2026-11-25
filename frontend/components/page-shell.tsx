"use client";

// The one frame every page sits in, so they all line up: full width, the same side padding on every screen size,
// and the same heading. Nothing here caps the width; pages use the whole window, on a phone and on a wide monitor.
import * as React from "react";
import { cn } from "@/lib/utils";

/** The page body: full width, same padding everywhere, and an even gap between its sections. */
export function PageShell({ children, className, as: Tag = "main" }: { children: React.ReactNode; className?: string; as?: "main" | "div" | "section" }) {
    return <Tag className={cn("page-frame w-full min-w-0 space-y-6 p-4 sm:p-6 lg:px-8", className)}>{children}</Tag>;
}

/** Title, a line of help under it, and the page's main buttons. Stacks on a phone and sits in a row on a wider screen. */
export function PageHeader({ title, description, actions, className }: { title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; className?: string }) {
    return (
        <div className={cn("flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between", className)}>
            <div className="min-w-0">
                <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
                {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
            </div>
            {actions ? <div className="flex flex-wrap items-center gap-2 sm:justify-end">{actions}</div> : null}
        </div>
    );
}
