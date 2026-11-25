-- Network discovery: what a managed device (the scanner) found on its own network, and the scans that found it.
-- discovered_hosts holds one row per host and site: host_key is the MAC address when it was seen, otherwise "ip:<address>". A host that
-- turns out to be a managed device is linked to it (device_id). ignored hides a host that is known and not wanted in the list.
-- network_discovery_runs is one scan: who scanned (a device), which job did it, what came of it.
CREATE TABLE IF NOT EXISTS network_discovery_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id           uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  scanner_device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  scanner_name      text,
  job_id            uuid,
  requested_by      uuid,
  requested_at      timestamptz NOT NULL DEFAULT now(),
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed')),
  finished_at       timestamptz,
  ranges            text[] NOT NULL DEFAULT '{}',
  hosts_found       integer NOT NULL DEFAULT 0,
  new_hosts         integer NOT NULL DEFAULT 0,
  seconds           integer,
  message           text
);
CREATE INDEX IF NOT EXISTS network_discovery_runs_site_idx ON network_discovery_runs (site_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS network_discovery_runs_pending_idx ON network_discovery_runs (requested_at) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS discovered_hosts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id     uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  host_key    text NOT NULL,
  ip          text NOT NULL,
  mac         text,
  hostname    text,
  vendor      text,
  kind        text NOT NULL DEFAULT 'unknown',
  ports       integer[] NOT NULL DEFAULT '{}',
  first_seen  timestamptz NOT NULL DEFAULT now(),
  last_seen   timestamptz NOT NULL DEFAULT now(),
  seen_runs   integer NOT NULL DEFAULT 1,
  device_id   uuid REFERENCES devices(id) ON DELETE SET NULL,
  ignored     boolean NOT NULL DEFAULT false,
  last_run_id uuid,
  UNIQUE (site_id, host_key)
);
CREATE INDEX IF NOT EXISTS discovered_hosts_site_idx ON discovered_hosts (site_id, last_seen DESC);
CREATE INDEX IF NOT EXISTS discovered_hosts_device_idx ON discovered_hosts (device_id) WHERE device_id IS NOT NULL;
