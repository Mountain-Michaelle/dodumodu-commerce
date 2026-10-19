// The permission registry, tested as pure logic — no database, no HTTP. These
// are the rules the guard() middleware reads, so a bug here is an access-control
// bug. Each test names the security property it pins down.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  REGISTRY, registryGet, registryKeys, effectivePerms, cascadeOnRevoke,
  presetForRole, permForAction, STAFF_ROLES_LIST,
} from "./registry";
import { authRoute, adminRoute } from "./routes";

test("registryGet returns a known entry and undefined for an unknown key", () => {
  const view = registryGet("orders.view");
  assert.ok(view, "orders.view exists");
  assert.equal(view.type, "section");
  assert.equal(view.group, "orders");
  assert.equal(view.scoped, true, "orders are row-scoped");
  // Fail-closed: an unknown key is never an effective permission.
  assert.equal(registryGet("orders.nope"), undefined);
  assert.equal(registryGet(""), undefined);
});

test("no bare orders.status wildcard — one key per grantable target", () => {
  // The whole point of the per-status design: an alias like `orders.status`
  // could silently broaden access. It must never exist.
  assert.equal(registryGet("orders.status"), undefined);
  const statusKeys = registryKeys().filter((k) => k.startsWith("orders.status."));
  assert.deepEqual(statusKeys.sort(), [
    "orders.status.delivered",
    "orders.status.failed",
    "orders.status.paid",
  ], "only the three grantable targets get a key");
});

test("every require is itself a registered key (no dangling dependency)", () => {
  const keys = new Set(registryKeys());
  for (const e of REGISTRY) {
    for (const req of e.requires) {
      assert.ok(keys.has(req), `${e.key} requires ${req}, which is not registered`);
    }
  }
});

test("effectivePerms: an admin implicitly holds every key", () => {
  const admin = effectivePerms("admin", []);
  assert.deepEqual([...admin].sort(), registryKeys().sort());
  // Even with junk grants, an admin still holds all — grants never subtract.
  assert.deepEqual([...effectivePerms("admin", ["bogus"])].sort(), registryKeys().sort());
});

test("effectivePerms: a staff member never gets an adminOnly key", () => {
  // orders.assign is adminOnly. Handing it to a mono user in grants must not
  // make it effective — the server enforces adminOnly from THIS table.
  const perms = effectivePerms("mono", ["orders.view", "orders.assign", "users.manage"]);
  assert.ok(!perms.includes("orders.assign"), "adminOnly key is dropped for staff");
  assert.ok(!perms.includes("users.manage"), "another adminOnly key is dropped");
  assert.ok(perms.includes("orders.view"), "the plain section survives");
});

test("effectivePerms: a grant the role is not allowed is never effective", () => {
  // products.* is roles:[admin,general] — a mono user can't hold it.
  const perms = effectivePerms("mono", ["products.view", "orders.view"]);
  assert.ok(!perms.includes("products.view"), "role-disallowed key is dropped");
  assert.ok(perms.includes("orders.view"));
  // A general user, by contrast, may.
  assert.ok(effectivePerms("general", ["products.view"]).includes("products.view"));
});

test("effectivePerms: a privilege whose section was revoked is dropped", () => {
  // orders.change requires orders.view. Grant the privilege but not its
  // section: the dependency is enforced, so the privilege cannot stand alone.
  const perms = effectivePerms("general", ["orders.change"]);
  assert.ok(!perms.includes("orders.change"), "privilege dropped when its section is missing");
  // With the section present, both stand.
  const withSection = effectivePerms("general", ["orders.view", "orders.change"]);
  assert.ok(withSection.includes("orders.view") && withSection.includes("orders.change"));
});

test("effectivePerms: unknown and malformed grants are ignored, never effective", () => {
  const perms = effectivePerms("general", ["totally-made-up", "orders.view", ""]);
  assert.deepEqual(perms, ["orders.view"]);
});

test("cascadeOnRevoke: revoking a section removes everything that depends on it", () => {
  // A general user holding orders.view + its dependents. Revoking orders.view
  // must cascade to every privilege whose requires chain reaches it.
  const held = ["orders.view", "orders.change", "orders.export", "orders.assign", "reports.view"];
  const removed = cascadeOnRevoke(held, "orders.view").sort();
  assert.ok(removed.includes("orders.view"), "the revoked key itself is reported");
  for (const dep of ["orders.change", "orders.export", "orders.assign"]) {
    assert.ok(removed.includes(dep), `${dep} cascades from orders.view`);
  }
  assert.ok(!removed.includes("reports.view"), "an unrelated section is untouched");
});

test("cascadeOnRevoke: revoking a leaf leaves its section in place", () => {
  const held = ["orders.view", "orders.change", "reports.view"];
  const removed = cascadeOnRevoke(held, "orders.change").sort();
  assert.deepEqual(removed, ["orders.change"], "only the leaf is removed");
});

