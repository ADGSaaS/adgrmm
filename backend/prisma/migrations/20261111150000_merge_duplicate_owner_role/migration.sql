-- There were two Owner roles, "Owner" and a lowercase "owner". Everyone holding the lowercase one now holds "Owner",
-- and the lowercase role is removed. Owner always has every permission, so nothing is lost.

-- 1. Duplicates inside one organisation: keep the one spelled exactly "Owner" (else the oldest, renamed to "Owner").
DO $$
DECLARE
    grp RECORD;
    keep_id UUID;
BEGIN
    FOR grp IN
        SELECT organization_id FROM roles WHERE lower(name) = 'owner' AND organization_id IS NOT NULL
        GROUP BY organization_id HAVING count(*) > 1
    LOOP
        SELECT id INTO keep_id FROM roles
         WHERE organization_id = grp.organization_id AND lower(name) = 'owner'
         ORDER BY (name = 'Owner') DESC, created_at ASC LIMIT 1;

        INSERT INTO user_roles (user_id, role_id, assigned_at, assigned_by)
        SELECT ur.user_id, keep_id, ur.assigned_at, ur.assigned_by
          FROM user_roles ur JOIN roles r ON r.id = ur.role_id
         WHERE r.organization_id = grp.organization_id AND lower(r.name) = 'owner' AND r.id <> keep_id
        ON CONFLICT DO NOTHING;

        DELETE FROM roles WHERE organization_id = grp.organization_id AND lower(name) = 'owner' AND id <> keep_id;
        UPDATE roles SET name = 'Owner', updated_at = now() WHERE id = keep_id AND name <> 'Owner';
    END LOOP;
END $$;

-- 2. A system-wide "owner" role next to an organisation's "Owner": move its people to the Owner of their own organisation.
INSERT INTO user_roles (user_id, role_id, assigned_at, assigned_by)
SELECT ur.user_id, o.id, ur.assigned_at, ur.assigned_by
  FROM user_roles ur
  JOIN roles sys ON sys.id = ur.role_id AND sys.organization_id IS NULL AND lower(sys.name) = 'owner'
  JOIN users u ON u.id = ur.user_id
  JOIN roles o ON o.organization_id = u.organization_id AND lower(o.name) = 'owner'
ON CONFLICT DO NOTHING;

DELETE FROM user_roles ur
 USING roles sys, users u
 WHERE ur.role_id = sys.id AND sys.organization_id IS NULL AND lower(sys.name) = 'owner'
   AND u.id = ur.user_id
   AND EXISTS (SELECT 1 FROM roles o WHERE o.organization_id = u.organization_id AND lower(o.name) = 'owner');

DELETE FROM roles sys
 WHERE sys.organization_id IS NULL AND lower(sys.name) = 'owner'
   AND NOT EXISTS (SELECT 1 FROM user_roles ur WHERE ur.role_id = sys.id);
