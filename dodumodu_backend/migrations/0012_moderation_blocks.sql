-- Burst protection: a device-scoped signal, and the table that records a block.
--
-- WHY NOT A COUNTER. Earlier thinking put velocity in its own counter table. This
-- file counts COMMITTED ORDERS instead, because "how fast did real orders arrive"
-- is a question about the orders themselves. A counter is a second source of truth
-- that can disagree with the orders it is meant to describe - and it cannot answer
-- "how many DISTINCT phone identities" at all, which is the only part of the signal
-- that separates a script from a crowd. One query against `orders` is both simpler
-- and impossible to desynchronise.
--
-- `created_from_ip` ALREADY EXISTS (migration 0011). It is not re-added here.
--
-- WHAT THIS MIGRATION ADDS:
--   orders.device_id     - self-declared by the client; see below
--   orders.client_kind   - a coarse in-app / browser / unknown classification
--   moderation_blocks    - IP and device blocks, manual and automatic
--
-- ON device_id AND FINGERPRINTING. This is NOT a browser fingerprint. Nothing here
-- reads the canvas, the font list, the GPU, or any signal derived from the device's
-- characteristics. The client volunteers one random value and reuses it. That is a
-- deliberate trade: a self-declared id is trivially forged and trivially rotated by
-- anyone who knows it exists, and this schema is shaped around that fact rather than
-- pretending otherwise. The rotating-id bot is a KNOWN GAP, recorded as such in the
-- shadow report, not an oversight.
--
-- WHY THE SCOPE CHECK IS THE IMPORTANT PART OF THIS FILE. `scope` is constrained to
-- 'ip' and 'device'. An automatic block can therefore never become a phone ban or a
-- spam flag, not because the code is careful but because the database refuses the
-- shape. A permanent identity decision about a person belongs to a human with a
-- reason; a burst belongs to a machine and expires.
CREATE TABLE IF NOT EXISTS moderation_blocks (
  id             SERIAL PRIMARY KEY,
  -- 'ip' or 'device'. Never 'phone': see above.
  scope          TEXT NOT NULL,
  value          TEXT NOT NULL,
  -- Non-blank, enforced here rather than only in the service, so a row cannot exist
  -- that records a block without recording why.
  reason         TEXT NOT NULL,
  -- 'manual' (a person) or 'auto_v1' / 'auto_v2' (a burst rule). Kept distinct
  -- because the two have very different consequences and an operator must be able
  -- to tell them apart at a glance.
  source         TEXT NOT NULL,
  blocked_by     TEXT NOT NULL,
  blocked_at     TIMESTAMP NOT NULL DEFAULT now(),
  -- NULL means PERMANENT, and only a manual block may have NULL. Automatic blocks
  -- always carry an expiry; the service enforces that, and the check below is the
  -- backstop.
  expires_at     TIMESTAMP,
  released_at    TIMESTAMP,
  released_by    TEXT,
  release_reason TEXT,
  active         BOOLEAN NOT NULL DEFAULT true,
  -- The full arithmetic for an automatic block: orders, window, phones, devices,
  -- concentration. An operator reading a block later must be able to see WHY it
  -- fired without re-running anything.
  evidence       JSONB,
  CONSTRAINT moderation_blocks_scope_check   CHECK (scope IN ('ip','device')),
  CONSTRAINT moderation_blocks_source_check  CHECK (source IN ('manual','auto_v1','auto_v2')),
  CONSTRAINT moderation_blocks_reason_blank  CHECK (length(trim(reason)) > 0),
  CONSTRAINT moderation_blocks_value_blank   CHECK (length(trim(value)) > 0),
  -- An automatic block must expire. A manual one need not. This is what makes
  -- "auto-blocks are always temporary" a property of the data rather than of the
  -- code path that happened to write the row.
  CONSTRAINT moderation_blocks_auto_expires  CHECK (
    source = 'manual' OR expires_at IS NOT NULL
  )
);

-- One live block per scope+value. THIS INDEX is what makes concurrent block
-- creation safe: twenty simultaneous requests that all decide to block the same
-- address still produce exactly one row, arbitrated by the database rather than by
-- application logic that could race. ON CONFLICT DO NOTHING relies on this.
CREATE UNIQUE INDEX IF NOT EXISTS idx_moderation_blocks_one_active
  ON moderation_blocks (scope, value)
  WHERE active;

-- The admission check is `WHERE active AND (expires_at IS NULL OR expires_at >
-- now())`, so this index carries it.
CREATE INDEX IF NOT EXISTS idx_moderation_blocks_admission
  ON moderation_blocks (active, expires_at);

-- The Blocked screen reads newest-first.
CREATE INDEX IF NOT EXISTS idx_moderation_blocks_blocked_at
  ON moderation_blocks (blocked_at DESC);

-- ── Orders: the two columns the burst rules need ───────────────────────────
-- Additive and nullable. Existing rows are unaffected and backfill to NULL, which
-- is the correct default for both: an order placed before this migration has no
-- device, and one recorded without the header has no address to attribute.
--
-- No table rewrite, no DEFAULT rewrite, no long lock.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS device_id TEXT;

-- A coarse classification, never the raw User-Agent string. The shadow report only
-- ever asks "in-app or not", and storing a full UA on every order would be
-- personal data retained for no benefit. CHECK-constrained so a client cannot
-- invent a fourth category by sending a header value we pass through.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS client_kind TEXT;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_client_kind_check;
ALTER TABLE orders ADD CONSTRAINT orders_client_kind_check
  CHECK (client_kind IS NULL OR client_kind IN ('in_app','browser','unknown'));

-- ── Indexes for the burst queries ────────────────────────────────────────────
-- Both rules are "rows for this subject within the last N seconds", so both are
-- (subject, created_at DESC) range scans. Partial, because the overwhelming
-- majority of rows have NULL here for historical orders, and keeping them out of
-- the index keeps it small.
--
-- (created_from_ip, created_at DESC) is added because migration 0011 indexed
-- created_from_ip ALONE, which cannot serve a time-range scan - it would have to
-- read every order ever placed from that address and filter afterwards.
CREATE INDEX IF NOT EXISTS idx_orders_device_created
  ON orders (device_id, created_at DESC)
  WHERE device_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_orders_ip_created
  ON orders (created_from_ip, created_at DESC)
  WHERE created_from_ip IS NOT NULL;

-- The shadow report's "top orders per minute per address" needs the leading edge
-- of the window regardless of subject. This already exists as idx_orders_created_at_desc.