// adgrmm-frontend/components/device-table-columns.tsx

"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { ColumnDef } from "@tanstack/react-table";
import { formatUsDateTime } from "@/lib/time";
import {
    ArrowUpDown,
    ArrowUp,
    ArrowDown,
    MoreHorizontal,
    PlaySquare,
    ExternalLink,
    Copy,
    CircleDot,
    Edit3,
    Eraser,
    KeyRound,
    MoveRight,
    MapPin,
    CheckCircle2,
    Trash2, RefreshCw, Ticket as TicketIcon } from "lucide-react";

import { hasPerm } from "@/lib/permissions";
import { Checkbox } from "@/components/ui/checkbox";
import { requestDeviceDeletion, approveDeviceDeletion, getDeviceDeletionRequest, type DeletionRequest } from "@/lib/device-deletion";

import { Button } from "@/components/ui/button";
import { UpdateRingBadge } from "@/components/update-ring";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
import { Input } from "@/components/ui/input";
import { SortHeader } from "@/components/sort-header";

import { StatusBadge } from "@/components/status-badge";
import { Device, useDashboard } from "@/app/(dashboard)/dashboard-context";
import { toast as showToast } from "@/components/ui/use-toast";
import { trackAgentUpdate } from "@/lib/agent-update-tracker";
import { fetchCustomers, fetchCustomerSites, moveDeviceToSite, requestAgentUpdate } from "@/lib/api";
import { DEVICES_CHANGED_EVENT } from "@/lib/device-move";
import { newTicketHref } from "@/lib/ticket-from-device";

// Errors stay up longer, because they usually need reading.
const toast = {
    success: (title: string) => showToast({ title, variant: "success" }),
    error: (title: string) => showToast({ title, variant: "destructive", duration: 10_000 }),
};

/* ============================================================================
   Immediate UI updates without refresh:
   ========================================================================== */

type PlacementOverride = {
    client?: string | null;
    site?: string | null;
};

const placementOverrides = new Map<string, PlacementOverride>();
let placementVersion = 0;
const placementListeners = new Set<() => void>();

function emitPlacement() {
    placementVersion++;
    for (const l of placementListeners) l();
}

function setPlacementOverride(deviceId: string, patch: PlacementOverride) {
    const id = String(deviceId ?? "").trim();
    if (!id) return;

    const cur = placementOverrides.get(id) ?? {};
    const next = { ...cur, ...patch };
    placementOverrides.set(id, next);
    emitPlacement();
}

function clearPlacementOverride(deviceId: string) {
    const id = String(deviceId ?? "").trim();
    if (!id) return;

    if (placementOverrides.has(id)) {
        placementOverrides.delete(id);
        emitPlacement();
    }
}

function subscribePlacement(cb: () => void) {
    placementListeners.add(cb);
    return () => placementListeners.delete(cb);
}

function usePlacementOverride(deviceId: string) {
    React.useSyncExternalStore(subscribePlacement, () => placementVersion, () => 0);
    return placementOverrides.get(String(deviceId ?? "").trim()) ?? null;
}

