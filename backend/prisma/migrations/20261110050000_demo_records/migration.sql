-- CreateTable
CREATE TABLE "demo_records" (
    "table_name" TEXT NOT NULL,
    "record_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "demo_records_pkey" PRIMARY KEY ("table_name","record_id")
);
