-- Manual orders (created by an operator in the admin console) record who created them.
-- NULL = placed by a customer through the storefront. Additive and nullable: no backfill needed,
-- and nothing that reads orders has to change.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS created_by text;
CREATE INDEX IF NOT EXISTS orders_created_by_idx ON orders (created_by) WHERE created_by IS NOT NULL;
