-- Security basics, stage 1 (Defender status, baseline checks and score, BitLocker status): the last security scan of each Windows
-- device. `raw` holds the probes a scan found, after the server checked them (no secret is ever collected: no BitLocker key or
-- key id, no recovery password, no password). The rules and the score are worked out from `raw` when read; the columns next to it
-- are what the fleet page sorts, filters and counts by, as of the scan. attempted_at is the last try (a failed try keeps the last
-- good result in raw and scanned_at); pending_job_id is the scan job that has been asked for and not yet read back.
CREATE TABLE IF NOT EXISTS device_security_scans (
  device_id        uuid PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  scanned_at       timestamptz,
  attempted_at     timestamptz NOT NULL DEFAULT now(),
  ok               boolean NOT NULL DEFAULT false,
  raw              jsonb,
  score            integer CHECK (score IS NULL OR (score BETWEEN 0 AND 100)),
  grade            text CHECK (grade IS NULL OR grade IN ('A', 'B', 'C', 'D', 'F')),
  findings_failed  integer NOT NULL DEFAULT 0,
  findings_warned  integer NOT NULL DEFAULT 0,
  critical_failed  integer NOT NULL DEFAULT 0,
  high_failed      integer NOT NULL DEFAULT 0,
  unknown_count    integer NOT NULL DEFAULT 0,
  failed_rules     text[] NOT NULL DEFAULT '{}',
  message          text,
  pending_job_id   uuid,
  pending_at       timestamptz
);
CREATE INDEX IF NOT EXISTS device_security_scans_score_idx ON device_security_scans (score);
CREATE INDEX IF NOT EXISTS device_security_scans_grade_idx ON device_security_scans (grade);
CREATE INDEX IF NOT EXISTS device_security_scans_attempted_idx ON device_security_scans (attempted_at);
CREATE INDEX IF NOT EXISTS device_security_scans_pending_idx ON device_security_scans (pending_at) WHERE pending_job_id IS NOT NULL;