import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolvePublishState, readPublishVersion, verifyStorefront,
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

test("a publish ref is pub_ plus 20 random hex characters, and two never match", async () => {
  const { newPublishRef, PUBLISH_REF_PATTERN } = await import("./publishRef");
  const a = newPublishRef();
  assert.match(a, PUBLISH_REF_PATTERN);
  assert.notEqual(a, newPublishRef());
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
      assert.equal(result.url, "https://shop.example/glow-serum/");
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
    latestPublishRef: "pub_00000000000000000007", buildStatus: "triggered", liveVersion: "pub_00000000000000000007",
  }), "LIVE");
});

test("a stale storefront is NOT live, whatever the deploy hook said", () => {
  // The hook was accepted (buildStatus "triggered") but the edge is still serving
  // pub_6. Reporting LIVE here is precisely the bug this design exists to stop.
  assert.equal(resolvePublishState({
    latestPublishRef: "pub_00000000000000000007", buildStatus: "triggered", liveVersion: "pub_00000000000000000006",
  }), "DEPLOYING");
});

test("a verified page is LIVE even if the last hook attempt failed", () => {
  // The ordering matters: a naive "failed wins" rule would hide a page that IS
  // already being served.
  assert.equal(resolvePublishState({
    latestPublishRef: "pub_00000000000000000007", buildStatus: "failed", liveVersion: "pub_00000000000000000007",
  }), "LIVE");
});

test("a failed hook with no verification is FAILED, and the snapshot is unaffected", () => {
  assert.equal(resolvePublishState({
    latestPublishRef: "pub_00000000000000000007", buildStatus: "failed", liveVersion: null,
  }), "FAILED");
  assert.equal(resolvePublishState({
    latestPublishRef: "pub_00000000000000000007", buildStatus: "failed", liveVersion: "pub_00000000000000000006",
  }), "FAILED");
});

test("an accepted rebuild that has not landed is DEPLOYING", () => {
  assert.equal(resolvePublishState({
    latestPublishRef: "pub_00000000000000000007", buildStatus: "triggered", liveVersion: null,
  }), "DEPLOYING");
});

test("a snapshot with no rebuild requested is PUBLISHED", () => {
  assert.equal(resolvePublishState({
    latestPublishRef: "pub_00000000000000000007", buildStatus: "pending", liveVersion: null,
  }), "PUBLISHED");
});

test("a product that was never published is PUBLISHED with no version to claim", () => {
  assert.equal(resolvePublishState({
    latestPublishRef: null, buildStatus: "pending", liveVersion: null,
  }), "PUBLISHED");
});

test("a storefront serving a NEWER publish than we hold is not our LIVE", () => {
  // Somebody deployed without publishing through this console. The newest publish
  // we hold is not the one being served, so claiming LIVE would be false.
  assert.equal(resolvePublishState({
    latestPublishRef: "pub_00000000000000000007", buildStatus: "triggered", liveVersion: "pub_00000000000000000009",
  }), "DEPLOYING");
});

/* ---- empty-catalog and never-published edge cases ---- */

test("a product with no publish record at all is 'Not published', never LIVE", () => {
  // Scenario 2: created but never published. The admin must not show a View link.
  assert.equal(resolvePublishState({
    latestPublishRef: null, buildStatus: "pending", liveVersion: null,
  }), "PUBLISHED");
});

test("a publish with pending status and no verification is PUBLISHED, not DEPLOYING", () => {
  // The snapshot exists but no rebuild has been requested. Not DEPLOYING because
  // nothing has been triggered yet.
  assert.equal(resolvePublishState({
    latestPublishRef: "pub_00000000000000000003", buildStatus: "pending", liveVersion: null,
  }), "PUBLISHED");
});

test("a publish that was requested but the storefront cannot be reached is DEPLOYING, not FAILED", () => {
  // The hook was accepted but verifyStorefront could not reach the edge.
  // LIVE is unknown, so the honest state is DEPLOYING, not a definitive failure.
  assert.equal(resolvePublishState({
    latestPublishRef: "pub_00000000000000000005", buildStatus: "triggered", liveVersion: null,
  }), "DEPLOYING");
});
test("the Worker reads the page it serves in-process, never its own public URL", async () => {
  await withFetch(async () => { throw new Error("must not fetch"); }, async () => {
    const html = '<meta name="storefront-publish-id" content="pub_00000000000000000009">';
    const ok = await verifyStorefront(env("https://shop.example"), "glow-serum", () => html);
    assert.equal(ok.liveVersion, "pub_00000000000000000009");
    assert.equal(ok.reason, null);
    const gone = await verifyStorefront(env(""), "gone", () => null);
    assert.equal(gone.liveVersion, null);
    assert.equal(gone.reason, "no-status");
  });
});
