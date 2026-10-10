import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../db";
import { adminStaff, orderAssignments, orders } from "../schema";
import { orderMatchKey, lagosDayStart } from "../abuse/orderEvidence";

// Order assignment: fulfilment routing, kept entirely outside the order/payment
// lifecycle. Every mutation here is a SINGLE guarded statement - the production
// Worker runs on the Neon HTTP driver, which has no interactive transaction, so
// correctness must never depend on one. A guarded `UPDATE ... WHERE id = $1
// AND <eligibility> RETURNING` is atomic on its own; zero rows means the row
// moved or was ineligible, which the service turns into a conflict/skip.

export type StaffRow = typeof adminStaff.$inferSelect;
export type AssignmentRow = typeof orderAssignments.$inferSelect;

/** The active staff, for the assign dropdown. `active` first so a deactivated
 * operator drops out of the picker without deleting any history they are in. */
async function listStaff(db: Db): Promise<StaffRow[]> {
  return db.select().from(adminStaff).where(eq(adminStaff.active, true)).orderBy(adminStaff.name);
}

/** The assignment history of one order, newest first - the "who set it and
 * when" the order modal shows. Bounded by the order's own (short) trail. */
async function listForOrder(db: Db, orderId: number): Promise<AssignmentRow[]> {
  return db.select().from(orderAssignments)
    .where(eq(orderAssignments.orderId, orderId))
    .orderBy(desc(orderAssignments.createdAt));
}

/**
 * The duplicate-group guard, shared by every assign.
 *
 * WHY: the same order submitted twice (same phone + address + product + qty on
 * the same Lagos day - the EXISTING duplicate rule, reused verbatim so this can
 * never disagree with the "Duplicate" badge) must never be split across two
 * staff. If a sibling is already assigned to someone else, this order cannot be
 * assigned to a different person.
 *
 * Returns the conflicting sibling's assignee, or null when the assign is clear.
 * It is a plain read, and the assign that follows is still individually guarded,
 * so two operators acting at once cannot both win: the second one's guarded
 * UPDATE re-checks and returns zero rows -> conflict.
 */
async function conflictingAssignee(
  db: Db,
  order: { id: number; phoneNorm: string | null; address: string; productId: number; quantity: number; createdAt: Date },
  targetEmail: string,
): Promise<string | null> {
  if (!order.phoneNorm) return null; // no canonical identity -> no group -> no conflict
  const dayStart = lagosDayStart(order.createdAt);
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

  // Candidates: same Lagos day, same phone. Narrow enough to be a small set; the
  // full match key is then applied in JS with the SAME function the badge uses,
  // so "duplicate for assignment" and "duplicate on screen" are one rule.
  const candidates = await db.select({
    id: orders.id, phoneNorm: orders.phoneNorm, address: orders.address,
    productId: orders.productId, quantity: orders.quantity, assignedTo: orders.assignedTo,
  }).from(orders).where(and(
    eq(orders.phoneNorm, order.phoneNorm),
    sql`${orders.createdAt} >= ${dayStart}`,
    sql`${orders.createdAt} < ${dayEnd}`,
  ));

  const myKey = orderMatchKey(order.phoneNorm, order.address, order.productId, order.quantity);
  for (const c of candidates) {
    if (c.id === order.id) continue;
    if (c.assignedTo && c.assignedTo !== targetEmail) {
      const sameOrder = orderMatchKey(c.phoneNorm as string, c.address, c.productId, c.quantity) === myKey;
      if (sameOrder) return c.assignedTo;
    }
  }
  return null;
}

/**
 * Assign one order to a staff member. Idempotent: assigning to the current
 * assignee is a no-op that reports "unchanged" rather than writing a duplicate
 * history row. Discriminated result so the caller builds its per-row outcome
 * without a second read.
 */
async function assignOrder(
  db: Db,
  id: number,
  targetEmail: string,
): Promise<{ assignedTo: string; changed: boolean } | "not_found" | "conflict"> {
  const [current] = await db.select({
    id: orders.id, phoneNorm: orders.phoneNorm, address: orders.address,
    productId: orders.productId, quantity: orders.quantity, createdAt: orders.createdAt,
    assignedTo: orders.assignedTo,
  }).from(orders).where(eq(orders.id, id)).limit(1);
  if (!current) return "not_found";

  // Idempotent: already mine -> nothing to do, no history row.
  if (current.assignedTo === targetEmail) return { assignedTo: targetEmail, changed: false };

  // The cross-staff duplicate guard (see conflictingAssignee).
  const clash = await conflictingAssignee(db, current, targetEmail);
  if (clash) return "conflict";

  // One guarded statement. IS DISTINCT FROM re-asserts the row is still not
  // already this assignee, so a concurrent assign turns into zero rows ->
  // conflict rather than a double write.
  const updated = await db.update(orders)
    .set({ assignedTo: targetEmail, assignedAt: sql`now()` })
    .where(and(eq(orders.id, id), sql`${orders.assignedTo} IS DISTINCT FROM ${targetEmail}`))
    .returning();
  if (updated.length === 0) return "conflict";
  return { assignedTo: targetEmail, changed: true };
}

/** Clear the assignee. Idempotent: unassigning an already-unassigned order is a no-op. */
async function unassignOrder(db: Db, id: number): Promise<"not_found" | "unchanged" | "cleared"> {
  const [current] = await db.select({ id: orders.id, assignedTo: orders.assignedTo })
    .from(orders).where(eq(orders.id, id)).limit(1);
  if (!current) return "not_found";
  if (!current.assignedTo) return "unchanged";
  const updated = await db.update(orders)
    .set({ assignedTo: null, assignedAt: null })
    .where(and(eq(orders.id, id), sql`${orders.assignedTo} IS NOT NULL`))
    .returning();
  return updated.length === 0 ? "unchanged" : "cleared";
}

/** Append one assignment-history row. Never blocks the mutation it describes. */
async function writeHistory(
  db: Db, orderId: number, assigneeEmail: string, actorEmail: string,
  action: "assign" | "unassign", reason?: string,
): Promise<void> {
  await db.insert(orderAssignments).values({ orderId, assigneeEmail, actorEmail, action, reason: reason ?? null });
}

export const assignmentRepo = {
  listStaff, listForOrder, conflictingAssignee, assignOrder, unassignOrder, writeHistory,
};
