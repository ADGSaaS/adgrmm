-- What RemoteIQ last learned about ClamAV on a Linux device: whether it is installed, and the last malware scan's result.
CREATE TABLE IF NOT EXISTS device_linux_av (
  device_id         uuid PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  installed         boolean,
  installed_at      timestamptz,
  signatures_at     timestamptz,
  scan_at           timestamptz,
  scan_state        text CHECK (scan_state IN ('clean', 'infected', 'error')),
  scan_files        integer,
  scan_seconds      integer,
  scan_infected     integer NOT NULL DEFAULT 0,
  scan_found        jsonb NOT NULL DEFAULT '[]'::jsonb,
  scan_message      text
);
