-- Who owns assets: the built-in asset manager (the default) or an external one (the owner's Killian software). One row per
-- organisation; no row means built-in. When it is external the built-in asset manager is switched off (see docs/design/asset-provider.md):
-- its endpoints answer "managed elsewhere", its hourly sync and expiry emails stop, and nothing is deleted.
CREATE TABLE IF NOT EXISTS asset_provider_settings (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  provider        text NOT NULL DEFAULT 'builtin' CHECK (provider IN ('builtin', 'external')),
  external_name   text,
  external_url    text,
  changed_by      uuid,
  changed_at      timestamptz NOT NULL DEFAULT now()
);

-- A found host can be recorded as an asset; this says where that asset lives (the same provider-neutral pair snmp_devices has).
ALTER TABLE discovered_hosts ADD COLUMN IF NOT EXISTS asset_provider text;
ALTER TABLE discovered_hosts ADD COLUMN IF NOT EXISTS asset_ref text;

-- Switching the asset manager is a big step. Deliberately granted to NO role: Owner holds every right by rule.
INSERT INTO permissions (permission_key, label, group_key, group_label) VALUES
  ('integrations.manage', 'Manage integrations, including who owns assets', 'settings', 'Settings')
ON CONFLICT (permission_key) DO NOTHING;
