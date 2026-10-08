import { eq, and, asc, sql, like, lt, lte, gte, ne, inArray, or, desc, count, type SQL } from "drizzle-orm";
import type { Db } from "../db";
import { categories, orders, orderStatusHistory, products } from "../schema";

// §5.4b — the only transitions legal in V1. Checked here, not trusted from callers.
// Phase 7a additions: cancelled and not_picking are terminal except for reversal,
// which restores the pre_cancellation_status atomically in one statement.
const LEGAL_TRANSITIONS: Record<string, string[]> = {
  awaiting_payment: ["paid", "failed", "cancelled"],
  paid: ["delivered", "cancelled"],
  confirmed_cod: ["delivered", "cancelled"],
  failed: ["cancelled"],
  delivered: [],
  cancelled: [],
  not_picking: [],
};

export type OrderRow = typeof orders.$inferSelect;

function updatedAtVersionCondition(expectedUpdatedAt: Date): SQL {
  // PostgreSQL timestamps retain microseconds, while Date/JSON preserve only
  // milliseconds. Match the millisecond bucket sent to the browser instead of
  // comparing against a timestamp whose remaining precision was truncated.
  const nextMillisecond = new Date(expectedUpdatedAt.getTime() + 1);
  return sql`${orders.updatedAt} >= ${expectedUpdatedAt} AND ${orders.updatedAt} < ${nextMillisecond}`;
}

