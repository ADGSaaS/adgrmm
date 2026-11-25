// backend/src/alerts/alerts.service.ts
import { AccessScope, deviceWhereOf } from "../reports/client-access.service";
import { fireWorkflow } from "../workflows/workflows.bus";
import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../storage/prisma.service";
import { OrganizationContextService } from "../storage/organization-context.service";
import { TicketsService } from "../tickets/tickets.service";
import { WebhooksService } from "../webhooks/webhooks.service";
import { NotificationsService, type AlertEventName } from "../notifications/notifications.service";
import { PoliciesService } from "../policies/policies.service";
import type { Effective, ScalarKey } from "../policies/policy-engine";
import { activeWindow } from "../policies/time-window";

export enum AlertState {
    OPEN = "OPEN",
    ACKED = "ACKED",
    SILENCED = "SILENCED",
    RESOLVED = "RESOLVED",
}

export type AlertSeverity = "WARN" | "CRIT";

const SWEEP_EVERY_MS = 60_000;
const MAX_DETAIL = 2000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const BULK_LIMIT = 500;
const DEFAULT_SILENCE_HOURS = 24;

const SEVERITY_RANK: Record<AlertSeverity, number> = { WARN: 1, CRIT: 2 };

type RaiseInput = {
    deviceId: string;
    assignmentId?: string | null;
    kind: "check" | "offline" | "discovery" | "backup" | "edr";
    dedupeKey: string;
    severity: AlertSeverity;
    title: string;
    detail?: string | null;
    /** The caller already knows the device is not in a maintenance window. */
    maintenanceChecked?: boolean;
};

type ListParams = {
    state?: string[] | string;
    severity?: string[] | string;
    deviceId?: string;
    clientId?: string;
    siteId?: string;
    q?: string;
    limit?: number | string;
    cursor?: string;
};

const toArray = (v: string[] | string | undefined): string[] =>
    v === undefined ? [] : (Array.isArray(v) ? v : String(v).split(",")).map((s) => s.trim()).filter(Boolean);

@Injectable()
export class AlertsService {
    private readonly logger = new Logger(AlertsService.name);
    private readonly startedAt = Date.now();

    constructor(
        private readonly prisma: PrismaService,
        private readonly orgs: OrganizationContextService,
        private readonly tickets: TicketsService,
        private readonly notifications: NotificationsService,
        private readonly policies: PoliciesService,
        private readonly webhooks: WebhooksService,
    ) { }

    /** One alerting setting for one device: from the policies that reach it, or from the alert settings. */
    private async settingFor<T>(deviceId: string | null | undefined, key: ScalarKey, fallback: T): Promise<T> {
        if (!deviceId) return fallback;
        try {
            const e = await this.policies.effectiveForDevice(deviceId);
            const v = e?.scalars[key]?.value;
            return v === undefined || v === null ? fallback : (v as T);
        } catch (err) {
            this.logger.warn(`Could not read the policy for a device, using the alert settings: ${(err as Error).message}`);
            return fallback;
        }
    }

    /** Whether a maintenance window that mutes alerts is open for this device right now. */
    private mutedFrom(e: Effective | null | undefined): boolean {
        const m = e?.scalars.maintenance?.value as { windows: { name: string; days: number[]; start: string; end: string; timezone: string }[]; muteAlerts?: boolean } | undefined;
        return !!m && m.muteAlerts !== false && !!activeWindow(m.windows, Date.now());
    }

    private async mutedByMaintenance(deviceId: string | null | undefined): Promise<boolean> {
        if (!deviceId) return false;
        try {
            return this.mutedFrom(await this.policies.effectiveForDevice(deviceId));
        } catch (err) {
            this.logger.warn(`Could not read maintenance windows, alerting as usual: ${(err as Error).message}`);
            return false;
        }
    }

    private valueIn<T>(e: Effective | undefined, key: ScalarKey, fallback: T): T {
        const v = e?.scalars[key]?.value;
        return v === undefined || v === null ? fallback : (v as T);
    }

    /* ------------------------------ raising and clearing ------------------------------ */

