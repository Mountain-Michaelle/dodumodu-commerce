-- ---------------------------------------------------------------------------
-- Phase 7 — Order assignment to staff (Assignment Mode)
--
-- Additive only. Nothing here touches orders.status, any payment/webhook/
-- reconciliation state, or any existing column. Assignment is a fulfilment-
-- routing concern, deliberately kept OUT of the order-status enum for the same
-- reason spam flags are: the payment lifecycle must never learn a concept it
-- does not have. An order can be `confirmed_cod` and assigned at the same time.
--
-- Identity is the operator EMAIL — the one identity that exists today (the
-- Cloudflare Access principal) and the one the admin-auth work (aa_users.email)
-- settles on. There is intentionally NO foreign key to any users table: that
-- table does not exist on this branch yet, and a FK would make this migration
-- un-runnable here. When auth lands, staff emails join to aa_users by email
-- with zero data migration — which is the seam this design leaves open.
-- ---------------------------------------------------------------------------

-- The current assignee of an order. NULL means "not yet assigned". Two nullable
-- columns rather than one JSON blob: each is filterable/indexable on its own,
-- and "who has this order" is a real, frequent query.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS assigned_to      TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS assigned_at      TIMESTAMP;

-- Soft delete. NULL = live; a timestamp = deleted and hidden from the list
-- unless an operator filters for it. Never a hard DELETE: a delivered order is
-- the record a parcel arrived, and removing the row destroys the only evidence
-- it did. Reversible by design.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS deleted_at       TIMESTAMP;

-- Serves the two list predicates that matter: "orders assigned to <staff>"
-- (per-staff filter + that staff's report) and, as its complement, the
-- assignment-mode view of unassigned orders. Partial, because the overwhelmingly
-- common case is "unassigned" and a full index over those is wasted space.
CREATE INDEX IF NOT EXISTS idx_orders_assigned_to
  ON orders (assigned_to) WHERE assigned_to IS NOT NULL;

-- The staff directory. Email is the PRIMARY KEY and the join key to the future
-- auth table; `name` is display only and may be edited without breaking a
-- single assignment. Kept separate from assignment so the dropdown of "who can
-- be assigned work" is one small table an operator can curate, not a derived
-- list that changes meaning every time an order moves.
CREATE TABLE IF NOT EXISTS admin_staff (
  email      TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

-- Append-only assignment history. Reassignment is a real event worth keeping
-- ("this bounced between three people"), so this is a log, not a counter — the
-- same shape and intent as order_status_history. ON DELETE CASCADE ties each
-- entry to its order, so deleting an order removes its assignment trail too.
CREATE TABLE IF NOT EXISTS order_assignments (
  id             SERIAL PRIMARY KEY,
  order_id       INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  assignee_email TEXT NOT NULL,
  actor_email    TEXT NOT NULL,
  action         TEXT NOT NULL CHECK (action IN ('assign', 'unassign')),
  reason         TEXT,
  created_at     TIMESTAMP NOT NULL DEFAULT now()
);

-- "Show me the assignment history of this order, newest first" — the order
-- detail screen's one read of this table.
CREATE INDEX IF NOT EXISTS idx_order_assignments_order
  ON order_assignments (order_id, created_at DESC);

-- Seed the staff directory with the current operator so the dropdown is never
-- empty on first use. Lowercased to match the Access principal and the CHECK
-- discipline the auth table uses; ON CONFLICT keeps a re-run from duplicating.
INSERT INTO admin_staff (email, name)
VALUES ('dev@dodumodu.local', 'Dev Operator')
ON CONFLICT (email) DO NOTHING;
