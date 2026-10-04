// The one place adapters are listed.
//
// The dispatcher imports this map and nothing else about any platform, so this
// file is the complete coupling between the tracking core and the ad platforms.
// Adding a platform is a line here plus a config entry; nothing in the
// dispatcher, the order flow or the schema changes, and that is the property
// this file is written to preserve.

import { metaAdapter } from "./adapters/meta";
import { tiktokAdapter } from "./adapters/tiktok";
import type { Adapter } from "./adapters/types";

const REGISTRY: Record<string, Adapter> = {
  meta: metaAdapter,
  tiktok: tiktokAdapter,
  // _template.ts is intentionally absent: it is a shape to copy, not a platform.
  // Registering it would send real conversions to api.example.com.
};

/**
 * Look up an adapter by the key used in TRACKING_PLATFORMS.
 *
 * Returns null for an unknown key rather than throwing. An unrecognised name in
 * config must degrade to a `skipped` log row: a typo in an env var should cost
 * one platform's events, not take down the order flow that called us.
 */
export function adapterFor(key: string): Adapter | null {
  return REGISTRY[key] ?? null;
}

/** Registered keys, for config resolution and for tests that prove isolation. */
export function registeredKeys(): string[] {
  return Object.keys(REGISTRY);
}