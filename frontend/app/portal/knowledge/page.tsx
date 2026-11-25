"use client";

// Help articles the support team chose to share with customers, with search.
import * as React from "react";
import Link from "next/link";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Snippet } from "@/components/kb/markdown";
import { portal } from "@/lib/portal-api";
import { Empty, PageTitle, Panel } from "../parts";
import { useHref, usePortalMe } from "../portal-shell";

type Item = { id: string; title: string; excerpt: string; tags: string[]; category: { id: string; name: string } | null; updatedAt: string };
type Result = { items: Item[]; total: number; categories: { id: string; name: string; articles: number }[] };

export default function PortalKnowledge() {
    const { me } = usePortalMe();
    const href = useHref();
    const [q, setQ] = React.useState("");
    const [debounced, setDebounced] = React.useState("");
    const [category, setCategory] = React.useState("");
    const [data, setData] = React.useState<Result | null>(null);
    const [error, setError] = React.useState<string | null>(null);

    React.useEffect(() => {
        const t = setTimeout(() => setDebounced(q.trim()), 250);
        return () => clearTimeout(t);
    }, [q]);

    React.useEffect(() => {
        let stale = false;
        const params = new URLSearchParams();
        if (debounced) params.set("q", debounced);
        if (category) params.set("category", category);
        portal<Result>(`/kb${params.toString() ? `?${params}` : ""}`)
            .then((d) => { if (!stale) { setData(d); setError(null); } })
            .catch((e) => { if (!stale) setError(e?.message || "Could not load the articles."); });
        return () => { stale = true; };
    }, [debounced, category]);

    if (!me.modules.includes("knowledge")) return <Empty>This area is not available to you.</Empty>;

    return (
        <div>
            <PageTitle title="Help articles" />
            <div className="mb-4 flex flex-col gap-2 sm:flex-row">
                <div className="relative w-full sm:max-w-sm">
                    <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" aria-hidden />
                    <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search help articles" aria-label="Search help articles" className="pl-9" />
                </div>
                {data && data.categories.length > 0 ? (
                    <select aria-label="Category" value={category} onChange={(e) => setCategory(e.target.value)} className="h-10 rounded-md border border-input bg-background px-3 text-sm">
                        <option value="">All topics</option>
                        {data.categories.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.articles})</option>)}
                    </select>
                ) : null}
            </div>
            {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
            {!data && !error ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
            {data && data.items.length === 0 ? <Empty>{debounced || category ? "No articles match your search." : "There are no help articles yet."}</Empty> : null}
            <ul className="grid gap-3">
                {(data?.items ?? []).map((a) => (
                    <li key={a.id}>
                        <Link href={href(`/knowledge/${a.id}`)}>
                            <Panel className="p-4 transition-colors hover:bg-accent/40">
                                <h2 className="font-medium">{a.title}</h2>
                                {a.category ? <p className="text-xs text-muted-foreground">{a.category.name}</p> : null}
                                <p className="mt-1 line-clamp-2 text-sm text-muted-foreground"><Snippet text={a.excerpt} /></p>
                            </Panel>
                        </Link>
                    </li>
                ))}
            </ul>
        </div>
    );
}
