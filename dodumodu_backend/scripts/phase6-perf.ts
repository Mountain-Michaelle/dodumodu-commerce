// Phase 6: performance and fail-open behaviour.
//
// The N+1 question is the one worth answering properly. An Orders list page that
// asked the database once per row would be indistinguishable from a fast one at 5
// rows and unusable at 100, so the count is taken from PostgreSQL itself rather
// than inferred: enable statement logging statistics via pg_stat_statements is not
// available here, so instead the same page is measured against a SMALL page and a
// LARGE page. If evidence were fetched per row, the large page would cost roughly
// (large/small) times as many round trips. Flat growth is the evidence of batching.
import { sql } from "drizzle-orm";
import { registerDbDriver, createDb } from "../src/db";
import { pgDriver } from "../src/dbDrivers/pg";

const BASE = process.env.BASE_URL || "http://localhost:8787";
registerDbDriver(pgDriver);
const db = createDb(process.env.DATABASE_URL);

const headers = { "cf-access-authenticated-user-email": "admin@dodumodu.local" };

async function statements(): Promise<number> {
  const r: any = await db.execute(sql`SELECT sum(calls)::bigint AS calls FROM pg_stat_statements
    WHERE query ILIKE ${"%abuse%"} OR query ILIKE ${"%orders%"}`);
  return Number(r.rows[0]?.calls ?? 0);
}

async function timed(path: string, n = 20) {
  // one warm-up, then the average of n
  await fetch(`${BASE}${path}`, { headers });
  const t0 = performance.now();
  for (let i = 0; i < n; i++) await fetch(`${BASE}${path}`, { headers });
  return (performance.now() - t0) / n;
}

console.log("=== customer storefront ===");
for (const p of ["/published/glow-serum", "/health"]) {
  const ms = await timed(p, 15);
  console.log(`  ${p.padEnd(24)} ${ms.toFixed(1)} ms avg`);
}

console.log("\n=== order endpoint (full create, real validation + DB write) ===");
const mkOrder = () => ({
  productId: Number(process.env.P6_PRODUCT), quantity: 1,
  customerName: "Phase Six Perf PHASE6", phone: `0809${Math.floor(1000000 + Math.random() * 8999999)}`,
  whatsapp: "08090000001", address: `${Math.floor(Math.random() * 9999)} Perf Way, Lagos`,
  state: "Lagos", deliveryDate: "today", paymentMethod: "cod", turnstileToken: "",
  idempotencyKey: crypto.randomUUID(),
});
const createTimes: number[] = [];
for (let i = 0; i < 15; i++) {
  const t0 = performance.now();
  await fetch(`${BASE}/create-order`, {
    method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": `198.51.100.${i % 250}` },
    body: JSON.stringify(mkOrder()),
  });
  createTimes.push(performance.now() - t0);
}
createTimes.sort((a, b) => a - b);
console.log(`  create-order   avg ${(createTimes.reduce((a, b) => a + b, 0) / createTimes.length).toFixed(1)} ms`
  + `  median ${createTimes[7].toFixed(1)} ms  p95 ${createTimes[13].toFixed(1)} ms`);

console.log("\n=== admin evidence: does cost scale with page size? ===");
const small = await timed("/admin/orders?pageSize=5", 20);
const large = await timed("/admin/orders?pageSize=100", 20);
console.log(`  5 rows   ${small.toFixed(1)} ms`);
console.log(`  100 rows ${large.toFixed(1)} ms`);
const ratio = large / small;
console.log(`  ratio ${ratio.toFixed(2)}x for 20x the rows`);
// Per-row evidence queries would give a ratio far above 1 (near 20x). A batched
// implementation adds two fixed lookups regardless of page size.
console.log(`  verdict: ${ratio < 3 ? "BATCHED - no N+1 evidence query" : "POSSIBLE N+1 - investigate"}`);

const one: any = await (await fetch(`${BASE}/admin/orders?pageSize=1`, { headers })).json();
const detailId = one.orders[0]?.id;
const detailMs = await timed(`/admin/orders/${detailId}`, 20);
console.log(`  order detail  ${detailMs.toFixed(1)} ms avg`);

const shadowMs = await timed("/admin/spam/shadow?windowSeconds=86400", 10);
console.log(`  shadow report ${shadowMs.toFixed(1)} ms avg`);

console.log("\n=== fail-open: abuse layer failure must not stop the order ===");
// The abuse layer is pointed at a database that does not exist. If the guard did
// not fail open, this would throw and take the order with it; the expectation is
// that evaluate() returns normally with no restriction and only logs.
const { evaluate, recordOutcome } = await import("../src/abuse/guardService");
const { configFor } = await import("../src/abuse/guardService");
const brokenDb: any = createDb("postgresql://postgres@localhost:59999/nonexistent");
const env: any = { RL_MODE: "shadow", ABUSE_WINDOW_MINUTES: "10" };
const started = Date.now();
let decision: any = null;
let threw = "";
try {
  decision = await evaluate(brokenDb, configFor(env), {
    ip: "198.51.100.250", phone: "08090000777", idempotencyKey: crypto.randomUUID(),
    outcome: "order_created", now: new Date(),
  } as any);
} catch (err) {
  threw = (err as Error).message;
}
console.log(`  evaluate() against an unreachable database: ${threw ? "THREW " + threw.slice(0, 60) : "returned normally"} after ${Date.now() - started} ms`);
console.log(`  decision: ${decision ? JSON.stringify(decision) : "none"}`);
let outThrew = "";
try {
  await recordOutcome(brokenDb, configFor(env), {
    ip: "198.51.100.250", phone: "08090000777", outcome: "order_created", now: new Date(),
  } as any);
} catch (err) {
  outThrew = (err as Error).message;
}
console.log(`  recordOutcome(): ${outThrew ? "THREW (expected only if not wrapped)" : "returned normally"}`);
console.log("  NOTE: what must NOT be bypassed by this failure is idempotency, pricing,");
console.log("  Turnstile and payment safety - those all run BEFORE the guard is asked.");
console.log("\n(Done.)");
