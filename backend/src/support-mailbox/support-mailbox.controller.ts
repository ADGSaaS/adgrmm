import { BadRequestException, Body, Controller, Get, HttpCode, HttpStatus, Post, Put, Query, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { Public } from "../auth/public.decorator";
import { RequirePerm } from "../auth/require-perm.decorator";
import { SupportMailboxService } from "./support-mailbox.service";

function orgOf(req: Request): string {
    const u = (req as any)?.user;
    const org = u?.organizationId ?? u?.org ?? null;
    if (!org) throw new BadRequestException("No organization in the session.");
    return String(org);
}

/** The address Microsoft sends people back to. It has to match what is entered in the app registration. */
function redirectUriOf(req: Request): string {
    const configured = (process.env.PUBLIC_API_BASE_URL || "").trim().replace(/\/+$/, "");
    if (configured) return `${configured}/api/support-mailbox/callback`;
    const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "https").split(",")[0].trim();
    const host = String(req.headers["x-forwarded-host"] || req.get("host") || "").split(",")[0].trim();
    return `${proto}://${host}/api/support-mailbox/callback`;
}

@Controller("api/support-mailbox")
export class SupportMailboxController {
    constructor(private readonly svc: SupportMailboxService) { }

    @Get()
    @RequirePerm("settings.read")
    async get(@Req() req: Request) {
        return { ...(await this.svc.status(orgOf(req))), redirectUri: redirectUriOf(req) };
    }

    @Put()
    @RequirePerm("settings.write")
    async save(@Req() req: Request, @Body() body: { source?: "microsoft" | "imap"; tenantId?: string; clientId?: string; clientSecret?: string; enabled?: boolean }) {
        if (body?.source !== undefined && body.source !== "microsoft" && body.source !== "imap") throw new BadRequestException("source must be microsoft or imap");
        return { ...(await this.svc.save(orgOf(req), body ?? {})), redirectUri: redirectUriOf(req) };
    }

    @Post("connect")
    @HttpCode(HttpStatus.OK)
    @RequirePerm("settings.write")
    async connect(@Req() req: Request, @Body() body: { returnTo?: string }) {
        return { url: await this.svc.beginConnect(orgOf(req), redirectUriOf(req), body?.returnTo ?? null) };
    }

    /** Microsoft sends the browser here. The state in the address, saved when Connect was pressed, says who it is for. */
    @Public()
    @Get("callback")
    async callback(@Req() req: Request, @Res() res: Response, @Query() q: Record<string, string>) {
        const state = String(q.state ?? "");
        let ok = false;
        let message = "";
        let returnTo: string | null = null;
        if (q.error) {
            message = String(q.error_description ?? q.error).split(/\r?\n/)[0].slice(0, 300);
            returnTo = await this.svc.failConnect(state, message);
        } else if (q.code) {
            const r = await this.svc.completeConnect(state, String(q.code), redirectUriOf(req));
            ok = r.ok;
            message = r.message;
            returnTo = r.returnTo;
        } else {
            message = "Microsoft did not send a sign-in code.";
        }
        if (returnTo) {
            const url = new URL(returnTo);
            url.searchParams.set("mailbox", ok ? "connected" : "error");
            url.searchParams.set("message", message);
            return res.redirect(url.toString());
        }
        // Plain text with nosniff: shown as text, never parsed as markup, whatever the provider's message contains.
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.status(ok ? 200 : 400).type("text/plain").send(ok ? `${message}. You can close this page.` : message);
    }

    @Post("disconnect")
    @HttpCode(HttpStatus.OK)
    @RequirePerm("settings.write")
    async disconnect(@Req() req: Request) {
        return this.svc.disconnect(orgOf(req));
    }

    @Post("check-now")
    @HttpCode(HttpStatus.OK)
    @RequirePerm("settings.write")
    async checkNow(@Req() req: Request) {
        const org = orgOf(req);
        const result = await this.svc.pollOne(org);
        return { result, status: await this.svc.status(org) };
    }
}
