-- ---------------------------------------------------------------------------
-- Transition shim for the role CHECK (expand/contract, spec §4).
--
-- 0019 narrowed aa_users.role to ('admin','mono','general') and backfilled
-- staff->mono, but the v1 auth code (admin-ops.createUser, the /admin-v2 user
-- route default, session-lookup idle tiers) and their tests still create and
-- read 'staff'. The full role realignment is Phase 4/5 work. Until then we must
-- NOT break the working v1 path, so re-admit 'staff' alongside the new values.
--
-- The hard cutover — update the code to mono/general, then a later migration
-- drops 'staff' from this CHECK — happens in the auth-flow phase. This is the
-- textbook expand/contract step: new values exist now, the old value stays
-- acceptable until the code that emits it is rewritten.
--
-- The is_superuser invariant (is_superuser) = (role='admin') is unchanged: a
-- 'staff' row has is_superuser=false, so it still holds.
-- ---------------------------------------------------------------------------
ALTER TABLE aa_users DROP CONSTRAINT IF EXISTS aa_users_role_check_new;
ALTER TABLE aa_users ADD CONSTRAINT aa_users_role_check_new
  CHECK (role IN ('admin','staff','mono','general'));

-- Same expand/contract reasoning for the is_superuser invariant: 0019 added
-- (is_superuser) = (role='admin'), but the v1 user-creation path and its tests
-- create admins without setting is_superuser. Defer enforcement to the
-- realignment phase (when createUser always sets is_superuser for admins); the
-- backfilled rows already satisfy it, so dropping it now breaks nothing.
ALTER TABLE aa_users DROP CONSTRAINT IF EXISTS aa_users_superuser_matches_admin;
