-- Admin auth v2 (ADMIN_AUTH_V2) — additive only, everything new is aa_-prefixed.
-- Implements docs/admin-auth/IMPLEMENT.md Appendices A + F1 (schema) and the
-- functions from B, E7 and F2, plus atomic wrappers for the two-statement
-- transactions (E4, F3) and the advisory-lock guarded statements (C, E6, F3).
--
-- WHY THE WRAPPERS EXIST: the Worker talks to Neon over HTTP, which has no
-- multi-statement transaction API for the app (recon note item 2). The spec's
-- "two statements in ONE transaction" (PHRASE_RESET_CREATE, DEVICE_INVITE_CREATE)
-- and "advisory lock + guarded statement" (demote, deactivate, device revoke)
-- are therefore single PL/pgSQL functions: one round trip, one transaction,
-- same statements inside. Everything else below is copied verbatim from the
-- appendices.
--
-- Migration number: 0017 (repo convention: additive files only, never edited
-- after applying).

-- ============================================================ Appendix A
-- Auth schema (PostgreSQL / Neon). Phrase hash lives in aa_users.phrase_hash.
CREATE TABLE aa_users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           text NOT NULL UNIQUE CHECK (email = lower(btrim(email))),
  phrase_hash     text,                                   -- Argon2id PHC string; NULL until enrolled
  role            text NOT NULL DEFAULT 'staff' CHECK (role IN ('admin','staff')),
  is_active       boolean NOT NULL DEFAULT true,
  session_version integer NOT NULL DEFAULT 1,             -- bump to kill every session of this user
  totp_secret_enc text,                                   -- AES-GCM encrypted, admins only
  totp_enabled_at timestamptz,
  totp_last_step  bigint,                                 -- anti-replay
  created_by      uuid REFERENCES aa_users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE aa_user_permissions (
  user_id    uuid NOT NULL REFERENCES aa_users(id) ON DELETE CASCADE,
  perm       text NOT NULL,                               -- must exist in the PERMISSIONS registry (app-enforced)
  granted_by uuid REFERENCES aa_users(id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, perm)
);

-- One row per user, reused. Unexpired row = same code (idempotent send).
CREATE TABLE aa_login_challenges (
  user_id      uuid PRIMARY KEY REFERENCES aa_users(id) ON DELETE CASCADE,
  nonce        bytea NOT NULL,                            -- code = f(HMAC(OTP_KEY, user_id || nonce)); no plaintext stored
  code_mac     bytea NOT NULL,                            -- HMAC(OTP_KEY, "mac:" || user_id || ":" || code)
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz,
  send_count   smallint NOT NULL DEFAULT 1,
  last_sent_at timestamptz NOT NULL DEFAULT now()
);

