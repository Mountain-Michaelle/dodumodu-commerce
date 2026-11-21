import { and, eq, asc, count, ne } from "drizzle-orm";
import type { Db } from "../db";
import { testimonials } from "../schema";

/** How many WhatsApp screenshots one product's page may show. */
export const MAX_WHATSAPP_SCREENSHOTS = 5;

export const testimonialsRepo = {
  /** Visible WhatsApp screenshots per product ({ productId: n }), so the panel can say how many more fit. */
  async screenshotCounts(db: Db) {
    const rows = await db.select({ productId: testimonials.productId, n: count() }).from(testimonials)
      .where(and(eq(testimonials.kind, "whatsapp"), eq(testimonials.active, true))).groupBy(testimonials.productId);
    const out: Record<string, number> = {};
    for (const r of rows) if (r.productId != null) out[String(r.productId)] = Number(r.n);
    return out;
  },
  /** Visible screenshots of a product, not counting the row being edited. */
  async countActiveWhatsapp(db: Db, productId: number, exceptId?: number) {
    const [{ n }] = await db.select({ n: count() }).from(testimonials).where(and(
      eq(testimonials.productId, productId), eq(testimonials.kind, "whatsapp"), eq(testimonials.active, true),
      exceptId ? ne(testimonials.id, exceptId) : undefined,
    ));
    return Number(n);
  },

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

  /**
   * One page of the admin list, plus the total for its paginator. The COUNT uses
   * the same unfiltered table as the page query - a testimonial list has no
   * filters to split - so the two cannot disagree about how many pages exist.
   */
  async listPaged(db: Db, limit: number, offset: number) {
    const rows = await db.select().from(testimonials)
      .orderBy(asc(testimonials.displayOrder), asc(testimonials.id))
      .limit(limit)
      .offset(offset);
    const [{ total }] = await db.select({ total: count() }).from(testimonials);
    return { rows, total };
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
