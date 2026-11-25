-- CreateTable
CREATE TABLE "policies" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "os" TEXT NOT NULL DEFAULT 'any',
    "enforced" BOOLEAN NOT NULL DEFAULT false,
    "sections" JSONB NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policy_assignments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "policy_id" UUID NOT NULL,
    "level" TEXT NOT NULL,
    "target_id" UUID,
    "exclude" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "policy_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policy_audit" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "policy_id" UUID,
    "policy_name" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actor_id" UUID,
    "actor_name" TEXT,
    "version" INTEGER,
    "before" JSONB,
    "after" JSONB,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "policy_audit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "policies_organization_id_name_key" ON "policies"("organization_id", "name");

-- CreateIndex
CREATE INDEX "policy_assignments_policy_id_idx" ON "policy_assignments"("policy_id");

-- CreateIndex
CREATE INDEX "policy_assignments_level_target_id_idx" ON "policy_assignments"("level", "target_id");

-- CreateIndex
CREATE INDEX "policy_audit_policy_id_at_idx" ON "policy_audit"("policy_id", "at" DESC);

-- CreateIndex
CREATE INDEX "policy_audit_organization_id_at_idx" ON "policy_audit"("organization_id", "at" DESC);

-- AddForeignKey
ALTER TABLE "policies" ADD CONSTRAINT "policies_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "policy_assignments" ADD CONSTRAINT "policy_assignments_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "policies"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
