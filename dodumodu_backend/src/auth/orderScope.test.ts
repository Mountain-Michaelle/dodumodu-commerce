import { test } from "node:test";
import assert from "node:assert/strict";
import { PgDialect } from "drizzle-orm/pg-core";
import { orderScope } from "./orderScope";
import type { Session } from "./session-lookup";

// A minimal Session: orderScope only reads role + email, so those are the
// only fields that matter here. The rest are padding to satisfy the type.
function sess(role: string, email: string): Session {
  return {
    userId: "u-1", email, role, sid: "s-1", deviceId: null, tier: "normal",
    perms: [], permsVersion: 1, needsTouch: false, idleSecs: 0, stepupOk: false,
    prefix: null, country: null, driftCount: 0,
  };
}

test("admin sees every order: unrestricted, allows() always true", () => {
  const s = orderScope(sess("admin", "boss@example.com"));
  assert.equal(s.restricted, false);
  assert.equal(s.sqlWhere(), undefined);
  assert.equal(s.allows("mono@example.com"), true);
  assert.equal(s.allows(null), true);
});

test("general sees every staff order: unrestricted, allows() always true", () => {
  const s = orderScope(sess("general", "gen@example.com"));
  assert.equal(s.restricted, false);
  assert.equal(s.sqlWhere(), undefined);
  assert.equal(s.allows("someone.else@example.com"), true);
  assert.equal(s.allows(null), true);
});

test("mono sees only orders assigned to self", () => {
  const s = orderScope(sess("mono", "mono@example.com"));
  assert.equal(s.restricted, true);
  assert.equal(s.allows("mono@example.com"), true, "own assignment is visible");
  assert.equal(s.allows("other@example.com"), false, "another operator's order is hidden");
  assert.equal(s.allows(null), false, "an unassigned order is hidden, not world-readable");
});

test("mono emits a non-empty SQL predicate that references the email", () => {
  const s = orderScope(sess("mono", "mono@example.com"));
  const where = s.sqlWhere();
  assert.ok(where, "mono must narrow the query with a WHERE predicate");
  // Compile through the PG dialect: it turns the drizzle SQL tree into a plain
  // { sql, params } pair with no database connection, so the assertion is
  // deterministic (and avoids JSON.stringify's circular-reference blow-up).
  const compiled = new PgDialect().sqlToQuery(where);
  assert.match(compiled.sql, /assigned_to/, "the predicate constrains assigned_to");
  assert.ok(
    compiled.params.includes("mono@example.com"),
    "the predicate pins the caller's own email",
  );
});

test("an unrecognized role fails closed (treated as mono, self-only)", () => {
  const s = orderScope(sess("superuser", "weird@example.com"));
  assert.equal(s.restricted, true, "unknown roles must not be unrestricted");
  assert.equal(s.allows("weird@example.com"), true, "self still allowed");
  assert.equal(s.allows("other@example.com"), false, "others still denied");
});
