// backend/src/reports/full-report.service.ts
//
// The All report: everything the other reports know, for one device, a site, a customer or the whole fleet, in one
// document. A PDF with a cover scorecard and a section for each report, and an Excel workbook with a sheet for each,
// carrying every column and every row. Sections the person is not allowed to read are left out and listed, so the report
// never shows more than its reader may see.
import { Injectable } from "@nestjs/common";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { PrismaService } from "../storage/prisma.service";
import { CATALOG, EndpointReportsService, type ReportInput, type ReportKey, type ReportResult } from "./endpoint-reports.service";
import { buildXlsx, type Sheet, type SummaryLine } from "./xlsx";
import { ClientBrandingService } from "./client-branding.service";

/** The sections, in the order they appear. */
export const FULL_SECTIONS: ReportKey[] = [
    "hardware-inventory",
    "hardware-age",
    "windows-support",
    "network-map",
    "device-health",
    "availability",
    "disk-trend",
    "stale-devices",
    "security-status",
    "security-score",
    "risky-configuration",
    "antivirus-threats",
    "patch-compliance",
    "patch-missing",
    "patch-activity",
    "patch-speed",
    "software-summary",
    "software-inventory",
    "software-compliance",
    "change-log",
    "alert-history",
    "alert-noise",
    "script-results",
    "ticket-sla",
    "technician-activity",
    "remote-sessions",
    "renewals",
];

/** The quarterly business review: the sections a customer cares about, over the last quarter. */
export const QBR_SECTIONS: ReportKey[] = [
    "security-score",
    "risky-configuration",
    "antivirus-threats",
    "patch-compliance",
    "patch-speed",
    "hardware-age",
    "windows-support",
    "availability",
    "disk-trend",
    "software-compliance",
    "alert-noise",
    "ticket-sla",
    "script-results",
    "technician-activity",
    "stale-devices",
    "renewals",
];

/** One section of a report someone designed: which report, how it is shown, and what it is called. */
export type SectionSpec = { key: ReportKey; title?: string; params?: Record<string, string | number>; view?: unknown; charts?: boolean; maxRows?: number };

export type BuildOptions = {
    kind?: "full" | "qbr" | "custom";
    sections?: ReportKey[];
    /** For reports people design: the sections, each with its own settings. Takes the place of `sections`. */
    sectionSpecs?: SectionSpec[];
    title?: string;
    intro?: string;
    footer?: string;
    cover?: { scorecard?: boolean; recommendations?: boolean };
    defaultDays?: number;
    /** The customers the reader may see, when limited. */
    restrictClientIds?: string[];
};

/** What an emailed copy may include. Remote sessions come from the audit log, so they are never sent by email. */
export const EMAILED_PERMISSIONS = new Set(["devices.read", "alerts.read"]);

/** Rows a section may show in the PDF. The workbook always has every row. */
const PDF_ROWS_PER_SECTION = 300;

export type ScoreTile = { label: string; value: string; detail?: string; tone: "good" | "warn" | "bad" | "neutral" };

export type FullReport = {
    kind: "full" | "qbr" | "custom";
    title: string;
    /** The customer the report is for, when it is for one, so its own colour, logo and notes can be used. */
    clientId: string | null;
    /** Text the person wrote for the cover, and for the foot of every page. */
    intro: string | null;
    footer: string | null;
    cover: { scorecard: boolean; recommendations: boolean };
    /** Rows to show in the PDF for each section, in the order of `sections`. The workbook always has every row. */
    limits: Array<number | undefined>;
    /** What needs attention and what was done, in plain sentences worked out from the sections. */
    recommendations: string[];
    highlights: string[];
    generatedAt: string;
    scope: { customer: string | null; site: string | null; device: string | null };
    period: { from: string; to: string } | null;
    scorecard: ScoreTile[];
    sections: ReportResult[];
    omitted: Array<{ key: ReportKey; title: string; reason: string }>;
};

