// The "main account" rules: ONE flagged primary admin is the only recipient of bell
// notifications and the auto-assignee of every new order, so accounts created for testing
// never receive or own real work.
//   * with a primary: only it is notified; without one: every active admin/staff (unchanged)
//   * setPrimaryUser: moves the flag, only an ACTIVE ADMIN qualifies, never two primaries
//   * new order -> assigned_to = primary email (+ history row); feature flag off, no primary,
//     or an inactive primary -> left unassigned; a retry never re-assigns
// Live DB; fails fast without DATABASE_URL and refuses non-local databases.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { Env } from "../env";
import { ordersRoute } from "../routes/orders";
import { products, orders } from "../schema";
import { q, q1, sql } from "./sql";
import { setPrimaryUser } from "./admin-ops";
import { AuthRejectError } from "./errors";
import { notificationService } from "../services/notificationService";
import { openTestDb, closePools, testSecrets, makeTag, cleanupTag, createEnrolledUser } from "./mfa-test-kit";

const db = openTestDb();
const s = testSecrets();
const tag = makeTag("prim");
const realFetch = globalThis.fetch;
let prevPrimary: string | null = null;
let productId = 0;
let ipN = 0;
const nextIp = () => `10.202.${Math.floor(ipN / 250) + 1}.${(ipN++ % 250) + 1}`;

const app = new Hono<{ Bindings: Env }>();
app.route("/", ordersRoute);
const envFor = (assignment: "true" | "false") => ({
  DATABASE_URL: process.env.DATABASE_URL!, ENVIRONMENT: "sandbox", TURNSTILE_SECRET_KEY: "0xs",
  MAX_ORDER_QUANTITY: "10", ASSIGNMENT_MODE_ENABLED: assignment,
}) as unknown as Env;

before(async () => {
  const prev = await q1<{ id: string }>(db, sql`SELECT id::text AS id FROM aa_users WHERE is_primary`);
  prevPrimary = prev?.id ?? null;
  const [p] = await db.insert(products).values({
    slug: `${tag}-p`, name: "Primary fixture", description: "x", price: 100000 }).returning();
  productId = p.id;
  globalThis.fetch = (async (i: RequestInfo | URL, init?: RequestInit) =>
    String(i).includes("challenges.cloudflare.com")
      ? new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json" } })
      : realFetch(i, init)) as typeof fetch;
});

after(async () => {
  globalThis.fetch = realFetch;
  await q(db, sql`UPDATE aa_users SET is_primary = false WHERE email LIKE ${tag + "%"}`);
  if (prevPrimary) await q(db, sql`UPDATE aa_users SET is_primary = true WHERE id = ${prevPrimary}::uuid`).catch(() => {});
  const rows = await db.select({ id: orders.id }).from(orders).where(eq(orders.productId, productId));
  for (const r of rows) {
    await q(db, sql`DELETE FROM admin_notifications WHERE dedupe_key = ${"order-created:" + r.id}`);
    await q(db, sql`DELETE FROM order_assignments WHERE order_id = ${r.id}`);
    await q(db, sql`DELETE FROM order_status_history WHERE order_id = ${r.id}`);
  }
  await db.delete(orders).where(eq(orders.productId, productId));
  await db.delete(products).where(eq(products.id, productId));
  await q(db, sql`DELETE FROM admin_notifications WHERE title = ${tag}`);
  await cleanupTag(db, tag);
  await closePools();
});

/** Run with NO primary flagged (the live one is restored in after()). */
async function withNoPrimary(fn: () => Promise<void>) {
  await q(db, sql`UPDATE aa_users SET is_primary = false WHERE is_primary`);
  await fn();
}
const place = async (assignment: "true" | "false") => {
  const key = crypto.randomUUID();
  const res = await app.request("/create-order", {
    method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": nextIp() },
    body: JSON.stringify({
      idempotencyKey: key, turnstileToken: "t", productId, quantity: 1, customerName: "Primary Fixture",
      phone: "08031234567", whatsapp: "08031234567", address: "1 Test Rd", state: "Lagos",
      deliveryDate: "tomorrow", paymentMethod: "cod" }),
  }, envFor(assignment));
  assert.equal(res.status, 200, await res.clone().text());
  return (await db.select().from(orders).where(eq(orders.idempotencyKey, key)))[0];
};

test("notifications: with a primary only it is told; test/secondary admins hear nothing", async () => {
  await withNoPrimary(async () => {
    const main = await createEnrolledUser(db, s, `${tag}-main@example.com`, { role: "admin" });
    const other = await createEnrolledUser(db, s, `${tag}-other@example.com`, { role: "admin" });
    await setPrimaryUser(db, main.id);
    assert.equal(await notificationService.createForAdmins(db, { type: "t", title: tag, dedupeKey: `${tag}:1` }), 1);
    assert.equal((await notificationService.list(db, main.id)).filter((n) => n.title === tag).length, 1);
    assert.equal((await notificationService.list(db, other.id)).filter((n) => n.title === tag).length, 0);
  });
});

