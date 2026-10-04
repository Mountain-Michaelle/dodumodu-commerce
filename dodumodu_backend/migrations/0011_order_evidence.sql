-- Link an order to the address it was placed from, so abuse evidence can be shown
-- ON that order rather than only in an aggregate report.
--
-- WHY THIS IS NEEDED: the abuse counters (abuse_ip_windows) are keyed by IP, and
-- orders were not, so there was no way to answer "is there anything unusual around
-- THIS order?" without guessing. One nullable column makes that a direct lookup.
--
-- It is nullable and best-effort: an order placed before this migration, or one
-- created when the header was missing, simply has no address recorded and shows no
-- abuse evidence. That is the correct failure direction - no evidence, not a
-- fabricated one.
--
-- PRIVACY: this is the same address Cloudflare already puts in the request, and it
-- is displayed MASKED everywhere it is shown. It is never used as an identity, never
-- as a permanent restriction key, and never leaves the admin console. It exists so
-- an operator can recognise "this order shares an address with forty others".
ALTER TABLE orders ADD COLUMN IF NOT EXISTS created_from_ip TEXT;

-- Partial: only rows that HAVE an address can be looked up by it, and keeping the
-- rest out of the index keeps it small.
CREATE INDEX IF NOT EXISTS idx_orders_created_from_ip
  ON orders (created_from_ip)
  WHERE created_from_ip IS NOT NULL;