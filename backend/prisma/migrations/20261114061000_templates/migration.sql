-- Ticket templates: a starting point for a new ticket (subject, description, priority and custom field values).
CREATE TABLE IF NOT EXISTS ticket_templates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            text NOT NULL,
  hint            text,
  subject         text NOT NULL DEFAULT '',
  body            text NOT NULL DEFAULT '',
  priority        text NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
  custom_fields   jsonb NOT NULL DEFAULT '{}'::jsonb,
  sort_order      integer NOT NULL DEFAULT 0,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ticket_templates_name_uq ON ticket_templates (organization_id, lower(name));

-- What an administrator changed about a system email (portal invitation, password reset, alert, invoice). Without a row the built-in wording is used.
CREATE TABLE IF NOT EXISTS email_templates (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key             text NOT NULL,
  subject         text NOT NULL,
  body            text NOT NULL,
  updated_by      uuid,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, key)
);
