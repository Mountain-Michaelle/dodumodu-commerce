import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolvePublishState, readPublishVersion, publishVersion, verifyStorefront,
} from "./storefrontStatus";

/* LIVE is a MEASUREMENT, not a claim.
   Every test here exists to make it hard to show "LIVE" without evidence, because
   the failure this design prevents is a console that says a page is live while the
   edge is still serving the previous build. */

const env = (siteUrl: string) => ({ SITE_URL: siteUrl } as never);

/** Runs a test with a stubbed fetch, restoring the real one afterwards. */
async function withFetch(impl: (url: string) => Promise<Response>, body: () => Promise<void>) {
  const original = globalThis.fetch;
  globalThis.fetch = impl as never;
  try { await body(); } finally { globalThis.fetch = original; }
}

/* ---- the version marker ---- */

test("the version marker is namespaced, so publish 6 is never confused with any other 6", () => {
  assert.equal(publishVersion(6), "pub_6");
  assert.equal(publishVersion(123), "pub_123");
});

test("the marker is read from rendered HTML in either attribute order", () => {
  assert.equal(readPublishVersion('<meta name="storefront-publish-id" content="pub_7">'), "pub_7");
  // A minifier may reorder attributes, and a check that only understands one order
  // would silently report "not live" for a page that IS live.
  assert.equal(readPublishVersion('<meta content="pub_7" name="storefront-publish-id">'), "pub_7");
  assert.equal(readPublishVersion('<meta name="storefront-publish-id" content="pub_7"/>'), "pub_7");
  assert.equal(readPublishVersion("<meta name='storefront-publish-id' content='pub_7'>"), "pub_7");
});

test("a page with no marker yields null, never a guess", () => {
  assert.equal(readPublishVersion("<html><body>no marker</body></html>"), null);
  // An empty content attribute is not a version. Treating "" as one would make a
  // freshly built page look verified.
  assert.equal(readPublishVersion('<meta name="storefront-publish-id" content="">'), null);
  assert.equal(readPublishVersion(""), null);
});

/* ---- verification never invents an answer ---- */

test("verification reads the version the public page is actually serving", async () => {
  await withFetch(
    async () => new Response('<meta name="storefront-publish-id" content="pub_42">'),
    async () => {
      const result = await verifyStorefront(env("https://shop.example"), "glow-serum");
      assert.equal(result.liveVersion, "pub_42");
      assert.equal(result.reason, null);
      assert.equal(result.url, "https://shop.example/products/glow-serum/");
    },
  );
});

test("an unreachable storefront reports no version rather than throwing", async () => {
  await withFetch(async () => { throw new Error("ENOTFOUND"); }, async () => {
    const result = await verifyStorefront(env("https://shop.example"), "glow-serum");
    assert.equal(result.liveVersion, null);
    assert.equal(result.reason, "unreachable");
  });
});

test("a 404 is reported distinctly, so a missing page is not read as a network fault", async () => {
  await withFetch(async () => new Response("gone", { status: 404 }), async () => {
    const result = await verifyStorefront(env("https://shop.example"), "gone");
    assert.equal(result.reason, "no-status");
    assert.equal(result.liveVersion, null);
  });
});

test("an unconfigured SITE_URL is reported as such, not as a failed check", async () => {
  // Locally there is no public storefront. That is normal, and it must never be
  // rendered as "the deployment failed".
  const result = await verifyStorefront(env(""), "glow-serum");
  assert.equal(result.reason, "unconfigured");
  assert.equal(result.liveVersion, null);
});

test("a served page with no marker is 'unreadable', which is not evidence of anything", async () => {
  await withFetch(async () => new Response("<html>built before versioning</html>"), async () => {
    const result = await verifyStorefront(env("https://shop.example"), "glow-serum");
    assert.equal(result.reason, "unreadable");
    assert.equal(result.liveVersion, null);
  });
});

/* ---- the state rule ---- */

test("LIVE requires the storefront to report EXACTLY the latest publish", () => {
  assert.equal(resolvePublishState({
    latestPublishId: 7, buildStatus: "triggered", liveVersion: "pub_7",
  }), "LIVE");
});

test("a stale storefront is NOT live, whatever the deploy hook said", () => {
  // The hook was accepted (buildStatus "triggered") but the edge is still serving
  // pub_6. Reporting LIVE here is precisely the bug this design exists to stop.
  assert.equal(resolvePublishState({
    latestPublishId: 7, buildStatus: "triggered", liveVersion: "pub_6",
  }), "DEPLOYING");
});

test("a verified page is LIVE even if the last hook attempt failed", () => {
  // The ordering matters: a naive "failed wins" rule would hide a page that IS
  // already being served.
  assert.equal(resolvePublishState({
    latestPublishId: 7, buildStatus: "failed", liveVersion: "pub_7",
  }), "LIVE");
});

test("a failed hook with no verification is FAILED, and the snapshot is unaffected", () => {
  assert.equal(resolvePublishState({
    latestPublishId: 7, buildStatus: "failed", liveVersion: null,
  }), "FAILED");
  assert.equal(resolvePublishState({
    latestPublishId: 7, buildStatus: "failed", liveVersion: "pub_6",
  }), "FAILED");
});

test("an accepted rebuild that has not landed is DEPLOYING", () => {
  assert.equal(resolvePublishState({
    latestPublishId: 7, buildStatus: "triggered", liveVersion: null,
  }), "DEPLOYING");
});

test("a snapshot with no rebuild requested is PUBLISHED", () => {
  assert.equal(resolvePublishState({
    latestPublishId: 7, buildStatus: "pending", liveVersion: null,
  }), "PUBLISHED");
});

test("a product that was never published is PUBLISHED with no version to claim", () => {
  assert.equal(resolvePublishState({
    latestPublishId: null, buildStatus: "pending", liveVersion: null,
  }), "PUBLISHED");
});

test("a storefront serving a NEWER publish than we hold is not our LIVE", () => {
  // Somebody deployed without publishing through this console. The newest publish
  // we hold is not the one being served, so claiming LIVE would be false.
  assert.equal(resolvePublishState({
    latestPublishId: 7, buildStatus: "triggered", liveVersion: "pub_9",
  }), "DEPLOYING");
});