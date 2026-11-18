import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db";
import { productPublishes, products } from "../schema";

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

  /**
   * What a build's outcome means for the publishes it carried. "verified" is the durable "this snapshot is live"
   * marker the Worker serves from after any rebuild; a failure never downgrades a publish that already went live.
   */
  async setBuildOutcome(db: Db, publishRefs: string[], status: "verified" | "failed", error?: string | null) {
    if (publishRefs.length === 0) return;
    const where = status === "failed"
      ? and(inArray(productPublishes.publishRef, publishRefs), sql`${productPublishes.buildStatus} <> 'verified'`)
      : inArray(productPublishes.publishRef, publishRefs);
    await db.update(productPublishes)
      .set(status === "failed" ? { buildStatus: "failed", deployError: error ?? null } : { buildStatus: "verified", deployError: null })
      .where(where);
  },

  async setBuildOutcomeById(db: Db, id: number, error?: string | null) {
    await db.update(productPublishes)
      .set({ buildStatus: "failed", deployError: error ?? null })
      .where(and(eq(productPublishes.id, id), sql`${productPublishes.buildStatus} <> 'verified'`));
  },

  /** The newest VERIFIED snapshot of one product, by slug: what customers must keep getting after any rebuild. */
  async latestLiveBySlug(db: Db, slug: string) {
    const [row] = await db.select({
      id: productPublishes.id, publishRef: productPublishes.publishRef, payload: productPublishes.payload,
    })
      .from(productPublishes)
      .innerJoin(products, eq(products.id, productPublishes.productId))
      .where(and(eq(products.slug, slug), eq(productPublishes.buildStatus, "verified")))
      .orderBy(desc(productPublishes.id))
      .limit(1);
    return row ?? null;
  },

  /** Slugs that have a verified snapshot (for the sitemap). */
  async liveSlugs(db: Db): Promise<string[]> {
    const rows = await db.selectDistinct({ slug: products.slug })
      .from(productPublishes)
      .innerJoin(products, eq(products.id, productPublishes.productId))
      .where(eq(productPublishes.buildStatus, "verified"));
    return rows.map((r) => r.slug);
  },

  /** The newest publish of EVERY product: what a storefront build must render. */
  async latestPerProduct(db: Db) {
    const rows = await db.select().from(productPublishes).orderBy(desc(productPublishes.id));
    const seen = new Set<number>();
    return rows.filter((r) => (seen.has(r.productId) ? false : (seen.add(r.productId), true)));
  },

  /** Products that have been published at least once (a draft that was never published must never be published by a side effect). */
  async publishedProductIds(db: Db): Promise<number[]> {
    const rows = await db.selectDistinct({ id: productPublishes.productId }).from(productPublishes);
    return rows.map((r) => r.id);
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
