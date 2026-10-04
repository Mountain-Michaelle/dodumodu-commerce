-- Order-form abuse protection: observation tables for the shadow phase.
--
-- What this migration does NOT do, deliberately:
--   - It adds no order status. There is no "spam" or "blocked" status here, and
--     adding one would mean rewriting the order state machine that OPay, the
--     reconciliation job and the admin panel all share. Spam is a moderation
--     concern, not a fulfilment one.
--   - It writes nothing to `orders`. Observation lives beside the orders so that
--     deleting or pruning an observation row can never touch a customer's order.
--   - It normalizes no phone numbers. The canonical form is produced in ONE place
--     (src/shared/normalizePhone.ts) and arrives here as an opaque string. A SQL
--     normalizer would be a second implementation that could disagree with the
--     TypeScript one, and a customer whose two spellings resolved differently in
--     two places would be counted as two people.
--
-- Written to survive a re-run, like every migration in this directory.
-- ---------------------------------------------------------------------------

-- Per-IP activity within a fixed window.
--
-- One row per IP per window, replaced when the window rolls over. The unique key
-- is what lets the increment be a single atomic upsert rather than a
-- read-modify-write: concurrent requests all hit the same row and the database
-- serializes them, so no increment is lost. That is the whole reason this is
-- Postgres and not the KV namespace the old limiter used - KV allows one write per
-- second per key, so a burst silently lost counts exactly when they mattered.
CREATE TABLE IF NOT EXISTS abuse_ip_windows (
  ip TEXT NOT NULL,
  window_start BIGINT NOT NULL,
  posts INTEGER NOT NULL DEFAULT 0,
  validation_failures INTEGER NOT NULL DEFAULT 0,
  turnstile_failures INTEGER NOT NULL DEFAULT 0,
  -- Orders from this IP that reached a legitimate progression status. This is the
  -- success interlock: it is what stops a shared mobile carrier address from ever
  -- being treated as abusive no matter how high the failure counts climb.
  successful_progressions INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMP NOT NULL DEFAULT now(),
  PRIMARY KEY (ip, window_start)
);

-- Distinct normalized phones seen from one IP in one window.
--
-- A separate table rather than a column, because "how many different people" is
-- the signal that distinguishes a shared carrier NAT from a flood, and counting
-- distinct values needs its own rows to be exact. `phone_norm` is the canonical
-- E.164 identity from the shared normalizer; it is never the last-8 shortcut,
-- which is not unique and is only ever a search aid.
CREATE TABLE IF NOT EXISTS abuse_ip_phones (
  ip TEXT NOT NULL,
  window_start BIGINT NOT NULL,
  phone_norm TEXT NOT NULL,
  first_seen TIMESTAMP NOT NULL DEFAULT now(),
  PRIMARY KEY (ip, window_start, phone_norm)
);

-- The audit trail for shadow observations and, later, manual spam flags.
--
-- Append-only by intent: an observation of "this request looked like this" is
-- evidence, and rewriting evidence is how a moderation system becomes
-- unaccountable. Rows move from 'observed' to 'flagged' or 'cleared' by an
-- authorized admin, and the reason and identity are kept either way.
CREATE TABLE IF NOT EXISTS abuse_observations (
  id SERIAL PRIMARY KEY,
  ip TEXT,
  -- The canonical identity. NULL when the submitted number could not be resolved:
  -- an unrecognized number is recorded as an observation, never invented into an
  -- identity and never used to refuse anybody.
  phone_norm TEXT,
  outcome TEXT NOT NULL,
  -- What the restriction rule WOULD have said, recorded even while shadow mode
  -- blocks nothing. This is the measurement that justifies going live.
  would_restrict BOOLEAN NOT NULL DEFAULT false,
  reason TEXT,
  order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

-- Reads are always "the newest observations first", optionally filtered by
-- outcome or by would_restrict when reviewing what enforcement would have done.
CREATE INDEX IF NOT EXISTS idx_abuse_observations_created
  ON abuse_observations (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_abuse_observations_would_restrict
  ON abuse_observations (would_restrict, created_at DESC)
  WHERE would_restrict;
-- The suspect/flag lookup is by phone, so it gets its own index rather than
-- relying on the creation index.
CREATE INDEX IF NOT EXISTS idx_abuse_observations_phone
  ON abuse_observations (phone_norm, created_at DESC)
  WHERE phone_norm IS NOT NULL;

-- Order-form rate limiting used to run in KV. It is deliberately NOT recreated
-- here: it keyed on the RAW phone string, so "08012345678" and "+2348012345678"
-- were two different buckets and the limit was bypassable by reformatting.
-- Counter history is kept only as long as a window can still be current.