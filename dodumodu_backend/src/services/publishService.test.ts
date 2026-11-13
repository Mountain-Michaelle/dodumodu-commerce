import { test } from "node:test";
import assert from "node:assert/strict";
import { publishService } from "./publishService";
import { productsRepo } from "../data/productsRepo";
import { productPagesRepo } from "../data/productPagesRepo";
import { testimonialsRepo } from "../data/testimonialsRepo";
import { discountTiersRepo } from "../data/discountTiersRepo";
import { paymentRulesRepo } from "../data/paymentRulesRepo";
import { publishesRepo } from "../data/publishesRepo";
import { siteBuildsRepo } from "../data/siteBuildsRepo";
import { PUBLISH_REF_PATTERN } from "./publishRef";
import type { Env } from "../env";

/* A publish is successful the moment the immutable snapshot exists; deploying is a separate fact.
   What these tests pin down:
     * a publish id is minted ONLY when the content changed - publishing twice, or retrying, never mints another;
     * a retry is a new BUILD against the SAME publish ref;
     * every dispatch failure - an unreachable GitHub, a rejected token, a missing token - is a FAILED build that
       carries the exact reason, so the admin never shows "deploying" for ever.
   Repository reads are stubbed; what is asserted is what ended up recorded. */

const env = (token: string) => ({ MAX_ORDER_QUANTITY: "20", GITHUB_DEPLOY_TOKEN: token } as unknown as Env);

const PRODUCT = {
  id: 1, slug: "glow-serum", name: "Radiance Glow Serum", description: "A bright serum.",
  price: 1500000, packageOptions: [], seoTitle: null, seoDescription: null,
};

type PublishRow = {
  id: number; productId: number; payload: unknown; publishedBy: string; buildStatus: string; publishRef: string;
  contentHash: string | null; deployError: string | null; deployHttpStatus: number | null; deployAttempts: number;
};
type BuildRow = {
  buildId: string; status: string; triggerPublishId: number | null; intendedPublications: { publishRef: string }[];
  verificationError: string | null; failedStep: string | null; lastEventAt: Date;
};

