import { and, asc, desc, eq, isNull, sql, type SQL } from "drizzle-orm";
import type { Db } from "../db";
import { categories, products } from "../schema";
import { updatedAtBucketCondition } from "../shared/versionGuard";

// Categories are few and read constantly, so "few" is a real design input: the
// tree is walked in application code over a bounded number of indexed
// primary-key reads rather than a recursive CTE, which behaves the same under
// both drivers. If categories ever number in the thousands, this file is where
// that decision gets revisited - not whichever route noticed first.

export type CategoryRow = typeof categories.$inferSelect;
export type CategoryWithUsage = CategoryRow & { productCount: number }; 
export type CategoryUsage = {
  childCount: number;
  productCount: number;
  /**
   * "Nothing references it" and "safe to remove" are not the same question. A
   * category with children but no products still cannot go, because ON DELETE
   * SET NULL would re-parent those children to the root - a change to the shape
   * of the catalogue that nobody asked for.
   */
  canDelete: boolean;
};

// The only values ?sort= may select. The list query never receives a column name.
export const CATEGORY_SORT_FIELDS = ["name", "slug", "sortOrder", "createdAt"] as const;
export type CategoryFilter = "all" | "roots" | "active" | "unused";

export type CategoryListOptions = {
  search: string | null;
  filters: { parentId: number | null; filter: CategoryFilter };
  sort: { field: string; direction: "asc" | "desc" };
  limit: number;
  offset: number;
};

// How far up the tree a walk goes before it concludes the data is corrupt. A real
// catalogue nests two or three deep; past this is a cycle that outwitted the
// save-time check, and the honest response is to stop rather than to spin.
const MAX_TREE_DEPTH = 10;

const sortColumn = (field: string) => {
  switch (field) {
    case "name": return categories.name;
    case "slug": return categories.slug;
    case "sortOrder": return categories.sortOrder;
    default: return categories.createdAt;
  }
};

const hasProducts = sql`exists (select 1 from products p where p.category_id = categories.id)`;
const countProducts = sql<number>`(select count(*)::int from products p where p.category_id = categories.id)`;

/**
 * Built once and handed to both the page query and the count query, because the
 * two drifting is exactly how a listing gets a page 3 that does not exist: the
 * rows are counted under one predicate and paged under another.
 */
function buildWhere(opts: CategoryListOptions): SQL | undefined {
  const conditions: SQL[] = [];
  if (opts.search) {
    const pattern = `%${opts.search}%`;
    conditions.push(
      sql`(lower(${categories.name}) like ${pattern} or lower(${categories.slug}) like ${pattern})`,
    );
  }
  if (opts.filters.parentId !== null) conditions.push(eq(categories.parentId, opts.filters.parentId));
  if (opts.filters.filter === "roots") conditions.push(isNull(categories.parentId));
  if (opts.filters.filter === "active") conditions.push(eq(categories.isActive, true));
  if (opts.filters.filter === "unused") conditions.push(sql`not ${hasProducts}`);
  return conditions.length === 0 ? undefined : and(...conditions);
}

