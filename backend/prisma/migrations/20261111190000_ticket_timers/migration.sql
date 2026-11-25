-- A technician's stopwatch on a ticket, kept on the server so it survives closing the browser.
CREATE TABLE "ticket_timers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "started_at" TIMESTAMPTZ(6),
    "accumulated_seconds" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_timers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ticket_timers_user_id_ticket_id_key" ON "ticket_timers"("user_id", "ticket_id");
CREATE INDEX "ticket_timers_user_id_idx" ON "ticket_timers"("user_id");

ALTER TABLE "ticket_timers" ADD CONSTRAINT "ticket_timers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "ticket_timers" ADD CONSTRAINT "ticket_timers_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
