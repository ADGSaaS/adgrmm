"use client";

// Roles matrix: every role against every permission, read from the same roles the Roles tab edits. A box can be
// ticked or cleared here when the server would allow it: Owner always has everything, and nobody can give a
// permission they do not hold themselves or change a role stronger than they are. The server checks all of that
// again on every change, so a box that looks editable but is refused simply goes back.
import * as React from "react";
import { Check, Lock, Table2 } from "lucide-react";
import { jfetch } from "@/lib/api";
import { useMe } from "@/lib/use-me";
import { Header, messageOf } from "../platform-common";
import type { ToastFn } from "../types";

type Role = { id: string; name: string; description?: string; permissions: string[]; usersCount: number };
type Group = { key: string; label: string; items: { key: string; label: string; description?: string }[] };

const isOwnerName = (n: string) => n.trim().toLowerCase() === "owner";

export default function RolesMatrixTab({ push }: { push: ToastFn }) {
    const { user, permissions } = useMe();
    const mine = React.useMemo(() => new Set((Array.isArray(permissions) ? permissions : []).map((p: string) => String(p).toLowerCase())), [permissions]);
    const iAmOwner = (user?.roles ?? [user?.role]).some((r) => isOwnerName(String(r ?? "")));
    const canWrite = iAmOwner || mine.has("roles.write");

    const [roles, setRoles] = React.useState<Role[] | null>(null);
    const [groups, setGroups] = React.useState<Group[]>([]);
    const [error, setError] = React.useState<string | null>(null);
    const [busy, setBusy] = React.useState<string | null>(null);

    React.useEffect(() => {
        Promise.all([jfetch<Role[]>("/api/roles"), jfetch<{ groups: Group[] }>("/api/roles/permission-keys")])
            .then(([r, k]) => {
                setRoles(r);
                setGroups(k.groups ?? []);
            })
            .catch((e) => {
                setError(messageOf(e));
                push({ title: "Could not load roles", desc: messageOf(e), kind: "destructive" });
            });
    }, [push]);

    const holds = (r: Role, key: string) => isOwnerName(r.name) || r.permissions.includes(key);

    /** Why a box cannot be changed by this person, or null when it can. */
    function lockedReason(r: Role, key: string): string | null {
        if (isOwnerName(r.name)) return "Owner always has every permission.";
        if (!canWrite) return "You can view roles but not change them.";
        if (iAmOwner) return null;
        if (!mine.has(key)) return "You cannot give or take a permission you do not hold yourself.";
        if (r.permissions.some((p) => !mine.has(p))) return "This role holds permissions you do not, so it is not yours to change.";
        return null;
    }

    async function toggle(r: Role, key: string) {
        const next = r.permissions.includes(key) ? r.permissions.filter((p) => p !== key) : [...r.permissions, key];
        const id = `${r.id}:${key}`;
        setBusy(id);
        setRoles((cur) => (cur ?? []).map((x) => (x.id === r.id ? { ...x, permissions: next } : x)));
        try {
            await jfetch(`/api/roles/${r.id}`, { method: "PATCH", body: { permissions: next } });
        } catch (e) {
            setRoles((cur) => (cur ?? []).map((x) => (x.id === r.id ? { ...x, permissions: r.permissions } : x)));
            push({ title: "That change was refused", desc: messageOf(e), kind: "destructive" });
        } finally {
            setBusy(null);
        }
    }

    return (
        <div className="grid gap-4">
            <Header icon={<Table2 className="h-5 w-5" aria-hidden />} title="Roles matrix">
                Every role against every permission, read from the same roles the Roles tab edits.
                {canWrite ? " Tick or clear a box to change a role at once; each change is recorded in the audit log." : " You can view the matrix but not change it."}
                {" "}Owner always has everything, and nobody can give a permission they do not hold.
            </Header>
            {error ? <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</div> : null}
            {!roles && !error ? <div className="p-4 text-sm text-muted-foreground">Loading…</div> : null}
            {roles ? (
                <div className="max-h-[75vh] overflow-auto rounded-xl border border-border/70 bg-card">
                    <table className="w-full border-separate border-spacing-0 text-sm">
                        <thead>
                            <tr>
                                <th className="sticky left-0 top-0 z-20 min-w-[16rem] border-b bg-card px-4 py-3 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Permission</th>
                                {roles.map((r) => (
                                    <th key={r.id} className="sticky top-0 z-10 border-b bg-card px-3 py-3 text-center text-xs font-medium" title={r.description || undefined}>
                                        <div className="flex items-center justify-center gap-1">
                                            {isOwnerName(r.name) ? <Lock className="h-3 w-3 text-muted-foreground" aria-hidden /> : null}
                                            {r.name}
                                        </div>
                                        <div className="text-[10px] font-normal text-muted-foreground">{r.usersCount} {r.usersCount === 1 ? "person" : "people"}</div>
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {groups.map((g) => (
                                <React.Fragment key={g.key}>
                                    <tr>
                                        <td colSpan={roles.length + 1} className="sticky left-0 bg-muted/40 px-4 py-1.5 text-xs font-semibold">{g.label}</td>
                                    </tr>
                                    {g.items.map((p) => (
                                        <tr key={p.key} className="hover:bg-accent/40">
                                            <td className="sticky left-0 z-[1] border-b border-border/60 bg-card px-4 py-2">
                                                <div className="font-medium">{p.label}</div>
                                                <code className="text-[11px] text-muted-foreground">{p.key}</code>
                                            </td>
                                            {roles.map((r) => {
                                                const on = holds(r, p.key);
                                                const locked = lockedReason(r, p.key);
                                                return (
                                                    <td key={r.id} className="border-b border-border/60 px-3 py-2 text-center">
                                                        <button
                                                            type="button"
                                                            role="checkbox"
                                                            aria-checked={on}
                                                            aria-label={`${r.name}: ${p.label}`}
                                                            title={locked ?? (on ? "Click to take this permission away" : "Click to give this permission")}
                                                            disabled={!!locked || busy === `${r.id}:${p.key}`}
                                                            onClick={() => void toggle(r, p.key)}
                                                            className={`mx-auto flex h-6 w-6 items-center justify-center rounded border ${on ? "border-emerald-600 bg-emerald-600 text-white" : "border-border bg-background"} ${locked ? "opacity-50" : "hover:ring-2 hover:ring-ring"}`}
                                                        >
                                                            {on ? <Check className="h-4 w-4" aria-hidden /> : null}
                                                        </button>
                                                    </td>
                                                );
                                            })}
                                        </tr>
                                    ))}
                                </React.Fragment>
                            ))}
                        </tbody>
                    </table>
                </div>
            ) : null}
        </div>
    );
}
