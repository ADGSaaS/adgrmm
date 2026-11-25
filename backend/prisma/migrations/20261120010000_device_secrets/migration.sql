-- Security basics, stage 2: the encrypted device-secrets vault (BitLocker recovery keys and managed local administrator passwords).
-- `ciphertext` is authenticated encryption (AES-256-GCM, a key derived from the server's data-encryption key) with the device id, the
-- kind and `ref` bound in as associated data, so a row copied to another device or another kind fails to open. `key_version` and
-- `key_id` say which key sealed it. NO plaintext is ever stored here, and device_secret_access holds no secret material at all.
-- ref: the BitLocker protector id (a GUID) or, for a local admin password, a generation id.
-- status: current | previous (superseded, kept for a while) | unconfirmed (set on the device but the logon check failed) | purged
-- (ciphertext removed). missed_reads counts consecutive successful BitLocker reads that did not list the protector.
CREATE TABLE IF NOT EXISTS device_secrets (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  device_id        uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  kind             text NOT NULL CHECK (kind IN ('bitlocker_recovery', 'local_admin')),
  label            text NOT NULL,
  ref              text NOT NULL,
  ciphertext       text,
  key_version      integer NOT NULL DEFAULT 1,
  key_id           text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  rotated_at       timestamptz,
  superseded_at    timestamptz,
  last_seen_at     timestamptz,
  missed_reads     integer NOT NULL DEFAULT 0,
  status           text NOT NULL DEFAULT 'current' CHECK (status IN ('current', 'previous', 'unconfirmed', 'purged')),
  last_revealed_at timestamptz,
  last_revealed_by text,
  CONSTRAINT device_secrets_cipher_chk CHECK ((status = 'purged') = (ciphertext IS NULL))
);
CREATE INDEX IF NOT EXISTS device_secrets_device_idx ON device_secrets (device_id, kind, status);
CREATE INDEX IF NOT EXISTS device_secrets_org_idx ON device_secrets (org_id);
CREATE UNIQUE INDEX IF NOT EXISTS device_secrets_one_current_idx ON device_secrets (device_id, kind, label, ref) WHERE status = 'current' AND kind = 'bitlocker_recovery';
CREATE UNIQUE INDEX IF NOT EXISTS device_secrets_one_admin_current_idx ON device_secrets (device_id, kind, label) WHERE status = 'current' AND kind = 'local_admin';

-- Who looked at, stored or changed which secret, when and why. Never any secret material.
CREATE TABLE IF NOT EXISTS device_secret_access (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id   uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  secret_id   uuid REFERENCES device_secrets(id) ON DELETE SET NULL,
  secret_kind text,
  label       text,
  user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  user_name   text,
  at          timestamptz NOT NULL DEFAULT now(),
  action      text NOT NULL CHECK (action IN ('reveal', 'escrow', 'rotate', 'rotate-requested', 'purge')),
  reason      text,
  outcome     text NOT NULL,
  error       text
);
CREATE INDEX IF NOT EXISTS device_secret_access_device_at_idx ON device_secret_access (device_id, at DESC);
CREATE INDEX IF NOT EXISTS device_secret_access_at_idx ON device_secret_access (at DESC);
CREATE INDEX IF NOT EXISTS device_secret_access_user_idx ON device_secret_access (user_id, at DESC);

-- What is waiting or was last tried, per device (the answers of the secret jobs are applied when they arrive; see JobsService.finishJob).
CREATE TABLE IF NOT EXISTS device_secret_state (
  device_id             uuid PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  escrow_pending_job_id uuid,
  escrow_pending_at     timestamptz,
  escrow_attempted_at   timestamptz,
  escrow_ok_at          timestamptz,
  escrow_message        text,
  escrow_by_user        uuid,
  escrow_by_name        text,
  escrow_trigger        text,
  laps_pending_job_id   uuid,
  laps_pending_at       timestamptz,
  laps_attempted_at     timestamptz,
  laps_ok_at            timestamptz,
  laps_attempt          text CHECK (laps_attempt IS NULL OR laps_attempt IN ('ok', 'failed', 'unconfirmed', 'no_answer')),
  laps_message          text,
  laps_by_user          uuid,
  laps_by_name          text,
  laps_trigger          text,
  laps_rotate_due_at    timestamptz
);
CREATE INDEX IF NOT EXISTS device_secret_state_escrow_pending_idx ON device_secret_state (escrow_pending_at) WHERE escrow_pending_job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS device_secret_state_laps_pending_idx ON device_secret_state (laps_pending_at) WHERE laps_pending_job_id IS NOT NULL;
