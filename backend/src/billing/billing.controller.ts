// backend/src/billing/billing.controller.ts
import { Body, Controller, Delete, ForbiddenException, Get, Headers, HttpCode, HttpException, HttpStatus, Param, ParseUUIDPipe, Post, Put, Query, Req, Res, UsePipes, ValidationPipe } from "@nestjs/common";
import { Type } from "class-transformer";
import {
    ArrayMinSize,
    IsArray,
    IsBoolean,
    IsEmail,
    IsIn,
    IsInt,
    IsNumber,
    IsOptional,
    IsString,
    IsUUID,
    Max,
    MaxLength,
    Min,
    ValidateNested,
} from "class-validator";
import type { Response } from "express";
import { Public } from "../auth/public.decorator";
import { RequirePerm } from "../auth/require-perm.decorator";
import { BillingService } from "./billing.service";

class LineDto {
    @IsString() @MaxLength(1000) description!: string;
    @IsNumber() @Min(0.01) @Max(1_000_000) quantity!: number;
    @IsInt() @Min(-100_000_000) @Max(100_000_000) unitPriceCents!: number;
    @IsOptional() @IsBoolean() taxable?: boolean;
}

class InvoiceDto {
    @IsOptional() @IsIn(["invoice", "quote"]) kind?: "invoice" | "quote";
    @IsUUID("all") clientId!: string;
    @IsOptional() @IsEmail() recipientEmail?: string;
    @IsOptional() @IsString() @MaxLength(4000) notes?: string;
    @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => LineDto) lines!: LineDto[];
}

class ContractDto {
    @IsUUID("all") clientId!: string;
    @IsString() @MaxLength(200) name!: string;
    @IsIn(["flat", "per_device", "per_user", "block_hours", "hourly"]) kind!: "flat" | "per_device" | "per_user" | "block_hours" | "hourly";
    @IsOptional() @IsIn(["active", "paused", "ended"]) status?: "active" | "paused" | "ended";
    @IsInt() billingIntervalMonths!: number;
    @IsString() startDate!: string;
    @IsOptional() @IsString() endDate?: string;
    @IsOptional() @IsString() nextInvoiceDate?: string;
    @IsOptional() @IsInt() @Min(0) priceCents?: number;
    @IsOptional() @IsNumber() @Min(0) quantity?: number;
    @IsOptional() @IsNumber() @Min(0) blockHours?: number;
    @IsOptional() @IsInt() @Min(0) hourlyRateCents?: number;
    @IsOptional() @IsInt() @Min(0) overageRateCents?: number;
    @IsOptional() @IsBoolean() taxable?: boolean;
    @IsOptional() @IsString() @MaxLength(4000) notes?: string;
}

class TimeDto {
    @IsOptional() @IsUUID("all") clientId?: string;
    @IsOptional() @IsUUID("all") ticketId?: string;
    @IsString() workDate!: string;
    @IsInt() @Min(1) @Max(1440) minutes!: number;
    @IsOptional() @IsBoolean() billable?: boolean;
    @IsOptional() @IsString() @MaxLength(2000) note?: string;
}

class ApproveDto {
    @IsArray() @IsUUID("all", { each: true }) ids!: string[];
    @IsBoolean() approved!: boolean;
}

class CatalogDto {
    @IsString() @MaxLength(200) name!: string;
    @IsOptional() @IsString() @MaxLength(1000) description?: string;
    @IsInt() @Min(0) unitPriceCents!: number;
    @IsOptional() @IsBoolean() taxable?: boolean;
    @IsOptional() @IsBoolean() active?: boolean;
}

