import { test } from "node:test";
import assert from "node:assert/strict";
import { publishService } from "./publishService";
import { productsRepo } from "../data/productsRepo";
import { productPagesRepo } from "../data/productPagesRepo";
import { testimonialsRepo } from "../data/testimonialsRepo";
import { discountTiersRepo } from "../data/discountTiersRepo";
import { paymentRulesRepo } from "../data/paymentRulesRepo";
import { publishesRepo } from "../data/publishesRepo";
import type { Env } from "../env";

/* Publishing and deploying are separate facts, and these tests exist because it is
   easy to conflate them.

   The invariant under test: a publish is successful the moment the immutable
   snapshot exists. Cloudflare being unreachable is a fact about Cloudflare, not
   about whether the content was captured - and a valid snapshot must survive it.

   Repository reads are stubbed, following the approach src/routes/admin.test.ts
   uses. What is under test here is the ORDER of the two operations and the
   SEPARATION of their outcomes, not the SQL. What is asserted is what ended up
   recorded in product_publishes, because that is the durable artefact. */

const env = (hook: string) => ({ MAX_ORDER_QUANTITY: "20", PAGES_DEPLOY_HOOK: hook } as unknown as Env);

const PRODUCT = {
  id: 1, slug: "glow-serum", name: "Radiance Glow Serum", description: "A bright serum.",
  price: 1500000, packageOptions: [], seoTitle: null, seoDescription: null,
};

type SnapshotRow = { id: number; payload: unknown; publishedBy: string; buildStatus: string };

/**
 * Stubs every read assemble() performs and both publish writes, recording what
 * lands in product_publishes so the assertions are about real durable state.
 */
function harness() {
  const rows: SnapshotRow[] = [];
  const saved = {
    findBySlug: productsRepo.findBySlug,
    forProduct: productPagesRepo.forProduct,
    savePage: productPagesRepo.save,
    imagesForProduct: productsRepo.imagesForProduct,
    listActiveForProduct: testimonialsRepo.listActiveForProduct,
    findActive: discountTiersRepo.findActive,
    getRules: paymentRulesRepo.get,
    record: publishesRepo.record,
    markBuildStatus: publishesRepo.markBuildStatus,
    latestForProduct: publishesRepo.latestForProduct,
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
      id: rows.length + 1,
      payload: input.payload,
      publishedBy: input.publishedBy ?? "unknown",
      buildStatus: input.buildStatus ?? "triggered",
    } as SnapshotRow;
    rows.push(row);
    return row as never;
  };
  publishesRepo.markBuildStatus = async (_db, id, status) => {
    const row = rows.find((r) => r.id === id);
    if (!row) return false;
    row.buildStatus = status;
    return true;
  };
  publishesRepo.latestForProduct = async () => (rows[rows.length - 1] ?? null) as never;

  const restore = () => {
    productsRepo.findBySlug = saved.findBySlug;
    productPagesRepo.forProduct = saved.forProduct;
    productPagesRepo.save = saved.savePage;
    productsRepo.imagesForProduct = saved.imagesForProduct;
    testimonialsRepo.listActiveForProduct = saved.listActiveForProduct;
    discountTiersRepo.findActive = saved.findActive;
    paymentRulesRepo.get = saved.getRules;
    publishesRepo.record = saved.record;
    publishesRepo.markBuildStatus = saved.markBuildStatus;
    publishesRepo.latestForProduct = saved.latestForProduct;
  };

  return { rows, restore, onFetch: null as null | (() => void) };
}

/**
 * Runs a test with a stubbed fetch and a stubbed harness, restoring both after.
 *
 * `ctx.onFetch` is a hook the test can set to observe state at the exact moment the
 * deploy hook is called - which is the only way to assert the ORDER of the two
 * operations rather than just their end states.
 */
async function withHarness(
  fetchImpl: () => Promise<Response>,
  run: (ctx: ReturnType<typeof harness>) => Promise<void>,
) {
  const originalFetch = globalThis.fetch;
  const ctx = harness();
  globalThis.fetch = (async () => {
    ctx.onFetch?.();
    return fetchImpl();
  }) as never;
  try { await run(ctx); } finally { globalThis.fetch = originalFetch; ctx.restore(); }
}

const db = {} as never;

test("a successful hook reports published AND triggered, as two separate facts", async () => {
  await withHarness(async () => new Response("", { status: 201 }), async (ctx) => {
    const result = await publishService.publish(db, env("https://hook.example/d"), "glow-serum", "owner@test");
    assert.ok(result.record, "the snapshot must exist");
    assert.equal(result.deployment.status, "triggered");
    assert.equal(result.deployment.retryable, true);
    assert.equal(ctx.rows.length, 1, "exactly one snapshot");
    assert.equal(ctx.rows[0].buildStatus, "triggered");
  });
});

