"use client";

// Secrets & Environment: which of the server's settings are set and which are not. It never shows a value, not
// even part of one, and it cannot change anything: these settings live in the server's own configuration.
import * as React from "react";
import { Vault } from "lucide-react";
import { Input } from "@/components/ui/input";
import { jfetch } from "@/lib/api";
import { Header, Panel, Pill, messageOf } from "../platform-common";
import type { ToastFn } from "../types";

type Item = {
    key: string;
    category: string;
    description: string;
    set: boolean;
    secret: boolean;
    importance: "required" | "recommended" | "optional";
    attention: boolean;
    restartRequired: boolean;
    configuredIn: string;
};
type Status = { generatedAt: string; summary: { total: number; set: number; unset: number; secretsSet: number; needAttention: number }; items: Item[] };

export default function SecretsTab({ push }: { push: ToastFn }) {
    const [data, setData] = React.useState<Status | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [q, setQ] = React.useState("");
    const [show, setShow] = React.useState<"all" | "set" | "unset" | "attention">("all");

    React.useEffect(() => {
        jfetch<Status>("/api/admin/secrets-status")
            .then(setData)
            .catch((e) => {
                setError(messageOf(e));
                push({ title: "Could not load the server settings", desc: messageOf(e), kind: "destructive" });
            });
    }, [push]);

    const items = React.useMemo(() => {
        const term = q.trim().toLowerCase();
        return (data?.items ?? []).filter((i) => {
            if (show === "set" && !i.set) return false;
            if (show === "unset" && i.set) return false;
            if (show === "attention" && !i.attention) return false;
            return !term || i.key.toLowerCase().includes(term) || i.description.toLowerCase().includes(term) || i.category.toLowerCase().includes(term);
        });
    }, [data, q, show]);

    const categories = React.useMemo(() => [...new Set(items.map((i) => i.category))], [items]);

    return (
        <div className="grid w-full min-w-0 gap-6">
            <Header icon={<Vault className="h-5 w-5" aria-hidden />} title="Secrets & Environment">
                Which of this server&apos;s settings are set and which are not. Values are never shown, not even in part, and nothing can be changed here:
                these settings live in the server&apos;s own configuration (its service file, .env file or container settings), and a change needs a restart.
                Opening this list is recorded in the audit log.
            </Header>

            {error ? <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</div> : null}
            {!data && !error ? <div className="p-4 text-sm text-muted-foreground">Loading…</div> : null}

            {data ? (
                <>
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                        <Pill tone="neutral">{data.summary.total} settings</Pill>
                        <Pill tone="good">{data.summary.set} set</Pill>
                        <Pill tone="neutral">{data.summary.unset} not set</Pill>
                        <Pill tone="neutral">{data.summary.secretsSet} secrets in use</Pill>
                        {data.summary.needAttention ? <Pill tone="warn">{data.summary.needAttention} need attention</Pill> : <Pill tone="good">Nothing needs attention</Pill>}
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                        <Input className="max-w-xs" placeholder="Search settings" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search settings" />
                        <div className="flex gap-1" role="group" aria-label="Show">
                            {(["all", "set", "unset", "attention"] as const).map((k) => (
                                <button
                                    key={k}
                                    type="button"
                                    onClick={() => setShow(k)}
                                    aria-pressed={show === k}
                                    className={`rounded-md border px-2.5 py-1 text-xs ${show === k ? "bg-accent font-medium" : "text-muted-foreground hover:bg-accent/50"}`}
                                >
                                    {k === "all" ? "All" : k === "set" ? "Set" : k === "unset" ? "Not set" : "Need attention"}
                                </button>
                            ))}
                        </div>
                    </div>

                    {categories.length === 0 ? <div className="p-4 text-sm text-muted-foreground">No settings match.</div> : null}
                    {categories.map((cat) => (
                        <Panel key={cat} title={cat}>
                            <div className="divide-y">
                                {items.filter((i) => i.category === cat).map((i) => (
                                    <div key={i.key} className="grid gap-1 py-2 sm:grid-cols-[16rem_1fr_auto] sm:items-start sm:gap-3">
                                        <code className="break-all text-sm font-medium">{i.key}</code>
                                        <p className="text-sm text-muted-foreground">
                                            {i.description}
                                            <span className="mt-0.5 block text-xs">Set in: {i.configuredIn}</span>
                                        </p>
                                        <div className="flex flex-wrap items-center gap-1.5 sm:justify-end">
                                            {i.secret ? <Pill tone="neutral">Secret</Pill> : null}
                                            {i.attention ? <Pill tone="warn">{i.importance === "required" ? "Required" : "Recommended"}</Pill> : null}
                                            <Pill tone={i.set ? "good" : "neutral"}>{i.set ? "Set" : "Not set"}</Pill>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </Panel>
                    ))}
                </>
            ) : null}
        </div>
    );
}
