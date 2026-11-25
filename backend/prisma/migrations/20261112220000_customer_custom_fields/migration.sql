-- Fields an organization defines for its customers (an account manager, a contract number, a renewal date...).
CREATE TABLE IF NOT EXISTS custom_field_defs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  entity          text NOT NULL DEFAULT 'customer' CHECK (entity IN ('customer')),
  -- Fixed once made, so values already saved stay attached to the field however its label changes.
  key             text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{0,39}$'),
  label           text NOT NULL,
  type            text NOT NULL CHECK (type IN ('text', 'longtext', 'number', 'date', 'dropdown', 'checkbox', 'url')),
  options         jsonb NOT NULL DEFAULT '[]'::jsonb,
  required        boolean NOT NULL DEFAULT false,
  help            text,
  sort_order      integer NOT NULL DEFAULT 0,
  -- A field that is taken away is archived: what people saved in it is kept and comes back if it is restored.
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, entity, key)
);
CREATE UNIQUE INDEX IF NOT EXISTS custom_field_defs_label_uq ON custom_field_defs (organization_id, entity, lower(label)) WHERE active;

ALTER TABLE clients ADD COLUMN IF NOT EXISTS custom_fields jsonb NOT NULL DEFAULT '{}'::jsonb;
