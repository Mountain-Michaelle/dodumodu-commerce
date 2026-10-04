// Burst scenarios, run through the REAL order endpoint in SHADOW mode.
//
// Shadow is the point: RL_AUTO_BLOCK=shadow means every rule below is evaluated and
// logged, and not one customer is refused. Nothing here proves enforcement works -
// it proves the rules fire on the right shapes, stay silent on the wrong ones, and
// report honest arithmetic when they do.
//
// Every order is a genuine HTTP POST through the real router, guard, validation and
// service. Nothing is inserted by hand, because the question is what the running
// system records when attacked, not what a fixture says it would.
//
// The device token is a header the client volunteers. It is NOT a fingerprint and
// nothing here inspects the device - see readDeviceId in orderGuard.

const BASE = process.env.BASE_URL || "http://localhost:8787";
const PRODUCT = Number(process.env.P6_PRODUCT);

let pass = 0; let fail = 0;
const check = (l: string, ok: boolean, d = "") => {
  if (ok) { pass++; console.log(`  PASS  ${l}${d ? ` -- ${d}` : ""}`); }
  else { fail++; console.log(`  FAIL  ${l}${d ? ` -- ${d}` : ""}`); }
};
const section = (n: string) => console.log(`\n${"=".repeat(74)}\n${n}\n${"=".repeat(74)}`);

let seed = Number(process.env.P6_SEED ?? Date.now() % 100000);
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
const PREFIXES = ["0803", "0806", "0813", "0814", "0816", "0703", "0906", "0913"];
const phone = () => `${PREFIXES[int(0, PREFIXES.length - 1)]}${String(int(0, 99999999)).padStart(8, "0")}`;

async function submit(opts: { ip?: string | null; device?: string | null }) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  // Absent ip => the header is simply not sent, which is how the null path is tested.
  if (opts.ip) headers["cf-connecting-ip"] = opts.ip;
  if (opts.device) headers["x-dodumodu-device"] = opts.device;
  const res = await fetch(`${BASE}/create-order`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      productId: PRODUCT, quantity: 1,
      customerName: "BURST SHADOW SIM",
      phone: phone(), whatsapp: phone(),
      address: `${int(1, 999)} Sim Road, Lagos`, state: "Lagos",
      deliveryDate: "today", paymentMethod: "cod", turnstileToken: "",
      idempotencyKey: crypto.randomUUID(),
    }),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

const decisionFor = async (ip: string | null, device: string | null) => {
  const { evaluateBurst } = await import("../src/abuse/velocity");
  const { abuseConfigFrom } = await import("../src/abuse/config");
  const { registerDbDriver, createDb } = await import("../src/db");
  const { pgDriver } = await import("../src/dbDrivers/pg");
  registerDbDriver(pgDriver);
  const db = createDb(process.env.DATABASE_URL as string);
  // Shadow, with V2 ON so both rules can be observed - nothing is refused either way.
  const config = abuseConfigFrom({ RL_AUTO_BLOCK: "shadow", RL_V2_ENABLED: "on" });
  return evaluateBurst(db, config, { ip, deviceId: device });
};

console.log(`burst simulation -> ${BASE}`);
console.log("mode: SHADOW (RL_AUTO_BLOCK=shadow) - every rule is evaluated, nobody is refused");

// ---------------------------------------------------------------------------
section("1. A CROWD OF SEPARATE DEVICES  (the false positive we must never cause)");
const crowdIp = `203.0.113.${int(1, 250)}`;
const CROWD = 14; // past both rules' order floors
for (let i = 0; i < CROWD; i++) {
  // One order each, each on its own device, each a different person. Exactly what a
  // Nigerian carrier NAT or a flash sale looks like.
  await submit({ ip: crowdIp, device: `crowd-device-${Date.now().toString(36)}-${i}` });
}
const crowd = await decisionFor(crowdIp, null);
console.log(`  ${crowd.arithmetic}`);
console.log(`  blocked: ${crowd.matched}   rotatingIds gap: ${crowd.rotatingIds}`);
check("a crowd of separate devices is never blocked", crowd.matched === false);
check("the concentration test is what stops it", crowd.shortOf.some((s) => s.includes("concentration")),
  JSON.stringify(crowd.shortOf));

// ---------------------------------------------------------------------------
section("2. SAME-DEVICE, MULTI-PHONE BURST  (V1 must fire)");
const v1Device = `bot-device-${Date.now().toString(36)}`;
let v1Statuses: number[] = [];
for (let i = 0; i < 5; i++) {
  v1Statuses.push((await submit({ ip: null, device: v1Device })).status);
}
console.log(`  ${v1Statuses.length} attempts on one device, no address header at all`);
const v1 = await decisionFor(null, v1Device);
console.log(`  ${v1.arithmetic}`);
console.log(`  matched=${v1.matched} rule=${v1.rule} scope=${v1.scope}`);
check("V1 fires on one device with several identities", v1.matched === true);
check("V1 blocks the DEVICE, not the address", v1.scope === "device" && v1.subject === v1Device);
check("the arithmetic is reported in full", /orders on one device/.test(v1.arithmetic) && /distinct numbers/.test(v1.arithmetic));
check("every attempt still succeeded - shadow refuses nobody",
  v1Statuses.every((s) => s === 200), v1Statuses.join(","));

