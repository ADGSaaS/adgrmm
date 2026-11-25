"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, ThumbsDown, ThumbsUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Markdown } from "@/components/kb/markdown";
import { portal } from "@/lib/portal-api";
import { Empty, PageTitle, Panel, useLoad } from "../../parts";
import { useHref, usePortalMe } from "../../portal-shell";

type Article = { id: string; title: string; body: string; tags: string[]; category: { id: string; name: string } | null; updatedAt: string; myVote: "helpful" | "unhelpful" | null };

export default function PortalArticle() {
    const { me } = usePortalMe();
    const href = useHref();
    const id = useParams<{ id: string }>()?.id ?? "";
    const { data, error } = useLoad(() => portal<Article>(`/kb/${encodeURIComponent(id)}`), [id]);
    const [vote, setVote] = React.useState<"helpful" | "unhelpful" | null>(null);
    React.useEffect(() => setVote(data?.myVote ?? null), [data]);

    if (!me.modules.includes("knowledge")) return <Empty>This area is not available to you.</Empty>;

    async function send(helpful: boolean) {
        try {
            const r = await portal<{ myVote: "helpful" | "unhelpful" }>(`/kb/${encodeURIComponent(id)}/feedback`, { method: "POST", body: { helpful } });
            setVote(r.myVote);
        } catch { /* the vote is a nicety; stay quiet */ }
    }

    return (
        <div>
            <Link href={href("/knowledge")} className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" aria-hidden />Help articles</Link>
            {error ? <Empty>This article is not available.</Empty> : null}
            {!data && !error ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
            {data ? (
                <>
                    <PageTitle title={data.title} />
                    <Panel className="p-5"><Markdown text={data.body} /></Panel>
                    <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
                        <span>Did this help?</span>
                        <Button size="sm" variant={vote === "helpful" ? "default" : "outline"} className="gap-1.5" aria-pressed={vote === "helpful"} onClick={() => void send(true)}><ThumbsUp className="h-4 w-4" aria-hidden />Yes</Button>
                        <Button size="sm" variant={vote === "unhelpful" ? "default" : "outline"} className="gap-1.5" aria-pressed={vote === "unhelpful"} onClick={() => void send(false)}><ThumbsDown className="h-4 w-4" aria-hidden />No</Button>
                        {vote === "unhelpful" ? <span className="text-muted-foreground">Sorry. Open a ticket and we will help.</span> : null}
                    </div>
                </>
            ) : null}
        </div>
    );
}
