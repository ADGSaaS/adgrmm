-- What the tray shows about the IT provider: name, office hours, website, point of contact, after-hours number and a notice.
ALTER TABLE tray_settings
  ADD COLUMN IF NOT EXISTS provider_name     text,
  ADD COLUMN IF NOT EXISTS office_hours      text,
  ADD COLUMN IF NOT EXISTS website           text,
  ADD COLUMN IF NOT EXISTS contact_name      text,
  ADD COLUMN IF NOT EXISTS after_hours_phone text,
  ADD COLUMN IF NOT EXISTS notice            text;