test("a FAILED hook does not roll back, delete or invalidate the snapshot", async () => {
  await withHarness(async () => { throw new Error("ECONNREFUSED"); }, async () => {
    const result = await publishService.publish(db, env("https://hook.example/d"), "glow-serum", "owner@test");
    // The publish still happened. That is the entire design.
    assert.ok(result.record, "a failed deploy must never mean the publish failed");
    assert.equal(result.deployment.status, "failed");
    assert.equal(result.deployment.retryable, true);
  });
  // The snapshot itself is inspected in the next test, where it can be.
});

test("a FAILED hook still leaves the snapshot present with its payload intact", async () => {
  await withHarness(async () => new Response("", { status: 500 }), async (ctx) => {
    await publishService.publish(db, env("https://hook.example/d"), "glow-serum", "owner@test");
    assert.equal(ctx.rows.length, 1, "the snapshot must survive the deploy failure");
    assert.ok(ctx.rows[0].payload, "and must still carry its content");
    assert.equal(ctx.rows[0].buildStatus, "failed", "but it is honestly recorded as failed");
  });
});

test("a snapshot is inserted as 'pending', never as 'triggered' before the hook fires", async () => {
  // "triggered" means the request was ACCEPTED. Asserting it at insert time would
  // claim something that has not happened yet. This reads the row from inside the
  // stubbed fetch, which runs after the insert and before the status is written -
  // so it observes exactly that window.
  let statusWhenHookFired: string | undefined;
  await withHarness(async () => new Response("", { status: 200 }), async (ctx) => {
    ctx.onFetch = () => { statusWhenHookFired = ctx.rows[0]?.buildStatus; };
    await publishService.publish(db, env("https://hook.example/d"), "glow-serum", "owner@test");
    assert.equal(statusWhenHookFired, "pending",
      "at the moment the hook is called the snapshot must still say pending");
    assert.equal(ctx.rows[0].buildStatus, "triggered", "and only afterwards become triggered");
  });
});

test("with no hook configured the publish succeeds and the status stays pending", async () => {
  await withHarness(async () => { throw new Error("must not be called"); }, async (ctx) => {
    const result = await publishService.publish(db, env(""), "glow-serum", "owner@test");
    assert.ok(result.record, "a local publish still publishes");
    assert.equal(result.deployment.status, "pending");
    assert.equal(result.deployment.retryable, false, "there is nothing to retry when nothing was configured");
    assert.equal(ctx.rows[0].buildStatus, "pending", "an absent hook must never be recorded as a failure");
  });
});

test("every publish writes a complete snapshot, so the build never reads a draft table", async () => {
  await withHarness(async () => { throw new Error("x"); }, async (ctx) => {
    await publishService.publish(db, env(""), "glow-serum", "owner@test");
    const payload = ctx.rows[0].payload as Record<string, unknown>;
    for (const key of ["slug", "publishedAt", "product", "page", "images", "testimonials",
      "deliveryOptions", "discountTiers", "paymentRules"]) {
      assert.ok(key in payload, `the snapshot must carry ${key}`);
    }
    assert.equal((payload.product as Record<string, unknown>).slug, "glow-serum");
  });
});

test("a retry rebuilds the SAME snapshot instead of publishing again", async () => {
  await withHarness(async () => { throw new Error("down"); }, async (ctx) => {
    const published = await publishService.publish(db, env(""), "glow-serum", "owner@test");
    const before = ctx.rows.length;

    const retry = await publishService.redeploy(db, env("https://hook.example/d"), 1);
    assert.ok(retry, "a retry must find the existing snapshot");
    assert.equal(retry.publishId, published.record.id, "it targets the same publish");
    assert.equal(retry.deployment.status, "failed");
    assert.equal(ctx.rows.length, before, "a retry must NOT create a second snapshot");
    assert.equal(ctx.rows[0].buildStatus, "failed");
  });
});

test("a successful retry marks the existing snapshot triggered, with no second snapshot", async () => {
  await withHarness(async () => new Response("", { status: 200 }), async (ctx) => {
    await publishService.publish(db, env(""), "glow-serum", "owner@test");
    const retry = await publishService.redeploy(db, env("https://hook.example/d"), 1);
    assert.ok(retry, "the retry must find the snapshot the publish just wrote");
    assert.equal(retry.deployment.status, "triggered");
    assert.equal(ctx.rows.length, 1, "still exactly one snapshot");
    assert.equal(ctx.rows[0].buildStatus, "triggered");
  });
});

test("retrying a product that was never published is null, not an error", async () => {
  await withHarness(async () => new Response("", { status: 200 }), async () => {
    assert.equal(await publishService.redeploy(db, env("https://hook.example/d"), 1), null);
  });
});
