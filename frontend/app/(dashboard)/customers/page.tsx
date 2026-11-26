"use client";

import { PageHeader } from "@/components/page-shell";
import * as React from "react";
import { ChevronDown, Plus, SlidersHorizontal } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import {
    useDashboard,
    type Device,
    type DeviceStatus,
} from "@/app/(dashboard)/dashboard-context";
import { useCustomers } from "@/app/(dashboard)/customers/customers-context";
import { useDemoMode } from "@/lib/demo";
import { CustomerForm } from "@/components/customers/customer-form";
import { SiteFormDialog } from "@/components/customers/site-form";
import FiltersRail from "@/components/filters-rail";
import DeviceTable from "@/components/device-table";
import { CustomersOverview } from "@/components/customers/customers-overview";
import { CustomerSitesView } from "@/components/customers/customer-sites-view";
import { PortalAccessDialog } from "@/components/customers/portal-access-dialog";

import PermGate from "@/components/perm-gate";
import { CustomerUpdateRing } from "@/components/update-ring";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { removals } from "@/lib/device-removals-api";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";

import {
    jfetch,
    createCustomerSite,
    fetchCustomers,
    fetchCustomerSites,
    deleteCustomerClient,
    deleteCustomerSite,
    type CustomerClient,
    getInstallerBundle,
    startBrowserDownload,
    type InstallerOs,
} from "@/lib/api";

type Flash = { kind: "success" | "error"; text: string } | null;
type SiteOption = { key: string; name: string };

// Prefer IDs if present (new backend payload), otherwise fall back to display names
function getDeviceClientKey(d: Device): string {
    const anyD = d as any;
    return String(anyD?.clientId ?? d.client ?? "").trim();
}
function getDeviceSiteKey(d: Device): string {
    const anyD = d as any;
    return String(anyD?.siteId ?? d.site ?? "").trim();
}

// Backend DTO result for reusable enrollment key
type CreateEnrollmentKeyResult = {
    enrollmentKey: string; // raw token returned ONCE
    tokenId: string; // uuid
    expiresAt: string; // ISO
    clientId: string;
    siteId: string;
    name: string | null;
};

