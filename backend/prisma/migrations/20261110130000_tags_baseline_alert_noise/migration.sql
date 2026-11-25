-- AlterTable
ALTER TABLE "policies" ADD COLUMN "apply_to_new_customers" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "tag_defs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tag_defs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_tags" (
    "device_id" UUID NOT NULL,
    "tag_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_tags_pkey" PRIMARY KEY ("device_id","tag_id")
);

-- CreateTable
CREATE TABLE "alert_pending" (
    "dedupe_key" TEXT NOT NULL,
    "device_id" UUID NOT NULL,
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alert_pending_pkey" PRIMARY KEY ("dedupe_key")
);

-- CreateIndex
CREATE UNIQUE INDEX "tag_defs_organization_id_name_key" ON "tag_defs"("organization_id", "name");

-- CreateIndex
CREATE INDEX "device_tags_tag_id_idx" ON "device_tags"("tag_id");

-- CreateIndex
CREATE INDEX "alert_pending_last_seen_at_idx" ON "alert_pending"("last_seen_at");

-- AddForeignKey
ALTER TABLE "tag_defs" ADD CONSTRAINT "tag_defs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "device_tags" ADD CONSTRAINT "device_tags_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "device_tags" ADD CONSTRAINT "device_tags_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "tag_defs"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
