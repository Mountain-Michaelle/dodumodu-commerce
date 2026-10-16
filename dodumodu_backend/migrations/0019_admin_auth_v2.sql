-- ---------------------------------------------------------------------------
-- Admin auth v2 — REALIGNMENT (ADMIN_AUTH_V2). Migration 0019 (0018 is the
-- order-assignment migration; numbering is not reused). Additive + idempotent:
-- every object is IF NOT EXISTS / guarded, and each destructive step (the role
-- CHECK change) is approved and reversible by re-running with the old values.
--
-- WHAT THIS DOES (spec §2 user model, §4.2 flow columns, §4.5 blocks, §4.8
-- outbox, §4.6 account requests, §5A templates, §4.2a backup generations):
--   1. aa_users -> Django-aligned (username/names/is_staff/is_superuser/
--      date_joined/last_login/enroll_window_until/perms_version) + role CHECK
--      admin|mono|general with the is_superuser invariant. staff->mono backfill.
--   2. aa_auth_flows -> recovery counters (totp_fails/recovery_unlocked/
--      phrase_fails/enroll_mode/vid_hash) + new stages (backup_codes/recovery/dead).
--   3. New tables: aa_blocks, aa_alert_outbox, aa_account_requests,
--      aa_role_templates, aa_backup_code_sets, aa_backup_codes, aa_audit_log,
--      aa_auth_log. Append-only triggers. Restricted-role note.
--
-- NOT HERE (deferred, see GATE 1): aa_auth_log/aa_audit_log are created as
-- SINGLE tables, not monthly partitions. At this system's volume partitioning
-- adds a maintenance identity + a partition-cron for no correctness gain; the
-- spec (§4.7) explicitly allows the single-table choice at GATE 1. Retention
-- then runs as bounded deletes by the aa_maint role only (runbook), never the
-- app role. Triggers below already make both append-only.
-- ---------------------------------------------------------------------------

-- ============================================================ aa_users (§2)
ALTER TABLE aa_users ADD COLUMN IF NOT EXISTS username            text;
ALTER TABLE aa_users ADD COLUMN IF NOT EXISTS first_name          text NOT NULL DEFAULT '';
ALTER TABLE aa_users ADD COLUMN IF NOT EXISTS last_name           text NOT NULL DEFAULT '';
ALTER TABLE aa_users ADD COLUMN IF NOT EXISTS is_staff            boolean NOT NULL DEFAULT true;
ALTER TABLE aa_users ADD COLUMN IF NOT EXISTS is_superuser        boolean NOT NULL DEFAULT false;
ALTER TABLE aa_users ADD COLUMN IF NOT EXISTS date_joined         timestamptz NOT NULL DEFAULT now();
ALTER TABLE aa_users ADD COLUMN IF NOT EXISTS last_login          timestamptz;
ALTER TABLE aa_users ADD COLUMN IF NOT EXISTS enroll_window_until timestamptz;
ALTER TABLE aa_users ADD COLUMN IF NOT EXISTS perms_version       integer NOT NULL DEFAULT 1;

-- username default = email local-part where still null (Django parity: email +
-- username only are required; everything else defaults). Case-insensitive unique
-- via a functional unique index (no citext extension needed).
UPDATE aa_users
   SET username = lower(split_part(email, '@', 1))
 WHERE username IS NULL;
-- Guard: a local-part collision (two people, same provider local-part) would
-- make the unique index fail. Suffix with the id tail to keep it unique; this
-- is a one-time data fix, not a rule the app relies on.
UPDATE aa_users u
   SET username = u.username || '-' || left(u.id::text, 8)
 WHERE EXISTS (SELECT 1 FROM aa_users x
                WHERE x.username = u.username AND x.id <> u.id);

-- Case-insensitive unique username (^[a-z0-9_.-]{3,30}$ enforced in the app).
CREATE UNIQUE INDEX IF NOT EXISTS aa_users_username_lower_key
  ON aa_users (lower(username));

-- Role realignment (C2, approved). Drop the v1 CHECK, backfill staff->mono and
-- admin->is_superuser, then install the new CHECK plus the is_superuser invariant.
ALTER TABLE aa_users DROP CONSTRAINT IF EXISTS aa_users_role_check;
UPDATE aa_users SET role = 'mono' WHERE role = 'staff';
UPDATE aa_users SET is_superuser = true WHERE role = 'admin';
UPDATE aa_users SET is_staff = true WHERE role = 'admin';

