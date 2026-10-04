-- V3: state-gated pay-on-delivery with a bulk-quantity ceiling. Additive only —
-- nothing from 0000_init.sql / 0001_quantity_discounts.sql is dropped or altered
-- in a way that changes already-stored data (§8.7: past orders never change).
--
-- Semantics (one row, id = 1, the whole table is the "global variable"):
--   cod_states           — states where a customer may choose pay-on-delivery.
--                          Anything not listed must pay before dispatch.
--   cod_bulk_threshold   — the FIRST quantity that counts as a bulk order: 5
--                          means quantities 1–4 may still use COD while 5+ has
--                          to be paid for up front (a refused 20-item COD
--                          delivery is a 20-item loss, a refused single is not).
--
-- Deliberately NOT a new enum value or a column on orders: which states are
-- eligible changes with the logistics partner, and an order always keeps the
-- payment method the customer actually chose (§8.7).

CREATE TABLE payment_rules (
  id SERIAL PRIMARY KEY,
  cod_states TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  cod_bulk_threshold INTEGER NOT NULL DEFAULT 5 CHECK (cod_bulk_threshold >= 1),
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now(),
  -- Singleton: this table holds exactly one row, and it is always this row.
  CONSTRAINT payment_rules_singleton CHECK (id = 1)
);

-- Seed data matching the current business rule — edit via the admin panel
-- afterwards, don't hand-edit in prod.
INSERT INTO payment_rules (id, cod_states, cod_bulk_threshold) VALUES
  (1, ARRAY['Lagos', 'Ogun', 'Enugu', 'Abuja'], 5);
