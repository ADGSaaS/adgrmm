// backend/src/reports/reports.service.ts
import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { PrismaService } from "../storage/prisma.service";
import { OrganizationContextService } from "../storage/organization-context.service";
import { SmtpService } from "../smtp/smtp.service";
import { addMonths, parseDateOnly, toDateOnly } from "../billing/billing.util";
import { CATALOG, EndpointReportsService, type ReportInput } from "./endpoint-reports.service";
import { drawCharts, type PdfChart } from "./pdf-charts";
import { cleanConfig, type ViewConfig } from "./report-views.service";
import { EMAILED_PERMISSIONS, FullReportService, QBR_SECTIONS, type FullReport } from "./full-report.service";
import { CustomReportsService } from "./custom-reports.service";
import { checkRule, describeRule, localDate, nextRun as computeNextRun, previewRuns, type ScheduleRule } from "./schedule-time";
import type { report_schedules } from "@prisma/client";

/** What a person sends to say when a schedule runs. */
export type TimingInput = {
    frequency: string;
    time?: string;
    timezone?: string;
    daysOfWeek?: number[];
    dayOfMonth?: number;
    nthWeek?: number;
    nthWeekday?: number;
    onceDate?: string;
};
type ScheduleRow = report_schedules;

const RUN_EVERY_MS = 15 * 60_000;
const MAX_SCHEDULE_ERROR = 500;
const MAX_RECIPIENTS = 20;
/** The original scheduled report, which is not one of the endpoint reports. */
const CUSTOMER_SUMMARY = "customer-health";
/** Every report in one document. Sent as a PDF, an Excel workbook or both, and never with the audit log in it. */
const FULL_REPORT = "full-report";
/** The quarterly business review: a customer-ready pack, sent the same way as the All report. */
const QBR_REPORT = "quarterly-review";
/** A report someone designed is scheduled as custom:<id>. */
/** What is known about one send while it happens, so the delivery log can say what went out. */
type DeliveryContext = { id: string | null; label: string; reportKey: string; trigger: "scheduled" | "test"; recipients: string; logged: boolean };
const KEEP_DELIVERY_DAYS = 400;

const CUSTOM_PREFIX = "custom:";
const customIdOf = (key: string) => (key.startsWith(CUSTOM_PREFIX) ? key.slice(CUSTOM_PREFIX.length) : null);
const isFullKind = (key: string) => key === FULL_REPORT || key === QBR_REPORT || key.startsWith(CUSTOM_PREFIX);
/**
 * What can be emailed on a schedule. Reports about devices only: the alert and audit reports need their own rights to
 * read, and a schedule would let them be sent to any address.
 */
const SCHEDULABLE = CATALOG.filter((d) => d.permission === "devices.read").map((d) => d.key as string);
/** The same window the device list uses to call a device online. */
const ONLINE_WINDOW_MS = 5 * 60_000;

function range(from: string, to: string) {
    try {
        const start = parseDateOnly(from);
        const end = new Date(parseDateOnly(to).getTime() + 86_400_000);
        if (end <= start) throw new Error("The end date must be after the start date.");
        return { start, end };
    } catch (err) {
        throw new BadRequestException((err as Error).message);
    }
}

const pct = (part: number, whole: number) => (whole ? Math.round((part / whole) * 1000) / 10 : null);

export type HealthReport = Awaited<ReturnType<ReportsService["customerHealth"]>>;

@Injectable()
export class ReportsService {
    private readonly logger = new Logger(ReportsService.name);
    private running = false;

    constructor(
        private readonly prisma: PrismaService,
        private readonly orgs: OrganizationContextService,
        private readonly smtp: SmtpService,
        private readonly endpoint: EndpointReportsService,
        private readonly full: FullReportService,
        private readonly custom: CustomReportsService,
    ) { }

