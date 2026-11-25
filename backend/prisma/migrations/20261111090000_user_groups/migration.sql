-- CreateTable
CREATE TABLE "user_groups" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_group_members" (
    "group_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "added_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_group_members_pkey" PRIMARY KEY ("group_id","user_id")
);

-- CreateTable
CREATE TABLE "user_group_permissions" (
    "group_id" UUID NOT NULL,
    "permission_key" TEXT NOT NULL,

    CONSTRAINT "user_group_permissions_pkey" PRIMARY KEY ("group_id","permission_key")
);

-- CreateTable
CREATE TABLE "user_group_scope" (
    "group_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "target_id" UUID NOT NULL,

    CONSTRAINT "user_group_scope_pkey" PRIMARY KEY ("group_id","kind","target_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_groups_organization_id_name_key" ON "user_groups"("organization_id", "name");

-- CreateIndex
CREATE INDEX "user_group_members_user_id_idx" ON "user_group_members"("user_id");

-- AddForeignKey
ALTER TABLE "user_groups" ADD CONSTRAINT "user_groups_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "user_group_members" ADD CONSTRAINT "user_group_members_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "user_groups"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "user_group_members" ADD CONSTRAINT "user_group_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "user_group_permissions" ADD CONSTRAINT "user_group_permissions_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "user_groups"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "user_group_permissions" ADD CONSTRAINT "user_group_permissions_permission_key_fkey" FOREIGN KEY ("permission_key") REFERENCES "permissions"("permission_key") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "user_group_scope" ADD CONSTRAINT "user_group_scope_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "user_groups"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "user_group_scope" ADD CONSTRAINT "user_group_scope_kind_check" CHECK ("kind" IN ('customer','site','tag'));
