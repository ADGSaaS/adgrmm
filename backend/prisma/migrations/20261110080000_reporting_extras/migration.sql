-- AlterTable
ALTER TABLE "device_daily" ADD COLUMN     "business_online_samples" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "business_samples" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "software_policies" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "client_id" UUID,
    "kind" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "software_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_settings" (
    "organization_id" UUID NOT NULL,
    "business_days" INTEGER[] DEFAULT ARRAY[1, 2, 3, 4, 5]::INTEGER[],
    "business_start" TEXT NOT NULL DEFAULT '08:00',
    "business_end" TEXT NOT NULL DEFAULT '18:00',
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_settings_pkey" PRIMARY KEY ("organization_id")
);

-- CreateTable
CREATE TABLE "client_report_settings" (
    "client_id" UUID NOT NULL,
    "primary_color" TEXT,
    "logo_file" TEXT,
    "cover_text" TEXT,
    "footer_text" TEXT,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_report_settings_pkey" PRIMARY KEY ("client_id")
);

-- CreateTable
CREATE TABLE "report_deliveries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "schedule_id" UUID,
    "schedule_label" TEXT,
    "report_key" TEXT NOT NULL,
    "ran_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "trigger" TEXT NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "recipients" TEXT NOT NULL,
    "subject" TEXT,
    "attachments" TEXT,
    "result" TEXT,
    "error" TEXT,

    CONSTRAINT "report_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_client_access" (
    "user_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_client_access_pkey" PRIMARY KEY ("user_id","client_id")
);

-- CreateIndex
CREATE INDEX "software_policies_organization_id_client_id_idx" ON "software_policies"("organization_id", "client_id");

-- CreateIndex
CREATE INDEX "report_deliveries_schedule_id_ran_at_idx" ON "report_deliveries"("schedule_id", "ran_at" DESC);

-- CreateIndex
CREATE INDEX "report_deliveries_ran_at_idx" ON "report_deliveries"("ran_at" DESC);

-- CreateIndex
CREATE INDEX "user_client_access_client_id_idx" ON "user_client_access"("client_id");

