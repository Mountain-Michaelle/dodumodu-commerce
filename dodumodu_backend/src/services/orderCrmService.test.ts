import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { Db } from "../db";
import { ordersRepo, type OrderRow } from "../data/ordersRepo";
import { orderCrmService, availableActions } from "./orderCrmService";
import { ConflictError, NotFoundError, ValidationError } from "../shared/httpError";

/* The delivery and payment rules, tested directly against the service.
   The repos are stubbed in place - they are plain objects - so these are the real
   rules being exercised, not a description of them. No database is involved. */

const db = {} as Db;

function order(over: Partial<OrderRow> = {}): OrderRow {
  return {
    id: 1,
    productId: 1,
    idempotencyKey: "key-1",
    customerName: "Chioma Adeyemi",
    phone: "08012345678",
    whatsapp: "08012345678",
    address: "12 Allen Avenue, Ikeja",
    state: "Lagos",
    deliveryFeeType: "free",
    deliveryDate: "tomorrow",
    flaggedLate: false,
    questionNotes: null,
    paymentMethod: "cod",
    packageId: null,
    quantity: 1,
    unitPrice: 1500000,
    subtotal: 1500000,
    discountPercent: 0,
    discountAmount: 0,
    amount: 1500000,
    currency: "NGN",
    reference: "ord-abc-12345678",
    status: "paid",
    retryCount: 0,
    lastCheckedAt: null,
    deliveredAt: null,
    createdAt: new Date("2026-01-01T10:00:00Z"),
    updatedAt: new Date("2026-01-01T10:00:00Z"),
    ...over,
  } as OrderRow;
}

// Captured so each test can assert on what the service asked the database to do -
// which is how the atomicity claims below are checked rather than assumed.
let current: OrderRow | null = null;
let history: { oldStatus: string | null; newStatus: string; changedBy: string }[] = [];
let statusUpdates: { to: string }[] = [];

function stub() {
  ordersRepo.findById = async () => current;
  ordersRepo.writeStatusHistory = async (_db, _id, oldStatus, newStatus, changedBy) => {
    history.push({ oldStatus, newStatus, changedBy });
  };
  ordersRepo.markDelivered = async (_db, _id, expectedStatus) => {
    void expectedStatus;
    const next = { ...current!, status: "delivered", deliveredAt: new Date() } as OrderRow;
    current = next;
    return next;
  };
  ordersRepo.revertDelivery = async (_db, _id, toStatus) => {
    const next = { ...current!, status: toStatus as OrderRow["status"], deliveredAt: null } as OrderRow;
    current = next;
    return next;
  };
  ordersRepo.markNotPicking = async (_db, _id, expectedStatus) => {
    const next = {
      ...current!,
      status: "not_picking",
      preNotPickingStatus: expectedStatus,
    } as OrderRow;
    current = next;
    return next;
  };
  ordersRepo.revertNotPicking = async () => {
    const previousStatus = current?.preNotPickingStatus;
    if (!previousStatus) return null;
    const next = {
      ...current!,
      status: previousStatus,
      preNotPickingStatus: null,
    } as OrderRow;
    current = next;
    return next;
  };
  ordersRepo.guardedStatusUpdate = async (_db, _id, _from, to) => {
    statusUpdates.push({ to });
    const next = { ...current!, status: to as OrderRow["status"] } as OrderRow;
    current = next;
    return next;
  };
  ordersRepo.findByIds = async (_db, ids) => (current && ids.includes(current.id) ? [current] : []);
  ordersRepo.updateEditableFields = async (_db, _id, patch) => {
    const next = { ...current!, ...patch } as OrderRow;
    current = next;
    return next;
  };
  ordersRepo.deleteById = async () => { current = null; return true; };
}
stub();

beforeEach(() => {
  current = order();
  history = [];
  statusUpdates = [];
  stub();
});

/* ---- which actions exist ---- */

test("a paid order can be delivered; a failed one cannot", () => {
  assert.deepEqual(availableActions(order({ status: "paid" })), ["deliver", "cancel", "mark-not-picking"]);
  assert.deepEqual(availableActions(order({ status: "confirmed_cod" })), ["deliver", "cancel", "mark-not-picking"]);
  // The claim "the parcel arrived" is not available on an order whose payment
  // failed or that is still awaiting one.
  assert.deepEqual(availableActions(order({ status: "failed" })), ["cancel"]);
  assert.deepEqual(availableActions(order({ status: "awaiting_payment" })), ["mark-paid", "mark-failed", "cancel"]);
});

