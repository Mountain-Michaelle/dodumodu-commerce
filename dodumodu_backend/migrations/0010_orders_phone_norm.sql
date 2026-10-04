-- Store the canonical phone identity on the order itself.
--
-- WHY THIS IS A PLAIN COLUMN RATHER THAN A GENERATED ONE:
--
-- The obvious alternative - `GENERATED ALWAYS AS (some_sql_function(phone))
-- STORED` - would require writing a SECOND phone normalizer in SQL. That is the
-- exact failure this design refuses: two implementations of "who is this
-- customer" that can disagree. If the SQL rule and the TypeScript rule ever
-- diverge by one digit, a customer's flag, open-order count and ad-match hash
-- silently split into three identities for one person, and nobody sees the bug -
-- they just see worse match rates and a spam flag that misses its own customer.
--
-- So `phone_norm` is written by the application, using the SAME
-- src/shared/normalizePhone.ts every other consumer uses. One implementation, one
-- answer.
--
-- NULL is a normal, expected value: it means the submitted number could not be
-- canonically resolved. Those rows are simply excluded from identity-based checks,
-- which fails OPEN. An unrecognized number is never invented into an identity and
-- never used to refuse anyone.
--
-- The backfill below is deliberately NOT attempted in SQL for the same reason -
-- historical rows were typed by hand in whatever format the customer used
-- ("0801 234 5678"), and only the shared normalizer can be trusted to interpret
-- them. Phase 3 backfills from the application and logs what it cannot resolve.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS phone_norm TEXT;

-- The suspects query groups by this, and the order history looks a customer up by
-- it. A partial index keeps it small: rows that failed to normalize are dead
-- weight in this index, and there is no reason for them to be in it.
CREATE INDEX IF NOT EXISTS idx_orders_phone_norm
  ON orders (phone_norm)
  WHERE phone_norm IS NOT NULL;

-- Suspects groups by identity within a date window.
CREATE INDEX IF NOT EXISTS idx_orders_phone_norm_created
  ON orders (phone_norm, created_at DESC)
  WHERE phone_norm IS NOT NULL;