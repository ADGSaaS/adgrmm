-- The Pion video engine was tried and removed: the per-customer engine setting goes with it.
ALTER TABLE clients DROP COLUMN IF EXISTS remote_console_engine;
