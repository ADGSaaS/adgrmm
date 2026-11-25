-- How each remote console session reached the computer (directly or through the relay) and how much video came through it, as the technician's browser reports it.
CREATE TABLE IF NOT EXISTS remote_session_transport (
  session_id     text PRIMARY KEY,
  user_id        uuid,
  relay          boolean NOT NULL,
  bytes_received bigint NOT NULL DEFAULT 0,
  started_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS remote_session_transport_started_idx ON remote_session_transport (started_at DESC);
