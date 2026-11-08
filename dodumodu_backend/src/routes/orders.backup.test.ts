// Order safety net (live DB): every verified order is emailed independently of the database,
// and an order that could NOT be saved is emailed to the admin stored in the database.
//   * backup copy -> ORDER_BACKUP_EMAIL, full details, no Turnstile token, one email per order
//   * the customer never waits for email (a hung Resend cannot slow or fail the order)
//   * database rejects the order -> backup copy STILL sent + failure alert to the DB admin
//   * saved orders send no failure alert; bad input / bot failures send nothing at all
//   * not configured (no address / no API key) -> skipped silently
//   * retry of the same order reuses the same Resend idempotency key (no duplicate emails)
//   * admin address survives a database outage (cache), else falls back to ORDER_BACKUP_EMAIL
// Fails fast without DATABASE_URL and refuses non-local databases (mfa-test-kit).
import { test, after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { Env } from "../env";
import { ordersRoute } from "./orders";
import { products, orders } from "../schema";
import { ordersRepo } from "../data/ordersRepo";
import { q, q1, sql } from "../auth/sql";
import { setPrimaryUser } from "../auth/admin-ops";
import { flushOrderMail, resetOrderMailCache, sendOrderFailureAlert } from "../services/orderBackupMailer";
import { openTestDb, closePools, testSecrets, makeTag, cleanupTag, createEnrolledUser } from "../auth/mfa-test-kit";

const db = openTestDb();
const s = testSecrets();
const tag = makeTag("obk");
const realFetch = globalThis.fetch;
const BACKUP = `backup-${tag}@example.com`;
let adminEmail = "";
let prevPrimary: string | null = null;
let productId = 0;
let ipN = 0;
const nextIp = () => `10.203.${Math.floor(ipN / 250) + 1}.${(ipN++ % 250) + 1}`;

type Sent = { to: string; subject: string; text: string; key: string };
let sent: Sent[] = [];
let resendMode: "ok" | "hang" | "fail" = "ok";

const app = new Hono<{ Bindings: Env }>();
app.route("/", ordersRoute);
const envWith = (over: Record<string, string> = {}) => ({
  DATABASE_URL: process.env.DATABASE_URL!, ENVIRONMENT: "sandbox", TURNSTILE_SECRET_KEY: "0xs",
  MAX_ORDER_QUANTITY: "10", RESEND_API_KEY: "re_test", AUTH_FROM_EMAIL: "orders@example.com",
  ORDER_BACKUP_EMAIL: BACKUP, ...over,
}) as unknown as Env;

before(async () => {
  const prev = await q1<{ id: string }>(db, sql`SELECT id::text AS id FROM aa_users WHERE is_primary`);
  prevPrimary = prev?.id ?? null;
  await q(db, sql`UPDATE aa_users SET is_primary = false WHERE is_primary`);
  const a = await createEnrolledUser(db, s, `${tag}-admin@example.com`, { role: "admin" });
  await setPrimaryUser(db, a.id);
  adminEmail = a.email;
  const [p] = await db.insert(products).values({ slug: `${tag}-p`, name: "Backup fixture", description: "x", price: 100000 }).returning();
  productId = p.id;
  globalThis.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => {
    const url = String(i);
    if (url.includes("challenges.cloudflare.com")) {
      const ok = JSON.parse(String(init?.body)).response !== "bad";
      return new Response(JSON.stringify({ success: ok }), { headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("api.resend.com")) {
      const b = JSON.parse(String(init?.body));
      const key = new Headers(init?.headers).get("Idempotency-Key") ?? "";
      if (resendMode === "hang") await new Promise((r) => setTimeout(r, 3000));
      if (resendMode === "fail") return new Response("{}", { status: 500 });
      sent.push({ to: b.to, subject: b.subject, text: b.text, key });
      return new Response(JSON.stringify({ id: "x" }), { status: 200 });
    }
    return realFetch(i, init);
  }) as typeof fetch;
});

beforeEach(() => { sent = []; resendMode = "ok"; resetOrderMailCache(); });

after(async () => {
  globalThis.fetch = realFetch;
  await flushOrderMail();
  const rows = await db.select({ id: orders.id }).from(orders).where(eq(orders.productId, productId));
  for (const r of rows) {
    await q(db, sql`DELETE FROM admin_notifications WHERE dedupe_key = ${"order-created:" + r.id}`);
    await q(db, sql`DELETE FROM order_status_history WHERE order_id = ${r.id}`);
  }
  await db.delete(orders).where(eq(orders.productId, productId));
  await db.delete(products).where(eq(products.id, productId));
  await q(db, sql`UPDATE aa_users SET is_primary = false WHERE email LIKE ${tag + "%"}`);
  if (prevPrimary) await q(db, sql`UPDATE aa_users SET is_primary = true WHERE id = ${prevPrimary}::uuid`).catch(() => {});
  await cleanupTag(db, tag);
  await closePools();
});

const body = (key: string, over: Record<string, unknown> = {}) => ({
  idempotencyKey: key, turnstileToken: "good-token-xyz", productId, quantity: 2, customerName: "Ada Obi",
  phone: "08031234567", whatsapp: "08031234567", address: "12 Backup Street, Ikeja", state: "Lagos",
  deliveryDate: "tomorrow", paymentMethod: "cod", ...over,
});
const post = (b: unknown, env = envWith()) => app.request("/create-order", {
  method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": nextIp() }, body: JSON.stringify(b),
}, env);
const countFor = async (key: string) =>
  (await db.select({ id: orders.id }).from(orders).where(eq(orders.idempotencyKey, key))).length;

test("every order is emailed to ORDER_BACKUP_EMAIL with its details, once, and never the Turnstile token", async () => {
  const key = crypto.randomUUID();
  const res = await post(body(key));
  assert.equal(res.status, 200);
  await flushOrderMail();
  assert.equal(sent.length, 1, "exactly one email for a saved order (no failure alert)");
  const m = sent[0];
  assert.equal(m.to, BACKUP);
  assert.match(m.subject, /^\[ORDER\] Ada Obi/);
  for (const needle of ["Ada Obi", "08031234567", "12 Backup Street, Ikeja", "Lagos", "quantity: 2", key]) {
    assert.ok(m.text.includes(needle), `email contains ${needle}`);
  }
  assert.ok(!m.text.includes("good-token-xyz"), "the bot-check token is never emailed");
  assert.equal(await countFor(key), 1);
});

test("email never slows the customer: a hung email provider does not delay or fail the order", async () => {
  resendMode = "hang";
  const t = Date.now();
  const res = await post(body(crypto.randomUUID()));
  const took = Date.now() - t;
  assert.equal(res.status, 200);
  assert.ok(took < 2000, `order answered in ${took}ms while Resend was hanging for 3000ms`);
  await flushOrderMail();
});

test("a failing email provider (500) never fails the order", async () => {
  resendMode = "fail";
  const key = crypto.randomUUID();
  assert.equal((await post(body(key))).status, 200);
  await flushOrderMail();
  assert.equal(await countFor(key), 1);
});

test("database REJECTS the order: backup copy still goes out AND the DB admin gets a failure alert with the full order", async () => {
  const original = ordersRepo.insert;
  ordersRepo.insert = async () => { throw new Error("connection terminated unexpectedly"); };
  try {
    const key = crypto.randomUUID();
    const res: Response | Error = await Promise.resolve(app.request("/create-order", {
      method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": nextIp() },
      body: JSON.stringify(body(key)),
    }, envWith())).catch((e: Error) => e);
    // Hono answers 500 for the rethrown error; either shape means "the customer was not told it saved".
    assert.ok(res instanceof Error || (res as Response).status === 500);
    await flushOrderMail();
    const backup = sent.filter((m) => m.to === BACKUP);
    const alert = sent.filter((m) => m.to === adminEmail);
    assert.equal(backup.length, 1, "the independent copy was sent");
    assert.match(backup[0].subject, /^\[ORDER\]/);
    assert.equal(alert.length, 1, "the admin in the database was alerted");
    assert.match(alert[0].subject, /^\[ORDER NOT SAVED\] order_not_saved/);
    assert.ok(alert[0].text.includes("connection terminated unexpectedly"));
    for (const needle of ["Ada Obi", "08031234567", "12 Backup Street, Ikeja", key]) assert.ok(alert[0].text.includes(needle));
    assert.ok(!alert[0].text.includes("good-token-xyz"));
    assert.equal(await countFor(key), 0);
  } finally {
    ordersRepo.insert = original;
  }
});

test("an order for a missing product is a rejected order too: the admin is alerted", async () => {
  const res = await post(body(crypto.randomUUID(), { productId: 2_000_000_000 }));
  assert.equal(res.status, 404);
  await flushOrderMail();
  assert.equal(sent.filter((m) => m.to === adminEmail && /product_not_found/.test(m.subject)).length, 1);
});

test("a SAVED order sends no failure alert; invalid input and failed bot checks send no email at all", async () => {
  assert.equal((await post(body(crypto.randomUUID()))).status, 200);
  await flushOrderMail();
  assert.equal(sent.filter((m) => m.to === adminEmail).length, 0);

  sent = [];
  assert.equal((await post(body(crypto.randomUUID(), { phone: "" }))).status, 400);       // schema rejects
  assert.equal((await post(body(crypto.randomUUID(), { turnstileToken: "bad" }))).status, 400); // bot check fails
  await flushOrderMail();
  assert.equal(sent.length, 0, "junk and bot traffic never reaches the mailbox");
});

test("not configured: no ORDER_BACKUP_EMAIL, or no RESEND_API_KEY -> skipped silently, order unaffected", async () => {
  assert.equal((await post(body(crypto.randomUUID()), envWith({ ORDER_BACKUP_EMAIL: "" }))).status, 200);
  assert.equal((await post(body(crypto.randomUUID()), envWith({ RESEND_API_KEY: "" }))).status, 200);
  assert.equal((await post(body(crypto.randomUUID()), envWith({ ORDER_BACKUP_EMAIL: "not-an-email" }))).status, 200);
  await flushOrderMail();
  assert.equal(sent.length, 0);
});

test("a retry of the same order reuses the same Resend idempotency key (provider dedupes; no second email)", async () => {
  const key = crypto.randomUUID();
  await post(body(key));
  await post(body(key));
  await flushOrderMail();
  const copies = sent.filter((m) => m.to === BACKUP);
  assert.equal(copies.length, 2, "re-sent on retry, so a first failed send is recovered...");
  assert.equal(copies[0].key, copies[1].key, "...under ONE idempotency key, so Resend delivers it once");
  assert.equal(await countFor(key), 1);
});

test("several recipients (comma separated) each get the copy", async () => {
  await post(body(crypto.randomUUID()), envWith({ ORDER_BACKUP_EMAIL: `${BACKUP}, second-${tag}@example.com` }));
  await flushOrderMail();
  assert.deepEqual(sent.map((m) => m.to).sort(), [BACKUP, `second-${tag}@example.com`].sort());
});

test("failure alert survives a database outage: cached admin address, else ORDER_BACKUP_EMAIL", async () => {
  const dead = { execute: async () => { throw new Error("db down"); } } as never;
  const order = { idempotencyKey: crypto.randomUUID(), customerName: "Ada", quantity: 1, productId: 1, state: "Lagos" };
  const meta = { ip: "1.2.3.4", clientKind: "browser" };

  // 1) never looked up before + DB down -> falls back to the configured address
  assert.equal(await sendOrderFailureAlert(envWith(), dead, order, meta, "order_not_saved", "x"), "sent");
  assert.deepEqual(sent.map((m) => m.to), [BACKUP]);

  // 2) prime the cache with the real admin, then the DB goes down -> still the real admin
  sent = [];
  await sendOrderFailureAlert(envWith(), db, order, meta, "prime", "x");
  sent = [];
  await sendOrderFailureAlert(envWith(), dead, order, meta, "order_not_saved", "x");
  assert.deepEqual(sent.map((m) => m.to), [adminEmail]);
});
