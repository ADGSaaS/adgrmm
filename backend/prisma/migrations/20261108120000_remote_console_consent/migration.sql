-- What the person at a device is told when a technician starts Remote Console, set per customer.
--   off     : nothing is shown
--   notice  : a message says who connected (the default)
--   consent : the person must allow the session, and it is refused if nobody answers
-- Devices with nobody signed in are not asked, so unattended access keeps working.
ALTER TABLE public.clients
    ADD COLUMN IF NOT EXISTS remote_console_consent text NOT NULL DEFAULT 'notice';

ALTER TABLE public.clients
    DROP CONSTRAINT IF EXISTS clients_remote_console_consent_check;

ALTER TABLE public.clients
    ADD CONSTRAINT clients_remote_console_consent_check
    CHECK (remote_console_consent IN ('off', 'notice', 'consent'));
