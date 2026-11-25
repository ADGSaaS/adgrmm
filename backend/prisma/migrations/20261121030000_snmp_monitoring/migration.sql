-- SNMP monitoring of network devices that have no agent (printers, switches, anything that answers SNMP v1/v2c): a managed Windows or
-- Linux device of the same site (the poller) asks them through a fixed signed job.
-- snmp_devices is one monitored device per site and address. community_enc is the community string, encrypted with the data key (never
-- returned by the API). data holds the last answer (supplies, printer state, interfaces). asset_provider/asset_ref are a provider-neutral
-- link to an asset record: they say where the asset lives (the built-in asset manager, or another one) and are never required.
-- snmp_polls is one poll job for the devices of a site; snmp_samples is a thin history (reachability, uptime, page count, lowest supply).
CREATE TABLE IF NOT EXISTS snmp_devices (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id           uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  ip                text NOT NULL,
  port              integer NOT NULL DEFAULT 161 CHECK (port BETWEEN 1 AND 65535),
  name              text,
  community_enc     text NOT NULL,
  kind              text NOT NULL DEFAULT 'auto' CHECK (kind IN ('auto', 'printer', 'switch', 'other')),
  poll_minutes      integer NOT NULL DEFAULT 15 CHECK (poll_minutes IN (5, 15, 30, 60)),
  enabled           boolean NOT NULL DEFAULT true,
  alert_enabled     boolean NOT NULL DEFAULT true,
  poller_device_id  uuid REFERENCES devices(id) ON DELETE SET NULL,
  asset_provider    text,
  asset_ref         text,
  created_by        uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  last_polled_at    timestamptz,
  last_ok_at        timestamptz,
  fail_count        integer NOT NULL DEFAULT 0,
  status            text NOT NULL DEFAULT 'unknown' CHECK (status IN ('unknown', 'ok', 'unreachable')),
  last_error        text,
  sys_name          text,
  sys_descr         text,
  sys_location      text,
  uptime_seconds    bigint,
  detected_kind     text,
  data              jsonb NOT NULL DEFAULT '{}'::jsonb,
  pending_poll_id   uuid,
  UNIQUE (site_id, ip)
);
CREATE INDEX IF NOT EXISTS snmp_devices_site_idx ON snmp_devices (site_id);
CREATE INDEX IF NOT EXISTS snmp_devices_due_idx ON snmp_devices (last_polled_at) WHERE enabled;

CREATE TABLE IF NOT EXISTS snmp_polls (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id          uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  job_id           uuid,
  poller_device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  poller_name      text,
  device_ids       uuid[] NOT NULL DEFAULT '{}',
  requested_at     timestamptz NOT NULL DEFAULT now(),
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed')),
  finished_at      timestamptz,
  seconds          integer,
  message          text
);
CREATE INDEX IF NOT EXISTS snmp_polls_pending_idx ON snmp_polls (requested_at) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS snmp_samples (
  device_id        uuid NOT NULL REFERENCES snmp_devices(id) ON DELETE CASCADE,
  at               timestamptz NOT NULL DEFAULT now(),
  ok               boolean NOT NULL,
  uptime_seconds   bigint,
  pages            bigint,
  min_supply_pct   integer,
  PRIMARY KEY (device_id, at)
);
