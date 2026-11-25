-- Read-only remote registry browser on Windows devices (HKLM and HKU).
INSERT INTO permissions (permission_key, label, group_key, group_label) VALUES
  ('devices.registry.read', 'Browse the registry of Windows devices', 'devices', 'Devices')
ON CONFLICT (permission_key) DO NOTHING;

-- Administrators only: a registry can hold sensitive settings. Owner holds everything by rule; Operator and Viewer do not get it
-- (an administrator can grant it to another role in the Roles screen).
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, 'devices.registry.read' FROM roles r WHERE lower(r.name) = 'admin'
ON CONFLICT DO NOTHING;
