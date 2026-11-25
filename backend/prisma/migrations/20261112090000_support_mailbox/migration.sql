-- The support mailbox: one Microsoft 365 mailbox per organization that mail is read from (it becomes tickets and
-- ticket replies) and that replies to customers are sent from. Secrets are stored encrypted.
CREATE TABLE IF NOT EXISTS support_mailbox (
  organization_id     uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  enabled             boolean NOT NULL DEFAULT false,
  -- 'microsoft': signed in to Microsoft 365 (OAuth2). 'imap': the IMAP and SMTP login saved under the Tickets purpose.
  source              text NOT NULL DEFAULT 'microsoft' CHECK (source IN ('microsoft', 'imap')),
  tenant_id           text NOT NULL DEFAULT '',
  client_id           text NOT NULL DEFAULT '',
  client_secret       text,
  refresh_token       text,
  mailbox_address     text NOT NULL DEFAULT '',
  connected_at        timestamptz,
  oauth_state         text,
  oauth_state_expires timestamptz,
  oauth_return_to     text,
  last_polled_at      timestamptz,
  last_error          text,
  last_error_at       timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- A reply that arrived by email, as opposed to one a technician typed.
ALTER TABLE ticket_activity ADD COLUMN IF NOT EXISTS is_inbound boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_email_messages_message_id ON email_messages (channel_id, message_id);