    /** Called for each finished check run. Never throws, because a monitoring run must still be saved. */
    async onCheckRun(input: {
        deviceId: string;
        assignmentId: string;
        checkName: string;
        status: string;
        severity?: string | null;
        output?: string | null;
    }): Promise<void> {
        try {
            const dedupeKey = `check:${input.assignmentId}`;

            if (input.status === "OK") {
                await this.prisma.alert_pending.deleteMany({ where: { dedupe_key: dedupeKey } });
                await this.clear(dedupeKey, "The check is passing again.");
                return;
            }
            // Could not tell either way, which says nothing about the device.
            if (input.status !== "WARN" && input.status !== "CRIT" && input.status !== "TIMEOUT") return;

            const severity: AlertSeverity =
                input.status === "WARN" || input.severity === "WARN" ? "WARN" : "CRIT";
            const device = await this.prisma.devices.findUnique({
                where: { id: input.deviceId },
                select: { hostname: true, alias: true },
            });
            if (!device) return;

            await this.raise({
                deviceId: input.deviceId,
                assignmentId: input.assignmentId,
                kind: "check",
                dedupeKey,
                severity,
                title: `${input.checkName} on ${device.alias || device.hostname}`,
                detail: input.output,
            });
        } catch (err) {
            this.logger.error(`Could not evaluate a check run: ${(err as Error).message}`);
        }
    }

    async raise(input: RaiseInput): Promise<void> {
        // A device in a maintenance window is expected to be busy or restarting, so nothing is raised. If the problem is still there afterwards, it is raised then.
        if (!input.maintenanceChecked && (await this.mutedByMaintenance(input.deviceId))) return;
        const now = new Date();
        const detail = input.detail ? input.detail.slice(0, MAX_DETAIL) : null;

        const live = await this.prisma.alerts.findFirst({
            where: { dedupe_key: input.dedupeKey, state: { not: AlertState.RESOLVED } },
        });

        if (live) {
            const worse = SEVERITY_RANK[input.severity] > SEVERITY_RANK[live.severity as AlertSeverity];
            await this.prisma.alerts.update({
                where: { id: live.id },
                data: { last_seen_at: now, severity: worse ? input.severity : undefined, detail, title: input.title },
            });
            if (worse) {
                await this.addEvent(live.id, "escalated", null, `Now ${input.severity}.`);
                if (live.state !== AlertState.SILENCED) await this.announce(live.id, "escalated");
            }
            return;
        }

        // A check has to keep failing for the time a policy sets before it alerts, so a blip is not an alert.
        if (input.kind === "check") {
            const hold = await this.settingFor<number>(input.deviceId, "alerting.holdMinutes", 0);
            if (hold > 0) {
                let pending = await this.prisma.alert_pending.findUnique({ where: { dedupe_key: input.dedupeKey } });
                // A check that stopped reporting in between is not one continuous problem.
                if (pending && now.getTime() - pending.last_seen_at.getTime() > 2 * 3_600_000) {
                    await this.prisma.alert_pending.delete({ where: { dedupe_key: input.dedupeKey } });
                    pending = null;
                }
                pending = pending
                    ? await this.prisma.alert_pending.update({ where: { dedupe_key: input.dedupeKey }, data: { last_seen_at: now } })
                    : await this.prisma.alert_pending.create({ data: { dedupe_key: input.dedupeKey, device_id: input.deviceId } });
                if (now.getTime() - pending.first_seen_at.getTime() < hold * 60_000) return;
            }
        }

        // A problem that comes straight back reopens the alert it just closed, instead of starting a new alert and a new ticket.
        const reopenWithin = await this.settingFor<number>(input.deviceId, "alerting.reopenWithinMinutes", 0);
        if (reopenWithin > 0) {
            const recent = await this.prisma.alerts.findFirst({
                where: { dedupe_key: input.dedupeKey, state: AlertState.RESOLVED, resolved_at: { gte: new Date(now.getTime() - reopenWithin * 60_000) } },
                orderBy: { resolved_at: "desc" },
            });
            if (recent) {
                await this.prisma.alerts.update({
                    where: { id: recent.id },
                    data: { state: AlertState.OPEN, resolved_at: null, state_changed_at: now, last_seen_at: now, open_count: { increment: 1 }, severity: input.severity, title: input.title, detail },
                });
                await this.addEvent(recent.id, "reopened", null, "The problem came back soon after it cleared.");
                await this.prisma.alert_pending.deleteMany({ where: { dedupe_key: input.dedupeKey } });
                await this.reopenTicket(recent.ticket_id, input.title);
                return;
            }
        }

        let id: string;
        try {
            ({ id } = await this.prisma.alerts.create({
                data: {
                    device_id: input.deviceId,
                    assignment_id: input.assignmentId ?? null,
                    kind: input.kind,
                    dedupe_key: input.dedupeKey,
                    severity: input.severity,
                    title: input.title,
                    detail,
                },
                select: { id: true },
            }));
        } catch (err) {
            // Two runs raced, and the unique index let one through. It covers this problem.
            if ((err as Prisma.PrismaClientKnownRequestError)?.code === "P2002") return;
            throw err;
        }

        await this.prisma.alert_pending.deleteMany({ where: { dedupe_key: input.dedupeKey } });
        await this.addEvent(id, "opened", null, null);
        await this.announce(id, "opened");
        await this.maybeOpenTicket(id, input.severity);
        fireWorkflow({ trigger: "alert.opened", alertId: id, deviceId: input.deviceId });
        if (input.kind === "offline") fireWorkflow({ trigger: "device.offline", alertId: id, deviceId: input.deviceId });
    }

