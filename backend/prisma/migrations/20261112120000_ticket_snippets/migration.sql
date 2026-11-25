-- Snippets: a person can keep reply text for themselves (private) or share it with everyone (shared), their choice.
-- The canned responses an administrator keeps are shared snippets with no owner.
ALTER TABLE canned_responses ADD COLUMN IF NOT EXISTS owner_user_id uuid REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE canned_responses ADD COLUMN IF NOT EXISTS is_shared boolean NOT NULL DEFAULT true;
ALTER TABLE canned_responses DROP CONSTRAINT IF EXISTS canned_responses_private_needs_owner;
ALTER TABLE canned_responses ADD CONSTRAINT canned_responses_private_needs_owner CHECK (is_shared OR owner_user_id IS NOT NULL);

-- Shared titles are unique across the organization; private titles only per person.
DROP INDEX IF EXISTS canned_responses_org_title_uq;
CREATE UNIQUE INDEX IF NOT EXISTS canned_responses_shared_title_uq ON canned_responses (organization_id, lower(title)) WHERE is_shared;
CREATE UNIQUE INDEX IF NOT EXISTS canned_responses_private_title_uq ON canned_responses (organization_id, owner_user_id, lower(title)) WHERE NOT is_shared;
CREATE INDEX IF NOT EXISTS canned_responses_owner_idx ON canned_responses (owner_user_id) WHERE owner_user_id IS NOT NULL;
