-- Chats are sessions: they start with the first message, can be ended (by the person, a technician, or after a quiet spell), and an ended
-- one keeps a copy of its transcript and records whether it was emailed.
CREATE TABLE IF NOT EXISTS device_chat_sessions (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id               uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  windows_user            text,
  contact_name            text,
  contact_email           text,
  contact_phone           text,
  started_at              timestamptz NOT NULL DEFAULT now(),
  last_message_at         timestamptz NOT NULL DEFAULT now(),
  ended_at                timestamptz,
  ended_by                text CHECK (ended_by IN ('user', 'technician', 'idle', 'earlier')),
  ended_by_name           text,
  transcript              text,
  transcript_emailed_at   timestamptz,
  transcript_email_status text
);
CREATE UNIQUE INDEX IF NOT EXISTS device_chat_one_open_idx ON device_chat_sessions (device_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS device_chat_sessions_device_idx ON device_chat_sessions (device_id, started_at DESC);

ALTER TABLE device_chat_messages ADD COLUMN IF NOT EXISTS session_id uuid REFERENCES device_chat_sessions(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS device_chat_messages_session_idx ON device_chat_messages (session_id, created_at);

-- Messages from before sessions existed: one ended session per computer that holds them.
WITH old AS (
  SELECT device_id, min(created_at) AS first_at, max(created_at) AS last_at FROM device_chat_messages WHERE session_id IS NULL GROUP BY device_id
), made AS (
  INSERT INTO device_chat_sessions (device_id, started_at, last_message_at, ended_at, ended_by, transcript_email_status)
  SELECT device_id, first_at, last_at, last_at, 'earlier', 'no_email' FROM old RETURNING id, device_id
)
UPDATE device_chat_messages m SET session_id = made.id FROM made WHERE m.device_id = made.device_id AND m.session_id IS NULL;
