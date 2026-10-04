import { Hono } from "hono";
import type { Env } from "../../env";
import { z } from "zod";
import { createDb } from "../../db";
import { productsRepo } from "../../data/productsRepo";
import { productService } from "../../services/productService";
import { parseListQuery, pageMeta, normalizeSearch, likePattern } from "../../shared/listQuery";
import { PERMISSIONS } from "../../auth/adminAuth";
import { NotFoundError } from "../../shared/httpError";
import { requirePermissionOf, readBody, expectedVersion } from "./helpers";
import type { Principal } from "../../auth/adminAuth";

// Products: identity, category membership, and the images attached to them.
//
// The detail endpoint is ONE request on purpose. The alternative - the panel
// calling /products/:id, then /categories, then /images, then /page, then
// /publishes - is five sequential round trips before the editor opens, and every
// field added later would be another one.

export const productListFiltersSchema = z.object({
  categoryId: z.coerce.number().int().positive().optional(),
  active: z.enum(["true", "false"]).optional(),
});

export const PRODUCT_SORT_FIELDS = ["name", "slug", "price", "updatedAt"] as const;

const productUpsertSchema = z.object({
  slug: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(5000),
  price: z.coerce.number().int().positive(),
  packageOptions: z.array(z.object({
    id: z.string().trim().min(1).max(40),
    label: z.string().trim().min(1).max(120),
    price: z.coerce.number().int().positive().nullish(),
  })).max(20).default([]),
  categoryId: z.number().int().positive().nullish(),
  seoTitle: z.string().trim().max(200).nullish(),
  seoDescription: z.string().trim().max(300).nullish(),
  active: z.boolean().default(true),
  expectedUpdatedAt: z.string().datetime({ offset: true }).nullish(),
});

const imagesSchema = z.object({
  images: z.array(z.object({
    r2Key: z.string().trim().min(1).max(400),
    altText: z.string().trim().max(300).default(""),
    displayOrder: z.number().int().min(0).max(100),
    width: z.number().int().positive().max(20000).nullish(),
    height: z.number().int().positive().max(20000).nullish(),
    variants: z.array(z.object({
      width: z.number().int().positive(),
      key: z.string().trim().min(1).max(400),
    })).max(8).default([]),
  })).max(12),
});

export function productRoutes() {
  const route = new Hono<{ Bindings: Env; Variables: { principal: Principal } }>();

  route.get("/", async (c) => {
    requirePermissionOf(c, PERMISSIONS.productsRead);
    const query = parseListQuery(c.req.query(), {
      filters: productListFiltersSchema,
      sortable: PRODUCT_SORT_FIELDS,
      defaultSort: "name",
      defaultOrder: "asc",
    });
    if (!query) return c.json({ error: { code: "INVALID_QUERY", message: "Unsupported filter" } }, 400);

    const db = createDb(c.env.DATABASE_URL);
    const search = normalizeSearch(query.search);
    const { rows, total } = await productsRepo.listForAdmin(db, {
      search: search ? likePattern(search) : null,
      filters: {
        categoryId: query.filters.categoryId ?? null,
        // A filter absent from the query string means "both", not "neither" -
        // reading the absence as false would quietly hide every archived product.
        active: query.filters.active === undefined ? null : query.filters.active === "true",
      },
      sort: query.sort,
      limit: query.limit,
      offset: query.offset,
    });
    return c.json({ products: rows, page: pageMeta(query, total) });
  });

  route.get("/:id", async (c) => {
    requirePermissionOf(c, PERMISSIONS.productsRead);
    // One request: product, category, images, page content, latest publish and the
    // order count. A fixed number of round trips whatever the catalogue looks like.
    return c.json(await productService.detail(createDb(c.env.DATABASE_URL), Number(c.req.param("id"))));
  });

  route.post("/", async (c) => {
    requirePermissionOf(c, PERMISSIONS.productsWrite);
    const body = await readBody(c, productUpsertSchema, "product");
    const { expectedUpdatedAt: _version, ...input } = body;
    const product = await productService.create(createDb(c.env.DATABASE_URL), {
      ...input,
      categoryId: input.categoryId ?? null,
    });
    return c.json({ product }, 201);
  });

  route.patch("/:id", async (c) => {
    requirePermissionOf(c, PERMISSIONS.productsWrite);
    const body = await readBody(c, productUpsertSchema, "product");
    const { expectedUpdatedAt, ...input } = body;
    const product = await productService.update(
      createDb(c.env.DATABASE_URL),
      Number(c.req.param("id")),
      { ...input, categoryId: input.categoryId ?? null },
      expectedVersion(body),
    );
    return c.json({ product });
  });

  route.delete("/:id", async (c) => {
    requirePermissionOf(c, PERMISSIONS.productsWrite);
    // Archive, never delete: orders.product_id is a non-null foreign key, so a
    // product that has ever sold cannot be removed without destroying the record
    // of what was bought. active = false takes it off the storefront in one
    // statement and keeps every historical order readable.
    const result = await productService.archive(
      createDb(c.env.DATABASE_URL), Number(c.req.param("id")), expectedVersion(c.req.query()),
    );
    return c.json(result);
  });

  route.put("/:id/images", async (c) => {
    requirePermissionOf(c, PERMISSIONS.productsWrite);
    const db = createDb(c.env.DATABASE_URL);
    const productId = Number(c.req.param("id"));
    const product = await productsRepo.findById(db, productId);
    if (!product) throw new NotFoundError("Product", productId);

    const body = await readBody(c, imagesSchema, "image list");
    // The whole ordered list replaces what is there. There is no per-image id the
    // form ever saw to reconcile against, so a merge would have to invent one.
    const images = await productsRepo.replaceImages(db, productId, body.images);
    return c.json({ images });
  });

  route.delete("/:id/images/:imageId", async (c) => {
    requirePermissionOf(c, PERMISSIONS.productsWrite);
    const db = createDb(c.env.DATABASE_URL);
    const imageId = Number(c.req.param("imageId"));
    const image = await productsRepo.findImageById(db, imageId);
    // The image must belong to THIS product: an id taken from another product's
    // list would otherwise delete a row the URL never referred to.
    if (!image || image.productId !== Number(c.req.param("id"))) {
      throw new NotFoundError("Image", imageId);
    }
    await productsRepo.deleteImageById(db, imageId);
    return c.json({ deleted: true });
  });

  return route;
}