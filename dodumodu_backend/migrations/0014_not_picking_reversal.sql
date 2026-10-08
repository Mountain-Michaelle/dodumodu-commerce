-- Preserve the exact status to restore when Not Picking is explicitly reverted.
ALTER TABLE orders
  ADD COLUMN pre_not_picking_status TEXT;
