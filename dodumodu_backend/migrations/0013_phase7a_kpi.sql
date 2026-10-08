-- Phase 7a: add cancellation and Not Picking states, preserve cancellation
-- reversal state, and store closed-month KPI snapshots.

ALTER TYPE order_status ADD VALUE 'cancelled';
ALTER TYPE order_status ADD VALUE 'not_picking';

ALTER TABLE orders
  ADD COLUMN pre_cancellation_status TEXT;

CREATE TABLE monthly_kpi_snapshots (
  id SERIAL PRIMARY KEY,
  month TEXT NOT NULL UNIQUE,
  total_valid_orders INTEGER NOT NULL DEFAULT 0,
  delivered_orders INTEGER NOT NULL DEFAULT 0,
  delivered_revenue INTEGER NOT NULL DEFAULT 0,
  delivered_in_month INTEGER NOT NULL DEFAULT 0,
  collected_amount INTEGER NOT NULL DEFAULT 0,
  total_orders INTEGER NOT NULL DEFAULT 0,
  cancelled_orders INTEGER NOT NULL DEFAULT 0,
  not_picking_orders INTEGER NOT NULL DEFAULT 0,
  spam_flagged_orders INTEGER NOT NULL DEFAULT 0,
  abuse_evidence_orders INTEGER NOT NULL DEFAULT 0,
  pay_now_orders INTEGER NOT NULL DEFAULT 0,
  cod_orders INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL,
  definition_version INTEGER NOT NULL DEFAULT 1,
  taken_at TIMESTAMP NOT NULL,
  taken_by TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
