import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { Db } from "../db";
import { assignmentRepo } from "../data/assignmentRepo";
import { ordersRepo } from "../data/ordersRepo";
import { orderCrmService } from "./orderCrmService";

/* Assignment rules, tested against the real service with the repos stubbed in
   place. Assignment is fulfilment routing: it must move `assignedTo` and write
   history, and must NEVER touch status, payment, delivered_at or cancellation.
   These tests pin that separation down. No database is involved. */

const db = {} as Db;

let row: {
  id: number; reference: string; status: string; paymentMethod: string;
  deliveredAt: Date | null; preCancellationStatus: string | null; assignedTo: string | null;
};
let history: { orderId: number; assigneeEmail: string; actorEmail: string; action: string }[] = [];

let assignOutcome: { assignedTo: string; changed: boolean } | "not_found" | "conflict" = { assignedTo: "a@x.test", changed: true };
let unassignOutcome: "not_found" | "unchanged" | "cleared" = "cleared";

function stub() {
  assignmentRepo.assignOrder = async (_db, _id, targetEmail) => {
    if (assignOutcome === "not_found" || assignOutcome === "conflict") return assignOutcome;
    row.assignedTo = targetEmail;
    return assignOutcome;
  };
  assignmentRepo.unassignOrder = async () => {
    if (unassignOutcome === "not_found" || unassignOutcome === "unchanged") return unassignOutcome;
    row.assignedTo = null;
    return unassignOutcome;
  };
  assignmentRepo.writeHistory = async (_db, orderId, assigneeEmail, actorEmail, action) => {
    history.push({ orderId, assigneeEmail, actorEmail, action });
  };
  ordersRepo.findByIds = async (_db, ids) =>
    ids.includes(row.id) ? [{ id: row.id, reference: row.reference }] as never : [];
}

beforeEach(() => {
  row = {
    id: 7, reference: "ddmd-abcdef1234567", status: "confirmed_cod", paymentMethod: "cod",
    deliveredAt: null, preCancellationStatus: null, assignedTo: null,
  };
  history = [];
  assignOutcome = { assignedTo: "a@x.test", changed: true };
  unassignOutcome = "cleared";
  stub();
});

test("assigning an order sets the assignee and writes one history row", async () => {
  const result = await orderCrmService.assign(db, [7], "a@x.test", "admin@x.test");
  assert.deepEqual(result.updated, [{ id: 7, reference: "ddmd-abcdef1234567" }]);
  assert.equal(result.skipped.length, 0);
  assert.equal(result.errors.length, 0);
  assert.equal(row.assignedTo, "a@x.test");
  assert.equal(history.length, 1);
  assert.equal(history[0].assigneeEmail, "a@x.test");
  assert.equal(history[0].actorEmail, "admin@x.test");
  assert.equal(history[0].action, "assign");
});

test("assign never changes status, payment, delivered_at or cancellation", async () => {
  const before = { ...row };
  await orderCrmService.assign(db, [7], "a@x.test", "admin@x.test");
  assert.equal(row.status, before.status, "status must not move");
  assert.equal(row.paymentMethod, before.paymentMethod, "payment must not move");
  assert.equal(row.deliveredAt, before.deliveredAt, "delivered_at must not move");
  assert.equal(row.preCancellationStatus, before.preCancellationStatus, "cancellation state must not move");
});

test("re-assigning to the SAME staff is idempotent: no change, no duplicate history", async () => {
  assignOutcome = { assignedTo: "a@x.test", changed: false };
  const result = await orderCrmService.assign(db, [7], "a@x.test", "admin@x.test");
  assert.equal(result.updated.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /already assigned/i);
  assert.equal(history.length, 0, "no history row for a no-op reassign");
});

test("a duplicate sibling assigned to another staff is skipped with a reason", async () => {
  assignOutcome = "conflict";
  const result = await orderCrmService.assign(db, [7], "b@x.test", "admin@x.test");
  assert.equal(result.updated.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /duplicate/i);
  assert.equal(history.length, 0);
});

test("reassignment keeps prior history (append-only): a second assign adds a row", async () => {
  row.assignedTo = "a@x.test";
  assignOutcome = { assignedTo: "b@x.test", changed: true };
  const result = await orderCrmService.assign(db, [7], "b@x.test", "admin@x.test");
  assert.equal(result.updated.length, 1);
  assert.equal(history.length, 1);
  assert.equal(history[0].assigneeEmail, "b@x.test");
});

test("an admin can assign an order to themself", async () => {
  const me = "admin@x.test";
  const result = await orderCrmService.assign(db, [7], me, me);
  assert.equal(result.updated.length, 1);
  assert.equal(row.assignedTo, me);
  assert.equal(history[0].assigneeEmail, me);
  assert.equal(history[0].actorEmail, me);
});

test("unassign clears the assignee and writes an unassign row", async () => {
  row.assignedTo = "a@x.test";
  const result = await orderCrmService.unassign(db, [7], "admin@x.test");
  assert.equal(result.updated.length, 1);
  assert.equal(row.assignedTo, null);
  assert.equal(history.length, 1);
  assert.equal(history[0].action, "unassign");
});

test("unassigning an already-unassigned order is a no-op, not an error", async () => {
  row.assignedTo = null;
  unassignOutcome = "unchanged";
  const result = await orderCrmService.unassign(db, [7], "admin@x.test");
  assert.equal(result.updated.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.equal(history.length, 0);
});

test("a bulk assign over no ids does nothing rather than erroring", async () => {
  const result = await orderCrmService.assign(db, [], "a@x.test", "admin@x.test");
  assert.deepEqual(result, { updated: [], skipped: [], errors: [] });
});

test("an unknown order id is reported as an error, not silently dropped", async () => {
  const result = await orderCrmService.assign(db, [999], "a@x.test", "admin@x.test");
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].id, 999);
});
