"use client";

// Feature flags: switches for features that really check them, kept per organization and recorded in the audit log.
// Only flags that something in the product reads are listed here. The default is how the product behaved before the flag existed.
import * as React from "react";
import { Rocket } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { jfetch } from "@/lib/api";
import { refreshFlags } from "@/lib/flags";
import { useMe } from "@/lib/use-me";
import { hasPerm } from "@/lib/permissions";
import { Header, Panel, Pill, messageOf } from "../platform-common";
import type { ToastFn } from "../types";

type Flag = {
    key: string;
    label: string;
    description: string;
    effect: string;
    enabled: boolean;
    defaultEnabled: boolean;
    changed: boolean;
    updatedAt: string | null;
    updatedBy: string | null;
};

export default function FeatureFlagsTab({ push }: { push: ToastFn }) {
    const { permissions } = useMe();
    const canEdit = hasPerm(permissions, "settings.write");
    const [flags, setFlags] = React.useState<Flag[] | null>(null);
    const [busy, setBusy] = React.useState<string | null>(null);
    const [error, setError] = React.useState<string | null>(null);

    React.useEffect(() => {
        jfetch<{ items: Flag[] }>("/api/admin/flags")
            .then((r) => setFlags(r.items))
            .catch((e) => {
                setError(messageOf(e));
                push({ title: "Could not load the feature flags", desc: messageOf(e), kind: "destructive" });
            });
    }, [push]);

    async function toggle(f: Flag, enabled: boolean) {
        setBusy(f.key);
        try {
            const next = await jfetch<Flag>(`/api/admin/flags/${encodeURIComponent(f.key)}`, { method: "PUT", body: { enabled } });
            setFlags((cur) => (cur ?? []).map((x) => (x.key === f.key ? next : x)));
            void refreshFlags();
            push({ title: `${f.label} is ${enabled ? "on" : "off"}`, desc: "The change is recorded in the audit log.", kind: "success" });
        } catch (e) {
            push({ title: "Could not change the flag", desc: messageOf(e), kind: "destructive" });
        } finally {
            setBusy(null);
        }
    }

    return (
        <div className="grid w-full min-w-0 gap-6">
            <Header icon={<Rocket className="h-5 w-5" aria-hidden />} title="Feature flags">
                Switches for features that check them. Each is kept for this organization, and every change is recorded in the audit log with who made it.
                A flag appears here only when something in the product reads it, and the default is how the product behaved before the flag existed.
                {!canEdit ? " You can see the flags but not change them." : ""}
            </Header>
            {error ? <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</div> : null}
            {!flags && !error ? <div className="p-4 text-sm text-muted-foreground">Loading…</div> : null}
            {flags?.map((f) => (
                <Panel key={f.key}>
                    <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                                <h3 className="text-sm font-semibold">{f.label}</h3>
                                <code className="text-xs text-muted-foreground">{f.key}</code>
                                {f.changed ? <Pill tone="warn">Changed from the default ({f.defaultEnabled ? "on" : "off"})</Pill> : <Pill tone="neutral">Default</Pill>}
                            </div>
                            <p className="mt-1 text-sm">{f.description}</p>
                            <p className="mt-1 text-xs text-muted-foreground">{f.effect}</p>
                            {f.updatedAt ? <p className="mt-1 text-xs text-muted-foreground">Last changed {new Date(f.updatedAt).toLocaleString()}{f.updatedBy ? ` by ${f.updatedBy}` : ""}.</p> : null}
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                            <span className="text-xs text-muted-foreground">{f.enabled ? "On" : "Off"}</span>
                            <Switch checked={f.enabled} disabled={!canEdit || busy === f.key} onCheckedChange={(v) => void toggle(f, v)} aria-label={`${f.label} is ${f.enabled ? "on" : "off"}`} />
                        </div>
                    </div>
                </Panel>
            ))}
        </div>
    );
}
