-- AlterTable
ALTER TABLE "clients" ADD COLUMN "archived_at" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "sites"
  ADD COLUMN "phone" TEXT,
  ADD COLUMN "email" TEXT,
  ADD COLUMN "contact_name" TEXT,
  ADD COLUMN "contact_email" TEXT,
  ADD COLUMN "contact_phone" TEXT,
  ADD COLUMN "time_zone" TEXT,
  ADD COLUMN "notes" TEXT;
