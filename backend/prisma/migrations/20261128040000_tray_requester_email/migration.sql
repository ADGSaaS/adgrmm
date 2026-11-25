-- The email address a person gave when they submitted a ticket from the tray: where technicians' replies are emailed.
ALTER TABLE tray_help_requests ADD COLUMN IF NOT EXISTS requester_email text;
