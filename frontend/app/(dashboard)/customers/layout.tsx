// app/(dashboard)/customers/layout.tsx
"use client";

import * as React from "react";
import { CustomersProvider, useCustomers } from "./customers-context";
import CustomersSidebar from "./customers-sidebar";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { ChevronDown, ListTree } from "lucide-react";

/** On small screens the tree is a drawer, which closes once something is chosen. */
function CustomersDrawer() {
    const { scopeLabel } = useCustomers();
    const [open, setOpen] = React.useState(false);

    return (
        <div className="mb-3 lg:hidden">
            <Sheet open={open} onOpenChange={setOpen}>
                <SheetTrigger asChild>
                    <Button variant="outline" size="sm" className="w-full justify-start gap-2 sm:w-auto">
                        <ListTree className="h-4 w-4 shrink-0" aria-hidden="true" />
                        <span className="truncate">{scopeLabel}</span>
                        <ChevronDown className="ml-auto h-4 w-4 shrink-0 opacity-60 sm:ml-1" aria-hidden="true" />
                    </Button>
                </SheetTrigger>
                <SheetContent side="left" className="flex w-[85vw] max-w-sm flex-col gap-0 p-0 sm:w-96">
                    <SheetHeader className="border-b p-4 text-left">
                        <SheetTitle>Customers</SheetTitle>
                        <SheetDescription>Choose what the device list shows.</SheetDescription>
                    </SheetHeader>
                    <div className="min-h-0 flex-1">
                        <CustomersSidebar embedded onChoose={() => setOpen(false)} />
                    </div>
                </SheetContent>
            </Sheet>
        </div>
    );
}

/**
 * Customers area shell
 * - Fixed TopBar (56px).
 * - Left sidebar with independent scroll.
 * - Main content uses <main> landmark and skip link for a11y.
 */
export default function CustomersLayout({ children }: { children: React.ReactNode }) {
    return (
        <CustomersProvider>
            {/* Skip to content for keyboard users */}
            <a
                href="#customers-main"
                className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 rounded bg-primary px-3 py-2 text-primary-foreground"
            >
                Skip to content
            </a>

            {/* The header and its offset come from the shared (dashboard) layout, so it stays put when moving between pages. */}
            <div className="flex">
                {/* Local customers sidebar */}
                <div className="hidden lg:block">
                    <CustomersSidebar />
                </div>

                {/* Main content */}
                <main id="customers-main" className="page-frame w-full min-w-0 flex-1 p-4 sm:p-6 lg:px-8">
                    <CustomersDrawer />
                    {children}
                </main>
            </div>
        </CustomersProvider>
    );
}
