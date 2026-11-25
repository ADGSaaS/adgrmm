-- AlterTable
ALTER TABLE "report_schedules" ADD COLUMN     "config" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "format" TEXT NOT NULL DEFAULT 'pdf',
ADD COLUMN     "last_result" TEXT,
ADD COLUMN     "report_key" TEXT NOT NULL DEFAULT 'customer-health',
ADD COLUMN     "send_if_empty" BOOLEAN NOT NULL DEFAULT true,
ALTER COLUMN "client_id" DROP NOT NULL;

