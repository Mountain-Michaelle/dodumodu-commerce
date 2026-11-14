import { test } from "node:test";
import assert from "node:assert/strict";
import { eq, inArray } from "drizzle-orm";
import { registerDbDriver } from "../db";
import { closePools, pgDriver } from "../dbDrivers/pg";
import { products, productPublishes, siteBuilds } from "../schema";
import { siteBuildsRepo } from "../data/siteBuildsRepo";
import { livePage, liveSlugs } from "./livePage";
import { readPublishVersion } from "./storefrontStatus";

/**
 * Published products must survive any rebuild. This build baked NO products (the application build), so every page here
 * comes from the database: only a VERIFIED snapshot is served, a failed later build never takes a live page away, and
 * a newer verified publish replaces it.
 */
const databaseUrl = process.env.DATABASE_URL;
const SLUG = "rebuild-survival-test";
const REF1 = "pub_1111111111111111aaaa";
const REF2 = "pub_2222222222222222bbbb";
const snapshot = (name: string) => ({
  slug: SLUG, product: { id: 1, slug: SLUG, name, description: "d", price: 1000, packageOptions: [] }, page: {},
  images: [{ r2Key: "uploads/a.jpg", altText: "a" }], testimonials: [], deliveryOptions: [], discountTiers: [],
  maxOrderQuantity: 20, paymentRules: {}, freeDeliveryStates: [],
});

test("a verified snapshot is served after a rebuild that baked nothing; unverified and failed ones never replace it", {
  skip: !databaseUrl,
}, async (t) => {
  registerDbDriver(pgDriver);
  const db = pgDriver(databaseUrl!);
  t.after(async () => {
    await db.delete(productPublishes).where(inArray(productPublishes.publishRef, [REF1, REF2]));
    await db.delete(siteBuilds).where(inArray(siteBuilds.buildId, ["rs_b1", "rs_b2"]));
    await db.delete(products).where(eq(products.slug, SLUG));
    await closePools();
  });
  const env = { DATABASE_URL: databaseUrl, SITE_URL: "https://shop.example.com" } as never;

  const [p] = await db.insert(products).values({ slug: SLUG, name: "Serum", description: "d", price: 1000 }).returning();
  const [pub1] = await db.insert(productPublishes).values({ productId: p.id, payload: snapshot("First"), publishedBy: "t", publishRef: REF1 }).returning();

  assert.equal(await livePage(env, SLUG, { fresh: true }), null, "an unverified publish is not served");
  assert.ok(!(await liveSlugs(env)).includes(SLUG));

  await siteBuildsRepo.record(db, { buildId: "rs_b1", intendedPublications: [{ slug: SLUG, publishId: pub1.id, publishRef: REF1 }], triggeredBy: "t", triggerPublishId: pub1.id });
  await siteBuildsRepo.markVerified(db, "rs_b1");
  const first = await livePage(env, SLUG, { fresh: true });
  assert.equal(first?.source, "database");
  assert.equal(readPublishVersion(first!.html), REF1);
  assert.match(first!.html, /<title>First - DODUMODU<\/title>/);
  assert.ok((await liveSlugs(env)).includes(SLUG));

  // A newer publish whose build FAILS must not take the live page away.
  const [pub2] = await db.insert(productPublishes).values({ productId: p.id, payload: snapshot("Second"), publishedBy: "t", publishRef: REF2 }).returning();
  await siteBuildsRepo.record(db, { buildId: "rs_b2", intendedPublications: [{ slug: SLUG, publishId: pub2.id, publishRef: REF2 }], triggeredBy: "t", triggerPublishId: pub2.id });
  await siteBuildsRepo.markFailed(db, "rs_b2", "render exploded", "render");
  assert.equal(readPublishVersion((await livePage(env, SLUG, { fresh: true }))!.html), REF1);
  const [row2] = await db.select().from(productPublishes).where(eq(productPublishes.id, pub2.id));
  assert.equal(row2.buildStatus, "failed");
  assert.equal(row2.deployError, "render exploded");

  // Retrying that same publish and verifying it makes it the live one.
  await siteBuildsRepo.record(db, { buildId: "rs_b3", intendedPublications: [{ slug: SLUG, publishId: pub2.id, publishRef: REF2 }], triggeredBy: "t", triggerPublishId: pub2.id });
  await siteBuildsRepo.markVerified(db, "rs_b3");
  await db.delete(siteBuilds).where(eq(siteBuilds.buildId, "rs_b3"));
  const second = await livePage(env, SLUG, { fresh: true });
  assert.equal(readPublishVersion(second!.html), REF2);
  assert.match(second!.html, /Second - DODUMODU/);
});
