-- The client portal: a separate website for a customer's own people, served on its own domain.
-- They sign in with their own accounts (never staff accounts) and see only their own company.

CREATE TABLE IF NOT EXISTS portal_settings (
  organization_id     uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  enabled             boolean NOT NULL DEFAULT false,
  -- The address the portal answers on, e.g. portal.example.com (no scheme, path or port).
  domain              text,
  -- Which areas customers can open: dashboard, tickets, devices, invoices.
  modules             text[] NOT NULL DEFAULT ARRAY['dashboard','tickets','devices','invoices']::text[],
  allow_ticket_create boolean NOT NULL DEFAULT true,
  welcome_title       text NOT NULL DEFAULT '',
  welcome_text        text NOT NULL DEFAULT '',
  support_email       text NOT NULL DEFAULT '',
  support_phone       text NOT NULL DEFAULT '',
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS portal_settings_domain_uq ON portal_settings (lower(domain)) WHERE domain IS NOT NULL;

-- One sign-in per person. A person belongs to exactly one customer.
CREATE TABLE IF NOT EXISTS portal_accounts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  client_id       uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  contact_id      uuid REFERENCES customer_contacts(id) ON DELETE SET NULL,
  email           citext NOT NULL,
  name            text NOT NULL,
  -- user: sees the tickets they opened. manager: sees everything the customer has (tickets, devices, invoices).
  role            text NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'manager')),
  status          text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active', 'disabled')),
  password_hash   text,
  failed_logins   integer NOT NULL DEFAULT 0,
  locked_until    timestamptz,
  last_login_at   timestamptz,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (email)
);
CREATE INDEX IF NOT EXISTS portal_accounts_client_idx ON portal_accounts (client_id);

-- Invitation and password-reset links. Only a hash of the token is kept.
CREATE TABLE IF NOT EXISTS portal_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES portal_accounts(id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('invite', 'reset')),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS portal_tokens_account_idx ON portal_tokens (account_id);

-- Signed-in browsers, so a person can be signed out everywhere and a disabled account stops at once.
CREATE TABLE IF NOT EXISTS portal_sessions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES portal_accounts(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  ip         text,
  user_agent text
);
CREATE INDEX IF NOT EXISTS portal_sessions_account_idx ON portal_sessions (account_id);

-- Tickets belong to a customer, so the portal can show a customer its own. Tickets opened for a device already
-- belong to that device's customer; the rest can be set from the ticket.
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS client_id uuid REFERENCES clients(id) ON DELETE SET NULL;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS portal_account_id uuid REFERENCES portal_accounts(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS tickets_client_idx ON tickets (client_id);

UPDATE tickets t
   SET client_id = s.client_id
  FROM devices d
  JOIN sites s ON s.id = d.site_id
 WHERE t.device_id = d.id AND t.client_id IS NULL;
