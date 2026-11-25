-- Third-party software patching: the outdated programs each device reported, when it was last scanned, and the
-- allow / never-update lists that decide what policies may update on their own.
ALTER TYPE "agent_task_type" ADD VALUE IF NOT EXISTS 'software_updates_scan';

CREATE TABLE "agent_outdated_software" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "agent_id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "app_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "installed_version" TEXT,
    "available_version" TEXT NOT NULL,
    "approximate" BOOLEAN NOT NULL DEFAULT false,
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "scanned_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_outdated_software_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "agent_outdated_software_agent_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE NO ACTION
);
CREATE UNIQUE INDEX "agent_outdated_software_uq" ON "agent_outdated_software"("agent_id", "source", "app_id");
CREATE INDEX "agent_outdated_software_app_idx" ON "agent_outdated_software"(lower("app_id"), "source");

CREATE TABLE "agent_software_scans" (
    "agent_id" UUID NOT NULL,
    "attempted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "scanned_at" TIMESTAMPTZ(6),
    "ok" BOOLEAN NOT NULL DEFAULT false,
    "winget_state" TEXT,
    "choco_state" TEXT,
    "message" TEXT,
    "app_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "agent_software_scans_pkey" PRIMARY KEY ("agent_id"),
    CONSTRAINT "agent_software_scans_agent_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE TABLE "software_update_rules" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "client_id" UUID,
    "source" TEXT NOT NULL DEFAULT 'winget',
    "app_id" TEXT NOT NULL,
    "app_name" TEXT,
    "rule" TEXT NOT NULL,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "software_update_rules_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "software_update_rules_rule_check" CHECK ("rule" IN ('allow', 'block')),
    CONSTRAINT "software_update_rules_client_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE NO ACTION
);
-- one rule per app and place (the whole organisation, or one customer)
CREATE UNIQUE INDEX "software_update_rules_uq" ON "software_update_rules"("organization_id", COALESCE("client_id", '00000000-0000-0000-0000-000000000000'::uuid), "source", lower("app_id"));
CREATE INDEX "software_update_rules_org_idx" ON "software_update_rules"("organization_id", "rule");
