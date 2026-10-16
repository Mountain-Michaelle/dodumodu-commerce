// Committed coverage for the createsuperuser CLI grammar (spec §13 bootstrap).
// Pure — no database. Run by `npm test` (scripts glob added to the test script).
import test from "node:test";
import assert from "node:assert/strict";
import { parseSuperuserArgs } from "./superuser.js";

test("accepts one email, lowercased/trimmed", () => {
  assert.deepEqual(parseSuperuserArgs(["Admin@Example.com"]), { email: "admin@example.com", username: undefined });
});

test("accepts an explicit valid username", () => {
  assert.deepEqual(parseSuperuserArgs(["a@b.com", "--username=ops.lead_1"]), { email: "a@b.com", username: "ops.lead_1" });
});

test("rejects zero args", () => {
  assert.throws(() => parseSuperuserArgs([]), /Usage/);
});

test("rejects extra positional args", () => {
  assert.throws(() => parseSuperuserArgs(["a@b.com", "c@d.com"]), /exactly one email/);
});

test("rejects an invalid email", () => {
  assert.throws(() => parseSuperuserArgs(["notanemail"]), /Invalid email/);
  assert.throws(() => parseSuperuserArgs(["owner@example..com"]), /Invalid email/);
});

test("rejects unknown flags", () => {
  assert.throws(() => parseSuperuserArgs(["a@b.com", "--verbose"]), /Unknown flag/);
});

test("rejects duplicate and empty --username", () => {
  assert.throws(() => parseSuperuserArgs(["a@b.com", "--username=x", "--username=y"]), /Duplicate/);
  assert.throws(() => parseSuperuserArgs(["a@b.com", "--username="]), /must not be empty/);
});

test("rejects a malformed username", () => {
  assert.throws(() => parseSuperuserArgs(["a@b.com", "--username=BAD!"]), /username must match/);
  assert.throws(() => parseSuperuserArgs(["a@b.com", "--username=ab"]), /username must match/);
});
