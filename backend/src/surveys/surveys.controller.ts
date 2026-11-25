import { BadRequestException, Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query, Req, Res, UseGuards, forwardRef } from "@nestjs/common";
import type { Request, Response } from "express";
import { Public } from "../auth/public.decorator";
import { AuthRateLimiter } from "../auth/auth-rate-limiter.service";
import { RequirePerm } from "../auth/require-perm.decorator";
import { PortalGuard, Me } from "../portal/portal.controller";
import type { PortalActor } from "../portal/portal-auth.service";
import { TicketsService } from "../tickets/tickets.service";
import { SurveysService } from "./surveys.service";

const orgOf = (req: Request): string => {
    const u = (req as any)?.user;
    const org = u?.organizationId ?? u?.org ?? null;
    if (!org) throw new BadRequestException("No organization in the session.");
    return String(org);
};
const userOf = (req: Request): string | null => {
    const id = (req as any)?.user?.id;
    return id ? String(id) : null;
};

/** Administration > Surveys: the settings and the results. */
@Controller("api/admin/surveys")
export class SurveysAdminController {
    constructor(private readonly svc: SurveysService) { }

    @Get("settings")
    @RequirePerm("settings.read")
    settings(@Req() req: Request) {
        return this.svc.getSettings(orgOf(req));
    }

    @Put("settings")
    @RequirePerm("settings.write")
    save(@Req() req: Request, @Body() body: Record<string, unknown>) {
        return this.svc.saveSettings(orgOf(req), body ?? {}, userOf(req));
    }

    @Get("options")
    @RequirePerm("settings.read")
    options(@Req() req: Request) {
        return this.svc.options(orgOf(req));
    }

    @Get("summary")
    @RequirePerm("settings.read")
    summary(@Req() req: Request, @Query("days") days?: string) {
        return this.svc.summary(orgOf(req), days);
    }
}

/** The survey shown on a ticket's page: the ticket must be in the person's organization, as for every ticket route. */
@Controller("api/tickets")
export class TicketSurveyController {
    constructor(private readonly svc: SurveysService, @Inject(forwardRef(() => TicketsService)) private readonly tickets: TicketsService) { }

    @Get(":id/survey")
    @RequirePerm("tickets.read")
    async get(@Param("id") id: string, @Req() req: Request) {
        await this.tickets.assertVisible(id, req);
        return { survey: await this.svc.forTicket(orgOf(req), id) };
    }
}

function noStore(res: Response) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
}

/**
 * The link in the email. No sign-in: the signed, single-use, expiring token is the credential. It is also served under
 * /api/portal so that it works on the portal's own domain, which allows nothing else.
 */
@Public()
@Controller(["api/survey", "api/portal/survey"])
export class SurveyPublicController {
    constructor(private readonly svc: SurveysService, private readonly limiter: AuthRateLimiter) { }

    @Get(":token")
    async describe(@Param("token") token: string, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
        noStore(res);
        return this.svc.describe(token, this.limiter.clientIp(req));
    }

    @Post(":token")
    @HttpCode(200)
    async answer(@Param("token") token: string, @Body() body: { score?: unknown; comment?: unknown }, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
        noStore(res);
        return this.svc.answerByLink(token, body ?? {}, this.limiter.clientIp(req), req);
    }
}

/** The same survey on a ticket in the client portal, for the signed-in person. */
@Public()
@UseGuards(PortalGuard)
@Controller("api/portal/tickets")
export class SurveyPortalController {
    constructor(private readonly svc: SurveysService) { }

    @Get(":id/survey")
    get(@Me() me: PortalActor, @Param("id") id: string) {
        return this.svc.portalGet(me, id);
    }

    @Post(":id/survey")
    @HttpCode(200)
    answer(@Me() me: PortalActor, @Param("id") id: string, @Body() body: { score?: unknown; comment?: unknown }, @Req() req: Request) {
        return this.svc.portalAnswer(me, id, body ?? {}, req);
    }
}
