"use client";

import * as React from "react";
import { Pager, usePaged } from "@/components/pager";
import { EmptyState, ListToolbar, SearchField, SegmentedTabs } from "@/components/list-controls";
import { Users as UsersIcon } from "lucide-react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { TabsContent } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { jfetch } from "@/lib/api";
import { useMe } from "@/lib/use-me";
import { hasPerm } from "@/lib/permissions";
import { badClass, errorText, Field, Pill } from "@/components/policies/shared";
import { PermissionPicker, ScopePicker, SCOPE_LABEL, usePermissionGroups, type ScopeItem } from "@/components/access/pickers";

export type GroupsTabProps = { push: (t: any) => void };

type Group = { id: string; name: string; description: string | null; memberCount: number; permissions: string[]; scope: ScopeItem[]; updatedAt: string };
type Person = { id: string; name: string; email: string; status: string };
type Detail = Group & { members: Person[] };
type Section = "details" | "members" | "permissions" | "access";

const SECTIONS: { v: Section; label: string }[] = [
    { v: "details", label: "Details" },
    { v: "members", label: "Members" },
    { v: "permissions", label: "Permissions" },
    { v: "access", label: "What they can see" },
];

function accessSummary(g: Pick<Group, "scope">): string {
    if (g.scope.length === 0) return "Everything";
    const n = (k: ScopeItem["kind"]) => g.scope.filter((s) => s.kind === k).length;
    const parts = [
        n("customer") && `${n("customer")} customer${n("customer") === 1 ? "" : "s"}`,
        n("site") && `${n("site")} site${n("site") === 1 ? "" : "s"}`,
        n("tag") && `${n("tag")} tag${n("tag") === 1 ? "" : "s"}`,
    ].filter(Boolean);
    return `Only ${parts.join(", ")}`;
}

export default function GroupsTab({ push }: GroupsTabProps) {
    const { permissions } = useMe();
    const canWrite = hasPerm(permissions, "groups.write");
    const [groups, setGroups] = React.useState<Group[] | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [filter, setFilter] = React.useState("");
    const [editing, setEditing] = React.useState<{ id: string | null } | null>(null);
    const [removing, setRemoving] = React.useState<Group | null>(null);

    const load = React.useCallback(() => {
        jfetch<Group[]>("/api/admin/groups").then((g) => { setGroups(g); setError(null); }).catch((e) => setError(errorText(e)));
    }, []);
    React.useEffect(load, [load]);

    const shown = (groups ?? []).filter((g) => !filter.trim() || g.name.toLowerCase().includes(filter.trim().toLowerCase()) || (g.description ?? "").toLowerCase().includes(filter.trim().toLowerCase()));

    const paged = usePaged(shown, "admin-groups", 25);

    const remove = async () => {
        if (!removing) return;
        try {
            await jfetch(`/api/admin/groups/${removing.id}`, { method: "DELETE" });
            push?.({ title: "Group deleted", description: `${removing.name} no longer gives anyone permissions or limits what they see.` });
            setRemoving(null);
            load();
        } catch (e) {
            push?.({ title: "Could not delete that", description: errorText(e), variant: "destructive" });
            setRemoving(null);
        }
    };

    return (
        <TabsContent value="groups">
            <Card className="border-0 bg-transparent shadow-none">
                <CardHeader className="p-0 pb-5">
                    <CardTitle className="text-xl tracking-tight">Groups</CardTitle>
                    <CardDescription>
                        Put technicians into groups. A group can give permissions on top of each person&apos;s role, and can limit which customers, sites and tagged devices its members see. A person gets everything from their role plus everything from every group they are in. If neither they nor their groups name any customer, site or tag, they see everything.
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4 rounded-xl border border-border/70 bg-card p-5 shadow-sm">
                    <ListToolbar
                        right={
                            <>
                                <SearchField label="Search groups" placeholder="Search groups" value={filter} onChange={setFilter} />
                                {canWrite && <Button onClick={() => setEditing({ id: null })}>New group</Button>}
                            </>
                        }
                    />
                    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
                    {!groups && !error && <p className="text-sm text-muted-foreground">Loading…</p>}
                    {groups && groups.length === 0 && (
                        <EmptyState>
                            <UsersIcon className="mx-auto mb-2 h-6 w-6" aria-hidden />
                            No groups yet. Make one for each team, such as Help desk, Network team, or Acme technicians.
                        </EmptyState>
                    )}
                    <ul className="grid gap-2">
                        {paged.rows.map((g) => (
                            <li key={g.id} className="rounded-xl border border-border/70 bg-card p-4 transition-colors hover:bg-accent">
                                <div className="flex flex-wrap items-start gap-3">
                                    <div className="min-w-0 flex-1">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <span className="font-medium">{g.name}</span>
                                            <Pill>{g.memberCount} {g.memberCount === 1 ? "person" : "people"}</Pill>
                                            <Pill tone={g.permissions.length ? "good" : "muted"}>{g.permissions.length ? `${g.permissions.length} permission${g.permissions.length === 1 ? "" : "s"}` : "No extra permissions"}</Pill>
                                            <Pill tone={g.scope.length ? "warn" : "muted"}>{accessSummary(g)}</Pill>
                                        </div>
                                        {g.description && <p className="mt-1 text-sm text-muted-foreground">{g.description}</p>}
                                        {g.scope.length > 0 && (
                                            <p className="mt-1 text-xs text-muted-foreground">
                                                {g.scope.slice(0, 6).map((s) => `${SCOPE_LABEL[s.kind]}: ${s.kind === "site" && s.customer ? `${s.customer} / ${s.name}` : s.name}`).join(", ")}
                                                {g.scope.length > 6 ? ` and ${g.scope.length - 6} more` : ""}
                                            </p>
                                        )}
                                    </div>
                                    <div className="flex gap-2">
                                        <Button size="sm" variant="outline" onClick={() => setEditing({ id: g.id })}>{canWrite ? "Edit" : "View"}</Button>
                                        {canWrite && <Button size="sm" variant="destructive" onClick={() => setRemoving(g)}>Delete</Button>}
                                    </div>
                                </div>
                            </li>
                        ))}
                    </ul>
                    {shown.length > 0 && <Pager paged={paged} noun="groups" />}
                    {groups && groups.length > 0 && shown.length === 0 && <p className="text-sm text-muted-foreground">No group matches that.</p>}
                </CardContent>
            </Card>

            {editing && <GroupEditor id={editing.id} canWrite={canWrite} onClose={() => setEditing(null)} onSaved={(msg) => { setEditing(null); push?.({ title: "Saved", description: msg }); load(); }} />}

            <AlertDialog open={!!removing} onOpenChange={(o) => !o && setRemoving(null)}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Delete {removing?.name}?</AlertDialogTitle>
                        <AlertDialogDescription>
                            {removing?.memberCount ? `${removing.memberCount} ${removing.memberCount === 1 ? "person is" : "people are"} in it. ` : ""}
                            They lose the permissions this group gave them{removing?.scope.length ? " and the limit it put on what they see (they may then see more)" : ""}. This cannot be undone.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Keep it</AlertDialogCancel>
                        <AlertDialogAction onClick={() => void remove()}>Delete group</AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </TabsContent>
    );
}

