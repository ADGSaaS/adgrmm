"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { jfetch } from "@/lib/api";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { useSites } from "@/components/reports/full-report";
import { selectClass } from "@/components/policies/shared";

export type PermGroup = { key: string; label: string; items: { key: string; label: string; description?: string }[] };
export type ScopeItem = { kind: "customer" | "site" | "tag"; id: string; name?: string; customer?: string };

export const SCOPE_LABEL: Record<ScopeItem["kind"], string> = { customer: "Customer", site: "Site", tag: "Tag" };

/** The permission catalogue, loaded once per screen. */
export function usePermissionGroups(): PermGroup[] {
    const [groups, setGroups] = React.useState<PermGroup[]>([]);
    React.useEffect(() => {
        jfetch<{ groups?: PermGroup[] }>("/api/roles/permission-keys").then((r) => setGroups(r.groups ?? [])).catch(() => setGroups([]));
    }, []);
    return groups;
}

/**
 * Permissions as grouped checkboxes with a search and a switch per group. `blocked` are permissions the
 * person editing does not hold themselves: they show but cannot be switched on, because nobody can hand out
 * what they lack.
 */
export function PermissionPicker({ groups, value, onChange, blocked, disabled }: { groups: PermGroup[]; value: string[]; onChange: (next: string[]) => void; blocked?: ReadonlySet<string>; disabled?: boolean }) {
    const [filter, setFilter] = React.useState("");
    const chosen = React.useMemo(() => new Set(value), [value]);
    const term = filter.trim().toLowerCase();
    const set = (keys: string[], on: boolean) => {
        const next = new Set(chosen);
        for (const k of keys) {
            if (on) { if (!blocked?.has(k)) next.add(k); } else next.delete(k);
        }
        onChange([...next]);
    };
    const visible = groups
        .map((g) => ({ ...g, items: g.items.filter((i) => !term || i.label.toLowerCase().includes(term) || i.key.toLowerCase().includes(term) || (i.description ?? "").toLowerCase().includes(term)) }))
        .filter((g) => g.items.length);

    return (
        <div className="grid gap-3">
            <div className="flex flex-wrap items-center gap-3">
                <Input aria-label="Search permissions" className="max-w-xs" placeholder="Search permissions" value={filter} onChange={(e) => setFilter(e.target.value)} />
                <span className="text-sm text-muted-foreground">{value.length} selected</span>
            </div>
            {visible.length === 0 && <p className="text-sm text-muted-foreground">No permission matches that.</p>}
            <div className="grid gap-3 md:grid-cols-2">
                {visible.map((g) => {
                    const keys = g.items.map((i) => i.key).filter((k) => !blocked?.has(k));
                    const all = keys.length > 0 && keys.every((k) => chosen.has(k));
                    const some = g.items.some((i) => chosen.has(i.key));
                    return (
                        <fieldset key={g.key} className="rounded-md border p-3" disabled={disabled}>
                            <legend className="sr-only">{g.label}</legend>
                            <label className="mb-2 flex items-center gap-2 text-sm font-medium">
                                <Checkbox checked={all ? true : some ? "indeterminate" : false} disabled={disabled || keys.length === 0} onCheckedChange={(v) => set(keys, v === true)} aria-label={`All ${g.label} permissions`} />
                                {g.label}
                            </label>
                            <div className="grid gap-1.5 pl-6">
                                {g.items.map((i) => {
                                    const off = blocked?.has(i.key) && !chosen.has(i.key);
                                    return (
                                        <label key={i.key} className={cn("flex items-start gap-2 text-sm", off && "opacity-50")} title={off ? "You do not have this permission yourself, so you cannot give it." : i.description}>
                                            <Checkbox className="mt-0.5" checked={chosen.has(i.key)} disabled={disabled || off} onCheckedChange={(v) => set([i.key], v === true)} aria-label={i.label} />
                                            <span>{i.label}</span>
                                        </label>
                                    );
                                })}
                            </div>
                        </fieldset>
                    );
                })}
            </div>
        </div>
    );
}

const key = (s: Pick<ScopeItem, "kind" | "id">) => `${s.kind}:${s.id}`;

