-- Domain, DNS and certificate monitoring: things on the internet that a customer depends on, checked on a schedule.
--   certificate: the TLS certificate a server shows (days left, trusted chain, right name)
--   domain:      when the registration of a domain runs out (read from the registry over RDAP)
--   dns:         the records of a name, against what they should be or against what they were
CREATE TABLE IF NOT EXISTS web_monitors (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  client_id       uuid REFERENCES clients(id) ON DELETE SET NULL,
  kind            text NOT NULL CHECK (kind IN ('certificate', 'domain', 'dns')),
  name            text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  host            text NOT NULL CHECK (length(host) BETWEEN 1 AND 253),
  port            integer NOT NULL DEFAULT 443 CHECK (port BETWEEN 1 AND 65535),
  config          jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled         boolean NOT NULL DEFAULT true,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ok', 'warning', 'failed', 'error')),
  detail          text,
  result          jsonb,
  expires_at      timestamptz,
  error_count     integer NOT NULL DEFAULT 0,
  last_checked_at timestamptz,
  next_check_at   timestamptz NOT NULL DEFAULT now(),
  status_since    timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS web_monitors_target_idx ON web_monitors (organization_id, kind, lower(host), port);
CREATE INDEX IF NOT EXISTS web_monitors_due_idx ON web_monitors (next_check_at) WHERE enabled;
CREATE INDEX IF NOT EXISTS web_monitors_client_idx ON web_monitors (client_id);
