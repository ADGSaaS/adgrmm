"use client";

// components/automation/script-editor-dialog.tsx
//
// The script editor as an IDE-style window: name and description on top, a strip of settings (language, category, time limit), the script in a
// real code editor with a status bar, and the parameters beside it. New scripts, edits and copies all use it. A built-in script can be edited
// too; saving it marks it Customized (it then stops following ADG RMM's updates) and it can be reset to the shipped version.
import * as React from "react";
import dynamic from "next/dynamic";
import { Plus, RotateCcw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScriptPropertiesHint } from "@/components/script-properties-hint";
import { ScriptSnippetsDialog } from "@/components/script-snippets-dialog";
import { toast } from "@/components/ui/use-toast";
import { jfetch } from "@/lib/api";
import type { EditorHandle, EditorStatus } from "@/components/automation/code-editor";
import { UNCATEGORIZED, platformOfScript, type Script, type ScriptCategory, type ScriptParameter, type ScriptPlatform } from "@/components/automation/script-types";

// the editor is a few hundred KB: it is fetched only when a script is opened
const CodeEditor = dynamic(() => import("@/components/automation/code-editor"), {
    ssr: false,
    loading: () => <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading the editor…</div>,
});

const NEW_CATEGORY = "__new__";
const selectClass = "h-9 rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const errorText = (e: unknown) => {
    const raw = e instanceof Error ? e.message : "Something went wrong.";
    try {
        const j = JSON.parse(raw) as { message?: string | string[] };
        return Array.isArray(j.message) ? j.message.join(" ") : j.message ?? raw;
    } catch {
        return raw;
    }
};

type Props = {
    /** The script to edit, or null for a new one. A copy of a script is "new" with its text filled in. */
    initial: Script | null;
    /** Start a new script from this text and these settings (a copy), without editing the original. */
    template?: Script | null;
    /** The category a new script starts in (the one the person came from). */
    defaultCategory?: string | null;
    categories: ScriptCategory[];
    /** Whether the person may create categories (a separate right from editing scripts). */
    canCreateCategory: boolean;
    onCategoryCreated: (c: ScriptCategory) => void;
    onClose: () => void;
    onSaved: () => void;
};

