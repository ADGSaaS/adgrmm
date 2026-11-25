-- Scheduled network discovery: one optional schedule per customer site. The server starts a scan from an online Windows or Linux device
-- of the site every interval_hours, and (alert_new) raises an alert for each host that is new, not a managed device and not ignored.
-- The first successful scan of a site is a baseline: it raises nothing, so switching this on does not alert about the whole network.
-- scanner_device_id is a preferred device; when it is offline the server uses any other online Windows or Linux device of the site.
-- last_requested_at is when a scan was last started for this schedule; last_message says why a scan could not be started.
CREATE TABLE IF NOT EXISTS network_discovery_schedules (
  site_id           uuid PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
  enabled           boolean NOT NULL DEFAULT true,
  interval_hours    integer NOT NULL DEFAULT 24 CHECK (interval_hours BETWEEN 1 AND 168),
  ranges            text[] NOT NULL DEFAULT '{}',
  scanner_device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  alert_new         boolean NOT NULL DEFAULT true,
  created_by        uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  last_requested_at timestamptz,
  last_message      text
);
CREATE INDEX IF NOT EXISTS network_discovery_schedules_due_idx ON network_discovery_schedules (last_requested_at) WHERE enabled;
