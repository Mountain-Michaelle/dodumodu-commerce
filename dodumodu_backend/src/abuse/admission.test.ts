// The admission decision - the only code in the application that can refuse an
// order automatically - tested against a REAL database for its three switch
// positions (off / shadow / on), plus the fail-open and already-blocked paths.
//
// The control flow here is the product: what each position of RL_AUTO_BLOCK does,
// what gets logged, what gets persisted, and what the customer is told. A stubbed
// Db could answer all of that trivially and wrongly - the same reason
// velocity.test.ts refuses stubs - so every decision path below is driven through
// real SQL, except fail-open, where the whole point is that the SQL is broken.
//
// Skipped, loudly, when no database is configured.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { registerDbDriver, createDb, type Db } from "../db";
import { pgDriver } from "../dbDrivers/pg";
import { abuseConfigFrom, type AbuseConfig } from "./config";
import { decideAdmission, type Admission } from "./admission";

const url = process.env.DATABASE_URL;
const live = Boolean(url);
const cfg = (over: Partial<AbuseConfig> = {}): AbuseConfig =>
  ({ ...abuseConfigFrom({ RL_AUTO_BLOCK: "on", RL_V2_ENABLED: "on" }), ...over });

registerDbDriver(pgDriver);
const db: any = live ? createDb(url as string) : null;

// Each run owns a throwaway product, so the suite works on a database that does not hold id 1.
let productId = 0;
let seq = 0;
const uniq = () => `a${Date.now().toString(36)}${(seq++).toString(36)}`;

/** Every event a run logged, in order. Reset before each decision. */
let log: Record<string, unknown>[] = [];
const capture = (event: Record<string, unknown>) => { log.push(event); };
const events = () => log.map((e) => e.event);

/** Same seeding as velocity.test.ts - the rules read exactly these columns. */
async function seed(device: string, phone: string) {
  await db.execute(sql`
    INSERT INTO orders (
      idempotency_key, customer_name, phone, phone_norm, whatsapp, address, state, product_id,
      delivery_fee_type, delivery_date, flagged_late, payment_method, quantity,
      unit_price, subtotal, discount_percent, discount_amount, amount, currency,
      reference, status, created_from_ip, device_id, client_kind, created_at
    ) VALUES (
      ${`p6-${uniq()}`}, 'ADMISSION TEST', ${phone}, ${phone},
      ${phone}, '1 Test Road, Lagos', 'Lagos', ${productId}, 'free', 'today', false,
      'cod', 1, 100, 100, 0, 0, 100, 'NGN', ${`p6-${uniq().toLowerCase()}`},
      'confirmed_cod', null, ${device}, 'browser', now()
    )
  `);
}

/** Four committed orders from four identities on one device: V1's floor is four. */
async function seedBurst(device: string) {
  for (let i = 0; i < 4; i++) await seed(device, `0809222${String(100 + i)}`);
}

before(async () => {
  if (!live) return;
  await db.execute(sql`DELETE FROM orders WHERE customer_name = 'ADMISSION TEST'`);
  await db.execute(sql`DELETE FROM moderation_blocks WHERE scope = 'device' AND value LIKE 'adm-%'`);
  const rows = await db.execute(sql`
    INSERT INTO products (slug, name, description, price)
    VALUES (${`admission-fixture-${Date.now().toString(36)}`}, 'Admission fixture', 'x', 100000) RETURNING id`);
  productId = ((rows as unknown as { rows?: { id: number }[] }).rows ?? (rows as unknown as { id: number }[]))[0].id;
});
after(async () => {
  if (!live) return;
  await db.execute(sql`DELETE FROM orders WHERE customer_name = 'ADMISSION TEST'`);
  await db.execute(sql`DELETE FROM moderation_blocks WHERE scope = 'device' AND value LIKE 'adm-%'`);
  if (productId) await db.execute(sql`DELETE FROM products WHERE id = ${productId}`);
});

// ---------------------------------------------------------------------------
// The kill switch, position by position. This is the whole contract.
// ---------------------------------------------------------------------------

test("RL_AUTO_BLOCK=off: a matched burst rule refuses nobody and writes nothing", async (t) => {
  if (!live) return t.skip("no DATABASE_URL");
  const device = `adm-off-${uniq()}`;
  await seedBurst(device);
  log = [];
  const decision = await decideAdmission(db, cfg({ autoBlock: "off" }), { ip: null, deviceId: device }, capture);

  assert.equal(decision.allowed, true, "off means off - no refusal");
  const rows = await db.execute(sql`SELECT 1 FROM moderation_blocks WHERE scope = 'device' AND value = ${device}`);
  assert.equal(rows.rows.length, 0, "off must not persist a block");
  assert.ok(!events().includes("abuse_would_block"), "off is not even shadow");
});

