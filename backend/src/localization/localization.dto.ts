import { IsIn, IsOptional, IsString } from "class-validator";

export class LocalizationDto {
    @IsString()
    language!: string;

    @IsString()
    dateFormat!: string;

    @IsString()
    timeFormat!: string;

    @IsString()
    numberFormat!: string;

    @IsString()
    timeZone!: string;

    @IsIn(["sunday", "monday"])
    firstDayOfWeek!: "sunday" | "monday";

    @IsOptional()
    @IsString()
    currency?: string;
}

export type LocalizationRow = LocalizationDto & { id: string };
