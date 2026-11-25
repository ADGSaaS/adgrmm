import { Body, CanActivate, Controller, ExecutionContext, Get, HttpCode, Injectable, Param, Post, Query, Req, Res, UnauthorizedException, UseGuards, createParamDecorator } from "@nestjs/common";
import type { Request, Response } from "express";
import { Public } from "../auth/public.decorator";
import { PortalAuthService, type PortalActor } from "./portal-auth.service";
import { PortalDataService } from "./portal-data.service";
import { PortalSettingsService } from "./portal-settings.service";
import { KbService } from "../kb/kb.service";
import { PORTAL_COOKIE } from "./portal.util";

/** Lets a request through only with a valid portal sign-in. Staff sign-ins do not work here, and portal ones do not work for staff. */
@Injectable()
export class PortalGuard implements CanActivate {
    constructor(private readonly auth: PortalAuthService) { }

    async canActivate(ctx: ExecutionContext): Promise<boolean> {
        const http = ctx.switchToHttp();
        const req = http.getRequest<Request & { portal?: PortalActor }>();
        http.getResponse<Response>().setHeader("Cache-Control", "no-store");
        const actor = await this.auth.authenticate((req as any).cookies?.[PORTAL_COOKIE]);
        if (!actor) throw new UnauthorizedException("Sign in to continue.");
        req.portal = actor;
        return true;
    }
}

export const Me = createParamDecorator((_data: unknown, ctx: ExecutionContext): PortalActor => ctx.switchToHttp().getRequest().portal);

function isHttps(req: Request): boolean {
    return req.secure || String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim() === "https";
}

function setSession(req: Request, res: Response, session: { token: string; maxAgeMs: number }) {
    res.cookie(PORTAL_COOKIE, session.token, { httpOnly: true, sameSite: "lax", secure: isHttps(req), path: "/", maxAge: session.maxAgeMs });
}

/** The customer portal's own API. Everything here answers only to portal sign-ins. */
@Public()
@Controller("api/portal")
export class PortalController {
    constructor(private readonly auth: PortalAuthService, private readonly data: PortalDataService, private readonly settings: PortalSettingsService, private readonly kb: KbService) { }

    /** Draws the sign-in page, and is how the web app learns which domain is the portal. */
    @Get("config")
    config(@Res({ passthrough: true }) res: Response) {
        res.setHeader("Cache-Control", "no-store");
        return this.settings.publicConfig();
    }

    /* ----------------------------------- auth ----------------------------------- */

    @Post("auth/login")
    @HttpCode(200)
    async login(@Body() b: { email?: string; password?: string }, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
        res.setHeader("Cache-Control", "no-store");
        setSession(req, res, await this.auth.login(b?.email, b?.password, req));
        return { ok: true };
    }

    @Post("auth/logout")
    @HttpCode(200)
    @UseGuards(PortalGuard)
    async logout(@Me() me: PortalActor, @Res({ passthrough: true }) res: Response) {
        await this.auth.logout(me.sessionId);
        res.clearCookie(PORTAL_COOKIE, { path: "/" });
        return { ok: true };
    }

    @Get("auth/me")
    @UseGuards(PortalGuard)
    async me(@Me() me: PortalActor) {
        const s = await this.settings.publicConfig();
        return {
            name: me.name, email: me.email, role: me.role, customer: me.clientName,
            modules: await this.data.modulesFor(me),
            unreadReplies: await this.data.unreadCount(me),
            allowTicketCreate: s.allowTicketCreate,
            welcomeTitle: s.welcomeTitle, welcomeText: s.welcomeText, supportEmail: s.supportEmail, supportPhone: s.supportPhone,
        };
    }

    /** What an invitation or reset link is for, so the page can say hello by name. */
    @Get("auth/link/:token")
    async link(@Param("token") token: string, @Req() req: Request) {
        return this.auth.describeLink(token, req);
    }

    @Post("auth/set-password")
    @HttpCode(200)
    async setPassword(@Body() b: { token?: string; password?: string }, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
        res.setHeader("Cache-Control", "no-store");
        setSession(req, res, await this.auth.setPassword(String(b?.token ?? ""), b?.password, req));
        return { ok: true };
    }

    /** The same answer whether or not the email has an account. */
    @Post("auth/forgot")
    @HttpCode(200)
    async forgot(@Body() b: { email?: string }, @Req() req: Request) {
        await this.auth.requestReset(b?.email, req);
        return { ok: true };
    }

