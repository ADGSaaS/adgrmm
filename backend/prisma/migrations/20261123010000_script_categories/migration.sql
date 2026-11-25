-- Script categories people make themselves (the built-in categories come with the built-in scripts and are not stored here).
-- A script's category is the name kept in its configuration, so a category can exist with no script in it.
CREATE TABLE IF NOT EXISTS script_categories (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 60),
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS script_categories_name_idx ON script_categories (organization_id, lower(name));
