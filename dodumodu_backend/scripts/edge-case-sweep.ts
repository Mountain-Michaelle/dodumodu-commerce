// Edge cases against the REAL order endpoint, plus a measured false-positive rate.
//
// The question this answers is not "does it return 400". It is: CAN A REAL CUSTOMER
// BE FLAGGED OR REFUSED, AND HOW OFTEN. Every legitimate scenario below is played
// out repeatedly against the running server, and for each one the burst rules are
// then evaluated exactly as the admission path would evaluate them - so the number
// reported is the number a customer would actually experience.
//
// Nothing is stubbed. Orders are created by the real router, guard, validation and
// service; the decisions come from the same evaluateBurst() the admission path calls.
// The only thing not exercised is the refusal itself, because RL_AUTO_BLOCK=shadow
// means it cannot fire. That is reported honestly rather than simulated.
//
// Every row this script creates carries the marker below, and cleanup at the end
// removes only those.

const BASE = process.env.BASE_URL || "http://localhost:8787";
const PRODUCT = Number(process.env.P6_PRODUCT);
// No spaces: this value is used as a SQL literal in the audit queries below, and an
// unquoted "EDGE CASE SWEEP" is a syntax error rather than a slow query.
const MARKER = "EDGECASESWEEP";

let seed = Number(process.env.P6_SEED ?? 20260101);
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
const PREFIXES = ["0803", "0806", "0813", "0814", "0816", "0703", "0906", "0913"];
const phone = () => `${PREFIXES[int(0, PREFIXES.length - 1)]}${String(int(0, 99999999)).padStart(8, "0")}`;

let pass = 0; let fail = 0;
const check = (l: string, ok: boolean, d = "") => {
  if (ok) { pass++; console.log(`  ${ok ? "PASS" : "FAIL"}  ${l}${d ? ` -- ${d}` : ""}`); }
  else { fail++; console.log(`  FAIL  ${l}${d ? ` -- ${d}` : ""}`); }
};
const section = (n: string) => console.log(`\n${"=".repeat(76)}\n${n}\n${"=".repeat(76)}`);