    @Post("auth/change-password")
    @HttpCode(200)
    @UseGuards(PortalGuard)
    async changePassword(@Me() me: PortalActor, @Body() b: { current?: string; password?: string }) {
        await this.auth.changePassword(me, b?.current, b?.password);
        return { ok: true };
    }

    /* ----------------------------------- data ----------------------------------- */

    @Get("dashboard")
    @UseGuards(PortalGuard)
    dashboard(@Me() me: PortalActor) {
        return this.data.dashboard(me);
    }

    @Get("tickets")
    @UseGuards(PortalGuard)
    async tickets(@Me() me: PortalActor, @Query("status") status?: string, @Query("q") q?: string) {
        await this.data.requireModule(me, "tickets");
        return this.data.tickets(me, { status, q });
    }

    @Post("tickets")
    @UseGuards(PortalGuard)
    async createTicket(@Me() me: PortalActor, @Body() b: { subject?: string; description?: string; deviceId?: string }) {
        await this.data.requireModule(me, "tickets");
        return this.data.createTicket(me, b ?? {});
    }

    @Get("tickets/:id")
    @UseGuards(PortalGuard)
    async ticket(@Me() me: PortalActor, @Param("id") id: string) {
        await this.data.requireModule(me, "tickets");
        return this.data.ticket(me, id);
    }

    @Post("tickets/:id/replies")
    @HttpCode(200)
    @UseGuards(PortalGuard)
    async reply(@Me() me: PortalActor, @Param("id") id: string, @Body() b: { body?: string }) {
        await this.data.requireModule(me, "tickets");
        return this.data.reply(me, id, b?.body);
    }

    /* ------------------------- knowledge base (customer-visible articles only) ------------------------- */

    @Get("kb")
    @UseGuards(PortalGuard)
    async kbList(@Me() me: PortalActor, @Query("q") q?: string, @Query("category") category?: string) {
        await this.data.requireModule(me, "knowledge");
        return { ...(await this.kb.portalList({ orgId: me.orgId, accountId: me.accountId }, { q, category })), categories: await this.kb.portalCategories(me.orgId) };
    }

    @Get("kb/:id")
    @UseGuards(PortalGuard)
    async kbGet(@Me() me: PortalActor, @Param("id") id: string) {
        await this.data.requireModule(me, "knowledge");
        return this.kb.portalGet({ orgId: me.orgId, accountId: me.accountId }, id);
    }

    @Post("kb/:id/feedback")
    @HttpCode(200)
    @UseGuards(PortalGuard)
    async kbFeedback(@Me() me: PortalActor, @Param("id") id: string, @Body() b: { helpful?: unknown }) {
        await this.data.requireModule(me, "knowledge");
        return this.kb.portalFeedback({ orgId: me.orgId, accountId: me.accountId }, id, b?.helpful);
    }

    @Get("devices")
    @UseGuards(PortalGuard)
    devices(@Me() me: PortalActor) {
        return this.data.devices(me);
    }

    @Get("reports")
    @UseGuards(PortalGuard)
    async reports(@Me() me: PortalActor) {
        await this.data.requireModule(me, "reports");
        return this.data.reportList();
    }

    @Get("reports/:key/pdf")
    @UseGuards(PortalGuard)
    async reportPdf(@Me() me: PortalActor, @Param("key") key: string, @Query("days") days: string | undefined, @Res() res: Response) {
        const { filename, data } = await this.data.reportPdf(me, key, days);
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
        res.send(data);
    }

    @Get("invoices")
    @UseGuards(PortalGuard)
    invoices(@Me() me: PortalActor) {
        return this.data.invoices(me);
    }

    @Get("invoices/:id")
    @UseGuards(PortalGuard)
    invoice(@Me() me: PortalActor, @Param("id") id: string) {
        return this.data.invoice(me, id);
    }

    @Get("invoices/:id/pdf")
    @UseGuards(PortalGuard)
    async pdf(@Me() me: PortalActor, @Param("id") id: string, @Res() res: Response) {
        const { filename, data } = await this.data.invoicePdf(me, id);
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
        res.send(data);
    }

    @Post("invoices/:id/checkout")
    @HttpCode(200)
    @UseGuards(PortalGuard)
    async checkout(@Me() me: PortalActor, @Param("id") id: string) {
        const domain = (await this.settings.get()).domain;
        return this.data.checkout(me, id, `https://${domain}/invoices/${id}`);
    }
}
