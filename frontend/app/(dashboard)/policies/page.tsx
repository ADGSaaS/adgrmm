"use client";

import { PageHeader, PageShell } from "@/components/page-shell";
import * as React from "react";
import { Pager, usePaged } from "@/components/pager";
import { EmptyState, ListToolbar, SegmentedTabs } from "@/components/list-controls";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronDown, Plus } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/use-toast";
import PermGate from "@/components/perm-gate";
import { jfetch } from "@/lib/api";
import { hasPerm } from "@/lib/permissions";
import { useMe } from "@/lib/use-me";
import { PolicyEditor } from "@/components/policies/policy-editor";
import { BaselineTab, TagsTab } from "@/components/policies/tags-and-baseline";
import { SoftwareLibraryTab } from "@/components/policies/software-library-tab";
import { OutdatedAppsTab } from "@/components/policies/outdated-apps-tab";
import { assignmentSummary, badClass, errorText, Field, isEndpointOnly, KIND_HELP, KIND_LABEL, OS_LABEL, Pill, POLICY_KINDS, policyKinds, SECTION_LABEL, templateAsPolicy, type Policy, type PolicyKind, type PolicyTemplate } from "@/components/policies/shared";

type Tab = "policies" | "templates" | "software" | "outdated" | "tags" | "baseline" | "profiles" | "history";
type Profile = { id: string; name: string; description: string | null; checkIds: string[]; checkNames: string[]; usedBy: string[] };
type HistoryItem = { id: string; policyId: string | null; policy: string; action: string; by: string | null; at: string; changes: string[] };
type Reach = { items: { deviceId: string; device: string; customer: string | null; site: string | null; status: "applied" | "skipped"; reason: string | null; winning: number; overridden: number }[]; total: number; applied: number; skipped: number; truncated: boolean };

export default function PoliciesPage() {
    return (
        <PageShell>
            <PageHeader title="Policies" />
            <PermGate require="policies.read" title="No permission" message="You do not have permission to see policies.">
                <PoliciesBody />
            </PermGate>
        </PageShell>
    );
}

type SortKey = "type" | "name" | "applies" | "devices" | "priority";

/** Where a policy sits in the pecking order, broadest first, so Global comes before Customer, Site and Tag. */
const kindRank = (p: Policy) => { const k = policyKinds(p)[0]; return k ? POLICY_KINDS.indexOf(k) : POLICY_KINDS.length; };

