-- Ensure fresh PostgreSQL installations match the production index set.
CREATE INDEX IF NOT EXISTS device_deletion_requests_status_idx
    ON public.device_deletion_requests (status);
