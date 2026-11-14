import { test } from "node:test";
import assert from "node:assert/strict";
import { renderEmptyCatalog, extractPageParts, buildCsp } from "./build-site.mjs";

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


const builtPage = [
  '<!doctype html><html><head>',
  '<script type="application/ld+json">{"a":1}</script>',
  '<script>window.API_BASE="https://api.example.com",window.IMAGE_DELIVERY_BASE="https://media.example.com";</script>',
  '</head><body><svg class="dm-defs" width="0"></svg><svg id="icons"></svg><a href="#order-form" class="skip-link">Skip</a>',
  '<div class="cf-turnstile" data-sitekey="0xSITEKEY" data-callback="cb"></div>',
  '<script>(function(){var form=1})()</script><script>(function(){var stick=1})()</script>',
  '<script src="/site.js" defer></script></body></html>',
].join("");

test("extractPageParts takes the sprite, runtime config and inline scripts from the built page", () => {
  const parts = extractPageParts(builtPage);
  assert.equal(parts.sprite, '<svg class="dm-defs" width="0"></svg><svg id="icons"></svg>');
  assert.equal(parts.runtimeConfig, '<script>window.API_BASE="https://api.example.com",window.IMAGE_DELIVERY_BASE="https://media.example.com";</script>');
  // the form and sticky scripts, in order; not the JSON-LD, not the runtime config, not the external bundle
  assert.equal(parts.inlineScripts, "<script>(function(){var form=1})()</script><script>(function(){var stick=1})()</script>");
  assert.equal(parts.turnstileSiteKey, "0xSITEKEY");
  assert.equal(parts.apiBase, "https://api.example.com");
  assert.equal(parts.imageDeliveryBase, "https://media.example.com");
});

test("extractPageParts refuses a page missing something published pages need", () => {
  assert.throws(() => extractPageParts(builtPage.replace(/<script>window\.API_BASE[^<]*<\/script>/, "")), /runtime config/);
  assert.throws(() => extractPageParts(builtPage.replace('<svg class="dm-defs"', '<svg class="other"')), /sprite/);
  assert.throws(() => extractPageParts(builtPage.replace(/<script>\(function[^<]*<\/script>/g, "")), /inline scripts/);
});

test("buildCsp is strict by default and allows only what the page really loads", () => {
  const base = { scriptHashes: ["'sha256-a'"], styleHashes: ["'sha256-b'"] };
  const plain = buildCsp(base);
  assert.match(plain, /^default-src 'none'; script-src 'self' 'sha256-a'; style-src 'sha256-b'; img-src 'self' data:; connect-src 'self'; base-uri 'none'/);
  assert.ok(!plain.includes("challenges.cloudflare.com") && !plain.includes("frame-src"));
});

test("buildCsp lets Turnstile and an off-origin image host load, and nothing else", () => {
  const csp = buildCsp({
    scriptHashes: ["'sha256-a'"],
    styleHashes: ["'sha256-b'"],
    imgOrigins: ["https://media.example.com"],
    connectOrigins: ["https://api.example.com"],
    turnstile: true,
  });
  assert.match(csp, /script-src 'self' 'sha256-a' https:\/\/challenges\.cloudflare\.com;/);
  assert.match(csp, /frame-src https:\/\/challenges\.cloudflare\.com;/);
  assert.match(csp, /img-src 'self' data: https:\/\/media\.example\.com;/);
  assert.match(csp, /connect-src 'self' https:\/\/api\.example\.com;/);
  assert.match(csp, /default-src 'none'/);
});
