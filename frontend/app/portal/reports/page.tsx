"use client";

import * as React from "react";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { portal, type PortalReport } from "@/lib/portal-api";
import { Empty, PageTitle, Panel, useLoad } from "../parts";
import { usePortalMe } from "../portal-shell";

const RANGES = [
    { days: 30, label: "Last 30 days" },
    { days: 90, label: "Last 90 days" },
    { days: 180, label: "Last 6 months" },
    { days: 365, label: "Last year" },
];

function ReportCard({ r }: { r: PortalReport }) {
    const [days, setDays] = React.useState(r.defaultDays);
    return (
        <Panel className="flex flex-col gap-3 p-5">
            <div>
                <h2 className="font-medium">{r.title}</h2>
                <p className="mt-1 text-sm text-muted-foreground">{r.description}</p>
            </div>
            <div className="mt-auto flex flex-wrap items-center gap-2">
                <label className="sr-only" htmlFor={`range-${r.key}`}>Period for {r.title}</label>
                <select id={`range-${r.key}`} value={days} onChange={(e) => setDays(Number(e.target.value))} className="h-10 rounded-md border border-input bg-background px-3 text-sm">
                    {RANGES.map((x) => <option key={x.days} value={x.days}>{x.label}</option>)}
                </select>
                <Button asChild className="gap-1.5">
                    <a href={`/api/portal/reports/${r.key}/pdf?days=${days}`}><Download className="h-4 w-4" aria-hidden />Download PDF</a>
                </Button>
            </div>
        </Panel>
    );
}

export default function PortalReports() {
    const { me } = usePortalMe();
    const { data, error } = useLoad(() => portal<PortalReport[]>("/reports"));
    if (!me.modules.includes("reports")) return <Empty>This area is not available to you.</Empty>;
    return (
        <div>
            <PageTitle title="Reports" />
            <p className="mb-4 text-sm text-muted-foreground">Reports about {me.customer}&apos;s devices, made when you download them.</p>
            {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
            {!data && !error ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
            {data && data.length === 0 ? <Empty>No reports are available.</Empty> : null}
            <div className="grid gap-4 sm:grid-cols-2">{(data ?? []).map((r) => <ReportCard key={r.key} r={r} />)}</div>
        </div>
    );
}
