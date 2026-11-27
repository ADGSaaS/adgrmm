// backend/src/billing/billing.service.ts
import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { Prisma } from "@prisma/client";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { PrismaService } from "../storage/prisma.service";
import { OrganizationContextService } from "../storage/organization-context.service";
import { SmtpService } from "../smtp/smtp.service";
import { EmailTemplatesService } from "../templates/email-templates.service";
import { decryptSecret, encryptSecret } from "../common/secret-box";
import { addDays, addMonths, computeTotals, csvCell, formatMoney, lineAmount, parseDateOnly, toDateOnly } from "./billing.util";
import { renderInvoicePdf } from "./invoice-pdf";
import { trimTrailing } from "../common/text-util";
import { looksLikeEmail } from "../common/text-util";

export type ContractKind = "flat" | "per_device" | "per_user" | "block_hours" | "hourly";
export type InvoiceKind = "invoice" | "quote";

export type LineDto = { description: string; quantity: number; unitPriceCents: number; taxable?: boolean };

export type InvoiceDto = {
    kind?: InvoiceKind;
    clientId: string;
    recipientEmail?: string | null;
    notes?: string | null;
    lines: LineDto[];
};

export type ContractDto = {
    clientId: string;
    name: string;
    kind: ContractKind;
    status?: "active" | "paused" | "ended";
    billingIntervalMonths: number;
    startDate: string;
    endDate?: string | null;
    nextInvoiceDate?: string | null;
    priceCents?: number;
    quantity?: number | null;
    blockHours?: number | null;
    hourlyRateCents?: number | null;
    overageRateCents?: number | null;
    taxable?: boolean;
    notes?: string | null;
};

export type TimeDto = {
    clientId?: string | null;
    ticketId?: string | null;
    workDate: string;
    minutes: number;
    billable?: boolean;
    note?: string | null;
};

const RUN_EVERY_MS = 60 * 60_000;
const MAX_LINES = 500;
const MAX_MINUTES_PER_ENTRY = 24 * 60;
const STRIPE_TOLERANCE_SECONDS = 300;

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

function dateOrBadRequest(value: string): Date {
    try {
        return parseDateOnly(value);
    } catch (err) {
        throw new BadRequestException((err as Error).message);
    }
}

@Injectable()
export class BillingService {
    private readonly logger = new Logger(BillingService.name);
    private running = false;

    constructor(
        private readonly prisma: PrismaService,
        private readonly orgs: OrganizationContextService,
        private readonly smtp: SmtpService,
        private readonly templates: EmailTemplatesService,
    ) { }

    private orgId() {
        return this.orgs.getDefaultOrganizationId();
    }

    private async requireClient(clientId: string, organizationId: string) {
        const client = await this.prisma.clients.findFirst({ where: { id: clientId, organization_id: organizationId } });
        if (!client) throw new BadRequestException("That customer does not exist.");
        return client;
    }

    /* ------------------------------ settings ------------------------------ */

    private async rawSettings(organizationId: string) {
        return this.prisma.billing_settings.upsert({
            where: { organization_id: organizationId },
            create: { organization_id: organizationId },
            update: {},
        });
    }

    async getSettings() {
        const s = await this.rawSettings(await this.orgId());
        return {
            currency: s.currency,
            taxRateBps: s.tax_rate_bps,
            paymentTermsDays: s.payment_terms_days,
            invoicePrefix: s.invoice_prefix,
            nextInvoiceNumber: s.next_invoice_number,
            quotePrefix: s.quote_prefix,
            nextQuoteNumber: s.next_quote_number,
            laborCostCents: s.labor_cost_cents,
            defaultHourlyRateCents: s.default_hourly_rate_cents,
            footer: s.footer,
            publicBaseUrl: s.public_base_url,
            // Only whether they are set. A saved key is never sent back out.
            stripeConfigured: !!s.stripe_secret_key && !!s.stripe_webhook_secret,
        };
    }

    async saveSettings(input: {
        currency?: string;
        taxRateBps?: number;
        paymentTermsDays?: number;
        invoicePrefix?: string;
        nextInvoiceNumber?: number;
        quotePrefix?: string;
        nextQuoteNumber?: number;
        laborCostCents?: number;
        defaultHourlyRateCents?: number;
        footer?: string | null;
        publicBaseUrl?: string | null;
        stripeSecretKey?: string | null;
        stripeWebhookSecret?: string | null;
    }) {
        const organizationId = await this.orgId();
        await this.rawSettings(organizationId);
        await this.prisma.billing_settings.update({
            where: { organization_id: organizationId },
            data: {
                currency: input.currency?.toUpperCase(),
                tax_rate_bps: input.taxRateBps,
                payment_terms_days: input.paymentTermsDays,
                invoice_prefix: input.invoicePrefix,
                next_invoice_number: input.nextInvoiceNumber,
                quote_prefix: input.quotePrefix,
                next_quote_number: input.nextQuoteNumber,
                labor_cost_cents: input.laborCostCents,
                default_hourly_rate_cents: input.defaultHourlyRateCents,
                footer: input.footer,
                public_base_url: input.publicBaseUrl === undefined || input.publicBaseUrl === null ? input.publicBaseUrl : trimTrailing(String(input.publicBaseUrl), "/"),
                ...(input.stripeSecretKey !== undefined
                    ? { stripe_secret_key: input.stripeSecretKey ? encryptSecret(input.stripeSecretKey) : null }
                    : {}),
                ...(input.stripeWebhookSecret !== undefined
                    ? { stripe_webhook_secret: input.stripeWebhookSecret ? encryptSecret(input.stripeWebhookSecret) : null }
                    : {}),
                updated_at: new Date(),
            },
        });
        return this.getSettings();
    }

    /* ------------------------------ catalog ------------------------------ */

    async listCatalog() {
        const rows = await this.prisma.catalog_items.findMany({ where: { organization_id: await this.orgId() }, orderBy: { name: "asc" } });
        return {
            items: rows.map((r) => ({ id: r.id, name: r.name, description: r.description, unitPriceCents: r.unit_price_cents, taxable: r.taxable, active: r.active })),
        };
    }

    async saveCatalogItem(id: string | null, input: { name: string; description?: string | null; unitPriceCents: number; taxable?: boolean; active?: boolean }) {
        const organizationId = await this.orgId();
        const data = {
            name: input.name.trim(),
            description: input.description ?? null,
            unit_price_cents: input.unitPriceCents,
            taxable: input.taxable ?? true,
            active: input.active ?? true,
            updated_at: new Date(),
        };
        if (!data.name) throw new BadRequestException("Give it a name.");
        try {
            const row = id
                ? await this.prisma.catalog_items.update({ where: { id }, data })
                : await this.prisma.catalog_items.create({ data: { ...data, organization_id: organizationId } });
            return { id: row.id };
        } catch (err) {
            const code = (err as Prisma.PrismaClientKnownRequestError)?.code;
            if (code === "P2002") throw new ConflictException("An item with that name already exists.");
            if (code === "P2025") throw new NotFoundException("Item not found");
            throw err;
        }
    }

