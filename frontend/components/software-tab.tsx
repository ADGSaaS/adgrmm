// remoteiq-frontend/components/software-tab.tsx
"use client";

import * as React from "react";
import { useParams } from "next/navigation";
import {
    ColumnDef,
    SortingState,
    ColumnFiltersState,
    VisibilityState,
} from "@tanstack/react-table";
import { MoreHorizontal, Trash2, Search, Plus } from "lucide-react";

import { DataTable } from "@/components/data-table";
import { SortHeader } from "@/components/sort-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SearchField, SegmentedTabs } from "@/components/list-controls";
import { errorText } from "@/components/policies/shared";
import { SoftwareInstallLog } from "@/components/software-install-log";
import { OutdatedAppsPanel } from "@/components/outdated-apps-panel";
import { hasPerm } from "@/lib/permissions";
import { useMe } from "@/lib/use-me";
import {
    DropdownMenu,
    DropdownMenuTrigger,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
    AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/lib/toast";
import { deviceFamily } from "@/lib/device-os";
import { waitForJob } from "@/lib/device-files-api";

import {
    fetchDeviceSoftware,
    jfetch,
    requestUninstallSoftware,
    type DeviceSoftware,
} from "@/lib/api";

/** Same call shape used across the app (title/desc/kind) */
type ToastFn = (t: {
    title?: string;
    desc?: string;
    kind?: "default" | "destructive" | "success" | "warning";
}) => void;

type Props = { push?: ToastFn; os?: string | null };

type LibraryItem = { id: string; name: string; category: string; matchText: string; chocolateyId: string | null; wingetId?: string | null; installerUrl?: string | null; installerSha256?: string | null; installable: boolean };
type DeviceUser = { account: string; loggedIn: boolean };

/** Whether an entry can be installed for one user: that runs in their own session, through winget or the entry's direct installer (Chocolatey needs elevation). */
const forOneUser = (e: LibraryItem) => !!e.wingetId || (!!e.installerUrl && !!e.installerSha256);

/** The library entry with a winget id whose match text is in the program's name; used to remove a per-user program from inside that user's session. */
function libraryMatchWinget(name: string, library: LibraryItem[]): LibraryItem | null {
    const n = name.toLowerCase();
    let best: LibraryItem | null = null;
    for (const e of library) {
        if (!e.wingetId || !e.matchText.trim() || !n.includes(e.matchText.trim().toLowerCase())) continue;
        if (!best || e.matchText.length > best.matchText.length) best = e;
    }
    return best;
}

/** The library entry with a Chocolatey id whose match text is in the program's name; the longest match text wins. */
function libraryMatch(name: string, library: LibraryItem[]): LibraryItem | null {
    const n = name.toLowerCase();
    let best: LibraryItem | null = null;
    for (const e of library) {
        if (!e.chocolateyId || !e.matchText.trim() || !n.includes(e.matchText.trim().toLowerCase())) continue;
        if (!best || e.matchText.length > best.matchText.length) best = e;
    }
    return best;
}

// Matches the time limit the backend gives an uninstall job.
const UNINSTALL_TIMEOUT_MS = 30 * 60_000;

export default function SoftwareTab({ push, os }: Props) {
    const isLinux = deviceFamily(os) === "linux";
    const { permissions } = useMe();
    const canInstall = hasPerm(permissions, "software.install");
    const [scopeFilter, setScopeFilter] = React.useState<"all" | "machine" | "user">("all");
    const [library, setLibrary] = React.useState<LibraryItem[]>([]);
    const [installOpen, setInstallOpen] = React.useState(false);
    const [libQ, setLibQ] = React.useState("");
    const [libPick, setLibPick] = React.useState<LibraryItem | null>(null);
    const [installing, setInstalling] = React.useState(false);
    const [installError, setInstallError] = React.useState<string | null>(null);
    const [libUninstall, setLibUninstall] = React.useState<{ item: DeviceSoftware; entry: LibraryItem; runAs?: string } | null>(null);

    // Back-compat: if parent didn't pass `push` yet, fall back to hook
    const hook = useToast();
    const doPush: ToastFn = push ?? hook.push;

    const params = useParams<{ deviceId: string }>();
    const deviceId = params?.deviceId;

    const [data, setData] = React.useState<DeviceSoftware[]>([]);
    const [loading, setLoading] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);

    const [sorting, setSorting] = React.useState<SortingState>([]);
    const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>([]);
    const [columnVisibility, setColumnVisibility] = React.useState<VisibilityState>({});

    React.useEffect(() => {
        let alive = true;
        (async () => {
            if (!deviceId) return;
            setLoading(true);
            setError(null);
            try {
                const { items } = await fetchDeviceSoftware(deviceId);
                if (!alive) return;
                setData(items);
            } catch (e: any) {
                if (!alive) return;
                setError(e?.message ?? "Failed to load software list");
                doPush({
                    title: "Failed to load software",
                    desc: e?.message ?? "Request failed",
                    kind: "destructive",
                });
            } finally {
                if (alive) setLoading(false);
            }
        })();
        return () => {
            alive = false;
        };
    }, [deviceId, doPush]);

    React.useEffect(() => {
        if (!canInstall) return;
        jfetch<{ items: LibraryItem[] }>("/api/software-library").then((r) => setLibrary(r.items)).catch(() => setLibrary([]));
    }, [canInstall]);

    // Bumped when an install is queued so the log below looks again at once.
    const [logTick, setLogTick] = React.useState(0);
    // Who the install is for: empty means everyone on the PC. The accounts come from the device's last inventory report.
    const [installFor, setInstallFor] = React.useState("");
    // Install adds something from the library; Remove takes a Chocolatey-installed program off, even one the list cannot see.
    const [dialogMode, setDialogMode] = React.useState<"install" | "uninstall">("install");
    const [deviceUsers, setDeviceUsers] = React.useState<DeviceUser[]>([]);

    React.useEffect(() => {
        if (!installOpen || !deviceId) return;
        setInstallFor("");
        setDialogMode("install");
        jfetch<{ items: DeviceUser[] }>(`/api/devices/${encodeURIComponent(deviceId)}/software/users`).then((r) => setDeviceUsers(r.items)).catch(() => setDeviceUsers([]));
    }, [installOpen, deviceId]);

    const rows = React.useMemo(() => data.filter((d) => scopeFilter === "all" || (scopeFilter === "user" ? d.scope === "user" : d.scope !== "user")), [data, scopeFilter]);
    const userCount = React.useMemo(() => data.filter((d) => d.scope === "user").length, [data]);

    /** Install or uninstall a library entry on this device through the agent. The server says in words why it cannot. */
    const runLibrary = async (entry: LibraryItem, action: "install" | "uninstall", runAs?: string): Promise<boolean> => {
        if (!deviceId) return false;
        try {
            await jfetch(`/api/devices/${encodeURIComponent(deviceId)}/software/install`, { method: "POST", body: { libraryId: entry.id, action, ...(runAs ? { runAs } : {}), ...(action === "uninstall" && !runAs ? { force: true } : {}) } });
            doPush({
                title: `${action === "install" ? "Install" : "Uninstall"} queued`,
                desc: `${entry.name} will be ${action === "install" ? "installed" : "removed"} ${runAs ? `for ${runAs} ` : ""}on this device shortly. The list updates after its next inventory report.`,
                kind: "success",
            });
            setLogTick((n) => n + 1);
            return true;
        } catch (e) {
            const text = errorText(e);
            setInstallError(text);
            doPush({ title: `Could not ${action} ${entry.name}`, desc: text, kind: "destructive" });
            return false;
        }
    };

    const doSearchWeb = (name: string, version?: string | null) => {
        const q = encodeURIComponent([name, version].filter(Boolean).join(" "));
        window.open(
            `https://www.google.com/search?q=${q}`,
            "_blank",
            "noopener,noreferrer"
        );
    };

    // Linux: install one package by name from the device's own repositories (the software library is Windows only).
    const [pkgOpen, setPkgOpen] = React.useState(false);
    const [pkgName, setPkgName] = React.useState("");
    const [pkgBusy, setPkgBusy] = React.useState(false);
    const [pkgError, setPkgError] = React.useState<string | null>(null);
    const installPackage = async () => {
        if (!deviceId) return;
        const name = pkgName.trim();
        setPkgBusy(true);
        setPkgError(null);
        try {
            const r = await jfetch<{ jobId?: string }>(`/api/devices/${encodeURIComponent(deviceId)}/actions/install-package`, { method: "POST", body: { name } });
            setPkgOpen(false);
            setPkgName("");
            doPush({ title: "Install requested", desc: `Installing ${name}. You will be told when it finishes.`, kind: "success" });
            if (!r.jobId) return;
            const job = await waitForJob(r.jobId, { timeoutMs: UNINSTALL_TIMEOUT_MS, pollMs: 5000 });
            if (String(job.status).toLowerCase() === "succeeded") {
                doPush({ title: "Install finished", desc: `${name} is installed. It shows in this list after the device's next inventory report.`, kind: "success" });
            } else {
                doPush({ title: `Could not install ${name}`, desc: String(job.stderr || job.stdout || "The package manager reported a failure.").slice(0, 400), kind: "destructive" });
            }
        } catch (e: any) {
            setPkgError(e?.message ?? "The request failed.");
        } finally {
            setPkgBusy(false);
        }
    };

    const doUninstall = async (item: DeviceSoftware) => {
        if (!deviceId) return;
        try {
            const { jobId } = await requestUninstallSoftware(deviceId, {
                name: item.name,
                version: item.version || undefined,
            });
            doPush({
                title: "Uninstall requested",
                desc: `Removing ${item.name}. You will be told when it finishes.`,
                kind: "success",
            });

            if (!jobId) return;
            const job = await waitForJob(jobId, { timeoutMs: UNINSTALL_TIMEOUT_MS, pollMs: 5000 });
            if (String(job.status).toLowerCase() === "succeeded") {
                doPush({
                    title: "Uninstall finished",
                    desc: `${item.name} was removed. It leaves this list after the device's next inventory report.`,
                    kind: "success",
                });
            } else {
                doPush({
                    title: `Could not uninstall ${item.name}`,
                    desc: String(job.stderr || job.stdout || "The uninstaller reported a failure."),
                    kind: "destructive",
                });
            }
        } catch (e: any) {
            doPush({
                title: "Uninstall failed",
                desc: e?.message ?? "This device is offline. Ensure the agent is running and connected, then try again.",
                kind: "destructive",
            });
        }
    };

    const columns: ColumnDef<DeviceSoftware>[] = [
        {
            accessorKey: "name",
            header: ({ column }) => <SortHeader column={column} label="Name" />,
        },
        { accessorKey: "version", header: ({ column }) => <SortHeader column={column} label="Version" /> },
        { accessorKey: "publisher", header: ({ column }) => <SortHeader column={column} label="Publisher" /> },
        {
            accessorKey: "installDate",
            header: ({ column }) => (
                <span title="The date the program reports. Programs that update themselves, such as Microsoft Edge, report the date of their latest update.">
                    <SortHeader column={column} label="Installed or updated" />
                </span>
            ),
            // A calendar day, not a moment: shown as that day whatever this browser's time zone is.
            cell: ({ row }) => {
                const v = row.original.installDate;
                if (!v) return <span className="text-muted-foreground">Unknown</span>;
                const d = new Date(v);
                return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
            },
        },
        {
            id: "scope",
            accessorFn: (r) => (r.scope === "user" ? "User" : "System"),
            header: ({ column }) => <SortHeader column={column} label="Scope" />,
            cell: ({ row }) => {
                const r = row.original;
                return r.scope === "user"
                    ? <div><span>User</span>{r.user && <div className="text-xs text-muted-foreground">{r.user}</div>}</div>
                    : <span>System</span>;
            },
        },
        {
            id: "installedBy",
            accessorFn: (r) => r.installedBy ?? "",
            header: ({ column }) => <SortHeader column={column} label="Installed by" />,
            cell: ({ row }) => row.original.installedBy ?? <span className="text-muted-foreground">Unknown</span>,
        },
        {
            id: "actions",
            header: () => <span className="sr-only">Actions</span>,
            cell: ({ row }) => {
                const item = row.original;
                const userRow = item.scope === "user" && !!item.user;
                const match = canInstall && !isLinux && !userRow ? libraryMatch(item.name, library) : null;
                const userMatch = canInstall && !isLinux && userRow ? libraryMatchWinget(item.name, library) : null;
                return (
                    <AlertDialog>
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button variant="ghost" className="h-8 w-8 p-0" aria-label="Open menu">
                                    <MoreHorizontal className="h-4 w-4" />
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                                <DropdownMenuLabel>Actions</DropdownMenuLabel>
                                <DropdownMenuItem
                                    onClick={async () => {
                                        await navigator.clipboard.writeText(item.name);
                                        doPush({ title: "Copied", desc: "Name copied to clipboard." });
                                    }}
                                >
                                    Copy name
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                    onClick={async () => {
                                        await navigator.clipboard.writeText(item.version || "");
                                        doPush({
                                            title: "Copied",
                                            desc: "Version copied to clipboard.",
                                        });
                                    }}
                                >
                                    Copy version
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem onClick={() => doSearchWeb(item.name, item.version)}>
                                    <Search className="mr-2 h-4 w-4" />
                                    Search web
                                </DropdownMenuItem>
                                {match && (
                                    <>
                                        <DropdownMenuSeparator />
                                        <DropdownMenuItem onSelect={() => setLibUninstall({ item, entry: match })}>
                                            <Trash2 className="mr-2 h-4 w-4" />
                                            Uninstall with Chocolatey…
                                        </DropdownMenuItem>
                                    </>
                                )}
                                {userMatch && item.user && (
                                    <>
                                        <DropdownMenuSeparator />
                                        <DropdownMenuItem onSelect={() => setLibUninstall({ item, entry: userMatch, runAs: item.user ?? undefined })}>
                                            <Trash2 className="mr-2 h-4 w-4" />
                                            Uninstall for {item.user} with winget…
                                        </DropdownMenuItem>
                                    </>
                                )}
                                {(
                                    <>
                                        <DropdownMenuSeparator />
                                        <AlertDialogTrigger asChild>
                                            <DropdownMenuItem className="text-destructive focus:text-destructive">
                                                <Trash2 className="mr-2 h-4 w-4" />
                                                Uninstall…
                                            </DropdownMenuItem>
                                        </AlertDialogTrigger>
                                    </>
                                )}
                            </DropdownMenuContent>
                        </DropdownMenu>

                        {/* Confirm dialog */}
                        <AlertDialogContent>
                            <AlertDialogHeader>
                                <AlertDialogTitle>Uninstall “{item.name}”?</AlertDialogTitle>
                                <AlertDialogDescription>
                                    {isLinux
                                        ? "This removes the package with the device's package manager (apt, dnf, yum or zypper) in the background. It is refused, and nothing is removed, if other packages need it or if it is something the device needs to keep running or stay reachable. Settings files stay."
                                        : "This runs the program's uninstaller in the background on the device. An uninstaller that needs someone to click through it cannot be answered, and fails after 30 minutes. Some programs also need a reboot."}
                                </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                                <AlertDialogCancel>Cancel</AlertDialogCancel>
                                <AlertDialogAction onClick={() => doUninstall(item)}>
                                    Uninstall
                                </AlertDialogAction>
                            </AlertDialogFooter>
                        </AlertDialogContent>
                    </AlertDialog>
                );
            },
        },
    ];

    return (
        <Card>
            <CardContent className="pt-6">
                {loading && (
                    <div className="text-sm text-muted-foreground mb-3">Loading…</div>
                )}
                {error && <div className="mb-3 text-sm text-destructive">{error}</div>}
                {isLinux && (
                    <div className="text-sm text-muted-foreground mb-3">
                        This list comes from the device&apos;s package manager, so names are package names. Install a package by
                        name with Install software; remove one from its row menu. Updates for installed packages are on the Patch tab.
                    </div>
                )}
                {deviceId && (isLinux
                    ? <p className="mb-4 rounded-md border p-3 text-sm text-muted-foreground">Updating programs from here is for Windows devices. A Linux device&apos;s package updates are on the Patch tab.</p>
                    : <OutdatedAppsPanel deviceId={deviceId} canInstall={canInstall} onQueued={() => setLogTick((t) => t + 1)} />)}
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <SegmentedTabs
                        label="Show software installed"
                        items={[{ key: "all", label: "All", count: data.length }, { key: "machine", label: "System", count: data.length - userCount }, { key: "user", label: "User", count: userCount }]}
                        value={scopeFilter}
                        onChange={(k) => setScopeFilter(k as "all" | "machine" | "user")}
                    />
                    <Button
                        variant="success"
                        disabled={!canInstall}
                        title={!canInstall ? "You need the right to install software (Roles, Software: Install and remove software on devices)." : isLinux ? "Install a package from the device's own repositories, by name" : "Install a program from the software library on this device"}
                        onClick={() => { if (isLinux) { setPkgError(null); setPkgOpen(true); return; } setLibQ(""); setLibPick(null); setInstallError(null); setInstallOpen(true); }}
                    >
                        <Plus className="mr-1 h-4 w-4" aria-hidden /> Install software
                    </Button>
                </div>
                <DataTable
                    columns={columns}
                    data={rows}
                    sorting={sorting}
                    setSorting={setSorting}
                    columnFilters={columnFilters}
                    setColumnFilters={setColumnFilters}
                    columnVisibility={columnVisibility}
                    setColumnVisibility={setColumnVisibility}
                    filterColumn="name"
                    filterInputPlaceholder="Filter by name..."
                />
                {deviceId && (
                    <div className="mt-6">
                        <SoftwareInstallLog deviceId={deviceId} refreshKey={logTick} title="Install log" />
                    </div>
                )}
            </CardContent>

            <Dialog open={pkgOpen} onOpenChange={(o) => !pkgBusy && setPkgOpen(o)}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>Install a package</DialogTitle>
                        <DialogDescription>Installs one package from this device&apos;s own repositories with its package manager. Type the package name, for example htop or clamav. The device must be online.</DialogDescription>
                    </DialogHeader>
                    <div className="grid gap-1">
                        <label htmlFor="pkg-name" className="text-sm font-medium">Package name</label>
                        <input id="pkg-name" className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={pkgName} maxLength={100} autoComplete="off" spellCheck={false}
                            onChange={(e) => { setPkgName(e.target.value); setPkgError(null); }}
                            onKeyDown={(e) => { if (e.key === "Enter" && pkgName.trim() && !pkgBusy) void installPackage(); }} />
                        {pkgError ? <p role="alert" className="text-sm text-destructive">{pkgError}</p> : null}
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setPkgOpen(false)} disabled={pkgBusy}>Cancel</Button>
                        <Button onClick={() => void installPackage()} disabled={pkgBusy || !pkgName.trim()}>{pkgBusy ? "Working…" : "Install"}</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog open={installOpen} onOpenChange={(o) => !installing && setInstallOpen(o)}>
                <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
                    <DialogHeader>
                        <DialogTitle>{dialogMode === "install" ? "Install software" : "Remove software"}</DialogTitle>
                        <DialogDescription>{dialogMode === "install" ? "Choose a program from the software library to install on this device. The device must be online." : "Choose a program from the software library to remove from this device, and who to remove it for. The device must be online."}</DialogDescription>
                    </DialogHeader>
                    <div className="grid gap-2">
                        <SegmentedTabs
                            label="Install or remove"
                            items={[{ key: "install", label: "Install" }, { key: "uninstall", label: "Remove" }]}
                            value={dialogMode}
                            onChange={(k) => { setDialogMode(k as "install" | "uninstall"); setLibPick(null); setInstallError(null); }}
                        />
                        <div className="grid gap-1">
                            <label htmlFor="sw-install-for" className="text-sm font-medium">{dialogMode === "install" ? "Install for" : "Remove for"}</label>
                            <select id="sw-install-for" className="h-10 w-full rounded-md border border-input bg-background px-2 text-sm" value={installFor}
                                onChange={(e) => { setInstallFor(e.target.value); setLibPick(null); setInstallError(null); }}>
                                <option value="">{dialogMode === "install" ? "Everyone on this PC (machine-wide)" : "Everyone on this PC (with Chocolatey)"}</option>
                                {deviceUsers.map((u) => (
                                    <option key={u.account} value={u.account} disabled={!u.loggedIn}>{u.account}{u.loggedIn ? " (signed in)" : " (not signed in)"}</option>
                                ))}
                            </select>
                            <p className="min-h-4 text-xs text-muted-foreground">
                                {dialogMode === "uninstall"
                                    ? installFor
                                        ? `Removed from inside ${installFor}'s own session with winget. They must be signed in. Only programs with a winget id are listed.`
                                        : "Removed for the whole PC with Chocolatey, even if the software list does not show it. A program installed for one user is removed by choosing that user."
                                    : installFor
                                        ? `Installed inside ${installFor}'s own session with winget or the entry's direct installer, so it lands in their profile. Only programs that can do that are listed.`
                                        : deviceUsers.length ? "Installed once for the whole PC. Per-user programs may not work this way; choose a user for those." : "Installed once for the whole PC. The list of users appears after the device's next inventory report."}
                            </p>
                        </div>
                        <SearchField value={libQ} onChange={setLibQ} placeholder="Search the library" label="Search the software library" className="sm:w-full" />
                        <div className="h-64 overflow-y-auto rounded-md border bg-card text-sm" role="listbox" aria-label="Software library">
                            {library
                                .filter((e) => (dialogMode === "uninstall" ? (installFor ? !!e.wingetId : !!e.chocolateyId) : installFor ? forOneUser(e) : e.installable) && (!libQ.trim() || `${e.name} ${e.category} ${e.matchText}`.toLowerCase().includes(libQ.trim().toLowerCase())))
                                .map((e) => (
                                    <button key={e.id} type="button" role="option" aria-selected={libPick?.id === e.id}
                                        className={`flex w-full items-baseline justify-between gap-2 px-3 py-2 text-left hover:bg-accent ${libPick?.id === e.id ? "bg-muted font-medium" : ""}`}
                                        onClick={() => { setLibPick(e); setInstallError(null); }}>
                                        <span>{e.name}</span>
                                        <span className="text-xs text-muted-foreground">{e.category}</span>
                                    </button>
                                ))}
                            {library.filter((e) => (dialogMode === "uninstall" ? (installFor ? !!e.wingetId : !!e.chocolateyId) : installFor ? forOneUser(e) : e.installable)).length === 0 && <p className="px-3 py-3 text-xs text-muted-foreground">No installable software in the library yet. Add a Chocolatey id or an installer link on the Policies page, Software tab.</p>}
                        </div>
                    </div>
                    <DialogFooter className="items-center gap-2 sm:justify-between">
                        <p role="alert" className="min-h-5 text-sm text-destructive">{installError ?? ""}</p>
                        <div className="flex gap-2">
                            <Button type="button" variant="outline" disabled={installing} onClick={() => setInstallOpen(false)}>Cancel</Button>
                            <Button type="button" variant="success" disabled={!libPick || installing}
                                onClick={async () => { if (!libPick) return; setInstalling(true); setInstallError(null); const ok = await runLibrary(libPick, dialogMode, installFor || undefined); setInstalling(false); if (ok) setInstallOpen(false); }}>
                                {installing ? "Queuing…" : libPick ? `${dialogMode === "install" ? "Install" : "Remove"} ${libPick.name}${installFor ? ` for ${installFor}` : ""}` : dialogMode === "install" ? "Install" : "Remove"}
                            </Button>
                        </div>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <AlertDialog open={!!libUninstall} onOpenChange={(o) => !o && setLibUninstall(null)}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Uninstall “{libUninstall?.item.name}”?</AlertDialogTitle>
                        <AlertDialogDescription>
                            {libUninstall?.runAs ? `This removes ${libUninstall.entry.name} from inside ${libUninstall.runAs}'s own session with winget, in the background. They must be signed in.` : `This removes ${libUninstall?.entry.name} with Chocolatey, in the background, on this device.`} Some programs need a restart afterwards.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction onClick={() => { const t = libUninstall; setLibUninstall(null); if (t) void runLibrary(t.entry, "uninstall", t.runAs); }}>Uninstall</AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </Card>
    );
}
