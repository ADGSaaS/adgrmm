-- A policy kept as a pattern, to be copied to a global, customer, site or tag policy.
CREATE TABLE "policy_templates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "os" TEXT NOT NULL DEFAULT 'any',
    "enforced" BOOLEAN NOT NULL DEFAULT false,
    "sections" JSONB NOT NULL DEFAULT '{}',
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "policy_templates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "policy_templates_organization_id_name_key" ON "policy_templates"("organization_id", "name");

ALTER TABLE "policy_templates" ADD CONSTRAINT "policy_templates_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
