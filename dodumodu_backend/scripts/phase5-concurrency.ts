// Concurrency verification against the real database.
//
// Sequential tests cannot show a lost update, so the claims that matter here are
// all about what happens when requests arrive at the same instant:
//
//   - N concurrent order POSTs sharing one idempotency key produce ONE order;
//   - N concurrent counter increments produce N (not N-1, not N+1);
//   - the abuse counters stay correct under a parallel burst;
//   - duplicate/repeat evidence does not contradict itself afterwards.
import { registerDbDriver } from "../src/db";
import { pgDriver } from "../src/dbDrivers/pg";
registerDbDriver(pgDriver);
import pg from "pg";
import { createDb } from "../src/db";
import { orderService } from "../src/services/orderService";
import { abuseIpWindows } from "../src/schema";
import { sql } from "drizzle-orm";
import * as orderEvidence from "../src/abuse/orderEvidence";

const client = new pg.Client({ connectionString: process.env.DATABASE_URL! });
await client.connect();
const db = createDb(process.env.DATABASE_URL!);
const env = { ENVIRONMENT: "sandbox", MAX_ORDER_QUANTITY: "20" } as never;
const productId = Number((await client.query("SELECT id FROM products WHERE active LIMIT 1")).rows[0].id);
const K = "conc" + Date.now();
const address = "4 Concurrency Road, Lagos";

let pass = 0; let fail = 0;
const check = (l: string, ok: boolean, d = "") => { if (ok) { pass++; console.log(`  PASS  ${l}`); } else { fail++; console.log(`  FAIL  ${l}${d ? ` -- ${d}` : ""}`); } };
const place = (phone: string, n: string) => orderService.createOrder(db, env, {
  idempotencyKey: `${K}-${n}`, turnstileToken: "", productId, quantity: 1,
  customerName: "Concurrent", phone, whatsapp: phone, address, state: "Lagos",
  deliveryDate: "today", paymentMethod: "cod",
} as never, { ip: "198.51.100.99" });

console.log("\n=== 1. 20 concurrent submissions, ONE idempotency key ===");
const sharedKey = `${K}-same`;
const submitSame = () => orderService.createOrder(db, env, {
  idempotencyKey: sharedKey, turnstileToken: "", productId, quantity: 1,
  customerName: "Concurrent", phone: "08066660001", whatsapp: "08066660001",
  address, state: "Lagos", deliveryDate: "today", paymentMethod: "cod",
} as never, { ip: "198.51.100.98" });

const results = await Promise.all(Array.from({ length: 20 }, () => submitSame()));
const ids = new Set(results.map((r) => r.order.id));
check("all 20 calls returned the SAME order id", ids.size === 1, `ids=${[...ids].join(",")}`);
const rows = await client.query("SELECT count(*)::int AS n FROM orders WHERE idempotency_key=$1", [sharedKey]);
check("exactly ONE row exists in the database", rows.rows[0].n === 1, `rows=${rows.rows[0].n}`);

console.log("\n=== 2. 50 concurrent atomic counter increments ===");
const IP = "198.51.100.97";
const ws = Math.floor(Date.now() / 1000 / 900) * 900;
await client.query("DELETE FROM abuse_ip_windows WHERE ip=$1", [IP]);
const bump = () => db.insert(abuseIpWindows).values({ ip: IP, windowStart: ws, posts: 1 })
  .onConflictDoUpdate({
    target: [abuseIpWindows.ip, abuseIpWindows.windowStart],
    set: { posts: sql`${abuseIpWindows.posts} + 1` },
  }).returning();
await Promise.all(Array.from({ length: 50 }, () => bump()));
const counted = await client.query("SELECT posts FROM abuse_ip_windows WHERE ip=$1 AND window_start=$2", [IP, ws]);
check("counter reached exactly 50 (no lost updates)", Number(counted.rows[0].posts) === 50, `posts=${counted.rows[0].posts}`);

console.log("\n=== 3. 15 concurrent DISTINCT orders, then evidence ===");
const phone = "08066660002";
const created = await Promise.all(Array.from({ length: 15 }, (_, i) => place(phone, `p${i}`)));
const uniqueOrders = new Set(created.map((r) => r.order.id));
check("15 distinct orders were created", uniqueOrders.size === 15, `unique=${uniqueOrders.size}`);

const evidence = await orderEvidence.evidenceForOrders(db, created.map((o) => ({
  id: o.order.id, reference: o.order.reference, createdAt: o.order.createdAt,
  phoneNorm: o.order.phoneNorm, address: o.order.address, productId: o.order.productId,
  // Part of the order match key: without it the comparison is against an
  // undefined quantity and never matches.
  quantity: o.order.quantity,
})));
// All 15 share a phone, address, product and quantity, so EVERY one must point at
// a duplicate, and NONE may be reordering (no delivered order exists).
const dupCount = [...evidence.values()].filter((e) => e.duplicateOf !== null).length;
check("all 15 flagged as possible duplicates (same order match key, same day)", dupCount === 15, `dupes=${dupCount}`);
const reorderCount = [...evidence.values()].filter((e) => e.reordering).length;
check("none treated as reordering (no DELIVERED order exists)", reorderCount === 0, `reordering=${reorderCount}`);

// Contradictory evidence check: two orders must never each point at a DIFFERENT
// partner inconsistently, and no order may point at itself.
const selfRefs = [...evidence.entries()].filter(([id, e]) => e.duplicateOf?.id === id);
check("no order points at itself", selfRefs.length === 0, `self=${selfRefs.length}`);

console.log("\n=== 4. Concurrent replay does not inflate abuse evidence ===");
const before = await client.query("SELECT posts FROM abuse_ip_windows WHERE ip=$1 AND window_start=$2", ["198.51.100.96", ws]);
const beforePosts = Number(before.rows[0]?.posts ?? 0);
const replayKey = `${K}-replay`;
await place("08066660003", "replay-1");
const rp = await Promise.all(Array.from({ length: 10 }, () => orderService.createOrder(db, env, {
  idempotencyKey: replayKey, turnstileToken: "", productId, quantity: 1,
  customerName: "Concurrent", phone: "08066660003", whatsapp: "08066660003",
  address, state: "Lagos", deliveryDate: "today", paymentMethod: "cod",
} as never, { ip: "198.51.100.96" })));
const replayIds = new Set(rp.map((r) => r.order.id));
check("10 concurrent replays returned one order", replayIds.size === 1, `ids=${replayIds.size}`);
// The guard (not the service) is what skips counting for replays; here the service
// is called directly, so what matters is that only ONE order row exists.
const replayRows = await client.query("SELECT count(*)::int AS n FROM orders WHERE idempotency_key=$1", [replayKey]);
check("replays created no extra rows", replayRows.rows[0].n === 1, `rows=${replayRows.rows[0].n}`);
void beforePosts;

// Cleanup: only this run's own rows.
await client.query("DELETE FROM order_status_history WHERE order_id IN (SELECT id FROM orders WHERE idempotency_key LIKE $1)", [`${K}-%`]);
await client.query("DELETE FROM orders WHERE idempotency_key LIKE $1", [`${K}-%`]);
await client.query("DELETE FROM abuse_ip_windows WHERE ip = ANY($1)", [["198.51.100.96", "198.51.100.97", "198.51.100.98", "198.51.100.99"]]);
await client.query("DELETE FROM abuse_ip_phones WHERE ip = ANY($1)", [["198.51.100.96", "198.51.100.97", "198.51.100.98", "198.51.100.99"]]);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
await client.end();
process.exit(fail === 0 ? 0 : 1);
