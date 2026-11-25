"use client";

// The shared look of an Administration tab, so every tab has the same width, the same heading and the same boxes:
//   <AdminTab>                     the column (one width for every tab)
//     <AdminTabHeader icon title description />
//     <AdminSection title description footer>   one box per topic; a Save belongs in ITS section's footer
//     <AdminNote tone="warn">                   a notice inside a section
//   </AdminTab>
// Controls inside a section use the shared Switch, Select, Input and Button, never a bare checkbox or select.
import * as React from "react";
import type { LucideIcon } from "lucide-react";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

/** The looks every Administration tab shares, as class strings for the places that build a box or a control by hand. */
export const ADMIN_COLUMN = "grid w-full min-w-0 gap-6";
export const ADMIN_BOX = "rounded-xl border border-border/70 bg-card p-5 text-card-foreground shadow-[0_1px_2px_rgba(0,0,0,0.06),0_8px_24px_-12px_rgba(0,0,0,0.25)]";
export const ADMIN_SELECT = "h-10 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
export const ADMIN_CHECKBOX = "h-4 w-4 shrink-0 rounded border-input accent-primary";
export const ADMIN_HEADING = "flex items-center gap-2 text-xl font-semibold tracking-tight";

/** The tab's column: the full width of the page, the same spacing everywhere. */
export function AdminTab({ children, className, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
    return <div className={cn(ADMIN_COLUMN, className)} {...rest}>{children}</div>;
}

export function AdminTabHeader({ icon: Icon, title, description, actions }: { icon?: LucideIcon; title: string; description?: React.ReactNode; actions?: React.ReactNode }) {
    return (
        <header className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 space-y-1">
                <h2 className={ADMIN_HEADING}>
                    {Icon ? <Icon className="h-5 w-5 shrink-0" aria-hidden /> : null}
                    {title}
                </h2>
                {description ? <p className="max-w-3xl text-sm text-muted-foreground">{description}</p> : null}
            </div>
            {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
        </header>
    );
}

export function AdminSection({
    title, description, icon: Icon, actions, footer, children, className, ...rest
}: {
    title?: string;
    description?: React.ReactNode;
    icon?: LucideIcon;
    actions?: React.ReactNode;
    footer?: React.ReactNode;
    children?: React.ReactNode;
} & Omit<React.HTMLAttributes<HTMLElement>, "title">) {
    return (
        <Card className={className}>
            <section {...rest}>
                {title || description || actions ? (
                    <CardHeader className="flex-row items-start justify-between gap-3 space-y-0 p-5 pb-3">
                        <div className="min-w-0 space-y-1">
                            {title ? (
                                <CardTitle className="flex items-center gap-2 text-base">
                                    {Icon ? <Icon className="h-4 w-4 shrink-0" aria-hidden /> : null}
                                    {title}
                                </CardTitle>
                            ) : null}
                            {description ? <CardDescription>{description}</CardDescription> : null}
                        </div>
                        {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
                    </CardHeader>
                ) : null}
                <CardContent className={cn("grid gap-4 p-5", title || description || actions ? "pt-2" : "")}>{children}</CardContent>
                {footer ? <CardFooter className="flex flex-wrap items-center gap-2 border-t p-4">{footer}</CardFooter> : null}
            </section>
        </Card>
    );
}

const NOTE_TONE = {
    info: "border-border bg-muted/40",
    ok: "border-emerald-500/40 bg-emerald-500/10",
    warn: "border-amber-500/40 bg-amber-500/10",
    bad: "border-red-500/40 bg-red-500/10",
} as const;

export function AdminNote({ tone = "info", children, className, ...rest }: { tone?: keyof typeof NOTE_TONE } & React.HTMLAttributes<HTMLDivElement>) {
    return <div role="status" className={cn("rounded-md border px-3 py-2 text-sm", NOTE_TONE[tone], className)} {...rest}>{children}</div>;
}

/** A label with a switch and a line of explanation, laid out the same wherever it is used. */
export function AdminToggle({ id, checked, onCheckedChange, label, children, disabled }: {
    id: string; checked: boolean; onCheckedChange: (v: boolean) => void; label: string; children?: React.ReactNode; disabled?: boolean;
}) {
    return (
        <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 space-y-1">
                <label htmlFor={id} className="text-sm font-medium">{label}</label>
                {children ? <p className="text-sm text-muted-foreground">{children}</p> : null}
            </div>
            <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} />
        </div>
    );
}

