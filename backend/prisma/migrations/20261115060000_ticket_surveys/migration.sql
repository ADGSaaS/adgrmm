-- Customer satisfaction surveys: the settings, and one survey per ticket (sent to the person who asked, answered once).
CREATE TABLE IF NOT EXISTS survey_settings (
  organization_id     uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  enabled             boolean NOT NULL DEFAULT false,
  -- Statuses that start a survey, when a ticket gets one of them.
  trigger_statuses    text[] NOT NULL DEFAULT ARRAY['resolved','closed'],
  delay_minutes       integer NOT NULL DEFAULT 60,
  -- 'all' customers, or only the ones in client_ids.
  scope               text NOT NULL DEFAULT 'all' CHECK (scope IN ('all', 'selected')),
  client_ids          uuid[] NOT NULL DEFAULT '{}',
  -- At most one survey per person in this many days (0 = no limit).
  throttle_days       integer NOT NULL DEFAULT 14,
  reminder_enabled    boolean NOT NULL DEFAULT false,
  reminder_after_days integer NOT NULL DEFAULT 3,
  expiry_days         integer NOT NULL DEFAULT 30,
  -- 'stars' (1 to 5) or 'thumbs' (1 = down, 5 = up).
  scale               text NOT NULL DEFAULT 'stars' CHECK (scale IN ('stars', 'thumbs')),
  -- A score at or below this is "low".
  low_threshold       integer NOT NULL DEFAULT 2,
  alert_user_ids      uuid[] NOT NULL DEFAULT '{}',
  alert_group_ids     uuid[] NOT NULL DEFAULT '{}',
  -- Tickets that reached a trigger status before this moment never get a survey.
  enabled_at          timestamptz,
  updated_by          uuid,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ticket_surveys (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- One survey per ticket, ever: a reopened ticket does not ask the same person again.
  ticket_id          uuid NOT NULL UNIQUE REFERENCES tickets(id) ON DELETE CASCADE,
  client_id          uuid,
  recipient_email    text NOT NULL DEFAULT '',
  recipient_name     text NOT NULL DEFAULT '',
  -- The technician the ticket was assigned to when it was sent.
  technician_user_id uuid,
  -- pending (to send), sent, answered, expired, skipped, failed
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'answered', 'expired', 'skipped', 'failed')),
  skip_reason        text,
  attempts           integer NOT NULL DEFAULT 0,
  next_attempt_at    timestamptz NOT NULL DEFAULT now(),
  last_error         text,
  portal_link        boolean NOT NULL DEFAULT false,
  triggered_at       timestamptz,
  sent_at            timestamptz,
  reminded_at        timestamptz,
  expires_at         timestamptz,
  answered_at        timestamptz,
  answered_via       text,
  score              integer CHECK (score BETWEEN 1 AND 5),
  comment            text,
  low_alerted_at     timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ticket_surveys_due_idx ON ticket_surveys (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS ticket_surveys_recipient_idx ON ticket_surveys (organization_id, lower(recipient_email), sent_at);
CREATE INDEX IF NOT EXISTS ticket_surveys_answered_idx ON ticket_surveys (organization_id, answered_at);
