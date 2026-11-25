-- Microsoft 365 tenants of customers, read through Microsoft Graph with an app the customer (or the MSP) registered. Read-only.
CREATE TABLE IF NOT EXISTS m365_tenants (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  client_id         uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  tenant            text NOT NULL CHECK (length(tenant) BETWEEN 3 AND 253),
  app_id            text NOT NULL CHECK (length(app_id) BETWEEN 8 AND 64),
  secret_enc        text NOT NULL,
  name              text,
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ok', 'partial', 'error')),
  last_error        text,
  last_synced_at    timestamptz,
  requested_at      timestamptz,
  summary           jsonb,
  created_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS m365_tenants_tenant_idx ON m365_tenants (organization_id, lower(tenant));
CREATE INDEX IF NOT EXISTS m365_tenants_client_idx ON m365_tenants (client_id);
