-- Windows services, processes and event log tools on a device (roadmap 1.16).
INSERT INTO permissions (permission_key, label, group_key, group_label) VALUES
  ('devices.tools.write', 'Change services and processes on devices', 'devices', 'Devices')
ON CONFLICT (permission_key) DO NOTHING;

-- Administrators and operators already have the terminal (devices.actions), which can do the same; owner holds everything by rule.
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, 'devices.tools.write' FROM roles r WHERE lower(r.name) IN ('admin', 'operator')
ON CONFLICT DO NOTHING;