export const ordersRepo = {
  async findByIdempotencyKey(db: Db, idempotencyKey: string): Promise<OrderRow | null> {
    const [row] = await db.select().from(orders)
      .where(eq(orders.idempotencyKey, idempotencyKey)).limit(1);
    return row ?? null;
  },

  /**
   * Deliberately case-insensitive, and this is load-bearing rather than tidy.
   *
   * The only caller is the payment webhook, which looks the order up by the
   * reference the payment provider echoed back. That value can differ in case
   * from what we stored — every reference written before the lowercase format
   * is uppercase, and a provider is free to normalise what it echoes — and a
   * plain `eq()` comparison in Postgres is case-sensitive. Missing here means
   * `order_not_found`, which means a paid order is never marked paid.
   *
   * Cost: this can no longer use the UNIQUE index on `reference`, so it is a
   * scan of the orders table. That is one scan per webhook on a table we
   * control, and it only happens after a signature check has already passed.
   */
  async findByReference(db: Db, reference: string): Promise<OrderRow | null> {
    const [row] = await db.select().from(orders)
      .where(sql`lower(${orders.reference}) = lower(${reference})`).limit(1);
    return row ?? null;
  },

  async findById(db: Db, id: number): Promise<OrderRow | null> {
    const [row] = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
    return row ?? null;
  },

  /**
   * Insert a new order. If two requests race with the same idempotency key,
   * the UNIQUE constraint on idempotency_key rejects the loser — the caller
   * (orderService) catches that and re-fetches the winner's row.
   */
  async insert(db: Db, input: typeof orders.$inferInsert): Promise<OrderRow> {
    const [row] = await db.insert(orders).values(input).returning();
    return row;
  },

  async writeStatusHistory(
    db: Db,
    orderId: number,
    oldStatus: string | null,
    newStatus: string,
    changedBy: string,
    reason?: string,
  ) {
    await db.insert(orderStatusHistory).values({
      orderId, oldStatus, newStatus, changedBy, reason: reason ?? null,
    });
  },

  /**
   * §5.4b — atomic, conditional status transition. Never read-then-write:
   * the WHERE clause is what makes concurrent callers (webhook + reconcile,
   * or two webhook deliveries) safe. Exactly one caller ever sees `applied: true`
   * for a given fromStatus->toStatus pair on one order.
   */
  async applyStatusTransition(
    db: Db,
    orderId: number,
    fromStatus: string,
    toStatus: string,
    changedBy: string,
    reason?: string,
  ): Promise<{ applied: boolean; order: OrderRow | null; illegal?: boolean }> {
    const allowed = LEGAL_TRANSITIONS[fromStatus] ?? [];
    if (!allowed.includes(toStatus)) {
      return { applied: false, order: await this.findById(db, orderId), illegal: true };
    }

    const updated = await db.update(orders)
      .set({ status: toStatus as OrderRow["status"], updatedAt: new Date() })
      .where(and(eq(orders.id, orderId), eq(orders.status, fromStatus as OrderRow["status"])))
      .returning();

    if (updated.length === 0) {
      // Someone else already transitioned this order first. No-op, not an error.
      return { applied: false, order: await this.findById(db, orderId) };
    }

    await this.writeStatusHistory(db, orderId, fromStatus, toStatus, changedBy, reason);
    return { applied: true, order: updated[0] };
  },

  async incrementRetryCount(db: Db, orderId: number) {
    const [row] = await db.update(orders)
      .set({ retryCount: sql`${orders.retryCount} + 1`, lastCheckedAt: new Date() })
      .where(eq(orders.id, orderId))
      .returning();
    return row;
  },

  async findStalePending(db: Db, olderThanMinutes: number): Promise<OrderRow[]> {
    const cutoff = new Date(Date.now() - olderThanMinutes * 60_000);
    return db.select().from(orders)
      .where(and(eq(orders.status, "awaiting_payment"), lt(orders.createdAt, cutoff)));
  },

  /**
   * The admin listing. Everything about it is server-side on purpose: a table of
   * a few thousand orders cannot be fetched whole and filtered in a browser
   * without the browser first downloading every order, including the ones it was
   * never asked to show, each of which is somebody's name, phone number and
   * address.
   *
   * The joins exist because the alternative is worse. Returning product_id and
   * letting the panel resolve names is an N+1 on the page an operator stares at
   * all day; selecting just the order columns loses the product and category, so
   * "orders for the serum in Skin Cares" could not be filtered at all. Both joins
   * are on primary keys behind non-null foreign keys, so the row count cannot
   * change and no order can be dropped or duplicated by the join.
   */
  async listForAdmin(
    db: Db,
    opts: {
      search: string | null;
      filters: OrderListFilters;
      sort: { field: string; direction: "asc" | "desc" };
      limit: number;
      offset: number;
    },
  ): Promise<{ rows: OrderListItem[]; total: number }> {
    const where = buildOrderWhere(opts.search, opts.filters);
    const ordered = opts.sort.direction === "asc"
      ? asc(orderSortColumn(opts.sort.field))
      : desc(orderSortColumn(opts.sort.field));

    const rows = await db
      .select({
        order: orders,
        productName: products.name,
        productSlug: products.slug,
        categoryName: categories.name,
      })
      .from(orders)
      .innerJoin(products, eq(orders.productId, products.id))
      .leftJoin(categories, eq(products.categoryId, categories.id))
      .where(where)
      // The tie-break is what makes the page boundary stable. Ordered by
      // created_at alone, two orders in the same second can appear on page 1 and
      // again on page 2, and an operator marking the second copy delivered is
      // acting on a row they already acted on.
      .orderBy(ordered, desc(orders.id))
      .limit(opts.limit)
      .offset(opts.offset);

    // Same WHERE, same joins, one number. A count that drifted from the page
    // query shows pagination that lies: a next button to a page with nothing on it.
    const [{ total }] = await db
      .select({ total: count() })
      .from(orders)
      .innerJoin(products, eq(orders.productId, products.id))
      .leftJoin(categories, eq(products.categoryId, categories.id))
      .where(where);

    return {
      rows: rows.map((row) => ({
        ...row.order,
        productName: row.productName,
        productSlug: row.productSlug,
        categoryName: row.categoryName,
      })),
      total,
    };
  },

  /**
   * Edits to the fulfilment record: what the deliverer was told, and the internal
   * note. Deliberately not the money fields - amount, unit price, discount and
   * status are a receipt of what was quoted and agreed, and editing them after the
   * fact rewrites history without leaving a trace. Payment state moves through
   * orderCrmService, which writes history and says who did it.
   *
   * expectedUpdatedAt is part of the WHERE rather than checked afterwards: a read
   * then a write is a window, and two admins editing the same customer details
   * would silently end with one of their edits gone.
   */
  async updateEditableFields(
    db: Db,
    id: number,
    patch: Partial<Pick<OrderRow, "customerName" | "phone" | "whatsapp" | "address" | "state" | "questionNotes" | "deliveredAt">>,
    expectedUpdatedAt: Date | null,
  ): Promise<OrderRow | null> {
    const where = expectedUpdatedAt === null
      ? eq(orders.id, id)
      : and(eq(orders.id, id), updatedAtVersionCondition(expectedUpdatedAt));
    const [row] = await db.update(orders).set({ ...patch, updatedAt: new Date() }).where(where).returning();
    return row ?? null;
  },

  /**
   * A status change guarded on BOTH the status and the version the caller was
   * shown. One statement, so it is atomic on its own without needing a
   * transaction - the Neon HTTP driver does not offer multi-statement ones.
   *
   * It writes no history, because history is the caller's decision: the webhook
   * path and an admin override record different things and must not share a
   * helper that decides for them. Returning null means "the row moved", which the
   * caller turns into a 409 with the current row attached.
   *
   * expectedUpdatedAt null is for a caller that has just re-read the row and is
   * racing only another transition, not another edit - which is exactly what the
   * bulk actions do, having read the status in the same request.
   */
  async guardedStatusUpdate(
    db: Db,
    id: number,
    expectedStatus: string,
    toStatus: string,
    extraPatch: Partial<typeof orders.$inferInsert> = {},
    expectedUpdatedAt: Date | null = null,
  ): Promise<OrderRow | null> {
    const conditions: ReturnType<typeof sql>[] = [
      sql`${orders.id} = ${id}`,
      sql`${orders.status} = ${expectedStatus}`,
    ];
    if (expectedUpdatedAt !== null) conditions.push(updatedAtVersionCondition(expectedUpdatedAt));
    const [row] = await db.update(orders)
      .set({ ...extraPatch, status: toStatus as OrderRow["status"], updatedAt: new Date() })
      .where(and(...conditions))
      .returning();
    return row ?? null;
  },

  /**
   * Marks delivered and stamps delivered_at in ONE statement.
   *
   * This is the single most important atomicity decision in the admin, so it is
   * worth being explicit about why it is one statement rather than a
   * read-then-write. The two columns are a fact about the same event: either the
   * order is delivered AND has a delivery time, or it is not delivered AND has
   * none. Two statements leave a window in which a crash, or a concurrent
   * reader, observes "delivered, never delivered at" or the reverse - and the
   * second of those is indistinguishable from a bug that loses money.
   *
   * The WHERE carries both the current status and the version the operator was
   * shown, so a lost update is a 409 rather than a silent overwrite.
   */
  async markDelivered(
    db: Db,
    id: number,
    expectedStatus: string,
    expectedUpdatedAt: Date | null = null,
    deliveredAt: Date = new Date(),
  ): Promise<OrderRow | null> {
    const conditions: SQL[] = [
      sql`${orders.id} = ${id}`,
      sql`${orders.status} = ${expectedStatus}`,
    ];
    if (expectedUpdatedAt !== null) conditions.push(updatedAtVersionCondition(expectedUpdatedAt));
    const [row] = await db.update(orders)
      .set({ status: "delivered", deliveredAt, updatedAt: new Date() })
      .where(and(...conditions))
      .returning();
    return row ?? null;
  },

  /**
   * Undoes a delivery: status back to whatever it was before, delivered_at NULL.
   *
   * The caller passes the status to return to rather than this hardcoding one,
   * because "revert pending" means "undo the delivery", and a pay-now order that
   * was delivered goes back to paid, not to awaiting_payment. Reverting to a
   * hardcoded status would quietly claim money that was in fact collected.
   */
  async revertDelivery(
    db: Db,
    id: number,
    toStatus: string,
    expectedUpdatedAt: Date | null = null,
  ): Promise<OrderRow | null> {
    const conditions: SQL[] = [
      sql`${orders.id} = ${id}`,
      sql`${orders.status} = 'delivered'`,
    ];
    if (expectedUpdatedAt !== null) conditions.push(updatedAtVersionCondition(expectedUpdatedAt));
    const [row] = await db.update(orders)
      .set({ status: toStatus as OrderRow["status"], deliveredAt: null, updatedAt: new Date() })
      .where(and(...conditions))
      .returning();
    return row ?? null;
  },

  /**
   * Cancel an order. Stores the current status so reversal can restore it.
   * Cancellation is allowed from any non-terminal state.
   */
  async cancel(
    db: Db,
    id: number,
    expectedStatus: string,
    expectedUpdatedAt: Date | null = null,
  ): Promise<OrderRow | null> {
    const conditions: SQL[] = [
      sql`${orders.id} = ${id}`,
      sql`${orders.status} = ${expectedStatus}`,
    ];
    if (expectedUpdatedAt !== null) conditions.push(updatedAtVersionCondition(expectedUpdatedAt));
    const [row] = await db.update(orders)
      .set({
        status: "cancelled" as OrderRow["status"],
        preCancellationStatus: expectedStatus,
        updatedAt: new Date(),
      })
      .where(and(...conditions))
      .returning();
    return row ?? null;
  },

  /**
   * Revert a cancellation: restore the status that was current when cancelled.
   * This is the only way to undo a cancellation - it restores exactly what came before.
   */
  async revertCancellation(
    db: Db,
    id: number,
    expectedUpdatedAt: Date | null = null,
  ): Promise<OrderRow | null> {
    const conditions: SQL[] = [
      sql`${orders.id} = ${id}`,
      sql`${orders.status} = 'cancelled'`,
      sql`${orders.preCancellationStatus} IS NOT NULL`,
    ];
    if (expectedUpdatedAt !== null) conditions.push(updatedAtVersionCondition(expectedUpdatedAt));
    const [row] = await db.update(orders)
      .set({
        status: sql`${orders.preCancellationStatus}::order_status`,
        preCancellationStatus: null,
        updatedAt: new Date(),
      })
      .where(and(...conditions))
      .returning();
    return row ?? null;
  },

  /**
   * Mark an order as Not Picking. This is a terminal fulfilment state, distinct
   * from cancellation. Once set, it stays unless admin explicitly reverts it.
   */
  async markNotPicking(
    db: Db,
    id: number,
    expectedStatus: string,
    expectedUpdatedAt: Date | null = null,
  ): Promise<OrderRow | null> {
    const conditions: SQL[] = [
      sql`${orders.id} = ${id}`,
      sql`${orders.status} = ${expectedStatus}`,
    ];
    if (expectedUpdatedAt !== null) conditions.push(updatedAtVersionCondition(expectedUpdatedAt));
    const [row] = await db.update(orders)
      .set({
        status: "not_picking" as OrderRow["status"],
        preNotPickingStatus: expectedStatus,
        updatedAt: new Date(),
      })
      .where(and(...conditions))
      .returning();
    return row ?? null;
  },

  /**
   * Revert Not Picking back to the previous state. Unlike cancellation reversal,
   * this requires explicit knowledge of the previous status because Not Picking
   * does not store it (it is a permanent mark, not a suspension).
   */
  async revertNotPicking(
    db: Db,
    id: number,
    expectedUpdatedAt: Date | null = null,
  ): Promise<OrderRow | null> {
    const conditions: SQL[] = [
      sql`${orders.id} = ${id}`,
      sql`${orders.status} = 'not_picking'`,
      sql`${orders.preNotPickingStatus} IS NOT NULL`,
    ];
    if (expectedUpdatedAt !== null) conditions.push(updatedAtVersionCondition(expectedUpdatedAt));
    const [row] = await db.update(orders)
      .set({
        status: sql`${orders.preNotPickingStatus}::order_status`,
        preNotPickingStatus: null,
        updatedAt: new Date(),
      })
      .where(and(...conditions))
      .returning();
    return row ?? null;
  },

  /** Ids only, newest first, for the bulk action preview: what would this affect. */
  async matchingIds(
    db: Db,
    search: string | null,
    filters: OrderListFilters,
    cap: number,
  ): Promise<number[]> {
    const rows = await db.select({ id: orders.id }).from(orders)
      .innerJoin(products, eq(orders.productId, products.id))
      .leftJoin(categories, eq(products.categoryId, categories.id))
      .where(buildOrderWhere(search, filters))
      .orderBy(desc(orders.createdAt), desc(orders.id))
      .limit(cap);
    return rows.map((row) => row.id);
  },
  async findPotentialDuplicates(db: Db, order: OrderRow, windowMinutes = 30): Promise<OrderRow[]> {
    const windowStart = new Date(order.createdAt.getTime() - windowMinutes * 60_000);
    const windowEnd = new Date(order.createdAt.getTime() + windowMinutes * 60_000);
    return db.select().from(orders).where(and(
      eq(orders.phone, order.phone),
      eq(orders.address, order.address),
      eq(orders.productId, order.productId),
      ne(orders.id, order.id),
      gte(orders.createdAt, windowStart),
      lt(orders.createdAt, windowEnd),
    ));
  },
 /**
   * The rows behind an id set, in one read. A bulk action reads the ids it is
   * about to touch rather than trusting what the browser believes they contain:
   * the statuses a page rendered two minutes ago are not a statement about the
   * database now, and every transition is checked against what is actually there.
   */
  /**
   * Every order created inside a window. Used once per page to find duplicates,
   * rather than once per row - see the note in routes/admin/orders.ts.
   *
   * It returns whole rows because the grouping is done in memory and needs phone,
   * address and product_id off each one. The window is bounded by the page being
   * displayed plus the duplicate threshold on each side, so it cannot become a
   * full-table scan however large the orders table grows.
   */
  async ordersCreatedBetween(db: Db, from: Date, to: Date): Promise<OrderRow[]> {
    return db.select().from(orders)
      .where(and(gte(orders.createdAt, from), lte(orders.createdAt, to)));
  },

  /** The audit trail for one order, newest first. Two columns plus the reason. */
  async statusHistoryForOrder(db: Db, orderId: number) {
    return db.select({
      id: orderStatusHistory.id,
      oldStatus: orderStatusHistory.oldStatus,
      newStatus: orderStatusHistory.newStatus,
      changedBy: orderStatusHistory.changedBy,
      reason: orderStatusHistory.reason,
      createdAt: orderStatusHistory.createdAt,
    })
      .from(orderStatusHistory)
      .where(eq(orderStatusHistory.orderId, orderId))
      .orderBy(desc(orderStatusHistory.id));
  },

  async findByIds(db: Db, ids: number[]): Promise<OrderRow[]> {
    if (ids.length === 0) return [];
    return db.select().from(orders).where(inArray(orders.id, ids));
  },

  /**
   * Deletes one order and its status history.
   *
   * The history rows go first, explicitly, rather than relying on a cascade.
   * order_status_history.order_id has no ON DELETE CASCADE (0000 created it long
   * before deleting an order was a thing anyone could do), so without this the
   * second statement fails on the foreign key and the order survives - which
   * looks like a successful delete to the operator while nothing happened.
   *
   * order_status_history is small and bounded (one row per transition), so this
   * is a plain indexed delete rather than a cascade worth depending on being
   * present in every environment.
   */
  async deleteById(db: Db, id: number): Promise<boolean> {
    await db.delete(orderStatusHistory).where(eq(orderStatusHistory.orderId, id));
    const deleted = await db.delete(orders).where(eq(orders.id, id)).returning();
    return deleted.length !== 0;
  },
};
// ---------------------------------------------------------------------------
// The admin listing: filters, search and sorting, assembled here rather than
// passed through from a query string.
//
// Three rules are what make this safe instead of merely convenient:
//   - sort fields come from an allowlist, so a caller chooses an ordering and can
//     never name a column;
//   - every filter is typed and bounded before it reaches SQL;
//   - the search term is bound as a value and never spliced into text.
// ---------------------------------------------------------------------------

