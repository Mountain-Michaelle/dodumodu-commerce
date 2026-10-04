import { test } from "node:test";
import assert from "node:assert/strict";
import {
  imageConfigFrom, projectTransformUsage,
  DEFAULT_IMAGE_WIDTHS, FREE_TIER_TRANSFORM_BUDGET,
} from "./imageConfig";

/* Configuration is the only place an image decision is allowed to live.
 *
   These tests exist mostly to pin the FALLBACK behaviour: every value here has a
   default, so a missing environment variable produces a working deployment rather
   than a build that breaks halfway through a Pages run. */

test("an empty environment still produces a complete, usable configuration", () => {
  const config = imageConfigFrom({});
  assert.equal(config.mode, "derivative");
  assert.equal(config.maxUploadBytes, 10 * 1024 * 1024);
  assert.equal(config.maxDimension, 12_000);
  assert.deepEqual(config.widths.hero, [480, 768, 1200]);
  assert.deepEqual(config.widths.gallery, [320, 640, 960]);
  assert.deepEqual(config.widths.testimonial, [320, 640]);
  assert.deepEqual(config.widths.thumbnail, [160, 320]);
  assert.equal(config.quality.hero, 80);
  assert.equal(config.keyPrefix, "uploads", "existing rows keep the uploads/ shape");
});

test("every slot has its own widths, so one slot's sizes cannot leak into another", () => {
  const { widths } = imageConfigFrom({});
  for (const [slot, expected] of Object.entries(DEFAULT_IMAGE_WIDTHS)) {
    assert.deepEqual(widths[slot as keyof typeof widths], expected, `${slot} widths`);
  }
});

test("widths can be overridden per slot from configuration", () => {
  const config = imageConfigFrom({ IMAGE_WIDTHS_HERO: "400,900", IMAGE_QUALITY_GALLERY: "60" });
  assert.deepEqual(config.widths.hero, [400, 900]);
  assert.equal(config.quality.gallery, 60);
  assert.deepEqual(config.widths.gallery, [320, 640, 960], "untouched slots keep their defaults");
});

test("a nonsense width list falls back rather than yielding a page with no images", () => {
  // An empty srcset is a page with no images at all - a worse failure than a
  // default width nobody asked for.
  assert.deepEqual(imageConfigFrom({ IMAGE_WIDTHS_HERO: "" }).widths.hero, [480, 768, 1200]);
  assert.deepEqual(imageConfigFrom({ IMAGE_WIDTHS_HERO: "junk" }).widths.hero, [480, 768, 1200]);
  assert.deepEqual(imageConfigFrom({ IMAGE_WIDTHS_HERO: "-5" }).widths.hero, [480, 768, 1200]);
});

test("widths are de-duplicated and sorted so a srcset is well-formed", () => {
  assert.deepEqual(imageConfigFrom({ IMAGE_WIDTHS_HERO: "800, 400, 800" }).widths.hero, [400, 800]);
});

test("the delivery mode is read from configuration and falls back safely", () => {
  assert.equal(imageConfigFrom({ IMAGE_MODE: "transform" }).mode, "transform");
  assert.equal(imageConfigFrom({ IMAGE_MODE: "derivative" }).mode, "derivative");
  // An unrecognised value must not reach the URL builder and produce a broken path.
  assert.equal(imageConfigFrom({ IMAGE_MODE: "nonsense" }).mode, "derivative");
  assert.equal(imageConfigFrom({ IMAGE_MODE: undefined }).mode, "derivative");
});

test("the key prefix drops trailing slashes so keys cannot start with one", () => {
  assert.equal(imageConfigFrom({ IMAGE_KEY_PREFIX: "products/1/original/" }).keyPrefix, "products/1/original");
});

/* ---- the free-tier transform budget ---- */

test("a normal catalogue projects well inside the free tier", () => {
  // 10 products x 8 images, one slot each, three widths, pessimistically three
  // formats per transform: 720 against a 5,000 ceiling.
  const result = projectTransformUsage({ imageCount: 80, widthsPerSlot: 3, slotsPerImage: 1 });
  assert.equal(result.transformations, 720);
  assert.ok(result.transformations < FREE_TIER_TRANSFORM_BUDGET);
  assert.equal(result.warning, null, "an ordinary catalogue must not raise a warning");
});

test("the budget warns before it is exceeded, and names the way out", () => {
  const result = projectTransformUsage({ imageCount: 2000, widthsPerSlot: 3, slotsPerImage: 2 });
  assert.ok(result.transformations > FREE_TIER_TRANSFORM_BUDGET);
  assert.match(result.warning ?? "", /IMAGE_MODE=derivative/);
});

test("the warning appears at 70% of the budget, not at the ceiling", () => {
  // Warning only once the damage is done would be too late: past 5,000 the next
  // transformation FAILS (error 9422) rather than costing anything.
  const at70 = projectTransformUsage({ imageCount: 3900, widthsPerSlot: 3, slotsPerImage: 1, formatsPerTransform: 1 });
  assert.ok(at70.transformations >= FREE_TIER_TRANSFORM_BUDGET * 0.7, `got ${at70.transformations}`);
  assert.ok(at70.warning, "70% of the budget must already warn");

  const below = projectTransformUsage({ imageCount: 1000, widthsPerSlot: 3, slotsPerImage: 1, formatsPerTransform: 1 });
  assert.equal(below.warning, null);
});