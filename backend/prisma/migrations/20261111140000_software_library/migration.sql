-- The software library, installs through the agent, and user-installed programs in the inventory.
ALTER TYPE "agent_task_type" ADD VALUE IF NOT EXISTS 'software_install';

ALTER TABLE "agent_software" ADD COLUMN "scope" TEXT NOT NULL DEFAULT 'machine';
ALTER TABLE "agent_software" ADD COLUMN "installed_user" TEXT;
ALTER TABLE "agent_software" ADD COLUMN "installed_by" TEXT;

CREATE TABLE "software_library" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'Other',
    "match_text" TEXT NOT NULL,
    "publisher" TEXT,
    "chocolatey_id" TEXT,
    "winget_id" TEXT,
    "installer_url" TEXT,
    "installer_sha256" TEXT,
    "installer_kind" TEXT,
    "silent_args" TEXT,
    "linux_package" TEXT,
    "notes" TEXT,
    "built_in" BOOLEAN NOT NULL DEFAULT false,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "software_library_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "software_library_organization_id_name_key" ON "software_library"("organization_id", "name");
ALTER TABLE "software_library" ADD CONSTRAINT "software_library_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- The new right to install and remove software. Administrators get it; operators and viewers do not unless a role is edited.
INSERT INTO permissions (permission_key, label, group_key, group_label)
VALUES ('software.install', 'Install and remove software on devices', 'software', 'Software')
ON CONFLICT (permission_key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, 'software.install' FROM roles r WHERE lower(r.name) = 'admin'
ON CONFLICT DO NOTHING;
