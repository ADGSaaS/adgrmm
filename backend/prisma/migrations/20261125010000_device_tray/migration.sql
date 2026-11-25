-- The tray app on a device: what an administrator switched on, and the chat between the person at the device and the technicians.
CREATE TABLE IF NOT EXISTS tray_settings (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  enabled         boolean NOT NULL DEFAULT false,
  help_enabled    boolean NOT NULL DEFAULT true,
  chat_enabled    boolean NOT NULL DEFAULT true,
  support_phone   text,
  support_email   text,
  greeting        text,
  updated_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS device_chat_messages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id        uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  direction        text NOT NULL CHECK (direction IN ('device', 'tech')),
  sender           text NOT NULL CHECK (length(sender) BETWEEN 1 AND 120),
  user_id          uuid REFERENCES users(id) ON DELETE SET NULL,
  body             text NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  created_at       timestamptz NOT NULL DEFAULT now(),
  delivered_at     timestamptz,
  read_by_tech_at  timestamptz
);
CREATE INDEX IF NOT EXISTS device_chat_device_idx ON device_chat_messages (device_id, created_at DESC);
CREATE INDEX IF NOT EXISTS device_chat_unread_idx ON device_chat_messages (device_id) WHERE direction = 'device' AND read_by_tech_at IS NULL;

-- A help request is a ticket; this keeps which tickets came from the tray, so the tray shows only those to the person at the device
-- (never the technicians' other tickets about the device) and so one device cannot make tickets without end.
CREATE TABLE IF NOT EXISTS tray_help_requests (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id  uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  ticket_id  uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  requester  text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tray_help_device_idx ON tray_help_requests (device_id, created_at DESC);
