// lib/use-devices.ts
"use client";

// Devices are never loaded wholesale: the server counts them (useDeviceCounts) and hands out one page at a time,
// filtered and sorted (useDevicePage), so a system with many thousands of devices behaves like one with a few.
import * as React from "react";
import { AGENT_UPDATED_EVENT } from "@/lib/agent-update-tracker";
import { DEVICES_CHANGED_EVENT } from "@/lib/device-move";
import { CUSTOMERS_CHANGED_EVENT, fetchDeviceCounts, fetchDevices } from "./api";
import type { Device, DeviceCounts, DeviceFilters, DeviceSortKey } from "./api";

/** Your dashboard context uses lowercase statuses */
export type DeviceStatus = "healthy" | "warning" | "critical" | "offline";

/** UI-side filters coming from your rail/dashboard context */
export type UiFilters = {
  q?: string;
  status?: DeviceStatus[];                  // lowercase, matches your context
  os?: Array<"Windows" | "Linux" | "macOS">;
  tags?: string[];                          // tag ids
};

/** The rail's choices as the server's filters. Online and offline both ticked means no status filter. */
export function toBackendFilters(ui?: UiFilters): DeviceFilters {
  if (!ui) return {};

  const offline = ui.status?.includes("offline");
  const anyOnline = (ui.status ?? []).some((s) => s === "healthy" || s === "warning" || s === "critical");

  const status = offline && anyOnline ? undefined : offline ? "offline" : anyOnline ? "online" : undefined;
  const os = (ui.os ?? []).map((o) => o.toLowerCase());

  return {
    q: ui.q || undefined,
    status,
    os: os.length ? os : undefined,
    tags: ui.tags?.length ? ui.tags : undefined,
  };
}

/** Something about devices changed elsewhere (a move, an agent update, a customer edit): refetch. */
function useDevicesChanged(onChange: () => void) {
  const ref = React.useRef(onChange);
  ref.current = onChange;
  React.useEffect(() => {
    const again = () => ref.current();
    for (const e of [AGENT_UPDATED_EVENT, DEVICES_CHANGED_EVENT, CUSTOMERS_CHANGED_EVENT]) window.addEventListener(e, again);
    return () => {
      for (const e of [AGENT_UPDATED_EVENT, DEVICES_CHANGED_EVENT, CUSTOMERS_CHANGED_EVENT]) window.removeEventListener(e, again);
    };
  }, []);
}

/** Device counts for some filters. `version` changes to ask for a fresh count. */
export function useDeviceCounts(filters: DeviceFilters, version = 0) {
  const key = JSON.stringify(filters);
  const [counts, setCounts] = React.useState<DeviceCounts | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [tick, setTick] = React.useState(0);
  useDevicesChanged(() => setTick((n) => n + 1));

  React.useEffect(() => {
    const ac = new AbortController();
    setLoading(true);
    fetchDeviceCounts(JSON.parse(key) as DeviceFilters, { signal: ac.signal })
      .then((c) => {
        if (ac.signal.aborted) return;
        setCounts(c);
        setError(null);
      })
      .catch((e) => {
        if (ac.signal.aborted || e?.name === "AbortError") return;
        setError(e?.message ?? "Could not count devices.");
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoading(false);
      });
    return () => ac.abort();
  }, [key, version, tick]);

  return { counts, loading, error };
}

export type DevicePageOptions = {
  filters: DeviceFilters;
  sort?: DeviceSortKey;
  dir?: "asc" | "desc";
  pageIndex: number;
  pageSize: number;
  version?: number;
};

/** One page of devices (and how many match in all), filtered and sorted by the server. The old page stays until the new one arrives. */
export function useDevicePage({ filters, sort, dir, pageIndex, pageSize, version = 0 }: DevicePageOptions) {
  const key = JSON.stringify({ filters, sort, dir, pageIndex, pageSize });
  const [items, setItems] = React.useState<Device[]>([]);
  const [total, setTotal] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [tick, setTick] = React.useState(0);
  useDevicesChanged(() => setTick((n) => n + 1));

  React.useEffect(() => {
    const ac = new AbortController();
    const o = JSON.parse(key) as { filters: DeviceFilters; sort?: DeviceSortKey; dir?: "asc" | "desc"; pageIndex: number; pageSize: number };
    setLoading(true);
    fetchDevices(o.pageSize, null, o.filters, { sort: o.sort, dir: o.dir, offset: o.pageIndex * o.pageSize, total: true }, { signal: ac.signal })
      .then((r) => {
        if (ac.signal.aborted) return;
        setItems(r.items);
        setTotal(r.total ?? r.items.length);
        setError(null);
      })
      .catch((e) => {
        if (ac.signal.aborted || e?.name === "AbortError") return;
        setError(e?.message ?? "Could not load devices.");
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoading(false);
      });
    return () => ac.abort();
  }, [key, version, tick]);

  return { items, total, loading, error };
}
