-- Device secrets for Linux: a LUKS recovery key (added by RemoteIQ on a volume that unlocks without a passphrase) is a new kind of secret.
-- The local administrator password needs nothing new. Idempotent.
ALTER TABLE device_secrets DROP CONSTRAINT IF EXISTS device_secrets_kind_check;
ALTER TABLE device_secrets ADD CONSTRAINT device_secrets_kind_check CHECK (kind IN ('bitlocker_recovery', 'luks_recovery', 'local_admin'));
CREATE UNIQUE INDEX IF NOT EXISTS device_secrets_one_luks_current_idx ON device_secrets (device_id, kind, label, ref) WHERE status = 'current' AND kind = 'luks_recovery';
