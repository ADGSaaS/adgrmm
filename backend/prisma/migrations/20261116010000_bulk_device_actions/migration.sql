-- Bulk device actions (roadmap 1.13): one row per batch a person started from the device list, one row per device in it.
-- Items point at the job or agent task each device was given, so the batch view can show how each one went.
CREATE TABLE IF NOT EXISTS bulk_batches (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid        NOT NULL,
  action          text        NOT NULL,
  summary         text        NOT NULL,
  params          jsonb       NOT NULL DEFAULT '{}'::jsonb,
  requested       integer     NOT NULL,
  succeeded       integer     NOT NULL DEFAULT 0,
  skipped         integer     NOT NULL DEFAULT 0,
  failed          integer     NOT NULL DEFAULT 0,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bulk_batches_org_created_idx ON bulk_batches (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS bulk_batches_user_created_idx ON bulk_batches (created_by, created_at DESC);

CREATE TABLE IF NOT EXISTS bulk_batch_items (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id    uuid        NOT NULL REFERENCES bulk_batches(id) ON DELETE CASCADE,
  device_id   uuid        NOT NULL,
  device_name text        NOT NULL DEFAULT '',
  client_id   uuid,
  status      text        NOT NULL,
  reason      text,
  job_id      uuid,
  task_id     uuid,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bulk_batch_items_batch_idx ON bulk_batch_items (batch_id);
