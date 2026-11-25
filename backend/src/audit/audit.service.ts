// backend/src/audit/audit.service.ts
import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { Prisma } from "@prisma/client";
import { isCanonicalUuid } from "../common/agent-lookup.util";
import { PrismaService } from "../storage/prisma.service";
import { auditRuleFor } from "./audit-routes";
import { cleanText, clientIpOf, scrubDetails } from "./audit.util";
import type { AuditQueryDto } from "./audit.dto";

export type AuditOutcome = "success" | "failure";

type RequestLike = { headers?: Record<string, unknown>; socket?: { remoteAddress?: string } };

export type AuditEventInput = {
    action: string;
    category: string;
    outcome: AuditOutcome;
    actorUserId?: string | null;
    actorEmail?: string | null;
    targetType?: string | null;
    targetId?: string | null;
    targetLabel?: string | null;
    /** The incoming request or WebSocket upgrade, for the address and user agent. */
    req?: RequestLike | null;
    details?: Record<string, unknown> | null;
};

export type SignInEvent = {
    req: RequestLike;
    outcome: AuditOutcome;
    email?: string | null;
    userId?: string | null;
    action?: string;
    reason?: string;
    via?: string;
};

const DEFAULT_RETENTION_DAYS = 365;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const EXPORT_BATCH = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const BLOCKED_EVENT_INTERVAL_MS = 60_000;
const MAX_TRACKED_BLOCKS = 10_000;

export function retentionDays(raw = process.env.AUDIT_RETENTION_DAYS): number {
    const days = Number(raw);
    return Number.isInteger(days) && days > 0 ? days : DEFAULT_RETENTION_DAYS;
}

/** Prisma passes % and _ to LIKE as wildcards, but a search here means the literal characters. */
function literal(text: string): string {
    return text.replace(/[\\%_]/g, "\\$&");
}

function parseDate(value: string | undefined, name: string): Date | undefined {
    if (!value) return undefined;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw new BadRequestException(`Invalid ${name} date.`);
    return date;
}

type Cursor = { createdAt: Date; id: string };

