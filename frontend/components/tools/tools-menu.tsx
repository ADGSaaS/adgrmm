"use client";

// The Tools menu in the top bar: six tools for many devices or for the server, each shown only to people who may use it.
import * as React from "react";
import { ChevronDown, Terminal, FileCode2, PackageCheck, DatabaseZap, Eraser, LifeBuoy, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useMe } from "@/lib/use-me";
import { hasPerm } from "@/lib/permissions";
import ToolDialogs, { type ToolKey } from "@/components/tools/tool-dialogs";

/** The tools and the right each one needs (the same rights the matching single-device actions need). */
export const TOOL_ITEMS: Array<{ key: ToolKey; label: string; hint: string; perm: string | string[]; icon: typeof Terminal; group: "devices" | "server" }> = [
    { key: "command", label: "Bulk command", hint: "Run one command on many devices", perm: ["devices.read", "automation.run"], icon: Terminal, group: "devices" },
    { key: "script", label: "Bulk script", hint: "Run a saved script on many devices", perm: ["devices.read", "automation.run"], icon: FileCode2, group: "devices" },
    { key: "patches", label: "Bulk patch management", hint: "Scan or install updates on many devices", perm: ["devices.read", "devices.actions"], icon: PackageCheck, group: "devices" },
    { key: "recover", label: "Recover all agents", hint: "Restart the agent on devices that look stuck", perm: ["devices.read", "devices.actions"], icon: LifeBuoy, group: "devices" },
    { key: "maintenance", label: "Server maintenance", hint: "Clear out old history", perm: "settings.write", icon: DatabaseZap, group: "server" },
    { key: "cache", label: "Clear cache", hint: "Make the server forget what it keeps in memory", perm: "settings.write", icon: Eraser, group: "server" },
];

export default function ToolsMenu({ className, mobile, onPicked, menuOpen, onMenuOpenChange, onTriggerHover }: { className?: string; mobile?: boolean; onPicked?: () => void; menuOpen?: boolean; onMenuOpenChange?: (o: boolean) => void; onTriggerHover?: () => void }) {
    const { user } = useMe();
    const [tool, setTool] = React.useState<ToolKey | null>(null);
    const perms = user?.permissions ?? [];
    const items = TOOL_ITEMS.filter((i) => hasPerm(perms, i.perm));
    if (items.length === 0) return null;
    const pick = (k: ToolKey) => { setTool(k); onPicked?.(); };

    return (
        <>
            {mobile ? (
                <div className="grid gap-1">
                    <div className="px-3 pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Tools</div>
                    {items.map(({ key, label, icon: Icon }) => (
                        <button key={key} type="button" onClick={() => pick(key)} className="flex items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-muted">
                            <Icon className="h-4 w-4" aria-hidden /> {label}
                        </button>
                    ))}
                </div>
            ) : (
                <DropdownMenu modal={false} {...(menuOpen === undefined ? {} : { open: menuOpen, onOpenChange: onMenuOpenChange })}>
                    <DropdownMenuTrigger asChild onPointerEnter={onTriggerHover}>
                        <Button variant="ghost" size="sm" className={className ?? "h-full gap-1 rounded-sm px-3 text-sm font-medium text-muted-foreground hover:text-foreground"} data-testid="tools-menu">
                            <Wrench className="h-4 w-4" aria-hidden /> Tools <ChevronDown className="h-3.5 w-3.5 opacity-60" aria-hidden />
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-72">
                        {items.filter((i) => i.group === "devices").map(({ key, label, hint, icon: Icon }) => (
                            <DropdownMenuItem key={key} onSelect={() => pick(key)} className="flex items-start gap-2 py-2">
                                <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                                <span><span className="block text-sm font-medium">{label}</span><span className="block text-xs text-muted-foreground">{hint}</span></span>
                            </DropdownMenuItem>
                        ))}
                        {items.some((i) => i.group === "devices") && items.some((i) => i.group === "server") ? <DropdownMenuSeparator /> : null}
                        {items.filter((i) => i.group === "server").map(({ key, label, hint, icon: Icon }) => (
                            <DropdownMenuItem key={key} onSelect={() => pick(key)} className="flex items-start gap-2 py-2">
                                <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                                <span><span className="block text-sm font-medium">{label}</span><span className="block text-xs text-muted-foreground">{hint}</span></span>
                            </DropdownMenuItem>
                        ))}
                    </DropdownMenuContent>
                </DropdownMenu>
            )}
            <ToolDialogs tool={tool} onClose={() => setTool(null)} />
        </>
    );
}
