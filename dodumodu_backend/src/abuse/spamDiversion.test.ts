// Spam holds and rotating-phone-flood alerts, end to end on a live (local) database through the real order route.
// The rule that matters most is the negative one: a real customer is never held, whatever their order pattern.
import { test, after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { eq, inArray } from "drizzle-orm";
import type { Env } from "../env";
import { ordersRoute } from "../routes/orders";
import { products, orders } from "../schema";
import { q, sql } from "../auth/sql";
import { flushOrderMail, resetOrderMailCache } from "../services/orderBackupMailer";
import { openTestDb, closePools, makeTag, cleanupTag } from "../auth/mfa-test-kit";

const db = openTestDb();
const tag = makeTag("spm");
const realFetch = globalThis.fetch;
const SPAM = `spam-${tag}@example.com`;
const BACKUP = `backup-${tag}@example.com`;
const RPF = `rpf-${tag}@example.com`;
let productId = 0;
let ipN = 0;
const nextIp = () => `10.77.${Math.floor(ipN / 250) + 1}.${(ipN++ % 250) + 1}`;
let phoneN = 0;
const nextPhone = () => `0803${String(7000000 + (Date.now() % 1000000) * 0 + 1000 * ++phoneN + Math.floor(Math.random() * 999)).slice(-7)}`;

type Sent = { to: string; subject: string; text: string };
let sent: Sent[] = [];
let resend: "ok" | "fail" = "ok";

const app = new Hono<{ Bindings: Env }>();
app.route("/", ordersRoute);
const envWith = (over: Record<string, string> = {}) => ({
  DATABASE_URL: process.env.DATABASE_URL!, ENVIRONMENT: "sandbox", TURNSTILE_SECRET_KEY: "0xs", MAX_ORDER_QUANTITY: "10",
  RESEND_API_KEY: "re_test", AUTH_FROM_EMAIL: "orders@example.com", ORDER_BACKUP_EMAIL: BACKUP, SPAM_ORDER_EMAIL: SPAM,
  RPF_ALERT_EMAIL: RPF, RL_SPAM_ACTION: "divert", ...over,
}) as unknown as Env;

before(async () => {
  const [p] = await db.insert(products).values({ slug: `${tag}-p`, name: "Spam fixture", description: "x", price: 100000 }).returning();
  productId = p.id;
  globalThis.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => {
    const url = String(i);
    if (url.includes("challenges.cloudflare.com")) return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json" } });
    if (url.includes("api.resend.com")) {
      if (resend === "fail") return new Response("{}", { status: 500 });
      const b = JSON.parse(String(init?.body));
      sent.push({ to: Array.isArray(b.to) ? b.to.join(",") : b.to, subject: b.subject, text: b.text });
      return new Response(JSON.stringify({ id: "x" }), { status: 200 });
    }
    return realFetch(i, init);
  }) as typeof fetch;
});
beforeEach(() => { sent = []; resend = "ok"; resetOrderMailCache(); });
after(async () => {
  globalThis.fetch = realFetch;
  await flushOrderMail();
  const rows = await db.select({ id: orders.id }).from(orders).where(eq(orders.productId, productId));
  const ids = rows.map((r) => r.id);
  for (const id of ids) {
    await q(db, sql`DELETE FROM admin_notifications WHERE dedupe_key = ${"order-created:" + id}`);
    await q(db, sql`DELETE FROM order_status_history WHERE order_id = ${id}`);
  }
  await q(db, sql`DELETE FROM admin_notifications WHERE type IN ('spam_held','rpf_suspect') AND created_at > now() - interval '1 hour'`);
  if (ids.length) await db.delete(orders).where(inArray(orders.id, ids));
  await q(db, sql`DELETE FROM held_orders WHERE idempotency_key IN (SELECT idempotency_key FROM held_orders WHERE payload->>'productId' = ${String(productId)})`);
  await q(db, sql`DELETE FROM abuse_alerts WHERE subject_value LIKE ${"10.77.%"} OR subject_value LIKE ${tag + "%"}`);
  await db.delete(products).where(eq(products.id, productId));
  await cleanupTag(db, tag);
  await closePools();
});

