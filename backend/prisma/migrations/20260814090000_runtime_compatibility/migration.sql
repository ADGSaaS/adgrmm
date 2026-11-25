-- REMOTEIQ_PRISMA_RUNTIME_COMPATIBILITY_V1
-- Align the recovered PostgreSQL baseline with schema required by the current
-- RemoteIQ Backend. Prisma owns these structures after this migration.

BEGIN;

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "citext";

-- -----------------------------------------------------------------------------
-- Provisioning / device lifecycle
-- -----------------------------------------------------------------------------

ALTER TABLE public.devices
    ADD COLUMN IF NOT EXISTS alias text;

CREATE TABLE IF NOT EXISTS public.endpoint_enrollments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
    site_id uuid NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
    device_id uuid NOT NULL REFERENCES public.devices(id) ON DELETE CASCADE,
    os text NOT NULL,
    alias text NOT NULL,
    token_hash text NOT NULL UNIQUE,
    expires_at timestamptz NOT NULL,
    used_at timestamptz NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS endpoint_enrollments_device_idx
    ON public.endpoint_enrollments (device_id);

CREATE INDEX IF NOT EXISTS endpoint_enrollments_expires_idx
    ON public.endpoint_enrollments (expires_at);

CREATE TABLE IF NOT EXISTS public.site_enrollment_keys (
    id uuid PRIMARY KEY,
    client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
    site_id uuid NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
    name text NULL,
    token_hash text NOT NULL UNIQUE,
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz NULL,
    last_used_at timestamptz NULL,
    created_by_user_id uuid NULL REFERENCES public.users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS site_enrollment_keys_site_idx
    ON public.site_enrollment_keys (site_id);

CREATE INDEX IF NOT EXISTS site_enrollment_keys_expires_idx
    ON public.site_enrollment_keys (expires_at);

CREATE TABLE IF NOT EXISTS public.installer_bundles (
    id uuid PRIMARY KEY,
    client_id uuid NOT NULL,
    site_id uuid NOT NULL,
    os text NOT NULL,
    filename text NOT NULL,
    content text NOT NULL,
    download_token_hash text NOT NULL,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS installer_bundles_expires_at_idx
    ON public.installer_bundles (expires_at);

CREATE TABLE IF NOT EXISTS public.device_deletion_requests (
    id uuid PRIMARY KEY,
    device_id uuid NOT NULL UNIQUE,
    status text NOT NULL,
    requested_by_user_id uuid NULL,
    requested_at timestamptz NOT NULL DEFAULT now(),
    approved_by_user_id uuid NULL,
    approved_at timestamptz NULL,
    completed_at timestamptz NULL
);

-- -----------------------------------------------------------------------------
-- Agent job pipeline
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.jobs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id uuid NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
    type text NOT NULL,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    status text NOT NULL DEFAULT 'queued',
    created_at timestamptz NOT NULL DEFAULT now(),
    dispatched_at timestamptz NULL,
    started_at timestamptz NULL,
    finished_at timestamptz NULL
);

CREATE INDEX IF NOT EXISTS jobs_agent_status_idx
    ON public.jobs (agent_id, status);

CREATE INDEX IF NOT EXISTS jobs_created_at_idx
    ON public.jobs (created_at);

CREATE TABLE IF NOT EXISTS public.job_results (
    job_id uuid PRIMARY KEY REFERENCES public.jobs(id) ON DELETE CASCADE,
    exit_code integer NOT NULL DEFAULT 0,
    stdout text NOT NULL DEFAULT '',
    stderr text NOT NULL DEFAULT '',
    duration_ms bigint NOT NULL DEFAULT 0
);

-- -----------------------------------------------------------------------------
-- Monitoring checks: temporary compatibility superset for both current service
-- layouts. Follow-up Prisma conversion can normalize this after callers move.
-- -----------------------------------------------------------------------------

ALTER TABLE public.check_assignments
    ALTER COLUMN check_id DROP NOT NULL;

ALTER TABLE public.check_assignments
    ALTER COLUMN target_type TYPE text
    USING target_type::text;

ALTER TABLE public.check_assignments
    ALTER COLUMN target_type DROP NOT NULL;

ALTER TABLE public.check_assignments
    ALTER COLUMN target_id DROP NOT NULL;

ALTER TABLE public.check_assignments
    ADD COLUMN IF NOT EXISTS device_id text,
    ADD COLUMN IF NOT EXISTS dedupe_key text,
    ADD COLUMN IF NOT EXISTS check_type text,
    ADD COLUMN IF NOT EXISTS check_name text;

CREATE UNIQUE INDEX IF NOT EXISTS check_assignments_target_dedupe_uk
    ON public.check_assignments (target_type, target_id, dedupe_key);

CREATE INDEX IF NOT EXISTS check_assignments_target_idx
    ON public.check_assignments (target_type, target_id);

CREATE UNIQUE INDEX IF NOT EXISTS check_assignments_device_dedupe_uk
    ON public.check_assignments (
        device_id,
        COALESCE(
            NULLIF(dedupe_key, ''),
            LOWER(COALESCE(check_type, '')) || '|' || LOWER(COALESCE(check_name, ''))
        )
    );

CREATE INDEX IF NOT EXISTS check_assignments_device_id_idx
    ON public.check_assignments (device_id);

ALTER TABLE public.check_runs
    ALTER COLUMN status TYPE text
    USING status::text;

ALTER TABLE public.check_runs
    ALTER COLUMN severity TYPE text
    USING severity::text;

ALTER TABLE public.check_runs
    ALTER COLUMN severity DROP NOT NULL;

ALTER TABLE public.check_runs
    ADD COLUMN IF NOT EXISTS device_id text,
    ADD COLUMN IF NOT EXISTS metrics jsonb,
    ADD COLUMN IF NOT EXISTS output text,
    ADD COLUMN IF NOT EXISTS finished_at timestamptz;

CREATE INDEX IF NOT EXISTS check_runs_assignment_id_idx
    ON public.check_runs (assignment_id);

CREATE INDEX IF NOT EXISTS check_runs_device_id_idx
    ON public.check_runs (device_id);

CREATE INDEX IF NOT EXISTS check_runs_created_at_idx
    ON public.check_runs (created_at);

-- -----------------------------------------------------------------------------
-- Ticketing
-- -----------------------------------------------------------------------------

ALTER TYPE ticket_status
    ADD VALUE IF NOT EXISTS 'in_progress';

ALTER TABLE public.tickets
    ADD COLUMN IF NOT EXISTS due_at timestamptz NULL;

CREATE TABLE IF NOT EXISTS public.ticket_activity (
    id uuid PRIMARY KEY,
    ticket_id uuid NOT NULL REFERENCES public.tickets(id) ON DELETE CASCADE,
    kind text NOT NULL,
    body text NOT NULL DEFAULT '',
    attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
    time_worked_seconds integer NOT NULL DEFAULT 0,
    notify_customer boolean NOT NULL DEFAULT false,
    author text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    is_internal boolean NOT NULL DEFAULT false,
    field text NULL,
    from_value text NULL,
    to_value text NULL
);

ALTER TABLE public.ticket_activity
    DROP CONSTRAINT IF EXISTS ticket_activity_kind_check;

ALTER TABLE public.ticket_activity
    ADD COLUMN IF NOT EXISTS body text,
    ADD COLUMN IF NOT EXISTS attachments jsonb,
    ADD COLUMN IF NOT EXISTS time_worked_seconds integer,
    ADD COLUMN IF NOT EXISTS notify_customer boolean,
    ADD COLUMN IF NOT EXISTS is_internal boolean,
    ADD COLUMN IF NOT EXISTS field text,
    ADD COLUMN IF NOT EXISTS from_value text,
    ADD COLUMN IF NOT EXISTS to_value text;

UPDATE public.ticket_activity SET body = '' WHERE body IS NULL;
UPDATE public.ticket_activity SET attachments = '[]'::jsonb WHERE attachments IS NULL;
UPDATE public.ticket_activity SET time_worked_seconds = 0 WHERE time_worked_seconds IS NULL;
UPDATE public.ticket_activity SET notify_customer = false WHERE notify_customer IS NULL;
UPDATE public.ticket_activity SET is_internal = (kind = 'note') WHERE is_internal IS NULL;
UPDATE public.ticket_activity SET kind = 'message' WHERE kind = 'reply';

ALTER TABLE public.ticket_activity
    ALTER COLUMN body SET DEFAULT '',
    ALTER COLUMN body SET NOT NULL,
    ALTER COLUMN attachments SET DEFAULT '[]'::jsonb,
    ALTER COLUMN attachments SET NOT NULL,
    ALTER COLUMN time_worked_seconds SET DEFAULT 0,
    ALTER COLUMN time_worked_seconds SET NOT NULL,
    ALTER COLUMN notify_customer SET DEFAULT false,
    ALTER COLUMN notify_customer SET NOT NULL,
    ALTER COLUMN is_internal SET DEFAULT false,
    ALTER COLUMN is_internal SET NOT NULL;

CREATE INDEX IF NOT EXISTS ticket_activity_ticket_created_idx
    ON public.ticket_activity (ticket_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.ticket_links (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id uuid NOT NULL REFERENCES public.tickets(id) ON DELETE CASCADE,
    linked_ticket_id uuid NOT NULL REFERENCES public.tickets(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS ticket_links_pair_uq
    ON public.ticket_links (ticket_id, linked_ticket_id);

CREATE INDEX IF NOT EXISTS ticket_links_ticket_id_idx
    ON public.ticket_links (ticket_id);

CREATE TABLE IF NOT EXISTS public.canned_responses (
    id uuid PRIMARY KEY,
    organization_id uuid NOT NULL,
    title text NOT NULL,
    body text NOT NULL,
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS canned_responses_org_idx
    ON public.canned_responses (organization_id);

CREATE UNIQUE INDEX IF NOT EXISTS canned_responses_org_title_uq
    ON public.canned_responses (organization_id, lower(title));

CREATE TABLE IF NOT EXISTS public.canned_variables (
    id uuid PRIMARY KEY,
    organization_id uuid NOT NULL,
    key text NOT NULL,
    value text NOT NULL,
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS canned_variables_org_idx
    ON public.canned_variables (organization_id);

CREATE UNIQUE INDEX IF NOT EXISTS canned_variables_org_key_uq
    ON public.canned_variables (organization_id, lower(key));

-- -----------------------------------------------------------------------------
-- IMAP ingestion/state
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.imap_state (
    purpose text PRIMARY KEY,
    last_uid bigint NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.imap_ingested (
    id bigserial PRIMARY KEY,
    purpose text NOT NULL,
    uid bigint NOT NULL,
    from_addr text NULL,
    subject text NULL,
    size_bytes integer NULL,
    headers_snippet text NULL,
    is_bounce boolean NOT NULL DEFAULT false,
    bounce_recipient text NULL,
    bounce_status text NULL,
    bounce_action text NULL,
    bounce_diagnostic text NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (purpose, uid)
);

COMMIT;