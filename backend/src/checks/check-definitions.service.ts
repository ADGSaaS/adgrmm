// backend/src/checks/check-definitions.service.ts
import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../storage/prisma.service";
import { OrganizationContextService } from "../storage/organization-context.service";
import { AlertsService } from "../alerts/alerts.service";
import { toAgentCheck } from "./check-plan.util";

export type CheckKind = "disk" | "cpu" | "memory" | "service" | "process" | "ping" | "port";
export type TargetType = "organization" | "client" | "site" | "device";
export type CheckTarget = { type: TargetType; id?: string | null };

export type CheckInput = {
    name: string;
    kind: CheckKind;
    description?: string | null;
    intervalMinutes?: number;
    enabled?: boolean;
    severity?: "WARN" | "CRIT";
    warn?: number | null;
    crit?: number | null;
    path?: string | null;
    service?: string | null;
    process?: string | null;
    host?: string | null;
    port?: number | null;
    targets: CheckTarget[];
};

type StoredConfig = Record<string, unknown>;

function toStored(input: CheckInput): { type: "metric" | "service" | "process" | "ping"; config: StoredConfig } {
    const severity = input.severity ? { severity: input.severity } : {};
    const limits = {
        ...(input.warn !== undefined && input.warn !== null ? { warn: input.warn } : {}),
        ...(input.crit !== undefined && input.crit !== null ? { crit: input.crit } : {}),
    };

    switch (input.kind) {
        case "cpu":
        case "memory":
            return { type: "metric", config: { metric: input.kind, ...limits } };
        case "disk":
            return { type: "metric", config: { metric: "disk", ...limits, ...(input.path ? { path: input.path } : {}) } };
        case "service":
            return { type: "service", config: { service: input.service, ...severity } };
        case "process":
            return { type: "process", config: { process: input.process, ...severity } };
        case "ping":
            return { type: "ping", config: { host: input.host, ...severity } };
        case "port":
            return { type: "ping", config: { host: input.host, port: input.port, ...severity } };
        default:
            throw new BadRequestException("Unknown type of check.");
    }
}

function kindOf(type: string, config: StoredConfig): CheckKind {
    if (type === "metric") return config.metric as CheckKind;
    if (type === "ping") return config.port ? "port" : "ping";
    return type as CheckKind;
}

