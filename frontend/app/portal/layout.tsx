import { headers } from "next/headers";
import type { Metadata } from "next";
import PortalShell from "./portal-shell";

export const metadata: Metadata = {
    title: "Customer portal",
    description: "Follow your support tickets, devices and invoices.",
    robots: { index: false, follow: false },
};

export default async function PortalLayout({ children }: { children: React.ReactNode }) {
    // "" when the portal has its own domain, "/portal" when it is reached on the main address.
    const base = (await headers()).get("x-adg-portal-base") ?? "/portal";
    return <PortalShell base={base}>{children}</PortalShell>;
}
