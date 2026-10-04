import { and, asc, desc, eq, sql, type SQL } from "drizzle-orm";
import type { Db } from "../db";
import { media, productImages, products, testimonials, categories } from "../schema";

export type MediaRow = typeof media.$inferSelect;
export type MediaFilter = "all" | "unattached" | "unused";

export type MediaListOptions = {
  search: string | null;
  filter: MediaFilter;
  productId: number | null;
  sort: { field: string; direction: "asc" | "desc" };
  limit: number;
  offset: number;
};

export const MEDIA_SORT_FIELDS = ["createdAt", "byteSize", "r2Key"] as const;

/**
 * The reference inventory: every key any row currently points at, as one
 * statement.
 *
 * "Is this key in use" has exactly one honest answer, and it is to ask every
 * table that can hold a key. The alternatives all drift: a counter on the media
 * row, or a flag set when an admin attaches an image, are both claims about other
 * tables that go wrong the first time a row is edited through a path that
 * forgot to update them. Asking the tables instead means the answer cannot be
 * stale, because it is never stored.
 *
 * Three details are load-bearing rather than cautious:
 *
 *  - variants is jsonb and its shape is whatever was written. jsonb_typeof guards
 *    every expansion: one legacy row holding an object instead of an array would
 *    otherwise make the whole inventory fail, and an inventory that errors is one
 *    that a caller will be tempted to treat as "not in use". That is how an image
 *    on a live page gets deleted.
 *  - product_publishes is the payload a build renders from, so a key inside it is
 *    in use even though no editable row points at it. Only the newest publish per
 *    product counts: that is the one a build reads, and a snapshot older than it
 *    is a record of the past rather than something still being rendered.
 *  - Every branch discards null and empty keys, because the result is used in an
 *    IN comparison and one null in that list turns the whole comparison into
 *    "no rows", silently reporting every image as unused.
 */
const REFERENCES = sql`
  select i.r2_key as key, 'product image'::text as source, i.product_id as owner_id, 'product'::text as owner_kind
    from product_images i
   where i.r2_key != ''
  union all
  select jsonb_extract_path_text(v.value, 'key'), 'image variant'::text, i.product_id, 'product'::text
    from product_images i
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(i.variants) = 'array' then i.variants else '[]'::jsonb end
    ) v
   where jsonb_extract_path_text(v.value, 'key') is not null
  union all
  select t.r2_key, 'testimonial'::text, t.product_id, 'product'::text
    from testimonials t
   where t.r2_key != ''
  union all
  select c.media_r2_key, 'category image'::text, c.id, 'category'::text
    from categories c
   where c.media_r2_key != ''
  union all
  select jsonb_extract_path_text(pub.value, 'r2Key'), 'published snapshot'::text, lp.product_id, 'product'::text
    from (select p.product_id, p.payload from product_publishes p
           where p.id = (select max(p2.id) from product_publishes p2 where p2.product_id = p.product_id)) lp
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(jsonb_extract_path(lp.payload, 'images')) = 'array'
           then jsonb_extract_path(lp.payload, 'images') else '[]'::jsonb end
    ) pub
   where jsonb_extract_path_text(pub.value, 'r2Key') is not null
  union all
  select jsonb_extract_path_text(tst.value, 'r2Key'), 'published snapshot'::text, lp.product_id, 'product'::text
    from (select p.product_id, p.payload from product_publishes p
           where p.id = (select max(p2.id) from product_publishes p2 where p2.product_id = p.product_id)) lp
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(jsonb_extract_path(lp.payload, 'testimonials')) = 'array'
           then jsonb_extract_path(lp.payload, 'testimonials') else '[]'::jsonb end
    ) tst
   where jsonb_extract_path_text(tst.value, 'r2Key') is not null
`;

