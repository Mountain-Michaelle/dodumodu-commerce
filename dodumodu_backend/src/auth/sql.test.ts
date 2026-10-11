import { test } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { q, q1 } from "./sql";
import {
  AuthRejectError,
  AuthLockedError,
  AuthServerFaultError,
  AuthUnauthorizedError,
  AuthForbiddenError,
} from "./errors";

// The row normalizer must accept BOTH driver shapes. node-postgres returns
// { rows }, neon-http returns the array directly. A regression here silently
// breaks the Worker while the Node suite stays green — so it is pinned here.
function dbReturning(res: unknown) {
  return { execute: async () => res } as unknown as Parameters<typeof q>[0];
}

test("q reads .rows from a node-postgres QueryResult", async () => {
  const rows = await q(dbReturning({ rows: [{ a: 1 }, { a: 2 }] }), sql`select 1`);
  assert.deepEqual(rows, [{ a: 1 }, { a: 2 }]);
});

test("q reads a neon-http array result directly", async () => {
  const rows = await q(dbReturning([{ a: 1 }, { a: 2 }]), sql`select 1`);
  assert.deepEqual(rows, [{ a: 1 }, { a: 2 }]);
});

test("q returns [] for an empty result and for unexpected shapes", async () => {
  assert.deepEqual(await q(dbReturning({ rows: [] }), sql`x`), []);
  assert.deepEqual(await q(dbReturning([]), sql`x`), []);
  assert.deepEqual(await q(dbReturning(null), sql`x`), []);
  assert.deepEqual(await q(dbReturning({ command: "UPDATE" }), sql`x`), []);
});

test("q1 returns the first row or null", async () => {
  assert.deepEqual(await q1(dbReturning({ rows: [{ a: 1 }, { a: 2 }] }), sql`x`), { a: 1 });
  assert.equal(await q1(dbReturning({ rows: [] }), sql`x`), null);
});

test("AuthRejectError carries an audit reason but a neutral message", () => {
  const e = new AuthRejectError("wrong_phrase");
  assert.equal(e.reason, "wrong_phrase");
  assert.equal(e.message, "Invalid or expired code");
  assert.equal(e.name, "AuthRejectError");
});

test("AuthLockedError carries the retry countdown", () => {
  assert.equal(new AuthLockedError(42).retryAfterSecs, 42);
});

test("AuthServerFaultError preserves the cause", () => {
  const cause = new Error("db down");
  assert.equal(new AuthServerFaultError(cause).cause, cause);
  assert.equal(new AuthServerFaultError().cause, undefined);
});

test("authz errors have the expected names", () => {
  assert.equal(new AuthUnauthorizedError().name, "AuthUnauthorizedError");
  assert.equal(new AuthForbiddenError().name, "AuthForbiddenError");
});
