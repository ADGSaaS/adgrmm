// app/(dashboard)/top-bar.tsx
"use client";

/**
 * Top Bar
 * ----------------------------------------------------------------
 * Brand, main navigation, search, and the account menu.
 * Saved views only appear where a view can be saved.
 * Administration only shows when the user has 'admin.access' (or is super admin).
 */

import React, { useEffect, useRef, useState } from "react";
import {
    Moon,
    Cloud,
    HardDrive,
    Globe,
    MessageSquare,
    Sun,
    Bell,
    Bookmark,
    PlusCircle,
    Trash2,
    Laptop,
    PlaySquare,
    ChevronDown,
    Check,
    Link as LinkIcon,
    LogOut,
    Save,
    Shield,
    Video,
    Menu,
    LayoutDashboard,
    ShieldCheck,
    Users2,
    Ticket,
    UserCircle,
    BarChart3,
    Receipt,
    Workflow,
    BookOpen,
    CalendarDays,
    ShieldAlert,
    Boxes,
    Radar,
    Network,
    type LucideIcon,
    Wrench,
} from "lucide-react";
import Link from "next/link";
import { useTheme } from "next-themes";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
    DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from "@/components/ui/dialog";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Label } from "@/components/ui/label";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import RunScriptModal from "@/components/run-script-modal";
import ToolsMenu from "@/components/tools/tools-menu";
import GlobalSearch from "@/components/global-search";
import AlertsBell from "@/components/alerts-bell";
import { EntitlementsUsage } from "@/components/entitlements-bar";
import { LayoutToggle, ThemeToggle } from "@/components/header-toggles";
import RunningTimerBadge from "@/components/running-timer-badge";
import { toast } from "@/components/ui/use-toast";
import { cn } from "@/lib/utils";
import { useDashboard, SavedView } from "@/app/(dashboard)/dashboard-context";
import { useBranding } from "@/app/providers/BrandingProvider";

const TOP_BAR_HEIGHT = 56;
const PLACEHOLDER_AVATAR = "/avatar-placeholder.png"; // ensure this exists in FE /public
const API_BASE = (process.env.NEXT_PUBLIC_API_BASE || "").replace(/\/+$/, "");

type NavLeaf = { href: string; label: string; icon: LucideIcon };
type NavGroup = { label: string; icon: LucideIcon; items: NavLeaf[] };
type NavEntry = NavLeaf | NavGroup;
const isGroup = (e: NavEntry): e is NavGroup => "items" in e;

/** The main navigation: a few pages on their own and the rest in category dropdowns. */
const NAV: NavEntry[] = [
    { href: "/", label: "Dashboard", icon: LayoutDashboard },
    { href: "/customers", label: "Customers", icon: Users2 },
    {
        label: "Devices", icon: Laptop, items: [
            { href: "/assets", label: "Assets", icon: Boxes },
            { href: "/network-discovery", label: "Network discovery", icon: Radar },
            { href: "/endpoint-backups", label: "Endpoint backups", icon: HardDrive },
            { href: "/snmp", label: "Network devices (SNMP)", icon: Network },
            { href: "/recordings", label: "Session recordings", icon: Video },
            { href: "/removal-requests", label: "Removal requests", icon: Trash2 },
        ],
    },
    {
        label: "Monitoring", icon: Bell, items: [
            { href: "/alerts", label: "Alerts", icon: Bell },
            { href: "/monitoring/web", label: "Domains and certificates", icon: Globe },
            { href: "/microsoft-365", label: "Microsoft 365", icon: Cloud },
            { href: "/edr", label: "EDR and antivirus", icon: ShieldCheck },
            { href: "/auto-repair", label: "Automatic repair", icon: Wrench },
            { href: "/security", label: "Security", icon: ShieldAlert },
        ],
    },
    {
        label: "Service desk", icon: Ticket, items: [
            { href: "/tickets", label: "Tickets", icon: Ticket },
            { href: "/chat", label: "Device chat", icon: MessageSquare },
            { href: "/service-desk-performance", label: "Performance", icon: BarChart3 },
            { href: "/calendar", label: "Calendar", icon: CalendarDays },
            { href: "/knowledge-base", label: "Knowledge base", icon: BookOpen },
        ],
    },
    {
        label: "Automation", icon: Workflow, items: [
            { href: "/automation", label: "Scripts and automation", icon: Workflow },
            { href: "/policies", label: "Policies", icon: ShieldCheck },
        ],
    },
    {
        label: "Business", icon: Receipt, items: [
            { href: "/billing", label: "Billing", icon: Receipt },
            { href: "/reports", label: "Reports", icon: BarChart3 },
        ],
    },
];

