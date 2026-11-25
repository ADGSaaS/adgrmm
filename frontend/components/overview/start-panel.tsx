"use client";

// components/overview/start-panel.tsx
//
// What a new install shows instead of empty charts: three steps to the first device, with a link to each one that the person
// is allowed to open. The page looks again for a device by itself, so the first one to report in replaces this panel.
import * as React from "react";
import Link from "next/link";
import { CheckCircle2, Monitor } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Step = { n: number; title: string; text: string; done?: boolean; action?: { label: string; href: string; primary?: boolean } | null };

export function StartPanel({ customers, canAdmin, canCustomers }: { customers: number | null; canAdmin: boolean; canCustomers: boolean }) {
    const haveCustomer = (customers ?? 0) > 0;
    const steps: Step[] = [
        {
            n: 1,
            title: haveCustomer ? "You have a customer" : "Add a customer and a site",
            text: haveCustomer ? "Every device belongs to a customer and one of its sites." : "Every device belongs to a customer and one of its sites. Create the first one.",
            done: haveCustomer,
            action: !haveCustomer && canCustomers ? { label: "Add a customer", href: "/customers", primary: !haveCustomer } : null,
        },
        {
            n: 2,
            title: "Install the agent on a computer",
            text: canAdmin ? "Create an install key, then run the installer it gives you on the computer you want to manage." : "Ask an administrator for an install link, then run it on the computer you want to manage.",
            action: canAdmin ? { label: "Create an installer", href: "/administration?tab=install_keys", primary: haveCustomer || !canCustomers } : null,
        },
        { n: 3, title: "It shows up here", text: "The device appears within a minute of the agent starting. This page checks again by itself." },
    ];
    return (
        <Card className="p-6 sm:p-8" role="region" aria-labelledby="ov-start">
            <div className="flex items-start gap-4">
                <span className="hidden h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary sm:flex" aria-hidden><Monitor className="h-5 w-5" /></span>
                <div className="min-w-0">
                    <h2 id="ov-start" className="text-lg font-semibold tracking-tight">Add your first device</h2>
                    <p className="mt-1 max-w-prose text-sm text-muted-foreground">Nothing is reporting in yet. Three steps and this page fills with the health of everything you manage.</p>
                </div>
            </div>
            <ol className="mt-6 grid gap-4 md:grid-cols-3">
                {steps.map((s) => (
                    <li key={s.n} className="flex flex-col rounded-lg border border-border/70 p-4">
                        <div className="flex items-center gap-2">
                            {s.done ? (
                                <CheckCircle2 className="h-5 w-5 text-emerald-600 dark:text-emerald-400" aria-label="Done" />
                            ) : (
                                <span className={cn("flex h-5 w-5 items-center justify-center rounded-full bg-muted text-xs font-semibold tabular-nums")} aria-hidden>{s.n}</span>
                            )}
                            <h3 className="text-sm font-medium">{s.title}</h3>
                        </div>
                        <p className="mt-2 flex-1 text-sm text-muted-foreground">{s.text}</p>
                        {s.action ? (
                            <Button asChild size="sm" variant={s.action.primary ? "default" : "outline"} className="mt-3 self-start">
                                <Link href={s.action.href}>{s.action.label}</Link>
                            </Button>
                        ) : null}
                    </li>
                ))}
            </ol>
        </Card>
    );
}
