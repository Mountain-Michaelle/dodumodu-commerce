import { test } from "node:test";
import assert from "node:assert/strict";
import { isSchemaBehind } from "./schemaDrift";

test("recognises an undefined column by SQLSTATE, directly or under a Drizzle wrapper", () => {
  assert.equal(isSchemaBehind(Object.assign(new Error("x"), { code: "42703" })), true);
  assert.equal(isSchemaBehind(Object.assign(new Error("Failed query: select ..."), {
    cause: Object.assign(new Error('column "bot_check" does not exist'), { code: "42703" }),
  })), true);
  assert.equal(isSchemaBehind(Object.assign(new Error("x"), { code: "42P01" })), true);
});

test("recognises it by message when the driver drops the code", () => {
  assert.equal(isSchemaBehind(new Error('column "bot_check_enabled" of relation "products" does not exist')), true);
});

test("a wrapper whose query text mentions 'does not exist' is not enough on its own", () => {
  assert.equal(isSchemaBehind(new Error('Failed query: select 1 where "a" does not exist')), false);
});

test("other faults are not mistaken for it", () => {
  assert.equal(isSchemaBehind(new Error("connection reset")), false);
  assert.equal(isSchemaBehind(Object.assign(new Error("dup"), { code: "23505" })), false);
  assert.equal(isSchemaBehind(null), false);
  assert.equal(isSchemaBehind(undefined), false);
  const loop: { cause?: unknown } = {}; loop.cause = loop;
  assert.equal(isSchemaBehind(loop), false);
});
