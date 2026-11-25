// components/tickets-table.tsx
"use client";

import * as React from "react";
import Link from "next/link";
import type { ColumnDef, ColumnFiltersState, SortingState, VisibilityState } from "@tanstack/react-table";
import { StatusPill, PriorityPill } from "@/components/pills";
import { DataTable } from "@/components/data-table";
import { SortHeader } from "@/components/sort-header";
import { Pager, usePaged } from "@/components/pager";
import SlaBadge from "@/components/tickets/sla-badge";
import { dueSortValue } from "@/lib/service-desk";

function NewReplyPill() {
  return <span className="ml-2 inline-flex items-center rounded-full bg-emerald-500/15 px-2 py-0.5 align-middle text-xs font-medium text-emerald-700 dark:text-emerald-300" title="The customer replied since you last opened this ticket">New reply</span>;
}

export type Ticket = {
  id: string;
  number?: string | null;
  title: string;
  status: string;
  priority?: string | null;

  requesterName?: string | null;
  requesterEmail?: string | null;
  /** The customer has replied since this person last opened the ticket. */
  hasNewReply?: boolean;

  // legacy display string (may not be set by list endpoint)
  assignedTo?: string | null;

  // what the backend actually returns (list endpoint)
  assigneeUserId?: string | null;

  customerId?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;

  /** In a search: where the words were found, when it was in a reply, note or the description rather than the title. */
  match?: { in: string; author: string; snippet: string };
  /** The first few device names on the ticket, and how many devices it has. */
  deviceNames?: string[];
  deviceCount?: number;

  // tolerate extra fields
  [k: string]: any;
};

/** In a search: the words around the match, and whose reply or note they were in. */
function MatchLine({ match, wrap }: { match?: Ticket["match"]; wrap?: boolean }) {
  if (!match) return null;
  const label =
    match.in === "description" ? "In the description" : match.in === "device" ? "On the device" : match.in === "requester" ? "Asked by" : `In a ${match.in}${match.author ? ` by ${match.author}` : ""}`;
  return (
    <div className={`mt-0.5 whitespace-normal text-xs text-muted-foreground ${wrap ? "break-words" : "line-clamp-2"}`} title={match.snippet}>
      <span className="font-medium">{label}:</span> {match.snippet}
    </div>
  );
}

/** The devices on a ticket: the first few names and how many more. */
function DeviceLine({ names, count }: { names?: string[]; count?: number }) {
  if (!names || names.length === 0) return null;
  const more = (count ?? names.length) - names.length;
  return (
    <div className="mt-0.5 truncate text-xs text-muted-foreground" title={names.join(", ")}>
      {names.join(", ")}{more > 0 ? ` +${more} more` : ""}
    </div>
  );
}

type Renderer = (value?: string | null) => React.ReactNode;

type TicketsTableProps =
  | {
    items: Ticket[];
    loading?: boolean;
    showCustomer?: boolean;
    renderStatus?: Renderer;
    renderPriority?: Renderer;
  }
  | {
    items: { items?: Ticket[] } | { data?: Ticket[] } | unknown;
    loading?: boolean;
    showCustomer?: boolean;
    renderStatus?: Renderer;
    renderPriority?: Renderer;
  };

/** Normalize whatever we get into a Ticket[] */
function toArray(input: any): Ticket[] {
  if (Array.isArray(input)) return input as Ticket[];
  if (input && typeof input === "object") {
    if (Array.isArray((input as any).items)) return (input as any).items as Ticket[];
    if (Array.isArray((input as any).data)) return (input as any).data as Ticket[];
  }
  return [];
}

const API_BASE =
  (typeof process !== "undefined" && process.env.NEXT_PUBLIC_API_BASE) || "";

function url(path: string) {
  if (!API_BASE) return path;
  return `${API_BASE.replace(/\/+$/, "")}${path.startsWith("/") ? "" : "/"}${path}`;
}

function shortId(s: string) {
  return String(s ?? "").slice(0, 8);
}

function safeWhen(iso: string) {
  const d = new Date(iso);
  return isFinite(d.getTime()) ? d.toLocaleString() : "-";
}

/** "5 min ago", "3 h ago", "2 d ago"; older than a month falls back to the date. */
function ago(iso?: string | null): string {
  if (!iso) return "-";
  const t = new Date(iso).getTime();
  if (!isFinite(t)) return "-";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 30 * 86400) return `${Math.floor(s / 86400)} d ago`;
  return new Date(t).toLocaleDateString();
}

/** The ticket's ID as it was always shown: its short ID, or its number field if the API sends one under that name. */
function ticketLabel(t: Ticket): string {
  return String(t.number ?? String(t.id ?? "").slice(0, 8));
}

function Person({ name }: { name?: string | null }) {
  if (!name) return <span className="text-muted-foreground">Unassigned</span>;
  const initials = name.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase()).join("");
  return (
    <span className="inline-flex items-center gap-2">
      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/15 text-[10px] font-semibold text-primary">{initials || "?"}</span>
      <span className="max-w-[10rem] truncate">{name}</span>
    </span>
  );
}