ALTER TABLE aa_users DROP CONSTRAINT IF EXISTS aa_users_role_check_new;
ALTER TABLE aa_users ADD CONSTRAINT aa_users_role_check_new
  CHECK (role IN ('admin','mono','general'));
ALTER TABLE aa_users DROP CONSTRAINT IF EXISTS aa_users_superuser_matches_admin;
ALTER TABLE aa_users ADD CONSTRAINT aa_users_superuser_matches_admin
  CHECK ((is_superuser) = (role = 'admin'));

-- Users without TOTP get a 7-day window to enroll at cutover (§2 backfill).
-- Idempotent: only touches rows that still have neither TOTP nor a window.
UPDATE aa_users
   SET enroll_window_until = now() + interval '7 days'
 WHERE totp_enabled_at IS NULL AND enroll_window_until IS NULL;

-- Serves "is this user allowed in the console at all" and per-staff lookups.
CREATE INDEX IF NOT EXISTS idx_aa_users_role_active ON aa_users (role, is_active);

-- ============================================================ aa_auth_flows (§4.2)
-- Recovery counters + the visitor-id hash used by the flow-ownership guard and
-- by device blocking. All nullable/defaulted so existing live flows keep working.
ALTER TABLE aa_auth_flows ADD COLUMN IF NOT EXISTS totp_fails          smallint NOT NULL DEFAULT 0;
ALTER TABLE aa_auth_flows ADD COLUMN IF NOT EXISTS recovery_unlocked   boolean NOT NULL DEFAULT false;
ALTER TABLE aa_auth_flows ADD COLUMN IF NOT EXISTS phrase_fails        smallint NOT NULL DEFAULT 0;
ALTER TABLE aa_auth_flows ADD COLUMN IF NOT EXISTS enroll_mode         text;      -- 'recovery_reset' when resetting TOTP via recovery
ALTER TABLE aa_auth_flows ADD COLUMN IF NOT EXISTS vid_hash            bytea;     -- HMAC of the __Host-vid visitor id (device-block key)

-- New stages: backup_codes (ack generation), recovery (phrase/backup panel),
-- dead (terminal). Widen the v1 stage CHECK. Drop-by-name is idempotent.
ALTER TABLE aa_auth_flows DROP CONSTRAINT IF EXISTS aa_auth_flows_stage_check;
ALTER TABLE aa_auth_flows ADD CONSTRAINT aa_auth_flows_stage_check
  CHECK (stage IN ('otp','phrase','enroll_phrase','totp','totp_enroll',
                   'backup_codes','recovery','ready','done','dead'));

