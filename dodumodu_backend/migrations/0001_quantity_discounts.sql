-- V2: quantity + tiered discounts. Additive only — nothing from 0000_init.sql is dropped
-- or altered in a way that would change already-stored data (§8.7: past orders never change).

CREATE TABLE discount_tiers (
  id SERIAL PRIMARY KEY,
  min_quantity INTEGER NOT NULL UNIQUE CHECK (min_quantity >= 1),
  discount_percent INTEGER NOT NULL CHECK (discount_percent BETWEEN 0 AND 100),
  label TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);

-- Seed data matching the current business rule — edit via admin afterward, don't hand-edit in prod.
INSERT INTO discount_tiers (min_quantity, discount_percent, label) VALUES
  (1, 0,  NULL),
  (2, 10, 'Buy 2, save 10%'),
  (3, 20, 'Buy 3 or 4, save 20%'),
  (5, 25, 'Buy 5+, save 25%');

-- Quantity + pricing breakdown columns on orders. Existing rows get quantity = 1,
-- unit_price = amount, subtotal = amount so the NOT NULL backfill is consistent
-- with "1 unit, no discount" for every pre-V2 order.
ALTER TABLE orders ADD COLUMN package_id TEXT;
ALTER TABLE orders ADD COLUMN quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 1);
ALTER TABLE orders ADD COLUMN unit_price INTEGER;
ALTER TABLE orders ADD COLUMN subtotal INTEGER;
ALTER TABLE orders ADD COLUMN discount_percent INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN discount_amount INTEGER NOT NULL DEFAULT 0;

UPDATE orders SET unit_price = amount, subtotal = amount WHERE unit_price IS NULL;

ALTER TABLE orders ALTER COLUMN unit_price SET NOT NULL;
ALTER TABLE orders ALTER COLUMN subtotal SET NOT NULL;
