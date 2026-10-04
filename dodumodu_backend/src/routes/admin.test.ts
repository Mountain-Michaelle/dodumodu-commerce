import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { adminRoute as app } from "./admin";
import { registerDbDriver } from "../db";
import { FakeDatabase, fakeDriver } from "../testSupport/fakeDb";
import { ordersRepo } from "../data/ordersRepo";
import { ACCESS_EMAIL_HEADER } from "../auth/adminAuth";
import type { Env } from "../env";

/* The admin HTTP surface, exercised through the real app: real middleware, real
   authorization seam, real validation, real route handlers, real error envelope.
   Only the database driver is stood in for, and it is registered through the same
   seam the real drivers use - so nothing in the app knows the difference.

   What is pinned here is the CONTRACT, because a panel is written against it:
   which status comes back, and what shape the error body has. */

const env = {
  DATABASE_URL: "fake://admin-test",
  ADMIN_OPERATORS: "",
  ENVIRONMENT: "sandbox",
} as unknown as Env;

const db = new FakeDatabase();
registerDbDriver(fakeDriver(db));

// Mounted at /admin exactly as app.ts does it. The test calls the router
// directly rather than the whole app, so the prefix has to be applied here - and
// applying it here rather than adjusting the paths keeps the test asserting the
// same URLs a browser would use.
const testApp = new Hono<{ Bindings: Env }>();
testApp.route("/admin", app);

function call(path: string, init: RequestInit & { as?: string | null } = {}) {
  const { as = "owner@example.com", ...rest } = init;
  const headers = new Headers(rest.headers);
  headers.set("Content-Type", "application/json");
  if (as !== null) headers.set(ACCESS_EMAIL_HEADER, as);
  return testApp.fetch(new Request(`http://localhost${path}`, { ...rest, headers }), env as never);
}

function callAs(path: string, email: string, operators: string) {
  return testApp.fetch(
    new Request(`http://localhost${path}`, { headers: { [ACCESS_EMAIL_HEADER]: email } }),
    { ...env, ADMIN_OPERATORS: operators } as unknown as Env as never,
  );
}

function order(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    productId: 1,
    idempotencyKey: "key-1",
    customerName: "Chioma Adeyemi",
    phone: "08012345678",
    whatsapp: "08012345678",
    address: "12 Allen Avenue, Ikeja",
    state: "Lagos",
    deliveryFeeType: "free",
    deliveryDate: "tomorrow",
    flaggedLate: false,
    questionNotes: null,
    paymentMethod: "cod",
    packageId: null,
    quantity: 1,
    unitPrice: 1500000,
    subtotal: 1500000,
    discountPercent: 0,
    discountAmount: 0,
    amount: 1500000,
    currency: "NGN",
    reference: "ord-abc-12345678",
    status: "paid",
    retryCount: 0,
    lastCheckedAt: null,
    deliveredAt: null,
    createdAt: new Date("2026-01-01T10:00:00Z"),
    updatedAt: new Date("2026-01-01T10:00:00Z"),
    ...over,
  };
}

let current: Record<string, unknown> | null;

beforeEach(() => {
  current = order();
  db.table("orders", [current as Record<string, unknown>]);
  db.table("products", [{ id: 1, name: "Glow Serum", slug: "glow-serum", categoryId: null, active: true }]);
  db.table("order_status_history", []);

  // The repositories are stubbed only where a test needs to control the outcome (a
  // lost update, a missing row). Everything else runs the real service path.
  ordersRepo.findById = async () => (current as never);
  ordersRepo.writeStatusHistory = async () => undefined;
  // The version guard is honoured, not ignored: a stub that accepted any
  // expectedUpdatedAt would make the 409 test pass for the wrong reason, which is
  // worse than no test at all.
  ordersRepo.markDelivered = async (_db, _id, expectedStatus, expectedUpdatedAt) => {
    if (!current || current.status !== expectedStatus) return null;
    if (expectedUpdatedAt && (current.updatedAt as Date).getTime() !== expectedUpdatedAt.getTime()) return null;
    current = { ...current, status: "delivered", deliveredAt: new Date(), updatedAt: new Date() };
    return current as never;
  };
  ordersRepo.revertDelivery = async (_db, _id, toStatus) => {
    if (!current || current.status !== "delivered") return null;
    current = { ...current, status: toStatus, deliveredAt: null };
    return current as never;
  };
  ordersRepo.guardedStatusUpdate = async (_db, _id, from, to) => {
    if (!current || current.status !== from) return null;
    current = { ...current, status: to };
    return current as never;
  };
  ordersRepo.findByIds = async () => (current ? [current as never] : []);
  ordersRepo.ordersCreatedBetween = async () => (current ? [current as never] : []);
  ordersRepo.statusHistoryForOrder = async () => [];
  ordersRepo.updateEditableFields = async (_db, _id, patch) => {
    current = { ...current!, ...patch };
    return current as never;
  };
  ordersRepo.deleteById = async () => true;
  ordersRepo.listForAdmin = async () => ({ rows: [], total: 0 });
  ordersRepo.applyStatusTransition = async () => ({ applied: true, order: current as never });
  ordersRepo.findPotentialDuplicates = async () => [];
});

