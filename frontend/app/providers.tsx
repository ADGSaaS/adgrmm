// app/providers.tsx
"use client";

import * as React from "react";
import { ToastProvider } from "@/lib/toast";            // ✅ add this
import { TooltipProvider } from "@/components/ui/tooltip";
import AmbientTooltips from "@/components/ambient-tooltips";
import { DashboardProvider } from "@/app/(dashboard)/dashboard-context";
import IdleSignOut from "@/components/idle-signout";

export default function Providers({ children, portal = false }: { children: React.ReactNode; portal?: boolean }) {
    // Customers of the portal never load the staff app's devices, alerts and so on.
    if (portal) {
        return (
            <ToastProvider>
                <TooltipProvider delayDuration={200}>{children}</TooltipProvider>
            </ToastProvider>
        );
    }
    return (
        <ToastProvider>                                      {/* ✅ now useToast() is safe */}
            <TooltipProvider delayDuration={200}>
                <DashboardProvider>
                    {children}
                    {/* Follows the session limits from Security Policies: signs out when idle, goes to sign-in when the server ended the session */}
                    <IdleSignOut />
                    {/* Global, zero-config tooltips for elements with data-tooltip="..." */}
                    <AmbientTooltips />
                </DashboardProvider>
            </TooltipProvider>
        </ToastProvider>
    );
}
