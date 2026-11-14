import type { Context, Next } from "hono";
import type { Env } from "../env";
import type { LivePage } from "../services/livePage";
import { injectTurnstile } from "../services/turnstileInjection";

export type PrerenderedProduct = { html: string; etag: string; publishId: number; publishRef: string };

/**
 * Serves a prerendered product page from memory (no database read), with ETag revalidation.
 *
 * It is mounted at BOTH /:slug and /:slug/. Hono routing is strict, so those are two different routes, and the
 * trailing-slash form is the canonical one: the sitemap, the page's own links and the deploy verifier all use it.
 * Mounting only /:slug once made every product page a 404 at the address that matters. A slug that is not
 * prerendered falls through (static files in local dev, 404 on the Worker).
 */
export function productPageHandler(getPage: (env: Env, slug: string) => Promise<LivePage | null>) {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    let entry: LivePage | null = null;
    try {
      entry = await getPage(c.env, c.req.param("slug") ?? "");
    } catch (err) {
      console.error(JSON.stringify({ event: "product_page_lookup_failed", error: String(err) }));
    }
    if (!entry) return await next();
    // The public site key is applied here, so the widget exists on every page whichever build made it.
    const { html, injected } = injectTurnstile(entry.html, c.env?.TURNSTILE_SITE_KEY);
    const etag = injected ? entry.etag.replace(/"$/, '-t"') : entry.etag;
    // The snapshot is immutable, so the ETag changes iff content changed.
    if (c.req.header("if-none-match") === etag) return c.body(null, 304);
    return c.html(html, 200, {
      ETag: etag,
      "Cache-Control": "public, max-age=60, stale-while-revalidate=3600",
    });
  };
}
