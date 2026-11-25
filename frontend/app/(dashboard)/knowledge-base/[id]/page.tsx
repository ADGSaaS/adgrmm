"use client";

// One knowledge base article: read it, vote on it, and (with kb.write) edit it, publish it and look through its history.
import * as React from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, Eye, History, Pencil, ThumbsDown, ThumbsUp, Trash2 } from "lucide-react";
import { PageHeader, PageShell } from "@/components/page-shell";
import PermGate from "@/components/perm-gate";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/use-toast";
import { Markdown } from "@/components/kb/markdown";
import { fmtDate, fmtDateTime, StatusBadges } from "@/components/kb/bits";
import { kb, type KbArticle, type KbCategory, type KbVersion, type KbVersionRow } from "@/lib/kb-api";
import { useMe } from "@/lib/use-me";
import { hasPerm } from "@/lib/permissions";

type Draft = { title: string; body: string; tags: string; categoryId: string; status: "draft" | "published"; customerVisible: boolean; note: string };
const EMPTY: Draft = { title: "", body: "", tags: "", categoryId: "", status: "draft", customerVisible: false, note: "" };

function parseTags(s: string): string[] {
    return [...new Set(s.split(/[,\n]/).map((t) => t.trim().toLowerCase().replace(/^#/, "").replace(/\s+/g, "-")).filter(Boolean))];
}

function Editor({ id, initial, categories, onSaved, onCancel }: { id: string | null; initial: Draft; categories: KbCategory[]; onSaved: (id: string) => void; onCancel: () => void }) {
    const [d, setD] = React.useState<Draft>(initial);
    const [preview, setPreview] = React.useState(false);
    const [saving, setSaving] = React.useState(false);
    const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
    const tags = parseTags(d.tags);

    async function save() {
        if (!d.title.trim()) { toast({ title: "The article needs a title", variant: "destructive" }); return; }
        setSaving(true);
        try {
            const body = { title: d.title.trim(), body: d.body, tags, categoryId: d.categoryId || null, status: d.status, customerVisible: d.customerVisible, note: d.note.trim() || undefined };
            if (id) {
                await kb.update(id, body);
                onSaved(id);
            } else {
                const r = await kb.create(body);
                onSaved(r.id);
            }
            toast({ title: "Saved" });
        } catch (e: any) {
            toast({ title: "Could not save", description: e?.message, variant: "destructive" });
        } finally {
            setSaving(false);
        }
    }

    return (
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void save(); }}>
            <div className="space-y-1.5">
                <Label htmlFor="kb-title">Title</Label>
                <Input id="kb-title" value={d.title} maxLength={200} onChange={(e) => set("title", e.target.value)} placeholder="What the article is about, in the words someone would search for" autoFocus={!id} />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                    <Label htmlFor="kb-category">Category</Label>
                    <select id="kb-category" value={d.categoryId} onChange={(e) => set("categoryId", e.target.value)} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
                        <option value="">No category</option>
                        {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                </div>
                <div className="space-y-1.5">
                    <Label htmlFor="kb-tags">Tags</Label>
                    <Input id="kb-tags" value={d.tags} onChange={(e) => set("tags", e.target.value)} placeholder="printing, windows, vpn" />
                    <p className="text-xs text-muted-foreground">Separate with commas. Up to 10. {tags.length ? `Saved as: ${tags.map((t) => `#${t}`).join(" ")}` : ""}</p>
                </div>
            </div>
            <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                    <Label htmlFor="kb-body">Article</Label>
                    <div className="inline-flex rounded-md border text-xs" role="tablist" aria-label="Editor view">
                        <button type="button" role="tab" aria-selected={!preview} className={`px-3 py-1 ${!preview ? "bg-muted font-medium" : ""}`} onClick={() => setPreview(false)}>Write</button>
                        <button type="button" role="tab" aria-selected={preview} className={`px-3 py-1 ${preview ? "bg-muted font-medium" : ""}`} onClick={() => setPreview(true)}>Preview</button>
                    </div>
                </div>
                {preview ? (
                    <div className="min-h-[18rem] rounded-md border bg-card p-4">{d.body.trim() ? <Markdown text={d.body} /> : <p className="text-sm text-muted-foreground">Nothing to preview yet.</p>}</div>
                ) : (
                    <Textarea id="kb-body" value={d.body} onChange={(e) => set("body", e.target.value)} rows={16} className="font-mono text-sm" placeholder={"Steps, one per line:\n\n1. Open **Services**\n2. Restart `Print Spooler`\n\nUse # for headings, - for bullets, and ``` for code blocks."} />
                )}
                <p className="text-xs text-muted-foreground">Markdown: **bold**, *italic*, `code`, [links](https://example.com), lists, quotes, headings and code blocks.</p>
            </div>
            <div className="grid gap-4 rounded-lg border p-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                    <Label htmlFor="kb-status">Status</Label>
                    <select id="kb-status" value={d.status} onChange={(e) => set("status", e.target.value as Draft["status"])} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
                        <option value="draft">Draft: only people who can write articles see it</option>
                        <option value="published">Published: every technician can read it</option>
                    </select>
                </div>
                <div className="flex items-start gap-3">
                    <Switch id="kb-customers" checked={d.customerVisible} onCheckedChange={(v) => set("customerVisible", v)} />
                    <div>
                        <Label htmlFor="kb-customers">Visible to customers</Label>
                        <p className="text-xs text-muted-foreground">Shown in the client portal once published. Anything written here can be read by every customer with a portal account, so keep internal details out.</p>
                    </div>
                </div>
            </div>
            {id ? (
                <div className="space-y-1.5">
                    <Label htmlFor="kb-note">What changed (optional)</Label>
                    <Input id="kb-note" value={d.note} maxLength={200} onChange={(e) => set("note", e.target.value)} placeholder="Shown in the version history" />
                </div>
            ) : null}
            <div className="flex flex-wrap gap-2">
                <Button type="submit" disabled={saving}>{saving ? "Saving…" : id ? "Save article" : "Create article"}</Button>
                <Button type="button" variant="outline" onClick={onCancel} disabled={saving}>Cancel</Button>
            </div>
        </form>
    );
}

function HistoryPanel({ id, onRestored }: { id: string; onRestored: () => void }) {
    const [rows, setRows] = React.useState<KbVersionRow[] | null>(null);
    const [open, setOpen] = React.useState<KbVersion | null>(null);
    const [error, setError] = React.useState<string | null>(null);

    const load = React.useCallback(() => {
        kb.versions(id).then(setRows).catch((e) => setError(e?.message || "Could not load the history."));
    }, [id]);
    React.useEffect(load, [load]);

    async function view(v: number) {
        try { setOpen(await kb.version(id, v)); } catch (e: any) { toast({ title: "Could not open that version", description: e?.message, variant: "destructive" }); }
    }
    async function restore(v: number) {
        if (!confirm(`Put version ${v} back? It becomes a new version; nothing is lost.`)) return;
        try {
            await kb.restore(id, v);
            toast({ title: `Version ${v} restored` });
            setOpen(null);
            load();
            onRestored();
        } catch (e: any) {
            toast({ title: "Could not restore", description: e?.message, variant: "destructive" });
        }
    }

    return (
        <section aria-labelledby="kb-history" className="rounded-xl border bg-card p-4">
            <h2 id="kb-history" className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">Version history</h2>
            {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
            {!rows && !error ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
            <ul className="divide-y">
                {(rows ?? []).map((v) => (
                    <li key={v.version} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                        <span className="w-10 font-medium tabular-nums">v{v.version}</span>
                        <span className="min-w-0 flex-1">
                            <span className="block truncate">{v.title}</span>
                            <span className="block text-xs text-muted-foreground">{fmtDateTime(v.savedAt)}{v.savedBy ? ` by ${v.savedBy}` : ""}{v.note ? `: ${v.note}` : ""}</span>
                        </span>
                        {v.current ? <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-700 dark:text-emerald-300">Current</span> : null}
                        <Button size="sm" variant="ghost" onClick={() => void view(v.version)}>View</Button>
                        {!v.current ? <Button size="sm" variant="outline" onClick={() => void restore(v.version)}>Restore</Button> : null}
                    </li>
                ))}
            </ul>
            {open ? (
                <div className="mt-4 rounded-lg border bg-background p-4">
                    <div className="mb-2 flex items-center justify-between gap-2">
                        <h3 className="font-medium">Version {open.version}: {open.title}</h3>
                        <Button size="sm" variant="ghost" onClick={() => setOpen(null)}>Close</Button>
                    </div>
                    <Markdown text={open.body} />
                </div>
            ) : null}
        </section>
    );
}

function Article() {
    const params = useParams<{ id: string }>();
    const router = useRouter();
    const rawId = params?.id ?? "";
    const isNew = rawId === "new";
    const { permissions } = useMe();
    const canWrite = hasPerm(permissions, "kb.write");
    const [a, setA] = React.useState<KbArticle | null>(null);
    const [categories, setCategories] = React.useState<KbCategory[]>([]);
    const [error, setError] = React.useState<string | null>(null);
    const [editing, setEditing] = React.useState(isNew);
    const [showHistory, setShowHistory] = React.useState(false);

    const load = React.useCallback(async (countView: boolean) => {
        try {
            setA(await kb.get(rawId, countView));
            setError(null);
        } catch (e: any) {
            setError(e?.status === 404 ? "This article does not exist, or you cannot see it." : e?.message || "Could not load the article.");
        }
    }, [rawId]);

    React.useEffect(() => {
        if (!isNew) void load(true);
    }, [isNew, load]);
    React.useEffect(() => {
        kb.categories().then(setCategories).catch(() => null);
    }, []);

    async function vote(helpful: boolean) {
        if (!a) return;
        try {
            const r = await kb.vote(a.id, helpful);
            setA({ ...a, helpful: r.helpful, unhelpful: r.unhelpful, myVote: r.myVote });
        } catch (e: any) {
            toast({ title: "Could not save your vote", description: e?.message, variant: "destructive" });
        }
    }
    async function remove() {
        if (!a || !confirm(`Delete "${a.title}" and its history? This cannot be undone.`)) return;
        try {
            await kb.remove(a.id);
            toast({ title: "Article deleted" });
            router.push("/knowledge-base");
        } catch (e: any) {
            toast({ title: "Could not delete", description: e?.message, variant: "destructive" });
        }
    }

    const back = (
        <Link href="/knowledge-base" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" aria-hidden />Knowledge base</Link>
    );

    if (isNew) {
        if (!canWrite) return <PageShell>{back}<p className="text-sm text-muted-foreground">You do not have permission to write articles.</p></PageShell>;
        return (
            <PageShell>
                {back}
                <PageHeader title="New article" />
                <Editor id={null} initial={EMPTY} categories={categories} onSaved={(id) => router.replace(`/knowledge-base/${id}`)} onCancel={() => router.push("/knowledge-base")} />
            </PageShell>
        );
    }
    if (error) return <PageShell>{back}<p role="alert" className="text-sm text-destructive">{error}</p></PageShell>;
    if (!a) return <PageShell>{back}<p className="text-sm text-muted-foreground">Loading…</p></PageShell>;

    if (editing && canWrite) {
        return (
            <PageShell>
                {back}
                <PageHeader title="Edit article" />
                <Editor
                    id={a.id}
                    initial={{ title: a.title, body: a.body, tags: a.tags.join(", "), categoryId: a.category?.id ?? "", status: a.status, customerVisible: a.customerVisible, note: "" }}
                    categories={categories}
                    onSaved={async () => { await load(false); setEditing(false); }}
                    onCancel={() => setEditing(false)}
                />
            </PageShell>
        );
    }

    return (
        <PageShell>
            {back}
            <PageHeader
                title={<span className="flex flex-wrap items-center gap-2">{a.title} <StatusBadges a={a} /></span>}
                description={
                    <>
                        {a.category ? <>{a.category.name} · </> : null}
                        Updated {fmtDate(a.updatedAt)}{a.updatedBy ? ` by ${a.updatedBy}` : ""} · version {a.version}
                        {a.author?.name ? <> · written by {a.author.name}</> : null}
                    </>
                }
                actions={
                    canWrite ? (
                        <>
                            <Button variant="outline" className="gap-1.5" onClick={() => setShowHistory((s) => !s)}><History className="h-4 w-4" aria-hidden />History</Button>
                            <Button className="gap-1.5" onClick={() => setEditing(true)}><Pencil className="h-4 w-4" aria-hidden />Edit</Button>
                            <Button variant="outline" className="gap-1.5 text-destructive" onClick={() => void remove()}><Trash2 className="h-4 w-4" aria-hidden />Delete</Button>
                        </>
                    ) : null
                }
            />
            {a.status === "draft" ? <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">This is a draft. Technicians who cannot write articles do not see it.</p> : null}
            <article className="rounded-xl border bg-card p-5">
                {a.body.trim() ? <Markdown text={a.body} /> : <p className="text-sm text-muted-foreground">This article has no text yet.</p>}
            </article>
            {a.tags.length ? <div className="flex flex-wrap gap-2 text-xs">{a.tags.map((t) => <Link key={t} href={`/knowledge-base`} className="rounded bg-muted px-2 py-1 text-muted-foreground">#{t}</Link>)}</div> : null}
            <div className="flex flex-wrap items-center gap-3 rounded-xl border p-4 text-sm">
                <span>Was this helpful?</span>
                <Button size="sm" variant={a.myVote === "helpful" ? "default" : "outline"} className="gap-1.5" aria-pressed={a.myVote === "helpful"} onClick={() => void vote(true)}><ThumbsUp className="h-4 w-4" aria-hidden />Yes ({a.helpful})</Button>
                <Button size="sm" variant={a.myVote === "unhelpful" ? "default" : "outline"} className="gap-1.5" aria-pressed={a.myVote === "unhelpful"} onClick={() => void vote(false)}><ThumbsDown className="h-4 w-4" aria-hidden />No ({a.unhelpful})</Button>
                <span className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground"><Eye className="h-3.5 w-3.5" aria-hidden />{a.viewCount} view{a.viewCount === 1 ? "" : "s"} · linked on {a.linkedTickets} ticket{a.linkedTickets === 1 ? "" : "s"}</span>
            </div>
            {showHistory && canWrite ? <HistoryPanel id={a.id} onRestored={() => void load(false)} /> : null}
        </PageShell>
    );
}

export default function KnowledgeBaseArticlePage() {
    return (
        <PermGate require="kb.read" title="Knowledge base" message="You do not have permission to read the knowledge base.">
            <Article />
        </PermGate>
    );
}
