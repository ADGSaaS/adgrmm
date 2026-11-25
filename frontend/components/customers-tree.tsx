// components/customers-tree.tsx
"use client";

import * as React from "react";
import {
    Building2,
    ChevronRight,
    Layers,
    MapPin,
    PanelLeftClose,
    PanelLeftOpen,
    RefreshCw,
    Search,
    X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
    CUSTOMERS_CHANGED_EVENT,
    fetchCustomers,
    fetchCustomerSites,
} from "@/lib/api";

/** A customer, or one site of a customer. */
export type TreeSelection = { org: string; site?: string };

/** Device counts for one customer and its sites, as the server counts them (see fetchDeviceCounts). */
export type TreeClient = { name: string | null; total: number; offline: number; sites: { name: string | null; total: number; offline: number }[] };

type TreeSite = { name: string; count: number; offline: number };
type TreeOrg = { name: string; count: number; offline: number; sites: TreeSite[] };

/** The tree's counts from the server's device counts. */
export function treeClientsOf(counts: { clients: Array<{ name: string | null; total: number; offline: number; sites: Array<{ name: string | null; total: number; offline: number }> }> } | null | undefined): TreeClient[] {
    return (counts?.clients ?? []).map((c) => ({ name: c.name, total: c.total, offline: c.offline, sites: c.sites.map((s) => ({ name: s.name, total: s.total, offline: s.offline })) }));
}

const EXPANDED_KEY = "riq.customers.expanded";
const COLLAPSED_KEY = "riq.customers.collapsed";

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base" });
const clean = (value: unknown) => String(value ?? "").trim();

export const sameSelection = (a: TreeSelection, b: TreeSelection) =>
    a.org === b.org && (a.site ?? "") === (b.site ?? "");

/**
 * Customers and sites from the API, so ones without devices still appear, with the server's device
 * counts. Names are the key, because that is what devices carry.
 */
function useCustomerTree(counted: TreeClient[]) {
    const [apiOrgs, setApiOrgs] = React.useState<Record<string, string[]>>({});
    const [loading, setLoading] = React.useState(true);
    const [failed, setFailed] = React.useState(false);

    const load = React.useCallback(async () => {
        setLoading(true);
        setFailed(false);
        try {
            const clients = await fetchCustomers();
            const entries = await Promise.all(
                (clients ?? []).map(async (client) => {
                    const sites = await fetchCustomerSites(client.id).catch(() => []);
                    return [clean(client.name), (sites ?? []).map((s) => clean(s.name)).filter(Boolean)] as const;
                })
            );
            setApiOrgs(Object.fromEntries(entries.filter(([name]) => name)));
        } catch {
            setFailed(true);
        } finally {
            setLoading(false);
        }
    }, []);

    React.useEffect(() => {
        void load();
        const onChanged = () => void load();
        window.addEventListener(CUSTOMERS_CHANGED_EVENT, onChanged);
        return () => window.removeEventListener(CUSTOMERS_CHANGED_EVENT, onChanged);
    }, [load]);

    const orgs = React.useMemo<TreeOrg[]>(() => {
        const map = new Map<string, Map<string, TreeSite>>();
        const totals = new Map<string, { count: number; offline: number }>();
        const siteMapFor = (org: string) => {
            if (!map.has(org)) map.set(org, new Map());
            if (!totals.has(org)) totals.set(org, { count: 0, offline: 0 });
            return map.get(org)!;
        };

        for (const [org, sites] of Object.entries(apiOrgs)) {
            const siteMap = siteMapFor(org);
            for (const site of sites) siteMap.set(site, { name: site, count: 0, offline: 0 });
        }

        for (const c of counted) {
            // Devices with no customer show as an em dash, like they do in the device list.
            const org = clean(c.name) || "—";
            const siteMap = siteMapFor(org);
            const total = totals.get(org)!;
            total.count += c.total;
            total.offline += c.offline;
            for (const s of c.sites) {
                const siteName = clean(s.name) || "—";
                const site = siteMap.get(siteName) ?? { name: siteName, count: 0, offline: 0 };
                site.count += s.total;
                site.offline += s.offline;
                siteMap.set(siteName, site);
            }
        }

        return Array.from(map.entries())
            .map(([name, sites]) => ({
                name,
                ...totals.get(name)!,
                sites: Array.from(sites.values()).sort((a, b) => byName(a.name, b.name)),
            }))
            .sort((a, b) => byName(a.name, b.name));
    }, [apiOrgs, counted]);

    return { orgs, loading, failed, reload: load };
}

