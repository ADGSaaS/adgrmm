// backend/src/devices/device-removals.service.ts
//
// The queue of device removal requests: what is waiting for someone with the right to delete devices, and the two answers, approve
// (the device is deleted, as the per-device "Approve & delete" does) and decline (the request is closed and the device stays).
// A person limited to some customers sees and answers only the requests of their own customers. A request must be waiting: nothing
// here deletes a device that nobody asked to remove.
import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../storage/prisma.service";
import { OrganizationContextService } from "../storage/organization-context.service";
import { ClientAccessService, deviceSqlOf, type AccessScope } from "../reports/client-access.service";
import { DevicesService } from "./devices.service";

export const MAX_DECISIONS = 100;
const LIST_LIMIT = 500;
const ONLINE_WINDOW_MS = 5 * 60_000;

type Row = {
    device_id: string; reason: string | null; requested_at: Date; ticket_id: string | null; requested_by: string | null;
    first_name: string | null; last_name: string | null; email: string | null; hostname: string; alias: string | null; operating_system: string | null;
    site_name: string | null; client_name: string | null; client_id: string | null; last_check_in_at: Date | null;
};

export type Decision = "approve" | "decline";
export type DecisionResult = { deviceId: string; name: string; status: "deleted" | "declined" | "skipped" | "failed"; reason: string | null };

@Injectable()
export class DeviceRemovalsService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly orgs: OrganizationContextService,
        private readonly access: ClientAccessService,
        private readonly devices: DevicesService,
    ) { }

    scopeOf(userId: string | null) {
        return this.access.scopeFor(userId);
    }

    /** Every request that is waiting, oldest first, for the devices the person may see. */
    async list(userId: string | null) {
        const orgId = await this.orgs.getDefaultOrganizationId();
        const scope = await this.scopeOf(userId);
        const conds: Prisma.Sql[] = [Prisma.sql`r.status = 'pending'`, Prisma.sql`(c.id IS NULL OR c.organization_id = ${orgId}::uuid)`];
        if (scope) conds.push(deviceSqlOf(scope, { client: Prisma.sql`st.client_id::text`, site: Prisma.sql`d.site_id::text`, id: Prisma.sql`d.id::text` }));
        const rows = await this.prisma.$queryRaw<Row[]>`
            SELECT r.device_id::text AS device_id, r.reason, r.requested_at, r.ticket_id::text AS ticket_id, r.requested_by_user_id::text AS requested_by,
                   u.first_name, u.last_name, u.email, d.hostname, d.alias, d.operating_system, st.name AS site_name, c.name AS client_name, c.id::text AS client_id,
                   a.last_check_in_at
              FROM public.device_deletion_requests r
              JOIN public.devices d ON d.id = r.device_id
              LEFT JOIN public.sites st ON st.id = d.site_id
              LEFT JOIN public.clients c ON c.id = st.client_id
              LEFT JOIN public.users u ON u.id = r.requested_by_user_id
              LEFT JOIN public.agents a ON a.device_id = d.id
             WHERE ${Prisma.join(conds, " AND ")}
             ORDER BY r.requested_at ASC
             LIMIT ${LIST_LIMIT}`;
        const now = Date.now();
        return {
            total: rows.length,
            items: rows.map((r) => ({
                deviceId: r.device_id,
                name: r.alias || r.hostname,
                hostname: r.hostname,
                customer: r.client_name,
                clientId: r.client_id,
                site: r.site_name,
                os: r.operating_system,
                online: !!r.last_check_in_at && now - r.last_check_in_at.getTime() <= ONLINE_WINDOW_MS,
                reason: r.reason,
                requestedAt: r.requested_at.toISOString(),
                requestedBy: [r.first_name, r.last_name].filter(Boolean).join(" ") || r.email || null,
                requestedById: r.requested_by,
                ticketId: r.ticket_id,
            })),
        };
    }

    /** How many requests wait, for the Overview's attention list (the same visibility as the list). */
    async count(userId: string | null): Promise<number> {
        return (await this.list(userId)).total;
    }

    /**
     * Answers each device on its own: one that is not visible, not waiting, or that fails does not stop the others. `onEach` is called
     * after every answer so the caller can write the audit trail.
     */
    async decide(userId: string | null, decision: Decision, ids: string[], onEach: (r: DecisionResult) => void | Promise<void>): Promise<DecisionResult[]> {
        const scope: AccessScope | null = await this.scopeOf(userId);
        const out: DecisionResult[] = [];
        for (const id of [...new Set(ids)].slice(0, MAX_DECISIONS)) {
            let result: DecisionResult;
            try {
                const dev = await this.prisma.devices.findUnique({ where: { id }, select: { hostname: true, alias: true } });
                const name = dev ? dev.alias || dev.hostname : id;
                if (!dev || !(await this.access.canSeeDevice(scope, id))) {
                    result = { deviceId: id, name: id, status: "skipped", reason: "Device not found." };
                } else {
                    const req = await this.prisma.device_deletion_requests.findUnique({ where: { device_id: id }, select: { status: true } });
                    if (!req || req.status !== "pending") {
                        result = { deviceId: id, name, status: "skipped", reason: "No removal request is waiting for this device any more." };
                    } else if (decision === "approve") {
                        await this.devices.approveAndDeleteDevice(id, userId);
                        result = { deviceId: id, name, status: "deleted", reason: null };
                    } else {
                        const r = await this.prisma.device_deletion_requests.updateMany({ where: { device_id: id, status: "pending" }, data: { status: "declined", completed_at: new Date() } });
                        result = r.count ? { deviceId: id, name, status: "declined", reason: null } : { deviceId: id, name, status: "skipped", reason: "No removal request is waiting for this device any more." };
                    }
                }
            } catch (e) {
                result = { deviceId: id, name: id, status: "failed", reason: String((e as Error)?.message ?? "Something went wrong.").slice(0, 200) };
            }
            out.push(result);
            await onEach(result);
        }
        return out;
    }
}
