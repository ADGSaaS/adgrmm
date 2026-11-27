import { BadRequestException, Body, Controller, Get, HttpCode, HttpStatus, Post, Put, Query, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { Public } from "./public.decorator";
import { RequirePerm } from "./require-perm.decorator";
import { UserAuthService } from "./user-auth.service";
import { SsoService } from "./sso.service";
import { OidcError } from "./oidc";
import { AuditService } from "../audit/audit.service";
import { SecurityPolicyService } from "./security-policy.service";

/** The address the provider sends people back to. It has to match what is registered with the provider. */
function redirectUriOf(req: Request): string {
    const configured = (process.env.PUBLIC_API_BASE_URL || "").trim().replace(/\/+$/, "");
    if (configured) return `${configured}/api/auth/sso/callback`;
    const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "https").split(",")[0].trim();
    const host = String(req.headers["x-forwarded-host"] || req.get("host") || "").split(",")[0].trim();
    return `${proto}://${host}/api/auth/sso/callback`;
}

/** Sign in with a provider: the public pages the browser goes through. */
@Controller("api/auth/sso")
export class SsoController {
    constructor(
        private readonly sso: SsoService,
        private readonly users: UserAuthService,
        private readonly audit: AuditService,
        private readonly policy: SecurityPolicyService
    ) { }

    /** Whether to show the "Sign in with ..." button. */
    @Public()
    @Get("config")
    config() {
        return this.sso.publicStatus();
    }

    @Public()
    @Get("start")
    async start(@Req() req: Request, @Res() res: Response, @Query("returnTo") returnTo?: string) {
        try {
            return res.redirect(await this.sso.start(returnTo, redirectUriOf(req)));
        } catch (e: any) {
            res.setHeader("X-Content-Type-Options", "nosniff");
            return res.status(400).type("text/plain").send(e?.message ?? "Single sign-on is not available.");
        }
    }

    @Public()
    @Get("callback")
    async callback(@Req() req: Request, @Res() res: Response, @Query() q: Record<string, string>) {
        const state = String(q.state ?? "");
        const fail = (returnTo: string | null, code: string, message: string) => {
            void this.audit.recordSignIn({ req, outcome: "failure", reason: code, via: "sso" });
            if (returnTo) {
                const u = new URL("/login", new URL(returnTo).origin);
                u.searchParams.set("sso_error", code);
                return res.redirect(u.toString());
            }
            // Plain text with nosniff: a browser shows the message as text and never as markup, whatever the provider sent.
            res.setHeader("X-Content-Type-Options", "nosniff");
            return res.status(400).type("text/plain").send(message);
        };
        if (q.error) {
            // The person said no, or the provider is set up wrong. The state is still in the table until it expires.
            return fail(null, "sso_denied", String(q.error_description ?? q.error).split(/\r?\n/)[0].slice(0, 300));
        }
        if (!q.code) return fail(null, "sso_failed", "The provider did not send a sign-in code.");

        let result: Awaited<ReturnType<SsoService["finish"]>>;
        try {
            result = await this.sso.finish(state, String(q.code), redirectUriOf(req));
        } catch (e: any) {
            return fail((e as any)?.returnTo ?? null, e instanceof OidcError ? e.code : "sso_failed", e?.message ?? "The sign-in could not be completed.");
        }

        // The provider has already checked who this is, and its own second step (if any), so there is no local 2FA prompt.
        const user = await this.users.findUserById(result.userId);
        try {
            await this.policy.assertSignInAddress(req, user);
        } catch (e: any) {
            return fail(result.returnTo, "sso_ip_not_allowed", e?.message ?? "Sign-in is not allowed from this network address.");
        }
        const { token, jti } = await this.users.signWithJti(user);
        const ua = req.headers["user-agent"] || "";
        const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || (req.socket as any)?.remoteAddress || "";
        await this.users.recordSessionOnLogin(user.id, jti, String(ua), String(ip));
        void this.audit.recordSignIn({ req, outcome: "success", email: user.email, userId: user.id, via: "sso" });

        const cookieName = process.env.AUTH_COOKIE_NAME || "auth_token";
        res.cookie(cookieName, token, {
            httpOnly: true,
            sameSite: "lax",
            secure: process.env.NODE_ENV === "production",
            path: "/",
            domain: process.env.AUTH_COOKIE_DOMAIN || undefined,
            maxAge: Number(process.env.AUTH_COOKIE_MAX_AGE_MS || 7 * 24 * 60 * 60 * 1000),
        });
        if (result.returnTo) return res.redirect(result.returnTo);
        return res.type("text/plain").send("Signed in. You can close this page.");
    }
}

type SaveBody = {
    enabled?: boolean;
    displayName?: string;
    issuer?: string;
    clientId?: string;
    clientSecret?: string;
    scopes?: string;
    jitEnabled?: boolean;
    defaultRoleId?: string | null;
    allowedDomains?: string;
    passwordLogin?: boolean;
};

const orgOf = (req: Request): string => {
    const u = (req as any)?.user;
    const org = u?.organizationId ?? u?.org ?? null;
    if (!org) throw new BadRequestException("No organization in the session.");
    return String(org);
};

/** Single sign-on settings in Administration. */
@Controller("api/admin/sso")
export class SsoAdminController {
    constructor(private readonly sso: SsoService) { }

    @Get()
    @RequirePerm("settings.read")
    async get(@Req() req: Request) {
        return { ...(await this.sso.admin(orgOf(req))), redirectUri: redirectUriOf(req) };
    }

    @Put()
    @RequirePerm("settings.write")
    async save(@Req() req: Request, @Body() body: SaveBody) {
        return { ...(await this.sso.save(orgOf(req), body ?? {})), redirectUri: redirectUriOf(req) };
    }

    @Post("test")
    @HttpCode(HttpStatus.OK)
    @RequirePerm("settings.write")
    test(@Req() req: Request) {
        return this.sso.test(orgOf(req));
    }
}