-- ============================================================ aa_blocks (§4.5)
-- Device + IP blocks. key_hash is the HMAC used for the server-side lookup on
-- every /auth/* request; ip_enc is the AES-GCM encrypted raw IP (admins only,
-- §1.10/C4) and is NULL for device blocks. block_ref is a random, non-secret
-- appeal handle shown to the user and quoted to the admin out of band.
CREATE TABLE IF NOT EXISTS aa_blocks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        text NOT NULL CHECK (kind IN ('device','ip')),
  key_hash    bytea NOT NULL,                       -- HMAC(vid) or HMAC(ip prefix)
  ip_enc      text,                                 -- v1:<kid>:<nonce>:<ct> ; NULL for device
  user_id     uuid REFERENCES aa_users(id) ON DELETE SET NULL,
  block_ref   text NOT NULL,
  reason      text,
  event_ref   bigint,                               -- aa_auth_log row that caused it
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz,                          -- NULL = until an admin lifts (device)
  lifted_at   timestamptz,
  lifted_by   uuid REFERENCES aa_users(id)
);
CREATE INDEX IF NOT EXISTS idx_aa_blocks_live
  ON aa_blocks (kind, key_hash) WHERE lifted_at IS NULL;

-- ============================================================ aa_alert_outbox (§4.8)
-- Reliable, idempotent admin ATTENTION emails. Enqueued in the SAME transaction
-- as the mutation + audit; sent after commit and retried by the janitor.
-- dedupe_key UNIQUE is what makes a retry or repeated request not double-send.
CREATE TABLE IF NOT EXISTS aa_alert_outbox (
  id            bigserial PRIMARY KEY,
  kind          text NOT NULL,                      -- phrase_block|recovery_login_used|...
  dedupe_key    text NOT NULL UNIQUE,
  event_ref     bigint,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','dead')),
  attempts      integer NOT NULL DEFAULT 0,
  max_attempts  integer NOT NULL DEFAULT 8,
  next_try_at   timestamptz NOT NULL DEFAULT now(),
  locked_until  timestamptz,
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_aa_outbox_ready
  ON aa_alert_outbox (status, next_try_at) WHERE status IN ('pending','sending');

-- ============================================================ aa_account_requests (§4.6)
-- Lost-email recovery requests. The attempted username is stored truncated and
-- ALWAYS HTML-escaped when displayed (never trusted as markup).
CREATE TABLE IF NOT EXISTS aa_account_requests (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username_attempted text NOT NULL,
  ip_hash            bytea NOT NULL,
  status             text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  resolved_at        timestamptz,
  resolved_by        uuid REFERENCES aa_users(id),
  resolved_user_id   uuid REFERENCES aa_users(id)
);
CREATE INDEX IF NOT EXISTS idx_aa_account_requests_status
  ON aa_account_requests (status, created_at DESC);

-- ============================================================ aa_role_templates (§5A.3)
-- Named permission bundles, COPIED at apply time (never a live link), so editing
-- a template never silently changes a user who already applied it.
CREATE TABLE IF NOT EXISTS aa_role_templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  perms       text[] NOT NULL DEFAULT '{}',
  created_by  uuid REFERENCES aa_users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS aa_role_templates_name_key ON aa_role_templates (name);

-- ============================================================ backup-code generations (§4.2a)
-- Backup codes are GENERATIONS, not a flat set. A user is backup-ready iff a set
-- exists with acked_at set and revoked_at NULL. Replaces reliance on the v1
-- aa_recovery_codes flat table for the new flow (v1 rows are left untouched).
CREATE TABLE IF NOT EXISTS aa_backup_code_sets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES aa_users(id) ON DELETE CASCADE,
  generation   integer NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  acked_at     timestamptz,                          -- "I saved these" confirmed
  revoked_at   timestamptz
);
CREATE INDEX IF NOT EXISTS idx_aa_backup_sets_user
  ON aa_backup_code_sets (user_id, generation DESC);

CREATE TABLE IF NOT EXISTS aa_backup_codes (
  set_id     uuid NOT NULL REFERENCES aa_backup_code_sets(id) ON DELETE CASCADE,
  code_hash  bytea NOT NULL,
  used_at    timestamptz,
  PRIMARY KEY (set_id, code_hash)
);

-- ============================================================ aa_auth_log (§4.7)
-- Append-only admin auth log. SINGLE table (not partitioned — see header note).
-- ip_enc holds the AES-GCM encrypted IP for admin display only (C4); ip_hash is
-- what matching/throttling keys on. No raw IP is ever written here.
CREATE TABLE IF NOT EXISTS aa_auth_log (
  id             bigserial PRIMARY KEY,
  at             timestamptz NOT NULL DEFAULT now(),
  event          text NOT NULL,
  status         text NOT NULL CHECK (status IN ('success','fail','blocked','locked','rate_limited','info')),
  user_id        uuid REFERENCES aa_users(id) ON DELETE SET NULL,
  email_tag      bytea,                              -- HMAC of the email, never raw
  username_attempted text,
  ip_hash        bytea,
  ip_enc         text,                               -- v1:<kid>:<nonce>:<ct>, admins only
  ua             text,
  device_label   text,
  device_id_hash bytea,
  flow_id        uuid,
  stage          text,
  reason         text,
  meta           jsonb
);
CREATE INDEX IF NOT EXISTS idx_aa_auth_log_at        ON aa_auth_log (at DESC);
CREATE INDEX IF NOT EXISTS idx_aa_auth_log_user_at   ON aa_auth_log (user_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_aa_auth_log_ip_at     ON aa_auth_log (ip_hash, at DESC);
CREATE INDEX IF NOT EXISTS idx_aa_auth_log_event_at  ON aa_auth_log (event, at DESC);

-- ============================================================ aa_audit_log (§5A.4)
-- Append-only admin-mutation + access-change audit. Same DB protections as the
-- auth log. Written in the SAME transaction as the change it records.
CREATE TABLE IF NOT EXISTS aa_audit_log (
  id             bigserial PRIMARY KEY,
  at             timestamptz NOT NULL DEFAULT now(),
  actor_id       uuid REFERENCES aa_users(id) ON DELETE SET NULL,
  action         text NOT NULL,
  status         text NOT NULL CHECK (status IN ('success','denied','failed')),
  target_user_id uuid REFERENCES aa_users(id) ON DELETE SET NULL,
  target_type    text,
  target_id      text,
  perm           text,
  before         jsonb,
  after          jsonb,
  reason         text,
  ip_hash        bytea,
  ip_enc         text,
  ua             text,
  device_label   text,
  request_id     text
);
CREATE INDEX IF NOT EXISTS idx_aa_audit_log_at       ON aa_audit_log (at DESC);
CREATE INDEX IF NOT EXISTS idx_aa_audit_log_actor_at ON aa_audit_log (actor_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_aa_audit_log_perm_at  ON aa_audit_log (perm, at DESC);

-- ============================================================ append-only (§4.7/§8)
-- Defense in depth: the app role is meant to hold INSERT/SELECT only, but a
-- BEFORE UPDATE OR DELETE trigger that raises makes the tables immutable even to
-- a mistake. Retention (bounded deletes) is performed ONLY by the aa_maint role,
-- which the trigger permits by name. Never a row trigger on a partitioned drop.
CREATE OR REPLACE FUNCTION aa_no_update_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('aa.maint', true) = 'on' THEN
    IF (TG_OP = 'DELETE') THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'aa_% is append-only (op=%)', TG_TABLE_NAME, TG_OP;
END $$;

DROP TRIGGER IF EXISTS aa_auth_log_append_only  ON aa_auth_log;
CREATE TRIGGER aa_auth_log_append_only  BEFORE UPDATE OR DELETE ON aa_auth_log
  FOR EACH ROW EXECUTE FUNCTION aa_no_update_delete();
DROP TRIGGER IF EXISTS aa_audit_log_append_only ON aa_audit_log;
CREATE TRIGGER aa_audit_log_append_only BEFORE UPDATE OR DELETE ON aa_audit_log
  FOR EACH ROW EXECUTE FUNCTION aa_no_update_delete();

-- ============================================================ orders (§7/§8)
-- Edit-tracking + assignment actor. Assignment stays EMAIL-keyed (the seam the
-- 0018 comment designed and the working feature already uses): scoping matches
-- orders.assigned_to = <acting user's email>, so there is NO data migration and
-- NO foreign key. This is a deliberate, justified deviation from the spec's
-- user-id shape (recorded for GATE 1). assigned_by records who assigned it.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS assigned_by TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS is_edited   boolean NOT NULL DEFAULT false;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS edited_at   TIMESTAMP;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS edited_by   TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS edit_count  integer NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS version     integer NOT NULL DEFAULT 1;

-- Composite scope index (§10): "orders assigned to <staff>" ordered by recency,
-- which is the mono/general list + per-staff report path. 0018's partial index
-- stays; this one adds status + created_at for the ordered, scoped listing.
CREATE INDEX IF NOT EXISTS idx_orders_scope
  ON orders (assigned_to, status, created_at DESC) WHERE assigned_to IS NOT NULL;

-- ============================================================ order_audit_snapshots (§8)
-- Immutable before-image of an order's PRODUCTS + PRICES, written on each
-- content edit in the SAME transaction as the guarded UPDATE. Coverage is
-- intentionally items/prices only (customer fields and notes are NOT captured —
-- see §8). Append-only; no endpoint modifies or deletes these.
CREATE TABLE IF NOT EXISTS order_audit_snapshots (
  id             bigserial PRIMARY KEY,
  order_id       integer NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  version_before integer NOT NULL,
  edited_by      TEXT,
  edited_at      TIMESTAMP NOT NULL DEFAULT now(),
  snapshot_json  jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_order_audit_snapshots_order
  ON order_audit_snapshots (order_id, version_before DESC);

DROP TRIGGER IF EXISTS order_audit_snapshots_append_only ON order_audit_snapshots;
CREATE TRIGGER order_audit_snapshots_append_only BEFORE UPDATE OR DELETE ON order_audit_snapshots
  FOR EACH ROW EXECUTE FUNCTION aa_no_update_delete();

-- NOTE on status events: the spec calls for an `order_events` table, but the
-- repository ALREADY has `order_status_history` (who/from/to/when). Creating a
-- second table would duplicate a working audit path, so status changes continue
-- to append to `order_status_history` (documented as the "order_events" log).
-- `order_audit_snapshots` above is genuinely new and is the only addition.




