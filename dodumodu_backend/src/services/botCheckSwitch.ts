import type { Env } from "../env";
import { createDb } from "../db";
import { productsRepo } from "../data/productsRepo";

/**
 * Whether a product's order form carries the Cloudflare bot check. A live setting (a column on the product, flipped in
 * admin), not part of a publish, so it changes without a rebuild. Remembered for 30 seconds per Worker instance so a page
 * view costs no database read; it errs on the side of KEEPING the check on if the lookup fails.
 */
const TTL_MS = 30_000;
const cache = new Map<string, { enabled: boolean; at: number }>();

export async function botCheckEnabled(env: Env, slug: string): Promise<boolean> {
  const hit = cache.get(slug);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.enabled;
  let enabled = true;
  try {
    const row = await productsRepo.findBySlug(createDb(env.DATABASE_URL), slug);
    enabled = row?.botCheckEnabled !== false;
  } catch {
    return hit?.enabled ?? true;
  }
  cache.set(slug, { enabled, at: Date.now() });
  return enabled;
}

export function clearBotCheckSwitchCache(): void { cache.clear(); }