function useUsersMap() {
  const [map, setMap] = React.useState<Record<string, string>>({});

  React.useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch(url("/api/users"), { credentials: "include" });
        if (!res.ok) return;
        const data = await res.json();
        const arr: any[] = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];

        const next: Record<string, string> = {};
        for (const u of arr) {
          const id = String(u?.id ?? "").trim();
          if (!id) continue;
          const label = String(u?.name || u?.fullName || u?.email || u?.username || id).trim();
          next[id] = label;
        }

        if (!cancelled) setMap(next);
      } catch {
        // ignore
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return map;
}

function getAssigneeId(t: Ticket): string | null {
  const id =
    (t.assigneeUserId ??
      (t as any).assignee_user_id ??
      (t as any).assigneeId ??
      (t as any).assignee_id ??
      null) as any;

  const v = String(id ?? "").trim();
  return v ? v : null;
}

function getAssigneeLabel(t: Ticket, usersMap: Record<string, string>): string | null {
  const direct = String(t.assignedTo ?? "").trim();
  if (direct) return direct;

  const id = getAssigneeId(t);
  if (!id) return null;

  return usersMap[id] ?? null;
}

const PRIORITY_RANK: Record<string, number> = { urgent: 5, high: 4, medium: 3, normal: 2, low: 1 };