export const categoriesRepo = {
  async findById(db: Db, id: number): Promise<CategoryRow | null> {
    const [row] = await db.select().from(categories).where(eq(categories.id, id)).limit(1);
    return row ?? null;
  },

  /**
   * Every category in one read, ordered for display. Used by the tree builder and
   * by pickers: both need the whole set, and both would otherwise issue one query
   * per row. The list screen does NOT use this - it pages server-side.
   */
  async listAll(db: Db): Promise<CategoryRow[]> {
    return db.select().from(categories)
      .orderBy(asc(categories.sortOrder), asc(categories.name));
  },

  async findBySlug(db: Db, slug: string): Promise<CategoryRow | null> {
    const [row] = await db.select().from(categories).where(eq(categories.slug, slug)).limit(1);
    return row ?? null;
  },

  /**
   * Case-insensitive on purpose. "Face" and "face" are one category to a customer
   * browsing a URL and two impossible choices to the admin who has to pick one
   * every day, so the collision is refused where it is created.
   */
  async slugTaken(db: Db, slug: string, excludeId?: number): Promise<boolean> {
    const conditions: SQL[] = [sql`lower(${categories.slug}) = lower(${slug})`];
    if (excludeId !== undefined) conditions.push(sql`${categories.id} != ${excludeId}`);
    const [row] = await db.select({ id: categories.id }).from(categories).where(and(...conditions)).limit(1);
    return Boolean(row);
  },

  async nameTaken(db: Db, name: string, excludeId?: number): Promise<boolean> {
    const conditions: SQL[] = [sql`lower(trim(${categories.name})) = lower(trim(${name}))`];
    if (excludeId !== undefined) conditions.push(sql`${categories.id} != ${excludeId}`);
    const [row] = await db.select({ id: categories.id }).from(categories).where(and(...conditions)).limit(1);
    return Boolean(row);
  },

  async listWithUsage(db: Db, opts: CategoryListOptions): Promise<{ rows: CategoryWithUsage[]; total: number }> {
    const where = buildWhere(opts);
    const ordered = opts.sort.direction === "asc"
      ? asc(sortColumn(opts.sort.field))
      : desc(sortColumn(opts.sort.field));

    // id breaks ties so a page boundary is stable: ordered by name alone, two
    // categories called the same thing can appear on page 1 and again on page 2.
    const rowsQuery = db
      .select({ row: categories, productCount: countProducts })
      .from(categories)
      .where(where)
      .orderBy(ordered, asc(categories.id))
      .limit(opts.limit)
      .offset(opts.offset);

    const countQuery = db.select({ total: sql<number>`count(*)::int` }).from(categories).where(where);
    // Independent of each other: wait for both at once (one round trip, not two).
    const [rows, [{ total }]] = await Promise.all([rowsQuery, countQuery]);
    return { rows: rows.map((entry) => ({ ...entry.row, productCount: entry.productCount })), total };
  },

  /**
   * Two indexed counts rather than one join: each uses an index created for it
   * (idx_categories_parent_sort, idx_products_category_id), neither has to visit
   * a heap page, and the query stays readable in EXPLAIN a year from now.
   */
  async usageFor(db: Db, categoryId: number): Promise<CategoryUsage> {
    const [children] = await db.select({ n: sql<number>`count(*)::int` }).from(categories)
      .where(eq(categories.parentId, categoryId));
    const [owned] = await db.select({ n: sql<number>`count(*)::int` }).from(products)
      .where(eq(products.categoryId, categoryId));
    return {
      childCount: children.n,
      productCount: owned.n,
      canDelete: children.n === 0 && owned.n === 0,
    };
  },

  /**
   * The ancestors above a category, nearest parent first. Bounded, and it stops
   * the moment it revisits a row: the save path refuses cycles, so reaching one
   * here means the data already disagrees with itself, and reporting a truncated
   * chain beats hanging a request.
   */
  async ancestors(db: Db, startId: number): Promise<CategoryRow[]> {
    const chain: CategoryRow[] = [];
    const visited = new Set<number>([startId]);
    let currentId = startId;
    for (let depth = 0; depth < MAX_TREE_DEPTH; depth += 1) {
      const [node] = await db.select({ parentId: categories.parentId }).from(categories)
        .where(eq(categories.id, currentId)).limit(1);
      const parentId = node?.parentId;
      if (parentId === undefined || parentId === null || visited.has(parentId)) break;
      const parent = await categoriesRepo.findById(db, parentId);
      if (!parent) break;
      chain.push(parent);
      visited.add(parent.id);
      currentId = parent.id;
    }
    return chain;
  },

  async insert(db: Db, input: typeof categories.$inferInsert): Promise<CategoryRow> {
    const [row] = await db.insert(categories).values(input).returning();
    return row;
  },

  /**
   * One UPDATE, not a read followed by a write. The version the caller was shown
   * is part of the WHERE, so a row that moved since then matches nothing and the
   * caller is told instead of quietly overwriting. updatedAt is stamped by the
   * server: a browser clock is not a version number.
   *
   * expectedUpdatedAt null means "no version supplied" and skips the guard. The
   * admin routes always supply one; the parameter exists so a migration script or
   * a fix-up tool is not forced to invent a timestamp to satisfy the form.
   */
  async update(
    db: Db,
    id: number,
    patch: Partial<typeof categories.$inferInsert>,
    expectedUpdatedAt: Date | null,
  ): Promise<CategoryRow | null> {
    const stamped = { ...patch, updatedAt: new Date() };
    const where = expectedUpdatedAt === null
      ? eq(categories.id, id)
      : sql`${categories.id} = ${id} and ${updatedAtBucketCondition(categories.updatedAt, expectedUpdatedAt)}`;
    const [row] = await db.update(categories).set(stamped).where(where).returning();
    return row ?? null;
  },

  async deleteById(db: Db, id: number): Promise<boolean> {
    const deleted = await db.delete(categories).where(eq(categories.id, id)).returning();
    return deleted.length !== 0;
  },

  /**
   * For a product form's picker: the visible categories in catalogue order, with
   * no usage counts. A picker is not a management view, and counting products per
   * row to render a dropdown is paying for information nobody acts on there.
   */
  async listSelectable(db: Db) {
    return db
      .select({
        id: categories.id,
        name: categories.name,
        slug: categories.slug,
        parentId: categories.parentId,
        sortOrder: categories.sortOrder,
        isActive: categories.isActive,
      })
      .from(categories)
      .where(eq(categories.isActive, true))
      .orderBy(asc(categories.sortOrder), asc(categories.name));
  },
};
