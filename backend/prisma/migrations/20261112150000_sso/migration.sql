-- Single sign-on (OpenID Connect): who the identity provider is, how people are matched to accounts, and the
-- short-lived state of a sign-in in progress.
CREATE TABLE IF NOT EXISTS sso_config (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  enabled         boolean NOT NULL DEFAULT false,
  display_name    text NOT NULL DEFAULT 'Single sign-on',
  issuer          text NOT NULL DEFAULT '',
  client_id       text NOT NULL DEFAULT '',
  client_secret   text,
  scopes          text NOT NULL DEFAULT 'openid email profile',
  -- Create an account at the first sign-in when none matches the email, with default_role_id.
  jit_enabled     boolean NOT NULL DEFAULT false,
  default_role_id uuid REFERENCES roles(id) ON DELETE SET NULL,
  -- Only these email domains may sign in this way (comma separated). Empty means any.
  allowed_domains text NOT NULL DEFAULT '',
  -- When false, passwords stop working for everyone except Owners (so a broken identity provider never locks everyone out).
  password_login  boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Which identity-provider account belongs to which user. Later sign-ins match on this, not on the email,
-- so a changed or reused email address cannot take over someone else's account.
CREATE TABLE IF NOT EXISTS sso_identities (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  issuer          text NOT NULL,
  subject         text NOT NULL,
  email           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_login_at   timestamptz,
  UNIQUE (issuer, subject),
  UNIQUE (user_id, issuer)
);

CREATE TABLE IF NOT EXISTS sso_login_states (
  state           text PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  nonce           text NOT NULL,
  code_verifier   text NOT NULL,
  return_to       text,
  expires_at      timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS sso_login_states_expires_idx ON sso_login_states (expires_at);