    /** Only measured facts. Where something was not measured, the field is null rather than a guess. */
    async customerHealth(clientId: string, from: string, to: string) {
        const { start, end } = range(from, to);
        const client = await this.prisma.clients.findFirst({ where: { id: clientId, organization_id: await this.orgs.getDefaultOrganizationId() }, select: { id: true, name: true } });
        if (!client) throw new NotFoundException("Customer not found");

        const devices = await this.prisma.devices.findMany({
            where: { sites: { client_id: clientId }, agents: { isNot: null } },
            select: { id: true, hostname: true, alias: true, operating_system: true, last_seen_at: true, agents: { select: { version: true, facts: true, last_check_in_at: true } } },
        });
        const deviceIds = devices.map((d) => d.id);
        const isOnline = (d: (typeof devices)[number]) => !!d.agents?.last_check_in_at && Date.now() - d.agents.last_check_in_at.getTime() <= ONLINE_WINDOW_MS;

        const [alerts, ticketsOpened, ticketsClosed, runs] = await Promise.all([
            this.prisma.alerts.findMany({
                where: { device_id: { in: deviceIds }, first_seen_at: { gte: start, lt: end } },
                select: { severity: true, kind: true, title: true, first_seen_at: true, resolved_at: true, device_id: true },
            }),
            this.prisma.tickets.count({ where: { device_id: { in: deviceIds }, created_at: { gte: start, lt: end } } }),
            this.prisma.tickets.count({ where: { device_id: { in: deviceIds }, closed_at: { gte: start, lt: end } } }),
            this.prisma.check_runs.groupBy({ by: ["status"], where: { device_id: { in: deviceIds }, created_at: { gte: start, lt: end }, check_assignments: { OR: [{ check_type: null }, { check_type: { notIn: ["NETWORK", "DISKIO"] } }] } }, _count: { _all: true } }),
        ]);

        const resolved = alerts.filter((a) => a.resolved_at);
        const resolveMinutes = resolved.map((a) => (a.resolved_at!.getTime() - a.first_seen_at.getTime()) / 60_000);
        const totalRuns = runs.reduce((sum, r) => sum + r._count._all, 0);
        const okRuns = runs.filter((r) => /^(ok|pass|passed|success)$/i.test(r.status)).reduce((sum, r) => sum + r._count._all, 0);

        const byTitle = new Map<string, number>();
        for (const alert of alerts) byTitle.set(alert.title, (byTitle.get(alert.title) ?? 0) + 1);

        const osCount = new Map<string, number>();
        for (const d of devices) {
            const os = String((d.agents?.facts as any)?.os || d.operating_system || "Unknown");
            osCount.set(os, (osCount.get(os) ?? 0) + 1);
        }

        return {
            client,
            from,
            to,
            devices: {
                total: devices.length,
                online: devices.filter(isOnline).length,
                offline: devices.filter((d) => !isOnline(d)).map((d) => ({ name: d.alias || d.hostname, lastSeenAt: d.agents?.last_check_in_at ?? d.last_seen_at })),
                byOs: Array.from(osCount, ([os, count]) => ({ os, count })).sort((a, b) => b.count - a.count),
            },
            alerts: {
                total: alerts.length,
                critical: alerts.filter((a) => a.severity === "CRIT").length,
                resolved: resolved.length,
                stillOpen: alerts.length - resolved.length,
                averageMinutesToResolve: resolveMinutes.length ? Math.round(resolveMinutes.reduce((s, m) => s + m, 0) / resolveMinutes.length) : null,
                mostCommon: Array.from(byTitle, ([title, count]) => ({ title, count })).sort((a, b) => b.count - a.count).slice(0, 5),
            },
            checks: { runs: totalRuns, passedPercent: pct(okRuns, totalRuns) },
            tickets: { opened: ticketsOpened, closed: ticketsClosed },
        };
    }

    healthPdf(report: HealthReport, companyName: string): Promise<Buffer> {
        return new Promise((resolve, reject) => {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const PDFDocument = require("pdfkit");
            const doc = new PDFDocument({ size: "LETTER", margin: 50, info: { Title: `${report.client.name} health report` } });
            const chunks: Buffer[] = [];
            doc.on("data", (c: Buffer) => chunks.push(c));
            doc.on("end", () => resolve(Buffer.concat(chunks)));
            doc.on("error", reject);

            const heading = (text: string) => {
                doc.moveDown(0.8).font("Helvetica-Bold").fontSize(12).fillColor("#000000").text(text);
                doc.moveDown(0.2).font("Helvetica").fontSize(10);
            };
            const row = (label: string, value: string | number) => doc.fillColor("#333333").text(`${label}: ${value}`);

            doc.font("Helvetica-Bold").fontSize(18).text(`${report.client.name}: health report`);
            doc.font("Helvetica").fontSize(10).fillColor("#555555").text(`${report.from} to ${report.to}${companyName ? `. Prepared by ${companyName}.` : ""}`);

            // The headline numbers as charts, before the detail.
            const charts: PdfChart[] = [
                { key: "online", title: "Devices online now", kind: "donut", data: [{ label: "Online", value: report.devices.online }, { label: "Offline", value: report.devices.total - report.devices.online }] },
                { key: "os", title: "Operating systems", kind: "bar", data: report.devices.byOs.map((o) => ({ label: o.os, value: o.count })) },
                { key: "alerts", title: "Alerts in the period", kind: "donut", data: [{ label: "Resolved", value: report.alerts.resolved }, { label: "Open", value: report.alerts.stillOpen }] },
                { key: "common", title: "Most common alerts", kind: "bar", data: report.alerts.mostCommon.map((a) => ({ label: a.title, value: a.count })) },
            ];
            doc.moveDown(0.8);
            drawCharts(doc, charts, { margin: 50, width: doc.page.width - 100, bottom: () => doc.page.height - 64, columns: 2 });

            heading("Devices");
            row("Managed devices", report.devices.total);
            row("Online now", report.devices.online);
            for (const os of report.devices.byOs) row(os.os, os.count);
            if (report.devices.offline.length) {
                doc.moveDown(0.3).fillColor("#333333").text(`Offline now: ${report.devices.offline.slice(0, 30).map((d) => d.name).join(", ")}`);
            }

            heading("Monitoring");
            row("Check runs", report.checks.runs);
            row("Passed", report.checks.passedPercent === null ? "No runs" : `${report.checks.passedPercent}%`);
            row("Alerts raised", report.alerts.total);
            row("Critical alerts", report.alerts.critical);
            row("Resolved", report.alerts.resolved);
            if (report.alerts.averageMinutesToResolve !== null) row("Average time to resolve", `${report.alerts.averageMinutesToResolve} minutes`);
            if (report.alerts.mostCommon.length) {
                doc.moveDown(0.3).fillColor("#333333").text("Most common:");
                for (const item of report.alerts.mostCommon) doc.text(`${item.count} x ${item.title}`, { indent: 10 });
            }

            heading("Service");
            row("Tickets opened", report.tickets.opened);
            row("Tickets closed", report.tickets.closed);

            doc.end();
        });
    }

