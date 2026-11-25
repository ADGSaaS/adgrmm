-- Importing from another helpdesk (Freshdesk first): the jobs, and which imported thing became which record here,
-- so running an import again skips what is already in.
CREATE TABLE IF NOT EXISTS import_jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source          text NOT NULL,
  status          text NOT NULL CHECK (status IN ('previewing', 'previewed', 'running', 'completed', 'failed', 'cancelled', 'interrupted')),
  -- The provider address and the API key (encrypted). The key is removed when the job ends.
  config          jsonb NOT NULL DEFAULT '{}'::jsonb,
  options         jsonb NOT NULL DEFAULT '{}'::jsonb,
  preview         jsonb,
  progress        jsonb NOT NULL DEFAULT '{}'::jsonb,
  errors          jsonb NOT NULL DEFAULT '[]'::jsonb,
  message         text,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  started_at      timestamptz,
  finished_at     timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS import_jobs_org_idx ON import_jobs (organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS import_links (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source          text NOT NULL,
  kind            text NOT NULL,
  external_id     text NOT NULL,
  local_id        uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, source, kind, external_id)
);
