-- REMOTEIQ_POSTGRES_RUNTIME_COMPATIBILITY_V2
--
-- Scope:
--   1. Add patch_scan and patch_install to agent_task_type.
--   2. Ensure every organization has a normalized localization row.
--   3. Align localization compatibility id with organization_id.
--   4. Enforce the localization -> organization relationship.
--
-- Intentionally NOT added:
--   users.name
--   support_legal_settings
--   device_enrollment_tokens
--   policies
--   settings
--   audit_logs

BEGIN;

-- ---------------------------------------------------------------------------
-- Patch task protocol
-- ---------------------------------------------------------------------------

ALTER TYPE public.agent_task_type
    ADD VALUE IF NOT EXISTS 'patch_scan';

ALTER TYPE public.agent_task_type
    ADD VALUE IF NOT EXISTS 'patch_install';

-- ---------------------------------------------------------------------------
-- Localization normalization
-- ---------------------------------------------------------------------------

-- Existing compatibility IDs should mirror the owning organization.
UPDATE public.localization_settings
SET id = organization_id::text
WHERE id IS DISTINCT FROM organization_id::text;

-- Ensure every organization has one localization row.
--
-- first_day_of_week:
--   0 = Sunday
--   1 = Monday
--
-- Existing localization rows are never overwritten here.
INSERT INTO public.localization_settings (
    organization_id,
    locale,
    language,
    timezone,
    time_zone,
    date_format,
    time_format,
    number_format,
    first_day_of_week,
    id,
    currency
)
SELECT
    o.id,
    'en-US',
    'en-US',
    COALESCE(NULLIF(o.time_zone, ''), 'UTC'),
    COALESCE(NULLIF(o.time_zone, ''), 'UTC'),
    'yyyy-MM-dd',
    'HH:mm',
    '1,234.56',
    0,
    o.id::text,
    'USD'
FROM public.organizations o
WHERE NOT EXISTS (
    SELECT 1
    FROM public.localization_settings l
    WHERE l.organization_id = o.id
);

-- Enforce organization ownership.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid =
              'public.localization_settings'::regclass
          AND conname =
              'localization_settings_organization_id_fkey'
    ) THEN
        ALTER TABLE public.localization_settings
            ADD CONSTRAINT
                localization_settings_organization_id_fkey
            FOREIGN KEY (organization_id)
            REFERENCES public.organizations(id)
            ON DELETE CASCADE;
    END IF;
END
$$;

COMMIT;
