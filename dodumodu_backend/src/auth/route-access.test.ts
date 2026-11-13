import { test } from "node:test";
import assert from "node:assert/strict";
import { adminRoute } from "../routes/admin";
import { ROUTE_RULES, requiredKey, mayCall, legacyFromGrants } from "./route-access";
import { REGISTRY } from "./registry";

// Routes that are deliberately ADMIN-ONLY (no rule). Adding a route to the admin API fails the coverage test
// below until it is either given a rule (a registry key an admin can grant) or listed here on purpose.
const ADMIN_ONLY = new Set([
  // pages (the console shell itself is admitted for every signed-in operator in admin.ts; the rest are admin pages)
  "GET /", "GET /sessions", "GET /sessions/", "GET /users", "GET /users/",
  // order actions that change ownership, cancel, delete or override
  "POST /orders/bulk-action", "POST /orders/1/assign", "POST /orders/1/unassign", "POST /orders/1/cancel",
  "POST /orders/1/revert-cancel", "POST /orders/1/mark-not-picking", "POST /orders/1/revert-not-picking",
  "DELETE /orders/1", "PATCH /orders/1/status",
  "POST /categories/bulk-action", "DELETE /media",
  // site-wide settings and moderation
  "GET /blocks", "GET /blocks/history", "POST /blocks", "POST /blocks/1/release",
  // blocking and flagging are administrator decisions, never grantable
  "POST /spam/flag", "POST /spam/1/revert",
  "GET /abuse/summary", "GET /abuse/held", "POST /abuse/held/1/release", "POST /abuse/held/1/dismiss",
  "GET /abuse/rpf", "POST /abuse/rpf/1/block", "POST /abuse/rpf/1/dismiss",
  "GET /discount-tiers", "PUT /discount-tiers", "GET /payment-rules", "PUT /payment-rules",
  // anything that publishes or deploys the storefront
  "POST /products/1/publish", "GET /products/1/status", "POST /products/1/redeploy", "GET /products/1/publishes",
  "POST /deploy-trigger", "POST /builds/1/mark-deployed", "POST /builds/1/mark-verified", "POST /builds/1/mark-failed", "POST /builds/1/pre-deploy",
]);

function concrete(path: string) { return path.replace(/:[A-Za-z]+\??/g, "1"); }

test("every key in the access table is a real registry key", () => {
  const keys = new Set(REGISTRY.map((r) => r.key));
  for (const r of ROUTE_RULES) if (r.need !== "*") assert.ok(keys.has(r.need), `${r.method} ${r.path}: unknown key ${r.need}`);
});

test("every admin API route has been decided: a rule an admin can grant, or admin-only on purpose", () => {
  const undecided: string[] = [];
  for (const r of adminRoute.routes) {
    if (r.method === "ALL") continue;
    const path = concrete(r.path);
    if (/^\/(assets|sign-in|device|auth|admin-v2)/.test(path)) continue;   // pages/assets/other namespaces, not console data
    if (requiredKey(r.method, path) !== null) continue;
    const label = `${r.method} ${path}`;
    if (ADMIN_ONLY.has(label)) continue;
    undecided.push(label);
  }
  assert.deepEqual(undecided, [], "give each a rule in route-access.ts, or add it to ADMIN_ONLY here");
});
test("nothing on the admin-only list has quietly gained a rule", () => {
  for (const label of ADMIN_ONLY) { const [m, p] = label.split(" "); assert.equal(requiredKey(m, p), null, label); }
});

test("a rule's method and path decide it: wrong method, extra segments and other resources do not match", () => {
  assert.equal(requiredKey("GET", "/4ehhi/orders"), "orders.view");
  assert.equal(requiredKey("POST", "/orders"), null);
  assert.equal(requiredKey("GET", "/orders/1/cancel"), null);
  assert.equal(requiredKey("DELETE", "/orders/1"), null, "deleting an order is admin-only");
  assert.equal(requiredKey("GET", "/orders/"), "orders.view", "a trailing slash is the same route");
  assert.equal(requiredKey("GET", "/discount-tiers"), null);
});

test("mayCall: admin always; others only with the key the rule names", () => {
  assert.equal(mayCall("admin", [], "DELETE", "/orders/1"), true);
  assert.equal(mayCall("mono", ["orders.view"], "GET", "/orders"), true);
  assert.equal(mayCall("mono", [], "GET", "/orders"), false);
  assert.equal(mayCall("mono", ["orders.view"], "GET", "/products"), false);
  assert.equal(mayCall("mono", [], "GET", "/me"), true);
  assert.equal(mayCall("general", ["categories.view"], "GET", "/categories/tree"), true);
  assert.equal(mayCall("general", ["settings.manage"], "GET", "/discount-tiers"), false, "no rule = admin only, whatever is granted");
  assert.equal(mayCall("staff", ["orders.view"], "GET", "/orders"), false, "an unknown legacy role holds nothing");
});

test("legacy capabilities derive from grants: write needs add/change/delete, never just view", () => {
  assert.deepEqual(legacyFromGrants("general", ["categories.view"]), ["categories:read"]);
  assert.ok(legacyFromGrants("general", ["categories.view", "categories.add"]).includes("categories:write"));
  assert.deepEqual(legacyFromGrants("mono", []), []);
  assert.ok(legacyFromGrants("admin", []).includes("settings:write"));
});
