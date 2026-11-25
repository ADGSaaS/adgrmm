-- Changing the registry of Windows devices (phase 2 of the registry browser): set / delete a value, create / delete an empty key, undo.
INSERT INTO permissions (permission_key, label, group_key, group_label) VALUES
  ('devices.registry.write', 'Change the registry of Windows devices', 'devices', 'Devices')
ON CONFLICT (permission_key) DO NOTHING;

-- Deliberately granted to NO role. Owner holds every right by rule; an administrator who should be able to change the registry is
-- given this right explicitly in the Roles screen (it also needs devices.registry.read and devices.read).
