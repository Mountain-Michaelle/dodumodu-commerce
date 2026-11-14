import type { Context, Next } from "hono";
import type { Env } from "../env";

export type PrerenderedProduct = { html: string; etag: string; publishId: number; publishRef: string };

/**
 * Serves a prerendered product page from memory (no database read), with ETag revalidation.
 *
 * It is mounted at BOTH /:slug and /:slug/. Hono routing is strict, so those are two different routes, and the
 * trailing-slash form is the canonical one: the sitemap, the page's own links and the deploy verifier all use it.
 * Mounting only /:slug once made every product page a 404 at the address that matters. A slug that is not
 * prerendered falls through (static files in local dev, 404 on the Worker).
 */
export function productPageHandler(getProducts: () => Record<string, PrerenderedProduct>) {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const entry = getProducts()[c.req.param("slug") ?? ""];
    if (!entry) return await next();
    // The snapshot is immutable, so the ETag changes iff content changed.
    if (c.req.header("if-none-match") === entry.etag) return c.body(null, 304);
    return c.html(entry.html, 200, {
      ETag: entry.etag,
      "Cache-Control": "public, max-age=60, stale-while-revalidate=3600",
    });
  };
}
