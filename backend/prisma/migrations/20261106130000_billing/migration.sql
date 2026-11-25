-- Time, contracts, invoices, quotes and payments. Amounts are whole cents, because fractions of a
-- cent from floating point would eventually show up as totals that do not add up.

CREATE TABLE "billing_settings" (
    "organization_id" UUID NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "tax_rate_bps" INTEGER NOT NULL DEFAULT 0,
    "payment_terms_days" INTEGER NOT NULL DEFAULT 30,
    "invoice_prefix" TEXT NOT NULL DEFAULT 'INV-',
    "next_invoice_number" INTEGER NOT NULL DEFAULT 1001,
    "quote_prefix" TEXT NOT NULL DEFAULT 'QUO-',
    "next_quote_number" INTEGER NOT NULL DEFAULT 1001,
    "labor_cost_cents" INTEGER NOT NULL DEFAULT 0,
    "default_hourly_rate_cents" INTEGER NOT NULL DEFAULT 0,
    "footer" TEXT,
    "public_base_url" TEXT,
    "stripe_secret_key" TEXT,
    "stripe_webhook_secret" TEXT,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "billing_settings_pkey" PRIMARY KEY ("organization_id"),
    CONSTRAINT "billing_settings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "catalog_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "unit_price_cents" INTEGER NOT NULL DEFAULT 0,
    "taxable" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "catalog_items_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "catalog_items_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "catalog_items_organization_id_name_key" ON "catalog_items"("organization_id", "name");

CREATE TABLE "contracts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "billing_interval_months" INTEGER NOT NULL DEFAULT 1,
    "start_date" DATE NOT NULL,
    "end_date" DATE,
    "next_invoice_date" DATE NOT NULL,
    "price_cents" INTEGER NOT NULL DEFAULT 0,
    "quantity" DECIMAL(12,2),
    "block_hours" DECIMAL(10,2),
    "hourly_rate_cents" INTEGER,
    "overage_rate_cents" INTEGER,
    "taxable" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "contracts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "contracts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "contracts_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "contracts_status_next_invoice_date_idx" ON "contracts"("status", "next_invoice_date");
CREATE INDEX "contracts_client_id_idx" ON "contracts"("client_id");

CREATE TABLE "invoices" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "contract_id" UUID,
    "kind" TEXT NOT NULL DEFAULT 'invoice',
    "number" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "tax_rate_bps" INTEGER NOT NULL DEFAULT 0,
    "subtotal_cents" INTEGER NOT NULL DEFAULT 0,
    "tax_cents" INTEGER NOT NULL DEFAULT 0,
    "total_cents" INTEGER NOT NULL DEFAULT 0,
    "paid_cents" INTEGER NOT NULL DEFAULT 0,
    "issue_date" DATE,
    "due_date" DATE,
    "period_start" DATE,
    "period_end" DATE,
    "recipient_email" TEXT,
    "notes" TEXT,
    "public_token_hash" TEXT,
    "converted_from_id" UUID,
    "sent_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "invoices_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "invoices_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "invoices_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "contracts"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "invoices_organization_id_kind_number_key" ON "invoices"("organization_id", "kind", "number");
CREATE UNIQUE INDEX "invoices_public_token_hash_key" ON "invoices"("public_token_hash");
-- The database itself refuses to bill one contract twice for a period, whatever the code does.
CREATE UNIQUE INDEX "invoices_contract_id_period_start_key" ON "invoices"("contract_id", "period_start");
CREATE INDEX "invoices_kind_status_idx" ON "invoices"("kind", "status");
CREATE INDEX "invoices_client_id_idx" ON "invoices"("client_id");

CREATE TABLE "invoice_lines" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "invoice_id" UUID NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(12,2) NOT NULL DEFAULT 1,
    "unit_price_cents" INTEGER NOT NULL DEFAULT 0,
    "amount_cents" INTEGER NOT NULL DEFAULT 0,
    "taxable" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "invoice_lines_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "invoice_lines_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "invoice_lines_invoice_id_idx" ON "invoice_lines"("invoice_id");

CREATE TABLE "payments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "invoice_id" UUID NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "method" TEXT NOT NULL,
    "reference" TEXT,
    "paid_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "recorded_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "payments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "payments_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "payments_invoice_id_idx" ON "payments"("invoice_id");
-- A payment provider can deliver the same event twice, and it must only count once.
CREATE UNIQUE INDEX "payments_method_reference_key" ON "payments"("method", "reference");

CREATE TABLE "time_entries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "client_id" UUID,
    "ticket_id" UUID,
    "work_date" DATE NOT NULL,
    "minutes" INTEGER NOT NULL,
    "billable" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "approved_by" UUID,
    "approved_at" TIMESTAMPTZ(6),
    "invoice_line_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "time_entries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "time_entries_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "time_entries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "time_entries_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "time_entries_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "time_entries_invoice_line_id_fkey" FOREIGN KEY ("invoice_line_id") REFERENCES "invoice_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "time_entries_minutes_positive" CHECK ("minutes" > 0)
);

CREATE INDEX "time_entries_user_id_work_date_idx" ON "time_entries"("user_id", "work_date");
CREATE INDEX "time_entries_client_id_status_idx" ON "time_entries"("client_id", "status");
CREATE INDEX "time_entries_ticket_id_idx" ON "time_entries"("ticket_id");
