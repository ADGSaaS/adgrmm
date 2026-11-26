// app/(dashboard)/devices/[deviceId]/page.tsx
"use client";

import * as React from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams, usePathname } from "next/navigation";
import { Power, Play, Copy, ArrowLeft, ExternalLink, Ticket as TicketIcon } from "lucide-react";

import {
    Breadcrumb,
    BreadcrumbItem,
    BreadcrumbLink,
    BreadcrumbList,
    BreadcrumbPage,
    BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { useDashboard, type Device as UiDevice } from "@/app/(dashboard)/dashboard-context";
import { StatusBadge } from "@/components/status-badge";
import { DeviceReportMenu } from "@/components/reports/full-report";
import SoftwareTab from "@/components/software-tab";
import EffectivePolicy from "@/components/policies/effective-policy";
import ChecksAndAlertsTab from "@/components/checks-and-alerts-tab";
import PatchTab from "@/components/patch-tab";
import RemoteTab from "@/components/remote-tab";
import FileBrowserTab from "@/components/file-browser-tab";
import RemoteConsolePanel from "@/components/remote-console-panel";
import DevicePerformance from "@/components/device-performance";
import DeviceToolsTab from "@/components/device-tools-tab";
import RegistryTab from "@/components/registry-tab";
import SecurityTab from "@/components/security/security-tab";
import DeviceNetworkTab from "@/components/network/device-network-tab";
import { DeviceUpdateRing, UpdateRingBadge } from "@/components/update-ring";
import { deviceFamily } from "@/lib/device-os";
import { useDevice } from "@/lib/use-device";
import { DeviceTicketsCard } from "@/components/tickets/device-tickets-card";
import { newTicketHref } from "@/lib/ticket-from-device";
import { hasPerm } from "@/lib/permissions";
import { useMe } from "@/lib/use-me";
import dynamic from "next/dynamic";
import { apiUrl, fetchDeviceChecks, type DeviceCheck } from "@/lib/api";

const RemoteShellPanel = dynamic(() => import("@/components/remote-shell-panel"), {
    ssr: false,
});

// US-style "MM/DD/YYYY - H:MM AM/PM"
const dtFmt = new Intl.DateTimeFormat("en-US", {
    month: "2-digit",
    day: "2-digit",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
});

function formatLastSeenSafe(input?: unknown): string {
    if (input == null) return "—";

    const raw = String(input).trim();
    const low = raw.toLowerCase();

    if (!raw || low === "null" || low === "undefined" || low === "nan") return "—";

    const d = new Date(raw);
    const t = d.getTime();
    if (!Number.isFinite(t)) return "—";

    try {
        return dtFmt.format(d).replace(",", " -");
    } catch {
        return "—";
    }
}

type BadgeStatus = "healthy" | "warning" | "critical" | "offline";
function normalizeStatus(s?: string): BadgeStatus {
    switch ((s || "").toLowerCase()) {
        case "healthy":
            return "healthy";
        case "warning":
            return "warning";
        case "critical":
            return "critical";
        case "online":
            return "healthy";
        default:
            return "offline";
    }
}

function formatBytes(bytes: unknown, decimals = 1): string {
    const n = typeof bytes === "string" ? Number(bytes) : typeof bytes === "number" ? bytes : NaN;
    if (!Number.isFinite(n) || n < 0) return "—";
    if (n === 0) return "0 B";
    const k = 1024;
    const units = ["B", "KB", "MB", "GB", "TB", "PB"];
    const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(k)));
    const v = n / Math.pow(k, i);
    const fixed = i === 0 ? 0 : decimals;
    return `${v.toFixed(fixed)} ${units[i]}`;
}

function clampPct(x: number): number {
    if (!Number.isFinite(x)) return 0;
    return Math.max(0, Math.min(100, x));
}

function pickDiskBarClass(usedPct: number): string {
    if (usedPct >= 90) return "bg-red-500";
    if (usedPct >= 80) return "bg-yellow-500";
    return "bg-emerald-500";
}

type DiskFact = {
    mount?: string;
    name?: string;
    fs?: string;
    totalBytes?: number;
    freeBytes?: number;
    usedBytes?: number;
    usedPercent?: number;
    summary?: string;
};

