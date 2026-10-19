import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { orderV2Routes } from "./ordersV2";
import { ordersRepo } from "../../data/ordersRepo";
import { registerDbDriver } from "../../db";
import { FakeDatabase, fakeDriver } from "../../testSupport/fakeDb";
import { authInit, type AuthEnv, type AuthState } from "../../auth/middleware";
import type { Session } from "../../auth/session-lookup";

// The handlers call createDb(DATABASE_URL); register the fake driver through the
// same seam the real drivers use, so nothing in the app knows the difference.
const db = new FakeDatabase();
registerDbDriver(fakeDriver(db));

// A mono operator: the case scoping exists for. Only role + email drive scope.
// The perms array mirrors a real mono preset (the scope gate only fires after
// guard() grants the perm), so orders.audit.view is listed even though it is
// only used to reach the per-order scope check below.
const MONO: Session = {
  userId: "u-mono", email: "mono@example.com", role: "mono", sid: "s-1",
  deviceId: null, tier: "normal", perms: ["orders.view", "orders.change",
    "orders.status.delivered", "orders.status.paid", "orders.status.failed",
    "orders.audit.view"],
  permsVersion: 1, needsTouch: false, idleSecs: 0, stepupOk: true,
  prefix: null, country: null, driftCount: 0,
};

// Build a request app that injects the session the way guard() expects:
// authInit() returns a pre-set c.get("aa") as-is, so seeding it makes the
// session look already-loaded. No cookie/DB round-trip.
function callAs(session: Session, path: string, init: RequestInit = {}) {
  const app = new Hono<{ Bindings: AuthEnv }>();
  app.use("*", async (c, next) => {
    const state = authInit(c);
    (state as AuthState).session = session;
    await next();
  });
  app.route("/admin-v2/orders", orderV2Routes);
  // "/" means the collection root; the trailing slash is NOT the same route
  // in Hono, so normalize it away instead of 404-ing the list handler.
  const suffix = path === "/" ? "" : path;
  return app.request(
    `http://localhost/admin-v2/orders${suffix}`,
    { ...init, headers: { "Content-Type": "application/json", ...(init.headers ?? {}) } },
    { DATABASE_URL: "postgres://test" } as unknown as AuthEnv,
  );
}

// The row shape findById/statusHistory return; only id/status/updatedAt/assignedTo matter.
const ORDER = {
  id: 42, reference: "DD-00042", status: "paid", updatedAt: new Date("2026-01-01"),
  assignedTo: "someone.else@example.com",
};

// A second row shape with the mono operator as the assignee; used only by the
// "own order is readable" test, where the in-scope `assignedTo` is the mono email.
const SELF_ORDER = {
  ...ORDER,
  id: 43, reference: "DD-00043", status: "paid", updatedAt: new Date("2026-01-01"),
  assignedTo: "mono@example.com",
};

// An admin implicitly holds every privilege; a general operator needs only the
// orders section to reach the list route. Neither is scope-restricted, so the
// list query they issue must carry NO scope predicate.
const ADMIN: Session = {
  ...MONO,
  userId: "u-admin", email: "admin@example.com", role: "admin", perms: [],
};

const GENERAL: Session = {
  ...MONO,
  userId: "u-general", email: "general@example.com", role: "general",
  perms: ["orders.view"],
};

test("admin/general/mono: list query carries scope only for the mono operator", async () => {
  // Capture the scope the route passes into the repository. The fake driver
  // records predicates without evaluating them, so this asserts on the exact
  // routing boundary (which queries are narrowed) rather than the row content
  // a fake SQL engine happened to return.
  const scopes: unknown[] = [];
  const origListForAdmin = ordersRepo.listForAdmin;
  ordersRepo.listForAdmin = (async (_db: never, opts: { scope?: unknown }) => {
    scopes.push(opts.scope);
    return { rows: [], total: 0 };
  }) as never;

  try {
    const admin = await callAs(ADMIN, "/");
    const general = await callAs(GENERAL, "/");
    const mono = await callAs(MONO, "/");

    assert.equal(admin.status, 200, "an admin must reach the list route");
    assert.equal(general.status, 200, "a general operator must reach the list route");
    assert.equal(mono.status, 200, "a mono operator must reach the list route");
    assert.equal(scopes.length, 3, "every list request must reach the repository");
    assert.equal(scopes[0], undefined, "an admin query is unrestricted");
    assert.equal(scopes[1], undefined, "a general query is unrestricted");
    assert.notEqual(scopes[2], undefined, "a mono query is narrowed to their own rows");
  } finally {
    ordersRepo.listForAdmin = origListForAdmin;
  }
});

