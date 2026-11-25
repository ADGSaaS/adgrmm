// The client portal's calls. Always to this same address (the web app forwards /api/portal on), never to another host,
// so the portal's sign-in cookie stays on the portal's own domain.

export class PortalError extends Error {
    constructor(message: string, public status: number) {
        super(message);
    }
}

export async function portal<T = unknown>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
    const res = await fetch(`/api/portal${path}`, {
        method: opts.method ?? "GET",
        credentials: "same-origin",
        cache: "no-store",
        headers: opts.body !== undefined ? { "Content-Type": "application/json" } : undefined,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
        const m = data?.message;
        throw new PortalError(Array.isArray(m) ? m.join(" ") : String(m || "Something went wrong. Try again."), res.status);
    }
    return data as T;
}

export type PortalMe = {
    name: string;
    email: string;
    role: "user" | "manager";
    customer: string;
    modules: string[];
    allowTicketCreate: boolean;
    welcomeTitle: string;
    welcomeText: string;
    supportEmail: string;
    supportPhone: string;
    /** Tickets with a reply from support that this person has not opened yet. */
    unreadReplies: number;
};

export type PortalConfig = {
    enabled: boolean;
    domain: string | null;
    modules: string[];
    allowTicketCreate: boolean;
    welcomeTitle: string;
    welcomeText: string;
    supportEmail: string;
    supportPhone: string;
};

export type PortalTicketRow = { id: string; number: number; subject: string; status: string; statusLabel: string; createdAt: string; updatedAt: string; device: string | null; unread?: boolean };

export type PortalTicket = PortalTicketRow & {
    description: string;
    closedAt: string | null;
    openedBy: string | null;
    canReply: boolean;
    /** Ticket custom fields marked visible to the customer, with a value. */
    customFields?: { label: string; type: string; value: string }[];
    replies: { id: string; fromSupport: boolean; author: string; body: string; createdAt: string; isNew?: boolean }[];
};

export type PortalDevice = { id: string; name: string; os: string | null; user: string | null; site: string; online: boolean; lastSeen: string | null };

export type PortalInvoiceRow = { id: string; number: string | null; status: string; currency: string; issueDate: string | null; dueDate: string | null; totalCents: number; paidCents: number; dueCents: number };

export type PortalInvoice = {
    number: string | null;
    status: string;
    currency: string;
    issueDate: string | null;
    dueDate: string | null;
    subtotalCents: number;
    taxCents: number;
    totalCents: number;
    paidCents: number;
    notes: string | null;
    canPay: boolean;
    lines: { description: string; quantity: number; unitPriceCents: number; amountCents: number }[];
    payments: { amountCents: number; method: string; paidAt: string }[];
};

export type PortalReport = { key: string; title: string; description: string; defaultDays: number };

export type PortalDashboard = {
    unreadReplies?: number;
    openTickets: number;
    waitingTickets: number;
    recentTickets: PortalTicketRow[];
    devices?: { total: number; online: number; offline: number };
    invoices?: { unpaid: number; balanceCents: number; overdue: number };
};

export const when = (v: string | null | undefined) => (v ? new Date(v).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—");
export const day = (v: string | null | undefined) => (v ? new Date(`${String(v).slice(0, 10)}T00:00:00`).toLocaleDateString(undefined, { dateStyle: "medium" }) : "—");
