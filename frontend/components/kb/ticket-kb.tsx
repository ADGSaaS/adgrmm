"use client";

// The knowledge base on a ticket: articles linked to it, suggestions from its subject, a search to link another,
// and a button for the reply box that inserts an article's link.
import * as React from "react";
import Link from "next/link";
import { BookOpen, Link2, Plus, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/use-toast";
import { Snippet } from "@/components/kb/markdown";
import { articleUrl, kb, type KbArticleRow } from "@/lib/kb-api";
import { useMe } from "@/lib/use-me";
import { hasPerm } from "@/lib/permissions";

/** Search the published articles and choose one. */
function ArticlePicker({ open, onClose, title, description, onPick }: { open: boolean; onClose: () => void; title: string; description: string; onPick: (a: KbArticleRow) => void | Promise<void> }) {
    const [q, setQ] = React.useState("");
    const [rows, setRows] = React.useState<KbArticleRow[]>([]);
    const [loading, setLoading] = React.useState(false);

    React.useEffect(() => {
        if (!open) return;
        let stale = false;
        const t = setTimeout(() => {
            setLoading(true);
            kb.list({ q: q.trim(), status: "published", limit: 20 })
                .then((r) => { if (!stale) setRows(r.items); })
                .catch(() => { if (!stale) setRows([]); })
                .finally(() => { if (!stale) setLoading(false); });
        }, 200);
        return () => { stale = true; clearTimeout(t); };
    }, [open, q]);

    return (
        <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle>{title}</DialogTitle>
                    <DialogDescription>{description}</DialogDescription>
                </DialogHeader>
                <div className="relative">
                    <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" aria-hidden />
                    <Input autoFocus aria-label="Search articles" placeholder="Search articles" className="pl-9" value={q} onChange={(e) => setQ(e.target.value)} />
                </div>
                <ul className="max-h-80 space-y-1 overflow-y-auto">
                    {rows.map((a) => (
                        <li key={a.id}>
                            <button type="button" className="w-full rounded-md border p-2 text-left text-sm hover:bg-accent" onClick={() => void onPick(a)}>
                                <span className="flex items-center gap-2 font-medium">{a.title}{a.customerVisible ? <span className="rounded-full bg-sky-500/15 px-1.5 text-xs font-normal text-sky-700 dark:text-sky-300">Customers can open</span> : <span className="rounded-full bg-muted px-1.5 text-xs font-normal text-muted-foreground">Internal</span>}</span>
                                <span className="line-clamp-1 text-xs text-muted-foreground"><Snippet text={a.excerpt} /></span>
                            </button>
                        </li>
                    ))}
                    {!loading && rows.length === 0 ? <li className="py-4 text-center text-sm text-muted-foreground">No published articles match.</li> : null}
                </ul>
            </DialogContent>
        </Dialog>
    );
}

/** A button for the reply box: pick an article and its link goes into the reply. */
export function InsertArticleButton({ onInsert, disabled }: { onInsert: (text: string) => void; disabled?: boolean }) {
    const { permissions } = useMe();
    const [open, setOpen] = React.useState(false);
    if (!hasPerm(permissions, "kb.read")) return null;
    return (
        <>
            <Button type="button" variant="outline" size="sm" className="h-9 gap-1.5" disabled={disabled} onClick={() => setOpen(true)} title="Insert a link to a knowledge base article">
                <BookOpen className="h-4 w-4" aria-hidden />Insert article
            </Button>
            <ArticlePicker
                open={open}
                onClose={() => setOpen(false)}
                title="Insert an article link"
                description="The link goes into your reply. Customers can open it only when the article is marked visible to customers and the client portal has an address."
                onPick={async (a) => {
                    const { url, customerCanOpen } = await articleUrl(a);
                    onInsert(`${a.title}: ${url}`);
                    setOpen(false);
                    if (!customerCanOpen) toast({ title: "Customers cannot open this link", description: "This article is internal, or the portal has no address. Consider writing the steps into the reply." });
                }}
            />
        </>
    );
}

/** The ticket page's knowledge base card. */
export function TicketKbCard({ ticketId, subject }: { ticketId: string; subject: string }) {
    const { permissions } = useMe();
    const canRead = hasPerm(permissions, "kb.read");
    const canLink = hasPerm(permissions, ["kb.read", "tickets.write"]);
    const [linked, setLinked] = React.useState<KbArticleRow[]>([]);
    const [suggested, setSuggested] = React.useState<KbArticleRow[]>([]);
    const [pick, setPick] = React.useState(false);

    const load = React.useCallback(() => {
        kb.links(ticketId).then(setLinked).catch(() => setLinked([]));
        kb.suggestions(ticketId).then(setSuggested).catch(() => setSuggested([]));
    }, [ticketId]);
    // The subject can change, so suggestions are fetched again when it does.
    React.useEffect(() => { if (canRead) load(); }, [canRead, load, subject]);

    if (!canRead) return null;

    async function link(a: KbArticleRow) {
        try { await kb.link(ticketId, a.id); setPick(false); load(); } catch (e: any) { toast({ title: "Could not link the article", description: e?.message, variant: "destructive" }); }
    }
    async function unlink(a: KbArticleRow) {
        try { await kb.unlink(ticketId, a.id); load(); } catch (e: any) { toast({ title: "Could not remove the link", description: e?.message, variant: "destructive" }); }
    }

    return (
        <div>
            <div className="mb-3 flex items-center justify-between">
                <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Knowledge base</h3>
                {canLink ? <Button size="sm" variant="ghost" className="h-7 gap-1 px-2" onClick={() => setPick(true)}><Plus className="h-3.5 w-3.5" aria-hidden />Link article</Button> : null}
            </div>
            {linked.length === 0 ? <p className="text-sm text-muted-foreground">No articles linked.</p> : (
                <ul className="space-y-1.5 text-sm">
                    {linked.map((a) => (
                        <li key={a.id} className="flex items-center justify-between gap-2">
                            <Link href={`/knowledge-base/${a.id}`} className="inline-flex min-w-0 items-center gap-1.5 hover:underline"><Link2 className="h-3.5 w-3.5 shrink-0" aria-hidden /><span className="truncate">{a.title}</span></Link>
                            {canLink ? <button type="button" aria-label={`Unlink ${a.title}`} className="text-muted-foreground hover:text-foreground" onClick={() => void unlink(a)}><X className="h-3.5 w-3.5" /></button> : null}
                        </li>
                    ))}
                </ul>
            )}
            {suggested.length > 0 ? (
                <div className="mt-3 border-t pt-3">
                    <p className="mb-1.5 text-xs font-medium text-muted-foreground">Suggested from the subject</p>
                    <ul className="space-y-1.5 text-sm">
                        {suggested.map((a) => (
                            <li key={a.id} className="flex items-center justify-between gap-2">
                                <Link href={`/knowledge-base/${a.id}`} className="truncate hover:underline">{a.title}</Link>
                                {canLink ? <button type="button" className="shrink-0 text-xs text-primary hover:underline" onClick={() => void link(a)}>Link</button> : null}
                            </li>
                        ))}
                    </ul>
                </div>
            ) : null}
            <ArticlePicker open={pick} onClose={() => setPick(false)} title="Link an article" description="Linked articles are listed on the ticket for whoever works on it next." onPick={link} />
        </div>
    );
}
