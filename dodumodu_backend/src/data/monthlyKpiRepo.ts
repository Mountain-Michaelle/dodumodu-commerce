import { and, eq, gte, inArray, lt } from "drizzle-orm";
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
