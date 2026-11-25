"use client";

import * as React from "react";
import { TicketTimeCard } from "@/components/tickets/ticket-time-card";
import { InsertArticleButton, TicketKbCard } from "@/components/kb/ticket-kb";
import { ServiceDeskCard } from "@/components/tickets/service-desk-card";
import { TicketVisitsCard } from "@/components/schedule/ticket-visits";
import { TicketSurveyCard } from "@/components/surveys/ticket-survey-cards";
import { useTicketTimer, type TicketTimer } from "@/lib/use-ticket-timer";
import { clock, formatMinutes, parseDuration } from "@/lib/duration";
import { useMe } from "@/lib/use-me";
import { hasPerm } from "@/lib/permissions";
import LinksPanel from "@/components/itdocs/links-panel";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { StatusPill, PriorityPill } from "@/components/pills";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { TicketCustomFieldsCard } from "@/components/tickets/ticket-custom-fields";
import { TicketDevicesCard } from "@/components/tickets/ticket-devices-card";
import { RequesterRow, type RequesterContact } from "@/components/tickets/requester-row";

/* -------------------------------- Types -------------------------------- */

type Ticket = {
    id: string;

    ticketNumber?: number | null;
    number?: string | null;

    title: string;
    description?: string | null;

    status: "open" | "resolved" | "closed" | "in_progress" | string;
    priority?: "low" | "normal" | "medium" | "high" | "urgent" | string | null;

    requesterName?: string | null;
    requesterEmail?: string | null;
    /** The customer's own contact who asked (from the customer record). */
    requesterCustomerContactId?: string | null;
    requesterContact?: RequesterContact | null;
    /** The recurring schedule that opened this ticket. */
    recurringId?: string | null;

    assignedTo?: string | null;
    assigneeUserId?: string | null;

    customerId?: string | null;
    /** The customer (client) the ticket is for. */
    clientId?: string | null;
    /** The customer has replied since this person last opened the ticket. */
    hasNewReply?: boolean;
    lastCustomerReplyAt?: string | null;
    client?: string | null;
    site?: string | null;
    deviceId?: string | null;

    createdAt?: string | null;
    updatedAt?: string | null;
    dueAt?: string | null;
    collaborators?: string[] | null;
    /** What people saved in the ticket custom fields, by field key. */
    customFields?: Record<string, unknown>;
};

type Attachment = { id: string; name: string; size?: number; url: string };

type ActivityMessageOrNote = {
    id: string;
    kind: "message" | "note";
    author: string;
    body: string;
    createdAt: string;
    isInternal?: boolean;
    // some backends send snake_case
    is_internal?: boolean;
    /** A private note left for the next technician: where the ticket was left. */
    isHandoff?: boolean;
    /** The customer wrote this and it arrived by email or the portal. */
    isInbound?: boolean;
    /** For a customer reply: where it came from. */
    via?: "portal" | "email";
    /** Time logged with this reply or note, in seconds. */
    timeWorkedSeconds?: number;
    attachments?: Attachment[];
};

type ActivityChange = {
    id: string;
    kind: "change";
    createdAt: string;
    actor: string;
    field: "status" | "priority" | "assignee" | "title" | "dueAt" | "collaborators";
    from?: string | null;
    to?: string | null;
};

type ActivityItem = ActivityMessageOrNote | ActivityChange;

type CannedResponse = { id: string; title: string; body: string };
type LinkedTicket = { id: string; number?: string | null; title: string; status: string };
type HistoryItem = { at: string; who: string; what: string };

type SearchTicket = {
    id: string;
    title: string;
    status: string;
    ticketNumber?: number | null;
    number?: string | null;
};

/* ----------------------------- Helpers --------------------------------- */

const API = process.env.NEXT_PUBLIC_API_BASE || "";

const shortId = (s: string) => String(s || "").slice(0, 8);
const fmtWhen = (iso?: string | null) => (iso ? new Date(iso).toLocaleString() : "-");

function getDisplayTicketNumber(t: Ticket): string {
    const tn = (t as any)?.ticketNumber;
    if (typeof tn === "number" && Number.isFinite(tn)) return String(tn);
    const n = t.number;
    if (typeof n === "string" && n.trim()) return n.trim();
    return shortId(t.id);
}

function SectionCard(props: React.HTMLAttributes<HTMLDivElement>) {
    return (
        <div
            {...props}
            className={cn("rounded-xl border border-border/70 bg-card p-5 shadow-[0_1px_2px_rgba(0,0,0,0.06),0_8px_24px_-12px_rgba(0,0,0,0.25)] backdrop-blur-sm", props.className)}
        />
    );
}

function safeText(v: unknown) {
    return typeof v === "string" ? v : "";
}

async function safeReadErrorMessage(res: Response): Promise<string> {
    try {
        const ct = res.headers.get("content-type") || "";
        if (ct.includes("application/json")) {
            const j = await res.json();
            return String(j?.message ?? j?.error ?? "").trim();
        }
        const t = await res.text();
        return String(t ?? "").trim();
    } catch {
        return "";
    }
}

function getIsInternal(a: any): boolean {
    return !!(a?.isInternal ?? a?.is_internal ?? a?.internal);
}

/* ----------------------------- Data hooks ------------------------------ */

function useTicket(id: string) {
    const [ticket, setTicket] = React.useState<Ticket | null>(null);
    const [loading, setLoading] = React.useState(true);
    const [refreshing, setRefreshing] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);

    const ticketRef = React.useRef<Ticket | null>(null);
    React.useEffect(() => {
        ticketRef.current = ticket;
    }, [ticket]);

    const fetchTicket = React.useCallback(
        async (opts?: { silent?: boolean }) => {
            const silent = !!opts?.silent;
            const isInitial = ticketRef.current == null;

            try {
                if (isInitial) setLoading(true);
                else if (!silent) setRefreshing(true);

                setError(null);

                const res = await fetch(`${API}/api/tickets/${id}`, { credentials: "include", cache: "no-store" });
                if (!res.ok) throw new Error(`Failed to load ticket (${res.status})`);
                const data: Ticket = await res.json();
                setTicket(data);
            } catch (e: any) {
                setError(e?.message ?? String(e));
            } finally {
                if (isInitial) setLoading(false);
                setRefreshing(false);
            }
        },
        [id]
    );

    React.useEffect(() => {
        fetchTicket();
    }, [fetchTicket]);

    return { ticket, setTicket, loading, refreshing, error, refetch: fetchTicket };
}

function useTicketExtras(id: string) {
    const [activity, setActivity] = React.useState<ActivityItem[]>([]);
    const [canned, setCanned] = React.useState<CannedResponse[]>([]);
    const [linked, setLinked] = React.useState<LinkedTicket[]>([]);
    const [history, setHistory] = React.useState<HistoryItem[]>([]);
    const [loading, setLoading] = React.useState(true);
    const [refreshing, setRefreshing] = React.useState(false);

    const hasLoadedRef = React.useRef(false);
    const seqRef = React.useRef(0);
    const abortRef = React.useRef<AbortController | null>(null);

    const fetchExtras = React.useCallback(
        async (opts?: { silent?: boolean }) => {
            const silent = !!opts?.silent;
            const isInitial = !hasLoadedRef.current;

            abortRef.current?.abort();
            const ac = new AbortController();
            abortRef.current = ac;

            const mySeq = ++seqRef.current;

            try {
                if (isInitial) setLoading(true);
                else if (!silent) setRefreshing(true);

                const [a, n, c, l, h] = await Promise.all([
                    fetch(`${API}/api/tickets/${id}/activity`, { credentials: "include", cache: "no-store", signal: ac.signal }),
                    fetch(`${API}/api/tickets/${id}/notes`, { credentials: "include", cache: "no-store", signal: ac.signal }),
                    fetch(`${API}/api/tickets/canned-responses`, { credentials: "include", cache: "no-store", signal: ac.signal }),
                    fetch(`${API}/api/tickets/${id}/linked`, { credentials: "include", cache: "no-store", signal: ac.signal }),
                    fetch(`${API}/api/tickets/${id}/history`, { credentials: "include", cache: "no-store", signal: ac.signal }),
                ]);

                if (ac.signal.aborted) return;
                if (mySeq !== seqRef.current) return;

                const combined: ActivityItem[] = [];

                if (a.ok) {
                    try {
                        combined.push(...((await a.json()) as ActivityItem[]));
                    } catch {
                        // ignore
                    }
                }

                if (n.ok) {
                    try {
                        combined.push(...((await n.json()) as ActivityItem[]));
                    } catch {
                        // ignore
                    }
                }

                if (combined.length > 0) {
                    const map = new Map<string, ActivityItem>();
                    for (const item of combined) map.set((item as any)?.id, item);
                    setActivity(Array.from(map.values()));
                }

                if (c.ok) setCanned((await c.json()) as CannedResponse[]);
                if (l.ok) setLinked((await l.json()) as LinkedTicket[]);
                if (h.ok) setHistory((await h.json()) as HistoryItem[]);

                hasLoadedRef.current = true;
            } catch (e: any) {
                if (e?.name === "AbortError") return;
            } finally {
                if (isInitial) setLoading(false);
                setRefreshing(false);
            }
        },
        [id]
    );

    React.useEffect(() => {
        fetchExtras();
        return () => abortRef.current?.abort();
    }, [fetchExtras]);

    return { activity, canned, linked, history, loading, refreshing, refetch: fetchExtras };
}

