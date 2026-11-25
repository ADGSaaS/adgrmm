-- Security policies (Administration > Security Policies) and agent defaults (Administration > Agents & Endpoints).
-- One row per organization each. The defaults keep today's behaviour: nothing new is enforced until an administrator turns it on.
CREATE TABLE IF NOT EXISTS security_policies (
  organization_id        uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  -- Passwords for staff accounts.
  password_min_length    integer NOT NULL DEFAULT 8,
  password_require_numbers   boolean NOT NULL DEFAULT false,
  password_require_special   boolean NOT NULL DEFAULT false,
  password_require_uppercase boolean NOT NULL DEFAULT false,
  -- How many of a person's latest passwords cannot be used again (0 = no rule).
  password_history       integer NOT NULL DEFAULT 0,
  -- Minutes a sign-in may last, and minutes of no use before it ends (0 = no limit).
  session_timeout_mins   integer NOT NULL DEFAULT 0,
  idle_timeout_mins      integer NOT NULL DEFAULT 0,
  -- One address or CIDR range per line. Empty means any address may sign in.
  ip_allowlist           text NOT NULL DEFAULT '',
  -- Cloudflare Turnstile on the staff sign-in page. The secret is stored encrypted.
  captcha_enabled        boolean NOT NULL DEFAULT false,
  turnstile_site_key     text NOT NULL DEFAULT '',
  turnstile_secret       text,
  updated_at             timestamptz NOT NULL DEFAULT now(),
  updated_by             uuid REFERENCES users(id) ON DELETE SET NULL
);

-- Hashes of earlier passwords, so the history rule can refuse a reused one.
CREATE TABLE IF NOT EXISTS password_history (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  password_hash  text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS password_history_user_idx ON password_history (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_settings (
  organization_id          uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  -- How long a new install key lasts when the person creating it does not say (minutes).
  install_key_expiry_mins  integer NOT NULL DEFAULT 10080,
  -- When off, agents are told there is no update, whatever package is on the server.
  auto_update              boolean NOT NULL DEFAULT true,
  updated_at               timestamptz NOT NULL DEFAULT now(),
  updated_by               uuid REFERENCES users(id) ON DELETE SET NULL
);