@Injectable()
export class CheckDefinitionsService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly orgs: OrganizationContextService,
        private readonly alerts: AlertsService,
    ) { }

    private validate(input: CheckInput) {
        const name = input.name?.trim();
        if (!name) throw new BadRequestException("Give the check a name.");
        if (!input.targets?.length) throw new BadRequestException("Choose where this check should run.");

        if (["disk", "cpu", "memory"].includes(input.kind)) {
            if (input.warn == null && input.crit == null) throw new BadRequestException("Set a warning or critical limit.");
            if (input.warn != null && input.crit != null && input.warn >= input.crit) {
                throw new BadRequestException("The warning limit must be below the critical limit.");
            }
        }
        if (input.kind === "port" && !input.port) throw new BadRequestException("Enter a port.");

        const stored = toStored(input);
        const schedule = `${Math.max(1, input.intervalMinutes ?? 5)}m`;

        // The same rules an agent's plan is built with, so what is saved here can actually run.
        if (!toAgentCheck({ id: "validate", name, type: stored.type, schedule, config: stored.config })) {
            throw new BadRequestException("Some of those details are not valid. Check names and addresses for unusual characters.");
        }
        return { name, schedule, ...stored };
    }

    private async targetRows(checkId: string, organizationId: string, targets: CheckTarget[]) {
        const unique = new Map<string, { type: TargetType; id: string }>();
        for (const target of targets) {
            const id = target.type === "organization" ? organizationId : target.id;
            if (!id) throw new BadRequestException("Choose which customer, site or device.");
            unique.set(`${target.type}:${id}`, { type: target.type, id });
        }
        return Array.from(unique.values()).map((t) => ({
            check_id: checkId,
            target_type: t.type,
            target_id: t.id,
            dedupe_key: `check:${checkId}`,
        }));
    }

    private async labelTargets(rows: Array<{ target_type: string | null; target_id: string | null }>) {
        const ids = (type: string) => rows.filter((r) => r.target_type === type && r.target_id).map((r) => r.target_id!);
        const [clients, sites, devices] = await Promise.all([
            this.prisma.clients.findMany({ where: { id: { in: ids("client") } }, select: { id: true, name: true } }),
            this.prisma.sites.findMany({ where: { id: { in: ids("site") } }, select: { id: true, name: true, clients: { select: { name: true } } } }),
            this.prisma.devices.findMany({ where: { id: { in: ids("device") } }, select: { id: true, hostname: true, alias: true } }),
        ]);
        const labels = new Map<string, string>();
        clients.forEach((c) => labels.set(c.id, c.name));
        sites.forEach((s) => labels.set(s.id, `${s.clients?.name ?? ""} / ${s.name}`));
        devices.forEach((d) => labels.set(d.id, d.alias || d.hostname));
        return labels;
    }

    async list() {
        const organizationId = await this.orgs.getDefaultOrganizationId();
        const rows = await this.prisma.checks.findMany({
            where: { organization_id: organizationId, type: { not: "script" } },
            orderBy: { name: "asc" },
            include: { check_assignments: { select: { target_type: true, target_id: true } } },
        });
        const labels = await this.labelTargets(rows.flatMap((r) => r.check_assignments));

        return {
            items: rows.map((row) => {
                const config = (row.config ?? {}) as StoredConfig;
                return {
                    id: row.id,
                    name: row.name,
                    description: row.description,
                    kind: kindOf(String(row.type), config),
                    enabled: row.enabled,
                    intervalMinutes: Math.round(Number.parseInt(row.schedule, 10) || 5),
                    severity: config.severity ?? "CRIT",
                    warn: config.warn ?? null,
                    crit: config.crit ?? null,
                    path: config.path ?? null,
                    service: config.service ?? null,
                    process: config.process ?? null,
                    host: config.host ?? null,
                    port: config.port ?? null,
                    targets: row.check_assignments.map((a) => ({
                        type: a.target_type,
                        id: a.target_type === "organization" ? null : a.target_id,
                        label: a.target_type === "organization" ? "All devices" : labels.get(a.target_id ?? "") ?? "Removed",
                    })),
                };
            }),
        };
    }

    /**
     * Every check that runs on one device, with the reason it does: the device itself, its site, its customer, or all
     * devices. `own` is true only for a check aimed at this device and nothing else, which is the only kind the device
     * page may change.
     */
    async forDevice(deviceId: string) {
        const device = await this.prisma.devices.findUnique({ where: { id: deviceId }, select: { id: true, site_id: true, sites: { select: { client_id: true } } } });
        if (!device) throw new NotFoundException("Device not found");
        const clientId = device.sites?.client_id ?? null;
        const rank = { device: 0, site: 1, customer: 2, everyone: 3 } as const;
        const items: Array<Awaited<ReturnType<CheckDefinitionsService["list"]>>["items"][number] & { source: keyof typeof rank; own: boolean }> = [];
        for (const item of (await this.list()).items) {
            const sources: Array<keyof typeof rank> = [];
            for (const t of item.targets) {
                if (t.type === "organization") sources.push("everyone");
                else if (t.type === "client" && t.id === clientId) sources.push("customer");
                else if (t.type === "site" && t.id === device.site_id) sources.push("site");
                else if (t.type === "device" && t.id === deviceId) sources.push("device");
            }
            if (!sources.length) continue;
            sources.sort((a, b) => rank[a] - rank[b]);
            items.push({ ...item, source: sources[0], own: item.targets.length === 1 && sources[0] === "device" });
        }
        return { items };
    }

    private async ownCheck(deviceId: string, checkId: string) {
        const found = (await this.forDevice(deviceId)).items.find((c) => c.id === checkId);
        if (!found) throw new NotFoundException("That check does not run on this device.");
        if (!found.own) throw new ConflictException("That check also runs on other devices. Change it under Automation, where it is clear who else it affects.");
    }

    createForDevice(deviceId: string, input: Omit<CheckInput, "targets">, userId: string | null) {
        return this.create({ ...input, targets: [{ type: "device", id: deviceId }] }, userId);
    }

    async updateForDevice(deviceId: string, checkId: string, input: Omit<CheckInput, "targets">) {
        await this.ownCheck(deviceId, checkId);
        return this.update(checkId, { ...input, targets: [{ type: "device", id: deviceId }] });
    }

    async removeForDevice(deviceId: string, checkId: string) {
        await this.ownCheck(deviceId, checkId);
        return this.remove(checkId);
    }

    async create(input: CheckInput, userId: string | null) {
        const { name, schedule, type, config } = this.validate(input);
        const organizationId = await this.orgs.getDefaultOrganizationId();

        try {
            return await this.prisma.$transaction(async (tx) => {
                const check = await tx.checks.create({
                    data: {
                        organization_id: organizationId,
                        name,
                        description: input.description ?? null,
                        type,
                        schedule,
                        config: config as Prisma.InputJsonValue,
                        enabled: input.enabled ?? true,
                        created_by: userId,
                    },
                    select: { id: true },
                });
                await tx.check_assignments.createMany({ data: await this.targetRows(check.id, organizationId, input.targets), skipDuplicates: true });
                return { id: check.id };
            });
        } catch (err) {
            if ((err as Prisma.PrismaClientKnownRequestError)?.code === "P2002") throw new ConflictException("A check with that name already exists.");
            throw err;
        }
    }

    async update(id: string, input: CheckInput) {
        const { name, schedule, type, config } = this.validate(input);
        const organizationId = await this.orgs.getDefaultOrganizationId();

        const existing = await this.prisma.checks.findUnique({ where: { id }, select: { id: true } });
        if (!existing) throw new NotFoundException("Check not found");

        try {
            await this.prisma.$transaction(async (tx) => {
                await tx.checks.update({
                    where: { id },
                    data: {
                        name,
                        description: input.description ?? null,
                        type,
                        schedule,
                        config: config as Prisma.InputJsonValue,
                        enabled: input.enabled ?? true,
                        updated_at: new Date(),
                    },
                });
                await tx.check_assignments.deleteMany({ where: { check_id: id } });
                await tx.check_assignments.createMany({ data: await this.targetRows(id, organizationId, input.targets), skipDuplicates: true });
            });
        } catch (err) {
            if ((err as Prisma.PrismaClientKnownRequestError)?.code === "P2002") throw new ConflictException("A check with that name already exists.");
            throw err;
        }
        if (input.enabled === false) await this.clearAlerts(id, "The check was turned off.");
        return { id };
    }

    /** Nothing will report on this check again, so anything it raised would otherwise stay open forever. */
    private async clearAlerts(checkId: string, reason: string) {
        const results = await this.prisma.check_assignments.findMany({
            where: { dedupe_key: `check:${checkId}` },
            select: { id: true },
        });
        for (const { id } of results) await this.alerts.clear(`check:${id}`, reason);
    }

    async remove(id: string) {
        const existing = await this.prisma.checks.findUnique({ where: { id }, select: { id: true } });
        if (!existing) throw new NotFoundException("Check not found");

        await this.clearAlerts(id, "The check was deleted.");
        await this.prisma.$transaction([
            this.prisma.check_assignments.deleteMany({ where: { OR: [{ check_id: id }, { dedupe_key: `check:${id}` }] } }),
            this.prisma.checks.delete({ where: { id } }),
        ]);
    }
}
