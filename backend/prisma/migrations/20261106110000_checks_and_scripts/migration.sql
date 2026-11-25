-- Checks can be switched off without deleting them, and scripts keep a history and schedules.

ALTER TABLE "checks" ADD COLUMN "enabled" BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE "script_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "automation_id" UUID,
    "script_name" TEXT NOT NULL,
    "job_id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "schedule_id" UUID,
    "triggered_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "script_runs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "script_runs_automation_id_fkey" FOREIGN KEY ("automation_id") REFERENCES "automations"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "script_runs_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "script_runs_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "script_runs_created_at_idx" ON "script_runs"("created_at" DESC);
CREATE INDEX "script_runs_automation_id_idx" ON "script_runs"("automation_id");
CREATE INDEX "script_runs_device_id_idx" ON "script_runs"("device_id");

CREATE TABLE "script_schedules" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "automation_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" UUID,
    "interval_minutes" INTEGER NOT NULL,
    "next_run_at" TIMESTAMPTZ(6) NOT NULL,
    "last_run_at" TIMESTAMPTZ(6),
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "parameters" JSONB NOT NULL DEFAULT '{}',
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "script_schedules_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "script_schedules_automation_id_fkey" FOREIGN KEY ("automation_id") REFERENCES "automations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "script_schedules_enabled_next_run_at_idx" ON "script_schedules"("enabled", "next_run_at");
