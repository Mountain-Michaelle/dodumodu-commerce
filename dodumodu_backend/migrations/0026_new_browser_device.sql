-- A browser that passes email code + authenticator code but has no registered device (cookies
-- cleared, new browser, new site address) is no longer locked out: it gets a STRICT session and is
-- registered as a device with created_via = 'new_browser' (visible, and revocable, in the device list).
ALTER TABLE aa_admin_devices DROP CONSTRAINT IF EXISTS aa_admin_devices_created_via_check;
ALTER TABLE aa_admin_devices ADD CONSTRAINT aa_admin_devices_created_via_check
  CHECK (created_via IN ('first_login', 'invite', 'admin_invite', 'operator', 'new_browser'));