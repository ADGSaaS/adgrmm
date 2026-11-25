// backend/src/auth/auth.controller.ts

import { AuthRateLimiter } from "./auth-rate-limiter.service";
import { Body, Controller, Get, Post, Req, Res, BadRequestException, UnauthorizedException } from "@nestjs/common";
import { ApiOkResponse, ApiTags } from "@nestjs/swagger";
import type { Request, Response } from "express";
import { LoginDto } from "./dto/login.dto";
import { Verify2FADto } from "./dto/verify-2fa.dto";
import { UserAuthService } from "./user-auth.service";
import { PrismaService } from "../storage/prisma.service";
import { Public } from "./public.decorator";
import { AuditService } from "../audit/audit.service";
import { SsoService } from "./sso.service";
import { SecurityPolicyService } from "./security-policy.service";

@ApiTags("auth")
@Controller("api/auth")
export class AuthController {
    constructor(
        private readonly users: UserAuthService,
        private readonly db: PrismaService,          // ⬅️ DB access for permissions
        private readonly limiter: AuthRateLimiter,
        private readonly audit: AuditService,
        private readonly sso: SsoService,
        private readonly policy: SecurityPolicyService,
    ) { }

    /** Flattened permission keys for a user. */
    private async getUserPermissions(userId: string): Promise<string[]> {
        const rows = await this.db.role_permissions.findMany({
            where: { roles: { user_roles: { some: { user_id: userId } } } },
            select: { permission_key: true },
            distinct: ["permission_key"],
        });
        return rows.map((r) => r.permission_key).filter(Boolean);
    }

