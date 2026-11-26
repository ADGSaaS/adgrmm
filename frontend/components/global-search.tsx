// components/global-search.tsx
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
    AlertTriangle, Building2, Layers, MapPin, Monitor, Search, ShieldCheck, Tag, Ticket, UserRound, Users, X, BarChart3, LayoutDashboard,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { jfetch } from "@/lib/api";
import { useMe } from "@/lib/use-me";
import { matchPages } from "@/components/search-index";

type Item = { id: string; title: string; detail?: string; badge?: string; href: string };
type Group = { key: string; label: string; items: Item[] };
type Row = Item & { key: string; group: string; groupKey: string };

const ICONS: Record<string, React.ComponentType<React.SVGProps<SVGSVGElement>>> = {
    devices: Monitor,
    customers: Building2,
    sites: MapPin,
    tickets: Ticket,
    alerts: AlertTriangle,
    people: UserRound,
    groups: Users,
    policies: ShieldCheck,
    tags: Tag,
    reports: BarChart3,
    pages: LayoutDashboard,
};

/** What is searched, shown under the box and when it is empty. */
const SCOPE_HINT = "Search devices, customers, tickets, alerts, people, policies and settings";

/** The server search, one request per pause in typing, with the previous request cancelled. */
function useServerSearch(query: string) {
    const [groups, setGroups] = React.useState<Group[]>([]);
    const [loading, setLoading] = React.useState(false);
    const [failed, setFailed] = React.useState(false);

    React.useEffect(() => {
        const text = query.trim();
        if (text.length < 2) {
            setGroups([]);
            setLoading(false);
            setFailed(false);
            return;
        }
        setLoading(true);
        const ac = new AbortController();
        const timer = window.setTimeout(() => {
            jfetch<{ groups: Group[] }>(`/api/search?q=${encodeURIComponent(text)}`, { signal: ac.signal } as any)
                .then((r) => {
                    if (ac.signal.aborted) return;
                    setGroups(r.groups ?? []);
                    setFailed(false);
                })
                .catch((e) => {
                    if (ac.signal.aborted || e?.name === "AbortError") return;
                    setGroups([]);
                    setFailed(true);
                })
                .finally(() => {
                    if (!ac.signal.aborted) setLoading(false);
                });
        }, 200);
        return () => {
            window.clearTimeout(timer);
            ac.abort();
        };
    }, [query]);

    return { groups, loading, failed };
}

function useRows(query: string) {
    const { permissions } = useMe();
    const { groups, loading, failed } = useServerSearch(query);
    const rows = React.useMemo<Row[]>(() => {
        const mine = new Set((Array.isArray(permissions) ? permissions : []).map((p: string) => String(p).toLowerCase()));
        const can = (perm: string) => mine.has(perm.toLowerCase());
        const out: Row[] = [];
        for (const g of groups) for (const i of g.items) out.push({ ...i, key: `${g.key}:${i.id}`, group: g.label, groupKey: g.key });
        for (const p of matchPages(query, can)) out.push({ id: p.href, title: p.title, detail: p.detail, href: p.href, key: `pages:${p.href}`, group: "Pages and settings", groupKey: "pages" });
        return out;
    }, [groups, permissions, query]);
    return { rows, loading, failed };
}

function ResultsList({
    rows,
    active,
    query,
    loading,
    failed,
    onHover,
    onChoose,
}: {
    rows: Row[];
    active: number;
    query: string;
    loading: boolean;
    failed: boolean;
    onHover: (index: number) => void;
    onChoose: (row: Row) => void;
}) {
    const text = query.trim();
    if (text.length < 2) {
        return <div className="px-3 py-4 text-sm text-muted-foreground">{SCOPE_HINT}.</div>;
    }
    if (rows.length === 0) {
        return (
            <div className="px-3 py-4 text-sm text-muted-foreground">
                {loading ? "Searching…" : failed ? "Search is not available right now. Try again in a moment." : `Nothing matches “${text}”.`}
            </div>
        );
    }

    return (
        <ul id="global-search-results" role="listbox" aria-label="Search results" className="max-h-[70vh] overflow-y-auto p-1">
            {rows.map((row, index) => {
                const Icon = ICONS[row.groupKey] ?? Layers;
                const firstOfGroup = index === 0 || rows[index - 1].groupKey !== row.groupKey;
                return (
                    <React.Fragment key={row.key}>
                        {firstOfGroup ? (
                            <li role="presentation" className="px-2 pb-1 pt-2 text-xs font-medium text-muted-foreground">
                                {row.group}
                            </li>
                        ) : null}
                        <li role="option" aria-selected={index === active}>
                            {/* Before the input loses focus, or the list closes before the click lands. */}
                            <button
                                type="button"
                                onMouseEnter={() => onHover(index)}
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={() => onChoose(row)}
                                className={cn(
                                    "flex min-h-10 w-full items-center gap-2.5 rounded-lg px-2 text-left text-sm",
                                    index === active && "bg-accent text-accent-foreground"
                                )}
                            >
                                <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                                <span className="min-w-0 truncate">{row.title}</span>
                                {row.detail ? (
                                    <span className="ml-auto min-w-0 shrink truncate pl-3 text-xs text-muted-foreground">{row.detail}</span>
                                ) : null}
                                {row.badge ? (
                                    <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] capitalize text-muted-foreground">{row.badge}</span>
                                ) : null}
                            </button>
                        </li>
                    </React.Fragment>
                );
            })}
            {loading ? <li role="presentation" className="px-3 py-2 text-xs text-muted-foreground">Searching…</li> : null}
        </ul>
    );
}

