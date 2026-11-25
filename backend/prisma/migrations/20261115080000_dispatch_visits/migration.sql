-- Technician schedule and dispatch board: visits booked against tickets, working hours and time off.
CREATE TABLE IF NOT EXISTS ticket_visits (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  ticket_id            uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  client_id            uuid REFERENCES clients(id) ON DELETE SET NULL,
  title                text NOT NULL,
  notes                text,
  location             text,
  status               text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','en_route','on_site','done','cancelled')),
  starts_at            timestamptz NOT NULL,
  ends_at              timestamptz NOT NULL,
  time_zone            text NOT NULL DEFAULT 'UTC',
  customer_notified_at timestamptz,
  time_entry_id        uuid REFERENCES time_entries(id) ON DELETE SET NULL,
  sequence             integer NOT NULL DEFAULT 0,
  created_by           uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ticket_visits_range CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS idx_ticket_visits_org_start ON ticket_visits (organization_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_ticket_visits_ticket ON ticket_visits (ticket_id);

CREATE TABLE IF NOT EXISTS ticket_visit_techs (
  visit_id uuid NOT NULL REFERENCES ticket_visits(id) ON DELETE CASCADE,
  user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (visit_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_ticket_visit_techs_user ON ticket_visit_techs (user_id);

-- Weekly working hours: hours is [{on,start,end}] for Monday..Sunday ("HH:MM").
CREATE TABLE IF NOT EXISTS tech_availability (
  user_id         uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  time_zone       text NOT NULL DEFAULT 'UTC',
  hours           jsonb NOT NULL DEFAULT '[]',
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tech_time_off (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  starts_at       timestamptz NOT NULL,
  ends_at         timestamptz NOT NULL,
  reason          text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tech_time_off_range CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS idx_tech_time_off_user ON tech_time_off (user_id, starts_at);

INSERT INTO permissions (permission_key, label, group_key, group_label) VALUES
  ('schedule.read',  'View the schedule', 'schedule', 'Schedule'),
  ('schedule.write', 'Book and change visits and availability', 'schedule', 'Schedule')
ON CONFLICT (permission_key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, p.k FROM roles r, (VALUES ('schedule.read'), ('schedule.write')) AS p(k) WHERE lower(r.name) IN ('admin','operator')
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, 'schedule.read' FROM roles r WHERE lower(r.name) = 'viewer'
ON CONFLICT DO NOTHING;
-- Owner always holds every permission.
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, p.k FROM roles r, (VALUES ('schedule.read'), ('schedule.write')) AS p(k) WHERE lower(r.name) = 'owner'
ON CONFLICT DO NOTHING;
