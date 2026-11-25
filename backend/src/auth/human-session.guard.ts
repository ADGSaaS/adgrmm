import {
    CanActivate,
    ExecutionContext,
    ForbiddenException,
    Injectable,
    UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";
import { parse as parseCookie } from "cookie";
import { PrismaService } from "../storage/prisma.service";

/**
 * Requires a real interactive browser session for especially sensitive
 * administration endpoints.
 *
 * This deliberately does NOT allow an admin API key to act as a substitute
 * for a human session.
 */
@Injectable()
export class HumanSessionGuard implements CanActivate {
    constructor(
        private readonly prisma: PrismaService,
    ) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const req = context.switchToHttp().getRequest<Request>();
        const user = (req as any).user;
        const sessionId = (req as any).jti;
        const authSource = (req as any).authSource;

        if (req.headers["x-admin-api-key"]) {
            throw new ForbiddenException(
                "Admin API keys cannot access system configuration.",
            );
        }

        const cookieName = process.env.AUTH_COOKIE_NAME || "auth_token";

        let cookies: Record<string, string | undefined> =
            ((req as any).cookies as
                | Record<string, string | undefined>
                | undefined) ?? {};

        if (
            !cookies[cookieName] &&
            !cookies.auth_token &&
            typeof req.headers.cookie === "string"
        ) {
            try {
                cookies = parseCookie(req.headers.cookie);
            } catch {
                cookies = {};
            }
        }

        const hasInteractiveCookie = Boolean(
            cookies[cookieName] || cookies.auth_token,
        );

        if (
            !user?.id ||
            !sessionId ||
            authSource !== "cookie" ||
            !hasInteractiveCookie
        ) {
            throw new UnauthorizedException(
                "An authenticated interactive browser session is required.",
            );
        }

        let activeSession = false;

        try {
            const session = await this.prisma.sessions.findFirst({
                where: {
                    id: String(sessionId),
                    user_id: String(user.id),
                    revoked_at: null,
                },
                select: { id: true },
            });

            activeSession = session !== null;
        } catch {
            activeSession = false;
        }

        if (!activeSession) {
            throw new UnauthorizedException(
                "An authenticated interactive browser session is required.",
            );
        }

        return true;
    }
}