export const ORDER_SORT_FIELDS = [
  "createdAt", "updatedAt", "status", "amount", "reference", "phone", "deliveredAt",
] as const;

export type OrderListFilters = {
  status: string | null;
  action: string | null;
  paymentMethod: "pay_now" | "cod" | null;
  phone: string | null;
  from: Date | null;
  to: Date | null;
  productId: number | null;
  categoryId: number | null;
};

/**
 * Turns validated query-string filters into the shape the repository wants.
 *
 * The one interesting decision is the date range. The panel sends YYYY-MM-DD
 * because that is what a person picks, and "the 3rd" means the WHOLE 3rd - so
 * 	o is pushed to 23:59:59.999 of its own day. Without that,
 * created_at <= '2026-01-03' compares against midnight and excludes nearly the
 * entire day the operator selected, which reads as a broken filter rather than as
 * a boundary condition, and is why date filters get abandoned.
 */
export function filtersFromQuery(input: {
  status?: string;
  action?: string;
  paymentMethod?: "pay_now" | "cod";
  phone?: string;
  productId?: number;
  categoryId?: number;
  from?: string;
  to?: string;
}): OrderListFilters {
  return {
    status: input.status ?? null,
    action: input.action ?? null,
    paymentMethod: input.paymentMethod ?? null,
    phone: input.phone?.trim() || null,
    productId: input.productId ?? null,
    categoryId: input.categoryId ?? null,
    from: input.from ? new Date(input.from + 'T00:00:00.000') : null,
    to: input.to ? new Date(input.to + 'T23:59:59.999') : null,
  };
}