    @Public()
    @Post("login")
    @ApiOkResponse({ description: "Sets auth cookie on success or returns 2FA challenge when required" })
    async login(
        @Body() dto: LoginDto & { deviceFingerprint?: string },
        @Req() req: Request,
        @Res({ passthrough: true }) res: Response,
    ) {
        // 1) Validate user
        const clientIp = this.limiter.clientIp(req);
        try {
            this.limiter.assertAllowed(clientIp, dto.email);
        } catch (e) {
            void this.audit.recordSignInBlocked({ req, email: dto.email });
            throw e;
        }
        // The CAPTCHA (when it is on) comes before anything that touches a password.
        await this.policy.assertCaptcha(req, (dto as any).captchaToken);
        // Once single sign-on is required, passwords stop working for everyone except Owners.
        if (await this.sso.passwordBlocked(dto.email)) {
            void this.audit.recordSignIn({ req, outcome: "failure", email: dto.email, reason: "password_login_off" });
            throw new UnauthorizedException("Password sign-in is turned off. Use single sign-on.");
        }
        let user: Awaited<ReturnType<UserAuthService["validateUser"]>>;
        try {
            user = await this.users.validateUser(dto.email, dto.password);
        } catch (e) {
            this.limiter.recordFailure(clientIp, dto.email);
            void this.audit.recordSignIn({ req, outcome: "failure", email: dto.email, reason: "invalid_credentials" });
            throw e;
        }
        this.limiter.recordSuccess(dto.email);
        // Only listed addresses may sign in (Owners always can). Checked after the password so the list is not revealed to guessers.
        await this.policy.assertSignInAddress(req, user);

        // 2) 2FA gate
        const is2FAEnabled = await this.users.isTwoFactorEnabled(user.id);
        const deviceTrusted = await this.users.isDeviceTrusted(user.id, dto.deviceFingerprint ?? null);
        if (is2FAEnabled && !deviceTrusted) {
            const { token: challengeToken, jti } = await this.users.createChallengeToken(user.id);
            void this.audit.recordSignIn({
                req,
                outcome: "success",
                action: "auth.signin.password_accepted",
                email: user.email,
                userId: user.id,
            });
            return { status: "2fa_required" as const, challengeToken, jti };
        }

        // 3) Issue JWT with JTI
        const { token, jti } = await this.users.signWithJti(user);

        // 4) Record session
        const ua = req.headers["user-agent"] || "";
        const ip =
            (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
            (req.socket as any)?.remoteAddress ||
            "";
        await this.users.recordSessionOnLogin(user.id, jti, String(ua), String(ip));
        void this.audit.recordSignIn({
            req,
            outcome: "success",
            email: user.email,
            userId: user.id,
            via: is2FAEnabled ? "trusted_device" : "password",
        });

        // 5) Set cookie
        const cookieName = process.env.AUTH_COOKIE_NAME || "auth_token";
        const maxAgeMs = Number(process.env.AUTH_COOKIE_MAX_AGE_MS || 7 * 24 * 60 * 60 * 1000); // 7d
        res.cookie(cookieName, token, {
            httpOnly: true,
            sameSite: "lax",
            secure: process.env.NODE_ENV === "production",
            path: "/",
            domain: process.env.AUTH_COOKIE_DOMAIN || undefined,
            maxAge: maxAgeMs,
        });

        // 6) Attach permissions (so FE can use immediately after login if desired)
        const permissions = await this.getUserPermissions(user.id);

        return { user: { ...user, permissions }, sessionRules: await this.policy.sessionRules(user.organizationId) };
    }

    @Public()
    @Post("2fa/verify")
    @ApiOkResponse({ description: "Verifies TOTP or recovery code and sets auth cookie" })
    async verify2FA(@Body() dto: Verify2FADto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
        if (dto.code) dto.code = dto.code.trim();
        if (dto.recoveryCode) dto.recoveryCode = dto.recoveryCode.trim();

        if (!dto.code && !dto.recoveryCode) {
            throw new BadRequestException("Provide either 'code' or 'recoveryCode'.");
        }

        let challenge: Awaited<ReturnType<UserAuthService["verifyChallengeToken"]>>;
        try {
            challenge = await this.users.verifyChallengeToken(dto.challengeToken);
        } catch (e) {
            void this.audit.recordSignInBlocked({ req, reason: "invalid_2fa_challenge" });
            throw e;
        }
        const { userId, jti } = challenge;
        const limiterIp = this.limiter.clientIp(req);
        const limiterKey = `2fa:${userId}`;
        try {
            this.limiter.assertAllowed(limiterIp, limiterKey);
        } catch (e) {
            void this.audit.recordSignInBlocked({ req, userId });
            throw e;
        }

        let ok = false;
        if (dto.code) ok = await this.users.verifyTOTP(userId, dto.code);
        else if (dto.recoveryCode) ok = await this.users.consumeRecoveryCode(userId, dto.recoveryCode);

        if (!ok) {
            this.limiter.recordFailure(limiterIp, limiterKey);
            const failedUser = await this.users.findUserById(userId).catch(() => null);
            void this.audit.recordSignIn({
                req,
                outcome: "failure",
                email: failedUser?.email,
                userId,
                reason: dto.code ? "invalid_2fa_code" : "invalid_recovery_code",
            });
            throw new BadRequestException("Invalid code");
        }
        this.limiter.recordSuccess(limiterKey);

        const user = await this.users.findUserById(userId);
        await this.policy.assertSignInAddress(req, user);
        const { token, jti: newJti } = await this.users.signWithJti(user);

        const ua = req.headers["user-agent"] || "";
        const ip =
            (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
            (req.socket as any)?.remoteAddress ||
            "";
        await this.users.recordSessionOnLogin(userId, newJti, String(ua), String(ip));
        void this.audit.recordSignIn({
            req,
            outcome: "success",
            email: user.email,
            userId,
            via: dto.code ? "2fa_code" : "recovery_code",
        });

        const cookieName = process.env.AUTH_COOKIE_NAME || "auth_token";
        const maxAgeMs = Number(process.env.AUTH_COOKIE_MAX_AGE_MS || 7 * 24 * 60 * 60 * 1000);
        res.cookie(cookieName, token, {
            httpOnly: true,
            sameSite: "lax",
            secure: process.env.NODE_ENV === "production",
            path: "/",
            domain: process.env.AUTH_COOKIE_DOMAIN || undefined,
            maxAge: maxAgeMs,
        });

        if (dto.rememberDevice) {
            const fp = dto.deviceFingerprint ?? jti;
            await this.users.trustCurrentDevice(userId, fp);
        }

        return { ok: true };
    }

    @Public()
    @Post("logout")
    @ApiOkResponse({ description: "Clears auth cookie" })
    async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
        const cookieName = process.env.AUTH_COOKIE_NAME || "auth_token";
        // The auth middleware skips this route, so the cookie is the only way to know who left.
        const token = (req as any).cookies?.[cookieName];
        const leaving = token ? await this.users.verify(token) : null;
        // Signing out ends the session itself, so a copy of the cookie stops working too.
        if (leaving?.id) await this.users.revokeSessionOfToken(token, leaving.id);
        if (leaving?.id) {
            void this.audit.recordSignIn({
                req,
                outcome: "success",
                action: "auth.signout",
                email: leaving.email,
                userId: leaving.id,
            });
        }
        res.clearCookie(cookieName, {
            path: "/",
            domain: process.env.AUTH_COOKIE_DOMAIN || undefined,
        });
        return { ok: true };
    }

    @Public()
    @Get("me")
    @ApiOkResponse({ description: "Current user (if authenticated)" })
    async me(@Req() req: Request) {
        const cookieName = process.env.AUTH_COOKIE_NAME || "auth_token";
        const token = (req as any).cookies?.[cookieName];
        if (!token) return { user: null };

        const user = await this.users.verify(token);
        if (!user?.id) return { user: null };

        const permissions = await this.getUserPermissions(user.id);

        return { user: { ...user, permissions }, sessionRules: await this.policy.sessionRules(user.organizationId) };
    }
}
