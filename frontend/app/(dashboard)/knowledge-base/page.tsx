"use client";

// The internal knowledge base: how-to articles for technicians. Search, filter, open, and (with the right) write.
import * as React from "react";
import Link from "next/link";
import { BookOpen, Eye, FolderCog, Plus, ThumbsUp } from "lucide-react";
import { PageHeader, PageShell } from "@/components/page-shell";
import PermGate from "@/components/perm-gate";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/use-toast";
import { EmptyState, FilterSelect, ListToolbar, SearchField } from "@/components/list-controls";
import { Snippet } from "@/components/kb/markdown";
import { fmtDate, StatusBadges } from "@/components/kb/bits";
import { kb, type KbArticleRow, type KbCategory } from "@/lib/kb-api";
import { useMe } from "@/lib/use-me";
import { hasPerm } from "@/lib/permissions";

const PAGE = 25;

function CategoriesDialog({ open, onClose, categories, onChanged }: { open: boolean; onClose: () => void; categories: KbCategory[]; onChanged: () => void }) {
    const [name, setName] = React.useState("");
    const [busy, setBusy] = React.useState(false);
    const [editing, setEditing] = React.useState<Record<string, string>>({});

    async function run(fn: () => Promise<unknown>, okMsg?: string) {
        setBusy(true);
        try {
            await fn();
            if (okMsg) toast({ title: okMsg });
            onChanged();
        } catch (e: any) {
            toast({ title: "That did not work", description: e?.message, variant: "destructive" });
        } finally {
            setBusy(false);
        }
    }

    return (
        <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>Categories</DialogTitle>
                    <DialogDescription>Deleting a category keeps its articles; they just have no category.</DialogDescription>
                </DialogHeader>
                <ul className="max-h-72 space-y-2 overflow-y-auto">
                    {categories.map((c) => (
                        <li key={c.id} className="flex items-center gap-2">
                            <Input
                                aria-label={`Name of ${c.name}`}
                                value={editing[c.id] ?? c.name}
                                onChange={(e) => setEditing((m) => ({ ...m, [c.id]: e.target.value }))}
                                onBlur={() => {
                                    const v = (editing[c.id] ?? c.name).trim();
                                    if (v && v !== c.name) void run(() => kb.renameCategory(c.id, v), "Renamed");
                                    setEditing((m) => { const n = { ...m }; delete n[c.id]; return n; });
                                }}
                            />
                            <span className="w-16 shrink-0 text-xs text-muted-foreground">{c.articles} article{c.articles === 1 ? "" : "s"}</span>
                            <Button variant="ghost" size="sm" disabled={busy} onClick={() => { if (confirm(`Delete the category "${c.name}"? Its articles are kept.`)) void run(() => kb.deleteCategory(c.id), "Deleted"); }}>Delete</Button>
                        </li>
                    ))}
                    {categories.length === 0 ? <li className="text-sm text-muted-foreground">No categories yet.</li> : null}
                </ul>
                <form
                    className="flex gap-2"
                    onSubmit={(e) => {
                        e.preventDefault();
                        const v = name.trim();
                        if (!v) return;
                        void run(() => kb.createCategory(v), "Category added").then(() => setName(""));
                    }}
                >
                    <Input aria-label="New category name" placeholder="New category" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
                    <Button type="submit" disabled={busy || !name.trim()}>Add</Button>
                </form>
                <DialogFooter><Button variant="outline" onClick={onClose}>Done</Button></DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function KnowledgeBase() {
    const { permissions } = useMe();
    const canWrite = hasPerm(permissions, "kb.write");
    const [q, setQ] = React.useState("");
    const [debounced, setDebounced] = React.useState("");
    const [category, setCategory] = React.useState("");
    const [status, setStatus] = React.useState("");
    const [tag, setTag] = React.useState("");
    const [items, setItems] = React.useState<KbArticleRow[]>([]);
    const [total, setTotal] = React.useState(0);
    const [loading, setLoading] = React.useState(true);
    const [error, setError] = React.useState<string | null>(null);
    const [categories, setCategories] = React.useState<KbCategory[]>([]);
    const [tags, setTags] = React.useState<{ tag: string; n: number }[]>([]);
    const [manage, setManage] = React.useState(false);

    React.useEffect(() => {
        const t = setTimeout(() => setDebounced(q.trim()), 250);
        return () => clearTimeout(t);
    }, [q]);

    const loadSide = React.useCallback(() => {
        kb.categories().then(setCategories).catch(() => null);
        kb.tags().then(setTags).catch(() => null);
    }, []);
    React.useEffect(loadSide, [loadSide]);

    React.useEffect(() => {
        let stale = false;
        setLoading(true);
        kb.list({ q: debounced, category, tag, status, limit: PAGE, offset: 0 })
            .then((r) => { if (!stale) { setItems(r.items); setTotal(r.total); setError(null); } })
            .catch((e) => { if (!stale) setError(e?.message || "Could not load the articles."); })
            .finally(() => { if (!stale) setLoading(false); });
        return () => { stale = true; };
    }, [debounced, category, tag, status]);

    async function more() {
        try {
            const r = await kb.list({ q: debounced, category, tag, status, limit: PAGE, offset: items.length });
            setItems((cur) => [...cur, ...r.items]);
            setTotal(r.total);
        } catch (e: any) {
            toast({ title: "Could not load more", description: e?.message, variant: "destructive" });
        }
    }

    return (
        <PageShell>
            <PageHeader
                title="Knowledge base"
                description="How-to articles for the help desk: fixes, procedures and answers worth reusing."
                actions={
                    canWrite ? (
                        <>
                            <Button variant="outline" onClick={() => setManage(true)} className="gap-1.5"><FolderCog className="h-4 w-4" aria-hidden />Categories</Button>
                            <Button asChild className="gap-1.5"><Link href="/knowledge-base/new"><Plus className="h-4 w-4" aria-hidden />New article</Link></Button>
                        </>
                    ) : null
                }
            />
            <ListToolbar
                left={<p className="text-sm text-muted-foreground" aria-live="polite">{loading ? "Searching…" : `${total} article${total === 1 ? "" : "s"}`}</p>}
                right={
                    <>
                        <SearchField value={q} onChange={setQ} placeholder="Search articles" />
                        <FilterSelect label="Category" value={category} onChange={setCategory} options={[{ value: "", label: "All categories" }, { value: "none", label: "No category" }, ...categories.map((c) => ({ value: c.id, label: c.name }))]} />
                        <FilterSelect label="Tag" value={tag} onChange={setTag} options={[{ value: "", label: "Any tag" }, ...tags.map((t) => ({ value: t.tag, label: `${t.tag} (${t.n})` }))]} />
                        {canWrite ? <FilterSelect label="Status" value={status} onChange={setStatus} options={[{ value: "", label: "Drafts and published" }, { value: "published", label: "Published" }, { value: "draft", label: "Drafts" }]} /> : null}
                    </>
                }
            />
            {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
            {!loading && !error && items.length === 0 ? (
                <EmptyState>
                    <BookOpen className="mx-auto mb-2 h-6 w-6" aria-hidden />
                    {debounced || category || tag || status ? "No articles match." : canWrite ? "No articles yet. Write the first one." : "No articles have been published yet."}
                </EmptyState>
            ) : null}
            <ul className="grid gap-3">
                {items.map((a) => (
                    <li key={a.id}>
                        <Link href={`/knowledge-base/${a.id}`} className="block rounded-xl border bg-card p-4 transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                            <div className="flex flex-wrap items-center gap-2">
                                <h2 className="font-medium">{a.title}</h2>
                                <StatusBadges a={a} />
                                {a.category ? <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{a.category.name}</span> : null}
                            </div>
                            <p className="mt-1 line-clamp-2 text-sm text-muted-foreground"><Snippet text={a.excerpt} /></p>
                            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                                {a.tags.map((t) => <span key={t} className="rounded bg-muted px-1.5 py-0.5">#{t}</span>)}
                                <span>Updated {fmtDate(a.updatedAt)}{a.updatedBy ? ` by ${a.updatedBy}` : ""}</span>
                                <span className="inline-flex items-center gap-1"><Eye className="h-3 w-3" aria-hidden />{a.viewCount}</span>
                                <span className="inline-flex items-center gap-1"><ThumbsUp className="h-3 w-3" aria-hidden />{a.helpful}</span>
                            </div>
                        </Link>
                    </li>
                ))}
            </ul>
            {items.length < total ? <div className="text-center"><Button variant="outline" onClick={() => void more()}>Show more ({total - items.length} left)</Button></div> : null}
            <CategoriesDialog open={manage} onClose={() => setManage(false)} categories={categories} onChanged={loadSide} />
        </PageShell>
    );
}

export default function KnowledgeBasePage() {
    return (
        <PermGate require="kb.read" title="Knowledge base" message="You do not have permission to read the knowledge base.">
            <KnowledgeBase />
        </PermGate>
    );
}
