// backend/src/reports/report-settings.service.ts
//
// Settings the reports share. For now, when the working day is, so availability can be measured in business hours only.
import { BadRequestException, Injectable } from "@nestjs/common";
import { PrismaService } from "../storage/prisma.service";
import { OrganizationContextService } from "../storage/organization-context.service";
import { isValidTimezone, localParts } from "./schedule-time";
import { PoliciesService } from "../policies/policies.service";

export type BusinessHours = { days: number[]; start: string; end: string; timezone: string };

export const DEFAULT_BUSINESS_HOURS: BusinessHours = { days: [1, 2, 3, 4, 5], start: "08:00", end: "18:00", timezone: "UTC" };

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));

/** Whether an instant falls inside the working day. A day that ends before it starts runs overnight. */
export function inBusinessHours(at: number, hours: BusinessHours): boolean {
    const p = localParts(at, hours.timezone);
    const now = p.hour * 60 + p.minute;
    const start = minutes(hours.start);
    const end = minutes(hours.end);
    if (start === end) return hours.days.includes(p.weekday);
    if (start < end) return hours.days.includes(p.weekday) && now >= start && now < end;
    // Overnight: the evening belongs to the day it started on, the morning after to the day before.
    return (now >= start && hours.days.includes(p.weekday)) || (now < end && hours.days.includes((p.weekday + 6) % 7));
}

@Injectable()
export class ReportSettingsService {
    constructor(private readonly prisma: PrismaService, private readonly orgs: OrganizationContextService) { }

    async getBusinessHours(): Promise<BusinessHours> {
        const row = await this.prisma.report_settings.findUnique({ where: { organization_id: await this.orgs.getDefaultOrganizationId() } });
        if (!row) return DEFAULT_BUSINESS_HOURS;
        return { days: row.business_days?.length ? row.business_days : DEFAULT_BUSINESS_HOURS.days, start: row.business_start, end: row.business_end, timezone: row.timezone };
    }

    async setBusinessHours(input: { days: number[]; start: string; end: string; timezone: string }): Promise<BusinessHours> {
        const days = [...new Set(input.days ?? [])].sort();
        if (!days.length || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw new BadRequestException("Choose at least one working day.");
        if (!TIME.test(input.start ?? "") || !TIME.test(input.end ?? "")) throw new BadRequestException("Times must look like 08:00.");
        if (!isValidTimezone(input.timezone ?? "")) throw new BadRequestException("That time zone is not one we know.");
        const organization_id = await this.orgs.getDefaultOrganizationId();
        const data = { business_days: days, business_start: input.start, business_end: input.end, timezone: input.timezone, updated_at: new Date() };
        await this.prisma.report_settings.upsert({ where: { organization_id }, create: { organization_id, ...data }, update: data });
        PoliciesService.invalidate();
        return this.getBusinessHours();
    }
}