test("notifications: with NO primary every active admin/staff is notified, as before", async () => {
  await withNoPrimary(async () => {
    const a = await createEnrolledUser(db, s, `${tag}-a@example.com`, { role: "admin" });
    const st = await createEnrolledUser(db, s, `${tag}-st@example.com`, { role: "staff" });
    await notificationService.createForAdmins(db, { type: "t", title: tag, dedupeKey: `${tag}:2` });
    for (const u of [a, st]) {
      assert.equal((await notificationService.list(db, u.id)).filter((n) => n.title === tag).length, 1);
    }
  });
});

test("an INACTIVE primary is skipped: notifications fall back instead of vanishing", async () => {
  await withNoPrimary(async () => {
    const dead = await createEnrolledUser(db, s, `${tag}-dead@example.com`, { role: "admin" });
    const live = await createEnrolledUser(db, s, `${tag}-live@example.com`, { role: "admin" });
    await setPrimaryUser(db, dead.id);
    await q(db, sql`UPDATE aa_users SET is_active = false WHERE id = ${dead.id}::uuid`);
    await notificationService.createForAdmins(db, { type: "t", title: tag, dedupeKey: `${tag}:3` });
    assert.equal((await notificationService.list(db, live.id)).filter((n) => n.title === tag).length, 1);
  });
});

test("setPrimaryUser moves the flag, keeps exactly one primary, and refuses non-admin / inactive targets", async () => {
  await withNoPrimary(async () => {
    const a = await createEnrolledUser(db, s, `${tag}-pa@example.com`, { role: "admin" });
    const b = await createEnrolledUser(db, s, `${tag}-pb@example.com`, { role: "admin" });
    const staff = await createEnrolledUser(db, s, `${tag}-ps@example.com`, { role: "staff" });
    await setPrimaryUser(db, a.id);
    await setPrimaryUser(db, b.id);
    const flagged = await q<{ email: string }>(db, sql`SELECT email FROM aa_users WHERE is_primary`);
    assert.deepEqual(flagged.map((r) => r.email), [b.email]);
    await assert.rejects(setPrimaryUser(db, staff.id), AuthRejectError);
    await assert.rejects(setPrimaryUser(db, crypto.randomUUID()), AuthRejectError);
    assert.deepEqual((await q<{ email: string }>(db, sql`SELECT email FROM aa_users WHERE is_primary`)).map((r) => r.email), [b.email],
      "a refused call changes nothing");
  });
});

test("the database itself refuses a second primary", async () => {
  await withNoPrimary(async () => {
    const a = await createEnrolledUser(db, s, `${tag}-da@example.com`, { role: "admin" });
    const b = await createEnrolledUser(db, s, `${tag}-db@example.com`, { role: "admin" });
    await q(db, sql`UPDATE aa_users SET is_primary = true WHERE id = ${a.id}::uuid`);
    await assert.rejects(q(db, sql`UPDATE aa_users SET is_primary = true WHERE id = ${b.id}::uuid`));
  });
});

test("POST /admin/users/:id/primary needs an admin session with step-up (anonymous -> 401)", async () => {
  const { adminRoute } = await import("./routes");
  const res = await adminRoute.request("http://localhost/users/x/primary", {
    method: "POST", headers: { "content-type": "application/json", host: "localhost", origin: "http://localhost" }, body: "{}",
  }, { DATABASE_URL: process.env.DATABASE_URL!, ADMIN_AUTH_V2: "1",
    OTP_KEY: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=", THROTTLE_KEY: "CwcHCwcHCwcHCwcHCwcHCwcHCwcHCwcHCwcHCwcHCwc=",
    TOTP_ENC_KEY: "DwcHDwcHDwcHDwcHDwcHDwcHDwcHDwcHDwcHDwcHDwc=" } as never);
  assert.equal(res.status, 401);
});

test("a new order is auto-assigned to the primary (with a history row), never to another account", async () => {
  await withNoPrimary(async () => {
    const main = await createEnrolledUser(db, s, `${tag}-boss@example.com`, { role: "admin" });
    const tester = await createEnrolledUser(db, s, `${tag}-tester@example.com`, { role: "admin" });
    await setPrimaryUser(db, main.id);
    const o = await place("true");
    assert.equal(o.assignedTo, main.email);
    assert.notEqual(o.assignedTo, tester.email);
    assert.ok(o.assignedAt);
    const hist = await q<{ actor_email: string; action: string }>(db,
      sql`SELECT actor_email, action FROM order_assignments WHERE order_id = ${o.id}`);
    assert.deepEqual(hist, [{ actor_email: "system", action: "assign" }]);
  });
});

test("auto-assign is OFF while ASSIGNMENT_MODE_ENABLED is not 'true', and when there is no active primary", async () => {
  await withNoPrimary(async () => {
    const main = await createEnrolledUser(db, s, `${tag}-boss2@example.com`, { role: "admin" });
    await setPrimaryUser(db, main.id);
    assert.equal((await place("false")).assignedTo, null, "feature flag off");
    await q(db, sql`UPDATE aa_users SET is_active = false WHERE id = ${main.id}::uuid`);
    assert.equal((await place("true")).assignedTo, null, "inactive primary is never assigned work");
  });
  await withNoPrimary(async () => {
    assert.equal((await place("true")).assignedTo, null, "no primary flagged");
  });
});
