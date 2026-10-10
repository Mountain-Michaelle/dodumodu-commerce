import { test } from "node:test";
import assert from "node:assert/strict";
import { PgDialect } from "drizzle-orm/pg-core";
import { orders } from "../schema";
import { naiveUtc, updatedAtBucketBounds, updatedAtBucketCondition } from "./versionGuard";

/* The version guard compares a naive `timestamp without time zone` column
   against the version the browser was shown. It binds wall-clock strings, not
   Date parameters: node-postgres serialises a Date in process-local time and
   Postgres drops the offset on the naive column, which moved the bound hours
   away from the stored value and made every guarded admin write report a
   conflict. These pin the round trip the string binding depends on. */

test("a Date in, the stored naive-UTC shape out", () => {
  const { from, to } = updatedAtBucketBounds(new Date("2026-10-07T21:06:32.589Z"));
  assert.equal(from, "2026-10-07 21:06:32.589");
  assert.equal(to, "2026-10-07 21:06:32.590");
  assert.equal(naiveUtc(new Date(0)), "1970-01-01 00:00:00.000");
});

test("the bucket rolls over a second boundary", () => {
  const { from, to } = updatedAtBucketBounds(new Date("2026-10-07T21:06:32.999Z"));
  assert.equal(from, "2026-10-07 21:06:32.999");
  assert.equal(to, "2026-10-07 21:06:33.000");
});

test("the microsecond remainder of a stored value falls inside the bucket", () => {
  // The first half mirrors drizzle's read of the column (mapFromDriverValue
  // appends "+0000"), so this is the value the browser is actually shown.
  const stored = "2026-10-07 21:06:32.589423";
  const shownToBrowser = new Date(stored + "+0000");
  const { from, to } = updatedAtBucketBounds(shownToBrowser);
  assert.ok(stored >= from && stored < to, `${stored} must be inside [${from}, ${to})`);

  // A row that moved on lands outside the same bucket — that miss is the guard.
  const moved = "2026-10-07 21:06:32.700111";
  assert.ok(!(moved >= from && moved < to), `${moved} must be outside [${from}, ${to})`);
});

test("the condition binds naive strings, never Date parameters", () => {
  const cond = updatedAtBucketCondition(orders.updatedAt, new Date("2026-10-07T21:06:32.589Z"));
  // The dialect render is what actually reaches node-postgres: two naive
  // strings, never Dates (a Date parameter would be serialised in
  // process-local time and compared against the naive stored value).
  const query = new PgDialect().sqlToQuery(cond);
  assert.deepEqual(query.params, ["2026-10-07 21:06:32.589", "2026-10-07 21:06:32.590"]);
  assert.match(query.sql, /updated_at"\s*>=\s*\$\d+/);
  assert.match(query.sql, /updated_at"\s*<\s*\$\d+/);
});
