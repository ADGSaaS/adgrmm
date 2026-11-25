// backend/src/reports/report-views.service.ts
//
// Saved views: a name for a way of looking at a report (scope, limits, period, filter, sort, grouping and columns), so
// it can be opened again, shared with the team, and later scheduled. A view is only settings. What it shows is decided
// each time it is run, so it always uses the current data and the current rights of whoever opens it.
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../storage/prisma.service";
import { OrganizationContextService } from "../storage/organization-context.service";
import { CATALOG } from "./endpoint-reports.service";

const MAX_CONFIG_BYTES = 8_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ViewConfig = {
    scope?: { clientId?: string; siteId?: string; deviceId?: string };
    params?: Record<string, string | number>;
    /** For reports that cover a period: how many days back from today, so the view stays current. */
    days?: number;
    view?: Record<string, unknown>;
};

/** Keeps only what a view may hold, and says plainly what is wrong with the rest. */
export function cleanConfig(raw: unknown): ViewConfig {
    if (raw === undefined || raw === null) return {};
    if (typeof raw !== "object" || Array.isArray(raw)) throw new BadRequestException("The view settings could not be read.");
    if (JSON.stringify(raw).length > MAX_CONFIG_BYTES) throw new BadRequestException("That view is too large.");
    const input = raw as Record<string, any>;
    const out: ViewConfig = {};

    if (input.scope && typeof input.scope === "object") {
        const scope: NonNullable<ViewConfig["scope"]> = {};
        for (const key of ["clientId", "siteId", "deviceId"] as const) {
            const value = input.scope[key];
            if (value === undefined || value === null || value === "") continue;
            if (typeof value !== "string" || !UUID.test(value)) throw new BadRequestException("The customer or site in this view is not valid.");
            scope[key] = value;
        }
        if (Object.keys(scope).length) out.scope = scope;
    }
    if (input.params && typeof input.params === "object" && !Array.isArray(input.params)) {
        const params: Record<string, string | number> = {};
        for (const [key, value] of Object.entries(input.params)) {
            if (!/^[A-Za-z]{1,40}$/.test(key)) throw new BadRequestException("A limit in this view is not valid.");
            if (typeof value === "number" && Number.isFinite(value)) params[key] = value;
            else if (typeof value === "string" && value.length <= 200) params[key] = value;
            else if (value !== null && value !== undefined && value !== "") throw new BadRequestException("A limit in this view is not valid.");
        }
        if (Object.keys(params).length) out.params = params;
    }
    if (input.days !== undefined && input.days !== null) {
        const days = Number(input.days);
        if (!Number.isInteger(days) || days < 1 || days > 3650) throw new BadRequestException("The period in this view is not valid.");
        out.days = days;
    }
    if (input.view !== undefined && input.view !== null) {
        if (typeof input.view !== "object" || Array.isArray(input.view)) throw new BadRequestException("The filter in this view could not be read.");
        out.view = input.view;
    }
    return out;
}

function cleanName(raw: unknown): string {
    const name = String(raw ?? "").trim().replace(/\s+/g, " ");
    if (!name) throw new BadRequestException("Give the view a name.");
    if (name.length > 80) throw new BadRequestException("The name is too long (80 characters at most).");
    return name;
}

@Injectable()
export class ReportViewsService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly orgs: OrganizationContextService,
    ) { }

    private known(reportKey: string) {
        if (!CATALOG.some((d) => d.key === reportKey)) throw new BadRequestException("Unknown report.");
    }

    private shape(row: { id: string; report_key: string; name: string; config: unknown; created_by: string | null; updated_at: Date }, userId: string | null) {
        return { id: row.id, reportKey: row.report_key, name: row.name, config: row.config as ViewConfig, mine: !!userId && row.created_by === userId, updatedAt: row.updated_at };
    }

    async list(reportKey: string | undefined, userId: string | null) {
        if (reportKey) this.known(reportKey);
        const rows = await this.prisma.report_views.findMany({
            where: { organization_id: await this.orgs.getDefaultOrganizationId(), ...(reportKey ? { report_key: reportKey } : {}) },
            orderBy: [{ report_key: "asc" }, { name: "asc" }],
            take: 500,
        });
        return { items: rows.map((r) => this.shape(r, userId)) };
    }

    async create(userId: string | null, input: { reportKey: string; name: string; config?: unknown }) {
        this.known(input.reportKey);
        const organizationId = await this.orgs.getDefaultOrganizationId();
        try {
            const row = await this.prisma.report_views.create({
                data: { organization_id: organizationId, report_key: input.reportKey, name: cleanName(input.name), config: cleanConfig(input.config) as object, created_by: userId },
            });
            return this.shape(row, userId);
        } catch (e: any) {
            if (e?.code === "P2002") throw new ConflictException("A view with that name already exists for this report.");
            throw e;
        }
    }

    private async mineOrFail(id: string, userId: string | null) {
        const row = await this.prisma.report_views.findFirst({ where: { id, organization_id: await this.orgs.getDefaultOrganizationId() } });
        if (!row) throw new NotFoundException("View not found.");
        if (!userId || row.created_by !== userId) throw new ForbiddenException("Only the person who saved a view can change or remove it.");
        return row;
    }

    async update(id: string, userId: string | null, input: { name?: string; config?: unknown }) {
        const existing = await this.mineOrFail(id, userId);
        try {
            const row = await this.prisma.report_views.update({
                where: { id: existing.id },
                data: {
                    ...(input.name !== undefined ? { name: cleanName(input.name) } : {}),
                    ...(input.config !== undefined ? { config: cleanConfig(input.config) as object } : {}),
                    updated_at: new Date(),
                },
            });
            return this.shape(row, userId);
        } catch (e: any) {
            if (e?.code === "P2002") throw new ConflictException("A view with that name already exists for this report.");
            throw e;
        }
    }

    async remove(id: string, userId: string | null) {
        const existing = await this.mineOrFail(id, userId);
        await this.prisma.report_views.delete({ where: { id: existing.id } });
        return { id, deleted: true };
    }
}