    async deleteCatalogItem(id: string) {
        await this.prisma.catalog_items.delete({ where: { id } }).catch(() => {
            throw new NotFoundException("Item not found");
        });
        return { id, deleted: true };
    }

    /* ------------------------------ time ------------------------------ */

    /** A ticket's customer comes through its device, since tickets do not record one directly. */
    private async clientForTicket(ticketId: string): Promise<string | null> {
        const ticket = await this.prisma.tickets.findUnique({
            where: { id: ticketId },
            select: { devices: { select: { sites: { select: { client_id: true } } } } },
        });
        return ticket?.devices?.sites?.client_id ?? null;
    }

    private validateTime(input: TimeDto) {
        if (!Number.isInteger(input.minutes) || input.minutes < 1 || input.minutes > MAX_MINUTES_PER_ENTRY) {
            throw new BadRequestException("Enter between 1 minute and 24 hours.");
        }
        return dateOrBadRequest(input.workDate);
    }

    async createTime(input: TimeDto, userId: string) {
        const workDate = this.validateTime(input);
        const organizationId = await this.orgId();
        const clientId = input.clientId ?? (input.ticketId ? await this.clientForTicket(input.ticketId) : null);
        if (clientId) await this.requireClient(clientId, organizationId);

        const row = await this.prisma.time_entries.create({
            data: {
                organization_id: organizationId,
                user_id: userId,
                client_id: clientId,
                ticket_id: input.ticketId ?? null,
                work_date: workDate,
                minutes: input.minutes,
                billable: input.billable ?? true,
                note: input.note ?? null,
            },
            select: { id: true },
        });
        return { id: row.id };
    }

    private async ownEditable(id: string, userId: string, canApprove: boolean) {
        const entry = await this.prisma.time_entries.findUnique({ where: { id } });
        if (!entry) throw new NotFoundException("Time entry not found");
        if (entry.invoice_line_id) throw new ConflictException("This time is already on an invoice.");
        if (entry.user_id !== userId && !canApprove) throw new ForbiddenException("You can only change your own time.");
        if (entry.status === "approved" && !canApprove) throw new ConflictException("This time is already approved.");
        return entry;
    }

    async updateTime(id: string, input: TimeDto, userId: string, canApprove: boolean, canManual = false) {
        const workDate = this.validateTime(input);
        const entry = await this.ownEditable(id, userId, canApprove);
        // Whether it is billable can be changed freely; the minutes and the day are the time itself.
        if (!canManual && (input.minutes !== entry.minutes || toDateOnly(entry.work_date) !== toDateOnly(workDate))) {
            throw new ForbiddenException("You do not have permission to change logged time. Ask an administrator.");
        }
        await this.prisma.time_entries.update({
            where: { id },
            data: {
                client_id: input.clientId !== undefined ? input.clientId : entry.client_id,
                work_date: workDate,
                minutes: input.minutes,
                billable: input.billable ?? entry.billable,
                note: input.note ?? null,
                // A changed entry has to be looked at again.
                status: "pending",
                approved_by: null,
                approved_at: null,
                updated_at: new Date(),
            },
        });
        return { id };
    }

    async deleteTime(id: string, userId: string, canApprove: boolean) {
        await this.ownEditable(id, userId, canApprove);
        await this.prisma.time_entries.delete({ where: { id } });
        return { id, deleted: true };
    }

    async listTime(params: { userId?: string; clientId?: string; ticketId?: string; status?: string; from?: string; to?: string }) {
        const organizationId = await this.orgId();
        const rows = await this.prisma.time_entries.findMany({
            where: {
                organization_id: organizationId,
                ...(params.userId ? { user_id: params.userId } : {}),
                ...(params.clientId ? { client_id: params.clientId } : {}),
                ...(params.ticketId ? { ticket_id: params.ticketId } : {}),
                ...(params.status ? { status: params.status } : {}),
                ...(params.from || params.to
                    ? {
                        work_date: {
                            ...(params.from ? { gte: dateOrBadRequest(params.from) } : {}),
                            ...(params.to ? { lte: dateOrBadRequest(params.to) } : {}),
                        },
                    }
                    : {}),
            },
            orderBy: [{ work_date: "desc" }, { created_at: "desc" }],
            take: 1000,
            include: {
                users_time_entries_user_idTousers: { select: { id: true, email: true, first_name: true, last_name: true } },
                clients: { select: { id: true, name: true } },
                tickets: { select: { id: true, ticket_number: true, subject: true } },
            },
        });
        return {
            items: rows.map((r) => {
                const u = r.users_time_entries_user_idTousers;
                return {
                    id: r.id,
                    workDate: toDateOnly(r.work_date),
                    minutes: r.minutes,
                    billable: r.billable,
                    note: r.note,
                    status: r.status,
                    invoiced: !!r.invoice_line_id,
                    user: { id: u.id, name: [u.first_name, u.last_name].filter(Boolean).join(" ") || u.email },
                    client: r.clients ? { id: r.clients.id, name: r.clients.name } : null,
                    ticket: r.tickets ? { id: r.tickets.id, number: String(r.tickets.ticket_number), subject: r.tickets.subject } : null,
                };
            }),
        };
    }

    async approveTime(ids: string[], approverId: string, approved: boolean) {
        const { count } = await this.prisma.time_entries.updateMany({
            where: { id: { in: ids }, invoice_line_id: null },
            data: approved
                ? { status: "approved", approved_by: approverId, approved_at: new Date() }
                : { status: "pending", approved_by: null, approved_at: null },
        });
        return { updated: count };
    }

    /* ------------------------------ contracts ------------------------------ */

    private presentContract(c: any) {
        return {
            id: c.id,
            client: c.clients ? { id: c.clients.id, name: c.clients.name } : { id: c.client_id, name: "" },
            name: c.name,
            kind: c.kind,
            status: c.status,
            billingIntervalMonths: c.billing_interval_months,
            startDate: toDateOnly(c.start_date),
            endDate: c.end_date ? toDateOnly(c.end_date) : null,
            nextInvoiceDate: toDateOnly(c.next_invoice_date),
            priceCents: c.price_cents,
            quantity: c.quantity === null ? null : Number(c.quantity),
            blockHours: c.block_hours === null ? null : Number(c.block_hours),
            hourlyRateCents: c.hourly_rate_cents,
            overageRateCents: c.overage_rate_cents,
            taxable: c.taxable,
            notes: c.notes,
        };
    }