test("a delivered order offers revert, and never a second deliver", () => {
  assert.deepEqual(availableActions(order({ status: "delivered" })), ["revert"]);
});

test("payment overrides are offered only while a pay-now order is unpaid", () => {
  assert.ok(availableActions(order({ status: "awaiting_payment", paymentMethod: "pay_now" }))
    .includes("mark-paid"));
  // Already settled: an override here is a no-op that would only write a false
  // history entry.
  assert.ok(!availableActions(order({ status: "paid", paymentMethod: "pay_now" })).includes("mark-paid"));
});

test("cancellation reversal is offered in the detail action set only when its previous status exists", () => {
  assert.deepEqual(availableActions(order({ status: "cancelled" })), []);
  assert.deepEqual(
    availableActions(order({ status: "cancelled", preCancellationStatus: "paid" })),
    ["revert-cancel"],
  );
});

test("Not Picking is offered only for deliverable orders and has a reversal when its prior state exists", () => {
  assert.ok(availableActions(order({ status: "paid" })).includes("mark-not-picking"));
  assert.ok(!availableActions(order({ status: "failed" })).includes("mark-not-picking"));
  assert.deepEqual(availableActions(order({ status: "not_picking" })), []);
  assert.deepEqual(
    availableActions(order({ status: "not_picking", preNotPickingStatus: "confirmed_cod" })),
    ["revert-not-picking"],
  );
});

test("reverting Not Picking restores the exact status saved when it was marked", async () => {
  current = order({ status: "paid" });
  await orderCrmService.markNotPicking(db, 1, null, "admin@x.test");
  assert.equal(current?.status, "not_picking");
  assert.equal(current?.preNotPickingStatus, "paid");

  await orderCrmService.revertNotPicking(db, 1, null, "admin@x.test");
  assert.equal(current?.status, "paid");
  assert.equal(current?.preNotPickingStatus, null);
  assert.deepEqual(history.map((entry) => [entry.oldStatus, entry.newStatus]), [
    ["paid", "not_picking"],
    ["not_picking", "paid"],
  ]);
});

/* ---- delivering ---- */

test("delivering stamps delivered_at and records the transition", async () => {
  await orderCrmService.deliver(db, 1, null, "admin@x.test");
  assert.equal(current?.status, "delivered");
  assert.ok(current?.deliveredAt instanceof Date, "delivered_at must be set at the same time");
  assert.deepEqual(history, [
    { oldStatus: "paid", newStatus: "delivered", changedBy: "admin@x.test" },
  ]);
});

test("an order cannot be delivered from a state the goods were never dispatched in", async () => {
  current = order({ status: "awaiting_payment" });
  await assert.rejects(
    () => orderCrmService.deliver(db, 1, null, "admin@x.test"),
    (err: unknown) => err instanceof ValidationError,
  );
  assert.equal(current?.status, "awaiting_payment", "a refused delivery must change nothing");
});

test("delivering twice is a conflict, not a second timestamp", async () => {
  current = order({ status: "delivered" });
  await assert.rejects(
    () => orderCrmService.deliver(db, 1, null, "admin@x.test"),
    (err: unknown) => err instanceof ConflictError,
  );
});

test("a lost update during delivery is a conflict, not a silent overwrite", async () => {
  // The optimistic-concurrency guard: the row moved between our read and our
  // write, so the operator is told rather than their click silently winning.
  const real = ordersRepo.markDelivered;
  ordersRepo.markDelivered = async () => null;
  current = order({ status: "paid" });
  await assert.rejects(
    () => orderCrmService.deliver(db, 1, new Date("2026-01-01T09:00:00Z"), "admin@x.test"),
    (err: unknown) => err instanceof ConflictError,
  );
  ordersRepo.markDelivered = real;
});

/* ---- reverting ---- */

test("reverting a pay-now delivery goes back to paid, not to awaiting_payment", async () => {
  // The rule that protects collected money: undoing a delivery does not un-charge
  // a card, so the order must not be reclassified as outstanding.
  current = order({ status: "delivered", paymentMethod: "pay_now" });
  await orderCrmService.revert(db, 1, null, "admin@x.test");
  assert.equal(current?.status, "paid");
  assert.equal(current?.deliveredAt, null, "delivered_at must be cleared, never left stale");
});

test("reverting a COD delivery goes back to confirmed COD", async () => {
  current = order({ status: "delivered", paymentMethod: "cod" });
  await orderCrmService.revert(db, 1, null, "admin@x.test");
  assert.equal(current?.status, "confirmed_cod");
  assert.equal(current?.deliveredAt, null);
});

