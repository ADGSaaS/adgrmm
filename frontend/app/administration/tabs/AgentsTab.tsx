"use client";

// Agent defaults that the server really applies: how long a new install key lasts, and whether agents are offered updates.
// (The agent's check-in interval is set on the agent itself, and installs carry no scripts, so neither is offered here.)
// Each section saves on its own, and a save sends only that section's value (the other one keeps the value the server has).
import * as React from "react";
import { Cpu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { jfetch } from "@/lib/api";
import type { ToastFn } from "../types";
import { AdminNote, AdminSection, AdminTab, AdminTabHeader, AdminToggle } from "../tab-layout";
import ReleasesCard from "./ReleasesCard";
import AutoRepairCard from "./AutoRepairCard";
import TrayCard from "./TrayCard";

type AgentSettings = {
    installKeyExpiryMins: number;
    autoUpdate: boolean;
    updatesDisabledByServer: boolean;
    packages: { os: "windows" | "linux"; version: string | null; sizeBytes: number | null }[];
};

const messageOf = (e: unknown) => {
    const raw = e instanceof Error ? e.message : "Something went wrong.";
    try { const j = JSON.parse(raw) as { message?: string | string[] }; return Array.isArray(j.message) ? j.message.join(" ") : j.message ?? raw; } catch { return raw; }
};

const DAY = 1440;
const PRESETS: { mins: number; label: string }[] = [
    { mins: 60, label: "1 hour" },
    { mins: DAY, label: "1 day" },
    { mins: 7 * DAY, label: "7 days (the default)" },
    { mins: 14 * DAY, label: "14 days" },
    { mins: 30 * DAY, label: "30 days" },
    { mins: 90 * DAY, label: "90 days" },
    { mins: 365 * DAY, label: "1 year" },
    { mins: 5_259_600, label: "10 years" },
];

function describeMins(m: number): string {
    if (m % DAY === 0) return `${m / DAY} day${m === DAY ? "" : "s"}`;
    if (m % 60 === 0) return `${m / 60} hour${m === 60 ? "" : "s"}`;
    return `${m} minutes`;
}

const OS_NAME = { windows: "Windows", linux: "Linux" } as const;
const size = (n: number | null) => (n == null ? "" : n > 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);

export default function AgentsTab({ push }: { push: ToastFn }) {
    const [saved, setSaved] = React.useState<AgentSettings | null>(null);
    const [mins, setMins] = React.useState(7 * DAY);
    const [auto, setAuto] = React.useState(true);
    const [busy, setBusy] = React.useState<"keys" | "updates" | null>(null);

    const apply = (s: AgentSettings) => { setSaved(s); setMins(s.installKeyExpiryMins); setAuto(s.autoUpdate); };
    const load = React.useCallback(async () => {
        try { apply(await jfetch<AgentSettings>("/api/admin/agent-settings")); }
        catch (e) { push({ title: "Could not load agent settings", desc: messageOf(e), kind: "destructive" }); }
    }, [push]);
    React.useEffect(() => { void load(); }, [load]);

    if (!saved) return <div className="p-4 text-sm text-muted-foreground">Loading…</div>;
    const keysDirty = mins !== saved.installKeyExpiryMins;
    const updatesDirty = auto !== saved.autoUpdate;
    const options = PRESETS.some((p) => p.mins === mins) ? PRESETS : [...PRESETS, { mins, label: `${describeMins(mins)} (custom)` }].sort((a, b) => a.mins - b.mins);

    async function save(which: "keys" | "updates") {
        if (!saved) return;
        setBusy(which);
        try {
            // only this section's value changes; the other keeps what the server has
            const body = which === "keys" ? { installKeyExpiryMins: mins, autoUpdate: saved.autoUpdate } : { installKeyExpiryMins: saved.installKeyExpiryMins, autoUpdate: auto };
            const next = await jfetch<AgentSettings>("/api/admin/agent-settings", { method: "PUT", body });
            setSaved(next);
            if (which === "keys") setMins(next.installKeyExpiryMins); else setAuto(next.autoUpdate);
            push({ title: "Agent settings saved", kind: "success" });
        } catch (e) {
            push({ title: "Could not save", desc: messageOf(e), kind: "destructive" });
        } finally {
            setBusy(null);
        }
    }

    const footer = (which: "keys" | "updates", dirty: boolean, discard: () => void) => (
        <>
            <Button size="sm" onClick={() => void save(which)} disabled={busy !== null || !dirty}>{busy === which ? "Saving…" : "Save"}</Button>
            <Button size="sm" variant="outline" onClick={discard} disabled={busy !== null || !dirty}>Discard changes</Button>
        </>
    );

    return (
        <AdminTab>
            <AdminTabHeader
                icon={Cpu}
                title="Agents & endpoints"
                description="Defaults for the agents installed on devices. Install keys themselves are made and revoked under Install keys."
            />

            <AdminSection
                title="Install keys"
                description="What the “create install key” form starts with, and what a key gets when it is made without choosing a length. Keys that already exist are not changed, and a key can always be revoked early."
                footer={footer("keys", keysDirty, () => setMins(saved.installKeyExpiryMins))}
            >
                <div className="grid max-w-xs gap-2">
                    <Label htmlFor="key-life">How long a new key lasts</Label>
                    <Select value={String(mins)} onValueChange={(v) => setMins(Number(v))}>
                        <SelectTrigger id="key-life"><SelectValue /></SelectTrigger>
                        <SelectContent>
                            {options.map((o) => <SelectItem key={o.mins} value={String(o.mins)}>{o.label}</SelectItem>)}
                        </SelectContent>
                    </Select>
                </div>
            </AdminSection>

            <AdminSection
                title="Agent updates"
                footer={footer("updates", updatesDirty, () => setAuto(saved.autoUpdate))}
            >
                <AdminToggle id="auto-update" checked={auto} onCheckedChange={setAuto} label="Offer new agent versions to devices automatically">
                    Agents ask the server for a newer version every few minutes. When this is on and a newer package is on the server, they download it, check its signature and install it.
                    When it is off, they are told there is nothing newer and stay as they are.
                </AdminToggle>
                {saved.updatesDisabledByServer ? (
                    <AdminNote tone="warn">
                        <code>AGENT_UPDATES_ENABLED</code> is switched off in the server&apos;s environment, so no agent is offered an update, whatever is chosen here.
                    </AdminNote>
                ) : null}
                <div className="grid gap-2">
                    <div className="text-sm font-medium">Newest package on this server</div>
                    <ul className="grid gap-1 text-sm">
                        {saved.packages.map((p) => (
                            <li key={p.os} className="flex flex-wrap items-center gap-x-3">
                                <span className="w-16 font-medium">{OS_NAME[p.os]}</span>
                                {p.sizeBytes == null ? <span className="text-muted-foreground">no package uploaded</span>
                                    : p.version ? <span>version {p.version} <span className="text-muted-foreground">({size(p.sizeBytes)})</span></span>
                                        : <span className="text-muted-foreground">package present, no version file, so it cannot be offered as an update</span>}
                            </li>
                        ))}
                    </ul>
                </div>
            </AdminSection>

            <TrayCard push={push} />
            <AutoRepairCard push={push} />

            <ReleasesCard push={push} />

            <p className="text-sm text-muted-foreground">
                Not here, because the agent does not take them from the server: the check-in interval is set on each agent, and installs do not carry maintenance scripts.
                To run something on new devices, use Policies.
            </p>
        </AdminTab>
    );
}
