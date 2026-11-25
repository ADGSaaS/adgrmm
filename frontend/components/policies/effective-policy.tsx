"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { jfetch } from "@/lib/api";
import { hasPerm } from "@/lib/permissions";
import { useMe } from "@/lib/use-me";
import { errorText, LEVEL_LABEL, Pill, SourceBadge, valueText, type Level, type Source } from "@/components/policies/shared";

type Row = { key: string; label: string; kind: "value" | "list"; value: unknown; source: Source; overrode: { value: unknown; source: Source }[]; blocked: { value: unknown; source: Source }[] };
type Explained = {
    device: { id: string; name: string; customer: string | null; site: string | null; os: string };
    rows: Row[];
    applied: { policyId: string; name: string; level: Level; priority: number; enforced: boolean }[];
    skipped: { policyId: string; name: string; reason: string }[];
    removed: { list: string; item: string; by: Source; was: Source; why: "allowed" | "banned" }[];
    hash: string;
    maintenance: { windows: { name: string; days: number[]; start: string; end: string; timezone: string }[]; muteAlerts: boolean; source: Source; activeNow: string | null; next: { name: string; at: string } | null } | null;
    actions: { id: string; kind: string; policy: string | null; detail: Record<string, unknown>; at: string }[];
};

const sourceName = (s: Source) => (s.kind === "policy" ? `${s.name} (${LEVEL_LABEL[s.level].toLowerCase()})` : s.label);

/** What this device gets from its policies, one row per setting, with where each came from and what it replaced. */
type TagRef = { id: string; name: string; color: string | null };

