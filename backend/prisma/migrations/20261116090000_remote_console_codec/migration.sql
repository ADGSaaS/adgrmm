-- Which video codec Remote Console may use for a customer's devices, set per customer.
--   auto : VP8, unless the device has a hardware H.264 encoder that passed its start-up check (the default)
--   vp8  : always VP8
--   h264 : H.264 when the device and the browser can do it (hardware or Windows' software encoder), else VP8
-- The server only passes this on; the device decides whether it can really encode H.264.
ALTER TABLE public.clients
    ADD COLUMN IF NOT EXISTS remote_console_codec text NOT NULL DEFAULT 'auto';

ALTER TABLE public.clients
    DROP CONSTRAINT IF EXISTS clients_remote_console_codec_check;

ALTER TABLE public.clients
    ADD CONSTRAINT clients_remote_console_codec_check
    CHECK (remote_console_codec IN ('auto', 'vp8', 'h264'));
