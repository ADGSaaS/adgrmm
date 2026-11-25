"use client";

import * as React from "react";
import Link from "next/link";
import { jfetch } from "@/lib/api";
import { Pager, usePaged } from "@/components/pager";
import { EmptyState, FilterSelect, ListToolbar } from "@/components/list-controls";
import { errorText, Pill } from "@/components/policies/shared";

type Item = { id: string; kind: "script" | "patch" | "action"; title: string; deviceId: string; device: string; customer: string | null; site: string | null; at: string; status: "failed" | "timed out" | "skipped"; reason: string };
type Result = {
    days: number;
    summary: { failed: number; timedOut: number; skipped: number; scripts: number; patches: number; actions: number };
    worstDevices: { deviceId: string; device: string; customer: string | null; count: number }[];
    items: Item[];
    truncated: boolean;
};

const KIND_LABEL: Record<Item["kind"], string> = { script: "Script", patch: "Updates", action: "Device action" };

/** Everything that failed on its own, in one list: scripts, update scans and installs, restarts. */
export default function FailuresPanel() {
    const [days, setDays] = React.useState("7");
    const [kind, setKind] = React.useState("");
    const [showSkipped, setShowSkipped] = React.useState(true);
    const [data, setData] = React.useState<Result | null>(null);
    const [error, setError] = React.useState<string | null>(null);

    const load = React.useCallback(() => {
        const sp = new URLSearchParams({ days });
        if (kind) sp.set("kind", kind);
        if (!showSkipped) sp.set("skipped", "false");
        jfetch<Result>(`/api/automation/failures?${sp.toString()}`).then((r) => { setData(r); setError(null); }).catch((e) => setError(errorText(e)));
    }, [days, kind, showSkipped]);
    React.useEffect(load, [load]);
    const paged = usePaged(data?.items ?? [], "automation-failures", 25);

    return (
        <div className="space-y-4">
            <ListToolbar
                right={
                    <>
                        <FilterSelect
                            label="Period"
                            value={days}
                            onChange={setDays}
                            options={[
                                { value: "1", label: "Last day" },
                                { value: "7", label: "Last 7 days" },
                                { value: "30", label: "Last 30 days" },
                                { value: "90", label: "Last 90 days" },
                            ]}
                        />
                        <FilterSelect
                            label="What"
                            value={kind}
                            onChange={setKind}
                            options={[
                                { value: "", label: "Everything" },
                                { value: "script", label: "Scripts" },
                                { value: "patch", label: "Updates" },
                                { value: "action", label: "Device actions" },
                            ]}
                        />
                        <label className="flex items-center gap-2 text-sm">
                            <input type="checkbox" checked={showSkipped} onChange={(e) => setShowSkipped(e.target.checked)} />
                            Show skipped
                        </label>
                    </>
                }
            />

            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            {!data && !error && <p className="text-sm text-muted-foreground">Loading…</p>}

            {data && (
                <>
                    <div className="flex flex-wrap gap-2 text-sm">
                        <Pill tone={data.summary.failed ? "bad" : "good"}>{data.summary.failed} failed</Pill>
                        <Pill tone={data.summary.timedOut ? "warn" : "muted"}>{data.summary.timedOut} timed out</Pill>
                        <Pill>{data.summary.skipped} skipped</Pill>
                        <span className="text-xs text-muted-foreground">Scripts {data.summary.scripts}, updates {data.summary.patches}, device actions {data.summary.actions}. Skipped means there was nobody signed in to run it for, so nothing needs fixing.</span>
                    </div>
                    {data.worstDevices.length > 0 && (
                        <p className="text-sm">
                            <span className="text-muted-foreground">Most failures: </span>
                            {data.worstDevices.map((d, i) => (
                                <span key={d.deviceId}>{i > 0 ? ", " : ""}<Link className="underline-offset-2 hover:underline" href={`/devices/${d.deviceId}`}>{d.device}</Link> ({d.count})</span>
                            ))}
                        </p>
                    )}
                    {data.items.length === 0 && <EmptyState>Nothing failed in this period.</EmptyState>}
                    <div className="overflow-hidden rounded-xl border border-border/70 bg-card">
                    <ul className="divide-y divide-border/60">
                        {paged.rows.map((i) => (
                            <li key={`${i.kind}-${i.id}`} className="px-5 py-4 text-sm hover:bg-accent">
                                <div className="flex flex-wrap items-center gap-2">
                                    <Pill tone={i.status === "failed" ? "bad" : i.status === "timed out" ? "warn" : "muted"}>{i.status === "failed" ? "Failed" : i.status === "timed out" ? "Timed out" : "Skipped"}</Pill>
                                    <span className="font-medium">{i.title}</span>
                                    <span className="text-xs text-muted-foreground">{KIND_LABEL[i.kind]}</span>
                                    <span className="ml-auto text-xs tabular-nums text-muted-foreground">{new Date(i.at).toLocaleString()}</span>
                                </div>
                                <div className="mt-1 text-xs">
                                    <Link className="font-medium underline-offset-2 hover:underline" href={`/devices/${i.deviceId}`}>{i.device}</Link>
                                    <span className="text-muted-foreground"> {[i.customer, i.site].filter(Boolean).join(" / ")}</span>
                                </div>
                                <p className="mt-1 break-words text-xs text-muted-foreground">{i.reason}</p>
                            </li>
                        ))}
                    </ul>
                    </div>
                    {data.items.length > 0 && <Pager paged={paged} noun="failures" />}
                    {data.truncated && <p className="text-xs text-muted-foreground">Only the newest are listed.</p>}
                </>
            )}
        </div>
    );
}