/**
 * Every row that points at a key, with where it points from.
 *
 * This is the single definition of "in use", and BOTH questions are answered from
 * it: the library's In use column (usedKeys) and the refusal reason
 * (referencesForKey). They used to be two separate queries with different table
 * lists, so an image held only by the newest publish snapshot showed "in use"
 * while the delete path found nothing to name - the guard and its explanation
 * disagreeing, which is worse than either being alone. Deriving both from one
 * fragment is what makes that impossible rather than merely unlikely.
 *
 * owner_id/owner_kind are new: they answer "used by WHAT", so the library can name
 * the product or category an image belongs to instead of leaving the operator to
 * work it out. They are the product/category id, not the referencing row id,
 * because "open the thing that uses this" is the action worth offering.
 */
export type MediaReference = {
  key: string;
  source: string;
  ownerId: number | null;
  ownerKind: "product" | "category" | null;
};

const USED_KEYS = sql`select key from (${REFERENCES}) refs`;

/**
 * One fragment serves both the page query and the count query, which is the only
 * way the two can be relied on to agree. A filter that reached one and not the
 * other produces a listing whose pagination lies.
 */
function buildWhere(opts: MediaListOptions): SQL | undefined {
  const conditions: SQL[] = [];
  if (opts.search) conditions.push(sql`lower(${media.r2Key}) like ${`%${opts.search}%`}`);
  if (opts.productId !== null) conditions.push(eq(media.productId, opts.productId));
  if (opts.filter === "unattached") conditions.push(sql`${media.productId} is null`);
  if (opts.filter === "unused") conditions.push(sql`${media.r2Key} not in (${USED_KEYS})`);
  return conditions.length === 0 ? undefined : and(...conditions);
}

const sortColumn = (field: string) => {
  switch (field) {
    case "byteSize": return media.byteSize;
    case "r2Key": return media.r2Key;
    default: return media.createdAt;
  }
};

