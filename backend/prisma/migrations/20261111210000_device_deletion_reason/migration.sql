-- A request to remove a device says why, and can open a ticket for the approval.
ALTER TABLE "device_deletion_requests" ADD COLUMN "reason" TEXT;
ALTER TABLE "device_deletion_requests" ADD COLUMN "ticket_id" UUID;
