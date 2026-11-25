-- Where a customer's reply came from, so a reply written in the portal is not shown as an email.
ALTER TABLE ticket_activity ADD COLUMN IF NOT EXISTS via text;
UPDATE ticket_activity a
   SET via = 'portal'
  FROM tickets t
  JOIN portal_accounts pa ON pa.id = t.portal_account_id
 WHERE a.ticket_id = t.id AND a.is_inbound = true AND a.via IS NULL AND a.author = pa.name;

-- What each portal person has already seen, so new replies can be pointed out.
CREATE TABLE IF NOT EXISTS portal_ticket_reads (
  account_id uuid NOT NULL REFERENCES portal_accounts(id) ON DELETE CASCADE,
  ticket_id  uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  read_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, ticket_id)
);

-- The same for each technician.
CREATE TABLE IF NOT EXISTS ticket_staff_reads (
  user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  read_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, ticket_id)
);

-- Reports are one more area of the portal, on by default.
ALTER TABLE portal_settings ALTER COLUMN modules SET DEFAULT ARRAY['dashboard','tickets','devices','invoices','reports']::text[];
UPDATE portal_settings SET modules = array_append(modules, 'reports') WHERE NOT ('reports' = ANY(modules));
