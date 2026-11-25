-- Self-healing: a failed monitoring check (an alert) can start the same find, repair and confirm loop as a ticket does, with no ticket needed.
-- Every run now keeps its own log (what a technician reads on the ticket is a copy of it), so runs without a ticket can be followed too.
ALTER TABLE auto_repair_settings ADD COLUMN IF NOT EXISTS self_healing boolean NOT NULL DEFAULT false;

ALTER TABLE auto_repair_runs ALTER COLUMN ticket_id DROP NOT NULL;
ALTER TABLE auto_repair_runs ADD COLUMN IF NOT EXISTS source   text NOT NULL DEFAULT 'ticket';
ALTER TABLE auto_repair_runs ADD COLUMN IF NOT EXISTS alert_id uuid REFERENCES alerts(id) ON DELETE SET NULL;
ALTER TABLE auto_repair_runs DROP CONSTRAINT IF EXISTS auto_repair_runs_source_check;
ALTER TABLE auto_repair_runs ADD CONSTRAINT auto_repair_runs_source_check CHECK (source IN ('ticket', 'alert'));
-- an alert is healed at most once: a second run for the same alert cannot be made
CREATE UNIQUE INDEX IF NOT EXISTS auto_repair_runs_alert_uq ON auto_repair_runs (alert_id) WHERE alert_id IS NOT NULL;

ALTER TABLE auto_repair_runs DROP CONSTRAINT IF EXISTS auto_repair_runs_state_check;
ALTER TABLE auto_repair_runs ADD CONSTRAINT auto_repair_runs_state_check
  CHECK (state IN ('diagnosing', 'repairing', 'verifying', 'awaiting_user', 'confirmed_fixed', 'not_fixed', 'needs_technician', 'no_issue_found', 'healed'));

CREATE TABLE IF NOT EXISTS auto_repair_events (
  id       bigserial PRIMARY KEY,
  run_id   uuid NOT NULL REFERENCES auto_repair_runs(id) ON DELETE CASCADE,
  at       timestamptz NOT NULL DEFAULT now(),
  internal boolean NOT NULL DEFAULT true,
  body     text NOT NULL
);
CREATE INDEX IF NOT EXISTS auto_repair_events_run_idx ON auto_repair_events (run_id, id);
