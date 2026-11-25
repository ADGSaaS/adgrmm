-- CreateTable
CREATE TABLE "policy_actions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "policy_id" UUID,
    "policy_name" TEXT,
    "kind" TEXT NOT NULL,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "policy_actions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "policy_actions_device_id_kind_created_at_idx" ON "policy_actions"("device_id", "kind", "created_at" DESC);

-- CreateIndex
CREATE INDEX "policy_actions_organization_id_created_at_idx" ON "policy_actions"("organization_id", "created_at" DESC);