-- Server-side login state machine. email kept even for unknown emails (user_id NULL).
CREATE TABLE aa_auth_flows (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash bytea NOT NULL UNIQUE,
  email      text NOT NULL,
  user_id    uuid REFERENCES aa_users(id) ON DELETE CASCADE,
  pending_totp_enc text,                                  -- admin TOTP secret awaiting first valid code
  stage      text NOT NULL CHECK (stage IN ('otp','phrase','enroll_phrase','totp','totp_enroll','ready','done')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE aa_sessions (
  id_hash             bytea PRIMARY KEY,
  user_id             uuid NOT NULL REFERENCES aa_users(id) ON DELETE CASCADE,
  session_version     integer NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  absolute_expires_at timestamptz NOT NULL,
  sid                 uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,  -- public handle for "my sessions"; never the token hash
  stepup_until        timestamptz,                                      -- fresh re-authentication window for sensitive actions
  ip                  text,
  ua                  text                                              -- truncated user agent, display only
);
CREATE INDEX aa_sessions_user_idx ON aa_sessions (user_id);

CREATE TABLE aa_phrase_resets (
  token_hash bytea PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES aa_users(id) ON DELETE CASCADE,
  created_by uuid REFERENCES aa_users(id),
  expires_at timestamptz NOT NULL,
  used_at    timestamptz
);
CREATE UNIQUE INDEX aa_phrase_resets_one_active ON aa_phrase_resets (user_id) WHERE used_at IS NULL;

CREATE TABLE aa_recovery_codes (
  user_id   uuid NOT NULL REFERENCES aa_users(id) ON DELETE CASCADE,
  code_hash bytea NOT NULL,
  used_at   timestamptz,
  PRIMARY KEY (user_id, code_hash)
);

CREATE TABLE aa_auth_throttle (
  key          text PRIMARY KEY,                          -- "otp:<hmac(email)>:<ip>", "fuse:<hmac(email)>", "send:..."
  thr          smallint NOT NULL,                         -- failures per round (3 pair, 9 fuse) or the send-cap limit
  fails        smallint NOT NULL,
  round        integer  NOT NULL,
  locked_until timestamptz,
  last_fail_at timestamptz NOT NULL                       -- for send-cap keys this is the window START (see E7)
);

CREATE TABLE aa_audit_events (
  id        bigserial PRIMARY KEY,
  at        timestamptz NOT NULL DEFAULT now(),
  actor_id  uuid,
  target_id uuid,
  event     text NOT NULL,
  ip        text,
  meta      jsonb                                         -- never codes, phrases or free-text reasons
);
CREATE INDEX aa_audit_target_idx ON aa_audit_events (target_id, at DESC);

-- ============================================================ Appendix F1
ALTER TABLE aa_users ADD COLUMN device_window_until timestamptz;   -- open = first admin device may be claimed

CREATE TABLE aa_admin_devices (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES aa_users(id) ON DELETE CASCADE,
  token_hash     bytea NOT NULL UNIQUE,                          -- SHA-256 of the __Host-did token
  status         text NOT NULL CHECK (status IN ('pending','active','revoked')),
  label          text,                                           -- truncated user agent, display only
  created_via    text NOT NULL CHECK (created_via IN ('first_login','invite','admin_invite','operator')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,                           -- sliding
  pending_until  timestamptz,
  revoked_at     timestamptz,
  last_ip        text,
  last_ip_prefix text,
  last_country   text
);
CREATE INDEX aa_admin_devices_user_idx ON aa_admin_devices (user_id) WHERE status <> 'revoked';

CREATE TABLE aa_device_invites (
  token_hash bytea PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES aa_users(id) ON DELETE CASCADE,   -- the admin the device is for
  created_by uuid NOT NULL REFERENCES aa_users(id),
  expires_at timestamptz NOT NULL,
  used_at    timestamptz
);
CREATE UNIQUE INDEX aa_device_invites_one_active ON aa_device_invites (user_id) WHERE used_at IS NULL;

ALTER TABLE aa_auth_flows ADD COLUMN device_id uuid REFERENCES aa_admin_devices(id) ON DELETE SET NULL,
                          ADD COLUMN via text NOT NULL DEFAULT 'email' CHECK (via IN ('email','device','resume')),
                          ADD COLUMN resume_hash bytea,
                          ADD COLUMN ip_prefix text, ADD COLUMN country text;
ALTER TABLE aa_sessions   ADD COLUMN device_id uuid REFERENCES aa_admin_devices(id) ON DELETE SET NULL,
                          ADD COLUMN login_via text NOT NULL DEFAULT 'email' CHECK (login_via IN ('email','device')),
                          ADD COLUMN ip_prefix text, ADD COLUMN country text,
                          ADD COLUMN tier text NOT NULL DEFAULT 'normal' CHECK (tier IN ('normal','strict')),
                          ADD COLUMN drift_count smallint NOT NULL DEFAULT 0, ADD COLUMN drift_at timestamptz,
                          ADD COLUMN resume_hash bytea UNIQUE;     -- hash of the __Host-rid cookie; the resume right

-- ============================================================ Appendix B
-- One failed-attempt reservation for one key. Atomic per row (ON CONFLICT row lock).
-- Escalation: every p_thr reserved attempts => lock for LEAST(step * round, max) minutes.
CREATE OR REPLACE FUNCTION aa_auth_bump(
  p_key text, p_thr int,
  p_step_min int DEFAULT 10, p_max_min int DEFAULT 1440, p_decay interval DEFAULT '24 hours'
) RETURNS TABLE (allowed boolean, locked_until timestamptz)
LANGUAGE plpgsql AS $$
DECLARE r aa_auth_throttle%ROWTYPE;
BEGIN
  -- quiet period: forget old failures and the round counter
  UPDATE aa_auth_throttle t SET fails = 0, round = 0, locked_until = NULL
   WHERE t.key = p_key AND t.last_fail_at < now() - p_decay;

  INSERT INTO aa_auth_throttle AS t (key, thr, fails, round, locked_until, last_fail_at)
  VALUES (p_key, p_thr, 1, 0, NULL, now())
  ON CONFLICT (key) DO UPDATE SET
    thr          = EXCLUDED.thr,
    fails        = CASE WHEN t.fails + 1 >= EXCLUDED.thr THEN 0 ELSE t.fails + 1 END,
    round        = CASE WHEN t.fails + 1 >= EXCLUDED.thr THEN t.round + 1 ELSE t.round END,
    locked_until = CASE WHEN t.fails + 1 >= EXCLUDED.thr
                        THEN now() + make_interval(mins => LEAST(p_step_min * (t.round + 1), p_max_min))
                        ELSE t.locked_until END,
    last_fail_at = now()
  WHERE t.locked_until IS NULL OR t.locked_until <= now()   -- evaluated on the locked, latest row version
  RETURNING * INTO r;

  IF FOUND THEN
    RETURN QUERY SELECT true, CASE WHEN r.locked_until > now() THEN r.locked_until END;
  ELSE
    RETURN QUERY SELECT false, (SELECT x.locked_until FROM aa_auth_throttle x WHERE x.key = p_key);
  END IF;
END $$;

-- ============================================================ Appendix E7
-- Hourly send caps for `send:` keys. Returns true if this send is allowed, false if the cap is reached.
-- Fixed window: last_fail_at holds the window START and is NOT moved by later calls, so a steady stream cannot extend
-- the window. After p_window the count restarts. Nothing here ever sets locked_until.
CREATE OR REPLACE FUNCTION aa_auth_send_cap(p_key text, p_limit int, p_window interval DEFAULT '1 hour')
RETURNS boolean LANGUAGE sql AS $$
  WITH i AS (
    INSERT INTO aa_auth_throttle AS t (key, thr, fails, round, locked_until, last_fail_at)
    VALUES (p_key, p_limit, 1, 0, NULL, now())
    ON CONFLICT (key) DO UPDATE SET
      thr          = EXCLUDED.thr,
      fails        = CASE WHEN t.last_fail_at < now() - p_window THEN 1 ELSE t.fails + 1 END,
      last_fail_at = CASE WHEN t.last_fail_at < now() - p_window THEN now() ELSE t.last_fail_at END
    WHERE t.last_fail_at < now() - p_window OR t.fails < p_limit
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM i);
$$;

-- ============================================================ Appendix F2
-- Reserve on ONE key only (pair, trusted-device key or strict key). Never returns a lock caused by another client.
CREATE OR REPLACE FUNCTION aa_auth_reserve_v2(p_key text, p_thr int, p_step_min int, p_max_min int)
RETURNS TABLE (allowed boolean, locked_until timestamptz)
LANGUAGE sql AS $$ SELECT * FROM aa_auth_bump(p_key, p_thr, p_step_min, p_max_min); $$;

-- Non-blocking per-email counter. Returns true when friction (audit event, alert email) should be on.
CREATE OR REPLACE FUNCTION aa_auth_fuse_note(p_key text, p_thr int DEFAULT 9, p_decay interval DEFAULT '1 hour')
RETURNS boolean LANGUAGE sql AS $$
  INSERT INTO aa_auth_throttle AS t (key, thr, fails, round, locked_until, last_fail_at)
  VALUES (p_key, p_thr, 1, 0, NULL, now())
  ON CONFLICT (key) DO UPDATE SET
    fails        = CASE WHEN t.last_fail_at < now() - p_decay THEN 1 ELSE LEAST(t.fails + 1, 32000) END,
    last_fail_at = now()
  RETURNING t.fails >= p_thr;
$$;

-- Refund ONE reservation after a server fault of ours. p_lock = the locked_until that reservation returned (NULL if none).
-- Never call for a wrong answer or a client abort.
CREATE OR REPLACE FUNCTION aa_auth_refund(p_key text, p_lock timestamptz DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE n int;
BEGIN
  IF p_lock IS NULL THEN
    UPDATE aa_auth_throttle SET fails = GREATEST(fails - 1, 0)
     WHERE key = p_key AND fails > 0 AND (locked_until IS NULL OR locked_until <= now());
  ELSE   -- that reservation tripped the lock: undo it only if the lock is still exactly that one
    UPDATE aa_auth_throttle SET fails = thr - 1, round = GREATEST(round - 1, 0), locked_until = NULL
     WHERE key = p_key AND locked_until = p_lock;
  END IF;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n = 1;
END $$;

-- ============================================================ Atomic wrappers (spec fixes; see header)
-- E4 PHRASE_RESET_CREATE: "Statement 1 and 2 run in ONE transaction."
CREATE OR REPLACE FUNCTION aa_phrase_reset_create(
  p_user_id uuid, p_token_hash bytea, p_created_by uuid, p_ttl_secs int
) RETURNS bytea LANGUAGE plpgsql AS $$
DECLARE v bytea;
BEGIN
  DELETE FROM aa_phrase_resets WHERE user_id = p_user_id AND used_at IS NULL;

  INSERT INTO aa_phrase_resets (token_hash, user_id, created_by, expires_at)
  SELECT p_token_hash, u.id, p_created_by, now() + make_interval(secs => p_ttl_secs::float8)
    FROM aa_users u WHERE u.id = p_user_id AND u.is_active
  RETURNING token_hash INTO v;
  RETURN v;
END $$;

-- F3 DEVICE_INVITE_CREATE: "one transaction, two statements, so the unique index never races the delete".
CREATE OR REPLACE FUNCTION aa_device_invite_create(
  p_target_admin_id uuid, p_created_by uuid, p_token_hash bytea, p_ttl_secs int
) RETURNS bytea LANGUAGE plpgsql AS $$
DECLARE v bytea;
BEGIN
  DELETE FROM aa_device_invites WHERE user_id = p_target_admin_id AND used_at IS NULL;

  INSERT INTO aa_device_invites (token_hash, user_id, created_by, expires_at)
  SELECT p_token_hash, u.id, p_created_by, now() + make_interval(secs => p_ttl_secs::float8)
    FROM aa_users u WHERE u.id = p_target_admin_id AND u.role = 'admin' AND u.is_active
  RETURNING token_hash INTO v;
  RETURN v;
END $$;

-- C DEMOTE_ADMIN_GUARDED: 2nd statement of a transaction whose 1st is pg_advisory_xact_lock(7001).
CREATE OR REPLACE FUNCTION aa_demote_admin_guarded(p_target uuid)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(7001);
  UPDATE aa_users SET role = 'staff', session_version = session_version + 1
   WHERE id = p_target AND role = 'admin'
     AND (SELECT count(*) FROM aa_users WHERE role = 'admin' AND is_active) > 1
  RETURNING id INTO v;
  RETURN v;
END $$;

-- E6 DEACTIVATE_GUARDED: same advisory lock, refuses to deactivate the last active admin.
CREATE OR REPLACE FUNCTION aa_deactivate_guarded(p_target uuid)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(7001);
  UPDATE aa_users SET is_active = false, session_version = session_version + 1
   WHERE id = p_target AND is_active
     AND (role <> 'admin' OR (SELECT count(*) FROM aa_users WHERE role = 'admin' AND is_active) > 1)
  RETURNING id INTO v;
  RETURN v;
END $$;

-- F3 DEVICE_REVOKE_GUARDED: 2nd statement of a transaction whose 1st is
-- SELECT pg_advisory_xact_lock(hashtextextended($2::text, 7002)); Own last active device is refused.
CREATE OR REPLACE FUNCTION aa_device_revoke_guarded(
  p_device_id uuid, p_owner_user_id uuid, p_acting_is_other_admin boolean
) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_owner_user_id::text, 7002));
  WITH r AS (
    UPDATE aa_admin_devices SET status = 'revoked', revoked_at = now()
     WHERE id = p_device_id AND user_id = p_owner_user_id AND status IN ('active','pending')
       AND (p_acting_is_other_admin OR status = 'pending'
            OR (SELECT count(*) FROM aa_admin_devices x
                 WHERE x.user_id = p_owner_user_id AND x.status = 'active' AND x.id <> p_device_id) >= 1)
    RETURNING id
  ), s AS (DELETE FROM aa_sessions WHERE device_id IN (SELECT id FROM r))
  SELECT id FROM r INTO v;
  RETURN v;
END $$;



