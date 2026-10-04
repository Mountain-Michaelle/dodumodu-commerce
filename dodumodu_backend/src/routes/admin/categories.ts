import { Hono } from "hono";
import type { Env } from "../../env";
import { z } from "zod";
import { createDb } from "../../db";
import { categoriesRepo, CATEGORY_SORT_FIELDS } from "../../data/categoriesRepo";
import { categoryService } from "../../services/categoryService";
import { parseListQuery, pageMeta, normalizeSearch, likePattern } from "../../shared/listQuery";
import { PERMISSIONS } from "../../auth/adminAuth";
import { ValidationError, ConflictError, NotFoundError } from "../../shared/httpError";
import { requirePermissionOf, readBody, expectedVersion } from "./helpers";
import type { Principal } from "../../auth/adminAuth";

// Categories: the whole resource, and the shape every other admin list copies.
//
// The route stays thin on purpose - parse, delegate, format. The rules about
// slugs, cycles and what may be deleted live in categoryService, because they
// are the same whether they arrive from HTTP, from a script or from a future
// public API, and a rule that only exists inside a route handler is a rule that
// the next caller will not know about.

export const categoryListFiltersSchema = z.object({
  filter: z.enum(["all", "roots", "active", "unused"]).default("all"),
  parentId: z.coerce.number().int().positive().optional(),
  isActive: z.enum(["true", "false"]).optional(),
});

const categoryUpsertSchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).nullish(),
  mediaR2Key: z.string().trim().max(400).nullish(),
  parentId: z.number().int().positive().nullish(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

export function categoryRoutes() {
  const route = new Hono<{ Bindings: Env; Variables: { principal: Principal } }>();

  route.get("/", async (c) => {
    requirePermissionOf(c, PERMISSIONS.categoriesRead);
    const query = parseListQuery(c.req.query(), {
      filters: categoryListFiltersSchema,
      sortable: CATEGORY_SORT_FIELDS,
      defaultSort: "sortOrder",
      defaultOrder: "asc",
    });
    if (!query) throw new ValidationError("That filter combination is not valid", { query: ["Unsupported filter"] });

    const db = createDb(c.env.DATABASE_URL);
    // normalizeSearch drops a one-character term rather than running it: two
    // characters across name and slug returns most of the catalogue and reads as
    // a search that is broken.
    const search = normalizeSearch(query.search);
    const { rows, total } = await categoriesRepo.listWithUsage(db, {
      search: search ? likePattern(search) : null,
      filters: {
        parentId: query.filters.parentId ?? null,
        // The schema defaults it to "all", but the type is optional because the
        // default is applied during parsing - the ?? is what tells the compiler
        // that, rather than a cast that would be wrong if the default ever moved.
        filter: query.filters.filter ?? "all",
      },
      sort: query.sort,
      limit: query.limit,
      offset: query.offset,
    });

    return c.json({ categories: rows, page: pageMeta(query, total) });
  });

  route.get("/tree", async (c) => {
    requirePermissionOf(c, PERMISSIONS.categoriesRead);
    return c.json({ tree: await categoryService.tree(createDb(c.env.DATABASE_URL)) });
  });

  route.get("/:id", async (c) => {
    requirePermissionOf(c, PERMISSIONS.categoriesRead);
    const db = createDb(c.env.DATABASE_URL);
    const id = Number(c.req.param("id"));
    const category = await categoriesRepo.findById(db, id);
    if (!category) return c.json({ error: "Category not found" }, 404);
    return c.json({
      category,
      usage: await categoriesRepo.usageFor(db, id),
      ancestors: await categoriesRepo.ancestors(db, id),
    });
  });

  route.post("/", async (c) => {
    requirePermissionOf(c, PERMISSIONS.categoriesWrite);
    const body = await readBody(c, categoryUpsertSchema);
    const category = await categoryService.create(createDb(c.env.DATABASE_URL), {
      ...body,
      parentId: body.parentId ?? null,
    });
    return c.json({ category }, 201);
  });

  route.patch("/:id", async (c) => {
    requirePermissionOf(c, PERMISSIONS.categoriesWrite);
    const body = await readBody(c, categoryUpsertSchema);
    const category = await categoryService.update(
      createDb(c.env.DATABASE_URL),
      Number(c.req.param("id")),
      { ...body, parentId: body.parentId ?? null },
      expectedVersion(body),
    );
    return c.json({ category });
  });

  route.delete("/:id", async (c) => {
    requirePermissionOf(c, PERMISSIONS.categoriesWrite);
    // The service refuses while products or children still point here, and says
    // what does. That answer reaches the panel as a 409 with the list attached.
    const result = await categoryService.remove(createDb(c.env.DATABASE_URL), Number(c.req.param("id")));
    return c.json({ deleted: true, usage: result.usage });
  });

  /**
   * One request for a whole selection, so clearing a list of 200 categories is
   * 200 states changing rather than 200 HTTP round trips. Each row is transitioned
   * on its own and the outcome is reported per row, because a panel told "done"
   * after a partial run leaves the operator believing rows changed that did not.
   *
   * There is no "set active" verb on purpose: bulk-archiving a category whose
   * products are still in it is exactly the state this resource exists to avoid.
   * The only bulk action that means anything here is delete, and it is subject to
   * every rule the single-row delete is.
   */
  route.post("/bulk-action", async (c) => {
    requirePermissionOf(c, PERMISSIONS.categoriesWrite);
    const body = await readBody(c, z.object({
      ids: z.array(z.number().int().positive()).min(1).max(1000),
      action: z.literal("delete"),
    }), "bulk action");

    const db = createDb(c.env.DATABASE_URL);
    const result: { deleted: number[]; skipped: { id: number; reason: string }[]; errors: { id: number; reason: string }[] } =
      { deleted: [], skipped: [], errors: [] };

    for (const id of body.ids) {
      try {
        await categoryService.remove(db, id);
        result.deleted.push(id);
      } catch (err) {
        // A refusal is the common case, not a failure: most selections will include
        // something still in use, and the reason belongs to the operator.
        if (err instanceof NotFoundError) {
          result.errors.push({ id, reason: err.message });
        } else if (err instanceof ConflictError || err instanceof ValidationError) {
          result.skipped.push({ id, reason: err.message });
        } else {
          result.errors.push({ id, reason: err instanceof Error ? err.message : "Unexpected error" });
        }
      }
    }

    return c.json({
      deleted: result.deleted,
      skipped: result.skipped,
      errors: result.errors,
    });
  });

  return route;
}
