/**
 * Building the URLs that fetch an image.
 *
 * This module is deliberately dependency-free: no DOM, no window, no fetch. That is
 * what lets the Pages BUILD use it to write srcset into prerendered HTML and the
 * BROWSER use it at runtime, so a width can never mean one thing at build time and
 * another at runtime - which is exactly how a page ends up advertising a candidate
 * the layout cannot display.
 *
 * Two delivery modes, one builder:
 *
 *   transform  - Cloudflare resizes and negotiates format at the edge, from
 *                /cdn-cgi/image/<options>/. Needs a custom domain on a Cloudflare
 *                zone. Costs transformation budget.
 *   derivative - the admin's browser already rendered each width and uploaded it, so
 *                the URL is a plain R2 object. Costs nothing.
 *
 * In BOTH cases no Worker sits in the image path: the browser talks to the R2 custom
 * domain directly.
 *
 * These values are the defaults from src/config/imageConfig.ts. They are duplicated
 * here rather than imported because the site's build has no access to the backend's
 * TypeScript; the server injects the real values into the page at build time, and
 * test/image-urls.check.mjs asserts the two never drift.
 */

export const DEFAULT_WIDTHS = {
  hero: [480, 768, 1200],
  gallery: [320, 640, 960],
  testimonial: [320, 640],
  thumbnail: [160, 320],
};

export const DEFAULT_QUALITY = {
  hero: 80,
  gallery: 75,
  testimonial: 70,
  thumbnail: 70,
};

/**
 * The real rendered width of each slot, in CSS pixels, per breakpoint.
 *
 * `sizes` is not a guess: it is what tells the browser which candidate to pick
 * BEFORE the image arrives. A wrong `sizes` makes the browser download the wrong
 * width on every load, and the mistake is invisible until you read the network tab.
 *
 * The hero is full-bleed on a phone and half a two-column grid from 768px up. The
 * gallery and testimonials sit in the same column. The breakpoint must match the
 * layout's own `max-width: 768px` media query, or the two disagree at exactly one
 * width - which is the width most real devices land on.
 */
export const DEFAULT_SIZES = {
  hero: "(max-width: 768px) 100vw, 480px",
  gallery: "(max-width: 768px) 100vw, 480px",
  testimonial: "(max-width: 768px) 100vw, 480px",
  thumbnail: "48px",
};

/** The width that goes in the `width`/`height` attributes: the largest we serve. */
export function intrinsicWidthFor(slot, widths = DEFAULT_WIDTHS) {
  const list = widths[slot] || widths.hero;
  return list[list.length - 1];
}

/**
 * One image URL at one width.
 *
 * `fit=scale-down` never upscales: asking for 1200px of a 600px image returns the
 * 600px original rather than inventing pixels, so a small source never costs more
 * bytes than it already has.
 *
 * `format=auto` is the whole reason there is one URL per WIDTH rather than one per
 * format: Cloudflare picks AVIF, then WebP, then the original format as the browser
 * allows. Building separate AVIF/WebP URLs, or wrapping them in <picture>, would
 * multiply the transformation count for no visual gain.
 */
export function imageUrl({
  key,
  width,
  quality,
  mode = "transform",
  deliveryBase = "/media",
}) {
  if (typeof key !== "string" || key === "") return "";
  // An absolute key is used as-is. That is how a database row can point at a real
  // CDN asset rather than a storage key, and it must survive untouched.
  const absolute = /^https?:\/\//i.test(key);
  const base = deliveryBase.replace(/\/+$/, "");

  if (absolute) {
    return mode === "transform"
      ? `${key.replace(/\/+$/, "")}`
      : `${key}`;
  }

  if (mode === "derivative") {
    // The admin rendered and uploaded this exact width at upload time. The width is
    // part of the key rather than a query string, so every candidate is a distinct
    // immutable object with its own one-year cache.
    const stem = key.replace(/\.[^./]+$/, "");
    const extension = (key.match(/\.[^./]+$/) || [""])[0];
    return `${base}/${stem}.w${width}${extension}`;
  }

  // format=auto negotiates; no sharpen/brightness/gamma, because those are how an
  // image comes back looking processed rather than sharp.
  const options = `width=${width},quality=${quality},format=auto,fit=scale-down`;
  return `${base}/cdn-cgi/image/${options}/${key}`;
}

/**
 * A srcset for one image in one slot.
 *
 * Every candidate is the same image at a different width, so the browser picks by
 * layout and device pixel ratio and never downloads more than it will display.
 */
export function srcsetFor({
  key,
  slot = "hero",
  widths = DEFAULT_WIDTHS,
  quality = DEFAULT_QUALITY,
  mode = "transform",
  deliveryBase = "/media",
}) {
  if (typeof key !== "string" || key === "") return "";
  const list = widths[slot] || widths.hero;
  const q = quality[slot] ?? quality.hero;
  return list
    .map((width) => `${imageUrl({ key, width, quality: q, mode, deliveryBase })} ${width}w`)
    .join(", ");
}

/**
 * Every <img> attribute an image needs, in one call.
 *
 * Grouped because a missing width/height is the single cheapest way to destroy CLS,
 * and doing it correctly in five call sites means five chances to forget one.
 * `sizes` is emitted only when it is known: an absent sizes attribute is far better
 * than a wrong one, because it makes the browser assume the image fills the
 * viewport and pick conservatively large.
 */
export function imgAttrs({ key, slot = "hero", width, height, alt = "", ...rest }) {
  const sizes = rest.sizes !== undefined ? rest.sizes : DEFAULT_SIZES[slot];
  return {
    src: rest.src || imageUrl({
      key,
      width: rest.defaultWidth || intrinsicWidthFor(slot, rest.widths),
      quality: (rest.quality || DEFAULT_QUALITY)[slot] ?? 80,
      mode: rest.mode,
      deliveryBase: rest.deliveryBase,
    }),
    srcset: rest.srcset || srcsetFor({ key, slot, ...rest }),
    sizes,
    width,
    height,
    alt,
  };
}