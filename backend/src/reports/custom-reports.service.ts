// backend/src/reports/custom-reports.service.ts
//
// Reports people design themselves. A design is a title, text for the cover and foot of the page, and a list of
// sections, each one of the built-in reports with its own title, limits, columns, filter, sort, grouping, charts and
// row limit. Running a design builds those sections the same way the All report does, so scope, permissions, the PDF,
// the workbook and scheduling all work without anything special.
import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../storage/prisma.service";
import { OrganizationContextService } from "../storage/organization-context.service";
import { CATALOG, EndpointReportsService, type ReportInput, type ReportKey } from "./endpoint-reports.service";
import { checkView } from "./report-view";
import { FullReportService, type FullReport, type SectionSpec } from "./full-report.service";

const MAX_SECTIONS = 30;
const MAX_CONFIG_BYTES = 120_000;

export type CustomConfig = {
    title?: string;
    intro?: string;
    footer?: string;
    cover: { scorecard: boolean; recommendations: boolean };
    /** How many days back a report with a period covers, when no dates are given. */
    days?: number;
    sections: Array<{ key: ReportKey; title?: string; params?: Record<string, string | number>; view?: Record<string, unknown>; charts?: boolean; maxRows?: number }>;
};

const text = (v: unknown, max: number, what: string): string | undefined => {
    if (v === undefined || v === null || v === "") return undefined;
    if (typeof v !== "string") throw new BadRequestException(`${what} must be text.`);
    if (v.length > max) throw new BadRequestException(`${what} can be at most ${max} characters.`);
    return v;
};

/** Checks a design someone sent and keeps only what a design may hold. The filter and sort are checked by trying them. */
export function cleanCustomConfig(raw: unknown): CustomConfig {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new BadRequestException("The report design could not be read.");
    if (JSON.stringify(raw).length > MAX_CONFIG_BYTES) throw new BadRequestException("That report design is too large.");
    const input = raw as Record<string, any>;
    if (!Array.isArray(input.sections) || input.sections.length === 0) throw new BadRequestException("Add at least one section to the report.");
    if (input.sections.length > MAX_SECTIONS) throw new BadRequestException(`A report can have at most ${MAX_SECTIONS} sections.`);

    const sections: CustomConfig["sections"] = input.sections.map((s: any, i: number) => {
        const where = `Section ${i + 1}`;
        const def = CATALOG.find((d) => d.key === s?.key);
        if (!def) throw new BadRequestException(`${where} is not one of the reports.`);
        const out: CustomConfig["sections"][number] = { key: def.key };
        const title = text(s.title, 120, `${where}'s title`);
        if (title) out.title = title;
        if (s.params && typeof s.params === "object" && !Array.isArray(s.params)) {
            const params: Record<string, string | number> = {};
            for (const p of def.params) {
                const v = s.params[p.key];
                if (v === undefined || v === null || v === "") continue;
                if (p.type === "number") {
                    const n = Number(v);
                    if (!Number.isFinite(n)) throw new BadRequestException(`${where}: ${p.label} must be a number.`);
                    params[p.key] = n;
                } else {
                    if (typeof v !== "string" || v.length > 500) throw new BadRequestException(`${where}: ${p.label} must be text of at most 500 characters.`);
                    params[p.key] = v;
                }
            }
            if (Object.keys(params).length) out.params = params;
        }
        if (s.view && typeof s.view === "object" && !Array.isArray(s.view)) out.view = s.view;
        if (s.charts === false) out.charts = false;
        if (s.maxRows !== undefined && s.maxRows !== null && s.maxRows !== "") {
            const n = Number(s.maxRows);
            if (!Number.isInteger(n) || n < 1 || n > 5000) throw new BadRequestException(`${where}: the row limit must be a whole number from 1 to 5000.`);
            out.maxRows = n;
        }
        return out;
    });

    const days = input.days === undefined || input.days === null || input.days === "" ? undefined : Number(input.days);
    if (days !== undefined && (!Number.isInteger(days) || days < 1 || days > 730)) throw new BadRequestException("The number of days must be a whole number from 1 to 730.");
    return {
        ...(text(input.title, 120, "The title") ? { title: text(input.title, 120, "The title") } : {}),
        ...(text(input.intro, 4000, "The cover text") ? { intro: text(input.intro, 4000, "The cover text") } : {}),
        ...(text(input.footer, 160, "The page footer") ? { footer: text(input.footer, 160, "The page footer") } : {}),
        cover: { scorecard: input.cover?.scorecard !== false, recommendations: input.cover?.recommendations !== false },
        ...(days !== undefined ? { days } : {}),
        sections,
    };
}

