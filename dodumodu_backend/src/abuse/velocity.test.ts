// Burst detection, proven against a REAL database.
//
// These are not unit tests with a stubbed Db. Every claim here is about SQL that
// only PostgreSQL can settle - a window computed by now(), a DISTINCT over
// nullable columns, a ratio - and a stub would answer all of them trivially and
// wrongly. That is not hypothetical: the outcome-counter bug in Phase 6 sat behind
// 31 passing stub tests for a whole phase because a stub cannot render SQL.
//
// Skipped, loudly, when no database is configured. A test that quietly passes
// without running is worse than no test.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { registerDbDriver, createDb } from "../db";
import { pgDriver } from "../dbDrivers/pg";
import { abuseConfigFrom, type AbuseConfig } from "./config";
import { evaluateBurst, decideDeviceBurst, decideIpBurst } from "./velocity";

const url = process.env.DATABASE_URL;
const live = Boolean(url);
const cfg = (over: Partial<AbuseConfig> = {}): AbuseConfig =>
  ({ ...abuseConfigFrom({ RL_AUTO_BLOCK: "on", RL_V2_ENABLED: "on" }), ...over });

registerDbDriver(pgDriver);
const db: any = live ? createDb(url as string) : null;

let seq = 0;
const uniq = () => `t${Date.now().toString(36)}${(seq++).toString(36)}`;

/**
 * Inserts a committed order directly, bypassing the endpoint.
 *
 * Deliberate, and only here. These tests need to control `created_at` precisely -
 * to place orders minutes and hours apart - which no HTTP call can do. Everything
 * the rules read (device_id, created_from_ip, phone_norm, created_at) is written
 * exactly as orderService writes it, so the rows are indistinguishable from real
 * ones. Each is marked so cleanup can find them without touching real orders.
 */
async function seed(opts: { device?: string | null; ip?: string | null; phone: string; ageSeconds?: number }) {
  await db.execute(sql`
    INSERT INTO orders (
      idempotency_key, customer_name, phone, phone_norm, whatsapp, address, state, product_id,
      delivery_fee_type, delivery_date, flagged_late, payment_method, quantity,
      unit_price, subtotal, discount_percent, discount_amount, amount, currency,
      reference, status, created_from_ip, device_id, client_kind, created_at
    ) VALUES (
      ${`p6-${uniq()}`}, 'BURST TEST', ${opts.phone}, ${opts.phone},
      ${opts.phone}, '1 Test Road, Lagos', 'Lagos', 1, 'free', 'today', false,
      'cod', 1, 100, 100, 0, 0, 100, 'NGN', ${`p6-${uniq().toLowerCase()}`},
      'confirmed_cod', ${opts.ip ?? null}, ${opts.device ?? null}, 'browser',
      now() - make_interval(secs => ${opts.ageSeconds ?? 0})
    )
  `);
}

before(async () => {
  if (!live) return;
  await db.execute(sql`DELETE FROM orders WHERE customer_name = 'BURST TEST'`);
});
after(async () => {
  if (!live) return;
  await db.execute(sql`DELETE FROM orders WHERE customer_name = 'BURST TEST'`);
});

// ---------------------------------------------------------------------------
// The safety property the whole design rests on.
// ---------------------------------------------------------------------------

test("a crowd of separate real devices NEVER matches, however busy", async (t) => {
  if (!live) return t.skip("no DATABASE_URL");
  const ip = `198.51.100.${1 + (seq % 200)}`;
  const N = 14; // well past both rules' order floors
  for (let i = 0; i < N; i++) {
    // One order each, each on its OWN device, each a different person. This is the
    // shape of a shared carrier NAT or a flash sale, and it is the one V2 must never
    // touch: the concentration ratio is 1/N, nowhere near the floor.
    await seed({ device: `crowd-${uniq()}-${i}`, ip, phone: `0809000${String(1000 + i)}` });
  }
  const decision = await evaluateBurst(db, cfg(), { ip, deviceId: null });
  assert.equal(decision.matched, false, "a crowd must never match");
  assert.match(decision.arithmetic, /orders from one address/);
  assert.match(decision.arithmetic, /distinct devices/, "the arithmetic must show the device spread");
  assert.ok(
    decision.shortOf.some((s) => s.includes("concentration")),
    `expected concentration to be the blocker, got: ${JSON.stringify(decision.shortOf)}`,
  );
});

// ---------------------------------------------------------------------------
// V1 — the rule that should fire.
// ---------------------------------------------------------------------------