function ClientCell({ device }: { device: Device }) {
    const ov = usePlacementOverride(device.id);
    const display = String(ov?.client ?? device.client ?? "");

    React.useEffect(() => {
        if (!ov) return;
        const clientMatches = (ov.client ?? null) === (device.client ?? null);
        const siteMatches = (ov.site ?? null) === (device.site ?? null);
        if (clientMatches && siteMatches) clearPlacementOverride(device.id);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [device.client, device.site, ov?.client, ov?.site, device.id]);

    return <span className="truncate">{display}</span>;
}

function SiteCell({ device }: { device: Device }) {
    const ov = usePlacementOverride(device.id);
    const display = String(ov?.site ?? device.site ?? "");

    React.useEffect(() => {
        if (!ov) return;
        const clientMatches = (ov.client ?? null) === (device.client ?? null);
        const siteMatches = (ov.site ?? null) === (device.site ?? null);
        if (clientMatches && siteMatches) clearPlacementOverride(device.id);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [device.client, device.site, ov?.client, ov?.site, device.id]);

    return <span className="truncate">{display}</span>;
}

/* ============================================================================
   Columns
   ========================================================================== */

const SortableHeader = SortHeader;

export const columns: ColumnDef<Device>[] = [
    {
        // Ticks for the bulk actions. The server table turns them on; a table that cannot select leaves this column out.
        id: "select",
        enableSorting: false,
        enableHiding: false,
        header: ({ table }) => (
            <Checkbox
                aria-label="Select all devices on this page"
                checked={table.getIsAllPageRowsSelected() ? true : table.getIsSomePageRowsSelected() ? "indeterminate" : false}
                onCheckedChange={(v) => table.toggleAllPageRowsSelected(!!v)}
            />
        ),
        cell: ({ row }) => (
            <Checkbox
                aria-label={`Select ${(row.original as Device).alias || (row.original as Device).hostname}`}
                checked={row.getIsSelected()}
                onCheckedChange={(v) => row.toggleSelected(!!v)}
                onClick={(e) => e.stopPropagation()}
            />
        ),
    },
    {
        id: "tags",
        // The server sorts the list and cannot sort by tags, so this heading is not a sort button.
        enableSorting: false,
        header: "Tags",
        cell: ({ row }) => {
            const tags = ((row.original as Device).tags ?? []) as { id: string; name: string }[];
            if (!tags.length) return <span className="text-muted-foreground">—</span>;
            return (
                <span className="flex flex-wrap gap-1">
                    {tags.map((t) => (
                        <span key={t.id} className="rounded-full border bg-muted px-2 py-0.5 text-xs">{t.name}</span>
                    ))}
                </span>
            );
        },
    },
    {
        accessorKey: "hostname",
        header: ({ column }) => <SortableHeader column={column} label="Hostname" />,
        cell: ({ row }) => {
            const d = row.original as Device;
            return (
                <Link href={`/devices/${d.id}`} className="hover:underline" onClick={(e) => e.stopPropagation()}>
                    {d.alias ? (
                        <div className="leading-tight">
                            <div className="font-medium text-foreground">{d.alias}</div>
                            <div className="text-xs text-muted-foreground">{d.hostname}</div>
                        </div>
                    ) : (
                        <span className="font-medium text-foreground">{d.hostname}</span>
                    )}
                    <UpdateRingBadge ring={d.updateRing} className="ml-2 align-middle" />
                </Link>
            );
        },
    },
    {
        accessorKey: "status",
        header: ({ column }) => <SortableHeader column={column} label="Status" />,
        cell: ({ row }) => <StatusBadge status={row.getValue("status")} />,
    },
    {
        accessorKey: "client",
        header: ({ column }) => <SortableHeader column={column} label="Client" />,
        cell: ({ row }) => <ClientCell device={row.original as Device} />,
    },
    {
        accessorKey: "site",
        header: ({ column }) => <SortableHeader column={column} label="Site" />,
        cell: ({ row }) => <SiteCell device={row.original as Device} />,
    },
    {
        accessorKey: "os",
        header: ({ column }) => <SortableHeader column={column} label="Operating System" />,
        cell: ({ row }) => <span>{row.getValue("os") as string}</span>,
    },
    {
        accessorKey: "user",
        header: ({ column }) => <SortableHeader column={column} label="User" />,
        cell: ({ row }) => {
            const u = row.getValue("user") as any;
            if (!u) return <span className="text-muted-foreground">—</span>;
            const text = Array.isArray(u) ? u.filter(Boolean).join(", ") : String(u);
            return <span className="truncate">{text || "—"}</span>;
        },
    },
    {
        accessorKey: "lastResponse",
        header: ({ column }) => <SortableHeader column={column} label="Last Response" />,
        cell: ({ row }) => {
            const iso = row.getValue("lastResponse") as string | null | undefined;
            const pretty = formatUsDateTime(iso);
            return iso ? (
                <time dateTime={iso} title={iso}>
                    {pretty}
                </time>
            ) : (
                <span className="text-muted-foreground">—</span>
            );
        },
    },
    {
        id: "actions",
        enableSorting: false,
        header: () => <span className="sr-only">Actions</span>,
        cell: ({ row }) => <RowActions device={row.original} />,
    },
];

type ClientOption = {
    id: string;
    name: string;
};

type SiteOption = {
    id: string;
    clientId: string;
    name: string;
};

function normalizeName(s: unknown) {
    return String(s ?? "").trim().toLowerCase();
}

function sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
}

/**
 * A one-pixel marker at the cursor for a right-click menu to hang from. It lives on the page itself, not in the table,
 * because the table's own positioning would shift a fixed element.
 */
const CursorAnchor = React.forwardRef<HTMLSpanElement, { x: number; y: number } & React.HTMLAttributes<HTMLSpanElement>>(function CursorAnchor({ x, y, ...rest }, ref) {
    if (typeof document === "undefined") return null;
    return createPortal(
        <span {...rest} ref={ref} aria-hidden style={{ position: "fixed", left: x, top: y, width: 1, height: 1, pointerEvents: "none" }} />,
        document.body
    );
});

function RowActions({ device }: { device: Device }) {
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();

    const dash = useDashboard() as any;
    const updateDeviceAlias = dash?.updateDeviceAlias as (id: string, alias: string | null) => void;

    const myPerms =
        dash?.me?.permissions ??
        dash?.me?.perms ??
        dash?.permissions ??
        dash?.perms ??
        dash?.me?.rolePermissions ??
        [];

    const canFinalizeDelete = hasPerm(myPerms, "devices.delete");
    const canCreateTicket = hasPerm(myPerms, "tickets.write");
    const deletionStatusRaw = String((device as any)?.deletionStatus ?? "").trim().toLowerCase();
    const isDeletionPending = deletionStatusRaw === "pending";

    const [menuOpen, setMenuOpen] = React.useState(false);

    // Right-clicking anywhere on the row opens this same menu, where the cursor is.
    const triggerRef = React.useRef<HTMLButtonElement | null>(null);
    const [openedAt, setOpenedAt] = React.useState<{ x: number; y: number } | null>(null);
    React.useEffect(() => {
        const row = triggerRef.current?.closest("tr");
        if (!row) return;
        const onContextMenu = (e: MouseEvent) => {
            // Links, text boxes and Shift+right-click keep the browser's own menu.
            if (e.shiftKey) return;
            if ((e.target as HTMLElement | null)?.closest("a, input, textarea, select, [contenteditable='true']")) return;
            e.preventDefault();
            setOpenedAt({ x: e.clientX, y: e.clientY });
            setMenuOpen(true);
        };
        row.addEventListener("contextmenu", onContextMenu);
        return () => row.removeEventListener("contextmenu", onContextMenu);
    }, []);
    React.useEffect(() => {
        if (!menuOpen) setOpenedAt(null);
    }, [menuOpen]);
    // When opened by a right-click the menu hangs from a tiny invisible marker at the cursor instead of from the button.
    // It sits a few pixels clear of the cursor, so letting go of the mouse button does not land on the first item.
    const atCursor = openedAt !== null;

    // Alias
    const [aliasOpen, setAliasOpen] = React.useState(false);
    const [aliasValue, setAliasValue] = React.useState(device.alias ?? "");
    const [confirmClearOpen, setConfirmClearOpen] = React.useState(false);

    // Delete/request deletion
    const [deleteOpen, setDeleteOpen] = React.useState(false);
    const [deleteLoading, setDeleteLoading] = React.useState(false);
    // Why the device should go, and whether to open a ticket for the approval.
    const [delReason, setDelReason] = React.useState("");
    const [delTicket, setDelTicket] = React.useState(false);
    const [delTried, setDelTried] = React.useState(false);
    const [pendingRequest, setPendingRequest] = React.useState<DeletionRequest | null>(null);
    const reasonOk = delReason.trim().length >= 3 && delReason.trim().length <= 500;

    // Move dialog: another site, at this customer or another one
    const [moveOpen, setMoveOpen] = React.useState(false);
    const [moveLoading, setMoveLoading] = React.useState(false);
    const [sitesLoading, setSitesLoading] = React.useState(false);

    const [moveClients, setMoveClients] = React.useState<ClientOption[]>([]);
    const [moveClientId, setMoveClientId] = React.useState<string>("");
    const [homeClientId, setHomeClientId] = React.useState<string>("");
    const [moveClientName, setMoveClientName] = React.useState<string>("");

    const [siteQuery, setSiteQuery] = React.useState("");
    const [sites, setSites] = React.useState<SiteOption[]>([]);
    const [selectedSiteId, setSelectedSiteId] = React.useState<string>("");

    // Success confirmation (inside the modal)
    const [moveSuccess, setMoveSuccess] = React.useState<{
        clientName: string;
        siteName: string;
    } | null>(null);

    React.useEffect(() => {
        if (aliasOpen) setAliasValue(device.alias ?? "");
    }, [aliasOpen, device.alias]);

    const copy = async (text: string, label: string) => {
        try {
            setMenuOpen(false);
            await navigator.clipboard.writeText(text);
            toast.success(`${label} copied to clipboard`);
        } catch {
            toast.error("Copy failed: your browser blocked clipboard access");
        }
    };

    const saveAlias = () => {
        updateDeviceAlias(device.id, aliasValue || null);
        setAliasOpen(false);
        toast.success(aliasValue ? `Alias set to “${aliasValue}”` : "Alias cleared");
    };

    const updateAgent = async () => {
        setMenuOpen(false);
        const name = device.alias || device.hostname;
        try {
            const result = await requestAgentUpdate(device.id);
            if (result.status === "up_to_date") {
                toast.success(`${name} is already up to date (version ${result.version})`);
            } else {
                trackAgentUpdate({ deviceId: device.id, jobId: result.jobId, name, targetVersion: result.targetVersion });
            }
        } catch (e: any) {
            toast.error(e?.message || "Could not start the agent update");
        }
    };

    const openRunScriptHere = () => {
        setMenuOpen(false);
        const sp = new URLSearchParams(searchParams);
        sp.set("runScript", device.id);
        router.push(`${pathname}?${sp.toString()}`);
    };

    const confirmClearAlias = () => {
        updateDeviceAlias(device.id, null);
        setConfirmClearOpen(false);
        toast.success("Alias cleared");
    };

    const agentUuid = (device as any)?.agentUuid as string | undefined | null;

    const currentClientName = String(device.client ?? "").trim();
    const currentSiteName = String(device.site ?? "").trim();

    const openMoveDialog = async () => {
        setMenuOpen(false);
        setMoveOpen(true);

        // Reset each time
        setMoveClientId("");
        setMoveClientName(currentClientName);
        setSites([]);
        setSelectedSiteId("");
        setSiteQuery("");
        setMoveSuccess(null);

        if (!currentClientName) {
            toast.error("This device row has no client name, so we can’t determine allowed sites.");
            return;
        }

        try {
            setSitesLoading(true);

            const csRaw = await fetchCustomers();
            const clients: ClientOption[] = (csRaw ?? [])
                .map((c: any) => ({
                    id: String(c.id ?? c.key ?? ""),
                    name: String(c.name ?? c.label ?? ""),
                }))
                .filter((c) => c.id && c.name);

            const targetNorm = normalizeName(currentClientName);

            let match = clients.find((c) => normalizeName(c.name) === targetNorm);
            if (!match) {
                match = clients.find((c) => normalizeName(c.name).includes(targetNorm) || targetNorm.includes(normalizeName(c.name)));
            }

            if (!match?.id) {
                toast.error(
                    `Could not find clientId for “${currentClientName}”. Make sure the client list contains this name.`
                );
                return;
            }

            setMoveClients(clients.sort((a, b) => a.name.localeCompare(b.name)));
            setMoveClientId(match.id);
            setHomeClientId(match.id);
            setMoveClientName(match.name);

            const ss = await fetchCustomerSites(match.id);
            const normalized: SiteOption[] = (ss ?? [])
                .map((s: any) => ({
                    id: String(s.id ?? s.key ?? ""),
                    clientId: String(s.clientId ?? s.client_id ?? match!.id),
                    name: String(s.name ?? s.label ?? ""),
                }))
                .filter((x) => x.id && x.name);

            setSites(normalized);
        } catch (e: any) {
            toast.error(e?.message || "Failed to load sites");
            setSites([]);
        } finally {
            setSitesLoading(false);
        }
    };

    const chooseClient = async (id: string) => {
        const c = moveClients.find((x) => x.id === id);
        if (!c || id === moveClientId) return;
        setMoveClientId(c.id);
        setMoveClientName(c.name);
        setSites([]);
        setSelectedSiteId("");
        setSiteQuery("");
        try {
            setSitesLoading(true);
            const ss = await fetchCustomerSites(c.id);
            setSites(
                (ss ?? [])
                    .map((s: any) => ({ id: String(s.id ?? s.key ?? ""), clientId: String(s.clientId ?? s.client_id ?? c.id), name: String(s.name ?? s.label ?? "") }))
                    .filter((x) => x.id && x.name)
            );
        } catch (e: any) {
            toast.error(e?.message || "Failed to load sites");
        } finally {
            setSitesLoading(false);
        }
    };

    const changingCustomer = !!moveClientId && !!homeClientId && moveClientId !== homeClientId;

    const filteredSites = React.useMemo(() => {
        const q = siteQuery.trim().toLowerCase();
        if (!q) return sites;
        return sites.filter((s) => s.name.toLowerCase().includes(q));
    }, [sites, siteQuery]);

    const selectedSiteName = React.useMemo(() => {
        return sites.find((s) => s.id === selectedSiteId)?.name ?? "";
    }, [sites, selectedSiteId]);

    const doMove = async () => {
        const siteId = String(selectedSiteId ?? "").trim();
        if (!siteId) {
            toast.error("Please select a target site");
            return;
        }
        if (changingCustomer && !window.confirm(`Move ${device.alias || device.hostname} from ${currentClientName} to ${moveClientName}? It will no longer appear for people who only have access to ${currentClientName}.`)) return;

        try {
            setMoveLoading(true);

            await moveDeviceToSite(device.id, siteId);

            const finalClientName = moveClientName || currentClientName || "";
            const finalSiteName = selectedSiteName || "";

            // ✅ Immediate UI update in table
            setPlacementOverride(device.id, {
                client: finalClientName || null,
                site: finalSiteName || null,
            });

            // ✅ Visible confirmation
            toast.success("Device moved successfully");

            setMoveSuccess({
                clientName: finalClientName || "—",
                siteName: finalSiteName || "—",
            });

            // Give the user a moment to see the confirmation in the modal
            await sleep(700);

            setMoveOpen(false);
            // Lists that show this device (by customer, site or filter) fetch their rows again.
            window.dispatchEvent(new CustomEvent(DEVICES_CHANGED_EVENT));
        } catch (e: any) {
            toast.error(e?.message || "Failed to move device");
        } finally {
            setMoveLoading(false);
        }
    };

    const openDeleteDialog = () => {
        setMenuOpen(false);
        setDelReason("");
        setDelTicket(false);
        setDelTried(false);
        setPendingRequest(null);
        // An approver sees who asked and why.
        if (canFinalizeDelete && isDeletionPending) {
            getDeviceDeletionRequest(device.id).then((r) => setPendingRequest(r.request)).catch(() => setPendingRequest(null));
        }
        setDeleteOpen(true);
    };

    const doDeleteOrRequest = async () => {
        if (!canFinalizeDelete) {
            setDelTried(true);
            if (!reasonOk) return;
        }
        try {
            setDeleteLoading(true);

            if (canFinalizeDelete) {
                await approveDeviceDeletion(device.id);
                toast.success("Device deleted");
            } else {
                const r = await requestDeviceDeletion(device.id, { reason: delReason.trim(), createTicket: delTicket });
                toast.success(r?.ticketId ? "Deletion requested, and a ticket was opened for the approval" : "Deletion requested (pending approval)");
            }

            setDeleteOpen(false);
            // best-effort refresh
            (router as any)?.refresh?.();
            window.dispatchEvent(new CustomEvent(DEVICES_CHANGED_EVENT));
        } catch (e: any) {
            toast.error(e?.message || "Delete action failed");
        } finally {
            setDeleteLoading(false);
        }
    };

    return (
        <>
            <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
                {openedAt ? (
                    <>
                        <DropdownMenuTrigger asChild>
                            <CursorAnchor x={openedAt.x} y={openedAt.y} />
                        </DropdownMenuTrigger>
                        <Button
                            ref={triggerRef}
                            variant="ghost"
                            className="h-8 w-8 p-0"
                            onClick={(e) => { e.stopPropagation(); setOpenedAt(null); }}
                            aria-label={`Row actions for ${device.hostname}`}
                            title="Row actions"
                        >
                            <MoreHorizontal className="h-4 w-4" aria-hidden />
                        </Button>
                    </>
                ) : (
                    <DropdownMenuTrigger asChild>
                        <Button
                            ref={triggerRef}
                            variant="ghost"
                            className="h-8 w-8 p-0"
                            onClick={(e) => e.stopPropagation()}
                            aria-label={`Row actions for ${device.hostname}`}
                            title="Row actions"
                        >
                            <MoreHorizontal className="h-4 w-4" aria-hidden />
                        </Button>
                    </DropdownMenuTrigger>
                )}

                <DropdownMenuContent
                    align={atCursor ? "start" : "end"}
                    side="bottom"
                    sideOffset={atCursor ? 3 : 4}
                    alignOffset={atCursor ? 3 : 0}
                    onClick={(e) => e.stopPropagation()}
                >
                    <DropdownMenuLabel>{device.alias || device.hostname}</DropdownMenuLabel>

                    <DropdownMenuSeparator />

                    <DropdownMenuItem
                        onSelect={(e) => {
                            e.preventDefault();
                            setMenuOpen(false);
                            router.push(`/devices/${device.id}`);
                        }}
                    >
                        <ExternalLink className="mr-2 h-4 w-4" />
                        View details
                    </DropdownMenuItem>

                    <DropdownMenuItem
                        onSelect={(e) => {
                            e.preventDefault();
                            openRunScriptHere();
                        }}
                    >
                        <PlaySquare className="mr-2 h-4 w-4" />
                        Run Script…
                    </DropdownMenuItem>

                    <DropdownMenuItem
                        disabled={String(device.status ?? "offline").toLowerCase() === "offline"}
                        onSelect={(e) => {
                            e.preventDefault();
                            void updateAgent();
                        }}
                    >
                        <RefreshCw className="mr-2 h-4 w-4" />
                        Update agent
                    </DropdownMenuItem>

                    {canCreateTicket ? (
                        <DropdownMenuItem
                            onSelect={(e) => {
                                e.preventDefault();
                                setMenuOpen(false);
                                router.push(newTicketHref({ id: device.id, hostname: device.hostname, alias: device.alias, clientId: (device as any).clientId, client: device.client, site: device.site }));
                            }}
                        >
                            <TicketIcon className="mr-2 h-4 w-4" />
                            Create ticket…
                        </DropdownMenuItem>
                    ) : null}

                    <DropdownMenuSeparator />

                    <DropdownMenuItem
                        onSelect={(e) => {
                            e.preventDefault();
                            openMoveDialog();
                        }}
                    >
                        <MoveRight className="mr-2 h-4 w-4" />
                        Move to another site or customer…
                    </DropdownMenuItem>

                    <DropdownMenuSeparator />

                    <DropdownMenuItem
                        onSelect={(e) => {
                            e.preventDefault();
                            setMenuOpen(false);
                            setAliasOpen(true);
                        }}
                    >
                        <Edit3 className="mr-2 h-4 w-4" />
                        Edit alias…
                    </DropdownMenuItem>

                    {device.alias ? (
                        <DropdownMenuItem
                            className="text-destructive focus:text-destructive"
                            onSelect={(e) => {
                                e.preventDefault();
                                setMenuOpen(false);
                                setConfirmClearOpen(true);
                            }}
                        >
                            <Eraser className="mr-2 h-4 w-4" />
                            Clear alias
                        </DropdownMenuItem>
                    ) : null}

                    <DropdownMenuSeparator />

                    {isDeletionPending ? (
                        <DropdownMenuItem disabled>
                            <CheckCircle2 className="mr-2 h-4 w-4" />
                            DELETION PENDING
                        </DropdownMenuItem>
                    ) : null}

                    <DropdownMenuItem
                        className="text-destructive focus:text-destructive"
                        onSelect={(e) => {
                            e.preventDefault();
                            openDeleteDialog();
                        }}
                    >
                        <Trash2 className="mr-2 h-4 w-4" />
                        {canFinalizeDelete ? (isDeletionPending ? "Approve & delete…" : "Delete device…") : "Request deletion…"}
                    </DropdownMenuItem>

                    <DropdownMenuSeparator />

                    <DropdownMenuItem
                        onSelect={(e) => {
                            e.preventDefault();
                            copy(device.hostname, "Hostname");
                        }}
                    >
                        <Copy className="mr-2 h-4 w-4" />
                        Copy hostname
                    </DropdownMenuItem>

                    <DropdownMenuItem
                        onSelect={(e) => {
                            e.preventDefault();
                            copy(device.id, "Device ID");
                        }}
                    >
                        <CircleDot className="mr-2 h-4 w-4" />
                        Copy device ID
                    </DropdownMenuItem>

                    {agentUuid ? (
                        <DropdownMenuItem
                            onSelect={(e) => {
                                e.preventDefault();
                                copy(agentUuid, "Agent UUID");
                            }}
                        >
                            <KeyRound className="mr-2 h-4 w-4" />
                            Copy agent UUID
                        </DropdownMenuItem>
                    ) : null}
                </DropdownMenuContent>
            </DropdownMenu>

            {/* Delete / Request Deletion confirm */}
            <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
                <AlertDialogContent onClick={(e) => e.stopPropagation()}>
                    <AlertDialogHeader>
                        <AlertDialogTitle>{canFinalizeDelete ? "Delete this device?" : "Request device deletion?"}</AlertDialogTitle>
                        <AlertDialogDescription>
                            {canFinalizeDelete
                                ? "This will permanently remove the device endpoint and associated agent records."
                                : "This will mark the device as DELETION PENDING. A user with delete permission must approve and finalize the deletion."}
                        </AlertDialogDescription>
                    </AlertDialogHeader>

                    {canFinalizeDelete && isDeletionPending && pendingRequest ? (
                        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
                            <div className="text-xs text-muted-foreground">
                                Requested{pendingRequest.requestedBy ? ` by ${pendingRequest.requestedBy}` : ""} on {new Date(pendingRequest.requestedAt).toLocaleString()}
                            </div>
                            <div className="mt-1 whitespace-pre-wrap break-words">{pendingRequest.reason || "No reason was given."}</div>
                            {pendingRequest.ticketId ? (
                                <a href={`/tickets/${pendingRequest.ticketId}`} className="mt-1 inline-block text-xs underline underline-offset-2" target="_blank" rel="noreferrer">Open the approval ticket</a>
                            ) : null}
                        </div>
                    ) : null}

                    {!canFinalizeDelete ? (
                        <div className="grid gap-2 text-sm">
                            <label htmlFor="del-reason" className={delTried && !reasonOk ? "font-medium text-destructive" : "font-medium"}>Why should this device be removed? *</label>
                            <textarea
                                id="del-reason"
                                rows={3}
                                maxLength={500}
                                value={delReason}
                                aria-invalid={delTried && !reasonOk}
                                onChange={(e) => setDelReason(e.target.value)}
                                placeholder="For example: replaced by a new laptop, customer has left"
                                className={`w-full rounded-lg border bg-card/60 p-2 text-sm focus:outline-none focus:ring-2 focus:ring-[hsl(var(--primary))] ${delTried && !reasonOk ? "border-destructive" : "border-input"}`}
                            />
                            <p className={`min-h-4 text-xs ${delTried && !reasonOk ? "text-destructive" : "text-muted-foreground"}`}>
                                {delTried && !reasonOk ? "Say why, in a few words" : `${delReason.trim().length}/500`}
                            </p>
                            <label className="flex items-start gap-2">
                                <input type="checkbox" className="mt-1" checked={delTicket} onChange={(e) => setDelTicket(e.target.checked)} />
                                <span>Also open a ticket for the approval <span className="text-xs text-muted-foreground">(the approver sees your reason either way)</span></span>
                            </label>
                        </div>
                    ) : null}

                    <AlertDialogFooter>
                        <AlertDialogCancel disabled={deleteLoading}>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                            disabled={deleteLoading}
                            onClick={(e) => { e.preventDefault(); void doDeleteOrRequest(); }}
                            title={canFinalizeDelete ? "Delete device" : "Request deletion"}
                        >
                            {deleteLoading ? "Working…" : canFinalizeDelete ? "Delete" : "Request"}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>

            {/* Move-to-site dialog */}
            <Dialog open={moveOpen} onOpenChange={setMoveOpen}>
                <DialogContent onClick={(e) => e.stopPropagation()} className="sm:max-w-[560px]">
                    <DialogHeader>
                        <DialogTitle>Move device</DialogTitle>
                        <DialogDescription>Pick a customer and a site. Moving to another customer re-files the device under it.</DialogDescription>
                    </DialogHeader>

                    <div className="space-y-4 py-2">
                        {/* Success banner */}
                        {moveSuccess ? (
                            <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900 dark:border-emerald-900/40 dark:bg-emerald-950/40 dark:text-emerald-200">
                                <div className="flex items-start gap-2">
                                    <CheckCircle2 className="mt-0.5 h-4 w-4" aria-hidden="true" />
                                    <div>
                                        <div className="font-medium">Move successful</div>
                                        <div className="text-xs opacity-90">
                                            Now in <span className="font-medium">{moveSuccess.clientName}</span> →{" "}
                                            <span className="font-medium">{moveSuccess.siteName}</span>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        ) : null}

                        <div className="rounded-lg border p-3">
                            <div className="text-sm font-medium">{device.alias || device.hostname}</div>
                            <div className="text-xs text-muted-foreground">{device.hostname}</div>
                            <div className="mt-2 text-xs text-muted-foreground">
                                Current:{" "}
                                <span className="font-medium text-foreground">{moveClientName || currentClientName || "—"}</span> →{" "}
                                <span className="font-medium text-foreground">{currentSiteName || "—"}</span>
                            </div>
                        </div>

                        {/* Customer picker */}
                        <div className="space-y-2">
                            <label htmlFor="move-customer" className="text-sm font-medium">Customer</label>
                            <select
                                id="move-customer"
                                className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                                value={moveClientId}
                                onChange={(e) => void chooseClient(e.target.value)}
                                disabled={moveLoading || sitesLoading || !!moveSuccess || moveClients.length === 0}
                            >
                                {moveClients.map((c) => (
                                    <option key={c.id} value={c.id}>{c.name}{c.id === homeClientId ? " (current)" : ""}</option>
                                ))}
                            </select>
                            {changingCustomer ? (
                                <div role="status" className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
                                    This moves the device from <b>{currentClientName}</b> to <b>{moveClientName}</b>. Its alerts and policies follow it, and people limited to {currentClientName} will no longer see it.
                                    Tickets already linked to it stay as they are. The agent keeps working; reinstalling it needs an install key from {moveClientName}.
                                </div>
                            ) : null}
                        </div>

                        {/* Site picker */}
                        <div className="space-y-2">
                            <div className="flex items-center gap-2">
                                <MapPin className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                                <div className="text-sm font-medium">Site</div>
                                {(moveClientName || currentClientName) ? (
                                    <span className="text-xs text-muted-foreground">for {moveClientName || currentClientName}</span>
                                ) : null}
                            </div>

                            <Input
                                placeholder={sitesLoading ? "Loading sites…" : "Search sites…"}
                                value={siteQuery}
                                onChange={(e) => setSiteQuery(e.target.value)}
                                disabled={sitesLoading || moveLoading || !moveClientName || !!moveSuccess}
                            />

                            <div className="max-h-52 overflow-auto rounded-md border">
                                {sitesLoading ? (
                                    <div className="p-3 text-sm text-muted-foreground">Loading sites…</div>
                                ) : filteredSites.length ? (
                                    filteredSites.map((s) => {
                                        const active = s.id === selectedSiteId;
                                        const isCurrent = normalizeName(s.name) === normalizeName(currentSiteName);

                                        return (
                                            <button
                                                key={s.id}
                                                type="button"
                                                className={[
                                                    "flex w-full items-center justify-between px-3 py-2 text-left text-sm",
                                                    "hover:bg-muted/60",
                                                    active ? "bg-muted" : "",
                                                    isCurrent ? "opacity-70" : "",
                                                ].join(" ")}
                                                onClick={() => setSelectedSiteId(s.id)}
                                                disabled={moveLoading || !!moveSuccess}
                                                title={isCurrent ? "Current site" : "Select site"}
                                            >
                                                <span className="truncate">{s.name}</span>
                                                {isCurrent ? (
                                                    <span className="text-xs text-muted-foreground">Current</span>
                                                ) : active ? (
                                                    <span className="text-xs text-muted-foreground">Selected</span>
                                                ) : null}
                                            </button>
                                        );
                                    })
                                ) : (
                                    <div className="p-3 text-sm text-muted-foreground">No sites found</div>
                                )}
                            </div>
                        </div>

                        {/* Summary */}
                        <div className="rounded-lg border bg-muted/30 p-3 text-sm">
                            <div className="flex items-center justify-between">
                                <span className="text-muted-foreground">Target</span>
                                <span className="font-medium">
                                    {(moveClientName || currentClientName) && selectedSiteName
                                        ? `${moveClientName || currentClientName} → ${selectedSiteName}`
                                        : (moveClientName || currentClientName)
                                            ? `${moveClientName || currentClientName} → (pick a site)`
                                            : "(pick a site)"}
                                </span>
                            </div>
                        </div>
                    </div>

                    <DialogFooter>
                        <Button variant="outline" onClick={() => setMoveOpen(false)} disabled={moveLoading} title="Cancel">
                            Cancel
                        </Button>
                        <Button onClick={doMove} disabled={!selectedSiteId || moveLoading || !!moveSuccess} title="Move device">
                            {moveLoading ? "Moving…" : moveSuccess ? "Moved" : "Move"}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Alias dialog */}
            <Dialog open={aliasOpen} onOpenChange={setAliasOpen}>
                <DialogContent onClick={(e) => e.stopPropagation()}>
                    <DialogHeader>
                        <DialogTitle>Edit alias</DialogTitle>
                        <DialogDescription>Set a friendly name for this device.</DialogDescription>
                    </DialogHeader>
                    <div className="py-2">
                        <Input
                            autoFocus
                            placeholder="e.g., Accounting File Server"
                            value={aliasValue}
                            onChange={(e) => setAliasValue(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter") saveAlias();
                            }}
                        />
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setAliasOpen(false)} title="Cancel">
                            Cancel
                        </Button>
                        <Button onClick={saveAlias} title="Save alias">
                            Save
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Clear alias confirm */}
            <AlertDialog open={confirmClearOpen} onOpenChange={setConfirmClearOpen}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Clear alias?</AlertDialogTitle>
                        <AlertDialogDescription>This will remove the alias for this device.</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                            onClick={confirmClearAlias}
                            title="Confirm clear alias"
                        >
                            Clear alias
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </>
    );
}
