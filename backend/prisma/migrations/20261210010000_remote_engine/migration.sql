-- Which WebRTC engine a customer's devices use for Remote Console video: the built-in one, or the Pion helper.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS remote_console_engine text NOT NULL DEFAULT 'builtin' CHECK (remote_console_engine IN ('builtin', 'pion'));