    /** The ticket an alert closed is opened again when the alert is reopened. */
    private async reopenTicket(ticketId: string | null, title: string): Promise<void> {
        if (!ticketId) return;
        try {
            const organizationId = await this.orgs.getDefaultOrganizationId();
            const req = { user: { organizationId, name: "RemoteIQ Alerts" } };
            const ticket = await this.tickets.getOne(ticketId, req);
            if (ticket && ticket.status === "resolved") await this.tickets.update(ticketId, { status: "open" } as any, req);
        } catch (err) {
            this.logger.error(`Could not reopen the ticket for "${title}": ${(err as Error).message}`);
        }
    }

    /** The problem went away by itself. */
    async clear(dedupeKey: string, reason: string): Promise<void> {
        const live = await this.prisma.alerts.findFirst({
            where: { dedupe_key: dedupeKey, state: { not: AlertState.RESOLVED } },
            select: { id: true },
        });
        if (live) await this.markResolved(live.id, null, reason);
    }

    private async markResolved(id: string, actor: string | null, reason: string | null): Promise<void> {
        const now = new Date();
        const alert = await this.prisma.alerts.update({
            where: { id },
            data: { state: AlertState.RESOLVED, resolved_at: now, state_changed_at: now, silenced_until: null },
            select: { ticket_id: true, title: true, device_id: true },
        });
        await this.addEvent(id, "resolved", actor, reason);
        await this.announce(id, "resolved");
        await this.maybeCloseTicket(alert.ticket_id, alert.title, alert.device_id);
    }

    private async addEvent(alertId: string, type: string, actor: string | null, reason: string | null) {
        await this.prisma.alert_events.create({
            data: { alert_id: alertId, type, actor_user_id: actor, reason },
        });
    }

    private async announce(alertId: string, event: AlertEventName) {
        try {
            await this.notifications.enqueueForAlert(alertId, event);
        } catch (err) {
            this.logger.error(`Could not queue notifications: ${(err as Error).message}`);
        }
        // Outbound webhooks (alert opened or resolved, device offline). Never blocks the alert.
        await this.webhooks.emitForAlert(alertId, event);
    }

    /* ------------------------------ periodic work ------------------------------ */

    @Interval(SWEEP_EVERY_MS)
    async sweep(): Promise<void> {
        try {
            await this.sweepOffline();
            await this.sweepSilences();
            await this.sweepRenotify();
            await this.prisma.alert_pending.deleteMany({ where: { last_seen_at: { lt: new Date(Date.now() - 24 * 3_600_000) } } });
        } catch (err) {
            this.logger.error(`Alert sweep failed: ${(err as Error).message}`);
        }
    }