export const mediaRepo = {
  async findById(db: Db, id: number): Promise<MediaRow | null> {
    const [row] = await db.select().from(media).where(eq(media.id, id)).limit(1);
    return row ?? null;
  },

  async findByKey(db: Db, r2Key: string): Promise<MediaRow | null> {
    const [row] = await db.select().from(media).where(eq(media.r2Key, r2Key)).limit(1);
    return row ?? null;
  },

  async list(db: Db, opts: MediaListOptions): Promise<{ rows: MediaRow[]; total: number }> {
    const where = buildWhere(opts);
    const ordered = opts.sort.direction === "asc"
      ? asc(sortColumn(opts.sort.field))
      : desc(sortColumn(opts.sort.field));

    const rows = await db.select().from(media)
      .where(where)
      .orderBy(ordered, desc(media.id))
      .limit(opts.limit)
      .offset(opts.offset);

    const [{ total }] = await db.select({ total: sql<number>`count(*)::int` }).from(media).where(where);
    return { rows, total };
  },

  /**
   * The whole inventory in one round trip. Called once per listing rather than
   * once per row: asking on the page costs a single query however many rows are
   * shown, and asking per row is fifty HTTP round trips to the database on the
   * page a person opens most often.
   * This reads the SAME fragment referencesForKey reads, so the library's "In
   * use" column and the delete guard's refusal reason are two views of one
   * statement and cannot disagree about a key. The library also gets the owner
   * columns for free, which is what lets it say "used by Sparkler (product 42)"
   * rather than a bare "in use".
   */
  async referencesByKey(db: Db): Promise<Map<string, MediaReference[]>> {
    const rows = await db
      .select({
        key: sql<string>`refs.key`,
        source: sql<string>`refs.source`,
        ownerId: sql<number | null>`refs.owner_id`,
        ownerKind: sql<MediaReference["ownerKind"]>`refs.owner_kind`,
      })
      .from(sql`(${REFERENCES}) refs`);

    const byKey = new Map<string, MediaReference[]>();
    for (const row of rows) {
      const list = byKey.get(row.key);
      if (list) list.push(row);
      else byKey.set(row.key, [row]);
    }
    return byKey;
  },

  async usedKeys(db: Db): Promise<Set<string>> {
    const rows = await db
      .select({ key: sql<string>`used_keys.key` })
      .from(sql`(${USED_KEYS}) used_keys`);
    return new Set(rows.map((row) => row.key));
  },

  /**
   * Registers an upload. The key is the identity and it is UNIQUE, so registering
   * the same key twice is treated as what it is - the same object reported twice -
   * and the row that is already there comes back rather than a duplicate.
   */
  async register(db: Db, input: typeof media.$inferInsert): Promise<{ row: MediaRow; created: boolean }> {
    const inserted = await db.insert(media).values(input)
      .onConflictDoNothing({ target: media.r2Key })
      .returning();
    if (inserted.length !== 0) return { row: inserted[0], created: true };
    const existing = await mediaRepo.findByKey(db, input.r2Key);
    // The conflict says a row exists. If it is gone by the time we look, a delete
    // raced us, and that is a fault to surface rather than a row to invent.
    if (!existing) throw new Error(`media row for ${input.r2Key} disappeared while being registered`);
    return { row: existing, created: false };
  },

  /**
   * Which rows point at ONE key, across every table that can hold one. This is
   * the "why can I not delete this?" answer, and it must ask the SAME tables as
   * usedKeys, so the explanation cannot contradict the refusal that produced it.
   *
   * It previously queried only product_images, testimonials and categories while
   * usedKeys also counted product_publishes - and its own comment claimed parity it
   * did not have. The visible effect was an image held solely by the newest publish
   * snapshot showing "in use" in the library while the delete path found no
   * references to name. The delete was still blocked (remove() re-checks usedKeys),
   * but for the stated reason it cited none. Two answers to one question, derived
   * from different table lists, is exactly the drift that lets a guard and its
   * explanation disagree - so publishes are included here now.
   */
  async referencesForKey(db: Db, r2Key: string): Promise<MediaReference[]> {
    const byKey = await mediaRepo.referencesByKey(db);
    return byKey.get(r2Key) ?? [];
  },

  async deleteById(db: Db, id: number): Promise<boolean> {
    const deleted = await db.delete(media).where(eq(media.id, id)).returning();
    return deleted.length !== 0;
  },

  /**
   * Which of a product's own rows point at which key - the answer to "can I remove
   * this image from this product, or is it also on something else". Read from the
   * referencing tables and not from the media row, for the same reason as above.
   *
   * Deliberately narrower than usedKeys: this is about editable rows a person can
   * act on from the product screen, so it omits the publish payloads, where a key
   * is in use but there is nothing to un-point. That gap is stated rather than
   * papered over, because the two questions need different answers.
   */
  async referencesForProduct(db: Db, productId: number) {
    const [images, product, reviews] = await Promise.all([
      db.select().from(productImages).where(eq(productImages.productId, productId)),
      db.select({ categoryId: products.categoryId }).from(products).where(eq(products.id, productId)).limit(1),
      db.select().from(testimonials).where(eq(testimonials.productId, productId)),
    ]);

    const references: { id: number; key: string; source: string }[] = [];
    for (const image of images) {
      references.push({ id: image.id, key: image.r2Key, source: "product image" });
      const variants = Array.isArray(image.variants) ? image.variants as { key?: unknown }[] : [];
      for (const variant of variants) {
        if (typeof variant.key === "string" && variant.key !== "") {
          references.push({ id: image.id, key: variant.key, source: "image variant" });
        }
      }
    }
    for (const review of reviews) {
      if (review.r2Key !== "") references.push({ id: review.id, key: review.r2Key, source: "testimonial" });
    }
    // `product` is the single-row result of that select, so the first element is
    // the row. A product with no category yields categoryId null, which is the
    // only case where there is no category image to consider.
    const productRow = product[0];
    if (productRow?.categoryId) {
      const [category] = await db.select({ mediaR2Key: categories.mediaR2Key })
        .from(categories).where(eq(categories.id, productRow.categoryId)).limit(1);
      if (category && category.mediaR2Key !== "") {
        references.push({ id: productRow.categoryId, key: category.mediaR2Key, source: "category image" });
      }
    }
    return references;
  },
};