export type OrderListItem = OrderRow & {
  productName: string;
  productSlug: string;
  categoryName: string | null;
};

const orderSortColumn = (field: string) => {
  switch (field) {
    case "updatedAt": return orders.updatedAt;
    case "status": return orders.status;
    case "amount": return orders.amount;
    case "reference": return orders.reference;
    case "phone": return orders.phone;
    case "deliveredAt": return orders.deliveredAt;
    default: return orders.createdAt;
  }
};

/**
 * Built once and handed to both the page query and the count query, because the
 * two drifting is how a listing ends up with a page 3 that does not exist.
 */
function buildOrderWhere(search: string | null, filters: OrderListFilters) {
  const conditions = [];

  if (search) {
    // Three ways a person finds one order among thousands: they have the
    // reference, they have the phone number, or they remember the name. The
    // first two are indexed lookups. Phone is a prefix match rather than a
    // substring precisely so idx_orders_phone can serve it - searching the
    // middle of a number would find marginally more at the cost of a full scan
    // on every keystroke, which is a worse trade the first time the list is slow.
    conditions.push(or(
      sql`lower(${orders.reference}) = lower(${search})`,
      sql`lower(${orders.reference}) like ${search + "%"}`,
      sql`${orders.phone} like ${search + "%"}`,
      sql`lower(${orders.customerName}) like ${"%" + search + "%"}`,
      sql`replace(lower(${orders.status}::text), '_', ' ') like ${"%" + search.replace(/[_-]+/g, " ") + "%"}`,
    ));
  }
  if (filters.status) conditions.push(eq(orders.status, filters.status as OrderRow["status"]));
  if (filters.action) {
    const actionConditions: Record<string, SQL> = {
      deliver: inArray(orders.status, ["paid", "confirmed_cod"]),
      revert: eq(orders.status, "delivered"),
      "mark-paid": and(eq(orders.status, "awaiting_payment"), eq(orders.paymentMethod, "pay_now"))!,
      "mark-failed": and(eq(orders.status, "awaiting_payment"), eq(orders.paymentMethod, "pay_now"))!,
      cancel: inArray(orders.status, ["awaiting_payment", "paid", "confirmed_cod", "failed"]),
      "revert-cancel": and(eq(orders.status, "cancelled"), sql`${orders.preCancellationStatus} IS NOT NULL`)!,
      "mark-not-picking": inArray(orders.status, ["paid", "confirmed_cod"]),
      "revert-not-picking": and(eq(orders.status, "not_picking"), sql`${orders.preNotPickingStatus} IS NOT NULL`)!,
    };
    const actionCondition = actionConditions[filters.action];
    if (actionCondition) conditions.push(actionCondition);
  }
  if (filters.paymentMethod) conditions.push(eq(orders.paymentMethod, filters.paymentMethod));
  if (filters.phone) conditions.push(like(orders.phone, filters.phone + "%"));
  if (filters.from) conditions.push(gte(orders.createdAt, filters.from));
  if (filters.to) conditions.push(lte(orders.createdAt, filters.to));
  if (filters.productId) conditions.push(eq(orders.productId, filters.productId));
  // The only condition that reaches outside the orders table, and the reason the
  // count query has to repeat the joins rather than skip them.
  if (filters.categoryId) conditions.push(eq(products.categoryId, filters.categoryId));

  return conditions.length === 0 ? undefined : and(...conditions);
}
