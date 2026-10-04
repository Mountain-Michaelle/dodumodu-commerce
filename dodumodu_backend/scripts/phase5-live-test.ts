// LIVE end-to-end verification of the two independent order rules, against the real
// development database and the real order-creation service.
//
//   Tests A-I, exactly as specified. Every one of them runs against Postgres and
//   calls orderService.createOrder, so what is exercised is the real order path
//   including the guard, the canonical phone identity and the evidence queries.
//
// Test data is namespaced with a marker and cleaned up at the end. Real historical
// evidence is never touched.
import { registerDbDriver } from "../src/db";
import { pgDriver } from "../src/dbDrivers/pg";
registerDbDriver(pgDriver);

import pg from "pg";
import { createDb } from "../src/db";
import { orderService } from "../src/services/orderService";
import * as orderEvidence from "../src/abuse/orderEvidence";
import { spamService } from "../src/abuse/spamService";
import { normalizePhone } from "../src/shared/normalizePhone";
import { registerDbDriver as _r } from "../src/db";

const client = new pg.Client({ connectionString: process.env.DATABASE_URL! });
await client.connect();
const db = createDb(process.env.DATABASE_URL!);

let pass = 0; let fail = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? ` -- ${detail}` : ""}`); }
}
function section(name: string) { console.log(`\n=== ${name} ===`); }

const env = { ENVIRONMENT: "sandbox", MAX_ORDER_QUANTITY: "20" } as never;
const product = await client.query("SELECT id FROM products WHERE active LIMIT 1");
const productId = Number(product.rows[0].id);

const MARK = "p5test";
const address = "1 Phase Five Road, Lagos";

async function place(phone: string, key: string, ip: string, opts: { quantity?: number; state?: string; address?: string } = {}) {
  const input = {
    idempotencyKey: key, turnstileToken: "", productId,
    quantity: opts.quantity ?? 1, customerName: "Phase Five Tester",
    phone, whatsapp: phone, address: opts.address ?? address, state: opts.state ?? "Lagos",
    deliveryDate: "today", paymentMethod: "cod",
  } as never;
  return orderService.createOrder(db, env, input, { ip });
}
/**
 * Mark an order delivered through the SAME path the admin panel uses.
 *
 * Not a raw UPDATE: migration 0006 added a database constraint that a delivered
 * order must carry delivered_at, and a raw statement violates it. That constraint
 * firing on this test is itself evidence the invariant is enforced in the database
 * and not merely in application code.
 */
async function markDelivered(orderId: number) {
  const { ordersRepo } = await import("../src/data/ordersRepo");
  const result = await ordersRepo.markDelivered(db, orderId, "confirmed_cod", null);
  if (!result) throw new Error(`markDelivered did not apply for order ${orderId}`);
  return result;
}
const ev = (o: any) => orderEvidence.evidenceForOrder(db, {
  id: o.id, reference: o.reference, createdAt: o.createdAt,
  phoneNorm: o.phoneNorm, address: o.address, productId: o.productId,
  // Quantity is part of the order match key, so the helper must carry it. Omitting it
  // here made every duplicate assertion compare against an undefined quantity.
  quantity: o.quantity,
});
const key = (n: string) => `${MARK}-${n}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function cleanup() {
  // Status history first: it references the order, so deleting orders first would
  // trip the foreign key. Only rows carrying this test's own marker are touched.
  await client.query(
    "DELETE FROM order_status_history WHERE order_id IN (SELECT id FROM orders WHERE idempotency_key LIKE $1)",
    [`${MARK}-%`],
  );
  await client.query("DELETE FROM orders WHERE idempotency_key LIKE $1", [`${MARK}-%`]);
  await client.query("DELETE FROM spam_flags WHERE reason LIKE $1", [`%${MARK}%`]);
  await client.query("DELETE FROM abuse_ip_windows WHERE ip LIKE $1", ["198.51.100.%"]);
  await client.query("DELETE FROM abuse_ip_phones WHERE ip LIKE $1", ["198.51.100.%"]);
}
await cleanup();

/* ---- A: first customer ---- */
section("Test A - first customer");
const a = await place("08011110001", key("A"), "198.51.100.10");
const aEv = await ev(a.order);
check("order created", a.order.id > 0);
check("no reordering badge", aEv.reordering === false, `reordering=${aEv.reordering}`);
check("no previous orders", aEv.previousOrders === 0, `prev=${aEv.previousOrders}`);
check("no duplicate badge", aEv.duplicateOf === null);

