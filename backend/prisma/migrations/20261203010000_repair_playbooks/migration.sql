-- Your own repairs: a problem you describe with a detection script and a repair script. They run in the automatic repair loop only after the Owner
-- approves the exact scripts (the approval is bound to a hash of them), and stop running if they are edited or the stored text no longer matches.
CREATE TABLE IF NOT EXISTS repair_playbooks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key             text NOT NULL CHECK (key ~ '^c-[0-9a-f]{8}$'),
  title           text NOT NULL,
  plain           text NOT NULL,
  signs           text NOT NULL DEFAULT '',
  fix_text        text NOT NULL DEFAULT '',
  if_it_returns   text NOT NULL DEFAULT '',
  categories      text[] NOT NULL DEFAULT '{}',
  app_words       text[] NOT NULL DEFAULT '{}',
  check_service   text,
  check_metric    text CHECK (check_metric IN ('disk', 'cpu')),
  detect_script   text NOT NULL,
  fix_script      text NOT NULL DEFAULT '',
  risk            text NOT NULL DEFAULT 'low' CHECK (risk IN ('low', 'medium', 'high')),
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'tested', 'approved', 'disabled')),
  version         integer NOT NULL DEFAULT 1,
  content_hash    text NOT NULL,
  approved_hash   text,
  approved_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_at     timestamptz,
  last_test       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, key)
);

CREATE TABLE IF NOT EXISTS repair_playbook_versions (
  id          bigserial PRIMARY KEY,
  playbook_id uuid NOT NULL REFERENCES repair_playbooks(id) ON DELETE CASCADE,
  version     integer NOT NULL,
  content_hash text NOT NULL,
  snapshot    jsonb NOT NULL,
  saved_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  saved_at    timestamptz NOT NULL DEFAULT now(),
  note        text
);
CREATE INDEX IF NOT EXISTS repair_playbook_versions_idx ON repair_playbook_versions (playbook_id, id DESC);

-- which of your playbooks a run included, so the confirming check uses exactly the same ones
ALTER TABLE auto_repair_runs ADD COLUMN IF NOT EXISTS custom_ids text[] NOT NULL DEFAULT '{}';
