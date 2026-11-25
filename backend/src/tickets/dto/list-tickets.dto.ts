import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, Min } from "class-validator";
import { Type } from "class-transformer";

export class ListTicketsQuery {
  @IsOptional()
  @IsUUID()
  organizationId?: string;

  // Legacy alias
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @IsOptional()
  @IsIn(["open", "in_progress", "pending", "resolved", "closed"])
  status?: "open" | "in_progress" | "pending" | "resolved" | "closed";

  @IsOptional()
  @IsIn(["low", "medium", "high", "urgent"])
  priority?: "low" | "medium" | "high" | "urgent";

  @IsOptional()
  @IsString()
  search?: string;

  /** Only tickets that have this device on them. */
  @IsOptional()
  @IsUUID()
  deviceId?: string;

  /** Only tickets this customer contact asked for. */
  @IsOptional()
  @IsUUID()
  contactId?: string;

  /** Only tickets a recurring schedule opened. */
  @IsOptional()
  @IsUUID()
  recurringId?: string;

  /** Only tickets in this queue, or "none" for tickets in no queue. */
  @IsOptional()
  @IsString()
  queueId?: string;

  /** "me", "unassigned" or a person's id. */
  @IsOptional()
  @IsString()
  assignee?: string;

  /** Only tickets whose SLA is: breached, warning, at_risk (either), paused, ok or none. */
  @IsOptional()
  @IsString()
  sla?: string;

  /** created (default), updated, priority or sla_due (the soonest due time first). */
  @IsOptional()
  @IsString()
  sort?: string;

  @IsOptional()
  @IsIn(["asc", "desc"])
  dir?: "asc" | "desc";

  /** Only tickets whose custom field with this key has the value in customValue. */
  @IsOptional()
  @IsString()
  customField?: string;

  @IsOptional()
  @IsString()
  customValue?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  pageSize?: number = 25;
}