function computeDisk(d: DiskFact) {
    const total = typeof d.totalBytes === "number" ? d.totalBytes : NaN;
    const free = typeof d.freeBytes === "number" ? d.freeBytes : NaN;
    const used =
        typeof d.usedBytes === "number"
            ? d.usedBytes
            : Number.isFinite(total) && Number.isFinite(free)
                ? total - free
                : NaN;

    const usedPct =
        typeof d.usedPercent === "number"
            ? d.usedPercent
            : Number.isFinite(total) && total > 0 && Number.isFinite(used)
                ? (used / total) * 100
                : NaN;

    const safeUsedPct = clampPct(Number.isFinite(usedPct) ? usedPct : 0);

    const builtSummary =
        d.summary ??
        (Number.isFinite(total) && Number.isFinite(free)
            ? `${formatBytes(free)} free of ${formatBytes(total)}`
            : "—");

    const title = String(d.mount ?? d.name ?? "Disk");
    const fs = d.fs ? String(d.fs) : "";

    return {
        title,
        fs,
        summary: builtSummary,
        usedPct: safeUsedPct,
        hasUsage: Number.isFinite(usedPct) || (Number.isFinite(total) && total > 0),
    };
}

function extractDeviceFactsRoot(facts: Record<string, any> | null): Record<string, any> | null {
    if (!facts || typeof facts !== "object") return null;

    const device = (facts as any).device;
    if (device && typeof device === "object") return device as Record<string, any>;

    const nestedFacts = (facts as any).facts;
    if (nestedFacts && typeof nestedFacts === "object") return nestedFacts as Record<string, any>;

    if ((facts as any).hardware || (facts as any).disks) return facts;

    return null;
}

// The tunnel exists but cannot be reached: it listens on the server, and the .rdp file points at the
// technician's own PC. The code stays until there is a real path, and old links land on this message.
function RemoteDesktopUnavailable() {
    return (
        <Card className="h-full">
            <CardHeader>
                <CardTitle>Remote Desktop (RDP) is not available</CardTitle>
                <CardDescription>
                    An RDP program needs a direct network connection to reach the device, and ADG RMM does not provide one
                    yet.
                </CardDescription>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
                Use Remote Console to see and control the screen, or Remote Shell for a command line.
            </CardContent>
        </Card>
    );
}

type ActionBanner = { kind: "success" | "error" | "info"; text: string } | null;

async function safeJson(res: Response): Promise<any> {
    try {
        return await res.json();
    } catch {
        return null;
    }
}

type ToolParam = "" | "remote-console" | "remote-desktop" | "remote-shell" | "file-browser";
type TabValue = "overview" | "remote" | "checks" | "patch" | "software" | "tools" | "registry" | "security" | "network";