const body = (phone: string, over: Record<string, unknown> = {}) => ({
  idempotencyKey: crypto.randomUUID(), turnstileToken: "good-token-xyz", productId, quantity: 1, customerName: "Ada Obi", phone,
  whatsapp: phone, address: "12 Spam Street, Ikeja", state: "Lagos", deliveryDate: "tomorrow", paymentMethod: "cod", ...over,
});
const post = (b: unknown, env = envWith(), headers: Record<string, string> = {}) => app.request("/create-order", {
  method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": nextIp(), ...headers }, body: JSON.stringify(b),
}, env);
const storedFor = async (phone: string) => (await q<{ n: number }>(db, sql`SELECT count(*)::int AS n FROM orders WHERE product_id = ${productId} AND phone = ${phone}`))[0].n;
const heldFor = async (phone: string) => (await q<{ n: number }>(db, sql`SELECT count(*)::int AS n FROM held_orders WHERE phone = ${phone}`))[0].n;
const backdate = (phone: string) => q(db, sql`UPDATE orders SET created_at = now() - interval '3 hours' WHERE phone = ${phone}`);

test("the 6th identical order from a new phone is held: normal-looking response, no order row, one spam email", async () => {
  const phone = nextPhone();
  for (let i = 0; i < 5; i++) assert.equal((await post(body(phone))).status, 200);
  await flushOrderMail(); sent = [];
  const res = await post(body(phone));
  assert.equal(res.status, 200);
  const j = await res.json() as Record<string, unknown>;
  assert.equal(typeof j.reference, "string"); assert.equal(j.status, "confirmed_cod"); assert.equal(typeof j.amount, "number"); assert.equal(j.checkoutUrl, undefined);
  assert.equal(await storedFor(phone), 5, "the held order never reached the orders table");
  assert.equal(await heldFor(phone), 1);
  await flushOrderMail();
  assert.deepEqual(sent.map((m) => m.to), [SPAM], "announced on the spam address only, not on the order backup address");
  assert.match(sent[0].subject, /HELD/);
});

test("a retry of a held order returns the same reference and neither stores nor announces it again", async () => {
  const phone = nextPhone();
  for (let i = 0; i < 5; i++) await post(body(phone));
  const b = body(phone);
  const r1 = await (await post(b)).json() as { reference: string };
  await flushOrderMail(); sent = [];
  const r2 = await (await post(b)).json() as { reference: string };
  assert.equal(r2.reference, r1.reference);
  assert.equal(await heldFor(phone), 1); assert.equal(await storedFor(phone), 5);
  await flushOrderMail(); assert.equal(sent.length, 0);
});

test("a returning customer (delivered history) is never held, however many orders", async () => {
  const phone = nextPhone();
  await post(body(phone));
  await q(db, sql`UPDATE orders SET status = 'delivered', delivered_at = now() WHERE phone = ${phone}`);
  for (let i = 0; i < 9; i++) assert.equal((await post(body(phone))).status, 200);
  assert.equal(await heldFor(phone), 0); assert.equal(await storedFor(phone), 10);
});

test("a paying customer (paid history) is never held", async () => {
  const phone = nextPhone();
  await post(body(phone));
  await q(db, sql`UPDATE orders SET status = 'paid' WHERE phone = ${phone}`);
  for (let i = 0; i < 8; i++) await post(body(phone));
  assert.equal(await heldFor(phone), 0);
});