const isLinkActive = (pathname: string, href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

const navItemClass = (active: boolean) => cn(
    "relative flex h-full items-center gap-1 rounded-sm px-3 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
    active ? "text-foreground" : "text-muted-foreground hover:text-foreground"
);

/** One category of pages as a dropdown; it shows as the current one while any of its pages is open. */
function NavDropdown({ group, pathname, open, onOpenChange, onHover }: { group: NavGroup; pathname: string; open: boolean; onOpenChange: (o: boolean) => void; onHover: () => void }) {
    const active = group.items.some((i) => isLinkActive(pathname, i.href));
    return (
        <DropdownMenu modal={false} open={open} onOpenChange={onOpenChange}>
            <DropdownMenuTrigger className={navItemClass(active)} aria-label={`${group.label} menu`} onPointerEnter={onHover}>
                {group.label}
                <ChevronDown className="h-3.5 w-3.5 opacity-60" aria-hidden="true" />
                {active ? <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-primary" aria-hidden="true" /> : null}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-60">
                {group.items.map(({ href, label, icon: Icon }) => (
                    <DropdownMenuItem key={href} asChild className={isLinkActive(pathname, href) ? "bg-accent" : undefined}>
                        <Link href={href} aria-current={isLinkActive(pathname, href) ? "page" : undefined} className="flex items-center gap-2">
                            <Icon className="h-4 w-4 opacity-70" aria-hidden="true" />
                            {label}
                        </Link>
                    </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

/* ---------------- Branding logo ---------------- */
function AppLogo() {
    const { branding } = useBranding();
    const light = branding?.logoLightUrl ?? undefined;
    const dark = branding?.logoDarkUrl ?? undefined;
    return (
        <div className="flex items-center gap-2">
            <picture>
                {dark ? <source srcSet={dark} media="(prefers-color-scheme: dark)" /> : null}
                <img
                    src={light || dark || "/adg-saas-icon.png"}
                    alt="ADG RMM"
                    width={28}
                    height={28}
                    className="rounded-sm"
                />
            </picture>
            <span className="hidden font-semibold sm:inline">ADG RMM</span>
        </div>
    );
}

/* ---------------- Avatar helpers ---------------- */
function getInitials(name?: string, email?: string) {
    const fromName =
        (name || "")
            .split(" ")
            .map((s) => s.trim()[0])
            .filter(Boolean)
            .slice(0, 2)
            .join("")
            .toUpperCase();
    if (fromName) return fromName;
    const fromEmail = (email || "").trim()[0];
    return (fromEmail || "U").toUpperCase();
}

function normalizeAvatarUrl(raw?: string): string | undefined {
    if (!raw) return undefined;
    const url = raw.trim();
    if (!url) return undefined;
    if (/^(https?:)?\/\//i.test(url) || url.startsWith("data:")) return url; // absolute
    const base = (process.env.NEXT_PUBLIC_API_BASE || "").replace(/\/+$/, "");
    if (!base) return url; // same-origin fallback
    if (url.startsWith("/")) return `${base}${url}`;
    return `${base}/${url}`;
}

/* ---------------- Types from /api/users/me and /api/auth/me ---------------- */
type MeProfileResponse = {
    id: string;
    name?: string;
    email?: string;
    avatarUrl?: string;
    avatar_url?: string;
};

type AuthMe =
    | { user: null }
    | {
        user: {
            id: string;
            email?: string;
            name?: string;
            role?: string;
            isSuperAdmin?: boolean;
            // permission shapes we’ll tolerate:
            permissions?: string[] | Record<string, boolean>;
            permissionKeys?: string[];
        };
    };

/* ---------------- Permission helpers ---------------- */
function hasPermissionKey(user: AuthMe extends { user: infer U } ? U : never, key: string): boolean {
    if (!user) return false;
    if ((user as any).isSuperAdmin === true) return true;

    const perms = (user as any).permissions;
    if (Array.isArray(perms)) {
        if (perms.some((k) => String(k).toLowerCase() === key)) return true;
    } else if (perms && typeof perms === "object") {
        if (perms[key] === true) return true;
    }

    const keys = (user as any).permissionKeys;
    if (Array.isArray(keys)) {
        if (keys.some((k) => String(k).toLowerCase() === key)) return true;
    }

    return false;
}

/* ====================================================================== */

export default function TopBar() {
    const pathname = usePathname();
    // A saved view is what these two pages are showing, so elsewhere there is nothing to save.
    const hasViews = pathname === "/" || pathname.startsWith("/customers");

    const { theme, setTheme } = useTheme();
    const {
        savedViews,
        saveCurrentView,
        loadView,
        deleteView,
        overwriteViewFromCurrent,
        getEncodedCurrentView,
    } = useDashboard();

    const router = useRouter();
    const searchParams = useSearchParams();

    const [newViewName, setNewViewName] = useState("");
    const [isSaveDialogOpen, setSaveDialogOpen] = useState(false);
    const [nameError, setNameError] = useState<string | null>(null);
    const [viewToDelete, setViewToDelete] = useState<SavedView | null>(null);
    const [viewToOverwrite, setViewToOverwrite] = useState<SavedView | null>(null);

    const [isRunScriptOpen, setRunScriptOpen] = useState(false);
    const [preselectIds, setPreselectIds] = useState<string[] | undefined>(undefined);
    const [navOpen, setNavOpen] = useState(false);
    // Which dropdown of the bar is open. Like a menu bar: while one is open, moving over another title opens that one instead.
    const [openMenu, setOpenMenu] = useState<string | null>(null);
    const menuProps = (id: string) => ({
        open: openMenu === id,
        onOpenChange: (o: boolean) => setOpenMenu((cur) => (o ? id : cur === id ? null : cur)),
        onHover: () => setOpenMenu((cur) => (cur !== null && cur !== id ? id : cur)),
    });

    // ---------- CURRENT USER (avatar + initials + admin permission) ----------
    const [avatarUrl, setAvatarUrl] = useState<string | undefined>(undefined);
    const [avatarErrored, setAvatarErrored] = useState(false);
    const [initials, setInitials] = useState("U");
    const [userName, setUserName] = useState("");
    const [userEmail, setUserEmail] = useState("");
    const [canSeeAdmin, setCanSeeAdmin] = useState(false);
    const [canSeeRecordings, setCanSeeRecordings] = useState(false);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                // 1) Avatar/profile
                const resProfile = await fetch(`${API_BASE}/api/users/me`, { credentials: "include" });
                if (resProfile.ok) {
                    const data: MeProfileResponse = await resProfile.json();
                    if (!cancelled) {
                        const raw = (data as any)?.avatarUrl || (data as any)?.avatar_url || "";
                        const normalized = normalizeAvatarUrl(raw);
                        setAvatarUrl(normalized);
                        setInitials(getInitials(data?.name, data?.email));
                        setUserName(data?.name ?? "");
                        setUserEmail(data?.email ?? "");
                    }
                }
            } catch {
                /* keep initials-only fallback */
            }

            try {
                // 2) Auth/permissions
                const resAuth = await fetch(`${API_BASE}/api/auth/me`, { credentials: "include" });
                if (resAuth.ok) {
                    const auth: AuthMe = await resAuth.json();
                    if (!cancelled) {
                        const user = (auth as any)?.user || null;
                        const allowed = hasPermissionKey(user, "admin.access");
                        setCanSeeAdmin(allowed);
                        setCanSeeRecordings(hasPermissionKey(user, "recordings.read"));
                    }
                } else {
                    if (!cancelled) setCanSeeAdmin(false);
                }
            } catch {
                if (!cancelled) setCanSeeAdmin(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    const setQuery = (key: string, value?: string) => {
        const url = new URL(window.location.href);
        if (!value) url.searchParams.delete(key);
        else url.searchParams.set(key, value);
        router.replace(`${url.pathname}?${url.searchParams.toString()}`);
    };

    // modal open-from-URL guard
    const lastOpenedIdRef = useRef<string | null>(null);
    const openedFromUrlRef = useRef<boolean>(false);
    useEffect(() => {
        const runScriptId = searchParams.get("runScript");
        const deviceId = searchParams.get("device");
        const theId = runScriptId || deviceId;
        if (!theId || isRunScriptOpen || lastOpenedIdRef.current === theId) return;

        lastOpenedIdRef.current = theId;
        openedFromUrlRef.current = true;
        setPreselectIds([theId]);
        setRunScriptOpen(true);
    }, [searchParams, isRunScriptOpen]);

    const handleRunScriptOpenChange = (open: boolean) => {
        setRunScriptOpen(open);
        if (!open) {
            setPreselectIds(undefined);
            if (openedFromUrlRef.current) {
                openedFromUrlRef.current = false;
                router.back();
            } else {
                setQuery("runScript");
                setQuery("device");
            }
            window.setTimeout(() => {
                lastOpenedIdRef.current = null;
            }, 0);
        }
    };

    const openRunScript = () => {
        setNavOpen(false);
        setPreselectIds(undefined);
        setRunScriptOpen(true);
        const url = new URL(window.location.href);
        url.searchParams.delete("runScript");
        url.searchParams.delete("device");
        history.replaceState(null, "", url.toString());
        openedFromUrlRef.current = false;
        lastOpenedIdRef.current = null;
    };

    // Saved views actions
    const handleSaveView = () => {
        const trimmed = newViewName.trim();
        if (!trimmed) return setNameError("Please enter a name.");
        if (savedViews.some((v) => v.name.toLowerCase() === trimmed.toLowerCase())) {
            return setNameError("A view with this name already exists.");
        }
        saveCurrentView(trimmed);
        toast({ title: "View saved", description: `"${trimmed}" was saved.`, variant: "success" });
        setNewViewName("");
        setNameError(null);
        setSaveDialogOpen(false);
    };
    const confirmDelete = () => {
        if (!viewToDelete) return;
        deleteView(viewToDelete.id);
        toast({ title: "View deleted", description: `"${viewToDelete.name}" was removed.` });
        setViewToDelete(null);
    };
    const confirmOverwrite = () => {
        if (!viewToOverwrite) return;
        overwriteViewFromCurrent(viewToOverwrite.id);
        toast({ title: "View updated", description: `"${viewToOverwrite.name}" now matches this page.`, variant: "success" });
        setViewToOverwrite(null);
    };

    const handleCopyViewLink = async () => {
        try {
            const encoded = getEncodedCurrentView({ includeLayouts: true });
            const url = new URL(window.location.href);
            if (encoded) url.searchParams.set("v", encoded);
            else url.searchParams.delete("v");
            const href = url.toString();
            await navigator.clipboard.writeText(href);
            toast({ title: "Link copied", description: "Anyone with access can open this view.", variant: "success" });
        } catch {
            toast({ title: "Could not copy the link", description: "Your browser blocked clipboard access.", variant: "destructive" });
        }
    };

    const applyView = (view: SavedView) => {
        if (loadView(view.id)) {
            toast({ title: "View applied", description: `"${view.name}" is showing.`, variant: "success" });
        }
    };

    const handleLogout = async () => {
        try {
            await fetch(`${API_BASE}/api/auth/logout`, {
                method: "POST",
                credentials: "include",
            });
        } catch {
            // ignore
        }
        router.replace("/login?next=/");
    };

    return (
        <>
            <header
                className="fixed inset-x-0 top-0 z-50 flex items-center gap-2 border-b border-border/60 bg-background/70 px-2 backdrop-blur-xl supports-[backdrop-filter]:bg-background/60 sm:px-4"
                style={{ height: TOP_BAR_HEIGHT }}
            >
                <Button
                    variant="ghost"
                    size="icon"
                    className="shrink-0 lg:hidden"
                    aria-label="Open navigation menu"
                    title="Menu"
                    onClick={() => setNavOpen(true)}
                >
                    <Menu className="h-5 w-5" aria-hidden="true" />
                </Button>

                <Link href="/" className="flex shrink-0 items-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label="ADG RMM home">
                    <AppLogo />
                </Link>

                {/* Main navigation */}
                <nav aria-label="Main" className="ml-3 hidden h-full shrink-0 items-stretch gap-1 whitespace-nowrap lg:flex">
                    {NAV.map((entry) => {
                        if (isGroup(entry)) return <NavDropdown key={entry.label} group={entry} pathname={pathname} {...menuProps(entry.label)} />;
                        const active = isLinkActive(pathname, entry.href);
                        return (
                            <Link
                                key={entry.href}
                                href={entry.href}
                                aria-current={active ? "page" : undefined}
                                className={navItemClass(active)}
                            >
                                {entry.label}
                                {active ? <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-primary" aria-hidden="true" /> : null}
                            </Link>
                        );
                    })}
                    <ToolsMenu {...(() => { const m = menuProps("tools"); return { menuOpen: m.open, onMenuOpenChange: m.onOpenChange, onTriggerHover: m.onHover }; })()} />
                </nav>

                {/* Search sits right after the navigation and takes the space that is left */}
                <div className="flex min-w-0 flex-1 justify-end md:justify-start md:px-4">
                    <GlobalSearch />
                </div>

                <div className="flex shrink-0 items-center gap-1">
                    {hasViews ? (
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button variant="ghost" size="sm" className="hidden gap-1.5 text-muted-foreground hover:text-foreground lg:inline-flex" title="Saved views">
                                    <Bookmark className="h-4 w-4" aria-hidden="true" />
                                    Views
                                    <ChevronDown className="h-3.5 w-3.5 opacity-60" aria-hidden="true" />
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-72">
                                <DropdownMenuItem
                                    onSelect={(e) => {
                                        e.preventDefault();
                                        setSaveDialogOpen(true);
                                    }}
                                >
                                    <PlusCircle className="mr-2 h-4 w-4" aria-hidden="true" />
                                    Save this view
                                </DropdownMenuItem>
                                <DropdownMenuItem onSelect={() => void handleCopyViewLink()}>
                                    <LinkIcon className="mr-2 h-4 w-4" aria-hidden="true" />
                                    Copy link to this view
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                {savedViews.length === 0 ? (
                                    <div className="px-2 py-3 text-center text-xs text-muted-foreground">No saved views yet</div>
                                ) : null}
                                {savedViews.map((view) => (
                                    <DropdownMenuItem key={view.id} onSelect={() => applyView(view)} className="group flex items-center gap-2 py-1.5">
                                        <Bookmark className="h-4 w-4 shrink-0 opacity-60" aria-hidden="true" />
                                        <span className="min-w-0 flex-1 truncate">{view.name}</span>
                                        <button
                                            type="button"
                                            title={`Update "${view.name}" to match this page`}
                                            aria-label={`Update ${view.name}`}
                                            className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-foreground"
                                            onClick={(e) => {
                                                e.preventDefault();
                                                e.stopPropagation();
                                                setViewToOverwrite(view);
                                            }}
                                        >
                                            <Save className="h-3.5 w-3.5" aria-hidden="true" />
                                        </button>
                                        <button
                                            type="button"
                                            title={`Delete "${view.name}"`}
                                            aria-label={`Delete ${view.name}`}
                                            className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-destructive"
                                            onClick={(e) => {
                                                e.preventDefault();
                                                e.stopPropagation();
                                                setViewToDelete(view);
                                            }}
                                        >
                                            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                                        </button>
                                    </DropdownMenuItem>
                                ))}
                            </DropdownMenuContent>
                        </DropdownMenu>
                    ) : null}

                    <EntitlementsUsage />
                    <RunningTimerBadge />
                    <LayoutToggle />
                    <ThemeToggle />
                    <AlertsBell />

                    {canSeeRecordings ? (
                        <Button
                            asChild
                            variant="ghost"
                            size="icon"
                            className={cn("hidden lg:inline-flex", pathname.startsWith("/recordings") ? "text-foreground" : "text-muted-foreground")}
                            title="Session recordings"
                            aria-label="Session recordings"
                        >
                            <Link href="/recordings">
                                <Video className="h-5 w-5" aria-hidden="true" />
                            </Link>
                        </Button>
                    ) : null}

                    {canSeeAdmin ? (
                        <Button
                            asChild
                            variant="ghost"
                            size="icon"
                            className={cn("hidden lg:inline-flex", pathname.startsWith("/administration") ? "text-foreground" : "text-muted-foreground")}
                            title="Administration"
                            aria-label="Administration"
                        >
                            <Link href="/administration">
                                <Shield className="h-5 w-5" aria-hidden="true" />
                            </Link>
                        </Button>
                    ) : null}

                    {/* Account */}
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <button
                                type="button"
                                title="Account"
                                aria-label="Account"
                                className="ml-1 h-8 w-8 shrink-0 overflow-hidden rounded-full outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                            >
                                <Avatar className="h-8 w-8">
                                    <AvatarImage
                                        src={avatarErrored ? PLACEHOLDER_AVATAR : avatarUrl || PLACEHOLDER_AVATAR}
                                        alt=""
                                        className="h-full w-full object-cover"
                                        onError={() => setAvatarErrored(true)}
                                        referrerPolicy="no-referrer"
                                    />
                                    <AvatarFallback className="text-xs">{initials}</AvatarFallback>
                                </Avatar>
                            </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-60">
                            {userName || userEmail ? (
                                <>
                                    <div className="px-2 py-1.5">
                                        {userName ? <div className="truncate text-sm font-medium">{userName}</div> : null}
                                        {userEmail ? <div className="truncate text-xs text-muted-foreground">{userEmail}</div> : null}
                                    </div>
                                    <DropdownMenuSeparator />
                                </>
                            ) : null}
                            <DropdownMenuItem asChild>
                                <Link href="/account">
                                    <UserCircle className="mr-2 h-4 w-4" aria-hidden="true" />
                                    Account
                                </Link>
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => router.push("/account#security")}>
                                <Shield className="mr-2 h-4 w-4" aria-hidden="true" />
                                Security
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onSelect={() => void handleLogout()}>
                                <LogOut className="mr-2 h-4 w-4" aria-hidden="true" />
                                Sign out
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
            </header>

            {/* Save view */}
            <Dialog open={isSaveDialogOpen} onOpenChange={setSaveDialogOpen}>
                <DialogContent>
                    <form
                        onSubmit={(e) => {
                            e.preventDefault();
                            handleSaveView();
                        }}
                    >
                        <DialogHeader>
                            <DialogTitle>Save this view</DialogTitle>
                            <DialogDescription>Keeps the columns, customers and filters showing now.</DialogDescription>
                        </DialogHeader>

                        <div className="grid gap-2 py-4">
                            <Label htmlFor="sv-name">Name</Label>
                            <Input
                                id="sv-name"
                                value={newViewName}
                                onChange={(e) => {
                                    setNewViewName(e.target.value);
                                    setNameError(null);
                                }}
                                placeholder="e.g., Offline Windows servers"
                                autoFocus
                            />
                            {nameError ? <p className="text-xs text-destructive">{nameError}</p> : null}
                        </div>

                        <DialogFooter>
                            <Button type="button" variant="outline" onClick={() => setSaveDialogOpen(false)}>
                                Cancel
                            </Button>
                            <Button type="submit">Save</Button>
                        </DialogFooter>
                    </form>
                </DialogContent>
            </Dialog>

            {/* Navigation drawer, below lg */}
            <Sheet open={navOpen} onOpenChange={setNavOpen}>
                <SheetContent side="left" className="flex w-[85vw] max-w-xs flex-col gap-0 overflow-y-auto p-0 sm:w-80">
                    <SheetHeader className="border-b p-4 text-left">
                        <SheetTitle>ADG RMM</SheetTitle>
                        <SheetDescription className="sr-only">Navigation and tools</SheetDescription>
                    </SheetHeader>
                    <nav aria-label="Main" className="grid gap-1 p-2">
                        {[
                            ...NAV.map((entry) => (isGroup(entry)
                                ? { heading: entry.label, links: entry.items }
                                : { heading: null as string | null, links: [entry] })),
                            {
                                heading: null as string | null,
                                links: [
                                    ...(canSeeAdmin ? [{ href: "/administration", label: "Administration", icon: Shield }] : []),
                                    { href: "/account", label: "Account", icon: UserCircle },
                                ],
                            },
                        ].map((section, si) => (
                            <div key={section.heading ?? `s${si}`} className="grid gap-1">
                                {section.heading ? <div className="px-3 pb-0 pt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{section.heading}</div> : null}
                                {section.links.map(({ href, label, icon: Icon }) => {
                                    const active = href === "/administration" || href === "/account" ? pathname.startsWith(href) : isLinkActive(pathname, href);
                                    return (
                                        <Link
                                            key={href}
                                            href={href}
                                            onClick={() => setNavOpen(false)}
                                            aria-current={active ? "page" : undefined}
                                            className={`flex min-h-11 items-center gap-3 rounded-md px-3 text-sm font-medium hover:bg-accent ${active ? "bg-accent text-accent-foreground" : ""}`}
                                        >
                                            <Icon className="h-4 w-4" aria-hidden="true" />
                                            {label}
                                        </Link>
                                    );
                                })}
                            </div>
                        ))}
                    </nav>
                    <div className="border-t p-2">
                        <ToolsMenu mobile onPicked={() => setNavOpen(false)} />
                    </div>
                    <div className="grid gap-1 border-t p-2">
                        <div className="px-3 pb-1 pt-2 text-xs font-medium text-muted-foreground">Tools</div>
                        <button type="button" onClick={openRunScript} className="flex min-h-11 items-center gap-3 rounded-md px-3 text-left text-sm hover:bg-accent">
                            <PlaySquare className="h-4 w-4" aria-hidden="true" />
                            Run Script
                        </button>
                        <button
                            type="button"
                            onClick={() => {
                                setNavOpen(false);
                                void handleCopyViewLink();
                            }}
                            className="flex min-h-11 items-center gap-3 rounded-md px-3 text-left text-sm hover:bg-accent"
                        >
                            <LinkIcon className="h-4 w-4" aria-hidden="true" />
                            Copy View Link
                        </button>
                        <button
                            type="button"
                            onClick={() => {
                                setNavOpen(false);
                                setSaveDialogOpen(true);
                            }}
                            className="flex min-h-11 items-center gap-3 rounded-md px-3 text-left text-sm hover:bg-accent"
                        >
                            <PlusCircle className="h-4 w-4" aria-hidden="true" />
                            Save Current View
                        </button>
                    </div>
                    {savedViews.length > 0 && (
                        <div className="grid gap-1 border-t p-2">
                            <div className="px-3 pb-1 pt-2 text-xs font-medium text-muted-foreground">Saved views</div>
                            {savedViews.map((view) => (
                                <div key={view.id} className="flex items-center gap-1">
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setNavOpen(false);
                                            applyView(view);
                                        }}
                                        className="flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-md px-3 text-left text-sm hover:bg-accent"
                                    >
                                        <Bookmark className="h-4 w-4 shrink-0" aria-hidden="true" />
                                        <span className="truncate">{view.name}</span>
                                    </button>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        className="shrink-0"
                                        aria-label={`Delete ${view.name}`}
                                        title="Delete"
                                        onClick={() => {
                                            setNavOpen(false);
                                            setViewToDelete(view);
                                        }}
                                    >
                                        <Trash2 className="h-4 w-4" />
                                    </Button>
                                </div>
                            ))}
                        </div>
                    )}
                </SheetContent>
            </Sheet>

            {/* Overwrite confirm */}
            <AlertDialog open={!!viewToOverwrite} onOpenChange={(o) => !o && setViewToOverwrite(null)}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Overwrite saved view?</AlertDialogTitle>
                        <AlertDialogDescription>
                            Replace settings of <b>{viewToOverwrite?.name}</b> with your current configuration.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                            className="bg-amber-500 text-white hover:bg-amber-500/90 dark:bg-amber-600 dark:hover:bg-amber-600/90"
                            onClick={confirmOverwrite}
                        >
                            Overwrite
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>

            {/* Delete confirm */}
            <AlertDialog open={!!viewToDelete} onOpenChange={(o) => !o && setViewToDelete(null)}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Delete saved view?</AlertDialogTitle>
                        <AlertDialogDescription>
                            This will permanently delete <b>{viewToDelete?.name}</b>.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                            onClick={confirmDelete}
                        >
                            Delete
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>

            {/* Run Script modal */}
            <RunScriptModal
                open={isRunScriptOpen}
                onOpenChange={handleRunScriptOpenChange}
                preselectDeviceIds={preselectIds}
            />

        </>
    );
}
