// lib/billing-api.ts
import { API_BASE, jfetch } from "@/lib/api";

export type InvoiceLine = { id?: string; description: string; quantity: number; unitPriceCents: number; amountCents?: number; taxable: boolean };
export type Payment = { id: string; amountCents: number; method: string; reference: string | null; paidAt: string };

export type BillingDocument = {
    id: string;
    kind: "invoice" | "quote";
    number: string | null;
    status: string;
    currency: string;
    taxRateBps: number;
    subtotalCents: number;
    taxCents: number;
    totalCents: number;
    paidCents: number;
    issueDate: string | null;
    dueDate: string | null;
    periodStart: string | null;
    periodEnd: string | null;
    recipientEmail: string | null;
    notes: string | null;
    contractId: string | null;
    overdue: boolean;
    client: { id: string; name: string };
    lines?: InvoiceLine[];
    payments?: Payment[];
};

export type ContractKind = "flat" | "per_device" | "per_user" | "block_hours" | "hourly";

export type Contract = {
    id: string;
    client: { id: string; name: string };
    name: string;
    kind: ContractKind;
    status: "active" | "paused" | "ended";
    billingIntervalMonths: number;
    startDate: string;
    endDate: string | null;
    nextInvoiceDate: string;
    priceCents: number;
    quantity: number | null;
    blockHours: number | null;
    hourlyRateCents: number | null;
    overageRateCents: number | null;
    taxable: boolean;
    notes: string | null;
};

export type TimeEntry = {
    id: string;
    workDate: string;
    minutes: number;
    billable: boolean;
    note: string | null;
    status: "pending" | "approved";
    invoiced: boolean;
    user: { id: string; name: string };
    client: { id: string; name: string } | null;
    ticket: { id: string; number: string; subject: string } | null;
};

export type CatalogItem = { id: string; name: string; description: string | null; unitPriceCents: number; taxable: boolean; active: boolean };

export type BillingSettings = {
    currency: string;
    taxRateBps: number;
    paymentTermsDays: number;
    invoicePrefix: string;
    nextInvoiceNumber: number;
    quotePrefix: string;
    nextQuoteNumber: number;
    laborCostCents: number;
    defaultHourlyRateCents: number;
    footer: string | null;
    publicBaseUrl: string | null;
    stripeConfigured: boolean;
};

export type ProfitRow = {
    clientId: string;
    clientName: string;
    revenueCents: number;
    paidCents: number;
    outstandingCents: number;
    hours: number;
    billableHours: number;
    laborCostCents: number;
    marginCents: number;
};

export const billingUrl = (path: string) => `${(API_BASE || "").replace(/\/+$/, "")}${path}`;

export function money(cents: number, currency = "USD"): string {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(cents / 100);
}

/** "12.34" to 1234. Returns null for anything that is not an amount of money. */
export function toCents(text: string): number | null {
    const cleaned = text.replace(/[$,\s]/g, "");
    if (!/^-?\d*(\.\d{0,2})?$/.test(cleaned) || cleaned === "" || cleaned === "." || cleaned === "-") return null;
    return Math.round(Number(cleaned) * 100);
}

export const fromCents = (cents: number | null | undefined) => (cents === null || cents === undefined ? "" : (cents / 100).toFixed(2));

export const today = () => new Date().toISOString().slice(0, 10);

export const billing = {
    settings: () => jfetch<BillingSettings>("/api/billing/settings"),
    saveSettings: (body: Record<string, unknown>) => jfetch<BillingSettings>("/api/billing/settings", { method: "PUT", body }),

    documents: (kind: "invoice" | "quote", params: { status?: string; cursor?: string; limit?: number } = {}) => {
        const sp = new URLSearchParams({ kind });
        if (params.status) sp.set("status", params.status);
        if (params.cursor) sp.set("cursor", params.cursor);
        if (params.limit) sp.set("limit", String(params.limit));
        return jfetch<{ items: BillingDocument[]; nextCursor: string | null }>(`/api/billing/invoices?${sp}`);
    },
    document: (id: string) => jfetch<BillingDocument>(`/api/billing/invoices/${id}`),
    createDocument: (body: Record<string, unknown>) => jfetch<{ id: string }>("/api/billing/invoices", { method: "POST", body }),
    updateDocument: (id: string, body: Record<string, unknown>) => jfetch<{ id: string }>(`/api/billing/invoices/${id}`, { method: "PUT", body }),
    deleteDocument: (id: string) => jfetch(`/api/billing/invoices/${id}`, { method: "DELETE" }),
    send: (id: string, to: string) => jfetch<BillingDocument & { emailed: boolean; emailError: string | null }>(`/api/billing/invoices/${id}/send`, { method: "POST", body: { to } }),
    voidDocument: (id: string) => jfetch(`/api/billing/invoices/${id}/void`, { method: "POST", body: {} }),
    convert: (id: string) => jfetch<{ id: string }>(`/api/billing/invoices/${id}/convert`, { method: "POST", body: {} }),
    addTime: (id: string, rateCents?: number) => jfetch<{ added: number; hours?: number }>(`/api/billing/invoices/${id}/add-time`, { method: "POST", body: rateCents ? { rateCents } : {} }),
    pay: (id: string, body: { amountCents: number; method: string; reference?: string }) => jfetch<BillingDocument>(`/api/billing/invoices/${id}/payments`, { method: "POST", body }),
    removePayment: (id: string, paymentId: string) => jfetch<BillingDocument>(`/api/billing/invoices/${id}/payments/${paymentId}`, { method: "DELETE" }),

    contracts: () => jfetch<{ items: Contract[] }>("/api/billing/contracts"),
    saveContract: (id: string | null, body: Record<string, unknown>) =>
        jfetch<{ id: string }>(id ? `/api/billing/contracts/${id}` : "/api/billing/contracts", { method: id ? "PUT" : "POST", body }),
    deleteContract: (id: string) => jfetch(`/api/billing/contracts/${id}`, { method: "DELETE" }),
    runContracts: () => jfetch<{ created: number; failed: number }>("/api/billing/contracts/run", { method: "POST", body: {} }),

    time: (params: Record<string, string | undefined>) => {
        const sp = new URLSearchParams();
        for (const [k, v] of Object.entries(params)) if (v) sp.set(k, v);
        return jfetch<{ items: TimeEntry[] }>(`/api/billing/time?${sp}`);
    },
    createTime: (body: Record<string, unknown>) => jfetch<{ id: string }>("/api/billing/time", { method: "POST", body }),
    deleteTime: (id: string) => jfetch(`/api/billing/time/${id}`, { method: "DELETE" }),
    approveTime: (ids: string[], approved: boolean) => jfetch<{ updated: number }>("/api/billing/time/approve", { method: "POST", body: { ids, approved } }),

    catalog: () => jfetch<{ items: CatalogItem[] }>("/api/billing/catalog"),
    saveCatalogItem: (id: string | null, body: Record<string, unknown>) =>
        jfetch<{ id: string }>(id ? `/api/billing/catalog/${id}` : "/api/billing/catalog", { method: id ? "PUT" : "POST", body }),
    deleteCatalogItem: (id: string) => jfetch(`/api/billing/catalog/${id}`, { method: "DELETE" }),

    profitability: (from: string, to: string) =>
        jfetch<{ currency: string; laborCostConfigured: boolean; items: ProfitRow[] }>(`/api/billing/reports/profitability?from=${from}&to=${to}`),
};
