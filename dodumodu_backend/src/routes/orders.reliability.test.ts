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
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!String(input).includes("challenges.cloudflare.com")) return realFetch(input, init);
    calls += 1;
    bodies.push(JSON.parse(String(init?.body)));
    if (mode === "down") throw new Error("network down");
    if (mode === "reject") return new Response(JSON.stringify({ success: false, "error-codes": ["invalid-input-response"] }), { headers: { "Content-Type": "application/json" } });
    const token = JSON.parse(String(init?.body)).response as string;
    const ok = !used.has(token);
    used.add(token);
    return new Response(JSON.stringify(ok ? { success: ok } : { success: ok, "error-codes": ["timeout-or-duplicate"] }), { headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { calls: () => calls, bodies };
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

const botCheckOf = async (key: string) =>
  (await db.select({ b: orders.botCheck }).from(orders).where(eq(orders.idempotencyKey, key)))[0]?.b ?? null;

test("verifier outage: the order is ACCEPTED and flagged 'unverified' (fail open), nothing is lost", async () => {
  turnstile("down");
  const key = crypto.randomUUID();
  const res = await post(payload(key, "tok-B"));
  assert.equal(res.status, 200);
  assert.ok(!("botCheck" in ((await res.json()) as object)), "verification status is internal and never in the response");
  assert.equal(await countFor(key), 1);
  assert.equal(await botCheckOf(key), "unverified");
});

test("no token at all (script blocked, slow phone): accepted and flagged 'missing'; a later retry WITH a valid token upgrades the same order", async () => {
  turnstile("single-use");
  const key = crypto.randomUUID();
  const first = await post(payload(key, ""));
  assert.equal(first.status, 200);
  const a = await first.json() as { orderId: number; botCheck?: string };
  assert.equal(a.botCheck, undefined, "the customer is never told the check is missing");
  assert.equal(await botCheckOf(key), "missing");

  const retry = await post(payload(key, "tok-LATE"));        // the check finally completed on the customer's phone
  assert.equal(retry.status, 200);
  const b = await retry.json() as { orderId: number; botCheck?: string };
  assert.equal(b.orderId, a.orderId, "the SAME order");
  assert.equal(b.botCheck, undefined);
  assert.equal(await botCheckOf(key), "verified");
  assert.equal(await countFor(key), 1);
});

test("an expired or already-spent token is not a bot signal: accepted and flagged 'unverified'", async () => {
  turnstile("single-use");
  assert.equal((await post(payload(crypto.randomUUID(), "tok-SPENT"))).status, 200);   // spends it
  const key = crypto.randomUUID();
  const res = await post(payload(key, "tok-SPENT"));                                  // same token, new order: timeout-or-duplicate
  assert.equal(res.status, 200);
  assert.equal(await botCheckOf(key), "unverified");
});

test("a product with the bot check switched OFF never calls Cloudflare and records 'off'", async () => {
  await db.update(products).set({ botCheckEnabled: false }).where(eq(products.id, productId));
  try {
    const cf = turnstile("reject");
    const key = crypto.randomUUID();
    const res = await post(payload(key, ""));
    assert.equal(res.status, 200);
    assert.equal(cf.calls(), 0);
    assert.equal(await botCheckOf(key), "off");
  } finally {
    await db.update(products).set({ botCheckEnabled: true }).where(eq(products.id, productId));
  }
});

test("honeypot: a request that fills the hidden field gets a plausible answer and creates nothing", async () => {
  turnstile("single-use");
  const key = crypto.randomUUID();
  const res = await post({ ...payload(key, "tok-HP"), website: "http://spam.example" });
  assert.equal(res.status, 200);
  assert.equal(await countFor(key), 0);
});

test("fail-open brake: a burst of unverified orders from one address is STORED and flagged for review, never refused", async () => {
  turnstile("down");
  const ip = `203.0.113.${Math.floor(Math.random() * 200) + 20}`;
  for (let i = 0; i < 8; i++) assert.equal((await post({ ...payload(crypto.randomUUID(), ""), phone: `0803${String(1000000 + i)}`, whatsapp: `0803${String(1000000 + i)}`, customerName: `Burst ${i}`, address: `${i} Burst Road` }, ip)).status, 200);
  const key = crypto.randomUUID();
  const ninth = await post({ ...payload(key, ""), phone: "08039990000", whatsapp: "08039990000", customerName: "Ninth Person", address: "9 Ninth Road" }, ip);
  assert.equal(ninth.status, 200, "a customer behind a shared mobile-network address must not lose their order");
  assert.equal(await countFor(key), 1);
  const [row] = await db.select({ f: orders.riskFlags }).from(orders).where(eq(orders.idempotencyKey, key));
  assert.ok(row.f.includes("unverified_burst"), `flags: ${row.f}`);
});

test("a token Cloudflare does not recognise is STORED, flagged 'failed' for review, and answered like any other order", async () => {
  turnstile("reject");
  const key = crypto.randomUUID();
  const res = await post(payload(key, "tok-C"));
  assert.equal(res.status, 200, "an order must never be lost because verification failed");
  const body = await res.json() as Record<string, unknown>;
  assert.ok(body.orderId && body.reference);
  assert.ok(!("botCheck" in body) && !("error" in body) && !("code" in body), "nothing about verification reaches the customer");
  assert.equal(await countFor(key), 1);
  assert.equal(await botCheckOf(key), "failed");
  const [row] = await db.select({ f: orders.riskFlags }).from(orders).where(eq(orders.idempotencyKey, key));
  assert.ok(row.f.includes("bot_check_failed"));
});

test("a stored 'failed' order is upgraded, not duplicated, when the same submission later brings a valid token", async () => {
  turnstile("reject");
  const key = crypto.randomUUID();
  const first = await post(payload(key, "tok-bad")) ; const a = await first.json() as { orderId: number };
  turnstile("single-use");
  const second = await post(payload(key, "tok-good")); const b = await second.json() as { orderId: number };
  assert.equal(a.orderId, b.orderId);
  assert.equal(await countFor(key), 1);
  assert.equal(await botCheckOf(key), "verified");
});

test("the order's idempotency key is sent to Cloudflare, so an automatic retry of the same order can reuse its token", async () => {
  const cf = turnstile("single-use");
  const key = crypto.randomUUID();
  assert.equal((await post(payload(key, "tok-IDEM"))).status, 200);
  assert.equal(cf.bodies[0].idempotency_key, key);
});

test("an unseen key is still verified, so a bot cannot skip Turnstile by sending a made-up key (the order is stored either way)", async () => {
  const cf = turnstile("reject");
  const res = await post(payload(crypto.randomUUID(), "tok-D"));
  assert.equal(res.status, 200);
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