/* ------------------------ Options (dropdown data) ---------------------- */

type Option = { value: string; label: string };

function useOptions(candidates: string[], mapper: (item: any) => Option | null) {
    const [options, setOptions] = React.useState<Option[]>([]);
    const [loading, setLoading] = React.useState(true);

    React.useEffect(() => {
        let cancelled = false;
        (async () => {
            setLoading(true);
            try {
                for (const path of candidates) {
                    try {
                        const res = await fetch(`${API}${path}`, { credentials: "include" });
                        if (!res.ok) continue;
                        const data = await res.json();
                        const arr: any[] = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];
                        const mapped = arr
                            .map(mapper)
                            .filter((x): x is Option => !!x)
                            .filter((x, i, a) => a.findIndex((y) => y.value === x.value) === i);
                        if (!cancelled) setOptions(mapped);
                        break;
                    } catch {
                        // try next
                    }
                }
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [candidates.join("|")]);

    return { options, loading };
}

const userMapper = (u: any): Option | null => {
    const id = safeText(u?.id).trim();
    const label = safeText(u?.name || u?.fullName || u?.email || u?.username || id).trim();
    if (!id || !label) return null;
    return { value: id, label };
};

// Customers are chosen by id, so the ticket stays with the right customer even if it is renamed.
const clientMapper = (c: any): Option | null => {
    const label = safeText(c?.name || c?.title || c?.displayName || c?.company).trim();
    const id = safeText(c?.key || c?.id).trim();
    if (!label || !id) return null;
    return { value: id, label };
};

const siteMapper = (s: any): Option | null => {
    const label = safeText(s?.name || s?.title || s?.label || s?.id).trim();
    if (!label) return null;
    return { value: label, label };
};

const PRIORITY_OPTIONS: Option[] = [
    { value: "low", label: "Low" },
    { value: "medium", label: "Normal" },
    { value: "high", label: "High" },
    { value: "urgent", label: "Urgent" },
];

/* ------------------------ Inline editable SELECT ----------------------- */

function EditableSelectRow({
    label,
    value,
    placeholder,
    options,
    saving,
    onSave,
    displayValue,
}: {
    label: string;
    value?: string | null;
    placeholder: string;
    options: Option[];
    saving?: boolean;
    onSave: (v: string | null) => Promise<void> | void;
    displayValue?: string;
}) {
    const [editing, setEditing] = React.useState(false);
    const [draft, setDraft] = React.useState(value ?? "");
    const [pending, setPending] = React.useState(false);

    React.useEffect(() => {
        setDraft(value ?? "");
    }, [value]);

    const hasValue = !!(value && value.toString().trim());
    const labelForValue = displayValue ?? (hasValue ? options.find((o) => o.value === value)?.label ?? value : "");

    return (
        <div>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="mt-1">
                {!editing ? (
                    hasValue ? (
                        <button
                            className="font-medium text-foreground hover:underline underline-offset-2"
                            onClick={() => setEditing(true)}
                            title={`Edit ${label.toLowerCase()}`}
                        >
                            {labelForValue}
                        </button>
                    ) : (
                        <button
                            className="text-xs rounded-lg border border-input px-2 py-1 text-foreground/80 hover:bg-accent"
                            onClick={() => setEditing(true)}
                            title={`Set ${label.toLowerCase()}`}
                        >
                            + {placeholder}
                        </button>
                    )
                ) : (
                    <div className="flex items-center gap-2">
                        <select
                            className="h-8 w-full rounded-lg border border-input bg-card/60 px-2 text-sm text-foreground"
                            value={draft}
                            onChange={(e) => setDraft(e.currentTarget.value)}
                        >
                            <option value="">{placeholder}</option>
                            {options.map((opt) => (
                                <option key={opt.value} value={opt.value}>
                                    {opt.label}
                                </option>
                            ))}
                        </select>
                        <button
                            disabled={pending || saving}
                            className="inline-flex h-8 items-center rounded-lg border border-input px-2 text-xs text-foreground hover:bg-accent disabled:opacity-50"
                            onClick={async () => {
                                try {
                                    setPending(true);
                                    await onSave(draft.trim() ? draft : null);
                                    setEditing(false);
                                } finally {
                                    setPending(false);
                                }
                            }}
                        >
                            Save
                        </button>
                        <button
                            className="inline-flex h-8 items-center rounded-lg border border-input px-2 text-xs text-foreground hover:bg-accent"
                            onClick={() => {
                                setDraft(value ?? "");
                                setEditing(false);
                            }}
                        >
                            Cancel
                        </button>
                    </div>
                )}
            </dd>
        </div>
    );
}

/* ------------------------- Link Ticket Modal -------------------------- */

function TicketLinkModal({
    open,
    onOpenChange,
    currentTicketId,
    onLinked,
    btnBase,
    btnSecondary,
}: {
    open: boolean;
    onOpenChange: (v: boolean) => void;
    currentTicketId: string;
    onLinked: () => void;
    btnBase: string;
    btnSecondary: string;
}) {
    const [q, setQ] = React.useState("");
    const [busy, setBusy] = React.useState(false);
    const [results, setResults] = React.useState<SearchTicket[]>([]);
    const [err, setErr] = React.useState<string | null>(null);

    React.useEffect(() => {
        if (!open) {
            setQ("");
            setResults([]);
            setErr(null);
            setBusy(false);
        }
    }, [open]);

    React.useEffect(() => {
        if (!open) return;
        const needle = q.trim();
        if (!needle) {
            setResults([]);
            setErr(null);
            return;
        }

        let cancelled = false;
        const t = window.setTimeout(async () => {
            try {
                setBusy(true);
                setErr(null);

                const params = new URLSearchParams();
                params.set("search", needle);
                params.set("pageSize", "20");

                const res = await fetch(`${API}/api/tickets?${params.toString()}`, { credentials: "include" });
                if (!res.ok) throw new Error(`Search failed (${res.status})`);

                const raw = await res.json();
                const arr: any[] = Array.isArray(raw) ? raw : Array.isArray(raw?.items) ? raw.items : [];

                const mapped: SearchTicket[] = arr
                    .map((t: any) => ({
                        id: String(t?.id ?? ""),
                        title: String(t?.title ?? ""),
                        status: String(t?.status ?? ""),
                        ticketNumber: t?.ticketNumber !== undefined && t?.ticketNumber !== null ? Number(t.ticketNumber) : null,
                        number: t?.number ?? null,
                    }))
                    .filter((t) => t.id && t.title)
                    .filter((t) => t.id !== currentTicketId);

                if (!cancelled) setResults(mapped);
            } catch (e: any) {
                if (!cancelled) {
                    setErr(e?.message ?? String(e));
                    setResults([]);
                }
            } finally {
                if (!cancelled) setBusy(false);
            }
        }, 250);

        return () => {
            cancelled = true;
            clearTimeout(t);
        };
    }, [open, q, currentTicketId]);

    async function linkTicket(target: SearchTicket) {
        if (!target?.id) return;
        setBusy(true);
        setErr(null);
        try {
            const res = await fetch(`${API}/api/tickets/${currentTicketId}/linked`, {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ linkedId: target.id }),
            });

            if (!res.ok) {
                const msg = await safeReadErrorMessage(res);
                throw new Error(msg || `Link failed (${res.status})`);
            }

            onOpenChange(false);
            onLinked();
        } catch (e: any) {
            setErr(e?.message ?? String(e));
        } finally {
            setBusy(false);
        }
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-[680px]">
                <DialogHeader>
                    <DialogTitle>Link a ticket</DialogTitle>
                    <DialogDescription>
                        Type a ticket number, title, or the first 8 characters of a ticket UUID, then click the ticket to link it.
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-3">
                    <Input
                        value={q}
                        onChange={(e) => setQ(e.target.value)}
                        placeholder="Example: 1234  |  printer  |  d45157b8"
                        autoFocus
                    />

                    {err && (
                        <div className="rounded-md border border-red-700/40 bg-red-900/10 p-2 text-sm text-red-600 dark:text-red-300">{err}</div>
                    )}

                    <div className="max-h-[340px] overflow-auto rounded-md border border-border [scrollbar-gutter:stable]">
                        {busy && <div className="p-3 text-sm text-muted-foreground">Searching…</div>}

                        {!busy && q.trim() && results.length === 0 && <div className="p-3 text-sm text-muted-foreground">No matches.</div>}

                        {!busy && results.length > 0 && (
                            <ul className="divide-y divide-border">
                                {results.map((t) => {
                                    const displayNum =
                                        t.ticketNumber !== null && t.ticketNumber !== undefined ? String(t.ticketNumber) : t.number ?? shortId(t.id);

                                    return (
                                        <li key={t.id}>
                                            <button
                                                type="button"
                                                className={cn(
                                                    "w-full text-left p-3 hover:bg-accent/60 transition-colors",
                                                    "flex items-start justify-between gap-3"
                                                )}
                                                onClick={() => linkTicket(t)}
                                                disabled={busy}
                                                title="Click to link this ticket"
                                            >
                                                <div className="min-w-0">
                                                    <div className="text-sm text-foreground truncate">
                                                        <span className="font-semibold">#{displayNum}</span>{" "}
                                                        <span className="text-foreground/80">—</span>{" "}
                                                        <span>{t.title}</span>
                                                    </div>
                                                    <div className="mt-1 text-xs text-muted-foreground">
                                                        UUID: <span className="font-mono">{shortId(t.id)}</span>
                                                    </div>
                                                </div>
                                                <div className="shrink-0">
                                                    <StatusPill value={t.status} />
                                                </div>
                                            </button>
                                        </li>
                                    );
                                })}
                            </ul>
                        )}

                        {!q.trim() && <div className="p-3 text-sm text-muted-foreground">Start typing to search…</div>}
                    </div>
                </div>

                <DialogFooter>
                    <button type="button" className={cn(btnBase, btnSecondary, "h-9 px-3 text-sm")} onClick={() => onOpenChange(false)} disabled={busy}>
                        Close
                    </button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

/* -------------------------- Small presentational ------------------------- */

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="font-medium text-foreground">{children}</dd>
        </div>
    );
}

function SmallBtn(props: React.ButtonHTMLAttributes<HTMLButtonElement> & { className?: string }) {
    return (
        <button
            {...props}
            className={cn("inline-flex h-8 items-center rounded-md px-2 text-xs transition-colors", props.className)}
        />
    );
}

function ListPanel({
    title,
    count,
    badgeLabel,
    badgeClassName,
    items,
    emptyText,
    className,
}: {
    title: string;
    count: number;
    badgeLabel: string;
    badgeClassName: string;
    items: ActivityMessageOrNote[];
    emptyText: string;
    className?: string;
}) {
    return (
        <SectionCard className={cn("flex flex-col min-h-0 overflow-hidden", className)}>
            <div className="mb-3 flex items-center justify-between shrink-0">
                <h2 className="text-base font-semibold text-foreground">{title}</h2>
                <span className="text-xs text-muted-foreground">{count} item(s)</span>
            </div>

            <div className="flex-1 min-h-0 overflow-auto pr-2 [scrollbar-gutter:stable]">
                <ol className="space-y-4">
                    {items.map((a) => (
                        <ActivityCard key={a.id} a={a} />
                    ))}

                    {items.length === 0 && <li className="text-sm text-muted-foreground">{emptyText}</li>}
                </ol>
            </div>
        </SectionCard>
    );
}

function TicketHistoryPanel({ history, className }: { history: HistoryItem[]; className?: string }) {
    const sorted = React.useMemo(
        () => history.slice().sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()),
        [history]
    );

    return (
        <SectionCard className={cn("flex flex-col min-h-0 overflow-hidden", className)}>
            <h3 className="mb-3 text-base font-semibold text-foreground shrink-0">Ticket History</h3>
            <div className="flex-1 min-h-0 overflow-auto pr-2 [scrollbar-gutter:stable]">
                <ul className="space-y-2 text-sm">
                    {sorted.map((h, i) => (
                        <li key={`${h.at}-${i}`}>
                            <div className="text-muted-foreground">{fmtWhen(h.at)}</div>
                            <div className="text-foreground">
                                {h.what} — {h.who}
                            </div>
                        </li>
                    ))}
                    {sorted.length === 0 && <li className="text-muted-foreground">No history entries.</li>}
                </ul>
            </div>
        </SectionCard>
    );
}

