"use client";

import * as React from "react";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { portal, when, type PortalDevice } from "@/lib/portal-api";
import { Empty, PageTitle, Panel, Pill, useLoad } from "../parts";
import { usePortalMe } from "../portal-shell";

export default function PortalDevices() {
    const { me } = usePortalMe();
    const [q, setQ] = React.useState("");
    const { data, error } = useLoad(() => portal<PortalDevice[]>("/devices"));
    if (!me.modules.includes("devices")) return <Empty>This area is not available to you.</Empty>;

    const needle = q.trim().toLowerCase();
    const rows = (data ?? []).filter((d) => !needle || [d.name, d.user, d.site, d.os].some((v) => String(v ?? "").toLowerCase().includes(needle)));
    const online = (data ?? []).filter((d) => d.online).length;

    return (
        <div>
            <PageTitle title="Devices">
                {data ? <span className="text-sm text-muted-foreground">{data.length} {data.length === 1 ? "device" : "devices"}, {online} online</span> : null}
            </PageTitle>
            <div className="relative mb-3 w-full sm:w-72">
                <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden />
                <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search devices…" aria-label="Search devices" className="pl-8" />
            </div>
            {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
            {!data && !error ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
            {data && rows.length === 0 ? <Empty>{q ? "No device matches your search." : "No devices yet."}</Empty> : null}
            {rows.length > 0 ? (
                <Panel className="overflow-x-auto">
                    <table className="w-full min-w-[640px] text-sm">
                        <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                            <tr>{["Device", "Status", "Location", "Main user", "Operating system", "Last seen"].map((h) => <th key={h} scope="col" className="px-4 py-2 font-medium">{h}</th>)}</tr>
                        </thead>
                        <tbody className="divide-y">
                            {rows.map((d) => (
                                <tr key={d.id}>
                                    <td className="px-4 py-3 font-medium">{d.name}</td>
                                    <td className="px-4 py-3"><Pill tone={d.online ? "online" : "offline"}>{d.online ? "Online" : "Offline"}</Pill></td>
                                    <td className="px-4 py-3 text-muted-foreground">{d.site}</td>
                                    <td className="px-4 py-3 text-muted-foreground">{d.user ?? "—"}</td>
                                    <td className="px-4 py-3 text-muted-foreground">{d.os ?? "—"}</td>
                                    <td className="px-4 py-3 text-muted-foreground">{when(d.lastSeen)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </Panel>
            ) : null}
        </div>
    );
}