    async listContracts() {
        const rows = await this.prisma.contracts.findMany({
            where: { organization_id: await this.orgId() },
            orderBy: [{ status: "asc" }, { name: "asc" }],
            include: { clients: { select: { id: true, name: true } } },
        });
        return { items: rows.map((c) => this.presentContract(c)) };
    }

    private contractData(input: ContractDto) {
        if (!input.name?.trim()) throw new BadRequestException("Give the contract a name.");
        if (![1, 3, 6, 12].includes(input.billingIntervalMonths)) throw new BadRequestException("Bill monthly, quarterly, twice a year or yearly.");

        const start = dateOrBadRequest(input.startDate);
        const end = input.endDate ? dateOrBadRequest(input.endDate) : null;
        if (end && end < start) throw new BadRequestException("The contract cannot end before it starts.");

        if (input.kind === "per_user" && !(Number(input.quantity) > 0)) throw new BadRequestException("Enter how many users this covers.");
        if (input.kind === "block_hours" && !(Number(input.blockHours) > 0)) throw new BadRequestException("Enter how many hours the block includes.");
        if (input.kind === "hourly" && !(Number(input.hourlyRateCents) > 0)) throw new BadRequestException("Enter an hourly rate.");

        return {
            name: input.name.trim(),
            kind: input.kind,
            status: input.status ?? "active",
            billing_interval_months: input.billingIntervalMonths,
            start_date: start,
            end_date: end,
            next_invoice_date: input.nextInvoiceDate ? dateOrBadRequest(input.nextInvoiceDate) : start,
            price_cents: input.priceCents ?? 0,
            quantity: input.quantity ?? null,
            block_hours: input.blockHours ?? null,
            hourly_rate_cents: input.hourlyRateCents ?? null,
            overage_rate_cents: input.overageRateCents ?? null,
            taxable: input.taxable ?? true,
            notes: input.notes ?? null,
            updated_at: new Date(),
        };
    }

    async createContract(input: ContractDto) {
        const organizationId = await this.orgId();
        await this.requireClient(input.clientId, organizationId);
        const row = await this.prisma.contracts.create({
            data: { ...this.contractData(input), organization_id: organizationId, client_id: input.clientId },
            select: { id: true },
        });
        return { id: row.id };
    }

    async updateContract(id: string, input: ContractDto) {
        const organizationId = await this.orgId();
        await this.requireClient(input.clientId, organizationId);
        try {
            await this.prisma.contracts.update({ where: { id }, data: { ...this.contractData(input), client_id: input.clientId } });
        } catch {
            throw new NotFoundException("Contract not found");
        }
        return { id };
    }

    async deleteContract(id: string) {
        const invoiced = await this.prisma.invoices.count({ where: { contract_id: id } });
        if (invoiced > 0) throw new ConflictException("This contract has invoices. End it instead, to keep them traceable.");
        await this.prisma.contracts.delete({ where: { id } }).catch(() => {
            throw new NotFoundException("Contract not found");
        });
        return { id, deleted: true };
    }

    /* ------------------------------ recurring invoices ------------------------------ */

    /** Time already approved and not yet invoiced, for one customer, up to a date. */
    private unbilledTime(tx: Prisma.TransactionClient, clientId: string, through: Date, from?: Date) {
        return tx.time_entries.findMany({
            where: {
                client_id: clientId,
                billable: true,
                status: "approved",
                invoice_line_id: null,
                work_date: { lte: through, ...(from ? { gte: from } : {}) },
            },
            select: { id: true, minutes: true },
        });
    }

