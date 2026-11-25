// backend/src/audit/audit.interceptor.ts
import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import { from, Observable } from "rxjs";
import { switchMap, tap } from "rxjs/operators";
import { auditRuleFor, AuditRule, normalizeRoutePath } from "./audit-routes";
import { AuditOutcome, AuditService } from "./audit.service";
import { pickFields } from "./audit.util";
import { adminKeyMatches } from "../common/admin-key";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

type Actor = { id: string | null; email: string | null };

function firstString(source: any, fields: string[] | undefined): string | null {
    for (const field of fields ?? []) {
        const value = source?.[field];
        if (typeof value === "string" && value.trim()) return value.trim();
    }
    return null;
}

/** The admin API key passes every guard without a user, so its use has to be attributed too. */
function actorOf(req: any): Actor | null {
    if (req.user?.id) return { id: String(req.user.id), email: req.user.email ?? null };
    const key = req.headers?.["x-admin-api-key"];
    if (adminKeyMatches(key)) {
        return { id: null, email: "admin-api-key" };
    }
    return null;
}

function targetIdBefore(rule: AuditRule, req: any): string | null {
    const param = rule.targetParam ? req.params?.[rule.targetParam] : null;
    if (typeof param === "string" && param) return param;
    return firstString(req.body, rule.targetBody);
}

/**
 * Records mutating requests by signed-in users. Handler failures come through here too; refusals
 * by a guard do not, so PermissionsGuard records those. Agent routes are skipped because they
 * are machine traffic with no person to hold to account.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
    constructor(private readonly audit: AuditService) { }

    intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
        if (context.getType() !== "http") return next.handle();

        const http = context.switchToHttp();
        const req = http.getRequest<any>();
        const res = http.getResponse<any>();
        const method = String(req?.method ?? "").toUpperCase();
        const routePath = req?.route?.path;

        if (!MUTATING.has(method) || typeof routePath !== "string") return next.handle();

        const path = normalizeRoutePath(routePath);
        if (!path.startsWith("/api/") || path === "/api/agent" || path.startsWith("/api/agent/")) {
            return next.handle();
        }

        const actor = actorOf(req);
        const rule = auditRuleFor(method, path);
        if (!actor || rule.skip) return next.handle();

        const targetId = targetIdBefore(rule, req);
        const label = this.audit.lookupLabel(rule.targetType, targetId);

        let done = false;
        const finish = (outcome: AuditOutcome, status: number, response?: any) => {
            if (done) return;
            done = true;
            void this.write(rule, req, actor, outcome, status, targetId, label, response);
        };
        const httpStatus = () => Number(res?.statusCode) || 200;

        // The handler waits for the name, because a delete would otherwise race it and take it away.
        return from(label).pipe(
            switchMap(() => next.handle()),
            tap({
                next: (response) => {
                    const failed = httpStatus() >= 400 || (response as any)?.ok === false;
                    finish(failed ? "failure" : "success", httpStatus(), response);
                },
                complete: () => finish(httpStatus() >= 400 ? "failure" : "success", httpStatus()),
                error: (err) => finish("failure", typeof err?.getStatus === "function" ? err.getStatus() : 500),
            }),
        );
    }

    private async write(
        rule: AuditRule,
        req: any,
        actor: Actor,
        outcome: AuditOutcome,
        status: number,
        targetIdFromRequest: string | null,
        label: Promise<string | null>,
        response: any,
    ): Promise<void> {
        try {
            const fromResponse = rule.targetResponse ? response?.[rule.targetResponse] : null;
            const targetId = targetIdFromRequest ?? (fromResponse != null ? String(fromResponse) : null);
            const targetLabel = (await label) ?? firstString(req.body, rule.labelBody ? [rule.labelBody] : undefined);

            await this.audit.record({
                action: rule.action,
                category: rule.category,
                outcome,
                actorUserId: actor.id,
                actorEmail: actor.email,
                targetType: targetId || targetLabel ? rule.targetType : null,
                targetId,
                targetLabel,
                req,
                details: { ...pickFields(req.body, rule.fields), status },
            });
        } catch {
            // Auditing must never affect the request it describes.
        }
    }
}
