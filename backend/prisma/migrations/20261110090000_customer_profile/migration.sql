-- AlterTable
ALTER TABLE "clients"
  ADD COLUMN "status" TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN "legal_name" TEXT,
  ADD COLUMN "industry" TEXT,
  ADD COLUMN "website" TEXT,
  ADD COLUMN "phone" TEXT,
  ADD COLUMN "email" TEXT,
  ADD COLUMN "billing_email" TEXT,
  ADD COLUMN "tax_id" TEXT,
  ADD COLUMN "time_zone" TEXT,
  ADD COLUMN "currency" TEXT,
  ADD COLUMN "payment_terms" TEXT,
  ADD COLUMN "employee_count" INTEGER,
  ADD COLUMN "customer_since" DATE,
  ADD COLUMN "address" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "billing_address" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "billing_same_as_address" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "notes" TEXT,
  ADD COLUMN "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "customer_contacts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "client_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "job_title" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "mobile" TEXT,
    "role" TEXT NOT NULL DEFAULT 'other',
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customer_contacts_client_id_idx" ON "customer_contacts"("client_id");

-- AddForeignKey
ALTER TABLE "customer_contacts" ADD CONSTRAINT "customer_contacts_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
