"use client";

// components/automation/script-categories.tsx
//
// The first thing the scripts tab shows: one tile per category with how many scripts it holds. Clicking a tile opens that category (the page
// shows its scripts under a Back button). Creating a category needs its own right, separate from creating and editing scripts, so the "New
// category" tile and the delete button appear only for people who have it.
import * as React from "react";
import { FolderOpen, FolderPlus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { UNCATEGORIZED, type ScriptCategories } from "@/components/automation/script-types";

type Props = {
    data: ScriptCategories;
    canManage: boolean;
    onOpen: (key: string) => void;
    onCreate: (name: string) => Promise<string | null>;
    onDelete: (id: string, name: string) => void;
};

const tag = "shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium";

export default function ScriptCategoryTiles({ data, canManage, onOpen, onCreate, onDelete }: Props) {
    const [adding, setAdding] = React.useState(false);
    const [name, setName] = React.useState("");
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);

    const create = async () => {
        if (!name.trim()) return;
        setBusy(true);
        setError(null);
        const problem = await onCreate(name.trim());
        setBusy(false);
        if (problem) setError(problem);
        else { setAdding(false); setName(""); }
    };

    return (
        <ul className="grid list-none gap-3 p-0 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4" data-testid="category-tiles" aria-label="Script categories">
            {data.items.map((c) => (
                <li key={c.name} className="group relative">
                    <button
                        type="button"
                        onClick={() => onOpen(c.name)}
                        className="flex h-full w-full flex-col gap-2 rounded-xl border border-border/70 bg-card p-4 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        data-testid={`category-${c.name}`}
                    >
                        <span className="flex items-center gap-2">
                            <FolderOpen className="h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
                            <span className="truncate font-medium">{c.name}</span>
                        </span>
                        <span className="flex items-center gap-2 text-xs text-muted-foreground">
                            <span>{c.count} {c.count === 1 ? "script" : "scripts"}</span>
                            <span className={`${tag} ${c.builtin ? "border-primary/40 bg-primary/10 text-primary" : "border-border bg-muted text-muted-foreground"}`}>{c.builtin ? "Built-in" : "Yours"}</span>
                        </span>
                    </button>
                    {canManage && !c.builtin && c.id && c.count === 0 ? (
                        <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="absolute right-2 top-2 h-7 w-7 opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
                            aria-label={`Delete the category ${c.name}`}
                            title="Delete this empty category"
                            onClick={() => onDelete(c.id as string, c.name)}
                        >
                            <Trash2 className="h-4 w-4" aria-hidden="true" />
                        </Button>
                    ) : null}
                </li>
            ))}
            {data.uncategorized > 0 ? (
                <li>
                    <button
                        type="button"
                        onClick={() => onOpen(UNCATEGORIZED)}
                        className="flex h-full w-full flex-col gap-2 rounded-xl border border-border/70 bg-card p-4 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        data-testid="category-uncategorized"
                    >
                        <span className="flex items-center gap-2"><FolderOpen className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" /><span className="truncate font-medium">Uncategorized</span></span>
                        <span className="text-xs text-muted-foreground">{data.uncategorized} {data.uncategorized === 1 ? "script" : "scripts"}</span>
                    </button>
                </li>
            ) : null}
            {canManage ? (
                <li>
                    {adding ? (
                        <div className="flex h-full flex-col gap-2 rounded-xl border border-dashed border-primary/50 bg-card p-4" data-testid="new-category-form">
                            <label htmlFor="new-category-name" className="text-xs font-medium">New category</label>
                            <Input
                                id="new-category-name"
                                autoFocus
                                maxLength={60}
                                placeholder="Name"
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === "Enter") { e.preventDefault(); void create(); }
                                    if (e.key === "Escape") { setAdding(false); setName(""); setError(null); }
                                }}
                            />
                            {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
                            <div className="flex gap-2">
                                <Button type="button" size="sm" disabled={busy || !name.trim()} onClick={() => void create()}>{busy ? "Creating…" : "Create"}</Button>
                                <Button type="button" size="sm" variant="ghost" onClick={() => { setAdding(false); setName(""); setError(null); }}>Cancel</Button>
                            </div>
                        </div>
                    ) : (
                        <button
                            type="button"
                            onClick={() => setAdding(true)}
                            className="flex h-full min-h-[5.5rem] w-full items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-transparent p-4 text-sm text-muted-foreground transition-colors hover:border-primary/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            data-testid="new-category"
                        >
                            <FolderPlus className="h-4 w-4" aria-hidden="true" />
                            New category
                        </button>
                    )}
                </li>
            ) : null}
        </ul>
    );
}