/** The choice made before the editor opens: what kind of policy this is. */
function NewPolicyMenu({ onPick, variant = "success" }: { onPick: (k: PolicyKind) => void; variant?: "success" | "outline" }) {
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button variant={variant}><Plus className="mr-1 h-4 w-4" aria-hidden /> New policy <ChevronDown className="ml-1 h-4 w-4 opacity-70" aria-hidden /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-72">
                {POLICY_KINDS.map((k) => (
                    <DropdownMenuItem key={k} onSelect={() => onPick(k)} className="flex flex-col items-start gap-0.5">
                        <span className="font-medium">{KIND_LABEL[k]} policy</span>
                        <span className="text-xs text-muted-foreground">{KIND_HELP[k]}</span>
                    </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

function SortButton({ label, k, sort, onSort }: { label: string; k: SortKey; sort: { key: SortKey; dir: "asc" | "desc" }; onSort: (k: SortKey) => void }) {
    const on = sort.key === k;
    return (
        <button type="button" onClick={() => onSort(k)} aria-label={`Sort by ${label}`} title={`Sort by ${label}`}
            className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground">
            {label}
            {on ? (sort.dir === "asc" ? <ArrowUp className="h-3 w-3" aria-hidden /> : <ArrowDown className="h-3 w-3" aria-hidden />) : <ArrowUpDown className="h-3 w-3 opacity-50" aria-hidden />}
        </button>
    );
}

function PoliciesBody() {
    const { permissions } = useMe();
    const canWrite = hasPerm(permissions, "policies.write");
    const canTag = hasPerm(permissions, "devices.write");
    const canInstall = hasPerm(permissions, "software.install");
    const [tab, setTab] = React.useState<Tab>("policies");
    const [policies, setPolicies] = React.useState<Policy[] | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [editing, setEditing] = React.useState<{ policy: Policy | null; kind?: PolicyKind; seed?: Policy } | null>(null);
    const [kindTab, setKindTab] = React.useState<"all" | PolicyKind>("all");
    const [sort, setSort] = React.useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "type", dir: "asc" });
    const [reachOf, setReachOf] = React.useState<Policy | null>(null);
    // Policies that reach only single endpoints are managed on the endpoint, so they are not listed here.
    const listed = React.useMemo(() => (policies ?? []).filter((p) => !isEndpointOnly(p)), [policies]);
    const shown = React.useMemo(() => {
        const rows = listed.filter((p) => kindTab === "all" || policyKinds(p).includes(kindTab));
        const dir = sort.dir === "asc" ? 1 : -1;
        const by: Record<SortKey, (p: Policy) => string | number> = {
            type: kindRank,
            name: (p) => p.name.toLowerCase(),
            applies: (p) => assignmentSummary(p).toLowerCase(),
            devices: (p) => p.devices ?? 0,
            priority: (p) => p.priority,
        };
        return [...rows].sort((a, b) => {
            const x = by[sort.key](a), y = by[sort.key](b);
            const c = x < y ? -1 : x > y ? 1 : 0;
            // Ties: lowest priority number first, then by name.
            return c * dir || a.priority - b.priority || a.name.localeCompare(b.name);
        });
    }, [listed, kindTab, sort]);
    const pagedPolicies = usePaged(shown, "policies", 25);
    const onSort = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }));
    const kindCount = (k: PolicyKind) => listed.filter((p) => policyKinds(p).includes(k)).length;

    const load = React.useCallback(() => {
        jfetch<{ items: Policy[] }>("/api/policies").then((r) => { setPolicies(r.items); setError(null); }).catch((e) => setError(errorText(e)));
    }, []);
    React.useEffect(load, [load]);

    const act = async (fn: () => Promise<unknown>, done: string) => {
        try {
            await fn();
            toast({ title: done });
            load();
        } catch (e) {
            toast({ title: "Could not do that", description: errorText(e), variant: "destructive" });
        }
    };

    return (
        <div className="space-y-4">
            <p className="max-w-3xl text-sm text-muted-foreground">
                A policy is a set of settings and where they apply: everyone (global), a customer, a site or a tag. Global is the base. When several reach one endpoint, each setting comes from the most specific policy that sets it, in the order global, customer, site, tag, endpoint, and an enforced policy cannot be overridden. Endpoint policies are managed on the endpoint. Open a device&apos;s Policies tab to see what it gets and why. Nothing changes for a device until a policy reaches it.
            </p>

            <ListToolbar
                left={
                    <SegmentedTabs
                        label="Policy views"
                        items={[
                            { key: "policies", label: "Policies" },
                            { key: "templates", label: "Templates" },
                            { key: "software", label: "Software" },
                            { key: "outdated", label: "Outdated apps" },
                            { key: "tags", label: "Tags" },
                            { key: "baseline", label: "Baseline" },
                            { key: "profiles", label: "Check profiles" },
                            { key: "history", label: "History" },
                        ]}
                        value={tab}
                        onChange={(k) => setTab(k as Tab)}
                    />
                }
            />

            {tab === "policies" && (
                <section aria-label="Policies" className="space-y-3">
                    <div className="flex items-center justify-between gap-2">
                        <SegmentedTabs
                            label="Policy type"
                            items={[
                                { key: "all", label: "All", count: listed.length },
                                ...POLICY_KINDS.map((k) => ({ key: k, label: KIND_LABEL[k], count: kindCount(k) })),
                            ]}
                            value={kindTab}
                            onChange={(k) => setKindTab(k as "all" | PolicyKind)}
                        />
                        {canWrite && <NewPolicyMenu onPick={(kind) => setEditing({ policy: null, kind })} />}
                    </div>
                    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
                    {policies && listed.length === 0 && (
                        <EmptyState>
                            No policies yet. Devices use the alert settings, business hours, software lists and remote access notice you already have.
                            {canWrite && <div className="mt-3 flex justify-center"><NewPolicyMenu variant="outline" onPick={(kind) => setEditing({ policy: null, kind })} /></div>}
                        </EmptyState>
                    )}
                    {policies && listed.length > 0 && shown.length === 0 && <EmptyState>No {kindTab === "all" ? "" : KIND_LABEL[kindTab as PolicyKind].toLowerCase() + " "}policies yet.</EmptyState>}
                    {policies && shown.length > 0 && (
                        <>
                        <div className="overflow-x-auto rounded-xl border border-border/70 bg-card">
                            <table className="w-full min-w-[960px] text-sm">
                                <thead className="border-b border-border/60">
                                    <tr>
                                        <th className="px-5 py-3 text-left"><SortButton label="Policy" k="name" sort={sort} onSort={onSort} /></th>
                                        <th className="px-5 py-3 text-left"><SortButton label="Type" k="type" sort={sort} onSort={onSort} /></th>
                                        <th className="px-5 py-3 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Sets</th>
                                        <th className="px-5 py-3 text-left"><SortButton label="Applies to" k="applies" sort={sort} onSort={onSort} /></th>
                                        <th className="px-5 py-3 text-left"><SortButton label="Endpoints" k="devices" sort={sort} onSort={onSort} /></th>
                                        <th className="px-5 py-3 text-left"><SortButton label="Priority" k="priority" sort={sort} onSort={onSort} /></th>
                                        <th className="px-5 py-3 text-left"><span className="sr-only">Actions</span></th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-border/60">
                                    {pagedPolicies.rows.map((p) => (
                                        <tr key={p.id} className="align-top hover:bg-accent">
                                            <td className="px-5 py-4 text-sm">
                                                <button type="button" className="text-left font-medium hover:underline" onClick={() => setEditing({ policy: p })}>{p.name}</button>
                                                <div className="mt-0.5 flex flex-wrap gap-1">
                                                    <Pill tone={p.enabled ? "good" : "muted"}>{p.enabled ? "On" : "Off"}</Pill>
                                                    {p.enforced && <Pill tone="warn">Enforced</Pill>}
                                                    {p.applyToNewCustomers && <Pill>Baseline</Pill>}
                                                    {p.os !== "any" && <Pill>{OS_LABEL[p.os]}</Pill>}
                                                </div>
                                                {p.description && <div className="mt-0.5 max-w-xs text-xs text-muted-foreground">{p.description}</div>}
                                            </td>
                                            <td className="px-5 py-4 text-sm"><div className="flex flex-wrap gap-1">{policyKinds(p).length ? policyKinds(p).map((k) => <Pill key={k}>{KIND_LABEL[k]}</Pill>) : <Pill tone="warn">Not assigned</Pill>}</div></td>
                                            <td className="px-5 py-4 text-sm"><div className="flex flex-wrap gap-1">{p.sectionNames.length ? p.sectionNames.map((s) => <Pill key={s}>{SECTION_LABEL[s] ?? s}</Pill>) : <span className="text-xs text-muted-foreground">Nothing yet</span>}</div></td>
                                            <td className="px-5 py-4 text-xs">{assignmentSummary(p)}</td>
                                            <td className="px-5 py-4 text-sm"><button type="button" className="underline-offset-2 hover:underline" onClick={() => setReachOf(p)}>{p.devices ?? 0}</button></td>
                                            <td className="px-5 py-4 text-sm tabular-nums">{p.priority}</td>
                                            <td className="px-5 py-4 text-sm">
                                                <div className="flex flex-wrap justify-end gap-1">
                                                    <Button variant="ghost" size="sm" onClick={() => setEditing({ policy: p })}>{canWrite ? "Edit" : "View"}</Button>
                                                    {canWrite && (
                                                        <>
                                                            <Button variant="ghost" size="sm" onClick={() => void act(() => jfetch(`/api/policies/${p.id}`, { method: "PATCH", body: { enabled: !p.enabled, version: p.version } }), p.enabled ? "Switched off" : "Switched on")}>{p.enabled ? "Switch off" : "Switch on"}</Button>
                                                            <Button variant="ghost" size="sm" onClick={() => void act(() => jfetch(`/api/policies/${p.id}/duplicate`, { method: "POST" }), "Copied. The copy is switched off.")}>Copy</Button>
                                                            <Button variant="ghost" size="sm" title="Keep its settings as a template" onClick={() => void act(() => jfetch("/api/policies/templates", { method: "POST", body: { name: `${p.name} template`, description: p.description ?? "", priority: p.priority, os: p.os, enforced: p.enforced, sections: p.sections } }), "Saved as a template. See the Templates tab.")}>Save as template</Button>
                                                            <Button variant="ghost" size="sm" onClick={() => { if (window.confirm(`Delete "${p.name}"? Devices go back to what they had before. You can bring it back from History.`)) void act(() => jfetch(`/api/policies/${p.id}`, { method: "DELETE" }), "Deleted"); }}>Delete</Button>
                                                        </>
                                                    )}
                                                </div>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                        <Pager paged={pagedPolicies} className="pt-1" noun="policies" />
                        </>
                    )}
                </section>
            )}

            {tab === "templates" && <TemplatesTab canWrite={canWrite} onUse={(t, kind) => { setTab("policies"); setEditing({ policy: null, kind, seed: templateAsPolicy(t) }); }} />}
            {tab === "software" && <SoftwareLibraryTab canWrite={canWrite} canInstall={canInstall} />}
            {tab === "outdated" && <OutdatedAppsTab canWrite={canWrite} canInstall={canInstall} />}
            {tab === "tags" && <TagsTab canWrite={canWrite} canTag={canTag} />}
            {tab === "baseline" && <BaselineTab canWrite={canWrite} />}
            {tab === "profiles" && <ProfilesTab canWrite={canWrite} />}
            {tab === "history" && <HistoryTab canWrite={canWrite} onRestored={load} />}

            <PolicyEditor open={!!editing} onOpenChange={(o) => !o && setEditing(null)} policy={editing?.policy ?? null} newKind={editing?.kind} seed={editing?.seed ?? null} canWrite={canWrite} onSaved={(m) => { toast({ title: m }); load(); }} />
            <ReachDialog policy={reachOf} onClose={() => setReachOf(null)} />
        </div>
    );
}

/* ------------------------------ templates ------------------------------ */

function TemplatesTab({ canWrite, onUse }: { canWrite: boolean; onUse: (t: PolicyTemplate, kind: PolicyKind) => void }) {
    const [items, setItems] = React.useState<PolicyTemplate[] | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [editing, setEditing] = React.useState<{ template: PolicyTemplate | null } | null>(null);
    const load = React.useCallback(() => {
        jfetch<{ items: PolicyTemplate[] }>("/api/policies/templates").then((r) => { setItems(r.items); setError(null); }).catch((e) => setError(errorText(e)));
    }, []);
    React.useEffect(load, [load]);
    const paged = usePaged(items ?? [], "policy-templates", 25);
    const remove = async (t: PolicyTemplate) => {
        if (!window.confirm(`Delete the template "${t.name}"? Policies already made from it are not affected.`)) return;
        try { await jfetch(`/api/policies/templates/${t.id}`, { method: "DELETE" }); toast({ title: "Deleted" }); load(); } catch (e) { toast({ title: "Could not delete", description: errorText(e), variant: "destructive" }); }
    };
    return (
        <section aria-label="Templates" className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="max-w-2xl text-sm text-muted-foreground">A template is a set of settings kept as a pattern. It applies to nothing. Use it to start a global, customer, site or tag policy with those settings, then edit the policy.</p>
                {canWrite && <Button variant="success" onClick={() => setEditing({ template: null })}><Plus className="mr-1 h-4 w-4" aria-hidden /> New template</Button>}
            </div>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            {items === null && !error && <p className="text-sm text-muted-foreground">Loading…</p>}
            {items?.length === 0 && <EmptyState>No templates yet. Make one here, or choose Save as template on any policy.</EmptyState>}
            {items && items.length > 0 && (
                <div className="overflow-hidden rounded-xl border border-border/70 bg-card">
                    <ul className="divide-y divide-border/60">
                        {paged.rows.map((t) => (
                            <li key={t.id} className="flex flex-wrap items-start justify-between gap-2 px-5 py-4 text-sm hover:bg-accent">
                                <div className="min-w-0">
                                    <div className="font-medium">{t.name}</div>
                                    {t.description && <div className="text-xs text-muted-foreground">{t.description}</div>}
                                    <div className="mt-1 flex flex-wrap gap-1">
                                        {t.sectionNames.length ? t.sectionNames.map((s) => <Pill key={s}>{SECTION_LABEL[s] ?? s}</Pill>) : <span className="text-xs text-muted-foreground">Nothing set yet</span>}
                                        {t.enforced && <Pill tone="warn">Enforced</Pill>}
                                        {t.os !== "any" && <Pill>{OS_LABEL[t.os]}</Pill>}
                                    </div>
                                </div>
                                <div className="flex flex-wrap items-center justify-end gap-1">
                                    {canWrite && (
                                        <DropdownMenu>
                                            <DropdownMenuTrigger asChild>
                                                <Button variant="outline" size="sm">Use as <ChevronDown className="ml-1 h-3.5 w-3.5 opacity-70" aria-hidden /></Button>
                                            </DropdownMenuTrigger>
                                            <DropdownMenuContent align="end" className="w-72">
                                                {POLICY_KINDS.map((k) => (
                                                    <DropdownMenuItem key={k} onSelect={() => onUse(t, k)} className="flex flex-col items-start gap-0.5">
                                                        <span className="font-medium">{KIND_LABEL[k]} policy</span>
                                                        <span className="text-xs text-muted-foreground">{KIND_HELP[k]}</span>
                                                    </DropdownMenuItem>
                                                ))}
                                            </DropdownMenuContent>
                                        </DropdownMenu>
                                    )}
                                    <Button variant="ghost" size="sm" onClick={() => setEditing({ template: t })}>{canWrite ? "Edit" : "View"}</Button>
                                    {canWrite && <Button variant="ghost" size="sm" onClick={() => void remove(t)}>Delete</Button>}
                                </div>
                            </li>
                        ))}
                    </ul>
                </div>
            )}
            {items && items.length > 0 && <Pager paged={paged} noun="templates" />}
            <PolicyEditor template open={!!editing} onOpenChange={(o) => !o && setEditing(null)} policy={editing?.template ? templateAsPolicy(editing.template) : null} canWrite={canWrite} onSaved={(m) => { toast({ title: m }); load(); }} />
        </section>
    );
}

/* ------------------------------ devices a policy reaches ------------------------------ */

function ReachDialog({ policy, onClose }: { policy: Policy | null; onClose: () => void }) {
    const [data, setData] = React.useState<Reach | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    React.useEffect(() => {
        if (!policy) return;
        setData(null);
        setError(null);
        jfetch<Reach>(`/api/policies/${policy.id}/devices`).then(setData).catch((e) => setError(errorText(e)));
    }, [policy]);
    const paged = usePaged(data?.items ?? [], "policy-devices", 25);
    return (
        <Dialog open={!!policy} onOpenChange={(o) => !o && onClose()}>
            <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
                <DialogHeader>
                    <DialogTitle>{policy?.name}</DialogTitle>
                    <DialogDescription>The devices this policy reaches, and what it does on each.</DialogDescription>
                </DialogHeader>
                {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
                {!data && !error && <p className="text-sm text-muted-foreground">Loading…</p>}
                {data && (
                    <div className="grid gap-2">
                        <p className="text-sm"><strong>{data.applied}</strong> applied{data.skipped ? <>, <strong>{data.skipped}</strong> reached but not applied</> : null}.</p>
                        {data.items.length === 0 && <p className="text-sm text-muted-foreground">It does not reach any device. Check where it applies, and that it is switched on.</p>}
                        <div className="overflow-hidden rounded-xl border border-border/70 bg-card">
                        <ul className="divide-y divide-border/60">
                            {paged.rows.map((d) => (
                                <li key={d.deviceId} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm hover:bg-accent">
                                    <span><span className="font-medium">{d.device}</span> <span className="text-muted-foreground">{[d.customer, d.site].filter(Boolean).join(" / ")}</span></span>
                                    {d.status === "applied"
                                        ? <span className="text-xs text-muted-foreground">{d.winning} setting{d.winning === 1 ? "" : "s"} in effect{d.overridden ? `, ${d.overridden} overridden by another policy` : ""}</span>
                                        : <Pill tone="warn">{d.reason}</Pill>}
                                </li>
                            ))}
                        </ul>
                        </div>
                        {data.items.length > 0 && <Pager paged={paged} noun="devices" />}
                        {data.truncated && <p className="text-xs text-muted-foreground">Only the first 1000 are listed.</p>}
                    </div>
                )}
                <DialogFooter><Button variant="outline" onClick={onClose}>Close</Button></DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

/* ------------------------------ check profiles ------------------------------ */

function ProfilesTab({ canWrite }: { canWrite: boolean }) {
    const [profiles, setProfiles] = React.useState<Profile[] | null>(null);
    const [editing, setEditing] = React.useState<{ profile: Profile | null } | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const load = React.useCallback(() => {
        jfetch<{ items: Profile[] }>("/api/policies/check-profiles").then((r) => { setProfiles(r.items); setError(null); }).catch((e) => setError(errorText(e)));
    }, []);
    React.useEffect(load, [load]);
    const paged = usePaged(profiles ?? [], "check-profiles", 25);
    return (
        <section aria-label="Check profiles" className="space-y-3">
            <div className="flex items-center justify-between gap-2">
                <p className="max-w-2xl text-sm text-muted-foreground">A check profile is a named set of checks, such as &quot;Servers&quot;. Add a profile to a policy and every device it reaches runs those checks.</p>
                {canWrite && <Button variant="success" onClick={() => setEditing({ profile: null })}><Plus className="mr-1 h-4 w-4" aria-hidden /> New profile</Button>}
            </div>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            {profiles === null && !error && <p className="text-sm text-muted-foreground">Loading…</p>}
            {profiles && profiles.length === 0 && <EmptyState>No check profiles yet.</EmptyState>}
            {profiles && profiles.length > 0 && (
            <div className="overflow-hidden rounded-xl border border-border/70 bg-card">
            <ul className="divide-y divide-border/60">
                {paged.rows.map((p) => (
                    <li key={p.id} className="flex flex-wrap items-start justify-between gap-2 px-5 py-4 text-sm hover:bg-accent">
                        <div>
                            <div className="font-medium">{p.name}</div>
                            {p.description && <div className="text-xs text-muted-foreground">{p.description}</div>}
                            <div className="mt-1 text-xs">{p.checkNames.length ? p.checkNames.join(", ") : <span className="text-muted-foreground">No checks in it yet</span>}</div>
                            {p.usedBy.length > 0 && <div className="mt-1 text-xs text-muted-foreground">Used by {p.usedBy.join(", ")}</div>}
                        </div>
                        {canWrite && (
                            <div className="flex gap-1">
                                <Button variant="ghost" size="sm" onClick={() => setEditing({ profile: p })}>Edit</Button>
                                <Button variant="destructive" size="sm" disabled={p.usedBy.length > 0} title={p.usedBy.length ? "Take it out of its policies first" : undefined}
                                    onClick={async () => {
                                        if (!window.confirm(`Delete the profile "${p.name}"?`)) return;
                                        try { await jfetch(`/api/policies/check-profiles/${p.id}`, { method: "DELETE" }); toast({ title: "Deleted" }); load(); } catch (e) { toast({ title: "Could not delete", description: errorText(e), variant: "destructive" }); }
                                    }}>Delete</Button>
                            </div>
                        )}
                    </li>
                ))}
            </ul>
            </div>
            )}
            {profiles && profiles.length > 0 && <Pager paged={paged} noun="profiles" />}
            <ProfileDialog state={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />
        </section>
    );
}

function ProfileDialog({ state, onClose, onSaved }: { state: { profile: Profile | null } | null; onClose: () => void; onSaved: () => void }) {
    const profile = state?.profile ?? null;
    const [name, setName] = React.useState("");
    const [description, setDescription] = React.useState("");
    const [ids, setIds] = React.useState<string[]>([]);
    const [checks, setChecks] = React.useState<{ id: string; name: string }[]>([]);
    const [tried, setTried] = React.useState(false);
    const [saving, setSaving] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);

    React.useEffect(() => {
        if (!state) return;
        setName(profile?.name ?? "");
        setDescription(profile?.description ?? "");
        setIds(profile?.checkIds ?? []);
        setTried(false);
        setError(null);
        jfetch<{ items: { id: string; name: string }[] }>("/api/checks").then((r) => setChecks(r.items.map((c) => ({ id: c.id, name: c.name })))).catch(() => setChecks([]));
    }, [state, profile]);

    const submit = async (event: React.FormEvent) => {
        event.preventDefault();
        setTried(true);
        if (!name.trim()) { setError("Some details need fixing. They are marked in red."); return; }
        setSaving(true);
        setError(null);
        try {
            const body = { name: name.trim(), description, checkIds: ids };
            await jfetch(profile ? `/api/policies/check-profiles/${profile.id}` : "/api/policies/check-profiles", { method: profile ? "PATCH" : "POST", body });
            toast({ title: "Saved" });
            onSaved();
        } catch (e) {
            setError(errorText(e));
        } finally {
            setSaving(false);
        }
    };

    return (
        <Dialog open={!!state} onOpenChange={(o) => !saving && !o && onClose()}>
            <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
                <form onSubmit={submit} noValidate>
                    <DialogHeader>
                        <DialogTitle>{profile ? "Edit check profile" : "New check profile"}</DialogTitle>
                        <DialogDescription>Choose the checks that go together.</DialogDescription>
                    </DialogHeader>
                    <div className="grid gap-1 py-3">
                        <Field label="Name *" htmlFor="cp-name" error={tried && !name.trim() ? "Required" : undefined}>
                            <Input id="cp-name" value={name} maxLength={120} aria-invalid={tried && !name.trim()} className={tried && !name.trim() ? badClass : ""} onChange={(e) => setName(e.target.value)} placeholder="Servers" />
                        </Field>
                        <Field label="Description" htmlFor="cp-desc">
                            <Textarea id="cp-desc" rows={2} maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} />
                        </Field>
                        <div className="grid gap-1">
                            <span className="text-sm font-medium">Checks</span>
                            {checks.length === 0 && <p className="text-sm text-muted-foreground">There are no checks yet. Create them under Alerts.</p>}
                            <div className="grid max-h-56 gap-1 overflow-y-auto">
                                {checks.map((c) => (
                                    <label key={c.id} className="flex items-center gap-2 rounded-md border px-2 py-1 text-sm">
                                        <input type="checkbox" checked={ids.includes(c.id)} onChange={() => setIds((cur) => cur.includes(c.id) ? cur.filter((x) => x !== c.id) : [...cur, c.id])} />
                                        {c.name}
                                    </label>
                                ))}
                            </div>
                        </div>
                    </div>
                    <DialogFooter className="items-center gap-2 sm:justify-between">
                        <p role="alert" className="min-h-5 text-sm text-destructive">{error ?? ""}</p>
                        <div className="flex gap-2">
                            <Button type="button" variant="outline" disabled={saving} onClick={onClose}>Cancel</Button>
                            <Button type="submit" variant="success" disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
                        </div>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

/* ------------------------------ history ------------------------------ */

function HistoryTab({ canWrite, onRestored }: { canWrite: boolean; onRestored: () => void }) {
    const [items, setItems] = React.useState<HistoryItem[] | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const load = React.useCallback(() => {
        jfetch<{ items: HistoryItem[] }>("/api/policies/history?limit=200").then((r) => { setItems(r.items); setError(null); }).catch((e) => setError(errorText(e)));
    }, []);
    React.useEffect(load, [load]);
    const paged = usePaged(items ?? [], "policy-history", 25);
    return (
        <section aria-label="History" className="space-y-3">
            <p className="max-w-2xl text-sm text-muted-foreground">Every change to a policy, who made it and when. Restore puts a policy back as it was after that change, including one that was deleted.</p>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            {items === null && !error && <p className="text-sm text-muted-foreground">Loading…</p>}
            {items?.length === 0 && <EmptyState>Nothing has changed yet.</EmptyState>}
            {items && items.length > 0 && (
            <div className="overflow-hidden rounded-xl border border-border/70 bg-card">
            <ul className="divide-y divide-border/60">
                {paged.rows.map((h) => (
                    <li key={h.id} className="flex flex-wrap items-start justify-between gap-2 px-5 py-4 text-sm hover:bg-accent">
                        <div>
                            <div><span className="font-medium">{h.policy}</span> <Pill>{h.action}</Pill> <span className="text-xs text-muted-foreground">by {h.by ?? "someone"} on {new Date(h.at).toLocaleString()}</span></div>
                            {h.changes.length > 0 && <ul className="mt-1 text-xs text-muted-foreground">{h.changes.map((c, i) => <li key={i}>{c}</li>)}</ul>}
                        </div>
                        {canWrite && h.action !== "restored" && (
                            <Button size="sm" variant="outline" onClick={async () => {
                                if (!window.confirm(h.action === "deleted" ? `Bring back "${h.policy}" as it was before it was deleted?` : `Put "${h.policy}" back as it was after this change?`)) return;
                                try { await jfetch(`/api/policies/history/${h.id}/restore`, { method: "POST" }); toast({ title: "Restored" }); load(); onRestored(); } catch (e) { toast({ title: "Could not restore", description: errorText(e), variant: "destructive" }); }
                            }}>Restore</Button>
                        )}
                    </li>
                ))}
            </ul>
            </div>
            )}
            {items && items.length > 0 && <Pager paged={paged} noun="changes" />}
        </section>
    );
}
