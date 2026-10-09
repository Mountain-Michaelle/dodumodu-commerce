import { and, asc, eq, gte, inArray, lt } from "drizzle-orm";
import type { Db } from "../db";
import { monthlyKpiSnapshots, orders, orderStatusHistory } from "../schema";

export const monthlyKpiRepo = {
  async ordersBetween(db: Db, from: Date, to: Date) {
    return db.select({
      id: orders.id,
      reference: orders.reference,
      createdAt: orders.createdAt,
      status: orders.status,
      paymentMethod: orders.paymentMethod,
      amount: orders.amount,
      deliveredAt: orders.deliveredAt,
      phone: orders.phone,
      phoneNorm: orders.phoneNorm,
      address: orders.address,
      productId: orders.productId,
      quantity: orders.quantity,
    }).from(orders)
      .where(and(gte(orders.createdAt, from), lt(orders.createdAt, to)))
      .orderBy(orders.createdAt, orders.id);
  },

  async deliveryEventsBetween(db: Db, from: Date, to: Date) {
    return db.select({
      orderId: orderStatusHistory.orderId,
      createdAt: orderStatusHistory.createdAt,
    }).from(orderStatusHistory)
      .where(and(
        eq(orderStatusHistory.newStatus, "delivered"),
        gte(orderStatusHistory.createdAt, from),
        lt(orderStatusHistory.createdAt, to),
      ));
  },

  async currentlyDeliveredBetween(db: Db, from: Date, to: Date) {
    return db.select({
      id: orders.id,
      deliveredAt: orders.deliveredAt,
    }).from(orders)
      .where(and(
        eq(orders.status, "delivered"),
        gte(orders.deliveredAt, from),
        lt(orders.deliveredAt, to),
      ));
  },

  async earliestOrder(db: Db) {
    // The oldest stored order, so the report window can start at the month the
    // business actually began trading instead of blindly covering the requested
    // 12/24 months and surfacing phantom pre-launch months.
    const [row] = await db.select({ createdAt: orders.createdAt }).from(orders)
      .orderBy(asc(orders.createdAt))
      .limit(1);
    return row?.createdAt ?? null;
  },

  async snapshotsForMonths(db: Db, months: string[]) {
    if (months.length === 0) return [];
    return db.select().from(monthlyKpiSnapshots)
      .where(inArray(monthlyKpiSnapshots.month, months));
  },

  async insertSnapshots(db: Db, values: (typeof monthlyKpiSnapshots.$inferInsert)[]) {
    if (values.length === 0) return [];
    return db.insert(monthlyKpiSnapshots).values(values)
      .onConflictDoNothing({ target: monthlyKpiSnapshots.month })
      .returning();
  },
};