    private async sweepOffline(): Promise<void> {
        const settings = await this.getSettings();
        const agents = await this.prisma.agents.findMany({
            select: {
                device_id: true,
                last_check_in_at: true,
                devices: { select: { hostname: true, alias: true } },
            },
        });

        // A policy can give a device its own wait. Devices no policy reaches use the alert settings.
        let effective: Map<string, Effective> = new Map();
        try {
            effective = await this.policies.effectiveForDevices(agents.map((a) => a.device_id));
        } catch (err) {
            this.logger.warn(`Could not read policies for the offline sweep, using the alert settings: ${(err as Error).message}`);
        }

        for (const agent of agents) {
            const dedupeKey = `offline:${agent.device_id}`;
            const lastSeen = agent.last_check_in_at;
            const windowMs = this.valueIn<number>(effective.get(agent.device_id), "alerting.offlineAfterMinutes", settings.offline_after_minutes) * 60_000;

            // After this server restarts, agents need time to report in, or every device would look offline.
            if (Date.now() - this.startedAt < windowMs) continue;
            const cutoff = new Date(Date.now() - windowMs);

            if (lastSeen && lastSeen >= cutoff) {
                await this.clear(dedupeKey, "The device is back online.");
            } else {
                if (this.mutedFrom(effective.get(agent.device_id))) continue;
                await this.raise({
                    maintenanceChecked: true,
                    deviceId: agent.device_id,
                    kind: "offline",
                    dedupeKey,
                    severity: "CRIT",
                    title: `${agent.devices.alias || agent.devices.hostname} is offline`,
                    detail: lastSeen ? `Last seen ${lastSeen.toISOString()}.` : "It has never reported in.",
                });
            }
        }
    }

    private async sweepSilences(): Promise<void> {
        const expired = await this.prisma.alerts.findMany({
            where: { state: AlertState.SILENCED, silenced_until: { lte: new Date() } },
            select: { id: true },
        });
        for (const { id } of expired) {
            await this.setState(id, AlertState.OPEN, null, "silence-ended", "The silence period ended.");
            await this.announce(id, "opened");
        }
    }

    private async sweepRenotify(): Promise<void> {
        const { renotify_after_hours: defaultHours } = await this.getSettings();
        const open = await this.prisma.alerts.findMany({
            where: { state: AlertState.OPEN },
            select: { id: true, device_id: true, last_notified_at: true, first_seen_at: true },
            take: BULK_LIMIT * 4,
        });
        if (!open.length) return;
        let effective: Map<string, Effective> = new Map();
        try {
            effective = await this.policies.effectiveForDevices([...new Set(open.map((a) => a.device_id).filter((v): v is string => !!v))]);
        } catch (err) {
            this.logger.warn(`Could not read policies for reminders, using the alert settings: ${(err as Error).message}`);
        }

        let sent = 0;
        for (const a of open) {
            const hours = this.valueIn<number>(a.device_id ? effective.get(a.device_id) : undefined, "alerting.renotifyAfterHours", defaultHours);
            if (hours <= 0) continue;
            const since = a.last_notified_at ?? a.first_seen_at;
            if (!since || since.getTime() > Date.now() - hours * 3_600_000) continue;
            if (sent++ >= BULK_LIMIT) break;
            await this.announce(a.id, "reminder");
        }
    }

    /* ------------------------------ tickets ------------------------------ */

    private async maybeOpenTicket(alertId: string, severity: AlertSeverity): Promise<void> {
        try {
            const settings = await this.getSettings();
            const row = await this.prisma.alerts.findUnique({ where: { id: alertId }, select: { device_id: true } });
            const on = await this.settingFor<boolean>(row?.device_id, "alerting.autoTicket", settings.auto_ticket);
            if (!on) return;
            const minimum = (await this.settingFor<string>(row?.device_id, "alerting.autoTicketMinSeverity", settings.auto_ticket_min_severity)) as AlertSeverity;
            if (SEVERITY_RANK[severity] < SEVERITY_RANK[minimum]) return;
            await this.openTicket(alertId);
        } catch (err) {
            this.logger.error(`Could not open a ticket for an alert: ${(err as Error).message}`);
        }
    }

