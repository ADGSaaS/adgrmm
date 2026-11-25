-- A private note can be marked as a handoff: where the ticket was left for the next technician.
ALTER TABLE "ticket_activity" ADD COLUMN "is_handoff" BOOLEAN NOT NULL DEFAULT false;
