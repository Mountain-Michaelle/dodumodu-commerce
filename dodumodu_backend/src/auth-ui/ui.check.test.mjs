// admin-auth v2 UI structural checks (no browser needed). Verifies:
//  - every getElementById target in the JS exists as an id in the HTML,
//  - no inline <script> (CSP script-src 'self' => external files only),
//  - the external script/stylesheet paths are the ones we ship.
// Run: node --test src/auth-ui/ui.check.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(join(here, f), "utf8");
const ids = (html) => new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
const referenced = (js) => new Set([...js.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]));

const pages = [
  { html: "login.html", js: "auth.js" },
  { html: "sessions.html", js: "sessions.js" },
  { html: "devices.html", js: "devices.js" },
];

test("every JS getElementById target exists in its HTML", () => {
  for (const p of pages) {
    const present = ids(read(p.html));
    for (const id of referenced(read(p.js))) {
      assert.ok(present.has(id), `${p.js} references #${id} missing from ${p.html}`);
    }
  }
});

test("no inline scripts or handlers (CSP script-src 'self')", () => {
  for (const p of pages) {
    const html = read(p.html);
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/, `${p.html} has an inline <script>`);
    assert.doesNotMatch(html, /\son\w+=/, `${p.html} has an inline event handler`);
  }
});

test("external asset paths are the shipped ones", () => {
  for (const p of pages) {
    const html = read(p.html);
    // adminPages.ts serves these under /admin/assets/* (login.html is additionally
    // run through /auth-ui/ -> /admin/assets/ at request time). The source files
    // already reference the shipped paths, so assert those.
    assert.match(html, /href="\/admin\/assets\/auth\.css"/, `${p.html} must link the shared stylesheet`);
    assert.match(html, new RegExp(`src="\/admin\/assets\/${p.js.replace(".", "\\.")}"`), `${p.html} must load ${p.js}`);
  }
});

test("autocomplete hints match the spec (one-time-code, passwords)", () => {
  const js = read("auth.js");
  assert.match(js, /one-time-code/, "emailed code + TOTP use one-time-code");
  assert.match(js, /current-password/, "phrase uses current-password");
  assert.match(js, /new-password/, "enrollment uses new-password");
});