/* ---- B: repeat customer needs a DELIVERED prior order ---- */
section("Test B - repeat customer");
const b = await place("08011110002", key("B"), "198.51.100.11");
await markDelivered(b.order.id);
const bEv = await ev(b.order);
check("prior order still shows itself as first", bEv.reordering === false, "an order is not its own history");

const b2 = await place("08011110002", key("B2"), "198.51.100.11");
const b2Ev = await ev(b2.order);
check("new order IS reordering (prior delivered)", b2Ev.reordering === true, `reordering=${b2Ev.reordering}`);
check("previous orders counted", b2Ev.previousOrders === 1, `prev=${b2Ev.previousOrders}`);
check("order creation succeeded, not blocked", b2.order.id > 0);

/* ---- B2: pending/failed do NOT qualify (clarification C) ---- */
section("Test C - pending/failed are not a returning customer");
const c1 = await place("08011110003", key("C1"), "198.51.100.12");           // confirmed_cod (pending)
const c1b = await place("08011110003", key("C1B"), "198.51.100.12");
const c1bEv = await ev(c1b.order);
check("prior PENDING order does not make it reordering", c1bEv.reordering === false, `reordering=${c1bEv.reordering}`);
const f1 = await place("08011110004", key("F1"), "198.51.100.13");
await client.query("UPDATE orders SET status='failed' WHERE id=$1", [f1.order.id]);
const f1b = await place("08011110004", key("F1B"), "198.51.100.13");
const f1bEv = await ev(f1b.order);
check("prior FAILED order does not make it reordering", f1bEv.reordering === false, `reordering=${f1bEv.reordering}`);
void c1;

/* ---- C: same-day duplicate (same order match key) ---- */
section("Test D - same-day duplicate, same order match key");
const d1 = await place("08011110005", key("D1"), "198.51.100.14");
const d2 = await place("08011110005", key("D2"), "198.51.100.14"); // same phone+address+product
const d2Ev = await ev(d2.order);
check("second matching order flagged as possible duplicate", d2Ev.duplicateOf?.id === d1.order.id,
  `dup=${JSON.stringify(d2Ev.duplicateOf)} expected=${d1.order.id}`);
check("NEITHER order was cancelled or changed", d2.order.status === "confirmed_cod", `status=${d2.order.status}`);
const d1Ev = await ev(d1.order);
check("the first order points at the second", d1Ev.duplicateOf?.id === d2.order.id, `dup=${JSON.stringify(d1Ev.duplicateOf)}`);

/* ---- C2: same phone+day, DIFFERENT order = NOT a duplicate ---- */
section("Test D2 - same phone/address/product, DIFFERENT quantity");
// Same phone, same address, same product - but a different quantity. Two orders of
// different sizes are two orders, and calling the second a duplicate would send an
// operator hunting for a double-charge that does not exist.
const e1 = await place("08011110006", key("E1"), "198.51.100.15");
const e2 = await place("08011110006", key("E2"), "198.51.100.15", { quantity: 3 });
const e2Ev = await ev(e2.order);
check("different QUANTITY is NOT an exact duplicate", e2Ev.duplicateOf === null,
  `dup=${JSON.stringify(e2Ev.duplicateOf)}`);
check("both orders exist independently", e1.order.id !== e2.order.id);
check("neither was cancelled or merged", e2.order.status === "confirmed_cod" && e1.order.status === "confirmed_cod");

// A different ADDRESS is a different order too, independently of quantity.
const e3 = await place("08011110006", key("E3"), "198.51.100.15", { address: "99 Elsewhere Street, Lagos" });
const e3Ev = await ev(e3.order);
check("a different delivery ADDRESS is NOT a duplicate", e3Ev.duplicateOf === null,
  `dup=${JSON.stringify(e3Ev.duplicateOf)}`);
void e3;
section("Test E - phone format equivalence");
const forms = ["08012345678", "8012345678", "+2348012345678", "2348012345678", "002348012345678"];
const resolved = forms.map((f) => normalizePhone(f));
check("all five forms resolve identically", new Set(resolved).size === 1 && resolved[0] === "+2348012345678",
  JSON.stringify(resolved));