test("V1 fires: one device, several identities, inside the window", async (t) => {
  if (!live) return t.skip("no DATABASE_URL");
  const device = `bot-${uniq()}`;
  // Three committed orders (below the floor of 4) across three identities.
  for (let i = 0; i < 3; i++) await seed({ device, ip: null, phone: `0809111${String(100 + i)}` });

  const before = await evaluateBurst(db, cfg(), { ip: null, deviceId: device });
  assert.equal(before.matched, false, "three orders must not reach a floor of four");

  // The fourth order COMMITS - refuse-at-N+1 means the threshold order completes.
  await seed({ device, ip: null, phone: "0809111122" });

  const after = await evaluateBurst(db, cfg(), { ip: null, deviceId: device });
  assert.equal(after.matched, true, "the fifth attempt must see the burst");
  assert.equal(after.rule, "v1_device");
  assert.equal(after.scope, "device", "V1 blocks a DEVICE, never the address");
  assert.equal(after.subject, device);
  assert.match(after.arithmetic, /4 orders on one device in 60s/);
  // Four orders were seeded with four DIFFERENT numbers, so the identity count is 4.
  assert.match(after.arithmetic, /4 distinct numbers/);
});

test("one person retrying payment cannot match V1 - only ONE identity", async (t) => {
  if (!live) return t.skip("no DATABASE_URL");
  const device = `retry-${uniq()}`;
  // Ten attempts, same person, same number. This is the fastest realistic false
  // positive there is: a card that keeps declining.
  for (let i = 0; i < 10; i++) await seed({ device, ip: null, phone: "0809222333" });
  const decision = await evaluateBurst(db, cfg(), { ip: null, deviceId: device });
  assert.equal(decision.matched, false, "retries are not abuse");
  assert.match(decision.arithmetic, /1 distinct numbers/);
  assert.ok(decision.shortOf.some((s) => s.startsWith("distinct numbers")),
    `identity count must be the blocker: ${JSON.stringify(decision.shortOf)}`);
});

// ---------------------------------------------------------------------------
// V2 — id-less bot, and the rotating-id gap.
// ---------------------------------------------------------------------------

test("V2 fires for an id-less bot: many identities, no device to spread across", async (t) => {
  if (!live) return t.skip("no DATABASE_URL");
  const ip = `203.0.113.${1 + (seq % 250)}`;
  for (let i = 0; i < 10; i++) {
    await seed({ device: null, ip, phone: `0809333${String(100 + i)}` });
  }
  const decision = await evaluateBurst(db, cfg(), { ip, deviceId: null });
  assert.equal(decision.matched, true, "an id-less burst must be caught by V2");
  assert.equal(decision.rule, "v2_ip");
  assert.equal(decision.scope, "ip");
  assert.match(decision.arithmetic, /10 orders from one address/);
  assert.match(decision.arithmetic, /10 with no device/, "the no-device mass must be visible");
});

test("a rotating-id bot is recorded as a GAP, never as a match", async (t) => {
  if (!live) return t.skip("no DATABASE_URL");
  const ip = `203.0.113.${1 + (seq % 250)}`;
  for (let i = 0; i < 12; i++) {
    // A fresh device each time, from one address. Indistinguishable from a crowd by
    // any honest measure, so the system must say so rather than pick a side.
    await seed({ device: `rot-${uniq()}-${i}`, ip, phone: `0809444${String(100 + i)}` });
  }
  const decision = await evaluateBurst(db, cfg(), { ip, deviceId: null });
  assert.equal(decision.matched, false, "rotating ids must not be blocked");
  assert.equal(decision.rotatingIds, true, "but the gap must be reported");
});

test("V2 is not consulted at all while RL_V2_ENABLED is off", async (t) => {
  if (!live) return t.skip("no DATABASE_URL");
  const ip = `203.0.113.${1 + (seq % 250)}`;
  for (let i = 0; i < 10; i++) await seed({ device: null, ip, phone: `0809555${String(100 + i)}` });
  const decision = await evaluateBurst(db, cfg({ v2Enabled: false }), { ip, deviceId: null });
  assert.equal(decision.matched, false);
  assert.match(decision.shortOf.join(" "), /V2 is disabled/);
});

// ---------------------------------------------------------------------------
// The rule the user asked to be proven: time is the whole difference.
// ---------------------------------------------------------------------------

test("SAME volume spread over minutes never blocks - only the window matters", async (t) => {
  if (!live) return t.skip("no DATABASE_URL");
  const device = `slow-${uniq()}`;
  // Identical shape to the V1 case above: one device, four identities. The ONLY
  // difference is they are four minutes old instead of four seconds.
  for (let i = 0; i < 4; i++) {
    await seed({ device, ip: null, phone: `0809666${String(100 + i)}`, ageSeconds: 240 + i * 20 });
  }
  const decision = await evaluateBurst(db, cfg(), { ip: null, deviceId: device });
  assert.equal(decision.matched, false,
    "orders spread over time are not a burst, however many there are");
  assert.equal(decision.arithmetic, "0 orders on one device in 60s (floor 4), 0 distinct numbers (floor 3)",
    `the window must exclude every one of them: ${decision.arithmetic}`);
});

