"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";
import TicketsTable, { Ticket } from "@/components/tickets-table";
import { Input } from "@/components/ui/input";
import { Plus } from "lucide-react";
import { FilterSelect, ListToolbar, SearchField, SegmentedTabs } from "@/components/list-controls";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { PageHeader, PageShell } from "@/components/page-shell";
import { Textarea } from "@/components/ui/textarea";
import { QueueSelect, SlaNotices, useServiceDeskFilters } from "@/components/tickets/service-desk-bits";
import DeviceSearchPicker, { type PickedDevice } from "@/components/tickets/device-search-picker";
import ContactPicker, { type TicketContact } from "@/components/tickets/contact-picker";
import { TicketFieldInputs, fieldProblems, useTicketFieldDefs, valuesFromSaved, valuesToBody, type FieldValues } from "@/components/tickets/ticket-custom-fields";

const API = process.env.NEXT_PUBLIC_API_BASE || "";

function normalizeTicketsPayload(payload: any): Ticket[] {
  if (Array.isArray(payload)) return payload as Ticket[];
  if (payload && Array.isArray(payload.items)) return payload.items as Ticket[];
  return [];
}

export default function TicketsPage() {
  const router = useRouter();
  const [all, setAll] = React.useState<Ticket[]>([]);
  const [loading, setLoading] = React.useState(true);

  const [q, setQ] = React.useState("");
  const [statusTab, setStatusTab] = React.useState("all");
  const [priority, setPriority] = React.useState("all");

  // Modals
  const [newOpen, setNewOpen] = React.useState(false);
  const [exportOpen, setExportOpen] = React.useState(false);

  // New ticket form
  const [ntTitle, setNtTitle] = React.useState("");
  const [ntDesc, setNtDesc] = React.useState("");
  const [ntBusy, setNtBusy] = React.useState(false);
  const [ntClient, setNtClient] = React.useState("");
  // Who asked (one of the customer's contacts) and the devices the ticket is about. A device is the customer's, so it also picks the customer.
  const [ntContact, setNtContact] = React.useState<TicketContact | null>(null);
  const [ntDevices, setNtDevices] = React.useState<PickedDevice[]>([]);
  const [ntPickContact, setNtPickContact] = React.useState(false);
  const [ntPickDevice, setNtPickDevice] = React.useState(false);
  // The list narrowed to one device or one contact (from the device page, a contact's page or the filter buttons below).
  const searchParams = useSearchParams();
  const [deviceFilter, setDeviceFilter] = React.useState<{ id: string; name: string } | null>(null);
  const [contactFilter, setContactFilter] = React.useState<{ id: string; name: string } | null>(null);
  const [devFilterOpen, setDevFilterOpen] = React.useState(false);
  // Queue, whose tickets and SLA state: asked of the server, which counts them and looks through all tickets.
  const sd = useServiceDeskFilters();
  const [ntQueue, setNtQueue] = React.useState("");
  const relQuery = (sd.qs ? `&${sd.qs}` : "") + (deviceFilter ? `&deviceId=${encodeURIComponent(deviceFilter.id)}` : "") + (contactFilter ? `&contactId=${encodeURIComponent(contactFilter.id)}` : "");
  const fieldDefs = useTicketFieldDefs();
  const [ntFields, setNtFields] = React.useState<FieldValues>({});
  const [ntTried, setNtTried] = React.useState(false);
  // Templates (Administration > Templates): picking one fills the form, which can still be changed before it is created.
  type TicketTemplate = { id: string; name: string; hint: string; subject: string; body: string; priority: string; customFields: Record<string, unknown> };
  const [templates, setTemplates] = React.useState<TicketTemplate[]>([]);
  const [ntTemplate, setNtTemplate] = React.useState("");
  React.useEffect(() => {
    if (!newOpen) return;
    fetch(`${API}/api/ticket-templates`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : { items: [] }))
      .then((r) => setTemplates(Array.isArray(r?.items) ? r.items : []))
      .catch(() => setTemplates([]));
  }, [newOpen]);
  function pickTemplate(id: string) {
    setNtTemplate(id);
    const t = templates.find((x) => x.id === id);
    if (!t) return;
    if (t.subject) setNtTitle(t.subject);
    if (t.body) setNtDesc(t.body);
    setNtFields(valuesFromSaved(t.customFields, fieldDefs));
  }
  const [ntError, setNtError] = React.useState<string | null>(null);
  const ntProblems = ntTried ? fieldProblems(fieldDefs, ntFields) : {};

  // Links from other pages: a device's "Create ticket" opens the form filled in (customer, device, "Issue on HOSTNAME");
  // a device's or a contact's ticket list narrows this list.
  const linkApplied = React.useRef(false);
  React.useEffect(() => {
    if (linkApplied.current) return;
    linkApplied.current = true;
    const sp = searchParams;
    if (!sp) return;
    const dev = sp.get("deviceId");
    const con = sp.get("contactId");
    if (sp.get("new") === "1") {
      const name = sp.get("deviceName") || "";
      const customer = sp.get("customerName") || "";
      const site = sp.get("siteName") || "";
      if (sp.get("clientId")) setNtClient(sp.get("clientId")!);
      if (dev) setNtDevices([{ id: dev, hostname: name || dev, os: "", client: customer || null, site: site || null, clientId: sp.get("clientId") }]);
      if (name) setNtTitle(`Issue on ${name}`);
      if (name) setNtDesc(`Device: ${name}${customer || site ? ` (${[customer, site].filter(Boolean).join(" / ")})` : ""}\n\n`);
      setNewOpen(true);
      // The form is open: the address no longer asks for it again on reload.
      window.history.replaceState(null, "", "/tickets");
    } else {
      if (dev) setDeviceFilter({ id: dev, name: sp.get("deviceName") || "this device" });
      if (con) setContactFilter({ id: con, name: sp.get("contactName") || "this contact" });
    }
  }, [searchParams]);

  // Filter by one custom field: the server finds the tickets, in any age.
  const [cfKey, setCfKey] = React.useState("");
  const [cfValue, setCfValue] = React.useState("");
  const [cfHits, setCfHits] = React.useState<Ticket[] | null>(null);
  const cfDef = fieldDefs.find((d) => d.key === cfKey);
  React.useEffect(() => {
    setCfHits(null);
    if (!cfKey || !cfValue.trim()) return;
    const ac = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const res = await fetch(`${API}/api/tickets?customField=${encodeURIComponent(cfKey)}&customValue=${encodeURIComponent(cfValue.trim())}&pageSize=200${relQuery}`, { credentials: "include", signal: ac.signal });
        if (res.ok) setCfHits(normalizeTicketsPayload(await res.json()));
      } catch {
        /* the list stays as it was */
      }
    }, 250);
    return () => {
      window.clearTimeout(timer);
      ac.abort();
    };
  }, [cfKey, cfValue, relQuery]);
  const [customers, setCustomers] = React.useState<{ id: string; name: string }[]>([]);
  React.useEffect(() => {
    if (!newOpen || customers.length) return;
    fetch(`${API}/api/customers`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: any[]) => setCustomers((Array.isArray(rows) ? rows : []).filter((c) => c?.key && c?.name).map((c) => ({ id: String(c.key), name: String(c.name) })).sort((a, b) => a.name.localeCompare(b.name))))
      .catch(() => setCustomers([]));
  }, [newOpen, customers.length]);

  React.useEffect(() => {
    let cancel = false;
    const load = async (silent: boolean) => {
      try {
        if (!silent) setLoading(true);
        // The newest 200, not the server's default of 25. Searching asks the server, which looks through all of them.
        const res = await fetch(`${API}/api/tickets?pageSize=200${relQuery}`, { credentials: "include" });
        const raw = res.ok ? await res.json() : [];
        const data = normalizeTicketsPayload(raw);
        if (!cancel && (!silent || res.ok)) setAll(data);
      } catch {
        /* a failed refresh keeps what is shown */
      } finally {
        if (!cancel && !silent) setLoading(false);
      }
    };
    void load(false);
    // New customer replies show up without reloading.
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load(true);
    }, 30_000);
    return () => {
      cancel = true;
      clearInterval(timer);
    };
  }, [relQuery]);

  // Searching asks the server, so words inside replies and private notes are found too, in tickets of any age.
  const [searchHits, setSearchHits] = React.useState<Ticket[] | null>(null);
  React.useEffect(() => {
    const term = q.trim();
    setSearchHits(null);
    if (term.length < 2) return;
    const ac = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const res = await fetch(`${API}/api/tickets?search=${encodeURIComponent(term)}&pageSize=200${relQuery}`, { credentials: "include", signal: ac.signal });
        if (res.ok) setSearchHits(normalizeTicketsPayload(await res.json()));
      } catch {
        /* the title filter below keeps working */
      }
    }, 250);
    return () => {
      window.clearTimeout(timer);
      ac.abort();
    };
  }, [q, relQuery]);

  const counts = React.useMemo(() => {
    const c: Record<string, number> = { all: all.length };
    for (const t of all as any[]) {
      const s = String(t?.status ?? "").toLowerCase();
      c[s] = (c[s] ?? 0) + 1;
    }
    return c;
  }, [all]);

  const filtered = React.useMemo(() => {
    const needle = q.trim().toLowerCase();
    const serverMatched = needle.length >= 2 && searchHits !== null && cfHits === null;
    const base = ((cfHits ?? (serverMatched ? searchHits : all)) as any[]).filter(
      (t) =>
        (statusTab === "all" || String(t?.status ?? "").toLowerCase() === statusTab) &&
        (priority === "all" || String(t?.priority ?? "").toLowerCase() === priority),
    );
    if (!needle || serverMatched) return base;

    return base.filter((t: any) => {
      const idPrefix = String(t?.id ?? "").slice(0, 8).toLowerCase();
      const num = String(t?.number ?? t?.ticketNumber ?? "").toLowerCase().replace(/^#/, "");
      const title = String(t?.title ?? "").toLowerCase();
      const status = String(t?.status ?? "").toLowerCase();
      const priority = String(t?.priority ?? "").toLowerCase();

      return (
        idPrefix.includes(needle.replace(/^#/, "")) ||
        num.includes(needle.replace(/^#/, "")) ||
        title.includes(needle) ||
        status.includes(needle) ||
        priority.includes(needle)
      );
    });
  }, [all, q, statusTab, priority, searchHits, cfHits]);

  const btnBase =
    "font-semibold rounded-md transition-all duration-150 focus:outline-none focus:ring-2 focus:ring-offset-2 inline-flex items-center justify-center ring-offset-white dark:ring-offset-zinc-950";
  const btnPrimary =
    "bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] hover:bg-[hsl(var(--primary))]/90 focus:ring-[hsl(var(--primary))]";

  async function handleCreateTicket() {
    if (!ntTitle.trim()) return;
    setNtTried(true);
    setNtError(null);
    if (Object.keys(fieldProblems(fieldDefs, ntFields)).length > 0) return;
    try {
      setNtBusy(true);
      const res = await fetch(`${API}/api/tickets`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: ntTitle.trim(), description: ntDesc, ...(ntTemplate ? { templateId: ntTemplate } : {}), ...(ntClient ? { clientId: ntClient } : {}), ...(ntQueue ? { queueId: ntQueue } : {}), ...(ntContact ? { requesterCustomerContactId: ntContact.id } : {}), ...(ntDevices.length ? { deviceId: ntDevices[0].id, ...(ntDevices.length > 1 ? { deviceIds: ntDevices.slice(1).map((d) => d.id) } : {}) } : {}), ...(fieldDefs.length ? { customFields: valuesToBody(fieldDefs, ntFields) } : {}) }),
      });
      if (!res.ok) {
        let text = `Create failed (${res.status})`;
        try {
          const j = await res.json();
          const m = Array.isArray(j?.message) ? j.message.join(" ") : j?.message;
          if (m) text = String(m);
        } catch {
          /* keep the status */
        }
        throw new Error(text);
      }
      const created = await res.json();
      setNewOpen(false);
      setNtTitle("");
      setNtDesc("");
      setNtClient("");
      setNtQueue("");
      setNtContact(null);
      setNtDevices([]);
      setNtFields({});
      setNtTried(false);
      setNtTemplate("");
      if (created?.id) router.push(`/tickets/${created.id}`);
      else router.refresh();
    } catch (e) {
      setNtError((e as any)?.message ?? String(e));
    } finally {
      setNtBusy(false);
    }
  }

  async function handleExport() {
    setExportOpen(false);
    const rows = filtered.map((t: any) => ({
      id: t.id,
      number: t.number ?? t.ticketNumber ?? t.id?.slice?.(0, 8),
      title: t.title,
      status: t.status,
      priority: t.priority ?? "",
      requester: t.requesterName ?? t.requesterEmail ?? "",
      updatedAt: t.updatedAt ?? "",
      custom: fieldDefs.map((d) => {
        const v = t.customFields?.[d.key];
        return v === undefined || v === null ? "" : d.type === "checkbox" ? (v === true ? "Yes" : "No") : String(v);
      }),
    }));
    const csv = [
      ["id", "number", "title", "status", "priority", "requester", "updatedAt", ...fieldDefs.map((d) => d.label)].map((x) => `"${String(x).replace(/"/g, '""')}"`).join(","),
      ...rows.map((r) =>
        [r.id, r.number, r.title, r.status, r.priority, r.requester, r.updatedAt, ...r.custom]
          .map((x) => `"${String(x).replace(/"/g, '""')}"`)
          .join(",")
      ),
    ].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "tickets.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  const TABS: { key: string; label: string }[] = [
    { key: "all", label: "All" },
    { key: "open", label: "Open" },
    { key: "in_progress", label: "In progress" },
    { key: "pending", label: "Pending" },
    { key: "resolved", label: "Resolved" },
    { key: "closed", label: "Closed" },
  ];

  return (
    <PageShell as="div">
      <PageHeader
        title="Tickets"
        description={
          loading
            ? "Loading..."
            : `${counts.open ?? 0} open, ${(counts.in_progress ?? 0) + (counts.pending ?? 0)} in progress or waiting, ${all.length} in total.`
        }
        actions={
          <>
            <Button variant="outline" onClick={() => setExportOpen(true)}>
              Export
            </Button>
            <Button onClick={() => setNewOpen(true)} className="gap-1.5">
              <Plus className="h-4 w-4" aria-hidden="true" />
              New ticket
            </Button>
          </>
        }
      />

      <SlaNotices />

      <ListToolbar
        left={<SegmentedTabs label="Filter by status" value={statusTab} onChange={setStatusTab} items={TABS.map((t) => ({ key: t.key, label: t.label, count: counts[t.key] ?? 0 }))} />}
        right={
          <>
            {sd.controls}
            <Button type="button" variant={deviceFilter ? "secondary" : "outline"} className="h-9" onClick={() => setDevFilterOpen(true)} title="Show only the tickets that have a device on them">
              {deviceFilter ? `Device: ${deviceFilter.name}` : "Device"}
            </Button>
            {deviceFilter ? (
              <Button type="button" variant="ghost" className="h-9 px-2" aria-label="Clear the device filter" onClick={() => setDeviceFilter(null)}>
                ✕
              </Button>
            ) : null}
            {contactFilter ? (
              <Button type="button" variant="secondary" className="h-9 gap-1" title="Clear the contact filter" onClick={() => setContactFilter(null)}>
                Asked by {contactFilter.name} ✕
              </Button>
            ) : null}
            <FilterSelect
              label="Filter by priority"
              value={priority}
              onChange={setPriority}
              options={[
                { value: "all", label: "Any priority" },
                { value: "urgent", label: "Urgent" },
                { value: "high", label: "High" },
                { value: "medium", label: "Medium" },
                { value: "normal", label: "Normal" },
                { value: "low", label: "Low" },
              ]}
            />
            {fieldDefs.length > 0 ? (
              <>
                <FilterSelect
                  label="Filter by a custom field"
                  value={cfKey || "none"}
                  onChange={(v) => { setCfKey(v === "none" ? "" : v); setCfValue(""); }}
                  options={[{ value: "none", label: "Custom field" }, ...fieldDefs.map((d) => ({ value: d.key, label: d.label }))]}
                />
                {cfDef ? (
                  cfDef.type === "dropdown" ? (
                    <FilterSelect
                      label={`${cfDef.label} is`}
                      value={cfValue || "any"}
                      onChange={(v) => setCfValue(v === "any" ? "" : v)}
                      options={[{ value: "any", label: "Choose…" }, ...cfDef.options.map((o) => ({ value: o, label: o }))]}
                    />
                  ) : cfDef.type === "checkbox" ? (
                    <FilterSelect
                      label={`${cfDef.label} is`}
                      value={cfValue || "any"}
                      onChange={(v) => setCfValue(v === "any" ? "" : v)}
                      options={[{ value: "any", label: "Choose…" }, { value: "true", label: "Yes" }]}
                    />
                  ) : (
                    <Input value={cfValue} onChange={(e) => setCfValue(e.target.value)} placeholder={`${cfDef.label} is…`} aria-label={`${cfDef.label} is`} className="h-9 w-40" />
                  )
                ) : null}
              </>
            ) : null}
            <SearchField value={q} onChange={setQ} placeholder="Search tickets" />
          </>
        }
      />

      <TicketsTable items={filtered} loading={loading} />

      <Dialog open={newOpen} onOpenChange={setNewOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Create ticket</DialogTitle>
            <DialogDescription>Enter a title and optional description.</DialogDescription>
          </DialogHeader>
          {templates.length > 0 ? (
            <div className="grid gap-1">
              <label htmlFor="nt-template" className="text-xs text-muted-foreground">Start from a template</label>
              <select id="nt-template" value={ntTemplate} onChange={(e) => pickTemplate(e.target.value)} className="h-10 rounded-md border border-input bg-background px-3 text-sm">
                <option value="">No template</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}{t.hint ? ` - ${t.hint}` : ""}</option>
                ))}
              </select>
            </div>
          ) : null}
          <Input value={ntTitle} onChange={(e) => setNtTitle(e.target.value)} placeholder="Ticket title" autoFocus />
          <div className="grid gap-1">
            <label htmlFor="nt-customer" className="text-xs text-muted-foreground">Customer (so they can see it in the client portal)</label>
            <select
              id="nt-customer"
              value={ntClient}
              onChange={(e) => {
                const next = e.target.value;
                setNtClient(next);
                // The contact and the devices are the customer's: those of another customer are dropped.
                setNtContact((c) => (c && c.clientId === next ? c : null));
                setNtDevices((list) => list.filter((d) => !d.clientId || d.clientId === next));
              }}
              className="h-10 rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="">No customer</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
          <div className="grid gap-1">
            <span className="text-xs text-muted-foreground">Who asked</span>
            {ntContact ? (
              <div className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
                <span className="min-w-0 truncate"><span className="font-medium">{ntContact.name}</span>{ntContact.email ? <span className="text-muted-foreground"> · {ntContact.email}</span> : null}</span>
                <button type="button" className="text-xs text-muted-foreground hover:text-foreground hover:underline" onClick={() => setNtContact(null)}>Remove</button>
              </div>
            ) : ntPickContact ? (
              <div className="rounded-md border p-2">
                <ContactPicker clientId={ntClient || null} idPrefix="nt-contact" autoFocus onPick={(c) => { setNtContact(c); setNtPickContact(false); }} />
                <div className="mt-2 flex justify-end"><Button type="button" variant="ghost" size="sm" onClick={() => setNtPickContact(false)}>Cancel</Button></div>
              </div>
            ) : (
              <div>
                <Button type="button" variant="outline" size="sm" disabled={!ntClient} title={ntClient ? undefined : "Choose the customer first"} onClick={() => setNtPickContact(true)}>Choose a contact</Button>
                {!ntClient ? <span className="ml-2 text-xs text-muted-foreground">Choose the customer first.</span> : <span className="ml-2 text-xs text-muted-foreground">Replies by email go to them.</span>}
              </div>
            )}
          </div>
          <div className="grid gap-1">
            <span className="text-xs text-muted-foreground">Devices</span>
            {ntDevices.length > 0 ? (
              <ul className="grid gap-1">
                {ntDevices.map((d) => (
                  <li key={d.id} className="flex items-center justify-between gap-2 rounded-md border px-3 py-1.5 text-sm">
                    <span className="min-w-0 truncate"><span className="font-medium">{d.hostname}</span>{[d.client, d.site].filter(Boolean).length ? <span className="text-muted-foreground"> · {[d.client, d.site].filter(Boolean).join(" / ")}</span> : null}</span>
                    <button type="button" className="text-xs text-muted-foreground hover:text-foreground hover:underline" onClick={() => setNtDevices((l) => l.filter((x) => x.id !== d.id))}>Remove</button>
                  </li>
                ))}
              </ul>
            ) : null}
            {ntPickDevice ? (
              <div className="rounded-md border p-2">
                <DeviceSearchPicker
                  clientId={ntClient || null}
                  excludeIds={ntDevices.map((d) => d.id)}
                  idPrefix="nt-device"
                  autoFocus
                  onPick={(d) => {
                    setNtDevices((l) => [...l, d]);
                    // A device is its customer's: it picks the customer when none is chosen, and names the ticket when it has no title yet.
                    if (!ntClient && d.clientId) setNtClient(d.clientId);
                    setNtTitle((t) => (t.trim() ? t : `Issue on ${d.hostname}`));
                    setNtPickDevice(false);
                  }}
                />
                <div className="mt-2 flex justify-end"><Button type="button" variant="ghost" size="sm" onClick={() => setNtPickDevice(false)}>Cancel</Button></div>
              </div>
            ) : (
              <div>
                <Button type="button" variant="outline" size="sm" onClick={() => setNtPickDevice(true)}>{ntDevices.length ? "Add another device" : "Add a device"}</Button>
                <span className="ml-2 text-xs text-muted-foreground">{ntClient ? "Only this customer's devices are listed." : "Optional. Searches all devices."}</span>
              </div>
            )}
          </div>
          <QueueSelect value={ntQueue} onChange={setNtQueue} queues={sd.queues} />
          <Textarea
            value={ntDesc}
            onChange={(e) => setNtDesc(e.target.value)}
            placeholder="Description (optional)"
            className="min-h-[120px]"
          />
          {fieldDefs.length > 0 ? (
            <div className="max-h-64 overflow-y-auto rounded-md border p-3">
              <TicketFieldInputs defs={fieldDefs} values={ntFields} errors={ntProblems} idPrefix="nt-cf" onChange={(k, v) => setNtFields((cur) => ({ ...cur, [k]: v }))} />
            </div>
          ) : null}
          {ntError ? <p role="alert" className="text-sm text-destructive">{ntError}</p> : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewOpen(false)}>
              Cancel
            </Button>
            <Button className={cn(btnPrimary)} disabled={ntBusy} onClick={handleCreateTicket}>
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={devFilterOpen} onOpenChange={setDevFilterOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Tickets for a device</DialogTitle>
            <DialogDescription>Choose a device to see only the tickets that have it on them.</DialogDescription>
          </DialogHeader>
          <DeviceSearchPicker idPrefix="tf-device" autoFocus onPick={(d) => { setDeviceFilter({ id: d.id, name: d.hostname }); setDevFilterOpen(false); }} />
          <DialogFooter>
            {deviceFilter ? <Button variant="outline" onClick={() => { setDeviceFilter(null); setDevFilterOpen(false); }}>Show all devices</Button> : null}
            <Button variant="outline" onClick={() => setDevFilterOpen(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={exportOpen} onOpenChange={setExportOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Export tickets</DialogTitle>
            <DialogDescription>Export the current list to CSV?</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setExportOpen(false)}>
              Cancel
            </Button>
            <Button className={cn(btnPrimary)} onClick={handleExport}>
              Export
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}