function encodeCursor(row: { created_at: Date; id: string }): string {
    return Buffer.from(`${row.created_at.toISOString()}|${row.id}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): Cursor {
    const [iso, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
    const createdAt = new Date(iso ?? "");
    if (Number.isNaN(createdAt.getTime()) || !isCanonicalUuid(id ?? "")) {
        throw new BadRequestException("Invalid cursor.");
    }
    return { createdAt, id };
}

function afterCursor(cursor: Cursor): Prisma.audit_eventsWhereInput {
    return {
        OR: [
            { created_at: { lt: cursor.createdAt } },
            { created_at: cursor.createdAt, id: { lt: cursor.id } },
        ],
    };
}

const NEWEST_FIRST: Prisma.audit_eventsOrderByWithRelationInput[] = [{ created_at: "desc" }, { id: "desc" }];

/**
 * The audit trail is append-only: this service offers no way to change or remove a single row, and
 * the retention sweep is the only delete.
 */
@Injectable()
export class AuditService {
    private readonly logger = new Logger(AuditService.name);
    private readonly lastBlocked = new Map<string, number>();

    constructor(private readonly prisma: PrismaService) { }

    /** Never rejects: losing an audit row must not fail the action it describes. */
    async record(event: AuditEventInput): Promise<void> {
        try {
            const actorId = event.actorUserId && isCanonicalUuid(event.actorUserId) ? event.actorUserId : null;
            const details = event.details ? (scrubDetails(event.details) as Record<string, unknown>) : null;
            await this.prisma.audit_events.create({
                data: {
                    actor_user_id: actorId,
                    actor_email: cleanText(event.actorEmail, 320),
                    action: cleanText(event.action, 200) ?? "unknown",
                    category: cleanText(event.category, 64) ?? "other",
                    target_type: cleanText(event.targetType, 64),
                    target_id: cleanText(event.targetId, 300),
                    target_label: cleanText(event.targetLabel, 300),
                    ip: event.req ? clientIpOf(event.req) : null,
                    user_agent: cleanText(event.req?.headers?.["user-agent"], 512),
                    outcome: event.outcome,
                    details: details && Object.keys(details).length ? (details as Prisma.InputJsonValue) : undefined,
                },
            });
        } catch (err) {
            // Only the error code: a driver message can quote the values being written.
            this.logger.warn(`Could not record audit event ${event?.action}: ${(err as any)?.code ?? (err as Error)?.name}`);
        }
    }

    recordSignIn(event: SignInEvent): Promise<void> {
        return this.record({
            action: event.action ?? "auth.signin",
            category: "auth",
            outcome: event.outcome,
            actorUserId: event.userId,
            actorEmail: event.email?.trim().toLowerCase(),
            req: event.req,
            details: { reason: event.reason, via: event.via },
        });
    }

    /**
     * These attempts need no valid credentials and nothing limits them, so each address and
     * account writes at most one row a minute rather than letting anyone fill the table.
     */
    recordSignInBlocked(event: Omit<SignInEvent, "outcome">): Promise<void> {
        const reason = event.reason ?? "rate_limited";
        const account = event.email?.trim().toLowerCase() ?? event.userId ?? "";
        const key = `${clientIpOf(event.req) ?? ""}|${account}|${reason}`;
        const now = Date.now();
        if (now - (this.lastBlocked.get(key) ?? 0) < BLOCKED_EVENT_INTERVAL_MS) return Promise.resolve();
        if (this.lastBlocked.size >= MAX_TRACKED_BLOCKS) this.lastBlocked.clear();
        this.lastBlocked.set(key, now);
        return this.recordSignIn({ ...event, outcome: "failure", reason });
    }

    /** A guard refuses before any interceptor runs, so refused changes are recorded from the guard. */
    recordDenied(req: any, permission: string): Promise<void> {
        const method = String(req?.method ?? "").toUpperCase();
        if (!["POST", "PUT", "PATCH", "DELETE"].includes(method) || !req?.route?.path) return Promise.resolve();
        const rule = auditRuleFor(method, req.route.path);
        const param = rule.targetParam ? req.params?.[rule.targetParam] : null;
        return this.record({
            action: rule.action,
            category: rule.category,
            outcome: "failure",
            actorUserId: req.user?.id,
            actorEmail: req.user?.email,
            targetType: param ? rule.targetType : null,
            targetId: param,
            req,
            details: { status: 403, reason: "permission_denied", permission },
        });
    }

    /** Finds a readable name for a target. Returns null rather than failing. */
    async lookupLabel(type: string | null | undefined, id: string | null | undefined): Promise<string | null> {
        if (!type || !id) return null;
        try {
            const uuid = isCanonicalUuid(id);
            switch (type) {
                case "device": {
                    const agent = await this.prisma.agents.findFirst({
                        where: { OR: [{ agent_uuid: id }, ...(uuid ? [{ id }, { device_id: id }] : [])] },
                        select: { hostname: true, devices: { select: { hostname: true } } },
                    });
                    if (agent) return agent.devices?.hostname ?? agent.hostname ?? null;
                    if (!uuid) return null;
                    const row = await this.prisma.devices.findUnique({ where: { id }, select: { hostname: true } });
                    return row?.hostname ?? null;
                }
                case "user": {
                    if (!uuid) return null;
                    const row = await this.prisma.users.findUnique({ where: { id }, select: { email: true } });
                    return row?.email ?? null;
                }
                case "role": {
                    if (!uuid) return null;
                    const row = await this.prisma.roles.findUnique({ where: { id }, select: { name: true } });
                    return row?.name ?? null;
                }
                case "ticket": {
                    if (!uuid) return null;
                    const row = await this.prisma.tickets.findUnique({ where: { id }, select: { ticket_number: true } });
                    return row ? `#${row.ticket_number}` : null;
                }
                case "customer": {
                    if (!uuid) return id;
                    const row = await this.prisma.clients.findUnique({ where: { id }, select: { name: true } });
                    return row?.name ?? null;
                }
                case "site": {
                    if (!uuid) return id;
                    const row = await this.prisma.sites.findUnique({ where: { id }, select: { name: true } });
                    return row?.name ?? null;
                }
                default:
                    return null;
            }
        } catch {
            return null;
        }
    }

    private whereFor(query: AuditQueryDto): Prisma.audit_eventsWhereInput {
        const and: Prisma.audit_eventsWhereInput[] = [];
        const contains = (text: string) => ({ contains: literal(text), mode: "insensitive" as const });

        if (query.category) and.push({ category: query.category });
        if (query.outcome) and.push({ outcome: query.outcome });
        if (query.action) and.push({ action: { startsWith: literal(query.action), mode: "insensitive" } });
        if (query.actor) {
            and.push(isCanonicalUuid(query.actor) ? { actor_user_id: query.actor } : { actor_email: contains(query.actor) });
        }
        if (query.target) {
            and.push({ OR: [{ target_id: query.target }, { target_label: contains(query.target) }] });
        }
        if (query.q) {
            and.push({
                OR: [
                    { action: contains(query.q) },
                    { actor_email: contains(query.q) },
                    { target_type: contains(query.q) },
                    { target_id: contains(query.q) },
                    { target_label: contains(query.q) },
                    { ip: contains(query.q) },
                ],
            });
        }
        const from = parseDate(query.from, "from");
        const to = parseDate(query.to, "to");
        if (from) and.push({ created_at: { gte: from } });
        if (to) and.push({ created_at: { lte: to } });
        return { AND: and };
    }

    async list(query: AuditQueryDto) {
        const limit = Math.min(Math.max(Number(query.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
        const where = this.whereFor(query);
        const rows = await this.prisma.audit_events.findMany({
            where: query.cursor ? { AND: [where, afterCursor(decodeCursor(query.cursor))] } : where,
            orderBy: NEWEST_FIRST,
            take: limit + 1,
        });
        const page = rows.slice(0, limit);
        return {
            items: page,
            nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]) : null,
        };
    }

    /** Pages through a whole result without holding it in memory. A bad filter rejects on the first row. */
    async *exportRows(query: AuditQueryDto, maxRows: number) {
        const where = this.whereFor(query);
        let cursor: Cursor | null = null;
        let sent = 0;
        while (sent < maxRows) {
            const batch: Prisma.audit_eventsGetPayload<object>[] = await this.prisma.audit_events.findMany({
                where: cursor ? { AND: [where, afterCursor(cursor)] } : where,
                orderBy: NEWEST_FIRST,
                take: Math.min(EXPORT_BATCH, maxRows - sent),
            });
            if (!batch.length) return;
            for (const row of batch) yield row;
            sent += batch.length;
            const last = batch[batch.length - 1];
            cursor = { createdAt: last.created_at, id: last.id };
        }
    }

    @Cron(CronExpression.EVERY_DAY_AT_3AM)
    async sweep(): Promise<void> {
        try {
            const cutoff = new Date(Date.now() - retentionDays() * DAY_MS);
            const { count } = await this.prisma.audit_events.deleteMany({ where: { created_at: { lt: cutoff } } });
            if (count) this.logger.log(`Removed ${count} audit events past the retention period.`);
        } catch (err) {
            this.logger.warn(`Audit retention sweep failed: ${(err as any)?.code ?? (err as Error)?.name}`);
        }
    }
}
