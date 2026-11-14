import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { productPageHandler } from "./productPage";

const products = { "glow-serum": { html: "<html>serum</html>", etag: '"e1"', publishId: 1, publishRef: "pub_00000000000000000001" } };
const app = new Hono();
const handler = productPageHandler(() => products);
app.get("/:slug", handler);
app.get("/:slug/", handler);

test("a product page is served with AND without the trailing slash", async () => {
  for (const path of ["/glow-serum", "/glow-serum/"]) {
    const res = await app.request(path);
    assert.equal(res.status, 200, path);
    assert.equal(await res.text(), "<html>serum</html>");
  }
});

test("an unknown slug is a 404 either way, and a matching ETag is a 304", async () => {
  assert.equal((await app.request("/nope/")).status, 404);
  assert.equal((await app.request("/nope")).status, 404);
  assert.equal((await app.request("/glow-serum/", { headers: { "If-None-Match": '"e1"' } })).status, 304);
});