/** Pick what a group may see: whole customers, single sites, or every device carrying a tag. */
export function ScopePicker({ value, onChange, disabled }: { value: ScopeItem[]; onChange: (next: ScopeItem[]) => void; disabled?: boolean }) {
    const [customers, setCustomers] = React.useState<{ key: string; name: string }[] | null>(null);
    const [tags, setTags] = React.useState<{ id: string; name: string }[] | null>(null);
    const [siteClient, setSiteClient] = React.useState("");
    const [filter, setFilter] = React.useState("");
    const sites = useSites(siteClient);
    React.useEffect(() => {
        jfetch<{ key: string; name: string }[]>("/api/customers").then(setCustomers).catch(() => setCustomers([]));
        jfetch<{ items: { id: string; name: string }[] }>("/api/tags").then((r) => setTags(r.items)).catch(() => setTags([]));
    }, []);

    const chosen = React.useMemo(() => new Set(value.map(key)), [value]);
    const toggle = (item: ScopeItem) => onChange(chosen.has(key(item)) ? value.filter((v) => key(v) !== key(item)) : [...value, item]);
    const term = filter.trim().toLowerCase();
    const customerList = customers ?? [];
    const tagList = tags ?? [];
    const siteClientName = customerList.find((c) => c.key === siteClient)?.name;

    return (
        <div className="grid gap-4">
            <p className="text-sm text-muted-foreground">
                Leave this empty and the group does not limit what people see. Add anything and people in the group (and nothing else of theirs) can reach only what is added here.
            </p>
            {value.length > 0 && (
                <div className="flex flex-wrap gap-2" aria-label="Chosen access">
                    {value.map((v) => (
                        <button key={key(v)} type="button" disabled={disabled} onClick={() => toggle(v)} className="inline-flex items-center gap-1 rounded-full border bg-muted px-2.5 py-1 text-xs hover:bg-muted/70" title="Click to remove">
                            <span className="text-muted-foreground">{SCOPE_LABEL[v.kind]}</span>
                            <span className="font-medium">{v.kind === "site" && v.customer ? `${v.customer} / ${v.name}` : v.name}</span>
                            <span aria-hidden>×</span>
                        </button>
                    ))}
                </div>
            )}
            <Input aria-label="Search customers and tags" className="max-w-xs" placeholder="Search customers and tags" value={filter} onChange={(e) => setFilter(e.target.value)} />
            <div className="grid gap-4 md:grid-cols-3">
                <section className="rounded-md border p-3">
                    <h4 className="mb-2 text-sm font-medium">Whole customers</h4>
                    <div className="grid max-h-56 gap-1.5 overflow-auto">
                        {customerList.filter((c) => !term || c.name.toLowerCase().includes(term)).map((c) => (
                            <label key={c.key} className="flex items-center gap-2 text-sm">
                                <Checkbox checked={chosen.has(`customer:${c.key}`)} disabled={disabled} onCheckedChange={() => toggle({ kind: "customer", id: c.key, name: c.name })} aria-label={`Customer ${c.name}`} />
                                {c.name}
                            </label>
                        ))}
                        {customers === null && <p className="text-sm text-muted-foreground">Loading...</p>}
                        {customers !== null && customers.length === 0 && <p className="text-sm text-muted-foreground">No customers yet.</p>}
                    </div>
                </section>
                <section className="rounded-md border p-3">
                    <h4 className="mb-2 text-sm font-medium">Single sites</h4>
                    <select aria-label="Customer whose sites to show" className={cn(selectClass, "mb-2")} value={siteClient} onChange={(e) => setSiteClient(e.target.value)}>
                        <option value="">Choose a customer</option>
                        {customerList.map((c) => <option key={c.key} value={c.key}>{c.name}</option>)}
                    </select>
                    <div className="grid max-h-44 gap-1.5 overflow-auto">
                        {siteClient && sites.length === 0 && <p className="text-sm text-muted-foreground">That customer has no sites.</p>}
                        {sites.map((s) => (
                            <label key={s.id} className="flex items-center gap-2 text-sm">
                                <Checkbox checked={chosen.has(`site:${s.id}`)} disabled={disabled} onCheckedChange={() => toggle({ kind: "site", id: s.id, name: s.name, customer: siteClientName })} aria-label={`Site ${s.name}`} />
                                {s.name}
                            </label>
                        ))}
                    </div>
                </section>
                <section className="rounded-md border p-3">
                    <h4 className="mb-2 text-sm font-medium">Tags (across customers)</h4>
                    <div className="grid max-h-56 gap-1.5 overflow-auto">
                        {tagList.filter((t) => !term || t.name.toLowerCase().includes(term)).map((t) => (
                            <label key={t.id} className="flex items-center gap-2 text-sm">
                                <Checkbox checked={chosen.has(`tag:${t.id}`)} disabled={disabled} onCheckedChange={() => toggle({ kind: "tag", id: t.id, name: t.name })} aria-label={`Tag ${t.name}`} />
                                {t.name}
                            </label>
                        ))}
                        {tags === null && <p className="text-sm text-muted-foreground">Loading...</p>}
                        {tags !== null && tags.length === 0 && <p className="text-sm text-muted-foreground">No tags yet. Make them under Policies, Tags.</p>}
                    </div>
                </section>
            </div>
        </div>
    );
}

