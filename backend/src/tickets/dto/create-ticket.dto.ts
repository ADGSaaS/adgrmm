import { IsArray, IsIn, IsObject, IsOptional, IsString, IsUUID, MaxLength } from "class-validator";

export class CreateTicketDto {
  // Preferred
  @IsOptional()
  @IsUUID()
  organizationId?: string;

  // Legacy alias (maps to organizationId)
  @IsOptional()
  @IsUUID()
  customerId?: string;

  // Preferred field name for UI
  @IsOptional()
  @IsString()
  @MaxLength(300)
  subject?: string;

  // Legacy alias (maps to subject)
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

  @IsOptional()
  @IsUUID()
  deviceId?: string;

  /** More devices of the same customer to put on the ticket. */
  @IsOptional()
  @IsArray()
  @IsUUID(undefined, { each: true })
  deviceIds?: string[];

  /** The customer's own contact who asked (from the customer record). */
  @IsOptional()
  @IsUUID()
  requesterCustomerContactId?: string;

  /** A ticket template to start from: what is not given here (subject, description, priority, custom fields) comes from it. */
  @IsOptional()
  @IsUUID()
  templateId?: string;

  /** The customer (client) the ticket is for. Taken from the device when a device is given and this is not. */
  @IsOptional()
  @IsUUID()
  clientId?: string;

  /** The queue the ticket waits in. Routing rules may also choose one when none is given. */
  @IsOptional()
  @IsUUID()
  queueId?: string;

  /** Values for the ticket custom fields, by field key. */
  @IsOptional()
  @IsObject()
  customFields?: Record<string, unknown>;
}
