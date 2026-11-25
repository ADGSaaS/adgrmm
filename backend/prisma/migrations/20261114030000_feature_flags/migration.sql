-- Feature flags: one row per organization and flag, holding only what an administrator changed.
-- The flags themselves (key, description, default) are defined in the code, so none can exist without behaviour behind it.
CREATE TABLE IF NOT EXISTS feature_flags (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key             text NOT NULL,
  enabled         boolean NOT NULL,
  updated_by      uuid,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, key)
);