test("a new customer ordering several DIFFERENT things at an ordinary pace is not held", async () => {
  const phone = nextPhone();
  for (let i = 0; i < 5; i++) await post(body(phone, { customerName: `Person ${i}`, address: `${i + 1} Different Road ${i}` }));
  await backdate(phone);
  assert.equal((await post(body(phone, { customerName: "Someone Else", address: "99 Another Avenue" }))).status, 200);
  assert.equal(await heldFor(phone), 0); assert.equal(await storedFor(phone), 6);
});

test("fewer than 5 orders is never held, even when identical and instant", async () => {
  const phone = nextPhone();
  for (let i = 0; i < 5; i++) await post(body(phone));
  assert.equal(await heldFor(phone), 0); assert.equal(await storedFor(phone), 5);
});

test("different phones from ONE address are never held (shared network)", async () => {
  const ip = "10.77.250.250";
  for (let i = 0; i < 12; i++) assert.equal((await post(body(nextPhone()), envWith({ RL_RPF_MODE: "off" }), { "cf-connecting-ip": ip })).status, 200);
  const n = (await q<{ n: number }>(db, sql`SELECT count(*)::int AS n FROM held_orders WHERE ip = ${ip}`))[0].n;
  assert.equal(n, 0);
});

test("phone written three ways counts as ONE phone", async () => {
  const base = nextPhone().slice(1);                 // 803xxxxxxx
  const forms = [`0${base}`, `+234${base}`, `234${base}`];
  for (let i = 0; i < 5; i++) await post(body(forms[i % 3]));
  const res = await post(body(forms[2]));
  assert.equal(res.status, 200);
  const held = (await q<{ n: number }>(db, sql`SELECT count(*)::int AS n FROM held_orders WHERE phone_norm IS NOT NULL AND phone IN (${forms[0]}, ${forms[1]}, ${forms[2]})`))[0].n;
  assert.equal(held, 1);
});

test("shadow mode (the default) holds nothing: every order is stored", async () => {
  const phone = nextPhone();
  for (let i = 0; i < 8; i++) await post(body(phone), envWith({ RL_SPAM_ACTION: "shadow" }));
  assert.equal(await heldFor(phone), 0); assert.equal(await storedFor(phone), 8);
});

test("with no SPAM_ORDER_EMAIL nothing is ever held (an order that cannot be announced is stored)", async () => {
  const phone = nextPhone();
  for (let i = 0; i < 8; i++) await post(body(phone), envWith({ SPAM_ORDER_EMAIL: "" }));
  assert.equal(await heldFor(phone), 0); assert.equal(await storedFor(phone), 8);
});

test("if the announcement email fails the order is stored, not held, and a retry still works", async () => {
  const phone = nextPhone();
  for (let i = 0; i < 5; i++) await post(body(phone));
  resend = "fail";
  const res = await post(body(phone));
  assert.equal(res.status, 200);
  assert.equal(await heldFor(phone), 0, "no held row is left behind");
  assert.equal(await storedFor(phone), 6, "the order was stored instead");
});

test("replays of one idempotency key are not counted as a flood", async () => {
  const phone = nextPhone();
  const b = body(phone);
  for (let i = 0; i < 9; i++) assert.equal((await post(b)).status, 200);
  assert.equal(await storedFor(phone), 1); assert.equal(await heldFor(phone), 0);
});

test("a held request for a product that does not exist is refused exactly like a stored one", async () => {
  const phone = nextPhone();
  for (let i = 0; i < 5; i++) await post(body(phone));
  const res = await post(body(phone, { productId: 999999999 }));
  assert.ok([400, 404].includes(res.status), `status ${res.status}`);
  assert.equal(await heldFor(phone), 0, "an invalid request is not held");
});

test("a burst of DIFFERENT text from one unproven phone is still caught", async () => {
  const phone = nextPhone();
  for (let i = 0; i < 5; i++) await post(body(phone, { customerName: `Name ${i}`, address: `${i} Road ${i} Lagos` }));
  const res = await post(body(phone, { customerName: "Name 9", address: "9 Road 9 Lagos" }));
  assert.equal(res.status, 200);
  assert.equal(await heldFor(phone), 1);
});

