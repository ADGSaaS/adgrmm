// backend/src/audit/audit.dto.ts
import { IsIn, IsOptional, IsString, MaxLength } from "class-validator";

export class AuditQueryDto {
    @IsOptional() @IsString() @MaxLength(64) category?: string;
    @IsOptional() @IsString() @MaxLength(320) actor?: string;
    @IsOptional() @IsString() @MaxLength(200) action?: string;
    @IsOptional() @IsString() @MaxLength(300) target?: string;
    @IsOptional() @IsIn(["success", "failure"]) outcome?: "success" | "failure";
    @IsOptional() @IsString() @MaxLength(64) from?: string;
    @IsOptional() @IsString() @MaxLength(64) to?: string;
    @IsOptional() @IsString() @MaxLength(300) q?: string;
    @IsOptional() @IsString() @MaxLength(200) cursor?: string;
    @IsOptional() @IsString() @MaxLength(6) limit?: string;
}
