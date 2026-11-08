// Order submission on a bad connection (live DB). The customer's phone drops the
// response after the server already created the order, so it retries the SAME
// request: same idempotency key, same single-use Turnstile token. Pinned here:
//   * the replay returns the SAME order (never a second one, never "bot check failed"),
//   * Turnstile is NOT called again for a replay,
//   * a verifier outage is a retryable 503 that does not burn the key or create an order,
//   * a genuine Turnstile failure still fails closed with 400 and creates nothing,
//   * two simultaneous submits of one key produce exactly one order,
//   * a failed status-history write does not turn a placed order into a 500.
// Fails fast without DATABASE_URL and refuses non-local databases (mfa-test-kit).
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Env } from "../env";
import { ordersRoute } from "./orders";
import { products, orders } from "../schema";
import { ordersRepo } from "../data/ordersRepo";
import { openTestDb, closePools, makeTag } from "../auth/mfa-test-kit";

const db = openTestDb();
const url = process.env.DATABASE_URL!;
const tag = makeTag("ordrel");
const realFetch = globalThis.fetch;

const app = new Hono<{ Bindings: Env }>();
app.route("/", ordersRoute);

const env = {
  DATABASE_URL: url,
  ENVIRONMENT: "sandbox",
  TURNSTILE_SECRET_KEY: "0xsecret",
  MAX_ORDER_QUANTITY: "10",
} as unknown as Env;

let productId = 0;
let ipCounter = 0;
const nextIp = () => `10.201.${Math.floor(ipCounter / 250) + 1}.${(ipCounter++ % 250) + 1}`;

before(async () => {
  const [p] = await db.insert(products).values({
    slug: `${tag}-product`, name: "Reliability fixture", description: "disposable", price: 150000,
  }).returning();
  productId = p.id;
});

after(async () => {
  globalThis.fetch = realFetch;
  const rows = await db.select({ id: orders.id }).from(orders).where(eq(orders.productId, productId));
  for (const r of rows) {
    await db.execute(sql`DELETE FROM admin_notifications WHERE dedupe_key = ${"order-created:" + r.id}`);
    await db.execute(sql`DELETE FROM order_status_history WHERE order_id = ${r.id}`);
  }
  await db.delete(orders).where(eq(orders.productId, productId));
  await db.delete(products).where(eq(products.id, productId));
  await closePools();
});

/** A Cloudflare double that accepts a token ONCE (like the real single-use tokens). */
function turnstile(mode: "single-use" | "down" | "reject") {
  const used = new Set<string>();
  let calls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!String(input).includes("challenges.cloudflare.com")) return realFetch(input, init);
    calls += 1;
    if (mode === "down") throw new Error("network down");
    if (mode === "reject") return new Response(JSON.stringify({ success: false }), { headers: { "Content-Type": "application/json" } });
    const token = JSON.parse(String(init?.body)).response as string;
    const ok = !used.has(token);
    used.add(token);
    return new Response(JSON.stringify({ success: ok }), { headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { calls: () => calls };
}

const payload = (key: string, token = "tok-1") => ({
  idempotencyKey: key,
  turnstileToken: token,
  productId,
  quantity: 1,
  customerName: "Reliability Fixture",
  phone: "08031234567",
  whatsapp: "08031234567",
  address: "12 Test Street, Ikeja",
  state: "Lagos",
  deliveryDate: "tomorrow",
  paymentMethod: "cod",
});

const post = (body: unknown, ip = nextIp()) =>
  app.request("/create-order", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip },
    body: JSON.stringify(body),
  }, env);

const countFor = async (key: string) =>
  (await db.select({ id: orders.id }).from(orders).where(eq(orders.idempotencyKey, key))).length;

test("lost response: the retry with the SAME key and SAME single-use token returns the same order", async () => {
  const cf = turnstile("single-use");
  const key = crypto.randomUUID();
  const first = await post(payload(key, "tok-A"));
  assert.equal(first.status, 200, await first.clone().text());
  const a = await first.json() as { orderId: number; reference: string };

  const retry = await post(payload(key, "tok-A"));             // token already consumed at Cloudflare
  assert.equal(retry.status, 200, "a retry must not be answered with 'Bot verification failed'");
  const b = await retry.json() as { orderId: number; reference: string };
  assert.equal(b.orderId, a.orderId);
  assert.equal(b.reference, a.reference);
  assert.equal(cf.calls(), 1, "the replay did not hit Turnstile again");
  assert.equal(await countFor(key), 1);
});

test("verifier outage: retryable 503, nothing created, and the key is NOT burned", async () => {
  turnstile("down");
  const key = crypto.randomUUID();
  const res = await post(payload(key, "tok-B"));
  assert.equal(res.status, 503);
  assert.equal(res.headers.get("retry-after"), "2");
  assert.equal(await countFor(key), 0);

  turnstile("single-use");                                      // connectivity is back
  const ok = await post(payload(key, "tok-B2"));
  assert.equal(ok.status, 200);
  assert.equal(await countFor(key), 1);
});

test("a genuinely failed Turnstile check still fails closed: 400 and no order", async () => {
  turnstile("reject");
  const key = crypto.randomUUID();
  const res = await post(payload(key, "tok-C"));
  assert.equal(res.status, 400);
  assert.equal(await countFor(key), 0);
});

test("an unseen key is verified, so a bot cannot skip Turnstile by sending a made-up key", async () => {
  const cf = turnstile("reject");
  const res = await post(payload(crypto.randomUUID(), "tok-D"));
  assert.equal(res.status, 400);
  assert.equal(cf.calls(), 1);
});

test("double-submit race: two simultaneous requests for one key create exactly one order", async () => {
  turnstile("single-use");
  const key = crypto.randomUUID();
  const [x, y] = await Promise.all([post(payload(key, "tok-E1")), post(payload(key, "tok-E2"))]);
  assert.equal(x.status, 200);
  assert.equal(y.status, 200);
  const [bx, by] = [await x.json(), await y.json()] as { orderId: number }[];
  assert.equal(bx.orderId, by.orderId);
  assert.equal(await countFor(key), 1);
});

test("a failed status-history write does not turn a placed order into a 500", async () => {
  turnstile("single-use");
  const original = ordersRepo.writeStatusHistory;
  ordersRepo.writeStatusHistory = async () => { throw new Error("connection reset"); };
  try {
    const key = crypto.randomUUID();
    const res = await post(payload(key, "tok-F"));
    assert.equal(res.status, 200, "the order exists, so the customer must be told it was placed");
    assert.equal(await countFor(key), 1);
  } finally {
    ordersRepo.writeStatusHistory = original;
  }
});
