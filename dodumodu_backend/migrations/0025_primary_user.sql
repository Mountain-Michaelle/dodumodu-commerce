-- The "main" admin account. Additive: nothing changes until one account is flagged.
-- While no account is flagged, notifications still go to every active admin/staff
-- exactly as before. At most ONE account can be primary (partial unique index).
ALTER TABLE aa_users ADD COLUMN IF NOT EXISTS is_primary boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS uq_aa_users_single_primary ON aa_users ((true)) WHERE is_primary;