import { ArrayMinSize, IsArray, IsBoolean, IsIn, IsOptional, IsString, IsUUID, ValidateIf } from "class-validator";

export class PatchInstallDto {
    @IsUUID()
    deviceId!: string;

    @IsOptional()
    @IsBoolean()
    includeOptional?: boolean;

    /** Install every update ("all") or every security update ("security") the device offers, instead of naming them. */
    @IsOptional()
    @IsIn(["all", "security"])
    mode?: "all" | "security";

    @ValidateIf((o) => !o.mode)
    @IsArray()
    @ArrayMinSize(1)
    @IsString({ each: true })
    ids?: string[];
}
