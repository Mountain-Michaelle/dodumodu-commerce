# Phase 7a: Order Actions + Monthly KPIs (Implementation Guide)

## Overview
Phase 7a adds order cancellation, Not Picking status, and monthly KPI snapshots to the existing order lifecycle model. All changes follow the existing architecture: centralized status transitions, guarded atomic updates, and audit history.

## Section 0: Invariants

### 0.1 Process and Working Style
- All changes are strictly additive to the existing schema and business logic.
- Status transitions remain the single source of truth in `ordersRepo.LEGAL_TRANSITIONS`.
- Admin actions are guarded on both status and version (expectedUpdatedAt) to prevent lost updates.
- Every status change is recorded in `order_status_history` for audit trails.
- Payment state, fulfilment state, cancellation, Not Picking, and spam flags remain separate concerns.

### 0.2 Simplicity Budget
- New statuses: `cancelled` and `not_picking` added to the existing `order_status` enum.
- New column: `pre_cancellation_status` on orders table (stores previous status for cancellation reversal).
- New table: `monthly_kpi_snapshots` (one row per closed month, immutable after insertion).
- No event bus, no cache layer, no separate state machine framework.

### 0.3 Concepts That Stay Separate
- **Cancellation** is not equivalent to failed payment, spam, or Not Picking.
- **Not Picking** is a distinct fulfilment issue; a Not Picking order remains valid for reporting.
- **Spam flags** and **abuse evidence** stay on separate tables and do not imply cancelled/not picking.
- **Reversal** of cancellation restores the exact previous status from `pre_cancellation_status`.
- **Reversal** of Not Picking restores the exact status stored in `pre_not_picking_status`.

### 0.4 Financial and Payment Integrity
- Cancellation never changes payment records or triggers refunds.
- A delivered order can never be cancelled.
- A cancelled order cannot be marked delivered.
- Cancellation and Not Picking remain independent of payment state and spam flags.
- The KPI percentage cohort contains all stored real orders except orders whose
  canonical phone currently has an active spam flag; lifecycle status does not
  exclude an order.

### 0.5 Downstream Consumers
**Every place that reads order status must consider the new statuses:**
- Admin list filtering: cancelled and not_picking are filterable statuses.
- Available actions: offer cancel/revert-cancel/mark-not-picking/revert-not-picking based on current status.
- KPI reporting: include cancelled and not_picking in the counts; define which cohorts they belong to.
- Stock/inventory: validate that cancelled orders do not restore stock (not in scope for phase 7a).
- CRM/fulfillment automation: validate that cancelled/not_picking orders are not pushed externally.
- Review requests: validate that cancelled/not_picking orders do not receive review requests.
- Notifications: validate that cancelled/not_picking orders do not trigger delivery notifications.

### 0.6 Production Readiness
- All changes are deployed via standard SQL migrations.
- Cancellation/Not Picking schema is in migrations 0013-0014; KPI reporting is
  additive in migration 0015.
- Rollback is possible: delete `monthly_kpi_snapshots` rows and remove the enum values.
- No breaking changes to existing order APIs. The reporting surface adds a
  permission-protected GET route and a cron-secret-protected POST close route.

---

## Section 1: Status Model and Transitions

### 1.1 Updated Enum
Order status now includes:
```typescript
export const orderStatusEnum = pgEnum("order_status", [
  "awaiting_payment", "paid", "failed", "confirmed_cod", "delivered",
  "cancelled", "not_picking",
]);
```

### 1.2 Legal Transitions
```typescript
const LEGAL_TRANSITIONS: Record<string, string[]> = {
  awaiting_payment: ["paid", "failed", "cancelled"],
  paid: ["delivered", "cancelled"],
  confirmed_cod: ["delivered", "cancelled"],
  failed: ["cancelled"],
  delivered: [],               // terminal
  cancelled: [],               // terminal
  not_picking: [],             // terminal
};
```

**Key rules:**
- Cancellation is allowed from any non-terminal state except delivered.
- A delivered order can never be cancelled.
- Cancellation and Not Picking are terminal under normal operations.
- Only reversal routes (admin actions) can exit these states.

### 1.3 Pre-Cancellation Status
When an order is cancelled, `pre_cancellation_status` stores the status it was in before cancellation:
- `NOT NULL` → order is cancelled; reversal is available.
- `NULL` → order is not cancelled, or was cancelled long ago and reversal is no longer available.

### 1.4 Cancellation Reversal
- Reversal is the only way to undo a cancellation.
- It restores the exact status stored in `pre_cancellation_status`.
- It is a deliberate admin action with its own permission and history entry.
- After reversal, `pre_cancellation_status` is set back to NULL.

### 1.5 Not Picking Reversal
- `pre_not_picking_status` stores the exact status before Not Picking.
- Reversal restores that status automatically; the operator does not guess.
- Reversal is a deliberate action in the order detail modal and writes a history entry.

---

## Section 2: Admin Actions

### 2.1 Available Actions
The `availableActions(order)` function returns the actions the server believes are valid for a given order:

| Current Status | Available Actions |
| --- | --- |
| `awaiting_payment` | mark-paid, mark-failed, cancel |
| `paid` | deliver, cancel |
| `confirmed_cod` | deliver, cancel |
| `failed` | cancel |
| `delivered` | revert |
| `cancelled` (with pre_cancellation_status) | revert-cancel |
| `not_picking` | revert-not-picking |

### 2.2 Single-Order Routes
- `POST /:id/cancel` — Cancel an order
- `POST /:id/revert-cancel` — Undo a cancellation
- `POST /:id/mark-not-picking` — Mark as Not Picking
- `POST /:id/revert-not-picking` — Undo Not Picking (requires explicit toStatus)

All routes require:
- Timestamp-based optimistic locking (expectedUpdatedAt)
- Permission: `ordersWrite` for cancel/revert-cancel/mark-not-picking
- Permission: `ordersWrite` for revert-not-picking

### 2.3 Bulk Actions
The bulk action endpoint supports:
- `cancel` — Bulk cancel multiple orders
- `revert-cancel` — Bulk undo cancellations
- `mark-not-picking` — Bulk mark as Not Picking

Bulk actions skip ineligible rows rather than failing the entire batch.

### 2.4 Permissions
- `ordersWrite` — cancel, revert-cancel, mark-not-picking, revert-not-picking
- `ordersPaymentOverride` — mark-paid, mark-failed (unchanged)
- `ordersRead` — list, filter, export (unchanged)

---

## Section 3: KPI Reporting and Snapshots

### 3.1 Valid Order Predicate
A valid order is:
- A real stored order. No test/non-real order marker exists in the current schema.
- Not currently spam-marked by its canonical phone.
- Status-independent: awaiting payment, failed, confirmed COD, paid, delivered,
  Not Picking, and cancelled orders all remain in the denominator unless spam-marked.

### 3.2 Delivery Rate (Group A)
**Formula:**
```
delivery_rate = delivered_orders ÷ total_valid_orders
```

Both numerator and denominator are for orders **created** in the month and use the
same real, non-spam cohort. The numerator is delivered orders in that cohort.

- Cancelled non-spam orders **stay** in the denominator.
- Not Picking orders **stay in** the denominator but are not delivered (rate decreases).
- Spam-marked orders are excluded from both numerator and denominator. Abuse
  evidence alone does not exclude an order.

### 3.3 Cancellation Context
Cancelled orders are already included in the primary denominator, so a second
"including cancelled" rate would be redundant. Cancellation remains visible as its
own lifecycle count.

### 3.4 Snapshot Metrics
The `monthly_kpi_snapshots` table captures, per month:

**Group A: Valid Order Cohort**
- `total_valid_orders` — real orders created in the month with no active spam flag;
  includes every lifecycle status. No test-order marker currently exists.
- `delivered_orders` — real, non-spam orders with status = delivered
- `delivered_revenue` — sum of amounts for delivered_orders (integer kobo); order
  value is not reported as collected cash

**Group B: Timing-Based**
- `delivered_in_month` — distinct orders with a delivered history event during the
  month, plus current delivered rows with `delivered_at` in the month. For legacy
  rows, `delivered_at` may be an estimate backfilled from `updated_at`.
- `collected_amount` — NULL/unavailable until an authoritative persisted collection
  record with its own trustworthy timestamp exists. Delivery timestamps are not a
  collection source.

**Other Metrics**
- `total_orders` — all orders created in the month (including later cancelled, failed, etc.)
- `cancelled_orders` — orders with status = cancelled
- `not_picking_orders` — orders with status = not_picking
- `spam_flagged_orders` — orders whose current phone normalizes to a currently
  active spam flag at snapshot time
- `abuse_evidence_orders` — distinct orders with duplicate/reordering evidence
  under the existing order-evidence rules at snapshot time
- `pay_now_orders` — orders with payment_method = pay_now
- `cod_orders` — orders with payment_method = cod
- `awaiting_payment_orders`, `paid_orders`, `failed_orders`,
  `confirmed_cod_orders`, and `delivered_status_orders` — lifecycle status counts
  across all orders, including spam-marked orders

**Metadata**
- `month` — YYYY-MM format, unique key
- `source` — currently 'close' | 'lazy'
- `definition_version` — incremented on schema/logic changes
- `taken_at` — timestamp of snapshot
- `taken_by` — actor who triggered it (null for automatic)

### 3.5 Snapshot Lifecycle

**Live Current Month:**
- Computed on every report page load from live orders.
- Uses half-open Lagos-month timestamp bounds and a fixed number of batched queries,
  including the existing abuse-evidence helper.
- No cache, no incremental counters, no triggers.

**Closed Month Snapshot:**
- Written once after Lagos month end.
- Inserted with `INSERT ... ON CONFLICT (month) DO NOTHING` to ensure idempotency.
- Source = 'close' if written by automatic scheduler, 'lazy' if written on-demand.
- Immutable: never updated once inserted.
- The close route is `POST /internal/monthly-kpi-snapshots/close`, protected by the
  existing `RECONCILE_CRON_SECRET`; schedule it daily after midnight Africa/Lagos.