/** The groups a person can be put into, as checkboxes. Shows nothing when there are no groups or the viewer may not see them. */
export function GroupChoices({ value, onChange, disabled }: { value: string[]; onChange: (next: string[]) => void; disabled?: boolean }) {
    const [groups, setGroups] = React.useState<{ id: string; name: string; description: string | null; permissions: string[]; scope: unknown[] }[] | null>(null);
    React.useEffect(() => {
        jfetch<typeof groups>("/api/admin/groups").then(setGroups).catch(() => setGroups([]));
    }, []);
    if (!groups || groups.length === 0) return null;
    return (
        <fieldset className="grid gap-2 rounded-md border p-3" disabled={disabled}>
            <legend className="px-1 text-sm font-medium">Groups</legend>
            <div className="grid gap-1.5 sm:grid-cols-2">
                {groups.map((g) => (
                    <label key={g.id} className="flex items-start gap-2 text-sm" title={g.description ?? undefined}>
                        <Checkbox className="mt-0.5" checked={value.includes(g.id)} onCheckedChange={(v) => onChange(v === true ? [...value, g.id] : value.filter((x) => x !== g.id))} aria-label={`In the ${g.name} group`} />
                        <span>
                            {g.name}
                            <span className="block text-xs text-muted-foreground">
                                {g.permissions.length ? `${g.permissions.length} permission${g.permissions.length === 1 ? "" : "s"}` : "No extra permissions"}
                                {g.scope.length ? `, limits what they see` : ""}
                            </span>
                        </span>
                    </label>
                ))}
            </div>
        </fieldset>
    );
}

type Access = {
    owner: boolean;
    limited: boolean;
    permissions: { key: string; label: string; group: string; from: { kind: "role" | "group"; name: string }[] }[];
    scope: { from: { kind: "person" | "group"; name: string }; kind: ScopeItem["kind"]; id: string; name: string; customer?: string }[];
    groups: { id: string; name: string }[];
    roles: { id: string; name: string }[];
};

/** Everything a person can do and see, and which role, group or limit each piece comes from. */
export function EffectiveAccess({ userId }: { userId: string }) {
    const [data, setData] = React.useState<Access | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    React.useEffect(() => {
        setData(null);
        jfetch<Access>(`/api/admin/users/${userId}/access`).then((d) => { setData(d); setError(null); }).catch((e) => setError(e instanceof Error ? "Could not load this person's access." : "Could not load."));
    }, [userId]);
    if (error) return <p role="alert" className="text-sm text-destructive">{error}</p>;
    if (!data) return <p className="text-sm text-muted-foreground">Loading...</p>;

    const byGroup = new Map<string, Access["permissions"]>();
    for (const p of data.permissions) byGroup.set(p.group, [...(byGroup.get(p.group) ?? []), p]);

    return (
        <div className="grid gap-3 text-sm">
            <p>
                <span className="text-muted-foreground">Role: </span>{data.roles.length ? data.roles.map((r) => r.name).join(", ") : "none"}
                <span className="ml-4 text-muted-foreground">Groups: </span>{data.groups.length ? data.groups.map((g) => g.name).join(", ") : "none"}
            </p>
            <div>
                <h4 className="mb-1 font-medium">What they can see</h4>
                {!data.limited && <p className="text-muted-foreground">Every customer, site and device.</p>}
                {data.limited && (
                    <ul className="grid gap-1">
                        {data.scope.map((s, i) => (
                            <li key={`${s.kind}-${s.id}-${i}`} className="flex flex-wrap items-center gap-2">
                                <span className="text-muted-foreground">{SCOPE_LABEL[s.kind]}</span>
                                <span className="font-medium">{s.kind === "site" && s.customer ? `${s.customer} / ${s.name}` : s.name}</span>
                                <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{s.from.kind === "group" ? `Group: ${s.from.name}` : s.from.name}</span>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
            <div>
                <h4 className="mb-1 font-medium">What they can do ({data.permissions.length})</h4>
                {data.permissions.length === 0 && <p className="text-muted-foreground">Nothing yet.</p>}
                <div className="grid gap-1">
                    {[...byGroup.entries()].map(([group, items]) => (
                        <details key={group} className="rounded border px-2 py-1">
                            <summary className="cursor-pointer">{group} <span className="text-xs text-muted-foreground">({items.length})</span></summary>
                            <ul className="mt-1 grid gap-0.5 pb-1">
                                {items.map((p) => (
                                    <li key={p.key} className="flex flex-wrap items-center gap-2">
                                        <span>{p.label}</span>
                                        {p.from.map((f, i) => (
                                            <span key={i} className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{f.kind === "role" ? `Role: ${f.name}` : `Group: ${f.name}`}</span>
                                        ))}
                                    </li>
                                ))}
                            </ul>
                        </details>
                    ))}
                </div>
            </div>
        </div>
    );
}