export default function DeviceDetailPage() {
    const { deviceId } = useParams<{ deviceId: string }>();
    // The device comes from the server by its id (the list of devices is never held whole); only the alias is kept in this browser.
    const { aliases } = useDashboard();

    const { device: apiDevice, loading, error, refresh } = useDevice(deviceId);
    const mePermissions = useMe().permissions;
    const canCreateTicket = hasPerm(mePermissions, "tickets.write");
    // The Registry tab is for Windows devices and for people who hold the registry right.
    const canRegistry = hasPerm(mePermissions, ["devices.read", "devices.registry.read"]);
    const ticketDevice = apiDevice ? { id: apiDevice.id ?? deviceId, hostname: apiDevice.hostname ?? "", alias: aliases[apiDevice.id ?? deviceId] ?? null, clientId: apiDevice.clientId ?? null, client: apiDevice.client ?? null, site: apiDevice.site ?? null } : null;

    const device: UiDevice | undefined = React.useMemo(() => {
        if (!apiDevice) return undefined;

        const status = normalizeStatus(apiDevice.status);
        const merged: Record<string, unknown> = {
            id: apiDevice.id ?? deviceId,
            hostname: apiDevice.hostname ?? "",
            alias: aliases[apiDevice.id ?? deviceId] ?? apiDevice.hostname ?? "",
            client: apiDevice.client ?? "—",
            site: apiDevice.site ?? "—",
            os: apiDevice.os ?? "Unknown",
            status,
            lastResponse: apiDevice.lastSeen ?? null,
            arch: apiDevice.arch,
            primaryIp: apiDevice.primaryIp,
            version: apiDevice.version,
            user: apiDevice.user,
            agentUuid: (apiDevice as any)?.agentUuid ?? null,
            facts: (apiDevice as any)?.facts ?? null,
            updateRing: apiDevice.updateRing === "pilot" ? "pilot" : "stable",
            updateRingOwn: apiDevice.updateRingOwn ?? null,
        };

        return merged as unknown as UiDevice;
    }, [apiDevice, aliases, deviceId]);

    const router = useRouter();
    const pathname = usePathname();
    const search = useSearchParams();

    const tool = (String(search?.get("tool") ?? "").trim() as ToolParam) || "";
    const popout = String(search?.get("popout") ?? "").trim() === "1";

    const [banner, setBanner] = React.useState<ActionBanner>(null);

    // The fleet Security page links here with ?tab=security.
    const [tab, setTab] = React.useState<TabValue>(() => (search?.get("tab") === "security" ? "security" : search?.get("tab") === "network" ? "network" : "overview"));

    const [checks, setChecks] = React.useState<DeviceCheck[] | null>(null);
    const [checksFailed, setChecksFailed] = React.useState(false);
    React.useEffect(() => {
        let alive = true;
        fetchDeviceChecks(deviceId)
            .then((res) => {
                if (!alive) return;
                setChecks(res.items ?? []);
                setChecksFailed(false);
            })
            .catch(() => {
                if (alive) setChecksFailed(true);
            });
        return () => {
            alive = false;
        };
    }, [deviceId]);

    const openRunScript = React.useCallback(() => {
        const current = new URLSearchParams(search?.toString() ?? "");
        current.set("device", deviceId);
        router.push(`${pathname}?${current.toString()}`);
    }, [deviceId, pathname, router, search]);

    const postDeviceAction = React.useCallback(
        async (action: "reboot") => {
            setBanner(null);

            const res = await fetch(apiUrl(`/api/devices/${encodeURIComponent(deviceId)}/actions/${action}`), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify({ reason: "manual" }),
            });

            const body = await safeJson(res);

            if (res.status === 202 && body?.accepted && body?.jobId) {
                setBanner({
                    kind: "success",
                    text: `Reboot job queued successfully (Job ID: ${body.jobId}).`,
                });
                return;
            }

            if (res.status === 401 || res.status === 403) {
                setBanner({
                    kind: "error",
                    text: "You don’t have permission to run this action (401/403).",
                });
                return;
            }

            setBanner({
                kind: "error",
                text: `Action failed (${res.status}). ${body?.message ? String(body.message) : ""}`.trim(),
            });
        },
        [deviceId]
    );

    const onReboot = React.useCallback(async () => {
        await postDeviceAction("reboot");
    }, [postDeviceAction]);

    const copy = React.useCallback(async (text: string) => {
        try {
            await navigator.clipboard.writeText(text);
        } catch {
            // ignore
        }
    }, []);

    const setTool = React.useCallback(
        (nextTool: ToolParam) => {
            const current = new URLSearchParams(search?.toString() ?? "");
            if (nextTool) current.set("tool", nextTool);
            else current.delete("tool");
            router.push(`${pathname}?${current.toString()}`);
        },
        [pathname, router, search]
    );

    const openPopout = React.useCallback(() => {
        const current = new URLSearchParams(search?.toString() ?? "");
        if (!current.get("tool")) current.set("tool", "file-browser");
        current.set("popout", "1");
        const url = `${pathname}?${current.toString()}`;
        window.open(url, "_blank", "noopener,noreferrer,width=1280,height=800");
    }, [pathname, search]);

    const tabsValue: TabValue = tool ? "remote" : tab;

    React.useEffect(() => {
        if (tool) setTab("remote");
    }, [tool]);

    if (loading && !device) {
        return (
            <div className="flex flex-col items-center justify-center h-full gap-3 text-center p-6">
                <div className="text-sm text-muted-foreground">Loading device…</div>
            </div>
        );
    }
    if (error && !device) {
        return (
            <div className="flex flex-col items-center justify-center h-full gap-4 text-center p-6">
                <h2 className="text-2xl font-semibold">Error loading device</h2>
                <p className="text-muted-foreground">{String(error)}</p>
                <div className="flex gap-2">
                    <Button variant="outline" onClick={refresh}>
                        Retry
                    </Button>
                    <Button asChild>
                        <Link href="/">Return to Dashboard</Link>
                    </Button>
                </div>
            </div>
        );
    }
    if (!device) {
        return (
            <div className="flex flex-col items-center justify-center h-full gap-4 text-center p-6">
                <h2 className="text-2xl font-semibold">Device Not Found</h2>
                <p className="text-muted-foreground">
                    The device with ID &apos;{deviceId}&apos; could not be found.
                </p>
                <Button asChild>
                    <Link href="/">Return to Dashboard</Link>
                </Button>
            </div>
        );
    }

    const badgeStatus: BadgeStatus = normalizeStatus(device.status as unknown as string);

    const lastSeenIso = (device as any).lastResponse as string | null | undefined;
    const lastSeenStr = formatLastSeenSafe(lastSeenIso);

    const os = (device as any).os ?? "Unknown";
    // The Security tab: a security scan runs on Windows and Linux devices (not macOS or an unknown system).
    const canSecurityScan = deviceFamily(os) === "windows" || (deviceFamily(os) === "linux" && !/mac|darwin/i.test(os));
    const arch = (device as any).arch ?? "—";
    const primaryIp = (device as any).primaryIp ?? "—";
    const version = (device as any).version ?? "—";
    const currentUser = (device as any).user ?? "—";
    const agentUuid = (device as any)?.agentUuid as string | undefined | null;

    const facts = ((device as any)?.facts ?? null) as Record<string, any> | null;
    const deviceFacts = extractDeviceFactsRoot(facts);

    const hwModel = deviceFacts?.hardware?.model ?? null;
    const hwCpu = deviceFacts?.hardware?.cpu ?? null;

    const hwRam =
        deviceFacts?.hardware?.ram ??
        (typeof deviceFacts?.hardware?.ramBytes === "number" ? formatBytes(deviceFacts.hardware.ramBytes) : null);

    const rawGpu = deviceFacts?.hardware?.gpu ?? null;
    const hwGpu = Array.isArray(rawGpu) ? rawGpu.filter(Boolean).join(", ") : rawGpu;

    const hwSerial = deviceFacts?.hardware?.serial ?? null;

    const disks = Array.isArray(deviceFacts?.disks) ? (deviceFacts?.disks as DiskFact[]) : null;

    const remoteTitle =
        tool === "file-browser"
            ? "File Browser"
            : tool === "remote-shell"
                ? "Remote Shell"
                : tool === "remote-desktop"
                    ? "Remote Desktop (RDP)"
                    : tool === "remote-console"
                        ? "Remote Console"
                        : "Remote";

    // Popout mode:
    // For remote-console, render edge-to-edge and let the panel own the UI (tiny top bar + desktop + chat)
    if (popout && tool === "remote-console") {
        return (
            <main className="h-screen w-full">
                <RemoteConsolePanel deviceId={deviceId} agentUuid={agentUuid ?? undefined} popout />
            </main>
        );
    }

    // Other popouts keep the existing header wrapper
    if (popout) {
        return (
            <main className="min-h-screen w-full">
                <div className="sticky top-0 z-10 border-b bg-background/90 backdrop-blur">
                    <div className="flex items-center justify-between gap-3 px-4 py-3">
                        <div className="min-w-0">
                            <div className="text-xs text-muted-foreground">Device</div>
                            <div className="text-base font-semibold truncate">
                                {(device as any).alias || (device as any).hostname}
                            </div>
                            <div className="text-xs text-muted-foreground truncate">
                                {(device as any).client} / {(device as any).site}
                            </div>
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                            <Button variant="outline" onClick={() => window.close()} title="Close popout">
                                Close
                            </Button>
                        </div>
                    </div>
                </div>

                <div className="w-full p-4 h-[calc(100vh-72px)] min-h-0">
                    <div className="h-full min-h-0">
                        {tool === "file-browser" ? (
                            <FileBrowserTab deviceId={deviceId} popout />
                        ) : tool === "remote-shell" ? (
                            <RemoteShellPanel deviceId={deviceId} agentUuid={agentUuid ?? undefined} os={os} popout />
                        ) : tool === "remote-desktop" ? (
                            <RemoteDesktopUnavailable />
                        ) : (
                            <Card className="h-full">
                                <CardHeader>
                                    <CardTitle>Remote Tool</CardTitle>
                                    <CardDescription>
                                        Select a supported tool via <code className="text-xs">?tool=...</code>.
                                    </CardDescription>
                                </CardHeader>
                                <CardContent className="text-sm text-muted-foreground">
                                    Unknown tool: <code className="text-xs">{tool || "(none)"}</code>
                                </CardContent>
                            </Card>
                        )}
                    </div>
                </div>
            </main>
        );
    }

    const noAgent = !agentUuid;

    return (
        <main className="page-frame grid w-full flex-1 grid-cols-[minmax(0,1fr)] items-start gap-4 p-4 sm:p-6 md:gap-8 lg:px-8">
            <div className="grid w-full min-w-0 flex-1 auto-rows-max grid-cols-[minmax(0,1fr)] gap-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <Breadcrumb className="hidden min-w-0 md:flex">
                        <BreadcrumbList>
                            <BreadcrumbItem>
                                <BreadcrumbLink asChild>
                                    <Link href="/">Dashboard</Link>
                                </BreadcrumbLink>
                            </BreadcrumbItem>
                            <BreadcrumbSeparator />
                            <BreadcrumbItem>
                                <BreadcrumbLink asChild>
                                    <Link href="/customers">Devices</Link>
                                </BreadcrumbLink>
                            </BreadcrumbItem>
                            <BreadcrumbSeparator />
                            <BreadcrumbItem>
                                <BreadcrumbPage>{(device as any).alias || (device as any).hostname}</BreadcrumbPage>
                            </BreadcrumbItem>
                        </BreadcrumbList>
                    </Breadcrumb>

                    <div className="flex items-center gap-2">
                        <DeviceReportMenu deviceId={deviceId} />
                        {canCreateTicket && ticketDevice ? (
                            <Button asChild variant="outline" size="sm" className="gap-2" title="Open a ticket for this device">
                                <Link href={newTicketHref(ticketDevice)}>
                                    <TicketIcon className="h-4 w-4" /> Create ticket
                                </Link>
                            </Button>
                        ) : null}
                        <Button variant="default" size="sm" onClick={openRunScript} className="gap-2" title="Open Run Script">
                            <Play className="h-4 w-4" /> Run Script
                        </Button>

                        <AlertDialog>
                            <AlertDialogTrigger asChild>
                                <Button variant="destructive" size="sm" className="gap-2" title="Reboot this device">
                                    <Power className="h-4 w-4" /> Reboot
                                </Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                                <AlertDialogHeader>
                                    <AlertDialogTitle>Reboot {(device as any).alias || (device as any).hostname}?</AlertDialogTitle>
                                    <AlertDialogDescription>
                                        The device restarts within seconds, and anyone using it loses unsaved work. If it is offline, the
                                        reboot runs when it reconnects within the next hour.
                                    </AlertDialogDescription>
                                </AlertDialogHeader>
                                <AlertDialogFooter>
                                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                                    <AlertDialogAction onClick={onReboot}>Reboot</AlertDialogAction>
                                </AlertDialogFooter>
                            </AlertDialogContent>
                        </AlertDialog>
                    </div>
                </div>

                {banner ? (
                    <div
                        className={[
                            "rounded-md border px-3 py-2 text-sm",
                            banner.kind === "success"
                                ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                                : banner.kind === "error"
                                    ? "border-red-200 bg-red-50 text-red-900"
                                    : "border-border bg-muted/40 text-foreground",
                        ].join(" ")}
                        role="status"
                    >
                        <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">{banner.text}</div>
                            <button
                                className="text-xs opacity-70 hover:opacity-100"
                                onClick={() => setBanner(null)}
                                aria-label="Dismiss message"
                                title="Dismiss"
                            >
                                ✕
                            </button>
                        </div>
                    </div>
                ) : null}

                <Tabs
                    value={tabsValue}
                    onValueChange={(v) => {
                        const next = (v as TabValue) || "overview";
                        setTab(next);

                        if (next !== "remote") setTool("");
                    }}
                >
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <TabsList>
                            <TabsTrigger value="overview">Overview</TabsTrigger>
                            <TabsTrigger value="remote">Remote</TabsTrigger>
                            <TabsTrigger value="checks">Checks &amp; Alerts</TabsTrigger>
                            <TabsTrigger value="patch">Patch</TabsTrigger>
                            <TabsTrigger value="software">Software</TabsTrigger>
                            <TabsTrigger value="tools">Services / Processes / Event log</TabsTrigger>
                            {canRegistry && deviceFamily(os) === "windows" ? <TabsTrigger value="registry">Registry</TabsTrigger> : null}
                            {canSecurityScan ? <TabsTrigger value="security">Security</TabsTrigger> : null}
                            {canSecurityScan ? <TabsTrigger value="network">Network</TabsTrigger> : null}
                            <TabsTrigger value="policies">Policies</TabsTrigger>
                        </TabsList>
                        <div className="ml-auto flex items-center gap-2">
                            <Button variant="outline" size="sm" onClick={refresh} title="Refresh device data">
                                Refresh
                            </Button>
                        </div>
                    </div>

                    <TabsContent value="overview">
                        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                            <Card className="min-w-0 lg:col-span-2">
                                <CardHeader>
                                    <div className="flex justify-between items-start gap-4">
                                        <div className="min-w-0">
                                            <CardTitle className="truncate">{(device as any).alias || (device as any).hostname}</CardTitle>
                                            <CardDescription className="truncate">
                                                {(device as any).client} / {(device as any).site}
                                            </CardDescription>
                                        </div>
                                    </div>
                                </CardHeader>

                                <CardContent>
                                    <div className="text-sm text-muted-foreground">
                                        <span className="font-medium text-foreground">{(device as any).hostname}</span>
                                        {" · "}
                                        <span>{os}</span>
                                        {" · "}
                                        <span>Agent v{version}</span>
                                        {(device as any).updateRing === "pilot" ? <>{" · "}<UpdateRingBadge ring="pilot" /></> : null}
                                    </div>

                                    <Separator className="my-4" />

                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6 text-sm">
                                        <div className="space-y-2">
                                            <h3 className="font-medium">Hardware Details</h3>

                                            <div className="space-y-1 text-muted-foreground">
                                                <div className="flex min-w-0 justify-between gap-4">
                                                    <span>Status</span>
                                                    <span className="min-w-0 break-words text-right text-foreground">
                                                        <StatusBadge status={badgeStatus} />
                                                    </span>
                                                </div>

                                                <div className="flex min-w-0 justify-between gap-4">
                                                    <span>Architecture</span>
                                                    <span className="min-w-0 break-words text-right text-foreground">{arch}</span>
                                                </div>

                                                <div className="flex min-w-0 justify-between gap-4">
                                                    <span>Logged-in User</span>
                                                    <span className="min-w-0 break-words text-right text-foreground">{currentUser}</span>
                                                </div>

                                                <div className="flex min-w-0 justify-between gap-4">
                                                    <span>LAN IP</span>
                                                    <span className="min-w-0 break-words text-right text-foreground">{primaryIp}</span>
                                                </div>

                                                <div className="flex min-w-0 justify-between gap-4">
                                                    <span>Last Response</span>
                                                    <span className="min-w-0 break-words text-right text-foreground">{lastSeenStr}</span>
                                                </div>

                                                <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-1" data-testid="update-ring-row">
                                                    <span className="pt-1">Update ring</span>
                                                    <span className="min-w-0 break-words text-right text-foreground">
                                                        <DeviceUpdateRing
                                                            deviceId={String((device as any).id)}
                                                            ring={(device as any).updateRing === "pilot" ? "pilot" : "stable"}
                                                            own={(device as any).updateRingOwn ?? null}
                                                            onChanged={refresh}
                                                        />
                                                    </span>
                                                </div>

                                                <Separator className="my-3" />

                                                <div className="flex min-w-0 justify-between gap-4">
                                                    <span>System Model</span>
                                                    <span className="min-w-0 break-words text-right text-foreground">{hwModel ? String(hwModel) : "—"}</span>
                                                </div>

                                                <div className="flex min-w-0 justify-between gap-4">
                                                    <span>CPU</span>
                                                    <span className="min-w-0 break-words text-right text-foreground">{hwCpu ? String(hwCpu) : "—"}</span>
                                                </div>

                                                <div className="flex min-w-0 justify-between gap-4">
                                                    <span>RAM</span>
                                                    <span className="min-w-0 break-words text-right text-foreground">{hwRam ? String(hwRam) : "—"}</span>
                                                </div>

                                                <div className="flex min-w-0 justify-between gap-4">
                                                    <span>GPU</span>
                                                    <span className="min-w-0 break-words text-right text-foreground">{hwGpu ? String(hwGpu) : "—"}</span>
                                                </div>

                                                <div className="flex min-w-0 justify-between gap-4">
                                                    <span>System Serial Number</span>
                                                    <span className="min-w-0 break-words text-right text-foreground">{hwSerial ? String(hwSerial) : "—"}</span>
                                                </div>

                                                {!deviceFacts ? (
                                                    <div className="pt-2 text-xs text-muted-foreground">
                                                        The agent has not reported hardware details yet.
                                                    </div>
                                                ) : null}
                                            </div>

                                            {agentUuid ? (
                                                <div className="pt-3 space-y-1">
                                                    <h3 className="font-medium text-muted-foreground">Agent UUID</h3>
                                                    <div className="flex flex-wrap items-center gap-2">
                                                        <code className="min-w-0 text-xs break-all">{agentUuid}</code>
                                                        <Button
                                                            size="sm"
                                                            variant="outline"
                                                            title="Copy agent UUID"
                                                            onClick={() => copy(agentUuid)}
                                                            className="gap-2"
                                                        >
                                                            <Copy className="h-3.5 w-3.5" />
                                                            Copy
                                                        </Button>
                                                    </div>
                                                </div>
                                            ) : null}

                                            {noAgent ? (
                                                <div className="pt-2 text-xs text-muted-foreground">
                                                    This device has no <span className="font-medium">agentUuid</span> yet, so Remote tools can’t connect.
                                                </div>
                                            ) : null}
                                        </div>

                                        <div className="space-y-2">
                                            <h3 className="font-medium">Checks Status</h3>
                                            <div className="text-sm text-muted-foreground">
                                                {checksFailed
                                                    ? "Checks could not be loaded."
                                                    : checks === null
                                                        ? "Loading…"
                                                        : checks.length === 0
                                                            ? "No checks have reported on this device."
                                                            : `${checks.filter((c) => c.status === "Passing").length} passing, ${checks.filter((c) => c.status === "Warning").length} warning, ${checks.filter((c) => c.status === "Failing").length} failing`}
                                            </div>
                                        </div>
                                    </div>
                                </CardContent>
                            </Card>

                            <Card>
                                <CardHeader>
                                    <CardTitle>Disks</CardTitle>
                                </CardHeader>
                                <CardContent className="text-sm">
                                    {!disks?.length ? (
                                        <div className="text-muted-foreground">—</div>
                                    ) : (
                                        <div className="space-y-4">
                                            {disks.map((raw, idx) => {
                                                const d = computeDisk(raw);
                                                const barClass = pickDiskBarClass(d.usedPct);

                                                return (
                                                    <div key={idx} className="space-y-1">
                                                        <div className="flex items-center justify-between">
                                                            <div className="font-medium">
                                                                {d.title}
                                                                {d.fs ? <span className="text-muted-foreground font-normal"> ({d.fs})</span> : null}
                                                            </div>
                                                            <div className="text-xs text-muted-foreground">
                                                                {d.hasUsage ? `${d.usedPct.toFixed(0)}% used` : ""}
                                                            </div>
                                                        </div>

                                                        <div
                                                            className="h-2 w-full rounded-full bg-muted overflow-hidden"
                                                            role="progressbar"
                                                            aria-valuenow={d.usedPct}
                                                            aria-valuemin={0}
                                                            aria-valuemax={100}
                                                            aria-label={`${d.title} disk usage`}
                                                        >
                                                            <div className={`h-full ${barClass}`} style={{ width: `${d.usedPct}%` }} />
                                                        </div>

                                                        <div className="text-xs text-muted-foreground">{d.summary}</div>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    )}
                                </CardContent>
                            </Card>

                            <DevicePerformance deviceId={deviceId} deviceName={(device as any).alias || (device as any).hostname} />

                            {ticketDevice ? <DeviceTicketsCard className="min-w-0 lg:col-span-3" device={ticketDevice} /> : null}
                        </div>
                    </TabsContent>

                    <TabsContent value="remote" className="h-[calc(100vh-220px)] min-h-0">
                        {tool === "file-browser" || tool === "remote-shell" || tool === "remote-desktop" || tool === "remote-console" ? (
                            <div className="flex h-full flex-col gap-3 min-h-0">
                                <div className="flex items-center justify-between gap-2">
                                    <div className="min-w-0">
                                        <div className="text-sm text-muted-foreground">Remote</div>
                                        <div className="text-lg font-semibold truncate">{remoteTitle}</div>
                                    </div>

                                    <div className="flex items-center gap-2 shrink-0">
                                        <Button variant="outline" onClick={() => setTool("")} className="gap-2">
                                            <ArrowLeft className="h-4 w-4" />
                                            Back
                                        </Button>
                                        {tool === "remote-console" ? null : (
                                            <Button variant="outline" onClick={openPopout} className="gap-2" title="Open in a new window">
                                                <ExternalLink className="h-4 w-4" />
                                                Pop out
                                            </Button>
                                        )}
                                    </div>
                                </div>

                                <div className="flex-1 min-h-0">
                                    {tool === "file-browser" ? (
                                        <FileBrowserTab deviceId={deviceId} />
                                    ) : tool === "remote-shell" ? (
                                        <RemoteShellPanel deviceId={deviceId} agentUuid={agentUuid ?? undefined} os={os} />
                                    ) : tool === "remote-desktop" ? (
                                        <RemoteDesktopUnavailable />
                                    ) : (
                                        <RemoteConsolePanel deviceId={deviceId} agentUuid={agentUuid ?? undefined} />
                                    )}
                                </div>
                            </div>
                        ) : (
                            <RemoteTab deviceId={deviceId} os={(device as any)?.os} />
                        )}
                    </TabsContent>

                    <TabsContent value="checks">
                        <ChecksAndAlertsTab deviceId={deviceId} />
                    </TabsContent>
                    <TabsContent value="patch">
                        <PatchTab deviceId={deviceId} os={os} />
                    </TabsContent>
                    <TabsContent value="software">
                        <SoftwareTab os={os} />
                    </TabsContent>
                    <TabsContent value="tools">
                        <DeviceToolsTab deviceId={deviceId} os={os} deviceName={(device as any).alias || (device as any).hostname} />
                    </TabsContent>
                    {canRegistry && deviceFamily(os) === "windows" ? (
                        <TabsContent value="registry">
                            <RegistryTab deviceId={deviceId} os={os} deviceName={(device as any).alias || (device as any).hostname} />
                        </TabsContent>
                    ) : null}
                    {canSecurityScan ? (
                        <TabsContent value="security">
                            <SecurityTab deviceId={deviceId} os={os} deviceName={(device as any).alias || (device as any).hostname} />
                        </TabsContent>
                    ) : null}
                    {canSecurityScan ? (
                        <TabsContent value="network">
                            <DeviceNetworkTab deviceId={deviceId} deviceName={(device as any).alias || (device as any).hostname} />
                        </TabsContent>
                    ) : null}
                    <TabsContent value="policies">
                        <EffectivePolicy deviceId={deviceId} />
                    </TabsContent>
                </Tabs>
            </div>
        </main>
    );
}