    /**
     * Builds one period's invoice for a contract. Every kind becomes a draft, so a person checks it
     * before a customer sees it. Runs in one transaction with moving the contract forward.
     */
    private async invoiceContract(contract: any, today: Date): Promise<string | null> {
        const periodStart: Date = contract.next_invoice_date;
        const anchorDay = contract.start_date.getUTCDate();
        const nextDate = addMonths(periodStart, contract.billing_interval_months, anchorDay);
        const periodEnd = addDays(nextDate, -1);

        const settings = await this.rawSettings(contract.organization_id);

        return this.prisma.$transaction(async (tx) => {
            const label = `${toDateOnly(periodStart)} to ${toDateOnly(periodEnd)}`;
            type Line = { description: string; quantity: number; unitPriceCents: number; taxable: boolean; timeIds?: string[] };
            const lines: Line[] = [];
            const taxable: boolean = contract.taxable;

            if (contract.kind === "flat") {
                lines.push({ description: `${contract.name} (${label})`, quantity: 1, unitPriceCents: contract.price_cents, taxable });
            } else if (contract.kind === "per_device") {
                // Devices as they are on the day of billing, which is what keeps this automatic.
                const devices = await tx.devices.count({ where: { sites: { client_id: contract.client_id }, agents: { isNot: null } } });
                lines.push({ description: `${contract.name}: ${devices} ${devices === 1 ? "device" : "devices"} (${label})`, quantity: devices, unitPriceCents: contract.price_cents, taxable });
            } else if (contract.kind === "per_user") {
                const users = Number(contract.quantity ?? 0);
                lines.push({ description: `${contract.name}: ${users} ${users === 1 ? "user" : "users"} (${label})`, quantity: users, unitPriceCents: contract.price_cents, taxable });
            } else if (contract.kind === "block_hours") {
                lines.push({ description: `${contract.name}: ${Number(contract.block_hours)} hour block (${label})`, quantity: 1, unitPriceCents: contract.price_cents, taxable });

                // Overage for the period that has just finished, since the block is billed up front.
                const previousStart = addMonths(periodStart, -contract.billing_interval_months, anchorDay);
                const entries = await this.unbilledTime(tx, contract.client_id, addDays(periodStart, -1), previousStart);
                const hours = entries.reduce((sum, e) => sum + e.minutes, 0) / 60;
                const over = Math.round((hours - Number(contract.block_hours)) * 100) / 100;
                if (over > 0 && contract.overage_rate_cents) {
                    lines.push({
                        description: `Hours over the block in the previous period (${hours.toFixed(2)} used)`,
                        quantity: over,
                        unitPriceCents: contract.overage_rate_cents,
                        taxable,
                        timeIds: entries.map((e) => e.id),
                    });
                }
            } else if (contract.kind === "hourly") {
                const entries = await this.unbilledTime(tx, contract.client_id, addDays(nextDate, -1));
                const hours = Math.round((entries.reduce((sum, e) => sum + e.minutes, 0) / 60) * 100) / 100;
                if (hours > 0) {
                    lines.push({ description: `${contract.name}: ${hours.toFixed(2)} hours`, quantity: hours, unitPriceCents: contract.hourly_rate_cents, taxable, timeIds: entries.map((e) => e.id) });
                }
            }

            const next = {
                next_invoice_date: nextDate,
                ...(contract.end_date && nextDate > contract.end_date ? { status: "ended" } : {}),
                updated_at: new Date(),
            };

            // Nothing to bill this period, such as an hourly contract with no approved time.
            if (lines.length === 0) {
                await tx.contracts.update({ where: { id: contract.id }, data: next });
                return null;
            }

            const totals = computeTotals(lines, settings.tax_rate_bps);
            const invoice = await tx.invoices.create({
                data: {
                    organization_id: contract.organization_id,
                    client_id: contract.client_id,
                    contract_id: contract.id,
                    kind: "invoice",
                    status: "draft",
                    currency: settings.currency,
                    tax_rate_bps: settings.tax_rate_bps,
                    subtotal_cents: totals.subtotalCents,
                    tax_cents: totals.taxCents,
                    total_cents: totals.totalCents,
                    period_start: periodStart,
                    period_end: periodEnd,
                },
                select: { id: true },
            });

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                const created = await tx.invoice_lines.create({
                    data: {
                        invoice_id: invoice.id,
                        position: i,
                        description: line.description,
                        quantity: line.quantity,
                        unit_price_cents: line.unitPriceCents,
                        amount_cents: lineAmount(line.quantity, line.unitPriceCents),
                        taxable: line.taxable,
                    },
                    select: { id: true },
                });
                if (line.timeIds?.length) {
                    await tx.time_entries.updateMany({ where: { id: { in: line.timeIds } }, data: { invoice_line_id: created.id } });
                }
            }

            await tx.contracts.update({ where: { id: contract.id }, data: next });
            void today;
            return invoice.id;
        });
    }

    /** Creates drafts for every contract that is due, including any periods missed while it was down. */
    async generateDueInvoices(now = new Date()): Promise<{ created: number; failed: number }> {
        const today = parseDateOnly(toDateOnly(now));
        let created = 0;
        let failed = 0;

        // One period at a time, re-reading each pass, so a long outage catches up in order.
        for (let pass = 0; pass < 36; pass++) {
            const due = await this.prisma.contracts.findMany({ where: { status: "active", next_invoice_date: { lte: today } } });
            const ready = due.filter((c) => !c.end_date || c.next_invoice_date <= c.end_date);

            for (const stale of due.filter((c) => c.end_date && c.next_invoice_date > c.end_date)) {
                await this.prisma.contracts.update({ where: { id: stale.id }, data: { status: "ended", updated_at: new Date() } });
            }
            if (ready.length === 0) break;

            let progressed = false;
            for (const contract of ready) {
                try {
                    if (await this.invoiceContract(contract, today)) created++;
                    progressed = true;
                } catch (err) {
                    if ((err as Prisma.PrismaClientKnownRequestError)?.code === "P2002") {
                        // Already billed for this period, so only the date needs to move on.
                        await this.prisma.contracts.update({
                            where: { id: contract.id },
                            data: { next_invoice_date: addMonths(contract.next_invoice_date, contract.billing_interval_months, contract.start_date.getUTCDate()) },
                        });
                        progressed = true;
                    } else {
                        failed++;
                        this.logger.error(`Could not invoice contract ${contract.id}: ${(err as Error).message}`);
                    }
                }
            }
            if (!progressed) break;
        }
        return { created, failed };
    }

    @Interval(RUN_EVERY_MS)
    async runRecurring(): Promise<void> {
        if (this.running) return;
        this.running = true;
        try {
            const { created, failed } = await this.generateDueInvoices();
            if (created || failed) this.logger.log(`Recurring billing: ${created} draft(s) created, ${failed} failed.`);
        } catch (err) {
            this.logger.error(`Recurring billing failed: ${(err as Error).message}`);
        } finally {
            this.running = false;
        }
    }

    /* ------------------------------ invoices and quotes ------------------------------ */

    private presentInvoice(row: any) {
        return {
            id: row.id,
            kind: row.kind,
            number: row.number,
            status: row.status,
            currency: row.currency,
            taxRateBps: row.tax_rate_bps,
            subtotalCents: row.subtotal_cents,
            taxCents: row.tax_cents,
            totalCents: row.total_cents,
            paidCents: row.paid_cents,
            issueDate: row.issue_date ? toDateOnly(row.issue_date) : null,
            dueDate: row.due_date ? toDateOnly(row.due_date) : null,
            periodStart: row.period_start ? toDateOnly(row.period_start) : null,
            periodEnd: row.period_end ? toDateOnly(row.period_end) : null,
            recipientEmail: row.recipient_email,
            notes: row.notes,
            contractId: row.contract_id,
            client: row.clients ? { id: row.clients.id, name: row.clients.name } : { id: row.client_id, name: "" },
            createdAt: row.created_at,
            overdue:
                row.kind === "invoice" && (row.status === "sent" || row.status === "partial") && !!row.due_date &&
                toDateOnly(row.due_date) < toDateOnly(new Date()),
            lines: row.invoice_lines
                ? [...row.invoice_lines]
                    .sort((a: any, b: any) => a.position - b.position)
                    .map((l: any) => ({
                        id: l.id,
                        description: l.description,
                        quantity: Number(l.quantity),
                        unitPriceCents: l.unit_price_cents,
                        amountCents: l.amount_cents,
                        taxable: l.taxable,
                    }))
                : undefined,
            payments: row.payments
                ? row.payments.map((p: any) => ({ id: p.id, amountCents: p.amount_cents, method: p.method, reference: p.reference, paidAt: p.paid_at }))
                : undefined,
        };
    }

    async listInvoices(params: { kind?: string; status?: string; clientId?: string; cursor?: string; limit?: string | number }) {
        const limit = Math.min(Math.max(Number(params.limit) || 50, 1), 200);
        const rows = await this.prisma.invoices.findMany({
            where: {
                organization_id: await this.orgId(),
                kind: params.kind === "quote" ? "quote" : "invoice",
                ...(params.status ? { status: params.status } : {}),
                ...(params.clientId ? { client_id: params.clientId } : {}),
            },
            orderBy: [{ created_at: "desc" }, { id: "desc" }],
            take: limit + 1,
            ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
            include: { clients: { select: { id: true, name: true } } },
        });
        const page = rows.slice(0, limit);
        return { items: page.map((r) => this.presentInvoice(r)), nextCursor: rows.length > limit ? page[page.length - 1].id : null };
    }

    private async fullInvoice(id: string) {
        const row = await this.prisma.invoices.findFirst({
            where: { id, organization_id: await this.orgId() },
            include: { clients: { select: { id: true, name: true, contact: true } }, invoice_lines: true, payments: { orderBy: { paid_at: "asc" } } },
        });
        if (!row) throw new NotFoundException("Not found");
        return row;
    }

    async getInvoice(id: string) {
        return this.presentInvoice(await this.fullInvoice(id));
    }

    private validateLines(lines: LineDto[]) {
        if (!lines?.length) throw new BadRequestException("Add at least one line.");
        if (lines.length > MAX_LINES) throw new BadRequestException(`Use at most ${MAX_LINES} lines.`);
        return lines.map((l, i) => {
            if (!l.description?.trim()) throw new BadRequestException(`Line ${i + 1} needs a description.`);
            if (!(l.quantity > 0)) throw new BadRequestException(`Line ${i + 1} needs a quantity above zero.`);
            if (!Number.isInteger(l.unitPriceCents)) throw new BadRequestException(`Line ${i + 1} has an invalid price.`);
            return {
                position: i,
                description: l.description.trim(),
                quantity: Math.round(l.quantity * 100) / 100,
                unit_price_cents: l.unitPriceCents,
                amount_cents: lineAmount(l.quantity, l.unitPriceCents),
                taxable: l.taxable ?? true,
            };
        });
    }

    async createInvoice(input: InvoiceDto) {
        const organizationId = await this.orgId();
        await this.requireClient(input.clientId, organizationId);
        const settings = await this.rawSettings(organizationId);
        const lines = this.validateLines(input.lines);
        const totals = computeTotals(lines.map((l) => ({ quantity: Number(l.quantity), unitPriceCents: l.unit_price_cents, taxable: l.taxable })), settings.tax_rate_bps);

        const row = await this.prisma.invoices.create({
            data: {
                organization_id: organizationId,
                client_id: input.clientId,
                kind: input.kind ?? "invoice",
                currency: settings.currency,
                tax_rate_bps: settings.tax_rate_bps,
                subtotal_cents: totals.subtotalCents,
                tax_cents: totals.taxCents,
                total_cents: totals.totalCents,
                recipient_email: input.recipientEmail ?? null,
                notes: input.notes ?? null,
                invoice_lines: { create: lines },
            },
            select: { id: true },
        });
        return { id: row.id };
    }

    async updateInvoice(id: string, input: InvoiceDto) {
        const existing = await this.fullInvoice(id);
        if (existing.status !== "draft") throw new ConflictException("Only a draft can be edited. Void it and create a new one.");
        await this.requireClient(input.clientId, existing.organization_id);

        const lines = this.validateLines(input.lines);
        const totals = computeTotals(lines.map((l) => ({ quantity: Number(l.quantity), unitPriceCents: l.unit_price_cents, taxable: l.taxable })), existing.tax_rate_bps);

        await this.prisma.$transaction(async (tx) => {
            // Any time attached to the old lines goes back to unbilled.
            await tx.time_entries.updateMany({ where: { invoice_lines: { invoice_id: id } }, data: { invoice_line_id: null } });
            await tx.invoice_lines.deleteMany({ where: { invoice_id: id } });
            await tx.invoices.update({
                where: { id },
                data: {
                    client_id: input.clientId,
                    subtotal_cents: totals.subtotalCents,
                    tax_cents: totals.taxCents,
                    total_cents: totals.totalCents,
                    recipient_email: input.recipientEmail ?? null,
                    notes: input.notes ?? null,
                    invoice_lines: { create: lines },
                    updated_at: new Date(),
                },
            });
        });
        return { id };
    }

    async deleteInvoice(id: string) {
        const existing = await this.fullInvoice(id);
        if (existing.status !== "draft") throw new ConflictException("Only a draft can be deleted. Void this one instead, to keep the record.");
        await this.prisma.$transaction(async (tx) => {
            await tx.time_entries.updateMany({ where: { invoice_lines: { invoice_id: id } }, data: { invoice_line_id: null } });
            await tx.invoices.delete({ where: { id } });
        });
        return { id, deleted: true };
    }

    /** Adds a customer's approved, unbilled time to a draft, at one rate. */
    async addUnbilledTime(id: string, rateCents?: number) {
        const invoice = await this.fullInvoice(id);
        if (invoice.status !== "draft" || invoice.kind !== "invoice") throw new ConflictException("Time can only be added to a draft invoice.");

        const settings = await this.rawSettings(invoice.organization_id);
        const rate = rateCents ?? settings.default_hourly_rate_cents;
        if (!(rate > 0)) throw new BadRequestException("Enter an hourly rate, or set a default in billing settings.");

        return this.prisma.$transaction(async (tx) => {
            const entries = await this.unbilledTime(tx, invoice.client_id, new Date());
            if (entries.length === 0) return { added: 0 };

            const hours = Math.round((entries.reduce((sum, e) => sum + e.minutes, 0) / 60) * 100) / 100;
            const line = await tx.invoice_lines.create({
                data: {
                    invoice_id: id,
                    position: invoice.invoice_lines.length,
                    description: `Labor: ${hours.toFixed(2)} hours`,
                    quantity: hours,
                    unit_price_cents: rate,
                    amount_cents: lineAmount(hours, rate),
                    taxable: true,
                },
            });
            await tx.time_entries.updateMany({ where: { id: { in: entries.map((e) => e.id) } }, data: { invoice_line_id: line.id } });

            const all = await tx.invoice_lines.findMany({ where: { invoice_id: id } });
            const totals = computeTotals(all.map((l) => ({ quantity: Number(l.quantity), unitPriceCents: l.unit_price_cents, taxable: l.taxable })), invoice.tax_rate_bps);
            await tx.invoices.update({ where: { id }, data: { subtotal_cents: totals.subtotalCents, tax_cents: totals.taxCents, total_cents: totals.totalCents, updated_at: new Date() } });
            return { added: entries.length, hours };
        });
    }

    private async companyDetails() {
        const company = await this.prisma.company_profile.findFirst();
        return {
            name: company?.name ?? "",
            lines: [company?.address1, company?.address2, [company?.city, company?.state, company?.postal].filter(Boolean).join(", "), company?.country, company?.email, company?.phone, company?.vat_tin ? `Tax ID: ${company.vat_tin}` : null].filter(Boolean) as string[],
        };
    }

    async pdf(id: string): Promise<{ filename: string; data: Buffer }> {
        const row = await this.fullInvoice(id);
        return this.pdfFor(row);
    }

    private async pdfFor(row: any): Promise<{ filename: string; data: Buffer }> {
        const settings = await this.rawSettings(row.organization_id);
        const data = await renderInvoicePdf({
            kind: row.kind,
            number: row.number ?? "Draft",
            status: row.status,
            issueDate: row.issue_date ? toDateOnly(row.issue_date) : null,
            dueDate: row.due_date ? toDateOnly(row.due_date) : null,
            currency: row.currency,
            company: await this.companyDetails(),
            clientName: row.clients.name,
            lines: [...row.invoice_lines]
                .sort((a: any, b: any) => a.position - b.position)
                .map((l: any) => ({ description: l.description, quantity: Number(l.quantity), unitPriceCents: l.unit_price_cents, amountCents: l.amount_cents })),
            subtotalCents: row.subtotal_cents,
            taxCents: row.tax_cents,
            taxRateBps: row.tax_rate_bps,
            totalCents: row.total_cents,
            paidCents: row.paid_cents,
            notes: row.notes,
            footer: settings.footer,
        });
        const label = row.kind === "quote" ? "quote" : "invoice";
        return { filename: `${label}-${String(row.number ?? "draft").replace(/[^A-Za-z0-9_-]/g, "")}.pdf`, data };
    }

    /**
     * Gives it a number, which never changes after this, and emails it. A failed email does not undo
     * that: the customer has not seen it, and sending again uses the same number.
     */
    async send(id: string, to?: string | null) {
        const existing = await this.fullInvoice(id);
        if (existing.status === "void" || existing.status === "declined") throw new ConflictException("This can no longer be sent.");
        const recipient = (to ?? existing.recipient_email ?? "").trim();
        if (!looksLikeEmail(recipient)) throw new BadRequestException("Enter the email address to send it to.");

        const token = randomBytes(32).toString("base64url");
        const today = parseDateOnly(toDateOnly(new Date()));

        await this.prisma.$transaction(async (tx) => {
            const update: Prisma.invoicesUpdateInput = { recipient_email: recipient, public_token_hash: hashToken(token), sent_at: new Date(), updated_at: new Date() };

            if (existing.status === "draft") {
                const settings = await tx.billing_settings.update({
                    where: { organization_id: existing.organization_id },
                    data: existing.kind === "quote" ? { next_quote_number: { increment: 1 } } : { next_invoice_number: { increment: 1 } },
                });
                update.number = existing.kind === "quote" ? `${settings.quote_prefix}${settings.next_quote_number - 1}` : `${settings.invoice_prefix}${settings.next_invoice_number - 1}`;
                update.status = "sent";
                update.issue_date = today;
                update.due_date = addDays(today, settings.payment_terms_days);
            }
            await tx.invoices.update({ where: { id }, data: update });
        });

        const row = await this.fullInvoice(id);
        const settings = await this.rawSettings(row.organization_id);
        const { filename, data } = await this.pdfFor(row);
        const link = settings.public_base_url ? `${settings.public_base_url}/pay/${token}` : null;
        const noun = row.kind === "quote" ? "quote" : "invoice";
        const company = (await this.companyDetails()).name;

        // The wording is the built-in one unless an administrator changed it (Administration > Templates).
        const mail = await this.templates.render("invoice", {
            company_prefix: company ? `${company}: ` : "",
            document: noun,
            document_title: noun === "quote" ? "Quote" : "Invoice",
            number: String(row.number ?? ""),
            total: formatMoney(row.total_cents, row.currency),
            due_line: row.due_date && noun === "invoice" ? `It is due on ${toDateOnly(row.due_date)}.` : "",
            link_line: link ? `You can view it${noun === "invoice" && settings.stripe_secret_key ? " and pay online" : ""} here: ${link}` : "",
        }, row.organization_id);
        const result = await this.smtp.sendWithAttachment("reports", recipient, mail.subject, mail.body, { filename, content: data, contentType: "application/pdf" });

        return { ...this.presentInvoice(row), emailed: result.ok, emailError: result.ok ? null : result.result };
    }

    private async settleTotals(tx: Prisma.TransactionClient, invoiceId: string) {
        const invoice = await tx.invoices.findUniqueOrThrow({ where: { id: invoiceId } });
        const sum = await tx.payments.aggregate({ where: { invoice_id: invoiceId }, _sum: { amount_cents: true } });
        const paid = sum._sum.amount_cents ?? 0;
        await tx.invoices.update({
            where: { id: invoiceId },
            data: {
                paid_cents: paid,
                status: paid >= invoice.total_cents ? "paid" : paid > 0 ? "partial" : "sent",
                updated_at: new Date(),
            },
        });
    }

    async recordPayment(id: string, input: { amountCents: number; method: string; reference?: string | null; paidAt?: string | null }, userId: string | null) {
        const invoice = await this.fullInvoice(id);
        if (invoice.kind !== "invoice") throw new BadRequestException("Quotes cannot be paid.");
        if (!["sent", "partial"].includes(invoice.status)) throw new ConflictException("Only a sent invoice can be paid.");
        if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) throw new BadRequestException("Enter an amount above zero.");
        if (input.amountCents > invoice.total_cents - invoice.paid_cents) throw new BadRequestException("That is more than is owed on this invoice.");

        await this.prisma.$transaction(async (tx) => {
            await tx.payments.create({
                data: {
                    invoice_id: id,
                    amount_cents: input.amountCents,
                    method: input.method,
                    reference: input.reference || null,
                    paid_at: input.paidAt ? new Date(input.paidAt) : new Date(),
                    recorded_by: userId,
                },
            });
            await this.settleTotals(tx, id);
        });
        return this.getInvoice(id);
    }

    async removePayment(invoiceId: string, paymentId: string) {
        const payment = await this.prisma.payments.findFirst({ where: { id: paymentId, invoice_id: invoiceId } });
        if (!payment) throw new NotFoundException("Payment not found");
        await this.prisma.$transaction(async (tx) => {
            await tx.payments.delete({ where: { id: paymentId } });
            await this.settleTotals(tx, invoiceId);
        });
        return this.getInvoice(invoiceId);
    }

    async voidInvoice(id: string) {
        const invoice = await this.fullInvoice(id);
        if (invoice.paid_cents > 0) throw new ConflictException("Remove its payments first, or refund them.");
        await this.prisma.$transaction(async (tx) => {
            await tx.time_entries.updateMany({ where: { invoice_lines: { invoice_id: id } }, data: { invoice_line_id: null } });
            await tx.invoices.update({ where: { id }, data: { status: "void", public_token_hash: null, updated_at: new Date() } });
        });
        return this.getInvoice(id);
    }

    async convertQuote(id: string) {
        const quote = await this.fullInvoice(id);
        if (quote.kind !== "quote") throw new BadRequestException("Only a quote can be converted.");
        if (quote.status !== "accepted" && quote.status !== "sent") throw new ConflictException("Send the quote first.");

        const existing = await this.prisma.invoices.findFirst({ where: { converted_from_id: id, status: { not: "void" } }, select: { id: true } });
        if (existing) return { id: existing.id };

        const row = await this.prisma.invoices.create({
            data: {
                organization_id: quote.organization_id,
                client_id: quote.client_id,
                kind: "invoice",
                currency: quote.currency,
                tax_rate_bps: quote.tax_rate_bps,
                subtotal_cents: quote.subtotal_cents,
                tax_cents: quote.tax_cents,
                total_cents: quote.total_cents,
                recipient_email: quote.recipient_email,
                notes: quote.notes,
                converted_from_id: quote.id,
                invoice_lines: {
                    create: quote.invoice_lines.map((l) => ({
                        position: l.position,
                        description: l.description,
                        quantity: l.quantity,
                        unit_price_cents: l.unit_price_cents,
                        amount_cents: l.amount_cents,
                        taxable: l.taxable,
                    })),
                },
            },
            select: { id: true },
        });
        await this.prisma.invoices.update({ where: { id }, data: { status: "accepted", updated_at: new Date() } });
        return { id: row.id };
    }

    /* ------------------------------ public links ------------------------------ */

    private async byToken(token: string) {
        if (!token || token.length > 100) throw new NotFoundException("This link is not valid.");
        const row = await this.prisma.invoices.findUnique({
            where: { public_token_hash: hashToken(token) },
            include: { clients: { select: { id: true, name: true } }, invoice_lines: true },
        });
        if (!row || row.status === "void" || row.status === "draft") throw new NotFoundException("This link is not valid.");
        return row;
    }

    /** What someone holding the link may see. Nothing else about the customer or this system. */
    async publicView(token: string) {
        const row = await this.byToken(token);
        const settings = await this.rawSettings(row.organization_id);
        const company = await this.companyDetails();
        return {
            kind: row.kind,
            number: row.number,
            status: row.status,
            currency: row.currency,
            issueDate: row.issue_date ? toDateOnly(row.issue_date) : null,
            dueDate: row.due_date ? toDateOnly(row.due_date) : null,
            subtotalCents: row.subtotal_cents,
            taxCents: row.tax_cents,
            totalCents: row.total_cents,
            paidCents: row.paid_cents,
            notes: row.notes,
            clientName: row.clients.name,
            company,
            footer: settings.footer,
            canPay: row.kind === "invoice" && ["sent", "partial"].includes(row.status) && !!settings.stripe_secret_key && !!settings.stripe_webhook_secret,
            lines: [...row.invoice_lines]
                .sort((a, b) => a.position - b.position)
                .map((l) => ({ description: l.description, quantity: Number(l.quantity), unitPriceCents: l.unit_price_cents, amountCents: l.amount_cents })),
        };
    }

    async publicPdf(token: string) {
        const row = await this.byToken(token);
        const full = await this.fullInvoice(row.id);
        return this.pdfFor(full);
    }

    async respondToQuote(token: string, accept: boolean) {
        const row = await this.byToken(token);
        if (row.kind !== "quote") throw new BadRequestException("This is not a quote.");
        if (row.status !== "sent") throw new ConflictException("This quote has already been answered.");
        await this.prisma.invoices.update({ where: { id: row.id }, data: { status: accept ? "accepted" : "declined", updated_at: new Date() } });
        return { status: accept ? "accepted" : "declined" };
    }

    /* ------------------------------ Stripe ------------------------------ */

    private stripeBase() {
        return (process.env.STRIPE_API_BASE || "https://api.stripe.com").replace(/\/+$/, "");
    }

    /** Sends the customer to Stripe's hosted page, so card details never touch this system. */
    async createCheckout(token: string): Promise<{ url: string }> {
        const row = await this.byToken(token);
        const settings = await this.rawSettings(row.organization_id);
        if (row.kind === "invoice" && ["sent", "partial"].includes(row.status) && settings.stripe_secret_key && settings.stripe_webhook_secret && !settings.public_base_url) {
            throw new ConflictException("Online payment is not set up.");
        }
        return this.startCheckout(row, `${settings.public_base_url}/pay/${token}`);
    }

    private async startCheckout(row: { id: string; organization_id: string; kind: string; status: string; total_cents: number; paid_cents: number; currency: string; number: string | null; recipient_email: string | null }, pageUrl: string): Promise<{ url: string }> {
        if (row.kind !== "invoice" || !["sent", "partial"].includes(row.status)) throw new ConflictException("This invoice cannot be paid now.");

        const settings = await this.rawSettings(row.organization_id);
        if (!settings.stripe_secret_key || !settings.stripe_webhook_secret) throw new ConflictException("Online payment is not set up.");

        const due = row.total_cents - row.paid_cents;
        const form = new URLSearchParams({
            mode: "payment",
            "success_url": `${pageUrl}?paid=1`,
            "cancel_url": pageUrl,
            "line_items[0][quantity]": "1",
            "line_items[0][price_data][currency]": row.currency.toLowerCase(),
            "line_items[0][price_data][unit_amount]": String(due),
            "line_items[0][price_data][product_data][name]": `Invoice ${row.number}`,
            "metadata[invoice_id]": row.id,
            ...(row.recipient_email ? { customer_email: row.recipient_email } : {}),
        });

        const res = await fetch(`${this.stripeBase()}/v1/checkout/sessions`, {
            method: "POST",
            signal: AbortSignal.timeout(15_000),
            headers: {
                Authorization: `Bearer ${decryptSecret(settings.stripe_secret_key)}`,
                "Content-Type": "application/x-www-form-urlencoded",
                // Two clicks within a moment open one checkout instead of two.
                "Idempotency-Key": `invoice-${row.id}-${due}`,
            },
            body: form.toString(),
        });
        const body = (await res.json().catch(() => null)) as { url?: string; error?: { message?: string } } | null;
        if (!res.ok || !body?.url) {
            this.logger.error(`Stripe refused a checkout: ${body?.error?.message ?? res.status}`);
            throw new ConflictException("Online payment is not available right now.");
        }
        return { url: body.url };
    }

    /* ------------------------------ client portal ------------------------------ */

    /** An invoice that belongs to this customer and has been sent. A customer never reaches drafts, voided ones or other customers'. */
    private async portalRow(clientId: string, id: string) {
        const row = await this.prisma.invoices.findFirst({
            where: { id, client_id: clientId, kind: "invoice", status: { notIn: ["draft", "void"] } },
            include: { clients: { select: { id: true, name: true, contact: true } }, invoice_lines: true, payments: { orderBy: { paid_at: "asc" } } },
        });
        if (!row) throw new NotFoundException("Invoice not found");
        return row;
    }

    async portalInvoiceView(clientId: string, id: string) {
        const row = await this.portalRow(clientId, id);
        const settings = await this.rawSettings(row.organization_id);
        return {
            number: row.number,
            status: row.status,
            currency: row.currency,
            issueDate: row.issue_date ? toDateOnly(row.issue_date) : null,
            dueDate: row.due_date ? toDateOnly(row.due_date) : null,
            subtotalCents: row.subtotal_cents,
            taxCents: row.tax_cents,
            totalCents: row.total_cents,
            paidCents: row.paid_cents,
            notes: row.notes,
            canPay: ["sent", "partial"].includes(row.status) && !!settings.stripe_secret_key && !!settings.stripe_webhook_secret,
            lines: [...row.invoice_lines]
                .sort((a, b) => a.position - b.position)
                .map((l) => ({ description: l.description, quantity: Number(l.quantity), unitPriceCents: l.unit_price_cents, amountCents: l.amount_cents })),
            payments: row.payments.map((p) => ({ amountCents: p.amount_cents, method: p.method, paidAt: p.paid_at })),
        };
    }

    async portalInvoicePdf(clientId: string, id: string) {
        return this.pdfFor(await this.portalRow(clientId, id));
    }

    async portalCheckout(clientId: string, id: string, returnUrl: string) {
        return this.startCheckout(await this.portalRow(clientId, id), returnUrl);
    }

    /** Only a correctly signed event can record a payment. The browser returning from Stripe proves nothing. */
    async handleStripeWebhook(raw: Buffer, signatureHeader: string | undefined): Promise<void> {
        const organizationId = await this.orgId();
        const settings = await this.rawSettings(organizationId);
        if (!settings.stripe_webhook_secret) throw new BadRequestException("Not configured.");

        const parts = Object.fromEntries(
            String(signatureHeader ?? "").split(",").map((p) => {
                const [k, ...v] = p.split("=");
                return [k.trim(), v.join("=")];
            })
        ) as Record<string, string>;

        const timestamp = Number(parts.t);
        if (!parts.t || !parts.v1 || !Number.isFinite(timestamp)) throw new BadRequestException("Bad signature.");
        if (Math.abs(Date.now() / 1000 - timestamp) > STRIPE_TOLERANCE_SECONDS) throw new BadRequestException("Bad signature.");

        const expected = createHmac("sha256", decryptSecret(settings.stripe_webhook_secret))
            .update(`${parts.t}.${raw.toString("utf8")}`)
            .digest();
        const received = Buffer.from(parts.v1, "hex");
        if (received.length !== expected.length || !timingSafeEqual(received, expected)) throw new BadRequestException("Bad signature.");

        const event = JSON.parse(raw.toString("utf8"));
        if (event.type !== "checkout.session.completed") return;

        const session = event.data?.object;
        if (session?.payment_status !== "paid") return;

        const invoiceId = session.metadata?.invoice_id;
        const amount = Number(session.amount_total);
        if (!invoiceId || !Number.isInteger(amount) || amount <= 0) return;

        const invoice = await this.prisma.invoices.findUnique({ where: { id: invoiceId } });
        if (!invoice) return;

        try {
            await this.prisma.$transaction(async (tx) => {
                await tx.payments.create({
                    data: { invoice_id: invoiceId, amount_cents: amount, method: "stripe", reference: String(session.id), paid_at: new Date(timestamp * 1000) },
                });
                await this.settleTotals(tx, invoiceId);
            });
        } catch (err) {
            // Stripe sends an event again if it is unsure. Once is enough.
            if ((err as Prisma.PrismaClientKnownRequestError)?.code !== "P2002") throw err;
        }
    }

    /* ------------------------------ reports ------------------------------ */

    async profitability(params: { from: string; to: string }) {
        const from = dateOrBadRequest(params.from);
        const to = dateOrBadRequest(params.to);
        const organizationId = await this.orgId();
        const settings = await this.rawSettings(organizationId);

        const [clients, invoices, time] = await Promise.all([
            this.prisma.clients.findMany({ where: { organization_id: organizationId }, select: { id: true, name: true } }),
            this.prisma.invoices.findMany({
                where: { organization_id: organizationId, kind: "invoice", status: { in: ["sent", "partial", "paid"] }, issue_date: { gte: from, lte: to } },
                select: { client_id: true, subtotal_cents: true, paid_cents: true, total_cents: true },
            }),
            this.prisma.time_entries.findMany({
                where: { organization_id: organizationId, work_date: { gte: from, lte: to }, client_id: { not: null } },
                select: { client_id: true, minutes: true, billable: true },
            }),
        ]);

        const rows = clients.map((client) => {
            const own = invoices.filter((i) => i.client_id === client.id);
            const entries = time.filter((t) => t.client_id === client.id);
            const minutes = entries.reduce((s, t) => s + t.minutes, 0);
            const billableMinutes = entries.filter((t) => t.billable).reduce((s, t) => s + t.minutes, 0);
            // Before tax, since tax is not the business's money.
            const revenueCents = own.reduce((s, i) => s + i.subtotal_cents, 0);
            const laborCostCents = Math.round((minutes / 60) * settings.labor_cost_cents);
            return {
                clientId: client.id,
                clientName: client.name,
                revenueCents,
                paidCents: own.reduce((s, i) => s + i.paid_cents, 0),
                outstandingCents: own.reduce((s, i) => s + (i.total_cents - i.paid_cents), 0),
                hours: Math.round((minutes / 60) * 100) / 100,
                billableHours: Math.round((billableMinutes / 60) * 100) / 100,
                laborCostCents,
                marginCents: revenueCents - laborCostCents,
            };
        });

        return {
            currency: settings.currency,
            laborCostConfigured: settings.labor_cost_cents > 0,
            items: rows.filter((r) => r.revenueCents || r.hours).sort((a, b) => b.revenueCents - a.revenueCents),
        };
    }

    /** Flat rows that accounting packages can import, one per line. */
    async exportInvoicesCsv(params: { from: string; to: string }): Promise<string> {
        const from = dateOrBadRequest(params.from);
        const to = dateOrBadRequest(params.to);
        const rows = await this.prisma.invoices.findMany({
            where: { organization_id: await this.orgId(), kind: "invoice", status: { in: ["sent", "partial", "paid"] }, issue_date: { gte: from, lte: to } },
            orderBy: { issue_date: "asc" },
            include: { clients: { select: { name: true } }, invoice_lines: { orderBy: { position: "asc" } } },
        });
        const header = ["InvoiceNo", "Customer", "InvoiceDate", "DueDate", "Status", "Currency", "Description", "Quantity", "UnitPrice", "Amount", "Taxable", "TaxTotal", "InvoiceTotal", "Paid"];
        const lines = [header.join(",")];
        for (const inv of rows) {
            for (const line of inv.invoice_lines) {
                lines.push(
                    [
                        inv.number,
                        inv.clients.name,
                        inv.issue_date ? toDateOnly(inv.issue_date) : "",
                        inv.due_date ? toDateOnly(inv.due_date) : "",
                        inv.status,
                        inv.currency,
                        line.description,
                        Number(line.quantity).toFixed(2),
                        (line.unit_price_cents / 100).toFixed(2),
                        (line.amount_cents / 100).toFixed(2),
                        line.taxable ? "Y" : "N",
                        (inv.tax_cents / 100).toFixed(2),
                        (inv.total_cents / 100).toFixed(2),
                        (inv.paid_cents / 100).toFixed(2),
                    ].map(csvCell).join(",")
                );
            }
        }
        return lines.join("\r\n");
    }
}
