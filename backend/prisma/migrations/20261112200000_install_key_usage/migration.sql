-- How many times an install key has been used to enroll a device, so a key that is still in use is easy to tell from a forgotten one.
ALTER TABLE site_enrollment_keys ADD COLUMN IF NOT EXISTS use_count integer NOT NULL DEFAULT 0;
