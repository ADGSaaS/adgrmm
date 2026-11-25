// app/(dashboard)/billing/page.tsx
"use client";

import { PageHeader, PageShell } from "@/components/page-shell";
import * as React from "react";
import { SegmentedTabs } from "@/components/list-controls";
import DocumentsTab from "@/components/billing/documents-tab";
import { CatalogTab, ContractsTab, ReportsTab, SettingsTab, TimeTab } from "@/components/billing/other-tabs";

const TABS = [
    { value: "invoices", label: "Invoices" },
    { value: "quotes", label: "Quotes" },
    { value: "contracts", label: "Contracts" },
    { value: "time", label: "Time" },
    { value: "catalog", label: "Catalog" },
    { value: "reports", label: "Reports" },
    { value: "settings", label: "Settings" },
] as const;

export default function BillingPage() {
    const [tab, setTab] = React.useState<(typeof TABS)[number]["value"]>("invoices");

    return (
        <PageShell as="div">
            <PageHeader title="Billing" />
            <SegmentedTabs label="Billing" items={TABS.map((t) => ({ key: t.value, label: t.label }))} value={tab} onChange={(k) => setTab(k as (typeof TABS)[number]["value"])} />
            {tab === "invoices" && <DocumentsTab key="invoice" kind="invoice" />}
            {tab === "quotes" && <DocumentsTab key="quote" kind="quote" />}
            {tab === "contracts" && <ContractsTab />}
            {tab === "time" && <TimeTab />}
            {tab === "catalog" && <CatalogTab />}
            {tab === "reports" && <ReportsTab />}
            {tab === "settings" && <SettingsTab />}
        </PageShell>
    );
}
