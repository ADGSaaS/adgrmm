import { Injectable } from "@nestjs/common";
import { PrismaService } from "../storage/prisma.service";
import { LocalizationDto, LocalizationRow } from "./localization.dto";

function firstNonEmpty(...values: Array<string | null | undefined>): string | undefined {
    return values.find((v) => v !== null && v !== undefined && v !== "") ?? undefined;
}

@Injectable()
export class LocalizationService {
    constructor(private readonly prisma: PrismaService) { }

    async get(organizationId: string): Promise<LocalizationRow | null> {
        const row = await this.prisma.localization_settings.findUnique({
            where: { organization_id: organizationId },
        });
        if (!row) return null;

        const dateFormat = row.date_format.toLowerCase() === "yyyy-mm-dd"
            ? "YYYY-MM-DD"
            : firstNonEmpty(row.date_format) ?? "MM/DD/YYYY";
        const timeFormat = ["24h", "hh:mm", "h:mm"].includes(row.time_format.toLowerCase())
            ? "24h"
            : "12h";

        return {
            id: row.organization_id,
            language: firstNonEmpty(row.language, row.locale) ?? "en-US",
            dateFormat,
            timeFormat,
            numberFormat: firstNonEmpty(row.number_format) ?? "1,234.56",
            timeZone: firstNonEmpty(row.time_zone, row.timezone) ?? "UTC",
            firstDayOfWeek: row.first_day_of_week === 1 ? "monday" : "sunday",
            currency: firstNonEmpty(row.currency) ?? "USD",
        } as LocalizationRow;
    }

    async upsert(organizationId: string, input: LocalizationDto): Promise<void> {
        const values = {
            locale: input.language,
            language: input.language,
            timezone: input.timeZone,
            time_zone: input.timeZone,
            date_format: input.dateFormat,
            time_format: input.timeFormat,
            number_format: input.numberFormat,
            first_day_of_week: input.firstDayOfWeek === "monday" ? 1 : 0,
            id: organizationId,
        };

        await this.prisma.localization_settings.upsert({
            where: { organization_id: organizationId },
            create: {
                organization_id: organizationId,
                ...values,
                currency: input.currency ?? "USD",
            },
            update: {
                ...values,
                // An omitted currency keeps the saved one.
                ...(input.currency != null ? { currency: input.currency } : {}),
                updated_at: new Date(),
            },
        });
    }
}
