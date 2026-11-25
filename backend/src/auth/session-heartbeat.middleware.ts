// backend/src/auth/session-heartbeat.middleware.ts
import { Injectable, NestMiddleware } from "@nestjs/common";
import type { Request, Response, NextFunction } from "express";
import { PrismaService } from "../storage/prisma.service";
import { isCanonicalUuid } from "../common/agent-lookup.util";
import { toInet } from "./user-identity.util";

/**
 * SessionHeartbeatMiddleware
 * - Runs only where you register it (we’ll scope it to /api/users/me/* in AppModule)
 * - Requires req.user.id and req.jti (populated by your AuthCookieMiddleware)
 * - Updates sessions.last_seen_at AFTER the response to avoid blocking requests
 * - Never throws; errors are swallowed (optional debug log in dev)
 */
@Injectable()
export class SessionHeartbeatMiddleware implements NestMiddleware {
    constructor(private readonly prisma: PrismaService) { }

    use(req: Request, res: Response, next: NextFunction) {
        const user: any = (req as any).user;
        const jti: any = (req as any).jti;

        if (!user?.id || !jti) {
            return next();
        }

        const userId = String(user.id);
        const jtiText = String(jti);
        if (!isCanonicalUuid(jtiText)) {
            return next();
        }

        const ua = String(req.headers["user-agent"] || "");
        const ip = toInet(
            (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
            (req.socket as any)?.remoteAddress,
        );

        // Fire-and-forget after response completes
        res.on("finish", () => {
            this.prisma.sessions
                .updateMany({
                    where: { id: jtiText, user_id: userId, revoked_at: null },
                    data: {
                        last_seen_at: new Date(),
                        ...(ua ? { user_agent: ua } : {}),
                        ...(ip ? { ip_address: ip } : {}),
                    },
                })
                .catch(() => {
                    // Optional dev log:
                    // if (process.env.NODE_ENV !== "production") console.debug("session heartbeat update failed");
                });
        });

        next();
    }
}
