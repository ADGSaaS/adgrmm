// backend/src/auth/session-heartbeat.interceptor.ts
import {
    Injectable,
    NestInterceptor,
    ExecutionContext,
    CallHandler,
} from "@nestjs/common";
import type { Request } from "express";
import { Observable } from "rxjs";
import { finalize } from "rxjs/operators";
import { PrismaService } from "../storage/prisma.service";
import { isCanonicalUuid } from "../common/agent-lookup.util";
import { toInet } from "./user-identity.util";

/**
 * Updates sessions.last_seen_at for authenticated web users.
 * - NO-OP when req.user or req.jti are missing
 * - NO-OP for non-API paths and obvious public routes
 * - Never throws; DB errors are swallowed
 */
@Injectable()
export class SessionHeartbeatInterceptor implements NestInterceptor {
    constructor(private readonly prisma: PrismaService) { }

    intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
        const http = context.switchToHttp();
        const req = http.getRequest<Request>();

        // Only touch HTTP requests
        if (!req || !req.url) return next.handle();

        const url = req.url;

        // Skip non-API requests and public/docs/static routes
        // (adjust if your app has different mounts)
        const skip =
            !url.startsWith("/api") ||
            url.startsWith("/docs") ||
            url.startsWith("/static") ||
            url === "/healthz";

        if (skip) return next.handle();

        const user: any = (req as any).user;
        const jti: any = (req as any).jti;

        // If not authenticated or no JTI, do nothing
        if (!user?.id || !jti) {
            return next.handle();
        }

        // Capture request metadata before the stream completes
        const userId = String(user.id);
        const jtiText = String(jti);
        const ua = String(req.headers["user-agent"] || "");
        const ip = toInet(
            (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
            (req.socket as any)?.remoteAddress,
        );

        if (!isCanonicalUuid(jtiText)) return next.handle();

        return next.handle().pipe(
            finalize(() => {
                // Fire-and-forget: never block response, never throw.
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
                        // swallow errors; optionally add dev-only log:
                        if (process.env.NODE_ENV !== "production") {
                            // console.debug("Session heartbeat failed:", err?.message);
                        }
                    });
            }),
        );
    }
}