test("RL_AUTO_BLOCK=shadow: logs abuse_would_block, allows, persists nothing", async (t) => {
  if (!live) return t.skip("no DATABASE_URL");
  const device = `adm-shadow-${uniq()}`;
  await seedBurst(device);
  log = [];
  const decision = await decideAdmission(db, cfg({ autoBlock: "shadow" }), { ip: null, deviceId: device }, capture);

  assert.equal(decision.allowed, true, "shadow never refuses");
  assert.ok(events().includes("abuse_would_block"), `expected abuse_would_block, got ${events().join(",")}`);
  const shadow = log.find((e) => e.event === "abuse_would_block");
  assert.equal(shadow?.mode, "shadow");
  assert.equal(shadow?.note, "nothing was refused");
  assert.equal(typeof shadow?.arithmetic, "string", "the arithmetic must be readable later");
  const rows = await db.execute(sql`SELECT 1 FROM moderation_blocks WHERE scope = 'device' AND value = ${device}`);
  assert.equal(rows.rows.length, 0, "shadow must not persist a block");
});


test("RL_AUTO_BLOCK=on: refuses with the neutral 429 and persists the block", async (t) => {
  if (!live) return t.skip("no DATABASE_URL");
  const device = `adm-enforce-${uniq()}`;
  await seedBurst(device);
  log = [];
  const decision = await decideAdmission(db, cfg({ autoBlock: "on" }), { ip: null, deviceId: device }, capture);

  assert.equal(decision.allowed, false);
  const refused = decision as Extract<Admission, { allowed: false }>;
  assert.equal(refused.response.status, 429);
  assert.equal(refused.response.body.error, "ORDER_NOT_ACCEPTED");
  assert.ok(refused.response.body.retryAfterSeconds > 0, "the customer needs a real countdown");
  // The customer is never told what caught them.
  assert.ok(!/spam|device|bot|burst|v1|v2|rule/i.test(refused.response.body.message),
    `message must stay neutral: ${refused.response.body.message}`);
  // The operator gets the arithmetic - the detail is logged, not shown.
  assert.match(refused.detail, /orders on one device/);

  const rows = await db.execute(sql`
    SELECT source, blocked_by, reason, active, evidence
    FROM moderation_blocks WHERE scope = 'device' AND value = ${device}
  `);
  assert.equal(rows.rows.length, 1, "enforce must persist exactly one block");
  const row: any = rows.rows[0];
  assert.equal(row.source, "auto_v1", "a device burst is the v1 rule");
  assert.equal(row.blocked_by, "system:burst", "nobody human typed this");
  assert.equal(row.active, true);
  assert.match(row.reason, /Automatic v1_device burst block/);
  assert.equal(typeof row.evidence?.arithmetic, "string", "evidence must survive for the audit");
  assert.ok(events().includes("abuse_block_created"));
});

test("an already-blocked device is refused WITHOUT consulting the burst rules", async (t) => {
  if (!live) return t.skip("no DATABASE_URL");
  const device = `adm-blocked-${uniq()}`;
  // Seed orders that would NOT match (one order only) - if the burst rules were
  // consulted here, nothing would be found and the request would be allowed.
  await seed(device, "08093330001");
  await db.execute(sql`
    INSERT INTO moderation_blocks (scope, value, reason, source, blocked_by, expires_at)
    VALUES ('device', ${device}, 'pre-existing block for this test', 'manual',
            'admin@dodumodu.local', now() + make_interval(secs => 300))
  `);
  log = [];
  const decision = await decideAdmission(db, cfg({ autoBlock: "off" }), { ip: null, deviceId: device }, capture);

  // autoBlock is OFF here on purpose: the block lookup runs before the switch is
  // ever consulted, so a block made by a human is honoured even with the rules off.
  assert.equal(decision.allowed, false, "an active block refuses regardless of the burst switch");
  const refused = decision as Extract<Admission, { allowed: false }>;
  assert.ok(refused.response.body.retryAfterSeconds > 0 && refused.response.body.retryAfterSeconds <= 300,
    `countdown must come from the block's expiry, got ${refused.response.body.retryAfterSeconds}`);
  assert.ok(events().includes("moderation_block_hit"));
});

test("fail-open: a broken block lookup allows the order and logs the error", async () => {
  const broken = {
    execute: async () => { throw new Error("connection refused"); },
  } as unknown as Db;
  log = [];
  const decision = await decideAdmission(broken, cfg({ autoBlock: "on" }), { ip: "203.0.113.7", deviceId: null }, capture);

  assert.equal(decision.allowed, true, "the whole point: an unwell abuse layer costs nobody an order");
  assert.ok(events().includes("abuse_system_error"));
  const err = log.find((e) => e.event === "abuse_system_error");
  assert.equal(err?.stage, "block_lookup");
  assert.match(String(err?.detail), /connection refused/, "the error itself must reach the log");
});

test("the refusal carries the support contact only when one is configured", async (t) => {
  if (!live) return t.skip("no DATABASE_URL");
  const withUrl = `adm-url-${uniq()}`;
  await seedBurst(withUrl);
  const withDecision = await decideAdmission(
    db, cfg({ autoBlock: "on", supportWhatsappUrl: "https://wa.me/2348012345678" }),
    { ip: null, deviceId: withUrl }, capture,
  );
  assert.equal((withDecision as any).response?.body?.contactUrl, "https://wa.me/2348012345678");

  const withoutUrl = `adm-nourl-${uniq()}`;
  await seedBurst(withoutUrl);
  const withoutDecision = await decideAdmission(
    db, cfg({ autoBlock: "on", supportWhatsappUrl: null }),
    { ip: null, deviceId: withoutUrl }, capture,
  );
  assert.equal((withoutDecision as any).response?.body?.contactUrl, null,
    "no configured number means no link, never a guessed one");
});
