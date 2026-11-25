// components/itdocs/links-panel.tsx
"use client";

import * as React from "react";
import Link from "next/link";
import { Link2, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FilterSelect, SearchField } from "@/components/list-controls";
import { toast } from "@/components/ui/use-toast";
import { itdocs, type EntityLink, type LinkType } from "@/lib/itdocs-api";

const TYPE_LABEL: Record<LinkType, string> = { ticket: "Ticket", device: "Device", asset: "Asset" };

const hrefFor = (link: EntityLink) => {
    if (link.type === "ticket") return `/tickets/${link.id}`;
    if (link.type === "device") return `/devices/${link.id}`;
    return `/assets?asset=${link.id}`;
};

const errorText = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong.");

/** Shows and edits what a ticket, device or asset is linked to. */
export default function LinksPanel({ type, id, className }: { type: LinkType; id: string; className?: string }) {
    const [links, setLinks] = React.useState<EntityLink[]>([]);
    const [adding, setAdding] = React.useState(false);
    const [targetType, setTargetType] = React.useState<LinkType>("device");
    const [q, setQ] = React.useState("");
    const [targets, setTargets] = React.useState<Array<{ id: string; label: string }>>([]);

    const load = React.useCallback(() => {
        itdocs.links(type, id).then((r) => setLinks(r.items)).catch(() => setLinks([]));
    }, [type, id]);
    React.useEffect(load, [load]);

    React.useEffect(() => {
        if (!adding) return;
        const timer = window.setTimeout(() => {
            itdocs.targets(targetType, q).then((r) => setTargets(r.items.filter((t) => !(targetType === type && t.id === id)))).catch(() => setTargets([]));
        }, 200);
        return () => window.clearTimeout(timer);
    }, [adding, targetType, q, type, id]);

    const add = async (toId: string) => {
        try {
            await itdocs.addLink({ fromType: type, fromId: id, toType: targetType, toId });
            setAdding(false);
            setQ("");
            load();
        } catch (e) {
            toast({ title: "Could not link that", description: errorText(e), variant: "destructive" });
        }
    };

    return (
        <section className={className} aria-label="Linked items">
            <div className="flex items-center justify-between gap-2">
                <h2 className="flex items-center gap-1.5 text-base font-semibold"><Link2 className="h-4 w-4" /> Linked</h2>
                <Button type="button" variant="ghost" size="sm" onClick={() => setAdding((v) => !v)}><Plus className="mr-1 h-4 w-4" /> Link</Button>
            </div>

            {links.length === 0 && !adding && <p className="text-xs text-muted-foreground">Nothing linked yet.</p>}
            <ul className="grid gap-1">
                {links.map((link) => (
                    <li key={link.linkId} className="flex items-center justify-between gap-2 text-sm">
                        <Link href={hrefFor(link)} className="min-w-0 truncate underline-offset-2 hover:underline">
                            <span className="text-muted-foreground">{TYPE_LABEL[link.type]}:</span> {link.label}
                        </Link>
                        <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6"
                            aria-label={`Unlink ${link.label}`}
                            onClick={() => itdocs.removeLink(link.linkId).then(load).catch((e) => toast({ title: "Could not unlink that", description: errorText(e), variant: "destructive" }))}
                        >
                            <X className="h-3.5 w-3.5" />
                        </Button>
                    </li>
                ))}
            </ul>

            {adding && (
                <div className="mt-2 grid gap-2 rounded-xl border border-border/70 bg-card p-2">
                    <div className="flex gap-2">
                        <FilterSelect label="Type to link" value={targetType} onChange={(v) => setTargetType(v as LinkType)} options={(Object.keys(TYPE_LABEL) as LinkType[]).map((t) => ({ value: t, label: TYPE_LABEL[t] }))} />
                        <SearchField value={q} onChange={setQ} className="min-w-0 flex-1 sm:w-auto" />
                    </div>
                    <ul className="grid max-h-40 gap-0.5 overflow-y-auto">
                        {targets.map((t) => (
                            <li key={t.id}>
                                <button type="button" className="w-full truncate rounded px-2 py-1 text-left text-sm hover:bg-muted" onClick={() => add(t.id)}>{t.label}</button>
                            </li>
                        ))}
                        {targets.length === 0 && <li className="px-2 py-1 text-xs text-muted-foreground">No matches.</li>}
                    </ul>
                </div>
            )}
        </section>
    );
}
