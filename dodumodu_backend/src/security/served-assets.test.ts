import { test } from "node:test";
import assert from "node:assert/strict";
import { assetProblems } from "../../scripts/check-assets.mjs";

test("nothing the admin serves to a browser carries a secret, a source note, a path or readable comments", async () => {
  assert.deepEqual(await assetProblems(), []);
});
