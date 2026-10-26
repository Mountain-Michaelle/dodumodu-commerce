import { test } from "node:test";
import assert from "node:assert/strict";
import { app } from "./app";
import * as site from "./generated/site";
import { robotsTxt, sitemapXml } from "./staticAssets";

function mockBucket(objects: Record<string, { body: unknown; httpMetadata?: { contentType?: string; cacheControl?: string } }>) {
  return {
    async get(key: string) {
      const obj = objects[key];
      if (!obj) return null;
      return { body: obj.body, httpMetadata: obj.httpMetadata };
    },
  } as unknown as R2Bucket;
}

const env = {
  SITE_URL: "https://yoursite.com",
  MEDIA_BUCKET: mockBucket({
    "uploads/hero.jpg": {
      body: new Uint8Array([1, 2, 3]),
      httpMetadata: { contentType: "image/jpeg", cacheControl: "public, max-age=31536000" },
    },
    "uploads/test.webp": {
      body: new Uint8Array([4, 5, 6]),
      httpMetadata: { contentType: "image/webp" },
    },
  }),
} as never;

async function fetchApp(path: string, init: RequestInit = {}) {
  return app.fetch(new Request(`https://yoursite.com${path}`, init), env as never);
}

test("APP_JS_PATH serves the bundle with javascript content type and immutable cache", async () => {
  const res = await fetchApp(site.APP_JS_PATH);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Content-Type"), "application/javascript; charset=utf-8");
  assert.equal(res.headers.get("Cache-Control"), "public, max-age=31536000, immutable");
  const body = await res.text();
  assert.equal(body, site.APP_JS);
});

test("thank-you.html returns the order confirmation page", async () => {
  const res = await fetchApp("/thank-you.html");
  assert.equal(res.status, 200);
  assert.ok(res.headers.get("Content-Type")!.startsWith("text/html"));
  assert.equal(res.headers.get("Cache-Control"), "no-cache");
  const body = await res.text();
  assert.ok(body.includes("We've received your order"));
  assert.ok(body.includes("/products/glow-serum/"));
});

test("robots.txt returns plain text with sitemap URL", async () => {
  const res = await fetchApp("/robots.txt");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Content-Type"), "text/plain; charset=utf-8");
  assert.equal(res.headers.get("Cache-Control"), "public, max-age=3600");
  const body = await res.text();
  assert.ok(body.includes("User-agent: *"));
  assert.ok(body.includes("Disallow: /admin/"));
  assert.ok(body.includes("Sitemap: https://yoursite.com/sitemap.xml"));
});

test("sitemap.xml returns XML listing root and any published products", async () => {
  const res = await fetchApp("/sitemap.xml");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Content-Type"), "application/xml; charset=utf-8");
  assert.equal(res.headers.get("Cache-Control"), "public, max-age=3600");
  const body = await res.text();
  assert.ok(body.includes("<urlset"));
  // Root URL is always listed, even with an empty catalog.
  assert.ok(body.includes(`<loc>https://yoursite.com/</loc>`));
  // glow-serum is listed only when the generated site data contains it.
  const products = JSON.parse((await import("./generated/site")).PRODUCTS ?? "{}");
  if (products["glow-serum"]) {
    assert.ok(body.includes(`<loc>https://yoursite.com/glow-serum/</loc>`));
  }
});

test("robotsTxt helper produces correct content", () => {
  const body = robotsTxt("https://yoursite.com");
  assert.ok(body.includes("Sitemap: https://yoursite.com/sitemap.xml"));
  assert.ok(body.includes("Disallow: /thank-you.html"));
  const local = robotsTxt("");
  assert.ok(!local.includes("Sitemap:"));
});

test("sitemapXml helper produces correct content", () => {
  const body = sitemapXml("https://yoursite.com", { "glow-serum": {} });
  assert.ok(body.includes(`<loc>https://yoursite.com/</loc>`));
  assert.ok(body.includes(`<loc>https://yoursite.com/glow-serum/</loc>`));
});

test("sitemapXml with empty products lists only the root URL", () => {
  const body = sitemapXml("https://yoursite.com", {});
  assert.ok(body.includes("<urlset"));
  assert.ok(body.includes(`<loc>https://yoursite.com/</loc>`));
  assert.ok(!body.includes("/glow-serum/"));
  assert.equal(
    (body.match(/<loc>/g) ?? []).length,
    1,
    "only the root URL is listed"
  );
});

test("media serves known object with content type and cache headers", async () => {
  const res = await fetchApp("/media/uploads/hero.jpg");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Content-Type"), "image/jpeg");
  assert.equal(res.headers.get("Cache-Control"), "public, max-age=31536000");
  const body = await res.arrayBuffer();
  assert.deepEqual([...new Uint8Array(body)], [1, 2, 3]);
});

test("media serves object with content type but no cache control defaults to no-cache", async () => {
  const res = await fetchApp("/media/uploads/test.webp");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Content-Type"), "image/webp");
  assert.equal(res.headers.get("Cache-Control"), "no-cache");
});

test("media returns 404 for missing object", async () => {
  const res = await fetchApp("/media/uploads/missing.jpg");
  assert.equal(res.status, 404);
});

test("media rejects path traversal", async () => {
  const res = await fetchApp("/media/../etc/passwd");
  assert.equal(res.status, 404);
});

test("media rejects malformed encoding", async () => {
  const res = await fetchApp("/media/%80invalid");
  assert.equal(res.status, 404);
});

test("media rejects absolute path keys", async () => {
  const res = await fetchApp("/media//etc/passwd");
  assert.equal(res.status, 404);
});

test("existing reserved routes still take precedence over /:slug", async () => {
  const res = await fetchApp("/health");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean };
  assert.equal(body.ok, true);
});

test("unknown slug returns 404", async () => {
  const res = await fetchApp("/nonexistent-slug");
  assert.equal(res.status, 404);
});
