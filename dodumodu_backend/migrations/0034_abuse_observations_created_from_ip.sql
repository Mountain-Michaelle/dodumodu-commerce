-- schema.ts has declared abuse_observations.created_from_ip (the address an order was placed from, shown masked next to
-- the abuse evidence) since it was written, but no migration ever created it, so every SELECT on the table failed
-- with "column does not exist". Nullable and best-effort by design: rows written before this have no address.
ALTER TABLE abuse_observations ADD COLUMN IF NOT EXISTS created_from_ip text;
