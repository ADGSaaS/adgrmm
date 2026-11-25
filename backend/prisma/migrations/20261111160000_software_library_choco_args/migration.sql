-- Extra Chocolatey arguments per library entry, for packages whose installer is per user (it would otherwise land in
-- the system account's own profile when the agent, which runs as SYSTEM, installs it).
ALTER TABLE "software_library" ADD COLUMN "chocolatey_params" TEXT;
ALTER TABLE "software_library" ADD COLUMN "chocolatey_install_args" TEXT;

-- Brave's installer is Chromium based and takes --system-level for an all-users install.
UPDATE software_library SET chocolatey_install_args = '--system-level'
 WHERE built_in = true AND name = 'Brave' AND chocolatey_id = 'brave' AND chocolatey_install_args IS NULL;
