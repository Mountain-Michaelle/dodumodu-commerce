import type { Env } from "../env";

/**
 * Whether a published snapshot is actually the one customers are being served.
 *
 * The rule this module exists to enforce:
 *
 *   PUBLISHED means the immutable snapshot exists.
 *   LIVE     means that EXACT snapshot has been observed on the public storefront.
 *
 * They are different facts with different evidence. A deploy hook returning 200
 * proves a request was accepted, and nothing more - not that a build ran, not that
 * it succeeded, and certainly not that the new page is what the edge is serving.
 * Marking a publish LIVE on the strength of a hook is a claim dressed up as a
 * measurement, and it is the failure this design exists to prevent.
 *
 * So LIVE is DERIVED, on demand, by fetching the public page and reading the
 * version it says it was built from. Nothing is stored to mean "live": a stored
 * flag goes stale the moment anything else is deployed, and then the panel is
 * confidently wrong about what a customer is looking at.
 */

/** The four states the admin shows. */
export type PublishState = "PUBLISHED" | "DEPLOYING" | "FAILED" | "LIVE";

/**
 * The version marker a prerendered page carries.
 *
 * `pub_<publishId>` rather than the bare id, so a page claiming to be publish "6"
 * cannot be confused with any other 6 anywhere - a build number, a category id, a
 * year.
 */
export function publishVersion(publishId: number): string {
  return `pub_${publishId}`;
}

const META_TAG = /<meta\s+name=["']storefront-publish-id["']\s+content=["']([^"']+)["']\s*\/?>/i;
const META_TAG_REVERSED = /<meta\s+content=["']([^"']+)["']\s+name=["']storefront-publish-id["']\s*\/?>/i;

/**
 * Reads the publish version out of rendered HTML.
 *
 * Exported and pure so it can be tested against real markup without a network
 * round trip, including the attribute orders a minifier might produce.
 */
export function readPublishVersion(html: string): string | null {
  return META_TAG.exec(html)?.[1] ?? META_TAG_REVERSED.exec(html)?.[1] ?? null;
}

export type StorefrontVerification = {
  /** The version the public page says it was built from. Null when it cannot be read. */
  liveVersion: string | null;
  /** The URL that was actually fetched, so an operator can click and check. */
  url: string;
  /** Why the read failed, when it did. Null on a successful read. */
  reason: "unconfigured" | "unreachable" | "no-status" | "unreadable" | null;
};

const VERIFY_TIMEOUT_MS = 8_000;

/**
 * Fetches the public product page and reads the version it was built from.
 *
 * Every failure resolves to `{ liveVersion: null }` with a reason. It never
 * throws and never guesses: an unreachable storefront means LIVE is UNKNOWN, and
 * the caller turns that into "still deploying" rather than "live".
 */
export async function verifyStorefront(env: Env, slug: string): Promise<StorefrontVerification> {
  const base = (env.SITE_URL ?? "").trim().replace(/\/+$/, "");
  const url = base ? `${base}/products/${slug}/` : "";

  if (!base) {
    return { liveVersion: null, url: "", reason: "unconfigured" };
  }

  let html: string;
  try {
    const res = await fetch(url, {
      // The edge may serve a cached copy; a conditional request would be one more
      // thing to get wrong, and this runs on an admin screen where a few hundred
      // milliseconds does not matter.
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
      headers: { "User-Agent": "dodumodu-admin-status" },
    });
    if (!res.ok) {
      return { liveVersion: null, url, reason: res.status === 404 ? "no-status" : "unreachable" };
    }
    html = await res.text();
  } catch {
    return { liveVersion: null, url, reason: "unreachable" };
  }

  const version = readPublishVersion(html);
  // A page with no marker is not an error - it is a page built before versioning
  // existed, or one served from somewhere else. Either way it is not evidence.
  return { liveVersion: version, url, reason: version ? null : "unreadable" };
}

export type ResolveInput = {
  /** The newest publish id for this product, or null if it was never published. */
  latestPublishId: number | null;
  /** The stored deployment attempt state. */
  buildStatus: string;
  /** What the public storefront actually reports. */
  liveVersion: string | null;
};

/**
 * Folds the three facts into the one state the operator sees.
 *
 * Pure, so the rule can be tested directly rather than inferred from a panel. The
 * ordering is deliberate: LIVE is checked FIRST, because a publish that is
 * already being served is live even if the last hook attempt failed - which is
 * exactly the case where a naive "failed wins" rule would hide a working page.
 */
export function resolvePublishState({
  latestPublishId, buildStatus, liveVersion,
}: ResolveInput): PublishState {
  if (latestPublishId === null) return "PUBLISHED";
  // Verified: the page the public storefront serves was built from this publish.
  if (liveVersion === publishVersion(latestPublishId)) return "LIVE";
  // The snapshot exists but the storefront is not showing it yet.
  if (buildStatus === "failed") return "FAILED";
  if (buildStatus === "triggered") return "DEPLOYING";
  return "PUBLISHED";
}