class SettingsDto {
    @IsOptional() @IsString() @MaxLength(3) currency?: string;
    @IsOptional() @IsInt() @Min(0) @Max(10_000) taxRateBps?: number;
    @IsOptional() @IsInt() @Min(0) @Max(365) paymentTermsDays?: number;
    @IsOptional() @IsString() @MaxLength(20) invoicePrefix?: string;
    @IsOptional() @IsInt() @Min(1) nextInvoiceNumber?: number;
    @IsOptional() @IsString() @MaxLength(20) quotePrefix?: string;
    @IsOptional() @IsInt() @Min(1) nextQuoteNumber?: number;
    @IsOptional() @IsInt() @Min(0) laborCostCents?: number;
    @IsOptional() @IsInt() @Min(0) defaultHourlyRateCents?: number;
    @IsOptional() @IsString() @MaxLength(2000) footer?: string;
    @IsOptional() @IsString() @MaxLength(500) publicBaseUrl?: string;
    @IsOptional() @IsString() @MaxLength(500) stripeSecretKey?: string;
    @IsOptional() @IsString() @MaxLength(500) stripeWebhookSecret?: string;
}

class SendDto {
    @IsOptional() @IsEmail() to?: string;
}

class PaymentDto {
    @IsInt() @Min(1) amountCents!: number;
    @IsIn(["cash", "check", "transfer", "card", "other"]) method!: string;
    @IsOptional() @IsString() @MaxLength(200) reference?: string;
    @IsOptional() @IsString() paidAt?: string;
}

class AddTimeDto {
    @IsOptional() @IsInt() @Min(1) rateCents?: number;
}

class ListQuery {
    @IsOptional() @IsIn(["invoice", "quote"]) kind?: string;
    @IsOptional() @IsString() status?: string;
    @IsOptional() @IsUUID("all") clientId?: string;
    @IsOptional() @IsUUID("all") cursor?: string;
    @IsOptional() @IsString() limit?: string;
}

class TimeQuery {
    @IsOptional() @IsUUID("all") userId?: string;
    @IsOptional() @IsUUID("all") clientId?: string;
    @IsOptional() @IsUUID("all") ticketId?: string;
    @IsOptional() @IsIn(["pending", "approved"]) status?: string;
    @IsOptional() @IsString() from?: string;
    @IsOptional() @IsString() to?: string;
}

class RangeQuery {
    @IsString() from!: string;
    @IsString() to!: string;
}

const userOf = (req: any): string => {
    const id = req?.user?.id;
    if (!id) throw new ForbiddenException("Sign in again.");
    return id;
};

/** Everyone who can work tickets logs their own time. Only someone who manages billing can approve it. */
const canApprove = (req: any): boolean => req?.effectivePermissions?.has?.("billing.write") === true;

/** Typing time in, or changing what was logged, is its own right. The ticket timer needs only the right to work tickets. */
const canManualTime = (req: any): boolean => req?.effectivePermissions?.has?.("tickets.time.manual") === true;

const PUBLIC_WINDOW_MS = 60_000;
const PUBLIC_MAX_PER_WINDOW = 60;
const publicHits = new Map<string, { count: number; resetAt: number }>();

/** These routes need no account, so one address gets a limited number of tries a minute. */
function limitPublic(req: any): void {
    const cf = req.headers?.["cf-connecting-ip"];
    const ip = typeof cf === "string" && cf ? cf : String(req.headers?.["x-forwarded-for"] ?? req.socket?.remoteAddress ?? "unknown").split(",")[0].trim();
    const now = Date.now();
    if (publicHits.size > 50_000) publicHits.clear();
    const entry = publicHits.get(ip);
    if (!entry || entry.resetAt <= now) {
        publicHits.set(ip, { count: 1, resetAt: now + PUBLIC_WINDOW_MS });
        return;
    }
    entry.count++;
    if (entry.count > PUBLIC_MAX_PER_WINDOW) throw new HttpException("Too many requests. Try again in a minute.", HttpStatus.TOO_MANY_REQUESTS);
}

@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller("api/billing")
export class BillingController {
    constructor(private readonly billing: BillingService) { }

    @Get("settings")
    @RequirePerm("billing.read")
    settings() {
        return this.billing.getSettings();
    }

