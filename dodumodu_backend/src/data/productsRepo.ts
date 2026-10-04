import { eq, and, asc, desc, sql, type SQL } from "drizzle-orm";
import type { Db } from "../db";
import { products, productImages, categories, orders } from "../schema";

export const productsRepo = {
  async findBySlug(db: Db, slug: string) {
    const [product] = await db.select().from(products)
      .where(and(eq(products.slug, slug), eq(products.active, true)))
      .limit(1);
    return product ?? null;
  },

  async findById(db: Db, id: number) {
    const [product] = await db.select().from(products).where(eq(products.id, id)).limit(1);
    return product ?? null;
  },

  async imagesForProduct(db: Db, productId: number) {
    return db.select().from(productImages)
      .where(eq(productImages.productId, productId))
      .orderBy(asc(productImages.displayOrder));
  },

  /**
   * Just enough of a product to name it in a message: which products are in the
   * way of a category delete. Deliberately two columns, because this list exists
   * to be read by a person deciding what to do next, not to render a catalogue.
   */
  async listForCategory(db: Db, categoryId: number) {
    return db.select({ id: products.id, name: products.name, slug: products.slug })
      .from(products).where(eq(products.categoryId, categoryId)).orderBy(asc(products.name));
  },

  /**
   * The admin product list. Server-side, and selecting column by column rather
   * than with SELECT *: the catalogue table shows a name, a price and a state, and
   * description/seo fields would multiply the payload of every page for nothing.
   * The category name is joined rather than resolved per row, so a page of 50
   * products is one query instead of 51.
   */
  async listForAdmin(
    db: Db,
    opts: {
      search: string | null;
      filters: { categoryId: number | null; active: boolean | null };
      sort: { field: string; direction: "asc" | "desc" };
      limit: number;
      offset: number;
    },
  ) {
    const conditions: SQL[] = [];
    if (opts.search) {
      const pattern = `%${opts.search}%`;
      conditions.push(sql`(lower(${products.name}) like ${pattern} or lower(${products.slug}) like ${pattern})`);
    }
    if (opts.filters.categoryId !== null) conditions.push(eq(products.categoryId, opts.filters.categoryId));
    if (opts.filters.active !== null) conditions.push(eq(products.active, opts.filters.active));
    const where = conditions.length === 0 ? undefined : and(...conditions);

    const column = (() => {
      switch (opts.sort.field) {
        case "slug": return products.slug;
        case "price": return products.price;
        case "updatedAt": return products.updatedAt;
        default: return products.name;
      }
    })();
    const ordered = opts.sort.direction === "asc" ? asc(column) : desc(column);

    const rows = await db
      .select({
        id: products.id,
        slug: products.slug,
        name: products.name,
        price: products.price,
        active: products.active,
        categoryId: products.categoryId,
        updatedAt: products.updatedAt,
        categoryName: categories.name,
      })
      .from(products)
      .leftJoin(categories, eq(products.categoryId, categories.id))
      .where(where)
      // id breaks ties so a page boundary is stable: ordered by name alone, two
      // products with the same name can appear on page 1 and again on page 2.
      .orderBy(ordered, asc(products.id))
      .limit(opts.limit)
      .offset(opts.offset);

    // Same WHERE, so the count cannot disagree with the page and produce a next
    // button leading to a page with nothing on it.
    const [{ total }] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(products)
      .leftJoin(categories, eq(products.categoryId, categories.id))
      .where(where);

    return { rows, total };
  },

  /** How many orders reference this product: the check behind archive-not-delete. */
  async orderCount(db: Db, productId: number): Promise<number> {
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` })
      .from(orders).where(eq(orders.productId, productId));
    return n;
  },

  async listAll(db: Db) {
    return db.select().from(products).orderBy(asc(products.name));
  },

  /**
   * Is this slug already taken by another product? Case-insensitive, and
   * excluding one id so an edit does not collide with itself.
   */
  async slugTaken(db: Db, slug: string, excludeId?: number): Promise<boolean> {
    const conditions: SQL[] = [sql`lower(${products.slug}) = lower(${slug})`];
    if (excludeId !== undefined) conditions.push(sql`${products.id} != ${excludeId}`);
    const [row] = await db.select({ id: products.id }).from(products)
      .where(and(...conditions)).limit(1);
    return Boolean(row);
  },

  async upsert(db: Db, input: typeof products.$inferInsert & { id?: number }) {
    if (input.id) {
      const [row] = await db.update(products)
        .set({ ...input, updatedAt: new Date() })
        .where(eq(products.id, input.id))
        .returning();
      return row;
    }
    const [row] = await db.insert(products).values(input).returning();
    return row;
  },

  /**
   * Replaces a product's images in one statement-set: delete what is gone, insert
   * what is new. The panel sends the whole ordered list because there is no
   * stable per-image identity to reconcile against - an image row has no id the
   * form ever saw, and inventing one to merge against would be a second way of
   * saying the same thing.
   *
   * Individual edits (reorder, drop one) go through this too rather than through
   * a partial update, so there is one write path for a product's images and
   * therefore one place where display_order is decided.
   */
  async replaceImages(
    db: Db,
    productId: number,
    images: { r2Key: string; altText: string; displayOrder: number; width?: number | null; height?: number | null; variants?: unknown }[],
  ) {
    await db.delete(productImages).where(eq(productImages.productId, productId));
    if (images.length === 0) return [];
    const inserted = [];
    for (const image of images) {
      const [row] = await db.insert(productImages).values({
        productId,
        r2Key: image.r2Key,
        altText: image.altText,
        displayOrder: image.displayOrder,
        width: image.width ?? null,
        height: image.height ?? null,
        variants: (image.variants ?? []) as never,
      }).returning();
      inserted.push(row);
    }
    return inserted;
  },

  /** One image row, for the delete-one-image path and for the reference check. */
  async findImageById(db: Db, id: number) {
    const [row] = await db.select().from(productImages).where(eq(productImages.id, id)).limit(1);
    return row ?? null;
  },

  async deleteImageById(db: Db, id: number): Promise<boolean> {
    const deleted = await db.delete(productImages).where(eq(productImages.id, id)).returning();
    return deleted.length !== 0;
  },
};