test("mono operator: seeded order detail is readable via route layer", async () => {
  // Seed the in-memory driver with the two rows the fake `orders` table holds,
  // then exercise the route layer end to end (middleware -> guard -> scope gate
  // -> findById -> orderScope.allows) exactly as production does.
  //
  // NOTE: the fake driver records predicates but does not evaluate them, so
  // `findById` returns the first seeded row. `SELF_ORDER` is first so the
  // mono's own assigned row is what the handler resolves and serves.
  db.table("orders", [Object.assign({}, SELF_ORDER), Object.assign({}, ORDER)]);
  try {
    const r = await callAs(MONO, "/43");
    assert.equal(r.status, 200, "the mono's own seeded order must be served");
  } finally {
    db.table("orders", []);
  }
});

test("mono operator: seeded non-own order is concealed as 404", async () => {
  // Seed a single row whose assignedTo is NOT the mono operator's email. The
  // fake driver ignores `where` in `findById`, so it returns this first row;
  // the scope gate then conceals it (404) because assignedTo !== mono@example.com.
  db.table("orders", [Object.assign({}, ORDER)]);

  try {
    const r = await callAs(MONO, "/42");
    assert.equal(r.status, 404, "an out-of-scope order must not be readable, even by id");
  } finally {
    db.table("orders", []);
  }
});
test("mono operator: another operator's order detail is concealed as 404", async () => {
  // The repositories are stubbed only where a test needs to control the outcome: a
  // concealed order, a missing one, or a write that must not happen. Everything
  // else runs the real service path.
  ordersRepo.findById = async () => (ORDER as never);

  try {
    const r = await callAs(MONO, "/42");
    assert.equal(r.status, 404, "out-of-scope order must not be readable, even to guess");
  } finally {
    ordersRepo.findById = async () => undefined as never;
  }
});

test("mono operator: status read of another operator's order is 404", async () => {
  ordersRepo.findById = async () => (ORDER as never);
  try {
    const r = await callAs(MONO, "/42/status");
    assert.equal(r.status, 404);
  } finally {
    ordersRepo.findById = async () => undefined as never;
  }
});

test("mono operator: annotations of another operator's order are 404", async () => {
  ordersRepo.findById = async () => (ORDER as never);
  ordersRepo.statusHistoryForOrder = async () => ([] as never);
  try {
    const r = await callAs(MONO, "/42/annotations");
    assert.equal(r.status, 404);
  } finally {
    ordersRepo.findById = async () => undefined as never;
    ordersRepo.statusHistoryForOrder = async () => ([] as never);
  }
});

test("mono operator: own order detail is readable (200)", async () => {
  ordersRepo.findById = async () => (SELF_ORDER as never);
  try {
    const r = await callAs(MONO, "/42");
    assert.equal(r.status, 200, "an in-scope order must be served");
  } finally {
    ordersRepo.findById = async () => undefined as never;
  }
});

test("mono operator: note on another operator's order is 404", async () => {
  let wrote = false;
  ordersRepo.findById = async () => (ORDER as never);
  ordersRepo.writeStatusHistory = async () => { wrote = true; };
  try {
    const r = await callAs(MONO, "/42/notes", {
      method: "POST", body: JSON.stringify({ note: "please expedite" }),
    });
    assert.equal(r.status, 404);
    assert.equal(wrote, false, "no audit row is written for a concealed order");
  } finally {
    ordersRepo.findById = async () => undefined as never;
    ordersRepo.writeStatusHistory = async () => { wrote = false; };
  }
});
