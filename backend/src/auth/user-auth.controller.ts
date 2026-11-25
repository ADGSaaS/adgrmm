import { AuthRateLimiter } from "./auth-rate-limiter.service";
import { Body, Controller, Get, Post, Req, Res, BadRequestException } from "@nestjs/common";
import { ApiOkResponse, ApiTags } from "@nestjs/swagger";
import type { Request, Response } from "express";
import { LoginDto } from "./dto/login.dto";
import { Verify2FADto } from "./dto/verify-2fa.dto";
import { UserAuthService } from "./user-auth.service";
import { Public } from "./public.decorator";
import { AuditService } from "../audit/audit.service";
import { SecurityPolicyService } from "./security-policy.service";

/**
 * NOTE:
 * This file previously declared another AuthController under "api/auth",
 * colliding with auth.controller.ts routes.
 *
 * It is moved to /api/auth-legacy to avoid conflicts.
 * Prefer using backend/src/auth/auth.controller.ts going forward.
 */
@ApiTags("auth")
@Public() // ✅ bypass global AuthCookieGuard (legacy endpoints handle their own flow)
@Controller("api/auth-legacy")
export class LegacyAuthController {
    constructor(
        private readonly users: UserAuthService,
        private readonly limiter: AuthRateLimiter,
        private readonly audit: AuditService,
        private readonly policy: SecurityPolicyService,
    ) { }

    @Post("login")
    @ApiOkResponse({ description: "Sets auth cookie on success or returns 2FA challenge when required" })
    async login(
        @Body() dto: LoginDto & { deviceFingerprint?: string },
        @Req() req: Request,
        @Res({ passthrough: true }) res: Response
    ) {
        const clientIp = this.limiter.clientIp(req);
        try {
            this.limiter.assertAllowed(clientIp, dto.email);
        } catch (e) {
            void this.audit.recordSignInBlocked({ req, email: dto.email });
            throw e;
        }
        await this.policy.assertCaptcha(req, (dto as any).captchaToken);
        let user: Awaited<ReturnType<UserAuthService["validateUser"]>>;
        try {
            user = await this.users.validateUser(dto.email, dto.password);
        } catch (e) {
            this.limiter.recordFailure(clientIp, dto.email);
            void this.audit.recordSignIn({ req, outcome: "failure", email: dto.email, reason: "invalid_credentials" });
            throw e;
        }
        this.limiter.recordSuccess(dto.email);
        await this.policy.assertSignInAddress(req, user);

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

        const { token, jti } = await this.users.signWithJti(user);

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

        const cookieName = process.env.AUTH_COOKIE_NAME || "auth_token";
        const maxAgeMs = Number(process.env.AUTH_COOKIE_MAX_AGE_MS || 7 * 24 * 60 * 60 * 1000);
        res.cookie(cookieName, token, {
            httpOnly: true,
            sameSite: "lax",
            secure: process.env.NODE_ENV === "production",
            path: "/",
            maxAge: maxAgeMs,
        });

        return { user };
    }

    @Post("2fa/verify")
    @ApiOkResponse({ description: "Verifies TOTP or recovery code and sets auth cookie" })
    async verify2FA(
        @Body() dto: Verify2FADto,
        @Req() req: Request,
        @Res({ passthrough: true }) res: Response
    ) {
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
            maxAge: maxAgeMs,
        });

        if (dto.rememberDevice) {
            const fp = dto.deviceFingerprint ?? jti;
            await this.users.trustCurrentDevice(userId, fp);
        }

        return { ok: true };
    }

    @Post("logout")
    @ApiOkResponse({ description: "Clears auth cookie" })
    async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
        const cookieName = process.env.AUTH_COOKIE_NAME || "auth_token";
        // The auth middleware skips this route, so the cookie is the only way to know who left.
        const token = (req as any).cookies?.[cookieName];
        const leaving = token ? await this.users.verify(token) : null;
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
        res.clearCookie(cookieName, { path: "/" });
        return { ok: true };
    }

    @Get("me")
    @ApiOkResponse({ description: "Current user (if authenticated)" })
    async me(@Req() req: Request) {
        const cookieName = process.env.AUTH_COOKIE_NAME || "auth_token";
        const token = (req as any).cookies?.[cookieName];
        if (!token) return { user: null };
        const user = await this.users.verify(token);
        return { user };
    }
}