/* ----------------------------- Conversation ---------------------------- */

type ConversationItem =
    | { t: "item"; at: string; a: ActivityMessageOrNote; original?: boolean }
    | { t: "change"; at: string; who: string; what: string };

/** One reply, private note, handoff or the original request. What it is, is clear at a glance. */
function ActivityCard({ a, original }: { a: ActivityMessageOrNote; original?: boolean }) {
    const isNote = !original && (a.kind === "note" || getIsInternal(a));
    const isHandoff = isNote && a.isHandoff === true;
    const isInbound = !original && !isNote && a.isInbound === true;
    return (
        <li
            className={cn(
                "text-sm rounded-lg border p-3",
                original ? "border-border/60 border-l-4 border-l-slate-400/70 bg-card/40"
                    : isHandoff ? "border-orange-500/60 border-l-4 bg-orange-500/15"
                        : isNote ? "border-amber-500/40 border-l-4 bg-amber-500/10"
                            : isInbound ? "border-border/60 border-l-4 border-l-emerald-500/70 bg-card/40"
                                : "border-border/60 border-l-4 border-l-blue-500/70 bg-card/40"
            )}
        >
            <div className="flex items-start gap-3">
                <span className={cn("inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium",
                    original ? "bg-muted text-muted-foreground"
                        : isNote ? "bg-amber-500/20 text-amber-700 dark:text-amber-200"
                            : isInbound ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" : "bg-blue-500/15 text-blue-700 dark:text-blue-300")}>
                    {original ? "Original request" : isNote ? "Private note" : isInbound ? (a.via === "portal" ? "Customer reply (portal)" : "Customer reply (email)") : "Reply"}
                </span>
                <div className="flex-1 min-w-0">
                    <div className="text-muted-foreground">
                        {fmtWhen(a.createdAt)} • {a.author}
                        {isNote && <span className="ml-2 text-xs italic">Not sent to the customer</span>}
                        {isHandoff && <span className="ml-2 rounded-full bg-orange-500/25 px-2 py-0.5 text-xs font-medium not-italic text-orange-800 dark:text-orange-200">Handoff</span>}
                        {a.timeWorkedSeconds ? <span className="ml-2 rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-medium not-italic text-emerald-700 dark:text-emerald-300">{formatMinutes(a.timeWorkedSeconds / 60)} logged</span> : null}
                    </div>
                    <div className="mt-1 whitespace-pre-wrap break-words text-foreground">{a.body}</div>

                    {Array.isArray(a.attachments) && a.attachments.length > 0 && (
                        <ul className="mt-2 space-y-1">
                            {a.attachments.map((f: Attachment) => (
                                <li key={f.id}>
                                    <a className="underline underline-offset-2 hover:opacity-80" href={f.url} target="_blank" rel="noreferrer">
                                        {f.name}
                                    </a>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            </div>
        </li>
    );
}

/** The whole story in time order: the request, what was said to the customer, what was kept private, and what changed. */
function ConversationPanel({ items, loading, className }: { items: ConversationItem[]; loading: boolean; className?: string }) {
    const [filter, setFilter] = React.useState<"all" | "replies" | "notes" | "changes">("all");
    const scroller = React.useRef<HTMLDivElement | null>(null);

    const counts = React.useMemo(() => {
        const c = { all: items.length, replies: 0, notes: 0, changes: 0 };
        for (const i of items) {
            if (i.t === "change") c.changes++;
            else if (i.original) c.replies += 0;
            else if (i.a.kind === "note" || getIsInternal(i.a)) c.notes++;
            else c.replies++;
        }
        return c;
    }, [items]);

    const shown = React.useMemo(
        () => items.filter((i) => {
            if (filter === "all") return true;
            if (filter === "changes") return i.t === "change";
            if (i.t === "change") return false;
            if (i.original) return filter === "replies";
            const note = i.a.kind === "note" || getIsInternal(i.a);
            return filter === "notes" ? note : !note;
        }),
        [items, filter]
    );

    // Newest at the bottom, next to the composer: start there, and follow new items.
    const last = shown.length ? `${shown[shown.length - 1].t}:${shown[shown.length - 1].at}` : "";
    React.useEffect(() => {
        const el = scroller.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [last, filter]);

    const tabs: Array<[typeof filter, string]> = [["all", "All"], ["replies", "Replies"], ["notes", "Private notes"], ["changes", "Changes"]];
    return (
        <SectionCard className={cn("flex min-h-0 flex-col overflow-hidden", className)}>
            <div className="mb-3 flex shrink-0 flex-wrap items-center justify-between gap-2">
                <div role="tablist" aria-label="What to show" className="flex gap-1 rounded-xl border border-border/70 bg-card p-1 text-sm">
                    {tabs.map(([k, label]) => (
                        <button key={k} type="button" role="tab" aria-selected={filter === k} onClick={() => setFilter(k)}
                            className={cn("inline-flex items-center gap-1.5 rounded-lg px-3 py-1 font-medium transition-colors", filter === k ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:bg-accent hover:text-foreground")}>
                            {label}
                            <span className={cn("rounded-full px-1.5 text-[11px] tabular-nums", filter === k ? "bg-primary-foreground/20" : "bg-muted")}>{counts[k]}</span>
                        </button>
                    ))}
                </div>
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-blue-500/70" aria-hidden /> Reply, sent to the customer</span>
                    <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-amber-500/70" aria-hidden /> Private note</span>
                    <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-orange-500/80" aria-hidden /> Handoff</span>
                </div>
            </div>

            <div ref={scroller} className="min-h-0 flex-1 overflow-auto pr-2 [scrollbar-gutter:stable]">
                <ol className="space-y-3">
                    {shown.map((i) =>
                        i.t === "change" ? (
                            <li key={`c:${i.at}:${i.what}`} className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
                                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/50" aria-hidden />
                                <span>{i.what} — {i.who} • {fmtWhen(i.at)}</span>
                            </li>
                        ) : (
                            <ActivityCard key={i.a.id} a={i.a} original={i.original} />
                        )
                    )}
                    {shown.length === 0 && <li className="text-sm text-muted-foreground">{loading ? "Loading…" : "Nothing here yet."}</li>}
                </ol>
            </div>
        </SectionCard>
    );
}

/* -------------------------------- Page --------------------------------- */

export default function TicketDetailPage() {
    const { id } = useParams<{ id: string }>();
    const router = useRouter();

    const { ticket, setTicket, loading, refreshing, error, refetch } = useTicket(id);
    const extras = useTicketExtras(id);

    const users = useOptions(["/api/users"], userMapper);
    const clients = useOptions(["/api/customers"], clientMapper);
    const sites = useOptions(["/api/sites", "/api/locations"], siteMapper);

    const btnBase =
        "font-semibold rounded-md transition-all duration-150 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-background inline-flex items-center justify-center";
    const btnPrimary =
        "bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] hover:bg-[hsl(var(--primary))]/90 focus:ring-[hsl(var(--primary))]";
    const btnSecondary = "bg-muted hover:bg-accent text-foreground focus:ring-ring";

    const [savingField, setSavingField] = React.useState<string | null>(null);
    const canEditFields = hasPerm(useMe().permissions, "tickets.write");
    const [linkModalOpen, setLinkModalOpen] = React.useState(false);

    const isResolvedOrClosed = ticket?.status === "resolved" || ticket?.status === "closed";
    const isClosed = ticket?.status === "closed";

    // ---- New replies from the customer ----
    // Opening the ticket says so when the customer replied since it was last opened, and marks it seen. While it stays open,
    // the replies are checked every 20 seconds and a new one is announced.
    const [notice, setNotice] = React.useState<string | null>(null);
    const markedFor = React.useRef<string | null>(null);
    const seenInbound = React.useRef<number | null>(null);
    const markRead = React.useCallback((ticketId: string) => {
        void fetch(`${API}/api/tickets/${ticketId}/read`, { method: "POST", credentials: "include" }).catch(() => undefined);
    }, []);
    React.useEffect(() => {
        if (!ticket || markedFor.current === ticket.id) return;
        markedFor.current = ticket.id;
        if (ticket.hasNewReply) setNotice(`The customer replied${ticket.lastCustomerReplyAt ? ` (${fmtWhen(ticket.lastCustomerReplyAt)})` : ""} since you last opened this ticket.`);
        markRead(ticket.id);
    }, [ticket, markRead]);
    const inboundCount = React.useMemo(() => extras.activity.filter((a) => a.kind === "message" && (a as ActivityMessageOrNote).isInbound === true).length, [extras.activity]);
    React.useEffect(() => {
        if (extras.loading || !ticket) return;
        if (seenInbound.current !== null && inboundCount > seenInbound.current) {
            setNotice("The customer just replied.");
            markRead(ticket.id);
        }
        seenInbound.current = inboundCount;
    }, [inboundCount, extras.loading, ticket, markRead]);
    const refetchExtras = extras.refetch;
    React.useEffect(() => {
        const t = setInterval(() => {
            if (document.visibilityState === "visible") void refetchExtras({ silent: true });
        }, 20_000);
        return () => clearInterval(t);
    }, [refetchExtras]);

    // The stopwatch lives on the server and is started on purpose (see the Time worked card).
    const timer = useTicketTimer(ticket?.id);
    const [timeTick, setTimeTick] = React.useState(0);

    const replies = React.useMemo(() => {
        const items = extras.activity.filter((a): a is ActivityMessageOrNote => a.kind === "message" || a.kind === "note");
        return items
            .filter((a) => a.kind === "message" && !getIsInternal(a))
            .slice()
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    }, [extras.activity]);

    const notes = React.useMemo(() => {
        const items = extras.activity.filter((a): a is ActivityMessageOrNote => a.kind === "message" || a.kind === "note");
        return items
            .filter((a) => a.kind === "note" || getIsInternal(a))
            .slice()
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    }, [extras.activity]);

    // Replies and private notes together, newest first, so what was said to the customer and what was kept private read as one story.
    const timeline = React.useMemo(
        () => [...replies, ...notes].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
        [replies, notes]
    );
    // The whole story in time order: the original request, replies, private notes and changes.
    const conversation = React.useMemo<ConversationItem[]>(() => {
        const list: ConversationItem[] = [];
        if (ticket?.description) {
            list.push({
                t: "item", at: ticket.createdAt ?? "", original: true,
                a: { id: "original-request", kind: "message", author: ticket.requesterName ?? ticket.requesterEmail ?? "Requester", body: ticket.description, createdAt: ticket.createdAt ?? "", isInternal: false },
            });
        }
        for (const a of timeline) list.push({ t: "item", at: a.createdAt, a });
        for (const h of extras.history) list.push({ t: "change", at: h.at, who: h.who, what: h.what });
        return list.sort((x, y) => new Date(x.at).getTime() - new Date(y.at).getTime());
    }, [ticket, timeline, extras.history]);
    // The handoff note stays up top until someone adds anything after it: that is the next technician picking it up.
    const latestHandoff = timeline.length > 0 && timeline[0].kind === "note" && timeline[0].isHandoff === true ? timeline[0] : null;

    /** After something changed the ticket from another card (devices, the contact who asked). */
    const refreshTicket = React.useCallback(async () => {
        await refetch({ silent: true });
        await extras.refetch({ silent: true });
    }, [refetch, extras]);

    async function patchTicket(body: Partial<Ticket>, fieldName?: string) {
        if (!ticket) return;
        if (fieldName) setSavingField(fieldName);

        setTicket({ ...ticket, ...body });

        const res = await fetch(`${API}/api/tickets/${id}`, {
            method: "PATCH",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });

        if (!res.ok) {
            await refetch({ silent: false });
        }

        await extras.refetch({ silent: true });

        if (fieldName) setSavingField(null);
    }

    const markResolved = () => {
        if (!ticket || isResolvedOrClosed) return;
        return patchTicket({ status: "resolved" });
    };
    const markClosed = () => {
        if (!ticket || isResolvedOrClosed) return;
        return patchTicket({ status: "closed" });
    };
    const reopen = () => {
        if (!ticket) return;
        return patchTicket({ status: "open" });
    };

    // Mobile tabs: one scrollable “section” at a time (no full-page scrollbars)
    const [mobileTab, setMobileTab] = React.useState<"replies" | "notes" | "history" | "details" | "linked">("replies");

    const mobileTabs: Array<{ key: typeof mobileTab; label: string }> = [
        { key: "replies", label: "Replies" },
        { key: "notes", label: "Internal Notes" },
        { key: "history", label: "History" },
        { key: "details", label: "Details" },
        { key: "linked", label: "Linked" },
    ];

    return (
        <div className="page-frame h-[100dvh] bg-transparent text-foreground overflow-hidden flex flex-col p-4 sm:p-6 lg:px-8">
            <header className="mb-4 sm:mb-5 flex items-center justify-between shrink-0 gap-3">
                <div className="flex items-center gap-2 text-sm text-muted-foreground min-w-0">
                    <Link href="/tickets" className="hover:underline underline-offset-2 shrink-0">
                        Tickets
                    </Link>
                    <span className="shrink-0">/</span>
                    <span className="truncate text-foreground">{ticket?.title ?? shortId(id)}</span>
                    {refreshing ? <span className="text-xs text-muted-foreground shrink-0">(refreshing)</span> : null}
                </div>

                <div className="flex items-center gap-2 shrink-0">
                    <button
                        className={cn(btnBase, btnSecondary, "px-3 sm:px-4 py-1.5 text-sm")}
                        onClick={() => {
                            refetch({ silent: false });
                            extras.refetch({ silent: false });
                        }}
                        title="Refresh"
                    >
                        Refresh
                    </button>
                    <button
                        className={cn(btnBase, btnPrimary, "px-3 sm:px-4 py-1.5 text-sm")}
                        onClick={() => router.push("/tickets")}
                    >
                        Back
                    </button>
                </div>
            </header>

            {notice ? (
                <div role="status" className="fixed right-4 top-16 z-50 flex max-w-sm items-start gap-3 rounded-lg border border-emerald-500/50 bg-card p-3 text-sm shadow-lg">
                    <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-emerald-500" aria-hidden />
                    <span className="flex-1">{notice}</span>
                    <button type="button" className="text-xs text-muted-foreground underline" onClick={() => setNotice(null)}>Dismiss</button>
                </div>
            ) : null}

            <div className="flex-1 min-h-0 overflow-hidden">
                {loading && <SectionCard className="text-sm text-foreground/80">Loading…</SectionCard>}

                {error && <SectionCard className="text-sm border-red-700/30 bg-red-900/10 text-red-600 dark:text-red-300">{error}</SectionCard>}

                {ticket && (
                    <>
                        {/* ============================ DESKTOP (lg+) ============================ */}
                        <div className="hidden h-full min-h-0 gap-5 overflow-hidden lg:grid lg:grid-cols-[minmax(0,1fr)_340px]">
                            {/* The conversation */}
                            <div className="flex h-full min-h-0 flex-col gap-3 overflow-hidden">
                                <SectionCard className="shrink-0">
                                    <div className="flex flex-wrap items-start justify-between gap-3">
                                        <div className="min-w-0">
                                            <div className="text-xs text-muted-foreground"># {getDisplayTicketNumber(ticket)}</div>
                                            <h1 className="text-xl font-semibold tracking-tight text-foreground">{ticket.title}</h1>
                                            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                                                <StatusPill value={ticket.status} />
                                                <PriorityPill value={ticket.priority} />
                                                <span>{ticket.requesterName ?? ticket.requesterEmail ?? "No requester"}</span>
                                                {ticket.clientId ? <span>• {clients.options.find((o) => o.value === ticket.clientId)?.label ?? "Customer"}</span> : null}
                                                {ticket.dueAt ? <span>• Due {fmtWhen(ticket.dueAt)}</span> : null}
                                            </div>
                                        </div>

                                        <div className="flex flex-wrap items-center gap-2">
                                            {ticket.status !== "resolved" && ticket.status !== "closed" ? (
                                                <>
                                                    <button
                                                        className={cn(btnBase, btnSecondary, "h-9 px-3 text-sm disabled:opacity-50")}
                                                        onClick={markResolved}
                                                        disabled={isResolvedOrClosed}
                                                    >
                                                        Mark as Resolved
                                                    </button>
                                                    <button
                                                        className={cn(btnBase, btnSecondary, "h-9 px-3 text-sm disabled:opacity-50")}
                                                        onClick={markClosed}
                                                        disabled={isResolvedOrClosed}
                                                    >
                                                        Close
                                                    </button>
                                                </>
                                            ) : (
                                                <button className={cn(btnBase, btnSecondary, "h-9 px-3 text-sm")} onClick={reopen}>
                                                    Reopen
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                </SectionCard>

                                {latestHandoff && (
                                    <div role="status" className="shrink-0 rounded-lg border border-orange-500/50 border-l-4 bg-orange-500/15 p-3 text-sm">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <span className="rounded-full bg-orange-500/25 px-2 py-0.5 text-xs font-medium text-orange-800 dark:text-orange-200">Handoff</span>
                                            <span className="text-muted-foreground">Left by {latestHandoff.author} • {fmtWhen(latestHandoff.createdAt)}</span>
                                        </div>
                                        <div className="mt-1 max-h-28 overflow-auto whitespace-pre-wrap break-words text-foreground">{latestHandoff.body}</div>
                                        <div className="mt-1 text-xs text-muted-foreground">Private. Add a note or a reply to pick this up. This note stays in the conversation.</div>
                                    </div>
                                )}

                                <ConversationPanel items={conversation} loading={extras.loading} className="flex-1" />

                                <Composer
                                    ticketId={ticket.id}
                                    ticketStatus={ticket.status}
                                    canned={extras.canned}
                                    onSent={() => {
                                        extras.refetch({ silent: true });
                                        refetch({ silent: true });
                                        setTimeTick((n) => n + 1);
                                    }}
                                    onStatusChange={(next) => setTicket((t) => (t ? { ...t, status: next as any } : t))}
                                    btnBase={btnBase}
                                    btnPrimary={btnPrimary}
                                    btnSecondary={btnSecondary}
                                    timer={timer}
                                    docked
                                />
                            </div>

                            {/* The details rail */}
                            <aside className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto pr-1">
                                <SectionCard className="shrink-0">
                                    <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">Ticket</h3>
                                    <dl className="space-y-3 text-sm">
                                        <RequesterRow ticketId={ticket.id} clientId={ticket.clientId} contact={ticket.requesterContact} fallbackName={ticket.requesterName} fallbackEmail={ticket.requesterEmail} canEdit={canEditFields} onChanged={refreshTicket} />
                                        <EditableSelectRow
                                            label="Priority"
                                            value={(ticket.priority ?? "") as any}
                                            placeholder="Select priority"
                                            options={PRIORITY_OPTIONS}
                                            saving={savingField === "priority"}
                                            onSave={(v) => patchTicket({ priority: v as any }, "priority")}
                                        />
                                        <EditableSelectRow
                                            label="Assignee"
                                            value={ticket.assigneeUserId ?? ""}
                                            placeholder="Select assignee"
                                            options={users.options}
                                            saving={savingField === "assigneeUserId"}
                                            onSave={(v) => patchTicket({ assigneeUserId: v }, "assigneeUserId")}
                                        />
                                        <InlineDateRow
                                            label="Due date"
                                            value={ticket.dueAt}
                                            onSave={(v) => patchTicket({ dueAt: v as any }, "dueAt")}
                                            saving={savingField === "dueAt"}
                                        />
                                    </dl>
                                </SectionCard>

                                <ServiceDeskCard ticket={ticket as any} canEdit={canEditFields} onPatch={patchTicket as any} onChanged={refreshTicket} className="shrink-0" />
                                <SectionCard className="shrink-0">
                                    <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">Customer and device</h3>
                                    <dl className="space-y-3 text-sm">
                                        <EditableSelectRow
                                            label="Customer"
                                            value={ticket.clientId ?? ""}
                                            placeholder="Select customer"
                                            options={clients.options}
                                            saving={savingField === "clientId"}
                                            onSave={(v) => patchTicket({ clientId: (v || null) as any }, "clientId")}
                                        />
                                    </dl>
                                </SectionCard>

                                <TicketDevicesCard ticketId={ticket.id} clientId={ticket.clientId} canEdit={canEditFields} className="shrink-0" onChanged={refreshTicket} />

                                <TicketCustomFieldsCard
                                    ticketId={ticket.id}
                                    saved={ticket.customFields}
                                    canEdit={canEditFields}
                                    className="shrink-0"
                                    onSaved={async () => { await refetch({ silent: true }); await extras.refetch({ silent: true }); }}
                                />

                                <SectionCard className="shrink-0">
                                    <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">Time worked</h3>
                                    <TicketTimeCard ticketId={ticket.id} timer={timer} closed={isClosed} refreshKey={timeTick} />
                                    {isClosed && <div className="mt-2 text-xs text-amber-300">Ticket is closed. Replies/notes are disabled.</div>}
                                </SectionCard>

                                <SectionCard className="shrink-0">
                                    <TicketVisitsCard ticketId={ticket.id} ticketLabel={`#${ticket.number ?? ""} ${ticket.title}`.trim()} closed={isClosed} />
                                </SectionCard>

                                <SectionCard className="shrink-0">
                                    <TicketKbCard ticketId={ticket.id} subject={ticket.title} />
                                </SectionCard>
                                <TicketSurveyCard ticketId={ticket.id} refreshKey={ticket.status} />

                                <SectionCard className="shrink-0">
                                    <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">Linked tickets</h3>
                                    <ul className="space-y-2 text-sm">
                                        {extras.linked.map((lt) => (
                                            <li key={lt.id} className="flex items-center justify-between gap-2">
                                                <Link href={`/tickets/${lt.id}`} className="underline underline-offset-2 hover:opacity-80">
                                                    {lt.number ?? shortId(lt.id)} — {lt.title}
                                                </Link>
                                                <StatusPill value={lt.status} />
                                            </li>
                                        ))}
                                        {extras.linked.length === 0 && <li className="text-muted-foreground">No linked tickets.</li>}
                                    </ul>
                                    <div className="mt-2">
                                        <SmallBtn className={cn(btnBase, btnSecondary)} onClick={() => setLinkModalOpen(true)}>
                                            + Link a ticket
                                        </SmallBtn>
                                    </div>
                                    <LinksPanel type="ticket" id={id} className="mt-3 grid gap-1 border-t border-white/10 pt-3" />

                                    <TicketLinkModal
                                        open={linkModalOpen}
                                        onOpenChange={setLinkModalOpen}
                                        currentTicketId={id}
                                        onLinked={() => extras.refetch({ silent: true })}
                                        btnBase={btnBase}
                                        btnSecondary={btnSecondary}
                                    />
                                </SectionCard>

                                <SectionCard className="shrink-0">
                                    <dl className="space-y-2 text-xs">
                                        <MetaRow label="Created">{fmtWhen(ticket.createdAt)}</MetaRow>
                                        <MetaRow label="Updated">{fmtWhen(ticket.updatedAt)}</MetaRow>
                                    </dl>
                                </SectionCard>
                            </aside>
                        </div>

                        {/* ============================ MOBILE / TABLET (<lg) ============================ */}
                        <div className="lg:hidden h-full min-h-0 flex flex-col gap-4 overflow-hidden">
                            {/* Summary + actions (scrolls internally on mobile) */}
                            <SectionCard className="shrink-0 flex flex-col min-h-0 overflow-hidden max-h-[32dvh]">
                                <div className="flex items-start justify-between gap-3 shrink-0">
                                    <div className="min-w-0">
                                        <h1 className="text-lg font-semibold text-foreground truncate">{ticket.title}</h1>
                                        <div className="mt-2 flex flex-wrap items-center gap-2">
                                            <StatusPill value={ticket.status} />
                                            <PriorityPill value={ticket.priority} />
                                            <span className="text-xs text-muted-foreground"># {getDisplayTicketNumber(ticket)}</span>
                                        </div>
                                    </div>

                                    <div className="flex flex-col gap-2 shrink-0">
                                        {ticket.status !== "resolved" && ticket.status !== "closed" ? (
                                            <>
                                                <button
                                                    className={cn(btnBase, btnSecondary, "h-9 px-3 text-sm disabled:opacity-50")}
                                                    onClick={markResolved}
                                                    disabled={isResolvedOrClosed}
                                                >
                                                    Resolve
                                                </button>
                                                <button
                                                    className={cn(btnBase, btnSecondary, "h-9 px-3 text-sm disabled:opacity-50")}
                                                    onClick={markClosed}
                                                    disabled={isResolvedOrClosed}
                                                >
                                                    Close
                                                </button>
                                            </>
                                        ) : (
                                            <button className={cn(btnBase, btnSecondary, "h-9 px-3 text-sm")} onClick={reopen}>
                                                Reopen
                                            </button>
                                        )}
                                    </div>
                                </div>

                                {ticket.description ? (
                                    <div className="mt-3 flex-1 min-h-0 overflow-auto pr-2 [scrollbar-gutter:stable] text-sm text-foreground whitespace-pre-wrap break-words">
                                        {ticket.description}
                                    </div>
                                ) : null}
                            </SectionCard>

                            {/* Composer (scrolls internally on mobile) */}
                            <Composer
                                ticketId={ticket.id}
                                ticketStatus={ticket.status}
                                canned={extras.canned}
                                onSent={() => {
                                    extras.refetch({ silent: true });
                                    refetch({ silent: true });
                                    setTimeTick((n) => n + 1);
                                }}
                                onStatusChange={(next) => setTicket((t) => (t ? { ...t, status: next as any } : t))}
                                btnBase={btnBase}
                                btnPrimary={btnPrimary}
                                btnSecondary={btnSecondary}
                                timer={timer}
                            />

                            {/* Tabs */}
                            <div className="shrink-0 overflow-x-auto [scrollbar-gutter:stable]">
                                <div className="inline-flex gap-2 min-w-max">
                                    {mobileTabs.map((t) => (
                                        <button
                                            key={t.key}
                                            type="button"
                                            onClick={() => setMobileTab(t.key)}
                                            className={cn(
                                                "h-9 px-3 text-sm rounded-lg border border-input transition-colors",
                                                mobileTab === t.key
                                                    ? "bg-muted text-foreground"
                                                    : "bg-card/60 text-foreground/80 hover:bg-accent"
                                            )}
                                        >
                                            {t.label}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            {/* One panel at a time */}
                            <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
                                {mobileTab === "replies" && (
                                    <ListPanel
                                        title="Replies"
                                        count={replies.length}
                                        badgeLabel="Reply"
                                        badgeClassName="bg-blue-500/15 text-blue-300"
                                        items={replies}
                                        emptyText={extras.loading ? "Loading…" : "No replies yet."}
                                        className="flex-1"
                                    />
                                )}

                                {mobileTab === "notes" && (
                                    <ListPanel
                                        title="Internal Notes"
                                        count={notes.length}
                                        badgeLabel="Note"
                                        badgeClassName="bg-amber-500/15 text-amber-300"
                                        items={notes}
                                        emptyText={extras.loading ? "Loading…" : "No internal notes yet."}
                                        className="flex-1"
                                    />
                                )}

                                {mobileTab === "history" && <TicketHistoryPanel history={extras.history} className="flex-1" />}

                                {mobileTab === "details" && (
                                    <SectionCard className="flex flex-col min-h-0 overflow-hidden flex-1">
                                        <div className="mb-3 flex items-center justify-between shrink-0">
                                            <h3 className="text-base font-semibold text-foreground">Ticket Details</h3>
                                            <div className="text-xs text-muted-foreground tabular-nums">{clock(timer.seconds)}</div>
                                        </div>

                                        <div className="flex-1 min-h-0 overflow-auto pr-2 [scrollbar-gutter:stable]">
                                            <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2 sm:gap-x-8">
                                                <div className="space-y-3">
                                                    <MetaRow label="Ticket #">{getDisplayTicketNumber(ticket)}</MetaRow>
                                                    <RequesterRow ticketId={ticket.id} clientId={ticket.clientId} contact={ticket.requesterContact} fallbackName={ticket.requesterName} fallbackEmail={ticket.requesterEmail} canEdit={canEditFields} onChanged={refreshTicket} />

                                                    <EditableSelectRow
                                                        label="Priority"
                                                        value={(ticket.priority ?? "") as any}
                                                        placeholder="Select priority"
                                                        options={PRIORITY_OPTIONS}
                                                        saving={savingField === "priority"}
                                                        onSave={(v) => patchTicket({ priority: v as any }, "priority")}
                                                    />

                                                    <EditableSelectRow
                                                        label="Assignee"
                                                        value={ticket.assigneeUserId ?? ""}
                                                        placeholder="Select assignee"
                                                        options={users.options}
                                                        saving={savingField === "assigneeUserId"}
                                                        onSave={(v) => patchTicket({ assigneeUserId: v }, "assigneeUserId")}
                                                    />
                                                </div>

                                                <div className="space-y-3">
                                                    <EditableSelectRow
                                                        label="Customer"
                                                        value={ticket.clientId ?? ""}
                                                        placeholder="Select customer"
                                                        options={clients.options}
                                                        saving={savingField === "clientId"}
                                                        onSave={(v) => patchTicket({ clientId: (v || null) as any }, "clientId")}
                                                    />


                                                    <TicketDevicesCard ticketId={ticket.id} clientId={ticket.clientId} canEdit={canEditFields} className="!p-3 shadow-none" onChanged={refreshTicket} />

                                                    <InlineDateRow
                                                        label="Due date"
                                                        value={ticket.dueAt}
                                                        onSave={(v) => patchTicket({ dueAt: v as any }, "dueAt")}
                                                        saving={savingField === "dueAt"}
                                                    />

                                                    <MetaRow label="Updated">{fmtWhen(ticket.updatedAt)}</MetaRow>
                                                    <MetaRow label="Created">{fmtWhen(ticket.createdAt)}</MetaRow>
                                                </div>
                                            </dl>

                                            <TicketCustomFieldsCard
                                                ticketId={ticket.id}
                                                saved={ticket.customFields}
                                                canEdit={canEditFields}
                                                className="mt-4"
                                                onSaved={async () => { await refetch({ silent: true }); await extras.refetch({ silent: true }); }}
                                            />

                                            <div className="mt-4"><TicketVisitsCard ticketId={ticket.id} ticketLabel={`#${ticket.number ?? ""} ${ticket.title}`.trim()} closed={isClosed} /></div>

                                            <div className="mt-4"><TicketKbCard ticketId={ticket.id} subject={ticket.title} /></div>

                                            {isClosed && (
                                                <div className="mt-4 rounded-md border border-amber-700/40 bg-amber-900/10 p-2 text-sm text-amber-700 dark:text-amber-200">
                                                    Ticket is closed. Replies/notes are disabled.
                                                </div>
                                            )}
                                        </div>
                                    </SectionCard>
                                )}

                                {mobileTab === "linked" && (
                                    <SectionCard className="flex flex-col min-h-0 overflow-hidden flex-1">
                                        <div className="mb-3 flex items-center justify-between shrink-0">
                                            <h3 className="text-base font-semibold text-foreground">Linked tickets</h3>
                                            <SmallBtn className={cn(btnBase, btnSecondary)} onClick={() => setLinkModalOpen(true)}>
                                                + Link
                                            </SmallBtn>
                                        </div>

                                        <div className="flex-1 min-h-0 overflow-auto pr-2 [scrollbar-gutter:stable]">
                                            <ul className="space-y-2 text-sm">
                                                {extras.linked.map((lt) => (
                                                    <li key={lt.id} className="flex items-center justify-between gap-2">
                                                        <Link href={`/tickets/${lt.id}`} className="underline underline-offset-2 hover:opacity-80">
                                                            {lt.number ?? shortId(lt.id)} — {lt.title}
                                                        </Link>
                                                        <StatusPill value={lt.status} />
                                                    </li>
                                                ))}
                                                {extras.linked.length === 0 && <li className="text-muted-foreground">No linked tickets.</li>}
                                            </ul>
                                        </div>

                                        <TicketLinkModal
                                            open={linkModalOpen}
                                            onOpenChange={setLinkModalOpen}
                                            currentTicketId={id}
                                            onLinked={() => extras.refetch({ silent: true })}
                                            btnBase={btnBase}
                                            btnSecondary={btnSecondary}
                                        />
                                    </SectionCard>
                                )}
                            </div>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}

/* --------------------- Inline date editor (due date) ------------------- */

function InlineDateRow({
    label,
    value,
    onSave,
    saving,
}: {
    label: string;
    value?: string | null;
    onSave: (v: string | null) => Promise<void> | void;
    saving?: boolean;
}) {
    const [editing, setEditing] = React.useState(false);
    const [pending, setPending] = React.useState(false);

    const toLocalInput = (iso?: string | null) => {
        if (!iso) return "";
        const d = new Date(iso);
        if (isNaN(d.getTime())) return "";
        const pad = (n: number) => String(n).padStart(2, "0");
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    };

    const fromLocalInput = (v: string) => {
        if (!v.trim()) return null;
        const d = new Date(v);
        if (isNaN(d.getTime())) return null;
        return d.toISOString();
    };

    const [draft, setDraft] = React.useState(toLocalInput(value));
    React.useEffect(() => setDraft(toLocalInput(value)), [value]);

    const hasValue = !!(value && value.toString().trim());

    return (
        <div>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="mt-1">
                {!editing ? (
                    hasValue ? (
                        <button className="font-medium text-foreground hover:underline underline-offset-2" onClick={() => setEditing(true)}>
                            {fmtWhen(value)}
                        </button>
                    ) : (
                        <button
                            className="text-xs rounded-lg border border-input px-2 py-1 text-foreground/80 hover:bg-accent"
                            onClick={() => setEditing(true)}
                        >
                            + Set due date
                        </button>
                    )
                ) : (
                    <div className="flex items-center gap-2">
                        <input
                            type="datetime-local"
                            value={draft}
                            onChange={(e) => setDraft(e.currentTarget.value)}
                            className="h-8 rounded-lg border border-input bg-card/60 px-2 text-sm text-foreground"
                        />
                        <button
                            disabled={pending || saving}
                            className="inline-flex h-8 items-center rounded-lg border border-input px-2 text-xs text-foreground hover:bg-accent disabled:opacity-50"
                            onClick={async () => {
                                try {
                                    setPending(true);
                                    await onSave(fromLocalInput(draft));
                                    setEditing(false);
                                } finally {
                                    setPending(false);
                                }
                            }}
                        >
                            Save
                        </button>
                        <button
                            className="inline-flex h-8 items-center rounded-lg border border-input px-2 text-xs text-foreground hover:bg-accent"
                            onClick={() => {
                                setDraft(toLocalInput(value));
                                setEditing(false);
                            }}
                        >
                            Cancel
                        </button>
                    </div>
                )}
            </dd>
        </div>
    );
}

/* ----------------------------- Composer ----------------------------- */

function Composer({
    ticketId,
    ticketStatus,
    canned,
    onSent,
    onStatusChange,
    btnBase,
    btnPrimary,
    btnSecondary,
    timer,
    docked = false,
}: {
    ticketId: string;
    ticketStatus: string;
    canned: CannedResponse[];
    onSent: () => void;
    onStatusChange?: (nextStatus: "open" | "in_progress" | "resolved" | "closed" | string) => void;
    btnBase: string;
    btnPrimary: string;
    btnSecondary: string;
    timer: TicketTimer;
    /** Sits under the conversation: shorter, so the conversation keeps the room. */
    docked?: boolean;
}) {
    const [mode, setMode] = React.useState<"reply" | "note">("reply");
    const [body, setBody] = React.useState("");
    const [attach, setAttach] = React.useState<File[]>([]);
    const [dontEmailCustomer, setDontEmailCustomer] = React.useState(false);
    const [handoff, setHandoff] = React.useState(false);
    // Time spent on what is being sent, logged as a time entry on the ticket.
    const [timeText, setTimeText] = React.useState("");
    const [timeBillable, setTimeBillable] = React.useState(true);
    const [fromTimer, setFromTimer] = React.useState(false);
    const timeMinutes = parseDuration(timeText);
    const timeBad = timeText.trim() !== "" && timeMinutes === null;
    // Typing time in is its own right; without it the Time worked card's timer is the way to log time.
    const canManualTime = hasPerm(useMe().permissions, "tickets.time.manual");
    const [submitting, setSubmitting] = React.useState(false);

    const isClosed = ticketStatus === "closed";

    async function pickCanned(id: string) {
        const match = canned.find((c) => c.id === id);
        if (!match) return;

        try {
            const res = await fetch(`${API}/api/tickets/${ticketId}/canned-render`, {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ template: match.body }),
            });

            if (!res.ok) {
                const msg = await safeReadErrorMessage(res);
                throw new Error(msg || `Render failed (${res.status})`);
            }

            const data = await res.json();
            const rendered = typeof data?.rendered === "string" ? data.rendered : match.body;

            setBody((b) => (b ? `${b}\n\n${rendered}` : rendered));
        } catch {
            setBody((b) => (b ? `${b}\n\n${match.body}` : match.body));
        }
    }

    async function uploadFiles(): Promise<{ id: string; url: string; name: string }[]> {
        if (attach.length === 0) return [];
        const form = new FormData();
        attach.forEach((f) => form.append("files", f, f.name));
        const res = await fetch(`${API}/api/tickets/${ticketId}/attachments`, {
            method: "POST",
            credentials: "include",
            body: form,
        });
        if (!res.ok) throw new Error("File upload failed");
        return res.json();
    }

    async function submit(kind: "reply" | "note", submitAs?: "reply" | "reply_and_close" | "reply_and_resolve") {
        if (isClosed) return;
        if (!body.trim() && attach.length === 0) return;
        if (timeBad) { alert("The time is not valid. Use something like 25, 1:30 or 1h 30m, up to 24 hours."); return; }

        setSubmitting(true);
        try {
            const files = await uploadFiles();
            const res = await fetch(`${API}/api/tickets/${ticketId}/${kind}`, {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    body,
                    attachments: files,
                    notifyCustomer: kind === "reply" && !dontEmailCustomer,
                    ...(kind === "note" && handoff ? { handoff: true } : {}),
                    ...(canManualTime && timeMinutes ? { timeMinutes, billable: timeBillable } : {}),
                    submitAs,
                }),
            });
            if (!res.ok) throw new Error(`Submit failed (${res.status})`);
            // The reply is saved either way. Say so when it could not be emailed to the customer.
            if (kind === "reply" && !dontEmailCustomer) {
                const sent = await res.json().catch(() => null);
                if (sent?.emailed && sent.emailed.sent === false && sent.emailed.reason) alert(sent.emailed.reason);
            }

            if (submitAs === "reply_and_resolve") onStatusChange?.("resolved");
            if (submitAs === "reply_and_close") onStatusChange?.("closed");

            setBody("");
            setAttach([]);
            setHandoff(false);
            // The timer's time went out with this reply, so it is not counted twice.
            if (fromTimer && timeMinutes) await timer.discard();
            setTimeText("");
            setFromTimer(false);
            onSent();
        } catch (e) {
            alert((e as any)?.message ?? String(e));
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <SectionCard className={cn("shrink-0 flex flex-col min-h-0 overflow-hidden", docked ? "max-h-[42dvh]" : "max-h-[48dvh] lg:max-h-none")}>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3 shrink-0">
                <div className="flex items-center gap-2 text-sm">
                    <button
                        type="button"
                        className={cn(
                            "rounded-lg border border-input px-3 py-1",
                            mode === "reply" ? "bg-muted text-foreground" : "bg-card/60 text-muted-foreground hover:bg-accent"
                        )}
                        onClick={() => setMode("reply")}
                        disabled={isClosed}
                    >
                        Reply
                    </button>
                    <button
                        type="button"
                        className={cn(
                            "rounded-lg border border-input px-3 py-1",
                            mode === "note" ? "bg-muted text-amber-700 dark:text-amber-200" : "bg-card/60 text-muted-foreground hover:bg-accent"
                        )}
                        onClick={() => setMode("note")}
                        disabled={isClosed}
                        title="Internal note (technicians only)"
                    >
                        Internal note
                    </button>
                </div>

                <div className="text-xs text-muted-foreground">
                    {timer.started ? (
                        <span className={cn("tabular-nums", timer.running && "text-emerald-600 dark:text-emerald-300")}>Timer {clock(timer.seconds)}{timer.running ? " running" : " paused"}</span>
                    ) : null}
                </div>
            </div>

            {isClosed && (
                <div className="mb-3 rounded-md border border-amber-700/40 bg-amber-900/10 p-2 text-sm text-amber-700 dark:text-amber-200 shrink-0">
                    This ticket is closed. You can’t add replies or internal notes.
                </div>
            )}

            <div className="flex-1 min-h-0 overflow-auto pr-2 [scrollbar-gutter:stable]">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                    <select
                        className="h-9 rounded-lg border border-input bg-card/60 px-2 text-sm text-foreground"
                        onChange={(e) => pickCanned(e.currentTarget.value)}
                        defaultValue=""
                        title="Canned responses"
                        disabled={isClosed}
                    >
                        <option value="" disabled>
                            Select a canned response…
                        </option>
                        {canned.map((c) => (
                            <option key={c.id} value={c.id}>
                                {c.title}
                            </option>
                        ))}
                    </select>

                    <InsertArticleButton disabled={isClosed} onInsert={(t) => setBody((b) => (b ? `${b}

${t}` : t))} />

                    <label className={cn("ml-auto inline-flex cursor-pointer items-center gap-2 text-sm", isClosed && "opacity-50 cursor-not-allowed")}>
                        <input
                            type="file"
                            multiple
                            className="hidden"
                            disabled={isClosed}
                            onChange={(e) => setAttach(Array.from(e.currentTarget.files ?? []))}
                        />
                        <span className="rounded-lg border border-input px-3 py-1 text-foreground hover:bg-accent">Add file</span>
                        {attach.length > 0 ? (
                            <span className="text-xs text-muted-foreground tabular-nums">{attach.length} file(s)</span>
                        ) : (
                            <span className="text-xs text-muted-foreground tabular-nums opacity-0">0 file(s)</span>
                        )}
                    </label>
                </div>

                {canManualTime && (
                <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
                    <span className="text-xs font-medium text-muted-foreground">Time on this {mode === "note" ? "note" : "reply"}</span>
                    <input
                        aria-label="Time spent on this"
                        aria-invalid={timeBad}
                        className={cn("h-8 w-28 rounded-lg border bg-card/60 px-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-[hsl(var(--primary))]", timeBad ? "border-destructive" : "border-input")}
                        placeholder="25, 1:30, 1h"
                        value={timeText}
                        disabled={isClosed}
                        onChange={(e) => { setTimeText(e.currentTarget.value); setFromTimer(false); }}
                    />
                    {timer.started && (
                        <button
                            type="button"
                            className="rounded-lg border border-input px-2 py-1 text-xs text-foreground hover:bg-accent disabled:opacity-50"
                            disabled={isClosed}
                            onClick={() => { setTimeText(String(Math.max(1, Math.ceil(timer.seconds / 60)))); setFromTimer(true); }}
                            title="Use what the timer has counted, and clear the timer when this is sent"
                        >
                            Use timer ({formatMinutes(Math.max(1, Math.ceil(timer.seconds / 60)))})
                        </button>
                    )}
                    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <input type="checkbox" checked={timeBillable} onChange={(e) => setTimeBillable(e.currentTarget.checked)} disabled={isClosed} /> Billable
                    </label>
                    <span className={cn("min-h-4 text-xs", timeBad ? "text-destructive" : "text-muted-foreground")}>
                        {timeBad ? "Not a valid time" : timeMinutes ? `Will log ${formatMinutes(timeMinutes)}` : ""}
                    </span>
                </div>
                )}

                <textarea
                    className={cn(docked ? "min-h-[84px]" : "min-h-[130px] sm:min-h-[160px]", "w-full rounded-lg border border-input bg-card/60 p-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-[hsl(var(--primary))] disabled:opacity-50")}
                    placeholder={mode === "note" ? "Type an internal note (technicians only)…" : "Type your reply…"}
                    value={body}
                    onChange={(e) => setBody(e.currentTarget.value)}
                    disabled={isClosed}
                />

                <div className="mt-3 grid gap-3 md:grid-cols-2">
                    <div className="space-y-2 text-sm">
                        {mode === "note" && (
                            <label className="flex items-start gap-2">
                                <input type="checkbox" className="mt-1" checked={handoff} onChange={(e) => setHandoff(e.currentTarget.checked)} disabled={isClosed} />
                                <span>
                                    <span className="font-medium">Handoff note</span>
                                    <span className="block text-xs text-muted-foreground">Leaving for the day or passing it on. It is pinned at the top for the next technician, and the customer never sees it.</span>
                                </span>
                            </label>
                        )}
                        {mode === "reply" && (
                            <label className="flex items-center gap-2">
                                <input
                                    type="checkbox"
                                    checked={dontEmailCustomer}
                                    onChange={(e) => setDontEmailCustomer(e.currentTarget.checked)}
                                    disabled={isClosed}
                                />
                                Don’t send email notification of this reply to the customer
                            </label>
                        )}
                        {mode === "note" && <div className="text-xs text-amber-700 dark:text-amber-200/90">Internal notes are visible to technicians only.</div>}
                    </div>

                    <div className="flex flex-wrap items-center justify-end gap-2">
                        {mode === "note" ? (
                            <button
                                className={cn(btnBase, "h-9 px-3 text-sm disabled:opacity-50", "bg-muted hover:bg-accent text-foreground")}
                                disabled={submitting || isClosed}
                                onClick={() => submit("note")}
                            >
                                Add internal note
                            </button>
                        ) : (
                            <>
                                <button className={cn(btnBase, btnSecondary, "h-9 px-3 text-sm disabled:opacity-50")} disabled={submitting || isClosed} onClick={() => submit("reply")}>
                                    Submit reply
                                </button>
                                <button className={cn(btnBase, btnPrimary, "h-9 px-3 text-sm disabled:opacity-50")} disabled={submitting || isClosed} onClick={() => submit("reply", "reply_and_resolve")}>
                                    Submit & Resolve
                                </button>
                                <button className={cn(btnBase, btnPrimary, "h-9 px-3 text-sm disabled:opacity-50")} disabled={submitting || isClosed} onClick={() => submit("reply", "reply_and_close")}>
                                    Submit & Close
                                </button>
                            </>
                        )}
                    </div>
                </div>
            </div>
        </SectionCard>
    );
}