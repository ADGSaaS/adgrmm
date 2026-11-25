-- One row for every attempt to change a Windows device's registry from the Registry tab (ok, refused or failed), with what the
-- value was before and after, so the change can be shown in "Recent changes" and undone. Data is kept as the reader renders it
-- (text, a list of text, decimal digits for numbers, hex for binary); values whose name looks like a secret are never recorded.
-- The audit trail gets the same event WITHOUT any data.
CREATE TABLE IF NOT EXISTS device_registry_changes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  device_id       uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  user_id         uuid REFERENCES users(id) ON DELETE SET NULL,
  user_name       text,
  at              timestamptz NOT NULL DEFAULT now(),
  action          text NOT NULL CHECK (action IN ('set', 'delete-value', 'create-key', 'delete-key')),
  hive            text NOT NULL CHECK (hive IN ('HKLM', 'HKU')),
  view            text NOT NULL DEFAULT '64' CHECK (view IN ('64', '32')),
  path            text NOT NULL,
  value_name      text,
  old_type        text,
  old_data        jsonb,
  new_type        text,
  new_data        jsonb,
  outcome         text NOT NULL DEFAULT 'pending' CHECK (outcome IN ('pending', 'ok', 'refused', 'failed')),
  error           text,
  job_id          uuid,
  undone_at       timestamptz,
  undone_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  undo_of         uuid REFERENCES device_registry_changes(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS device_registry_changes_device_at_idx ON device_registry_changes (device_id, at DESC);
CREATE INDEX IF NOT EXISTS device_registry_changes_org_at_idx ON device_registry_changes (organization_id, at DESC);
CREATE INDEX IF NOT EXISTS device_registry_changes_job_idx ON device_registry_changes (job_id) WHERE job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS device_registry_changes_pending_idx ON device_registry_changes (device_id) WHERE outcome = 'pending';