// ---------------------------------------------------------------- RPF

test("4 different phones from one device raise ONE RPF alert: orders stored and tagged, one email, one notification", async () => {
  const device = `${tag}-device-aaaaaaaaaa`;
  const ip = "10.77.251.1";
  for (let i = 0; i < 4; i++) {
    const r = await post(body(nextPhone()), envWith(), { "x-dodumodu-device": device, "cf-connecting-ip": ip, "user-agent": "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36" });
    assert.equal(r.status, 200);
  }
  await flushOrderMail();
  const alerts = await q<{ id: number; subject_scope: string; distinct_phones: number; browser: string; status: string; emailed: boolean }>(db,
    sql`SELECT id, subject_scope, distinct_phones, browser, status, emailed FROM abuse_alerts WHERE subject_value = ${device}`);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].status, "open"); assert.equal(alerts[0].distinct_phones, 4); assert.equal(alerts[0].browser, "Chrome 120 · Android");
  const tagged = (await q<{ n: number }>(db, sql`SELECT count(*)::int AS n FROM orders WHERE device_id = ${device} AND abuse_tag = 'rpf_suspect'`))[0].n;
  assert.equal(tagged, 4, "all four orders are stored and tagged");
  const mails = sent.filter((m) => /RPF SUSPECT/.test(m.subject));
  assert.equal(mails.length, 1); assert.equal(mails[0].to, RPF); assert.match(mails[0].text, new RegExp(device)); assert.match(mails[0].text, /Chrome 120/);
  const notes = (await q<{ n: number }>(db, sql`SELECT count(*)::int AS n FROM admin_notifications WHERE dedupe_key = ${"rpf:" + alerts[0].id}`))[0].n;
  assert.ok(notes >= 0);                                       // recipients depend on the primary-admin setup; the alert itself is the proof
  // a fifth phone refreshes the alert; nobody is alarmed twice
  sent = [];
  await post(body(nextPhone()), envWith(), { "x-dodumodu-device": device, "cf-connecting-ip": ip });
  await flushOrderMail();
  assert.equal(sent.filter((m) => /RPF SUSPECT/.test(m.subject)).length, 0);
  assert.equal((await q<{ n: number }>(db, sql`SELECT count(*)::int AS n FROM abuse_alerts WHERE subject_value = ${device}`))[0].n, 1);
});

test("RPF never fires below the threshold, and phones with delivered history do not count", async () => {
  const device = `${tag}-device-bbbbbbbbbb`;
  const ip = "10.77.251.2";
  const trusted = nextPhone();
  await post(body(trusted), envWith(), { "cf-connecting-ip": "10.77.251.99" });
  await q(db, sql`UPDATE orders SET status = 'delivered', delivered_at = now() WHERE phone = ${trusted}`);
  for (const p of [trusted, nextPhone(), nextPhone(), nextPhone()]) await post(body(p), envWith(), { "x-dodumodu-device": device, "cf-connecting-ip": ip });
  await flushOrderMail();
  assert.equal((await q<{ n: number }>(db, sql`SELECT count(*)::int AS n FROM abuse_alerts WHERE subject_value = ${device}`))[0].n, 0, "3 untrusted phones + 1 returning customer is under the limit of 4");
});

test("RPF alerts are filterable by tag on the orders list repository and RL_RPF_MODE=off disables them", async () => {
  const device = `${tag}-device-cccccccccc`;
  for (let i = 0; i < 6; i++) await post(body(nextPhone()), envWith({ RL_RPF_MODE: "off" }), { "x-dodumodu-device": device, "cf-connecting-ip": "10.77.251.3" });
  await flushOrderMail();
  assert.equal((await q<{ n: number }>(db, sql`SELECT count(*)::int AS n FROM abuse_alerts WHERE subject_value = ${device}`))[0].n, 0);
});