    async healthPdfFile(clientId: string, from: string, to: string) {
        const report = await this.customerHealth(clientId, from, to);
        const company = await this.prisma.company_profile.findFirst({ select: { name: true } });
        const data = await this.healthPdf(report, company?.name ?? "");
        return { filename: `health-report-${report.from}-to-${report.to}.pdf`, data };
    }

    /* ------------------------------ schedules ------------------------------ */

    /** The schedule a stored row describes. */
    private ruleOf(row: { frequency: string; time_of_day: string; timezone: string; days_of_week: number[]; day_of_month: number | null; nth_week: number | null; nth_weekday: number | null; once_date: string | null }): ScheduleRule {
        return checkRule({
            kind: row.frequency as ScheduleRule["kind"],
            time: row.time_of_day,
            timezone: row.timezone,
            daysOfWeek: row.days_of_week,
            dayOfMonth: row.day_of_month ?? undefined,
            nth: row.nth_week !== null && row.nth_weekday !== null ? { week: row.nth_week as 1 | 2 | 3 | 4 | -1, weekday: row.nth_weekday } : undefined,
            onceDate: row.once_date ?? undefined,
        });
    }

    /** The columns that store a rule. */
    private ruleColumns(rule: ScheduleRule) {
        return {
            frequency: rule.kind,
            time_of_day: rule.time,
            timezone: rule.timezone,
            days_of_week: rule.daysOfWeek ?? [],
            day_of_month: rule.dayOfMonth ?? null,
            nth_week: rule.nth?.week ?? null,
            nth_weekday: rule.nth?.weekday ?? null,
            once_date: rule.onceDate ?? null,
        };
    }

    /** A rule from what a person sent, filling anything left out from an existing rule. */
    private ruleFromInput(input: TimingInput, fallback?: ScheduleRule): ScheduleRule {
        const nth = input.nthWeek !== undefined && input.nthWeekday !== undefined ? { week: input.nthWeek as 1 | 2 | 3 | 4 | -1, weekday: input.nthWeekday } : input.dayOfMonth !== undefined ? undefined : fallback?.nth;
        return checkRule({
            kind: input.frequency as ScheduleRule["kind"],
            time: input.time ?? fallback?.time,
            timezone: input.timezone ?? fallback?.timezone,
            daysOfWeek: input.daysOfWeek ?? fallback?.daysOfWeek,
            dayOfMonth: input.dayOfMonth ?? (nth ? undefined : fallback?.dayOfMonth),
            nth,
            onceDate: input.onceDate ?? fallback?.onceDate,
        });
    }

    /** Kept for callers that only know a frequency: the original defaults, 07:00 UTC, Monday and the 1st. */
    private nextRun(frequency: string, from: Date): Date {
        return computeNextRun(checkRule({ kind: frequency as ScheduleRule["kind"], time: "07:00", timezone: "UTC" }), from) ?? new Date(from.getTime() + 86_400_000);
    }

