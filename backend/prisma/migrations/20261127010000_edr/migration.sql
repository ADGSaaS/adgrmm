-- EDR and antivirus consoles (Microsoft Defender for Endpoint, SentinelOne, Huntress, CrowdStrike): the connection, and the endpoints each one
-- reports, matched to RemoteIQ's devices. Read-only toward the console.
CREATE TABLE IF NOT EXISTS edr_connections (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  client_id       uuid REFERENCES clients(id) ON DELETE CASCADE,
  vendor          text NOT NULL CHECK (vendor IN ('mde', 'sentinelone', 'huntress', 'crowdstrike')),
  name            text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  config          jsonb NOT NULL DEFAULT '{}'::jsonb,
  secret_enc      text NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ok', 'error')),
  last_error      text,
  last_synced_at  timestamptz,
  requested_at    timestamptz,
  endpoint_count  integer NOT NULL DEFAULT 0,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS edr_connections_name_idx ON edr_connections (organization_id, lower(name));

CREATE TABLE IF NOT EXISTS edr_endpoints (
  connection_id  uuid NOT NULL REFERENCES edr_connections(id) ON DELETE CASCADE,
  vendor_id      text NOT NULL,
  hostname       text NOT NULL,
  serial         text,
  os             text,
  agent_version  text,
  last_seen_at   timestamptz,
  health         text NOT NULL CHECK (health IN ('healthy', 'warning', 'unhealthy', 'unknown')),
  health_detail  text,
  threats        integer,
  device_id      uuid REFERENCES devices(id) ON DELETE SET NULL,
  PRIMARY KEY (connection_id, vendor_id)
);
CREATE INDEX IF NOT EXISTS edr_endpoints_device_idx ON edr_endpoints (device_id);
