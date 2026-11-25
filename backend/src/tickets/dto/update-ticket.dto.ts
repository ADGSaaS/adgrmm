import { IsIn, IsObject, IsOptional, IsString, IsUUID, MaxLength } from "class-validator";

export class UpdateTicketDto {
  @IsOptional()
  @IsUUID()
  organizationId?: string;

  // Legacy alias
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  subject?: string;

  // Legacy alias
  @IsOptional()
  @IsString()
  @MaxLength(300)
  title?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsIn(["open", "in_progress", "pending", "resolved", "closed"])
  status?: "open" | "in_progress" | "pending" | "resolved" | "closed";

  @IsOptional()
  @IsIn(["low", "medium", "high", "urgent"])
  priority?: "low" | "medium" | "high" | "urgent";

  @IsOptional()
  @IsUUID()
  assigneeUserId?: string;

  @IsOptional()
  @IsUUID()
  requesterContactId?: string;

  /** The main device. A device of another customer is refused; null takes the main device off the ticket. */
  @IsOptional()
  @IsUUID()
  deviceId?: string | null;

  /** The customer's own contact who asked; null clears it. */
  @IsOptional()
  @IsUUID()
  requesterCustomerContactId?: string | null;

  /** The customer (client) the ticket is for. */
  @IsOptional()
  @IsUUID()
  clientId?: string;

  // ISO string or null to clear
  @IsOptional()
  @IsString()
  dueAt?: string | null;

  // ISO string or null to clear
  @IsOptional()
  @IsString()
  closedAt?: string | null;

  /** The queue the ticket waits in; null takes it out of its queue. */
  @IsOptional()
  @IsUUID()
  queueId?: string | null;

  /** Values for the ticket custom fields, by field key. */
  @IsOptional()
  @IsObject()
  customFields?: Record<string, unknown>;
}
