-- One emailed-code challenge per (user, browser) instead of one per user.
-- Before: any browser that requested a code replaced the user's single challenge, so a stranger (or
-- the user's other browser) invalidated the code already sitting in the real user's inbox.
-- slot = 'v:<vid hash>' (the browser) or 'i:<network hash>' (a client with no cookie).
ALTER TABLE aa_login_challenges ADD COLUMN IF NOT EXISTS slot text NOT NULL DEFAULT '';
DO $$
DECLARE n text;
BEGIN
  SELECT conname INTO n FROM pg_constraint
   WHERE conrelid = 'aa_login_challenges'::regclass AND contype = 'p';
  IF n IS NOT NULL THEN
    EXECUTE format('ALTER TABLE aa_login_challenges DROP CONSTRAINT %I', n);
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_aa_login_challenges_user_slot ON aa_login_challenges (user_id, slot);
