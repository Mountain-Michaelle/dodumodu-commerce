import type { Db } from "../db";
import { categoriesRepo, type CategoryRow } from "../data/categoriesRepo";
import { productsRepo } from "../data/productsRepo";
import { ConflictError, NotFoundError, ValidationError } from "../shared/httpError";

// The rules that outlive a request: what a category may be called, where it may
// sit in the tree, and what happens to the products that point at it.
//
// The repository reads and writes. This decides. The separation matters here more
// than anywhere else in the admin, because every one of these rules protects data
// that cannot be recovered from a mistake - a deleted category that silently
// re-homed a product, or a tree that now contains a cycle and can no longer be
// walked to render.

// Mirrors the CHECK constraints in migrations/0005_admin_domain.sql. They are
// stated twice on purpose: the database is the last line of defence for any
// connection that bypasses this service, and this service is the line that can
// explain the problem to the person who has to fix it.
const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const NAME_MAX = 120;

export type CategoryInput = {
  name: string;
  slug: string;
  description?: string | null;
  mediaR2Key?: string | null;
  parentId?: number | null;
  isActive?: boolean;
  sortOrder?: number;
};

export const categoryService = {
  /**
   * Validates a category for saving and returns it in the exact shape the row
   * wants. Kept separate from create/update because both paths must apply
   * identical rules, and two copies of a slug check are two rules eventually.
   */
  async validate(db: Db, input: CategoryInput, excludeId?: number) {
    const name = input.name.trim();
    const slug = input.slug.trim().toLowerCase();

    if (name.length < 1 || name.length > NAME_MAX) {
      throw new ValidationError(`The name must be 1-${NAME_MAX} characters`, {
        name: [`Use 1-${NAME_MAX} characters`],
      });
    }
    if (!SLUG_PATTERN.test(slug)) {
      throw new ValidationError(
        "The URL slug may only use lowercase letters, numbers and single dashes",
        { slug: ["e.g. skin-cares"] },
      );
    }

    // Case-insensitive on both sides. "Face" and "face" are one category to a
    // customer browsing a URL and two impossible choices to the admin choosing one
    // daily, so the collision is refused where it is created rather than
    // discovered later as a broken link.
    if (await categoriesRepo.slugTaken(db, slug, excludeId)) {
      throw new ConflictError(`The slug "${slug}" is already used by another category`, "reload");
    }
    if (await categoriesRepo.nameTaken(db, name, excludeId)) {
      throw new ConflictError(`A category called "${name}" already exists`, "reload");
    }

    const parentId = input.parentId ?? null;
    if (parentId !== null) {
      if (excludeId !== undefined && parentId === excludeId) {
        throw new ValidationError("A category cannot be its own parent", {
          parentId: ["Choose a different parent"],
        });
      }
      const parent = await categoriesRepo.findById(db, parentId);
      if (!parent) {
        throw new ValidationError("That parent category does not exist", {
          parentId: ["Unknown category"],
        });
      }
      if (excludeId !== undefined) {
        // A CHECK constraint cannot compare rows, so the guard against a longer
        // cycle has to walk. Without this, moving a category under its own
        // descendant produces a tree no renderer can finish walking.
        const ancestors = await categoriesRepo.ancestors(db, excludeId);
        if (ancestors.some((node) => node.id === parentId)) {
          throw new ValidationError(
            "That would put the category inside one of its own children",
            { parentId: ["Creates a cycle"] },
          );
        }
      }
    }

    return {
      name,
      slug,
      description: input.description?.trim() || null,
      mediaR2Key: input.mediaR2Key ?? "",
      parentId,
      isActive: input.isActive ?? true,
      sortOrder: input.sortOrder ?? 0,
    };
  },

  async create(db: Db, input: CategoryInput): Promise<CategoryRow> {
    const clean = await categoryService.validate(db, input);
    return categoriesRepo.insert(db, clean);
  },

  /**
   * Edits a category, guarded on the version the operator was shown. The guard is
   * in the WHERE (see categoriesRepo.update), so a row that moved since the form
   * was loaded matches nothing and the operator is told, rather than one admin's
   * save quietly overwriting another's.
   */
  async update(
    db: Db,
    id: number,
    input: CategoryInput,
    expectedUpdatedAt: Date | null,
  ): Promise<CategoryRow> {
    const current = await categoriesRepo.findById(db, id);
    if (!current) throw new NotFoundError("Category", id);

    const clean = await categoryService.validate(db, input, id);
    const updated = await categoriesRepo.update(db, id, clean, expectedUpdatedAt);
    if (!updated) {
      throw new ConflictError(
        "This category changed while you were looking at it. Reload and try again.",
        "reload",
        await categoriesRepo.findById(db, id),
      );
    }
    return updated;
  },

  /**
   * Deletes a category, refusing while anything still depends on it.
   *
   * "Nothing references it" and "safe to remove" are different questions. A
   * category with children but no products still cannot go: products.category_id
   * is ON DELETE SET NULL, so the database would re-parent those children to the
   * root and quietly reshape the catalogue. The service enforces the business
   * rule and names what is in the way; the constraint is the safety net for any
   * path that bypasses it.
   *
   * The affected products come back with the refusal so the panel can list them -
   * "3 products are in this category" is a reason; "cannot delete" on its own is
   * just an obstacle.
   */
  async remove(db: Db, id: number) {
    const current = await categoriesRepo.findById(db, id);
    if (!current) throw new NotFoundError("Category", id);

    const usage = await categoriesRepo.usageFor(db, id);
    if (usage.childCount > 0) {
      throw new ConflictError(
        `This category still has ${usage.childCount} sub-categor${usage.childCount === 1 ? "y" : "ies"}. `
        + "Move or delete those first.",
        "reload",
        { childCount: usage.childCount, productCount: usage.productCount },
      );
    }
    if (usage.productCount > 0) {
      const products = await productsRepo.listForCategory(db, id);
      // "1 product still uses" / "2 products still use" - the plural has to agree
      // with the verb as well as the noun, which is the whole reason this string
      // is built rather than concatenated from a count.
      const many = usage.productCount !== 1;
      throw new ConflictError(
        `${usage.productCount} product${many ? "s" : ""} still use${many ? "" : "s"} this category. `
        + "Move them first.",
        "reload",
        { childCount: 0, productCount: usage.productCount, products },
      );
    }

    await categoriesRepo.deleteById(db, id);
    console.log(JSON.stringify({ event: "category_deleted", id, slug: current.slug }));
    return { usage };
  },

  /**
   * The category tree for a picker, built in application code from ONE read
   * rather than by asking the database to recurse. Categories are few, the walk
   * is over indexed primary keys, and a bounded loop behaves identically under
   * both the Node and Neon drivers - a recursive CTE is exactly the kind of thing
   * that behaves differently depending on which one you are running.
   */
  async tree(db: Db) {
    const rows = await categoriesRepo.listAll(db);
    const byParent = new Map<number | null, CategoryRow[]>();
    for (const row of rows) {
      const siblings = byParent.get(row.parentId) ?? [];
      siblings.push(row);
      byParent.set(row.parentId, siblings);
    }

    type TreeNode = CategoryRow & { children: TreeNode[] };
    const build = (parentId: number | null, depth: number): TreeNode[] => {
      // Bounded for the same reason the service is: a cycle that got past the
      // save-time check is corrupt data, and stopping is honest where spinning is not.
      if (depth > 10) return [];
      return (byParent.get(parentId) ?? []).map((row) => ({
        ...row,
        children: build(row.id, depth + 1),
      }));
    };
    return build(null, 0);
  },
};
