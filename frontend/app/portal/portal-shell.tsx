"use client";

// The portal's frame: the sign-in gate, the navigation and the footer. Pages inside get the signed-in person from usePortalMe().
import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { BookOpen, Building2, FileBarChart, LayoutDashboard, LifeBuoy, LogOut, Monitor, Receipt, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useBranding } from "@/app/providers/BrandingProvider";
import { portal, PortalError, type PortalMe } from "@/lib/portal-api";
import { cn } from "@/lib/utils";

type Ctx = { me: PortalMe; refresh: () => Promise<void> };
const MeContext = React.createContext<Ctx | null>(null);
const BaseContext = React.createContext("");

export const usePortalMe = () => {
    const c = React.useContext(MeContext);
    if (!c) throw new Error("usePortalMe is used outside the portal");
    return c;
};
/** Turns "/tickets" into the address that works where the portal is served ("/portal/tickets" on the main address). */
export const useHref = () => {
    const base = React.useContext(BaseContext);
    return React.useCallback((path: string) => `${base}${path === "/" && base ? "" : path}` || "/", [base]);
};

const PUBLIC_PAGES = ["/login", "/forgot", "/set-password", "/survey"];

function Brand({ title }: { title?: string }) {
    const { branding } = useBranding();
    const light = branding?.logoLightUrl;
    const dark = branding?.logoDarkUrl || light;
    return (
        <span className="flex items-center gap-2">
            {light ? (
                <>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={light} alt="" className="h-8 w-auto dark:hidden" />
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={dark ?? light} alt="" className="hidden h-8 w-auto dark:block" />
                </>
            ) : (
                <Building2 className="h-6 w-6 text-primary" aria-hidden />
            )}
            <span className="font-semibold">{title || "Customer portal"}</span>
        </span>
    );
}

export default function PortalShell({ base, children }: { base: string; children: React.ReactNode }) {
    const router = useRouter();
    const pathname = usePathname() || "/";
    const path = pathname.replace(/^\/portal(?=\/|$)/, "") || "/";
    const isPublic = PUBLIC_PAGES.some((p) => path === p || path.startsWith(`${p}/`));
    const href = React.useCallback((p: string) => `${base}${p === "/" && base ? "" : p}` || "/", [base]);

    const [me, setMe] = React.useState<PortalMe | null>(null);
    const [off, setOff] = React.useState<string | null>(null);

    const refresh = React.useCallback(async () => {
        try {
            setMe(await portal<PortalMe>("/auth/me"));
        } catch (e) {
            setMe(null);
            if (e instanceof PortalError && e.status === 401 && !isPublic) router.replace(href("/login"));
            else if (!(e instanceof PortalError && e.status === 401)) setOff("The portal could not be reached. Try again in a moment.");
        }
    }, [href, isPublic, router]);

    React.useEffect(() => {
        if (!isPublic) void refresh();
    }, [isPublic, refresh, path]);

    // New replies from support show on the Tickets tab without reloading.
    React.useEffect(() => {
        if (isPublic) return;
        const t = setInterval(() => {
            if (document.visibilityState === "visible") void refresh();
        }, 30_000);
        return () => clearInterval(t);
    }, [isPublic, refresh]);

    if (isPublic) {
        return (
            <BaseContext.Provider value={base}>
                <main className="flex min-h-screen items-center justify-center bg-muted/30 p-4">
                    <div className="w-full max-w-md space-y-6">
                        <div className="flex justify-center"><Brand /></div>
                        {children}
                    </div>
                </main>
            </BaseContext.Provider>
        );
    }

    if (!me) {
        return (
            <main className="flex min-h-screen items-center justify-center p-6 text-sm text-muted-foreground">
                {off ?? "Loading…"}
            </main>
        );
    }

    const nav = [
        { id: "dashboard", label: "Home", path: "/", icon: LayoutDashboard },
        { id: "tickets", label: "Tickets", path: "/tickets", icon: LifeBuoy },
        { id: "devices", label: "Devices", path: "/devices", icon: Monitor },
        { id: "invoices", label: "Invoices", path: "/invoices", icon: Receipt },
        { id: "reports", label: "Reports", path: "/reports", icon: FileBarChart },
        { id: "knowledge", label: "Help", path: "/knowledge", icon: BookOpen },
    ].filter((n) => me.modules.includes(n.id));

    const signOut = async () => {
        await portal("/auth/logout", { method: "POST" }).catch(() => null);
        setMe(null);
        router.replace(href("/login"));
    };

    return (
        <BaseContext.Provider value={base}>
            <MeContext.Provider value={{ me, refresh }}>
                <div className="flex min-h-screen flex-col bg-muted/30">
                    <header className="border-b bg-background">
                        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
                            <Link href={href("/")} className="shrink-0"><Brand title={me.welcomeTitle || undefined} /></Link>
                            <nav aria-label="Portal" className="flex flex-1 flex-wrap items-center gap-1">
                                {nav.map((n) => {
                                    const active = n.path === "/" ? path === "/" : path === n.path || path.startsWith(`${n.path}/`);
                                    return (
                                        <Link key={n.id} href={href(n.path)} aria-current={active ? "page" : undefined}
                                            className={cn("flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm hover:bg-accent", active && "bg-accent font-medium")}>
                                            <n.icon className="h-4 w-4" aria-hidden />
                                            {n.label}
                                            {n.id === "tickets" && me.unreadReplies > 0 ? (
                                                <span className="ml-1 rounded-full bg-primary px-1.5 text-xs font-medium text-primary-foreground" aria-label={`${me.unreadReplies} with new replies`}>{me.unreadReplies}</span>
                                            ) : null}
                                        </Link>
                                    );
                                })}
                            </nav>
                            <div className="flex items-center gap-1">
                                <Link href={href("/account")} className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm hover:bg-accent" title="Your account">
                                    <UserRound className="h-4 w-4" aria-hidden />
                                    <span className="hidden sm:inline">{me.name}</span>
                                </Link>
                                <Button variant="ghost" size="sm" onClick={signOut} className="gap-1.5">
                                    <LogOut className="h-4 w-4" aria-hidden />
                                    Sign out
                                </Button>
                            </div>
                        </div>
                    </header>
                    <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">{children}</main>
                    <footer className="border-t bg-background px-4 py-4 text-center text-xs text-muted-foreground">
                        {me.customer}
                        {me.supportEmail || me.supportPhone ? " · Need help? " : ""}
                        {me.supportEmail ? <a className="underline" href={`mailto:${me.supportEmail}`}>{me.supportEmail}</a> : null}
                        {me.supportEmail && me.supportPhone ? " · " : ""}
                        {me.supportPhone}
                    </footer>
                </div>
            </MeContext.Provider>
        </BaseContext.Provider>
    );
}