    /** The whole period before a run, in dates, as the customer's calendar sees it: yesterday, the last seven days, or the last month. */
    private period(frequency: string, runAt: Date, timezone = "UTC") {
        const [y, m, d] = localDate(runAt, timezone).split("-").map(Number);
        const day = new Date(Date.UTC(y, m - 1, d));
        const to = new Date(day.getTime() - 86_400_000);
        const from = frequency === "daily" ? to : frequency === "monthly" ? addMonths(new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), 1)), -1, 1) : new Date(day.getTime() - 7 * 86_400_000);
        return { from: toDateOnly(from), to: toDateOnly(to) };
    }

    /** The last N whole days before a run. */
    private lastDays(runAt: Date, days: number, timezone = "UTC") {
        const [y, m, d] = localDate(runAt, timezone).split("-").map(Number);
        const day = new Date(Date.UTC(y, m - 1, d));
        const to = new Date(day.getTime() - 86_400_000);
        return { from: toDateOnly(new Date(to.getTime() - (days - 1) * 86_400_000)), to: toDateOnly(to) };
    }

    /** What a schedule would do, in plain words and as the next few times it sends, before it is saved. */
    async previewSchedule(input: TimingInput) {
        const rule = this.ruleFromInput(input);
        const format = new Intl.DateTimeFormat("en-US", { timeZone: rule.timezone, weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
        return { description: describeRule(rule), runs: previewRuns(rule, 5).map((d) => ({ at: d.toISOString(), local: format.format(d) })) };
    }

    private reportTitle(key: string): string {
        return key === CUSTOMER_SUMMARY ? "Customer summary" : key === FULL_REPORT ? "All report" : key === QBR_REPORT ? "Quarterly business review" : CATALOG.find((d) => d.key === key)?.title ?? key;
    }

    /** Throws if a person limited to some customers touches a schedule that is not for one of them. */
    async assertScheduleAllowed(id: string, allowed: string[] | undefined) {
        if (!allowed) return;
        const row = await this.prisma.report_schedules.findUnique({ where: { id }, select: { client_id: true } });
        if (!row) throw new NotFoundException("Schedule not found");
        if (!row.client_id || !allowed.includes(row.client_id)) throw new ForbiddenException("You do not have access to that customer.");
    }

    async listSchedules(allowed?: string[]) {
        const designs = new Map((await this.custom.list()).items.map((d) => [`${CUSTOM_PREFIX}${d.id}`, d.name]));
        const rows = await this.prisma.report_schedules.findMany({
            where: { organization_id: await this.orgs.getDefaultOrganizationId(), ...(allowed ? { client_id: { in: allowed } } : {}) },
            orderBy: { created_at: "asc" },
            include: { clients: { select: { id: true, name: true } } },
        });
        // Names for the site or device an All report covers.
        const scopes = rows.map((r) => cleanConfig(r.config).scope);
        const siteIds = [...new Set(scopes.map((s) => s?.siteId).filter((v): v is string => !!v))];
        const deviceIds = [...new Set(scopes.map((s) => s?.deviceId).filter((v): v is string => !!v))];
        const [siteNames, deviceNames] = await Promise.all([
            siteIds.length ? this.prisma.sites.findMany({ where: { id: { in: siteIds } }, select: { id: true, name: true } }) : [],
            deviceIds.length ? this.prisma.devices.findMany({ where: { id: { in: deviceIds } }, select: { id: true, hostname: true, alias: true } }) : [],
        ]);
        return {
            items: rows.map((r) => {
                const config = cleanConfig(r.config);
                const site = siteNames.find((s) => s.id === config.scope?.siteId);
                const device = deviceNames.find((d) => d.id === config.scope?.deviceId);
                return {
                    id: r.id,
                    site: site ? { id: site.id, name: site.name } : null,
                    device: device ? { id: device.id, name: device.alias || device.hostname } : null,
                    reportKey: r.report_key,
                    title: designs.get(r.report_key) ?? this.reportTitle(r.report_key),
                    client: r.clients ? { id: r.clients.id, name: r.clients.name } : null,
                    frequency: r.frequency,
                    schedule: this.ruleOf(r),
                    description: describeRule(this.ruleOf(r)),
                    format: r.format,
                    sendIfEmpty: r.send_if_empty,
                    filtered: !!(config.view?.filter || config.view?.groupBy),
                    recipients: r.recipients,
                    enabled: r.enabled,
                    nextRunAt: r.next_run_at,
                    lastRunAt: r.last_run_at,
                    lastResult: r.last_result,
                    lastError: r.last_error,
                };
            }),
        };
    }

    private validateSchedule(input: { recipients: string[]; format?: string }, reportKey?: string) {
        if (!input.recipients?.length || input.recipients.some((r) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(r))) throw new BadRequestException("Enter valid email addresses.");
        if (input.recipients.length > MAX_RECIPIENTS) throw new BadRequestException(`Send to at most ${MAX_RECIPIENTS} addresses.`);
        if (input.format !== undefined) {
            if (isFullKind(reportKey ?? "")) {
                if (!["pdf", "xlsx", "both"].includes(input.format)) throw new BadRequestException("Send the All report as a PDF, an Excel workbook or both.");
            } else if (!["pdf", "csv", "both"].includes(input.format)) throw new BadRequestException("Send a PDF, a CSV or both.");
        }
    }

    /** What to ask the report engine for, from a schedule's customer and saved settings. */
    private inputFor(row: { client_id: string | null; report_key: string; frequency: string; timezone?: string; config: unknown }, runAt: Date): ReportInput {
        const config = cleanConfig(row.config);
        const input: ReportInput = { clientId: row.client_id ?? undefined, siteId: config.scope?.siteId, deviceId: config.scope?.deviceId, ...(config.params ?? {}) } as ReportInput;
        const def = CATALOG.find((d) => d.key === row.report_key);
        if (def?.dated || isFullKind(row.report_key)) {
            // The review covers a quarter however often it is sent, unless it was saved with its own number of days.
            const days = config.days ?? (row.report_key === QBR_REPORT ? 90 : undefined);
            const p = days ? this.lastDays(runAt, days, row.timezone) : this.period(row.frequency, runAt, row.timezone);
            input.from = p.from;
            input.to = p.to;
        }
        return input;
    }

    async createSchedule(input: TimingInput & { reportKey?: string; clientId?: string; siteId?: string; deviceId?: string; recipients: string[]; format?: string; sendIfEmpty?: boolean; viewId?: string; config?: unknown }) {
        const reportKey = input.reportKey ?? CUSTOMER_SUMMARY;
        if (reportKey !== CUSTOMER_SUMMARY && !isFullKind(reportKey) && !SCHEDULABLE.includes(reportKey)) {
            throw new BadRequestException("That report cannot be scheduled. Reports that show the audit log or alerts are not emailed.");
        }
        const designId = customIdOf(reportKey);
        if (designId) {
            try {
                await this.custom.get(designId);
            } catch {
                throw new BadRequestException("That report does not exist.");
            }
        }
        this.validateSchedule(input, reportKey);
        const rule = this.ruleFromInput(input);
        const firstRun = computeNextRun(rule, new Date());
        if (!firstRun) throw new BadRequestException("That date and time has already passed.");
        const format = input.format ?? "pdf";
        const organizationId = await this.orgs.getDefaultOrganizationId();

        let config: ViewConfig = cleanConfig(input.config);
        if (input.viewId) {
            const view = await this.prisma.report_views.findFirst({ where: { id: input.viewId, organization_id: organizationId } });
            if (!view || view.report_key !== reportKey) throw new BadRequestException("That saved view is not for this report.");
            config = cleanConfig(view.config);
        }

        let clientId = input.clientId ?? config.scope?.clientId ?? null;
        let siteId = input.siteId ?? config.scope?.siteId;
        const deviceId = input.deviceId ?? config.scope?.deviceId;
        if (deviceId && !isFullKind(reportKey)) throw new BadRequestException("Only the All report and the quarterly review can be sent for one device.");
        if (reportKey === CUSTOMER_SUMMARY) {
            if (!clientId) throw new BadRequestException("Choose a customer.");
            if (format !== "pdf") throw new BadRequestException("The customer summary is sent as a PDF.");
        }
        if (clientId) {
            const client = await this.prisma.clients.findFirst({ where: { id: clientId, organization_id: organizationId }, select: { id: true } });
            if (!client) throw new BadRequestException("That customer does not exist.");
        }
        // A site or a device belongs to a customer, so the customer follows from it, and a mismatch is refused.
        if (deviceId) {
            const device = await this.prisma.devices.findFirst({ where: { id: deviceId, sites: { clients: { organization_id: organizationId } } }, select: { site_id: true, sites: { select: { client_id: true } } } });
            if (!device) throw new BadRequestException("That device does not exist.");
            if (siteId && siteId !== device.site_id) throw new BadRequestException("That device is not in that site.");
            if (clientId && clientId !== device.sites!.client_id) throw new BadRequestException("That device is not in that customer.");
            clientId = device.sites!.client_id;
            siteId = undefined;
        } else if (siteId) {
            const site = await this.prisma.sites.findFirst({ where: { id: siteId, clients: { organization_id: organizationId } }, select: { client_id: true } });
            if (!site) throw new BadRequestException("That site does not exist.");
            if (clientId && clientId !== site.client_id) throw new BadRequestException("That site is not in that customer.");
            clientId = site.client_id;
        }
        config = { ...config, scope: clientId || siteId || deviceId ? { ...(clientId ? { clientId } : {}), ...(siteId ? { siteId } : {}), ...(deviceId ? { deviceId } : {}) } : undefined };
        if (!config.scope) delete config.scope;

        // Try it once now, so a view that cannot run is refused here and not found out at 07:00 on the first of the month.
        if (isFullKind(reportKey)) {
            await this.buildFullFor(reportKey, this.inputFor({ client_id: clientId, report_key: reportKey, frequency: rule.kind, timezone: rule.timezone, config }, new Date()));
        } else if (reportKey !== CUSTOMER_SUMMARY) {
            await this.endpoint.run(reportKey, this.inputFor({ client_id: clientId, report_key: reportKey, frequency: rule.kind, timezone: rule.timezone, config }, new Date()), config.view);
        }

        const row = await this.prisma.report_schedules.create({
            data: {
                organization_id: organizationId,
                client_id: clientId,
                report_key: reportKey,
                config: config as object,
                format,
                send_if_empty: input.sendIfEmpty ?? true,
                ...this.ruleColumns(rule),
                recipients: input.recipients,
                next_run_at: firstRun,
            },
            select: { id: true },
        });
        return { id: row.id };
    }

    async updateSchedule(id: string, input: TimingInput & { recipients: string[]; enabled?: boolean; format?: string; sendIfEmpty?: boolean }) {
        const existing = await this.prisma.report_schedules.findUnique({ where: { id } });
        if (!existing) throw new NotFoundException("Schedule not found");
        this.validateSchedule(input, existing.report_key);

        // Anything about when it sends starts the schedule over from now, so a change takes effect at the next matching time.
        const timingGiven = input.frequency !== existing.frequency || [input.time, input.timezone, input.daysOfWeek, input.dayOfMonth, input.nthWeek, input.nthWeekday, input.onceDate].some((v) => v !== undefined);
        let timing: Record<string, unknown> = {};
        if (timingGiven) {
            const rule = this.ruleFromInput(input, this.ruleOf(existing));
            const next = computeNextRun(rule, new Date());
            if (!next) throw new BadRequestException("That date and time has already passed.");
            timing = { ...this.ruleColumns(rule), next_run_at: next };
        }
        if (existing.report_key === CUSTOMER_SUMMARY && input.format !== undefined && input.format !== "pdf") throw new BadRequestException("The customer summary is sent as a PDF.");
        await this.prisma.report_schedules.update({
            where: { id },
            data: {
                recipients: input.recipients,
                enabled: input.enabled ?? existing.enabled,
                ...(input.format !== undefined ? { format: input.format } : {}),
                ...(input.sendIfEmpty !== undefined ? { send_if_empty: input.sendIfEmpty } : {}),
                ...timing,
                updated_at: new Date(),
            },
        });
        return { id };
    }

    async deleteSchedule(id: string) {
        await this.prisma.report_schedules.delete({ where: { id } }).catch(() => {
            throw new NotFoundException("Schedule not found");
        });
        return { id, deleted: true };
    }

    /**
     * Builds and emails one schedule's report. Returns what happened, for the schedule's "last result": it was sent, or
     * it was skipped because there was nothing to report and the schedule says not to send an empty one.
     */
    private async deliver(row: { client_id: string | null; report_key: string; frequency: string; timezone: string; format: string; send_if_empty: boolean; recipients: string[]; config: unknown }, runAt: Date, ctx?: DeliveryContext): Promise<string> {
        const to = row.recipients.join(", ");

        if (row.report_key === CUSTOMER_SUMMARY) {
            const { from, to: until } = this.period(row.frequency, runAt, row.timezone);
            const { filename, data } = await this.healthPdfFile(row.client_id!, from, until);
            const client = await this.prisma.clients.findUnique({ where: { id: row.client_id! }, select: { name: true } });
            const result = await this.sendLogged(ctx, to, `${client?.name ?? "Customer"} health report, ${from} to ${until}`, `Your health report for ${from} to ${until} is attached.`, [{ filename, content: data, contentType: "application/pdf" }]);
            if (!result.ok) throw new Error(result.result);
            return "Sent";
        }

        if (isFullKind(row.report_key)) return this.deliverFull(row, runAt, to, ctx);

        const config = cleanConfig(row.config);
        const report = await this.endpoint.run(row.report_key, this.inputFor(row, runAt), config.view);
        if (report.matchedRows === 0 && !row.send_if_empty) return "Skipped: nothing to report";

        const day = report.generatedAt.slice(0, 10);
        const attachments: Array<{ filename: string; content: Buffer; contentType: string }> = [];
        if (row.format === "pdf" || row.format === "both") {
            const company = await this.prisma.company_profile.findFirst({ select: { name: true } });
            attachments.push({ filename: `${row.report_key}-${day}.pdf`, content: await this.endpoint.pdf(report, company?.name ?? ""), contentType: "application/pdf" });
        }
        if (row.format === "csv" || row.format === "both") {
            attachments.push({ filename: `${row.report_key}-${day}.csv`, content: Buffer.from(this.endpoint.toCsv(report), "utf8"), contentType: "text/csv; charset=utf-8" });
        }

        const scope = [report.scope.customer, report.scope.site].filter(Boolean).join(" / ") || "All customers";
        const period = report.period ? `, ${report.period.from} to ${report.period.to}` : "";
        const lines = [
            `${report.title}: ${scope}${period}`,
            `As of ${report.generatedAt.slice(0, 16).replace("T", " ")} UTC.`,
            "",
            ...report.summary.slice(0, 8).map((s) => `${s.label}: ${s.value}`),
            ...(report.matchedRows !== report.totalRows ? ["", `A filter is applied: ${report.matchedRows} of ${report.totalRows} rows.`] : []),
            "",
            `The full report is attached${attachments.length > 1 ? " as a PDF and a CSV" : ""}.`,
        ];
        const result = await this.sendLogged(ctx, to, `${report.title}, ${scope}${period || `, ${day}`}`, lines.join("\n"), attachments);
        if (!result.ok) throw new Error(result.result);
        return `Sent (${report.matchedRows} row${report.matchedRows === 1 ? "" : "s"})`;
    }

    /** The All report: a PDF, a workbook or both, without the audit log, since the people it goes to are not checked against it. */
    /** Builds the All report, the review or a designed report the way an emailed copy is built. */
    private async buildFullFor(reportKey: string, input: ReportInput): Promise<FullReport> {
        const designId = customIdOf(reportKey);
        if (designId) {
            // A design with its own number of days uses that rather than the schedule's period.
            const design = await this.custom.get(designId);
            const { from: _from, to: _to, ...rest } = input;
            return this.custom.build(designId, design.config.days ? rest : input, EMAILED_PERMISSIONS);
        }
        return this.full.build(input, EMAILED_PERMISSIONS, this.fullOptions(reportKey));
    }

    private fullOptions(reportKey: string) {
        return reportKey === QBR_REPORT ? { kind: "qbr" as const, sections: QBR_SECTIONS, defaultDays: 90 } : {};
    }

    private async deliverFull(row: { client_id: string | null; report_key: string; frequency: string; timezone: string; format: string; send_if_empty: boolean; config: unknown }, runAt: Date, to: string, ctx?: DeliveryContext): Promise<string> {
        const report = await this.buildFullFor(row.report_key, this.inputFor(row, runAt));
        const devices = report.sections[0]?.matchedRows ?? 0;
        if (devices === 0 && !row.send_if_empty) return "Skipped: nothing to report";

        const attachments: Array<{ filename: string; content: Buffer; contentType: string }> = [];
        if (row.format === "pdf" || row.format === "both") {
            const file = await this.full.pdfFile(report);
            attachments.push({ filename: file.filename, content: file.data, contentType: "application/pdf" });
        }
        if (row.format === "xlsx" || row.format === "both") {
            const file = await this.full.xlsxFile(report);
            attachments.push({ filename: file.filename, content: file.data, contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
        }
        const period = report.period ? `, ${report.period.from} to ${report.period.to}` : "";
        const lines = [
            `${report.title}${period}`,
            `As of ${report.generatedAt.slice(0, 16).replace("T", " ")} UTC.`,
            "",
            ...report.scorecard.map((t) => `${t.label}: ${t.value}${t.detail ? ` (${t.detail})` : ""}`),
            ...(report.recommendations.length ? ["", "What needs attention:", ...report.recommendations.map((r) => `- ${r}`)] : []),
            ...(report.highlights.length ? ["", "What was done:", ...report.highlights.map((r) => `- ${r}`)] : []),
            ...(report.omitted.length ? [""] : []),
            ...report.omitted.map((o) => o.reason),
            "",
            `The full report is attached${attachments.length > 1 ? " as a PDF and an Excel workbook" : row.format === "xlsx" ? " as an Excel workbook" : " as a PDF"}.`,
        ];
        const result = await this.sendLogged(ctx, to, `${report.title}${period || `, ${report.generatedAt.slice(0, 10)}`}`, lines.join("\n"), attachments);
        if (!result.ok) throw new Error(result.result);
        return `Sent (${devices} device${devices === 1 ? "" : "s"})`;
    }

    /** Sends a message and writes down what happened, whether it went or not. */
    private async sendLogged(ctx: DeliveryContext | undefined, to: string, subject: string, text: string, attachments: Array<{ filename: string; content: Buffer; contentType: string }>) {
        const result = await this.smtp.sendWithAttachment("reports", to, subject, text, attachments);
        if (ctx) {
            ctx.logged = true;
            await this.logDelivery(ctx, { ok: result.ok, subject, attachments: attachments.map((a) => a.filename).join(", "), result: result.ok ? "Sent" : null, error: result.ok ? null : result.result });
        }
        return result;
    }

    private async logDelivery(ctx: DeliveryContext, entry: { ok: boolean; subject?: string | null; attachments?: string | null; result?: string | null; error?: string | null }) {
        try {
            await this.prisma.report_deliveries.create({
                data: {
                    schedule_id: ctx.id,
                    schedule_label: ctx.label.slice(0, 200),
                    report_key: ctx.reportKey,
                    trigger: ctx.trigger,
                    ok: entry.ok,
                    recipients: ctx.recipients.slice(0, 1000),
                    subject: entry.subject?.slice(0, 300) ?? null,
                    attachments: entry.attachments?.slice(0, 500) ?? null,
                    result: entry.result?.slice(0, MAX_SCHEDULE_ERROR) ?? null,
                    error: entry.error?.slice(0, MAX_SCHEDULE_ERROR) ?? null,
                },
            });
        } catch (err) {
            this.logger.warn(`Could not write the delivery log: ${(err as Error).message}`);
        }
    }

    private async contextFor(row: { id: string; report_key: string; recipients: string[] }, trigger: "scheduled" | "test"): Promise<DeliveryContext> {
        const designId = customIdOf(row.report_key);
        const design = designId ? await this.custom.get(designId).catch(() => null) : null;
        return { id: row.id, label: design?.name ?? this.reportTitle(row.report_key), reportKey: row.report_key, trigger, recipients: row.recipients.join(", "), logged: false };
    }

    /** What was sent and when, for one schedule or for all of them, newest first. */
    async listDeliveries(scheduleId?: string, limit = 50, allowed?: string[]) {
        // Someone limited to some customers sees only what was sent for schedules of those customers.
        const permitted = allowed ? (await this.prisma.report_schedules.findMany({ where: { client_id: { in: allowed } }, select: { id: true } })).map((s) => s.id) : null;
        const rows = await this.prisma.report_deliveries.findMany({
            where: { ...(scheduleId ? { schedule_id: scheduleId } : {}), ...(permitted ? { schedule_id: scheduleId ? scheduleId : { in: permitted } } : {}) },
            orderBy: { ran_at: "desc" },
            take: Math.min(Math.max(1, limit), 200),
        });
        return {
            items: rows.map((d) => ({ id: d.id, scheduleId: d.schedule_id, label: d.schedule_label, reportKey: d.report_key, at: d.ran_at, trigger: d.trigger, ok: d.ok, recipients: d.recipients, subject: d.subject, attachments: d.attachments, result: d.result, error: d.error })),
        };
    }

    /**
     * Moves on to the next period only after a successful send. If mail is down it tries again at
     * the next sweep, so a report is late rather than lost.
     */
    async runSchedule(row: ScheduleRow, now = new Date()): Promise<boolean> {
        const ctx = await this.contextFor(row, "scheduled");
        try {
            const outcome = await this.deliver(row, row.next_run_at, ctx);
            if (!ctx.logged) await this.logDelivery(ctx, { ok: true, result: outcome });
            // A one-off schedule has done its job: switch it off and keep it in the list as a record.
            const next = computeNextRun(this.ruleOf(row), now);
            await this.prisma.report_schedules.update({ where: { id: row.id }, data: { last_run_at: now, last_error: null, last_result: outcome, ...(next ? { next_run_at: next } : { enabled: false }) } });
            return true;
        } catch (err) {
            if (!ctx.logged) await this.logDelivery(ctx, { ok: false, error: (err as Error).message });
            await this.prisma.report_schedules.update({ where: { id: row.id }, data: { last_error: (err as Error).message.slice(0, MAX_SCHEDULE_ERROR) } });
            return false;
        }
    }

    /** Sends a schedule's report now, to see what it looks like. It does not move the schedule's next run. */
    async sendNow(id: string, now = new Date()) {
        const row = await this.prisma.report_schedules.findUnique({ where: { id } });
        if (!row) throw new NotFoundException("Schedule not found");
        const ctx = await this.contextFor(row, "test");
        try {
            const outcome = await this.deliver(row, now, ctx);
            if (!ctx.logged) await this.logDelivery(ctx, { ok: true, result: outcome });
            await this.prisma.report_schedules.update({ where: { id }, data: { last_run_at: now, last_error: null, last_result: `${outcome} (test)` } });
            return { id, result: outcome };
        } catch (err) {
            const message = (err as Error).message.slice(0, MAX_SCHEDULE_ERROR);
            if (!ctx.logged) await this.logDelivery(ctx, { ok: false, error: message });
            await this.prisma.report_schedules.update({ where: { id }, data: { last_error: message } });
            throw new BadRequestException(message);
        }
    }

    @Interval(RUN_EVERY_MS)
    async runDue(now = new Date()): Promise<void> {
        if (this.running) return;
        this.running = true;
        try {
            const due = await this.prisma.report_schedules.findMany({ where: { enabled: true, next_run_at: { lte: now } }, take: 50 });
            for (const row of due) await this.runSchedule(row, now);
            await this.prisma.report_deliveries.deleteMany({ where: { ran_at: { lt: new Date(now.getTime() - KEEP_DELIVERY_DAYS * 86_400_000) } } });
        } catch (err) {
            this.logger.error(`Scheduled reports failed: ${(err as Error).message}`);
        } finally {
            this.running = false;
        }
    }
}
