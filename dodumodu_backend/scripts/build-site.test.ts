import { test } from "node:test";
import assert from "node:assert/strict";
import { renderEmptyCatalog } from "./build-site.mjs";

test("renderEmptyCatalog produces valid HTML with no product data", () => {
  const css = "body{color:red}";
  const jsPath = "/site.abc123.min.js";
  const csp = "default-src 'none'; script-src 'self' 'sha256-abc'";
  const buildId = "build_123";

  const html = renderEmptyCatalog({ css, jsPath, csp, buildId });

  assert.ok(html.includes("<!doctype html>"));
  assert.ok(html.includes("<title>Storefront — DODUMODU</title>"));
  assert.ok(html.includes("No products are published yet."));
  assert.ok(html.includes(`<style>${css}</style>`));
  assert.ok(html.includes(`<script src="site.abc123.min.js" defer></script>`));
  assert.ok(
    html.includes(
      `<meta http-equiv="Content-Security-Policy" content="${csp}">`
    )
  );
  assert.ok(html.includes('<meta name="robots" content="noindex">'));
  // No product name, price, or publish id is fabricated.
  assert.ok(!html.includes("Radiance Glow Serum"));
  assert.ok(!html.includes("pub_"));
  // No unreplaced template slots.
  assert.ok(!html.match(/\{\{[A-Z_]+\}\}/));
});

test("renderEmptyCatalog strips leading slash from jsPath", () => {
  const html = renderEmptyCatalog({
    css: "",
    jsPath: "/site.js",
    csp: "default-src 'none'",
    buildId: "b",
  });
  assert.ok(html.includes('<script src="site.js" defer></script>'));
  assert.ok(!html.includes('<script src="/site.js"'));
});

test("renderEmptyCatalog output is well-formed HTML", () => {
  const html = renderEmptyCatalog({
    css: "a{}",
    jsPath: "/app.xyz.js",
    csp: "default-src 'self'",
    buildId: "build_1",
  });
  assert.equal(
    html.match(/<html/g)?.length,
    1,
    "exactly one opening html tag"
  );
  assert.equal(
    html.match(/<\/html>/g)?.length,
    1,
    "exactly one closing html tag"
  );
  assert.equal(
    html.match(/<head>/g)?.length,
    1,
    "exactly one opening head tag"
  );
  assert.equal(
    html.match(/<\/head>/g)?.length,
    1,
    "exactly one closing head tag"
  );
  assert.equal(
    html.match(/<body>/g)?.length,
    1,
    "exactly one opening body tag"
  );
  assert.equal(
    html.match(/<\/body>/g)?.length,
    1,
    "exactly one closing body tag"
  );
});