**Snapshot UI Labels:**
- "Snapshot taken <date> (close)" for automatic snapshots.
- "Snapshot taken <date> (lazy)" for on-demand fills.

### 3.6 Timezone and Boundaries
- Report timezone: Africa/Lagos (fixed UTC+1, consistent with the existing
  delivery and abuse date helpers).
- Month boundaries computed in application code as UTC instants.
- Filters use direct half-open ranges on timestamps: `created_at >= from AND created_at < to`
- No generate_series; fill missing months in application code.
- Default report window: last 12 months. Hard cap: 24 months.
- All order lifecycle status counts are displayed separately from the rate cohort.
- The redundant "including cancelled" secondary rate is omitted because cancelled
  non-spam orders are already included in the primary denominator.

---

## Section 4: Schema and Migrations

### 4.1 New Columns on `orders`
- `pre_cancellation_status` (TEXT, nullable) — previous status before cancellation
- `pre_not_picking_status` (TEXT, nullable) — previous status before Not Picking

### 4.2 New Table `monthly_kpi_snapshots`
See schema.ts for full definition. Key constraints:
- Unique constraint on `month`.
- No foreign keys (snapshots are immutable and survive order deletions).
- Unique `month` index for snapshot lookup.
- `collected_amount` is nullable and remains NULL unless an authoritative persisted
  collection record with its own timestamp becomes available.
- `delivered_in_month` uses an index on delivered status-history events.

### 4.3 Enum Update
`order_status` enum adds: `cancelled`, `not_picking`

---

## Section 5: Reporting and Filtering

### 5.1 Admin Filter Updates
The order list filter now accepts:
```typescript
status: "cancelled" | "not_picking" | ... (all existing statuses)
```

### 5.2 Order List Display
Orders with `cancelled` or `not_picking` status appear in lists and are filterable, searchable, and sortable like any other order.

### 5.3 Available Actions Column
The detail panel dynamically generates the action list based on `availableActions(order)`. The UI never shows an action the server has not approved.

### 5.4 Monthly KPI Report
- `GET /admin/reports/monthly-kpis?months=12` requires `orders:read`.
- The current Lagos month is live; closed months use immutable snapshots, filling
  missing snapshots lazily with source `lazy`.
- The report displays the delivery rate, order-value totals, all lifecycle status
  counts, spam flags, abuse evidence, and collection unavailability.
- Collected cash is never inferred from `amount` or `delivered_at`.

---

## Section 6: Testing Guidance

### 6.1 Unit Tests
- Verify `availableActions()` returns the correct set for each status.
- Verify transitions in `LEGAL_TRANSITIONS` match the database constraints.
- Verify cancellation stores `pre_cancellation_status` correctly.
- Verify reversal restores the exact previous status.
- Verify Not Picking reversal requires explicit toStatus.

### 6.2 Integration Tests
- Create an order, cancel it, verify status and history.
- Revert the cancellation, verify status is restored.
- Mark an order as Not Picking, verify it stays in valid-order cohort for KPIs.
- Verify bulk cancel/revert-cancel work correctly.
- Verify permissions block unauthorized cancel/not-picking actions.

### 6.3 Snapshot Tests
- Create orders in a month, close the month, verify snapshot is written.
- Verify snapshot contains correct counts and source='close'.
- Modify an order in the next month, verify closed month's snapshot does not change.
- Verify live current month is always recomputed.
- Verify all seven statuses count in the percentage denominator when not spam-marked.
- Verify active spam flags exclude an order from both delivery-rate numerator and
  denominator, independent of status.
- Verify `collected_amount` stays NULL without a persisted authoritative source.
- Verify an empty month is snapshotted as zero and repeated close attempts do not
  overwrite the first snapshot.

---

## Section 7: Rollout and Rollback

### 7.1 Deployment
1. Run migration: `npm run db:migrate`
2. Deploy the backend code.
3. Configure the monthly KPI close request described in README.
4. The Reports view is available once the backend and site are deployed.

### 7.2 Rollback
1. Keep `pre_cancellation_status` nullable on the orders table (no data loss).
2. Keep `monthly_kpi_snapshots` table (safe to leave empty if unused).
3. If forced to roll back:
   - Ignore `pre_cancellation_status` (it is NULL for non-cancelled orders).
   - Ignore cancelled/not_picking statuses (treat as unknown/error cases).
   - Delete the `monthly_kpi_snapshots` table.
   - Revert enum to previous values (PostgreSQL allows enum value removal only if no rows exist).

---

## Section 8: Open Decisions (for future phases)

- **Matured delivery rate:** Include `delivered_cohort_matured` snapshot 30 days after month end? (Gate A7)
- **Test order marker:** None exists in the current schema; if introduced, its
  inclusion/exclusion rule must be separately approved.
- **Visitor analytics:** Separate from 7a; see Section 2 of the Phase 7 master prompt.

---

## Verification Status

The implementation is verified by the repository's backend typecheck, focused KPI
unit/route tests, disposable PostgreSQL migration and end-to-end report tests, and
the admin UI check. The checked-in tests include the seven-status denominator,
spam exclusions, empty/closed/live months, lazy/close snapshots, idempotency,
immutability, and unavailable collection data.
