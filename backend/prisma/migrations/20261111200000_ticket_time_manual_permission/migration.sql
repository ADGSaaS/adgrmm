-- Adding time by hand (typing it in, or changing a logged entry) now needs its own right. The ticket timer does not.
-- Administrators and operators keep what they could do before; other roles can be given it in the Roles screen.
INSERT INTO permissions (permission_key, label, group_key, group_label)
VALUES ('tickets.time.manual', 'Add or change time by hand', 'tickets', 'Tickets')
ON CONFLICT (permission_key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, 'tickets.time.manual' FROM roles r WHERE lower(r.name) IN ('admin', 'operator')
ON CONFLICT DO NOTHING;