const pct = (part: number, whole: number) => (whole ? Math.round((part / whole) * 100) : null);
const toneFor = (percent: number | null, good = 90, warn = 70): ScoreTile["tone"] => (percent === null ? "neutral" : percent >= good ? "good" : percent >= warn ? "warn" : "bad");
const count = (rows: Array<Record<string, unknown>>, key: string, value: string) => rows.filter((r) => r[key] === value).length;
const sum = (rows: Array<Record<string, unknown>>, key: string) => rows.reduce((s, r) => s + (typeof r[key] === "number" ? (r[key] as number) : 0), 0);

@Injectable()
export class FullReportService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly endpoint: EndpointReportsService,
        private readonly clientBranding: ClientBrandingService,
    ) { }

    /**
     * Builds every section the reader may see. `permissions` is what they are allowed to read; null means no limit, for
     * jobs the system runs for itself.
     */
    async build(input: ReportInput, permissions: ReadonlySet<string> | null = null, options: BuildOptions = {}): Promise<FullReport> {
        const kind = options.kind ?? "full";
        const wantedKeys = options.sections ?? FULL_SECTIONS;
        // The review covers a quarter unless told otherwise.
        if (options.defaultDays && !input.from && !input.to) {
            const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
            input = { ...input, from: day(Date.now() - (options.defaultDays - 1) * 86_400_000), to: day(Date.now()) };
        }
        if (options.restrictClientIds) input = { ...input, restrictClientIds: options.restrictClientIds };
        const allowed = (key: ReportKey) => permissions === null || permissions.has(CATALOG.find((d) => d.key === key)!.permission);
        const omitted: FullReport["omitted"] = [];
        const specs: SectionSpec[] = options.sectionSpecs ?? wantedKeys.map((key) => ({ key }));
        const wanted: SectionSpec[] = [];
        for (const spec of specs) {
            const def = CATALOG.find((d) => d.key === spec.key)!;
            if (allowed(spec.key)) wanted.push(spec);
            else omitted.push({ key: spec.key, title: spec.title || def.title, reason: permissions === EMAILED_PERMISSIONS ? `${def.title} is not included in emailed reports.` : "You do not have the right to read this." });
        }
        const sections = await Promise.all(
            wanted.map(async (spec) => {
                const result = await this.endpoint.run(spec.key, spec.params ? { ...input, ...spec.params } : input, spec.view);
                if (spec.title) result.title = spec.title;
                if (spec.charts === false) result.charts = [];
                return result;
            }),
        );

        const clientId = await this.clientOf(input);
        const customerLook = await this.clientBranding.forReport(clientId);
        const first = sections[0];
        const scope = first?.scope ?? { customer: null, site: null, device: null };
        const what = scope.device ?? scope.site ?? scope.customer;
        const heading = options.title ?? (kind === "qbr" ? "Quarterly business review" : "Full report");
        return {
            kind,
            clientId,
            // The customer's own note follows the one written into the design, and its footer wins over the design's.
            intro: [options.intro?.trim(), customerLook.coverText?.trim()].filter(Boolean).join("\n\n") || null,
            footer: customerLook.footerText?.trim() || options.footer?.trim() || null,
            cover: { scorecard: options.cover?.scorecard !== false, recommendations: options.cover?.recommendations !== false },
            limits: wanted.map((spec) => spec.maxRows),
            title: what ? `${heading}: ${what}` : heading,
            recommendations: this.recommendations(sections),
            highlights: this.highlights(sections),
            generatedAt: new Date().toISOString(),
            scope,
            period: sections.find((s) => s.period)?.period ?? null,
            scorecard: this.scorecard(sections),
            sections,
            omitted,
        };
    }

    /** The customer a report is about, from the customer, site or device it was asked for. */
    private async clientOf(input: ReportInput): Promise<string | null> {
        if (input.clientId) return input.clientId;
        if (input.siteId) return (await this.prisma.sites.findUnique({ where: { id: input.siteId }, select: { client_id: true } }))?.client_id ?? null;
        if (input.deviceId) return (await this.prisma.devices.findUnique({ where: { id: input.deviceId }, select: { sites: { select: { client_id: true } } } }))?.sites?.client_id ?? null;
        return null;
    }

    /** Plain sentences about what needs attention, biggest first. A sentence appears only when there is something to say. */
    private recommendations(sections: ReportResult[]): string[] {
        const by = (key: ReportKey) => sections.find((s) => s.key === key);
        const n = (rows: Array<Record<string, unknown>>, key: string, ...values: string[]) => rows.filter((r) => values.includes(String(r[key]))).length;
        const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
        const out: Array<{ weight: number; text: string }> = [];
        const add = (weight: number, text: string) => out.push({ weight, text });

        const threats = by("antivirus-threats");
        if (threats) {
            const active = n(threats.rows, "status", "Active", "Failed to clean");
            const devices = new Set(threats.rows.filter((r) => ["Active", "Failed to clean"].includes(String(r.status))).map((r) => r.deviceId)).size;
            if (active) add(110 + active, `${plural(devices, "device")} ${devices === 1 ? "has" : "have"} a threat that is still active or could not be cleaned.`);
            else if (threats.rows.length) add(35, `${plural(threats.rows.length, "threat")} ${threats.rows.length === 1 ? "was" : "were"} found and dealt with.`);
        }
        const risk = by("risky-configuration");
        if (risk) { const c = n(risk.rows, "result", "High risk"); if (c) add(100 + c, `${plural(c, "device")} ${c === 1 ? "has" : "have"} high-risk settings, such as Remote Desktop without network-level authentication or automatic logon.`); }
        const sec = by("security-status");
        if (sec) { const c = n(sec.rows, "result", "Needs attention"); if (c) add(90 + c, `${plural(c, "device")} ${c === 1 ? "has" : "have"} an antivirus, firewall or disk encryption problem.`); }
        const patch = by("patch-compliance");
        if (patch) {
            const c = patch.rows.filter((r) => r.result !== "Compliant" && r.result !== "Not scanned").length;
            const critical = patch.rows.reduce((s, r) => s + (typeof r.critical === "number" ? r.critical : 0), 0);
            if (c) add(80 + c, `${plural(c, "Windows device")} ${c === 1 ? "is" : "are"} behind on patches${critical ? `, with ${plural(critical, "critical update")} missing` : ""}.`);
        }
        const support = by("windows-support");
        if (support) {
            const c = n(support.rows, "support", "Out of support");
            const notReady = n(support.rows, "windows11", "Not ready");
            if (c) add(75 + c, `${plural(c, "device")} ${c === 1 ? "runs" : "run"} a version of Windows that no longer gets security updates${notReady ? `; ${notReady} of them cannot upgrade to Windows 11 and need replacing` : ""}.`);
        }
        const age = by("hardware-age");
        if (age) { const c = n(age.rows, "stage", "Replace now"); const soon = n(age.rows, "stage", "Plan soon"); if (c || soon) add(60 + c, `${plural(c, "device")} ${c === 1 ? "is" : "are"} past replacement age${soon ? ` and ${soon} more will be within a year` : ""}.`); }
        const disk = by("disk-trend");
        if (disk) { const c = n(disk.rows, "state", "Full soon"); if (c) add(70 + c, `${plural(c, "device")} ${c === 1 ? "is" : "are"} on course to run out of disk space within weeks.`); }
        const avail = by("availability");
        if (avail) { const c = n(avail.rows, "result", "Below target"); if (c) add(55 + c, `${plural(c, "device")} ${c === 1 ? "was" : "were"} online less than the availability target.`); }
        const soft = by("software-compliance");
        if (soft) { const c = n(soft.rows, "result", "Non-compliant"); if (c) add(50 + c, `${plural(c, "device")} ${c === 1 ? "is" : "are"} missing required software or running software that is not allowed.`); }
        const noise = by("alert-noise");
        if (noise) { const c = n(noise.rows, "verdict", "Noisy"); if (c) add(40 + c, `${plural(c, "alert")} fire${c === 1 ? "s" : ""} so often that ${c === 1 ? "it is" : "they are"} worth tuning.`); }
        const tickets = by("ticket-sla");
        if (tickets) { const c = n(tickets.rows, "sla", "Breached", "Overdue"); if (c) add(45 + c, `${plural(c, "ticket")} missed or ${c === 1 ? "is" : "are"} past ${c === 1 ? "its" : "their"} due time.`); }
        const stale = by("stale-devices");
        if (stale && stale.rows.length) add(30 + stale.rows.length, `${plural(stale.rows.length, "device")} ${stale.rows.length === 1 ? "has" : "have"} not been seen for a long time or ${stale.rows.length === 1 ? "has" : "have"} no agent.`);
        const renew = by("renewals");
        if (renew) { const c = n(renew.rows, "state", "Expired", "Due within 30 days"); if (c) add(65 + c, `${plural(c, "warranty or contract", "warranties or contracts")} ${c === 1 ? "has" : "have"} expired or ${c === 1 ? "expires" : "expire"} within 30 days.`); }
        return out.sort((a, b) => b.weight - a.weight).slice(0, 10).map((o) => o.text);
    }

    /** What was done in the period, for the review. */
    private highlights(sections: ReportResult[]): string[] {
        const by = (key: ReportKey) => sections.find((s) => s.key === key);
        const value = (s: ReportResult | undefined, label: string) => s?.summary.find((x) => x.label === label)?.value;
        const out: string[] = [];
        const scripts = by("script-results");
        if (scripts && scripts.rows.length) out.push(`${scripts.rows.length} scripts and automations ran, ${value(scripts, "Success rate")} of them successfully.`);
        const tickets = by("ticket-sla");
        if (tickets && tickets.rows.length) out.push(`${tickets.rows.length} tickets were opened${value(tickets, "Avg hours to close") !== "n/a" ? `, closing in ${value(tickets, "Avg hours to close")} hours on average` : ""}${value(tickets, "SLA met") !== "n/a" ? `, with ${value(tickets, "SLA met")} closed on time` : ""}.`);
        const tech = by("technician-activity");
        if (tech && Number(value(tech, "Remote sessions"))) out.push(`Technicians held ${value(tech, "Remote sessions")} remote sessions.`);
        const speed = by("patch-speed");
        if (speed && value(speed, "Average days to install") !== undefined && value(speed, "Average days to install") !== "n/a") out.push(`Patches took ${value(speed, "Average days to install")} days on average to install.`);
        const avail = by("availability");
        if (avail && value(avail, "Average availability") !== undefined && value(avail, "Average availability") !== "n/a") out.push(`Devices were available ${value(avail, "Average availability")} of the time.`);
        const alerts = by("alert-noise");
        if (alerts && Number(value(alerts, "Alerts"))) out.push(`${value(alerts, "Alerts")} alerts were raised, ${value(alerts, "Still open")} still open.`);
        return out;
    }

    /** The headline numbers on the cover. A tile appears only for a section that is in the report. */
    private scorecard(sections: ReportResult[]): ScoreTile[] {
        const by = (key: ReportKey) => sections.find((s) => s.key === key);
        const tiles: ScoreTile[] = [];

        const hardware = by("hardware-inventory");
        if (hardware) {
            const online = count(hardware.rows, "status", "Online");
            tiles.push({ label: "Devices", value: String(hardware.rows.length), detail: `${online} online now`, tone: "neutral" });
        }
        const health = by("device-health");
        if (health) {
            const attention = count(health.rows, "result", "Needs attention");
            tiles.push({ label: "Need attention", value: String(attention), detail: `of ${health.rows.length} devices`, tone: attention === 0 ? "good" : pct(attention, health.rows.length)! > 30 ? "bad" : "warn" });
        }
        const patching = by("patch-compliance");
        if (patching) {
            const p = pct(count(patching.rows, "result", "Compliant"), patching.rows.length);
            const critical = sum(patching.rows, "critical");
            tiles.push({ label: "Patch compliance", value: p === null ? "No Windows devices" : `${p}%`, detail: p === null ? undefined : `${critical} critical missing`, tone: p === null ? "neutral" : critical > 0 && p < 100 ? (p >= 90 ? "warn" : "bad") : toneFor(p) });
        }
        const security = by("security-status");
        if (security) {
            const reported = security.rows.filter((r) => r.result !== "Not reported");
            const protectedCount = count(security.rows, "result", "Protected");
            const p = pct(protectedCount, reported.length);
            tiles.push({ label: "Protected", value: p === null ? "Not reported" : `${p}%`, detail: `${security.rows.length - reported.length} not reported yet`, tone: toneFor(p) });
            const av = security.rows.filter((r) => ["On", "Off", "Out of date"].includes(String(r.antivirusState)));
            const avOk = count(av, "antivirusState", "On");
            tiles.push({ label: "Antivirus on and current", value: av.length ? `${pct(avOk, av.length)}%` : "Not reported", detail: av.length ? `${av.length - avOk} with a problem` : undefined, tone: toneFor(pct(avOk, av.length)) });
            const enc = security.rows.filter((r) => ["Encrypted", "Not encrypted"].includes(String(r.encryption)));
            const encOk = count(enc, "encryption", "Encrypted");
            tiles.push({ label: "Disks encrypted", value: enc.length ? `${pct(encOk, enc.length)}%` : "Not reported", detail: enc.length ? `${enc.length - encOk} not encrypted` : undefined, tone: toneFor(pct(encOk, enc.length)) });
        }
        const score = by("security-score");
        if (score) {
            const scored = score.rows.map((r) => r.score).filter((x): x is number => typeof x === "number");
            const avg = scored.length ? Math.round(scored.reduce((s, x) => s + x, 0) / scored.length) : null;
            tiles.push({ label: "Security score", value: avg === null ? "Not enough data" : String(avg), detail: avg === null ? undefined : "average out of 100", tone: avg === null ? "neutral" : toneFor(avg, 85, 70) });
        }
        const availability = by("availability");
        if (availability) {
            const values = availability.rows.map((r) => r.availability).filter((x): x is number => typeof x === "number");
            const avg = values.length ? Math.round((values.reduce((s, x) => s + x, 0) / values.length) * 10) / 10 : null;
            tiles.push({ label: "Availability", value: avg === null ? "No data yet" : `${avg}%`, detail: avg === null ? undefined : `${count(availability.rows, "result", "Below target")} below target`, tone: avg === null ? "neutral" : toneFor(avg, 99, 95) });
        }
        const age = by("hardware-age");
        if (age) { const c = count(age.rows, "stage", "Replace now"); tiles.push({ label: "Due for replacement", value: String(c), detail: `${count(age.rows, "stage", "Plan soon")} more within a year`, tone: c === 0 ? "good" : "warn" }); }
        const support = by("windows-support");
        if (support) { const c = count(support.rows, "support", "Out of support"); tiles.push({ label: "Windows out of support", value: String(c), detail: `of ${support.rows.length} Windows devices`, tone: c === 0 ? "good" : "bad" }); }
        const threatTiles = by("antivirus-threats");
        if (threatTiles) { const c = count(threatTiles.rows, "status", "Active") + count(threatTiles.rows, "status", "Failed to clean"); tiles.push({ label: "Active threats", value: String(c), detail: `${threatTiles.rows.length} found in the period`, tone: c === 0 ? "good" : "bad" }); }
        const risk = by("risky-configuration");
        if (risk) { const c = count(risk.rows, "result", "High risk"); tiles.push({ label: "High-risk settings", value: String(c), detail: `${count(risk.rows, "result", "Not reported")} not reported yet`, tone: c === 0 ? "good" : "bad" }); }
        const alerts = by("alert-history");
        if (alerts) {
            const open = alerts.rows.filter((r) => !r.resolvedAt).length;
            tiles.push({ label: "Alerts in the period", value: String(alerts.rows.length), detail: `${open} still open, ${count(alerts.rows, "severity", "CRIT")} critical`, tone: open === 0 ? "good" : "warn" });
        }
        const sessions = by("remote-sessions");
        if (sessions) {
            const refused = sessions.rows.filter((r) => String(r.outcome) !== "success").length;
            tiles.push({ label: "Remote sessions", value: String(sessions.rows.length), detail: `${refused} refused`, tone: "neutral" });
        }
        return tiles;
    }

    /** The company's colour and logo for the cover, when set and usable. A logo must be a PNG or JPEG kept in the uploads folder. */
    private async brand(clientId: string | null): Promise<{ color: string | null; logoPath: string | null }> {
        const company = await this.companyBrand();
        const own = await this.clientBranding.forReport(clientId);
        return { color: own.color ?? company.color, logoPath: own.logoPath ?? company.logoPath };
    }

    private async companyBrand(): Promise<{ color: string | null; logoPath: string | null }> {
        const row = await this.prisma.branding_settings.findFirst({ select: { primary_color: true, logo_light_url: true } }).catch(() => null);
        const color = row?.primary_color && /^#[0-9a-f]{6}$/i.test(row.primary_color.trim()) ? row.primary_color.trim() : null;
        let logoPath: string | null = null;
        const url = row?.logo_light_url ?? "";
        if (/\.(png|jpe?g)$/i.test(url)) {
            const candidate = join(process.cwd(), "public", "uploads", basename(url.split("?")[0]));
            if (existsSync(candidate)) logoPath = candidate;
        }
        return { color, logoPath };
    }

    /* ------------------------------ the PDF ------------------------------ */

    async pdf(report: FullReport): Promise<Buffer> {
        const company = await this.prisma.company_profile.findFirst({ select: { name: true, website: true, email: true, phone: true } });
        const companyName = company?.name ?? "";
        const { doc, done, margin } = this.endpoint.newPdf(report.title);
        const width = doc.page.width - margin * 2;
        const brand = await this.brand(report.clientId);
        const accent = brand.color ?? "#111111";

        // ---- cover
        let titleWidth = width;
        if (brand.logoPath) {
            try {
                doc.image(brand.logoPath, margin + width - 150, margin, { fit: [150, 46], align: "right" });
                titleWidth = width - 170;
            } catch {
                /* an unreadable logo is left out */
            }
        }
        doc.font("Helvetica-Bold").fontSize(26).fillColor(accent).text(report.title, margin, margin + 8, { width: titleWidth });
        const scopeText = [report.scope.customer, report.scope.site, report.scope.device].filter(Boolean).join(" / ") || "All customers";
        const period = report.period ? `. Activity from ${report.period.from} to ${report.period.to}` : "";
        doc.font("Helvetica").fontSize(11).fillColor("#555555").text(`${scopeText}${period}.`, margin, doc.y + 2, { width });
        doc.fontSize(9).text(`As of ${report.generatedAt.slice(0, 16).replace("T", " ")} UTC.${companyName ? ` Prepared by ${companyName}.` : ""}`, margin, doc.y + 2, { width });
        const contact = [company?.website, company?.email, company?.phone].filter(Boolean).join("   ");
        if (contact) doc.text(contact, margin, doc.y + 1, { width });
        doc.moveDown(0.8);
        if (report.intro) {
            doc.font("Helvetica").fontSize(10.5).fillColor("#222222").text(report.intro, margin, doc.y, { width: titleWidth });
            doc.moveDown(0.8);
        }

        // ---- scorecard
        const tileW = (width - 14 * 3) / 4;
        const tileH = 66;
        const colours: Record<ScoreTile["tone"], string> = { good: "#16a34a", warn: "#d97706", bad: "#dc2626", neutral: accent };
        let rowTop = doc.y;
        (report.cover.scorecard ? report.scorecard : []).forEach((tile, i) => {
            const col = i % 4;
            if (col === 0 && i > 0) rowTop += tileH + 12;
            const x = margin + col * (tileW + 14);
            doc.roundedRect(x, rowTop, tileW, tileH, 5).lineWidth(0.6).strokeColor("#dde1e7").stroke();
            doc.rect(x, rowTop + 8, 3, tileH - 16).fill(colours[tile.tone]);
            doc.font("Helvetica").fontSize(8).fillColor("#555555").text(tile.label, x + 12, rowTop + 8, { width: tileW - 20, lineBreak: false, ellipsis: true });
            doc.font("Helvetica-Bold").fontSize(tile.value.length > 8 ? 13 : 22).fillColor(colours[tile.tone]).text(tile.value, x + 12, rowTop + 22, { width: tileW - 20, lineBreak: false, ellipsis: true });
            if (tile.detail) doc.font("Helvetica").fontSize(8).fillColor("#555555").text(tile.detail, x + 12, rowTop + 50, { width: tileW - 20, lineBreak: false, ellipsis: true });
        });
        doc.x = margin;
        doc.y = report.cover.scorecard && report.scorecard.length ? rowTop + tileH + 22 : doc.y;

        // ---- what needs attention, and what was done
        const bullets = (heading: string, items: string[]) => {
            if (!items.length) return;
            doc.font("Helvetica-Bold").fontSize(12).fillColor("#111111").text(heading, margin, doc.y, { width });
            doc.moveDown(0.25);
            for (const item of items) doc.font("Helvetica").fontSize(9.5).fillColor("#222222").text(`\u2022  ${item}`, margin + 6, doc.y, { width: width - 6 });
            doc.moveDown(0.8);
        };
        if (report.cover.recommendations) {
            bullets("What needs attention", report.recommendations);
            bullets("What was done", report.highlights);
        }

        // ---- contents
        doc.font("Helvetica-Bold").fontSize(12).fillColor("#111111").text("In this report", margin, doc.y, { width });
        doc.moveDown(0.3);
        for (const s of report.sections) {
            doc.font("Helvetica").fontSize(9.5).fillColor("#222222").text(`${s.title}`, margin, doc.y, { continued: true, width }).fillColor("#777777").text(`   ${s.rows.length.toLocaleString()} ${s.rows.length === 1 ? "row" : "rows"}`);
        }
        if (report.omitted.length) {
            doc.moveDown(0.6);
            doc.font("Helvetica-Oblique").fontSize(8.5).fillColor("#555555").text(`Left out: ${report.omitted.map((o) => o.title).join(", ")}. ${report.omitted[0].reason}`, margin, doc.y, { width });
        }

        // ---- a section for each report
        report.sections.forEach((section, index) => {
            doc.addPage();
            this.endpoint.drawReport(doc, section, companyName, margin, { maxRows: report.limits[index] ?? PDF_ROWS_PER_SECTION });
        });
        this.endpoint.addPageNumbers(doc, margin, report.footer ?? undefined);
        doc.end();
        return done;
    }

    /* ------------------------------ the workbook ------------------------------ */

    async xlsx(report: FullReport): Promise<Buffer> {
        const company = await this.prisma.company_profile.findFirst({ select: { name: true } });
        const scopeText = [report.scope.customer, report.scope.site, report.scope.device].filter(Boolean).join(" / ") || "All customers";
        const lines: SummaryLine[] = [
            { kind: "title", a: report.title },
            { kind: "pair", a: "Covers", b: scopeText },
            ...(report.period ? [{ kind: "pair", a: "Activity period", b: `${report.period.from} to ${report.period.to}` } as SummaryLine] : []),
            { kind: "pair", a: "As of (UTC)", b: report.generatedAt.slice(0, 16).replace("T", " ") },
            ...(company?.name ? [{ kind: "pair", a: "Prepared by", b: company.name } as SummaryLine] : []),
            { kind: "text", a: "All times in this workbook are UTC." },
            ...(report.intro ? [{ kind: "blank" } as SummaryLine, { kind: "text", a: report.intro } as SummaryLine] : []),
            { kind: "blank" },
            ...(report.cover.recommendations && report.recommendations.length ? [{ kind: "heading", a: "What needs attention" } as SummaryLine, ...report.recommendations.map((t): SummaryLine => ({ kind: "text", a: t })), { kind: "blank" } as SummaryLine] : []),
            ...(report.cover.recommendations && report.highlights.length ? [{ kind: "heading", a: "What was done" } as SummaryLine, ...report.highlights.map((t): SummaryLine => ({ kind: "text", a: t })), { kind: "blank" } as SummaryLine] : []),
            ...(report.cover.scorecard ? [{ kind: "heading", a: "Scorecard" } as SummaryLine] : []),
            ...(report.cover.scorecard ? report.scorecard : []).flatMap((t): SummaryLine[] => [{ kind: "pair", a: t.label, b: t.value }, ...(t.detail ? [{ kind: "text", a: `    ${t.detail}` } as SummaryLine] : [])]),
            { kind: "blank" },
            { kind: "heading", a: "Sheets in this workbook" },
            ...report.sections.map((s): SummaryLine => ({ kind: "pair", a: s.title, b: `${s.rows.length.toLocaleString()} rows` })),
        ];
        if (report.omitted.length) lines.push({ kind: "blank" }, { kind: "heading", a: "Left out" }, ...report.omitted.map((o): SummaryLine => ({ kind: "pair", a: o.title, b: o.reason })));
        for (const s of report.sections) {
            if (!s.summary.length && !s.notes.length) continue;
            lines.push({ kind: "blank" }, { kind: "heading", a: s.title });
            for (const item of s.summary) lines.push({ kind: "pair", a: item.label, b: item.value });
            for (const note of s.notes) lines.push({ kind: "text", a: note });
            if (s.truncated) lines.push({ kind: "text", a: "Only the first 20,000 rows are included." });
        }

        // Every column, including the ones hidden on screen by default: this is the report with everything in it.
        const sheets: Sheet[] = [
            { name: "Summary", lines },
            ...report.sections.map((s): Sheet => ({
                name: s.title,
                columns: s.columns.filter((c) => !c.internal).map((c) => ({ key: c.key, label: c.label, type: c.type })),
                rows: s.rows,
            })),
        ];
        return buildXlsx(sheets);
    }

    /* ------------------------------ files ------------------------------ */

    private fileBase(report: FullReport): string {
        const what = report.scope.device ?? report.scope.site ?? report.scope.customer ?? "all-customers";
        const base = report.kind === "qbr" ? "quarterly-review" : report.kind === "custom" ? report.title.split(":")[0].toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "report" : "full-report";
        return `${base}-${what.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "report"}-${report.generatedAt.slice(0, 10)}`;
    }

    async pdfFile(report: FullReport) {
        return { filename: `${this.fileBase(report)}.pdf`, data: await this.pdf(report) };
    }

    async xlsxFile(report: FullReport) {
        return { filename: `${this.fileBase(report)}.xlsx`, data: await this.xlsx(report) };
    }

    /** The scorecard and each section's headline numbers, without the rows, for showing on screen. */
    summarise(report: FullReport) {
        return {
            title: report.title,
            generatedAt: report.generatedAt,
            scope: report.scope,
            period: report.period,
            kind: report.kind,
            intro: report.intro,
            footer: report.footer,
            cover: report.cover,
            recommendations: report.recommendations,
            highlights: report.highlights,
            scorecard: report.scorecard,
            omitted: report.omitted,
            sections: report.sections.map((s) => ({ key: s.key, title: s.title, description: s.description, rows: s.rows.length, summary: s.summary, notes: s.notes, truncated: s.truncated })),
        };
    }
}
