import { eq } from "drizzle-orm";
import type { Db } from "../db";
import { productPages } from "../schema";

// One content row per product. There is no list view: a page asks for its own
// content by product id, and a product that has never had its copy edited has
// no row at all - the column defaults are then what ships.
export const productPagesRepo = {
  async forProduct(db: Db, productId: number) {
    const [row] = await db.select().from(productPages)
      .where(eq(productPages.productId, productId))
      .limit(1);
    return row ?? null;
  },

  // Save-or-create keyed by product, so the admin form saves identically
  // whether or not a row exists yet. product_pages.product_id is UNIQUE, which
  // is the ON CONFLICT target; updatedAt is always written so a save records
  // itself even when no field actually changed.
  async save(db: Db, productId: number, input: Partial<typeof productPages.$inferInsert>) {
    const [row] = await db.insert(productPages)
      .values({ ...input, productId })
      .onConflictDoUpdate({
        target: productPages.productId,
        set: { ...input, updatedAt: new Date() },
      })
      .returning();
    return row;
  },
};
