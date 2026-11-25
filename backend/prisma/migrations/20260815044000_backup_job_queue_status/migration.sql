-- Separate queued backup work from actively executing backup work.
ALTER TYPE public.backup_status
    ADD VALUE IF NOT EXISTS 'queued';
