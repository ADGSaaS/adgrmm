-- Snippets are for building scripts, not for ticket replies: undo the ticket-reply version.
DELETE FROM canned_responses WHERE NOT is_shared;
DROP INDEX IF EXISTS canned_responses_shared_title_uq;
DROP INDEX IF EXISTS canned_responses_private_title_uq;
DROP INDEX IF EXISTS canned_responses_owner_idx;
ALTER TABLE canned_responses DROP CONSTRAINT IF EXISTS canned_responses_private_needs_owner;
ALTER TABLE canned_responses DROP COLUMN IF EXISTS owner_user_id;
ALTER TABLE canned_responses DROP COLUMN IF EXISTS is_shared;
CREATE UNIQUE INDEX IF NOT EXISTS canned_responses_org_title_uq ON canned_responses (organization_id, lower(title));

-- Script snippets: pieces of script a person keeps for reuse, private or shared as the writer chooses.
CREATE TABLE IF NOT EXISTS script_snippets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  owner_user_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  title           text NOT NULL,
  description     text,
  language        text NOT NULL DEFAULT 'any' CHECK (language IN ('powershell', 'bash', 'any')),
  body            text NOT NULL,
  is_shared       boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
-- Shared titles are unique across the organization (per language); private titles only per person.
CREATE UNIQUE INDEX IF NOT EXISTS script_snippets_shared_title_uq ON script_snippets (organization_id, language, lower(title)) WHERE is_shared;
CREATE UNIQUE INDEX IF NOT EXISTS script_snippets_private_title_uq ON script_snippets (organization_id, owner_user_id, language, lower(title)) WHERE NOT is_shared;
CREATE INDEX IF NOT EXISTS script_snippets_org_idx ON script_snippets (organization_id);
