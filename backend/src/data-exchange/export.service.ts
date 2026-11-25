// backend/src/data-exchange/export.service.ts
//
// CSV export of customers, sites, contacts, devices, users and tickets. Each export reads the database in pages and
// hands out one row at a time, so the file streams to the browser and a large fleet never sits in memory. Users are
// exported without anything that signs them in: no password hash, no two-factor secret, no recovery codes.
import { BadRequestException, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { deviceWhereOf, type AccessScope } from "../reports/client-access.service";
import { PrismaService } from "../storage/prisma.service";
import { profileView } from "../customers/customer-profile";

export const EXPORT_KINDS = ["customers", "sites", "contacts", "devices", "users", "tickets"] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];

/** The permission each export needs, on top of being able to open Administration. */
export const EXPORT_PERMISSION: Record<ExportKind, string> = {
    customers: "customers.read",
    sites: "customers.read",
    contacts: "customers.read",
    devices: "devices.read",
    users: "users.read",
    tickets: "tickets.read",
};

const PAGE = 1000;
/** A sanity limit on one file. Narrowing the dates (tickets) reaches anything beyond it. */
export const EXPORT_MAX_ROWS = 200_000;

export type ExportScope = {
    orgId: string;
    /** The customers a limited person may see, or null for everyone. */
    clients: string[] | null;
    /** What a limited person may see of devices, or null for everyone. */
    devices: AccessScope | null;
    from?: Date;
    to?: Date;
};

export type ExportStream = { filename: string; columns: string[]; rows: AsyncGenerator<unknown[]> };

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : "");

/** Parses a yyyy-mm-dd or full date. A date alone means the whole day, so the end date includes that day. */
export function parseRange(raw: string | undefined, name: string, endOfDay: boolean): Date | undefined {
    if (!raw) return undefined;
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);
    const d = new Date(dateOnly ? `${raw}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z` : raw);
    if (Number.isNaN(d.getTime())) throw new BadRequestException(`The ${name} date is not valid. Use the form 2026-01-31.`);
    return d;
}

@Injectable()
export class ExportService {
    constructor(private readonly prisma: PrismaService) { }

    open(kind: ExportKind, scope: ExportScope): ExportStream {
        const stamp = new Date().toISOString().slice(0, 10);
        switch (kind) {
            case "customers":
                return { filename: `customers-${stamp}.csv`, columns: CUSTOMER_COLUMNS, rows: this.customers(scope) };
            case "sites":
                return { filename: `sites-${stamp}.csv`, columns: SITE_COLUMNS, rows: this.sites(scope) };
            case "contacts":
                return { filename: `contacts-${stamp}.csv`, columns: CONTACT_COLUMNS, rows: this.contacts(scope) };
            case "devices":
                return { filename: `devices-${stamp}.csv`, columns: DEVICE_COLUMNS, rows: this.devices(scope) };
            case "users":
                return { filename: `users-${stamp}.csv`, columns: USER_COLUMNS, rows: this.users(scope) };
            case "tickets":
                return { filename: `tickets-${scope.from ? `${scope.from.toISOString().slice(0, 10)}-` : ""}${scope.to ? scope.to.toISOString().slice(0, 10) : stamp}.csv`, columns: TICKET_COLUMNS, rows: this.tickets(scope) };
        }
    }

    private clientFilter(scope: ExportScope): Prisma.clientsWhereInput {
        return { organization_id: scope.orgId, ...(scope.clients ? { id: { in: scope.clients } } : {}) };
    }

