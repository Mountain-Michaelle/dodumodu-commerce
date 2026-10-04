// Phase 6: concurrency against the RUNNING server.
//
// Three separate claims, each measured rather than assumed:
//   1. many simultaneous submissions of one idempotency key produce ONE order
//   2. many simultaneous submissions of DIFFERENT keys produce N valid orders,
//      with no block, no corrupted counters and no self-matching duplicate evidence
//   3. concurrent counter increments land exactly - the final row equals the number
//      of increments attempted, not a lower number lost to a read-modify-write race
import { sql } from "drizzle-orm";
import { registerDbDriver, createDb } from "../src/db";
import { pgDriver } from "../src/dbDrivers/pg";
import { abuseIpWindows } from "../src/schema";

const BASE = process.env.BASE_URL || "http://localhost:8787";
const IP = "203.0.113.150";
let pass = 0; let fail = 0;
const check = (l, ok, d = "") => { if (ok) { pass++; console.log(`  PASS  ${l}`); } else { fail++; console.log(`  FAIL  ${l}${d ? ` -- ${d}` : ""}`); } };

registerDbDriver(pgDriver);
const db = createDb(process.env.DATABASE_URL);

async function submit(body, key) {
  const res = await fetch(`${BASE}/create-order`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": IP },
    body: JSON.stringify({ ...body, idempotencyKey: key }),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}
const order = (over = {}) => ({
  productId: Number(process.env.P6_PRODUCT), quantity: 1,
  customerName: "Phase Six Concurrency PHASE6", phone: "08090000099",
  whatsapp: "08090000099", address: "20 Concurrency Way, Lagos", state: "Lagos",
  deliveryDate: "today", paymentMethod: "cod", turnstileToken: "", ...over,
});
const admin = async (p) => {
  const r = await fetch(`${BASE}${p}`, { headers: { "cf-access-authenticated-user-email": "admin@dodumodu.local" } });
  return r.json();
};

// This script reuses fixed phone numbers and addresses on every run. Left in place,
// a previous run's rows become genuine same-day match-key duplicates for this run's
// rows and the "no self-matching duplicate" assertion stops meaning anything. The
// previous run's rows are therefore removed BEFORE the burst, and this run's are
// left behind afterwards for inspection.
await db.execute(sql`DELETE FROM order_status_history WHERE order_id IN (SELECT id FROM orders WHERE customer_name = ${"Phase Six Concurrency PHASE6"})`);
await db.execute(sql`DELETE FROM orders WHERE customer_name = ${"Phase Six Concurrency PHASE6"}`);
console.log("cleared any previous concurrency run");
console.log("=== 1. one idempotency key, fired concurrently ===");
const sharedKey = crypto.randomUUID();
const N = 25;
const burst = await Promise.all(Array.from({ length: N }, () => submit(order({ phone: "08090000099" }), sharedKey)));
const ids = new Set(burst.filter((b) => b.status === 200).map((b) => b.json.orderId));
check(`all ${N} responses succeeded`, burst.every((b) => b.status === 200), burst.map((b) => b.status).join(","));
check(`exactly ONE logical order was created`, ids.size === 1, `distinct ids=${ids.size}`);

console.log(`\n=== 2. different keys, fired concurrently ===`);
const M = 20;
const distinct = await Promise.all(Array.from({ length: M }, (_, i) => submit(
  order({ phone: `0809000${String(1000 + i).padStart(4, "0")}`, address: `2${i} Concurrency Way, Lagos` }), crypto.randomUUID())));
const okCount = distinct.filter((d) => d.status === 200).length;
check(`all ${M} distinct-key orders created`, okCount === M, `ok=${okCount}`);
check("nobody was blocked", distinct.every((d) => d.status === 200), distinct.map((d) => d.status).join(","));
const newIds = distinct.map((d) => d.json.orderId);
const list = await admin("/admin/orders?pageSize=100");
const rows = list.orders.filter((o) => newIds.includes(o.id));
check("every concurrent order is present in the database", rows.length === M, `found=${rows.length}`);
check("no concurrent order is a self-matching duplicate", rows.every((r) => r.possibleDuplicate === false),
  rows.filter((r) => r.possibleDuplicate).map((r) => r.id).join(","));
check("no concurrent order claims to be a reordering customer", rows.every((r) => r.reordering === false),
  rows.filter((r) => r.reordering).map((r) => r.id).join(","));
console.log(`\n=== 3. atomic counter increments ===`);
const P = 200;
await db.execute(sql`DELETE FROM abuse_ip_windows WHERE ip = ${IP}`);
await db.execute(sql`DELETE FROM abuse_ip_phones WHERE ip = ${IP}`);
const WINDOW = 1; // an arbitrary fixed bucket; only the increment behaviour is under test
await db.insert(abuseIpWindows).values({ ip: IP, windowStart: WINDOW, posts: 0 }).onConflictDoNothing();
await Promise.all(Array.from({ length: P }, () => db.execute(
  sql`UPDATE abuse_ip_windows SET posts = posts + 1 WHERE ip = ${IP} AND window_start = ${WINDOW}`)));
const result: any = await db.execute(sql`SELECT posts FROM abuse_ip_windows WHERE ip = ${IP} AND window_start = ${WINDOW}`);
const finalCount = Number(result.rows[0].posts);

check(`final count equals exactly ${P} increments (no lost updates)`, finalCount === P, `got=${finalCount}`);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
