// One place where every image decision is made.
//
// The rule this file exists to enforce: NO image constant lives anywhere else.
// Widths, quality, the delivery mode and the upload ceilings are read from here by
// the backend, by the site's build and by the admin panel, so a width can never
// mean two different things in two different places - which is how a srcset ends up
// advertising a size the layout cannot use.
//
// Defaults mirror wrangler.toml [vars] and src/node.ts, the same convention the rest
// of the configuration already uses: .env (local) overrides, [vars] is the deployed
// default, and code carries the fallback for a key nobody set.

/**
 * How optimized images reach a customer.
 *
 * - "transform": URLs carry /cdn-cgi/image/<options>/ and Cloudflare resizes and
 *   negotiates format at the edge. Needs a custom domain on a Cloudflare zone; it
 *   does NOT work on *.pages.dev.
 * - "derivative": the admin's browser renders the widths and uploads them, and the
 *   R2 custom domain serves them directly. Costs zero transformations, which is why
 *   it is the safe default when no custom domain exists yet.
 *
 * Neither mode puts a Worker in the image path.
 */
export type ImageMode = "transform" | "derivative";

/** The image slots a layout actually has. Widths are per slot, never global. */
export type ImageSlot = "hero" | "gallery" | "testimonial" | "thumbnail";

/**
 * Three widths per slot, not seven. Every entry here is a size some layout can
 * actually render; a width nothing displays is a transformation budget spent on
 * bytes no customer ever sees.
 */
export const DEFAULT_IMAGE_WIDTHS: Record<ImageSlot, number[]> = {
  hero: [480, 768, 1200],
  gallery: [320, 640, 960],
  testimonial: [320, 640],
  thumbnail: [160, 320],
};

/**
 * Quality is a VISUAL decision, not a size decision: a 70KB image with mushy label
 * text fails the same way a 120KB one passes, only slower. These are starting
 * points to be tuned by looking at a real product at 100% on a real phone.
 */
export const DEFAULT_IMAGE_QUALITY: Record<ImageSlot, number> = {
  hero: 80,
  gallery: 75,
  testimonial: 70,
  thumbnail: 70,
};

/** Cloudflare's transformation ceiling on the free plan is 5000 UNIQUE/month. */
export const FREE_TIER_TRANSFORM_BUDGET = 5000;

/** Warn (never block) once projected usage passes this share of the budget. */
export const TRANSFORM_BUDGET_WARN_RATIO = 0.7;

export type ImageConfig = {
  mode: ImageMode;
  maxUploadBytes: number;
  maxDimension: number;
  widths: Record<ImageSlot, number[]>;
  quality: Record<ImageSlot, number>;
  /** How long the edge may serve public catalog JSON without asking again. */
  catalogEdgeTtlSeconds: number;
  staleWhileRevalidateSeconds: number;
  /** Storage key prefix. Existing rows keep the uploads/ shape. */
  keyPrefix: string;
};

function int(raw: string | undefined, fallback: number): number {
  const value = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function widths(raw: string | undefined, fallback: number[]): number[] {
  const parsed = (raw ?? "")
    .split(",")
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((value) => Number.isFinite(value) && value > 0);
  // An empty or nonsense override falls back rather than yielding an empty set,
  // because an empty srcset is a page with no images at all.
  return parsed.length > 0 ? [...new Set(parsed)].sort((a, b) => a - b) : fallback;
}

/**
 * Resolves configuration from a record of raw env values.
 *
 * Takes a plain object rather than Env so it can be unit-tested with any values at
 * all, including none.
 */
export function imageConfigFrom(raw: Record<string, string | undefined> = {}): ImageConfig {
  const mode = raw.IMAGE_MODE === "transform" || raw.IMAGE_MODE === "derivative"
    ? raw.IMAGE_MODE
    : "derivative";

  return {
    mode,
    maxUploadBytes: int(raw.MAX_UPLOAD_BYTES, 10 * 1024 * 1024),
    // 12,000px per side is Cloudflare's transformation ceiling; an image larger
    // than that cannot be delivered through the transform path at all.
    maxDimension: int(raw.MAX_IMAGE_DIMENSION, 12_000),
    widths: {
      hero: widths(raw.IMAGE_WIDTHS_HERO, DEFAULT_IMAGE_WIDTHS.hero),
      gallery: widths(raw.IMAGE_WIDTHS_GALLERY, DEFAULT_IMAGE_WIDTHS.gallery),
      testimonial: widths(raw.IMAGE_WIDTHS_TESTIMONIAL, DEFAULT_IMAGE_WIDTHS.testimonial),
      thumbnail: widths(raw.IMAGE_WIDTHS_THUMBNAIL, DEFAULT_IMAGE_WIDTHS.thumbnail),
    },
    quality: {
      hero: int(raw.IMAGE_QUALITY_HERO, DEFAULT_IMAGE_QUALITY.hero),
      gallery: int(raw.IMAGE_QUALITY_GALLERY, DEFAULT_IMAGE_QUALITY.gallery),
      testimonial: int(raw.IMAGE_QUALITY_TESTIMONIAL, DEFAULT_IMAGE_QUALITY.testimonial),
      thumbnail: int(raw.IMAGE_QUALITY_THUMBNAIL, DEFAULT_IMAGE_QUALITY.thumbnail),
    },
    catalogEdgeTtlSeconds: int(raw.CATALOG_EDGE_TTL, 300),
    staleWhileRevalidateSeconds: int(raw.CATALOG_EDGE_SWR, 3600),
    keyPrefix: (raw.IMAGE_KEY_PREFIX ?? "uploads").replace(/\/+$/, ""),
  };
}

/**
 * How many unique transformations the current catalogue would produce.
 *
 * The format multiplier is deliberately pessimistic: `format=auto` negotiates a
 * format per browser, and until the Cloudflare dashboard has confirmed how those
 * variants are counted, assuming one transformation per format (3) is the honest
 * ceiling. Being wrong pessimistically costs nothing; being wrong optimistically
 * means discovering error 9422 - a HARD failure, new images stop transforming -
 * in front of a customer rather than in a dashboard.
 */
export function projectTransformUsage({
  imageCount,
  widthsPerSlot,
  slotsPerImage = 2,
  formatsPerTransform = 3,
}: {
  imageCount: number;
  widthsPerSlot: number;
  slotsPerImage?: number;
  formatsPerTransform?: number;
}): { transformations: number; ratio: number; warning: string | null } {
  const transformations = imageCount * widthsPerSlot * slotsPerImage * formatsPerTransform;
  const ratio = transformations / FREE_TIER_TRANSFORM_BUDGET;
  return {
    transformations,
    ratio,
    warning: ratio >= TRANSFORM_BUDGET_WARN_RATIO
      ? `Projected ${transformations} transformations is ${Math.round(ratio * 100)}% of the `
        + `${FREE_TIER_TRANSFORM_BUDGET}/month free budget. `
        + "Set IMAGE_MODE=derivative to drop transformation usage to zero."
      : null,
  };
}