/* ---- authorization ---- */

test("an unauthenticated request is refused with 401 and no data", async () => {
  // Cloudflare Access is the real boundary in production; this is where that fact
  // is enforced in code rather than assumed.
  for (const [method, path] of [
    ["GET", "/admin/orders"],
    ["GET", "/admin/categories"],
    ["GET", "/admin/products"],
    ["GET", "/admin/media"],
    ["POST", "/admin/orders/1/deliver"],
  ] as const) {
    const res = await call(path, { method, as: null });
    assert.equal(res.status, 401, `${method} ${path} must be 401 without an identity`);
    const body = await res.json() as { error: { code: string } };
    assert.equal(body.error.code, "UNAUTHORIZED");
  }
});

test("an identity not on the allowlist is refused with 403, not 401", async () => {
  // Authenticated, just not permitted. The two are different problems for whoever
  // is looking at the panel, so they must not be reported the same way.
  const res = await callAs("/admin/orders", "stranger@example.com", "owner@example.com");
  assert.equal(res.status, 403);
  const body = await res.json() as { error: { code: string } };
  assert.equal(body.error.code, "FORBIDDEN");
});

test("an operator on the allowlist gets through, with a normalised identity", async () => {
  const res = await callAs("/admin/me", "Owner@Example.com", "owner@example.com");
  assert.equal(res.status, 200);
  const body = await res.json() as { email: string; permissions: string[] };
  assert.equal(body.email, "owner@example.com");
  assert.ok(body.permissions.length > 0);
});

/* ---- validation ---- */

test("a malformed body is a 400 with field notes, not a 500", async () => {
  const res = await call("/admin/categories", { method: "POST", body: JSON.stringify({ name: "" }) });
  assert.equal(res.status, 400);
  const body = await res.json() as { error: { message: string }; fields?: Record<string, unknown> };
  assert.equal(body.error.message, "Check the highlighted fields");
  assert.ok(body.fields && Object.keys(body.fields).length > 0, "field notes must come back");
});

test("a body that is not JSON is a 400, not a crash", async () => {
  const res = await call("/admin/categories", { method: "POST", body: "not json at all" });
  assert.equal(res.status, 400);
});

test("a list request with an unbounded page size is refused", async () => {
  // The control that keeps "server-side" honest: without a ceiling, ?pageSize=100000
  // is a request to download every customer's name, phone and address.
  const res = await call("/admin/orders?pageSize=100000");
  assert.equal(res.status, 400);
});

/* ---- not found ---- */

test("a missing order is a 404 with the standard error envelope", async () => {
  ordersRepo.findById = async () => null;
  const res = await call("/admin/orders/99");
  assert.equal(res.status, 404);
  const body = await res.json() as { error: { code: string; message: string } };
  assert.equal(body.error.code, "NOT_FOUND");
});

/* ---- illegal transition ---- */

test("delivering an order that is not in transit is a 400, and changes nothing", async () => {
  current = order({ status: "awaiting_payment" });
  const res = await call("/admin/orders/1/deliver", { method: "POST", body: "{}" });
  assert.equal(res.status, 400);
  const body = await res.json() as { error: { message: string } };
  assert.match(body.error.message, /paid or confirmed COD/);
  assert.equal(current?.status, "awaiting_payment", "a refused transition must not write");
});

/* ---- concurrency ---- */

test("a stale expectedUpdatedAt is a 409 telling the operator to reload", async () => {
  // The row moved between the panel rendering the form and the operator pressing
  // the button. "We saved your change over theirs" is never acceptable.
  const res = await call("/admin/orders/1/deliver", {
    method: "POST",
    body: JSON.stringify({ expectedUpdatedAt: new Date("2020-01-01T00:00:00.000Z").toISOString() }),
  });
  assert.equal(res.status, 409);
  const body = await res.json() as { error: { message: string }; action: string };
  assert.equal(body.action, "reload");
  assert.match(body.error.message, /Reload/);
});

test("delivering with the current version succeeds and stamps delivered_at", async () => {
  const res = await call("/admin/orders/1/deliver", {
    method: "POST",
    body: JSON.stringify({ expectedUpdatedAt: (current as { updatedAt: Date }).updatedAt.toISOString() }),
  });
  assert.equal(res.status, 200);
  assert.equal(current?.status, "delivered");
  assert.ok(current?.deliveredAt, "delivered_at must be set in the same operation");
});

/* ---- delete confirmation ---- */

test("deleting an order without the confirm flag is refused", async () => {
  const res = await call("/admin/orders/1", { method: "DELETE", body: "{}" });
  assert.equal(res.status, 400);
  const body = await res.json() as { error: { code: string }; fields?: Record<string, unknown> };
  // The schema catches a missing `confirm` before the service is reached, so the
  // reason comes back as a field note against the field itself. The service
  // repeats the check underneath for any caller that bypasses the schema - both
  // are needed, and this test is about the outer one.
  assert.equal(body.error.code, "VALIDATION_ERROR");
  assert.ok(body.fields && "confirm" in body.fields, `expected a note against confirm: ${JSON.stringify(body)}`);
});