// ---------------------------------------------------------------------------
section("3. AN ID-LESS BOT  (V2 must fire)");
const idlessIp = `198.51.100.${int(1, 250)}`;
for (let i = 0; i < 10; i++) await submit({ ip: idlessIp, device: null });
const idless = await decisionFor(idlessIp, null);
console.log(`  ${idless.arithmetic}`);
console.log(`  matched=${idless.matched} rule=${idless.rule} scope=${idless.scope}`);
check("V2 fires for an id-less burst", idless.matched === true);
check("V2 blocks the ADDRESS", idless.scope === "ip" && idless.subject === idlessIp);
check("the no-device mass is visible in the arithmetic", /with no device/.test(idless.arithmetic));

// ---------------------------------------------------------------------------
section("4. ROTATING DEVICE IDS  (a documented gap, not a match)");
const rotatingIp = `198.51.100.${int(1, 250)}`;
for (let i = 0; i < 12; i++) {
  await submit({ ip: rotatingIp, device: `rot-${Date.now().toString(36)}-${i}` });
}
const rotating = await decisionFor(rotatingIp, null);
console.log(`  ${rotating.arithmetic}`);
console.log(`  matched=${rotating.matched}   rotatingIds gap=${rotating.rotatingIds}`);
check("a rotating-id bot is NOT blocked", rotating.matched === false);
check("the gap is reported rather than hidden", rotating.rotatingIds === true);

// ---------------------------------------------------------------------------
section("5. THE SAME VOLUME, SPREAD OVER TIME  (must NOT block)");
// Identical shape to scenario 2 - one device, five identities - but the orders are
// aged out of the window afterwards. The volume is the same; only the timing differs,
// and the timing is the entire rule.
const { sql } = await import("drizzle-orm");
const { registerDbDriver, createDb } = await import("../src/db");
const { pgDriver } = await import("../src/dbDrivers/pg");
registerDbDriver(pgDriver);
const db = createDb(process.env.DATABASE_URL as string);

const slowDevice = `slow-device-${Date.now().toString(36)}`;
for (let i = 0; i < 5; i++) await submit({ ip: null, device: slowDevice });
// Age every one of them well beyond the 60s window.
await db.execute(sql`
  UPDATE orders SET created_at = now() - make_interval(secs => 300)
  WHERE device_id = ${slowDevice}
`);
const slow = await decisionFor(null, slowDevice);
console.log(`  ${slow.arithmetic}`);
console.log(`  matched=${slow.matched} (identical volume to scenario 2, now outside the window)`);
check("identical volume spread over 5 minutes never blocks", slow.matched === false);
check("the window counted nothing at all", /0 orders/.test(slow.arithmetic), slow.arithmetic);

// ---------------------------------------------------------------------------
section("6. NULL ADDRESS  (never counted, never grouped, never blocked)");
// The header is simply not sent, which is the whole scenario: orderGuard's readIp
// returns null, evaluate() returns early, and nothing is recorded against any subject.
const nullDevice = `nullip-device-${Date.now().toString(36)}`;
const nullStatuses: number[] = [];
for (let i = 0; i < 5; i++) nullStatuses.push((await submit({ ip: null, device: nullDevice })).status);
console.log(`  5 orders with NO address header (device ${nullDevice.slice(0, 18)}...)`);

// V1 works without an address - it keys on the device, not the network.
const nullV1 = await decisionFor(null, nullDevice);
console.log(`  V1: ${nullV1.arithmetic} -> matched=${nullV1.matched}`);
check("V1 still fires without an address (it needs no address)", nullV1.matched === true);

// With neither subject, nothing can be decided and nothing is invented.
const noSubject = await decisionFor(null, null);
check("with no address and no device, nothing is blocked", noSubject.matched === false);
check("no subject is invented to act on", noSubject.subject === null);
check("the orders themselves were unaffected", nullStatuses.every((s) => s === 200), nullStatuses.join(","));

// Prove nothing was recorded against a null group in the counters.
const counters: any = await db.execute(sql`SELECT count(*)::int AS n FROM abuse_ip_windows WHERE ip = 'null'`);
check("no counter row was created for a null address", Number(counters.rows[0].n) === 0);

console.log(`\n${"=".repeat(74)}`);
console.log(`=== ${pass} passed, ${fail} failed ===`);
console.log("RL_AUTO_BLOCK=shadow throughout: every rule above was evaluated and logged,");
console.log("and not one customer above was refused. No enforcement is wired up.");
process.exit(fail === 0 ? 0 : 1);