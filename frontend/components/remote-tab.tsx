// components/remote-tab.tsx
"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Terminal, FileText, ExternalLink, Tv2 } from "lucide-react";
import { deviceFamily } from "@/lib/device-os";

type RemoteTabProps = {
    /** The current device id (uuid). If omitted, actions will be disabled. */
    deviceId?: string;
    /** Remote Console only exists on the Windows agent. */
    os?: string | null;
};

type RemoteToolCardProps = {
    icon: React.ElementType;
    title: string;
    description: string;
    actionText: string;
    onAction?: () => void;
    disabled?: boolean;
    secondaryActionText?: string;
    onSecondaryAction?: () => void;
};

function RemoteToolCard({
    icon,
    title,
    description,
    actionText,
    onAction,
    disabled,
    secondaryActionText,
    onSecondaryAction,
}: RemoteToolCardProps) {
    const Icon = icon;

    return (
        <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-base font-medium">{title}</CardTitle>
                <Icon className="h-6 w-6 text-muted-foreground" />
            </CardHeader>

            <CardContent>
                <p className="text-sm text-muted-foreground mb-4">{description}</p>

                <div className="flex gap-2">
                    <Button className="w-full" onClick={onAction} disabled={disabled}>
                        {actionText}
                    </Button>

                    {secondaryActionText ? (
                        <Button
                            variant="outline"
                            onClick={onSecondaryAction}
                            disabled={disabled}
                            className="shrink-0"
                            title={secondaryActionText}
                        >
                            <ExternalLink className="h-4 w-4" />
                        </Button>
                    ) : null}
                </div>
            </CardContent>
        </Card>
    );
}

type ToolKey = "remote-console" | "remote-shell" | "file-browser";

export default function RemoteTab({ deviceId, os }: RemoteTabProps) {
    const isLinux = deviceFamily(os) === "linux";
    const router = useRouter();
    const disabled = !deviceId;

    const openInDashboard = (tool: ToolKey) => {
        if (!deviceId) return;
        router.push(`/devices/${encodeURIComponent(deviceId)}?tool=${encodeURIComponent(tool)}`);
    };

    const popout = (tool: ToolKey) => {
        if (!deviceId) return;
        const url = `/devices/${encodeURIComponent(deviceId)}?tool=${encodeURIComponent(tool)}&popout=1`;
        if (tool === "remote-console") {
            // The same window the console panel opens, so the two never run side by side.
            window.open(`${url}&autoconnect=1`, `adgrmm_console_${deviceId.replace(/[^a-zA-Z0-9]/g, "_")}`, "popup,width=1400,height=900");
            return;
        }
        window.open(url, "_blank", "noopener,noreferrer,width=1280,height=800");
    };

    return (
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {isLinux ? null : (
                <RemoteToolCard
                    icon={Tv2}
                    title="Remote Console"
                    description="View and control this device's screen, with or without someone there, including its sign-in and lock screens."
                    actionText="Start Console"
                    onAction={() => openInDashboard("remote-console")}
                    secondaryActionText="Pop out"
                    onSecondaryAction={() => popout("remote-console")}
                    disabled={disabled}
                />
            )}

            <RemoteToolCard
                icon={Terminal}
                title="Remote Shell"
                description={isLinux
                    ? "Open a bash session directly on the device for command-line tasks."
                    : "Open a PowerShell session directly on the device for command-line tasks."}
                actionText="Open Shell"
                onAction={() => openInDashboard("remote-shell")}
                secondaryActionText="Pop out"
                onSecondaryAction={() => popout("remote-shell")}
                disabled={disabled}
            />

            <RemoteToolCard
                icon={FileText}
                title="File Browser"
                description="Securely browse, upload, and download files from the endpoint's filesystem."
                actionText="Browse Files"
                onAction={() => openInDashboard("file-browser")}
                secondaryActionText="Pop out"
                onSecondaryAction={() => popout("file-browser")}
                disabled={disabled}
            />

            {isLinux ? (
                <p className="text-sm text-muted-foreground md:col-span-2 lg:col-span-3">
                    Remote Console is only available on Windows devices.
                </p>
            ) : null}
        </div>
    );
}