test("presetForRole: admin = every key; staff presets stay inside their rights", () => {
  assert.deepEqual(presetForRole("admin"), registryKeys());
  const general = presetForRole("general");
  const mono = presetForRole("mono");
  // general is a strict superset of mono (the documented "+" relationship).
  for (const k of mono) assert.ok(general.includes(k), `general includes ${k}`);
  assert.ok(general.includes("orders.export") && general.includes("orders.filter_staff"));
  assert.ok(!mono.includes("orders.export"), "mono does not get export");
  // No staff preset ever carries an adminOnly key.
  for (const k of [...general, ...mono]) {
    assert.ok(!registryGet(k)!.adminOnly, `preset must not contain adminOnly ${k}`);
  }
});

test("permForAction: a verb maps to its target status privilege", () => {
  assert.equal(permForAction("deliver"), "orders.status.delivered");
  assert.equal(permForAction("revert"), "orders.status.delivered", "revert shares the target key");
  assert.equal(permForAction("mark-paid"), "orders.status.paid");
  assert.equal(permForAction("mark-failed"), "orders.status.failed");
  // Reserved targets: cancel / not-picking have NO grantable key, so the v2
  // route's admin-only fallback (authorizeTransition) is what guards them.
  assert.equal(permForAction("cancel"), "orders.status.cancelled");
  assert.equal(permForAction("mark-not-picking"), "orders.status.not_picking");
  assert.equal(registryGet(permForAction("cancel")), undefined);
  assert.equal(registryGet(permForAction("mark-not-picking")), undefined);
});

test("STAFF_ROLES_LIST is exactly the two staff roles", () => {
  assert.deepEqual([...STAFF_ROLES_LIST], ["mono", "general"]);
});

// Coverage check — currentwork.md §AUTHORIZATION: "boot/test fails if any
// /admin-v2 or protected /auth route lacks registry entry + guard()."
//
// This test IS that check. It enumerates the routes ACTUALLY registered on the
// two exported routers (so a newly added route cannot silently slip past it) and
// asserts:
//   1. every /admin-v2 route carries a guard, unless it is on a short, reasoned
//      exception list — the admin surface is meant to be fully guarded;
//   2. the session-requiring /auth routes carry a session guard;
//   3. every permission a guard() references is a real registry key (a typo
//      would otherwise only fail closed at runtime, never at build time).

// Substrings that prove a handler authorizes the caller. guard() is the v2
// decision tree; requireAdmin/requireStepUp/requireSession are the session-based
// guards; authorizeTransition wraps guard() for order status transitions.
const GUARD_TOKENS = [
  "guard(",
  "requireAdmin(",
  "requireStepUp(",
  "requireSession(",
  "requirePerm(",
  "authorizeTransition(",
];

// /admin-v2 routes intentionally NOT behind a session/permission guard. Each
// entry states the specific, self-contained reason it is safe. Everything else
// on the admin surface MUST carry a guard.
const ADMIN_EXCEPTIONS: Record<string, string> = {
  // Internal cron: authenticated by a shared RECONCILE_CRON_SECRET (404 without
  // it), never by a browser session.
  "POST /internal/cleanup": "cron-secret authenticated, not a browser session",
};

// The /auth routes that REQUIRE an existing session. The login/recovery flow is
// deliberately pre-auth (you have no session yet), so it is not listed here —
// this is the positive set of session-protected endpoints, each pinned to its
// guard so a removed guard is caught.
const SESSION_PROTECTED_AUTH = [
  "GET /me",
  "GET /sessions",
  "DELETE /sessions/:sid",
  "POST /sessions/revoke-others",
  "POST /backup-codes/regenerate",
  "POST /stepup",
];

function src(handler: unknown): string {
  return String(handler);
}

function isGuarded(handler: unknown): boolean {
  const body = src(handler);
  return GUARD_TOKENS.some((t) => body.includes(t));
}

test("every /admin-v2 route is guarded or a documented exception", () => {
  let checked = 0;
  for (const r of adminRoute.routes) {
    if (r.method === "ALL") continue; // the use("*") middleware, not a route
    const key = `${r.method} ${r.path}`;
    if (key in ADMIN_EXCEPTIONS) continue;
    checked++;
    assert.ok(
      isGuarded(r.handler),
      `${key} has no guard — add one, or document why it is safe in ADMIN_EXCEPTIONS`,
    );
  }
  assert.ok(checked > 0, "expected to find guarded admin routes");
});

test("every session-protected /auth route carries a session guard", () => {
  const byKey = new Map(authRoute.routes.map((r) => [`${r.method} ${r.path}`, r]));
  for (const key of SESSION_PROTECTED_AUTH) {
    const r = byKey.get(key);
    assert.ok(r, `${key} is no longer registered — update the coverage list`);
    assert.ok(isGuarded(r.handler), `${key} lost its session guard`);
  }
});

test("every permission a guard() references is a real registry key", () => {
  const seen = new Set<string>();
  for (const app of [authRoute, adminRoute]) {
    for (const r of app.routes) {
      const body = src(r.handler);
      // pull every guard({ perm: "..." }) / guard({perm:"..."}) out of the source
      for (const m of body.matchAll(/perm:\s*["']([^"']+)["']/g)) {
        const perm = m[1];
        assert.ok(
          registryGet(perm),
          `${r.method} ${r.path} guards an unregistered permission "${perm}"`,
        );
        seen.add(perm);
      }
    }
  }
  assert.ok(seen.size > 0, "expected to find at least one guarded permission");
});

