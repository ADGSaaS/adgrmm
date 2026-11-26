// backend/src/demo-mode/demo-mode.controller.ts
import { Body, Controller, Get, HttpCode, NotFoundException, Post, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { Public } from "../auth/public.decorator";
import { UserAuthService } from "../auth/user-auth.service";
import { DemoModeService } from "./demo-mode.service";
import { isDemoMode } from "./demo-mode.rules";

/** The demo's own routes. In a normal install they all say "not a demo". */
@Controller("api/demo")
export class DemoModeController {
    constructor(private readonly demo: DemoModeService, private readonly users: UserAuthService) { }

    /** Lets the web app know whether it is the public demo. Needs no sign-in. */
    @Public()
    @Get("mode")
    mode() {
        if (!isDemoMode()) return { demo: false };
        const back = (process.env.DEMO_BACK_URL || "").trim();
        return {
            demo: true,
            idleSeconds: Math.max(15, Number(process.env.DEMO_IDLE_SECONDS || 60)),
            // Where the bar at the top of the demo leads back to (the website's demos page). Only web addresses are passed on.
            backUrl: /^https?:\/\//i.test(back) ? back : "",
        };
    }

    /** Signs the visitor in as the demo user, so there is no account to make and no password to know. */
    @Public()
    @Post("enter")
    @HttpCode(200)
    async enter(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
        if (!isDemoMode()) throw new NotFoundException();
        const email = process.env.DEMO_USER_EMAIL;
        const password = process.env.DEMO_USER_PASSWORD;
        if (!email || !password) throw new NotFoundException();
        const user = await this.users.validateUser(email, password);
        const { token, jti } = await this.users.signWithJti(user);
        const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || (req.socket as any)?.remoteAddress || "";
        await this.users.recordSessionOnLogin(user.id, jti, String(req.headers["user-agent"] || ""), String(ip));
        res.cookie(process.env.AUTH_COOKIE_NAME || "auth_token", token, {
            httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/",
            domain: process.env.AUTH_COOKIE_DOMAIN || undefined, maxAge: 8 * 3600_000,
        });
        return { ok: true };
    }

    /** Sent every few seconds while the demo is open. A minute without one counts as "closed". */
    @Public()
    @Post("ping")
    @HttpCode(204)
    ping(@Body() body: { id?: string }) {
        if (!isDemoMode()) throw new NotFoundException();
        this.demo.ping(typeof body?.id === "string" && body.id ? body.id : "anonymous");
    }
}
