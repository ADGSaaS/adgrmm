-- Workflow rules: "when this happens, do that". A rule has one trigger, conditions that must all hold, and up to four actions.
CREATE TABLE IF NOT EXISTS workflow_rules (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name             text NOT NULL,
  enabled          boolean NOT NULL DEFAULT false,
  trigger          text NOT NULL CHECK (trigger IN ('alert.opened', 'device.registered', 'ticket.created')),
  conditions       jsonb NOT NULL DEFAULT '[]',
  actions          jsonb NOT NULL DEFAULT '[]',
  cooldown_minutes integer NOT NULL DEFAULT 60 CHECK (cooldown_minutes BETWEEN 1 AND 10080),
  created_by       uuid,
  run_count        integer NOT NULL DEFAULT 0,
  last_run_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workflow_rules_trigger_idx ON workflow_rules (trigger) WHERE enabled;

CREATE TABLE IF NOT EXISTS workflow_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id     uuid NOT NULL REFERENCES workflow_rules(id) ON DELETE CASCADE,
  trigger     text NOT NULL,
  subject     text NOT NULL,          -- the device or ticket it was about
  outcome     text NOT NULL CHECK (outcome IN ('done', 'failed', 'partial', 'skipped')),
  detail      text NOT NULL DEFAULT '',
  steps       jsonb NOT NULL DEFAULT '[]',
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workflow_runs_rule_idx ON workflow_runs (rule_id, at DESC);
CREATE INDEX IF NOT EXISTS workflow_runs_at_idx ON workflow_runs (at DESC);