function harness() {
  const rows: PublishRow[] = [];
  const builds: BuildRow[] = [];
  const events: { buildId: string; step: string; status: string; message?: string | null }[] = [];
  const saved = {
    findBySlug: productsRepo.findBySlug, forProduct: productPagesRepo.forProduct, savePage: productPagesRepo.save,
    imagesForProduct: productsRepo.imagesForProduct, listActiveForProduct: testimonialsRepo.listActiveForProduct,
    findActive: discountTiersRepo.findActive, getRules: paymentRulesRepo.get,
    record: publishesRepo.record, recordDeployAttempt: publishesRepo.recordDeployAttempt,
    latestForProduct: publishesRepo.latestForProduct,
    sRecord: siteBuildsRepo.record, sAddEvent: siteBuildsRepo.addEvent, sMarkFailed: siteBuildsRepo.markFailed,
    sLatestForPublish: siteBuildsRepo.latestForPublish,
  };

  productsRepo.findBySlug = async () => PRODUCT as never;
  productPagesRepo.forProduct = async () => ({ summaryHtml: "<p>Summary</p>" }) as never;
  productPagesRepo.save = async () => ({ summaryHtml: "<p>Summary</p>" }) as never;
  productsRepo.imagesForProduct = async () => [] as never;
  testimonialsRepo.listActiveForProduct = async () => [] as never;
  discountTiersRepo.findActive = async () => [] as never;
  paymentRulesRepo.get = async () => ({ codStates: ["Lagos"], codBulkThreshold: 5 }) as never;

  publishesRepo.record = async (_db, input) => {
    const row = {
      id: rows.length + 1, productId: input.productId, payload: input.payload, publishedBy: input.publishedBy ?? "x",
      buildStatus: input.buildStatus ?? "triggered", publishRef: input.publishRef, contentHash: input.contentHash ?? null,
      deployError: null, deployHttpStatus: null, deployAttempts: 0,
    };
    rows.push(row);
    return row as never;
  };
  publishesRepo.recordDeployAttempt = async (_db, id, a) => {
    const row = rows.find((r) => r.id === id);
    if (!row) return false;
    Object.assign(row, { buildStatus: a.status, deployError: a.error, deployHttpStatus: a.httpStatus, deployAttempts: row.deployAttempts + 1 });
    return true;
  };
  publishesRepo.latestForProduct = async () => (rows[rows.length - 1] ?? null) as never;

  siteBuildsRepo.record = async (_db, input) => {
    const row = {
      buildId: input.buildId, status: input.status ?? "triggered", triggerPublishId: input.triggerPublishId ?? null,
      intendedPublications: input.intendedPublications as never, verificationError: null, failedStep: null, lastEventAt: new Date(),
    };
    builds.push(row);
    return row as never;
  };
  siteBuildsRepo.addEvent = async (_db, e) => { events.push(e); return {} as never; };
  siteBuildsRepo.markFailed = async (_db, buildId, error, step) => {
    const b = builds.find((x) => x.buildId === buildId);
    if (b) Object.assign(b, { status: "failed", verificationError: error, failedStep: step ?? null });
    return b as never;
  };
  siteBuildsRepo.latestForPublish = async (_db, id) =>
    ([...builds].reverse().find((b) => b.triggerPublishId === id) ?? null) as never;

  const restore = () => {
    productsRepo.findBySlug = saved.findBySlug; productPagesRepo.forProduct = saved.forProduct;
    productPagesRepo.save = saved.savePage; productsRepo.imagesForProduct = saved.imagesForProduct;
    testimonialsRepo.listActiveForProduct = saved.listActiveForProduct; discountTiersRepo.findActive = saved.findActive;
    paymentRulesRepo.get = saved.getRules; publishesRepo.record = saved.record;
    publishesRepo.recordDeployAttempt = saved.recordDeployAttempt; publishesRepo.latestForProduct = saved.latestForProduct;
    siteBuildsRepo.record = saved.sRecord; siteBuildsRepo.addEvent = saved.sAddEvent;
    siteBuildsRepo.markFailed = saved.sMarkFailed; siteBuildsRepo.latestForPublish = saved.sLatestForPublish;
  };
  return { rows, builds, events, restore, dispatches: [] as { body: Record<string, unknown> }[] };
}

async function withHarness(
  fetchImpl: (init: RequestInit) => Promise<Response>,
  run: (ctx: ReturnType<typeof harness>) => Promise<void>,
) {
  const originalFetch = globalThis.fetch;
  const ctx = harness();
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    ctx.dispatches.push({ body: JSON.parse(String(init?.body ?? "{}")) });
    return fetchImpl(init);
  }) as never;
  try { await run(ctx); } finally { globalThis.fetch = originalFetch; ctx.restore(); }
}

const db = {} as never;
const ok = async () => new Response(null, { status: 204 });

test("a publish gets a random pub_ + 20 hex ref and a queued build whose id is sent to GitHub", async () => {
  await withHarness(ok, async (ctx) => {
    const r = await publishService.publish(db, env("tok"), "glow-serum", "owner@test");
    assert.match(r.record.publishRef, PUBLISH_REF_PATTERN);
    assert.equal(r.reused, false);
    assert.equal(r.outcome, "dispatched");
    assert.equal(r.deployment.status, "triggered");
    assert.equal(ctx.builds.length, 1);
    const sent = (ctx.dispatches[0].body.client_payload ?? {}) as Record<string, unknown>;
    assert.equal(sent.build_id, r.buildId, "the run reports against the build the Worker already created");
    assert.equal(sent.publish_ref, r.record.publishRef);
  });
});

test("publishing identical content again reuses the publish: no new ref, and no second build while one runs", async () => {
  await withHarness(ok, async (ctx) => {
    const first = await publishService.publish(db, env("tok"), "glow-serum", "owner@test");
    const second = await publishService.publish(db, env("tok"), "glow-serum", "owner@test");
    assert.equal(ctx.rows.length, 1, "a second publish row must not be created");
    assert.equal(second.record.publishRef, first.record.publishRef);
    assert.equal(second.reused, true);
    assert.equal(second.outcome, "already-running");
    assert.equal(ctx.dispatches.length, 1, "GitHub is not asked twice for the same publish");
  });
});

