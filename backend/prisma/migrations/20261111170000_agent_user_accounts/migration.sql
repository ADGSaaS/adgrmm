-- The accounts a device has (and whether they are signed in), reported with the software inventory.
CREATE TABLE "agent_user_accounts" (
    "agent_id" UUID NOT NULL,
    "account" TEXT NOT NULL,
    "logged_in" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_user_accounts_pkey" PRIMARY KEY ("agent_id","account")
);

ALTER TABLE "agent_user_accounts" ADD CONSTRAINT "agent_user_accounts_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
