import { and, eq, asc } from "drizzle-orm";
import type { Db } from "../db";
import { testimonials } from "../schema";

export const testimonialsRepo = {
  // Testimonials are product content now. A page must never show a review that
  // belongs to a different product, so the scope is part of the read rather than
  // a filter every caller is expected to remember.
  async listActiveForProduct(db: Db, productId: number) {
    return db.select().from(testimonials)
      .where(and(eq(testimonials.active, true), eq(testimonials.productId, productId)))
      .orderBy(asc(testimonials.displayOrder));
  },

  async listAll(db: Db) {
    return db.select().from(testimonials).orderBy(asc(testimonials.displayOrder));
  },

  async upsert(db: Db, input: typeof testimonials.$inferInsert & { id?: number }) {
    if (input.id) {
      const [row] = await db.update(testimonials)
        .set(input)
        .where(eq(testimonials.id, input.id))
        .returning();
      return row;
    }
    const [row] = await db.insert(testimonials).values(input).returning();
    return row;
  },
};
