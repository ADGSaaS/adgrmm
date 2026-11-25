-- Backup status of customers' computers (not RemoteIQ's own backups): what each device is backed up by, and when it last worked.
-- Read from the device by a signed, read-only script; off until an administrator turns it on.
CREATE TABLE IF NOT EXISTS endpoint_backup_settings (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  enabled         boolean NOT NULL DEFAULT false,
  warn_hours      integer NOT NULL DEFAULT 48 CHECK (warn_hours BETWEEN 1 AND 8760),
  fail_hours      integer NOT NULL DEFAULT 168 CHECK (fail_hours BETWEEN 1 AND 8760),
  check_hours     integer NOT NULL DEFAULT 6 CHECK (check_hours BETWEEN 1 AND 168),
  alerts          boolean NOT NULL DEFAULT true,
  updated_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- one row per device: the latest check and what it came to
CREATE TABLE IF NOT EXISTS endpoint_backup_checks (
  device_id      uuid PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  job_id         uuid,
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed')),
  requested_at   timestamptz NOT NULL DEFAULT now(),
  checked_at     timestamptz,
  message        text,
  overall        text CHECK (overall IN ('ok', 'warning', 'failed', 'unknown', 'none')),
  overall_detail text,
  last_success_at timestamptz
);
CREATE INDEX IF NOT EXISTS endpoint_backup_checks_due_idx ON endpoint_backup_checks (checked_at NULLS FIRST);

-- what the device said, product by product (replaced at every check)
CREATE TABLE IF NOT EXISTS endpoint_backup_products (
  device_id       uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  product         text NOT NULL CHECK (length(product) BETWEEN 1 AND 120),
  kind            text NOT NULL CHECK (kind IN ('image', 'file', 'snapshot', 'cloud', 'agent')),
  state           text NOT NULL CHECK (state IN ('ok', 'warning', 'failed', 'unknown')),
  last_success_at timestamptz,
  last_attempt_at timestamptz,
  detail          text,
  PRIMARY KEY (device_id, product)
);
