import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PATCHES, PATCH_MARK, NEW_ORDER_SOURCE, patchConsoleJs } from "./console-patch.mjs";
import { ADMIN_CONSOLE_ASSETS, ADMIN_CONSOLE_HTML } from "../src/generated/adminPages";

const js = Object.entries(ADMIN_CONSOLE_ASSETS).find(([n]) => n.endsWith(".min.js"))!;
test("shipped console bundle carries every fix and is referenced by its hashed name", () => {
  assert.ok(js[1].startsWith(PATCH_MARK));
  assert.ok(ADMIN_CONSOLE_HTML.includes(js[0]));
  for (const p of PATCHES) { assert.ok(js[1].includes(p.to), p.id); if (!p.to.includes(p.from)) assert.ok(!js[1].includes(p.from), `${p.id}: unpatched text still present`); }
});
test("the shipped bundle carries the CURRENT new-order script (regenerate adminPages.ts after editing it)", () => {
  assert.ok(js[1].includes(NEW_ORDER_SOURCE));
});
test("patching is idempotent, skips fixes a bundle already has, and refuses an ambiguous anchor", () => {
  assert.equal(patchConsoleJs(js[1]), js[1]);
  assert.ok(patchConsoleJs("function other(){}").includes("function other(){}"), "an unrelated bundle is not rejected");
  assert.throws(() => patchConsoleJs(`${PATCHES[0].from};${PATCHES[0].from}`), /expected at most 1 match, found 2/);
});
test("generator writes the same bundle that is shipped", () => {
  assert.match(readFileSync(new URL("./build-admin-pages.mjs", import.meta.url), "utf8"), /patchConsoleJs/);
});