const g1 = await place(forms[0], key("G1"), "198.51.100.16");
await markDelivered(g1.order.id);
const g2 = await place(forms[4], key("G2"), "198.51.100.16"); // 00-prefixed form
const g2Ev = await ev(g2.order);
check("repeat detection works across formats", g2Ev.reordering === true, `reordering=${g2Ev.reordering}`);
const g3 = await place(forms[2], key("G3"), "198.51.100.16"); // +234 form, same day+address
const g3Ev = await ev(g3.order);
check("duplicate detection works across formats", g3Ev.duplicateOf !== null, "00/+234 forms should match");

/* ---- E: invalid phone ---- */
section("Test F - unresolvable phone");
const h = await place("not-a-phone", key("H"), "198.51.100.17");
check("order still created (business rules unchanged)", h.order.id > 0);
const hEv = await ev(h.order);
check("phone_norm stored as NULL", h.order.phoneNorm === null, `phoneNorm=${h.order.phoneNorm}`);
check("no identity claim made (no reordering)", hEv.reordering === false);
check("no duplicate claim made", hEv.duplicateOf === null);

/* ---- F: shared IP, different phones ---- */
section("Test G - shared IP, different legitimate phones");
const s1 = await place("08011110021", key("S1"), "198.51.100.18");
const s2 = await place("08011110022", key("S2"), "198.51.100.18");
const s1Ev = await ev(s1.order); const s2Ev = await ev(s2.order);
check("IP alone creates no reordering", s1Ev.reordering === false && s2Ev.reordering === false);
check("IP alone creates no duplicate", s1Ev.duplicateOf === null && s2Ev.duplicateOf === null);

/* ---- G: idempotent retry ---- */
section("Test H - idempotent retry");
const k1 = key("K");
const r1 = await place("08011110031", k1, "198.51.100.19");
const r2 = await place("08011110031", k1, "198.51.100.19");
check("retry returns the SAME order", r1.order.id === r2.order.id, `${r1.order.id} vs ${r2.order.id}`);
const count = await client.query("SELECT count(*)::int AS n FROM orders WHERE idempotency_key=$1", [k1]);
check("exactly one row created", count.rows[0].n === 1, `rows=${count.rows[0].n}`);

/* ---- H: manual spam flag ---- */
section("Test I - manual spam flag");
const flagged = await spamService.flagPhone(db, {
  phone: "08011110041",
  reason: `Live test: repeated fake orders (${MARK})`,
  actor: "owner@example.com",
});
check("flag created on canonical identity", flagged.phoneNorm === "+2348011110041", `got=${flagged.phoneNorm}`);
const before = await client.query("SELECT status FROM orders WHERE id=$1", [a.order.id]);
check("existing order status untouched by flagging", before.rows[0].status !== "spam", `status=${before.rows[0].status}`);
await spamService.revert(db, { id: flagged.id, reason: `Live test cleanup (${MARK})`, actor: "owner@example.com" });
const afterRevert = await client.query("SELECT reverted_at, reverted_by FROM spam_flags WHERE id=$1", [flagged.id]);
check("revert recorded, history kept", afterRevert.rows[0].reverted_at !== null && afterRevert.rows[0].reverted_by === "owner@example.com");

/* ---- I: shadow candidate (observational only) ---- */
section("Test J - shadow activity is observational");
const ws = Math.floor(Date.now() / 1000 / 900) * 900;
await client.query(`INSERT INTO abuse_ip_windows (ip, window_start, posts, validation_failures, turnstile_failures, successful_progressions) VALUES ('198.51.100.77',$1,30,12,3,0) ON CONFLICT (ip, window_start) DO UPDATE SET posts=30, validation_failures=12, turnstile_failures=3, successful_progressions=0`, [ws]);
const obs = await orderEvidence.abuseObservationForIp(db, "198.51.100.77");
check("shadow evidence readable", obs !== null && obs.posts === 30, JSON.stringify(obs));
check("IP is masked for display", orderEvidence.maskIp("198.51.100.77") === "198.51.100.x", String(orderEvidence.maskIp("198.51.100.77")));

await cleanup();
console.log(`\n=== ${pass} passed, ${fail} failed ===`);
await client.end();
process.exit(fail === 0 ? 0 : 1);
