-- Why an agent update failed after the agent accepted it: the agent reports the outcome its updater wrote (rolled back, could not roll back, failed
-- verification) with the next update check, and the row goes away once the agent runs that version or newer.
CREATE TABLE IF NOT EXISTS agent_update_failures (
  agent_id          uuid PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  version           text NOT NULL,
  outcome           text NOT NULL CHECK (outcome IN ('rolled_back', 'rollback_failed', 'failed')),
  detail            text NOT NULL DEFAULT '',
  first_reported_at timestamptz NOT NULL DEFAULT now(),
  reported_at       timestamptz NOT NULL DEFAULT now()
);
