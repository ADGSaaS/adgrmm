-- Security basics, stage 2: viewing device secrets, and escrowing keys / rotating the managed local administrator password.
INSERT INTO permissions (permission_key, label, group_key, group_label) VALUES
  ('devices.secrets.reveal', 'View device secrets (BitLocker recovery keys, local administrator passwords)', 'devices', 'Devices'),
  ('devices.secrets.manage', 'Escrow BitLocker keys and rotate local administrator passwords', 'devices', 'Devices')
ON CONFLICT (permission_key) DO NOTHING;

-- Deliberately granted to NO role. Owner holds every right by rule; an administrator who should handle secrets is given these rights
-- explicitly in the Roles screen (both also need devices.read).
