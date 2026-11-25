-- Automatic repair for tickets that do not come from the tray (email, portal, technician): the words of the ticket choose the category. Off by default.
ALTER TABLE auto_repair_settings ADD COLUMN IF NOT EXISTS from_text boolean NOT NULL DEFAULT false;
