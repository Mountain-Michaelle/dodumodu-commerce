import { desc, eq, sql } from "drizzle-orm";
import type { Db } from "../db";
import { productPublishes } from "../schema";

// The publish log is append-only on purpose: nothing here updates or deletes a
// snapshot, because a snapshot is what makes a build reproducible. If it could
// be edited it would stop being a record of what actually shipped.
// The publish log is append-only on the PAYLOAD: nothing here rewrites or deletes a
// snapshot, because a snapshot is what makes a build reproducible. If it could be
// edited it would stop being a record of what actually shipped.
//
// `buildStatus` is the deliberate exception, and it is worth being precise about why
// that is not a contradiction. It is not part of the published content - it is
// delivery bookkeeping about what happened AFTER the snapshot was written. A
// publish is immutable; the fact that Cloudflare accepted the hook, then failed to
// rebuild, then succeeded on a retry says nothing about what was published.
export const publishesRepo = {
  async record(db: Db, input: typeof productPublishes.$inferInsert) {
    const [row] = await db.insert(productPublishes).values(input).returning();
    return row;
  },

  /**
   * Records the DEPLOYMENT outcome against an existing snapshot.
   *
   * `payload` is deliberately absent from the SET list. That is the whole point of
   * this method: the statement cannot corrupt published content even if it were
   * called with the wrong row.
   *
   * Returns false when the row is gone, so a retry against a deleted publish fails
   * quietly rather than throwing from a path that is trying to recover from a
   * failure already.
   */
  async markBuildStatus(db: Db, id: number, status: string): Promise<boolean> {
    const rows = await db.update(productPublishes)
      .set({ buildStatus: status })
      .where(eq(productPublishes.id, id))
      .returning();
    return rows.length > 0;
  },

  /** Records the outcome of one deploy attempt, error text included, and counts it. */
  async recordDeployAttempt(
    db: Db, id: number,
    attempt: { status: string; error: string | null; httpStatus: number | null },
  ): Promise<boolean> {
    const rows = await db.update(productPublishes)
      .set({
        buildStatus: attempt.status,
        deployError: attempt.error,
        deployHttpStatus: attempt.httpStatus,
        deployAttempts: sql`${productPublishes.deployAttempts} + 1`,
        deployAttemptedAt: new Date(),
      })
      .where(eq(productPublishes.id, id))
      .returning();
    return rows.length > 0;
  },

  /** The newest publish of EVERY product: what a storefront build must render. */
  async latestPerProduct(db: Db) {
    const rows = await db.select().from(productPublishes).orderBy(desc(productPublishes.id));
    const seen = new Set<number>();
    return rows.filter((r) => (seen.has(r.productId) ? false : (seen.add(r.productId), true)));
  },

  // The newest snapshot for one product: what the live site was built from.
  // Ordered by id rather than created_at, because ids cannot tie - two
  // publishes in the same second otherwise have no defined order.
  async latestForProduct(db: Db, productId: number) {
    const [row] = await db.select().from(productPublishes)
      .where(eq(productPublishes.productId, productId))
      .orderBy(desc(productPublishes.id))
      .limit(1);
    return row ?? null;
  },

  // History for the admin panel, deliberately without payload: this list exists
  // to show who published what and when, and one payload per row would have the
  // query carry hundreds of kilobytes nobody asked for.
  async listForProduct(db: Db, productId: number, limit = 20) {
    return db.select({
      id: productPublishes.id,
      publishedBy: productPublishes.publishedBy,
      buildStatus: productPublishes.buildStatus,
      publishRef: productPublishes.publishRef,
      deployError: productPublishes.deployError,
      deployAttempts: productPublishes.deployAttempts,
      createdAt: productPublishes.createdAt,
    })
      .from(productPublishes)
      .where(eq(productPublishes.productId, productId))
      .orderBy(desc(productPublishes.id))
      .limit(limit);
  },
};
