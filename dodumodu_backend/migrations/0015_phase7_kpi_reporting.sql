-- KPI reporting must distinguish every order lifecycle status. The delivered
-- cohort metric excludes active spam flags, while delivered_status_orders is the
-- all-order status count shown separately in the report.
ALTER TABLE monthly_kpi_snapshots
  ADD COLUMN awaiting_payment_orders INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN paid_orders INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN failed_orders INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN confirmed_cod_orders INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN delivered_status_orders INTEGER NOT NULL DEFAULT 0;

-- A delivery is not evidence that COD cash was collected. No collection source is
-- persisted today, so old placeholder/default values are not reportable.
ALTER TABLE monthly_kpi_snapshots
  ALTER COLUMN collected_amount DROP NOT NULL,
  ALTER COLUMN collected_amount DROP DEFAULT;

UPDATE monthly_kpi_snapshots SET collected_amount = NULL;

-- Delivery activity is a time-window query over the append-only transition log.
CREATE INDEX idx_order_status_history_delivered_created_at
  ON order_status_history (created_at, order_id)
  WHERE new_status = 'delivered';
