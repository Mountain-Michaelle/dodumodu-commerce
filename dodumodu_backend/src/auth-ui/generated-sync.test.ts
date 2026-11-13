// What the Worker SERVES is src/generated/adminPages.ts, built from src/auth-ui/*. Editing a page without
// regenerating it ships the OLD page, so the two must match byte for byte. Fix a failure with:
//   npx tsx scripts/build-admin-pages.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as gen from "../generated/adminPages";
import { minifyJs, minifyCss } from "../../scripts/minify-assets.mjs";

const src = (f: string) => readFileSync(join(process.cwd(), "src/auth-ui", f), "utf8");
const g = gen as unknown as Record<string, string>;

test("served scripts and stylesheet are exactly the sources", () => {
  const pairs: Array<[string, string]> = [
    ["ADMIN_AUTH_CSS", "auth.css"], ["ADMIN_SESSIONS_JS", "sessions.js"], ["ADMIN_DEVICES_JS", "devices.js"],
    ["ADMIN_UI_JS", "admin-ui.js"], ["ADMIN_DEVICE_ACCEPT_JS", "device-accept.js"],
  ];
  // What is served is the minified form of the source (comments, banners and readable names removed).
  for (const [name, file] of pairs) {
    const expected = file.endsWith(".css") ? minifyCss(src(file)) : minifyJs(src(file));
    assert.equal(g[name], expected, `${name} is stale: run scripts/build-admin-pages.mjs`);
  }
});

test("served pages load the shared helper and the right page script", () => {
  for (const [name, page] of [["ADMIN_SESSIONS_HTML", "sessions"], ["ADMIN_DEVICES_HTML", "devices"]] as const) {
    const html = g[name];
    assert.ok(html.includes("/admin/assets/admin-ui.js"), `${name} loads admin-ui.js`);
    assert.ok(html.includes(`/admin/assets/${page}.js`), `${name} loads ${page}.js`);
  }
  assert.ok(g.ADMIN_DEVICE_ACCEPT_HTML.includes("/admin/assets/device-accept.js"));
});
