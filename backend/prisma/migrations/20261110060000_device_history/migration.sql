-- CreateTable
CREATE TABLE "device_daily" (
    "device_id" UUID NOT NULL,
    "day" DATE NOT NULL,
    "samples" INTEGER NOT NULL DEFAULT 0,
    "online_samples" INTEGER NOT NULL DEFAULT 0,
    "disk_free_pct_min" DOUBLE PRECISION,
    "disk_total_bytes" BIGINT,
    "disk_free_bytes" BIGINT,

    CONSTRAINT "device_daily_pkey" PRIMARY KEY ("device_id","day")
);

-- CreateTable
CREATE TABLE "device_changes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "device_id" UUID NOT NULL,
    "changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,

    CONSTRAINT "device_changes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "device_daily_day_idx" ON "device_daily"("day");

-- CreateIndex
CREATE INDEX "device_changes_device_id_changed_at_idx" ON "device_changes"("device_id", "changed_at" DESC);

-- CreateIndex
CREATE INDEX "device_changes_changed_at_idx" ON "device_changes"("changed_at" DESC);

-- AddForeignKey
ALTER TABLE "device_daily" ADD CONSTRAINT "device_daily_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_changes" ADD CONSTRAINT "device_changes_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
