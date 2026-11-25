-- Health of the RemoteIQ servers themselves (database, disk, memory, backups, restore tests) with the history of every change of state.
CREATE TABLE IF NOT EXISTS system_health_state (
  check_key   text PRIMARY KEY,
  status      text NOT NULL CHECK (status IN ('ok', 'warn', 'critical')),
  detail      text NOT NULL DEFAULT '',
  since       timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  notified    text
);
CREATE TABLE IF NOT EXISTS system_health_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  check_key   text NOT NULL,
  from_status text,
  to_status   text NOT NULL,
  detail      text NOT NULL DEFAULT '',
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS system_health_events_at_idx ON system_health_events (at DESC);
