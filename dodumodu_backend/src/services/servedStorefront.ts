import * as site from "../generated/site";

/**
 * The product page THIS Worker is serving, read in-process.
 *
 * Why not fetch SITE_URL from the Worker: a Worker that requests its own public hostname does not reach itself
 * (Cloudflare sends same-zone subrequests past the Worker, to the origin), so the check got a 404 from a storefront
 * that was perfectly live. The pages a Worker serves ARE the ones baked into it, so asking it directly is both
 * simpler and exact. The deploy workflow separately reads the real public URL from outside, over the network.
 *
 * `served.read` is a seam so tests can stand in a storefront.
 */
function fromBakedSite(slug: string): string | null {
  const products = JSON.parse(site.PRODUCTS ?? "{}") as Record<string, { html: string }>;
  return products[slug]?.html ?? null;
}

export const served: { read: (slug: string) => string | null } = { read: fromBakedSite };
