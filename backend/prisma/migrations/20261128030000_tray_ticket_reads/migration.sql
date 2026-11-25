-- Which replies on a ticket the person at a device has seen in the tray.
CREATE TABLE IF NOT EXISTS tray_ticket_reads (
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  read_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, ticket_id)
);
