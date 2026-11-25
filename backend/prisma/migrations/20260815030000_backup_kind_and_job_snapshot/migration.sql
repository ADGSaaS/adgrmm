-- Distinguish portable logical exports from full PostgreSQL disaster-recovery backups.
ALTER TABLE public.backup_policies
    ADD COLUMN IF NOT EXISTS backup_kind text NOT NULL DEFAULT 'logical';

ALTER TABLE public.backup_policies
    DROP CONSTRAINT IF EXISTS backup_policies_backup_kind_check;

ALTER TABLE public.backup_policies
    ADD CONSTRAINT backup_policies_backup_kind_check
    CHECK (backup_kind IN ('logical', 'postgresql'));

-- Preserve the type and effective configuration of every historical backup job.
ALTER TABLE public.backup_jobs
    ADD COLUMN IF NOT EXISTS backup_kind text NOT NULL DEFAULT 'logical';

ALTER TABLE public.backup_jobs
    DROP CONSTRAINT IF EXISTS backup_jobs_backup_kind_check;

ALTER TABLE public.backup_jobs
    ADD CONSTRAINT backup_jobs_backup_kind_check
    CHECK (backup_kind IN ('logical', 'postgresql'));

ALTER TABLE public.backup_jobs
    ADD COLUMN IF NOT EXISTS config_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Give restore attempts explicit completion/error/verification state.
ALTER TABLE public.backup_restores
    ADD COLUMN IF NOT EXISTS finished_at timestamptz;

ALTER TABLE public.backup_restores
    ADD COLUMN IF NOT EXISTS error text;

ALTER TABLE public.backup_restores
    ADD COLUMN IF NOT EXISTS restore_database text;

ALTER TABLE public.backup_restores
    ADD COLUMN IF NOT EXISTS verification jsonb NOT NULL DEFAULT '{}'::jsonb;
