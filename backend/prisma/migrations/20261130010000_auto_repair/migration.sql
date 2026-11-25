-- Automatic repair of problems reported from the tray app: the switches, every run (diagnose, repair, verify) with where it stands, and the one
-- KB article each kind of problem gets.
CREATE TABLE IF NOT EXISTS auto_repair_settings (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  enabled         boolean NOT NULL DEFAULT false,
  auto_repair     boolean NOT NULL DEFAULT true,
  create_kb       boolean NOT NULL DEFAULT true,
  updated_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS auto_repair_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  ticket_id       uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  device_id       uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  category        text,
  app_name        text,
  checks          text[] NOT NULL DEFAULT '{}',
  state           text NOT NULL DEFAULT 'diagnosing' CHECK (state IN ('diagnosing', 'repairing', 'verifying', 'awaiting_user', 'confirmed_fixed', 'not_fixed', 'needs_technician', 'no_issue_found')),
  diag_job_id     uuid,
  repair_job_id   uuid,
  verify_job_id   uuid,
  repair_issues   text[] NOT NULL DEFAULT '{}',
  diagnosis       jsonb,
  repairs         jsonb,
  outcome         text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz
);
CREATE INDEX IF NOT EXISTS auto_repair_runs_ticket_idx ON auto_repair_runs (ticket_id, created_at DESC);
CREATE INDEX IF NOT EXISTS auto_repair_runs_device_idx ON auto_repair_runs (device_id, created_at DESC);
CREATE INDEX IF NOT EXISTS auto_repair_runs_active_idx ON auto_repair_runs (state) WHERE state IN ('diagnosing', 'repairing', 'verifying');

-- One row per kind of problem: the claim on writing its KB article, which is what keeps it from ever being written twice.
CREATE TABLE IF NOT EXISTS auto_repair_kb (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  issue_id        text NOT NULL,
  article_id      uuid,
  seen_count      integer NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, issue_id)
);

ALTER TABLE tray_help_requests
  ADD COLUMN IF NOT EXISTS category      text,
  ADD COLUMN IF NOT EXISTS app_name      text,
  ADD COLUMN IF NOT EXISTS app_publisher text,
  ADD COLUMN IF NOT EXISTS app_version   text;