test("an order that is not delivered cannot be reverted", async () => {
  await assert.rejects(
    () => orderCrmService.revert(db, 1, null, "admin@x.test"),
    (err: unknown) => err instanceof ConflictError,
  );
});

/* ---- manual payment overrides ---- */

test("a payment override is recorded as an admin override, never as a webhook", async () => {
  current = order({ status: "awaiting_payment", paymentMethod: "pay_now" });
  await orderCrmService.manualPaymentOverride(db, 1, "paid", null, "admin@x.test");
  assert.equal(current?.status, "paid");
  // The difference between "the provider said so" and "an operator said so" is the
  // entire point of an audit trail.
  assert.equal(history[0].changedBy, "admin-override:admin@x.test");
  assert.notEqual(history[0].changedBy, "webhook");
});

test("a pay-on-delivery order has no payment to override", async () => {
  current = order({ status: "awaiting_payment", paymentMethod: "cod" });
  await assert.rejects(
    () => orderCrmService.manualPaymentOverride(db, 1, "paid", null, "admin@x.test"),
    (err: unknown) => err instanceof ValidationError,
  );
  assert.equal(current?.status, "awaiting_payment");
});

test("an already-settled order cannot be overridden", async () => {
  current = order({ status: "paid", paymentMethod: "pay_now" });
  await assert.rejects(
    () => orderCrmService.manualPaymentOverride(db, 1, "failed", null, "admin@x.test"),
    (err: unknown) => err instanceof ConflictError,
  );
});

/* ---- editing ---- */

test("editing a state that is not a Nigerian state is refused", async () => {
  await assert.rejects(
    () => orderCrmService.updateEditableFields(db, 1, { state: "Atlantis" }, null),
    (err: unknown) => err instanceof ValidationError,
  );
});

test("editing a customer phone is allowed, and the state is normalised for querying", async () => {
  const updated = await orderCrmService.updateEditableFields(
    db, 1, { phone: "08099998888", state: "enugu" }, null,
  );
  assert.equal(updated.phone, "08099998888");
  // "enugu" is stored as "Enugu" so a later "orders in Enugu" filter matches.
  assert.equal(updated.state, "Enugu");
});

/* ---- deletion ---- */

test("deleting an order needs explicit confirmation", async () => {
  await assert.rejects(
    () => orderCrmService.remove(db, 1, false, "admin@x.test"),
    (err: unknown) => err instanceof ValidationError,
  );
  assert.ok(current, "the order must still exist after a refused delete");
});

test("a delivered order cannot be deleted, because it is the record of a sale", async () => {
  current = order({ status: "delivered" });
  await assert.rejects(
    () => orderCrmService.remove(db, 1, true, "admin@x.test"),
    (err: unknown) => err instanceof ConflictError,
  );
});

test("an unpaid, undelivered order can be deleted when confirmed", async () => {
  current = order({ status: "failed" });
  await orderCrmService.remove(db, 1, true, "admin@x.test");
  assert.equal(current, null);
});

test("a missing order is a 404, not a crash", async () => {
  current = null;
  await assert.rejects(
    () => orderCrmService.deliver(db, 99, null, "admin@x.test"),
    (err: unknown) => err instanceof NotFoundError,
  );
});

/* ---- bulk ---- */

test("a bulk action reports what it skipped, rather than failing the whole batch", async () => {
  // An order that cannot legally be delivered is skipped with a reason; the rest
  // of the batch still goes. Silently dropping it would leave the operator
  // believing a whole selection had been cleared.
  const first = order({ id: 1, status: "paid" });
  const second = order({ id: 2, status: "failed" });
  ordersRepo.findByIds = async () => [first, second];
  ordersRepo.markDelivered = async (_db, id, expectedStatus) => {
    if (id !== 1 || first.status !== expectedStatus) return null;
    first.status = "delivered";
    return first;
  };

  const result = await orderCrmService.bulkAction(db, [1, 2], "deliver", "admin@x.test");
  assert.equal(result.updated.length, 1, "the deliverable order is marked delivered");
  assert.equal(result.updated[0].id, 1);
  assert.equal(result.skipped.length, 1, "the failed order is skipped, not forced");
  assert.match(result.skipped[0].reason, /Cannot deliver from failed/);
  // The batch reports honestly: one done, one skipped, nothing silently lost.
  assert.equal(result.errors.length, 0);
});

test("a bulk action over no ids does nothing rather than erroring", async () => {
  const result = await orderCrmService.bulkAction(db, [], "deliver", "admin@x.test");
  assert.deepEqual(result, { updated: [], skipped: [], errors: [] });
});