    /** Opens a ticket for an alert, or returns the one it already has. */
    async openTicket(alertId: string): Promise<string> {
        const alert = await this.prisma.alerts.findUnique({ where: { id: alertId } });
        if (!alert) throw new NotFoundException("Alert not found");
        if (alert.ticket_id) return alert.ticket_id;

        const organizationId = await this.orgs.getDefaultOrganizationId();
        const ticketId = await this.tickets.create(
            {
                subject: alert.title,
                description: [alert.detail, `Raised automatically by RemoteIQ alert ${alert.id}.`].filter(Boolean).join("\n\n"),
                priority: alert.severity === "CRIT" ? "high" : "medium",
                deviceId: alert.device_id,
            } as any,
            { user: { organizationId, name: "RemoteIQ Alerts" } },
            { source: "alert" },
        );

        await this.prisma.alerts.update({ where: { id: alertId }, data: { ticket_id: ticketId } });
        await this.addEvent(alertId, "ticket-opened", null, null);
        return ticketId;
    }

    private async maybeCloseTicket(ticketId: string | null, title: string, deviceId?: string | null): Promise<void> {
        if (!ticketId) return;
        try {
            const settings = await this.getSettings();
            if (!(await this.settingFor<boolean>(deviceId, "alerting.autoResolveTicket", settings.auto_resolve_ticket))) return;

            const organizationId = await this.orgs.getDefaultOrganizationId();
            const req = { user: { organizationId, name: "RemoteIQ Alerts" } };
            const ticket = await this.tickets.getOne(ticketId, req);
            // Someone working the ticket has taken it over, so it is theirs to close.
            if (!ticket || ticket.status !== "open") return;
            await this.tickets.update(ticketId, { status: "resolved" } as any, req);
        } catch (err) {
            this.logger.error(`Could not close the ticket for "${title}": ${(err as Error).message}`);
        }
    }

    /* ------------------------------ reading ------------------------------ */