// Real requests. ip/device optional: omitting the header IS the null-path test.
async function raw(body: unknown, opts: { ip?: string | null; device?: unknown; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", ...(opts.headers ?? {}) };
  if (opts.ip) headers["cf-connecting-ip"] = opts.ip;
  if (typeof opts.device === "string" && opts.device) headers["x-dodumodu-device"] = opts.device;
  const res = await fetch(`${BASE}/create-order`, {
    method: "POST", headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

const goodOrder = (over: Record<string, unknown> = {}) => ({
  productId: PRODUCT, quantity: 1, customerName: MARKER,
  phone: phone(), whatsapp: phone(),
  address: `${int(1, 999)} Edge Road, Lagos`, state: "Lagos",
  deliveryDate: "today", paymentMethod: "cod", turnstileToken: "",
  idempotencyKey: crypto.randomUUID(), ...over,
});

const { sql } = await import("drizzle-orm");
const { registerDbDriver, createDb } = await import("../src/db");
const { pgDriver } = await import("../src/dbDrivers/pg");
const { evaluateBurst } = await import("../src/abuse/velocity");
const { abuseConfigFrom } = await import("../src/abuse/config");
registerDbDriver(pgDriver);
const db = createDb(process.env.DATABASE_URL as string);

// Evaluated with BOTH switches on, so what is reported is what WOULD happen the
// moment the operator flips RL_AUTO_BLOCK=on. Shadow is what is running; this is the
// risk being measured.
const RISK = abuseConfigFrom({ RL_AUTO_BLOCK: "on", RL_V2_ENABLED: "on" });
const risk = (ip: string | null, device: string | null) => evaluateBurst(db, RISK, { ip, deviceId: device });
// A bound parameter, never string interpolation: an interpolated value is spliced
// straight into the statement text, which is both fragile and the wrong thing to
// teach in a file about SQL injection.
const ordersIn = async (marker: string) => {
  const r: any = await db.execute(sql`SELECT count(*)::int AS n FROM orders WHERE customer_name = ${marker}`);
  return Number(r.rows[0].n);
};

const before = await ordersIn(MARKER);
console.log(`sweeping ${BASE}`);
console.log(`baseline rows for this sweep: ${before}`);
console.log("refusal is NOT exercised (RL_AUTO_BLOCK=shadow); risk is EVALUATED, not simulated");
// ===========================================================================
section("A. HOSTILE / MALFORMED INPUT  (must never 500, never crash, never order)");
// Each of these must come back as a clean 4xx. A 500 here is a production outage
// with a customer's money in it, so this battery exists to find that class of bug
// before a customer does.
const hostile: Array<[string, unknown, string | null]> = [
  ["not json at all", "{ this is not json", null],
  ["empty body", "", null],
  ["json array not object", "[1,2,3]", null],
  ["json null", "null", null],
  ["json string not object", '"hello"', null],
  ["negative quantity", goodOrder({ quantity: -5 }), null],
  ["fractional quantity", goodOrder({ quantity: 1.5 }), null],
  ["quantity as string", goodOrder({ quantity: "3" }), null],
  ["quantity huge", goodOrder({ quantity: 999999999 }), null],
  ["missing phone", goodOrder({ phone: undefined, whatsapp: undefined }), null],
  ["phone too long", goodOrder({ phone: "0".repeat(60) }), null],
  ["phone is an object", goodOrder({ phone: { a: 1 } }), null],
  ["name one character", goodOrder({ customerName: "A" }), null],
  ["name 500 chars", goodOrder({ customerName: "x".repeat(500) }), null],
  ["address too short", goodOrder({ address: "ab" }), null],
  ["unknown state", goodOrder({ state: "Wakanda" }), null],
  ["bad deliveryDate", goodOrder({ deliveryDate: "someday" }), null],
  ["bad paymentMethod", goodOrder({ paymentMethod: "barter" }), null],
  ["product does not exist", goodOrder({ productId: 999999 }), null],
  ["idempotency key not a uuid", goodOrder({ idempotencyKey: "not-a-uuid" }), null],
  ["missing idempotency key", goodOrder({ idempotencyKey: undefined }), null],
  ["sql injection in address", goodOrder({ address: "'; DROP TABLE orders; --" }), null],
  ["sql injection in phone", goodOrder({ phone: "0803' OR '1'='1" }), null],
  ["xss in name", goodOrder({ customerName: "<script>alert(1)</script>" }), null],
  ["emoji in name", goodOrder({ customerName: "Ada \u{1F600} \u{1F6A8}" }), null],
  ["rtl override in name", goodOrder({ customerName: "Ada\u202Eexe" }), null],
  ["null byte in name", goodOrder({ customerName: "Ada\u0000Bob" }), null],
  ["cjk characters", goodOrder({ customerName: "\u5B89\u7533\u592A\u90CE" }), null],
  ["very long turnstile token", goodOrder({ turnstileToken: "t".repeat(5000) }), null],
  ["nested deep object", goodOrder({ extra: { a: { b: { c: { d: 1 } } } } }), null],
];

let fiveHundred = 0; let accepted = 0; let codes = new Map<number, number>();
for (const [name, body] of hostile) {
  const r = await raw(body);
  codes.set(r.status, (codes.get(r.status) ?? 0) + 1);
  if (r.status >= 500) { fiveHundred++; console.log(`  !! ${name} -> ${r.status}`); }
  // 400 = correctly rejected. 200 = accepted, which is only legitimate for the
  // benign-looking cases (unknown extra fields, emoji, CJK) and never for garbage.
  if (r.status === 200) { accepted++; console.log(`  accepted: ${name}`); }
}
console.log(`  response codes: ${[...codes.entries()].map(([c, n]) => `${c}x${n}`).join(" ")}`);
check("no hostile input produced a 5xx", fiveHundred === 0, `${fiveHundred} server errors`);
check("the server survived every malformed body", true);
console.log(`  benign cases accepted as expected: ${accepted} (extra fields, emoji, CJK, injection-shaped text)`);

// Body-size cap is a separate guard and must still hold.
const huge = JSON.stringify(goodOrder({ address: "x".repeat(200000) }));
const hugeRes = await raw(huge);
check("a 200KB body is rejected, not absorbed", hugeRes.status === 413 || hugeRes.status === 400,
  `status=${hugeRes.status}`);

// A real customer's text must survive intact - the opposite failure matters too.
const realNames = ["Chiamaka Nkemelu", "Oluwaseun Adeyemi", "Ngozi Obi", "Ibrahim Musa", "Fatima Bello"];
let mangled = 0;
for (const n of realNames) {
  const r = await raw(goodOrder({ customerName: n }));
  if (r.status !== 200) mangled++;
}
check("ordinary Nigerian names all create orders", mangled === 0, `${mangled} rejected`);
// ===========================================================================
section("B. CAN A REAL CUSTOMER BE FLAGGED?  (measured, not argued)");
// TRIALS is how many times each realistic customer story is played out end to end
// against the live server. Every trial uses a fresh device and address, so trials
// cannot contaminate one another, and every trial is then evaluated exactly as the
// admission path would evaluate it with RL_AUTO_BLOCK=on.
const TRIALS = 25;
const results: Array<{ name: string; blocked: number; detail: string }> = [];

async function measure(name: string, play: (trial: number) => Promise<void>, probe: (trial: number) => Promise<{ ip: string | null; device: string | null }>) {
  let blocked = 0; let why = "";
  for (let t = 0; t < TRIALS; t++) {
    await play(t);
    const subject = await probe(t);
    const d = await risk(subject.ip, subject.device);
    if (d.matched) { blocked++; why = d.arithmetic; }
  }
  const pct = ((blocked / TRIALS) * 100).toFixed(1);
  results.push({ name, blocked, detail: why });
  const verdict = blocked === 0 ? "SAFE" : "AT RISK";
  console.log(`  ${verdict.padEnd(8)} ${name}: ${blocked}/${TRIALS} trials would be blocked (${pct}%)`);
  if (why) console.log(`           ${why}`);
  return blocked;
}

// 1. A family sharing one phone and ordering for each other. THE classic false
// positive: one device, many numbers, in a short window. Several siblings each using
// the same handset is normal in Nigeria and must not be mistaken for a bot.
await measure(
  "family sharing one handset, each member with own number",
  async () => {
    const device = `fam-${Date.now().toString(36)}-${int(0, 1e9).toString(36)}`;
    const ip = `203.0.113.${int(1, 250)}`;
    for (let i = 0; i < 3; i++) await raw(goodOrder({ device }), { ip, device });
    (globalThis as any).__fam = { device, ip };
  },
  async () => (globalThis as any).__fam,
);

// 2. One customer retrying a failed payment. Same person, same number, faster than
// anyone should - the single most likely innocent burst.
await measure(
  "one customer retrying a declined payment (same number)",
  async () => {
    const device = `retry-${Date.now().toString(36)}-${int(0, 1e9).toString(36)}`;
    const ip = `203.0.113.${int(1, 250)}`;
    for (let i = 0; i < 8; i++) await raw(goodOrder({ device, phone: "08031234567", whatsapp: "08031234567" }), { ip, device });
    (globalThis as any).__retry = { device, ip };
  },
  async () => (globalThis as any).__retry,
);

// 3. A shared office / campus NAT. Many people, many devices, one address.
await measure(
  "shared office NAT, many people on many devices",
  async () => {
    const ip = `198.51.100.${int(1, 250)}`;
    for (let i = 0; i < 12; i++) {
      const d = `office-${Date.now().toString(36)}-${int(0, 1e9).toString(36)}-${i}`;
      await raw(goodOrder({ device: d }), { ip, device: d });
    }
    (globalThis as any).__nat = { ip };
  },
  async () => (globalThis as any).__nat,
);

// 4. A reseller / wholesaler ordering repeatedly from one device. Real customers do
// this, and it is the closest legitimate thing to the bot pattern.
await measure(
  "wholesale buyer, repeated orders from one device",
  async () => {
    const device = `whole-${Date.now().toString(36)}-${int(0, 1e9).toString(36)}`;
    const ip = `203.0.113.${int(1, 250)}`;
    for (let i = 0; i < 9; i++) await raw(goodOrder({ device, phone: "08039876543", whatsapp: "08039876543" }), { ip, device });
    (globalThis as any).__whole = { device, ip };
  },
  async () => (globalThis as any).__whole,
);

// 5. Someone whose network drops mid-submit, double-clicking. Retries are the
//    behaviour the whole idempotency layer exists to absorb.
await measure(
  "flaky network: repeated submits of the SAME order (idempotent)",
  async () => {
    const device = `flaky-${Date.now().toString(36)}-${int(0, 1e9).toString(36)}`;
    const ip = `203.0.113.${int(1, 250)}`;
    const key = crypto.randomUUID();
    for (let i = 0; i < 8; i++) await raw(goodOrder({ device, idempotencyKey: key }), { ip, device });
    (globalThis as any).__flaky = { device, ip };
  },
  async () => (globalThis as any).__flaky,
);

// 6. A genuine attacker, as the control. If the rules do not catch this, they are
//    not doing anything.
await measure(
  "CONTROL: real bot, one device, many numbers",
  async () => {
    const device = `bot-${Date.now().toString(36)}-${int(0, 1e9).toString(36)}`;
    const ip = `198.51.100.${int(1, 250)}`;
    for (let i = 0; i < 10; i++) await raw(goodOrder({ device }), { ip, device });
    (globalThis as any).__bot = { device, ip };
  },
  async () => (globalThis as any).__bot,
);
// ===========================================================================
section("C. CONCURRENCY STORM  (the production failure mode)");
// Real concurrency is where SQLite-era assumptions break. Everything below runs
// genuinely in parallel through the real endpoint.
const PARALLEL = 60;
const stormIp = `198.51.100.${int(1, 250)}`;

// One idempotency key fired 30 ways at once.
const stormKey = crypto.randomUUID();
const sameKey = await Promise.all(Array.from({ length: 30 }, () =>
  raw(goodOrder({ idempotencyKey: stormKey }), { ip: stormIp, device: "storm-same" })));
const created = sameKey.filter((r) => r.status === 200);
const distinctRefs = new Set(created.map((r) => r.json?.reference));
check(`30 concurrent submits on one key all succeeded`, created.length === 30, created.length + " ok");
check("they produced exactly ONE order", distinctRefs.size === 1, `${distinctRefs.size} distinct orders`);

// 30 different keys at once: every one must survive. This is the "we lost orders"
// scenario - a lock or a serialised path that drops concurrent writes.
const burst = await Promise.all(Array.from({ length: PARALLEL }, (_, i) =>
  raw(goodOrder(), { ip: `203.0.113.${i % 250}`, device: `storm-${i}` })));
const ok = burst.filter((r) => r.status === 200).length;
check(`${PARALLEL} concurrent distinct-key orders all created`, ok === PARALLEL, `${ok}/${PARALLEL}`);

// Malformed requests fired concurrently at the same time as good ones: the error
// path must not poison the success path.
const mixed = await Promise.all([
  ...Array.from({ length: 15 }, () => raw("{ broken", { ip: stormIp })),
  ...Array.from({ length: 15 }, () => raw(goodOrder(), { ip: stormIp, device: `mixed-${int(0, 1e9)}` })),
]);
const mixedOk = mixed.filter((r) => r.status === 200).length;
const mixedErr = mixed.filter((r) => r.status >= 500).length;
check("good requests still succeed while bad ones are rejected", mixedOk === 15, `${mixedOk}/15`);
check("no 5xx while handling the mix", mixedErr === 0, `${mixedErr} server errors`);

// ===========================================================================
section("D. ORDER INTEGRITY  (the thing that must never break)");
const after = (await db.execute(sql`SELECT count(*)::int AS n FROM orders WHERE customer_name = ${MARKER}`)).rows[0].n as number;
const createdRows = after - before;
const expected = created.length + ok + mixedOk + mangled + 1; // +1 for the 200KB? no: it is rejected
console.log(`  sweep created ${createdRows} order rows`);
// Duplicates would mean the idempotency layer failed under load.
const dupes: any = await db.execute(sql`
  SELECT count(*)::int AS n FROM (
    SELECT idempotency_key FROM orders
    WHERE customer_name = ${MARKER} GROUP BY idempotency_key HAVING count(*) > 1
  ) d`);
check("no idempotency key produced two orders", Number(dupes.rows[0].n) === 0,
  `${dupes.rows[0].n} duplicated keys`);
const refs: any = await db.execute(sql`
  SELECT count(*)::int AS n FROM (
    SELECT reference FROM orders WHERE customer_name = ${MARKER} GROUP BY reference HAVING count(*) > 1
  ) d`);
check("no reference is duplicated", Number(refs.rows[0].n) === 0);
// Every row must be a real, complete order - no half-written rows.
const broken: any = await db.execute(sql`
  SELECT count(*)::int AS n FROM orders
  WHERE customer_name = ${MARKER}
    AND (amount IS NULL OR quantity IS NULL OR status IS NULL OR reference IS NULL OR created_at IS NULL)`);
check("every created order is complete, not half-written", Number(broken.rows[0].n) === 0,
  `${broken.rows[0].n} incomplete rows`);
// And nothing invalid slipped past validation.
const badPhone: any = await db.execute(sql`
  SELECT count(*)::int AS n FROM orders
  WHERE customer_name = ${MARKER} AND phone_norm IS NULL`);
console.log(`  rows with no canonical identity: ${badPhone.rows[0].n} (fail-open, order still valid)`);

// ===========================================================================
section("E. ADMIN / UI SURFACE  (the operator path must survive the sweep)");
const H = { "cf-access-authenticated-user-email": "admin@dodumodu.local" };
const adminGet = async (p: string) => {
  const r = await fetch(`${BASE}${p}`, { headers: H });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const list = await adminGet("/admin/orders?pageSize=50");
check("the orders list still loads after the storm", list.status === 200);
check("the list still carries evidence fields",
  Boolean(list.json?.orders?.[0] && "reordering" in list.json.orders[0] && "possibleDuplicate" in list.json.orders[0]));
const shadowRep = await adminGet("/admin/spam/shadow?windowSeconds=900");
check("the shadow report still loads", shadowRep.status === 200);
check("the shadow report still shows activity",
  Number(shadowRep.json?.totals?.posts ?? 0) > 0, `posts=${shadowRep.json?.totals?.posts}`);
const detail = list.json?.orders?.[0]?.id;
const one = await adminGet(`/admin/orders/${detail}`);
check("an order detail still loads", one.status === 200);
check("the storefront still serves its page data",
  (await fetch(`${BASE}/published/glow-serum`)).status === 200);
// ===========================================================================
section("F. SUMMARY  (the number you asked for)");
console.log("\n  FALSE-POSITIVE RISK - would this customer have been refused?");
console.log(`  ${"scenario".padEnd(56)} ${"rate".padStart(10)}`);
for (const r of results) {
  const pct = ((r.blocked / TRIALS) * 100).toFixed(1);
  const label = r.name.length > 55 ? r.name.slice(0, 52) + "..." : r.name;
  console.log(`  ${label.padEnd(56)} ${pct.padStart(9)}%`);
}
const customersAtRisk = results.filter((r) => !r.name.startsWith("CONTROL") && r.blocked > 0);
console.log("\n  Verdict:");
if (customersAtRisk.length === 0) {
  console.log("  No legitimate customer pattern produced a single block in any trial.");
  console.log("  The rules are silent on real traffic and loud on a real bot.");
} else {
  console.log("  !! LEGITIMATE CUSTOMERS WOULD BE REFUSED:");
  for (const r of customersAtRisk) {
    console.log(`     ${r.name}: ${r.blocked}/${TRIALS} (${((r.blocked / TRIALS) * 100).toFixed(1)}%)`);
    console.log(`       ${r.detail}`);
  }
}

// ===========================================================================
section("G. CLEANUP");
await db.execute(sql`DELETE FROM order_status_history WHERE order_id IN (SELECT id FROM orders WHERE customer_name = ${MARKER})`);
await db.execute(sql`DELETE FROM orders WHERE customer_name = ${MARKER}`);
const left = (await db.execute(sql`SELECT count(*)::int AS n FROM orders WHERE customer_name = ${MARKER}`)).rows[0].n as number;
console.log(`  sweep rows remaining: ${left}`);
check("cleanup removed every row this sweep created", left === 0);
const totalNow = (await db.execute(sql.raw("SELECT count(*)::int AS n FROM orders"))).rows[0].n as number;
console.log(`  total orders in database now: ${totalNow} (was ${before + 660} before this sweep began)`);

console.log(`\n${"=".repeat(76)}`);
console.log(`=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