    private async *customers(scope: ExportScope): AsyncGenerator<unknown[]> {
        let cursor: string | undefined;
        for (let n = 0; n < EXPORT_MAX_ROWS; ) {
            const rows = await this.prisma.clients.findMany({ where: this.clientFilter(scope), orderBy: { id: "asc" }, take: PAGE, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
            if (!rows.length) return;
            cursor = rows[rows.length - 1].id;
            for (const r of rows) {
                const p = profileView(r, []);
                n++;
                yield [p.id, p.name, p.status, p.accountNumber, p.legalName, p.industry, p.website, p.phone, p.email, p.billingEmail, p.taxId, p.timeZone, p.currency, p.paymentTerms, p.employeeCount, p.customerSince, p.address.line1, p.address.line2, p.address.city, p.address.region, p.address.postalCode, p.address.country, p.tags.join("; "), p.archived ? "yes" : "no", p.notes, iso(r.created_at)];
            }
        }
    }

    private async *sites(scope: ExportScope): AsyncGenerator<unknown[]> {
        let cursor: string | undefined;
        for (let n = 0; n < EXPORT_MAX_ROWS; ) {
            const rows = await this.prisma.sites.findMany({ where: { clients: this.clientFilter(scope) }, include: { clients: { select: { name: true } } }, orderBy: { id: "asc" }, take: PAGE, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
            if (!rows.length) return;
            cursor = rows[rows.length - 1].id;
            for (const r of rows) {
                const a: any = r.address && typeof r.address === "object" && !Array.isArray(r.address) ? r.address : {};
                n++;
                yield [r.clients.name, r.client_id, r.id, r.name, a.line1 ?? "", a.line2 ?? "", a.city ?? "", a.region ?? "", a.postalCode ?? "", a.country ?? "", r.phone, r.email, r.contact_name, r.contact_email, r.contact_phone, r.time_zone, r.notes];
            }
        }
    }

    private async *contacts(scope: ExportScope): AsyncGenerator<unknown[]> {
        let cursor: string | undefined;
        for (let n = 0; n < EXPORT_MAX_ROWS; ) {
            const rows = await this.prisma.customer_contacts.findMany({ where: { clients: this.clientFilter(scope) } as any, include: { clients: { select: { name: true } } } as any, orderBy: { id: "asc" }, take: PAGE, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
            if (!rows.length) return;
            cursor = rows[rows.length - 1].id;
            for (const r of rows as any[]) {
                n++;
                yield [r.clients?.name ?? "", r.client_id, r.name, r.job_title, r.email, r.phone, r.mobile, r.role, r.is_primary ? "yes" : "no", r.notes];
            }
        }
    }

    private async *devices(scope: ExportScope): AsyncGenerator<unknown[]> {
        const where: Prisma.devicesWhereInput = scope.devices ? deviceWhereOf(scope.devices) : { sites: { clients: { organization_id: scope.orgId } } };
        let cursor: string | undefined;
        for (let n = 0; n < EXPORT_MAX_ROWS; ) {
            const rows = await this.prisma.devices.findMany({
                where,
                select: { id: true, hostname: true, alias: true, operating_system: true, architecture: true, status: true, primary_user: true, serial_number: true, last_seen_at: true, created_at: true, sites: { select: { name: true, clients: { select: { name: true } } } }, agents: { select: { version: true, last_check_in_at: true } } },
                orderBy: { id: "asc" },
                take: PAGE,
                ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            });
            if (!rows.length) return;
            cursor = rows[rows.length - 1].id;
            for (const r of rows) {
                n++;
                yield [r.id, r.hostname, r.alias, r.sites?.clients?.name ?? "", r.sites?.name ?? "", r.operating_system, r.architecture, r.status, r.primary_user, r.serial_number, r.agents?.version ?? "", iso(r.agents?.last_check_in_at ?? r.last_seen_at), iso(r.created_at)];
            }
        }
    }

    /** Never selects anything that signs a person in. */
    private async *users(scope: ExportScope): AsyncGenerator<unknown[]> {
        let cursor: string | undefined;
        for (let n = 0; n < EXPORT_MAX_ROWS; ) {
            const rows = await this.prisma.users.findMany({
                where: { organization_id: scope.orgId },
                select: { id: true, email: true, first_name: true, last_name: true, status: true, phone: true, last_seen_at: true, created_at: true, user_security: { select: { two_factor_enabled: true } }, user_roles_user_roles_user_idTousers: { select: { roles: { select: { name: true } } } } },
                orderBy: { id: "asc" },
                take: PAGE,
                ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            });
            if (!rows.length) return;
            cursor = rows[rows.length - 1].id;
            for (const r of rows) {
                n++;
                yield [r.id, String(r.email), r.first_name, r.last_name, r.status, r.phone, r.user_roles_user_roles_user_idTousers.map((x) => x.roles.name).sort().join("; "), r.user_security?.two_factor_enabled ? "yes" : "no", iso(r.last_seen_at), iso(r.created_at)];
            }
        }
    }

    /** Ticket details but not the conversation: subject, status, who and what it concerns, and the dates. */
    private async *tickets(scope: ExportScope): AsyncGenerator<unknown[]> {
        const created: Prisma.DateTimeFilter = { ...(scope.from ? { gte: scope.from } : {}), ...(scope.to ? { lte: scope.to } : {}) };
        const where: Prisma.ticketsWhereInput = {
            organization_id: scope.orgId,
            ...(Object.keys(created).length ? { created_at: created } : {}),
            ...(scope.clients ? { client_id: { in: scope.clients } } : {}),
        };
        const names = new Map<string, string>();
        let cursor: string | undefined;
        for (let n = 0; n < EXPORT_MAX_ROWS; ) {
            const rows = await this.prisma.tickets.findMany({
                where,
                select: { id: true, ticket_number: true, subject: true, status: true, priority: true, client_id: true, created_at: true, updated_at: true, closed_at: true, due_at: true, users: { select: { email: true } }, devices: { select: { hostname: true } } },
                orderBy: { id: "asc" },
                take: PAGE,
                ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            });
            if (!rows.length) return;
            cursor = rows[rows.length - 1].id;
            const missing = [...new Set(rows.map((r) => r.client_id).filter((c): c is string => !!c && !names.has(c)))];
            if (missing.length) for (const c of await this.prisma.clients.findMany({ where: { id: { in: missing } }, select: { id: true, name: true } })) names.set(c.id, c.name);
            for (const r of rows) {
                n++;
                yield [String(r.ticket_number), r.subject, r.status, r.priority, r.client_id ? names.get(r.client_id) ?? "" : "", r.devices?.hostname ?? "", r.users?.email ? String(r.users.email) : "", iso(r.created_at), iso(r.updated_at), iso(r.closed_at), iso(r.due_at)];
            }
        }
    }
}

export const CUSTOMER_COLUMNS = ["id", "name", "status", "account_number", "legal_name", "industry", "website", "phone", "email", "billing_email", "tax_id", "time_zone", "currency", "payment_terms", "employee_count", "customer_since", "address_line1", "address_line2", "address_city", "address_region", "address_postal_code", "address_country", "tags", "archived", "notes", "created_at"];
export const SITE_COLUMNS = ["customer", "customer_id", "id", "name", "address_line1", "address_line2", "address_city", "address_region", "address_postal_code", "address_country", "phone", "email", "contact_name", "contact_email", "contact_phone", "time_zone", "notes"];
export const CONTACT_COLUMNS = ["customer", "customer_id", "name", "job_title", "email", "phone", "mobile", "role", "is_primary", "notes"];
export const DEVICE_COLUMNS = ["id", "hostname", "alias", "customer", "site", "operating_system", "architecture", "status", "primary_user", "serial_number", "agent_version", "last_seen", "created_at"];
export const USER_COLUMNS = ["id", "email", "first_name", "last_name", "status", "phone", "roles", "two_factor", "last_seen_at", "created_at"];
export const TICKET_COLUMNS = ["ticket_number", "subject", "status", "priority", "customer", "device", "assignee", "created_at", "updated_at", "closed_at", "due_at"];