function GroupEditor({ id, canWrite, onClose, onSaved }: { id: string | null; canWrite: boolean; onClose: () => void; onSaved: (message: string) => void }) {
    const { permissions: mine } = useMe();
    const catalogue = usePermissionGroups();
    const [section, setSection] = React.useState<Section>("details");
    const [loaded, setLoaded] = React.useState(id === null);
    const [name, setName] = React.useState("");
    const [description, setDescription] = React.useState("");
    const [perms, setPerms] = React.useState<string[]>([]);
    const [scope, setScope] = React.useState<ScopeItem[]>([]);
    const [memberIds, setMemberIds] = React.useState<string[]>([]);
    const [people, setPeople] = React.useState<Person[]>([]);
    const [peopleFilter, setPeopleFilter] = React.useState("");
    const [error, setError] = React.useState<string | null>(null);
    const [tried, setTried] = React.useState(false);
    const [saving, setSaving] = React.useState(false);

    React.useEffect(() => {
        jfetch<{ items: { id: string; name: string; email: string; status: string }[] }>("/api/admin/users?pageSize=500&sortKey=name").then((r) => setPeople(r.items)).catch(() => setPeople([]));
    }, []);
    React.useEffect(() => {
        if (!id) return;
        jfetch<Detail>(`/api/admin/groups/${id}`)
            .then((d) => { setName(d.name); setDescription(d.description ?? ""); setPerms(d.permissions); setScope(d.scope); setMemberIds(d.members.map((m) => m.id)); setLoaded(true); })
            .catch((e) => { setError(errorText(e)); setLoaded(true); });
    }, [id]);

    // People may only hand out permissions they hold themselves.
    const blocked = React.useMemo(() => {
        const mineSet = new Set((Array.isArray(mine) ? mine : []).map((p: string) => p.toLowerCase()));
        return new Set(catalogue.flatMap((g) => g.items.map((i) => i.key)).filter((k) => !mineSet.has(k)));
    }, [mine, catalogue]);

    const nameBad = tried && name.trim().length < 2;
    const readOnly = !canWrite;

    const save = async () => {
        setTried(true);
        if (name.trim().length < 2) { setSection("details"); return; }
        setSaving(true);
        setError(null);
        try {
            const body = { name: name.trim(), description: description.trim() || null, permissions: perms, scope: scope.map((s) => ({ kind: s.kind, id: s.id })), memberIds };
            if (id) await jfetch(`/api/admin/groups/${id}`, { method: "PATCH", body });
            else await jfetch("/api/admin/groups", { method: "POST", body });
            onSaved(`${name.trim()} saved.`);
        } catch (e) {
            setError(errorText(e));
        } finally {
            setSaving(false);
        }
    };

    const term = peopleFilter.trim().toLowerCase();
    const listed = people.filter((p) => !term || p.name.toLowerCase().includes(term) || p.email.toLowerCase().includes(term));
    const toggleMember = (pid: string) => setMemberIds((m) => (m.includes(pid) ? m.filter((x) => x !== pid) : [...m, pid]));

    return (
        <Dialog open onOpenChange={(o) => !o && onClose()}>
            <DialogContent className="max-h-[90vh] max-w-4xl overflow-hidden">
                <DialogHeader>
                    <DialogTitle>{id ? (readOnly ? "Group" : "Edit group") : "New group"}</DialogTitle>
                    <DialogDescription>Members get this group&apos;s permissions on top of their role, and see only what is chosen under What they can see.</DialogDescription>
                </DialogHeader>
                <SegmentedTabs
                    label="Group sections"
                    value={section}
                    onChange={(k) => setSection(k as Section)}
                    items={SECTIONS.map((s) => ({
                        key: s.v,
                        label: s.v === "details" && nameBad ? `${s.label} !` : s.label,
                        count: s.v === "members" ? memberIds.length : s.v === "permissions" ? perms.length : undefined,
                    }))}
                />
                <div className="min-h-[340px] overflow-y-auto pr-1" style={{ maxHeight: "58vh" }}>
                    {!loaded && <p className="text-sm text-muted-foreground">Loading…</p>}
                    {loaded && section === "details" && (
                        <div className="grid max-w-xl gap-2 pt-3">
                            <Field label="Name" htmlFor="group-name" error={nameBad ? "Give the group a name of at least 2 characters." : undefined} hint="For example Help desk or Acme technicians.">
                                <Input id="group-name" value={name} disabled={readOnly} onChange={(e) => setName(e.target.value)} maxLength={64} aria-invalid={nameBad} className={cn(nameBad && badClass)} />
                            </Field>
                            <Field label="Description" htmlFor="group-desc" hint="Optional. Say who belongs here and why.">
                                <Textarea id="group-desc" value={description} disabled={readOnly} onChange={(e) => setDescription(e.target.value)} rows={3} />
                            </Field>
                        </div>
                    )}
                    {loaded && section === "members" && (
                        <div className="grid gap-3 pt-3">
                            <div className="flex flex-wrap items-center gap-3">
                                <Input aria-label="Search people" className="max-w-xs" placeholder="Search people" value={peopleFilter} onChange={(e) => setPeopleFilter(e.target.value)} />
                                <span className="text-sm text-muted-foreground">{memberIds.length} in this group</span>
                            </div>
                            <div className="grid gap-1.5 sm:grid-cols-2">
                                {listed.map((p) => (
                                    <label key={p.id} className="flex items-center gap-2 rounded border px-2 py-1.5 text-sm">
                                        <Checkbox checked={memberIds.includes(p.id)} disabled={readOnly} onCheckedChange={() => toggleMember(p.id)} aria-label={`${p.name} is in the group`} />
                                        <span className="min-w-0 flex-1 truncate"><span className="font-medium">{p.name}</span> <span className="text-muted-foreground">{p.email}</span></span>
                                        {p.status !== "active" && <Pill tone={p.status === "suspended" ? "bad" : "warn"}>{p.status}</Pill>}
                                    </label>
                                ))}
                            </div>
                            {people.length === 0 && <p className="text-sm text-muted-foreground">No people to choose from.</p>}
                        </div>
                    )}
                    {loaded && section === "permissions" && (
                        <div className="pt-3">
                            <p className="mb-3 text-sm text-muted-foreground">What members can do on top of their role. You can only give permissions you have yourself.</p>
                            <PermissionPicker groups={catalogue} value={perms} onChange={setPerms} blocked={blocked} disabled={readOnly} />
                        </div>
                    )}
                    {loaded && section === "access" && (
                        <div className="pt-3">
                            <ScopePicker value={scope} onChange={setScope} disabled={readOnly} />
                        </div>
                    )}
                </div>
                {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
                <DialogFooter>
                    <Button variant="ghost" onClick={onClose}>{readOnly ? "Close" : "Cancel"}</Button>
                    {!readOnly && <Button onClick={() => void save()} disabled={saving || !loaded}>{saving ? "Saving..." : "Save group"}</Button>}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