export default function ScriptEditorDialog({ initial, template, defaultCategory, categories, canCreateCategory, onCategoryCreated, onClose, onSaved }: Props) {
    const seed = initial ?? template ?? null;
    const [name, setName] = React.useState(seed?.name ?? "");
    const [description, setDescription] = React.useState(seed?.description ?? "");
    const [platform, setPlatform] = React.useState<ScriptPlatform>(seed ? platformOfScript(seed) : "windows");
    const [script, setScript] = React.useState(seed?.script ?? "");
    // the bash text of a script that is for both systems (its PowerShell text is `script`)
    const [linuxScript, setLinuxScript] = React.useState(seed?.linuxScript ?? "");
    // the bash text for a Mac, in a script that is for all three systems
    const [macosScript, setMacosScript] = React.useState(seed?.macosScript ?? "");
    const [part, setPart] = React.useState<"windows" | "linux" | "macos">("windows");
    const language: Script["language"] = platform === "linux" ? "bash" : "powershell";
    const several = platform === "both" || platform === "all";
    // what the editor shows: for several systems, the part chosen on the tabs
    const editing: "windows" | "linux" | "macos" = several ? (part === "macos" && platform !== "all" ? "windows" : part) : platform === "linux" ? "linux" : "windows";
    const editorLanguage: Script["language"] = editing === "windows" ? "powershell" : "bash";
    const text = several && editing === "linux" ? linuxScript : several && editing === "macos" ? macosScript : script;
    const setText = several && editing === "linux" ? setLinuxScript : several && editing === "macos" ? setMacosScript : setScript;
    const [timeoutSec, setTimeoutSec] = React.useState(seed?.timeoutSec ?? 300);
    const [parameters, setParameters] = React.useState<ScriptParameter[]>(seed?.parameters ?? []);
    const [category, setCategory] = React.useState<string>(seed?.category ?? (defaultCategory && defaultCategory !== UNCATEGORIZED ? defaultCategory : ""));
    const [newCategory, setNewCategory] = React.useState<string | null>(null);
    const [creating, setCreating] = React.useState(false);
    const [snippetsOpen, setSnippetsOpen] = React.useState(false);
    const [saving, setSaving] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const [status, setStatus] = React.useState<EditorStatus>({ line: 1, col: 1, lines: 1, chars: seed?.script.length ?? 0 });
    const editor = React.useRef<EditorHandle | null>(null);
    const dirty = React.useRef(false);

    const builtin = !!initial?.builtin;
    const changed = initial
        ? name !== initial.name || (description || "") !== (initial.description ?? "") || language !== initial.language || platform !== platformOfScript(initial) || script !== initial.script || (several && linuxScript !== (initial.linuxScript ?? "")) || (platform === "all" && macosScript !== (initial.macosScript ?? "")) || timeoutSec !== initial.timeoutSec
            || (category || "") !== (initial.category ?? "") || JSON.stringify(parameters) !== JSON.stringify(initial.parameters)
        : !!(name.trim() || description.trim() || script.trim() || parameters.length);
    dirty.current = changed;

    const updateParameter = (index: number, patch: Partial<ScriptParameter>) => setParameters((list) => list.map((p, i) => (i === index ? { ...p, ...patch } : p)));

    const save = async () => {
        if (saving) return;
        if (!name.trim()) { setError("Give the script a name."); return; }
        if (!script.trim()) { setError(several ? "The Windows (PowerShell) part is empty." : "The script is empty."); return; }
        if (several && !linuxScript.trim()) { setError("The Linux (bash) part is empty."); return; }
        if (platform === "all" && !macosScript.trim()) { setError("The macOS (bash) part is empty."); return; }
        setSaving(true);
        setError(null);
        try {
            await jfetch(initial ? `/api/scripts/${initial.id}` : "/api/scripts", {
                method: initial ? "PUT" : "POST",
                body: { name: name.trim(), description: description || undefined, language, platform, script, ...(several ? { linuxScript } : {}), ...(platform === "all" ? { macosScript } : {}), timeoutSec, parameters, category: category || null },
            });
            toast({ title: initial ? "Script saved" : "Script added", variant: "success" });
            onSaved();
        } catch (err) {
            setError(errorText(err));
        } finally {
            setSaving(false);
        }
    };
    const saveRef = React.useRef(save);
    saveRef.current = save;

    const createCategory = async () => {
        const wanted = (newCategory ?? "").trim();
        if (!wanted) return;
        setCreating(true);
        setError(null);
        try {
            const made = await jfetch<ScriptCategory>("/api/scripts/categories", { method: "POST", body: { name: wanted } });
            onCategoryCreated(made);
            setCategory(made.name);
            setNewCategory(null);
        } catch (err) {
            setError(errorText(err));
        } finally {
            setCreating(false);
        }
    };

    const reset = async () => {
        if (!initial) return;
        if (!window.confirm(`Put "${initial.name}" back to the version ADG RMM ships? Your changes to it are lost.`)) return;
        setSaving(true);
        try {
            await jfetch(`/api/scripts/${initial.id}/reset`, { method: "POST", body: {} });
            toast({ title: "Back to the original", variant: "success" });
            onSaved();
        } catch (err) {
            setError(errorText(err));
        } finally {
            setSaving(false);
        }
    };

    const requestClose = () => {
        if (dirty.current && !window.confirm("Close without saving your changes?")) return;
        onClose();
    };

    return (
        <Dialog open onOpenChange={(open) => !open && requestClose()}>
            <DialogContent
                className="flex h-[90vh] max-h-[90vh] w-[95vw] max-w-[95vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-[95vw]"
                data-testid="script-editor"
                onKeyDown={(e) => {
                    // Ctrl+S saves from anywhere in the window (the editor handles it itself while it has the focus)
                    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); void saveRef.current(); }
                }}
            >
                <div className="grid gap-3 border-b px-5 py-3 pr-14">
                    <div className="flex flex-wrap items-baseline gap-x-3">
                        <DialogTitle className="text-base font-semibold">{initial ? "Edit script" : template ? "Copy of a script" : "New script"}</DialogTitle>
                        <DialogDescription className="text-xs">Saved scripts can be run on many devices, or on a schedule. Ctrl+S saves.</DialogDescription>
                    </div>
                    <div className="grid gap-3 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
                        <div className="grid gap-1">
                            <Label htmlFor="script-name" className="text-xs">Name</Label>
                            <Input id="script-name" maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
                        </div>
                        <div className="grid gap-1">
                            <Label htmlFor="script-description" className="text-xs">Description (optional)</Label>
                            <Input id="script-description" maxLength={1000} value={description} onChange={(e) => setDescription(e.target.value)} />
                        </div>
                    </div>
                    <div className="flex flex-wrap items-end gap-3">
                        <div className="grid gap-1">
                            <Label htmlFor="script-platform" className="text-xs">Runs on</Label>
                            <select
                                id="script-platform"
                                value={platform}
                                onChange={(e) => {
                                    const next = e.target.value as ScriptPlatform;
                                    // a Linux script turned into one for both keeps its text as the bash part
                                    if ((next === "both" || next === "all") && platform === "linux" && !linuxScript.trim()) { setLinuxScript(script); setScript(""); }
                                    // and back: the part for the one system left is the one that stays
                                    if (several && next === "linux" && linuxScript.trim()) setScript(linuxScript);
                                    setPart(next === "linux" ? "linux" : "windows");
                                    if (next !== "all" && part === "macos") setPart("windows");
                                    setPlatform(next);
                                }}
                                className={selectClass}
                            >
                                <option value="windows">Windows (PowerShell)</option>
                                <option value="linux">Linux (bash)</option>
                                <option value="both">Windows and Linux (two parts)</option>
                                <option value="all">Windows, Linux and macOS (three parts)</option>
                            </select>
                        </div>
                        <div className="grid gap-1">
                            <Label htmlFor="script-category" className="text-xs">Category</Label>
                            <select
                                id="script-category"
                                value={newCategory !== null ? NEW_CATEGORY : category}
                                onChange={(e) => {
                                    if (e.target.value === NEW_CATEGORY) setNewCategory("");
                                    else { setNewCategory(null); setCategory(e.target.value); }
                                }}
                                className={`${selectClass} min-w-48`}
                            >
                                <option value="">No category</option>
                                {category && !categories.some((c) => c.name === category) ? <option value={category}>{category}</option> : null}
                                {categories.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
                                {canCreateCategory ? <option value={NEW_CATEGORY}>Create a new category…</option> : null}
                            </select>
                        </div>
                        {newCategory !== null ? (
                            <div className="flex items-end gap-2">
                                <div className="grid gap-1">
                                    <Label htmlFor="script-new-category" className="text-xs">New category</Label>
                                    <Input
                                        id="script-new-category"
                                        autoFocus
                                        maxLength={60}
                                        className="h-9 w-56"
                                        value={newCategory}
                                        onChange={(e) => setNewCategory(e.target.value)}
                                        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void createCategory(); } }}
                                    />
                                </div>
                                <Button type="button" size="sm" disabled={creating || !newCategory.trim()} onClick={() => void createCategory()}>{creating ? "Creating…" : "Create"}</Button>
                                <Button type="button" size="sm" variant="ghost" onClick={() => setNewCategory(null)}>Cancel</Button>
                            </div>
                        ) : null}
                        <div className="grid gap-1">
                            <Label htmlFor="script-timeout" className="text-xs">Time limit (sec)</Label>
                            <Input id="script-timeout" type="number" min={10} max={86400} className="h-9 w-28" value={timeoutSec} onChange={(e) => setTimeoutSec(Number(e.target.value))} />
                        </div>
                        <div className="ml-auto flex items-center gap-2">
                            {initial?.customized ? (
                                <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={() => void reset()} disabled={saving}>
                                    <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                                    Reset to original
                                </Button>
                            ) : null}
                        </div>
                    </div>
                    {builtin ? (
                        <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs" role="note" data-testid="builtin-edit-note">
                            This is a built-in script. If you save changes it becomes <strong>Customized</strong> and no longer follows ADG RMM&apos;s updates to it.
                            {initial?.customized ? " Reset to original brings back the version ADG RMM ships." : " You can reset it to the original at any time afterwards."}
                        </p>
                    ) : null}
                </div>

                <div className="grid min-h-0 flex-1 gap-0 lg:grid-cols-[minmax(0,1fr)_20rem]">
                    <div className="flex min-h-0 min-w-0 flex-col border-b lg:border-b-0 lg:border-r">
                        <div className="flex items-center justify-between gap-2 border-b bg-muted/40 px-3 py-1.5">
                            {several ? (
                                <div className="flex gap-1" role="tablist" aria-label="Which part to edit">
                                    {((platform === "all" ? ["windows", "linux", "macos"] : ["windows", "linux"]) as Array<"windows" | "linux" | "macos">).map((k) => (
                                        <button
                                            key={k}
                                            type="button"
                                            role="tab"
                                            aria-selected={part === k}
                                            className={`rounded px-2 py-1 text-xs font-medium ${part === k ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                                            onClick={() => setPart(k)}
                                        >
                                            {k === "windows" ? "Windows: script.ps1" : k === "linux" ? "Linux: script.sh" : "macOS: script.sh"}
                                        </button>
                                    ))}
                                </div>
                            ) : (
                                <span className="text-xs font-medium text-muted-foreground">{language === "powershell" ? "script.ps1" : "script.sh"}</span>
                            )}
                            <Button type="button" size="sm" variant="outline" className="h-7 text-xs" onClick={() => setSnippetsOpen(true)}>Snippets</Button>
                        </div>
                        <ScriptSnippetsDialog
                            open={snippetsOpen}
                            onOpenChange={setSnippetsOpen}
                            language={editorLanguage}
                            draft={text}
                            onInsert={(code) => { if (editor.current) editor.current.insert(code); else setText((cur) => `${cur}${cur.endsWith("\n") || !cur ? "" : "\n"}${code}`); }}
                        />
                        <div className="min-h-[14rem] flex-1 overflow-hidden" data-testid="code-editor">
                            <CodeEditor key={editing} value={text} onChange={setText} language={editorLanguage} onSave={() => void saveRef.current()} onStatus={setStatus} handleRef={editor} />
                        </div>
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t bg-muted/40 px-3 py-1 text-xs text-muted-foreground" data-testid="editor-status">
                            <span>Line {status.line}, column {status.col}</span>
                            <span>{status.lines} {status.lines === 1 ? "line" : "lines"}</span>
                            <span>{status.chars.toLocaleString()} characters</span>
                            <span className="ml-auto">{editorLanguage === "powershell" ? "PowerShell" : "Bash"}</span>
                        </div>
                    </div>

                    <div className="min-h-0 overflow-y-auto p-4">
                        <div className="grid gap-3">
                            <div className="flex items-center justify-between gap-2">
                                <Label>Parameters</Label>
                                <Button type="button" variant="outline" size="sm" className="h-7 gap-1 text-xs" onClick={() => setParameters((p) => [...p, { name: "", required: false }])}>
                                    <Plus className="h-3 w-3" aria-hidden="true" />
                                    Add
                                </Button>
                            </div>
                            {parameters.length === 0 ? (
                                <p className="text-xs text-muted-foreground">Values someone fills in when it runs.</p>
                            ) : (
                                <p className="text-xs text-muted-foreground">
                                    Read them from environment variables: a parameter named <code>user</code> is <code>{several ? "$env:ADG_USER (PowerShell) or $ADG_USER (bash)" : language === "powershell" ? "$env:ADG_USER" : "$ADG_USER"}</code>.
                                </p>
                            )}
                            {parameters.map((parameter, i) => (
                                <div key={i} className="grid gap-2 rounded-md border p-2">
                                    <div className="flex items-center gap-2">
                                        <Input aria-label="Parameter name" placeholder="name" value={parameter.name} onChange={(e) => updateParameter(i, { name: e.target.value })} className="h-8 min-w-0 flex-1" />
                                        <Button type="button" variant="ghost" size="icon" className="h-8 w-8 shrink-0" aria-label="Remove parameter" onClick={() => setParameters((p) => p.filter((_, index) => index !== i))}>
                                            <X className="h-4 w-4" aria-hidden="true" />
                                        </Button>
                                    </div>
                                    <Input aria-label="Label" placeholder="Label shown when it runs (optional)" value={parameter.label ?? ""} onChange={(e) => updateParameter(i, { label: e.target.value || undefined })} className="h-8" />
                                    <Input aria-label="Default value" placeholder="Default (optional)" value={parameter.defaultValue ?? ""} onChange={(e) => updateParameter(i, { defaultValue: e.target.value })} className="h-8" />
                                    <label className="flex items-center gap-1.5 text-xs">
                                        <Checkbox checked={!!parameter.required} onCheckedChange={(v) => updateParameter(i, { required: !!v })} />
                                        Required
                                    </label>
                                </div>
                            ))}
                            <ScriptPropertiesHint />
                        </div>
                    </div>
                </div>

                <div className="flex flex-wrap items-center gap-3 border-t px-5 py-3">
                    {error ? <p role="alert" className="min-w-0 flex-1 text-sm text-destructive">{error}</p> : <span className="flex-1" />}
                    <Button type="button" variant="outline" onClick={requestClose}>Cancel</Button>
                    <Button type="button" disabled={saving || (!!initial && !changed)} onClick={() => void save()}>{saving ? "Saving…" : "Save"}</Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}
