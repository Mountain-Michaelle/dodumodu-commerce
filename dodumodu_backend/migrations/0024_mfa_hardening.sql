-- 0024_mfa_hardening.sql — additive only (no column is dropped, renamed or retyped).
--
-- 1) TOTP replay protection that never false-rejects the real user.
--    aa_users.totp_last_step already records the newest consumed 30s step. These two
--    columns record WHO consumed it, so the SAME browser (vid) or the SAME login flow
--    can legitimately repeat that step (lost response / retry on a bad network),
--    while any other browser presenting an already-used code is rejected.
-- 2) aa_backup_codes.used_flow_id lets a retry of an already-consumed backup code on
--    the SAME flow return the same success instead of a false 401.
-- 3) aa_auth_flows.trusted marks an email-path flow that arrived with a cookie-matched
--    (first-configured / active) admin device. Untrusted browsers get the strict
--    "3rd failure blocks the device" rule; trusted ones keep default throttling.
ALTER TABLE aa_users       ADD COLUMN IF NOT EXISTS totp_last_vid  bytea;
ALTER TABLE aa_users       ADD COLUMN IF NOT EXISTS totp_last_flow uuid;
ALTER TABLE aa_backup_codes ADD COLUMN IF NOT EXISTS used_flow_id  uuid;
ALTER TABLE aa_auth_flows  ADD COLUMN IF NOT EXISTS trusted        boolean NOT NULL DEFAULT false;