/** Searches everything from anywhere: records, pages and settings. Ctrl+K or Cmd+K jumps to it. */
export default function GlobalSearch() {
    const router = useRouter();
    const [query, setQuery] = React.useState("");
    const [open, setOpen] = React.useState(false);
    const [dialogOpen, setDialogOpen] = React.useState(false);
    const [active, setActive] = React.useState(0);
    const inputRef = React.useRef<HTMLInputElement>(null);
    const { rows, loading, failed } = useRows(query);

    React.useEffect(() => setActive(0), [query]);

    React.useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
                e.preventDefault();
                if (inputRef.current?.offsetParent) inputRef.current.focus();
                else setDialogOpen(true);
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);

    const choose = (row: Row) => {
        setOpen(false);
        setDialogOpen(false);
        setQuery("");
        inputRef.current?.blur();
        router.push(row.href);
    };

    const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((i) => Math.min(i + 1, rows.length - 1));
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((i) => Math.max(i - 1, 0));
        } else if (e.key === "Enter" && rows[active]) {
            e.preventDefault();
            choose(rows[active]);
        } else if (e.key === "Escape") {
            if (query) setQuery("");
            else inputRef.current?.blur();
        }
    };

    return (
        <>
            {/* Wide screens: in the bar */}
            <div className="relative hidden w-full max-w-lg md:block">
                <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden="true" />
                <input
                    ref={inputRef}
                    type="search"
                    name="adg-global-search"
                    autoComplete="off"
                    data-lpignore="true"
                    data-1p-ignore="true"
                    value={query}
                    role="combobox"
                    aria-expanded={open}
                    aria-controls="global-search-results"
                    aria-label="Search everything"
                    placeholder="Search everything"
                    onChange={(e) => {
                        setQuery(e.target.value);
                        setOpen(true);
                    }}
                    onFocus={() => setOpen(true)}
                    onBlur={() => setOpen(false)}
                    onKeyDown={onKeyDown}
                    className="h-9 w-full rounded-lg border border-input bg-muted/40 pl-9 pr-8 text-sm outline-none xl:pr-16 placeholder:text-muted-foreground focus:border-ring focus:bg-background focus:ring-1 focus:ring-ring [&::-webkit-search-cancel-button]:hidden"
                />
                {query ? (
                    <button
                        type="button"
                        aria-label="Clear search"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => setQuery("")}
                        className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:text-foreground"
                    >
                        <X className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                ) : (
                    <kbd className="pointer-events-none absolute right-2 top-2 hidden h-5 items-center whitespace-nowrap rounded border bg-background px-1.5 text-[10px] text-muted-foreground xl:flex">
                        Ctrl K
                    </kbd>
                )}
                {open ? (
                    <div className="absolute inset-x-0 top-11 z-50 overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-xl">
                        <ResultsList rows={rows} active={active} query={query} loading={loading} failed={failed} onHover={setActive} onChoose={choose} />
                    </div>
                ) : null}
            </div>

            {/* Small screens: a button that opens it full width */}
            <Button
                variant="ghost"
                size="icon"
                className="md:hidden"
                aria-label="Search"
                title="Search"
                onClick={() => setDialogOpen(true)}
            >
                <Search className="h-5 w-5" aria-hidden="true" />
            </Button>
            <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
                <DialogContent className="top-4 max-w-[calc(100vw-2rem)] translate-y-0 gap-0 overflow-hidden p-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 sm:top-16">
                    <DialogTitle className="sr-only">Search</DialogTitle>
                    <DialogDescription className="sr-only">{SCOPE_HINT}</DialogDescription>
                    <div className="relative border-b">
                        <Search className="pointer-events-none absolute left-3 top-3.5 h-4 w-4 text-muted-foreground" aria-hidden="true" />
                        <input
                            type="search"
                            name="adg-global-search"
                            autoComplete="off"
                            data-lpignore="true"
                            data-1p-ignore="true"
                            autoFocus
                            value={query}
                            aria-label="Search everything"
                            placeholder="Search everything"
                            onChange={(e) => setQuery(e.target.value)}
                            onKeyDown={onKeyDown}
                            className="h-11 w-full bg-transparent pl-9 pr-10 text-base outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden"
                        />
                    </div>
                    <ResultsList rows={rows} active={active} query={query} loading={loading} failed={failed} onHover={setActive} onChoose={choose} />
                </DialogContent>
            </Dialog>
        </>
    );
}
