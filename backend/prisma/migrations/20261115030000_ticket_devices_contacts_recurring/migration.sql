-- Roadmap 3.4, 3.5 and 3.6: devices on a ticket, a customer contact as the person who asked, and recurring tickets.

-- 1. Devices on a ticket: zero or more. tickets.device_id stays as the main one (older screens, the portal and alerts use it).
CREATE TABLE IF NOT EXISTS ticket_devices (
  ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  added_by  text,
  added_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ticket_id, device_id)
);
CREATE INDEX IF NOT EXISTS ticket_devices_device_idx ON ticket_devices (device_id);

INSERT INTO ticket_devices (ticket_id, device_id)
SELECT id, device_id FROM tickets WHERE device_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- Whatever opens a ticket with a device (alerts, the removal approval, email rules, the demo data) gets the link too.
CREATE OR REPLACE FUNCTION ticket_main_device_link() RETURNS trigger AS $$
BEGIN
  IF NEW.device_id IS NOT NULL THEN
    INSERT INTO ticket_devices (ticket_id, device_id, added_by) VALUES (NEW.id, NEW.device_id, 'system') ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tickets_main_device_link ON tickets;
CREATE TRIGGER tickets_main_device_link AFTER INSERT OR UPDATE OF device_id ON tickets
  FOR EACH ROW EXECUTE FUNCTION ticket_main_device_link();

-- 2. The person who asked, as one of the customer's own contacts (the customer record's contact list).
--    requester_contact_id keeps pointing at the mailbox's address book entries.
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS requester_customer_contact_id uuid REFERENCES customer_contacts(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS tickets_requester_customer_contact_idx ON tickets (requester_customer_contact_id) WHERE requester_customer_contact_id IS NOT NULL;

-- 3. Recurring tickets: a ticket made from a template on a schedule.
CREATE TABLE IF NOT EXISTS recurring_tickets (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name             text NOT NULL,
  template_id      uuid REFERENCES ticket_templates(id) ON DELETE SET NULL,
  subject          text,
  description      text,
  priority         text,
  client_id        uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  site_id          uuid REFERENCES sites(id) ON DELETE SET NULL,
  device_id        uuid REFERENCES devices(id) ON DELETE SET NULL,
  assignee_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  frequency        text NOT NULL CHECK (frequency IN ('daily', 'weekly', 'monthly', 'yearly')),
  run_time         text NOT NULL DEFAULT '08:00',
  timezone         text NOT NULL DEFAULT 'UTC',
  days_of_week     integer[] NOT NULL DEFAULT '{}',
  day_of_month     integer,
  month_of_year    integer,
  start_date       date,
  end_date         date,
  skip_if_open     boolean NOT NULL DEFAULT true,
  enabled          boolean NOT NULL DEFAULT true,
  next_run_at      timestamptz,
  last_run_at      timestamptz,
  last_status      text,
  last_error       text,
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);
CREATE INDEX IF NOT EXISTS recurring_tickets_due_idx ON recurring_tickets (next_run_at) WHERE enabled;

-- One row per period a schedule has been run for. The unique run key is what stops a second ticket for the same period,
-- after a restart or when two processes sweep at the same moment.
CREATE TABLE IF NOT EXISTS recurring_ticket_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recurring_id  uuid NOT NULL REFERENCES recurring_tickets(id) ON DELETE CASCADE,
  run_key       text NOT NULL,
  scheduled_for timestamptz NOT NULL,
  trigger       text NOT NULL DEFAULT 'scheduled',
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'created', 'skipped', 'failed')),
  ticket_id     uuid REFERENCES tickets(id) ON DELETE SET NULL,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  UNIQUE (recurring_id, run_key)
);
CREATE INDEX IF NOT EXISTS recurring_ticket_runs_recent_idx ON recurring_ticket_runs (recurring_id, created_at DESC);

ALTER TABLE tickets ADD COLUMN IF NOT EXISTS recurring_id uuid REFERENCES recurring_tickets(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS tickets_recurring_idx ON tickets (recurring_id) WHERE recurring_id IS NOT NULL;