/** The tags on this device, so policies for a tag reach it. */
function DeviceTags({ deviceId }: { deviceId: string }) {
    const { permissions } = useMe();
    const canTag = hasPerm(permissions, "devices.write");
    const [mine, setMine] = React.useState<TagRef[] | null>(null);
    const [all, setAll] = React.useState<TagRef[]>([]);
    const [error, setError] = React.useState<string | null>(null);
    const load = React.useCallback(() => {
        jfetch<{ items: TagRef[] }>(`/api/tags/devices/${deviceId}`).then((r) => setMine(r.items)).catch((e) => setError(errorText(e)));
        jfetch<{ items: TagRef[] }>("/api/tags").then((r) => setAll(r.items)).catch(() => setAll([]));
    }, [deviceId]);
    React.useEffect(load, [load]);
    const save = async (ids: string[]) => {
        try {
            setMine((await jfetch<{ items: TagRef[] }>(`/api/tags/devices/${deviceId}`, { method: "PUT", body: { tagIds: ids } })).items);
            setError(null);
        } catch (e) {
            setError(errorText(e));
        }
    };
    if (!mine) return error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null;
    const addable = all.filter((t) => !mine.some((m) => m.id === t.id));
    return (
        <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">Tags:</span>
            {mine.length === 0 && <span className="text-xs text-muted-foreground">none</span>}
            {mine.map((t) => (
                <span key={t.id} className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs">
                    <span className="h-2 w-2 rounded-full border" style={t.color ? { backgroundColor: t.color } : undefined} aria-hidden />
                    {t.name}
                    {canTag && <button type="button" aria-label={`Remove the tag ${t.name}`} className="text-muted-foreground hover:text-foreground" onClick={() => void save(mine.filter((m) => m.id !== t.id).map((m) => m.id))}>&times;</button>}
                </span>
            ))}
            {canTag && addable.length > 0 && (
                <select aria-label="Add a tag" className="h-7 rounded-md border border-input bg-background px-1 text-xs" value="" onChange={(e) => e.target.value && void save([...mine.map((m) => m.id), e.target.value])}>
                    <option value="">Add a tag</option>
                    {addable.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
            )}
            {error && <span role="alert" className="text-xs text-destructive">{error}</span>}
        </div>
    );
}

export default function EffectivePolicy({ deviceId }: { deviceId: string }) {
    const [data, setData] = React.useState<Explained | null>(null);
    const [error, setError] = React.useState<string | null>(null);

    React.useEffect(() => {
        let stale = false;
        setData(null);
        setError(null);
        jfetch<Explained>(`/api/policies/devices/${deviceId}/effective`)
            .then((d) => { if (!stale) setData(d); })
            .catch((e) => { if (!stale) setError(/403|forbidden/i.test(String(e?.message)) ? "You do not have permission to see policies." : errorText(e)); });
        return () => { stale = true; };
    }, [deviceId]);

    if (error) return <p role="alert" className="text-sm text-destructive">{error}</p>;
    if (!data) return <p className="text-sm text-muted-foreground">Loading…</p>;

    const values = data.rows.filter((r) => r.kind === "value");
    const lists = data.rows.filter((r) => r.kind === "list");
    const grouped = new Map<string, Row[]>();
    for (const r of lists) grouped.set(r.key, [...(grouped.get(r.key) ?? []), r]);

    return (
        <div className="grid gap-5">
            <DeviceTags deviceId={deviceId} />
            <div className="flex flex-wrap items-center gap-2 text-sm">
                {data.applied.length === 0 ? (
                    <Pill>No policy reaches this device</Pill>
                ) : (
                    <>
                        <span className="text-muted-foreground">Policies in effect, broadest first:</span>
                        {data.applied.map((a) => <Pill key={a.policyId} tone={a.enforced ? "warn" : "muted"}>{a.name} ({LEVEL_LABEL[a.level].toLowerCase()}){a.enforced ? ", enforced" : ""}</Pill>)}
                    </>
                )}
                <span className="ml-auto text-xs text-muted-foreground" title="Changes whenever what this device gets changes">Version {data.hash}</span>
            </div>

            {data.maintenance && (
                <div role="status" className={cn("px-5 py-4 text-sm hover:bg-accent", data.maintenance.activeNow ? "border-amber-500/50 bg-amber-500/10" : "bg-muted/30")}>
                    {data.maintenance.activeNow ? (
                        <><strong>In maintenance now</strong> ({data.maintenance.activeNow}). {data.maintenance.muteAlerts ? "Alerts for this device are being held back." : "Alerts are still being raised."}</>
                    ) : data.maintenance.next ? (
                        <><strong>Not in maintenance.</strong> The next window, {data.maintenance.next.name}, opens {new Date(data.maintenance.next.at).toLocaleString()}.</>
                    ) : (
                        <><strong>Not in maintenance.</strong> None of its windows opens in the next week.</>
                    )}
                    <span className="ml-1 text-xs text-muted-foreground">Set by <SourceBadge source={data.maintenance.source} /></span>
                </div>
            )}

            <section aria-labelledby="eff-settings" className="grid gap-2">
                <h3 id="eff-settings" className="text-base font-semibold">Settings</h3>
                <div className="overflow-x-auto rounded-xl border border-border/70 bg-card">
                    <table className="w-full min-w-[640px] text-sm">
                        <thead className="border-b border-border/60">
                            <tr><th className="px-5 py-3 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Setting</th><th className="px-5 py-3 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Value</th><th className="px-5 py-3 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Comes from</th><th className="px-5 py-3 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">It replaced</th></tr>
                        </thead>
                        <tbody className="divide-y divide-border/60">
                            {values.map((r) => (
                                <tr key={r.key} className="align-top hover:bg-accent">
                                    <td className="px-5 py-4 text-sm">{r.label}</td>
                                    <td className="px-5 py-4 text-sm font-medium">{valueText(r.key, r.value)}</td>
                                    <td className="px-5 py-4 text-sm"><SourceBadge source={r.source} /></td>
                                    <td className="px-5 py-4 text-xs text-muted-foreground">
                                        {r.overrode.length === 0 ? "Nothing" : r.overrode.map((o, i) => <div key={i}>{valueText(r.key, o.value)} from {sourceName(o.source)}</div>)}
                                        {r.blocked.map((b, i) => <div key={`b${i}`} className="text-amber-600 dark:text-amber-400">{sourceName(b.source)} wanted {valueText(r.key, b.value)}, blocked because this is enforced</div>)}
                                    </td>
                                </tr>
                            ))}
                            {values.length === 0 && <tr><td colSpan={4} className="px-5 py-4 text-sm text-muted-foreground">Nothing is set.</td></tr>}
                        </tbody>
                    </table>
                </div>
            </section>

            {[...grouped.entries()].map(([key, rows]) => (
                <section key={key} aria-label={rows[0].label} className="grid gap-2">
                    <h3 className="text-base font-semibold">{rows[0].label}</h3>
                    <ul className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/70 bg-card">
                        {rows.map((r, i) => (
                            <li key={`${key}-${i}`} className="flex flex-wrap items-center gap-2 px-5 py-3 hover:bg-accent text-sm">
                                <span className="font-medium">{String(r.value)}</span>
                                <SourceBadge source={r.source} />
                                {r.blocked.length > 0 && <span className="text-xs text-amber-600 dark:text-amber-400">A lower policy tried to allow this and was blocked</span>}
                            </li>
                        ))}
                    </ul>
                </section>
            ))}

            {data.removed.length > 0 && (
                <section aria-label="Taken out" className="grid gap-2">
                    <h3 className="text-base font-semibold">Taken out</h3>
                    <ul className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/70 bg-card text-sm">
                        {data.removed.map((r, i) => (
                            <li key={i} className="px-5 py-3 hover:bg-accent">
                                <span className="font-medium">{r.item}</span> was {r.list === "software.required" ? "required" : "banned"} by {sourceName(r.was)}, {r.why === "allowed" ? <>allowed by {sourceName(r.by)}</> : <>and is banned, which wins over required</>}.
                            </li>
                        ))}
                    </ul>
                </section>
            )}

            {data.actions.length > 0 && (
                <section aria-label="Automatic actions" className="grid gap-2">
                    <h3 className="text-base font-semibold">What policies did on this device</h3>
                    <ul className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/70 bg-card text-sm">
                        {data.actions.map((a) => (
                            <li key={a.id} className="flex flex-wrap items-center gap-2 px-5 py-3 hover:bg-accent">
                                <span className="tabular-nums text-xs text-muted-foreground">{new Date(a.at).toLocaleString()}</span>
                                <span className="font-medium">{a.kind === "reboot" ? "Asked the device to restart" : `Started installing ${String(a.detail.count ?? "")} update${Number(a.detail.count) === 1 ? "" : "s"}`}</span>
                                {a.policy && <span className="text-xs text-muted-foreground">because of {a.policy}</span>}
                            </li>
                        ))}
                    </ul>
                </section>
            )}

            {data.skipped.length > 0 && (
                <section aria-label="Policies that did not apply" className="grid gap-2">
                    <h3 className="text-base font-semibold">Reach this device but not applied</h3>
                    <ul className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/70 bg-card text-sm">
                        {data.skipped.map((s) => <li key={s.policyId} className="px-5 py-3 hover:bg-accent"><span className="font-medium">{s.name}</span> <span className="text-muted-foreground">{s.reason}</span></li>)}
                    </ul>
                </section>
            )}
        </div>
    );
}
