import { Hono } from "hono";
import type { Env } from "../env";
import { createDb } from "../db";
import { catalogService, ProductNotFoundError } from "../services/catalogService";

export const catalogRoute = new Hono<{ Bindings: Env }>();

// The live view: what the rows say right now, unsaved-publish included. The
// admin panel previews through this; a customer never reads it.
catalogRoute.get("/page-data/:slug", async (c) => {
  const db = createDb(c.env.DATABASE_URL);
  try {
    const data = await catalogService.getPageData(db, c.env, c.req.param("slug"));
    return c.json(data);
  } catch (err) {
    if (err instanceof ProductNotFoundError) {
      return c.json({ error: "Product not found" }, 404);
    }
    throw err;
  }
});

// The published view: the newest snapshot, which is precisely what the last
// publish captured. Anything that renders a page for a customer — the static
// build today, a page-level fetch later — reads this and never page-data, so an
// admin editing copy cannot leak into what shoppers see.
//
// The ETag is the publish id. A snapshot is immutable, so the id is a complete
// and honest validator: it changes if and only if the content does, and the
// answer stays cacheable across a draft saved a second later.
catalogRoute.get("/published/:slug", async (c) => {
  const db = createDb(c.env.DATABASE_URL);
  let record;
  try {
    record = await catalogService.getPublished(db, c.req.param("slug"));
  } catch (err) {
    if (err instanceof ProductNotFoundError) {
      return c.json({ error: "Product not found" }, 404);
    }
    throw err;
  }
  if (!record) {
    return c.json({ error: "This product has never been published" }, 404);
  }
  return c.json(record.payload, 200, {
    ETag: `"publish-${record.id}"`,
    "Cache-Control": "public, max-age=60",
  });
});
