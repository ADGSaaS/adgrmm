"use client";

// Script snippets: pieces of script kept for reuse. The person who writes one chooses whether it is private or shared.
// Used from the script editor and from "Run script": pick one to put it into the script being written.
import * as React from "react";
import { Lock, Pencil, Trash2, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/use-toast";
import { jfetch } from "@/lib/api";

type Language = "powershell" | "bash" | "any";

export type ScriptSnippet = {
    id: string;
    title: string;
    description: string;
    language: Language;
    body: string;
    shared: boolean;
    mine: boolean;
    author: string;
    canEdit: boolean;
    updatedAt: string;
};

const LANGUAGE_NAME: Record<Language, string> = { powershell: "PowerShell", bash: "Bash", any: "Any language" };

const messageOf = (e: unknown) => {
    const raw = e instanceof Error ? e.message : "Something went wrong.";
    try { const j = JSON.parse(raw) as { message?: string | string[] }; return Array.isArray(j.message) ? j.message.join(" ") : j.message ?? raw; } catch { return raw; }
};

export function ScriptSnippetsDialog({
    open,
    onOpenChange,
    language,
    draft,
    onInsert,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** The language of the script being written: snippets for it, and for any language, are listed first. */
    language: "powershell" | "bash" | "cmd";
    /** The script being written, offered as the start of a new snippet. */
    draft?: string;
    /** Puts a snippet's code into the script. */
    onInsert: (code: string) => void;
}) {
    const here: Language = language === "cmd" ? "any" : language;
    const [items, setItems] = React.useState<ScriptSnippet[] | null>(null);
    const [query, setQuery] = React.useState("");
    const [allLanguages, setAllLanguages] = React.useState(false);
    const [editing, setEditing] = React.useState<string | "new" | null>(null);
    const [title, setTitle] = React.useState("");
    const [description, setDescription] = React.useState("");
    const [snipLanguage, setSnipLanguage] = React.useState<Language>(here);
    const [body, setBody] = React.useState("");
    const [shared, setShared] = React.useState(false);
    const [saving, setSaving] = React.useState(false);
    const [tried, setTried] = React.useState(false);

    const load = React.useCallback(async () => {
        try {
            setItems((await jfetch<{ items: ScriptSnippet[] }>("/api/script-snippets")).items);
        } catch (e) {
            setItems([]);
            toast({ title: "Could not load snippets", description: messageOf(e), variant: "destructive" });
        }
    }, []);

    const startNew = React.useCallback((code = "") => {
        setEditing("new");
        setTitle("");
        setDescription("");
        setSnipLanguage(here);
        setBody(code);
        setShared(false);
        setTried(false);
    }, [here]);

    React.useEffect(() => {
        if (!open) return;
        setQuery("");
        setEditing(null);
        void load();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    function edit(s: ScriptSnippet) {
        setEditing(s.id);
        setTitle(s.title);
        setDescription(s.description);
        setSnipLanguage(s.language);
        setBody(s.body);
        setShared(s.shared);
        setTried(false);
    }

    const titleOk = title.trim().length > 0;
    const bodyOk = body.trim().length > 0;

    async function save() {
        setTried(true);
        if (!titleOk || !bodyOk) return;
        setSaving(true);
        try {
            const payload = { title, description, language: snipLanguage, body, shared };
            if (editing === "new") await jfetch("/api/script-snippets", { method: "POST", body: payload });
            else await jfetch(`/api/script-snippets/${editing}`, { method: "PATCH", body: payload });
            toast({ title: editing === "new" ? "Snippet saved" : "Snippet updated" });
            setEditing(null);
            await load();
        } catch (e) {
            toast({ title: "Could not save the snippet", description: messageOf(e), variant: "destructive" });
        } finally {
            setSaving(false);
        }
    }

    async function remove(s: ScriptSnippet) {
        if (!window.confirm(`Remove the snippet "${s.title}"?${s.shared ? " It is shared, so other people lose it too." : ""}`)) return;
        try {
            await jfetch(`/api/script-snippets/${s.id}`, { method: "DELETE" });
            toast({ title: "Snippet removed" });
            await load();
        } catch (e) {
            toast({ title: "Could not remove the snippet", description: messageOf(e), variant: "destructive" });
        }
    }

    const shown = React.useMemo(() => {
        const q = query.trim().toLowerCase();
        return (items ?? [])
            .filter((s) => allLanguages || s.language === "any" || s.language === here)
            .filter((s) => !q || `${s.title} ${s.description} ${s.body}`.toLowerCase().includes(q));
    }, [items, query, allLanguages, here]);

    const othersLanguage = (items ?? []).filter((s) => s.language !== "any" && s.language !== here).length;
    const editingOthers = editing && editing !== "new" ? items?.find((i) => i.id === editing && !i.mine) : undefined;

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-h-[85vh] max-w-2xl grid-cols-[minmax(0,1fr)] overflow-x-hidden overflow-y-auto">
                <DialogHeader>
                    <DialogTitle>Script snippets</DialogTitle>
                    <DialogDescription>
                        Pieces of script you use again and again. Keep one private, or share it with everyone who writes scripts. Insert puts it into the script at the cursor.
                    </DialogDescription>
                </DialogHeader>

                {editing ? (
                    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3">
                        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_12rem]">
                            <div className="grid gap-1">
                                <label htmlFor="ss-title" className={`text-sm font-medium ${tried && !titleOk ? "text-destructive" : ""}`}>Title</label>
                                <Input id="ss-title" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} aria-invalid={tried && !titleOk} placeholder="For example: Restart a service" autoFocus />
                            </div>
                            <div className="grid gap-1">
                                <label htmlFor="ss-lang" className="text-sm font-medium">Language</label>
                                <select id="ss-lang" value={snipLanguage} onChange={(e) => setSnipLanguage(e.target.value as Language)} className="h-9 rounded-md border bg-background px-2 text-sm">
                                    <option value="powershell">PowerShell</option>
                                    <option value="bash">Bash</option>
                                    <option value="any">Any language</option>
                                </select>
                            </div>
                        </div>
                        <div className="grid gap-1">
                            <label htmlFor="ss-desc" className="text-sm font-medium">What it does <span className="font-normal text-muted-foreground">(optional)</span></label>
                            <Input id="ss-desc" value={description} maxLength={1000} onChange={(e) => setDescription(e.target.value)} />
                        </div>
                        <div className="grid gap-1">
                            <label htmlFor="ss-body" className={`text-sm font-medium ${tried && !bodyOk ? "text-destructive" : ""}`}>Code</label>
                            <Textarea id="ss-body" value={body} rows={10} spellCheck={false} className="font-mono text-xs" onChange={(e) => setBody(e.target.value)} aria-invalid={tried && !bodyOk} />
                        </div>
                        <fieldset className="grid gap-2 text-sm" disabled={!!editingOthers}>
                            <legend className="mb-1 font-medium">Who can use it?</legend>
                            <label className="flex items-start gap-2">
                                <input type="radio" name="ss-share" className="mt-1" checked={!shared} onChange={() => setShared(false)} />
                                <span><Lock className="mr-1 inline h-3.5 w-3.5" aria-hidden />Only me <span className="text-xs text-muted-foreground">(private)</span></span>
                            </label>
                            <label className="flex items-start gap-2">
                                <input type="radio" name="ss-share" className="mt-1" checked={shared} onChange={() => setShared(true)} />
                                <span><Users className="mr-1 inline h-3.5 w-3.5" aria-hidden />Everyone <span className="text-xs text-muted-foreground">(shared with all who write scripts)</span></span>
                            </label>
                            {editingOthers ? <p className="text-xs text-muted-foreground">Only {editingOthers.author || "the person who wrote it"} can make this private.</p> : null}
                        </fieldset>
                        <div className="flex justify-end gap-2">
                            <Button variant="outline" size="sm" onClick={() => setEditing(null)} disabled={saving}>Cancel</Button>
                            <Button size="sm" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
                        </div>
                    </div>
                ) : (
                    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3">
                        <div className="flex flex-wrap items-center gap-2">
                            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search snippets" aria-label="Search snippets" className="h-9 min-w-[10rem] flex-1" />
                            {draft && draft.trim() ? <Button size="sm" variant="outline" onClick={() => startNew(draft)}>Save this script as a snippet</Button> : null}
                            <Button size="sm" onClick={() => startNew()}>New snippet</Button>
                        </div>
                        {othersLanguage > 0 ? (
                            <label className="flex items-center gap-2 text-xs text-muted-foreground">
                                <input type="checkbox" checked={allLanguages} onChange={(e) => setAllLanguages(e.target.checked)} />
                                Also show snippets for other languages ({othersLanguage})
                            </label>
                        ) : null}
                        {items === null ? (
                            <p className="text-sm text-muted-foreground">Loading…</p>
                        ) : shown.length === 0 ? (
                            <p className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
                                {items.length === 0 ? "No snippets yet. Create one, or write a script and choose “Save this script as a snippet”." : "No snippet matches."}
                            </p>
                        ) : (
                            <ul className="min-w-0 divide-y overflow-hidden rounded-md border">
                                {shown.map((s) => (
                                    <li key={s.id} className="flex min-w-0 items-start gap-3 p-3 text-sm">
                                        <div className="min-w-0 flex-1">
                                            <div className="flex flex-wrap items-center gap-2">
                                                <span className="font-medium">{s.title}</span>
                                                <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">{LANGUAGE_NAME[s.language]}</span>
                                                <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${s.shared ? "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300" : "text-muted-foreground"}`}>
                                                    {s.shared ? <Users className="h-3 w-3" aria-hidden /> : <Lock className="h-3 w-3" aria-hidden />}
                                                    {s.shared ? (s.mine ? "Shared by you" : s.author ? `Shared by ${s.author}` : "Shared") : "Private"}
                                                </span>
                                            </div>
                                            {s.description ? <p className="mt-1 text-xs text-muted-foreground">{s.description}</p> : null}
                                            <pre className="mt-1 max-h-24 max-w-full overflow-auto whitespace-pre rounded bg-muted/40 p-2 font-mono text-xs">{s.body}</pre>
                                        </div>
                                        <div className="flex shrink-0 flex-col items-end gap-1 self-start">
                                            <Button size="sm" onClick={() => { onInsert(s.body); onOpenChange(false); }}>Insert</Button>
                                            {s.canEdit ? (
                                                <div className="flex gap-1">
                                                    <Button variant="ghost" size="icon" aria-label={`Edit ${s.title}`} onClick={() => edit(s)}><Pencil className="h-4 w-4" /></Button>
                                                    <Button variant="ghost" size="icon" aria-label={`Remove ${s.title}`} onClick={() => remove(s)}><Trash2 className="h-4 w-4" /></Button>
                                                </div>
                                            ) : null}
                                        </div>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                )}
            </DialogContent>
        </Dialog>
    );
}

/** Puts code into a script at the cursor (replacing what is selected), or at the end when the box was never clicked. */
export function insertAtCursor(elementId: string, current: string, code: string): string {
    const el = typeof document !== "undefined" ? (document.getElementById(elementId) as HTMLTextAreaElement | null) : null;
    const start = el && typeof el.selectionStart === "number" ? el.selectionStart : current.length;
    const end = el && typeof el.selectionEnd === "number" ? el.selectionEnd : start;
    const before = current.slice(0, start);
    const after = current.slice(end);
    const lead = before && !before.endsWith("\n") ? "\n" : "";
    const tail = after && !code.endsWith("\n") ? "\n" : "";
    return `${before}${lead}${code}${tail}${after}`;
}
