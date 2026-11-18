// Probable-duplicate labelling against a real database: it flags a likely repeat of an OPEN order with a reference to it, never
// refuses or alters the order, never flags a legitimate repeat purchase (earlier order delivered), and survives retries and races.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Env } from "../env";
import { ordersRoute } from "./orders";
import { products, orders } from "../schema";
import { openTestDb, closePools, makeTag } from "../auth/mfa-test-kit";

const db = openTestDb();
const url = process.env.DATABASE_URL!;
const tag = makeTag("orddup");
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


function ok() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!String(input).includes("challenges.cloudflare.com")) return realFetch(input, init);
    return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}
const payload = (key: string, over: Record<string, unknown> = {}) => ({
  idempotencyKey: key, turnstileToken: "t-" + key, productId, quantity: 1, customerName: "Dup Fixture", phone: "08037770001", whatsapp: "08037770001",
  address: "5 Dup Street, Ikeja", state: "Lagos", deliveryDate: "tomorrow", paymentMethod: "cod", ...over,
});
const post = (body: unknown) => app.request("/create-order", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": nextIp() }, body: JSON.stringify(body) }, env);
const row = async (key: string) => (await db.select().from(orders).where(eq(orders.idempotencyKey, key)))[0];

test("a second order from the same person minutes later is stored AND flagged, pointing at the first", async () => {
  ok();
  const k1 = crypto.randomUUID(), k2 = crypto.randomUUID();
  assert.equal((await post(payload(k1))).status, 200);
  const second = await post(payload(k2));
  assert.equal(second.status, 200, "a duplicate is never refused");
  const a = await row(k1), b = await row(k2);
  assert.ok(a && b && a.id !== b.id, "both orders exist");
  assert.deepEqual(a.riskFlags, []);
  assert.ok(b.riskFlags.includes("probable_duplicate"));
  assert.equal(b.duplicateRefs?.[0]?.id, a.id);
  assert.equal(b.duplicateRefs?.[0]?.reference, a.reference);
  const body = await second.json() as Record<string, unknown>;
  assert.ok(!("riskFlags" in body) && !("duplicateRefs" in body), "risk labels never reach the customer");
});

test("a legitimate repeat purchase is not flagged once the earlier order was delivered", async () => {
  ok();
  const k1 = crypto.randomUUID(), k2 = crypto.randomUUID();
  const phone = "08037770002";
  await post(payload(k1, { phone, whatsapp: phone, customerName: "Repeat Buyer", address: "8 Repeat Road" }));
  await db.update(orders).set({ status: "delivered", deliveredAt: new Date() }).where(eq(orders.idempotencyKey, k1));
  assert.equal((await post(payload(k2, { phone, whatsapp: phone, customerName: "Repeat Buyer", address: "8 Repeat Road" }))).status, 200);
  const b = await row(k2);
  assert.deepEqual(b.riskFlags, [], JSON.stringify(b.duplicateRefs));
  assert.equal(b.duplicateRefs, null);
});

test("two different customers are never flagged against each other", async () => {
  ok();
  const k1 = crypto.randomUUID(), k2 = crypto.randomUUID();
  await post(payload(k1, { phone: "08037770003", whatsapp: "08037770003", customerName: "Person One", address: "1 One Street" }));
  await post(payload(k2, { phone: "08037770004", whatsapp: "08037770004", customerName: "Person Two", address: "2 Two Street" }));
  assert.deepEqual((await row(k2)).riskFlags, []);
});

test("a RETRY of the same submission is the same order and is not flagged as a duplicate of itself", async () => {
  ok();
  const k = crypto.randomUUID();
  const a = await (await post(payload(k, { phone: "08037770005", whatsapp: "08037770005", customerName: "Retry Person", address: "55 Retry Lane" }))).json() as { orderId: number };
  const b = await (await post(payload(k, { phone: "08037770005", whatsapp: "08037770005", customerName: "Retry Person", address: "55 Retry Lane" }))).json() as { orderId: number };
  assert.equal(a.orderId, b.orderId);
  const rows = await db.select().from(orders).where(eq(orders.idempotencyKey, k));
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].riskFlags, []);
});

test("concurrent identical submissions create one order and no self-referencing flag", async () => {
  ok();
  const k = crypto.randomUUID();
  const body = payload(k, { phone: "08037770006", whatsapp: "08037770006", customerName: "Race Person", address: "66 Race Lane" });
  const results = await Promise.all([post(body), post(body), post(body)]);
  assert.deepEqual(results.map((r) => r.status), [200, 200, 200]);
  const ids = new Set((await Promise.all(results.map((r) => r.json()))).map((j) => (j as { orderId: number }).orderId));
  assert.equal(ids.size, 1);
  const rows = await db.select().from(orders).where(eq(orders.idempotencyKey, k));
  assert.equal(rows.length, 1);
  assert.ok(!rows[0].riskFlags.includes("probable_duplicate"));
});

test("flags accumulate without repeating (failed token + duplicate)", async () => {
  ok();
  const k1 = crypto.randomUUID(), k2 = crypto.randomUUID();
  const same = { phone: "08037770007", whatsapp: "08037770007", customerName: "Flag Mix", address: "7 Mix Road" };
  await post(payload(k1, same));
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!String(input).includes("challenges.cloudflare.com")) return realFetch(input, init);
    return new Response(JSON.stringify({ success: false, "error-codes": ["invalid-input-response"] }), { headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  assert.equal((await post(payload(k2, same))).status, 200);
  const b = await row(k2);
  assert.deepEqual([...b.riskFlags].sort(), ["bot_check_failed", "probable_duplicate"]);
});
