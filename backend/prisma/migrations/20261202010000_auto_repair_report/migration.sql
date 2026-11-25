-- Why a run went to a technician, as a short code, so the results report can count the reasons.
ALTER TABLE auto_repair_runs ADD COLUMN IF NOT EXISTS handoff_reason text;
CREATE INDEX IF NOT EXISTS auto_repair_runs_org_created_idx ON auto_repair_runs (organization_id, created_at DESC);