export default function TicketsTable(props: TicketsTableProps) {
  const { loading, showCustomer, renderStatus, renderPriority } = props as any;
  const list = React.useMemo(() => toArray((props as any).items), [props]);

  const usersMap = useUsersMap();

  const renderStatusPill: Renderer =
    renderStatus ?? ((value?: string | null) => <StatusPill value={value?.toString()} />);

  const renderPriorityPill: Renderer =
    renderPriority ?? ((value?: string | null) => <PriorityPill value={value?.toString()} />);

  // Newest activity first, until someone sorts by something else.
  const [sorting, setSorting] = React.useState<SortingState>([{ id: "updated", desc: true }]);
  const [columnVisibility, setColumnVisibility] = React.useState<VisibilityState>({});
  const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>([]);

  const columns = React.useMemo<ColumnDef<Ticket>[]>(() => {
    const cols: ColumnDef<Ticket>[] = [
      {
        id: "number",
        accessorFn: (t) => {
          const n = Number(t.number ?? t.ticketNumber);
          return Number.isFinite(n) ? n : 0;
        },
        header: ({ column }) => <SortHeader column={column} label="#" />,
        cell: ({ row }) => <span className="font-mono text-xs text-muted-foreground">{ticketLabel(row.original)}</span>,
      },
      {
        id: "title",
        accessorFn: (t) => String(t.title ?? "").toLowerCase(),
        // A fixed-layout table takes column widths from the heading, so this one is given room for a title and the words found.
        meta: { headerClassName: "w-[26rem]", cellClassName: "whitespace-normal" },
        header: ({ column }) => <SortHeader column={column} label="Title" />,
        cell: ({ row }) => (
          <div className="min-w-0">
            <Link href={`/tickets/${row.original.id}`} className={`text-foreground hover:text-primary ${row.original.hasNewReply ? "font-semibold" : "font-medium"}`} title={row.original.title}>
              {row.original.title}
            </Link>
            {row.original.hasNewReply ? <NewReplyPill /> : null}
            <MatchLine match={row.original.match} />
            <DeviceLine names={row.original.deviceNames} count={row.original.deviceCount} />
          </div>
        ),
      },
    ];
    if (showCustomer) {
      cols.push({
        id: "customer",
        accessorFn: (t) => String(t.customerId ?? ""),
        header: ({ column }) => <SortHeader column={column} label="Customer" />,
        cell: ({ row }) => <span className="text-muted-foreground">{row.original.customerId ?? "-"}</span>,
      });
    }
    cols.push(
      {
        id: "status",
        accessorFn: (t) => String(t.status ?? "").toLowerCase(),
        header: ({ column }) => <SortHeader column={column} label="Status" />,
        cell: ({ row }) => renderStatusPill(row.original.status),
      },
      {
        id: "priority",
        // High and urgent first when sorted descending.
        accessorFn: (t) => PRIORITY_RANK[String(t.priority ?? "").toLowerCase()] ?? 0,
        header: ({ column }) => <SortHeader column={column} label="Priority" />,
        cell: ({ row }) => renderPriorityPill(row.original.priority),
      },
      {
        id: "requester",
        accessorFn: (t) => String(t.requesterName ?? t.requesterEmail ?? "").toLowerCase(),
        header: ({ column }) => <SortHeader column={column} label="Requester" />,
        cell: ({ row }) => {
          const name = row.original.requesterName ?? row.original.requesterEmail;
          return name ? <Person name={name} /> : <span className="text-muted-foreground">-</span>;
        },
      },
      {
        id: "assignee",
        accessorFn: (t) => (getAssigneeLabel(t, usersMap) ?? getAssigneeId(t) ?? "").toString().toLowerCase(),
        header: ({ column }) => <SortHeader column={column} label="Assignee" />,
        cell: ({ row }) => {
          const id = getAssigneeId(row.original);
          return <Person name={getAssigneeLabel(row.original, usersMap) ?? (id ? `User ${shortId(id)}` : null)} />;
        },
      },
      {
        id: "queue",
        accessorFn: (t) => String(t.queueName ?? "").toLowerCase(),
        header: ({ column }) => <SortHeader column={column} label="Queue" />,
        cell: ({ row }) => (row.original.queueName ? <span>{row.original.queueName}</span> : <span className="text-muted-foreground">-</span>),
      },
      {
        id: "sla",
        // Soonest due first when sorted ascending; tickets with no running clock go last.
        accessorFn: (t) => dueSortValue(t.sla),
        sortUndefined: "last",
        header: ({ column }) => <SortHeader column={column} label="SLA" />,
        cell: ({ row }) => <SlaBadge sla={row.original.sla} />,
      },
      {
        id: "updated",
        accessorFn: (t) => {
          const ms = t.updatedAt ? new Date(t.updatedAt).getTime() : 0;
          return Number.isFinite(ms) ? ms : 0;
        },
        header: ({ column }) => <SortHeader column={column} label="Updated" />,
        cell: ({ row }) => (
          <span className="text-muted-foreground" title={row.original.updatedAt ? safeWhen(row.original.updatedAt) : undefined}>
            {ago(row.original.updatedAt)}
          </span>
        ),
      },
      {
        id: "created",
        accessorFn: (t) => {
          const ms = t.createdAt ? new Date(t.createdAt).getTime() : 0;
          return Number.isFinite(ms) ? ms : 0;
        },
        header: ({ column }) => <SortHeader column={column} label="Created" />,
        cell: ({ row }) => (
          <span className="text-muted-foreground" title={row.original.createdAt ? safeWhen(row.original.createdAt) : undefined}>
            {ago(row.original.createdAt)}
          </span>
        ),
      },
    );
    return cols;
    // renderStatusPill / renderPriorityPill are rebuilt each render but only draw pills.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showCustomer, usersMap]);

  // Phones and tablets: one card per ticket, paged the same way.
  const cards = usePaged(list, "tickets-cards", 25);

  return (
    <div className="min-w-0">
      {loading && <p className="mb-2 text-xs text-muted-foreground">Loading…</p>}

      {/* Phones and tablets: one card per ticket */}
      <div className="overflow-hidden rounded-xl border border-border/70 bg-card backdrop-blur-sm lg:hidden">
        <ul className="divide-y divide-border/60">
          {cards.rows.map((t: any) => {
            const assigneeId = getAssigneeId(t);
            const assignee = getAssigneeLabel(t, usersMap) ?? (assigneeId ? `User ${shortId(assigneeId)}` : null);
            const requester = t.requesterName ?? t.requesterEmail;
            return (
              <li key={t.id}>
                <Link href={`/tickets/${t.id}`} className="block space-y-2 p-4 hover:bg-accent/50">
                  <div className="flex items-start justify-between gap-3">
                    <span className={`min-w-0 break-words text-sm ${t.hasNewReply ? "font-semibold" : "font-medium"}`}>{t.title}{t.hasNewReply ? <NewReplyPill /> : null}</span>
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">{ticketLabel(t)}</span>
                  </div>
                  <MatchLine match={t.match} wrap />
                  <DeviceLine names={t.deviceNames} count={t.deviceCount} />
                  <div className="flex flex-wrap items-center gap-2">
                    {renderStatusPill(t.status)}
                    {renderPriorityPill(t.priority)}
                  </div>
                  <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                    {showCustomer && t.customerId ? (<><dt>Customer</dt><dd className="truncate">{t.customerId}</dd></>) : null}
                    {requester ? (<><dt>Requester</dt><dd className="truncate">{requester}</dd></>) : null}
                    <dt>Assignee</dt>
                    <dd className="truncate">{assignee ?? "Unassigned"}</dd>
                    {t.updatedAt ? (<><dt>Updated</dt><dd className="truncate">{ago(t.updatedAt)}</dd></>) : null}
                  </dl>
                </Link>
              </li>
            );
          })}
          {!loading && cards.total === 0 && <li className="p-8 text-center text-sm text-muted-foreground">No tickets found.</li>}
        </ul>
        <div className="border-t border-border/60 px-4 py-3">
          <Pager paged={cards} noun="tickets" />
        </div>
      </div>

      {/* Laptops and up: sortable, reorderable columns, show/hide, rows per page */}
      <div className="hidden lg:block">
        <DataTable<Ticket, unknown>
          columns={columns}
          data={list}
          sorting={sorting}
          setSorting={setSorting}
          columnVisibility={columnVisibility}
          setColumnVisibility={setColumnVisibility}
          columnFilters={columnFilters}
          setColumnFilters={setColumnFilters}
          orderStorageKey="tickets"
          defaultPageSize={25}
        />
      </div>
    </div>
  );
}