function readStored<T>(key: string, fallback: T): T {
    try {
        const raw = localStorage.getItem(key);
        return raw ? (JSON.parse(raw) as T) : fallback;
    } catch {
        return fallback;
    }
}

function store(key: string, value: unknown) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch {
        // Only remembering it between visits depends on this.
    }
}

function Count({ count, offline }: { count: number; offline: number }) {
    return (
        <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2">
            {offline > 0 ? (
                <span
                    className="h-1.5 w-1.5 rounded-full bg-amber-500"
                    title={`${offline} offline`}
                    aria-label={`${offline} offline`}
                />
            ) : null}
            <span className="min-w-4 text-right text-xs tabular-nums text-muted-foreground">{count}</span>
        </span>
    );
}

type RowProps = {
    level: 1 | 2 | 3;
    label: string;
    icon: React.ElementType;
    selected: boolean;
    /** Something inside this row is selected, which matters when the row is collapsed. */
    containsSelection?: boolean;
    count: number;
    offline: number;
    expanded?: boolean;
    orgKey?: string;
    onSelect: (additive: boolean) => void;
    onToggle?: () => void;
};

function Row({ level, label, icon: Icon, selected, containsSelection, count, offline, expanded, orgKey, onSelect, onToggle }: RowProps) {
    const expandable = !!onToggle;
    return (
        <div
            className={cn(
                "group relative flex min-h-9 items-center rounded-md lg:min-h-8",
                selected ? "bg-primary/15 text-foreground" : "hover:bg-accent/60"
            )}
        >
            {selected ? <span className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-primary" aria-hidden="true" /> : null}

            {level > 1 ? (
                expandable ? (
                    <button
                        type="button"
                        tabIndex={-1}
                        onClick={onToggle}
                        aria-label={`${expanded ? "Collapse" : "Expand"} ${label}`}
                        className="ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                    >
                        <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", expanded && "rotate-90")} aria-hidden="true" />
                    </button>
                ) : (
                    <span className={cn("shrink-0", level === 3 ? "ml-7 w-0" : "ml-1 w-6")} aria-hidden="true" />
                )
            ) : null}

            <button
                type="button"
                role="treeitem"
                data-tree-row=""
                data-org={orgKey}
                aria-level={level}
                aria-selected={selected}
                aria-expanded={expandable ? !!expanded : undefined}
                title={label}
                onClick={(e) => onSelect(e.ctrlKey || e.metaKey)}
                className={cn(
                    "flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-md pr-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring lg:min-h-8",
                    level === 1 ? "pl-2" : "pl-1",
                    selected && "font-medium"
                )}
            >
                <Icon className={cn("h-4 w-4 shrink-0", selected || containsSelection ? "text-primary" : "text-muted-foreground")} aria-hidden="true" />
                <span className="truncate">{label}</span>
                <Count count={count} offline={offline} />
            </button>
        </div>
    );
}

export type CustomersTreeProps = {
    /** The server's counts per customer and site (empty until they arrive). */
    counted: TreeClient[];
    selection: TreeSelection[];
    /** Null means every customer. Additive means Ctrl or Cmd was held, so it adds to the selection. */
    onSelect: (item: TreeSelection | null, additive: boolean) => void;
    /** Fills its container, such as a drawer, instead of being a collapsible rail. */
    embedded?: boolean;
};

export default function CustomersTree({ counted, selection, onSelect, embedded = false }: CustomersTreeProps) {
    const { orgs, loading, failed, reload } = useCustomerTree(counted);

    const [query, setQuery] = React.useState("");
    const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
    const [collapsed, setCollapsed] = React.useState(false);

    React.useEffect(() => {
        setExpanded(new Set(readStored<string[]>(EXPANDED_KEY, [])));
        setCollapsed(readStored<boolean>(COLLAPSED_KEY, false));
    }, []);

    const setExpandedAndStore = React.useCallback((update: (prev: Set<string>) => Set<string>) => {
        setExpanded((prev) => {
            const next = update(prev);
            store(EXPANDED_KEY, Array.from(next));
            return next;
        });
    }, []);

    const toggle = (org: string, open?: boolean) =>
        setExpandedAndStore((prev) => {
            const next = new Set(prev);
            if (open ?? !next.has(org)) next.add(org);
            else next.delete(org);
            return next;
        });

    // What is selected should be visible, whether it was clicked, searched for or came from a link.
    React.useEffect(() => {
        const orgNames = selection.map((s) => s.org);
        if (!orgNames.length) return;
        setExpanded((prev) => (orgNames.every((o) => prev.has(o)) ? prev : new Set([...prev, ...orgNames])));
    }, [selection]);

    const setCollapsedAndStore = (value: boolean) => {
        setCollapsed(value);
        store(COLLAPSED_KEY, value);
    };

    const needle = query.trim().toLowerCase();
    const visible = React.useMemo(() => {
        if (!needle) return orgs;
        return orgs.flatMap((org) => {
            if (org.name.toLowerCase().includes(needle)) return [org];
            const sites = org.sites.filter((s) => s.name.toLowerCase().includes(needle));
            return sites.length ? [{ ...org, sites }] : [];
        });
    }, [needle, orgs]);

    const treeRef = React.useRef<HTMLDivElement>(null);
    const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        const rows = Array.from(treeRef.current?.querySelectorAll<HTMLElement>("[data-tree-row]") ?? []);
        const current = document.activeElement as HTMLElement;
        const index = rows.indexOf(current);
        if (index < 0) return;

        const move = (to: number) => {
            e.preventDefault();
            rows[Math.max(0, Math.min(rows.length - 1, to))]?.focus();
        };

        if (e.key === "ArrowDown") move(index + 1);
        else if (e.key === "ArrowUp") move(index - 1);
        else if (e.key === "Home") move(0);
        else if (e.key === "End") move(rows.length - 1);
        else if (e.key === "ArrowRight" && current.dataset.org) {
            e.preventDefault();
            toggle(current.dataset.org, true);
        } else if (e.key === "ArrowLeft" && current.dataset.org) {
            e.preventDefault();
            toggle(current.dataset.org, false);
        }
    };

    const total = counted.reduce((n, c) => n + c.total, 0);
    const totalOffline = counted.reduce((n, c) => n + c.offline, 0);
    const isSelected = (item: TreeSelection) => selection.some((s) => sameSelection(s, item));

    if (collapsed && !embedded) {
        return (
            <div className="flex h-full w-12 flex-col items-center gap-1 border-r bg-background py-2">
                <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    aria-label="Show customers"
                    title="Show customers"
                    onClick={() => setCollapsedAndStore(false)}
                >
                    <PanelLeftOpen className="h-4 w-4" aria-hidden="true" />
                </Button>
                {selection.length > 0 ? (
                    <span
                        className="mt-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium text-primary-foreground"
                        title={`${selection.length} selected`}
                    >
                        {selection.length}
                    </span>
                ) : null}
            </div>
        );
    }

    return (
        <div className={cn("flex h-full flex-col bg-background", embedded ? "w-full" : "w-72 border-r")}>
            <div className="space-y-2 p-2">
                {embedded ? null : (
                    <div className="flex items-center justify-between pl-2">
                        <span className="text-sm font-semibold">Customers</span>
                        <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-muted-foreground"
                            aria-label="Hide customers"
                            title="Hide customers"
                            onClick={() => setCollapsedAndStore(true)}
                        >
                            <PanelLeftClose className="h-4 w-4" aria-hidden="true" />
                        </Button>
                    </div>
                )}

                <div className="relative">
                    <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                    <Input
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Escape") setQuery("");
                        }}
                        placeholder="Find a customer or site"
                        aria-label="Find a customer or site"
                        className="h-9 pl-8 pr-8 text-sm"
                    />
                    {query ? (
                        <button
                            type="button"
                            onClick={() => setQuery("")}
                            aria-label="Clear search"
                            className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:text-foreground"
                        >
                            <X className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                    ) : null}
                </div>
            </div>

            <div
                ref={treeRef}
                role="tree"
                aria-label="Customers and sites"
                aria-multiselectable="true"
                onKeyDown={onKeyDown}
                className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-3"
            >
                {needle ? null : (
                    <Row
                        level={1}
                        label="All customers"
                        icon={Layers}
                        selected={selection.length === 0}
                        count={total}
                        offline={totalOffline}
                        onSelect={() => onSelect(null, false)}
                    />
                )}

                {failed ? (
                    <div className="px-2 py-3 text-xs text-muted-foreground">
                        Could not load customers.
                        <Button variant="outline" size="sm" className="mt-2 h-7 gap-1.5 text-xs" onClick={() => void reload()}>
                            <RefreshCw className="h-3 w-3" aria-hidden="true" />
                            Try again
                        </Button>
                    </div>
                ) : null}

                {loading && orgs.length === 0 ? (
                    <div className="space-y-1.5 px-2 py-2" aria-label="Loading customers">
                        {[0, 1, 2, 3].map((i) => (
                            <div key={i} className="h-5 animate-pulse rounded bg-muted" />
                        ))}
                    </div>
                ) : null}

                {!loading && !failed && orgs.length === 0 ? (
                    <div className="px-2 py-3 text-xs text-muted-foreground">No customers yet.</div>
                ) : null}

                {needle && visible.length === 0 && orgs.length > 0 ? (
                    <div className="px-2 py-3 text-xs text-muted-foreground">Nothing matches “{query.trim()}”.</div>
                ) : null}

                {visible.map((org) => {
                    const hasSites = org.sites.length > 0;
                    const isOpen = hasSites && (expanded.has(org.name) || !!needle);
                    return (
                        <div key={org.name} role="none" className="space-y-0.5">
                            <Row
                                level={2}
                                label={org.name}
                                icon={Building2}
                                selected={isSelected({ org: org.name })}
                                containsSelection={selection.some((s) => s.org === org.name && !!s.site)}
                                count={org.count}
                                offline={org.offline}
                                expanded={isOpen}
                                orgKey={hasSites ? org.name : undefined}
                                onSelect={(additive) => {
                                    // Its sites are usually the next thing wanted. Closing it again stays a choice.
                                    if (hasSites) toggle(org.name, true);
                                    onSelect({ org: org.name }, additive);
                                }}
                                onToggle={hasSites ? () => toggle(org.name) : undefined}
                            />
                            {isOpen ? (
                                <div role="group" className="ml-[1.0625rem] space-y-0.5 border-l border-border/70">
                                    {org.sites.map((site) => (
                                        <Row
                                            key={site.name}
                                            level={3}
                                            label={site.name}
                                            icon={MapPin}
                                            selected={isSelected({ org: org.name, site: site.name })}
                                            count={site.count}
                                            offline={site.offline}
                                            onSelect={(additive) => onSelect({ org: org.name, site: site.name }, additive)}
                                        />
                                    ))}
                                </div>
                            ) : null}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
