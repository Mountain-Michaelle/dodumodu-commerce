-- Manual spam moderation: an explicit, human decision, kept entirely separate
-- from the order lifecycle.
--
-- THE SEPARATION THIS FILE ENFORCES, and the reason it matters:
--
--   A spam flag is NOT an order status. An order can be `awaiting_payment` while
--   its phone carries an active flag, and flagging an order does not touch
--   orders.status, any payment state, or any fulfilment state. Folding "spam"
--   into the status enum would mean the OPay webhook, reconciliation and the
--   delivery transitions all have to learn about a concept none of them has, and
--   it would make "refused by the customer" and "blocked by the business"
--   indistinguishable in the order history.
--
-- NOTHING HERE IS AUTOMATIC. There is no code path that creates a flag without an
-- authorized admin supplying a meaningful reason. A temporary automatic
-- restriction from the observation layer never produces one: escalating a
-- temporary signal into a permanent record is exactly the kind of irreversible
-- decision this system is built to avoid.
--
-- `phone_norm` is the canonical identity from the ONE shared normalizer. Never a
-- last-8 shortcut: eight digits are not globally unique, and a flag built on one
-- would permanently exclude an unrelated customer who happened to share a suffix.
CREATE TABLE IF NOT EXISTS spam_flags (
  id SERIAL PRIMARY KEY,
  phone_norm TEXT NOT NULL,
  -- Where the suspicion came from. The order is SET NULL if it is ever deleted;
  -- the FLAG is not tied to the order's existence, because the phone is what is
  -- blocked and a phone outlives any one order.
  source_order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  -- Mandatory and enforced by the service, not merely by the schema: "spam" on
  -- its own tells a future reader nothing about why this customer was excluded.
  reason TEXT NOT NULL,
  -- The Cloudflare Access identity. Taken from the request context, never from
  -- the body, so it cannot be forged by an operator or a compromised client.
  flagged_by TEXT NOT NULL,
  flagged_at TIMESTAMP NOT NULL DEFAULT now(),
  -- Reverting FILLS THESE IN. It never deletes the row: "this was flagged, and
  -- then somebody looked again and disagreed" is information worth keeping, and
  -- deleting it would make a repeated mistaken flag indistinguishable from one
  -- that never happened.
  reverted_at TIMESTAMP,
  reverted_by TEXT,
  revert_reason TEXT,
  CONSTRAINT spam_flags_reason_not_blank CHECK (length(trim(reason)) > 0)
);

-- At most ONE active flag per phone. The partial predicate is what allows the
-- full revert history to be kept while still preventing a second active flag:
-- once reverted_at is set, the row leaves the index and the number can be flagged
-- again legitimately.
CREATE UNIQUE INDEX IF NOT EXISTS idx_spam_flags_one_active
  ON spam_flags (phone_norm)
  WHERE reverted_at IS NULL;

-- The order list needs "is this phone currently flagged?" for every row on the
-- page. This makes that a lookup rather than a scan, which matters because that
-- query runs on every page of the admin orders list.
CREATE INDEX IF NOT EXISTS idx_spam_flags_active_phone
  ON spam_flags (phone_norm)
  WHERE reverted_at IS NULL;

-- Revert history reads newest-first.
CREATE INDEX IF NOT EXISTS idx_spam_flags_flagged_at
  ON spam_flags (flagged_at DESC);