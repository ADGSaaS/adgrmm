-- Remote session recording (roadmap 1.26). Recorded in the technician's browser and uploaded in pieces; the
-- pieces are encrypted on the server's disk. A customer opts in (off by default); no row can exist for a session
-- that was started while recording was off.

ALTER TABLE clients ADD COLUMN IF NOT EXISTS record_remote_sessions boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS remote_recording_settings (
  organization_id  uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  retention_days   integer NOT NULL DEFAULT 90 CHECK (retention_days BETWEEN 1 AND 3650),
  max_recording_mb integer NOT NULL DEFAULT 2048 CHECK (max_recording_mb BETWEEN 10 AND 20480),
  quota_gb         integer NOT NULL DEFAULT 50 CHECK (quota_gb BETWEEN 1 AND 10240),
  updated_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS remote_session_recordings (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  session_id        uuid NOT NULL UNIQUE,
  device_id         uuid REFERENCES devices(id) ON DELETE SET NULL,
  device_name       text,
  client_id         uuid REFERENCES clients(id) ON DELETE SET NULL,
  client_name       text,
  technician_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  technician_name   text,
  status            text NOT NULL DEFAULT 'recording' CHECK (status IN ('recording', 'complete', 'interrupted', 'failed')),
  mime_type         text NOT NULL DEFAULT 'video/webm',
  started_at        timestamptz NOT NULL DEFAULT now(),
  ended_at          timestamptz,
  last_chunk_at     timestamptz,
  duration_ms       bigint NOT NULL DEFAULT 0,
  size_bytes        bigint NOT NULL DEFAULT 0,
  chunk_count       integer NOT NULL DEFAULT 0,
  notice_mode       text,
  expires_at        timestamptz NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS remote_session_recordings_org_started_idx ON remote_session_recordings (organization_id, started_at DESC);
CREATE INDEX IF NOT EXISTS remote_session_recordings_client_idx ON remote_session_recordings (client_id);
CREATE INDEX IF NOT EXISTS remote_session_recordings_device_idx ON remote_session_recordings (device_id);
CREATE INDEX IF NOT EXISTS remote_session_recordings_expires_idx ON remote_session_recordings (expires_at);
CREATE INDEX IF NOT EXISTS remote_session_recordings_open_idx ON remote_session_recordings (status) WHERE status = 'recording';

INSERT INTO permissions (permission_key, label, group_key, group_label) VALUES
  ('recordings.read', 'View and download session recordings', 'recordings', 'Session recordings'),
  ('recordings.delete', 'Delete session recordings and set how long they are kept', 'recordings', 'Session recordings')
ON CONFLICT (permission_key) DO NOTHING;

-- Recordings show what was on a customer's screen, so only managers (admin) get them. Owner holds everything by rule.
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, p.k FROM roles r CROSS JOIN (VALUES ('recordings.read'), ('recordings.delete')) AS p(k)
WHERE lower(r.name) = 'admin'
ON CONFLICT DO NOTHING;