    async list(params: ListParams, scope: AccessScope | null = null) {
        const states = toArray(params.state);
        const severities = toArray(params.severity);
        const limit = Math.min(Math.max(Number(params.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);

        const where: Prisma.alertsWhereInput = {};
        if (states.length) where.state = { in: states };
        if (severities.length) where.severity = { in: severities };
        if (params.deviceId) where.device_id = params.deviceId;
        if (params.siteId) where.devices = { site_id: params.siteId };
        if (params.clientId) where.devices = { sites: { client_id: params.clientId } };
        if (params.q?.trim()) where.title = { contains: params.q.trim(), mode: "insensitive" };
        // A limited person sees alerts only for their customers, whatever else they ask for.
        if (scope) where.AND = [{ devices: deviceWhereOf(scope) }];

        const rows = await this.prisma.alerts.findMany({
            where,
            orderBy: [{ last_seen_at: "desc" }, { id: "desc" }],
            take: limit + 1,
            ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
            include: {
                devices: {
                    select: {
                        id: true,
                        hostname: true,
                        alias: true,
                        sites: { select: { name: true, clients: { select: { name: true } } } },
                    },
                },
            },
        });

        const page = rows.slice(0, limit);
        return {
            items: page.map((a) => ({
                id: a.id,
                kind: a.kind,
                state: a.state,
                severity: a.severity,
                title: a.title,
                detail: a.detail,
                firstSeenAt: a.first_seen_at,
                lastSeenAt: a.last_seen_at,
                silencedUntil: a.silenced_until,
                resolvedAt: a.resolved_at,
                ticketId: a.ticket_id,
                device: {
                    id: a.devices.id,
                    name: a.devices.alias || a.devices.hostname,
                    client: a.devices.sites?.clients?.name ?? null,
                    site: a.devices.sites?.name ?? null,
                },
            })),
            nextCursor: rows.length > limit ? page[page.length - 1].id : null,
        };
    }

    async summary(scope: AccessScope | null = null) {
        const rows = await this.prisma.alerts.groupBy({
            by: ["state", "severity"],
            where: { state: { not: AlertState.RESOLVED }, ...(scope ? { devices: deviceWhereOf(scope) } : {}) },
            _count: { _all: true },
        });
        const count = (state: string, severity?: string) =>
            rows
                .filter((r) => r.state === state && (!severity || r.severity === severity))
                .reduce((sum, r) => sum + r._count._all, 0);
        return {
            open: count(AlertState.OPEN),
            openCritical: count(AlertState.OPEN, "CRIT"),
            acknowledged: count(AlertState.ACKED),
            silenced: count(AlertState.SILENCED),
        };
    }

    async getTimeline(id: string) {
        const events = await this.prisma.alert_events.findMany({
            where: { alert_id: id },
            orderBy: { created_at: "asc" },
        });
        const actors = Array.from(new Set(events.map((e) => e.actor_user_id).filter(Boolean))) as string[];
        const users = actors.length
            ? await this.prisma.users.findMany({ where: { id: { in: actors } }, select: { id: true, email: true, first_name: true, last_name: true } })
            : [];
        const nameOf = new Map(users.map((u) => [u.id, [u.first_name, u.last_name].filter(Boolean).join(" ") || u.email]));

        return {
            items: events.map((e) => ({
                id: e.id,
                type: e.type,
                reason: e.reason,
                at: e.created_at,
                actor: e.actor_user_id ? nameOf.get(e.actor_user_id) ?? "Unknown user" : "RemoteIQ",
            })),
        };
    }

    /* ------------------------------ technician actions ------------------------------ */

    private async setState(id: string, state: AlertState, actor: string | null, event: string, reason: string | null, silencedUntil: Date | null = null) {
        await this.prisma.alerts.update({
            where: { id },
            data: { state, state_changed_at: new Date(), silenced_until: silencedUntil },
        });
        await this.addEvent(id, event, actor, reason);
    }

    private async requireLive(id: string) {
        const alert = await this.prisma.alerts.findUnique({ where: { id }, select: { id: true, state: true } });
        if (!alert) throw new NotFoundException("Alert not found");
        if (alert.state === AlertState.RESOLVED) throw new BadRequestException("This alert is already resolved.");
        return alert;
    }

    async ack(id: string, actor: string | null, reason?: string) {
        await this.requireLive(id);
        await this.setState(id, AlertState.ACKED, actor, "acknowledged", reason ?? null);
        return { id, state: AlertState.ACKED };
    }

    async silence(id: string, actor: string | null, reason?: string, until?: string | null) {
        await this.requireLive(id);
        const end = until ? new Date(until) : new Date(Date.now() + DEFAULT_SILENCE_HOURS * 3_600_000);
        if (Number.isNaN(end.getTime()) || end <= new Date()) throw new BadRequestException("Choose a time in the future.");
        await this.setState(id, AlertState.SILENCED, actor, "silenced", reason ?? null, end);
        return { id, state: AlertState.SILENCED, silencedUntil: end };
    }

    async unsilence(id: string, actor: string | null) {
        await this.requireLive(id);
        await this.setState(id, AlertState.OPEN, actor, "unsilenced", null);
        return { id, state: AlertState.OPEN };
    }

    async resolve(id: string, actor: string | null, reason?: string) {
        await this.requireLive(id);
        await this.markResolved(id, actor, reason ?? null);
        return { id, state: AlertState.RESOLVED };
    }

    async bulk(action: "ack" | "silence" | "resolve", ids: string[], actor: string | null, reason?: string, until?: string | null) {
        if (ids.length > BULK_LIMIT) throw new BadRequestException(`Choose at most ${BULK_LIMIT} alerts.`);

        const failed: string[] = [];
        for (const id of ids) {
            try {
                if (action === "ack") await this.ack(id, actor, reason);
                else if (action === "silence") await this.silence(id, actor, reason, until);
                else await this.resolve(id, actor, reason);
            } catch {
                failed.push(id);
            }
        }
        return { updated: ids.length - failed.length, failed };
    }

    /* ------------------------------ settings ------------------------------ */

    getSettings() {
        return this.prisma.alert_settings.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
    }

    async updateSettings(data: {
        offlineAfterMinutes?: number;
        renotifyAfterHours?: number;
        autoTicket?: boolean;
        autoTicketMinSeverity?: AlertSeverity;
        autoResolveTicket?: boolean;
    }) {
        const fields = {
            offline_after_minutes: data.offlineAfterMinutes,
            renotify_after_hours: data.renotifyAfterHours,
            auto_ticket: data.autoTicket,
            auto_ticket_min_severity: data.autoTicketMinSeverity,
            auto_resolve_ticket: data.autoResolveTicket,
            updated_at: new Date(),
        };
        const saved = await this.prisma.alert_settings.upsert({ where: { id: 1 }, create: { id: 1, ...fields }, update: fields });
        PoliciesService.invalidate();
        return saved;
    }
}
