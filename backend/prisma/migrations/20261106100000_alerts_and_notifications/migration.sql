-- Alerts raised from failing checks and offline devices, and how people get told about them.

CREATE TABLE "alerts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "device_id" UUID NOT NULL,
    "assignment_id" UUID,
    "kind" TEXT NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'OPEN',
    "severity" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT,
    "open_count" INTEGER NOT NULL DEFAULT 1,
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "state_changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "silenced_until" TIMESTAMPTZ(6),
    "resolved_at" TIMESTAMPTZ(6),
    "last_notified_at" TIMESTAMPTZ(6),
    "ticket_id" UUID,
    CONSTRAINT "alerts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "alerts_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- One live alert per problem. A problem that returns after being resolved is a new alert.
CREATE UNIQUE INDEX "alerts_one_live_per_problem" ON "alerts"("dedupe_key") WHERE "state" <> 'RESOLVED';
CREATE INDEX "alerts_state_last_seen_at_idx" ON "alerts"("state", "last_seen_at" DESC);
CREATE INDEX "alerts_device_id_idx" ON "alerts"("device_id");

CREATE TABLE "alert_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "alert_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "actor_user_id" UUID,
    "reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "alert_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "alert_events_alert_id_fkey" FOREIGN KEY ("alert_id") REFERENCES "alerts"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "alert_events_alert_id_created_at_idx" ON "alert_events"("alert_id", "created_at");

CREATE TABLE "alert_settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "offline_after_minutes" INTEGER NOT NULL DEFAULT 15,
    "renotify_after_hours" INTEGER NOT NULL DEFAULT 0,
    "auto_ticket" BOOLEAN NOT NULL DEFAULT false,
    "auto_ticket_min_severity" TEXT NOT NULL DEFAULT 'CRIT',
    "auto_resolve_ticket" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "alert_settings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "alert_settings_single_row" CHECK ("id" = 1)
);

INSERT INTO "alert_settings" ("id") VALUES (1);

CREATE TABLE "notification_channels" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "min_severity" TEXT NOT NULL DEFAULT 'WARN',
    "notify_on_resolve" BOOLEAN NOT NULL DEFAULT true,
    "config" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "notification_channels_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "notification_deliveries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "channel_id" UUID NOT NULL,
    "alert_id" UUID,
    "event" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "delivered_at" TIMESTAMPTZ(6),
    CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "notification_deliveries_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "notification_channels"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "notification_deliveries_alert_id_fkey" FOREIGN KEY ("alert_id") REFERENCES "alerts"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "notification_deliveries_status_next_attempt_at_idx" ON "notification_deliveries"("status", "next_attempt_at");
