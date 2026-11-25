-- Staged agent rollout: set update rings, promote a candidate agent build to everyone, withdraw it.
INSERT INTO permissions (permission_key, label, group_key, group_label) VALUES
  ('agents.release.manage', 'Manage agent update rings and releases', 'devices', 'Devices')
ON CONFLICT (permission_key) DO NOTHING;

-- Deliberately granted to NO role. Owner holds every right by rule; an administrator who should be able to promote an agent build
-- to every device is given this right explicitly in the Roles screen.
