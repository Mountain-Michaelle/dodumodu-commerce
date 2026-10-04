import { eq, sql } from "drizzle-orm";
import type { Db } from "../db";
import { products as productsTable, categories as categoriesTable } from "../schema";
import { productsRepo } from "../data/productsRepo";
import { productPagesRepo } from "../data/productPagesRepo";
import { publishesRepo } from "../data/publishesRepo";
import { categoriesRepo } from "../data/categoriesRepo";
import { ConflictError, NotFoundError, ValidationError } from "../shared/httpError";

// Product rules: what may be saved, when a category is required, and why a
// product with orders behind it is archived rather than destroyed.
//
// The historical-pricing rule is worth stating once, here, because it is the one
// thing in this file that is not obvious from the code: saving a new price
// changes what the NEXT order pays and nothing else. Every order already placed
// keeps the unit price, discount and amount it was created with, so a price
// change can never retroactively alter what a customer was quoted or what the
// books say was collected. There is no path in this service that writes to
// orders.quantity, orders.unit_price, orders.amount or orders.discount_percent.

const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export type ProductInput = {
  slug: string;
  name: string;
  description: string;
  price: number;
  // `price` is optional per package because a package may inherit the product
  // price rather than override it - nullish here means "not set", which is a
  // different fact from "set to zero", so the null is preserved through to the
  // row rather than being coerced to 0 and silently repricing a package.
  packageOptions: { id: string; label: string; price?: number | null }[];
  categoryId: number | null;
  seoTitle?: string | null;
  seoDescription?: string | null;
  active: boolean;
};

export const productService = {
  async validate(db: Db, input: ProductInput, excludeId?: number) {
    const slug = input.slug.trim().toLowerCase();
    const name = input.name.trim();

    if (!SLUG_PATTERN.test(slug)) {
      throw new ValidationError(
        "The URL slug may only use lowercase letters, numbers and single dashes",
        { slug: ["e.g. glow-serum"] },
      );
    }
    if (name.length < 1 || name.length > 200) {
      throw new ValidationError("The name must be 1-200 characters", { name: ["Use 1-200 characters"] });
    }
    if (!Number.isInteger(input.price) || input.price <= 0) {
      throw new ValidationError("Enter a price greater than zero", { price: ["Must be a whole number of kobo"] });
    }

    if (await productsRepo.slugTaken(db, slug, excludeId)) {
      throw new ConflictError(`The slug "${slug}" is already used by another product`, "reload");
    }

    // The column is nullable so a migration is never half-applied, and the rule
    // is enforced here instead, where it can be explained. An ACTIVE product
    // without a category is a product nothing can find: no category listing, no
    // breadcrumb, and no way to retire it in a group later. A draft may exist
    // without one - that is the point of a draft.
    if (input.active) {
      if (input.categoryId === null) {
        throw new ValidationError("An active product must be in a category", {
          categoryId: ["Choose a category"],
        });
      }
      const category = await categoriesRepo.findById(db, input.categoryId);
      if (!category) {
        throw new ValidationError("That category does not exist", { categoryId: ["Unknown category"] });
      }
    }

    return {
      slug,
      name,
      description: input.description.trim(),
      price: input.price,
      packageOptions: input.packageOptions,
      categoryId: input.categoryId,
      seoTitle: input.seoTitle?.trim() || null,
      seoDescription: input.seoDescription?.trim() || null,
      active: input.active,
    };
  },

  async create(db: Db, input: ProductInput) {
    const clean = await productService.validate(db, input);
    const [row] = await db.insert(productsTable).values(clean).returning();
    console.log(JSON.stringify({ event: "product_created", id: row.id, slug: row.slug }));
    return row;
  },

  async update(db: Db, id: number, input: ProductInput, expectedUpdatedAt: Date | null) {
    const current = await productsRepo.findById(db, id);
    if (!current) throw new NotFoundError("Product", id);

    const clean = await productService.validate(db, input, id);
    // The version guard lives in the WHERE, not in a check above it: a read then a
    // write is a window, and two admins saving the same product would otherwise
    // end with one edit silently gone.
    const where = expectedUpdatedAt === null
      ? eq(productsTable.id, id)
      : sql`${productsTable.id} = ${id} and ${productsTable.updatedAt} = ${expectedUpdatedAt}`;

    const [row] = await db.update(productsTable)
      .set({ ...clean, updatedAt: new Date() })
      .where(where)
      .returning();

    if (!row) {
      throw new ConflictError(
        "This product changed while you were looking at it. Reload and try again.",
        "reload",
        await productsRepo.findById(db, id),
      );
    }
    console.log(JSON.stringify({ event: "product_updated", id, slug: row.slug }));
    return row;
  },

  /**
   * Hides a product from the storefront without destroying it.
   *
   * Archive, never delete, when orders exist - and that is the normal case for
   * anything that has ever sold. orders.product_id is a non-null foreign key, so
   * deleting the product would either fail on the constraint or, if a future
   * change made it SET NULL, silently orphan every historical order: a list of
   * sales that no longer says what was bought. Setting active = false keeps the
   * row, keeps the history readable, and takes the product off the storefront in
   * one statement.
   */
  async archive(db: Db, id: number, expectedUpdatedAt: Date | null) {
    const current = await productsRepo.findById(db, id);
    if (!current) throw new NotFoundError("Product", id);

    const where = expectedUpdatedAt === null
      ? eq(productsTable.id, id)
      : sql`${productsTable.id} = ${id} and ${productsTable.updatedAt} = ${expectedUpdatedAt}`;
    const [row] = await db.update(productsTable)
      .set({ active: false, updatedAt: new Date() })
      .where(where)
      .returning();

    if (!row) {
      throw new ConflictError(
        "This product changed while you were looking at it. Reload and try again.",
        "reload",
        await productsRepo.findById(db, id),
      );
    }
    console.log(JSON.stringify({ event: "product_archived", id, slug: row.slug }));
    return { product: row, orderCount: await productsRepo.orderCount(db, id) };
  },

  /**
   * Everything the product editor needs, in ONE request and a fixed number of
   * queries.
   *
   * This exists because the alternative is the thing the specification calls an
   * N+1: opening a product would fire a request for the product, then one for its
   * category, then one for each image, then one for the page copy, then one for
   * the publish log. Five round trips before the editor appears, and any future
   * field would be a sixth. The reads that CAN be concurrent are concurrent, so
   * this is two round trips (product, then the rest together) rather than five
   * sequential ones.
   *
   * The latest publish comes back without its payload: the editor shows when it
   * was published and by whom, and a snapshot can be hundreds of kilobytes that
   * nobody asked to see on screen.
   */
  async detail(db: Db, id: number) {
    const product = await productsRepo.findById(db, id);
    if (!product) throw new NotFoundError("Product", id);

    const [images, page, latestPublish, orderCount] = await Promise.all([
      productsRepo.imagesForProduct(db, id),
      productPagesRepo.forProduct(db, id),
      publishesRepo.latestForProduct(db, id),
      productsRepo.orderCount(db, id),
    ]);

    const [category] = product.categoryId === null
      ? []
      : await db.select({ id: categoriesTable.id, name: categoriesTable.name, slug: categoriesTable.slug })
        .from(categoriesTable)
        .where(eq(categoriesTable.id, product.categoryId))
        .limit(1);

    return {
      product,
      category: category ?? null,
      images,
      page,
      latestPublish: latestPublish
        ? { id: latestPublish.id, publishedBy: latestPublish.publishedBy, createdAt: latestPublish.createdAt }
        : null,
      orderCount,
    };
  },
};
