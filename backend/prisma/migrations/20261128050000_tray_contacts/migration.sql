-- Who is at the computer: the name, email and phone a person gave in the tray when they submitted a ticket or chatted.
CREATE TABLE IF NOT EXISTS tray_contacts (
  device_id    uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  windows_user text NOT NULL,
  name         text,
  email        text,
  phone        text,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, windows_user)
);
ALTER TABLE tray_help_requests ADD COLUMN IF NOT EXISTS requester_name text, ADD COLUMN IF NOT EXISTS requester_phone text;
