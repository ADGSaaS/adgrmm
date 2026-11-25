-- AlterTable
ALTER TABLE "report_schedules" ADD COLUMN     "day_of_month" INTEGER,
ADD COLUMN     "days_of_week" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
ADD COLUMN     "nth_week" INTEGER,
ADD COLUMN     "nth_weekday" INTEGER,
ADD COLUMN     "once_date" TEXT,
ADD COLUMN     "time_of_day" TEXT NOT NULL DEFAULT '07:00',
ADD COLUMN     "timezone" TEXT NOT NULL DEFAULT 'UTC';


-- Schedules made before this keep sending exactly when they did: weekly ones on Monday, monthly ones on the 1st,
-- at 07:00 UTC.
UPDATE "report_schedules" SET "days_of_week" = ARRAY[1] WHERE "frequency" = 'weekly';
UPDATE "report_schedules" SET "day_of_month" = 1 WHERE "frequency" = 'monthly';