    @Put("settings")
    @RequirePerm("billing.write")
    saveSettings(@Body() body: SettingsDto) {
        return this.billing.saveSettings(body);
    }

    /* catalog */

    @Get("catalog")
    @RequirePerm("billing.read")
    catalog() {
        return this.billing.listCatalog();
    }

    @Post("catalog")
    @RequirePerm("billing.write")
    createItem(@Body() body: CatalogDto) {
        return this.billing.saveCatalogItem(null, body);
    }

    @Put("catalog/:id")
    @RequirePerm("billing.write")
    updateItem(@Param("id", new ParseUUIDPipe()) id: string, @Body() body: CatalogDto) {
        return this.billing.saveCatalogItem(id, body);
    }

    @Delete("catalog/:id")
    @RequirePerm("billing.write")
    deleteItem(@Param("id", new ParseUUIDPipe()) id: string) {
        return this.billing.deleteCatalogItem(id);
    }

    /* time */

    @Get("time")
    @RequirePerm("tickets.read")
    time(@Query() query: TimeQuery) {
        return this.billing.listTime(query);
    }

    @Post("time")
    @RequirePerm(["tickets.write", "tickets.time.manual"])
    createTime(@Body() body: TimeDto, @Req() req: any) {
        return this.billing.createTime(body, userOf(req));
    }

    @Post("time/approve")
    @RequirePerm("billing.write")
    approveTime(@Body() body: ApproveDto, @Req() req: any) {
        return this.billing.approveTime(body.ids, userOf(req), body.approved);
    }

    @Put("time/:id")
    @RequirePerm("tickets.write")
    updateTime(@Param("id", new ParseUUIDPipe()) id: string, @Body() body: TimeDto, @Req() req: any) {
        return this.billing.updateTime(id, body, userOf(req), canApprove(req), canManualTime(req));
    }

    @Delete("time/:id")
    @RequirePerm("tickets.write")
    deleteTime(@Param("id", new ParseUUIDPipe()) id: string, @Req() req: any) {
        return this.billing.deleteTime(id, userOf(req), canApprove(req));
    }

    /* contracts */

    @Get("contracts")
    @RequirePerm("billing.read")
    contracts() {
        return this.billing.listContracts();
    }

    @Post("contracts")
    @RequirePerm("billing.write")
    createContract(@Body() body: ContractDto) {
        return this.billing.createContract(body);
    }

    @Post("contracts/run")
    @RequirePerm("billing.write")
    runNow() {
        return this.billing.generateDueInvoices();
    }

    @Put("contracts/:id")
    @RequirePerm("billing.write")
    updateContract(@Param("id", new ParseUUIDPipe()) id: string, @Body() body: ContractDto) {
        return this.billing.updateContract(id, body);
    }

    @Delete("contracts/:id")
    @RequirePerm("billing.write")
    deleteContract(@Param("id", new ParseUUIDPipe()) id: string) {
        return this.billing.deleteContract(id);
    }

    /* reports (before the routes with an id) */

    @Get("reports/profitability")
    @RequirePerm("billing.read")
    profitability(@Query() query: RangeQuery) {
        return this.billing.profitability(query);
    }

