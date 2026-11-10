import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolvePrincipal, can, requirePermission, operatorAllowList,
  UnauthorizedError, ForbiddenError, PERMISSIONS,
} from "./adminAuth";

/* The authorization seam. These matter more than most unit tests, because this is
   the only thing standing between an unauthenticated request and the ability to
   mark an order paid. Nothing else in the admin re-checks identity: routes call
   resolvePrincipal's output and trust it, so if this is wrong every route is
   wrong in the same way. */

test("a request with no identity is refused, not treated as anonymous-but-allowed", () => {
  assert.throws(() => resolvePrincipal(undefined), UnauthorizedError);
  assert.throws(() => resolvePrincipal(""), UnauthorizedError);
  assert.throws(() => resolvePrincipal("   "), UnauthorizedError);
});

test("an authenticated operator is normalised and given the operator permissions", () => {
  const principal = resolvePrincipal("  Owner@Example.COM ");
  // Lowercased, so the audit trail and the allowlist cannot disagree about who
  // this is purely because of capitalisation.
  assert.equal(principal.email, "owner@example.com");
  assert.equal(can(principal, PERMISSIONS.ordersWrite), true);
  assert.equal(can(principal, PERMISSIONS.ordersPaymentOverride), true);
});

test("with an allowlist set, only the named operators get in", () => {
  const list = "owner@example.com, second@example.com";
  assert.equal(resolvePrincipal("owner@example.com", list).email, "owner@example.com");
  assert.equal(resolvePrincipal("OWNER@example.com", list).email, "owner@example.com");
  // Authenticated but not on the list: a refusal, not a missing identity. The two
  // are different problems for whoever is looking at the panel.
  assert.throws(() => resolvePrincipal("stranger@example.com", list), ForbiddenError);
});

test("an empty allowlist means any Access identity, which is correct for one owner", () => {
  assert.deepEqual(operatorAllowList(""), []);
  assert.deepEqual(operatorAllowList(undefined), []);
  assert.deepEqual(operatorAllowList("  a@b.com , , c@d.com "), ["a@b.com", "c@d.com"]);
  assert.equal(resolvePrincipal("anyone@example.com", "").email, "anyone@example.com");
});

test("a permission the principal does not hold throws rather than returning false", () => {
  // The reason requirePermission throws: a route that forgets to check the result
  // is then a route that permits everything. A silent false is the failure mode
  // this guards against.
  const principal = resolvePrincipal("owner@example.com");
  const limited = { ...principal, permissions: [PERMISSIONS.ordersRead] as const };
  assert.equal(can(limited, PERMISSIONS.ordersRead), true);
  assert.equal(can(limited, PERMISSIONS.ordersDelete), false);
  assert.throws(() => requirePermission(limited, PERMISSIONS.ordersDelete), ForbiddenError);
  assert.doesNotThrow(() => requirePermission(limited, PERMISSIONS.ordersRead));
});

test("the payment override is a distinct permission from moving a delivery", () => {
  // The separation is the whole point of §14/§15: an operator who may mark a
  // parcel delivered has not thereby been authorised to assert money arrived.
  const principal = resolvePrincipal("owner@example.com");
  assert.notEqual(PERMISSIONS.ordersWrite, PERMISSIONS.ordersPaymentOverride);
  const deliveryOnly = { ...principal, permissions: [PERMISSIONS.ordersWrite] as const };
  assert.equal(can(deliveryOnly, PERMISSIONS.ordersWrite), true);
  assert.equal(can(deliveryOnly, PERMISSIONS.ordersPaymentOverride), false);
});

test("deleting an order needs its own permission too", () => {
  const principal = resolvePrincipal("owner@example.com");
  const writer = { ...principal, permissions: [PERMISSIONS.ordersWrite] as const };
  assert.equal(can(writer, PERMISSIONS.ordersDelete), false);
  assert.throws(() => requirePermission(writer, PERMISSIONS.ordersDelete), ForbiddenError);
});

import { legacyPermissionsForRole } from "./adminAuth";
import { test as legacyTest } from "node:test";
import legacyAssert from "node:assert/strict";
legacyTest("legacy console permissions: admins hold every key, other roles none", () => {
  legacyAssert.ok(legacyPermissionsForRole("admin").includes("products:write"));
  legacyAssert.deepEqual(legacyPermissionsForRole("staff"), []);
  legacyAssert.deepEqual(legacyPermissionsForRole("general"), []);
});