const rowOf = (r: { id: string; name: string; description: string | null; config: unknown; created_by: string | null; created_at: Date; updated_at: Date }) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    config: r.config as CustomConfig,
    mine: false,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
});

@Injectable()
export class CustomReportsService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly orgs: OrganizationContextService,
        private readonly endpoint: EndpointReportsService,
        private readonly full: FullReportService,
    ) { }

    async list() {
        const rows = await this.prisma.custom_reports.findMany({ where: { organization_id: await this.orgs.getDefaultOrganizationId() }, orderBy: { name: "asc" } });
        return { items: rows.map((r) => ({ ...rowOf(r), sections: ((r.config as CustomConfig).sections ?? []).length })) };
    }

    async get(id: string) {
        const row = await this.prisma.custom_reports.findFirst({ where: { id, organization_id: await this.orgs.getDefaultOrganizationId() } });
        if (!row) throw new NotFoundException("That report does not exist.");
        return rowOf(row);
    }

    /** A design is only saved if every section can run, so a bad filter is found now and not at 07:00 on the first of the month. */
    private async tryIt(config: CustomConfig) {
        for (const [i, s] of config.sections.entries()) {
            try {
                // One device that is not there keeps the trial cheap while still checking the filter against the columns.
                const columns = await this.columnsFor(s.key);
                if (!columns.length) continue;
                checkView(s.view, columns);
            } catch (err) {
                throw new BadRequestException(`Section ${i + 1} (${s.title || s.key}): ${(err as Error).message}`);
            }
        }
    }

    async create(userId: string | null, input: { name: string; description?: string; config: unknown }) {
        const organizationId = await this.orgs.getDefaultOrganizationId();
        const name = (input.name ?? "").trim();
        if (!name) throw new BadRequestException("Give the report a name.");
        const config = cleanCustomConfig(input.config);
        await this.tryIt(config);
        const clash = await this.prisma.custom_reports.findFirst({ where: { organization_id: organizationId, name: { equals: name, mode: "insensitive" } }, select: { id: true } });
        if (clash) throw new ConflictException("A report with that name already exists.");
        const row = await this.prisma.custom_reports.create({ data: { organization_id: organizationId, name, description: input.description?.trim() || null, config: config as object, created_by: userId } });
        return rowOf(row);
    }

    async update(id: string, input: { name: string; description?: string; config: unknown }) {
        const existing = await this.get(id);
        const organizationId = await this.orgs.getDefaultOrganizationId();
        const name = (input.name ?? "").trim();
        if (!name) throw new BadRequestException("Give the report a name.");
        const config = cleanCustomConfig(input.config);
        await this.tryIt(config);
        const clash = await this.prisma.custom_reports.findFirst({ where: { organization_id: organizationId, name: { equals: name, mode: "insensitive" }, NOT: { id } }, select: { id: true } });
        if (clash) throw new ConflictException("A report with that name already exists.");
        const row = await this.prisma.custom_reports.update({ where: { id: existing.id }, data: { name, description: input.description?.trim() || null, config: config as object, updated_at: new Date() } });
        return rowOf(row);
    }

    async remove(id: string) {
        await this.get(id);
        // A schedule for a report that no longer exists could never send, so those go with it.
        await this.prisma.report_schedules.deleteMany({ where: { report_key: `custom:${id}` } });
        await this.prisma.custom_reports.delete({ where: { id } });
        return { id, deleted: true };
    }

    /** The columns a built-in report has, for choosing which to show. Found by running it for nothing in particular. */
    async columnsFor(key: string) {
        const def = CATALOG.find((d) => d.key === key);
        if (!def) throw new NotFoundException("Unknown report");
        const organizationId = await this.orgs.getDefaultOrganizationId();
        const anyDevice = await this.prisma.devices.findFirst({ where: { sites: { clients: { organization_id: organizationId } } }, select: { id: true } });
        const result = await this.endpoint.run(key, anyDevice ? { deviceId: anyDevice.id } : {});
        return result.columns.filter((c) => !c.internal);
    }

    /** Builds a designed report for a scope. `permissions` is what the reader may see; null for the system's own jobs. */
    async build(id: string, input: ReportInput, permissions: ReadonlySet<string> | null, restrictClientIds?: string[]): Promise<FullReport> {
        const design = await this.get(id);
        const config = design.config;
        const specs: SectionSpec[] = config.sections.map((s) => ({ key: s.key, title: s.title, params: s.params, view: s.view, charts: s.charts, maxRows: s.maxRows }));
        return this.full.build(input, permissions, {
            kind: "custom",
            sectionSpecs: specs,
            title: config.title || design.name,
            intro: config.intro,
            footer: config.footer,
            cover: config.cover,
            defaultDays: config.days,
            restrictClientIds,
        });
    }
}
