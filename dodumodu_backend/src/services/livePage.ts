import type { Env } from "../env";
import { createDb } from "../db";
import { publishesRepo } from "../data/publishesRepo";
import * as site from "../generated/site";
import { renderProductWith } from "../../build/render-core.mjs";

/**
 * The product pages customers get, durable across rebuilds.
 *
 * A page baked into this Worker by a publish build is served as it is (no database read). A rebuild that did not
 * run the publish step (the application build, a Cloudflare git deploy) bakes nothing, and used to turn every
 * published product into a 404. Now a slug that is not baked is rendered from its newest VERIFIED snapshot in the
 * database, using THIS build's template, hashed JS/CSS and CSP, so the page always matches the code it ships with.
 * Publishing is still the only way a snapshot becomes verified, and rebuilding never changes which one that is.
 *
 * The rendered page is kept in memory per isolate for a short time; `fresh` bypasses it (status checks).
 */
export type LivePage = { html: string; etag: string; publishRef: string | null; source: "baked" | "database" };

const TTL_MS = 30_000;
const cache = new Map<string, { page: LivePage; expires: number }>();

type Parts = {
  css: string; jsPath: string; csp: string; buildId: string; siteUrl: string; deliveryBase: string; imageMode: string;
  sprite: string; runtimeConfig: string; inlineScripts: string; turnstileSiteKey: string; maxOrderQuantity: string;
};

const parts = (): Parts => JSON.parse((site as { PAGE_PARTS?: string }).PAGE_PARTS ?? "{}") as Parts;
const template = (): string => (site as { PRODUCT_TEMPLATE?: string }).PRODUCT_TEMPLATE ?? "";

async function etagOf(html: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(html));
  return `"${[...new Uint8Array(digest)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("")}"`;
}

function baked(slug: string): { html: string; etag: string; publishRef?: string } | null {
  const products = JSON.parse(site.PRODUCTS ?? "{}") as Record<string, { html: string; etag: string; publishRef?: string }>;
  return products[slug] ?? null;
}

export async function livePage(env: Env, slug: string, opts: { fresh?: boolean } = {}): Promise<LivePage | null> {
  const b = baked(slug);
  if (b) return { html: b.html, etag: b.etag, publishRef: b.publishRef ?? null, source: "baked" };

  const hit = cache.get(slug);
  if (!opts.fresh && hit && hit.expires > Date.now()) return hit.page;
  if (!template() || !env.DATABASE_URL) return null;

  const row = await publishesRepo.latestLiveBySlug(createDb(env.DATABASE_URL), slug);
  if (!row) { cache.delete(slug); return null; }
  const p = parts();
  const snapshot = { ...(row.payload as object), publishRef: row.publishRef };
  const html = renderProductWith(template(), snapshot, {
    css: p.css, jsPath: p.jsPath, csp: p.csp, buildId: p.buildId,
    // The deployed address wins: the application build may have run before SITE_URL existed.
    siteUrl: (env.SITE_URL ?? p.siteUrl ?? "").trim().replace(/\/+$/, ""),
    deliveryBase: p.deliveryBase, imageMode: p.imageMode, sprite: p.sprite, runtimeConfig: p.runtimeConfig,
    inlineScripts: p.inlineScripts, turnstileSiteKey: p.turnstileSiteKey, maxOrderQuantity: p.maxOrderQuantity,
  });
  const page: LivePage = { html, etag: await etagOf(html), publishRef: row.publishRef, source: "database" };
  cache.set(slug, { page, expires: Date.now() + TTL_MS });
  return page;
}

/** Every slug a customer can reach: baked pages plus verified snapshots. Never throws (the sitemap must not fail). */
export async function liveSlugs(env: Env): Promise<string[]> {
  const slugs = new Set(Object.keys(JSON.parse(site.PRODUCTS ?? "{}") as object));
  try {
    if (env.DATABASE_URL) for (const s of await publishesRepo.liveSlugs(createDb(env.DATABASE_URL))) slugs.add(s);
  } catch { /* baked pages alone are still a correct sitemap */ }
  return [...slugs];
}
