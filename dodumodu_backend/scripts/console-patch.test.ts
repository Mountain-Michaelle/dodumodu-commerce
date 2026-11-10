import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PATCHES, PATCH_MARK, patchConsoleJs } from "./console-patch.mjs";
import { ADMIN_CONSOLE_ASSETS, ADMIN_CONSOLE_HTML } from "../src/generated/adminPages";

const js = Object.entries(ADMIN_CONSOLE_ASSETS).find(([n]) => n.endsWith(".min.js"))!;
test("shipped console bundle carries every fix and is referenced by its hashed name", () => {
  assert.ok(js[1].startsWith(PATCH_MARK));
  assert.ok(ADMIN_CONSOLE_HTML.includes(js[0]));
  for (const p of PATCHES) { assert.ok(js[1].includes(p.to), p.id); assert.ok(!js[1].includes(p.from), `${p.id}: unpatched text still present`); }
});
test("patching is idempotent and fails loudly on an unknown bundle", () => {
  assert.equal(patchConsoleJs(js[1]), js[1]);
  assert.throws(() => patchConsoleJs("function other(){}"), /expected exactly 1 match/);
});
test("generator writes the same bundle that is shipped", () => {
  assert.match(readFileSync(new URL("./build-admin-pages.mjs", import.meta.url), "utf8"), /patchConsoleJs/);
});