function CustomersActions() {
    const [flash, setFlash] = React.useState<Flash>(null);

    // -------------------------
    // Customers CRUD
    // -------------------------
    const [createClientOpen, setCreateClientOpen] = React.useState(false);
    const [editCustomerOpen, setEditCustomerOpen] = React.useState(false);
    const [portalOpen, setPortalOpen] = React.useState(false);
    const [editSiteOpen, setEditSiteOpen] = React.useState(false);

    const [createSiteOpen, setCreateSiteOpen] = React.useState(false);
    const [siteName, setSiteName] = React.useState("");
    const [siteClientId, setSiteClientId] = React.useState<string>("");
    const [creatingSite, setCreatingSite] = React.useState(false);

    const [deleteOpen, setDeleteOpen] = React.useState(false);
    const [deleteMode, setDeleteMode] = React.useState<"client" | "site">("client");
    const [deleteClientId, setDeleteClientId] = React.useState<string>("");
    const [deleteSiteId, setDeleteSiteId] = React.useState<string>("");
    const [sites, setSites] = React.useState<SiteOption[]>([]);
    const [sitesLoading, setSitesLoading] = React.useState(false);
    const [deleting, setDeleting] = React.useState(false);

    const [clients, setClients] = React.useState<CustomerClient[]>([]);
    const [clientsLoading, setClientsLoading] = React.useState(false);

    // -------------------------
    // Remote access notice: what the person at a customer's devices is told when a technician connects
    // -------------------------
    type ConsentMode = "off" | "notice" | "consent";
    const [accessOpen, setAccessOpen] = React.useState(false);
    const [accessClientId, setAccessClientId] = React.useState<string>("");
    const [accessMode, setAccessMode] = React.useState<ConsentMode>("notice");
    // Whether Remote Console sessions on this customer's devices are recorded (off unless someone turns it on).
    const [accessRecord, setAccessRecord] = React.useState(false);
    // Which video codec Remote Console may use for this customer's devices.
    type VideoCodec = "auto" | "vp8" | "h264";
    const [accessCodec, setAccessCodec] = React.useState<VideoCodec>("auto");
    const [accessLoading, setAccessLoading] = React.useState(false);
    const [accessSaving, setAccessSaving] = React.useState(false);

    // The client list is only loaded when a dialog that needs it opens, so this one has to ask for it too.
    React.useEffect(() => {
        if (accessOpen) void refreshClients();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [accessOpen]);

    // Start on the first client, so the setting can be read straight away.
    React.useEffect(() => {
        if (accessOpen && !accessClientId && clients[0]?.key) setAccessClientId(clients[0].key);
    }, [accessOpen, accessClientId, clients]);

    React.useEffect(() => {
        if (!accessOpen || !accessClientId) return;
        let cancelled = false;
        setAccessLoading(true);
        jfetch<{ consent: ConsentMode; record?: boolean; codec?: VideoCodec }>(`/api/customers/${encodeURIComponent(accessClientId)}/remote-console`)
            .then((r) => {
                if (cancelled) return;
                if (r?.consent === "off" || r?.consent === "notice" || r?.consent === "consent") setAccessMode(r.consent);
                setAccessRecord(r?.record === true);
                setAccessCodec(r?.codec === "vp8" || r?.codec === "h264" ? r.codec : "auto");
            })
            .catch(() => {
                if (!cancelled) setFlash({ kind: "error", text: "Could not load this customer's remote access setting." });
            })
            .finally(() => {
                if (!cancelled) setAccessLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [accessOpen, accessClientId]);

    const saveAccessMode = async () => {
        if (!accessClientId) return;
        setAccessSaving(true);
        setFlash(null);
        try {
            await jfetch(`/api/customers/${encodeURIComponent(accessClientId)}/remote-console`, {
                method: "PATCH",
                body: { consent: accessMode, record: accessRecord, codec: accessCodec },
            });
            const name = clients.find((c) => c.key === accessClientId)?.name ?? "the customer";
            setFlash({ kind: "success", text: `Remote access setting saved for ${name}.` });
            setAccessOpen(false);
        } catch (e: any) {
            setFlash({ kind: "error", text: e?.message || "Could not save the remote access setting." });
        } finally {
            setAccessSaving(false);
        }
    };

    // -------------------------
    // Rename a customer or one of its sites
    // -------------------------
    const [renameOpen, setRenameOpen] = React.useState(false);
    const [renameMode, setRenameMode] = React.useState<"client" | "site">("client");
    const [renameClientId, setRenameClientId] = React.useState<string>("");
    const [renameSites, setRenameSites] = React.useState<SiteOption[]>([]);
    const [renameSiteId, setRenameSiteId] = React.useState<string>("");
    const [renameName, setRenameName] = React.useState("");
    const [renaming, setRenaming] = React.useState(false);

    React.useEffect(() => {
        if (renameOpen) void refreshClients();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [renameOpen]);

    React.useEffect(() => {
        if (renameOpen && !renameClientId && clients[0]?.key) setRenameClientId(clients[0].key);
    }, [renameOpen, renameClientId, clients]);

    // The sites are only needed when renaming a site.
    React.useEffect(() => {
        if (!renameOpen || renameMode !== "site" || !renameClientId) {
            setRenameSites([]);
            setRenameSiteId("");
            return;
        }
        let cancelled = false;
        fetchCustomerSites(renameClientId)
            .then((res) => {
                if (cancelled) return;
                const list: SiteOption[] = (res ?? [])
                    .map((s: any) => ({ key: String(s.key ?? s.id ?? ""), name: String(s.name ?? s.label ?? "") }))
                    .filter((s) => s.key && s.name);
                setRenameSites(list);
                setRenameSiteId(list[0]?.key ?? "");
            })
            .catch((e: any) => {
                if (!cancelled) setFlash({ kind: "error", text: e?.message || "Failed to load sites." });
            });
        return () => {
            cancelled = true;
        };
    }, [renameOpen, renameMode, renameClientId]);

    // Start the box on the current name, so a small fix is a small edit.
    React.useEffect(() => {
        if (!renameOpen) return;
        const current =
            renameMode === "client"
                ? clients.find((c) => c.key === renameClientId)?.name
                : renameSites.find((s) => s.key === renameSiteId)?.name;
        setRenameName(current ?? "");
    }, [renameOpen, renameMode, renameClientId, renameSiteId, clients, renameSites]);

    const currentRenameName =
        renameMode === "client"
            ? clients.find((c) => c.key === renameClientId)?.name ?? ""
            : renameSites.find((s) => s.key === renameSiteId)?.name ?? "";
    const renameUnchanged = renameName.trim() === "" || renameName.trim() === currentRenameName;

    const submitRename = async () => {
        const name = renameName.trim();
        if (!name || (renameMode === "site" && !renameSiteId) || !renameClientId) return;
        setRenaming(true);
        setFlash(null);
        try {
            const path =
                renameMode === "client"
                    ? `/api/customers/${encodeURIComponent(renameClientId)}`
                    : `/api/customers/${encodeURIComponent(renameClientId)}/sites/${encodeURIComponent(renameSiteId)}`;
            await jfetch(path, { method: "PATCH", body: { name } });
            setFlash({ kind: "success", text: `Renamed to ${name}.` });
            setRenameOpen(false);
            emitCustomersChanged();
            void refreshClients();
        } catch (e: any) {
            setFlash({ kind: "error", text: e?.message || "Could not rename." });
        } finally {
            setRenaming(false);
        }
    };

    // -------------------------
    // Reusable Installer (Option A)
    // -------------------------
    const demoMode = useDemoMode();
    const [installerOpen, setInstallerOpen] = React.useState(false);
    const [installerClientId, setInstallerClientId] = React.useState<string>("");
    const [installerSiteId, setInstallerSiteId] = React.useState<string>("");
    const [installerSites, setInstallerSites] = React.useState<SiteOption[]>([]);
    const [installerSitesLoading, setInstallerSitesLoading] = React.useState(false);

    const [installBundle, setInstallBundle] = React.useState<{ os: InstallerOs; command: string; url: string } | null>(null);

    const [keyName, setKeyName] = React.useState<string>("");
    const [keyExpiresMinutes, setKeyExpiresMinutes] = React.useState<string>("10080"); // 7 days default
    // A script that runs on every start-up (Group Policy) must leave machines that already have the agent alone.
    const [gpoMode, setGpoMode] = React.useState(false);
    const [creatingKey, setCreatingKey] = React.useState(false);
    const [keyResult, setKeyResult] = React.useState<CreateEnrollmentKeyResult | null>(null);

    const [downloadingInstaller, setDownloadingInstaller] = React.useState<InstallerOs | null>(null);

    const emitCustomersChanged = React.useCallback(() => {
        try {
            window.dispatchEvent(new CustomEvent("adgrmm:customers-changed"));
        } catch {
            // ignore
        }
    }, []);

    const refreshClients = React.useCallback(async () => {
        setClientsLoading(true);
        try {
            const list = await fetchCustomers();
            setClients(list ?? []);

            if (!siteClientId && list?.[0]?.key) setSiteClientId(list[0].key);
            if (!deleteClientId && list?.[0]?.key) setDeleteClientId(list[0].key);

            if (!installerClientId && list?.[0]?.key) setInstallerClientId(list[0].key);
        } catch (e: any) {
            setFlash({ kind: "error", text: e?.message || "Failed to load customers." });
        } finally {
            setClientsLoading(false);
        }
    }, [siteClientId, deleteClientId, installerClientId]);

    const refreshSitesForDeleteClient = React.useCallback(async (clientKey: string) => {
        if (!clientKey || clientKey === "__none") {
            setSites([]);
            setDeleteSiteId("");
            return;
        }

        setSitesLoading(true);
        try {
            const res = await fetchCustomerSites(clientKey);
            const normalized: SiteOption[] = (res ?? [])
                .map((s: any) => ({
                    key: String(s.key ?? s.id ?? ""),
                    name: String(s.name ?? s.label ?? ""),
                }))
                .filter((s) => s.key && s.name);

            setSites(normalized);
            setDeleteSiteId(normalized[0]?.key ?? "");
        } catch (e: any) {
            setSites([]);
            setDeleteSiteId("");
            setFlash({ kind: "error", text: e?.message || "Failed to load sites." });
        } finally {
            setSitesLoading(false);
        }
    }, []);

    const refreshInstallerSites = React.useCallback(
        async (clientKey: string) => {
            if (!clientKey || clientKey === "__none") {
                setInstallerSites([]);
                setInstallerSiteId("");
                return;
            }

            setInstallerSitesLoading(true);
            try {
                const res = await fetchCustomerSites(clientKey);
                const normalized: SiteOption[] = (res ?? [])
                    .map((s: any) => ({
                        key: String(s.key ?? s.id ?? ""),
                        name: String(s.name ?? s.label ?? ""),
                    }))
                    .filter((s) => s.key && s.name);

                setInstallerSites(normalized);

                if (normalized.length === 0) {
                    setInstallerSiteId("");
                } else {
                    const stillValid = normalized.some((x) => x.key === installerSiteId);
                    if (!installerSiteId || !stillValid) setInstallerSiteId(normalized[0].key);
                }
            } catch (e: any) {
                setInstallerSites([]);
                setInstallerSiteId("");
                setFlash({ kind: "error", text: e?.message || "Failed to load sites." });
            } finally {
                setInstallerSitesLoading(false);
            }
        },
        [installerSiteId]
    );

    React.useEffect(() => {
        if (createSiteOpen) void refreshClients();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [createSiteOpen]);

    React.useEffect(() => {
        if (!deleteOpen) return;
        void refreshClients();
        setFlash(null);

        if (deleteMode === "site") {
            void refreshSitesForDeleteClient(deleteClientId || siteClientId || "");
        } else {
            setSites([]);
            setDeleteSiteId("");
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [deleteOpen]);

    React.useEffect(() => {
        if (!deleteOpen) return;
        if (deleteMode === "site") void refreshSitesForDeleteClient(deleteClientId || "");
        else {
            setSites([]);
            setDeleteSiteId("");
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [deleteMode]);

    React.useEffect(() => {
        if (!deleteOpen) return;
        if (deleteMode !== "site") return;
        void refreshSitesForDeleteClient(deleteClientId);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [deleteClientId]);

    React.useEffect(() => {
        if (!installerOpen) return;

        void refreshClients();
        setFlash(null);
        setKeyResult(null);
        setKeyName("");
        // Starts at the default lifetime set under Administration > Agents & Endpoints (a week when none is set).
        setKeyExpiresMinutes("10080");
        void jfetch<{ expiresMinutes: number }>("/api/provisioning/enrollment-key-defaults")
            .then((d) => { if (d?.expiresMinutes >= 1) setKeyExpiresMinutes(String(d.expiresMinutes)); })
            .catch(() => { /* the form keeps its own default */ });

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [installerOpen]);

    React.useEffect(() => {
        if (!installerOpen) return;
        if (!installerClientId) return;
        void refreshInstallerSites(installerClientId);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [installerClientId, installerOpen]);

    const submitCreateSite = async () => {
        const name = siteName.trim();
        if (!siteClientId || siteClientId === "__none") {
            setFlash({ kind: "error", text: "Select a customer first." });
            return;
        }
        if (!name) {
            setFlash({ kind: "error", text: "Site name is required." });
            return;
        }

        setCreatingSite(true);
        setFlash(null);
        try {
            const res = await createCustomerSite(siteClientId, { name });
            setFlash({ kind: "success", text: `Site created: ${res?.name || name}` });
            setSiteName("");
            setCreateSiteOpen(false);

            await refreshClients();
            emitCustomersChanged();
        } catch (e: any) {
            setFlash({ kind: "error", text: e?.message || "Create site failed." });
        } finally {
            setCreatingSite(false);
        }
    };

    const submitDelete = async () => {
        setFlash(null);

        if (deleteMode === "client") {
            if (!deleteClientId || deleteClientId === "__none") {
                setFlash({ kind: "error", text: "Select a client to delete." });
                return;
            }
        } else {
            if (!deleteClientId || deleteClientId === "__none") {
                setFlash({ kind: "error", text: "Select a client first." });
                return;
            }
            if (!deleteSiteId || deleteSiteId === "__none") {
                setFlash({ kind: "error", text: "Select a site to delete." });
                return;
            }
        }

        setDeleting(true);
        try {
            if (deleteMode === "client") {
                await deleteCustomerClient(deleteClientId, { force: false });
                setFlash({ kind: "success", text: "Client deleted." });
            } else {
                await deleteCustomerSite(deleteClientId, deleteSiteId);
                setFlash({ kind: "success", text: "Site deleted." });
            }

            await refreshClients();
            if (deleteMode === "site") await refreshSitesForDeleteClient(deleteClientId);

            emitCustomersChanged();
            setDeleteOpen(false);
        } catch (e: any) {
            setFlash({ kind: "error", text: e?.message || "Delete failed." });
        } finally {
            setDeleting(false);
        }
    };

    const copy = React.useCallback(async (text: string) => {
        try {
            await navigator.clipboard.writeText(text);
            setFlash({ kind: "success", text: "Copied to clipboard." });
        } catch {
            setFlash({ kind: "error", text: "Copy failed." });
        }
    }, []);

    const submitCreateEnrollmentKey = async () => {
        setFlash(null);

        const clientId = String(installerClientId || "").trim();
        const siteId = String(installerSiteId || "").trim();
        const name = keyName.trim();
        const expiresRaw = String(keyExpiresMinutes || "").trim();
        const expiresMinutes = Number.parseInt(expiresRaw, 10);

        if (!clientId || clientId === "__none") {
            setFlash({ kind: "error", text: "Select a client." });
            return;
        }
        if (!siteId || siteId === "__none") {
            setFlash({ kind: "error", text: "Select a site." });
            return;
        }
        if (!Number.isFinite(expiresMinutes) || expiresMinutes < 1 || expiresMinutes > 5259600) {
            setFlash({ kind: "error", text: "Choose how long the key lasts." });
            return;
        }

        setCreatingKey(true);
        try {
            const res = await jfetch<CreateEnrollmentKeyResult>(`/api/provisioning/enrollment-keys`, {
                method: "POST",
                body: {
                    clientId,
                    siteId,
                    name: name || undefined,
                    expiresMinutes,
                },
            });

            setKeyResult(res);
            setInstallBundle(null);
            setFlash({
                kind: "success",
                text: `Reusable enrollment key created. Expires at ${new Date(res.expiresAt).toLocaleString()}.`,
            });
        } catch (e: any) {
            setKeyResult(null);
            setFlash({ kind: "error", text: e?.message || "Failed to create enrollment key." });
        } finally {
            setCreatingKey(false);
        }
    };

    // Prepares the installer for one OS. The same link serves the command and the download.
    const prepareInstaller = React.useCallback(
        async (os: InstallerOs) => {
            if (!keyResult?.enrollmentKey) return;

            setFlash(null);
            setDownloadingInstaller(os);

            try {
                const bundle = await getInstallerBundle({
                    os,
                    enrollmentKey: keyResult.enrollmentKey,
                    onlyIfMissing: gpoMode,
                });

                setInstallBundle({ os, command: bundle.installCommand ?? "", url: bundle.url });
            } catch (e: any) {
                setInstallBundle(null);
                setFlash({ kind: "error", text: e?.message || "Failed to prepare the installer." });
            } finally {
                setDownloadingInstaller(null);
            }
        },
        [keyResult, gpoMode]
    );

    return (
        <div className="space-y-3">
            {flash && (
                <div
                    className={[
                        "rounded-md border px-3 py-2 text-sm",
                        flash.kind === "success"
                            ? "border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-200"
                            : "border-red-200 bg-red-50 text-red-900 dark:border-red-700 dark:bg-red-900/20 dark:text-red-200",
                    ].join(" ")}
                >
                    {flash.text}
                </div>
            )}

            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
                <PermGate
                    require="customers.write"
                    title="No permission"
                    message="You don’t have permission to create or delete customers/sites."
                >
                    <div className="flex flex-wrap items-center gap-2">
                        {/* New and edit customer: the whole record, branding included */}
                        <DropdownMenu modal={false}>
                            <DropdownMenuTrigger asChild>
                                <Button variant="success">
                                    <Plus className="mr-1 h-4 w-4" aria-hidden /> New <ChevronDown className="ml-1 h-4 w-4" aria-hidden />
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="start">
                                <DropdownMenuItem onSelect={() => setCreateClientOpen(true)}>New customer</DropdownMenuItem>
                                <DropdownMenuItem onSelect={() => setCreateSiteOpen(true)}>New site</DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>
                        <DropdownMenu modal={false}>
                            <DropdownMenuTrigger asChild>
                                <Button variant="outline">
                                    Customer <ChevronDown className="ml-1 h-4 w-4" aria-hidden />
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="start">
                                <DropdownMenuItem onSelect={() => { void refreshClients(); setEditCustomerOpen(true); }}>Edit details</DropdownMenuItem>
                                <DropdownMenuItem onSelect={() => { setRenameMode("client"); setRenameOpen(true); }}>Rename</DropdownMenuItem>
                                <DropdownMenuItem onSelect={() => setAccessOpen(true)}>Remote access notice</DropdownMenuItem>
                                <DropdownMenuItem onSelect={() => setPortalOpen(true)}>Portal access</DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => { setDeleteMode("client"); setDeleteOpen(true); }}>Delete customer</DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>
                        <DropdownMenu modal={false}>
                            <DropdownMenuTrigger asChild>
                                <Button variant="outline">
                                    Site <ChevronDown className="ml-1 h-4 w-4" aria-hidden />
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="start">
                                <DropdownMenuItem onSelect={() => setEditSiteOpen(true)}>Edit details</DropdownMenuItem>
                                <DropdownMenuItem onSelect={() => { setRenameMode("site"); setRenameOpen(true); }}>Rename</DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => { setDeleteMode("site"); setDeleteOpen(true); }}>Delete site</DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>
                        {!demoMode && <Button variant="outline" onClick={() => setInstallerOpen(true)}>Reusable installer</Button>}
                        <SiteFormDialog
                            open={editSiteOpen}
                            onOpenChange={setEditSiteOpen}
                            onSaved={(saved) => {
                                setFlash({ kind: "success", text: `Saved: ${saved.name}` });
                                emitCustomersChanged();
                            }}
                        />
                        <CustomerForm
                            open={createClientOpen}
                            onOpenChange={setCreateClientOpen}
                            mode="create"
                            onSaved={(saved) => {
                                const inv = saved.portalInvites;
                                setFlash({
                                    kind: "success",
                                    text: `Customer created: ${saved.name}${inv && inv.invited > 0 ? `. ${inv.invited} ${inv.invited === 1 ? "person was" : "people were"} invited to the client portal as managers.` : ""}${inv && inv.failed > 0 ? ` ${inv.failed} could not be emailed; resend from Customer > Portal access.` : ""}`,
                                });
                                void refreshClients();
                                emitCustomersChanged();
                            }}
                        />
                        <CustomerForm
                            open={editCustomerOpen}
                            onOpenChange={setEditCustomerOpen}
                            mode="edit"
                            customers={clients.map((c) => ({ id: c.key, name: c.name }))}
                            onSaved={(saved) => {
                                setFlash({ kind: "success", text: `Saved: ${saved.name}` });
                                void refreshClients();
                                emitCustomersChanged();
                            }}
                        />

                        <PortalAccessDialog open={portalOpen} onOpenChange={setPortalOpen} />

                        {/* Remote access notice: what the person at the device sees when a technician connects */}
                        <Dialog open={accessOpen} onOpenChange={setAccessOpen}>

                            <DialogContent className="sm:max-w-[560px]">
                                <DialogHeader>
                                    <DialogTitle>Remote access notice</DialogTitle>
                                    <DialogDescription>
                                        Choose what the person at this customer&apos;s devices sees when a technician starts Remote Console.
                                        Devices with nobody signed in are never asked, so unattended access keeps working.
                                    </DialogDescription>
                                </DialogHeader>

                                <div className="grid gap-4 py-2">
                                    <div className="grid gap-2">
                                        <Label>Client</Label>
                                        <Select value={accessClientId} onValueChange={setAccessClientId}>
                                            <SelectTrigger>
                                                <SelectValue placeholder={clientsLoading ? "Loading..." : "Select a client"} />
                                            </SelectTrigger>
                                            <SelectContent>
                                                {clients.map((c) => (
                                                    <SelectItem key={c.key} value={c.key}>
                                                        {c.name}
                                                    </SelectItem>
                                                ))}
                                                {clients.length === 0 ? (
                                                    <SelectItem value="__none" disabled>
                                                        No clients
                                                    </SelectItem>
                                                ) : null}
                                            </SelectContent>
                                        </Select>
                                    </div>

                                    <div className="grid gap-2">
                                        <Label>When a technician connects</Label>
                                        <Select
                                            value={accessMode}
                                            onValueChange={(v) => setAccessMode(v as ConsentMode)}
                                            disabled={!accessClientId || accessLoading}
                                        >
                                            <SelectTrigger>
                                                <SelectValue />
                                            </SelectTrigger>
                                            <SelectContent>
                                                <SelectItem value="notice">Show a notice (default)</SelectItem>
                                                <SelectItem value="consent">Ask for permission first</SelectItem>
                                                <SelectItem value="off">Show nothing</SelectItem>
                                            </SelectContent>
                                        </Select>
                                        <p className="text-xs text-muted-foreground">
                                            {accessMode === "consent"
                                                ? "The person at the device must click Yes within 30 seconds. If they say no, or do not answer, the session is refused."
                                                : accessMode === "notice"
                                                    ? "A message tells the person at the device who connected. It disappears on its own."
                                                    : "Nothing is shown at the device."}
                                            {" "}Needs agent 1.3.14 or later on the device.
                                        </p>
                                    </div>

                                    <div className="grid gap-2 rounded-md border p-3">
                                        <div className="flex items-center justify-between gap-3">
                                            <Label htmlFor="rec-sessions">Record remote sessions</Label>
                                            <Switch
                                                id="rec-sessions"
                                                checked={accessRecord}
                                                onCheckedChange={setAccessRecord}
                                                disabled={!accessClientId || accessLoading}
                                            />
                                        </div>
                                        <p className="text-xs text-muted-foreground">
                                            {accessRecord
                                                ? "Each Remote Console session on this customer's devices is recorded (the picture, no sound) and kept for the retention period set on the Recordings page. The person at the device is always told the session is recorded, even if you chose to show nothing above."
                                                : "Off: nothing is recorded. Recording is made in the technician's browser while the session runs."}
                                        </p>
                                    </div>
                                    <div className="grid gap-2">
                                        <Label>Remote video codec</Label>
                                        <Select value={accessCodec} onValueChange={(v) => setAccessCodec(v as VideoCodec)} disabled={!accessClientId || accessLoading}>
                                            <SelectTrigger>
                                                <SelectValue />
                                            </SelectTrigger>
                                            <SelectContent>
                                                <SelectItem value="auto">Auto (default)</SelectItem>
                                                <SelectItem value="vp8">VP8</SelectItem>
                                                <SelectItem value="h264">H.264</SelectItem>
                                            </SelectContent>
                                        </Select>
                                        <p className="text-xs text-muted-foreground">
                                            {accessCodec === "h264"
                                                ? "H.264 whenever the device can encode it and the browser can show it, using the graphics card or else Windows' own encoder, which can look worse than VP8. Otherwise VP8."
                                                : accessCodec === "vp8"
                                                    ? "Always VP8, which works everywhere."
                                                    : "VP8, unless the device has a graphics card H.264 encoder that passed a test at start-up, which cuts delay and processor use."}
                                            {" "}A device that cannot do it, or whose H.264 fails, goes back to VP8 by itself. Windows devices only.
                                        </p>
                                    </div>
                                    {accessClientId ? <CustomerUpdateRing clientId={accessClientId} /> : null}
                                </div>

                                <DialogFooter>
                                    <Button variant="outline" type="button" onClick={() => setAccessOpen(false)} disabled={accessSaving}>
                                        Cancel
                                    </Button>
                                    <Button
                                        variant="success"
                                        type="button"
                                        onClick={saveAccessMode}
                                        disabled={!accessClientId || accessLoading || accessSaving}
                                    >
                                        {accessSaving ? "Saving..." : "Save"}
                                    </Button>
                                </DialogFooter>
                            </DialogContent>
                        </Dialog>

                        {/* Rename a customer or one of its sites */}
                        <Dialog open={renameOpen} onOpenChange={setRenameOpen}>

                            <DialogContent className="sm:max-w-[520px]">
                                <DialogHeader>
                                    <DialogTitle>Rename</DialogTitle>
                                    <DialogDescription>
                                        Change the name of a customer or of one of its sites. Devices, tickets and installers keep working,
                                        because they follow the customer, not its name.
                                    </DialogDescription>
                                </DialogHeader>

                                <div className="grid gap-4 py-2">
                                    <div className="grid gap-2">
                                        <Label>What to rename</Label>
                                        <Select value={renameMode} onValueChange={(v) => setRenameMode(v as "client" | "site")}>
                                            <SelectTrigger>
                                                <SelectValue />
                                            </SelectTrigger>
                                            <SelectContent>
                                                <SelectItem value="client">A customer</SelectItem>
                                                <SelectItem value="site">A site</SelectItem>
                                            </SelectContent>
                                        </Select>
                                    </div>

                                    <div className="grid gap-2">
                                        <Label>Customer</Label>
                                        <Select value={renameClientId} onValueChange={setRenameClientId}>
                                            <SelectTrigger>
                                                <SelectValue placeholder={clientsLoading ? "Loading..." : "Select a customer"} />
                                            </SelectTrigger>
                                            <SelectContent>
                                                {clients.map((c) => (
                                                    <SelectItem key={c.key} value={c.key}>
                                                        {c.name}
                                                    </SelectItem>
                                                ))}
                                                {clients.length === 0 ? (
                                                    <SelectItem value="__none" disabled>
                                                        No clients
                                                    </SelectItem>
                                                ) : null}
                                            </SelectContent>
                                        </Select>
                                    </div>

                                    {renameMode === "site" ? (
                                        <div className="grid gap-2">
                                            <Label>Site</Label>
                                            <Select value={renameSiteId} onValueChange={setRenameSiteId}>
                                                <SelectTrigger>
                                                    <SelectValue placeholder="Select a site" />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    {renameSites.map((s) => (
                                                        <SelectItem key={s.key} value={s.key}>
                                                            {s.name}
                                                        </SelectItem>
                                                    ))}
                                                    {renameSites.length === 0 ? (
                                                        <SelectItem value="__none" disabled>
                                                            No sites
                                                        </SelectItem>
                                                    ) : null}
                                                </SelectContent>
                                            </Select>
                                        </div>
                                    ) : null}

                                    <div className="grid gap-2">
                                        <Label htmlFor="rename-name">New name</Label>
                                        <Input
                                            id="rename-name"
                                            value={renameName}
                                            maxLength={120}
                                            onChange={(e) => setRenameName(e.target.value)}
                                            onKeyDown={(e) => {
                                                if (e.key === "Enter" && !renameUnchanged && !renaming) void submitRename();
                                            }}
                                        />
                                    </div>
                                </div>

                                <DialogFooter>
                                    <Button variant="outline" type="button" onClick={() => setRenameOpen(false)} disabled={renaming}>
                                        Cancel
                                    </Button>
                                    <Button
                                        variant="success"
                                        type="button"
                                        onClick={submitRename}
                                        disabled={renaming || renameUnchanged || !renameClientId || (renameMode === "site" && !renameSiteId)}
                                    >
                                        {renaming ? "Saving..." : "Rename"}
                                    </Button>
                                </DialogFooter>
                            </DialogContent>
                        </Dialog>

                        {/* Reusable Installer (Option A) */}
                        <Dialog open={installerOpen} onOpenChange={setInstallerOpen}>

                            <DialogContent className="sm:max-w-[720px]">
                                <DialogHeader>
                                    <DialogTitle>Reusable Installer</DialogTitle>
                                    <DialogDescription>
                                        Create a reusable enrollment key for a site, then run the install command it gives you on each device.
                                    </DialogDescription>
                                </DialogHeader>

                                <div className="grid gap-4 py-2">
                                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                                        <div className="grid gap-2">
                                            <Label>Client</Label>
                                            <Select
                                                value={installerClientId}
                                                onValueChange={(v) => {
                                                    setInstallerClientId(v);
                                                    setInstallerSiteId("");
                                                    setKeyResult(null);
                                                }}
                                            >
                                                <SelectTrigger>
                                                    <SelectValue placeholder={clientsLoading ? "Loading..." : "Select a client"} />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    {clients.map((c) => (
                                                        <SelectItem key={c.key} value={c.key}>
                                                            {c.name}
                                                        </SelectItem>
                                                    ))}
                                                    {clients.length === 0 && (
                                                        <SelectItem value="__none" disabled>
                                                            No clients found
                                                        </SelectItem>
                                                    )}
                                                </SelectContent>
                                            </Select>
                                        </div>

                                        <div className="grid gap-2">
                                            <Label>Site</Label>
                                            <Select
                                                value={installerSiteId}
                                                onValueChange={(v) => {
                                                    setInstallerSiteId(v);
                                                    setKeyResult(null);
                                                }}
                                            >
                                                <SelectTrigger>
                                                    <SelectValue
                                                        placeholder={
                                                            installerSitesLoading
                                                                ? "Loading..."
                                                                : installerClientId
                                                                    ? "Select a site"
                                                                    : "Select a client first"
                                                        }
                                                    />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    {installerSites.map((s) => (
                                                        <SelectItem key={s.key} value={s.key}>
                                                            {s.name}
                                                        </SelectItem>
                                                    ))}
                                                    {installerClientId && installerSites.length === 0 && (
                                                        <SelectItem value="__none" disabled>
                                                            No sites found
                                                        </SelectItem>
                                                    )}
                                                </SelectContent>
                                            </Select>
                                        </div>
                                    </div>

                                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                                        <div className="grid gap-2">
                                            <Label htmlFor="key-expires">How long the key lasts</Label>
                                            <select
                                                id="key-expires"
                                                value={keyExpiresMinutes}
                                                onChange={(e) => { setKeyExpiresMinutes(e.target.value); setKeyResult(null); }}
                                                className="h-9 rounded-md border bg-background px-2 text-sm"
                                            >
                                                {![1440, 10080, 43200, 129600, 525600, 2628000, 5259600].includes(Number(keyExpiresMinutes)) && Number(keyExpiresMinutes) >= 1 ? (
                                                    <option value={keyExpiresMinutes}>{Number(keyExpiresMinutes) % 1440 === 0 ? `${Number(keyExpiresMinutes) / 1440} days` : Number(keyExpiresMinutes) % 60 === 0 ? `${Number(keyExpiresMinutes) / 60} hours` : `${keyExpiresMinutes} minutes`} (your default)</option>
                                                ) : null}
                                                <option value="1440">1 day</option>
                                                <option value="10080">7 days</option>
                                                <option value="43200">30 days</option>
                                                <option value="129600">90 days</option>
                                                <option value="525600">1 year</option>
                                                <option value="2628000">5 years</option>
                                                <option value="5259600">10 years (for Group Policy and other long deployments)</option>
                                            </select>
                                            <div className="text-xs text-muted-foreground">
                                                You can stop any key working at any time under Administration &gt; Install keys.
                                            </div>
                                        </div>
                                    </div>

                                    <div className="grid gap-2">
                                        <Label htmlFor="key-name">Key name (optional)</Label>
                                        <Input
                                            id="key-name"
                                            value={keyName}
                                            onChange={(e) => setKeyName(e.target.value)}
                                            placeholder="e.g., Huber Heights – Workstations"
                                        />
                                    </div>

                                    <div className="flex flex-wrap items-center gap-2">
                                        <Button
                                            type="button"
                                            onClick={submitCreateEnrollmentKey}
                                            disabled={creatingKey || !installerClientId || !installerSiteId}
                                        >
                                            {creatingKey ? "Creating..." : "Create Enrollment Key"}
                                        </Button>
                                        {keyResult?.enrollmentKey && (
                                            <Button
                                                type="button"
                                                variant="outline"
                                                onClick={() => copy(keyResult.enrollmentKey)}
                                            >
                                                Copy Key
                                            </Button>
                                        )}
                                    </div>

                                    {keyResult && (
                                        <div className="min-w-0 rounded-md border bg-muted/30 p-3">
                                            <div className="text-sm font-medium">Install on a device</div>
                                            <div className="mt-1 text-xs text-muted-foreground">
                                                This works on any number of devices until{" "}
                                                <span className="font-medium">
                                                    {new Date(keyResult.expiresAt).toLocaleString()}
                                                </span>
                                                . It contains the enrollment key, so treat it like a password.
                                            </div>

                                            <label className="mt-3 flex items-start gap-2 text-sm">
                                                <input
                                                    type="checkbox"
                                                    className="mt-1"
                                                    checked={gpoMode}
                                                    onChange={(e) => { setGpoMode(e.target.checked); setInstallBundle(null); }}
                                                />
                                                <span>
                                                    For Group Policy or other start-up scripts
                                                    <span className="block text-xs text-muted-foreground">
                                                        The script runs on every start-up but does nothing on a computer that already has the agent, so it can stay in place.
                                                    </span>
                                                </span>
                                            </label>

                                            <div className="mt-3 flex flex-wrap gap-2">
                                                {(["windows", "linux"] as const).map((os) => (
                                                    <Button
                                                        key={os}
                                                        type="button"
                                                        variant={installBundle?.os === os ? "default" : "outline"}
                                                        onClick={() => prepareInstaller(os)}
                                                        disabled={!!downloadingInstaller}
                                                    >
                                                        {downloadingInstaller === os
                                                            ? "Preparing..."
                                                            : os === "windows"
                                                              ? "Windows"
                                                              : "Linux"}
                                                    </Button>
                                                ))}
                                            </div>

                                            {installBundle && (
                                                <div className="mt-3 min-w-0 space-y-2">
                                                    <div className="text-xs text-muted-foreground">
                                                        {gpoMode
                                                            ? installBundle.os === "windows"
                                                                ? "Download the script, then add it in the Group Policy editor under Computer Configuration > Policies > Windows Settings > Scripts (Startup) > PowerShell Scripts. Copy it to the policy's own Startup folder so computers can read it. Or paste the command below into a test machine first."
                                                                : "Download the script and run it from your configuration management or a boot-time job. It does nothing where the agent is already installed."
                                                            : installBundle.os === "windows"
                                                                ? "Run this in PowerShell as Administrator on the device:"
                                                                : "Run this as root in a terminal on the device (x64, systemd or OpenRC). On Alpine, first run: apk add bash curl"}
                                                    </div>
                                                    {gpoMode ? (
                                                        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
                                                            The script contains the install key, and computers in your domain can read it from the policy folder. The key only lets devices enroll into this site, and you can stop it at any time under Administration &gt; Install keys.
                                                        </div>
                                                    ) : null}
                                                    <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-background p-3 text-xs">
                                                        {installBundle.command}
                                                    </pre>
                                                    <div className="flex flex-wrap gap-2">
                                                        <Button type="button" size="sm" onClick={() => copy(installBundle.command)}>
                                                            Copy command
                                                        </Button>
                                                        <Button
                                                            type="button"
                                                            size="sm"
                                                            variant="outline"
                                                            onClick={() => startBrowserDownload(installBundle.url)}
                                                        >
                                                            {gpoMode ? "Download script" : "Download script instead"}
                                                        </Button>
                                                    </div>
                                                </div>
                                            )}

                                            <div className="mt-3 text-xs text-muted-foreground">
                                                The device appears in this site within a minute or so of the install finishing.
                                                No macOS agent is available yet.
                                            </div>
                                        </div>
                                    )}
                                </div>

                                <DialogFooter>
                                    <Button
                                        variant="outline"
                                        type="button"
                                        onClick={() => setInstallerOpen(false)}
                                        disabled={creatingKey || !!downloadingInstaller}
                                    >
                                        Close
                                    </Button>
                                </DialogFooter>
                            </DialogContent>
                        </Dialog>

                        {/* Create Site */}
                        <Dialog open={createSiteOpen} onOpenChange={setCreateSiteOpen}>
                            <DialogContent>
                                <DialogHeader>
                                    <DialogTitle>Create Site</DialogTitle>
                                    <DialogDescription>Adds a site under a specific client.</DialogDescription>
                                </DialogHeader>

                                <div className="grid gap-4 py-2">
                                    <div className="grid gap-2">
                                        <Label>Client</Label>
                                        <Select value={siteClientId} onValueChange={setSiteClientId}>
                                            <SelectTrigger>
                                                <SelectValue placeholder={clientsLoading ? "Loading..." : "Select a client"} />
                                            </SelectTrigger>
                                            <SelectContent>
                                                {clients.map((c) => (
                                                    <SelectItem key={c.key} value={c.key}>
                                                        {c.name}
                                                    </SelectItem>
                                                ))}
                                                {clients.length === 0 && (
                                                    <SelectItem value="__none" disabled>
                                                        No clients found
                                                    </SelectItem>
                                                )}
                                            </SelectContent>
                                        </Select>
                                    </div>

                                    <div className="grid gap-2">
                                        <Label htmlFor="new-site-name">Site name</Label>
                                        <Input
                                            id="new-site-name"
                                            value={siteName}
                                            onChange={(e) => setSiteName(e.target.value)}
                                            placeholder="e.g., Huber Heights"
                                        />
                                    </div>
                                </div>

                                <DialogFooter>
                                    <Button
                                        variant="outline"
                                        type="button"
                                        onClick={() => setCreateSiteOpen(false)}
                                        disabled={creatingSite}
                                    >
                                        Cancel
                                    </Button>
                                    <Button
                                        type="button"
                                        onClick={submitCreateSite}
                                        disabled={creatingSite || !siteClientId || siteClientId === "__none"}
                                    >
                                        {creatingSite ? "Creating..." : "Create"}
                                    </Button>
                                </DialogFooter>
                            </DialogContent>
                        </Dialog>

                        {/* Delete */}
                        <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
                            <DialogContent>
                                <DialogHeader>
                                    <DialogTitle>Delete client or site</DialogTitle>
                                    <DialogDescription>
                                        You can only delete a client if it has no sites (and no devices/tickets),
                                        and only delete a site if it has no devices/tickets.
                                    </DialogDescription>
                                </DialogHeader>

                                <div className="grid gap-4 py-2">
                                    <div className="grid gap-2">
                                        <Label>Delete type</Label>
                                        <Select value={deleteMode} onValueChange={(v) => setDeleteMode(v as "client" | "site")}>
                                            <SelectTrigger>
                                                <SelectValue />
                                            </SelectTrigger>
                                            <SelectContent>
                                                <SelectItem value="client">Client</SelectItem>
                                                <SelectItem value="site">Site</SelectItem>
                                            </SelectContent>
                                        </Select>
                                    </div>

                                    <div className="grid gap-2">
                                        <Label>Client</Label>
                                        <Select value={deleteClientId} onValueChange={setDeleteClientId}>
                                            <SelectTrigger>
                                                <SelectValue placeholder={clientsLoading ? "Loading..." : "Select a client"} />
                                            </SelectTrigger>
                                            <SelectContent>
                                                {clients.map((c) => (
                                                    <SelectItem key={c.key} value={c.key}>
                                                        {c.name}
                                                    </SelectItem>
                                                ))}
                                                {clients.length === 0 && (
                                                    <SelectItem value="__none" disabled>
                                                        No clients found
                                                    </SelectItem>
                                                )}
                                            </SelectContent>
                                        </Select>
                                    </div>

                                    {deleteMode === "site" && (
                                        <div className="grid gap-2">
                                            <Label>Site</Label>
                                            <Select value={deleteSiteId} onValueChange={setDeleteSiteId}>
                                                <SelectTrigger>
                                                    <SelectValue placeholder={sitesLoading ? "Loading..." : "Select a site"} />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    {sites.map((s) => (
                                                        <SelectItem key={s.key} value={s.key}>
                                                            {s.name}
                                                        </SelectItem>
                                                    ))}
                                                    {sites.length === 0 && (
                                                        <SelectItem value="__none" disabled>
                                                            No sites found
                                                        </SelectItem>
                                                    )}
                                                </SelectContent>
                                            </Select>
                                        </div>
                                    )}
                                </div>

                                <DialogFooter>
                                    <Button
                                        variant="outline"
                                        type="button"
                                        onClick={() => setDeleteOpen(false)}
                                        disabled={deleting}
                                    >
                                        Cancel
                                    </Button>
                                    <Button
                                        variant="destructive"
                                        type="button"
                                        onClick={submitDelete}
                                        disabled={
                                            deleting ||
                                            !deleteClientId ||
                                            deleteClientId === "__none" ||
                                            (deleteMode === "site" && (!deleteSiteId || deleteSiteId === "__none"))
                                        }
                                    >
                                        {deleting ? "Deleting..." : "Delete"}
                                    </Button>
                                </DialogFooter>
                            </DialogContent>
                        </Dialog>
                    </div>
                </PermGate>
            </div>
        </div>
    );
}

export default function CustomersPage() {
    const {
        sorting,
        setSorting,
        columnVisibility,
        setColumnVisibility,
        columnFilters,
        setColumnFilters,

        registerSnapshotGetter,
        activeFilters,
    } = useDashboard();

    const { selection, select, places } = useCustomers();
    const { refreshDevices, devicesLoading } = useDashboard();

    React.useEffect(() => {
        const off = registerSnapshotGetter(() => ({
            columnVisibility,
            sorting,
            columnFilters,

            // Saved views keep these names, so ones saved earlier still load.
            customersGroupOpen: true,
            expandedOrganizations: Array.from(new Set(selection.map((s) => s.org))),
            expandedSites: Array.from(new Set(selection.flatMap((s) => (s.site ? [s.site] : [])))),
            activeFilters,
        }));
        return () => {
            registerSnapshotGetter(null);
            void off;
        };
    }, [
        registerSnapshotGetter,
        columnVisibility,
        sorting,
        columnFilters,
        selection,
        activeFilters,
    ]);

    // How many devices the table shows, in all (the server counts them; the table fetches one page at a time).
    const [deviceTotal, setDeviceTotal] = React.useState<number | null>(null);
    const [customerTotal, setCustomerTotal] = React.useState<number | null>(null);
    // How many device removal requests wait for approval, shown on the link to the Removal requests page.
    const [removalCount, setRemovalCount] = React.useState<number>(0);
    React.useEffect(() => { removals.list().then((r) => setRemovalCount(r.total)).catch(() => setRemovalCount(0)); }, []);

    // Filters start collapsed on smaller screens, so devices are visible first.
    const [filtersOpen, setFiltersOpen] = React.useState(false);

    // What the page shows. Nothing chosen: the customers themselves. Whole customers chosen: their sites, with the devices
    // under each. A site (or a mix) chosen: that selection's devices in one table, as before.
    const view: "customers" | "sites" | "devices" = selection.length === 0 ? "customers" : selection.every((s) => !s.site) ? "sites" : "devices";
    const filtered = (activeFilters.status?.length ?? 0) + (activeFilters.os?.length ?? 0) + (activeFilters.tags?.length ?? 0) > 0;
    const [sitesSummary, setSitesSummary] = React.useState<string | null>(null);

    return (
        <div className="grid grid-cols-12 gap-6">
            <PageHeader
                className="col-span-12"
                title={
                    <>
                        Customers
                        {view === "customers" && customerTotal !== null ? (
                            <span className="ml-3 align-middle text-sm font-normal text-muted-foreground">
                                {customerTotal} {customerTotal === 1 ? "customer" : "customers"}
                            </span>
                        ) : null}
                        {view === "devices" ? (
                            <span className="ml-3 align-middle text-sm font-normal text-muted-foreground">
                                {deviceTotal ?? 0} {deviceTotal === 1 ? "device" : "devices"}
                            </span>
                        ) : null}
                        {view === "sites" && sitesSummary ? (
                            <span className="ml-3 align-middle text-sm font-normal text-muted-foreground">{sitesSummary}</span>
                        ) : null}
                    </>
                }
                description={view === "customers" ? "Every customer you look after. Open one to see its sites and the devices at each." : "Add customers with their contacts, addresses, billing and branding, then add sites. Devices appear once endpoints check in."}
                actions={
                    <>
                        {selection.length > 0 ? (
                            <Button variant="outline" size="sm" onClick={() => select(null)}>
                                Show all customers
                            </Button>
                        ) : null}
                        <Button asChild variant="outline" size="sm">
                            <Link href="/assets">Assets</Link>
                        </Button>
                        <Button asChild variant="outline" size="sm">
                            <Link href="/network-discovery">Network discovery</Link>
                        </Button>
                        <Button asChild variant="outline" size="sm">
                            <Link href="/removal-requests">Removal requests{removalCount ? ` (${removalCount})` : ""}</Link>
                        </Button>
                        <Button variant="outline" size="sm" onClick={refreshDevices} disabled={devicesLoading}>
                            {devicesLoading ? "Loading…" : "Refresh"}
                        </Button>
                        <CustomersActions />
                    </>
                }
            />

            {view === "customers" ? (
                <section className="col-span-12 min-w-0">
                    <CustomersOverview onOpen={(name) => select({ org: name })} onCount={setCustomerTotal} />
                </section>
            ) : null}

            {view !== "customers" ? (
            <aside className="col-span-12 lg:col-span-3 xl:col-span-2">
                <Button
                    variant="outline"
                    size="sm"
                    className="gap-2 lg:hidden"
                    aria-expanded={filtersOpen}
                    onClick={() => setFiltersOpen((open) => !open)}
                >
                    <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
                    {filtersOpen ? "Hide filters" : "Show filters"}
                </Button>
                <div className={filtersOpen ? "mt-3 lg:mt-0" : "hidden lg:block"}>
                    <FiltersRail searchColumn="hostname" searchPlaceholder="Filter devices…" />
                </div>
            </aside>
            ) : null}
            {view === "sites" ? (
                <section className="col-span-12 lg:col-span-9 xl:col-span-10 min-w-0 space-y-6">
                    {Array.from(new Set(selection.map((s) => s.org))).map((org) => (
                        <div key={org} className="space-y-3">
                            {selection.length > 1 ? <h2 className="text-lg font-semibold">{org}</h2> : null}
                            <CustomerSitesView org={org} filtered={filtered} onSummary={setSitesSummary} />
                        </div>
                    ))}
                </section>
            ) : null}
            {view === "devices" ? (
                <section className="col-span-12 lg:col-span-9 xl:col-span-10 min-w-0 space-y-3">
                    <DeviceTable
                        places={places}
                        onTotal={setDeviceTotal}
                        filterColumnId="hostname"
                        filterPlaceholder="Filter devices…"
                        compact={false}
                        toolbarElsewhere
                    />
                </section>
            ) : null}
        </div>
    );
}