test("hours apart, from one address, never blocks either", async (t) => {
  if (!live) return t.skip("no DATABASE_URL");
  const ip = `203.0.113.${1 + (seq % 250)}`;
  for (let i = 0; i < 12; i++) {
    await seed({ device: null, ip, phone: `0809777${String(100 + i)}`, ageSeconds: 3600 + i * 120 });
  }
  const decision = await evaluateBurst(db, cfg(), { ip, deviceId: null });
  assert.equal(decision.matched, false, "cumulative volume across hours is not a burst");
});

// ---------------------------------------------------------------------------
// The kill switch, and the null-address rule.
// ---------------------------------------------------------------------------

test("RL_AUTO_BLOCK=off does not even query", async (t) => {
  if (!live) return t.skip("no DATABASE_URL");
  const device = `off-${uniq()}`;
  for (let i = 0; i < 6; i++) await seed({ device, ip: null, phone: `0809888${String(100 + i)}` });
  const decision = await evaluateBurst(db, cfg({ autoBlock: "off" }), { ip: null, deviceId: device });
  assert.equal(decision.matched, false);
  assert.equal(decision.arithmetic, "", "off must cost nothing and say nothing");
});

test("a null address is never grouped, counted or blocked", async (t) => {
  if (!live) return t.skip("no DATABASE_URL");
  const device = `nullip-${uniq()}`;
  for (let i = 0; i < 6; i++) await seed({ device, ip: null, phone: `0809999${String(100 + i)}` });
  // V1 still works - it needs a device, not an address.
  const withDevice = await evaluateBurst(db, cfg(), { ip: null, deviceId: device });
  assert.equal(withDevice.matched, true, "V1 does not depend on the address");

  // And V2 is unreachable without one.
  const noSubject = await evaluateBurst(db, cfg(), { ip: null, deviceId: null });
  assert.equal(noSubject.matched, false);
  assert.equal(noSubject.subject, null, "nothing may be invented to act on");
});

test("the kill switch defaults to shadow, which blocks nothing", () => {
  assert.equal(abuseConfigFrom({}).autoBlock, "shadow");
  assert.equal(abuseConfigFrom({ RL_AUTO_BLOCK: "on" }).autoBlock, "on");
  // A typo must never be the reason a customer is refused.
  assert.equal(abuseConfigFrom({ RL_AUTO_BLOCK: "ON " }).autoBlock, "shadow");
  assert.equal(abuseConfigFrom({ RL_AUTO_BLOCK: "true" }).autoBlock, "shadow");
});

test("the burst window is floored at 30 seconds", () => {
  assert.equal(abuseConfigFrom({}).velocityWindowSeconds, 60);
  assert.equal(abuseConfigFrom({ RL_VELOCITY_WINDOW_SECONDS: "5" }).velocityWindowSeconds, 30);
  assert.equal(abuseConfigFrom({ RL_VELOCITY_WINDOW_SECONDS: "45" }).velocityWindowSeconds, 45);
});

test("V2 is off by default, independently of the kill switch", () => {
  assert.equal(abuseConfigFrom({}).v2Enabled, false);
  assert.equal(abuseConfigFrom({ RL_V2_ENABLED: "on" }).v2Enabled, true);
  // The dangerous combination - refusing AND V2 - needs both switches.
  assert.equal(abuseConfigFrom({ RL_AUTO_BLOCK: "on" }).v2Enabled, false);
});

test("only real WhatsApp hosts are accepted for the 429 link", () => {
  const u = (v: string | undefined) => abuseConfigFrom({ SUPPORT_WHATSAPP_URL: v }).supportWhatsappUrl;
  assert.equal(u(undefined), null);
  assert.equal(u(""), null);
  assert.equal(u("   "), null);
  assert.equal(u("https://wa.me/2348012345678"), "https://wa.me/2348012345678");
  assert.match(u("https://api.whatsapp.com/send?phone=23480") ?? "", /api\.whatsapp\.com/);
  // Everything else is dropped rather than rendered.
  assert.equal(u("javascript:alert(1)"), null);
  assert.equal(u("http://wa.me/23480"), null, "http is not accepted");
  assert.equal(u("https://evil.example.com/wa.me"), null);
  assert.equal(u("not a url"), null);
});

test("the pure decisions refuse to invent a subject", () => {
  const empty = decideDeviceBurst({ orders: 0, phones: 0 }, cfg(), "d");
  assert.equal(empty.subject, null);
  assert.equal(empty.scope, null);
  const ip = decideIpBurst(
    { orders: 0, phones: 0, devices: 0, noDevice: 0, topDeviceOrders: 0, concentration: 0, rotatingIds: false },
    cfg(), "1.2.3.4");
  assert.equal(ip.matched, false);
});
