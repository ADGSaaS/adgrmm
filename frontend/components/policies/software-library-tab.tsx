"use client";

import * as React from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/use-toast";
import { EmptyState, FilterSelect, ListToolbar, SearchField } from "@/components/list-controls";
import { Pager, usePaged } from "@/components/pager";
import { jfetch } from "@/lib/api";
import { useDeviceChoices, useSites } from "@/components/reports/full-report";
import { badClass, errorText, Field, Pill, selectClass } from "@/components/policies/shared";
import { SoftwareInstallLog } from "@/components/software-install-log";

export type LibraryEntry = {
    id: string;
    name: string;
    category: string;
    matchText: string;
    publisher: string | null;
    chocolateyId: string | null;
    chocolateyParams?: string | null;
    chocolateyInstallArgs?: string | null;
    wingetId: string | null;
    installerUrl: string | null;
    installerSha256: string | null;
    installerKind: "exe" | "msi" | null;
    silentArgs: string | null;
    linuxPackage: string | null;
    notes: string | null;
    builtIn: boolean;
    installable: boolean;
    devices: number;
};
type SeenItem = { name: string; publisher: string | null; devices: number };
type Eligible = { deviceId: string; device: string; customer: string | null; site: string | null; hasIt: boolean };
type Skipped = { deviceId: string; device: string; customer?: string | null; site?: string | null; reason: string };
type PreviewResult = { eligible: Eligible[]; skipped: Skipped[]; total: number };
type SortKey = "name" | "category" | "matchText" | "how" | "devices";

const DEFAULT_CATEGORIES = ["Browsers", "Remote access", "Security", "Office and productivity", "Utilities", "Backup", "Communication", "Media", "Developer", "Other"];
const how = (e: Pick<LibraryEntry, "chocolateyId" | "installerUrl" | "installable">) => (e.chocolateyId ? "Chocolatey" : e.installerUrl && e.installable ? "Direct download" : "Not installable");

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

/* ------------------------------ the tab ------------------------------ */

