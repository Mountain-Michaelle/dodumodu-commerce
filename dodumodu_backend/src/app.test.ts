import { test } from "node:test";
import assert from "node:assert/strict";
import { isOriginAllowed } from "./app";

// The allowlist is configuration (ALLOWED_ORIGINS), and the rule it encodes is
// security-relevant: the API takes customer details and returns order state, so
// "not listed" has to mean "no".

test("an exactly listed origin is allowed", () => {
  assert.equal(isOriginAllowed("https://yoursite.com", "https://yoursite.com"), true);
});

test("whitespace around a comma-separated list is ignored", () => {
  const list = "https://yoursite.com, https://shop.pages.dev ,http://localhost:8787";
  assert.equal(isOriginAllowed("https://yoursite.com", list), true);
  assert.equal(isOriginAllowed("https://shop.pages.dev", list), true);
  assert.equal(isOriginAllowed("http://localhost:8787", list), true);
});

test("an unlisted origin is refused", () => {
  assert.equal(isOriginAllowed("https://evil.example", "https://yoursite.com"), false);
  // A prefix of a listed origin must not pass.
  assert.equal(isOriginAllowed("https://yoursite.com.evil.example", "https://yoursite.com"), false);
  // Nor may a lookalike scheme.
  assert.equal(isOriginAllowed("http://yoursite.com", "https://yoursite.com"), false);
});

test("a wildcard entry covers subdomains only, never the bare domain", () => {
  const list = "*.pages.dev";
  assert.equal(isOriginAllowed("https://my-project.pages.dev", list), true);
  assert.equal(isOriginAllowed("https://a.b.pages.dev", list), true);
  assert.equal(isOriginAllowed("https://pages.dev", list), false);
  assert.equal(isOriginAllowed("https://evilpages.dev", list), false);
});

test("an empty or missing allowlist allows nothing", () => {
  assert.equal(isOriginAllowed("https://yoursite.com", ""), false);
  assert.equal(isOriginAllowed("https://yoursite.com", undefined), false);
  assert.equal(isOriginAllowed("", "https://yoursite.com"), false);
});