test("a FAILED dispatch keeps the snapshot, records the exact reason, and fails the build instead of leaving it pending", async () => {
  await withHarness(async () => new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 }), async (ctx) => {
    const r = await publishService.publish(db, env("tok"), "glow-serum", "owner@test");
    assert.ok(r.record, "a failed deploy never means the publish failed");
    assert.equal(r.deployment.status, "failed");
    assert.match(r.deployment.error ?? "", /401.*Bad credentials/);
    assert.equal(ctx.rows.length, 1);
    assert.equal(ctx.rows[0].deployError, r.deployment.error);
    assert.equal(ctx.builds[0].status, "failed");
    assert.equal(ctx.builds[0].failedStep, "dispatch");
  });
});

test("a missing token is a FAILED build with the reason, not a silent pending", async () => {
  await withHarness(async () => { throw new Error("must not be called"); }, async (ctx) => {
    const r = await publishService.publish(db, env(""), "glow-serum", "owner@test");
    assert.equal(r.deployment.status, "pending");
    assert.match(r.deployment.error ?? "", /GITHUB_DEPLOY_TOKEN/);
    assert.equal(ctx.builds[0].status, "failed");
    assert.match(ctx.builds[0].verificationError ?? "", /GITHUB_DEPLOY_TOKEN/);
  });
});

test("changed content mints a NEW ref; unchanged content after a failure reuses the old one and retries it", async () => {
  await withHarness(async () => new Response("{}", { status: 500 }), async (ctx) => {
    const first = await publishService.publish(db, env("tok"), "glow-serum", "owner@test");
    const again = await publishService.publish(db, env("tok"), "glow-serum", "owner@test");
    assert.equal(again.record.publishRef, first.record.publishRef, "a failed deploy does not create another publish");
    assert.equal(ctx.rows.length, 1);
    assert.equal(again.outcome, "dispatched", "but it does try the build again");
    assert.equal(ctx.builds.length, 2);

    PRODUCT.name = "Radiance Glow Serum 2";
    try {
      const changed = await publishService.publish(db, env("tok"), "glow-serum", "owner@test");
      assert.notEqual(changed.record.publishRef, first.record.publishRef);
      assert.equal(ctx.rows.length, 2);
    } finally { PRODUCT.name = "Radiance Glow Serum"; }
  });
});

test("every publish writes a complete snapshot, so the build never reads a draft table", async () => {
  await withHarness(ok, async (ctx) => {
    await publishService.publish(db, env("tok"), "glow-serum", "owner@test");
    const payload = ctx.rows[0].payload as Record<string, unknown>;
    for (const key of ["slug", "publishedAt", "product", "page", "images", "testimonials",
      "deliveryOptions", "discountTiers", "paymentRules"]) {
      assert.ok(key in payload, `the snapshot must carry ${key}`);
    }
  });
});

test("a retry is a NEW build against the SAME publish and creates no second snapshot", async () => {
  await withHarness(ok, async (ctx) => {
    const published = await publishService.publish(db, env(""), "glow-serum", "owner@test");
    const retry = await publishService.redeploy(db, env("tok"), 1, "owner@test");
    assert.ok(retry);
    assert.equal(retry.publishId, published.record.id);
    assert.equal(retry.publishRef, published.record.publishRef);
    assert.equal(retry.deployment.status, "triggered");
    assert.equal(ctx.rows.length, 1, "a retry must NOT create a second snapshot");
    assert.equal(ctx.builds.length, 2, "it is its own build, so its steps are its own");
  });
});

test("retrying a product that was never published is null, not an error", async () => {
  await withHarness(ok, async () => {
    assert.equal(await publishService.redeploy(db, env("tok"), 1), null);
  });
});