export function SoftwareLibraryTab({ canWrite, canInstall }: { canWrite: boolean; canInstall: boolean }) {
    // Bumped when an install is queued so the activity list looks again at once.
    const [logTick, setLogTick] = React.useState(0);
    const [items, setItems] = React.useState<LibraryEntry[] | null>(null);
    const [categories, setCategories] = React.useState<string[]>([]);
    const [error, setError] = React.useState<string | null>(null);
    const [seen, setSeen] = React.useState<SeenItem[] | null>(null);
    const [seenError, setSeenError] = React.useState<string | null>(null);
    const [seenQ, setSeenQ] = React.useState("");
    const [q, setQ] = React.useState("");
    const [category, setCategory] = React.useState("all");
    const [sort, setSort] = React.useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "category", dir: "asc" });
    const [editing, setEditing] = React.useState<{ entry: LibraryEntry | null; seed?: Partial<FormState> } | null>(null);
    const [acting, setActing] = React.useState<{ entry: LibraryEntry; action: "install" | "uninstall" } | null>(null);

    const load = React.useCallback(() => {
        jfetch<{ items: LibraryEntry[]; categories: string[] }>("/api/software-library")
            .then((r) => { setItems(r.items); setCategories(r.categories ?? []); setError(null); })
            .catch((e) => setError(errorText(e)));
        jfetch<{ items: SeenItem[] }>("/api/software-library/seen")
            .then((r) => { setSeen(r.items); setSeenError(null); })
            .catch((e) => setSeenError(errorText(e)));
    }, []);
    React.useEffect(load, [load]);

    const shown = React.useMemo(() => {
        const needle = q.trim().toLowerCase();
        const rows = (items ?? []).filter((e) => (category === "all" || e.category === category)
            && (!needle || [e.name, e.matchText, e.publisher ?? "", e.category, e.chocolateyId ?? ""].some((s) => s.toLowerCase().includes(needle))));
        const dir = sort.dir === "asc" ? 1 : -1;
        const by: Record<SortKey, (e: LibraryEntry) => string | number> = {
            name: (e) => e.name.toLowerCase(), category: (e) => e.category.toLowerCase(), matchText: (e) => e.matchText.toLowerCase(),
            how: (e) => how(e), devices: (e) => e.devices,
        };
        return [...rows].sort((a, b) => {
            const x = by[sort.key](a), y = by[sort.key](b);
            return (x < y ? -1 : x > y ? 1 : 0) * dir || a.name.localeCompare(b.name);
        });
    }, [items, q, category, sort]);
    const paged = usePaged(shown, "software-library", 25);
    const onSort = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }));

    const shownSeen = React.useMemo(() => {
        const needle = seenQ.trim().toLowerCase();
        return (seen ?? []).filter((s) => !needle || s.name.toLowerCase().includes(needle) || (s.publisher ?? "").toLowerCase().includes(needle));
    }, [seen, seenQ]);
    const pagedSeen = usePaged(shownSeen, "software-seen", 10);

    const remove = async (e: LibraryEntry) => {
        if (!window.confirm(`Delete "${e.name}" from the library? Policies that already list it by name keep working. Software already installed is not touched.`)) return;
        try { await jfetch(`/api/software-library/${e.id}`, { method: "DELETE" }); toast({ title: "Deleted" }); load(); } catch (err) { toast({ title: "Could not delete", description: errorText(err), variant: "destructive" }); }
    };

    const categoryOptions = React.useMemo(() => {
        const all = Array.from(new Set([...categories, ...(items ?? []).map((i) => i.category)])).sort((a, b) => a.localeCompare(b));
        return [{ value: "all", label: "All categories" }, ...all.map((c) => ({ value: c, label: c }))];
    }, [categories, items]);

    return (
        <section aria-label="Software" className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="max-w-2xl text-sm text-muted-foreground">
                    The software library is the list of programs your policies can require or ban, and that you can install or remove on endpoints. A policy matches the installed program names that contain an entry&apos;s match text. Installing and removing work on Windows endpoints that are online.
                </p>
                {canWrite && <Button variant="success" onClick={() => setEditing({ entry: null })}><Plus className="mr-1 h-4 w-4" aria-hidden /> Add software</Button>}
            </div>

            <ListToolbar
                left={<FilterSelect label="Category" value={category} onChange={setCategory} options={categoryOptions} className="w-full sm:w-56" />}
                right={<SearchField value={q} onChange={setQ} placeholder="Search the library" label="Search the software library" />}
            />

            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            {items === null && !error && <p className="text-sm text-muted-foreground">Loading…</p>}
            {items && items.length === 0 && <EmptyState>The library is empty. {canWrite ? "Add software, or pick one from the list of programs seen on your endpoints below." : ""}</EmptyState>}
            {items && items.length > 0 && shown.length === 0 && <EmptyState>Nothing in the library matches.</EmptyState>}
            {shown.length > 0 && (
                <>
                    <div className="overflow-x-auto rounded-xl border border-border/70 bg-card">
                        <table className="w-full min-w-[820px] text-sm">
                            <thead className="border-b border-border/60">
                                <tr>
                                    <th className="px-5 py-3 text-left"><SortButton label="Name" k="name" sort={sort} onSort={onSort} /></th>
                                    <th className="px-5 py-3 text-left"><SortButton label="Category" k="category" sort={sort} onSort={onSort} /></th>
                                    <th className="px-5 py-3 text-left"><SortButton label="Matches" k="matchText" sort={sort} onSort={onSort} /></th>
                                    <th className="px-5 py-3 text-left"><SortButton label="Installs by" k="how" sort={sort} onSort={onSort} /></th>
                                    <th className="px-5 py-3 text-left"><SortButton label="Endpoints" k="devices" sort={sort} onSort={onSort} /></th>
                                    <th className="px-5 py-3 text-left"><span className="sr-only">Actions</span></th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-border/60">
                                {paged.rows.map((e) => (
                                    <tr key={e.id} className="align-top hover:bg-accent">
                                        <td className="px-5 py-4">
                                            <div className="font-medium">{e.name}</div>
                                            {e.publisher && <div className="text-xs text-muted-foreground">{e.publisher}</div>}
                                        </td>
                                        <td className="px-5 py-4"><Pill>{e.category}</Pill></td>
                                        <td className="px-5 py-4 text-xs">{e.matchText}</td>
                                        <td className="px-5 py-4 text-xs">{e.installable ? how(e) : <span className="text-muted-foreground">Not installable</span>}</td>
                                        <td className="px-5 py-4 tabular-nums">{e.devices}</td>
                                        <td className="px-5 py-4">
                                            <div className="flex flex-wrap justify-end gap-1">
                                                {canInstall && <Button variant="outline" size="sm" disabled={!e.installable} title={e.installable ? undefined : "Add a Chocolatey id, or an installer link with its SHA-256, to make this installable"} onClick={() => setActing({ entry: e, action: "install" })}>Install</Button>}
                                                {canInstall && <Button variant="ghost" size="sm" disabled={!e.chocolateyId} title={e.chocolateyId ? undefined : "Uninstalling needs a Chocolatey id"} onClick={() => setActing({ entry: e, action: "uninstall" })}>Uninstall</Button>}
                                                <Button variant="ghost" size="sm" onClick={() => setEditing({ entry: e })}>{canWrite ? "Edit" : "View"}</Button>
                                                {canWrite && <Button variant="ghost" size="sm" onClick={() => void remove(e)}>Delete</Button>}
                                            </div>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    <Pager paged={paged} className="pt-1" noun="programs" />
                </>
            )}

            <div className="space-y-3 pt-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                        <h2 className="text-sm font-semibold">Seen on your endpoints</h2>
                        <p className="max-w-2xl text-xs text-muted-foreground">Programs found on endpoints that no library entry covers yet, most endpoints first.</p>
                    </div>
                    <SearchField value={seenQ} onChange={setSeenQ} placeholder="Search seen programs" label="Search programs seen on endpoints" />
                </div>
                {seenError && <p role="alert" className="text-sm text-destructive">{seenError}</p>}
                {seen === null && !seenError && <p className="text-sm text-muted-foreground">Loading…</p>}
                {seen && seen.length === 0 && <EmptyState>Every program found on your endpoints is already covered by the library.</EmptyState>}
                {seen && seen.length > 0 && shownSeen.length === 0 && <EmptyState>No seen program matches.</EmptyState>}
                {shownSeen.length > 0 && (
                    <>
                        <div className="overflow-hidden rounded-xl border border-border/70 bg-card">
                            <ul className="divide-y divide-border/60">
                                {pagedSeen.rows.map((s) => (
                                    <li key={s.name} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm hover:bg-accent">
                                        <div className="min-w-0">
                                            <div className="break-words font-medium">{s.name}</div>
                                            <div className="text-xs text-muted-foreground">{[s.publisher, `${s.devices} endpoint${s.devices === 1 ? "" : "s"}`].filter(Boolean).join(" · ")}</div>
                                        </div>
                                        {canWrite && <Button variant="outline" size="sm" onClick={() => setEditing({ entry: null, seed: { name: s.name, matchText: s.name, publisher: s.publisher ?? "" } })}>Add to library</Button>}
                                    </li>
                                ))}
                            </ul>
                        </div>
                        <Pager paged={pagedSeen} noun="programs" />
                    </>
                )}
            </div>

            {canInstall && (
                <div className="pt-2">
                    <SoftwareInstallLog refreshKey={logTick} title="Install activity" />
                </div>
            )}

            <EntryDialog state={editing} categories={categories} canWrite={canWrite} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />
            <ActionDialog state={acting} onClose={() => setActing(null)} onDone={() => { load(); setLogTick((n) => n + 1); }} />
        </section>
    );
}

/* ------------------------------ add / edit ------------------------------ */

type FormState = { name: string; category: string; matchText: string; publisher: string; chocolateyId: string; chocolateyParams: string; chocolateyInstallArgs: string; wingetId: string; installerUrl: string; installerSha256: string; installerKind: "" | "exe" | "msi"; silentArgs: string; linuxPackage: string; notes: string };
const blankForm = (): FormState => ({ name: "", category: "Other", matchText: "", publisher: "", chocolateyId: "", chocolateyParams: "", chocolateyInstallArgs: "", wingetId: "", installerUrl: "", installerSha256: "", installerKind: "", silentArgs: "", linuxPackage: "", notes: "" });
const fromEntry = (e: LibraryEntry): FormState => ({
    name: e.name, category: e.category, matchText: e.matchText, publisher: e.publisher ?? "", chocolateyId: e.chocolateyId ?? "", chocolateyParams: e.chocolateyParams ?? "", chocolateyInstallArgs: e.chocolateyInstallArgs ?? "", wingetId: e.wingetId ?? "", installerUrl: e.installerUrl ?? "",
    installerSha256: e.installerSha256 ?? "", installerKind: e.installerKind ?? "", silentArgs: e.silentArgs ?? "", linuxPackage: e.linuxPackage ?? "", notes: e.notes ?? "",
});
const CHOCO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

function formProblems(f: FormState): Record<string, string> {
    const p: Record<string, string> = {};
    if (!f.name.trim()) p.name = "Required";
    if (!f.matchText.trim()) p.matchText = "Required";
    if (f.chocolateyId.trim() && !CHOCO.test(f.chocolateyId.trim())) p.chocolateyId = "Letters, numbers, dots, dashes";
    const url = f.installerUrl.trim();
    if (url) {
        let ok = false;
        try { const u = new URL(url); ok = u.protocol === "https:" && !u.username && !u.password; } catch { ok = false; }
        if (!ok) p.installerUrl = "Must be an https link";
        if (!/^[0-9a-fA-F]{64}$/.test(f.installerSha256.trim())) p.installerSha256 = "Needs the 64-character SHA-256";
        if (!f.installerKind) p.installerKind = "Choose exe or msi";
    } else if (f.installerSha256.trim() && !/^[0-9a-fA-F]{64}$/.test(f.installerSha256.trim())) {
        p.installerSha256 = "Must be 64 hex characters";
    }
    return p;
}

function EntryDialog({ state, categories, canWrite, onClose, onSaved }: { state: { entry: LibraryEntry | null; seed?: Partial<FormState> } | null; categories: string[]; canWrite: boolean; onClose: () => void; onSaved: () => void }) {
    const entry = state?.entry ?? null;
    const [form, setForm] = React.useState<FormState>(blankForm);
    const [tried, setTried] = React.useState(false);
    const [saving, setSaving] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    React.useEffect(() => {
        if (!state) return;
        setForm(state.entry ? fromEntry(state.entry) : { ...blankForm(), ...state.seed });
        setTried(false);
        setError(null);
    }, [state]);
    const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));
    const errs = tried ? formProblems(form) : {};
    const cats = Array.from(new Set([...(categories.length ? categories : DEFAULT_CATEGORIES), form.category].filter(Boolean)));
    const bad = (k: string) => (errs[k] ? badClass : "");

    const submit = async (event: React.FormEvent) => {
        event.preventDefault();
        setTried(true);
        if (Object.keys(formProblems(form)).length) { setError("Some details need fixing. They are marked in red."); return; }
        const nul = (s: string) => (s.trim() ? s.trim() : null);
        const body = {
            name: form.name.trim(), category: form.category, matchText: form.matchText.trim(), publisher: nul(form.publisher), chocolateyId: nul(form.chocolateyId), chocolateyParams: nul(form.chocolateyParams), chocolateyInstallArgs: nul(form.chocolateyInstallArgs), wingetId: nul(form.wingetId),
            installerUrl: nul(form.installerUrl), installerSha256: nul(form.installerSha256)?.toLowerCase() ?? null, installerKind: form.installerUrl.trim() ? form.installerKind || null : null,
            silentArgs: nul(form.silentArgs), linuxPackage: nul(form.linuxPackage), notes: nul(form.notes),
        };
        setSaving(true);
        setError(null);
        try {
            await jfetch(entry ? `/api/software-library/${entry.id}` : "/api/software-library", { method: entry ? "PATCH" : "POST", body });
            toast({ title: entry ? "Saved" : "Added to the library" });
            onSaved();
        } catch (err) {
            setError(errorText(err));
        } finally {
            setSaving(false);
        }
    };

    return (
        <Dialog open={!!state} onOpenChange={(o) => !saving && !o && onClose()}>
            <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
                <form onSubmit={submit} noValidate>
                    <DialogHeader>
                        <DialogTitle>{entry ? (canWrite ? "Edit software" : entry.name) : "Add software"}</DialogTitle>
                        <DialogDescription>A policy matches installed programs whose name contains the match text. Installing needs a Chocolatey id, or an installer link with its SHA-256.</DialogDescription>
                    </DialogHeader>
                    <fieldset disabled={!canWrite} className="grid gap-x-4 py-3 sm:grid-cols-2">
                        <Field label="Name *" htmlFor="sl-name" error={errs.name} hint="Shown in lists, like Google Chrome">
                            <Input id="sl-name" value={form.name} maxLength={120} aria-invalid={!!errs.name} className={bad("name")} onChange={(e) => set("name", e.target.value)} />
                        </Field>
                        <Field label="Matches *" htmlFor="sl-match" error={errs.matchText} hint="Part of the program name, like Chrome">
                            <Input id="sl-match" value={form.matchText} maxLength={120} aria-invalid={!!errs.matchText} className={bad("matchText")} onChange={(e) => set("matchText", e.target.value)} />
                        </Field>
                        <Field label="Category" htmlFor="sl-cat" hint="Groups the library">
                            <select id="sl-cat" className={selectClass} value={form.category} onChange={(e) => set("category", e.target.value)}>
                                {cats.map((c) => <option key={c} value={c}>{c}</option>)}
                            </select>
                        </Field>
                        <Field label="Publisher" htmlFor="sl-pub" hint="Optional">
                            <Input id="sl-pub" value={form.publisher} maxLength={120} onChange={(e) => set("publisher", e.target.value)} />
                        </Field>
                        <Field label="Chocolatey id" htmlFor="sl-choco" error={errs.chocolateyId} hint="Lets you install and uninstall, like googlechrome">
                            <Input id="sl-choco" value={form.chocolateyId} maxLength={100} aria-invalid={!!errs.chocolateyId} className={bad("chocolateyId")} onChange={(e) => set("chocolateyId", e.target.value)} />
                        </Field>
                        <Field label="Chocolatey parameters" htmlFor="sl-chparams" hint="Optional. Passed as --params, only when installing">
                            <Input id="sl-chparams" value={form.chocolateyParams} maxLength={200} onChange={(e) => set("chocolateyParams", e.target.value)} placeholder="/NoDesktopIcon" />
                        </Field>
                        <Field label="Chocolatey installer arguments" htmlFor="sl-chargs" hint="Optional. Passed as --install-arguments, only when installing. For per-user installers try --system-level" className="sm:col-span-2">
                            <Input id="sl-chargs" value={form.chocolateyInstallArgs} maxLength={200} onChange={(e) => set("chocolateyInstallArgs", e.target.value)} placeholder="--system-level" />
                        </Field>
                        <Field label="Winget id" htmlFor="sl-winget" hint="Kept for later, not used yet">
                            <Input id="sl-winget" value={form.wingetId} maxLength={120} onChange={(e) => set("wingetId", e.target.value)} />
                        </Field>
                        <Field label="Installer link" htmlFor="sl-url" error={errs.installerUrl} hint="Optional direct download, https only" className="sm:col-span-2">
                            <Input id="sl-url" inputMode="url" value={form.installerUrl} maxLength={500} aria-invalid={!!errs.installerUrl} className={bad("installerUrl")} onChange={(e) => set("installerUrl", e.target.value)} placeholder="https://" />
                        </Field>
                        <Field label="Installer SHA-256" htmlFor="sl-sha" error={errs.installerSha256} hint="Required with an installer link" className="sm:col-span-2">
                            <Input id="sl-sha" value={form.installerSha256} maxLength={64} spellCheck={false} aria-invalid={!!errs.installerSha256} className={`${bad("installerSha256")} font-mono`} onChange={(e) => set("installerSha256", e.target.value)} />
                        </Field>
                        <Field label="Installer type" htmlFor="sl-kind" error={errs.installerKind} hint="msi runs quietly on its own">
                            <select id="sl-kind" className={`${selectClass} ${bad("installerKind")}`} value={form.installerKind} onChange={(e) => set("installerKind", e.target.value as FormState["installerKind"])}>
                                <option value="">Not set</option><option value="exe">exe</option><option value="msi">msi</option>
                            </select>
                        </Field>
                        <Field label="Quiet switches" htmlFor="sl-args" hint="For an exe installer, like /S">
                            <Input id="sl-args" value={form.silentArgs} maxLength={200} onChange={(e) => set("silentArgs", e.target.value)} />
                        </Field>
                        <Field label="Linux package" htmlFor="sl-linux" hint="Kept for later, not used yet">
                            <Input id="sl-linux" value={form.linuxPackage} maxLength={120} onChange={(e) => set("linuxPackage", e.target.value)} />
                        </Field>
                        <Field label="Notes" htmlFor="sl-notes" className="sm:col-span-2">
                            <Textarea id="sl-notes" rows={2} maxLength={1000} value={form.notes} onChange={(e) => set("notes", e.target.value)} />
                        </Field>
                    </fieldset>
                    <DialogFooter className="items-center gap-2 sm:justify-between">
                        <p role="alert" className="min-h-5 text-sm text-destructive">{error ?? ""}</p>
                        <div className="flex gap-2">
                            <Button type="button" variant="outline" disabled={saving} onClick={onClose}>{canWrite ? "Cancel" : "Close"}</Button>
                            {canWrite && <Button type="submit" variant="success" disabled={saving}>{saving ? "Saving…" : entry ? "Save" : "Add"}</Button>}
                        </div>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

/* ------------------------------ install / uninstall ------------------------------ */

type Chosen = { kind: "client" | "site" | "tag" | "device"; id: string; name: string };
const PICK_LABEL: Record<Chosen["kind"], string> = { client: "Customer", site: "Site", tag: "Tag", device: "Device" };

function ActionDialog({ state, onClose, onDone }: { state: { entry: LibraryEntry; action: "install" | "uninstall" } | null; onClose: () => void; onDone: () => void }) {
    const entry = state?.entry ?? null;
    const action = state?.action ?? "install";
    const [mode, setMode] = React.useState<Chosen["kind"]>("client");
    const [clientId, setClientId] = React.useState("");
    const [siteId, setSiteId] = React.useState("");
    const [deviceId, setDeviceId] = React.useState("");
    const [tagId, setTagId] = React.useState("");
    const [picks, setPicks] = React.useState<Chosen[]>([]);
    const [customers, setCustomers] = React.useState<{ key: string; name: string }[]>([]);
    const [tagList, setTagList] = React.useState<{ id: string; name: string }[]>([]);
    const [preview, setPreview] = React.useState<PreviewResult | null>(null);
    const [busy, setBusy] = React.useState<"" | "preview" | "run">("");
    const [error, setError] = React.useState<string | null>(null);
    // For removals: also try devices whose inventory does not list the program (one that went into the system account's profile is invisible to it).
    const [force, setForce] = React.useState(false);
    const sites = useSites(clientId);
    const devices = useDeviceChoices(clientId, siteId);
    const pagedEligible = usePaged(preview?.eligible ?? [], "software-eligible", 10);
    const pagedSkipped = usePaged(preview?.skipped ?? [], "software-skipped", 10);

    React.useEffect(() => {
        if (!state) return;
        setMode("client"); setClientId(""); setSiteId(""); setDeviceId(""); setTagId(""); setPicks([]); setPreview(null); setError(null); setBusy(""); setForce(false);
        jfetch<{ key: string; name: string }[]>("/api/customers").then(setCustomers).catch(() => setCustomers([]));
        jfetch<{ items: { id: string; name: string }[] }>("/api/tags").then((r) => setTagList(r.items)).catch(() => setTagList([]));
    }, [state]);

    const customerName = (id: string) => customers.find((c) => c.key === id)?.name ?? "Customer";
    const target = mode === "client" ? clientId : mode === "site" ? siteId : mode === "tag" ? tagId : deviceId;
    const add = () => {
        if (!target) return;
        const name = mode === "client" ? customerName(clientId)
            : mode === "site" ? `${customerName(clientId)} / ${sites.find((s) => s.id === siteId)?.name ?? "site"}`
                : mode === "tag" ? tagList.find((t) => t.id === tagId)?.name ?? "Tag"
                    : devices.find((d) => d.id === deviceId)?.name ?? "Device";
        if (picks.some((p) => p.kind === mode && p.id === target)) return;
        setPicks((cur) => [...cur, { kind: mode, id: target, name }]);
        setPreview(null);
    };
    const ids = (kind: Chosen["kind"]) => picks.filter((p) => p.kind === kind).map((p) => p.id);

    const runPreview = async () => {
        if (!entry || !picks.length) return;
        setBusy("preview"); setError(null);
        try {
            setPreview(await jfetch<PreviewResult>(`/api/software-library/${entry.id}/install-preview`, { method: "POST", body: { action, clientIds: ids("client"), siteIds: ids("site"), tagIds: ids("tag"), deviceIds: ids("device"), ...(action === "uninstall" && force ? { force: true } : {}) } }));
        } catch (e) {
            setError(errorText(e));
        } finally {
            setBusy("");
        }
    };

    const confirm = async () => {
        if (!entry || !preview || !preview.eligible.length) return;
        setBusy("run"); setError(null);
        const all = preview.eligible.map((d) => d.deviceId);
        let queued = 0;
        let skipped = 0;
        try {
            for (let i = 0; i < all.length; i += 200) {
                const r = await jfetch<{ queued: number; skipped: Skipped[] }>(`/api/software-library/${entry.id}/install`, { method: "POST", body: { action, deviceIds: all.slice(i, i + 200), ...(action === "uninstall" && force ? { force: true } : {}) } });
                queued += r.queued;
                skipped += r.skipped?.length ?? 0;
            }
            toast({
                title: `${action === "install" ? "Installing" : "Uninstalling"} ${entry.name} on ${queued} endpoint${queued === 1 ? "" : "s"}`,
                description: skipped ? `${skipped} could not be queued. Run Preview again to see why.` : "Each endpoint does it the next time it checks in, one program at a time.",
            });
            onDone();
            onClose();
        } catch (e) {
            if (queued) toast({ title: `Queued on ${queued} endpoint${queued === 1 ? "" : "s"} before it stopped`, description: errorText(e), variant: "destructive" });
            setError(errorText(e));
        } finally {
            setBusy("");
        }
    };

    const verb = action === "install" ? "Install" : "Uninstall";
    return (
        <Dialog open={!!state} onOpenChange={(o) => !busy && !o && onClose()}>
            <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
                <DialogHeader>
                    <DialogTitle>{verb} {entry?.name}</DialogTitle>
                    <DialogDescription>
                        Choose where, press Preview to see who would be touched and who is skipped, then confirm. Nothing is queued until you confirm.
                        {action === "uninstall" ? " Uninstalling removes it with Chocolatey." : ""}
                    </DialogDescription>
                </DialogHeader>

                <div className="grid gap-3">
                    {action === "uninstall" && (
                        <label className="flex items-start gap-2 rounded-md border p-3 text-sm">
                            <input type="checkbox" className="mt-1" checked={force} onChange={(e) => { setForce(e.target.checked); setPreview(null); }} />
                            <span>
                                <span className="font-medium">Remove it even if the device does not list it.</span>{" "}
                                <span className="text-muted-foreground">Use this for a program the software list cannot see, for example one that Chocolatey installed into the system account&apos;s own profile. The device still checks the result and reports back.</span>
                            </span>
                        </label>
                    )}
                    {picks.length === 0 && <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">Nothing chosen yet.</p>}
                    {picks.length > 0 && (
                        <ul className="flex flex-wrap gap-2">
                            {picks.map((p) => (
                                <li key={`${p.kind}:${p.id}`} className="flex items-center gap-1 rounded-md border px-2 py-1 text-sm">
                                    <Pill>{PICK_LABEL[p.kind]}</Pill> {p.name}
                                    <button type="button" aria-label={`Remove ${p.name}`} className="ml-1 text-muted-foreground hover:text-foreground" onClick={() => { setPicks((cur) => cur.filter((x) => x !== p)); setPreview(null); }}><Trash2 className="h-3.5 w-3.5" aria-hidden /></button>
                                </li>
                            ))}
                        </ul>
                    )}
                    <div className="flex flex-wrap items-end gap-2 rounded-md border p-3">
                        <label className="grid gap-1 text-xs">
                            <span className="text-muted-foreground">Choose by</span>
                            <select className={`${selectClass} w-40`} value={mode} onChange={(e) => { setMode(e.target.value as Chosen["kind"]); setSiteId(""); setDeviceId(""); setTagId(""); }}>
                                <option value="client">Customer</option><option value="site">Site</option><option value="tag">Tag</option><option value="device">Specific devices</option>
                            </select>
                        </label>
                        {mode === "tag" && (
                            <label className="grid gap-1 text-xs">
                                <span className="text-muted-foreground">Tag</span>
                                <select className={`${selectClass} w-52`} value={tagId} onChange={(e) => setTagId(e.target.value)}>
                                    <option value="">{tagList.length ? "Choose a tag" : "No tags yet"}</option>
                                    {tagList.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                                </select>
                            </label>
                        )}
                        {mode !== "tag" && (
                            <label className="grid gap-1 text-xs">
                                <span className="text-muted-foreground">Customer</span>
                                <select className={`${selectClass} w-52`} value={clientId} onChange={(e) => { setClientId(e.target.value); setSiteId(""); setDeviceId(""); }}>
                                    <option value="">Choose a customer</option>
                                    {customers.map((c) => <option key={c.key} value={c.key}>{c.name}</option>)}
                                </select>
                            </label>
                        )}
                        {(mode === "site" || mode === "device") && (
                            <label className="grid gap-1 text-xs">
                                <span className="text-muted-foreground">{mode === "site" ? "Site" : "Site (optional)"}</span>
                                <select className={`${selectClass} w-44`} value={siteId} disabled={!clientId} onChange={(e) => { setSiteId(e.target.value); setDeviceId(""); }}>
                                    <option value="">{mode === "site" ? "Choose a site" : "Any site"}</option>
                                    {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                                </select>
                            </label>
                        )}
                        {mode === "device" && (
                            <label className="grid gap-1 text-xs">
                                <span className="text-muted-foreground">Device</span>
                                <select className={`${selectClass} w-52`} value={deviceId} disabled={!clientId} onChange={(e) => setDeviceId(e.target.value)}>
                                    <option value="">Choose a device</option>
                                    {devices.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                                </select>
                            </label>
                        )}
                        <Button type="button" variant="outline" disabled={!target} onClick={add}>Add</Button>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        <Button type="button" variant="outline" disabled={!picks.length || !!busy} onClick={() => void runPreview()}>{busy === "preview" ? "Checking…" : "Preview"}</Button>
                        <span className="text-xs text-muted-foreground">{picks.length ? "" : "Add at least one customer, site, tag or device."}</span>
                    </div>

                    {preview && (
                        <div className="grid gap-3">
                            <p className="text-sm">
                                <strong>{preview.eligible.length}</strong> endpoint{preview.eligible.length === 1 ? "" : "s"} will be touched, <strong>{preview.skipped.length}</strong> skipped, of {preview.total} checked.
                            </p>
                            {preview.eligible.length > 0 && (
                                <div className="grid gap-1">
                                    <div className="text-sm font-medium">Will be touched</div>
                                    <div className="overflow-hidden rounded-xl border border-border/70 bg-card">
                                        <ul className="divide-y divide-border/60">
                                            {pagedEligible.rows.map((d) => (
                                                <li key={d.deviceId} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm">
                                                    <span><span className="font-medium">{d.device}</span> <span className="text-muted-foreground">{[d.customer, d.site].filter(Boolean).join(" / ")}</span></span>
                                                    <Pill tone="good">{action === "install" ? "Will install" : "Will uninstall"}</Pill>
                                                </li>
                                            ))}
                                        </ul>
                                    </div>
                                    <Pager paged={pagedEligible} noun="endpoints" />
                                </div>
                            )}
                            {preview.skipped.length > 0 && (
                                <div className="grid gap-1">
                                    <div className="text-sm font-medium">Skipped</div>
                                    <div className="overflow-hidden rounded-xl border border-border/70 bg-card">
                                        <ul className="divide-y divide-border/60">
                                            {pagedSkipped.rows.map((d) => (
                                                <li key={d.deviceId} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm">
                                                    <span><span className="font-medium">{d.device}</span> <span className="text-muted-foreground">{[d.customer, d.site].filter(Boolean).join(" / ")}</span></span>
                                                    <Pill tone="warn">{d.reason}</Pill>
                                                </li>
                                            ))}
                                        </ul>
                                    </div>
                                    <Pager paged={pagedSkipped} noun="endpoints" />
                                </div>
                            )}
                            {preview.total >= 500 && <p className="text-xs text-muted-foreground">At most 500 endpoints are checked at a time. Choose a smaller scope to be sure of everyone.</p>}
                        </div>
                    )}
                </div>

                <DialogFooter className="items-center gap-2 sm:justify-between">
                    <p role="alert" className="min-h-5 text-sm text-destructive">{error ?? ""}</p>
                    <div className="flex gap-2">
                        <Button type="button" variant="outline" disabled={busy === "run"} onClick={onClose}>Cancel</Button>
                        <Button type="button" variant={action === "uninstall" ? "destructive" : "success"} disabled={!preview || preview.eligible.length === 0 || !!busy} onClick={() => void confirm()}>
                            {busy === "run" ? "Queuing…" : preview && preview.eligible.length ? `${verb} on ${preview.eligible.length} endpoint${preview.eligible.length === 1 ? "" : "s"}` : `Confirm ${verb.toLowerCase()}`}
                        </Button>
                    </div>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