    @Get("reports/invoices.csv")
    @RequirePerm("billing.read")
    async exportCsv(@Query() query: RangeQuery, @Res() res: Response) {
        const csv = await this.billing.exportInvoicesCsv(query);
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="invoices-${query.from}-to-${query.to}.csv"`);
        res.send(csv);
    }

    /* invoices and quotes */

    @Get("invoices")
    @RequirePerm("invoices.read")
    list(@Query() query: ListQuery) {
        return this.billing.listInvoices(query);
    }

    @Post("invoices")
    @RequirePerm("billing.write")
    create(@Body() body: InvoiceDto) {
        return this.billing.createInvoice(body);
    }

    @Get("invoices/:id")
    @RequirePerm("invoices.read")
    get(@Param("id", new ParseUUIDPipe()) id: string) {
        return this.billing.getInvoice(id);
    }

    @Get("invoices/:id/pdf")
    @RequirePerm("invoices.read")
    async pdf(@Param("id", new ParseUUIDPipe()) id: string, @Res() res: Response) {
        const { filename, data } = await this.billing.pdf(id);
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
        res.send(data);
    }

    @Put("invoices/:id")
    @RequirePerm("billing.write")
    update(@Param("id", new ParseUUIDPipe()) id: string, @Body() body: InvoiceDto) {
        return this.billing.updateInvoice(id, body);
    }

    @Delete("invoices/:id")
    @RequirePerm("billing.write")
    remove(@Param("id", new ParseUUIDPipe()) id: string) {
        return this.billing.deleteInvoice(id);
    }

    @Post("invoices/:id/send")
    @RequirePerm("billing.write")
    send(@Param("id", new ParseUUIDPipe()) id: string, @Body() body: SendDto) {
        return this.billing.send(id, body.to);
    }

    @Post("invoices/:id/void")
    @RequirePerm("billing.write")
    void(@Param("id", new ParseUUIDPipe()) id: string) {
        return this.billing.voidInvoice(id);
    }

    @Post("invoices/:id/convert")
    @RequirePerm("billing.write")
    convert(@Param("id", new ParseUUIDPipe()) id: string) {
        return this.billing.convertQuote(id);
    }

    @Post("invoices/:id/add-time")
    @RequirePerm("billing.write")
    addTime(@Param("id", new ParseUUIDPipe()) id: string, @Body() body: AddTimeDto) {
        return this.billing.addUnbilledTime(id, body.rateCents);
    }

    @Post("invoices/:id/payments")
    @RequirePerm("billing.write")
    pay(@Param("id", new ParseUUIDPipe()) id: string, @Body() body: PaymentDto, @Req() req: any) {
        return this.billing.recordPayment(id, body, userOf(req));
    }

    @Delete("invoices/:id/payments/:paymentId")
    @RequirePerm("billing.write")
    unpay(@Param("id", new ParseUUIDPipe()) id: string, @Param("paymentId", new ParseUUIDPipe()) paymentId: string) {
        return this.billing.removePayment(id, paymentId);
    }
}

/**
 * For customers, who have no account. The long random token in the link is the only credential, and
 * only a hash of it is stored, so a copy of the database cannot be used to open invoices.
 */
@Public()
@Controller("api/public/billing")
export class PublicBillingController {
    constructor(private readonly billing: BillingService) { }

    @Get("documents/:token")
    view(@Param("token") token: string, @Req() req: any) {
        limitPublic(req);
        return this.billing.publicView(token);
    }

    @Get("documents/:token/pdf")
    async pdf(@Param("token") token: string, @Req() req: any, @Res() res: Response) {
        limitPublic(req);
        const { filename, data } = await this.billing.publicPdf(token);
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
        res.send(data);
    }

    @Post("documents/:token/checkout")
    @HttpCode(200)
    checkout(@Param("token") token: string, @Req() req: any) {
        limitPublic(req);
        return this.billing.createCheckout(token);
    }

    @Post("documents/:token/accept")
    @HttpCode(200)
    accept(@Param("token") token: string, @Req() req: any) {
        limitPublic(req);
        return this.billing.respondToQuote(token, true);
    }

    @Post("documents/:token/decline")
    @HttpCode(200)
    decline(@Param("token") token: string, @Req() req: any) {
        limitPublic(req);
        return this.billing.respondToQuote(token, false);
    }

    @Post("stripe-webhook")
    @HttpCode(200)
    async webhook(@Req() req: any, @Headers("stripe-signature") signature: string | undefined) {
        await this.billing.handleStripeWebhook(req.body, signature);
        return { received: true };
    }
}
