-- Repairing delivered_at, and then enforcing that it cannot be wrong again.
--
-- The problem this fixes is real and was observed, not theoretical. orders.delivered_at
-- arrived in 0005, but "mark delivered" existed before it and wrote ONLY the status.
-- So every order delivered before that migration is a row saying "delivered" with no
-- delivery time - the exact combination the design forbids, because a delivery with
-- no timestamp cannot be reconciled, aged or reported on.
--
-- The repair uses updated_at, which is the moment the row last changed and is
-- therefore the delivery for every row this can affect. That is an approximation
-- and is stated as one: an operator who marked an order delivered and then edited
-- the address has an updated_at later than the actual delivery. It is still far
-- better than NULL, which is the difference between "approximately when" and
-- "no idea when", and it is the only timestamp this table has.
--
-- Rows that are NOT delivered are left alone. Inventing a delivery time for an order
-- that is still in transit would be the opposite error.
UPDATE orders
   SET delivered_at = updated_at
 WHERE status = 'delivered'
   AND delivered_at IS NULL;

-- The second half is a constraint rather than more code. Single-statement updates
-- (orderCrmService.markDelivered writes both columns together) mean the application
-- cannot produce this state, but a script, a migration or a direct psql session can
-- - and "delivered with no delivery time" is meaningless enough that the database
-- should refuse it outright rather than leaving it to whichever reader notices.
--
-- Deliberately NOT a CHECK on the other direction (delivered_at IS NOT NULL implies
-- status = 'delivered'). That one would fight a legitimate workflow: an order being
-- dispatched can carry a planned delivery time before it has actually arrived.
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_delivered_requires_timestamp;
ALTER TABLE orders
  ADD CONSTRAINT orders_delivered_requires_timestamp
  CHECK (status <> 'delivered' OR delivered_at IS NOT NULL);
